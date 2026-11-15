# Heatmaster architecture v6

**Status:** written 2026-11-14 after the user's decisions D6–D11; D12 added 2026-11-15. Amended the same day after three reviews of plan 1 v6 and the user's rulings on them; section 19 lists every must-fix finding and what changed. It replaces `2026-11-14-architecture-v5.md`, which stays as the record of how the core design was reached and reviewed (its sections 16 and 17 list every finding). The core of v5 carries over; the shell is new. Where this document and the spec disagree, this document wins (spec §11).

**Sources:** v5 and its reviews; `../research/` (existing projects); `../research/research-standalone-platform.md` (platform facts checked on 2026-11-14). Facts about valves and Zigbee2MQTT (Z2M) are still unmeasured on this house; section 15 lists the measurements. Numbers marked *provisional* are checked by them.

## 1. What Heatmaster is now

A standalone application in TypeScript on Node, shipped as a Home Assistant app (add-on) and as a plain container image. It manages Sonoff valves through Z2M over MQTT, reads room sensors from Home Assistant over the websocket API, shows its rooms in Home Assistant through MQTT discovery, and has its own web UI. Home Assistant can be down or absent; valves keep being followed, but room sensors are read only through it, so rooms then use the valves' own sensors.

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
| D12 | Config and ledger stay plain JSON files. No SQLite and no ORM in plan 1; SQLite may come later for history only, and decisions never read it | user |

Caddy is a reverse proxy for **one** server. Heatmaster must never run as two instances: both would write to the valves (section 12).

## 3. Why the earlier design leaked

It remembered what it did (commands, results, in-flight slots, phases, a "written" set, two clocks) and inferred the valve's state from that memory. Every remembered field was a second copy that could disagree with the valve. v5 removed the memory; v6 keeps that.

## 4. Device and platform facts

1. Z2M gives no per-write result. For sensor source, active group, mode and setpoint it publishes the new value only after the valve acknowledged the write.
2. The TRVZB schedule cannot be read from the valve. Z2M publishes what it sent.
   On TRV-ZBT, Z2M publishes the previous edit group's cached days in messages that already name the new edit group, even with a fresh `last_seen`. TRV-ZBT day keys are write-only: they are never decoded.
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

Time: the core never reads the clock. It receives `now` as a `Temporal.ZonedDateTime` in the house's time zone and compares instants as epoch milliseconds. Durations are milliseconds. The shell compares the wall clock with a monotonic clock between ticks; a difference of more than 5 minutes means the clock was set, and is treated as "link up" for every transport (liveness returns to unknown, every group is marked) and logged.

## 7. What is stored

**Config** (`/data/config.json`) — what the user wants: settings, schedules (stable ids), rooms (valves by id, weighted sensors), plus the server-owned `releasing` map (valve → time the release was ordered). The revision counts user changes only. `releasing` is not exported and cannot be set by a caller.

**Ledger** (`/data/ledger.json`) — per managed valve one record with its captured originals: the sensor source, and on TRV-ZBT the active group. Schedules are not captured (D11). Entries are create-only; an unreadable one can be accepted as "unknown" and is then skipped on release. Released records are kept in a `released` list.

**Readable copy** — after every ledger change the ledger is also written as indented JSON to the public folder (in the app: the `app_config` folder, which survives uninstall; `/data` does not), keeping five generations.

Both files carry a `version` and go through one fixture-tested migration per version. Writes are atomic (temporary file, flush, rename).

**A file that failed to load is never written.** Unreadable config: every valve is frozen; a config change is refused unless the caller sets `overwrite_unreadable`, and then the old file is copied aside first. Unreadable ledger, or a missing ledger while the config is unreadable or has a valve in a room or in `releasing`, or while the readable copy still holds a record (both files lost, or a reinstall): no valve is written to, nothing joins, and `import_originals` restores from the readable copy.

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

