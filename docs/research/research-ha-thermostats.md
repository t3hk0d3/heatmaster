# Research: Home Assistant thermostat integrations that wrap radiator valves (no custom panel)

Read on 2026-11-14 from each default branch. **[V]** = read in source, docs or tracker today; **[U]** = inference. None of the four named projects uses config subentries [V: no mention in any `config_flow.py`], stores schedules, or runs a schedule on the device (question 7 does not apply). Question numbers follow the brief; skipped numbers do not apply.

## 1. Per project

### Better Thermostat (BT) 2.0.0

1. **Rooms.** One config entry per thermostat; an entry wraps one or more TRVs. Since entry version 18.2 all settings are in `entry.options` and `entry.data` is empty [V][bt-init]. Learned state (MPC/PID/TPI models, thermal stats) is in one `Store` per entry, key `better_thermostat_<entry_id>_state` [V][bt-state].
2. **Schedules.** None; presets only, with preset temperatures held by `number` entities [V][bt-pr2261].
3. **Editing.** Config flow of three forms: `user` (name, TRVs, room sensor, window and door sensors, four delays), `advanced` once per TRV (calibration type and mode), `confirm`. The options flow repeats the forms [V][bt-flow]. Two "live" settings are written to options and applied without a reload; anything else reloads the entry [V][bt-init].
5. **Versioning.** `async_migrate_entry` runs cumulative `if version <= n` steps, re-detects each TRV's model below v18, and refuses entries from before 1.0.0-Beta36 with a log message. Minor version 2 lets release 1.9.x still load the entry; because 1.9.3 writes settings back into `data`, every setup moves them into options again [V][bt-init]. The state store has its own `version` key; an unreadable payload is copied to a `.corrupt` store and read back before defaults may overwrite it. `async_remove_entry` deletes store, quarantine copies and repair issues [V][bt-state][bt-init]. Four legacy stores are imported once [V][bt-migrate].
6. **Complaints.** Presets fell back to defaults on every restart because number entities restore after the climate entity [V][bt-pr2261]. The options flow refused its own stored values and could not repair an entry whose setup failed [V][bt-pr2725]. Entities renamed on upgrade [V][bt-2271]. Offset writes on every 0.01 K change exhausted a cloud quota; "mostly a battery question" for Zigbee [V][bt-2890].
8. **Write check.** Read-back. Minimum 30 s between writes per TRV (600 s for HomematicIP), TRV events ignored for 3 s after a write, a 360 s confirm watchdog, a 5-minute reconcile tick, setpoint retries doubling up to 1 h, device error after 6 unapplied writes [V][bt-ctl].
9. **Restore on removal.** Removal cleans up BT's own data only; I found no write-back of original TRV settings [U][bt-init]. A "devices released" switch hands TRVs back to the user without removing the entry [V][bt-climate].
10. **External temperature.** On change, filtered: 5 s debounce, 0.11 K significance threshold, accumulation, a 120 s plateau rule [V][bt-temp]. Re-sent every 30 minutes because, per the source comment, a Sonoff TRVZB falls back to its own sensor after two hours of silence [V][bt-climate]. The TRVZB quirk writes `number.*external_temperature_input` and checks the sensor selector with every write, since a re-paired device returns to the internal sensor [V][bt-trvzb]. Quirks are one module per model behind typed protocols, plus an alias table for rebranded devices [V][bt-quirks].

### Versatile Thermostat (VT) 10.6.4

