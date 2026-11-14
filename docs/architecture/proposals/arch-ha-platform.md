# Heatmaster architecture — the idiomatic Home Assistant stance

Markers: **[V]** checked today against HA core source, the HA developer docs, the Zigbee2MQTT (Z2M) docs or Z2M source. **[U]** unverified.

## 1. Diagnosis

v4 builds a second runtime inside Home Assistant. The engine keeps its own copy of everything that HA or the valve already holds: a config database with revisions, a command ledger with outcomes, a per-aspect acknowledgement memory, a liveness detector with two clocks, a refresh state machine and three stores. Each copy has to be kept consistent with the real holder across restarts, replays and crashes, and every review found another place where a copy drifted. Classes 1 to 5 are all the same fault: a private copy disagreeing with its source.

The pure `step()` function did not remove that state; it made it explicit, and it then had to be persisted, migrated and recovered. The wide contracts (`ValveObservation`, `Aspect`, `ValveState`) exist to carry the copies between modules, which is why every fix touched them (class 8).

The structural fix is to hold no state that HA or the valve can hold. HA already owns config, entity state, availability, registries and service dispatch. What neither can hold is the valve's original settings and the user's request to give a valve back. Only that is ours to persist.

## 2. Core idea

Rooms and schedules are config subentries, so HA core stores, edits, versions and removes them and Heatmaster has no config store. Every tick, a stateless coordinator computes each valve's desired settings from config and time, reads the valve's HA entities, and hands the difference to one writer. A write is never "OK": a setting stays pending until the entity reads the desired value, so confirmation is the absence of a difference. The only private file is a ledger of original valve settings, written once inside the config flow before a valve joins a room. Rollback is the same reconciliation aimed at the originals, started only by a recorded request.

## 3. Components and boundaries

Platform decisions first.

| HA facility | Decision | Reason |
|---|---|---|
| Config subentries `room`, `schedule` | **For** | Per-item add, reconfigure and delete flows; core cleans up devices and entities bound by `config_subentry_id` [V]. Replaces `ConfigStore`, `apply_config`, revisions and three "refused start" paths. |
| Options flow | **For**, global settings only | Interval, stale timeout, global presets, "hold writes". |
| `DataUpdateCoordinator` | **For**, as tick and publisher | 30 s interval plus debounced `async_request_refresh` from state listeners [V]. Holds nothing durable. |
| `helpers.storage.Store` | **For**, one store | Versioned, `_async_migrate_func`, awaited `async_save`, `atomic_writes=True` (not the default) [V]. |
| `RestoreEntity` / `ExtraStoredData` | **Against** for anything that matters | Dumped every 15 min and at stop, so not crash-safe [V]. |
| Repairs, diagnostics | **For** | Issues tied to `config_entry_id` / `config_subentry_id` [V]; diagnostics doubles as the dry-run view. |
| Acting through Z2M's HA entities | **For** reads and writes | State listeners plus blocking service calls. HA silently skips unavailable entities [V], so the port checks first. |
| `mqtt` subscribe/publish | **Against** in Plan 1 | The only reason left is a forced same-value write; Z2M does not deduplicate [V], HA's number entity [U]. |
| `async_unload_entry` | Stop timers only | Unload also means reload and HA stop. |
| `async_remove_entry` | **Against** as rollback | The entry is already gone [V]; it cannot wait for sleepy valves or retry. It only refuses to forget (§6). |

Modules under `custom_components/heatmaster/`:

