# Heatmaster architecture v6

**Status:** written 2026-11-14 after the user's decisions D6–D11; not yet reviewed. It replaces `2026-11-14-architecture-v5.md`, which stays as the record of how the core design was reached and reviewed (its sections 16 and 17 list every finding). The core of v5 carries over; the shell is new. Where this document and the spec disagree, this document wins (spec §11).

**Sources:** v5 and its reviews; `../research/` (existing projects); `../research/research-standalone-platform.md` (platform facts checked on 2026-11-14). Facts about valves and Zigbee2MQTT (Z2M) are still unmeasured on this house; section 15 lists the measurements. Numbers marked *provisional* are checked by them.

## 1. What Heatmaster is now

A standalone application in TypeScript on Node, shipped as a Home Assistant app (add-on) and as a plain container image. It manages Sonoff valves through Z2M over MQTT, reads other sensors from Home Assistant over the websocket API, shows its rooms in Home Assistant through MQTT discovery, and has its own web UI. Home Assistant can be down or absent; valves and Z2M sensors keep being managed.

## 2. Decisions

| # | Decision | By |
|---|---|---|
| D1 | Valves are reached over MQTT directly | user |
| D2 | Config lives in Heatmaster's own versioned store | user |
| D3 | Z2M's `last_seen` option is required | user |
| D4 | Temperature is pushed on change (0.2 °C, at most once per interval) and every 30 min | user |
| D5 | Valves are given back only by an explicit release | user |
| D6 | Standalone application run as a Home Assistant app; integrates through the websocket API and MQTT | user |
| D7 | Problems in Home Assistant's Repairs are a bonus, not a requirement | user |
| D8 | It is meant to be shared: an app repository and a container image | user |
| D9 | TypeScript; Fastify for the server; Caddy in front as reverse proxy and static file server; s6-overlay as the container's init | user |
| D10 | Valves and settings may be read on demand through Z2M's `get` ("refresh") | user |
| D11 | The valve's saved schedule is not preserved or read. Heatmaster overwrites it eagerly | user |

Caddy is a reverse proxy for **one** server. Heatmaster must never run as two instances: both would write to the valves (section 12).

## 3. Why the earlier design leaked

It remembered what it did (commands, results, in-flight slots, phases, a "written" set, two clocks) and inferred the valve's state from that memory. Every remembered field was a second copy that could disagree with the valve. v5 removed the memory; v6 keeps that.

## 4. Device and platform facts

1. Z2M gives no per-write result. For sensor source, active group, mode and setpoint it publishes the new value only after the valve acknowledged the write.
2. The TRVZB schedule cannot be read from the valve. Z2M publishes what it sent.
3. Every device message carries Z2M's whole cached state.
4. On TRV-ZBT the "group to edit" lives in Z2M's memory, not on the valve. The group must be named in the same message as the days.
5. No source and no existing tool reports a mode toggle being needed for a new schedule to take effect.
6. With `last_seen` on, every device message carries it; a replayed cache carries the old value.
7. A sleeping valve's write or read can be queued in Z2M and land when the valve next speaks.
8. A valve whose temperature feed stopped shows `remote_source_offline` and recovers by itself.
9. Days sent in one message are grouped: identical days go out as one radio command.
10. Z2M replays its cache when Z2M starts and when Home Assistant announces itself, **not** when Heatmaster starts. With per-device `retain` off, a new subscriber hears nothing until the device speaks or is asked with `get`.
11. An outside process cannot create Repairs issues.
12. A climate entity created through MQTT discovery cannot be made read-only: its controls show and changes are dropped silently.
13. Over the websocket, `last_reported` is present only in full state objects (`get_states`, `state_changed`), and a report that changes nothing sends no event.

## 5. Principles

