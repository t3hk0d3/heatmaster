import type { Room } from "./model.ts";
import { activePoint } from "./schedule.ts";
import type { ResolvedWeek } from "./schedule.ts";
import type { ValveSpec } from "./settings.ts";
import type { AdapterContext } from "./thermostat-adapter.ts";
import {
  SCHEDULE,
  SENT_RETIRE_MS,
  clampTarget,
  defaultEnd,
  endsAt,
  sameThermostat,
} from "./thermostat-rules.ts";
import type {
  RoomLimits,
  SavedWeek,
  SentWrite,
  Thermostat,
  ThermostatSeen,
  ThermostatState,
  ThermostatWanted,
  ValveExpectation,
} from "./thermostat.ts";

const SECOND_MS = 1000;

/**
 * One managed valve of a room as the tick judges it. `seen` is its current mode and setpoint
 * (undefined where never shown), `heardAt` when it last spoke, `ctx` what its adapter is told of
 * its week, and `week` its confirmed week as a key and values (undefined while unconfirmed).
 */
export type JudgedValve = Readonly<{
  valveId: string;
  spec: ValveSpec;
  seen: ThermostatSeen;
  heardAt: number | undefined;
  expectation: ValveExpectation | undefined;
  ctx: AdapterContext;
  week: SavedWeek | undefined;
}>;

/** A report no expected state explains; `before` is the valve's confirmed state before it. */
export type PersonChange = Readonly<{
  valveId: string;
  seen: ThermostatSeen;
  before: ThermostatWanted;
  heardAt: number | undefined;
}>;

/** One room's judging: `week` is the room's resolved week, for ends. */
export type AdoptInput = Readonly<{
  room: Room;
  thermostat: Thermostat;
  valves: readonly JudgedValve[];
  limits: RoomLimits;
  week: ResolvedWeek;
  now: Temporal.ZonedDateTime;
}>;

/** The room's thermostat and every judged valve's expectation after judging. */
export type Adoption = Readonly<{
  thermostat: Thermostat;
  expectations: ReadonlyMap<string, ValveExpectation>;
}>;

/** What a valve shows, as the state it is then expected at: never scheduled, no setpoint when off. */
export function asWanted(seen: ThermostatSeen): ThermostatWanted {
  if (seen.mode === undefined) throw new RangeError("a valve that shows no mode has no state");
  return {
    mode: seen.mode,
    setpoint: seen.mode === "off" ? undefined : seen.setpoint,
    scheduled: false,
  };
}

/** A state that follows the schedule in `auto`. */
export function scheduledAuto(wanted: ThermostatWanted): boolean {
  return wanted.mode === "auto" && wanted.scheduled;
}

/**
 * The state to confirm for `wanted`: a scheduled `auto` state takes the setpoint the valve shows
 * while no week values are known, so a value it holds is explained later (R4).
 */
export function recorded(wanted: ThermostatWanted, valve: JudgedValve): ThermostatWanted {
  if (scheduledAuto(wanted) && valve.ctx.weekValues === undefined) {
    return { ...wanted, setpoint: valve.seen.setpoint };
  }
  return wanted;
}

/** The week to save with `wanted`: the valve's confirmed week for a scheduled `auto` state (R23). */
export function savedWeek(
  wanted: ThermostatWanted,
  expectation: ValveExpectation,
  valve: JudgedValve,
): SavedWeek | undefined {
  return scheduledAuto(wanted) && valve.week !== undefined ? valve.week : expectation.week;
}

/**
 * The report shows the write in one key only (R4.5): the write's mode with any other setpoint
 * (a TRVZB shows its last manual setpoint until the setpoint lands, M14), or the write's setpoint
 * with the mode the valve showed when it was sent.
 */
function partial(write: SentWrite, seen: ThermostatSeen): boolean {
  const { wanted, from } = write;
  const modeOnly =
    seen.mode === wanted.mode && wanted.mode !== from.mode && seen.setpoint !== wanted.setpoint;
  const setpointOnly =
    seen.setpoint !== undefined &&
    seen.setpoint === wanted.setpoint &&
    wanted.setpoint !== from.setpoint &&
    seen.mode === from.mode;
  return modeOnly || setpointOnly;
}

/** The report was heard less than `SENT_RETIRE_MS` after the write, or with no `heardAt`. */
function within(write: SentWrite, heardAt: number | undefined): boolean {
  return heardAt === undefined || heardAt < write.at + SENT_RETIRE_MS;
}

/**
 * The write is still landing (R4.5a): heard within its minute and showing it in one key, or, for
 * a scheduled `auto` write, showing a value of the valve's week in any mode (a TRV-ZBT passes
 * through `heat` at its schedule's value, M14).
 */
function landing(write: SentWrite, valve: JudgedValve): boolean {
  if (!within(write, valve.heardAt)) return false;
  const { seen } = valve;
  const { wanted } = write;
  if (seen.mode === wanted.mode) return true;
  if (seen.setpoint !== undefined && seen.setpoint === wanted.setpoint) return true;
  return (
    scheduledAuto(wanted) &&
    seen.setpoint !== undefined &&
    valve.ctx.weekValues?.has(seen.setpoint) === true
  );
}

