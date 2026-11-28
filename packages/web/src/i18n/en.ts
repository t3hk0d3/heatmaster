import type {
  ChangeRefusedCode,
  DroppedRoomReason,
  Evidence,
  HaChangeKind,
  LabelOp,
  Liveness,
  Membership,
  PendingReason,
  ProblemKind,
  SettingKey,
  Severity,
  SyncState,
  UnplacedReason,
  ValveMode,
  WindowNote,
} from "@heatmaster/core";

/** Why a contact carries the Heatmaster label but is used by no room (`problemContactLabelUnused`). */
type ContactUnusedReason =
  | "no_area"
  | "area_not_room"
  | "entry_unavailable"
  | "contact_unknown"
  | "contact_not_binary"
  | "contact_limit";

/** Why a sensor carries the Heatmaster label but is used by no room (`problemSensorLabelUnused`). */
type SensorUnusedReason =
  | "no_area"
  | "area_not_room"
  | "entry_unavailable"
  | "sensor_unknown"
  | "sensor_not_temperature"
  | "sensor_on_valve"
  | "sensor_limit";

type FrozenReason = "not_loaded" | "link_down";

/** The kinds of label write a `ha_label_failed` problem names. */
type LabelOpKind = LabelOp["kind"];

/** The texts that must exist for every member of a fixed set; the compiler refuses a missing one. */
type CodedKey =
  | `problem.${ProblemKind}`
  | `problem.sensor_label_unused.${SensorUnusedReason}`
  | `problem.contact_label_unused.${ContactUnusedReason}`
  | `pending.reason.${PendingReason}`
  | `unassigned.reason.${UnplacedReason}`
  | `upgrade.dropped.${DroppedRoomReason}`
  | `ha_changes.item.${HaChangeKind}`
  | `frozen_reason.${FrozenReason}`
  | `label_op.${LabelOpKind}`
  | `sync.${SyncState}`
  | `membership.${Membership}`
  | `liveness.${Liveness}`
  | `mode.${ValveMode}`
  | `severity.${Severity}`
  | `setting.${SettingKey}`
  | `evidence.${Evidence}`
  | `room.window.note.${WindowNote}`;

type ErrorCode =
  | ChangeRefusedCode
  // Raised by the server's own ask (refresh), not by a config change.
  | "transport_unusable"
  | "not_ready"
  | "mqtt_fault"
  | "body_invalid"
  | "config_or_yaml"
  | "yaml_invalid"
  | "config_invalid"
  | "body_too_large"
  | "not_found"
  | "internal"
  | "room_unknown"
  | "config_missing"
  | "ask_limited"
  | "not_started"
  | "store_locked"
  | "no_originals_copy"
  | "ledger_readable"
  | "state_readable"
  | "device_unknown"
  | "mqtt_not_connected"
  | "mqtt_timeout"
  | "mqtt_refused"
  | "topic_invalid"
  | "io_failed"
  | "network"
  | "http";

type Required = Readonly<Record<CodedKey | `error.${ErrorCode}`, string>>;

