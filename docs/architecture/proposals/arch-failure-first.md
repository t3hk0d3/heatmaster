# Heatmaster architecture — failure-first

Stance: start from what can go wrong, rank what must never happen, then give every "never" exactly one owner. Facts I rely on but have not verified are marked *(unverified)*.

## 0. Fault model and ranked invariants

**Faults the system must survive**

| # | Fault |
|---|---|
| F1 | HA restarts or crashes at any instant, including between two steps of a sequence, and in a crash loop |
| F2 | A store is lost, corrupt, or older than reality (backup restore, downgrade) |
| F3 | Zigbee2MQTT restarts and replays cached state |
| F4 | MQTT broker down or flapping |
| F5 | Valve asleep or offline for minutes, hours or days |
| F6 | A write is silently lost by the radio |
| F7 | A command arrives late or twice |
| F8 | Clocks differ between HA, Zigbee2MQTT and the valve |
| F9 | A person (or another automation) changes settings at the valve |
| F10 | Config changes while a sequence is in flight |
| F11 | Valve re-paired (same address, factory state) or replaced (new address) |
| F12 | Heatmaster is uninstalled, with or without warning |

**Invariants, highest first.** When two conflict, the higher wins.

- **I1 Rest-safe.** Whenever Heatmaster is absent, crashed or in doubt, every valve it has touched is in, or is being driven to, a state that is valid on its own. Sharpest case: no valve stays in fixed-target `heat` because of Heatmaster.
- **I2 Originals survive.** For every setting Heatmaster has ever written, the value the valve held before the first write is stored, never overwritten, and can be put back.
- **I3 No intent, no write.** A valve is written only because a valid stored config says so. Missing or unreadable intent never causes a write, and never a release.
- **I4 Bounded radio.** Per valve per day: keepalives at the configured interval, at most 40 other writes, and a separate small reserve for I1.
- **I5 Truthful.** Heatmaster never reports "in sync" or "dead" without evidence from the valve; every blocked or unconverged setting is a Repairs issue.

## 1. Diagnosis

v4 derives safety from **memory of its own actions**: what was sent, which result came back, which key was acknowledged, which refresh phase it is in, which aspects it has written. Under the fault model every piece of that memory can be wrong: lost with a store, stale after a crash, contradicted by a late command, faked by a replayed cache. Each review found one more way the memory and the valve disagree, and each fix added more memory (`acknowledged_key`, `written`, `needs_refresh_key`, `heard_at` beside `last_seen`), which widened contracts shared by several tasks.

Second, no invariant has an owner. "Never left in heat" emerges from the reconciler, the refresh machine, the dispatcher's priorities and the runtime's save order together. Save-before-send, baseline-before-snapshot and release-by-set-difference live in HA glue, outside the pure core that the tests cover.

Third, there was no written fault model, so "OK", "report" and "seen" had no fixed meaning. Reviewers supplied the faults one at a time.

## 2. Core idea

The valve is the only truth about the valve: Heatmaster stores intent (config) and debts (a small ledger of originals, claims and open leases), never beliefs about what it wrote. Control is level-triggered: each tick recomputes the desired registers from config, compares them with the latest payload from the valve, and issues at most one write per valve, with no command queue, no in-flight state and no command results. Every write passes one gateway, which is the only code able to publish and which checks, in order, link, claim, precondition, lease and budget. A managed valve at rest is always valid without Heatmaster; any value that is not (mode `heat`) exists only under a durable lease that a guard discharges on expiry, restart or doubt. The control plane is a pure function returning an **ordered effect list** (persist, then publish), so a simulator can crash it after every prefix, against a faulty simulated valve, bridge and disk, and check I1–I5 against ground truth.

**Kept from v4, because it is right:** the pure core with injected time; schedule comparison by meaning and the Sonoff day codec; transport × profile adapters; originals captured before any write, in their own store; advancing on observations, now applied to everything.

## 3. Components and boundaries

`kernel/` is pure Python: no HA imports, no I/O, no clock.

