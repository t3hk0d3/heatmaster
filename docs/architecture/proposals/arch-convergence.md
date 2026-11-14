# Heatmaster architecture — desired-state convergence

## 1. Diagnosis

v4 is level-triggered in name only. Its unit of work is the *command*: it has an id, a result, a start time and an in-flight slot, and the engine keeps a ledger of them (`AspectState`, `KeepaliveState`, `RefreshState`, `written`, `needs_refresh_key`, `acknowledged_key`, `heat_sent`, `heat_seen`). Each of those fields is the controller remembering what it did and inferring from that what the valve is. Wherever the valve cannot be read directly, a memory field stands in for the observation, and every memory field brings a crash window, a clock, a storage schema and a way to disagree with the device. Reviews keep finding holes in the same places because those are the places where memory replaces observation: write confirmation, the refresh sequence, baselines ("was this value mine?") and restart.

Two statements are missing underneath. First, per valve setting: how it can be observed and how far that observation is trusted. Without it, one generic reconciler receives `matches = None` and has to guess. Second, per valve setting: who owns it. Without it, baselines and release are inferred from differences between three stores.

## 2. Core idea

1. Each valve has a **desired document**: a map from setting to value, holding only settings Heatmaster has claimed, recomputed on every turn as a pure function of the stored document, the room's inputs, the valve's current observation and the time.
2. Each valve has an **observed document** built only from what Zigbee2MQTT publishes for the device; every field records how it was learned and when, and that trust expires.
3. **One rule** runs for every field: if the trusted observation differs from the desired value and the budget allows, write the desired value — one field, absolute, repeatable.
4. Nothing about past writes is persisted; a multi-step procedure exists only as "desired depends on observed", so after a crash the next turn computes the same next step from the valve itself.
5. **Ownership is a persisted claim** holding write-once originals; release is the same rule with the originals as desired values, and it starts only from an explicit claim state, never from something being absent.

## 3. Components and boundaries

| Module | One responsibility | Owns | May call | May not |
|---|---|---|---|---|
| `domain/model.py`, `schedule.py`, `temperature.py` | Config, schedules, room temperature (v4 Tasks 3–5, kept) | nothing | — | import HA |
| `domain/fields.py` | The **field table**: per setting its trust class, ownership policy, order, maximum age | nothing | — | — |
| `domain/desire.py` | `desire(document, room_inputs, observed, now) -> ValveDesired` | nothing | schedule, temperature | see attempts, budget or any record of writes |
| `domain/converge.py` | `need(field, desired, observed, attempt, now) -> Write \| None`; `plan(...)` | nothing | fields | — |
| `domain/status.py` | Statuses and problems from the same inputs | nothing | — | — |
| `control/observer.py` | Transport documents → `ObservedValve`; liveness | observations (memory) | profiles (decode) | write |
| `control/actuator.py` | The only writer: claim guard, budget, attempts | attempts, budget (memory) | transport, `store.put_original` | decide what is desired |
| `control/controller.py` | The loop: wake → `desire` → `need` → actuator | dirty set | the above | hold state between turns |
| `store.py` | One atomic document | config, claims, intents (disk) | — | — |
| `transports/z2m.py` | Topics, `/set`, `/get`, `bridge/devices`, `bridge/event` | subscriptions | HA MQTT | know what a field means |
| `profiles/*.py` | Declarative: field ↔ payload key, codec, capabilities, write context | nothing | — | sequence anything (no `execute`) |
| `ha/*` | Room inputs, entities, services, Repairs (a diff of computed problems against the issue registry) | — | controller, store | — |

Kept from v4 because they are right: the HA-free pure core, the two adapter axes, one writer, originals before the first write, a dry run that runs the real decision code, level-triggered problems, hardware measurement first. Dropped: commands and their results, the queue, per-aspect retry state, the refresh state machine, three stores.

**Ownership policy** is a column of the field table. `enforce` fields are always driven (schedule, slot, sensor source, external temperature; later child lock, frost temperature). `yield` fields (mode, setpoint) give way to a foreign change, which becomes a persisted *hold* intent that `desire` returns as the desired value. Plan 1 reports a hold as "diverged"; Plan 2 gives it an end rule and calls it an override.

