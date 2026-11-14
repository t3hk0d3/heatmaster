# Heatmaster — architecture from the simplifier's stance

## 1. Diagnosis

v4 answers every question with memory: a remembered command, result and four timestamps for "did the write take?", a remembered phase for the refresh, per-aspect entries plus a written-set for "what was original?". Each is a second copy of something the valve already knows, and each copy needs rules for when it is wrong: after a crash, a lost file, a late report, a second clock. Every review found its holes in those rules.

The count in v4: five state machines (reconciler, keepalive, refresh, release, baseline lifecycle) plus a queue with four outcomes; 22 named durations; about 65 persisted fields per valve plus up to 10 baseline fields; three stores tied together by ordering rules. The bugs sit at the intersections: refresh × reconciler × restart, baseline × written-set × lost store.

Two further causes. Destructive actions were derived from absence: no config meant "release everything", no baseline meant "take one now". And confirmation was by time rather than by value, which imported clocks.

## 2. Core idea

1. The valve, as Zigbee2MQTT reports it, is the only record of what has been written; Heatmaster persists nothing about writes.
2. Desired settings are a pure function of config and observations, and one small loop per valve repeatedly finds the first setting whose reported value differs from the desired one, writes it, and waits to see it reported.
3. A write "took" if and only if the reported value equals the desired value: a comparison of values, never of times.
4. Original settings are one write-once snapshot of the whole device taken by an explicit adoption step, and restoring them is the same loop with the originals as the desired state.
5. Unknown or missing data never causes a write: an unreadable value, a lost file and a valve not yet heard from all mean "wait and tell the user".

## 3. Components and boundaries

All code follows `STYLEGUIDE.md`, set up in build step 1 exactly as v4 Task 1 defines it.

**`core/` (pure, no HA imports, no state in or out).**
- `model.py`, `validation.py`, `schedule.py`, `temperature.py`: kept from v4 Tasks 3–5 unchanged, including comparing days by meaning. They were never the problem.
- `desired.py`: `desired_settings(config, intent, room_obs, caps, now) -> Settings`. `Settings` is a flat mapping from setting key (`mode`, `day.mon`…`day.sun`, `edit_group`, `active_group`, `sensor_source`; later `child_lock`, `frost_temp`…) to a comparable value. An absent key means "leave alone". Plan 2's layers extend this one function; `intent` is the user-intent state they need (overrides with expiry, forced mode), empty in Plan 1.
- `plan.py`: `next_step(desired, reported, caps, applied_digest) -> Write | MarkApplied | None` and `full_plan(...) -> tuple[PlanRow, ...]`. Reported uses the same `Settings` shape, with `UNKNOWN` as a value.
- `status.py`: `room_status(...)`, `problems(...)`, level-triggered as in v4.

**`adapters/` (two-dimensional, as the spec fixes).**
- Transport (`transports/z2m.py`): finds entities by exact unique id (kept from v4); `read(device, point) -> raw | UNKNOWN`, `write(device, point, raw)`, `seen_at(device) -> datetime | None`, `snapshot(device) -> Mapping[str, str]`, `subscribe(device, callback)`. Reading works for any discovered device.
- Profile (`profiles/*.py`): data and pure functions only: the point table, codecs between raw text and `Settings`, the write `order`, a `precondition(key, reported)` per key, capabilities, the `owned` key set, and `nudge` (`NONE`, `SETPOINT`, `TOGGLE`). A profile never awaits and never calls a transport, so no sequence can hide in it.

**HA layer.**
- `valve_loop.py`: the only code that writes to a valve; one identical coroutine per valve, owning four in-memory values.
- `originals.py`: the write-once store, `adopt`, and membership.
- `store.py`: config store and state store.
- `runtime.py`: one 60-second tick, listeners, room observations; starts the loops once Home Assistant has started.
- `repairs.py`: syncs the problem set to the issue registry and owns the single generic grace period.
- Entities, services, diagnostics: as in v4.

Deleted outright: `reconcile.py`, `engine.py`'s state, `dispatcher.py`, command classes and ids, `CommandResult` events, `WriteGate`, the sensor reading cache, MQTT activity tracking.

## 4. State model

