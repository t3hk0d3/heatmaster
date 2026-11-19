import { activePoint } from "./schedule.ts";
import type { Pending } from "./join.ts";
import type { LabelOp } from "./labels.ts";
import type { Membership } from "./ledger.ts";
import type { EndRule, Room } from "./model.ts";
import type { Liveness } from "./observation.ts";
import type { ResolvedWeek } from "./schedule.ts";
import type { Group, ValveMode } from "./settings.ts";
import type { Freshness, RoomTemperature } from "./temperature.ts";
import type { RoomLimits, Thermostat } from "./thermostat.ts";

/** `area` is a Home Assistant area by its id; `label` is a Home Assistant label by its id. */
export type SubjectKind = "system" | "room" | "valve" | "sensor" | "area" | "label";
export type Subject = Readonly<{ kind: SubjectKind; id: string }>;

/** `critical` is reserved for a later plan; no plan-1 problem uses it. */
export type Severity = "warning" | "error" | "critical";

export type ProblemKind =
  | "config_unreadable"
  | "ledger_unreadable"
  | "pacing_unreadable"
  | "link_down"
  | "transport_unusable"
  | "ha_link_required"
  | "rooms_frozen"
  | "no_schedule"
  | "valve_pending"
  | "valve_not_in_ha"
  | "valve_orphan"
  | "valve_unsupported"
  | "valve_silent"
  | "setting_not_holding"
  | "release_stalled"
  | "schedule_clamped"
  | "room_no_temperature"
  | "sensor_stale"
  | "sensor_out_of_range"
  | "sensor_liveness_unobservable"
  | "feed_lost"
  | "state_unreadable"
  | "store_write_failed"
  | "tick_failed"
  | "sensor_label_unused"
  | "legacy_label_present"
  | "label_foreign"
  | "entry_unavailable"
  | "ha_label_failed"
  | "sensor_unlabellable";

export type Problem = Readonly<{
  kind: ProblemKind;
  subject: Subject;
  severity: Severity;
  data: Readonly<Record<string, string>>;
}>;

export type SyncState = "in_sync" | "pending" | "not_holding" | "unverified" | "held" | "frozen";

/**
 * `mode`, `setpoint`, `running` and `battery` are readings; `target` is the setpoint the valve is
 * wanted at, or its schedule's value now while it is wanted in `auto` without one.
 */
export type ValveStatus = Readonly<{
  valveId: string;
  name: string;
  membership: Membership;
  liveness: Liveness;
  mode: ValveMode | undefined;
  setpoint: number | undefined;
  target: number | undefined;
  running: boolean | undefined;
  sync: SyncState;
  battery: number | undefined;
}>;

/**
 * `nextChangeAt` is an instant in epoch milliseconds. `thermostat` undefined: the state file is
 * unreadable. `target` is the override's target, the schedule's value now on the schedule and
 * while the state is unreadable, and undefined when the room is off. `mode` is the thermostat's
 * (R15), or the valves' while the state is unreadable. `limits` undefined: no managed valve has a
 * spec. `overrideEnd` and `overrideDurationMs` are the room's end settings.
 */
export type RoomStatus = Readonly<{
  roomId: string;
  currentTemperature: number | undefined;
  target: number | undefined;
  nextChangeAt: number | undefined;
  nextTarget: number | undefined;
  mode: ValveMode | undefined;
  heating: boolean | undefined;
  sync: SyncState;
  degraded: boolean;
  thermostat: Thermostat | undefined;
  limits: RoomLimits | undefined;
  overrideEnd: EndRule;
  overrideDurationMs: number;
  valves: readonly ValveStatus[];
}>;

/** The subject id of system problems, except `transport_unusable` and `link_down`. */
export const SYSTEM_ID = "heatmaster";

/** Worst first. */
const SYNC_ORDER: readonly SyncState[] = [
  "frozen",
  "not_holding",
  "held",
  "unverified",
  "pending",
  "in_sync",
];

/** The first matching rule wins. The caller decides `verified` and `pending`. */
export function valveSync(
  membership: Membership,
  held: boolean,
  verified: boolean,
  pending: boolean,
  notHolding: boolean,
): SyncState {
  if (membership === "frozen" || membership === "pending" || membership === "orphan")
    return "frozen";
  if (held) return "held";
  if (!verified) return "unverified";
  if (notHolding) return "not_holding";
  if (pending) return "pending";
  return "in_sync";
}

function worstSync(valves: readonly ValveStatus[]): SyncState {
  if (valves.length === 0) return "unverified";
  const rank = (s: SyncState): number => SYNC_ORDER.indexOf(s);
  return valves.reduce<SyncState>(
    (worst, v) => (rank(v.sync) < rank(worst) ? v.sync : worst),
    "in_sync",
  );
}

