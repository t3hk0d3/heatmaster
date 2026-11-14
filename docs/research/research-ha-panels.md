# Research: HA custom integrations with their own panel/card and rich stored content

Source read 2026-11-14 from shallow clones of each default branch. **[V]** = read in source/issue today, **[U]** = memory or inference. `…/blob/HEAD/` links resolve to the default branch.

Name corrections: `asantaga/wiser-home-assistant` does not exist; the integration is `asantaga/wiserHomeAssistantPlatform`. Its schedule card now lives in `andyblac/wiser-schedule-card` (named in `cards.json`; card source not read). "Chauffage" was found: `armellarcier/ha-chauffage`.

## 1. Per project

### Scheduler component + card (nielsfaber) — component 3.3.9, card 4.0.20
- **Rooms:** none. A schedule targets entities directly. [V]
- **Schedules:** own file `.storage/scheduler.storage` through a `Store` subclass, `STORAGE_VERSION = 3`, 10 s delayed save. Schema: `schedules[]` = `{schedule_id (3-byte hex), name, enabled, weekdays, start_date, end_date, repeat_type, timeslots[{start, stop, conditions[], condition_type, track_conditions, actions[{service, entity_id, service_data}]}]}`, plus `tags[]` = `{name, schedules[ids]}`. One schedule reaches many entities by repeating an action per entity; tags are the only grouping. Each schedule is a `switch` entity. [V] https://github.com/nielsfaber/scheduler-component/blob/HEAD/custom_components/scheduler/store.py
- **Config entry:** single instance, `data={}`; the entry only anchors the store and one device. [V] https://github.com/nielsfaber/scheduler-component/blob/HEAD/custom_components/scheduler/config_flow.py
- **Editing:** Lovelace card only (separate HACS repo), plus services `add/edit/remove/copy/enable_all/disable_all/reload_storage`. No panel. [V] https://github.com/nielsfaber/scheduler-component/blob/HEAD/custom_components/scheduler/__init__.py
- **Transport:** mixed. Reads over websocket (`scheduler`, `scheduler/item`, `scheduler/tags`), one subscription `scheduler_updated` relaying dispatcher signals (item created/updated/removed, timer updated/finished) carrying only a `schedule_id`; the card refetches. Writes are HTTP POST views `/api/scheduler/add|edit|remove`. No admin check in the handlers. [V] https://github.com/nielsfaber/scheduler-component/blob/HEAD/custom_components/scheduler/websockets.py , https://github.com/nielsfaber/scheduler-card/blob/HEAD/src/data/store/save_schedule.ts
- **Migration/backup:** `_async_migrate_func` handles v1→2→3. Missing file → empty. Load indexes keys directly, so a malformed entry raises during setup [U, inferred]. Backup = "include the file in your HA backup". Removing the entry deletes the file. Entity-id renames are followed and rewritten in the store. [V] https://github.com/nielsfaber/scheduler-component/blob/HEAD/README.md
- **Complaints:** a user hand-edited the storage file and wanted it reloaded; that produced `reload_storage` and delete-by-id to remove corrupt entries [V] https://github.com/nielsfaber/scheduler-component/issues/484 . Card and component ship separately and drift: conditions "disappeared" until the card was updated [V] https://github.com/nielsfaber/scheduler-component/issues/443 ; card v4 "cannot connect", users downgraded [V] https://github.com/nielsfaber/scheduler-card/issues/951 ; "Subscription not found" [V] https://github.com/nielsfaber/scheduler-component/issues/542 . Non-admins cannot add schedules; maintainer: "The choice is made by HA" [V] https://github.com/nielsfaber/scheduler-component/issues/85 .
- **Runs in** the controller (HA timers). [V]