**Valve data goes straight to MQTT**, not through HA entities. The device-topic JSON is one consistent observation, it arrives even when values repeat, and one `/set` payload can carry several keys. Room sensors on Z2M get freshness from the same observer; others from HA's `last_reported`. A ZHA transport must later build the same `ObservedValve` from entities, with weaker trust.

## 4. State model

**Persisted: one document**, `heatmaster.document`, written atomically (HA `Store` with `atomic_writes=True`, unverified) and awaited before the action it permits:

```
{version, revision,
 config:  rooms, schedules, presets, settings,
 claims:  {valve_id: {state: held | releasing,
                      originals: {field: {value, taken_at}},
                      effective: week-hash | null}},
 intents: [{kind: hold, valve_id, mode, setpoint, since}]}     (Plan 2 adds override kinds with expiry)
```

| Persisted item | If removed |
|---|---|
| `config` | nothing to desire |
| `claims.state` | release must be inferred from absence (v2's "lost config released every valve") |
| `claims.originals` | no rollback |
| `claims.effective` | toggle-type valves cannot tell "table written" from "table in force"; dropped if H2 shows no toggle is needed |
| `intents` | a manual change is fought after restart |

Config and claims share one file, so "config without baselines" and "baselines without config" are unreachable.

| Memory only | If removed | Cost of losing it at restart |
|---|---|---|
| `ObservedValve` | no truth | refilled by Z2M's cached publish, marked `cached` |
| `attempt[valve][field] = (value, at)` | a write is re-sent every turn before it lands | covered by the startup quiet period |
| budget counters | unbounded writes | bucket restarts low; bounded burst |
| `settled[valve][field]` | manual changes look like writes in progress | deviations at start are driven, not adopted |

One timer: a 15 s tick. No stored state machine.

- **Crash at any point.** Restart loads the document, waits `STARTUP_QUIET` (2 min after HA start and bridge online), observes, and computes the same decisions. A write sent just before the crash either landed (observed equal) or did not (written again; safe because absolute). Until inputs arrive a room is "unknown", not "degraded".
- **Lost document.** The config entry carries `initialised: true`; initialised but no document → Repairs issue, idle. No claims means the actuator may write nothing; valves keep running their onboard schedule.
- **Corrupt or newer-version document.** Refuse to start, change nothing; a Repairs fix flow restores the previous revision, kept as a sibling file.
- **Upgrade.** Migrations apply to the document only. No runtime schema exists.

## 5. Write path

**Observed document.** `ObservedValve{heard_at, seq, fields: {field: (value, source, verified_at)}}`. `seq` is Z2M's `last_seen`, an opaque token compared only with its own earlier value, never with HA's clock. A document is *genuine* when it is not retained and `seq` advanced; `heard_at` is its arrival on HA's clock. `live` = `heard_at` within `SILENT_AFTER`. A valve not yet heard is *unknown*: no writes, and not "unavailable" until `SILENT_AFTER` after start.

| Trust class | Fields | `verified_at` moves when | Trusted while |
|---|---|---|---|
| reported | `mode`, `setpoint`, `local_temperature` | any genuine document | the valve is live |
| acknowledged | `schedule.<day>`, `schedule.slot`, `sensor_source`, `external_temperature` | a genuine document after our write carries the written value (Z2M echoes only after the valve answers: unverified, H1), or a `/get` reply | age ≤ the field's maximum; reset by a rejoin announce |
| behaviour | "schedule in force" | — | `mode = auto` and `setpoint ∈ expected(week, now ± 10 min)` |

Maximum ages: `external_temperature` = the push interval; `sensor_source`, `schedule.slot` 24 h; schedule days 7 d. An expired field is re-asserted, or read with `/get` where supported. This one mechanism is the keepalive, the spec's daily resync, rejoin handling and `heatmaster.resync` (which expires a room's fields). It replaces "unreadable counts as accepted".

