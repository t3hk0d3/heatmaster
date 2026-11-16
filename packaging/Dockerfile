# Build with the repository root as context: docker build -f packaging/Dockerfile .

# The build runs on the build machine's own platform: what it produces (the page's files and the
# installed packages) is the same for every processor. That holds only while no production
# dependency has native code; the arm64 smoke check guards it.
FROM --platform=$BUILDPLATFORM node:26.13.1-alpine3.24 AS build
RUN npm install --global pnpm@10.22.0
WORKDIR /src
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
# Production dependencies only, for the server and the workspace packages it depends on. Nothing
# is compiled for core or server: Node runs their TypeScript as it is, and @heatmaster/core stays
# the workspace package (no `pnpm deploy`), so its real path lies outside every node_modules.
RUN rm -rf node_modules packages/*/node_modules \
 && pnpm install --frozen-lockfile --prod --filter "@heatmaster/server..." \
 && find packages/core packages/server -name node_modules -prune -o -name '*.test.ts' -type f -print -delete

FROM caddy:2.11.9-alpine AS caddy

FROM node:26.13.1-alpine3.24 AS node

FROM ghcr.io/home-assistant/base:3.24-2026.11.0
RUN apk add --no-cache libstdc++ libatomic
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
WORKDIR /opt/heatmaster
COPY --from=build /src/package.json /src/pnpm-workspace.yaml ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/packages/core/package.json packages/core/package.json
COPY --from=build /src/packages/core/src packages/core/src
COPY --from=build /src/packages/server/package.json packages/server/package.json
COPY --from=build /src/packages/server/src packages/server/src
COPY --from=build /src/packages/server/node_modules packages/server/node_modules
COPY --from=build /src/packages/web/dist /srv/www
COPY packaging/Caddyfile packaging/password.caddy /etc/caddy/
COPY packaging/rootfs/ /
ENV NODE_ENV=production
# The base image's entry point, /init (s6-overlay), is kept.

# Calls the server directly: a call through Caddy from inside the container would not come from
# the ingress address.
HEALTHCHECK --interval=30s --start-period=60s --timeout=10s --retries=3 \
  CMD ["/usr/local/bin/heatmaster-healthcheck"]

ARG VERSION=0.0.0-dev
LABEL io.hass.type="app" \
      io.hass.version="${VERSION}" \
      io.hass.name="Heatmaster" \
      io.hass.description="Room schedules and weighted room temperatures for Sonoff radiator valves" \
      org.opencontainers.image.title="Heatmaster" \
      org.opencontainers.image.source="https://github.com/t3hk0d3/heatmaster"
