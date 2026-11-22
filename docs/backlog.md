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