1. **Nothing about writes is persisted.** What the valve shows is the record.
2. **A write took when the observed value equals the desired value.** Values are compared, never times.
3. **One rule per kind of setting.** An *enforced* setting that differs is written. A *stream* is pushed on its own cadence. (Plan 2 adds *adopted* settings.)
4. **Sequences are preconditions**: "B is wanted only while A is observed".
5. **Nothing destructive is inferred from absence.** A missing or unreadable store never causes a write, a capture or a release.
6. **A setting is written only if the valve's ledger record exists**, and captured originals are never overwritten.
7. **Cached values are not evidence of the present.** After anything that may have changed the valve behind Heatmaster's back, readable settings are read again and unreadable ones are sent again.
8. **Device profiles are tables**, not code that runs sequences.
9. **Preview is the same function** the live path uses.
10. **The shell makes no decisions.** Decision logic is pure and returns an ordered list of effects.
11. **One instance.** A second instance must not be able to write.

## 6. Packages

A pnpm workspace:

| Package | Holds | May import |
|---|---|---|
| `packages/core` | All decision logic, pure. Config model and validation, schedule, temperature, settings, observation, ledger shapes and membership, memory, pacing, feed, desired, events, control, change, status, profiles with their bindings | nothing outside itself |
| `packages/server` | The shell: MQTT transport, Home Assistant link, stores, runtime, MQTT discovery publisher, Fastify HTTP API | `core` |
| `packages/web` | The web UI, a Vite single-page app with relative paths | the API types of `core` |
| `packaging/` | Dockerfile, Caddyfile, s6 service definitions, the app manifest (the repository file sits at the repository root) | — |

Time: the core never reads the clock. It receives `now` as a `Temporal.ZonedDateTime` in the house's time zone and compares instants as epoch milliseconds. Durations are milliseconds.

## 7. What is stored

**Config** (`/data/config.json`) — what the user wants: settings, schedules (stable ids), rooms (valves by id, weighted sensors), plus the server-owned `releasing` map (valve → time the release was ordered). The revision counts user changes only. `releasing` is not exported and cannot be set by a caller.

**Ledger** (`/data/ledger.json`) — per managed valve one record with its captured originals: the sensor source, and on TRV-ZBT the active group. Schedules are not captured (D11). Entries are create-only; an unreadable one can be accepted as "unknown" and is then skipped on release. Released records are kept in a `released` list.

**Readable copy** — after every ledger change the ledger is also written as indented JSON to the public folder (in the app: the `app_config` folder, which survives uninstall; `/data` does not), keeping five generations.

Both files carry a `version` and go through one fixture-tested migration per version. Writes are atomic (temporary file, flush, rename).

**A file that failed to load is never written.** Unreadable config: every valve is frozen; a config change is refused unless the caller sets `overwrite_unreadable`, and then the old file is copied aside first. Unreadable ledger, or a missing ledger while the config is unreadable or has a valve in a room or in `releasing`: no valve is written to, nothing joins, and `import_originals` restores from the readable copy.

**In memory only:** observations, pacing, feed, marks, release timers.

**Later plans** add a state file for overrides with expiry, manual modes, latched results and the heat output's state.

## 8. Membership and config changes

Per valve, derived every tick:

| Config | Valve is in | Ledger record | Meaning |
|---|---|---|---|
| ok | a room | yes | **Managed** |
| ok | a room | no | **Not adopted**: no writes; problem |
| ok | `releasing` only | yes | **Releasing**: desired = originals |
| ok | `releasing` only | no | **Stray**: dropped from `releasing` at the next tick |
| ok | neither | yes | **Orphan**: no writes; problem; `restore` or `forget` |
| ok, ledger unreadable | a room or `releasing` | unknown | **Frozen** |
| unreadable, or empty with ledger records | — | any | **Frozen** |
| empty, ledger empty | — | — | fresh install |

A config change (`plan_change`): validate; compare valve sets over the whole config (a moved valve is neither joining nor leaving; a joining valve that already has a record keeps it). Refuse on: unreadable config without `overwrite_unreadable`; stale revision; unknown or unsupported valve; unusable transport; ledger unreadable and anything joins; a new valve from which no message has arrived (`valve_not_observed`; the server then asks the valve to report, and the caller retries); a new valve whose captured setting cannot be read and was not accepted; an invalid sensor reference. Effects in order: save ledger with new records, write the readable copy, save config with leaving valves added to `releasing`. A dry run returns the preview only.

