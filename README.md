# Heatmaster

Manages Sonoff radiator valves (TRVZB, TRV-ZBT) through Zigbee2MQTT: shared schedules, weighted
room temperatures, and every problem shown in its own web page and in Home Assistant.

A pnpm workspace: `packages/core` (pure decision logic), `packages/server` (the shell) and
`packages/web` (the web page). Conventions are in [STYLEGUIDE.md](STYLEGUIDE.md).

```
pnpm install
pnpm check   # lint, types, tests
pnpm build   # the web page, into packages/web/dist/
```

Requires Node 26 and pnpm (see `packageManager` in `package.json`).