/** The mode a room's state puts its valves in. */
const THERMOSTAT_MODE: Readonly<Record<Thermostat["kind"], ValveMode>> = {
  schedule: "auto",
  override: "heat",
  off: "off",
};

/** The valves' mode: `off` when every valve that shows one is off, otherwise `auto`. */
function valvesMode(valves: readonly ValveStatus[]): ValveMode | undefined {
  const shown = valves.flatMap((v) => (v.mode === undefined ? [] : [v.mode]));
  if (shown.length === 0) return undefined;
  return shown.every((m) => m === "off") ? "off" : "auto";
}

function roomHeating(valves: readonly ValveStatus[]): boolean | undefined {
  if (valves.some((v) => v.running === true)) return true;
  return valves.some((v) => v.running === false) ? false : undefined;
}

/** `thermostat` undefined: the state file is unreadable. */
export function roomStatus(
  room: Room,
  week: ResolvedWeek,
  temperature: RoomTemperature,
  fresh: Freshness,
  valves: readonly ValveStatus[],
  now: Temporal.ZonedDateTime,
  thermostat: Thermostat | undefined,
  limits: RoomLimits | undefined,
): RoomStatus {
  const point = activePoint(week, now);
  let target: number | undefined = point.temperature;
  if (thermostat?.kind === "override") target = thermostat.target;
  if (thermostat?.kind === "off") target = undefined;
  return {
    roomId: room.id,
    currentTemperature: temperature.value,
    target,
    nextChangeAt: point.nextChangeAt,
    nextTarget: point.nextTemperature,
    mode: thermostat === undefined ? valvesMode(valves) : THERMOSTAT_MODE[thermostat.kind],
    heating: roomHeating(valves),
    sync: worstSync(valves),
    degraded: fresh === "stale" || fresh === "no_sensors",
    thermostat,
    limits,
    overrideEnd: room.overrideEnd,
    overrideDurationMs: room.overrideDurationMs,
    valves,
  };
}

/**
 * `<kind>:<subject kind>:<subject id>`, plus the group, the store or the label op where one subject
 * has many.
 */
export function problemId(problem: Problem): string {
  const base = `${problem.kind}:${problem.subject.kind}:${problem.subject.id}`;
  if (problem.kind === "setting_not_holding") return `${base}:${problem.data.setting ?? ""}`;
  if (problem.kind === "store_write_failed") return `${base}:${problem.data.store ?? ""}`;
  if (problem.kind === "ha_label_failed") return `${base}:${problem.data.op ?? ""}`;
  return base;
}

function problem(
  kind: ProblemKind,
  subjectKind: SubjectKind,
  id: string,
  severity: Severity,
  data: Readonly<Record<string, string>> = {},
): Problem {
  return { kind, subject: { kind: subjectKind, id }, severity, data };
}

export function problemConfigUnreadable(): Problem {
  return problem("config_unreadable", "system", SYSTEM_ID, "error");
}

export function problemLedgerUnreadable(): Problem {
  return problem("ledger_unreadable", "system", SYSTEM_ID, "error");
}

export function problemLinkDown(link: string): Problem {
  return problem("link_down", "system", link, "error", { link });
}

/** A second Heatmaster instance is the reason `another_instance`. */
export function problemTransportUnusable(transport: string, reason: string): Problem {
  return problem("transport_unusable", "system", transport, "error", { transport, reason });
}

/** No Home Assistant link is configured, so no room is managed. */
export function problemHaLinkRequired(): Problem {
  return problem("ha_link_required", "system", SYSTEM_ID, "error");
}

/** Rooms are frozen on the saved membership: nothing joins or releases. */
export function problemRoomsFrozen(reason: "not_loaded" | "link_down"): Problem {
  return problem("rooms_frozen", "system", SYSTEM_ID, "warning", { reason });
}

/** The config has no schedule while Home Assistant has a room: nothing joins or releases. */
export function problemNoSchedule(): Problem {
  return problem("no_schedule", "system", SYSTEM_ID, "warning");
}

/** `settings` lists the unreadable setting keys, comma separated (empty for other reasons). */
export function problemValvePending(pending: Pending): Problem {
  return problem("valve_pending", "valve", pending.valveId, "warning", {
    reason: pending.reason,
    roomId: pending.roomId,
    settings: pending.unreadable.join(","),
  });
}

/** Home Assistant has no device for the valve; it is kept in its previous room. */
export function problemValveNotInHa(valveId: string): Problem {
  return problem("valve_not_in_ha", "valve", valveId, "warning");
}

export function problemValveOrphan(valveId: string): Problem {
  return problem("valve_orphan", "valve", valveId, "warning");
}

export function problemValveUnsupported(valveId: string): Problem {
  return problem("valve_unsupported", "valve", valveId, "error");
}

export function problemValveSilent(valveId: string): Problem {
  return problem("valve_silent", "valve", valveId, "error");
}