- **`domain/`** (no HA imports; kept from v4 because it was right): `model`, `schedule` (resolve, fit, compare by meaning, active point), `temperature`, and `desired.py` with `desired_settings(room, valve, readings, originals, now) -> ordered mapping of setting key to value`. Pure, no state.
- **`devices/profiles.py`**: per model, a table of settings (key, codec, range, prerequisites) and capabilities. Data, not behaviour.
- **`devices/z2m.py`** (later `zha.py`): the `ValvePort`. Finds supported devices in the device registry, binds setting keys to entity registry entries by exact unique id, `read(valve) -> mapping of key to value or UNKNOWN`, `async_write(valve, key, value)` as one HA service call. Owns no state. May call HA services and registries; nothing else may call valve services.
- **`ledger.py`**: the one `Store`. Owns valve records (§4).
- **`writer.py`**: the single writer. Owns an in-memory attempt table and per-valve budgets. May call only the port.
- **`liveness.py`**: in-memory "last heard" per device (§5).
- **`coordinator.py`**: tick = parse entry, read, compute desired, diff, offer to writer, build status. May call domain, port (read only), liveness, ledger (read only).
- **`config_flow.py`**: entry flow (`single_config_entry`), options flow, subentry flows. The only caller of `ledger.adopt()`.
- **`issues.py`** (level-triggered sync), `repairs.py`, entity platforms, `diagnostics.py`, `services.py` (`preview`, `resync`, `release_all`), later `websocket.py`.

A config change reaches the runtime through the entry update listener, which core fires for subentry add, update and remove [V]. If room, valve or sensor membership changed it reloads the entry; otherwise it refreshes. Reload and restart are the same path. Subentry flows must end with `async_update_and_abort`, because `async_update_reload_and_abort` raises when update listeners exist [V].

The later panel's websocket commands are thin: validate with the same domain functions, call `async_add_subentry` / `async_update_subentry`, subscribe to the coordinator. ZHA is a second port module and a second column in the profile tables.

## 4. State model

**Persisted by HA core:** the config entry (options) and its subentries. `room`: name, area, valve device ids, sensors with weights, schedule subentry id, preset overrides. `schedule`: name, default week.

**Persisted by Heatmaster** — `heatmaster.ledger`, one record per valve:

| Field | Removed, what breaks |
|---|---|
| `originals` (setting key → value; absent = unreadable and accepted) | No rollback. |
| `release_requested_at` | A lost config would look like "all rooms removed" and release every valve. |
| `released_at` | Re-adoption could not tell a finished release from an interrupted one, and would keep stale originals. |
| `lease` (only if §9 Q1 fails) | A crash could leave a valve in `heat`. |

**In memory only:** attempt table, budgets, last-heard times, last heartbeat per valve, a per-valve "align setpoint" flag.

**Derived every tick:** desired settings, differences, statuses, problems.

**Crash at any point.** Convergence has no record: after a restart the difference is recomputed from what the entities read. Only two points are write-ahead, each one awaited save:
1. *Adoption:* originals saved, then the subentry is created. Crash between: a record with no room and no release request, an orphan (below).
2. *Release request:* the update listener stamps `release_requested_at` for valves that left a room, then reloads. Crash before the stamp: an orphan.

An **orphan** raises a Repairs issue with a fix flow offering "restore original settings" or "leave it"; nothing is written until the user chooses.

**Lost or corrupt ledger.** HA renames the file, raises its own critical issue and returns nothing [V]. Valves in rooms stay managed, since no new harm follows. Each gets an `originals_missing` issue whose fix flow can record current settings as originals. Nothing captures automatically.

**Lost config entries.** Heatmaster does not load and writes nothing. Re-added, it finds orphans and asks.

**A room that no longer parses** (after an upgrade) is skipped alone, with an issue; its valves are neither written nor released.

**Upgrade.** Entry `VERSION`/`MINOR_VERSION` with `async_migrate_entry`; a newer major is refused by core [V]. Store minor bumps are additive; a newer major raises `UnsupportedStorageVersionError` [V], which becomes a setup error and writes nothing.

## 5. Write path

**Tick.** For each valve the coordinator builds the ordered desired list, drops entries whose reading already equals the desired value (unknown counts as different), cuts the list at the first unmet prerequisite, and offers it to the writer. An offer replaces the previous one for that valve. There are no commands, ids, outcomes or supersede records.

