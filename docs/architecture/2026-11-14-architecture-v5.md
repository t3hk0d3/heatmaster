# Heatmaster architecture v5

**Status:** decisions D1–D5 made by the user on 2026-11-14; under adversarial review. Replaces the architecture of plan 1 v4. Overrides spec §4 (in part), §5.1, §5.10, §9.1–9.4 and §9.7; the product design is otherwise unchanged (see spec §10).

**Sources:** five independent redesigns in `proposals/`, four research reports in `../research/`. Facts about Home Assistant and Zigbee2MQTT (Z2M) come from reading current docs and source. None is measured on this house yet; section 11 lists what must be measured.

## 1. Why v4 kept leaking

All five architects gave the same cause, independently. v4 **remembers what it did** and works out from that memory what the valve must be: commands with ids and results, in-flight slots, acknowledged keys, refresh phases, a "written" set, two clocks. Every such field is a second copy of something the valve already holds. Each copy needs rules for when it is wrong (after a crash, a lost file, a late report, a replayed cache). Each review found another hole in those rules, and each fix added another field to contracts that several tasks share.

Two more causes: destructive actions were inferred from absence (no config meant "release everything"), and two beliefs were wrong at the device (section 2).

## 2. Device findings

1. **Z2M gives no per-write result.** For mode, setpoint, sensor source and external temperature, Z2M publishes the new value only after the valve acknowledged the write; on failure it publishes nothing.
2. **The TRVZB schedule cannot be read from the valve.** Z2M publishes what it sent. A matching value proves only that Z2M accepted the write.
3. **On TRV-ZBT the "group to edit" lives in Z2M's process memory, not on the valve.** After a Z2M restart it falls back to the active group while Home Assistant still shows the old value. Writing days then overwrites the household's active schedule. Naming the group in the same MQTT message as the days avoids it; through HA entities that is not possible.
4. **No source and no existing TRVZB schedule tool uses or reports needing the auto → heat → auto toggle.**
5. With Z2M's `last_seen` option on, every device message carries a last-seen value. A replayed cache carries the old one.
6. A valve whose temperature feed stopped says so: its source select reads `remote_source_offline`.
7. All days sent in one MQTT message are grouped by Z2M: identical days go out as one radio command.

## 3. Principles

1. **The valve is the only record of what was written.** Nothing about writes is stored: no commands, ids, results, queue or in-flight state.
2. **A write took when the observed value equals the desired value.** Values are compared, never times.
3. **One rule for every setting.** Desired settings are a pure function of config, room inputs and time. The first setting whose observed value differs is written, one at a time per valve.
4. **Sequences are preconditions.** "Do B after A" is "B is wanted only while A is observed". After a crash the same next step is computed from the valve.
5. **Nothing destructive is inferred from absence.** Release needs a stored order. A missing or unreadable config freezes valves.
6. **Originals are written once**, before the first write to a valve.
7. **Device profiles are tables**, not code that runs sequences.
8. **The temperature push is a stream**, not a setting: not confirmed or retried per write.
9. **Preview is the same function** the live path uses.
10. **The shell makes no decisions.** All decision logic is pure and returns an ordered list of effects (save, then publish), so a test can stop it after any effect.

## 4. Components

| Module | One responsibility | Owns |
|---|---|---|
| `core/model`, `validation`, `schedule`, `temperature` | Config shapes and validation, schedule resolution and comparison by meaning, weighted room temperature (kept from v4) | nothing |
| `core/settings` | The setting keys and the shapes `Desired` and `Observed` (setting → value, with "unknown") | nothing |
| `core/membership` | What each valve is to Heatmaster right now (section 5) | nothing |
| `core/desired` | `desired_settings(room, valve, room_inputs, originals, now)`. For a releasing valve the result is its originals | nothing |
| `core/pacing` | Backoff and budget as pure functions over a small in-memory value | nothing |
| `core/control` | `tick(world) -> (pacing, effects)`: membership → desired → first difference → pacing → effects. Also `preview(world)` | nothing |
| `core/status` | Room status and problems from the same inputs | nothing |
| `profiles/*` | Per model: setting ↔ payload key, codec, ranges, evidence class per setting, schedule slot, activation strategy | nothing |
| `transports/z2m` | MQTT → one `Observed` per device message, values and liveness kept apart; `publish(valve, payload)`; device list from `bridge/devices` | subscriptions |
| `stores` | `ConfigStore` and `Ledger` | two files |
| `runtime` | Collects the world, calls `tick` every 30 s and on each observation, executes effects strictly in order, awaiting each | pacing value, in memory |
| HA glue | Config entry (single, no data), room entities, Repairs sync, diagnostics, services | nothing |
| `tests/sim` | Simulated valve, fake Z2M, fault plans, oracle | — |