1. **Rooms.** One entry per thermostat, everything in `entry.data`; the options flow rewrites `data` and saves no options [V][vt-flow]. One extra entry of type `central_config` is allowed; the type is hidden once it exists [V][vt-flow]. Each thermostat has a `use_*_central_config` flag per section (main, TPI, window, motion, power, presence, presets, advanced, lock). At start the thermostat drops its own keys for flagged sections and merges onto the central entry's data [V][vt-base]. Saving the central entry reloads every thermostat [V][vt-init]. Expert parameters remain in `configuration.yaml` [V][vt-init].
2. **Schedules.** None; docs recommend an external scheduler [V][vt-add]. Preset temperatures left the config flow in 6.0 for `number` entities restored through `RestoreEntity` [V][vt-number][vt-354].
3. **Editing.** After choosing a type, a menu of 8–15 entries; "Finalize" appears only when a completeness check passes [V][vt-flow][vt-2171]. 6.0 replaced a linear "configuration tunnel" with this menu [V][vt-rel].
5. **Migration.** Version 2.4, compared as `major*100+minor`, cumulative steps: numbered keys (`heater`, `heater_2`…) became `underlying_entity_ids`, `security_*` became `safety_*`, the offset-calibration list became the sync list, defaults added, dead keys removed [V][vt-init].
6. **Complaints.** Open issue #2171: no guidance in the menu, "Configuration not complete" explains nothing, and per-device settings are parallel lists matched by position (valve entities, sync entities, CSV min/max strings), producing `*_nb_entities_incorrect` errors. The maintainer calls the config flow "a mess" and proposes a minimal flow plus a configuration page; a contributor argues for reworking the official flow instead [V][vt-2171]. The contributor's plan rejects subentries for underlyings: "different data model, edited outside the options menu, heavy migration, reload per subentry" [V][vt-plan]. Central configuration came from a user request to cut repeated screens [V][vt-239]. Presets read 0 after an upgrade for several users [V][vt-1419].
10. **External temperature.** Sent on every room-sensor change, outside the control cycle; either an offset to a calibration `number` (skipped when unchanged, rounded to the entity's step, clamped to its range) or the raw temperature to `external_temperature_input` [V][vt-climate][vt-sync]. No quirks table in core: docs tell the user to set the TRVZB `sensor_select` by hand [V][vt-sync].

### Dual Smart Thermostat (DST)

1. One entry per thermostat, `VERSION = 1`, no migration function; YAML platform still supported, with an import step [V][dst-init][dst-flow][dst-climate].
3. Config flow added September 2025 [V][dst-commits]: about 25 step methods chosen dynamically, plus reconfigure and options flows [V][dst-flow].
6. Runtime merges `{**data, **options}`. A stale options snapshot silently shadowed reconfigured fields (#631); the fix clears options on reconfigure [V][dst-flow][dst-631]. Also: transient flow flags stored, timedeltas stored as dicts, numbers stored as strings, entity not created, duplicate entity after reconfigure [V][dst-flow][dst-484][dst-458].
- **Openings.** Three steps: toggle, pick entities, then one form with an HVAC-mode scope and per-entity open and close timeouts in fields named by index (`opening_1_timeout_open`) [V][dst-open].

### HASmartThermostat (PID)

1. YAML-only until 2026-10-16, when a config flow was added; YAML remains [V][pid-commits][pid-climate]. One entry per thermostat, settings in `entry.options` (Home Assistant's schema flow helper), no version handling [V][pid-flow][pid-init].
3. Five forms (basic, temperature, presets, PID, advanced) with collapsed sections; the options flow repeats all five and reloads [V][pid-flow].
5. The PID integral is restored from the `pid_i` state attribute [V][pid-climate].

### Added: ha-chauffage (scheduler VT recommends; has a panel)

1–2. One config entry with empty `data`; all schedules in `.storage/chauffage`, storage version 6, one migration function per step, each tested against a fixture; downgrade unsupported [V][hc-store][hc-dec]. Model: named schedules; per thermostat one week per schedule; a day is `[["HH:MM", preset id]]`; global presets with a per-thermostat mapping; revision counters so two editors cannot overwrite each other [V][hc-model].
3–4. Panel registered with `async_register_built_in_panel(component_name="custom", …)`; the card is loaded with `add_extra_js_url` from a static path, version in the URL. Transport is websocket commands (`chauffage/subscribe`, `chauffage/weeks/save`, …) with access-level checks; services serve automations [V][hc-front][hc-ws].
6. "Settings in the card, not in the options flow": option forms "proved impractical for setting temperatures room by room" [V][hc-dec].
8. A `pending` list holds commands a battery valve has not shown yet, dropped once shown or after a day [V][hc-model].

## 2. Comparison

| Project | Rooms stored in | Schedules stored in | Edited through | Panel/card transport |
|---|---|---|---|---|
| BT | entry per thermostat (`options`); learned state in per-entry Store | none | config + options flow, entities | none |
| VT | entry per thermostat (`data`) + one central entry | none (external) | menu flow, `number` entities | none in core |
| DST | entry per thermostat (`data` + `options`), or YAML | none | config, reconfigure, options flows; YAML | none |
| PID | entry per thermostat (`options`), or YAML | none | 5-form flow; YAML | none |
| ha-chauffage | one entry; own Store | own Store, shared library | custom panel and card | websocket commands |

## 3. Patterns

- All four use **one config entry per thermostat**. The only shared configuration is VT's central entry, done with flags and a merge at start.
- **Config entries hold wiring, not values edited often.** BT and VT moved preset temperatures to entities; both then hit restore bugs. The one project with schedules uses its own versioned Store and a panel.
- **Flow length draws complaints** once it passes a few forms (VT, DST). BT stays at three forms plus one per TRV.
- **Outliers.** VT's central entry (reason: repeated screens). DST's data/options split (the options-flow default; caused silent bugs). BT's quarantine of unreadable state (reason: keep the only record of what was learned).

## 4. Lessons for a new integration

- **Do** keep one source of truth for settings. Never merge `data` and `options` at runtime [dst-631]; BT (options only) and VT (data only) each chose one.
- **Do** store per-valve settings as one structure per valve, not parallel lists [vt-2171][vt-plan].
- **Do** put schedules and temperatures in a versioned Store edited over websocket, with one tested migration per version and revision checks [hc-store][hc-model]. **Don't** put them in flow forms [vt-354][hc-dec].
- **Don't** rely on `RestoreEntity` numbers for values the climate entity needs at start [bt-pr2261][vt-1419].
- **Do** keep the config flow to a few forms and report exactly what is missing [vt-2171].
- **Do** weigh subentries knowingly: VT's objections were migration cost (absent in a new project) and a reload per subentry [vt-plan].
- **Do** migrate cumulatively, use minor versions for changes an older release can still load, and plan for a downgrade writing the old shape [bt-init].
- **Do** set unreadable storage aside before overwriting it, and delete stores in `async_remove_entry` [bt-state][bt-init].
- **Do** send external temperature on change with a debounce and threshold, plus a keepalive well inside the device's fallback window, and re-check the sensor selector on each write [bt-temp][bt-climate][bt-trvzb]. **Don't** write on every reading [bt-2890][vt-climate].
- **Do** confirm writes by read-back with tolerance, a per-device write budget, backoff, a periodic reconcile, and a short window in which the device's echo is not taken as a user change [bt-ctl].
- **Do** keep device quirks in per-model modules chosen by the registry model, with aliases [bt-quirks]; VT's manual TRVZB step shows the cost of not having them [vt-sync].
- **Do** detect one valve claimed by two entries; BT aborts the flow and raises a repair issue [bt-flow][bt-init].

[bt-init]: https://github.com/KartoffelToby/better_thermostat/blob/master/custom_components/better_thermostat/__init__.py
[bt-flow]: https://github.com/KartoffelToby/better_thermostat/blob/master/custom_components/better_thermostat/config_flow.py
[bt-state]: https://github.com/KartoffelToby/better_thermostat/blob/master/custom_components/better_thermostat/utils/state_manager.py
[bt-migrate]: https://github.com/KartoffelToby/better_thermostat/blob/master/custom_components/better_thermostat/utils/migrate_v0_stores.py
[bt-ctl]: https://github.com/KartoffelToby/better_thermostat/blob/master/custom_components/better_thermostat/utils/controlling.py
[bt-temp]: https://github.com/KartoffelToby/better_thermostat/blob/master/custom_components/better_thermostat/events/temperature.py
[bt-climate]: https://github.com/KartoffelToby/better_thermostat/blob/master/custom_components/better_thermostat/climate.py
[bt-trvzb]: https://github.com/KartoffelToby/better_thermostat/blob/master/custom_components/better_thermostat/model_fixes/TRVZB.py
[bt-quirks]: https://github.com/KartoffelToby/better_thermostat/blob/master/custom_components/better_thermostat/model_fixes/model_quirks.py
[bt-pr2261]: https://github.com/KartoffelToby/better_thermostat/pull/2261
[bt-pr2725]: https://github.com/KartoffelToby/better_thermostat/pull/2725
[bt-2271]: https://github.com/KartoffelToby/better_thermostat/issues/2271
[bt-2890]: https://github.com/KartoffelToby/better_thermostat/issues/2890
[vt-init]: https://github.com/jmcollin78/versatile_thermostat/blob/main/custom_components/versatile_thermostat/__init__.py
[vt-flow]: https://github.com/jmcollin78/versatile_thermostat/blob/main/custom_components/versatile_thermostat/config_flow.py
[vt-base]: https://github.com/jmcollin78/versatile_thermostat/blob/main/custom_components/versatile_thermostat/base_thermostat.py
[vt-number]: https://github.com/jmcollin78/versatile_thermostat/blob/main/custom_components/versatile_thermostat/number.py
[vt-climate]: https://github.com/jmcollin78/versatile_thermostat/blob/main/custom_components/versatile_thermostat/thermostat_climate.py
[vt-sync]: https://github.com/jmcollin78/versatile_thermostat/blob/main/documentation/en/feature-sync_device_temp.md
[vt-add]: https://github.com/jmcollin78/versatile_thermostat/blob/main/documentation/en/additions.md
[vt-rel]: https://github.com/jmcollin78/versatile_thermostat/blob/main/documentation/en/releases.md
[vt-2171]: https://github.com/jmcollin78/versatile_thermostat/issues/2171
[vt-plan]: https://github.com/bontiv/versatile_thermostat/blob/docs/config-flow-simplification/documentation/tech-docs/config-flow-simplification-plan.md
[vt-354]: https://github.com/jmcollin78/versatile_thermostat/issues/354
[vt-239]: https://github.com/jmcollin78/versatile_thermostat/issues/239
[vt-1419]: https://github.com/jmcollin78/versatile_thermostat/issues/1419
[dst-init]: https://github.com/swingerman/ha-dual-smart-thermostat/blob/master/custom_components/dual_smart_thermostat/__init__.py
[dst-flow]: https://github.com/swingerman/ha-dual-smart-thermostat/blob/master/custom_components/dual_smart_thermostat/config_flow.py
[dst-climate]: https://github.com/swingerman/ha-dual-smart-thermostat/blob/master/custom_components/dual_smart_thermostat/climate.py
[dst-open]: https://github.com/swingerman/ha-dual-smart-thermostat/blob/master/custom_components/dual_smart_thermostat/feature_steps/openings.py
[dst-commits]: https://github.com/swingerman/ha-dual-smart-thermostat/commit/1677a07
[dst-631]: https://github.com/swingerman/ha-dual-smart-thermostat/issues/631
[dst-484]: https://github.com/swingerman/ha-dual-smart-thermostat/issues/484
[dst-458]: https://github.com/swingerman/ha-dual-smart-thermostat/issues/458
[pid-init]: https://github.com/ScratMan/HASmartThermostat/blob/master/custom_components/smart_thermostat/__init__.py
[pid-flow]: https://github.com/ScratMan/HASmartThermostat/blob/master/custom_components/smart_thermostat/config_flow.py
[pid-climate]: https://github.com/ScratMan/HASmartThermostat/blob/master/custom_components/smart_thermostat/climate.py
[pid-commits]: https://github.com/ScratMan/HASmartThermostat/commit/10a72a7
[hc-store]: https://github.com/armellarcier/ha-chauffage/blob/main/custom_components/chauffage/store.py
[hc-model]: https://github.com/armellarcier/ha-chauffage/blob/main/custom_components/chauffage/model.py
[hc-front]: https://github.com/armellarcier/ha-chauffage/blob/main/custom_components/chauffage/frontend.py
[hc-ws]: https://github.com/armellarcier/ha-chauffage/blob/main/custom_components/chauffage/websocket.py
[hc-dec]: https://github.com/armellarcier/ha-chauffage/blob/main/docs/decisions.md
