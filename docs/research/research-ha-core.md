# Research: Home Assistant core's own conventions

Read on 2026-11-14 from the `dev` branch of core, the developer docs and the architecture discussions. **[V]** = read in source or official docs today; **[U]** = inference or memory.

URL prefixes: `C/` = https://github.com/home-assistant/core/blob/dev/homeassistant/ · `D/` = https://developers.home-assistant.io/ · `A/` = https://github.com/home-assistant/architecture/discussions/ · `F/` = https://github.com/home-assistant/frontend/blob/dev/src/

## 1. Per pattern

### Config subentries

- **What they are.** Typed children of a config entry: `data` (mapping), `subentry_id` (ULID), `subentry_type`, `title`, `unique_id`. They are saved inside the parent, in the one file `.storage/core.config_entries` (storage version 1.5, 1 s save delay). [V] `C/config_entries.py`
- **What they are for.** "Pieces of configuration which share some common resource, for example a cloud account or an MQTT broker" [V] `D/blog/2025/02/16/config-subentries`. The proposal lists MQTT entities, conversation agents, notification targets and weather locations. It says automations and scripts are "not the goal", and the author rejects using them to "ask the user more information that is necessary for set up". Approved 2025-01-23. [V] `A/1070`
- **Who uses them** (each read in `C/components/<name>/config_flow.py`) [V]:

| Integration | Subentry is | Data |
|---|---|---|
| `mqtt` | a device | nested: device info, availability, `components{id: entity config}`; a menu flow of about 850 lines (add, update, delete entity, save, export YAML) |
| `satel_integra` | partition, zone, output, switchable output | flat: number, name, type |
| `ness_alarm` | zone | flat: number, type |
| `rfxtrx` | device | flat: event code and device options |
| `forecast_solar` | roof plane | flat: declination, azimuth, power |
| `scrape` | sensor | flat sensor definition |
| `bayesian` | observation | flat, shape depends on observation type |
| `openai_conversation` | conversation agent, AI task, STT, TTS | flat options, including the prompt text |
| `telegram_bot` | allowed chat | one field |
| `teslemetry` | vehicle, energy site | flat |

  Also `smtp` (recipient), `ntfy` (topic), `habitica`, `nederlandse_spoorwegen` (route). Only MQTT nests; everything else is a handful of fields.
- **Size and nesting guidance.** None exists in the developer docs. [V, searched]
- **Limitations.**
  - Edited only through a `ConfigSubentryFlow` with `user` and `reconfigure` steps; no discovery or reauth. [V] `D/docs/core/integration/config_flow#subentry-flows`
  - The stock websocket command `config_entries/subentries/list` returns id, type, title and unique id, not `data`. [V] `C/components/config/config_entries.py`
  - There is no per-subentry listener. Any add, update or remove fires the parent entry's update listeners. `openai_conversation` and `satel_integra` reload the whole entry; `forecast_solar` hand-writes a diff to avoid that. [V]
  - A subentry unique id is unique only within its entry. Flow strings live under `config_subentries.<type>` in `strings.json`. [V]
  - Removing a subentry clears its devices, entities and issues. Since 2026.8 a device belongs to exactly one config entry and at most one subentry, and helpers must link entities to a foreign device, never add their entry to it. [V] `D/blog/2026/07/21/device-registry-single-config-entry`
  - No bulk edit: one flow per subentry. [U, no such API in `config_entries.py`]
  - Frontend had subentry bugs (sorting, entity counts, duplicate rows): frontend issues 26486, 26970, 54361. [V, titles only]

### The `schedule` helper

