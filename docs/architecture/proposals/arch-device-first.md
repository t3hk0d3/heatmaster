# Heatmaster architecture — device-first

Stance: start from what the valve and Zigbee2MQTT (Z2M) can really do, and put one honest boundary, the valve driver, on top of that. 2026-11-14.

Sources were read today from the `master` branches of Z2M (package version 2.14.3), zigbee-herdsman and zigbee-herdsman-converters. The versions installed on the user's system were not checked (unverified); the driver reads `bridge/info` at start and refuses versions it does not know.

## 0. Findings the design rests on

| # | Finding | Status |
|---|---|---|
| F1 | **No per-request result for a device `set` or `get`.** Z2M awaits the converter and, on error, only logs `Publish 'set' '<key>' to '<name>' failed: '<error>'`. The `transaction` field exists only for `bridge/request/*`. | Sourced: [publish.ts](https://github.com/Koenkk/zigbee2mqtt/blob/master/lib/extension/publish.ts), [MQTT topics](https://www.zigbee2mqtt.io/guide/usage/mqtt_topics_and_messages.html) |
| F2 | **The state publish after a `set` is not blind.** For attribute writes (mode, setpoint, sensor source, external temperature, child lock) the converter awaits the Zigbee write and checks its status before returning the state Z2M publishes. A value that changes to what was written means the valve acknowledged it. On failure nothing is published. | Sourced: [toZigbee.ts](https://github.com/Koenkk/zigbee-herdsman-converters/blob/master/src/converters/toZigbee.ts), [modernExtend.ts](https://github.com/Koenkk/zigbee-herdsman-converters/blob/master/src/lib/modernExtend.ts), [endpoint.ts](https://github.com/Koenkk/zigbee-herdsman/blob/master/src/controller/model/endpoint.ts) |
| F3 | A failure shows only as an error line on `<base>/bridge/logging`. Two identical lines in a row are published once. It is log text, not an API. | Sourced: [bridge.ts](https://github.com/Koenkk/zigbee2mqtt/blob/master/lib/extension/bridge.ts) |
| F4 | **Sleepy devices.** If the first send fails and the device has a poll-control check-in, the request is queued and sent when the device next speaks. A newer write of the same attribute replaces the queued one. So a failure can be logged an interval later, a write can land long after it was sent, and repeated writes of one attribute do not pile up. | Sourced: [endpoint.ts](https://github.com/Koenkk/zigbee-herdsman/blob/master/src/controller/model/endpoint.ts), [requestQueue.ts](https://github.com/Koenkk/zigbee-herdsman/blob/master/src/controller/helpers/requestQueue.ts). Whether these valves have that cluster, and their interval: **unverified** |
| F5 | `get` (one Zigbee read, same queue, answer arrives as an ordinary state message) exists for mode, setpoint, running state, sensor source, external temperature, child lock. **The TRVZB weekly schedule is set-only: Z2M cannot read it.** What v4 calls the "reported schedule" is Z2M's memory of the last write. The generic `command` converter could send `getWeeklySchedule`, and a decoder for the answer exists: **unverified** on hardware. The TRV-ZBT schedule has a real `get`. | Sourced: [sonoff.ts](https://github.com/Koenkk/zigbee-herdsman-converters/blob/master/src/devices/sonoff.ts), [TRVZB page](https://www.zigbee2mqtt.io/devices/TRVZB.html), [TRV-ZBT page](https://www.zigbee2mqtt.io/devices/TRV-ZBT.html) |
| F6 | All schedule days sent in **one MQTT message** are grouped: identical days go out as one Zigbee command. Through HA `text` entities each day is its own message and command. | Sourced: sonoff.ts, [homeassistant.ts](https://github.com/Koenkk/zigbee2mqtt/blob/master/lib/extension/homeassistant.ts) |
| F7 | **TRV-ZBT `schedule_group_to_edit` is not a device attribute.** It is Z2M process memory, lost when Z2M restarts (it then falls back to the active group) while Z2M's cache and HA still show the old value. A day write uses the group named **in the same message**. Selecting a group without days makes Z2M read that group from the valve. Day writes do not wait for the valve; its answer arrives later as `weekly_schedule_status`. v4's "set group 3, wait, write days" can therefore overwrite the household's active group after a Z2M restart. | Sourced: sonoff.ts |
| F8 | With `last_seen` enabled, every device message carries the device's last-seen time and Z2M publishes on every change of it. The cache is replayed at Z2M start and 30 s after HA comes online, **with the old `last_seen`**. Default is disabled. | Sourced: [controller.ts](https://github.com/Koenkk/zigbee2mqtt/blob/master/lib/controller.ts), homeassistant.ts, [settings.ts](https://github.com/Koenkk/zigbee2mqtt/blob/master/lib/util/settings.ts) |
| F9 | Availability is off by default. Battery devices are never pinged and go offline after 25 h of silence. Too coarse to use. | Sourced: [availability.ts](https://github.com/Koenkk/zigbee2mqtt/blob/master/lib/extension/availability.ts) |
| F10 | Reporting is configured for local temperature, setpoint and mode with a 1 h maximum, so a live valve speaks at least hourly. | Sourced: sonoff.ts, [reporting.ts](https://github.com/Koenkk/zigbee-herdsman-converters/blob/master/src/lib/reporting.ts) |
| F11 | External temperature: fallback to the internal sensor after about 2 h of silence; back to external on the next write; values outside 0–99.9 are silently ignored; in external mode the valve reports the external value as its `local_temperature`. | Community-measured on firmware 1.2.1: [PR 8873](https://github.com/Koenkk/zigbee-herdsman-converters/pull/8873), [discussion 26308](https://github.com/Koenkk/zigbee2mqtt/discussions/26308). **Unverified** on 1.4.4 and 1.1.0 |
| F12 | A schedule needing auto → heat → auto to take effect: no source found. | **Unverified** |
| F13 | Battery cost of frequent writes: no measurement found; one report that the display wakes on every write. | **Unverified** |

## 1. Diagnosis

v4 asks a pure core to work out what happened on a radio it cannot see. Its inputs are HA entity states, which sit three lossy layers above the valve (valve → Z2M cache → MQTT → HA entity). Each layer erases a distinction the core then needs: Z2M merges device reports, acknowledged writes and old cache into one document; HA drops repeats and timestamps; "OK" means "published". Two different device situations therefore look identical in the snapshot, each review finds another such pair, and each fix adds a field to shared contracts (settle time, acknowledged key, `heard_at`, `heat_seen`).

Two beliefs v4 builds on are false at the device: the TRVZB schedule is never read back (F5), and the TRV-ZBT edit group is not on the valve (F7).

The structural cause: no component owns the question "what do we know about this valve, and how do we know it". Evidence is thrown away at the bottom and guessed back at the top.

## 2. Core idea

One driver per valve talks to Z2M over MQTT directly and is the only code that knows about radio, cache and timing. Everything it reports upward carries a trust grade, and every write it accepts ends in an outcome decided from device evidence. Each valve runs one operation at a time, so evidence that Z2M does not correlate can be attributed to the single write in flight. Configuration writes (idempotent, confirmed) and the temperature feed (a lossy stream whose health the valve itself reports) are different verbs with different guarantees. Above the driver, everything is a plain comparison of desired against viewed settings, with no clocks, command ids or timers.

## 3. Components and boundaries

| Module | One responsibility | Owns | May call | May not |
|---|---|---|---|---|
| `transport/z2m.py` — `Z2mLink` | Turn MQTT into typed events and publishes | Subscriptions; per-device last-seen token and frame counter | HA's MQTT publish/subscribe | Interpret any value |
| `profiles/sonoff_trvzb.py`, `sonoff_trv_zbt.py` | Describe a model as data | Nothing (pure tables and codecs) | Nothing | Do I/O |
| `driver/valve.py` — `ValveDriver` | Make one valve hold settings, honestly | Register table, operation queue, radio budget, attempt memory (all in memory) | Link, profile, valve store | Know rooms or schedules |
| `driver/store.py` | Keep each valve's record | The valve store | — | Update or delete originals |
| `control/` (pure, no HA) | Rooms, schedule resolution, weighted temperature → desired settings per valve; `plan()` | Nothing | — | See MQTT, time sources, outcomes |
| `runtime.py` | Run `plan()` on change, call driver verbs, project status and problems | Config store handle | Control, drivers | Talk to MQTT |
| HA glue | Entities, services, Repairs, diagnostics | — | Runtime | — |

**Transport contract.** `describe(ieee) -> DeviceInfo` (identity, firmware, exposed keys with access, clusters; from `bridge/devices`), `send(ieee, payload) -> None | SendResult`, `read(ieee, keys)`, and a stream of:
- `Frame(ieee, values, fresh: bool, seq: int)` — `fresh` is true only when `last_seen` advanced since the previous frame (F8). `seq` counts fresh frames.
- `Fault(ieee, key, text)` — from `bridge/logging` (F3). A hint that speeds up failure, never proof of success.
- `Presence(ieee, announce | leave | renamed)`, `Bridge(online, info)`.

`capabilities: per_write_result, reads, atomic_batch`. For Z2M: false, true, true. Writes go to `<base>/<ieee>/set`, so renames do not matter.

**Profile contract.** `matches(DeviceInfo)`; a table `Setting → SettingSpec(range, step, firmware gate)`; per transport family a binding `Setting → (keys, encode, decode, confirm rule, read method, trust ceiling)`; and `activation`, `schedule_slot`, `feed_when_off`. A driver exists only for a pair with a binding.

**Driver contract (everything above sees only this).**
```
view() -> ValveView(identity, capabilities, liveness, registers, feed, owed_auto, adopted)
adopt() -> Outcome
ensure(setting, value) -> Outcome
program_schedule(week) -> Outcome
feed_temperature(celsius | None) -> None
audit(settings) -> Outcome
release() -> Outcome
```
- `Register(value, trust, in_doubt)`. Trust: `REPORTED` (fresh frame, no write of ours in flight, or the answer to our read) > `ACKED` (changed to what we wrote while that write was in flight, F2) > `ECHOED` (Z2M published without waiting for the valve; TRV-ZBT days) > `CACHED` (seen only in replayed frames) > `UNKNOWN`.
- `Outcome`: `CONFIRMED(trust)`, `NOT_NEEDED`, `REJECTED(reason)`, `UNCONFIRMED`, `UNREACHABLE`, `THROTTLED`.
- `liveness`: `LIVE` (fresh frame within 2 h), `QUIET`, `UNPROVEN` (none yet since start; cached values usable).
- `feed`: `FED`, `STARVED`, `OFF`, `UNKNOWN`.

## 4. State model

**Persisted — two stores.**
1. **Config store** (rooms, schedules, settings; versioned document, revision counter). Owned by the runtime.
2. **Valve store**, one record per adopted valve: `adopted_at`; `originals: Setting → (value, trust, captured_at)`, create-only; `owed_auto: bool`; `released_at`. A copy of the originals is also written once to a sidecar file in the HA config directory.

What breaks if removed: without `originals`, no rollback. Without `owed_auto`, a crash between `heat` and `auto` leaves a valve ignoring its schedule for ever. Without the sidecar, a lost `.storage` file ends rollback. Nothing else is persisted for the write path. Plans 2–5 add domain state (overrides, output), not write tracking.

**Derived, in memory.** Registers and trust (rebuilt from Z2M's replay plus one `get` of mode per valve at start, staggered, which also proves liveness); the operation in flight; attempt memory; radio budget; feed health.

**Crash at any point.** Every operation is idempotent and resumes from "desired differs from viewed":
- before originals are saved: nothing was sent, because adoption precedes every write;
- during a write: after restart the register shows the new value or it does not; `plan()` asks again;
- between `heat` and `auto`: `owed_auto` was saved first; the driver's first act at start is `ensure(mode, auto)`;
- during release: `released_at` is set only after every restore is confirmed.

**Lost or corrupt store.** Config store: the integration stops with a Repairs issue; drivers stay passive; nothing is released. Valve store: stop, offer to import the sidecar. Never re-adopt automatically, because that would record Heatmaster's own values as originals.

**Upgrade.** Both stores carry a version with forward migrations. A newer version than the code knows stops the integration.

## 5. Write path

**Configuration write, `ensure(setting, value)`:**
```
viewed value equals value, trust ≥ ACKED          → NOT_NEEDED (no radio)
not adopted, Z2M offline or valve QUIET           → UNREACHABLE
same (setting, value) failed recently, or bucket empty → THROTTLED
note seq; send one message; wait for the first of:
   register changes to value in a frame           → CONFIRMED(ACKED)
   profile says read back: read, fresh frame equal → CONFIRMED(REPORTED)
   Fault for this key                             → REJECTED (validation) or UNCONFIRMED (radio)
   deadline                                       → UNCONFIRMED, register marked in_doubt
```
The deadline is the only timer and uses one monotonic clock. Z2M's clock is never compared with HA's; `last_seen` is only a token that advances. A late arrival (F4) still flips the register to the value, so a slow write confirms itself and is not retried.

**Schedule, `program_schedule(week)`:** one message with all seven days, plus the group on TRV-ZBT (F6, F7). Days are compared by meaning, ignoring padding and repeats. TRVZB confirms as `ACKED`, or `REPORTED` if the hardware check shows `getWeeklySchedule` works. TRV-ZBT confirms by reading group 3 back and treats `weekly_schedule_status: fail` as rejection; the active group changes only after that.

**Making it effective** is part of the same operation, chosen by the profile's `activation`, which is measured, not assumed (F12):
- `NONE`;
- `SETPOINT`: one write of the current set point's temperature while in `auto`; the valve never leaves `auto`;
- `MODE_EXCURSION`, only if measurement forces it: save `owed_auto`; `ensure(mode, heat)`; then **always** `ensure(mode, auto)` whatever the first returned; clear `owed_auto` only when `auto` is confirmed. It starts only from a reported `auto`. A queued `heat` is replaced by the later `auto` (F4), so the unsafe ordering cannot arise inside Z2M.

**Temperature feed, `feed_temperature(c)`:** not a configuration write. Latest value wins, nothing is queued or retried, and no push is confirmed individually. The driver switches the sensor source to external after the first acknowledged push, and back when given `None`. Health comes from the valve: `FED` while the source reads external and, where the profile says so, the valve's `local_temperature` follows the pushed value (F11); `STARVED` when it reports `remote_source_offline`. This replaces v4's eight-field keepalive state.

**What bounds radio writes.** The feed has a fixed cadence and a minimum spacing. Configuration writes pass a per-valve token bucket (burst 6, one refill per 30 min, two tokens reserved for restoring `auto`). Attempt memory per setting allows the same value again after 2 min, 10 min, then 6 h; it clears on a device announce, a changed value or `resync`. A `REJECTED` value is not retried.

**Reads** are spent only at start, after a device announce (rejoin reverts settings), after a Z2M restart, and in the daily audit.

**Dry run** is `plan(config, views)`: a list of (valve, setting, viewed value with trust, desired value, would write). It is driven by desired settings, so a valve never heard from yields "write, current value unknown", never an empty result.

## 6. Original settings and rollback

- `adopt()` captures every setting the profile lists, at one moment, before any write, and saves the record and sidecar. Write verbs refuse a valve without a record.
- Each original keeps its trust. A TRVZB schedule is `CACHED` ("what Z2M last wrote") unless `getWeeklySchedule` works; the setup flow shows the captured values and the user confirms them.
- The store has no update call for originals. Heatmaster's values cannot replace them.
- TRV-ZBT: Heatmaster owns group 3. Adoption first reads group 3 from the valve (F7) and stores it, so its earlier content is captured by software too. Groups 1 and 2 are never written.
- `release()` is `ensure(original)` for every setting, then `ensure` of the original active group. Idempotence skips whatever never changed. It finishes when all are confirmed and reports per setting until then.
- Removing a valve or the integration runs release first; an empty config never implies release.

## 7. Issue table

| # | Class | In this design | If the transport gave real per-write results |
|---|---|---|---|
| 1 | Did the write take | Handled in one place: `ensure`. Still a risk: evidence is attributed, not correlated, and an acknowledged write proves acceptance, not behaviour | **Delivery and acceptance disappear.** "Accepted but not followed" stays |
| 2 | Schedule refresh | One driver operation, one saved boolean; possibly deleted by measurement | Simpler, **not gone**: two steps and a crash between them remain |
| 3 | Originals and release | Overwriting impossible by construction (create-only, adopt before write). Still a risk: TRVZB originals may be Z2M's cache | **Not affected**, except release knowing when it is done |
| 4 | Persistence and crashes | Handled in one place: the valve store; everything else is re-derived | **Not affected** |
| 5 | Liveness and freshness | Handled in one place: `Frame.fresh`. Requires Z2M `last_seen` | **Not affected**; reports are another channel |
| 6 | Write volume | Impossible by construction to exceed the bucket | Never-confirming loops disappear; **a budget is still needed** |
| 7 | Dry run | Handled in one place: `plan()` | **Not affected** |
| 8 | Contract drift | Seven verbs and one view; a new setting is a profile row. Still a risk if a later plan needs a new verb | **Smaller contract**, otherwise not affected |

Z2M sits in between: results exist (F2, F3) but are not tied to a request. Serial execution per valve is what makes them usable. A ZHA transport with `per_write_result` returns the result from `send` and the driver skips the wait (unverified for ZHA's API).

## 8. Costs and risks

- **It leaves HA's entity layer** for valves, reversing part of spec §4 (approach A). Heatmaster then depends on Z2M topics, payload keys and one log format.
- **Attribution can be wrong** when someone else writes the same value at the same moment; the result is still a valve holding the desired value.
- **`ACKED` depends on converter behaviour** (F2). A converter that stops awaiting the write would silently weaken it; the version check and recorded-traffic tests are the guard.
- **Most likely wrong:** deadlines and budgets before the check-in interval is measured (F4), and the feed-health rule if `local_temperature` does not mirror the pushed value on current firmware.
- **Given up:** v4's generic reconciler and its exhaustive retry table; a write-ahead log of every command.

## 9. Hardware questions and user decisions

Measure on one TRVZB and one TRV-ZBT, supervised, before building steps 5–6:
1. After writing a schedule in `auto`: does the setpoint follow at once, at the next set point, or only after a mode change? Does a setpoint write in `auto` hold until the next set point?
2. Does `getWeeklySchedule` through the `command` key return the TRVZB schedule?
3. Poll-control cluster and check-in interval (from `bridge/devices`); time from send to confirmation.
4. External mode on current firmware: mirror in `local_temperature`, fallback time, `remote_source_offline` reporting, behaviour while `off`.
5. TRV-ZBT: reading group 3; a write naming group 3 leaves the active group alone; `weekly_schedule_status`.
6. Which settings revert on rejoin or battery change.
7. Battery use at 5-minute against 30-minute pushes.

**Needs the user's decision:**
1. **Push every 5 minutes even when unchanged.** The valve's own timeout is about 2 h. Cheaper: push on a change of 0.1 °C or more (at most every 5 min) plus a 30-minute heartbeat.
2. **Require Z2M's `last_seen` option** (already on in this house). Supporting installations without it costs the replay-guessing code that failed review twice. Cheaper: refuse to manage valves until it is on.
3. **Rollback fidelity on TRVZB.** If question 2 fails, "original schedule" can only mean what Z2M remembered. Cheaper than chasing certainty: the user confirms the captured schedule at adoption.

Also for the user to note: valve access moves from HA entities to MQTT (§8).

## 10. Build order

This is a design, not a plan; the plan made from it starts with the styleguide and carries the full BDD skeleton.

1. Styleguide, scaffold, and a recorded-traffic harness: capture real MQTT traffic from both models read-only; build a scripted fake Z2M from it.
2. Supervised hardware session answering §9; write `docs/device-notes.md`.
3. `Z2mLink`: frames with `fresh` and `seq`, faults, presence. Works read-only against the live system.
4. Profiles and `ValveView`: a diagnostics dump of all ten valves with trust grades. No writes yet.
5. `adopt`, `ensure`, `release` with the valve store, budget and attempt memory. Supervised: adopt one valve, change one setting, release, compare.
6. `program_schedule` with the measured activation, and `feed_temperature`. Supervised on one valve, then one room.
7. `control/` and `plan()`, config store, `apply_config` with dry run.
8. Room entities, Repairs, diagnostics; take the 5-minute job over room by room.
9. Live verification and a rollback rehearsal on one room.

## Appendix: driver contract as a BDD skeleton

```
ValveDriver
    adopt
        With every setting readable
            - saves originals with their trust, then the sidecar
        With a record already present
            - changes nothing and returns NOT_NEEDED
        With the store unwritable
            - returns UNREACHABLE and no write verb is accepted
    ensure
        With the viewed value equal and trust ACKED or better
            - returns NOT_NEEDED and sends nothing
        With the register changing to the value while the write is in flight
            - returns CONFIRMED(ACKED)
        With a validation Fault for the key
            - returns REJECTED and does not retry that value
        With the deadline passing
            - returns UNCONFIRMED and marks the register in_doubt
        With the value arriving after the deadline
            - clears in_doubt and sends nothing more
        With the bucket empty or the same value inside its backoff
            - returns THROTTLED and sends nothing
        With the valve QUIET or Z2M offline
            - returns UNREACHABLE and sends nothing
    program_schedule
        On a TRV-ZBT
            - names group 3 in the same message as the days
            - changes the active group only after the read-back matches
        With activation MODE_EXCURSION and heat unconfirmed
            - still sends auto
            - keeps owed_auto until auto is confirmed
        After a restart with owed_auto set
            - sends auto before anything else
    feed_temperature
        With the valve reporting mode off and feed_when_off false
            - sends nothing
        With the valve reporting remote_source_offline
            - view().feed is STARVED
        With None
            - restores the internal sensor source
    release
        With a setting that never changed
            - sends nothing for it
        With one restore unconfirmed
            - leaves released_at empty and reports that setting
    view
        With only replayed frames since start
            - liveness is UNPROVEN and registers are CACHED
```