**Writer.** One task, one write at a time, 0.5 s apart globally and 2 s per valve. Per `(valve, key)` it keeps `attempts` and `next_try`. It writes when the entity is available, `next_try` has passed and the valve's budget has a token; then `next_try` moves out by 1 min, 5 min, 30 min, 2 h, and 6 h from then on. The row is dropped when the key leaves the offer or its desired value changes. Three attempts raise `setting_not_applied`; convergence clears it.

Why the reading is trustworthy: Z2M awaits the converter and publishes state only if it did not throw; on failure it logs and publishes nothing [V]. Whether that holds for a sleeping TRV is §9 Q2.

**Ordering** is the prerequisite column of the profile table:
- TRV-ZBT: `edit_group = 3` is written before every batch of days, even when it already reads 3; days require it; `active_group = 3` requires all days equal.
- `sensor_source = external` requires a heartbeat sent to that valve within two intervals.

**Making the schedule effective.** When the writer writes any day it sets the valve's align flag. While the flag is set, days are equal and the mode is `auto`, the desired list includes `setpoint = active set point`; the flag clears when it reads equal. It is one idempotent setting with no mode change. If the flag is lost in a crash the valve picks up the new target at its next transition. This assumes §9 Q1. If Q1 fails, the fallback is a ledger `lease {heat, until}` saved before `heat` is written: desired mode is `heat` until seen or expired, then `auto`, and the lease is deleted only when `auto` is read.

**Temperature push.** A separate fixed-rate lane: one write per valve per interval, staggered, skipped when the room temperature is unknown, the entity is unavailable or the mode is `off`. It is not confirmed and not retried; the next beat is the retry. Failure is observed where the valve reports it: the source select reads `remote_source_offline`, and the firmware switches back by itself when writes resume [V, Z2M docs]. That raises an issue and is not rewritten.

**Liveness.** `heard(device)` is the HA-clock time of the last state change of the device's Z2M `last_seen` entity (disabled by default [V]; a Repairs fix flow enables it), else of any entity on the device. The first state after start never counts, and Z2M's replay after HA's birth message carries unchanged values, which MQTT entities do not write [V]. Staleness is measured from the later of `heard` and start. Liveness drives issues and sensor freshness only; writes are gated by entity availability and budget, because a write to a dead valve costs its battery nothing.

**Bound per valve per day:** heartbeats ≤ 1440 / interval (288 at 5 min); settings ≤ a bucket of 20 tokens refilled one per 20 min (≤ 92); a setting that never takes costs 5 writes in the first 3 h, then 4 a day.

**Dry run.** `preview` runs the same desired-and-diff on a candidate room and returns the list. It cannot be empty for an unknown valve, because unknown means "will write". It is the last step of the room flow, a response-only service and a diagnostics section. "Hold writes" closes the writer for whole-house observation.

## 6. Original settings and rollback

- **Capture** happens in one place: the final step of the room flow, when a valve first joins a room. The flow shows what could not be read and the user accepts or cancels. TRVZB schedules cannot be read from the device at all [V], so the original is Z2M's last written value or unknown. There is no runtime capture path, so Heatmaster's own values can never become originals.
- **Protection.** A record is write-once until `released_at` is set. Re-adding a valve whose release did not finish reuses the record.
- **Release** is ordinary reconciliation with the originals as desired values: TRV-ZBT restores `active_group`, then `edit_group`, and never touches groups 1 and 2; TRVZB restores the seven days and the source. It is finished when every restored key reads its original, and only then. It cannot finish early, and if it does not finish it stays visible as `release_incomplete`.
- **Removing the integration.** `release_all` is the documented step before deletion. `async_remove_entry` writes nothing. If unreleased records remain it keeps the ledger file and posts a persistent notification listing each valve and its original values; re-adding the integration resumes through the orphan flow.

## 7. Issue table