**Persisted**

| Field | Store | If removed |
|---|---|---|
| Config document, `version`, `revision` | `heatmaster.config` | Nothing to do |
| Per valve: `taken_at`, `model_id`, `firmware`, `raw` (state of every writable entity of the device, keyed by Z2M object id), `claimed_group` (TRV-ZBT) | `heatmaster.originals` | No rollback |
| Per valve: `applied_digest` (the nudge for this week is done) | `heatmaster.state` | One extra nudge per valve after each restart. Dropped if hardware shows no nudge is needed |

The state store also holds Plan 2's `intent`. The files have no ordering rules between them, bar one inside `adopt` (§6).

**In memory, per valve**

| Value | If removed |
|---|---|
| `streak`, `not_before` | A valve that never accepts a write is written to without limit |
| `tokens` | A second writer fighting Heatmaster causes endless rewrites |
| `last_push_at` | Source could be switched to external before a temperature was written |

**Derived, never stored.** Membership:

| Valid config lists valve | Originals entry | Meaning |
|---|---|---|
| yes | yes | Managed: desired from config |
| yes | no | Not adopted: no writes, Repairs issue with an "adopt now" fix |
| no | yes | Releasing: desired = originals; entry deleted when the plan is empty |
| no config, or config invalid | yes | Frozen: no writes, Repairs issue |

Sync status and every problem are computed from desired, reported and the four in-memory values.

**Crash at any point.** After a restart the loop continues from what the valve reports. There is no in-flight record to lose. Counters reset, costing at most one extra write per valve.