## 9. Observation and evidence

- A transport delivers device messages with a **life token** that changes if and only if the device itself spoke (Z2M: `last_seen`). A device is *heard* when its token differs from the stored one; the first token after a start or after the link came back is stored without counting.
- Liveness: unknown, live, silent (valves after 2 h unheard; sensors after the staleness timeout). While a link is down its devices are unknown, not silent.
- **Observable:** at least one message from the valve has arrived since start. Nothing is written to a valve that is not observable. Every followed device has a state from the moment it is listed, so one that never speaks becomes silent in time.
- Per group of settings the binding states the **evidence**: `acked` or `echoed`, and whether the group is **readable** through `get`.
- **Marks.** A mark on a group means "do not trust the cached value". Marks are set on every group at start, on rejoin, on Z2M restart or MQTT reconnect, when a valve returns from silence, on `resync`, and when the group's maximum age passes (24 h for every group, *provisional*).
  - A marked **readable** group is cleared by a heard message that comes after Heatmaster asked the valve to report (`Refresh`). If the fresh value differs, the ordinary rule writes it.
  - A marked **unreadable** group (the schedule) is sent again in full once the valve was heard since the marking, and cleared by the next heard message after that.
- **Refresh.** A valve gets a `Refresh` when it is not observable, or when a mark still lacks its evidence (a readable group not yet asked since the marking, or the valve not heard since). Refreshes are paced like writes.
- Known limit: Z2M cannot tie an answer to a request. A read or write lost right after a rejoin, followed by an unrelated message from the valve, leaves a stale cached value believed until the next daily check.

**Plan 1 settings**

| Group | Members | Policy | Evidence | Readable | Captured and restored |
|---|---|---|---|---|---|
| `schedule` | seven days | enforce | echoed | no | no |
| `active_group` (TRV-ZBT) | one | enforce: group 3, only while the days are observed equal in a message whose edit group is 3 | acked | yes | yes |
| `sensor_source` | one | enforce: `external` once a push went out and the room temperature has been fresh for 10 min; `internal` when the room's sensors are stale or absent; otherwise left alone | acked | yes | yes |
| `external_temperature` | one | stream | — | — | no |

On TRV-ZBT Heatmaster writes days only into group 3, always naming the group in the same message, and never writes groups 1 and 2. A valve whose active group is already 3 may join; its group 3 is overwritten. Mode and setpoint are readings in plan 1.

## 10. The tick

`tick(world) → { memory, effects, rooms, problems }`, pure. Effects, executed strictly in order, each awaited: `saveLedger`, `writeOriginalsCopy`, `saveConfig`, `publish(valve, values)`, `publishSetpoint(valve, °C)`, `pushTemperature(valve, °C)`, `refresh(valve)`.

```
per valve that is managed or releasing and has a profile:
  transport unusable, link down, or valve silent → nothing
  not observable → refresh (paced); nothing else
  writes held → refreshes still happen; nothing below that writes or pushes
  desired = from the room's schedule and temperature state, or the originals when releasing
  a mark lacks its evidence → refresh (paced)
  candidates = groups, in profile order, whose desired value differs from the observed one,
               or that are unreadable, marked, and the valve was heard since the marking
  the first candidate pacing allows → publish (all members if marked, else the differing ones)
```

