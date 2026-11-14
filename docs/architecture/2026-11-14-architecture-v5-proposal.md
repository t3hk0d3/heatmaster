# Heatmaster architecture v5 — proposal

**Status:** proposal, not approved. Merged from five independent redesigns (in `proposals/`). If approved it replaces the architecture of plan 1 v4 and amends spec §4, §5.10 and §9. The product design in the spec is unchanged except where "Decisions" below says so.

Facts about Home Assistant and Zigbee2MQTT (Z2M) below come from the architects' reading of current docs and source. None is measured on this house yet. Sources are in `proposals/arch-device-first.md` and `proposals/arch-ha-platform.md`.

## 1. Why v4 kept leaking

All five architects gave the same cause, independently. v4 **remembers what it did** and works out from that memory what the valve must be: commands with ids and results, in-flight slots, acknowledged keys, refresh phases, a "written" set, two clocks. Every such field is a second copy of something the valve or Home Assistant already holds. Each copy needs rules for when it is wrong (after a crash, a lost file, a late report, a replayed cache), and each review found another hole in those rules. Each fix added another field to contracts that several tasks share.

Two more causes:
- Destructive actions were inferred from absence: no config meant "release everything", no baseline meant "take one now".
- Two beliefs were wrong at the device (section 2).

## 2. Device findings that change the design

1. **Z2M gives no per-write result.** But the value Z2M publishes after a `set` is not blind: for mode, setpoint, sensor source and external temperature it is published only after the valve acknowledged the write. On failure nothing is published.
2. **The TRVZB schedule cannot be read from the valve.** What v4 called the "reported schedule" is Z2M's memory of the last write.
3. **On TRV-ZBT the "group to edit" lives in Z2M's process memory, not on the valve.** After a Z2M restart it silently falls back to the active group while Home Assistant still shows the old value. v4's order (select group 3, wait, write days) can then overwrite the household's active schedule. Naming the group in the same MQTT message as the days avoids it. Through HA entities that is not possible.
4. **No source confirms that a schedule needs the auto → heat → auto toggle.**
5. With Z2M's `last_seen` option on, every device message carries a last-seen value. A replayed cache carries the old one, so replays can be told from news without comparing clocks.
6. A valve whose temperature feed stopped says so itself: the source select reads `remote_source_offline`.

## 3. Principles

Agreed by all five.

1. **The valve is the only record of what was written.** Nothing about writes is stored. No commands, ids, results, queue or in-flight state.
2. **A write took when the observed value equals the desired value.** Values are compared, never times.
3. **One rule for every setting.** Desired settings are a pure function of config, room inputs and time. The first setting whose observed value differs is written, one at a time per valve.
4. **Sequences are preconditions, not steps.** "Do B after A" becomes "B is wanted only while A is observed". After a crash the same next step is computed from the valve.
5. **Nothing destructive is inferred from absence.** Release needs a stored request. A lost or unreadable config freezes valves; it never releases them.
6. **Originals are written once**, before the first write to a valve, and nothing can update them.
7. **Device profiles are tables**, not code that runs sequences.
8. **The temperature push is a stream, not a setting.** It is not confirmed or retried per write; the next push is the retry. Its health comes from the valve.
9. **Dry run is the same function** the live path uses, so it cannot be empty or drift.
10. **Measure the hardware before writing the write path**, and build a simulated valve to test against.

## 4. Components

Assumes decisions D1 and D2 are accepted.

