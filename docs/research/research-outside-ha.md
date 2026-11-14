# Research: device/hub-held schedules and controllers outside the HA integration model

Read 2026-11-14. **[V]** = read today in source or official docs. **[U]** = forum, memory or inference.

## 1. Per project

### Zigbee2MQTT + Sonoff TRVZB weekly-schedule tooling
- **Write path [V]:** the `weeklySchedule` extend in [sonoff.ts](https://github.com/Koenkk/zigbee-herdsman-converters/blob/master/src/devices/sonoff.ts) exposes seven `weekly_schedule_<day>` text entities with access `STATE_SET` only. Each is a string `HH:mm/temp …`: at most 6 transitions, the first must be `00:00`, 4–35 °C in 0.5 steps, zero-padded hours. It sends ZCL `hvacThermostat.setWeeklySchedule` (mode = heat). When one MQTT message carries several days, days with identical strings are merged into one command through the day bitmask.
- **Verification [V]:** none. Z2M returns the written string as state straight after the command (optimistic). A `commandGetWeeklyScheduleRsp` parser exists but there is no `convertGet`; the [device page](https://www.zigbee2mqtt.io/devices/TRVZB.html) says "It's not possible to read (/get) this value."
- **Cards [V]:** [enikesha/trvzb-control-card](https://github.com/enikesha/trvzb-control-card) calls `text.set_value` one day at a time and waits up to 15 s for the entity state to equal the wanted string. It refuses to save if the entity changed since the editor loaded (`schedule_conflict`) and reports partial saves. It stores preset names in the Lovelace dashboard config (`lovelace/config`), so it needs an admin and a storage-mode dashboard. [abaddon](https://github.com/abaddon/ha_sonoff_TRVZB_scheduler_card) diffs and publishes one `mqtt.publish` to `zigbee2mqtt/<name>/set` with changed days only. [cr212](https://github.com/cr212/trvzb-schedule) and [petronovak](https://github.com/petronovak/sonoff-trv-schedule-card) fire `text.set_value` for the days with no confirmation. Because Z2M state is optimistic, even the 15 s wait only proves Z2M accepted the command.
- **Mode toggle:** no card toggles `system_mode` after writing [V], and I found no report that a toggle is needed for a new schedule to take effect. The schedule only drives the set point in `auto` [V, expose text].
- **Complaints [V]:** the old composite `weekly_schedule` sensor exceeded HA's 255-character state limit ([#23199](https://github.com/Koenkk/zigbee2mqtt/issues/23199)). The rework to per-day entities left two diverging copies in state and blank inputs ([#30614](https://github.com/Koenkk/zigbee2mqtt/issues/30614), [#30435](https://github.com/Koenkk/zigbee2mqtt/issues/30435)). Users keep schedules in CSV/Node-RED to re-push them ([forum](https://community.simon42.com/t/steuerung-der-schedules-der-sonoff-trvzb-thermostaten-unter-z2m/47793)) [U].
- **Q10 [V]:** `external_temperature_input` — "synchronisation … needs to happen outside of Zigbee2MQTT"; no interval is documented.

### Homematic IP / CCU, and Homematic(IP) Local
- **Vendor model [V]** ([user guide](https://www.eq-3.com/downloads/download/handbuecher/Homematic_IP-User_Guide.pdf)): per room up to three heating schedules, up to six heating phases per day over a base temperature. "Time profiles and groups … remain activated even without internet connection." Battery valves use "cyclical reception". "Lazy config": the access point "remembers" changed configuration and transmits it at the device's next contact. Eco mode (per-room list, 2/4/6 h or permanent), holiday mode (all rooms, end date) and party mode (one room, timed) sit on top of the profile.
- **On the wire [V]** ([week_profile.py](https://github.com/SukramJ/aiohomematic/blob/HEAD/aiohomematic/model/week_profile.py), [docs](https://github.com/SukramJ/aiohomematic/blob/HEAD/docs/user/features/week_profile.md)): profiles P1–P6, each weekday exactly 13 slots, stored in the device `MASTER` paramset as `P<n>_ENDTIME_<DAY>_<slot>` / `P<n>_TEMPERATURE_<DAY>_<slot>`. CCU heating groups appear as virtual thermostats. Community posts say P4–P6 are cooling profiles [U].
- **Sync and confirmation [V]:** writes use `put_paramset`. "The cache is NOT updated optimistically"; it is reloaded from the CCU when `CONFIG_PENDING` goes true→false ([data_point.py](https://github.com/SukramJ/aiohomematic/blob/HEAD/aiohomematic/model/generic/data_point.py)). The panel shows a "Configuration pending" icon ("the device may be in sleep mode"). Known failures: sending a field the device does not advertise makes the CCU reject the whole paramset silently, so `CONFIG_PENDING` never clears; on BidCos it is "unreliable", hence a manual `reload_device_config` service.
- **Editing [V]:** device-targeted services (`get/set_schedule_profile`, `set_schedule_weekday`, `copy_schedule`, `copy_schedule_profile`), a bundled climate schedule card, and an admin-only sidebar panel. Away mode is services (`enable_away_mode_by_calendar/_by_duration`).
- **Panel transport [V]:** websocket commands `homematicip_local/config/*` ([websocket_api.py](https://github.com/SukramJ/homematicip_local/blob/HEAD/custom_components/homematicip_local/websocket_api.py)), including an in-memory edit session (open/set/undo/redo/save/discard), JSON export/import and a change history in HA storage capped at 500 entries. Registered with `panel_custom.async_register_panel(require_admin=True)`; the static path is registered once per process because aiohttp cannot remove routes; cards load through `frontend.add_extra_js_url`, deferred to `homeassistant_started` ([panel.py](https://github.com/SukramJ/homematicip_local/blob/HEAD/custom_components/homematicip_local/panel.py)). Non-admin schedule editing is an option enforced in the backend.
- **Complaint [V]:** the simple "base temperature + periods" format is lossy. A slot at base temperature reads back as a gap, so any read-modify-write through card or panel deletes those switching points, which users rely on because "a manual change at the thermostat stays active only until the next switching point."
- **Q10 [V]:** the valve itself wakes "to recall the current temperature from the … Wall Thermostat" (pull, on the valve's cycle).

### Honeywell Evohome
- Zones and schedules live in the controller, reached through the vendor cloud. [V] ([zone.py](https://github.com/zxdavb/evohome-async/blob/HEAD/src/evohomeasync2/zone.py)): `GET/PUT …/{id}/schedule` with `dailySchedules`; limits come from the API (`maxSwitchpointsPerDay`, timing resolution). A PUT returns a vendor **comm task**: accepted "before the change has reached the system", gateway tasks take about 3–5 s, and `wait()` polls until success ([comm_task.py](https://github.com/zxdavb/evohome-async/blob/HEAD/src/evohomeasync2/comm_task.py)). Whole-system backup/restore matches zones by id or name ([control_system.py](https://github.com/zxdavb/evohome-async/blob/HEAD/src/evohomeasync2/control_system.py)).
- Local RF [V] ([ramses_rf schedule.py](https://github.com/zxdavb/ramses_rf/blob/HEAD/src/ramses_rf/systems/schedule.py)): schedules are compressed blobs moved in numbered fragments. The controller keeps a global change counter; the client compares it with the version it fetched to decide whether its copy is stale, and has explicit states (fetching, updating, synchronised, faulted). After a write it re-reads the counter or the schedule.

### tado
- Zones and schedules are in the cloud. [V] ([my_zone.py](https://github.com/wmalgadey/PyTado/blob/HEAD/PyTado/zone/my_zone.py)): each zone has timetables (one-day, three-day, seven-day), one active, with blocks at `zones/{id}/schedule/timetables/{t}/blocks/{day}`. Manual changes are overlays with a termination type (`MANUAL`, `NEXT_TIME_BLOCK`, `TADO_MODE`), so the override never edits the schedule. No shared library; schedules are per zone.

### Drayton Wiser
- Rooms and schedules live on the hub; HA holds one config entry per hub. [V] ([schedule.py](https://github.com/msp1974/aioWiserHeatAPI/blob/HEAD/aioWiserHeatAPI/schedule.py)): schedules are **separate hub objects** with id, name, type and an `Assignments` list of room ids. Assigning is a write of that list; create, rename, copy and delete are separate operations.
- Editing [V]: services (`get_schedule`/`set_schedule` to and from YAML files, `set_schedule_from_string`, `copy_schedule`, `assign_schedule`), a schedule card, and since 4.0 one sidebar panel with tabs ([README](https://github.com/asantaga/wiserHomeAssistantPlatform)).
- Transport [V] ([websockets.py](https://github.com/asantaga/wiserHomeAssistantPlatform/blob/HEAD/custom_components/wiser/websockets.py)): `wiser/schedules`, `wiser/schedule/{id,assign,create,rename,delete,save,copy}`; each write is followed by a coordinator refresh, and a `wiser_updated` event subscription pushes changes. The panel is registered with `frontend.async_register_built_in_panel` and a `_panel_custom` config; card bundles are downloaded from their own releases and updated through update entities ([frontend-registry.md](https://github.com/asantaga/wiserHomeAssistantPlatform/blob/HEAD/docs/frontend-registry.md)).
- The one HA-run schedule [V] ([local_schedule.py](https://github.com/asantaga/wiserHomeAssistantPlatform/blob/HEAD/custom_components/wiser/local_schedule.py)): versioned `Store`; on load it validates and falls back to a default if corrupt. The release notes warn it "does not change the boiler while Home Assistant is offline."
- Complaint [V, title]: [#794](https://github.com/asantaga/wiserHomeAssistantPlatform/issues/794) asks for schedules as entities.

### ioBroker `heatingcontrol`
- [V] ([README](https://github.com/rg-engineering/ioBroker.heatingcontrol), [datapoints.js](https://github.com/rg-engineering/ioBroker.heatingcontrol/blob/master/lib/datapoints.js)): structure (rooms, devices per room, profile type, number of profiles, number of periods) is adapter admin config. Schedule values are ordinary state datapoints, `Profiles.<n>.<Room>.<Mon|Mo-Fr|Mo-Su>.Periods.<i>.time/Temperature`, one per value ("the more you set, the more datapoints will be created"). A profile is a global slot covering all rooms, selected by `CurrentProfile`. Editing is by vis widgets or the object tree; copy buttons copy to the next profile or day. The controller runs the schedule. Changes at the thermostat follow one admin policy: timed override, new profile value, or until next profile point. Away, guests, party and window are relative or absolute offsets.
- Complaint [V, title]: [#884](https://github.com/rg-engineering/ioBroker.heatingcontrol/issues/884) — renaming a room has no effect, because rooms are keyed by name in datapoint paths.

### openHAB (community "time profiles" widget)
- [V] ([thread](https://community.openhab.org/t/the-ultimate-full-week-heating-thermostat-control-widget-and-ruleset-using-time-profiles/144122)): everything is items. A profile is a group of 24 hourly Number items; each room has primary and alternate profile items (workday/weekend). Widgets send item commands; rules on a 10-minute cron command every thermostat in the room group. Rooms reference profiles, so sharing is natural. Controller-run.

### Schedy (AppDaemon)
- [V] ([repo](https://github.com/efficiosoft/hass-apps), "MAINTENANCE MODE"): rooms, actors and schedules are all YAML in the AppDaemon app config; sharing is by `schedule_snippets`, `schedule_prepend` and `schedule_append`; no UI. Controller-run. Write confirmation ([actor/base.py](https://github.com/efficiosoft/hass-apps/blob/master/hass_apps/schedy/actor/base.py)): it re-sends until the actor reports the wanted value, `send_retries` 10 at `send_retry_interval` 30 s, then logs "Gave up sending". Manual changes: `allow_manual_changes`, `replicate_changes` to the other actors in the room, `rescheduling_delay`.

## 2. Comparison

| Project | Rooms stored in | Schedules stored in | Edited through | Panel/card transport |
|---|---|---|---|---|
| Z2M TRVZB cards | none (per valve) | valve; mirror in Z2M state | Lovelace cards, Z2M UI | `text.set_value` or `mqtt.publish` |
| Homematic(IP) Local | CCU (groups) | device MASTER paramset | services, card, admin panel | websocket commands |
| Evohome | controller/cloud | controller | vendor app, library | REST + comm task |
| tado | cloud | cloud, per zone | vendor app, library | REST |
| Wiser | hub | hub objects + assignments | services, YAML files, card, panel | websocket commands |
| ioBroker heatingcontrol | adapter config | state datapoints | vis widgets, object tree | state writes |
| openHAB widget | items/groups | items | Main UI widgets | item commands |
| Schedy | YAML | YAML | text editor | none |

## 3. Patterns

- Systems with a hub (Wiser, Evohome, tado, Homematic IP) make the schedule a hub object and let the hub deal with sleepy devices. Third-party code writes to the hub and never mirrors schedules into HA storage.
- A shared schedule library exists only where schedules are objects with assignment lists (Wiser) or referenced profiles (openHAB). Homematic and Z2M tools share by **copying** between devices.
- Honest pending state appears only in Homematic (`CONFIG_PENDING`, non-optimistic cache), Evohome (comm task) and ramses_rf (change counter, state machine). Z2M tooling is optimistic and cannot read back.
- Overrides are a separate layer everywhere (tado overlays, Homematic eco/holiday/party, ioBroker offsets); nobody edits the schedule to express "away".
- Removal: device-held systems keep running the last schedule; none restores previous settings. Controller-run systems (Schedy, ioBroker, openHAB) stop at the last set point [U].
- Both integrations with real UIs converged on websocket commands plus a custom sidebar panel, keeping services for automation.

## 4. Lessons

**Do**
- Make schedules first-class objects with ids and an assignment list (Wiser); avoid keying anything by room name (ioBroker #884).
- Keep the integration's own copy as the source of truth and track per-valve state (pending, synced, failed), with retries then "gave up" (Schedy, Homematic). TRVZB via Z2M cannot be read back, so the state can only mean "command accepted".
- Detect concurrent edits before saving (enikesha baseline check; ramses_rf change counter).
- Store exactly what is written to the device; a lossy simplified format silently destroys data on round trip (Homematic).
- Enforce device limits (6 transitions, first at 00:00, 0.5 °C) in the backend; merge identical days into one message (Z2M batching).
- Use websocket commands for the panel and services for automation; register the static path once; versioned `Store` with validate-or-default on load (Wiser).
- Model away/boost as a layer above the schedule with its own end condition.

**Don't**
- Don't treat an optimistic Z2M echo as device confirmation.
- Don't put a whole schedule in an entity state (255-character limit, #23199).
- Don't keep UI metadata in dashboard config (admin-only, breaks on YAML dashboards).
- Don't keep two representations of one schedule during a migration (#30614).