- **Pacing**, in memory per valve: 2 s spacing; a group's value written before waits 2 min, 10 min, 1 h, then 6 h before it is written again, counted over 24 h since the group's desired value last changed; a token bucket (*provisional:* 6 tokens, one back every 30 min, 4 at start). Three writes of the same value that were not caused by a mark raise "setting not holding". Refreshes use the same spacing, bucket and backoff.
- **Activation.** `none`, or `setpoint`: after a schedule write whose days differed is observed equal while the valve is in `auto`, the current set point's temperature is written once. A mode toggle is not designed; if measurement shows it is needed, work stops and it is designed first.
- **Temperature push** (as v5 §9): on a change of 0.2 °C no sooner than the interval, and every 30 min; only to managed, observable, non-silent valves; stops when the room goes stale, when the valve is off (unless the profile says it may be fed) and on release; never queued or confirmed.
- **Release** finishes when every restorable setting has stayed equal for the release hold (*provisional:* 15 min), counted from after the release order, and the valve was heard during that time. Then the record moves to `released` and the valve leaves `releasing`.
- **Hold writes** is a config setting, on by default, and an input to the tick: while on, no publish, setpoint write or push is decided. Reads continue, so a held installation still learns what its valves hold.
- **Preview** runs the same selection on a copy with pacing off, hold ignored, pushes assumed sent and each mark treated as satisfied once, until nothing more is written.
- **Events between ticks** (`applyEvent`, pure): device message, rejoined, bridge restarted, link up, resync requested. They update observations and set or clear marks.
- Removed from v5: the "schedule not followed" detection and everything it needed.

## 11. Inputs