A config change (`plan_change`): validate; compare valve sets over the whole config (a moved valve is neither joining nor leaving; a joining valve that already has a record keeps it). Refuse on: unreadable config without `overwrite_unreadable`; stale revision; unknown or unsupported valve; unusable transport; ledger unreadable and anything joins; a new valve from which no message has arrived (`valve_not_observed`; the server then asks the valve to report, and the caller retries); a new valve whose captured setting cannot be read and was not accepted; an invalid sensor reference; no time zone (no Home Assistant link, none in the new config, and the current config is missing, unreadable or names one). Effects in order: save ledger with new records, write the readable copy, save config with leaving valves added to `releasing`. A dry run returns the preview only.

## 9. Observation and evidence

- A transport delivers device messages with a **life token** that changes if and only if the device itself spoke (Z2M: `last_seen`). A device is *heard* when its token differs from the stored one; the first token after a start or after the link came back is stored without counting.
- Liveness: unknown, live, silent (valves after 2 h unheard; sensors after the staleness timeout). While a link is down its devices are unknown, not silent.
- **Observable:** at least one message from the valve has arrived since start. Nothing is written to a valve that is not observable. Every followed device has a state from the moment it is listed, so one that never speaks becomes silent in time.
- Per group of settings the binding states the **evidence**: `acked` or `echoed`, and whether the group is **readable** through `get`.
- **Marks.** A mark on a group means "do not trust the cached value". Marks are set on every group at start, on rejoin, on Z2M restart or MQTT reconnect, when a valve returns from silence, on `resync`, and when the group's maximum age passes (24 h for every group, *provisional*). A marking event does not replace a mark that was not acted on yet (not asked, not sent); it replaces one that was.
  - A marked **readable** group is cleared by a heard message that comes after Heatmaster asked the valve to report (`Refresh`). If the fresh value differs, the ordinary rule writes it.
  - A marked **unreadable** group (the schedule) is sent again in full once the valve was heard since the marking, and cleared by the next heard message after that.
  - Marks are stamped with the time the request actually went out. Messages that arrive while requests are being sent are applied afterwards, in order, so a message that arrived before a request left is not taken for its answer.
- **Refresh.** A valve gets a `Refresh` when it is not observable, when a mark still lacks its evidence (a readable group not yet asked since the marking, or the valve not heard since), or when it is releasing, settled, past the release hold and not heard since. A valve whose profile has no readable group is never refreshed. Refreshes are paced like writes.
- Known limit: Z2M cannot tie an answer to a request. A read or write lost right after a rejoin, followed by an unrelated message from the valve, leaves a stale cached value believed until the next daily check.

**Plan 1 settings**

| Group | Members | Policy | Evidence | Readable | Captured and restored |
|---|---|---|---|---|---|
| `schedule` | seven days | enforce | TRVZB `echoed`; TRV-ZBT `none` (write-only) | no | no |
| `active_group` (TRV-ZBT) | one | enforce: group 3, only while the schedule group has no mark and a write of the current week was sent | acked | yes | yes |
| `sensor_source` | one | enforce: `external` once a push went out and the room temperature has been fresh for 10 min; `internal` when the room's sensors are stale or absent; otherwise left alone | acked | yes | yes |
| `external_temperature` | one | stream | — | — | no |

On TRV-ZBT Heatmaster writes days only into group 3, always naming the group in the same message, and never writes groups 1 and 2. A valve whose active group is already 3 may join; its group 3 is overwritten. Mode and setpoint are readings in plan 1.