### Alarmo (nielsfaber) — 1.10.19
- **Areas, sensors, users, automations, sensor groups, config:** all in `.storage/alarmo.storage`; `Store` subclass with major 6 / minor 3. Config entry is single-instance with empty data. [V] https://github.com/nielsfaber/alarmo/blob/HEAD/custom_components/alarmo/store.py
- **Panel registration:** `hass.http.async_register_static_paths([StaticPathConfig("/api/panel_custom/alarmo", <dist/alarm-panel.js>, cache_headers=False)])`, then `panel_custom.async_register_panel(..., module_url="…?v={VERSION}&m={mtime}", require_admin=True, config_panel_domain=DOMAIN)`. Removed with `frontend.async_remove_panel` on unload and removal. Bundle is committed in `frontend/dist`. [V] https://github.com/nielsfaber/alarmo/blob/HEAD/custom_components/alarmo/panel.py
- **Transport:** same mixed shape as Scheduler. Websocket reads `alarmo/config|areas|sensors|users|automations|entities|sensor_groups|countdown|ready_to_arm_modes`; subscriptions `alarmo_config_updated` (empty ping → every view refetches) and `alarmo_updated` (card events); writes are POST views `/api/alarmo/config|area|sensors|users|automations|sensor_groups` where a `remove: true` field means delete. [V] https://github.com/nielsfaber/alarmo/blob/HEAD/custom_components/alarmo/websockets.py
- **Authorization:** only the panel is `require_admin`; neither the POST views nor the websocket reads check the user. [V, same file]. History: panel hiding was requested and re-added in v1.3.2 [V] https://github.com/nielsfaber/alarmo/issues/22 ; a "hide from sidebar" request followed [V] https://github.com/nielsfaber/alarmo/issues/328 .
- **Migration:** one function with cumulative `if old_major_version <= N` blocks, minor-version steps since 6.2. Missing data → a factory-default area is created. Removal deletes the store. No export/import. [V]
- **Complaints:** panel stuck on "Loading…" after HA frontend changes [V] https://github.com/nielsfaber/alarmo/issues/688 , https://github.com/nielsfaber/alarmo/issues/1145 (title only).

### Drayton Wiser (asantaga/wiserHomeAssistantPlatform) — 4.0.2
- **Rooms and schedules:** on the hub. A schedule is a hub object with an integer id, a type and an assignment list of room/device ids; assigning sends the merged id list. [V] https://github.com/msp1974/aioWiserHeatAPI/blob/HEAD/aioWiserHeatAPI/schedule.py
- **In HA:** config entry (v1.6) per hub with options; small Stores for room names and one integration-owned schedule (OpenTherm hot water) at `wiser.<entry_id>.opentherm_hot_water_schedule`, version 1, validated on load and reset to a default if invalid. [V] https://github.com/asantaga/wiserHomeAssistantPlatform/blob/HEAD/custom_components/wiser/local_schedule.py
- **Editing:** schedule card, sidebar panel, and services `get_schedule`/`set_schedule` (YAML file, default `<config>/schedules/schedule_<entity>.yaml`), `set_schedule_from_data` (templated YAML string), `copy_schedule`, `assign_schedule`. Only project here with file export/import. [V] https://github.com/asantaga/wiserHomeAssistantPlatform/blob/HEAD/custom_components/wiser/services.py
- **Websocket:** `wiser/hubs`, `/schedules`, `/schedules/types`, `/schedule/id`, `/rooms`, `/devices`, `/schedule/assign` (with `remove`), `/create`, `/rename`, `/delete`, `/save`, `/copy`, `/zigbee`; subscription `wiser_updated` (hub name only). Only `wiser/panel/configure*` is `require_admin`; schedule writes are not. Every write is followed by `coordinator.async_refresh()`, i.e. read-back from the hub. [V] https://github.com/asantaga/wiserHomeAssistantPlatform/blob/HEAD/custom_components/wiser/websockets.py
- **Panel:** added September 2026. First registration `panel_custom.async_register_panel`; later updates `frontend.async_register_built_in_panel(component_name="custom", config={"_panel_custom": …}, update=True)`. Per-panel settings live in config entry **options**. Sidebar entry is an option. [V] https://github.com/asantaga/wiserHomeAssistantPlatform/blob/HEAD/custom_components/wiser/frontend/wiser_sidebar.py , https://github.com/asantaga/wiserHomeAssistantPlatform/pull/708
- **Cache-busting:** `?v=` from a version marker comment in the bundle, else a sha256 prefix. Cards update independently through HA update entities into `.storage/wiser_cards/` with digest checks; bundles were removed from the repo because stale copies were mistaken for current. [V] https://github.com/asantaga/wiserHomeAssistantPlatform/blob/HEAD/custom_components/wiser/frontend/__init__.py , https://github.com/asantaga/wiserHomeAssistantPlatform/pull/709 , https://github.com/asantaga/wiserHomeAssistantPlatform/pull/716
- **Complaints:** auto-registering Lovelace resources wiped other resources at restart [V] https://github.com/asantaga/wiserHomeAssistantPlatform/issues/287 , crashed in YAML mode [V] https://github.com/asantaga/wiserHomeAssistantPlatform/issues/270 .
- **Schedule runs on** the hub; HA polls. No conflict handling needed. [V]

