# Platform facts for a standalone add-on service (verified 2026-11-14)

Sources were read today: official docs, source at the named tag or branch, npm and GitHub release metadata. Nothing was executed against a live system. Docs base `D` = https://contributors.home-assistant.io/apps (developers.home-assistant.io/docs/apps/* now 301-redirects there). Supervisor source `S` = https://github.com/home-assistant/supervisor/blob/main/supervisor (tag 2026.11.0 checked where a version is named). Core source `C` = https://github.com/home-assistant/core/blob/dev/homeassistant.

## Home Assistant add-ons ("apps")

1. **Ingress — CONFIRMED, with additions.** `ingress: true`; `ingress_port` defaults to `8099` (`0` = Supervisor picks 62000–65500). Requests come only from `172.30.32.2`; the docs say "Deny everything else". The prefix is stripped: Core route `/api/hassio_ingress/{token}/{path}` → Supervisor → `http://{app_ip}:{ingress_port}/{path}`. Core sets `X-Ingress-Path: /api/hassio_ingress/<token>` (no trailing slash). HTTP/1.x, streaming and WebSockets are proxied. `panel_icon` (default `mdi:puzzle`), `panel_title` (default app name), `panel_admin` (default `true`); also `ingress_entry`, `ingress_stream`. User headers: `X-Remote-User-Id`, `X-Remote-User-Name`, `X-Remote-User-Display-Name`, and in source also `X-Remote-User-Groups` (comma-separated, undocumented). They are stripped from incoming requests and set by the Supervisor, but "not guaranteed": treat a request without them as unknown user. `D/guides/ingress/`, `S/api/ingress.py`, `C/components/hassio/ingress.py`

2. **MQTT service — CONFIRMED.** `services: ["mqtt:need"]` (or `mqtt:want`; any role may read). `GET http://supervisor/services/mqtt` with `Authorization: Bearer $SUPERVISOR_TOKEN` returns `{"result":"ok","data":{"addon":"core_mosquitto","host":"core-mosquitto","port":1883,"ssl":false,"protocol":"3.1.1","username":"addons","password":"…"}}`. `username`/`password` are optional for the provider; `protocol` is `3.1` or `3.1.1`. The call fails when no app provides the service. A feature-flagged `/v2` API returns `app` instead of `addon`. `D/supervisor-api/services/`, `S/api/services.py`, `S/api/utils.py`

3. **Core API proxy — CONFIRMED.** `homeassistant_api: true`; REST `http://supervisor/core/api/`; websocket `ws://supervisor/core/websocket` (`/core/api/websocket` is routed too); send `SUPERVISOR_TOKEN` as `access_token` in the `auth` message. The app acts as an administrator. The proxy blocks `supervisor/` and `hassio/` websocket command types. `D/guides/communication/`, `S/api/__init__.py`, `S/api/proxy.py`

4. **Storage — PARTLY (names changed).** `/data` survives restarts and updates and is in every backup of the app; it is deleted on uninstall (`unload()` removes the data folder). Current `map` types: `homeassistant_config` (`/homeassistant`), `app_config` (`/config`), `all_app_configs` (`/app_configs`), `local_apps` (`/local_apps`), `ssl`, `share`, `media`, `backup`, `data`; entries are `{type, read_only (default true), path}`. `addon_config`, `all_addon_configs` (`/addon_configs`) and `addons` are deprecated aliases, accepted with a warning; `app_config` exists from Supervisor 2026.08.0. Host side: `<supervisor data>/app_configs/<repo>_<slug>` (constant `APP_CONFIGS`, tag 2026.11.0). The public config folder survives uninstall unless `remove_config: true` is passed (default `false`). Backups hold the app configuration, `/data` and the mapped `app_config` folder; hot by default, tunable with `backup: cold`, `backup_pre`, `backup_post`, `backup_exclude`. COULD NOT VERIFY: the absolute HAOS path, and how the former `addon_configs` directory is migrated. `D/reference/configuration/`, `D/reference/environment/`, `D/how-apps-work/`, `S/apps/app.py`, `S/config.py`

5. **Two processes, base images, architectures — PARTLY.** Base images ship S6 overlay v3 (`S6_OVERLAY_VERSION=3.2.3.2`), Bashio and Tempio. Services go in `/etc/s6-overlay/s6-rc.d/` (recommended, supports dependencies; register under `user-bundles.d/user/contents.d/`) or legacy `/etc/services.d/` + `/etc/cont-init.d/` (still supported). `init: false` is required with these images (otherwise `s6-overlay-suexec: fatal: can only run as pid 1`); keep `/init` as entrypoint; do not set `host_pid`. There is no official Node base image: only `ghcr.io/home-assistant/base` (Alpine 3.22–3.24), `base-python`, `base-debian` (bookworm, trixie), `base-ubuntu`. The community `hassio-addons/addon-base-nodejs` is archived. So: official base plus Node (Alpine 3.24 packages `nodejs` 24.22.3 and `nodejs-current` 26.13.1), or any other image (without S6, keep `init: true`). Architectures: `aarch64` and `amd64` only; `armhf`, `armv7`, `i386` are deprecated and only "accepted, with a warning"; base images are built for amd64 and arm64 only. `build.yaml` is deprecated and `BUILD_FROM` is no longer passed since Supervisor 2026.04.0. `D/guides/s6-overlay/`, `D/guides/dockerfile/`, https://github.com/home-assistant/docker-base