| Module | One responsibility | Owns | May call | May not |
|---|---|---|---|---|
| `kernel/registers.py` | The single shared contract: a `Register` row (name, group, evidence `READBACK` or `OPEN_LOOP`, resting-safe values), `Desired` and `Observed` maps, equality by meaning | nothing | — | — |
| `kernel/rooms.py` | Weighted room temperature, schedule resolution and fitting (v4 Tasks 3–5) | nothing | — | see observations of valves |
| `kernel/planner.py` | `desired(config, room_temps, capabilities, ledger, now) → {valve: Desired}`. For a releasing valve the desired values are its originals | nothing | `rooms` | read valve observations (so a plan always exists) |
| `kernel/ledger.py` | Originals, claims, leases, effect debts as an immutable value with transition functions | ledger value | — | — |
| `kernel/governor.py` | Budgets and per-register backoff | pacing state | — | — |
| `kernel/guard.py` | Opens and discharges leases on non-resting values | nothing (leases live in the ledger) | — | — |
| `kernel/gateway.py` | `admit(op, ledger, observed, pacing, link) → effects or refusal`. Sole holder of the publish capability | nothing | `ledger`, `governor` | decide what is desired |
| `kernel/control.py` | `tick(world) → (pacing, effects)`: composes the above for one valve | nothing | all kernel | — |
| `kernel/report.py` | Statuses and problems from desired, observed, ledger, pacing | nothing | — | — |
| `ports.py` | Protocols `Link`, `Disk`, `Clock`, `Issues` | — | — | — |
| `adapters/transports/z2m.py` | Subscribes to each device's MQTT topic, publishes to `…/set`; produces one `Observed` per payload plus liveness | last payload, liveness | HA `mqtt` | decide, retry or pace |
| `adapters/profiles/*` | Per model: register bindings, codec, write order, `requires` per register, resting-safe facts, effect strategy | nothing | — | perform I/O |
| `shell/` | HA glue: executes effects strictly in order, awaiting each; stores; entities; services; Repairs | nothing | ports | make decisions |
| `tests/sim/` | Simulated valve, bridge, broker, disk, human; fault plans; oracle | — | kernel via ports | — |

**Deviation from spec §4 (allowed by the brief):** the Z2M transport reads the device's MQTT payload and writes to `…/set` directly. HA uses the same data but loses repeats, timestamps and disabled entities on the way. One payload is one consistent snapshot. The HA device registry is used only for identity.

## 4. State model

**Persisted**

| Store | Holds | Without it |
|---|---|---|
| `heatmaster.config` | Versioned document: rooms, schedules, and an explicit `releasing` list | No intent: no writes (I3) |
| `heatmaster.ledger` (+ a second copy, written on the same events) | Per valve, keyed by IEEE address; per register group: original value, `claimed` flag; open leases; `effect_owed` schedule digest | Originals lost; own values recaptured as originals; a crash mid-lease strands `heat` |
| `heatmaster.cache` | Governor buckets, last sensor readings, last `heard_at` | Nothing unsafe: a start-up allowance replaces buckets; rooms show "unknown" for a few minutes |

**Derived, never stored:** sync status, "write took", liveness state, refresh progress, what is in flight (nothing is).

**Crash at any point.** Effects are ordered and the shell awaits each, so a crash executes a prefix. `[Persist(claim), Publish]`: after the first, the setting is claimed but unwritten, and restoring it is a no-op. `[Persist(lease), Publish(heat)]`: after the first, the guard restores a valve that never left `auto`. Start-up runs the normal tick; there is no recovery path to get wrong.

**Lost or corrupt store.**
- Config: start in **safe mode**. The planner is off, so nothing is written; the guard still discharges leases, which need only the ledger. v4 stops the integration, which also stops the one thing that gets a valve out of `heat`.
- Ledger: use the second copy. Both gone: configured valves are marked "original unknown" and never captured again from values Heatmaster wrote; the guard assumes a lease on every configured valve seen in `heat`.
- Cache: discarded silently.

**Upgrade.** Ledger schema changes are additive only. A ledger newer than the code puts Heatmaster in safe mode; it is never rewritten or dropped. A config goes through a migration hook. A cache of another version is discarded.

**Moving parts, and what breaks without each**

| Part | Without it |
|---|---|
| Lease machine: `OPEN → RESTORING → closed` (the only state machine) | Crash or late command strands `heat` |
| Tick every 30 s and on each payload | No retries, no keepalive |
| Per-register backoff 2 min, 10 min, 1 h, then every 6 h | Spams a dead valve, or gives up forever |
| Token bucket per valve | Crash loop or contention drains batteries |
| Lease quarantine `Q` | A late `heat` lands after the lease closed |
| Liveness: unknown for 10 min, silent after 2 h | False "dead" after restart; false "alive" after replay |
| `effect_owed` digest | A restart forgets that a written schedule still needs activating |

