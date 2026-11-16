import type {
  Evidence,
  Liveness,
  Membership,
  ProblemKind,
  SettingKey,
  Severity,
  SyncState,
  ValveMode,
} from "@heatmaster/core";

/** The texts that must exist for every member of a fixed set; the compiler refuses a missing one. */
type CodedKey =
  | `problem.${ProblemKind}`
  | `sync.${SyncState}`
  | `membership.${Membership}`
  | `liveness.${Liveness}`
  | `mode.${ValveMode}`
  | `severity.${Severity}`
  | `setting.${SettingKey}`
  | `evidence.${Evidence}`;

type ErrorCode =
  | "config_unreadable"
  | "revision_conflict"
  | "timezone_missing"
  | "ha_link_missing"
  | "sensor_unknown"
  | "sensor_not_temperature"
  | "sensor_on_valve"
  | "valve_unknown"
  | "valve_unsupported"
  | "ledger_unreadable"
  | "transport_unusable"
  | "valve_not_observed"
  | "originals_unreadable"
  | "valve_not_orphan"
  | "valve_managed"
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
  | "device_unknown"
  | "mqtt_not_connected"
  | "mqtt_timeout"
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

  "group.schedule": "schedule",
  "group.active_group": "active schedule group",
  "group.sensor_source": "temperature sensor source",

  "rooms.title": "Rooms",
  "rooms.none": "No rooms are configured yet.",
  "rooms.temperature": "Temperature",
  "rooms.target": "Target",
  "rooms.sync": "Sync",
  "rooms.degraded": "Degraded: the room has no working temperature sensor",
  "rooms.diverged": "Diverged: the valves do not agree",
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

  "others.title": "Other valves",
  "others.none": "No valves outside rooms.",
  "others.hint": "Copy a valve id into a room of the configuration to add the valve.",
  "others.not_reported": "The valve has not reported yet.",
  "others.reported": "Reported values",

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
  "editor.accept": "Accept unreadable originals of {name}",
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
  "plan.rejoining": "Valves that rejoin a room",
  "plan.leaving": "Valves that leave their room",
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
  "membership.not_adopted": "not adopted",
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

  "evidence.acked": "confirmed by the valve",
  "evidence.echoed": "as Zigbee2MQTT reported it",
  "evidence.none": "cannot be checked",

  "problem.config_unreadable":
    "The Heatmaster configuration cannot be read. Valves are left as they are",
  "problem.ledger_unreadable":
    "The saved original valve settings cannot be read. Valves are left as they are",
  "problem.transport_unusable": "Heatmaster cannot use {transport}: {reason}",
  "problem.link_down": "The connection to {name} is down",
  "problem.valve_not_adopted":
    "Valve {name} is in a room but its original settings were never saved",
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
  "problem.valve_not_auto":
    "Valve {name} is in {mode} mode and is not following its schedule. Heatmaster does not change the mode",
  "problem.store_write_failed":
    "Heatmaster could not save {store}. Check the disk; writes to valves may be stopped until the save works",

  "error.config_unreadable": "The configuration cannot be read, so it cannot be changed.",
  "error.revision_conflict":
    "The configuration was changed by someone else: you edited revision {expected}, the server has revision {current}. Reload and make your changes again.",
  "error.timezone_missing":
    "The time zone is not known. Set timezone in the settings of the configuration: there is no Home Assistant link to give the house's time zone.",
  "error.ha_link_missing": "Sensor {sensor} needs the Home Assistant link, and none is set up.",
  "error.sensor_unknown": "Sensor {sensor} does not exist in Home Assistant.",
  "error.sensor_not_temperature": "{sensor} is not a temperature sensor.",
  "error.sensor_on_valve": "{sensor} belongs to a valve and cannot be a room sensor.",
  "error.valve_unknown": "Valve {valveId} is not known to Heatmaster.",
  "error.valve_unsupported": "Valve {valveId} is not a supported model.",
  "error.ledger_unreadable":
    "The saved original valve settings cannot be read, so valves cannot be added.",
  "error.transport_unusable": "Valve {valveId} cannot be reached through {transport} now.",
  "error.valve_not_observed":
    "Valves {valveIds} have not reported yet. They were asked to report; try again shortly.",
  "error.originals_unreadable":
    "The original settings of valve {valveId} could not be read ({settings}). To add the valve anyway, accept this below and preview again.",
  "error.valve_not_orphan": "Valve {valveId} is not an orphan.",
  "error.valve_managed": "Valve {valveId} is in a room. Take it out of the configuration first.",
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
  "error.config_missing": "There is no configuration yet.",
  "error.ask_limited": "Valve {valveId} was asked a moment ago. Try again in a minute.",
  "error.not_started": "Heatmaster has not finished starting.",
  "error.store_locked": "Another process holds the Heatmaster files. Stop the other instance.",
  "error.no_originals_copy": "There is no readable copy of the saved original settings.",
  "error.ledger_readable":
    "The saved original settings can be read, so there is nothing to import.",
  "error.device_unknown": "Device {deviceId} is not known.",
  "error.mqtt_not_connected": "Heatmaster is not connected to the MQTT broker.",
  "error.mqtt_timeout": "The MQTT broker did not answer in time.",
  "error.network": "Heatmaster cannot be reached.",
  "error.http": "The server answered with status {status}, not with a Heatmaster answer.",
} as const satisfies Required & Readonly<Record<string, string>>;