### Climate Scheduler (kneave) — 1.15.1
- **Storage:** `.storage/climate_scheduler_data`, plain `Store`, `STORAGE_VERSION = 1` forever. Shape `{groups, profiles, settings, advance_history}`; groups keyed by **name**, single entities as `__entity_<id>` groups; a profile = `{schedule_mode: all_days|5/2|individual, schedules: {day: [{time, temp, …}]}}`. [V] https://github.com/kneave/climate-scheduler/blob/HEAD/custom_components/climate_scheduler/storage.py
- **Migrations:** five shape-sniffing functions run on every load (single → day-based → per-group profiles → entities-as-groups → global profiles), plus repair code for recursively nested `settings.settings.settings…` caused by a frontend/backend shape mismatch. [V, same file]
- **Why profiles went global (Feb 2026):** "Per schedule profiles is a bit tedious"; applying one profile to several schedules [V] https://github.com/kneave/climate-scheduler/issues/159 . Fallout: profiles renamed "Upstairs - Home", breaking automations [V] https://github.com/kneave/climate-scheduler/blob/HEAD/tools/CHANGELOG.md ; wrong conversion [V] https://github.com/kneave/climate-scheduler/issues/168 ; "one device schedule bleeds into another" when rooms share the Default profile [V] https://github.com/kneave/climate-scheduler/issues/187 .
- **Transport:** about 45 HA services, reads via `SupportsResponse.ONLY`; settings sent as a JSON string. Live updates through bus events. [V] https://github.com/kneave/climate-scheduler/blob/HEAD/custom_components/climate_scheduler/services.py
- **Frontend:** card auto-registered as a Lovelace resource with `?v=<manifest version>`; client compares against `/climate_scheduler/static/.version` and prompts a refresh. No sidebar panel registered in Python. [V] https://github.com/kneave/climate-scheduler/blob/HEAD/custom_components/climate_scheduler/__init__.py
- **Complaints:** non-admins get "Unauthorized" because the card subscribes to a custom bus event [V issue; HA rule U] https://github.com/kneave/climate-scheduler/issues/199 ; six duplicate resource registrations [V] https://github.com/kneave/climate-scheduler/issues/196 ; two HA instances corrupt each other through `localStorage` mirroring [V] https://github.com/kneave/climate-scheduler/issues/188 ; schedules vanish on reload [V] https://github.com/kneave/climate-scheduler/issues/8 .
- **Runs in** the controller, 60 s tick. [V] https://github.com/kneave/climate-scheduler/blob/HEAD/custom_components/climate_scheduler/const.py