| Module | One responsibility | Owns |
|---|---|---|
| `domain/model`, `schedule`, `temperature` | Config shapes, schedule resolution, weighted room temperature. Kept from v4 Tasks 3–5 | nothing |
| `domain/settings` | The setting table: per setting its order, precondition, how it is observed, whether Heatmaster owns it | nothing |
| `domain/desired` | `desired_settings(room, valve, room_inputs, record, now) -> Settings`. For a releasing valve the result is its originals | nothing |
| `domain/plan` | `plan(desired, observed, pacing, now) -> rows`; the first row that may be written is the next write | nothing |
| `domain/status` | Room status and problems from the same inputs | nothing |
| `profiles/*` | Per model: setting ↔ payload key, codec, ranges, schedule slot, activation strategy | nothing |
| `transports/z2m` | MQTT → one `Observed` per device message, with values and liveness kept apart; `send(device, payload)` | subscriptions |
| `ledger` | The one store Heatmaster owns | valve records |
| `writer` | The only code that publishes. Refuses without a ledger record, an unmet precondition, inside backoff, or over budget | attempts and budgets, in memory |
| `coordinator` | Tick every 30 s and on each observation: desired → plan → writer → status | nothing durable |
| `config_flow` | Entry, options, `room` and `schedule` subentry flows. Adoption and preview happen here | nothing |
| HA glue | Entities, Repairs sync, diagnostics, services `preview`, `resync`, `release_all` | nothing |
| `tests/sim` | Simulated valve, fake Z2M, fault plans, oracle | — |

`domain/` imports nothing from Home Assistant.

## 5. What is stored

- **By Home Assistant core:** the config entry (global options) and its subentries (rooms, schedules).
- **By Heatmaster, one file (`ledger`), per valve:** `originals` (write-once), `release_requested_at`, `released_at`, and `activation_owed` only if measurement shows a mode toggle is needed. A readable copy of the originals is also written once to the config directory.
- **In memory only:** observations, write attempts, budgets. Losing them costs at most a few extra writes.

Crash at any point: after restart the difference between desired and observed is recomputed from the valve. Two saves are write-ahead and awaited: the originals before a valve joins a room, and `activation_owed` before a valve is sent to `heat`.

Lost ledger: valves are not written to and nothing is re-captured automatically; a Repairs issue offers the saved copy. Lost config: nothing loads, nothing is written, nothing is released.

## 6. Write path

```
per valve, on tick or new observation:
  no ledger record                  → nothing; Repairs "not adopted"
  activation_owed and mode is heat  → the next write is mode := auto
  desired = desired_settings(...)   (exists even for a valve never heard from)
  take the first setting, in profile order, whose precondition holds and
      whose observed value differs from desired (unknown counts as different)
  writer sends it if: link up, no write to this valve still landing,
      not inside backoff for this (setting, value), budget has a token
  later observation equal   → converged, backoff cleared
  not equal after LANDING   → backoff grows; three misses raise a Repairs issue
```

- **Backoff and budget** live only in the writer. A valve that accepts nothing gets a handful of writes in the first hour, then about four a day. Nothing is "failed for good". Exact numbers follow the measurements.
- **Schedule.** All seven days go in one message; on TRV-ZBT the same message names group 3, and the active group changes only after the days are confirmed.
- **Making a schedule effective.** The profile names one strategy, chosen by measurement, in this order of preference: none; write the current set point's temperature while in `auto` (the valve never leaves `auto`); the heat toggle, guarded by `activation_owed`, started only from an observed `auto`, and always finished by writing `auto`.
- **Temperature push.** Its own lane: latest value wins, never queued. The sensor source is switched to external only after a push went out. A room with no fresh temperature stops pushing and the valve falls back by itself.
- **Liveness.** A device is "heard" only when its `last_seen` value advances. A replay gives values, not life. A valve not yet heard from is "unknown", not dead.

## 7. Original settings and rollback

- **Capture** happens in one place: the last step of the room flow, when a valve first joins a room. The flow shows what was captured and what could not be read, and the user accepts or cancels. On TRVZB the schedule shown is Z2M's memory, so the user's confirmation is what makes it the original.
- **TRV-ZBT.** Heatmaster owns group 3 only. Groups 1 and 2 are never written.
- **Release** is the normal rule with the originals as the desired values. It finishes only when every restored setting is observed equal. If it cannot finish it stays visible in Repairs.
- **Removing the integration** restores nothing by itself (it cannot wait for sleepy valves). `release_all`, or deleting the rooms, comes first. If unreleased valves remain, the ledger is kept and the user is told.

## 8. The eight recurring issue classes

