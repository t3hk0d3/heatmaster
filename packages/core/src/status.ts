import { activePoint } from "./schedule.ts";
import type { Membership } from "./ledger.ts";
import type { Room } from "./model.ts";
import type { Liveness } from "./observation.ts";
import type { ResolvedWeek } from "./schedule.ts";
import type { Group, ValveMode } from "./settings.ts";
import type { Freshness, RoomTemperature } from "./temperature.ts";

export type SubjectKind = "system" | "room" | "valve" | "sensor";
export type Subject = Readonly<{ kind: SubjectKind; id: string }>;

/** `critical` is reserved for a later plan; no plan-1 problem uses it. */
export type Severity = "warning" | "error" | "critical";

export type ProblemKind =
  | "config_unreadable"
  | "ledger_unreadable"
  | "link_down"
  | "transport_unusable"
  | "valve_not_adopted"
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
  | "valve_not_auto"
  | "store_write_failed"
  | "tick_failed";

export type Problem = Readonly<{
  kind: ProblemKind;
  subject: Subject;
  severity: Severity;
  data: Readonly<Record<string, string>>;
}>;

export type SyncState = "in_sync" | "pending" | "not_holding" | "unverified" | "held" | "frozen";

/** `mode`, `setpoint`, `running` and `battery` are readings; `target` is the schedule's now. */
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

/** `nextChangeAt` is an instant in epoch milliseconds. */
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
  diverged: boolean;
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
  if (membership === "frozen" || membership === "not_adopted" || membership === "orphan")
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

function roomMode(valves: readonly ValveStatus[]): ValveMode | undefined {
  const shown = valves.flatMap((v) => (v.mode === undefined ? [] : [v.mode]));
  if (shown.length === 0) return undefined;
  return shown.every((m) => m === "off") ? "off" : "auto";
}

function roomHeating(valves: readonly ValveStatus[]): boolean | undefined {
  if (valves.some((v) => v.running === true)) return true;
  return valves.some((v) => v.running === false) ? false : undefined;
}

export function roomStatus(
  room: Room,
  week: ResolvedWeek,
  temperature: RoomTemperature,
  fresh: Freshness,
  valves: readonly ValveStatus[],
  now: Temporal.ZonedDateTime,
): RoomStatus {
  const point = activePoint(week, now);
  return {
    roomId: room.id,
    currentTemperature: temperature.value,
    target: point.temperature,
    nextChangeAt: point.nextChangeAt,
    nextTarget: point.nextTemperature,
    mode: roomMode(valves),
    heating: roomHeating(valves),
    sync: worstSync(valves),
    degraded: fresh === "stale" || fresh === "no_sensors",
    diverged: valves.some((v) => v.mode !== undefined && v.mode !== "auto"),
    valves,
  };
}

/** `<kind>:<subject kind>:<subject id>`, plus the group or the store where one subject has many. */
export function problemId(problem: Problem): string {
  const base = `${problem.kind}:${problem.subject.kind}:${problem.subject.id}`;
  if (problem.kind === "setting_not_holding") return `${base}:${problem.data.setting ?? ""}`;
  if (problem.kind === "store_write_failed") return `${base}:${problem.data.store ?? ""}`;
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

export function problemValveNotAdopted(valveId: string): Problem {
  return problem("valve_not_adopted", "valve", valveId, "error");
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

export function problemValveNotAuto(valveId: string, mode: ValveMode): Problem {
  return problem("valve_not_auto", "valve", valveId, "warning", { mode });
}

/** Raised by the runtime, never by `tick`. `store` is `config`, `ledger` or `copy`. */
export function problemStoreWriteFailed(store: string): Problem {
  return problem("store_write_failed", "system", SYSTEM_ID, "error", { store });
}

/** Raised by the runtime, never by `tick`: the last tick threw, so nothing is being decided. */
export function problemTickFailed(): Problem {
  return problem("tick_failed", "system", SYSTEM_ID, "error");
}