`core/` imports nothing from Home Assistant. A transport is free to use MQTT or HA entities; the contract does not say which.

## 5. What is stored

**`ConfigStore` — what the user wants.** One document: settings, schedules (stable ids; names are labels), rooms (valves by device id with per-valve settings, weighted sensors), and a server-owned `releasing` list of valves being given back. It carries a revision; a save with a stale revision is refused. Storage has major and minor versions with one tested migration per version.

**`Ledger` — what the valves held.** Per valve: `originals` (create-only), and `activation_owed` only if measurement shows a mode toggle is needed. A readable copy of the originals is rewritten to the config directory on every change.

**In memory only:** observations, pacing. Losing them costs a few extra writes.

**Membership, derived every tick:**

| Config | Valve is in | Ledger record | Meaning |
|---|---|---|---|
| valid | a room | yes | **Managed**: desired from config |
| valid | a room | no | **Not adopted**: no writes; Repairs issue |
| valid | `releasing` | yes | **Releasing**: desired = originals |
| valid | neither | yes | **Orphan**: no writes; Repairs asks "restore" or "forget" |
| missing or unreadable | — | any | **Frozen**: no writes; Repairs issue |

One exception to "no writes": a valve with `activation_owed` is returned to `auto` in every row.

**Changing the config** (`apply_config`, later the panel):

```
validate; on errors change nothing
work out joining and leaving valves; build the preview
dry run → return the preview (captures, releases, planned writes); change nothing
stale revision → refuse
a joining valve has an owned setting that cannot be read, and it was not accepted → refuse, naming it
1. Ledger: create records for joining valves; save and await
2. Rewrite the readable copy of originals
3. ConfigStore: save with leaving valves added to `releasing`, rejoining ones removed; await
```

A crash between 1 and 3 leaves an orphan record for a valve that was never written to: safe, and Repairs asks. When a release finishes, the valve is dropped from `releasing` and its record is deleted.

**Unreadable or newer-version file.** Config: frozen. Ledger: every valve is "not adopted"; nothing is captured again automatically, and Repairs offers to import the readable copy.

## 6. Observation

- One `Observed` per device message: setting → value or unknown.
- Each setting has an **evidence class** in the profile: `reported` (the valve reports it by itself), `acked` (Z2M publishes it only after the valve acknowledged), `echoed` (Z2M publishes what it sent; TRVZB schedule days).
- Equality stops writing for every class. `echoed` settings are also written again after the valve rejoins and on `resync`, and are watched by behaviour: if the valve is in `auto`, untouched, and its setpoint is not the scheduled one after a set point passed, the room shows "schedule not followed". That is a status, not a write trigger.
- **Liveness** is separate from values. A device is *heard* only when its `last_seen` value differs from the previous one from the same device. A replay gives values, not life. States: unknown (not heard since start, for up to 2 h), live, silent (not heard for 2 h). Intervals are measured on Home Assistant's clock; `last_seen` is only compared with itself.
- Without Z2M's `last_seen` option the transport manages no valve and raises a Repairs issue (D3).
- **Room sensors** are HA entities. One that belongs to a Z2M device takes liveness from the transport; others from HA's `last_reported`. At start a sensor is "not yet known", not stale.

## 7. Write path

```
per valve, each tick:
  membership says no writes        → nothing
  silent, or link down             → nothing
  desired = desired_settings(...)   (exists even for a valve never heard from)
  take the first setting, in profile order, whose precondition holds and whose
      observed value differs from desired (unknown counts as different)
  pacing allows it if: no other write to this valve is still landing,
      not inside backoff for this (setting, value), budget has a token
  effects = [Publish]
  later observation equal   → converged; backoff cleared
  not equal after LANDING   → backoff grows; three misses raise a Repairs issue
```

- A changed desired value does not wait for the old write to land.
- **Backoff and budget** live only in `core/pacing`. A valve that accepts nothing gets a handful of writes in the first hour, then about four a day. Nothing is "failed for good". Numbers follow the measurements.
- **Schedule.** All seven days go in one message. On TRV-ZBT the same message names group 3, and "active group = 3" is wanted only once the days are observed.
- **Making a schedule effective.** The profile names one strategy, chosen by measurement, in this order of preference: none; write the current set point's temperature while in `auto`; the heat toggle. The toggle is wanted only while the valve reads `auto`, saves `activation_owed` before `heat` is published, and always ends by writing `auto`.
- **Temperature push (D4).** Its own lane: push when the room temperature differs from the last pushed value by 0.2 °C or more and the push interval (default 5 min) has passed, and in any case every 30 min. Latest value wins; nothing is queued. `sensor_source = external` is wanted only after a push went out; `internal` is wanted when the room's sensors are stale; before either is known the setting is left alone.

## 8. Original settings and rollback