- **Storage.** A `DictStorageCollection` over `Store(key="schedule")`, so `.storage/schedule`, version 1.1, plus a YAML collection. **No config entry**: the manifest has no `config_flow`. [V] `C/components/schedule/__init__.py`, `manifest.json`
- **Model.** `{id, name, icon?, monday…sunday: [{from, to, data?}]}`. Blocks must not overlap, `to` may be 24:00, and `data` is a flat dict of scalars per block. [V] `C/components/schedule/schema.py`
- **Editing.** The frontend week grid (`ha-schedule-form`, built on fullcalendar) calls `schedule/list|create|update|delete`, which `DictStorageCollectionWebsocket` generates. Automations read it with the response-only action `schedule.get_schedule`. [V] `F/data/schedule.ts`, `F/panels/config/helpers/forms/ha-schedule-form.ts`
- **Corrupt or missing file.** `Store` renames a corrupt file to `.corrupt.<time>`, raises a repair issue and starts empty. Migration is `_async_migrate_func(major, minor, data)`. [V] `C/helpers/storage.py`

### `helpers.collection`

- **Gives.** An id manager, CRUD with change listeners, a 10 s delayed save, `sync_entity_lifecycle` (one entity per item), and websocket `list|create|update|delete|subscribe` with admin-only writes. [V] `C/helpers/collection.py`
- **Users.** `input_*`, `counter`, `timer`, `schedule`, `zone`, `person`, `tag`, Lovelace dashboards and resources, `image_upload`, `application_credentials`, `assist_pipeline`. [V, code search]
- **Status for custom integrations.** The developer docs never mention it; they do announce `Store` changes to integration authors (`D/blog/2022/07/08/generic-store`, `D/blog/2025/11/25/…`). [V] So `Store` is the public helper and `collection` is importable but has no documented contract. [U]
- **Direction.** Later helpers are config-entry based: `template`, `group`, `utility_meter`, `generic_thermostat`, `derivative`, `threshold` and others all have `config_flow: true`. [V] The proposed colour helper also uses a config flow (`A/1448`). No existing collection user is being migrated, and the module got a functional fix on 2026-10-07. [V]

### Dashboards (Lovelace) and energy

- The dashboard index is a collection in `.storage/lovelace_dashboards`. Each dashboard is one whole document in its own `Store`, `.storage/lovelace.<id>`, read with `lovelace/config` and replaced whole with the admin-only `lovelace/config/save`. No config entry. [V] `C/components/lovelace/dashboard.py`, `websocket.py`
- Energy preferences follow the same shape: a versioned `Store` and `energy/get_prefs|save_prefs`. [V] `C/components/energy/data.py`

### KNX (added: the closest precedent)

- The config entry holds the bus connection. Entities created in the UI live in the integration's own versioned store, `.storage/knx/config_store.json` (version 2.5, with migration). A custom panel is registered with `panel_custom.async_register_panel` and a static path, and talks through about 25 admin-only websocket commands. KNX uses no subentries, although `A/1070` named it as a candidate. [V] `C/components/knx/storage/config_store.py`, `C/components/knx/websocket.py`

### Climate integrations whose device or hub owns a weekly schedule

| Integration | Schedule exposure [V, `climate.py`, `select.py`, `services.py`] |
|---|---|
| `evohome` | reads zone schedules, cached and refetched when stale, to show setpoints; a preset means "follow schedule"; services only override |
| `tado` | HVAC mode `auto` = smart schedule; timer services; no editing |
| `homematicip_cloud` | hub profiles appear as presets; `set_active_climate_profile` picks one by index |
| `netatmo` | a `select` entity and `set_schedule` choose a named schedule made in the vendor app |
| `plugwise` | a `select` chooses the schedule; HVAC `auto` turns it on |
| `fritzbox` | sensors for the scheduled preset only |
| `eq3btsmart`, `tuya`, `zha` | nothing; ZHA offers only the raw cluster-command action |
| `eurotronic_cometblue` | entity actions `get_schedule` (response, read from the valve) and `set_schedule` (per day, up to four from/to ranges) write straight to the valve |
| `bsblan` | `set_heating_schedule`, `set_hot_water_schedule` actions |

- In every case the device or hub is the owner. Home Assistant keeps no copy, and there is no conflict handling. Most only *select* a schedule; two write one through actions; none has an editor.
- Core declined a generic device-schedule entity because vendor schedule models differ too much. [V] `A/876`
- Write confirmation, restore on removal and external temperature feeds (questions 8–10) were not examined.

### Quality-scale rules