| # | Class | In this design |
|---|---|---|
| 1 | Did the write take | One place: observed equals desired. No "OK", no settle timers, no clocks |
| 2 | Schedule refresh | Gone if no toggle is needed. Otherwise one stored flag and one rule |
| 3 | Originals and release | Overwrite impossible: captured only in the flow, write-once. Release cannot finish early: it is convergence |
| 4 | Persistence and crashes | No engine state exists. Config is Home Assistant's. Release needs a stored request |
| 5 | Liveness | One place: the transport, from `last_seen` advancing |
| 6 | Write volume | One place: the writer's budget |
| 7 | Dry run | Same function as the live path; unknown means "will write" |
| 8 | Contract drift | One shared shape (setting → value). A new feature is a table row and a clause in `desired_settings` |

## 9. Decisions for the user

| # | Decision | Proposed by | Recommendation |
|---|---|---|---|
| D1 | Read and write valves over MQTT directly instead of through Z2M's HA entities. Reverses part of spec §4 | 3 of 5 | Yes. Finding 3 cannot be fixed through entities |
| D2 | Rooms and schedules as Home Assistant config subentries instead of Heatmaster's own config store and `apply_config` | 1 of 5 | Yes. Home Assistant stores, edits and migrates them, and there are real forms before the panel exists |
| D3 | Require Z2M's `last_seen` option; manage no valve without it | 4 of 5 | Yes |
| D4 | Push the room temperature on change (at most every 5 min) plus a 30-minute heartbeat, instead of every 5 min always. The unconditional push is 288 radio writes per valve per day; the valve's own timeout is about 2 h | 4 of 5 | Yes |
| D5 | Rollback is an explicit release before deletion; deleting the integration never restores valves by itself | 1 of 5, none against | Yes |

**Decided by the user, 2026-11-14:**
- D1: yes, for the Z2M transport. Direct MQTT is a property of that transport, not of the design; the transport contract must not assume MQTT, so a ZHA transport can work through entities.
- D2: open.
- D3: yes, for the Z2M transport.
- D4: yes. Push when the room temperature has changed by the threshold (default 0.2 °C, my call), at most once per push interval (default 5 min), and at least every 30 min regardless.
- D5: not important for v1. The simplest behaviour is taken: explicit release; deletion keeps the ledger and warns.

Left for plan 2, raised here so they are not lost:
- Never rest a valve in `heat`; overrides become a setpoint written in `auto`.
- Away as a room target instead of rewritten onboard schedules (each flip is about 70 day writes).
- Manual changes made while Home Assistant is down are not adopted.

## 10. Measurements that gate the build

On one TRVZB and one TRV-ZBT, supervised:
1. After a schedule write in `auto`, with no toggle: does the target change at once, at the next set point, or never? Does a setpoint written in `auto` hold until the next set point?
2. With batteries out: does Z2M publish a written value? How long from a good write to the published value?
3. Does the payload carry `last_seen`, and does a replay leave it unchanged?
4. TRV-ZBT: does a message naming group 3 leave the active group alone? Can group 3 be read?
5. External temperature: fallback time, what the source select then reads, behaviour while `off`.
6. What a battery swap or rejoin resets.
7. Can the TRVZB schedule be read through the generic command path?

## 11. Build order

1. Styleguide, scaffold, and a fake Z2M built from recorded traffic.
2. Supervised measurements (section 10).
3. `domain/` and profiles, with the simulated valve and its properties: converges, stays inside the budget, same result when all memory is dropped between any two steps.
4. Transport and coordinator, read-only on the real house: diagnostics show every valve as Heatmaster sees it.
5. Config flows, ledger, adoption and preview with writes held: the real house shows its planned writes.
6. Writer, temperature lane, sensor source. Rooms take over the existing automation one at a time; release one room to prove rollback.
7. Schedule days, TRV-ZBT group, the measured activation strategy.
8. Room entities, Repairs, services, `en` and `ru`.
9. Supervised verification and a 24 h soak.

Steps 4 and 5 put no write path in the code at all.

## 12. Kept and dropped from v4

**Kept:** the pure core, schedule comparison by meaning and the Sonoff day codec, transport × profile adapters, originals before any write, level-triggered problems, hardware measurement first, room entities, Repairs.

**Dropped:** the generic reconciler and its retry state, command classes and results, the dispatcher, the refresh state machine, keepalive state, the engine state and its schema, write-ahead of runtime state, the write gate, the config store with revisions, two of three stores.