A write-only schedule (TRV-ZBT) is never compared with anything the valve says. It is sent when its mark is ready and when no write of the current week is recorded. The sign that a write took is the next heard message after it: a fresh `last_seen`, with `weekly_schedule_status: "success"` expected on it. For TRVZB nothing confirms a day write beyond that heard message.

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
- **Activation.** `none`, or `setpoint`: after a schedule write whose days differed is observed equal (TRVZB) or has been followed by a heard message (TRV-ZBT) while the valve is in `auto`, the current set point's temperature is written once. A mode toggle is not designed; if measurement shows it is needed, work stops and it is designed first.
- **Temperature push** (as v5 §9): on a change of 0.2 °C no sooner than the interval, and every 30 min; only to managed, observable, non-silent valves; stops when the room goes stale, when the valve is off (unless the profile says it may be fed) and on release; never queued or confirmed. When the feed stops and starts again, the next push still waits for the interval (at most 30 min) since the last one, so a room whose freshness flaps cannot cause a push per flap. A push that did not go out is reported back (`push failed`), so the valve does not count as fed.
- **Release** finishes when every restorable setting has stayed equal for the release hold (*provisional:* 15 min), counted from after the release order, and the valve was heard during that time; a valve that does not speak by itself is asked once the hold has passed. Then the record moves to `released` and the valve leaves `releasing`.
- **Hold writes** is a config setting, on by default, and an input to the tick: while on, no publish, setpoint write or push is decided. Reads continue, so a held installation still learns what its valves hold.
- **Preview** runs the same selection on a copy with pacing off, hold ignored, pushes assumed sent and each mark treated as satisfied once, until nothing more is written.
- **Events between ticks** (`applyEvent`, pure): device message, rejoined, bridge restarted, link up, resync requested, push failed, sent. They update observations, set or clear marks, forget a push that failed, and move a mark's stamp to the time its request went out.
- Removed from v5: the "schedule not followed" detection and everything it needed.

## 11. Inputs