/** Judges one valve: its expectation after the report, and the person's change it shows, if any. */
function judge(
  valve: JudgedValve,
  roomId: string,
): Readonly<{ expectation: ValveExpectation; change: PersonChange | undefined }> {
  const given = valve.expectation;
  if (given?.roomId !== roomId) {
    // R3: taken over.
    const expectation = { roomId, confirmed: undefined, sent: [], week: undefined };
    return { expectation, change: undefined };
  }
  const { seen, heardAt, ctx, spec } = valve;
  if (seen.mode === undefined) return { expectation: given, change: undefined };
  const adapter = spec.thermostat;
  let e = given;
  if (heardAt !== undefined) {
    // R4.1: a write the valve shows no sign of a minute after it was sent is retired.
    const kept = e.sent.filter(
      (s) =>
        !(
          heardAt >= s.at + SENT_RETIRE_MS &&
          !adapter.matches(s.wanted, seen, ctx) &&
          !partial(s, seen)
        ),
    );
    if (kept.length !== e.sent.length) e = { ...e, sent: kept };
  }
  const known = [
    ...(e.confirmed === undefined ? [] : [e.confirmed]),
    ...e.sent.map((s) => s.wanted),
  ];
  const newest = e.sent[0];
  // R4.2: `last_seen` is whole seconds, so the write's instant is floored to the second (M14).
  if (
    newest !== undefined &&
    heardAt !== undefined &&
    heardAt >= Math.floor(newest.at / SECOND_MS) * SECOND_MS &&
    adapter.matches(newest.wanted, seen, ctx)
  ) {
    e = {
      roomId,
      confirmed: recorded(newest.wanted, valve),
      sent: [],
      week: savedWeek(newest.wanted, e, valve),
    };
  }
  const before = e.confirmed;
  // R4.3: a valve being taken over is not judged.
  if (before === undefined) return { expectation: e, change: undefined };
  // R4.4, R4.5, R4.5a.
  if (
    known.some((x) => adapter.explains(x, seen, ctx)) ||
    e.sent.some((s) => partial(s, seen)) ||
    e.sent.some((s) => landing(s, valve))
  ) {
    return { expectation: e, change: undefined };
  }
  // R4.6: a person's change.
  return {
    expectation: { roomId, confirmed: asWanted(seen), sent: e.sent, week: undefined },
    change: { valveId: valve.valveId, seen, before, heardAt },
  };
}

/** The newest change; an undefined `heardAt` is the oldest, ties go to the lowest valve id (R5). */
function newestChange(changes: readonly PersonChange[]): PersonChange | undefined {
  let best: PersonChange | undefined;
  for (const change of changes) {
    if (best === undefined) {
      best = change;
      continue;
    }
    const a = change.heardAt ?? -Infinity;
    const b = best.heardAt ?? -Infinity;
    if (a > b || (a === b && change.valveId < best.valveId)) best = change;
  }
  return best;
}

/**
 * Judges every valve of a room against its expectation (R3, R4) and adopts the newest person's
 * change as the room's state (R5), keeping the thermostat itself when the result equals it (R21).
 * Valves are judged in valve-id order.
 */
export function adopt(input: AdoptInput): Adoption {
  const expectations = new Map<string, ValveExpectation>();
  const changes: PersonChange[] = [];
  const valves = [...input.valves].sort((a, b) =>
    a.valveId < b.valveId ? -1 : a.valveId > b.valveId ? 1 : 0,
  );
  for (const valve of valves) {
    const judged = judge(valve, input.room.id);
    expectations.set(valve.valveId, judged.expectation);
    if (judged.change !== undefined) changes.push(judged.change);
  }
  const change = newestChange(changes);
  if (change === undefined) return { thermostat: input.thermostat, expectations };
  const next = personThermostat(input.thermostat, change, input);
  return {
    thermostat: sameThermostat(next, input.thermostat) ? input.thermostat : next,
    expectations,
  };
}

/** The room's target now: an override's target, otherwise the schedule's value, clamped. */
function targetNow(thermostat: Thermostat, input: AdoptInput): number {
  if (thermostat.kind === "override") return thermostat.target;
  return clampTarget(activePoint(input.week, input.now).temperature, input.limits);
}

/**
 * The room's state after a person's change, made now from the valve with the room's default end:
 * off; back to the schedule when `auto` was pressed at a valve confirmed in another mode; an
 * override at the shown setpoint (clamped); an override at the room's target for `heat` with no
 * setpoint; otherwise the thermostat unchanged.
 */
export function personThermostat(
  thermostat: Thermostat,
  change: PersonChange,
  input: AdoptInput,
): Thermostat {
  const { room, week, now } = input;
  const held = {
    rule: room.overrideEnd,
    endsAt: endsAt(defaultEnd(room), room, week, now),
    origin: { source: "valve", valveId: change.valveId },
    since: now.epochMilliseconds,
  } as const;
  const { seen } = change;
  if (seen.mode === "off") return { kind: "off", ...held };
  if (seen.mode === "auto" && change.before.mode !== "auto") return SCHEDULE;
  if (seen.setpoint !== undefined) {
    const target = clampTarget(seen.setpoint, input.limits);
    return { kind: "override", target, preset: undefined, ...held };
  }
  if (seen.mode === "heat") {
    return { kind: "override", target: targetNow(thermostat, input), preset: undefined, ...held };
  }
  return thermostat;
}

/**
 * The state with every sent write's `at` and every thermostat's `since` later than `nowMs` (the
 * clock went back) set to `nowMs`; `state` itself when there is none.
 */
export function clampThermostatState(state: ThermostatState, nowMs: number): ThermostatState {
  let changed = false;
  const rooms = new Map(state.rooms);
  for (const [roomId, thermostat] of state.rooms) {
    if (thermostat.kind === "schedule" || thermostat.since <= nowMs) continue;
    rooms.set(roomId, { ...thermostat, since: nowMs });
    changed = true;
  }
  const valves = new Map(state.valves);
  for (const [valveId, expectation] of state.valves) {
    if (!expectation.sent.some((s) => s.at > nowMs)) continue;
    const sent = expectation.sent.map((s) => (s.at > nowMs ? { ...s, at: nowMs } : s));
    valves.set(valveId, { ...expectation, sent });
    changed = true;
  }
  return changed ? { rooms, valves } : state;
}