- `config-flow`: "store all configuration in `ConfigEntry.data`", non-connection settings in `ConfigEntry.options`. [V] `D/docs/core/integration-quality-scale/rules/config-flow`
- `reconfiguration-flow`: change settings without removing and re-adding. `stale-devices`: remove devices that are surely gone, else implement `async_remove_config_entry_device`. `dynamic-devices`: add new devices automatically. `repair-issues`: only actionable issues; a repair flow may forward to a subentry reconfigure flow. [V] same folder, `D/docs/core/platform/repairs`
- No rule mentions subentries or `.storage`. [V, searched]

## 2. Comparison table

| Pattern | Items stored in | Schedules or documents stored in | Edited through | Panel or card transport |
|---|---|---|---|---|
| Subentry integrations | subentries in `core.config_entries` | — | subentry flow forms | stock flow API; data not listed |
| `schedule` helper | — | `.storage/schedule` collection | graphical week grid | generated `schedule/*` websocket |
| Old helpers, zones, persons | own collection | — | frontend forms | generated websocket |
| Newer helpers | one config entry each | — | config and options flow | stock flow API |
| Lovelace, energy | collection index | one `Store` document each | custom editors | bespoke websocket, whole-document save |
| KNX | entry + own `Store` | — | custom panel | bespoke admin websocket, `panel_custom` |
| Climate integrations | config entry | device or hub | vendor app; selects; two with actions | none |

## 3. Patterns

- Things that are **devices or entity groups under a shared connection** go into config entries and, since 2025, subentries. Their data is flat and small, and forms edit it.
- Things a user **draws or composes in a purpose-built editor** (schedules, dashboards, energy setup, KNX entities) go into the feature's own versioned `Store` behind bespoke websocket commands. None is a subentry.
- Outlier: MQTT nests many entities in one subentry and pays with a very large menu flow.
- Outlier: KNX keeps entities outside config entries, in a store its panel edits. Its reason is not stated in the source; the store may simply predate subentries. [U]
- Device-owned schedules are never mirrored into Home Assistant storage by core.

## 4. Lessons for a new integration

- **Do** model rooms as subentries of one config entry, with a device per room tagged with the subentry id. Evidence: `satel_integra`, `ness_alarm`, `rfxtrx`, `mqtt`.
- **Do** keep room data flat (name, member entity ids, scalar settings). Evidence: all users but MQTT.
- **Don't** add your entry to the valves' devices; store their ids and link. Evidence: the 2026.8 device-registry rule.
- **Do** plan for whole-entry reloads on any room change, or diff as `forecast_solar` does. Evidence: no per-subentry listener.
- **Do** put the schedule library in your own `Store` with major and minor versions and a migration function. Evidence: `schedule`, Lovelace, energy, KNX.
- **Do** serve the editor with your own admin-only websocket commands; reuse the helper's `{day: [{from, to, data}]}` shape. Evidence: `F/data/schedule.ts`, `eurotronic_cometblue`.
- **Don't** depend on `helpers.collection` as a contract; copy its command shape over `Store`. Evidence: absent from the developer docs.
- **Don't** put schedules in subentries: their data is not served to the frontend and forms are the only editor.
- **Do** expose `get_schedule` and `set_schedule` entity actions for the on-valve programme. Evidence: `eurotronic_cometblue`, `bsblan`.
- **Do** register a later panel with `panel_custom` as KNX does.

## 5. Plain answer

- **(a) Rooms** belong in **config subentries of a single config entry**, one subentry per room, each owning one room device and its entities, with the valves referenced by id. Confidence: **fairly high**. It matches the documented purpose and five or more core integrations. The remaining doubt is that a later custom panel cannot read or edit subentry data through stock commands (KNX, which has a panel, uses its own store); one config entry per room is the other conventional shape.
- **(b) The shared schedule library** belongs in **the integration's own versioned `.storage` file**, edited over the integration's own websocket commands. Confidence: **high**. Every graphically edited document in core is stored this way, none is a subentry, and the architecture discussion scopes subentries away from this kind of content.