| # | Class | Verdict |
|---|---|---|
| 1 | Did the write take | Handled in one place: the tick difference plus `writer.py`. No "OK", no settle timer, no Z2M clock. Still a risk: the reading is Z2M's belief; a factory-reset valve is not noticed (`resync` rewrites). |
| 2 | Schedule refresh | Impossible by construction if Q1 holds (no multi-step sequence, no `heat`). Otherwise handled in one place: the ledger lease. |
| 3 | Originals and release | Overwrite impossible by construction (capture only in the flow). Early or endless release handled in one place (§6). Still a risk: TRV-ZBT group semantics (Q5). |
| 4 | Persistence and crashes | Deleting rooms: impossible (core owns config). Mass release on lost config: impossible (release needs a stamped request). Engine state schema: there is none. |
| 5 | Liveness | Handled in one place: `liveness.py`. Replay and clock mixing impossible by construction. Still a risk: one timeout of blindness after each restart. |
| 6 | Write volume | Handled in one place: the writer's budget and backoff. "Failed forever" impossible. |
| 7 | Dry run | Impossible to be empty by construction. |
| 8 | Contract drift | Reduced: one generic shape (key → value) and HA's own APIs. Still a risk: profile tables and desired rules must agree; write-log snapshots catch it. |

## 8. Costs and risks

- No whole-behaviour unit test without HA. Compensated by wire-level tests: HA's real `mqtt` integration under `mqtt_mock`, captured Z2M discovery payloads, and a fake Z2M answering `/set` with state (drop, delay, replay, offline). `MockConfigEntry(subentries_data=…)`, `hass_storage`, `snapshot_platform` exist in pytest-homeassistant-custom-component [V]; the fake Z2M itself is [U] until step 1. A crash matrix replays every prefix of a scenario's write log, restarts from storage, and asserts originals unchanged, no valve in `heat`, convergence, and the write bound.
- Backoff and budgets reset on restart; a restart loop can spend one bucket per run.
- A dead sensor's cached value is used for up to one stale timeout after each restart.
- Membership changes reload the entry; room entities blink.
- Schedule editing in a subentry form is crude until the panel exists.
- Most likely wrong: Q1; Q2; and whether subentry flows are a good enough editor before Plan 4.

## 9. Hardware questions and user decisions

Measure before building:
1. With no mode toggle, does a schedule written in `auto` apply from the next transition, and does a setpoint written in `auto` hold until then?
2. With batteries out, does Z2M publish nothing and the entity stay unchanged? How long from a good write to the state update?
3. Does `number.set_value` with an unchanged value produce a Zigbee write? How long until `remote_source_offline`, and does it clear by itself?
4. How often does an idle valve report, and does `last_seen` advance each time?
5. TRV-ZBT: do days land in the group selected by `schedule_group_to_edit`, and what do the day entities show after switching it?

**Needs the user's decision:**
1. **Rollback on deletion.** Automatic restore when the integration is deleted cannot be made reliable. Proposed: rollback is an explicit `release_all` (or deleting a room) before deletion; deleting with unreleased valves keeps the record and warns.
2. **5-minute unconditional push.** 288 radio writes per valve per day on batteries. Cheaper: write on a change of 0.2 °C or more, plus a 30-minute keepalive (the fallback is about 2 h).
3. **Z2M `last_seen`.** Require it (ISO 8601) and let Heatmaster enable each device's `last_seen` entity with consent; without it, a sensor steady for an hour looks stale.

## 10. Build order

1. Scaffold, `STYLEGUIDE.md`, the wire-level harness, and the supervised measurements of §9.
2. `domain/` and `devices/profiles.py`, unit-tested.
3. Entry, options and subentry flows; coordinator read path; liveness; room entities; diagnostics. No valve writes: a read-only room view.
4. Ledger, adoption and preview in the flow, with "hold writes" on. The real house shows its planned writes.
5. Writer, temperature lane, sensor source, Repairs sync. Rooms take over the existing automation one at a time.
6. Schedule days, TRV-ZBT groups, making the schedule effective, sync entity, resync button.
7. Release, orphans, `release_all`, removal behaviour, fix flows.
8. Supervised live verification and a 24 h soak.

Planning-rule notes: the styleguide is step 1 and every later step follows it. BDD skeleton skipped here because this is an architecture proposal to be merged with four others; the skeleton belongs in the plan written from the merged design.