## 5. Write path

Per valve, per tick (ordering matters, so pseudocode):

```
want = planner.desired(...)[valve]                 # exists even if the valve was never heard
op   = guard.next(valve)            if a lease is open
       else first register r in profile order where observed[r] is known and ≠ want[r]
            (unknown: hold for 10 min after the link came up, then treat as different)
gateway.admit(op) refuses unless, in this order:
   1 link up: broker connected and bridge online      (nothing is ever queued to go out late)
   2 the ledger holds a durable claim for r's group    (else: emit Capture + Persist; write next tick)
   3 op.requires holds in a payload that arrived after the last write to the required register
   4 a non-resting value has an open, persisted lease
   5 governor admits: class budget, register backoff, 2 s spacing per valve
effects = [Persist…, Publish(op)]
```

- **Did it take?** For `READBACK` registers the only test is `observed = desired`, by meaning. There is no "OK". A lost write (F6) simply leaves the difference in place, and the backoff decides when to try again. Three tries without success raise a Repairs issue; tries continue every 6 hours.
- **Values versus liveness.** A replayed payload is good evidence of *values* and no evidence of *life*. `heard_at` moves only when the payload's `last_seen` advances against the previous one from the same device, so no two clocks are ever compared (F3, F8).
- **Ordering rules are `requires` preconditions, not sequences.** Source → external requires the valve to show the fed temperature. External temperature requires mode not `off`. On TRV-ZBT a day write requires `edit_group` = Heatmaster's group; activation requires all seven days equal.
- **Temperature push.** `external_temperature` is `OPEN_LOOP`: written every interval while the room temperature is fresh, phase-shifted per valve by a hash of its address, never confirmed individually. Twenty-four writes fit in the believed 2-hour fallback window, so single losses do not matter. A dead feed shows as a silent valve or as the source select leaving `remote_temperature`. If the room goes stale the pushes stop and the valve falls back by itself (I1).
- **Making a schedule effective.** The profile names one strategy, chosen from measurements, in this order of preference: none needed; **nudge** (write the scheduled target as setpoint while in `auto`; every intermediate state is resting-safe); **device-timed** temporary mode that the valve leaves by itself; **leased heat toggle**. For the last: persist the lease, write `heat` only if mode is `auto`, the setpoint already equals the scheduled target, the valve was heard recently and no set point is within 10 minutes. Then `RESTORING`: write `auto` at safety pace until `auto` is seen in a live payload and `Q` has passed with no `heat` reappearing. Any restart, config change or timeout of 60 s moves `OPEN` to `RESTORING`.
- **Contention.** A register that falls back from confirmed to different three times in a day, with no config change, is held for 24 hours with a Repairs issue (F9, and the user's old automation still running).

## 6. Original settings and rollback

- **Capture** happens inside the gateway, as the precondition of the first write to a register group, and needs every register of the group to be known. No complete capture, no claim, no write; a Repairs fix flow can ask the valve to report, or an admin can record "no original".
- **Protection.** An entry is write-once. The claim flag is persisted in the same effect, before the write, so own values can never be captured later. The ledger is keyed by IEEE address, so re-pairing keeps the originals and a replacement valve gets its own (F11).
- **TRV-ZBT.** All three groups are captured before the first write, by stepping the edit group *(unverified: needs H6)*. Heatmaster takes a group that is not the active one and records which. A day write that lands in the wrong group is then repairable, not only unlikely.
- **Release is an order, not a set difference.** Removing a valve moves it to `releasing` in the same saved document. The planner's desired values become the originals, the same loop converges, and "done" is the observation `observed = originals`, so it cannot finish early. An unreachable valve stays `releasing` with a Repairs issue.
- **Uninstall.** `release_all` is the supported path. If the entry is removed first, the ledger is kept and a readable restore card is written to the config directory; a reinstall resumes the release. Untouched, the valves are still rest-safe.

## 7. Issue table

| # | Class | Verdict |
|---|---|---|
| 1 | Knowing a write took | Impossible by construction: no result exists; only `observed = desired` |
| 2 | Schedule refresh | Handled in one place: `guard`. Impossible if nudge or device timer works. Otherwise **still a risk**: HA and valve both unreachable mid-lease; harm limited by the prepared setpoint |
| 3 | Originals and release | Handled in one place: gateway step 2 and the ledger. **Still a risk**: ledger restored from an older backup |
| 4 | Persistence and crashes | Impossible by construction for ordering (effect prefixes) and for release-on-loss (explicit order); lost stores handled in start-up mode selection |
| 5 | Liveness and freshness | Handled in one place: transport liveness, three-valued; "unknown" never writes and never alarms. **Still a risk** without Zigbee2MQTT's `last_seen` option |
| 6 | Write volume | Handled in one place: `governor` |
| 7 | Dry run | Impossible by construction: the planner never reads observations, and dry run is the same tick with publishing off |
| 8 | Contract drift | Handled in one place: the register table. A new feature is a new row and a planner term |

## 8. Costs and risks

- Direct MQTT ties the transport to Zigbee2MQTT's payload keys and leaves HA's entity layer.
- Without in-flight tracking, a failed write is noticed at backoff pace, and a slow echo can cost one duplicate write.
- A dead temperature feed is detected by its symptom, up to the fallback time later.
- Budgets slow large changes: ten valves times seven days takes minutes, not seconds.
- The simulator is only as true as the measurements behind it. A wrong valve model gives false confidence.
- Most likely wrong: that Zigbee2MQTT publishes a value only after the valve acknowledged it, and the lateness bound `Q`.

## 9. Hardware questions and user decisions

Measure before building:
- **H1** After a schedule write in `auto`, with no toggle: does the target change at once, at the next set point, or never?
- **H2** Does a setpoint written in `auto` hold until the next set point, and does that set point then follow the new schedule?
- **H3** Is there a temporary mode the valve leaves by itself, and does leaving it reload the schedule?
- **H4** With the valve's batteries out, does Zigbee2MQTT still publish a written value? How long does it keep trying? Does HA deliver a publish made while the broker was down?
- **H5** Does the payload carry `last_seen`, does it advance on a write acknowledgement, and what is replayed on bridge start and on HA start?
- **H6** TRV-ZBT: do the day texts follow `edit_group`, is it held by the valve, can all groups be read?
- **H7** Fallback time of the external temperature, what the source select then reads, and which registers a battery swap resets.

Needs the user's decision:
1. **Instant schedule activation.** If only the heat toggle works, either accept a rare stranded `heat` when HA and the valve fail together, or let edits take effect at the next set point with no toggle at all.
2. **Away as a rewritten onboard schedule.** Automatic Away can flip several times a day; each flip is 70 day writes and 10 activations, against I4. Cheaper: Away as a leased room target; only Holiday rewrites schedules.
3. **Five-minute push.** It is 288 of about 330 daily writes per valve. Cheaper: 15 minutes, still eight writes per fallback window.

## 10. Build order

1. Measure H1–H7 on one valve of each model; write restore cards. Result: the profile facts.
2. Register table, ports, and the simulator with oracle, driven by step 1's facts and checked against its captured traces. Result: a do-nothing controller that passes I1–I4.
3. Ledger, gateway, governor, with one register (sensor source). Result: claims, budgets and release proven under crash and store faults.
4. Planner, rooms, schedule registers, dry run. Result: convergence and plan-equals-run properties.
5. Guard and the effect strategy. Result: I1 under crash and late-command faults.
6. Z2M transport and Sonoff profiles, installed on the real house with publishing disabled. Result: a live dry run to compare with reality for some days.
7. Shell: stores, safe mode, room entities, services, Repairs, uninstall path.
8. Supervised enablement, one room at a time. The first live test is claim, then release, compared with the restore card.

## 11. Fault × invariant argument

"—" means the fault cannot reach the invariant.

| | I1 rest-safe | I2 originals | I3 no intent, no write | I4 bounded | I5 truthful |
|---|---|---|---|---|---|
| F1 crash | Lease persisted before `heat`; on start every lease is `RESTORING` | Claim persisted before first write | Nothing replays: there is no queue | Buckets persisted; if stale, start-up allowance of 12 | Status is derived, starts "unknown" |
| F2 store | Config lost: guard still runs. Ledger lost: lease assumed for valves in `heat` | Second copy; else "original unknown", never recaptured. Older backup: **risk** | Config lost: planner off | Cache lost: allowance | — |
| F3 replay | Replayed `auto` cannot close a lease: `last_seen` did not advance | — | — | Stale values may differ: paced | Values taken, life not |
| F4 broker | Lease stays open, discharged on reconnect | — | Gateway step 1 refuses; nothing queued | No publishes | Silent after threshold |
| F5 offline | Restore retried at safety pace | Release waits | — | Backoff to 6 h | Repairs issue |
| F6 lost write | `auto` rewritten until seen | — | — | Backoff | Difference stays visible |
| F7 late, duplicate | Writes are absolute; a late `heat` inside `Q` is restored | Day write rechecks `edit_group`; all groups captured | — | — | — |
| F8 clocks | `Q` and pacing on HA's clock only | — | — | — | `last_seen` compared only with itself |
| F9 person | Restore target is the desired resting mode | Capture precedes any write | Unclaimed registers are never written | Contention hold | Repairs issue |
| F10 config change | Discharge ignores config | Removed valve goes to `releasing` | — | Paced | — |
| F11 re-pair, replace | — | Keyed by address | New address is a new valve | Reconverges under budget | Old valve reported gone |
| F12 uninstall | Resting state is valid alone | Ledger and restore card kept | — | — | — |

## 12. Simulation harness

**Simulated world** (all deterministic from one seed):
- `SimValve`: registers including schedule groups; own clock with skew; sleeps and wakes; schedule-effect policy (immediate, next set point, on toggle); external-temperature fallback; reset on re-pair; knob turns.
- `SimBridge`: cache, echo after acknowledgement, replay on start, optional `last_seen`, delivery that may be late, lost or doubled.
- `SimBroker`: up, down, queueing or dropping.
- `SimDisk`: lose, corrupt, or roll back a store; crash after any effect prefix.
- `SimHuman`: config edits, valve changes, removal, uninstall.

**Oracle**, checked after every event against the simulated valve's true state:
- P1 time in `heat` caused by Heatmaster is bounded whenever HA, link and valve were up together.
- P2 the ledger's originals equal the true pre-write values, and after release the true values equal them.
- P3 writes received per valve per 24 h stay within budget.
- P4 no write reaches a valve outside the config's managed and releasing lists.
- P5 once faults stop, every reachable valve converges and the Repairs set is the expected one.
- P6 a dry run lists exactly the first writes a real run makes, also for never-heard valves.
- P7 a grouped valve's unclaimed groups never change.
- P8 no "in sync" while the truth differs; no "dead" inside the grace period.

**Which property would have caught which class:** 1 → P5, P8 (bridge accepts, radio drops). 2 → P1 (crash and late `heat`). 3 → P2, P7. 4 → P4, P2 (store loss at restart). 5 → P8, P6 (replay, never heard). 6 → P3, P5. 7 → P6. 8 → every profile and transport must pass the same suite, so a changed contract fails at once.

**What makes it cheap:** the kernel is pure and returns ordered effects, so "crash at any instant" is "run any prefix"; all I/O sits behind four ports; nothing is in flight, so there is no hidden state to model; the same tick serves start-up, normal running, release and dry run. Runs use property-based stateful testing with shrinking, thousands of fault schedules per CI run, no HA test harness.

## Appendix: BDD skeleton of the invariant owners

Styleguide: the decisions of v4 Task 1 stand. Skeletons for the other modules belong in the plans written from the merged design.

```
gateway
    admit
        With the link down
            - returns a refusal and no effects
        With no claim for the register's group and the group fully observed
            - returns Capture and Persist effects and no Publish
        With no claim and a group register unknown
            - returns a refusal naming the missing register
        With a requires that fails, or holds only in a payload older than the last write to it
            - returns a refusal
        With a non-resting value and no persisted lease
            - returns a refusal
        With the governor out of budget or in backoff
            - returns a refusal with the retry time
        With everything satisfied
            - returns Persist effects, if any, before exactly one Publish
guard
    next
        With a lease OPEN and the valve seen in heat, a timeout, or a restart
            - the lease becomes RESTORING
        With a lease RESTORING
            - returns a write of the desired resting mode in the safety class
        With auto seen in a live payload and the quarantine passed
            - returns a Persist effect closing the lease
        With heat seen again during the quarantine
            - the lease stays RESTORING
planner
    desired
        With no valid config
            - returns no valves
        With a valve never heard from
            - returns its full desired registers
        With a valve in the releasing list
            - returns its originals for claimed groups only
```