**Lost or corrupt store.** Config: frozen mode; the entry still loads, so `apply_config` and `export` work. Originals: affected valves become "not adopted" and are not written to; the unreadable file is copied aside, never overwritten automatically (Home Assistant's behaviour on a corrupt store file is unverified). State: one extra nudge.

**Upgrade.** Config keeps v4's `version` and `migrate_raw`. Originals are raw Z2M strings keyed by Z2M object ids, so they need no migration. State is read leniently.

## 5. Write path

**The loop** (pseudocode, because the order is the design):

```
per valve, after Home Assistant has started:
  wait for: a state change of the valve's entities (collected 1 s) | the tick | desired changed
  desired changed: streak = 0; not_before = now
  if frozen, not adopted, or unreachable: continue
  if push due: write external temperature (no confirmation); last_push_at = now
  s = next_step(desired, reported, applied_digest)
  s is none: streak = 0; if releasing: delete the originals entry; continue
  s is "mark applied": applied_digest = digest; save; run again
  if now < not_before or tokens == 0: continue
  write s; tokens -= 1
  wait until reported[s.key] == s.value, at most CONFIRM (30 s)
  confirmed: streak = 0; run again
  not confirmed: not_before = now + BACKOFF[streak]; streak += 1

next_step(desired, reported, applied_digest):
  if reported.mode == HEAT and nudge needed: return "mark applied"
  if reported.mode == HEAT and desired.mode != HEAT: return mode := desired.mode
  for key in profile.order:
      skip if key absent from desired, reported[key] is UNKNOWN, or precondition fails
      if reported[key] != desired[key]: return key := desired[key]
  if nudge needed and reported.mode == AUTO:
      if profile.nudge sets a setpoint and reported.setpoint != target: return setpoint := target
      if profile.nudge is TOGGLE: return mode := HEAT
      return "mark applied"
  return none

nudge needed = profile.nudge != NONE, every schedule key matches, applied_digest != digest(desired week)
```

**Knowing a write took.** Only by read-back equality. This rests on one fact (unverified, H1): Zigbee2MQTT publishes a new value only when the device acknowledged the write or reported it. `UNKNOWN` is neither accepted nor rejected; it blocks that key and is reported. The `resync` service with `force` is the one way to write over an unreadable value, once.

**One write, then look again.** Nothing is queued, so nothing goes stale or needs superseding, and a mode change pre-empts a schedule sync after at most one write. Global spacing is a shared lock held for the write plus 0.5 s.

**Making the schedule effective.** There is no refresh state machine. Two rules of `next_step` do it: if the days match, the nudge is not recorded and the valve is in `auto`, send it to `heat`; if a valve is in `heat` and should not be, record the nudge and send it to `auto`. A crash before `heat` repeats the step; a crash in `heat`, or a `heat` command landing hours late, is finished by the same rule. The setpoint is set to the scheduled target first, so a valve stranded in `heat` while Home Assistant is down holds the right temperature. In Plan 1 a managed valve in `heat` is always returned to `auto`; `off` is left alone.

**Temperature push.** On the tick, when `now − last_push_at ≥ interval`, for a managed, reachable valve not reading `off` whose room temperature is known. Desired `sensor_source` is `EXTERNAL` only when a push happened within two intervals, `INTERNAL` only when the room's sensors are positively stale, and absent otherwise, so a restart never flips sources. A valve that lost its feed says so through the source select (unverified, H4) or goes silent.

**Freshness.** `seen_at` is the value of Zigbee2MQTT's `last_seen` entity for the device, which Heatmaster enables at adoption (unverified, H6). It is a timestamp carried as data, so a replayed cache carries the old time and cannot look fresh; it is compared only against 60-minute and 2-hour thresholds. A valve is unreachable only on positive evidence: entity `unavailable`, or `seen_at` older than 2 h. At start, an unknown sensor is "not yet known", not stale.

**Bounds on radio writes.** A valve that accepts nothing gets one write per pass: five in the first 75 minutes, then four a day (backoff 30 s, 2 min, 10 min, 1 h, then 6 h; leaving `heat` is capped at 10 min). A competing writer is bounded by `tokens` (40, refilled 6 per hour), then a Repairs issue. The push is 12 per hour, the user's setting.

**Durations: 10** (v4: 22): tick, push interval, `CONFIRM`, backoff table, token refill, valve silent, sensor stale, Repairs grace, radio gap, event collection.

**Dry run** is `full_plan` on the candidate config: one row per valve per setting with reported value (or "unknown"), desired value and action. It is the function the loop uses, so it cannot drift.

## 6. Original settings and rollback

- **Capture.** `adopt(valve)` runs only inside `apply_config` or the Repairs fix, both user actions. It snapshots the raw state of every writable entity of the device, including ones later plans will write. If an owned setting is unreadable, adoption fails and names it; the user may accept explicitly.
- **Protection.** The store offers `create_if_absent` and `delete` only. A valve is written to only when its entry is on disk: the design's single write-ahead rule, in one function. Nothing re-takes a snapshot automatically, so Heatmaster's own values cannot become "original".
- **Restore.** A valve absent from a valid config and present in originals gets `desired = originals` restricted to the profile's `owned` keys. Release is finished when the plan is empty, by read-back, so it cannot finish early. For a dead valve, a Repairs fix "give up on this valve" ends it.
- **TRV-ZBT.** Heatmaster claims the highest group that is not active, records it, and never writes another group's days. Day writes have the precondition `reported.edit_group == claimed_group`.
- **Removal.** If entries remain when the integration is removed, the originals file stays on disk.

## 7. Issue table

| # | Class | Verdict |
|---|---|---|
| 1 | Knowing a write took | Handled in one place: the equality test in `valve_loop`. No clocks. Rests on H1 |
| 2 | Schedule refresh | Handled in one place: the two `heat` rules of `next_step`. There is no phase to lose, and `applied_digest` is compared with the current week. A valve that refuses `auto` is retried every 10 min under a critical Repairs issue |
| 3 | Originals | Overwriting and early finish are impossible by construction (write-once, user-initiated; read-back). Wrong group: handled in one place, the day-write precondition |
| 4 | Persistence and crashes | Impossible for writes: nothing about them is stored. Lost files never cause writes |
| 5 | Liveness | Handled in one place: `seen_at`. Still a risk: it needs Z2M's `last_seen` option, and Z2M's cache can outlive a valve reset (H7) |
| 6 | Write volume | Handled in one place: one write per pass, `streak`, `tokens` |
| 7 | Dry run | Impossible to be empty: same pure function, one row per setting |
| 8 | Contract drift | Reduced: one shared shape (`Settings`); a new setting is a table row and a line in `desired_settings` |

## 8. Costs and risks

- Temperature pushes are not confirmed individually. A lost feed surfaces when the valve reports it or after 2 h of silence, not within 15 minutes.
- Without Z2M's `last_seen`, dead devices are found only through Z2M availability. The arrival-time fallback is dropped.
- An attribute Z2M cannot read back can never be confirmed; it alone would need "remember what we wrote". A value Z2M publishes optimistically is believed.
- A user cannot rest a managed valve in `heat` in Plan 1.
- "Failed" (three unconfirmed writes) is forgotten on restart and reappears after about 3 minutes. First sync is slow: up to 13 sequential writes on a TRV-ZBT.
- Most likely to be wrong: H1 and H3, both measured before any loop code.

## 9. Hardware questions and user decisions

**Measure first**
- H1. For every owned setting: after a write, does the entity show the new value, how soon, and does it stay unchanged when the valve is unreachable?
- H2. After a Home Assistant restart, when are values readable again?
- H3. Does a written schedule apply at once, from the next set point, or only after a toggle? Does a setpoint written in `auto` hold until the next set point and survive into `heat`?
- H4. What does the source select read after the feed stops?
- H5. Does an unchanged-value write reach the radio? Does a write wake a valve that is `off`?
- H6. Can the `last_seen` entity be enabled by code, and does a replayed cache keep the old time?
- H7. After a battery pull or rejoin, what do the entities show?
- H8. TRV-ZBT: do day texts and writes follow the edit group?

**Needs the user's decision**
1. **Never rest a valve in `heat`.** Overrides become a setpoint written in `auto`, re-asserted after each set point; a manual switch to `heat` is adopted as such an override. "Valve in heat" is then an error in every plan. Cost: with Home Assistant down, an override ends at the next set point.
2. **Require Zigbee2MQTT's `last_seen`.** Heatmaster enables the entities itself and raises a Repairs issue when the option is off, rather than guessing from message arrival.
3. **Accept slower detection of a lost temperature feed** (up to 2 h instead of about 15 min) in exchange for no per-push confirmation.

## 10. Build order

1. Scaffold, styleguide, pure core (v4 Tasks 1, 3–5).
2. Transport and profile read side, `full_plan`, and dry run as a read-only service. No write path exists yet.
3. Supervised hardware check H1–H8, using step 2 as the measuring instrument.
4. Originals store and `adopt`; export service. Still no valve writes.
5. `valve_loop` for sensor source and temperature push, tested against a simulated valve (drops, delays, reverts) and by killing the loop at every await.
6. Schedule days, TRV-ZBT groups, and the nudge chosen by H3.
7. Release, frozen mode and lost-store behaviour; live rollback test.
8. Room entities, Repairs with grace, services, diagnostics, `en` and `ru`.
9. Live soak on one room, then roll-out.

Plans 2–5 keep their scope. Plan 2 adds `intent` and extends `desired_settings`; the loop, the stores and the adapters do not change.

## Appendix: BDD skeleton of the new contracts

```
plan
    next_step
        With reported equal to desired
            - returns none
        With one differing day
            - returns that day only
        With a key reported UNKNOWN
            - skips it and returns the next differing key
        With a TRV-ZBT whose edit group is not the claimed one
            - returns the edit group write and no day write
        With days matching, nudge not recorded, mode AUTO
            - returns the setpoint write, then mode HEAT on the next call
        With mode HEAT and a nudge needed
            - returns mark-applied
        With mode HEAT, no nudge needed and desired mode AUTO
            - returns mode AUTO
        With mode OFF
            - returns no mode write
    full_plan
        For a valve never heard from
            - returns one row per setting marked unknown
valve_loop
    run
        With a valve that accepts writes
            - sends one write per differing setting and then none
        With a valve that accepts nothing
            - sends at most 5 writes in 75 minutes
        With a competing writer
            - stops when tokens reach 0 and reports a problem
        When killed at any await and restarted
            - converges, and the originals entry is unchanged
originals
    adopt
        With every owned setting readable
            - the entry is on disk before the call returns
        With an entry already present
            - leaves it unchanged
        With an owned setting unreadable
            - fails, names it, and stores nothing
    membership
        With no config and stored entries
            - every valve is frozen and nothing is written
```