**The rule.**
```
need(f, d, o, a, now):
    d absent                                  → none            not claimed
    a within LANDING and a.value ≠ d          → write d         a late older write must not win
    a within LANDING, unconfirmed             → none            wait
    o.value == d and trusted(o)               → none            converged
    o unknown and f is reported-class         → none            wait for the valve to speak
    otherwise                                 → write d

turn(valve):
    not live, or before STARTUP_QUIET         → nothing
    a yield-field left a settled value with no attempt of ours → persist a hold intent
    first f in field order with a need, if the budget allows   → actuator.write
```
One write per valve at a time; the next follows the confirming document, or `LANDING`.

**Sequences are preconditions inside `desire`:**
- `sensor_source = external` is desired only while `external_temperature` is trusted; a room without a temperature wants `internal`.
- TRV-ZBT: `schedule.slot = 3` is desired only once the seven days are trusted. Each day write carries `schedule_group_to_edit: 3` in the same payload (the profile's write context); days are read only from documents showing edit group 3.
- **Making a schedule effective**, strategy per profile from H2: `none`; `nudge` — when the valve is not following, claim `setpoint = expected(now)`; `toggle` — the nudge first, then `mode = heat` is desired only while the valve *reads* `auto`, its days are trusted, its setpoint equals the scheduled target and `effective ≠ hash(desired week)`. Observing `heat` with matching days persists `effective`. In every other observation the desired mode is `auto`. A missed transition clears `effective`.

**Budget, in the actuator only.** At least 1 s between any two writes. Per valve: after an unconfirmed attempt wait 2, 4, 8 … 60 min, reset by any confirmed write; keepalives never closer than the interval; other writes draw from a bucket (capacity 12, refill 1 per 15 min, 3 after restart, filled by an admin apply or resync); `heat` excursions from their own (2 per 6 h). Per valve per day: 288 keepalives at 5 min, 108 other writes; a silent valve 0; a live valve that never confirms about 24. Nothing is "failed for good". Problems are derived: backoff at its cap → "writes not taking"; excursion bucket empty and still not following → "schedule not followed".

**Dry run** is `plan(candidate document)`: for every claimed field of every valve, a row `{observed or unknown, desired, action}`. It cannot reach the actuator and cannot be empty.

## 6. Original settings and rollback

- **Capture.** An `apply_config` that adds a valve writes, in the same save, a claim holding every claimable field currently observed. A field unknown then is captured at its first trusted observation. `store.put_original` is put-if-absent; nothing updates an entry.
- **Protection.** `actuator.write` is the only function that publishes, and it refuses a field with no original. An original is therefore always older than Heatmaster's first write to that field.
- **Release.** Removing a valve flips its claim to `releasing` in that save; the dry run shows it. `desire` then returns the originals (TRVZB: seven raw day texts, source, mode; TRV-ZBT: original active and edit group, source, mode; group 3's contents if H4 shows they can be read). The claim is deleted only when every field is observed equal and trusted. A valve that never converges stays `releasing` with a Repairs issue until an admin `forget` exports its originals and deletes the claim.
- **Uninstall.** `async_remove_entry` with claims left writes a restore card file before removing the document.

**Invariants**
1. *No write without a claim and an original* — one publishing function checks both.
2. *An original never holds a Heatmaster value* — put-if-absent, saved before the first write, in the same file as the config naming the valve.
3. *Every write is repeatable* — one field, absolute value, group context included.
4. *Without a user's intent, Heatmaster wants `heat` only while the valve reads `auto` right now* — `desire` is a function of the current observation; no stored phase exists.
5. *No release without a persisted `releasing` claim* — nothing compares stores.
6. *Writes per valve per day are bounded* — one budget on the one writer.
7. *No comparison across clocks* — `seq` is opaque.
8. *All process state may be discarded at any moment* — only the document is loaded.

## 7. Issue table

| # | Class | Answer |
|---|---|---|
| 1 | Did a write take | Handled in one place: `observer` sets `verified_at`, `need` reads it. No command result exists. Still a risk if Z2M echoes without the valve's answer (H1). |
| 2 | Schedule refresh | Advancing on results, sequencing hidden in a profile and "applied without applying" are impossible by construction: no sequence exists, and `effective` is recorded only from an observed `heat` with matching days. Late `heat`: handled in `need`, second line. Still a risk: HA dying while the valve is in `heat`; softened because its setpoint is already the scheduled target. |
| 3 | Originals and release | Overwrite: impossible by construction. Early or endless release: handled in one place — release is convergence, surfaced when stuck. Wrong group: still a risk until H4 confirms key order. |
| 4 | Persistence and crashes | Impossible by construction: one atomic document, refusal changes nothing, release needs a claim, no engine state exists to lose. |
| 5 | Liveness | Handled in one place: `observer`. Replays do not advance `seq`. |
| 6 | Write volume | Handled in one place: the actuator's budget. |
| 7 | Dry run | Impossible by construction: `plan` is total over claimed fields. |
| 8 | Contract drift | Three shared contracts: the field table, `ObservedValve`, `ValveDesired`. Later features add table rows, intents and `desire` clauses. Still a risk: `desire` growing; it is split into sub-functions over disjoint fields, with a test for disjointness. |

## 8. Costs and risks

- Restart forgets `settled`, so manual changes made while HA was down are driven back.
- Acknowledged-class fields can drift unseen until their age expires; re-asserting them costs about 2 % extra radio writes.
- Direct MQTT ties the valve path to Z2M topics and departs from "use HA entities" in spec §4.
- Detecting a manual change is the one edge-triggered piece: an edge in observations, not in commands.
- If the document is lost and the user starts over instead of restoring a backup, the new originals are whatever Heatmaster left on the valves.
- Most likely wrong: "echo implies the valve answered", and the following check on firmware that moves its own setpoint (open window, frost, clock skew). Until measured, following feeds status only.

## 9. Hardware questions and user decisions

All unverified until measured:
- **H1** Is the `/set` echo published only after the valve answers (batteries out: no echo)? Does an unchanged-value write reach the radio and advance `last_seen`?
- **H2** After a day write in `auto` with no toggle, does the next transition follow the new table? Does a setpoint written in `auto` hold until the next transition? Decides `none` / `nudge` / `toggle`.
- **H3** Which fields change in Z2M state by themselves (source fallback, rejoin), and which answer `/get`?
- **H4** TRV-ZBT: is key order inside one `/set` payload honoured; do day texts follow the edit group; can group 3 be read without changing it?
- **H5** Longest time from publish to landing (`LANDING`); do two quick sets land in order?
- **H6** Longest healthy silence (`SILENT_AFTER`); does Z2M's restart replay leave `last_seen` unchanged?
- **H7** Does `<base>/<ieee>/set` work; does `bridge/devices` give model and friendly name?

Needs the user's decision:
1. **Require Zigbee2MQTT's `last_seen` option.** Supporting installs without it needs the timing heuristic behind issue 5. Cheaper: a Repairs issue, and no valve is managed until it is on.
2. **Push the temperature on change, at most every 5 min and at least every 30 min**, instead of every 5 min unconditionally. In a steady room that is a sixth of the radio writes, still well inside the 2 h fallback.
3. **Manual changes made while HA is down are not adopted**; the valve returns to its schedule at start. Adopting them needs persisted per-field history.

## 10. Build order

0. `STYLEGUIDE.md` and scaffold (v4 Task 1, kept). Each step's plan carries its BDD skeleton.
1. Supervised measurements H1–H7; fill the field table and constants.
2. Pure domain plus a simulated valve (drops, delays, late landings, echo without storing, resets). Property tests: converges; never exceeds the budget; same outcome when all memory is discarded between any two turns.
3. Z2M transport and observer, read-only on the live system: diagnostics show every valve's observed document. No writing code exists yet.
4. Document store, `apply_config`, `plan`: live dry run for real rooms.
5. Actuator, claims, originals, release and restore card, for `external_temperature` and `sensor_source` only: take over the temperature feed room by room; release one room to prove rollback.
6. Schedule fields, the following check, the measured make-effective strategy, the TRV-ZBT slot.
7. Room entities, Repairs diff, services, diagnostics.
8. Supervised verification and 24 h soak. Plans 2–5 then add fields, intents and `desire` clauses.