**MQTT** (MQTT.js, the server's own client). Broker address and credentials come from the Supervisor's MQTT service in the app, or from environment variables in a plain container.
- Z2M transport: base topic from the app's options (default `zigbee2mqtt`), confirmed by `bridge/info`; devices from `bridge/devices`; state from `<base>/<friendly name>`; writes to `…/set`, reads to `…/get`; link state from the MQTT connection and `bridge/state`; rejoins from `bridge/event`. Faults: bridge unknown, unsupported version, `last_seen` off.
- Every Z2M device that has a valve profile is followed, configured or not, so a valve can be captured before it joins.

**Home Assistant link** (optional; `home-assistant-js-websocket`). In the app it connects through the Supervisor's proxy with the Supervisor token; in a plain container with a URL and a long-lived token. It supplies: states of sensors that are not on Z2M, the entity, device and area registries (names, device classes), and the house's time zone. It is never used for valves.

**Room sensors** are named by reference:
- `z2m:<ieee>` with a payload key (default `temperature`): read from MQTT, liveness from the life token. Needs no Home Assistant. A sensor's id is its reference, plus the key for a Z2M sensor.
- `ha:<entity id>`: value from state changes; liveness from `last_reported`, polled every 5 minutes because events do not carry it. An entity from Home Assistant's MQTT integration that is not a Z2M device cannot be judged and is used with a warning. While the link is down these sensors are pending, not stale.

Without a Home Assistant link, `ha:` sensors are refused at config time and the time zone comes from the settings.

## 12. One instance

The MQTT client uses a fixed client id and MQTT 5. If the broker reports "session taken over", another Heatmaster has connected: this one stops its MQTT client, stops writing and shows its transport as unusable with the reason "another instance". With a broker that only speaks MQTT 3.1.1 a takeover looks like a dropped connection; three drops within 30 s of connecting are treated the same way. The newest instance wins.

## 13. Outputs

**MQTT discovery** (prefix from the app's options, default `homeassistant`), one device message per room and one for Heatmaster itself, with availability through the client's last will:
- per room: temperature sensor, target temperature sensor, problem binary sensor, sync sensor (`in_sync`, `pending`, `not_holding`, `unverified`, `held`, `frozen`);
- for Heatmaster: problem binary sensor, problem count sensor with the list as attributes, "writes held" binary sensor, and a "stop writing" button. The button only turns hold on; turning it off needs the UI, because a button press cannot be checked for admin rights.
- A room `climate` entity is **not** published in plan 1 (fact 12). It arrives in plan 2 together with its command topics.
- A removed room's device is removed from discovery.

**HTTP API** (Fastify, bound to `127.0.0.1`): state snapshot and a live-update socket; export; preview; apply; resync; refresh a valve; restore and forget a valve; import originals; diagnostics. Every handler calls one pure `core` function or one runtime method.

**Problems** are level-triggered and appear in the API, the UI and the discovery entities. Critical ones may also raise a Home Assistant persistent notification when the link is up. Kinds: config unreadable, ledger unreadable, link down, transport unusable (including "another instance"), valve not adopted, valve orphaned, valve unsupported, valve silent, setting not holding, release stalled, schedule clamped, room has no fresh temperature, sensor stale, sensor out of range, sensor liveness unobservable, temperature feed lost.

**Web UI** (plan 1): one page with rooms and valves, problems, the config editor with preview and apply, the hold switch and the valve actions; English and Russian. The full panel is plan 4.

## 14. Container

One image, two processes under s6-overlay:
- **Caddy** listens on the ingress port, admits only the Supervisor's ingress address, serves the web UI's files with a single-page fallback, and proxies `/api/*` (including the socket) to the server. A second listener with a password is off by default and serves plain-container installs.
- **The server** (Node 26, Fastify) listens on `127.0.0.1` only.

Built on Home Assistant's base image with Node and Caddy copied in from their official images; `amd64` and `aarch64`. The app manifest asks for the MQTT service, the Home Assistant API, ingress with an admin-only panel, and the public config folder. The same image runs as a plain container with environment variables.

Uninstalling the app deletes `/data` and keeps the public folder. Valves are given back first by applying a config with no rooms.

## 15. Measurements that gate the build

On one TRVZB and one TRV-ZBT, supervised:
1. After a schedule write in `auto`, with no toggle: does the target change at once, at the next set point, or never? Does a setpoint written in `auto` hold until the next set point?
2. With batteries out: which settings does Z2M still publish after a write? How long from a good write to the published value, and how long can a queued write take to land?
3. Does every device message carry `last_seen`, does it change exactly when the device speaks, and does a replay leave it unchanged? What does Z2M publish when it restarts? What does a new subscriber receive?
4. `get`: which keys can be read on each model; how soon a sleeping valve answers; what Z2M publishes in response and whether `last_seen` changes; what happens when the valve does not answer.
5. TRV-ZBT: does a message naming group 3 leave the active group alone? Which group do the day values in a message belong to?
6. External temperature: fallback time, what the source select then reads, behaviour while `off`. Does an unchanged value produce a radio write?
7. What a battery swap or rejoin resets, and what Z2M publishes when it happens.
8. The valve's clock against local time.

## 16. Tests

- `core` is tested alone with vitest; property tests use fast-check.
- A simulator in `core`'s tests (simulated valve, fake Z2M speaking real payloads through the real bindings, fault plans) checks: convergence once faults stop; writes and refreshes within the budget; captured originals equal the true values before the first write and are restored on release; no write to a valve that is not managed or releasing, while held, or while a store is unreadable; no write to groups 1 or 2 of a TRV-ZBT; no mode write; the same when memory is dropped or the effect list is cut anywhere; a preview that matches the real run.
- The server is tested against an in-process MQTT broker with a scripted Z2M and a scripted Home Assistant websocket.
- The image is tested by starting it and calling the API through Caddy.

## 17. Build order

1. Styleguide, workspace, CI.
2. Supervised measurements.
3. Core: model, validation, schedule, temperature.
4. Core: settings, observation, ledger, memory, pacing, feed, desired, status, events, control, change.
5. Profiles and bindings; the simulator.
6. Server: MQTT transport, Home Assistant link, stores, runtime.
7. Server: HTTP API, discovery entities.
8. Web page.
9. Container and app packaging.
10. Supervised verification on the real house, starting with writes held, then one room, then a 24 h soak.

## 18. Room for the later plans

As v5 §15: manual changes become adopted settings with a value test (plan 2, with the room `climate` entity and its command topics); overrides, windows, seasons, modes, frost floor and child lock are clauses in the desired-settings function over stored intent; the heat output has its own timing rule and, where the output is an MQTT device, does not depend on Home Assistant; the full panel builds on the same API. A small optional Home Assistant integration could mirror problems into Repairs (D7).
