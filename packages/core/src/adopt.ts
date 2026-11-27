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
import type { WindowOpening } from "./window.ts";

const SECOND_MS = 1000;

/**
 * One managed valve of a room as the tick judges it. `seen` is its current mode and setpoint
 * (undefined where never shown), `heardAt` when it last spoke, `ctx` what its adapter is told of
 * its week, and `week` its confirmed week as a key and values (undefined while unconfirmed).
 * `previousPoints` are the temperatures in force near `heardAt` in a week the valve may still run
 * instead of its desired one (`savedPointValues`), undefined when there is none.
 */
export type JudgedValve = Readonly<{
  valveId: string;
  spec: ValveSpec;
  seen: ThermostatSeen;
  heardAt: number | undefined;
  expectation: ValveExpectation | undefined;
  ctx: AdapterContext;
  week: SavedWeek | undefined;
  previousPoints: ReadonlySet<number> | undefined;
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

/**
 * The room's thermostat and every judged valve's expectation after judging. `resend` holds the
 * valves whose report shows a point of the week they ran before: their schedule did not land and
 * is to be written again.
 */
export type Adoption = Readonly<{
  thermostat: Thermostat;
  expectations: ReadonlyMap<string, ValveExpectation>;
  resend: ReadonlySet<string>;
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

/** The expectation with `week` saved; `e` itself when its key is the saved week's. */
export function withWeek(e: ValveExpectation, week: SavedWeek | undefined): ValveExpectation {
  return week?.key === e.week?.key ? e : { ...e, week };
}

/**
 * The expectation once a schedule write of `week` is sent, confirmed or not. When its key differs
 * from the written week's, the week written before becomes the previous one: the valve may still
 * run it until it shows `week`. A state saved before the written week was kept has the saved week
 * stand in for it. `e` itself when the same week is sent again.
 */
export function withWritten(e: ValveExpectation, week: SavedWeek): ValveExpectation {
  if (week.key === e.written?.key) return e;
  const before = [e.written, e.week].find((w) => w !== undefined && w.key !== week.key);
  return { ...e, written: week, previous: before ?? e.previous };
}

/**
 * The report is a point of the week the valve ran before and no expected state explains it: a
 * scheduled `auto` state is expected and it shows `auto` at a value in force near its `heardAt` in
 * that week. The new week did not land (a lost, queued or late day write).
 */
function previousPoint(valve: JudgedValve, known: readonly ThermostatWanted[]): boolean {
  const { seen, previousPoints } = valve;
  return (
    seen.mode === "auto" &&
    seen.setpoint !== undefined &&
    previousPoints?.has(seen.setpoint) === true &&
    known.some(scheduledAuto)
  );
}

/**
 * The valve shows its saved week: in `auto` at a value of that week in force near its `heardAt`
 * (`ctx.pointValues`) that is no point of the previous week then and no setpoint Heatmaster
 * expects (a value it wrote is no sign of the week).
 */
function weekShown(valve: JudgedValve, known: readonly ThermostatWanted[]): boolean {
  const { seen, ctx, previousPoints } = valve;
  const setpoint = seen.setpoint;
  return (
    seen.mode === "auto" &&
    setpoint !== undefined &&
    ctx.pointValues?.has(setpoint) === true &&
    previousPoints?.has(setpoint) !== true &&
    !known.some((x) => x.setpoint === setpoint)
  );
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

/**
 * One valve's judging: its expectation after the report, the person's change it shows, if any,
 * and whether its schedule is to be written again.
 */
type Judging = Readonly<{
  expectation: ValveExpectation;
  change: PersonChange | undefined;
  resend: boolean;
}>;

/** Judges one valve against its expectation (R3, R4). */
function judge(valve: JudgedValve, roomId: string): Judging {
  const given = valve.expectation;
  if (given?.roomId !== roomId) {
    // R3: taken over. The weeks written to the valve are facts of the valve, not of its room, and
    // are kept: one of them may be the week it still runs.
    const expectation = {
      roomId,
      confirmed: undefined,
      sent: [],
      week: undefined,
      written: given?.written,
      previous: given?.previous,
    };
    return { expectation, change: undefined, resend: false };
  }
  const { seen, heardAt, ctx, spec } = valve;
  if (seen.mode === undefined) return { expectation: given, change: undefined, resend: false };
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
  // R4.2: `heardAt` is the server's receive time of the last message with a new `last_seen`.
  // An echo that repeats the `last_seen` of a message received up to 1 s before the write keeps
  // that earlier `heardAt` (`last_seen` is whole seconds), so the write's instant is floored to
  // the second (M14).
  if (
    newest !== undefined &&
    heardAt !== undefined &&
    heardAt >= Math.floor(newest.at / SECOND_MS) * SECOND_MS &&
    adapter.matches(newest.wanted, seen, ctx)
  ) {
    const confirmed = recorded(newest.wanted, valve);
    e = withWeek({ ...e, confirmed, sent: [] }, savedWeek(newest.wanted, e, valve));
  }
  // The valve shows its saved week: the week it ran before is no longer kept.
  if (e.previous !== undefined && weekShown(valve, known)) e = { ...e, previous: undefined };
  const before = e.confirmed;
  // R4.3: a valve being taken over is not judged.
  if (before === undefined) return { expectation: e, change: undefined, resend: false };
  // R4.4, R4.5, R4.5a.
  if (
    known.some((x) => adapter.explains(x, seen, ctx)) ||
    e.sent.some((s) => partial(s, seen)) ||
    e.sent.some((s) => landing(s, valve))
  ) {
    return { expectation: e, change: undefined, resend: false };
  }
  // A point of the week the valve ran before: its new week did not land, so it is written again.
  if (previousPoint(valve, known)) return { expectation: e, change: undefined, resend: true };
  // R4.6: a person's change. The saved week is kept: while the valve's week is unconfirmed it
  // still gives the points that explain an adopted `auto` value (R23, R24; fix round 1).
  return {
    expectation: { ...e, confirmed: asWanted(seen) },
    change: { valveId: valve.valveId, seen, before, heardAt },
    resend: false,
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
 * A report showing a point of the week a valve ran before is no change: that valve's schedule is
 * to be written again. Valves are judged in valve-id order.
 */
export function adopt(input: AdoptInput): Adoption {
  const expectations = new Map<string, ValveExpectation>();
  const changes: PersonChange[] = [];
  const resend = new Set<string>();
  const valves = [...input.valves].sort((a, b) =>
    a.valveId < b.valveId ? -1 : a.valveId > b.valveId ? 1 : 0,
  );
  for (const valve of valves) {
    const judged = judge(valve, input.room.id);
    expectations.set(valve.valveId, judged.expectation);
    if (judged.change !== undefined) changes.push(judged.change);
    if (judged.resend) resend.add(valve.valveId);
  }
  const change = newestChange(changes);
  if (change === undefined) return { thermostat: input.thermostat, expectations, resend };
  const next = personThermostat(input.thermostat, change, input);
  return {
    thermostat: sameThermostat(next, input.thermostat) ? input.thermostat : next,
    expectations,
    resend,
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
 * The state with every sent write's `at`, every thermostat's `since` and every opening's instant
 * later than `nowMs` (the clock went back) set to `nowMs`; `state` itself when there is none.
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
  const windows = new Map(state.windows);
  for (const [roomId, opening] of state.windows) {
    const clamped = clampOpening(opening, nowMs);
    if (clamped === opening) continue;
    windows.set(roomId, clamped);
    changed = true;
  }
  return changed ? { ...state, rooms, valves, windows } : state;
}

/** The opening with every instant later than `nowMs` set to `nowMs`; itself when there is none. */
function clampOpening(opening: WindowOpening, nowMs: number): WindowOpening {
  const instants = Object.values(opening).filter((at): at is number => at !== undefined);
  if (!instants.some((at) => at > nowMs)) return opening;
  const notAfter = (at: number | undefined): number | undefined =>
    at === undefined ? undefined : Math.min(at, nowMs);
  return {
    startedAt: Math.min(opening.startedAt, nowMs),
    temperatureSince: notAfter(opening.temperatureSince),
    temperatureEndedAt: notAfter(opening.temperatureEndedAt),
    suspendedAt: notAfter(opening.suspendedAt),
    limitAt: notAfter(opening.limitAt),
    notifiedAt: notAfter(opening.notifiedAt),
    droppedAt: notAfter(opening.droppedAt),
    endedAt: notAfter(opening.endedAt),
  };
}