- **Capture** happens in one place, step 1 of `apply_config`, when a valve first joins a room. The preview shows what will be captured and what cannot be read. On TRVZB the schedule shown is Z2M's memory of it.
- **TRV-ZBT.** Heatmaster owns group 3 only; groups 1 and 2 are never written.
- **Release** is the normal rule with the originals as the desired values. It finishes only when every restored setting is observed equal; until then it is visible in Repairs.
- **Removing the integration (D5)** writes nothing. Removing rooms, or `release_all`, comes first. If valves are still managed or releasing, the ledger file and the readable copy are kept and the user is told.

## 9. The eight recurring issue classes

| # | Class | In this design |
|---|---|---|
| 1 | Did the write take | One place: observed equals desired. No "OK", no settle timers, no clocks. Weaker for `echoed` settings, which is stated, not hidden |
| 2 | Schedule refresh | Gone if no toggle is needed. Otherwise one stored flag and one precondition |
| 3 | Originals and release | Overwrite impossible: create-only, captured before any write. Release cannot finish early: it is convergence. Release needs a stored order |
| 4 | Persistence and crashes | No engine state exists. Every crash window ends in a no-write state |
| 5 | Liveness | One place: the transport, from `last_seen` changing |
| 6 | Write volume | One place: `core/pacing` |
| 7 | Preview | Same function as the live path; unknown means "will write" |
| 8 | Contract drift | One shared shape (setting → value). A new feature is a profile row and a clause in `desired_settings` |

## 10. Decisions

| # | Decision | Outcome |
|---|---|---|
| D1 | Valves over MQTT directly | Yes, for the Z2M transport. The contract does not assume MQTT |
| D2 | Where rooms and schedules live | Heatmaster's own versioned store behind one config entry. Not subentries: no project with a panel uses them, and schedules are never kept in config entries (see `../research/`) |
| D3 | Require Z2M's `last_seen` | Yes, for the Z2M transport |
| D4 | Temperature push | On change, at most once per interval, and every 30 min regardless |
| D5 | Rollback on deletion | Not important for v1; explicit release only |

Parked for plan 2: never resting a valve in `heat`; Away without rewriting schedules; manual changes made while Home Assistant is down.

## 11. Measurements that gate the build

On one TRVZB and one TRV-ZBT, supervised:
1. After a schedule write in `auto`, with no toggle: does the target change at once, at the next set point, or never? Does a setpoint written in `auto` hold until the next set point?
2. With batteries out: which settings does Z2M still publish after a write? How long from a good write to the published value?
3. Does the payload carry `last_seen`, does it change on every device message, and does a replay leave it unchanged?
4. TRV-ZBT: does a message naming group 3 leave the active group alone? Can group 3 be read?
5. External temperature: fallback time, what the source select then reads, behaviour while `off`.
6. What a battery swap or rejoin resets, and what Z2M publishes when it happens.
7. Can the TRVZB schedule be read through the generic command path?

## 12. Tests

- `core/` is tested without Home Assistant.
- `tests/sim` holds a simulated valve (true settings, sleep, lost and late writes, echo without storing, reset on rejoin), a fake Z2M (cache, replay, `last_seen`), and fault plans. Properties checked against the simulated valve's true state: it converges once faults stop; writes stay inside the budget; originals equal the true values before the first write and the true values equal them after release; no write reaches a valve that is not managed or releasing; the result is the same when all memory is dropped between any two ticks and when the effect list is cut after any effect; a preview lists exactly the first writes a real run makes.
- The HA layer is tested with HA's real MQTT integration and the fake Z2M.

## 13. Build order

1. Styleguide, scaffold, CI.
2. Supervised measurements (section 11).
3. `core/`: model, validation, schedule, temperature.
4. `core/`: settings, membership, desired, pacing, control, status, with the simulator.
5. Profiles and the Z2M transport, read-only on the real house: diagnostics show every valve as Heatmaster sees it.
6. Stores, `apply_config` with preview, and a "hold writes" switch that is on by default: the real house shows its planned writes.
7. Effects executed for real: temperature lane and sensor source. Rooms take over the existing automation one at a time; one room is released to prove rollback.
8. Schedule days, TRV-ZBT group, the measured activation strategy.
9. Room entities, Repairs, services, diagnostics, `en` and `ru`.
10. Supervised verification and a 24 h soak.

## 14. Kept and dropped from v4

**Kept:** the pure core, schedule comparison by meaning and the Sonoff day codec, transport × profile adapters, originals before any write, the config store with revision and `apply_config` with dry run, level-triggered problems, hardware measurement first, room entities, Repairs.

**Dropped:** the generic reconciler and its retry state, command classes and results, the dispatcher, the refresh state machine, keepalive state, the engine state and its schema, write-ahead of runtime state, the write gate, the runtime store, baselines per aspect with a "written" set, release inferred from a valve's absence.
