# Heatmaster

Manages Sonoff radiator valves (TRVZB, TRV-ZBT) through Zigbee2MQTT: shared schedules, weighted
room temperatures, and every problem shown in its own web page and in Home Assistant.

## What Heatmaster is

Heatmaster runs the week's schedule on each valve itself (onboard) and feeds each valve a weighted
room temperature taken from the room's sensors in Home Assistant. Every problem it detects is
shown on its page and as Home Assistant entities. It runs as a Home Assistant app (add-on) or as a
plain container.

It needs Zigbee2MQTT with the **`last_seen` option on**. Without it no valve is managed, and the
page says why.

## Install as an app

1. Home Assistant with Supervisor 2026.08.0 or newer, and the Mosquitto broker app installed and
   started.
2. Add this repository to the app store: `https://github.com/t3hk0d3/heatmaster`.
3. Install Heatmaster and start it.
4. Open "Heatmaster" in the sidebar. Only administrators can open it: the Supervisor refuses the
   ingress of an app with `panel_admin` to every other user.

The app takes the broker's address and login from the Supervisor, and reaches Home Assistant
through the Supervisor's proxy. Its two options, the Zigbee2MQTT base topic and the MQTT discovery
prefix, are left at their defaults unless you changed them in Zigbee2MQTT or Home Assistant.

## Install as a plain container

Use [packaging/docker-compose.yml](packaging/docker-compose.yml). Its comments carry the notes:

- Make the password hash with `caddy hash-password`, and write every `$` of it as `$$` in the file.
- Never publish ports 8099 or 3000.
- Never run the container with host networking: the API on 127.0.0.1:3000 has no login and would
  be open to every process on the host.
- Never attach the container to a network in which another container can take the address
  172.30.32.2: the ingress listener admits that address without a password.
- Put TLS in front when the page is reached from outside the home network.

The page is on port 8080, behind the login (`UI_USER`, `UI_PASSWORD_HASH`). With neither variable
set the listener is off. The variables are `MQTT_URL` (`mqtt://` or `mqtts://` only, no login
inside it), `MQTT_USERNAME`, `MQTT_PASSWORD`, `HA_URL` and `HA_TOKEN` (both or neither), and the
optional `Z2M_BASE_TOPIC`, `DISCOVERY_PREFIX`, `DATA_DIR` (default `/data`), `PUBLIC_DIR` (default
`/config`) and `HEATMASTER_PORT`. Bad values end the container with exit code 78 and a line for
each fault. Without a Home Assistant link the config must name `timezone`; a config without one
is refused, and room sensors need the link.

## Example config

```yaml
version: 2
settings:
  timezone: Europe/Amsterdam
  hold_writes: true
schedules:
  - id: main
    name: Main
    week:
      - days: weekdays
        temperature:
          "00:00": 16
          "06:30": 20
          "22:00": 16
      - days: weekend
        temperature:
          "00:00": 16
          "08:00": comfort
          "23:00": 16
rooms:
  - id: living
    name: Living room
    schedule_id: main
    valves:
      - id: "z2m:0x00124b0000000001"
    sensors:
      - ref: ha:sensor.living_temperature
```

A schedule's `week` is a list of blocks, applied in order; every weekday must be in at least one block. A
later block replaces the whole day plan of each day it names, so `all` followed by `[fri]` gives
friday its own plan; a block whose days are all overridden later is refused. `days` is a list
of day names (`[mon, wed]`), or one of `all`, `weekdays` (mon to fri) and `weekend` (sat, sun).
`temperature` maps each time, in quotes, to a temperature or a preset name, and holds `"00:00"`.
Documents of version 1 (a `default_week` with a list per day) are refused; a stored config of
version 1 is upgraded when it is loaded.

Home Assistant gets, through MQTT discovery, one device per room (temperature, target
temperature, problem and sync entities) and one "Heatmaster" device (problem, problem count,
writes held, and the "Stop writing" button). There is no thermostat entity in this version.
Their entity ids are `<platform>.heatmaster_<room id>_<kind>` (for example
`sensor.heatmaster_living_room_temperature`); this needs Home Assistant 2025.10 or newer, which
reads the discovery key `default_entity_id`. Older releases ignore it and name the entities from
their names.

## First run

