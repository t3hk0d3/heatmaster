# Heatmaster architecture v5

**Status:** revision 3, after two adversarial reviews and a re-check (section 16). Decisions D1–D5 made by the user on 2026-11-14. Replaces the architecture of plan 1 v4. Overrides spec §4 (in part), §5.1, §5.10, §9.1–9.4 and §9.7; the product design is otherwise unchanged (see spec §10).

**Sources:** five independent redesigns in `proposals/`, four research reports in `../research/`. Facts about Home Assistant and Zigbee2MQTT (Z2M) come from reading current docs and source. None is measured on this house yet; section 12 lists what must be measured. Numbers marked *provisional* are set by those measurements.

## 1. Why v4 kept leaking

All five architects gave the same cause, independently. v4 **remembers what it did** and works out from that memory what the valve must be: commands with ids and results, in-flight slots, acknowledged keys, refresh phases, a "written" set, two clocks. Every such field is a second copy of something the valve already holds. Each copy needs rules for when it is wrong (after a crash, a lost file, a late report, a replayed cache). Each review found another hole in those rules, and each fix added another field to contracts that several tasks share.

Two more causes: destructive actions were inferred from absence (no config meant "release everything"), and two beliefs were wrong at the device (section 2).

## 2. Device findings

1. **Z2M gives no per-write result.** For sensor source, external temperature, mode and setpoint, Z2M publishes the new value only after the valve acknowledged the write; on failure it publishes nothing.
2. **The TRVZB schedule cannot be read from the valve.** Z2M publishes what it sent. A matching value proves only that Z2M accepted the write.
3. **Every device message carries Z2M's whole cached state.** A value in a message is not news from the valve just because the message is new.
4. **On TRV-ZBT the "group to edit" lives in Z2M's process memory, not on the valve.** After a Z2M restart it falls back to the active group while the cache still shows the old value. Writing days then overwrites the household's active schedule. Naming the group in the same MQTT message as the days avoids it; through HA entities that is not possible.
5. **No source and no existing TRVZB schedule tool uses or reports needing the auto → heat → auto toggle.**
6. With Z2M's `last_seen` option on, every device message carries a last-seen value. A replayed cache carries the old one.
7. A sleeping valve's write can be queued in Z2M and land when the valve next speaks.
8. A valve whose temperature feed stopped says so: its source select reads `remote_source_offline`, and it recovers by itself when pushes resume.
9. All days sent in one MQTT message are grouped by Z2M: identical days go out as one radio command.

## 3. Principles