export const en = {
  "app.title": "Heatmaster",
  "app.loading": "Waiting for the first state from Heatmaster…",
  unknown: "—",

  "header.links": "Links",
  "header.up": "up",
  "header.down": "down",
  "header.status.connecting": "Connecting to Heatmaster…",
  "header.status.live": "Connected to Heatmaster",
  "header.status.lost": "The connection to Heatmaster is lost. Trying again…",
  "header.held": "Writes to valves are stopped",
  "header.not_held": "Heatmaster is writing to valves",
  "header.stop": "Stop writing",
  "header.release": "Release writes",
  "header.release_question":
    "Release writes? Heatmaster will write to the valves again, and can change their settings.",
  "header.revision": "Configuration revision {revision}",
  "header.diagnostics": "Diagnostics",
  "header.language": "Language",
  "header.language_en": "English",
  "header.language_ru": "Русский",

  "link.z2m": "Zigbee2MQTT",
  "link.ha": "Home Assistant",

  "reason.mqtt_unavailable": "the MQTT broker cannot be reached",
  "reason.mqtt_auth_failed": "the MQTT broker refused the login",
  "reason.bridge_unknown": "Zigbee2MQTT has not announced itself",
  "reason.version_unsupported": "this Zigbee2MQTT version is not supported",
  "reason.last_seen_disabled": "the last_seen option of Zigbee2MQTT is off",
  "reason.another_instance": "another Heatmaster is running",

  "store.config": "the configuration",
  "store.ledger": "the saved original valve settings",
  "store.copy": "the readable copy of the saved original settings",
  "store.state": "the saved room states",

  "group.schedule": "schedule",
  "group.active_group": "active schedule group",
  "group.sensor_source": "temperature sensor source",
  "group.frost_protection": "frost protection temperature",
  "group.thermostat": "mode and target temperature",
  "group.open_window": "open window detection",

  "rooms.title": "Rooms",
  "rooms.none": "No Home Assistant area holds a valve yet, so there are no rooms.",
  "rooms.unknown": "Rooms come from Home Assistant's areas, so they are not known without it.",
  "room.schedule": "Schedule: {name}",
  "room.state.schedule": "Following the schedule",
  "room.state.override": "Set to {target} until {end}",
  "room.state.off": "Off until {end}",
  "room.window.open": "Window open since {since}",
  "room.window.open_contacts": "Window open since {since} ({contacts})",
  "room.window.open_temperature": "Window: temperature falling since {since}",
  "room.window.heat": "Window open, heating resumed after {limit}",
  "room.window.stay": "Window open, freeze protection kept after {limit}",
  "room.window.heat_bare": "Window open, heating resumed after the time limit",
  "room.window.stay_bare": "Window open, freeze protection kept after the time limit",
  "room.window.suspended": "Window open, heating on by request",
  "room.window.dropped": "Window open: the change at the valve was dropped",
  "room.window.note.knob_does_nothing":
    "The valves are off for the window, and a TRVZB's knob does nothing while it is off",
  "room.window.note.command_waits":
    "The room's change is kept, and its valves stay in open-window mode until the window closes",
  "room.window.hours": "{n} h",
  "room.window.minutes": "{n} min",
  "room.state.origin": "Changed on {origin}",
  "room.end.next_change": "the next schedule change",
  "room.end.manual": "you cancel",
  "room.origin.climate": "Home Assistant",
  "room.origin.api": "this page",
  "room.resume": "Resume schedule",
  "room.reset": "Start over",
  "room.reset_confirm":
    "Start over? The saved room states are dropped and every room goes back to its schedule.",
  "room.no_schedule": "No schedule",
  "room.not_managed": "Not managed",
  "room.not_managed_hint":
    "Heatmaster writes nothing to the valves of this room. It starts once the configuration is saved and Home Assistant is linked.",
  "room.not_managed_hint.unlinked":
    "Heatmaster writes nothing to the valves of this room. It starts once Home Assistant is linked (HA_URL and HA_TOKEN).",
  "room.not_managed_hint.no_config":
    "Heatmaster writes nothing to the valves of this room. It starts once a configuration is applied.",
  "room.not_managed_hint.no_schedule":
    "Heatmaster writes nothing to the valves of this room. It starts once the configuration has a schedule.",
  "rooms.temperature": "Temperature",
  "rooms.target": "Target",
  "rooms.sync": "Sync",
  "rooms.degraded": "Degraded: the room has no working temperature sensor",
  "rooms.valves": "Valves",
  "rooms.no_valves": "The room has no valves.",

  "valve.id": "Id",
  "valve.membership": "Membership",
  "valve.liveness": "Liveness",
  "valve.sync": "Sync",
  "valve.battery": "Battery {percent} %",
  "valve.refresh": "Ask to report",
  "valve.restore": "Restore original settings",
  "valve.forget": "Forget",
  "valve.forget_question":
    "Forget valve {name}? Its saved original settings are deleted and cannot be brought back.",
  "valve.not_supported": "Not supported",
  "valve.stranded":
    "Neither Home Assistant nor Zigbee2MQTT has this valve any more. If it was removed, forget it.",

  "others.title": "Other valves",
  "others.none": "No valves outside rooms.",
  "others.hint":
    "These valves are in no room. Put a valve's device into an area in Home Assistant to give it a room.",
  "others.hint_without_ha": "These valves are in no room.",
  "others.not_reported": "The valve has not reported yet.",
  "others.reported": "Reported values",

  "house.frozen.not_loaded":
    "Rooms are frozen on the last saved areas: Home Assistant has not been loaded yet. Valves keep following their schedules, but no valve joins or leaves a room.",
  "house.frozen.link_down":
    "Rooms are frozen on the last saved areas: the connection to Home Assistant is down. Valves keep following their schedules, but no valve joins or leaves a room.",
  "house.unlinked":
    "No Home Assistant link is set up (HA_URL and HA_TOKEN), so Heatmaster manages no room.",
  "frozen_reason.not_loaded": "Home Assistant has not been loaded yet",
  "frozen_reason.link_down": "the connection to Home Assistant is down",

  "config_unreadable.title": "The saved configuration cannot be read",
  "config_unreadable.why":
    "Heatmaster manages no room and leaves every valve as it is. After a conversion from an older version this happens when the configuration breaks a rule of the new format, for example when two schedule ids give the same Home Assistant label (label_id_duplicate), or when a schedule id ends in a dash or underscore and digits (schedule_id_reserved). The file config.json in Heatmaster's data directory has not been changed.",
  "config_unreadable.recover":
    "To recover, write a valid configuration in the editor below, tick “Overwrite the unreadable configuration” and press Apply. The old file is kept beside the new one as config.unreadable.<time>.json. Or correct config.json by hand and restart Heatmaster.",

  "pending.title": "Valves waiting to join a room",
  "pending.hint":
    "Each of these valves is in a room, but Heatmaster has not taken it over yet. It tries again at least every 30 seconds, and as soon as the valve reports. A valve whose original settings cannot be read waits until you accept them.",
  "pending.item": "{name} → room {room}",
  "pending.unreadable": "Settings that could not be read: {settings}",
  "pending.reason.house_frozen": "rooms are frozen until Home Assistant is back",
  "pending.reason.ledger_unreadable": "the saved original valve settings cannot be read",
  "pending.reason.transport_unusable": "the valve cannot be reached now",
  "pending.reason.valve_not_observed": "the valve has not reported its settings yet",
  "pending.reason.originals_unreadable":
    "some of the valve's current settings cannot be read, so they cannot be saved as its originals",
  "pending.accept": "Accept unknown originals",
  "pending.accept_question":
    "Accept unknown original settings for valve {name}? Heatmaster will take it over without knowing some of its original settings, and cannot give those back when the valve leaves.",

  "unused.title": "Unused configuration entries",
  "unused.hint": "Kept for when the area gets a valve.",

  "ha_changes.title": "Changed in Home Assistant",
  "ha_changes.hint":
    "These configuration revisions came from Home Assistant: label changes, and the sensor import from room_temperature_sensor. Newest first.",
  "ha_changes.revision": "Revision {revision}, {time}",
  "ha_changes.item.schedule": "Schedule of {area}: {schedule}",
  "ha_changes.item.sensor_added": "Sensor {entity} added to {area}",
  "ha_changes.item.sensor_removed": "Sensor {entity} removed from {area}",
  "ha_changes.item.sensors_imported":
    "Sensors of {area} imported from the room_temperature_sensor label",
  "ha_changes.item.contact_added": "Window contact {entity} added to {area}",
  "ha_changes.item.contact_removed": "Window contact {entity} removed from {area}",
  "ha_changes.item.override_end": "Override end in {area}",
  "ha_changes.item.window_setting": "Window setting {setting} in {area}: {value}",

  "upgrade.title": "Configuration converted",
  "upgrade.intro":
    "Your configuration was converted to the new format. Rooms now come from Home Assistant areas.",
  "upgrade.dropped_intro": "These old rooms could not be kept:",
  "upgrade.none_dropped": "Every old room was kept.",
  "upgrade.room": "{name} ({roomId}), valves {valves}: {reason}",
  "upgrade.no_valves": "none",
  "upgrade.dropped.no_area": "it names no Home Assistant area",
  "upgrade.dropped.area_duplicate": "its area is already used by another room",
  "upgrade.dropped.area_id_invalid": "its area id is not a valid Home Assistant area id",
  "upgrade.dismiss": "Dismiss",

  "unassigned.reason.no_area": "its device has no area in Home Assistant",
  "unassigned.reason.ignored_area": "its area carries the label heatmaster_ignore",
  "unassigned.reason.not_in_ha": "Home Assistant has no device for it",

  "plan.pending": "Valves that keep waiting",

  "problems.title": "Problems",
  "problems.none": "No problems.",

  "originals.found":
    "Saved original settings of {count} valves from an earlier installation were found. Import them before you add valves; originals you do not want can be forgotten afterwards",
  "originals.import": "Import saved originals",
  "originals.import_empty": "Start with an empty record",
  "originals.import_empty_question":
    "Start with an empty record of original settings? Valves that were returned to Heatmaster before will have no saved originals.",
  "originals.copy_records": "The saved copy holds {count} records.",
  "originals.no_copy": "There is no saved copy to import.",

  "editor.title": "Configuration (YAML)",
  "editor.preview": "Preview",
  "editor.apply": "Apply",
  "editor.reload": "Reload",
  "editor.overwrite": "Overwrite the unreadable configuration",
  "editor.dirty": "You have changes that are not applied.",
  "editor.server_changed":
    "The configuration changed on the server. Your text is kept; press Reload to replace it.",
  "editor.applied": "Applied as revision {revision}.",

  "plan.title": "Planned change",
  "plan.revision": "The configuration becomes revision {revision}.",
  "plan.joining": "Valves that join a room",
  "plan.original": "{setting}: {value} ({evidence})",
  "plan.unreadable": "{setting}: could not be read",
  "plan.writes": "Writes to valves",
  "plan.nothing": "Nothing will be written.",
  "plan.held": "Writes stay held after this change.",
  "plan.not_held": "After this change Heatmaster will write to the valves.",

  "sync.in_sync": "in sync",
  "sync.pending": "waiting for the valve",
  "sync.not_holding": "the valve does not keep it",
  "sync.unverified": "not checked yet",
  "sync.held": "held",
  "sync.frozen": "frozen",

  "membership.managed": "managed",
  "membership.pending": "waiting to join",
  "membership.releasing": "being returned",
  "membership.stray": "stray",
  "membership.orphan": "orphan",
  "membership.frozen": "frozen",

  "liveness.unknown": "unknown",
  "liveness.live": "alive",
  "liveness.silent": "silent",

  "mode.off": "off",
  "mode.auto": "auto",
  "mode.heat": "heat",

  "severity.warning": "Warning",
  "severity.error": "Error",
  "severity.critical": "Critical",

  "setting.day_mon": "Monday schedule",
  "setting.day_tue": "Tuesday schedule",
  "setting.day_wed": "Wednesday schedule",
  "setting.day_thu": "Thursday schedule",
  "setting.day_fri": "Friday schedule",
  "setting.day_sat": "Saturday schedule",
  "setting.day_sun": "Sunday schedule",
  "setting.active_group": "Active schedule group",
  "setting.sensor_source": "Temperature sensor source",
  "setting.frost_protection": "Frost protection temperature",
  "setting.system_mode": "Mode",
  "setting.setpoint": "Target temperature",
  "setting.open_window": "Open window detection",

  "evidence.acked": "confirmed by the valve",
  "evidence.echoed": "as Zigbee2MQTT reported it",
  "evidence.none": "cannot be checked",

  "problem.config_unreadable":
    "The Heatmaster configuration cannot be read. Valves are left as they are. The notice at the top of the page tells how to recover",
  "problem.ledger_unreadable":
    "The saved original valve settings cannot be read. Valves are left as they are",
  "problem.pacing_unreadable":
    "The saved record of how many writes each valve may still receive cannot be read. Heatmaster starts every valve with an empty budget and writes as it refills, one write per valve every 30 minutes",
  "problem.transport_unusable": "Heatmaster cannot use {transport}: {reason}",
  "problem.link_down": "The connection to {name} is down",
  "problem.valve_pending": "Valve {name} cannot join room {room} yet: {reason}",
  "problem.ha_link_required":
    "No Home Assistant link is set up (HA_URL and HA_TOKEN), so no room is managed",
  "problem.rooms_frozen": "Rooms are frozen on the last known Home Assistant areas: {reason}",
  "problem.no_schedule":
    "The configuration has no schedule, so no room is managed. Add a schedule to the configuration",
  "problem.valve_not_in_ha":
    "Home Assistant has no device for valve {name}; it stays in its previous room",
  "problem.valve_orphan": "Valve {name} is no longer in any room and was not given back",
  "problem.valve_unsupported": "Valve {name} is not a supported model",
  "problem.valve_silent": "Valve {name} is not responding",
  "problem.setting_not_holding": "Valve {name} does not keep its {setting}",
  "problem.release_stalled": "Valve {name} could not be returned to its original settings yet",
  "problem.schedule_clamped": "Valve {name} only allows {min}–{max} °C",
  "problem.room_no_temperature": "{name} has no working temperature sensor",
  "problem.sensor_stale": "Sensor {name} has stopped reporting",
  "problem.sensor_out_of_range": "Sensor {name} reports an implausible temperature",
  "problem.sensor_liveness_unobservable":
    "Heatmaster cannot tell whether sensor {name} is still alive",
  "problem.feed_lost": "Valve {name} is not receiving the room temperature",
  "problem.state_unreadable":
    "The saved room states cannot be read. Heatmaster writes no mode or setpoint to any valve until you start over",
  "problem.store_write_failed":
    "Heatmaster could not save {store}. Check the disk; writes to valves may be stopped until the save works",
  "problem.tick_failed":
    "Heatmaster failed inside while deciding what to send, so valves get no writes and no room temperature. See its log",
  "problem.sensor_label_unused":
    "Sensor {name} has the heatmaster_temp_sensor label, but no room uses it: {reason}",
  "problem.sensor_label_unused.no_area": "the sensor is in no area",
  "problem.sensor_label_unused.area_not_room": "its area holds no valve, so it is no room",
  "problem.sensor_label_unused.entry_unavailable":
    "its room cannot have an entry in the configuration (there are 64 entries already, or its area id is not one Heatmaster accepts)",
  "problem.sensor_label_unused.sensor_unknown": "Home Assistant does not know the sensor",
  "problem.sensor_label_unused.sensor_not_temperature": "it is not a temperature sensor",
  "problem.sensor_label_unused.sensor_on_valve": "it belongs to a valve",
  "problem.sensor_label_unused.sensor_limit": "the room already has the most sensors it can have",
  "problem.legacy_label_present":
    "{name} has Heatmaster sensors, but {entities} still carry room_temperature_sensor. Your own automation still feeds the room until you remove room_temperature_sensor from its sensors",
  "problem.entry_unavailable":
    "Area {name} cannot have an entry in the configuration (there are 64 entries already, or its area id is not one Heatmaster accepts), so Heatmaster does not take its labels {labels}",
  "problem.label_foreign":
    "The Home Assistant label {name} looks like a Heatmaster schedule label but is not one, so Heatmaster leaves it alone",
  "problem.ha_label_failed":
    "Heatmaster could not change labels in Home Assistant ({op}, {name}): {error}",
  "label_error.unauthorized":
    "the token's user is not an administrator of Home Assistant, and only an administrator may change labels",
  "label_error.timeout": "Home Assistant did not answer in time",
  "label_error.link_down": "the connection to Home Assistant dropped",
  "label_op.createLabel": "create a label",
  "label_op.renameLabel": "rename a label",
  "label_op.deleteLabel": "delete a label",
  "label_op.labelArea": "label an area",
  "label_op.labelEntity": "label a sensor",
  "problem.sensor_unlabellable":
    "Sensor {name} is in the configuration, but Home Assistant has no registry entry for it, so Heatmaster cannot label it",
  "problem.contact_label_unused":
    "Window contact {name} has the heatmaster_window_sensor label, but no room uses it: {reason}",
  "problem.contact_label_unused.no_area": "the contact is in no area",
  "problem.contact_label_unused.area_not_room": "its area holds no valve, so it is no room",
  "problem.contact_label_unused.entry_unavailable":
    "its room cannot have an entry in the configuration (there are 64 entries already, or its area id is not one Heatmaster accepts)",
  "problem.contact_label_unused.contact_unknown": "Home Assistant does not know the contact",
  "problem.contact_label_unused.contact_not_binary": "it is not a binary sensor",
  "problem.contact_label_unused.contact_limit":
    "the room already has the most window contacts it can have",
  "problem.contact_unavailable":
    "Window contact {name} has been unavailable for too long, so it no longer counts",
  "problem.window_open_too_long": "The window of {name} has been open longer than its limit",

  "error.config_unreadable":
    "The configuration cannot be read, so it cannot be changed. See the notice at the top of the page.",
  "error.revision_conflict":
    "The configuration was changed by someone else: you edited revision {expected}, the server has revision {current}. Reload and make your changes again.",
  "error.timezone_missing":
    "The time zone is not known. Set timezone in the settings of the configuration: there is no Home Assistant link to give the house's time zone.",
  "error.ha_link_missing": "Sensor {sensor} needs the Home Assistant link, and none is set up.",
  "error.ha_link_missing.contact":
    "Window contact {contact} needs the Home Assistant link, and none is set up.",
  "error.sensor_unknown": "Sensor {sensor} does not exist in Home Assistant.",
  "error.sensor_not_temperature": "{sensor} is not a temperature sensor.",
  "error.sensor_on_valve": "{sensor} belongs to a valve and cannot be a room sensor.",
  "error.contact_unknown": "Window contact {contact} does not exist in Home Assistant.",
  "error.contact_not_binary": "{contact} is not a binary sensor and cannot be a window contact.",
  "error.valve_unknown": "Valve {valveId} is not known to Heatmaster.",
  "error.valve_unsupported": "Valve {valveId} is not a supported model.",
  "error.ledger_unreadable":
    "The saved original valve settings cannot be read, so valves cannot be added.",
  "error.transport_unusable": "Valve {valveId} cannot be reached right now.",
  "error.valve_not_orphan": "Valve {valveId} is not an orphan.",
  "error.valve_managed": "Valve {valveId} is in a room. Take it out of the configuration first.",
  "error.valve_not_pending":
    "Valve {valveId} is not waiting for its unknown original settings to be accepted. It may have joined its room already.",
  "error.schedule_in_use":
    "The configuration needs at least one schedule while rooms exist, for example room {roomId}.",
  "error.not_ready": "Heatmaster is still starting. Try again in a moment.",
  "error.mqtt_fault": "The MQTT connection has a fault: {reason}.",
  "error.body_invalid": "The request is not valid.",
  "error.config_or_yaml": "A request holds either config or yaml, never both and never neither.",
  "error.yaml_invalid": "The YAML cannot be read.",
  "error.config_invalid": "The configuration has errors:",
  "error.body_too_large": "The request is too large.",
  "error.not_found": "There is nothing at that address.",
  "error.internal": "Heatmaster failed inside. See its log.",
  "error.room_unknown": "Room {roomId} does not exist.",
  "error.state_unreadable":
    "The saved room states cannot be read, so rooms cannot be changed. Start over to put every room back on its schedule.",
  "error.state_readable": "The saved room states can be read, so there is nothing to start over.",
  "error.schedule_unknown": "Schedule {scheduleId} does not exist.",
  "error.config_missing": "There is no configuration yet.",
  "error.ask_limited": "Valve {valveId} was asked a moment ago. Try again in a minute.",
  "error.not_started": "Heatmaster has not finished starting.",
  "error.store_locked":
    "A Heatmaster file could not be read when it was loaded, so Heatmaster will not overwrite it. For the original valve settings, press Import saved originals. For the configuration, write a valid one in the editor, tick Overwrite the unreadable configuration and apply it; the old file is kept beside it.",
  "error.no_originals_copy": "There is no readable copy of the saved original settings.",
  "error.ledger_readable":
    "The saved original settings can be read, so there is nothing to import.",
  "error.device_unknown": "Device {deviceId} is not known.",
  "error.mqtt_not_connected": "Heatmaster is not connected to the MQTT broker.",
  "error.mqtt_timeout": "The MQTT broker did not answer in time.",
  "error.mqtt_refused": "The MQTT broker refused the request (reason code {reasonCode}).",
  "error.topic_invalid": "The MQTT topic {topic} is not valid.",
  "error.io_failed": "Heatmaster could not read or write its files. Check the disk.",
  "error.network": "Heatmaster cannot be reached.",
  "error.http": "The server answered with status {status}, not with a Heatmaster answer.",
} as const satisfies Required & Readonly<Record<string, string>>;