1. The page shows the valves it found, and whether each has reported yet.
2. Write the config. A new config holds writes unless it says otherwise (`hold_writes`).
3. Preview: check the valves that join, their captured originals and the planned writes. The
   captured originals are what Zigbee2MQTT's cache held at that moment; a preview asks each
   joining valve to report, so preview once more before applying if a value looks wrong.
4. Apply. Nothing is written yet; Heatmaster only asks the valves to report.
5. Check the rooms, the problems and the diagnostics.
6. Press "Release writes".

## What Heatmaster does to a valve

It overwrites the valve's schedule, and sends it again at every start, after a rejoin, after a
Zigbee2MQTT restart and once a day. **The valve's old schedule is not saved and not put back.**
The sensor source (and on TRV-ZBT the active group) is saved and put back on release.

Heatmaster limits how often it writes to a valve: a bucket of 6 writes per valve, one more every 30
minutes. The time the bucket is full again is kept in `/data/pacing.json`, so a restart, or a
restart loop, does not refill it. If that file cannot be read, every valve starts with an empty
bucket and the page shows a problem.

TRV-ZBT: Heatmaster uses schedule group 3 and does not save what it held. A valve whose active
group is already 3 can join; its group 3 is overwritten. After a release the active group is back;
Zigbee2MQTT's "group to edit" stays 3.

## Rollback

Apply a config with no rooms and `hold_writes: false`. Wait until no valve is listed as releasing.
Then uninstall.

## What uninstall deletes and keeps

- `/data` (the config, the saved originals and `pacing.json`) is deleted.
- The public folder (`/config`) with `originals.json` and its four older copies stays.
- The devices in Home Assistant stay until they are deleted there.
- A valve that was not released keeps Heatmaster's schedule and falls back to its own sensor when
  the temperature stops coming.

## When a file cannot be read

An unreadable config freezes every valve; apply a config with the overwrite switch, and the old
file is kept beside the new one. An unreadable ledger: "Import saved originals" takes the newest
readable copy from the public folder. After a reinstall the same button brings back the originals
of valves that were not released; until it is pressed no valve can join. Originals that are not
wanted are forgotten afterwards, valve by valve.

## One instance only

Two Heatmasters on one broker would both write. The one started last wins; the other stops writing
and says so. The instance that stopped stays stopped until it is restarted, also after the other
one is gone; `/api/health` answers 503 and the page says so, and its valves get no temperature. The container stays healthy on purpose: a watchdog restart would let it take the broker session back, write the valves again and fight the other instance. Three broker
restarts within 30 seconds look the same to Heatmaster and stop it too; restart Heatmaster after
such an outage. On an MQTT 3.1.1 broker this count of dropped connections is the only sign of a
second instance, so an MQTT 5 broker, which names a takeover, is recommended.

## The broker is trusted

Anyone who can publish on the MQTT broker can change what Heatmaster believes about the valves and
can stop it. Give the broker a login and keep it off untrusted networks. A wrong MQTT password is
tried again only every 30 seconds, and the page names it.

No MQTT fault makes the container unhealthy (a broker that is down, a refused login, a second
instance): the server keeps trying by itself or stays stopped for good, and a restart would not
help or would do harm. Only a server that does not answer does. The page and `GET /api/health` (503,
code `mqtt_fault`) show it.

## When the app halts

If the server fails five times within 15 minutes the container stops (exit code 1). Under Docker's
restart policy, or with the app's Watchdog switch on, it is started again and halts again at once
until 15 minutes have passed since the first of the five starts. The valves then lose the
temperature feed and fall back to their own sensor. The app's log says why; `DOCS.md` carries the
same line and says where the log is.

## Stop writing

The "Stop writing" button in Home Assistant holds all writes. It cannot release the valves:
releasing needs the page, because it needs a look at what each valve will get back.

## Time zone

Zigbee2MQTT's host must have the right time zone, because the valves take their clock from it.

## Development

A pnpm workspace: `packages/core` (pure decision logic), `packages/server` (the shell) and
`packages/web` (the web page). Conventions are in [STYLEGUIDE.md](STYLEGUIDE.md).

```
pnpm install
pnpm check   # lint, types, tests
pnpm build   # the web page, into packages/web/dist/
```

Requires Node 26 and pnpm (see `packageManager` in `package.json`).
