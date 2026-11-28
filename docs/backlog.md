# Backlog

Known follow-ups left after plans 1 and 2 (0.2.0). None blocks daily use. Each line names the place and what to do.

## Behaviour

- **Un-hold after a forced hold.** Applying `hold_writes: false` does not clear the in-memory forced hold; the user needs a
  second toggle or a restart. The file is right; the error is on the side of holding.
- **Refused registry retried every 5 s.** A registry list that Home Assistant always refuses (not a timeout) is asked
  for again every `HA_RETRY_MS` with a warning each time; back off instead.
- **Device list through link loss.** After the first `bridge/devices` the Zigbee2MQTT device list is kept through a
  broker outage, so the stranded rule trusts an old list.
- **`+`/`#` valve names.** Core counts a recorded valve that its transport lists but cannot address as stranded, while
  the page does not offer Forget; its snapshot also says `supported: true` next to `valve_unsupported`.
- **YAML export.** Strings like `0o17` are written unquoted and a YAML 1.2 import reads them as numbers (it fails loudly
  as `config_invalid`). Double-quote every string on export.
- **Page names.** Problems about sensors, unused entries and `schedule_in_use` show raw ids; the server should send
  names.
- **Forget transient.** After a stranded valve is forgotten, one tick still sees it in its room as pending
  (`valve_not_observed`) before the membership drops it.
- **TRVZB timer mode for timed overrides, see M10.** The TRVZB's own timer (`temporary_mode_select: timer`) holds a
  temperature in `auto` and ends by itself; it could carry timed overrides instead of Heatmaster's own end time.
- **TRV-ZBT knob at the previous week's value (plan 3a).** A lost, queued or late TRV-ZBT day write is now detected:
  the valve's expectation keeps the week Heatmaster wrote before (recorded when a schedule write is sent) until the
  valve shows a point of the new one, a point of that week is not adopted, and the schedule group is written again.
  The residual: until the new week is evidenced, a person turning the TRV-ZBT to a value the previous week had in
  force within ±2 minutes of the report (any time of day, and not in the new week) is not seen (and the week is
  re-sent). If the write before was lost too, if a valve's first week write is missed after a release, or if a valve
  with no recorded week (new, taken over after Start over or lost state) misses its first schedule write, nothing
  explains the old week's points and nothing re-sends the schedule: the false override returns at each old-week point
  whose value is not in the new week, until the 24 h schedule re-assert. The simulator's P-own leaves these out (`zbtResidual` in
  `packages/core/test/sim/faults.ts`). Reading the valve's days back would end both, if a firmware ever reports them.

## Windows (plan 3b)

Known follow-ups left after 0.4.0.

- **Measurements pending (M18–M20).** M18 and M19: a knob turn in `heat` and in `off` on the TRVZB and TRV-ZBT (the
  window writes and `resume_heating` assume the 3a reports). M20: whether a valve's own window detection in a room
  Heatmaster does not watch changes its mode (3a would adopt that as a person's change). Docs change if they differ.
- **Pre-existing 3a simulator failure (P-keep).** Seed 1481946975 fails on `main` too: "place valve 0 in room a, knob
  valve 1 +1, edit alt 0, edit default 0, turn valve 0 +1" ends with "b is override 20, the turn left override 17.5".
  Needs its own diagnosis.
- **P-own exclusion is sticky.** The simulator's P-own leaves out a valve that changed rooms while a write to it was
  unconfirmed, for the rest of the run; a valve removed and re-added to the same room with a write in flight is not
  covered. The behaviour itself is a known limit (README).
- **Contact friendly names on the page.** `StateView` carries no entity names, so contacts show as entity ids.
  Send names.
- **Window writes have no pacing priority** (up to 30 minutes with an empty bucket). Give freeze protection a token first.
- **Drop rule tuned on one room.** Check other rooms' sensors (0.2 °C steps, only on a change) and adjust defaults.
- **Notices.** A pre-`try` failure in a notice is swallowed silently; no test for a stalled dismiss, the `stay` text,
  the Russian `stay` text, the minutes form or a notify timeout; `notify` recomputes the room's name at execution and
  can warn "room unknown" misleadingly.
- **Behaviour edges.** A limit set under 30 s shows as "0 min"; `rejoin_min` below `within_min` is covered by the
  kept-record rule but not validated; a rejoin keeps the old `startedAt` (the "command waits" note is cosmetic);
  a never-reported new contact settles for 30 minutes without a restart; a contact sharing a device with a sensor may
  still be polled; `knob_does_nothing` names the TRVZB for every model; a repeated `dismissed` on disabling an ended
  past-limit opening; `limitReached` deferred while the thermostat is `off` or `notify` is off (fires on the first
  live step after either changes); trails are not clamped on a clock jump back.
- **Status.** `FROZEN_VERDICT` shows the trigger `contact` for every contact room while frozen or settling; the `ha_link_missing`
  data key says `sensor` for a contact; the English time is 12-hour and the Russian "через 2 ч" reads oddly.
- **Code.** `CONTACT_PREFIX`, `SENSOR_PREFIX` and the `"ha:"` literal are repeated in `change.ts`, `labels.ts` and
  `label-sync.ts`; `committed(prune)` does two jobs; the sensor `with` rebuild in labels finds by ref;
  `entityLabels` has no doc comment; a `const window` shadows the global in the web code; `binary_sensor.*` is always
  treated as a contact in the refresh.
- **Tests.** The simulator's scenes generate no contacts; the config's window settings have no property test; no
  live-restart test with an open contact keeping `startedAt`; no test that a notice is not repeated on the next tick;
  the `ignore` knob-back test does not assert the republish after the settle.

## Release process

- The Supervisor sees a new version in `packaging/app/config.yaml` before its image exists (404). The release workflow
  should publish the image before the version reaches the branch Home Assistant reads.

## Code

- `runtime.ts`: the import-then-mirror sequence is written three times; `carryOut` hides its outcome, so `apply`
  re-implements it. `executeEffects` drops the rest of the list after a failed reconciliation save (documented only).
- Core: `Reconciliation.released` has no production consumer; the sensor-ref check in `failedSensorCheck` duplicates
  validation; a v2 room with `area_id: "__proto__"` vanishes without a report.
- `control.ts` ↔ `join.ts` import cycle (accepted).
- Plan 1 leftovers: `main.ts` reports startup failures with `console.error` instead of the logger; `start(options,
  logger)` positional flag; move the `restorable` originals check into core `ledgerFromRaw`.

## Tests

- `packages/server/src/main.test.ts` "the seven days are published once…" is load-flaky (asserts ≤ 31 s simulated).
- MQTT takeover tests use four real 150 ms sleeps.
- No test for a failed save of the fresh-install config at start; the label-write merge copy is not updated by an
  earlier delete in the same batch; no runtime test for the N1 stranded rule before `bridge/devices` arrives.

## Docs

- `README.md`: the "While the config cannot be saved" paragraph swallowed the next one; several lines are not wrapped.
- The page's Russian text reads oddly; it is to be rewritten with the full web UI, not piecemeal.