6. **Repository and terminology — CONFIRMED; the rename is real.** Add-ons are "apps" since Home Assistant 2026.2; code, API paths (`/addons/self/info`) and My links (`supervisor_add_addon_repository`) keep the old name. A repository is a Git repo with `repository.yaml` (`name` required; `url`, `maintainer`) and one folder per app holding `config.yaml` (plus `Dockerfile`, `DOCS.md`, `README.md`, `CHANGELOG.md`, `icon.png`, `logo.png`, `translations/`, `apparmor.txt`). `image: ghcr.io/me/my-app` without tag; the tag pulled is `version`; a multi-arch manifest is preferred, the `{arch}` placeholder still works. The all-in-one `home-assistant/builder` action is deprecated in favour of composable actions. A first GHCR push is private. `D/guides/repository/`, `D/guides/publishing/`, `D/reference/files/`, https://www.home-assistant.io/blog/2026/02/04/release-20262/

7. **Repairs from outside — CONFIRMED not possible.** The `repairs` integration registers only `repairs/list_issues`, `repairs/ignore_issue`, `repairs/get_issue_data` and has no `services.yaml`, so no action. Issues can only be created from Python inside Core. Alternatives: the `persistent_notification.create` action, or a `binary_sensor` with `device_class: problem`. `C/components/repairs/websocket_api.py`

## Websocket API and MQTT discovery

8. **Websocket commands — PARTLY.** Exist: `subscribe_events`, `subscribe_entities` (optional `entity_ids`), `get_states`, `get_config` (`time_zone`, `unit_system`, `country`, `currency`, `language`, `version`), `config/entity_registry/list`, `config/device_registry/list`, `config/area_registry/list`, `call_service`. Full state objects (`get_states`, `state_changed` events) include `last_reported`. `subscribe_entities` uses the compressed form with only `s`, `a`, `c`, `lc`, `lu`: no `last_reported`. It listens to `state_changed` only, so a report that changes nothing produces no message. `state_reported` cannot be subscribed over the websocket: the bus requires an event filter for it and excludes it from match-all. Only polling `get_states` shows a newer `last_reported`. `C/components/websocket_api/commands.py`, `C/core.py`, https://contributors.home-assistant.io/core/internals/websocket-api/

9. **home-assistant-js-websocket — CONFIRMED.** 9.8.1 (2026-10-29), no dependencies. Needs a global `WebSocket`; the README still says to polyfill `ws`, but Node 22+ has a global `WebSocket` (not tested here). `createLongLivedTokenAuth(hassUrl, token)` builds `ws…/api/websocket`, so `createLongLivedTokenAuth("http://supervisor/core", SUPERVISOR_TOKEN)` hits the routed `/core/api/websocket`. It reconnects and resubscribes automatically; the first connection retries only with `setupRetry` (default 0, `-1` infinite). `subscribeEntities` is now a deprecated alias of `subscribeEntityStates`. https://github.com/home-assistant/home-assistant-js-websocket

10. **MQTT discovery — PARTLY.** Device discovery: topic `<prefix>/device/[<node_id>/]<object_id>/config`; root requires `device` (`dev`) and `origin` (`o`); entities under `components` (`cmps`), each with `platform` (`p`) and `unique_id`; shared root options: availability options, `command_topic`, `state_topic`, `qos`, `encoding`. Removal: empty retained payload removes all components; to remove one, publish the payload with that component reduced to `{"p": "<platform>"}`, then again without it. `origin`: `name` required, `sw_version`, `support_url`. Climate: every topic is optional; `modes` defaults to `[auto, off, cool, heat, dry, fan_only]` and must be a subset; `current_temperature_topic`, `temperature_state_topic`, `action_topic`, `json_attributes_topic` exist. A climate without command topics publishes nothing, but it is not read-only in the UI: `TARGET_TEMPERATURE` is set when either the state or the command topic exists, and `TURN_ON`/`TURN_OFF` always; with a state topic and no command topic a user change is silently dropped. Sensor: `device_class: enum` with non-empty `options`, not combinable with `state_class` or `unit_of_measurement`. Binary sensor `problem` exists. Switch: `command_topic` required. Availability: `availability_topic` or `availability` list, default payloads `online`/`offline`; the last will is the client's job. Translation: no `translation_key`; names are literal, except that an entity with a `device_class` and no `name` gets Home Assistant's localized device-class name. https://www.home-assistant.io/integrations/mqtt/, https://www.home-assistant.io/integrations/climate.mqtt/, `C/components/mqtt/climate.py`, `C/components/mqtt/entity.py`