export function problemSettingNotHolding(valveId: string, group: Group): Problem {
  return problem("setting_not_holding", "valve", valveId, "error", { setting: group });
}

export function problemReleaseStalled(valveId: string): Problem {
  return problem("release_stalled", "valve", valveId, "warning");
}

/** `min` and `max` are written without trailing zeros. */
export function problemScheduleClamped(valveId: string, minTemp: number, maxTemp: number): Problem {
  return problem("schedule_clamped", "valve", valveId, "warning", {
    min: String(minTemp),
    max: String(maxTemp),
  });
}

export function problemRoomNoTemperature(roomId: string): Problem {
  return problem("room_no_temperature", "room", roomId, "warning");
}

export function problemSensorStale(sensorId: string): Problem {
  return problem("sensor_stale", "sensor", sensorId, "warning");
}

export function problemSensorOutOfRange(sensorId: string): Problem {
  return problem("sensor_out_of_range", "sensor", sensorId, "warning");
}

export function problemSensorLivenessUnobservable(sensorId: string): Problem {
  return problem("sensor_liveness_unobservable", "sensor", sensorId, "warning");
}

export function problemFeedLost(valveId: string): Problem {
  return problem("feed_lost", "valve", valveId, "warning");
}

/** The state file could not be read: no mode or setpoint is written (R10). */
export function problemStateUnreadable(): Problem {
  return problem("state_unreadable", "system", SYSTEM_ID, "error");
}

/** Raised by the runtime, never by `tick`: the saved write budget could not be read. */
export function problemPacingUnreadable(): Problem {
  return problem("pacing_unreadable", "system", SYSTEM_ID, "warning");
}

/** Raised by the runtime, never by `tick`. `store` is `config`, `ledger`, `copy` or `pacing`. */
export function problemStoreWriteFailed(store: string): Problem {
  return problem("store_write_failed", "system", SYSTEM_ID, "error", { store });
}

/** Raised by the runtime, never by `tick`: the last tick threw, so nothing is being decided. */
export function problemTickFailed(): Problem {
  return problem("tick_failed", "system", SYSTEM_ID, "error");
}

/** The id of a Home Assistant sensor entity as a sensor subject: its ref, `ha:<entity id>`. */
function sensorSubject(entityId: string): string {
  return `ha:${entityId}`;
}

/**
 * An entity carries `heatmaster_temp_sensor` but no entry lists it, and it cannot be added: `reason`
 * is `no_area`, `area_not_room`, `entry_unavailable`, `sensor_unknown`, `sensor_not_temperature`,
 * `sensor_on_valve` or `sensor_limit`.
 */
export function problemSensorLabelUnused(entityId: string, reason: string): Problem {
  return problem("sensor_label_unused", "sensor", sensorSubject(entityId), "warning", { reason });
}

/** A room has sensors while entities in its area still carry `room_temperature_sensor`. */
export function problemLegacyLabelPresent(roomId: string, entityIds: readonly string[]): Problem {
  return problem("legacy_label_present", "room", roomId, "warning", {
    entities: entityIds.join(","),
  });
}

/**
 * An area with no config entry that cannot get one (the config holds `MAX_ROOMS` entries, or the
 * area id does not match `AREA_ID_PATTERN`) wears a label Heatmaster would have taken into one: a
 * schedule label of another schedule than the one it follows, or `room_temperature_sensor` on an
 * entity of a room (the sensor import left it out). `labels` lists them, comma separated.
 */
export function problemEntryUnavailable(areaId: string, labels: readonly string[]): Problem {
  return problem("entry_unavailable", "area", areaId, "warning", { labels: labels.join(",") });
}

/** A numbered schedule label (`heatmaster_schedule_<x>_<digits>`): Heatmaster never touches it. */
export function problemLabelForeign(labelId: string): Problem {
  return problem("label_foreign", "label", labelId, "warning");
}

/**
 * A label write failed. The subject is the area, the sensor or the label the op names (for
 * `createLabel`, the name asked for); `op` is the op's kind and `error` Home Assistant's code.
 */
export function problemHaLabelFailed(op: LabelOp, error: string): Problem {
  const data = { op: op.kind, error };
  switch (op.kind) {
    case "createLabel":
      return problem("ha_label_failed", "label", op.name, "warning", data);
    case "renameLabel":
    case "deleteLabel":
      return problem("ha_label_failed", "label", op.labelId, "warning", data);
    case "labelArea":
      return problem("ha_label_failed", "area", op.areaId, "warning", data);
    case "labelEntity":
      return problem("ha_label_failed", "sensor", sensorSubject(op.entityId), "warning", data);
  }
}

/** A configured sensor that Home Assistant has no registry entry for, so it cannot be labelled. */
export function problemSensorUnlabellable(entityId: string): Problem {
  return problem("sensor_unlabellable", "sensor", sensorSubject(entityId), "warning");
}