**MQTT** (MQTT.js, the server's own client). Broker address and credentials come from the Supervisor's MQTT service in the app, or from environment variables in a plain container.
- Z2M transport: base topic from the app's options (default `zigbee2mqtt`), confirmed by `bridge/info`; devices from `bridge/devices`; state from `<base>/<friendly name>`; writes to `…/set`, reads to `…/get`; link state from the MQTT connection and `bridge/state`; rejoins from `bridge/event`. Faults: bridge unknown, unsupported version, `last_seen` off.
- Every Z2M device that has a valve profile is followed, configured or not, so a valve can be captured before it joins.

**Home Assistant link** (optional; `home-assistant-js-websocket`). In the app it connects through the Supervisor's proxy with the Supervisor token; in a plain container with a URL and a long-lived token. It supplies: the states of the room sensors, the entity, device and area registries (names, device classes, which device an entity belongs to), and the house's time zone. It is never used for valves.

**Room sensors** are read only through Home Assistant. The one reference is `ha:<entity id>`, and it is also the sensor's id. There is no payload key and no `z2m:` sensor reference; a `z2m:` reference is refused at config time. Valves stay on MQTT.
- Value: from state changes. A state that is not a number keeps the last number until the staleness timeout (default 120 minutes, 10 minutes at least).
- Liveness: the newest `last_reported` among all entities of the sensor's Home Assistant device (temperature, humidity, battery and the rest), because Home Assistant's MQTT temperature entity updates `last_reported` only when the value changes. The device comes from the entity registry. The link polls those entities every 2 minutes, one request per watched device, because events do not carry `last_reported`. Nothing is polled while no sensor is configured.
- An entity that has no device cannot be judged: it is used with a warning, as if live.
- While the link is down these sensors are pending, not stale.

Without a Home Assistant link, every room sensor is refused at config time, and the time zone comes from the settings; a config that names none is refused (`timezone_missing`), unless the config it replaces is readable and names none either.

## 12. One instance

The MQTT client uses a fixed client id and tries MQTT 5 first; it changes the protocol version only after an attempt that reached the broker and was turned down there. If the broker reports "session taken over", another Heatmaster has connected: this one stops its MQTT client, stops writing and shows its transport as unusable with the reason "another instance". A takeover can also look like a dropped connection (always on MQTT 3.1.1), so three drops of an established connection within 30 s (a sliding window) are treated the same way under either version. The stop is permanent until the process is restarted, and the health check fails while the MQTT client has a fault; three broker restarts within 30 s look the same, and the documentation says so and recommends an MQTT 5 broker. A refused login is a fault of its own (`mqtt_auth_failed`) and is retried every 30 s. The newest instance wins.

## 13. Outputs

**MQTT discovery** (prefix from the app's options, default `homeassistant`), one device message per room and one for Heatmaster itself, with availability through the client's last will:
- per room: temperature sensor, target temperature sensor, problem binary sensor, sync sensor (`in_sync`, `pending`, `not_holding`, `unverified`, `held`, `frozen`);
- for Heatmaster: problem binary sensor, problem count sensor with the list as attributes, "writes held" binary sensor, and a "stop writing" button. The button only turns hold on; turning it off needs the UI, because a button press cannot be checked for admin rights.
- A room `climate` entity is **not** published in plan 1 (fact 12). It arrives in plan 2 together with its command topics.
- A removed room's device is removed from discovery.

**HTTP API** (Fastify, bound to `127.0.0.1`): state snapshot and a live-update socket; export; preview; apply; resync; refresh a valve; restore and forget a valve; import originals; diagnostics. Every handler calls one pure `core` function or one runtime method.

**Problems** are level-triggered and appear in the API, the UI and the discovery entities. Critical ones may also raise a Home Assistant persistent notification when the link is up. Kinds: config unreadable, ledger unreadable, link down, transport unusable (including "another instance"), valve not adopted, valve orphaned, valve unsupported, valve silent, valve not in `auto` (it cannot follow its schedule, and Heatmaster never writes the mode), setting not holding, release stalled, schedule clamped, room has no fresh temperature, sensor stale, sensor out of range, sensor liveness unobservable, temperature feed lost, a store that could not be written.

**Web UI** (plan 1): one page with rooms and valves, problems, the config editor with preview and apply, the hold switch and the valve actions; English and Russian. The full panel is plan 4.

## 14. Container

One image, two processes under s6-overlay:
- **Caddy** listens on the ingress port, admits only the Supervisor's ingress address, serves the web UI's files with a single-page fallback, and proxies `/api/*` (including the socket) to the server. A second listener with a password is off by default and serves plain-container installs.
- **The server** (Node 26, Fastify) listens on `127.0.0.1` only. s6 starts it again when it ends, but the server starts at most five times in any 15 minutes: a further start halts the container without starting the server. The count is kept in the data folder, so it holds whoever starts the container again. Every start asks every managed valve to report, so a crash loop must not become a read loop.

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

As v5 §15: manual changes become adopted settings with a value test (plan 2, with the room `climate` entity and its command topics); overrides, windows, seasons, modes, frost floor and child lock are clauses in the desired-settings function over stored intent; the heat output has its own timing rule and, where the output is an MQTT device, does not depend on Home Assistant; the full panel builds on the same API. History (a log of config changes, problem history, per-valve write counts, temperature history) goes into SQLite when its first feature arrives, without an ORM; config and ledger stay JSON files (D12). A small optional Home Assistant integration could mirror problems into Repairs (D7).

## 19. Review record

Plan 1 v6 was reviewed three times on 2026-11-14: core contracts and arithmetic ("Core"), server, platform and security ("Server"), and fault scenarios against this document ("Safety"). Every must-fix finding is listed with what changed. Task numbers are those of plan v6.1, in which the simulator task is split in two and the later tasks moved up by one. The should-fix findings and the user's rulings on them are in the plan's last section.

| Finding | What was wrong | What changed |
|---|---|---|
| Core M1 | The styleguide allowed two error classes in the core; the plan has three, and plain errors for a caller's mistake | Plan Task 1: the styleguide names the three classes and the plain errors |
| Core M2 | Effect kinds are camelCase while the styleguide asked for snake_case codes | Plan Task 1: effect kinds are the stated exception; event kinds stay snake_case |
| Core M3 | The pacing budget "exactly 52" depended on an end point that was not stated | Plan Task 7: the budget scenarios run for t = 0 s … 86 400 s inclusive, on whole seconds |
| Core M4 | The setpoint write could go out while the schedule was still marked | Plan Task 10: the setpoint step needs a schedule group that is no candidate and has no mark |
| Core M5 | `ChangePlan.joining` and the pseudocode's `joining` meant different sets | Plan Task 11: the pseudocode's set is `entering`; `joining` holds the new valves only, in id order |
| Core M6 | "At most 7 days ahead" missed a change on the same weekday of the next week | Plan Task 5: the rest of today and the seven days after it; a test for the case |
| Core M7 | The liveness boundary was strict in one branch and not in the other | Plan Task 6: silent only when more than the limit has passed, in both branches; Task 13's scenario follows |
| Server M1 | The Zigbee2MQTT transport missed an MQTT connection made before it started, so its link never came up | Plan Task 15: the transport reads the client's state at start |
| Server M2 | The s6 services got no container environment | Plan Task 22: the scripts start through `with-contenv`; each service depends on `base` |
| Server M3 | The plan and the research file named different paths for registering services | Plan Task 22: the plan's path stays, with a duty to confirm it against the s6-overlay README; the research file is believed wrong |
| Server M4 | The shape of the Supervisor's MQTT answer was not pinned, so the script and its test could agree on a wrong one | Plan Task 22: the fields are read under `data`; the test's stand-in serves the documented body |
| Server M5 | A failed load of the Home Assistant link was not defined | Plan Task 16: the link stays down and loads again at the next connection; a failed poll changes nothing |
| Server M6 | A test line of the "stop writing" button could not pass as written | Plan Task 20: the scenario states the stored config and checks the revision |
| Server M7 | A test needed a broker that leaves a CONNECT unanswered, which the helper did not offer | Plan Task 15: `withholdConnack` on the raw broker; Task 19 consumes it |
| Server M8 | `panel_admin` was treated as access control without proof that it is one | Plan Task 22: confirm in Home Assistant Core; then refuse non-admins by the ingress header, or state plainly who can change the config |
| Safety M1 | Temperature pushes were unbounded when a room's freshness flapped | Section 10; plan Task 7: `lastPushAt` survives a stopped feed, and the next push waits for the interval; Task 14's budget line |
| Safety M2 | A crash loop was an unbounded read loop | Section 14; plan Task 22: a restart limit of five starts in 15 minutes (final form in the "Verification N1" row) |
| Safety M3 | With both files lost, or after a reinstall, Heatmaster's own values were captured as originals | Section 7; plan Task 17: a missing ledger is locked while the readable copy holds a record; Tasks 13, 18, 19 and 21 follow |
| Safety M4 | Three facts the design depends on were not measured or gated | Plan Task 2: the fallback time and the return from it, and `last_seen` after a write and after a `get`, each with a stop rule; Task 23 checks the fallback if the user declined the wait |
| Safety M5 | A valve that is not in `auto` read `in_sync` for ever | Section 13; plan Tasks 8 and 10: the problem `valve_not_auto` |
| Verification N1 | The restart limit halted one start early, its test lines could not pass, and a restart of the halted container could start the count again | Section 14; plan Task 22 (v6.2): the count is kept in the data folder, so the server starts at most five times in any 15 minutes, whoever starts the container again |

Design changes from the should-fix findings and the rulings, in the sections above: marks are not replaced before they were acted on, and are stamped with the time the request went out (sections 9 and 10); `active_group` waits for an unmarked schedule (section 9); no refresh without a readable group, and one refresh for a settled release (sections 9 and 10); the `push failed` event (section 10); the clock-jump rule (section 6); the 2-minute poll, the device-wide liveness of `ha:` sensors, the 120-minute default and the 10-minute lower limit of the staleness timeout (section 11); the refusal without a time zone (sections 8 and 11); the takeover count under both protocol versions, the permanent stop and `mqtt_auth_failed` (section 12); the problems "valve not in auto" and "a store that could not be written" (section 13).

Not adopted, by the user's ruling: an automatic recovery from "another instance"; a backoff across alternating desired values (the token bucket bounds them); a heard message as a condition for capturing originals (a preview or an apply asks each joining valve to report instead).