11. **Zigbee2MQTT (2.14.3) — CONFIRMED, one caveat.** Cached state is republished at start (`advanced.cache_state_send_on_startup`, default `true`) and 30 s after `online` on `homeassistant.status_topic` (default `homeassistant/status`), the latter only with its Home Assistant extension enabled. On an MQTT reconnect it republishes only its own retained messages. With `retain` off (per-device default `false`) a new subscriber receives nothing until the device reports or a `/get` is sent. It uses `mqtt.client_id` if set, otherwise MQTT.js's random `mqttjs_<hex>`; a differently named client does not affect it. Caveat: its default protocol is `version: 4` (3.1.1); only with `version: 5` does a takeover arrive as DISCONNECT. MQTT 5 [MQTT-3.1.4-3]: the server "sends a DISCONNECT packet to the existing Client with Reason Code of 0x8E (Session taken over)" and must close its connection; Mosquitto sends it to v5 clients only, others are just dropped. https://github.com/Koenkk/zigbee2mqtt/blob/master/lib/controller.ts, `…/lib/extension/homeassistant.ts`, `…/lib/mqtt.ts`, https://www.zigbee2mqtt.io/guide/configuration/mqtt.html, https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html, https://github.com/eclipse-mosquitto/mosquitto/blob/master/src/handle_connect.c

## Node and libraries

12. **Node — CONFIRMED.** Active LTS is Node 26 "Lithium" (LTS since 2026-10-28; latest 26.13.1). Node 24 went to maintenance on 2026-10-20. Temporal is "enabled by default in Node.js 26", no flag. Support on no-ICU and system-ICU builds landed in 26.12.0; whether Alpine's `nodejs-current` build has it: COULD NOT VERIFY. Polyfills: `temporal-polyfill` 1.0.8 (2026-11-04, "Less than 20 kB", active); `@js-temporal/polyfill` 0.5.1 (last release 2025-03-31, needs `jsbi`, about three times the unpacked size). https://github.com/nodejs/Release/blob/main/schedule.json, https://github.com/nodejs/node/blob/main/doc/changelogs/CHANGELOG_V26.md

13. **MQTT.js — CONFIRMED.** 5.16.1 (2026-10-14), Node ≥ 16. Default `protocolVersion: 4`; set `5` for MQTT 5. A server DISCONNECT surfaces as the `'disconnect'` event with the packet (`packet.reasonCode === 142`), MQTT 5 only. The socket then closes and the client reconnects every `reconnectPeriod` (default 1000 ms) with `resubscribe: true`, so two clients sharing an id evict each other every second unless the handler calls `client.end()`. Since 5.16.0 a refused CONNACK is not retried unless `reconnectOnConnackError: true`. https://github.com/mqttjs/MQTT.js

14. **Fastify — CONFIRMED.** 5.12.8 (6.0.0-alpha on `next`); `@fastify/websocket` 11.3.7, route option `{ websocket: true }`, handler `(socket, req)`. `listen` extends Node's `net` options: `{ host: '127.0.0.1', port }` or `{ path: '/run/app.sock' }`; default host is `localhost`. https://fastify.dev/docs/latest/Reference/Server/#listen, https://github.com/fastify/fastify-websocket

15. **fast-check — CONFIRMED.** 4.10.2; `fc.commands` and `fc.modelRun` are documented, with `replayPath`. `@fast-check/vitest` 0.5.0 (peers: vitest `^4.1.0 || ^5.0.0`, fast-check `^3 || ^4`) exports extended `test`/`it` and `fc`. Vitest is 5.1.0 and needs Node `^22.12 || ^24 || >=26`. https://fast-check.dev/docs/advanced/model-based-testing/, https://github.com/dubzzz/fast-check/tree/main/packages/vitest

16. **Caddy — PARTLY (built from docs, not run).** v2.11.9; binary 50.9 MB (amd64) / 47.3 MB (arm64), 18 / 16 MB compressed. The official `caddy` image is multi-arch (amd64, arm64, arm/v7, arm/v6, ppc64le, s390x, riscv64) with the binary at `/usr/bin/caddy`. `basicauth` was renamed `basic_auth` in 2.8 and takes hashes only (`caddy hash-password`). `reverse_proxy` handles WebSockets itself. Trap: `handle` sorts before `abort`/`respond`, so an IP check next to a catch-all `handle` never runs; `route` keeps literal order.

```
{
	admin off
}
(app) {
	handle /api/* {
		reverse_proxy 127.0.0.1:3000
	}
	handle {
		root * /srv/www
		try_files {path} /index.html
		file_server
	}
}
http://:8099 {
	route {
		@other not remote_ip 172.30.32.2
		abort @other
		import app
	}
}
http://:8080 {
	route {
		basic_auth {
			{$UI_USER} {$UI_PASSWORD_HASH}
		}
		import app
	}
}
```

https://caddyserver.com/docs/caddyfile/matchers#remote-ip, https://caddyserver.com/docs/caddyfile/patterns#single-page-apps-spas, https://caddyserver.com/docs/caddyfile/directives#directive-order, https://github.com/caddyserver/caddy/releases/tag/v2.11.9