### Chauffage (armellarcier/ha-chauffage) — 0.9.0-beta.4, created 2026-10, 20 stars
English/French project: weekly schedules for existing `climate` entities, with a card and an admin panel. [V] https://github.com/armellarcier/ha-chauffage
- **Storage:** `single_config_entry`; all content in `.storage/chauffage`, `Store` major 6 / minor 1, a `MIGRATIONS` dict of pure functions, each tested against a fixture. Deleting the entry deletes the data. [V] https://github.com/armellarcier/ha-chauffage/blob/HEAD/custom_components/chauffage/store.py
- **Model:** global `schedules[{id, name}]` (stable ids, names are labels), global `presets[]`, `thermostats{entity_id: {weeks{schedule_id: 7 days of [HH:MM, preset_id]}, mapping, paused, revision}}`, `overrides`, `pending`, global `revision`. Schedules are global *modes*; each thermostat holds its own week per mode — not a shared weekly profile. [V] https://github.com/armellarcier/ha-chauffage/blob/HEAD/custom_components/chauffage/model.py
- **History:** started as a YAML package; moved to an integration because of attribute size limits, no services, no UI. Settings moved from options flow to card ("option forms … proved impractical for setting temperatures room by room"), then to a panel. The integration, not card config, owns the list of scheduled thermostats. [V] https://github.com/armellarcier/ha-chauffage/blob/HEAD/docs/decisions.md
- **Panel:** `frontend.async_register_built_in_panel(component_name="custom", frontend_url_path="chauffage", config={"_panel_custom": {name, module_url, embed_iframe: False, trust_external: False}}, require_admin=…)`. One bundle serves card and panel, loaded on every page with `add_extra_js_url`, URL `?v=<integration version>`, static path with `cache_headers=False`. No Lovelace resource. Known race: pages served during startup lack the module. [V] https://github.com/armellarcier/ha-chauffage/blob/HEAD/custom_components/chauffage/frontend.py
- **Websocket:** `chauffage/subscribe` pushes a full snapshot after every change and survives integration reloads; writes are whole-collection setters (`weeks/save`, `schedules/set`, `presets/set`, `rules/set`, `mapping/set`, `thermostat/set|forget`, `settings/set`, `override/set`). Saves carry a revision and are refused as `stale`. Authorization per command: admin always; non-admins by access level (*Use/Plan/Set up*) and entity `POLICY_CONTROL`. Reason: wall tablets on non-admin accounts. [V] https://github.com/armellarcier/ha-chauffage/blob/HEAD/custom_components/chauffage/websocket.py
- **Write confirmation:** every command is recorded in persisted `pending` until the thermostat's state shows it (battery valves apply hours late), dropped after a day; own service-call contexts distinguish its writes from manual changes. [V] https://github.com/armellarcier/ha-chauffage/blob/HEAD/custom_components/chauffage/runtime.py

## 2. Comparison

| Project | Rooms stored in | Schedules stored in | Edited through | Transport |
|---|---|---|---|---|
| Scheduler | none | own Store v3 | card, services | WS read + subscribe, HTTP POST write |
| Alarmo | own Store v6.3 | n/a | admin panel | WS read + subscribe, HTTP POST write |
| Wiser | hub | hub (one local Store) | card, panel, services, YAML file | WS for all, subscribe ping |
| Climate Scheduler | own Store v1 | same file, global profiles | card | services with responses, bus events |
| Chauffage | own Store v6.1 | same file | card, admin panel | WS for all, snapshot subscribe |

## 3. Patterns

- **Single config entry with empty data plus one own Store file** is universal where the integration owns content. Nobody uses `helpers.collection`, subentries or one entry per room. Options hold only display preferences.
- **Push is a "something changed" ping followed by refetch** (Scheduler, Alarmo, Wiser). Chauffage pushes whole snapshots instead.
- **Outliers:** Climate Scheduler uses services as the frontend API and an unversioned store; it has the most storage and permission bugs. Wiser stores nothing because the hub does, and is alone in offering file export/import.
- **No project restores device state on removal**, and none feeds external temperature to valves.

## 4. Lessons

**Do**
1. Keep rooms and schedules in one versioned Store behind a single config entry (Alarmo, Scheduler, Chauffage).
2. Use `Store._async_migrate_func` with major/minor versions and fixture tests (Chauffage, Alarmo).
3. Give schedules stable ids; names are labels (Chauffage decision; Climate Scheduler's rename broke automations).
4. Model assignment as a reference list on the schedule and show the count (Wiser `Assignments`); keep "copy" a separate operation.
5. Expose your own websocket subscription; guard writes with a revision (Chauffage `stale`).
6. Check authorization in each command handler (Chauffage); `require_admin` on the panel only hides it (Alarmo, Wiser).
7. Serve the bundle from a static path with `cache_headers=False` and a `?v=` version or hash; remove the panel on unload; make the sidebar entry optional (Alarmo #328, Wiser, Chauffage).
8. Persist unconfirmed device commands (Chauffage `pending`).
9. Offer a text export/import or reload (Wiser YAML; Scheduler #484).

**Don't**
1. Sniff data shapes on every load (Climate Scheduler #168).
2. Make a shared profile editable from a room view without saying it is shared (#187).
3. Write Lovelace resources automatically (Wiser #287/#270, Climate Scheduler #196); prefer `add_extra_js_url` and document the startup race.
4. Ship card and backend on separate release tracks (Scheduler #443, card #951).
5. Subscribe the frontend to raw bus events (#199) or mirror config in `localStorage` (#188).
6. Use services as the panel's data API (Climate Scheduler's JSON-string settings and nested-settings corruption).