1. **Nothing about writes is persisted.** No commands, ids, results, queue or in-flight state. What the valve shows is the record.
2. **A write took when the observed value equals the desired value.** Values are compared, never times.
3. **One rule per kind of setting.** Desired settings are a pure function of config, room inputs and time. An *enforced* setting that differs is written. A *stream* is pushed on its own cadence. (Plan 2 adds *adopted* settings, where a difference becomes the user's intent.)
4. **Sequences are preconditions.** "Do B after A" is "B is wanted only while A is observed".
5. **Nothing destructive is inferred from absence.** Release needs a stored order. A missing or unreadable store never causes a write, a capture or a release.
6. **A setting is written only if the valve's ledger record has an entry for it**, and entries are never overwritten.
7. **Cached values are not evidence of the present.** After anything that may have changed the valve behind Heatmaster's back, its settings are asserted again.
8. **Device profiles are tables**, not code that runs sequences.
9. **Preview is the same function** the live path uses.
10. **The shell makes no decisions.** All decision logic is pure and returns an ordered list of effects, so a test can stop it after any effect.

## 4. Components

| Module | One responsibility |
|---|---|
| `core/model`, `validation`, `schedule`, `temperature` | Config shapes and validation, schedule resolution and comparison by meaning, weighted room temperature (kept from v4) |
| `core/settings` | Setting keys, groups and policies; the shapes `Desired` and `Observed` |
| `core/observation` | Pure updates of what is known about a device: merge a message, liveness, "assert again" marks |
| `core/membership` | What each valve is to Heatmaster right now (section 6) |
| `core/desired` | `desired_settings(...)`: setting → (value, reason). For a releasing valve the values are its originals |
| `core/pacing` | Backoff and budget as pure functions over an in-memory value |
| `core/feed` | The temperature push lane |
| `core/control` | `tick(world) -> TickResult` and `preview(world)` |
| `core/change` | `plan_change(...)`: validates a candidate config, works out joining, leaving and moved valves, refusals, the new ledger and config, and the preview |
| `core/status` | Room status and problems |
| `profiles/*` | Per model: ranges, limits, schedule slot, owned settings with order and preconditions. Per transport, a **binding**: setting ↔ payload key, codec, evidence class |
| `transports/base`, `transports/z2m` | The transport contract and its Z2M implementation (section 7) |
| `stores` | `ConfigStore` and `Ledger` (section 5) |
| `runtime` | Holds the in-memory world, feeds transport events through `core/observation`, runs `tick`, executes effects, publishes the latest snapshot to listeners |
| HA glue | Config entry (single, no data), room entities, issue sync, diagnostics, services |
| `tests/sim` | Simulated valve, fake Z2M, fault plans, oracle |

`core/` imports nothing from Home Assistant.

**The world** passed to `tick`: the config or its state (`ok`, `empty`, `unreadable`); the ledger or `unreadable`; per device its `Observed`, liveness and whether its transport is usable; link state; room sensor readings with liveness; the in-memory value (pacing, feed, assert marks, release timers); whether writes are held; `now`.

**Effects**, executed strictly in order, each awaited: `SaveLedger`, `WriteOriginalsCopy`, `SaveConfig`, `Publish(valve, {setting: value})`, `PushTemperature(valve, celsius)`. Later plans add `SaveState` and `SwitchOutput`.

**`TickResult`**: the new in-memory value, the effects, room statuses, problems.

**Runtime rules.** One lock covers a tick with its effects and every config change, so the two never interleave. Ticks run every 30 s and after transport events, coalesced. A failed effect aborts the rest of that tick. Pacing is charged when a write is decided; a publish that then fails is treated as a lost write. "Hold writes" is a config setting, on by default, and an input to `tick`: while it is on no write or push is decided, so pacing, marks and feed state are untouched and the sync status is `held`. Preview ignores it.

## 5. What is stored

**`ConfigStore` — what the user wants.** One document: settings, schedules (stable ids; names are labels), rooms (valves by id with per-valve settings, weighted sensors), plus a server-owned `releasing` map (valve → time the release was ordered). The revision counts user changes only; a save with a stale revision is refused. `releasing` is not exported, cannot be set by a caller, and a server save of it does not change the revision.

**`Ledger` — what the valves held.** Per valve, one record: `originals`, setting → value **as the device gave it** (a TRV-ZBT day may hold 12 set points), or `unknown-accepted`. Entries are create-only. A record may gain an entry for a setting a later version starts to own, captured from an observation before the first write to that setting.

**Readable copy.** After every ledger change a plain file with all originals, including those of released valves, is written to the config directory, keeping the last five generations.

Both stores have major and minor versions with one fixture-tested migration per version.

**In memory only:** observations, pacing, feed, assert marks, release timers. Losing them costs a bounded number of extra writes (section 8).

**A store that failed to load is never written.** Unreadable config: every valve is frozen; `apply_config` refuses unless the caller sets `overwrite_unreadable`, and then the old file is copied aside first. Unreadable ledger: no valve is written to, joins are refused, neither the ledger nor the readable copy is written; `import_originals` restores from the readable copy after copying the old file aside.

**Later plans** add `StateStore` for what Heatmaster was told or decided at run time: overrides with an absolute expiry, a manual house mode, latched results that have a delay or hysteresis, the heat output's state. Never anything about valve writes. Unreadable means empty plus a Repairs issue.

## 6. Membership

Derived every tick, per valve:

| Config | Valve is in | Ledger record | Meaning |
|---|---|---|---|
| ok | a room | yes | **Managed**: desired from config |
| ok | a room | no | **Not adopted**: no writes; Repairs issue |
| ok | `releasing` only | yes | **Releasing**: desired = originals |
| ok | `releasing` only | no | Dropped from `releasing` at the next tick |
| ok | neither | yes | **Orphan**: no writes; Repairs issue naming `restore_valve` and `forget_valve` |
| empty, ledger empty | — | — | Fresh install: nothing to do |
| unreadable, or empty with ledger records | — | any | **Frozen**: no writes; Repairs issue |
| ok, ledger unreadable | a room or `releasing` | unknown | **Frozen**: no writes; Repairs issue; release orders are kept |

A valve in a room and in `releasing` is treated as in a room. On top of any row: a valve whose transport is unusable (for Z2M: `last_seen` off, bridge offline, unknown Z2M version) gets no writes and a Repairs issue.

**Changing the config** (`apply_config`; later the panel calls the same function):

```
plan_change(current, candidate, ledger, devices, now):
  validate; on errors change nothing
  compare valve sets over the whole config:
      joining   = in a room now, not before          (a valve moved between rooms is neither)
      leaving   = in a room before, not now
      rejoining = joining and already has a ledger record: its stored originals are kept
  refuse if: revision is stale; the ledger is unreadable and anything joins;
      a joining valve without a record has a captured setting that cannot be read and is
      not listed in `accept_unknown_originals`; a joining TRV-ZBT without a record has group 3 active
  preview = captures, releases, and every write the new config leads to (pacing off, pushes assumed sent)
  dry run → return the preview; change nothing
effects, in order:
  1. SaveLedger with records created for joining valves
  2. WriteOriginalsCopy
  3. SaveConfig with leaving valves added to `releasing` (with the time), rejoining ones removed
```

A crash between 1 and 3 leaves an orphan record for a valve that was never written to.

## 7. Transport and observation

**Transport contract.** A transport names valves by a stable id (Z2M: the IEEE address), lists devices with model and firmware, and says whether it is usable. It delivers events and accepts writes; it interprets nothing.

- Events: `DeviceMessage(device, values, life_token)`, `Rejoined(device)`, `BridgeRestarted`, `LinkUp`, `LinkDown`.
- `life_token` changes if and only if the device itself spoke. For Z2M it is `last_seen`.
- Writes: `write(valve, {setting: value})`, one message per call.
- Z2M specifics: the base topic is derived from the device's entities in HA's registry and confirmed by `bridge/info`; "link down" is the MQTT client disconnected or `bridge/state` offline; any Z2M device can be followed, so room sensors on Z2M get liveness the same way.

**Observation** (`core/observation`, state held by the runtime):

- A message is merged into what is known: keys absent from it keep their value.
- **Liveness** is separate from values. A device is *heard* when its `life_token` differs from the previous one. States: unknown (not heard since start or since the link came back), live, silent. A valve is silent after 2 h unheard; a room sensor is stale after the staleness timeout (default 60 min). Time while the link is down does not count. Intervals use Home Assistant's clock; the token is only compared with itself.
- **No write goes to a valve before one message from it has arrived since start.** Values from Z2M's replay at start are used as they are.
- **Evidence class** per setting, from the binding: `reported` (the valve reports it by itself), `acked` (Z2M publishes it only after the valve acknowledged), `echoed` (Z2M publishes what it sent).
- **Assert marks.** A setting group marked "assert again" counts as different even if its value is equal. A marked group is written only once the valve was heard at or after the marking, and all its members are sent. The mark is cleared by the first heard message after that write; if none comes, the mark stays and backoff applies. All `acked` and `echoed` groups of a valve are marked on `Rejoined`, on `BridgeRestarted`, when the valve goes from silent to live, on `resync`, and when the group's maximum age passes (*provisional:* sensor source 24 h, schedule 7 days). `sensor_source` is also marked once at every start, because a rejoin may have been missed while Home Assistant was down. The schedule group is also marked, at most once a day, when the valve is **not following its schedule**: in `auto`, it shows the previous set point's temperature in a message heard between 5 and 15 min after a set point with a different temperature passed.
- Readings that are not settings are kept too: mode, setpoint, local temperature, running state, battery, feed health.

**Plan 1 settings.**

| Group | Members | Policy | Wanted | Captured as original | Restored on release |
|---|---|---|---|---|---|
| `schedule` | seven days | enforce | always, from the room's schedule | TRVZB only | TRVZB only |
| `active_group` (TRV-ZBT) | one | enforce | group 3, only while `schedule` is observed equal in a message whose edit group is 3 | yes | yes, with no precondition |
| `sensor_source` | one | enforce | `external` once a push went out and the room temperature is fresh; `internal` once the room's sensors are stale; otherwise left alone | yes | yes, unless the original cannot be written |
| `external_temperature` | one | stream | section 9 | no | no |

On TRV-ZBT the days are observed only from messages whose edit group is 3; what group 3 held before Heatmaster used it is not captured, and its ledger entries are created as "unknown" without asking. Mode and setpoint are readings in plan 1, not settings. A setting absent from `Desired` is never written and never blocks a release. The binding decodes `remote_source_offline` as source `external` with feed health "lost", so it is reported, not rewritten.

## 8. Write path

```
per valve, each tick:
  writes held, or membership or transport says no writes → nothing
  link down, valve silent, or no message yet   → nothing
  desired = desired_settings(...)               (exists even for a valve never heard from)
  candidates = groups, in profile order, whose precondition holds, that have a ledger entry,
               and whose observed value differs from desired, or that are marked "assert again"
               and the valve was heard since the marking
  take the first candidate that pacing allows   (a group in backoff does not block the next)
  effects = [Publish(valve, the differing members of that group; all members if marked)]
```

- **Pacing**, per valve, in memory:
  - *Spacing:* at least 2 s between writes to one valve.
  - *Backoff:* a group's value that was written before waits before it is written again: 2 min, 10 min, 1 h, then 6 h, by the number of times it was written in the last 24 h since the group's desired value last changed. A new desired value does not wait.
  - *Budget:* a token bucket per valve (*provisional:* 6 tokens, one back every 30 min, 3 at start).
  - Three such writes that were not caused by an assert mark raise the problem "setting not holding", whether the valve never took the value or something keeps changing it back. Nothing is "failed for good".
- **Bound.** Per valve per day: the pushes of section 9, plus at most the budget. Each restart adds at most the starting tokens.
- **Schedule.** Only days that differ are sent, in one message. On TRV-ZBT the message also names group 3.
- **Making a schedule effective.** The profile names a strategy chosen by measurement 1. `none`: nothing more. `setpoint`: after a schedule write whose days differed (never an assert rewrite) is observed equal while the valve is in `auto`, the current set point's temperature is written once, drawing from the budget; the reminder to do so is in memory, and losing it means the valve follows from its next set point. This one write is the only exception to principle 6. A mode toggle is **not designed**. If measurement 1 shows it is needed, it is designed before build step 8 is planned, with these constraints: a stored two-step record written before the days; `auto` published once after any restart whatever the cache shows; cleared only by `auto` in a heard message; `auto` exempt from backoff with reserved tokens; honoured in every membership row.
- **Preview** runs the same selection repeatedly on a copy of the world, with pacing off, hold ignored and pushes assumed sent, assuming each write lands, until nothing more is written, and lists the writes in order. For a valve never heard from it lists them with "current value unknown".

## 9. Temperature push

`core/feed`, in memory per valve: the last pushed value and time.

- Push when the room temperature is fresh and differs from the last pushed value by 0.2 °C or more and the push interval (default 5 min) has passed; and in any case every 30 min.
- Only to valves that are managed, usable, not silent, and have sent a message since start. Whether a valve that is `off` is fed is a profile fact (measurement 5).
- Latest value wins; nothing is queued, confirmed or retried. Pushes do not draw from the budget.
- Pushes stop when the room's sensors go stale and when a valve starts releasing.
- The source switches to `internal` when the sensors are stale and back to `external` only after the room temperature has been fresh again for 10 min, so it does not flap.
- A valve that reports its feed lost for longer than two heartbeats raises a problem.

## 10. Original settings and rollback

- **Capture** happens in step 1 of a config change, when a valve joins. The preview shows what will be captured, with its evidence class, and what cannot be read. On TRVZB the schedule is Z2M's memory of it.
- **TRV-ZBT.** Heatmaster owns group 3 only; groups 1 and 2 are never written. A valve whose active group is already 3 cannot join.
- **Release** is the normal rule with the originals as the desired values. It finishes when every restorable setting has stayed equal for the release hold (*provisional:* 15 min; the longest time a queued write takes to land) and the valve was heard during that time. Then the record is removed from the ledger, kept in the readable copy, and the valve is dropped from `releasing`.
- A release that cannot finish stays visible as a problem. `forget_valve` ends it by hand.
- **Removing the integration (D5)** writes nothing. If no valve is managed or releasing, the stores are deleted. Otherwise the ledger and the readable copy are kept and a persistent notification says which valves were not given back.
- **Known limits.** A restored TRVZB schedule is confirmed only by Z2M's echo. On TRV-ZBT, release restores the active group and leaves Heatmaster's days in group 3. A Z2M restart or rejoin missed while Home Assistant was down is caught for the sensor source at the next start and for the schedule by its maximum age or by the valve not following it. Restoring a Home Assistant backup loses originals captured after it; the readable copy is the remedy.

## 11. Services, entities, problems (plan 1)

All services are admin-only, check that in the handler, and call one pure `core` function.

| Service | Does |
|---|---|
| `apply_config` | Fields: the document or a file path, `dry_run`, `expected_revision`, `accept_unknown_originals` (valve ids), `overwrite_unreadable`. Returns the preview or the result |
| `export_config` | Returns the document; optionally writes a file |
| `resync` | Marks every group of a room's valves "assert again" |
| `restore_valve` / `forget_valve` | Orphan → releasing; orphan or releasing → record archived and dropped |
| `import_originals` | Restores the ledger from the readable copy |

Rollback is `apply_config` with no rooms.

**Per room:** a device with a `climate` entity (read-only target until plan 2), a temperature sensor, a problem binary sensor and a sync sensor with states `in_sync`, `pending`, `not_holding`, `unknown`, `held`, `frozen`.

**Problems** are level-triggered and synced to Repairs as plain issues that name the service to use (fix flows come in plan 3): config unreadable, ledger unreadable, transport unusable, valve not adopted, valve orphaned, valve unsupported, valve silent, setting not holding, release stalled, schedule not followed, room has no fresh temperature, sensor stale, sensor liveness unobservable (an MQTT sensor that is not a Z2M device), temperature feed lost.

## 12. Measurements that gate the build

On one TRVZB and one TRV-ZBT, supervised:
1. After a schedule write in `auto`, with no toggle: does the target change at once, at the next set point, or never? Does a setpoint written in `auto` hold until the next set point?
2. With batteries out: which settings does Z2M still publish after a write? How long from a good write to the published value, and how long can a queued write take to land?
3. Does every device message carry `last_seen`, does it change exactly when the device speaks, and does a replay leave it unchanged? What does Z2M publish when it restarts?
4. TRV-ZBT: does a message naming group 3 leave the active group alone? Which group do the day values in a message belong to? Can group 3 be read?
5. External temperature: fallback time, what the source select then reads, behaviour while `off`. Does an unchanged value sent over MQTT produce a radio write?
6. What a battery swap or rejoin resets, and what Z2M publishes when it happens.
7. Can the TRVZB schedule be read through the generic command path?

## 13. Tests

- `core/` is tested without Home Assistant.
- `tests/sim` holds a simulated valve (true settings, sleep, lost, late and reordered writes, echo without storing, reset on rejoin, a competing writer), a fake Z2M (whole-state messages, cache, replay, `last_seen`, restart) and fault plans. Properties, checked against the simulated valve's true state:
  - once faults stop, every reachable valve converges;
  - writes per valve stay within the budget plus the starting tokens of each restart;
  - originals equal the true values before the first write, and after release the true values equal them;
  - no write reaches a valve that is not managed or releasing;
  - dropping all memory between any two ticks, or cutting the effect list after any effect, never breaks the properties above;
  - a preview lists exactly the writes a real run then makes when every write lands.
- The HA layer is tested with HA's real MQTT integration and the fake Z2M.

## 14. Build order

1. Styleguide, scaffold, CI.
2. Supervised measurements (section 12).
3. `core/`: model, validation, schedule, temperature.
4. `core/`: settings, observation, membership, desired, pacing, feed, control, change, status, with the simulator.
5. Profiles with their Z2M bindings and the Z2M transport, read-only on the real house: diagnostics show every device as Heatmaster sees it.
6. Stores, runtime and `apply_config` with preview, with "hold writes" on: the real house shows its planned writes.
7. Writes enabled for the temperature push and the sensor source. Rooms take over the existing automation one at a time; one room is released to prove rollback.
8. Schedule days, TRV-ZBT group, the measured activation strategy.
9. Room entities, issue sync, remaining services, diagnostics, `en` and `ru`.
10. Supervised verification and a 24 h soak.

## 15. Room for the later plans

- **Manual changes (plan 2).** Mode and setpoint become *adopted* settings: a difference seen in a heard message, after start-up has settled, that is not *explained*, is saved as an override instead of being written over. Explained means: the current desired value; a value pacing wrote within its first backoff step; the schedule's previous or next set point within a tolerance; the value of an override that just expired. The last case is the one thing that must be stored (`StateStore`), so a restart does not adopt Heatmaster's own old override.
- **Overrides, windows, seasons, house modes, frost floor, child lock:** clauses in `desired_settings` over stored intent and latched inputs; `desired_settings` already returns a reason per value, which the status line shows.
- **Heat output (plan 3)** is not a valve setting: `core/demand` and `core/output` with their own timing rule, a `SwitchOutput` effect, and its state in `StateStore`.
- **Panel (plan 4):** websocket commands calling the same `core/change` and reading the runtime's snapshot, with a subscription.
- **A ZHA transport** supplies the same events through entities; its `life_token` and evidence classes come from its own bindings.
- **Deliberately not done:** persisting unconfirmed commands, as one studied project does. The value test above replaces it.

## 16. Review record

Two adversarial reviews of revision 1 returned "ready with fixes". Applied in this revision:

| Finding | Change |
|---|---|
| Release could finish on cached values and delete the originals | Release hold with a heard message; record archived, not deleted (§10) |
| TRV-ZBT days not tied to a group | Days count only in a message whose edit group is 3; group 3 active blocks joining (§6, §7) |
| A setting that never takes blocked everything after it | Backoff skips, it does not block (§8) |
| Writes before the first observation | No write before the first message since start (§7) |
| An unreadable ledger could be overwritten | A store that failed to load is never written (§5) |
| Cached values treated as current | Assert marks on rejoin, bridge restart, return from silence, age, and schedule not followed (§7) |
| Activation by toggle could not be expressed | Not designed; constraints recorded (§8) |
| A setting that keeps reverting looped for ever | Backoff counts writes in 24 h, does not clear on equality (§8) |
| Config change racing a tick | One lock (§4) |
| No home for run-time state; `releasing` under the user's revision | `StateStore` named for later plans; `releasing` rules stated (§5) |
| "Every difference is written" blocks manual-change adoption | Setting policies (§3, §15) |
| World, effects and tick outputs not listed | Listed (§4) |
| No setting table; payload details in the profile | Table in §7; bindings per transport (§4) |
| Originals could not grow; not in device form | Per-setting create-only entries in device form (§5) |
| Transport rules left open | Stated (§7) |
| Plan-1 surface unplaced | §11; `core/change` owns config changes |
| Temperature lane unowned | `core/feed` (§9) |

The re-check of revision 2 found four more, applied in revision 3:

| Finding | Change |
|---|---|
| An assert mark was spent on a write that could be lost | Marks wait for the valve to be heard and are cleared only by a heard message after the write (§7) |
| Backoff and "setting not holding" counted legitimate writes | Counted since the desired value last changed; assert writes do not count towards the problem (§8) |
| "Hold writes" charged pacing and spent marks | Hold is an input to `tick`; nothing is decided while it is on (§4, §8) |
| A rejoining TRV-ZBT was refused because of Heatmaster's own group 3 | Refusals apply only to valves without a record (§6) |
| TRV-ZBT days of another group could read as equal; restoring them would write the wrong group's days | Days observed only with edit group 3; not captured or restored on TRV-ZBT (§7, §10) |
| "Schedule not followed" fired on a knob turn | Narrowed to the previous set point's temperature, 5–15 min after a change (§7) |
