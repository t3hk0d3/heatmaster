import { differing, fitted, managedDesired, releaseDesired } from "./desired.ts";
import type { Desired } from "./desired.ts";
import { FEED_LOST_AFTER_MS, pushDue, pushed, stopped, trackRoom, wantedSource } from "./feed.ts";
import { memberships, withoutRecord } from "./ledger.ts";
import type { ConfigState, Ledger, Membership, StoredConfig } from "./ledger.ts";
import { markByAge, markedReady, needsAsk, newValveMemory } from "./memory.ts";
import type { Memory, RoomMemory, ValveMemory } from "./memory.ts";
import { WEEKDAYS, effectivePresets, sensorId } from "./model.ts";
import type { Config, Room } from "./model.ts";
import { VALVE_SILENT_AFTER_MS, liveness, newState } from "./observation.ts";
import type { DeviceState, Liveness } from "./observation.ts";
import {
  charge,
  chargeAsk,
  mayAsk,
  maySpend,
  mayWrite,
  noteDesired,
  notHolding,
  spend,
} from "./pacing.ts";
import { activePoint, resolveWeek } from "./schedule.ts";
import type { FittedWeek, ResolvedWeek } from "./schedule.ts";
import { members, valueKey } from "./settings.ts";
import type {
  Group,
  Readings,
  SettingKey,
  SettingValue,
  SettingValues,
  ValveSpec,
} from "./settings.ts";
import {
  problemConfigUnreadable,
  problemFeedLost,
  problemId,
  problemLedgerUnreadable,
  problemLinkDown,
  problemReleaseStalled,
  problemRoomNoTemperature,
  problemScheduleClamped,
  problemSensorLivenessUnobservable,
  problemSensorOutOfRange,
  problemSensorStale,
  problemSettingNotHolding,
  problemTransportUnusable,
  problemValveNotAdopted,
  problemValveNotAuto,
  problemValveOrphan,
  problemValveSilent,
  problemValveUnsupported,
  roomStatus,
  valveSync,
} from "./status.ts";
import type { Problem, RoomStatus, ValveStatus } from "./status.ts";
import { aggregate, freshness } from "./temperature.ts";
import type { Freshness, RoomTemperature, SensorReading } from "./temperature.ts";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** How long a releasing valve must stay equal to its originals (*provisional*). */
export const RELEASE_HOLD_MS = 15 * MINUTE_MS;
/** A release older than this is a problem. */
export const RELEASE_STALLED_AFTER_MS = 6 * HOUR_MS;

/** Rounds of `preview` per valve. */
const PREVIEW_ROUNDS = 10;

/**
 * - `spec` undefined: not a supported valve.
 * - `usable` false: its transport cannot be used right now.
 * - `state` undefined: no message has arrived from the device since the start.
 */
export type DeviceView = Readonly<{
  name: string;
  spec: ValveSpec | undefined;
  usable: boolean;
  state: DeviceState | undefined;
}>;

/**
 * Everything one tick reads. `ledger` undefined: the ledger could not be read. `links` holds one
 * entry per transport (and `ha` when configured); a transport with no entry counts as down.
 * `transportFaults` maps a transport key to why it is unusable. `sensors` and
 * `unobservableSensors` are keyed by sensor id. `now` is in the house's time zone.
 */
export type World = Readonly<{
  configState: ConfigState;
  stored: StoredConfig | undefined;
  ledger: Ledger | undefined;
  devices: ReadonlyMap<string, DeviceView>;
  links: Readonly<Record<string, boolean>>;
  transportFaults: Readonly<Record<string, string>>;
  sensors: ReadonlyMap<string, SensorReading>;
  unobservableSensors: ReadonlySet<string>;
  memory: Memory;
  now: Temporal.ZonedDateTime;
}>;

export type Effect =
  | Readonly<{ kind: "saveLedger"; ledger: Ledger }>
  | Readonly<{ kind: "writeOriginalsCopy"; ledger: Ledger }>
  | Readonly<{ kind: "saveConfig"; stored: StoredConfig }>
  | Readonly<{ kind: "publish"; valveId: string; values: SettingValues }>
  | Readonly<{ kind: "publishSetpoint"; valveId: string; celsius: number }>
  | Readonly<{ kind: "pushTemperature"; valveId: string; celsius: number }>
  | Readonly<{ kind: "refresh"; valveId: string }>;

export type TickResult = Readonly<{
  memory: Memory;
  effects: readonly Effect[];
  rooms: ReadonlyMap<string, RoomStatus>;
  problems: readonly Problem[];
}>;

/** One group to write: every desired key when `marked`, otherwise the differing ones. */
export type Selection = Readonly<{
  group: Group;
  values: SettingValues;
  differed: boolean;
  marked: boolean;
}>;

/** Keys missing from `current` are unknown. */
export type PlannedWrite = Readonly<{
  valveId: string;
  values: SettingValues;
  current: SettingValues;
}>;

/** The transport key of a valve id: the part before the colon. */
export function transportOf(valveId: string): string {
  const colon = valveId.indexOf(":");
  return colon < 0 ? valveId : valveId.slice(0, colon);
}

function linkUp(world: World, transport: string): boolean {
  return Object.hasOwn(world.links, transport) && world.links[transport] === true;
}

function hasFault(world: World, transport: string): boolean {
  return Object.hasOwn(world.transportFaults, transport);
}

/** A view with a spec and a state that has had at least one message since the start. */
export function isObservable(view: DeviceView | undefined): boolean {
  return view?.spec !== undefined && view.state?.messageAt !== undefined;
}

/** The view is not usable, or the valve's transport has an entry in `transportFaults`. */
export function transportFaulted(world: World, view: DeviceView, valveId: string): boolean {
  return !view.usable || hasFault(world, transportOf(valveId));
}

/** The valve's link is up, its view usable and its transport without a fault. */
export function transportUsable(world: World, view: DeviceView, valveId: string): boolean {
  return linkUp(world, transportOf(valveId)) && !transportFaulted(world, view, valveId);
}

/** Groups in the spec's order; see the task's candidate rule. Pacing is not considered. */
export function candidates(
  spec: ValveSpec,
  desired: Desired,
  state: DeviceState,
  vm: ValveMemory,
  anyMarkReady = false,
): readonly Selection[] {
  const result: Selection[] = [];
  const differs = new Set(differing(desired, state));
  for (const gs of spec.groups) {
    const keys = members(gs.group).filter((key) => desired[key] !== undefined);
    if (keys.length === 0) continue;
    const diff = keys.filter((key) => differs.has(key));
    const marked = !gs.readable && vm.groups[gs.group]?.mark !== undefined;
    const ready = marked && (anyMarkReady || markedReady(vm, spec, gs.group, state.heardAt));
    if (diff.length === 0 && !ready) continue;
    result.push({
      group: gs.group,
      values: valuesOf(desired, marked ? keys : diff),
      differed: diff.length > 0,
      marked,
    });
  }
  return result;
}

function valuesOf(desired: Desired, keys: readonly SettingKey[]): SettingValues {
  const values: Partial<Record<SettingKey, SettingValue>> = {};
  for (const key of keys) {
    const wanted = desired[key];
    if (wanted !== undefined) values[key] = wanted.value;
  }
  return values;
}

// Rooms ------------------------------------------------------------------------------------------

type RoomPlan = Readonly<{
  room: Room;
  week: ResolvedWeek;
  temperature: RoomTemperature;
  fresh: Freshness;
  rm: RoomMemory;
}>;

/** Each room whose schedule exists and has no empty day; others are left out. */
function planRooms(config: Config, world: World, nowMs: number): ReadonlyMap<string, RoomPlan> {
  const plans = new Map<string, RoomPlan>();
  for (const room of config.rooms) {
    const schedule = config.schedules.find((s) => s.id === room.scheduleId);
    if (schedule === undefined) continue;
    if (WEEKDAYS.some((day) => schedule.defaultWeek[day].length === 0)) continue;
    const week = resolveWeek(schedule.defaultWeek, effectivePresets(config, room));
    const temperature = aggregate(
      room.sensors,
      world.sensors,
      nowMs,
      config.settings.sensorStaleAfterMs,
    );
    const fresh = freshness(room.sensors, temperature);
    const old = world.memory.rooms.get(room.id) ?? { freshSince: undefined };
    plans.set(room.id, { room, week, temperature, fresh, rm: trackRoom(old, fresh, nowMs) });
  }
  return plans;
}

function roomProblems(plan: RoomPlan, world: World): readonly Problem[] {
  const problems: Problem[] = [];
  if (plan.fresh === "stale") problems.push(problemRoomNoTemperature(plan.room.id));
  for (const id of plan.temperature.stale) problems.push(problemSensorStale(id));
  for (const id of plan.temperature.invalid) problems.push(problemSensorOutOfRange(id));
  for (const sensor of plan.room.sensors) {
    const id = sensorId(sensor);
    if (world.unobservableSensors.has(id)) problems.push(problemSensorLivenessUnobservable(id));
  }
  return problems;
}

// One valve --------------------------------------------------------------------------------------

type Context = Readonly<{
  world: World;
  nowMs: number;
  held: boolean;
  config: Config | undefined;
}>;

type ValveRun = Readonly<{
  vm: ValveMemory;
  push: Effect | undefined;
  action: Effect | undefined;
  finished: boolean;
  live: Liveness;
  verified: boolean;
  pending: boolean;
  target: number | undefined;
  problems: readonly Problem[];
}>;

/** The desired value keys of one group, joined in member order. */
function desiredKeyOf(desired: Desired, group: Group): string | undefined {
  const keys = members(group).filter((key) => desired[key] !== undefined);
  if (keys.length === 0) return undefined;
  return keys
    .map((key) => {
      const wanted = desired[key];
      return wanted === undefined ? "" : valueKey(key, wanted.value);
    })
    .join("|");
}

function hasDesired(desired: Desired, group: Group): boolean {
  return members(group).some((key) => desired[key] !== undefined);
}

function withFeedLost(vm: ValveMemory, state: DeviceState | undefined, nowMs: number): ValveMemory {
  const lost = vm.feedAt !== undefined && state?.readings.feedLost === true;
  return { ...vm, feedLostSince: lost ? (vm.feedLostSince ?? nowMs) : undefined };
}

function valveLiveness(
  world: World,
  valveId: string,
  state: DeviceState | undefined,
  nowMs: number,
): Liveness {
  if (!linkUp(world, transportOf(valveId)) || state === undefined) return "unknown";
  return liveness(state, nowMs, VALVE_SILENT_AFTER_MS);
}

/** Runs a managed or releasing valve that has a spec (and, when managed, a planned room). */
function runValve(
  ctx: Context,
  valveId: string,
  kind: "managed" | "releasing",
  view: DeviceView,
  spec: ValveSpec,
  plan: RoomPlan | undefined,
): ValveRun {
  const { world, nowMs, held } = ctx;
  const state = view.state;
  const live: Liveness = valveLiveness(world, valveId, state, nowMs);
  let vm = markByAge(world.memory.valves.get(valveId) ?? newValveMemory(spec, nowMs), spec, nowMs);
  vm = kind === "managed" ? { ...vm, equalSince: undefined } : { ...vm, nudgeDue: false };
  const canRead = transportUsable(world, view, valveId) && live !== "silent";
  const canAct = canRead && !held;
  const readable = spec.groups.some((g) => g.readable);
  const problems: Problem[] = [];
  if (live === "silent") problems.push(problemValveSilent(valveId));

  const week: FittedWeek | undefined = plan === undefined ? undefined : fitted(plan.week, spec);
  const target = week === undefined ? undefined : activePoint(week.days, world.now).temperature;
  if (week?.clamped === true) {
    problems.push(problemScheduleClamped(valveId, spec.minTemp, spec.maxTemp));
  }
  const orderedAt = kind === "releasing" ? ctx.world.stored?.releasing.get(valveId) : undefined;
  if (orderedAt !== undefined && nowMs - orderedAt > RELEASE_STALLED_AFTER_MS) {
    problems.push(problemReleaseStalled(valveId));
  }

  const ask = (): Effect => {
    vm = chargeAsk(vm, spec, nowMs);
    return { kind: "refresh", valveId };
  };

  if (!isObservable(view) || state === undefined) {
    const action = canRead && readable && mayAsk(vm, nowMs) ? ask() : undefined;
    // A release counts its hold only while the valve is observed.
    if (kind === "releasing") vm = { ...vm, equalSince: undefined };
    vm = withFeedLost(vm, state, nowMs);
    return {
      vm,
      push: undefined,
      action,
      finished: false,
      live,
      verified: false,
      pending: false,
      target,
      problems,
    };
  }

  const record = world.ledger?.records.get(valveId);
  let desired: Desired = {};
  if (kind === "managed" && plan !== undefined) {
    const source = spec.externalSensor ? wantedSource(plan.fresh, plan.rm, vm, nowMs) : undefined;
    const trusted = vm.groups.schedule?.mark === undefined;
    desired = managedDesired(spec, plan.week, state, source, trusted);
  } else if (kind === "releasing" && record !== undefined) {
    desired = releaseDesired(spec, record);
  }
  for (const gs of spec.groups) {
    const key = desiredKeyOf(desired, gs.group);
    if (key !== undefined) vm = noteDesired(vm, gs.group, key);
  }
  const cands = candidates(spec, desired, state, vm);
  const markedDesired = spec.groups.some(
    (gs) => vm.groups[gs.group]?.mark !== undefined && hasDesired(desired, gs.group),
  );

  let push: Effect | undefined;
  let action: Effect | undefined;
  const mode = state.readings.mode;
  const offUnfed = mode === "off" && !spec.feedWhenOff;
  const roomTemperature = plan?.temperature.value;
  if (
    canAct &&
    kind === "managed" &&
    spec.externalSensor &&
    plan?.fresh === "fresh" &&
    roomTemperature !== undefined &&
    !offUnfed &&
    ctx.config !== undefined &&
    pushDue(vm, roomTemperature, ctx.config.settings.externalWriteIntervalMs, nowMs)
  ) {
    push = { kind: "pushTemperature", valveId, celsius: roomTemperature };
    vm = pushed(vm, roomTemperature, nowMs);
  }
  if (
    canAct &&
    ((kind === "managed" && (plan?.fresh !== "fresh" || offUnfed)) || kind === "releasing")
  ) {
    vm = stopped(vm);
  }
  if (canRead && readable && needsAsk(vm, spec, state.heardAt) && mayAsk(vm, nowMs)) {
    action = ask();
  }
  if (canAct && action === undefined) {
    const pick = cands.find((s) => mayWrite(vm, s.group, nowMs));
    if (pick !== undefined) {
      action = { kind: "publish", valveId, values: pick.values };
      vm = charge(vm, pick.group, nowMs, pick.marked);
      if (
        kind === "managed" &&
        pick.group === "schedule" &&
        pick.differed &&
        spec.activation === "setpoint"
      ) {
        vm = { ...vm, nudgeDue: true };
      }
    }
  }
  if (
    canAct &&
    kind === "managed" &&
    spec.activation === "setpoint" &&
    vm.nudgeDue &&
    target !== undefined &&
    !cands.some((s) => s.group === "schedule") &&
    vm.groups.schedule?.mark === undefined &&
    mode === "auto" &&
    action === undefined &&
    maySpend(vm, nowMs)
  ) {
    action = { kind: "publishSetpoint", valveId, celsius: target };
    vm = { ...spend(vm, nowMs), nudgeDue: false };
  }

  vm = withFeedLost(vm, state, nowMs);

  let finished = false;
  if (kind === "releasing") {
    const settled = cands.length === 0 && !markedDesired;
    const equalSince = settled ? (vm.equalSince ?? nowMs) : undefined;
    vm = { ...vm, equalSince };
    const holdPassed = equalSince !== undefined && nowMs - equalSince >= RELEASE_HOLD_MS;
    const heardSince =
      equalSince !== undefined && state.heardAt !== undefined && state.heardAt >= equalSince;
    finished = holdPassed && orderedAt !== undefined && equalSince >= orderedAt && heardSince;
    if (
      holdPassed &&
      !heardSince &&
      action === undefined &&
      readable &&
      canRead &&
      mayAsk(vm, nowMs)
    ) {
      action = ask();
    }
  }

  if (vm.feedLostSince !== undefined && nowMs - vm.feedLostSince >= FEED_LOST_AFTER_MS) {
    problems.push(problemFeedLost(valveId));
  }
  if (kind === "managed" && live === "live" && mode !== undefined && mode !== "auto") {
    problems.push(problemValveNotAuto(valveId, mode));
  }
  return {
    vm,
    push,
    action,
    finished,
    live,
    verified: canRead && live === "live",
    pending: cands.length > 0 || markedDesired,
    target,
    problems,
  };
}

// Tick -------------------------------------------------------------------------------------------

function readingsOf(
  state: DeviceState | undefined,
): Pick<Readings, "mode" | "setpoint" | "running" | "battery"> {
  return {
    mode: state?.readings.mode,
    setpoint: state?.readings.setpoint,
    running: state?.readings.running,
    battery: state?.readings.battery,
  };
}

function systemProblems(world: World, kinds: ReadonlyMap<string, Membership>): Problem[] {
  const problems: Problem[] = [];
  const recorded = (world.ledger?.records.size ?? 0) > 0;
  const configUnreadable =
    world.configState === "unreadable" ||
    (world.configState === "ok" && world.stored === undefined) ||
    (world.configState === "empty" && recorded);
  if (configUnreadable) problems.push(problemConfigUnreadable());
  if (world.ledger === undefined) problems.push(problemLedgerUnreadable());
  for (const link of Object.keys(world.links).sort()) {
    if (world.links[link] === false) problems.push(problemLinkDown(link));
  }
  const transports = new Set([...kinds.keys()].map(transportOf));
  for (const transport of Object.keys(world.transportFaults).sort()) {
    const reason = world.transportFaults[transport];
    if (reason !== undefined && transports.has(transport)) {
      problems.push(problemTransportUnusable(transport, reason));
    }
  }
  return problems;
}

/** Drops later problems with an id already listed. */
function unique(problems: readonly Problem[]): readonly Problem[] {
  const seen = new Set<string>();
  return problems.filter((p) => {
    const id = problemId(p);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** One control step: what to save and write, the new memory, the rooms and the problems. */
export function tick(world: World): TickResult {
  const nowMs = world.now.epochMilliseconds;
  const kinds = memberships(world.configState, world.stored, world.ledger);
  const stored = world.stored;
  const held = stored?.config.settings.holdWrites === true;
  const config = world.configState === "ok" ? stored?.config : undefined;
  const plans =
    config === undefined ? new Map<string, RoomPlan>() : planRooms(config, world, nowMs);
  const roomOf = new Map<string, string>();
  for (const room of config?.rooms ?? []) {
    for (const ref of room.valves) roomOf.set(ref.valveId, room.id);
  }
  const ctx: Context = { world, nowMs, held, config };

  const valves = new Map<string, ValveMemory>();
  const statuses = new Map<string, ValveStatus>();
  const valveEffects: Effect[] = [];
  const valveProblems: Problem[] = [];
  const finished: string[] = [];
  const strays: string[] = [];

  for (const valveId of [...kinds.keys()].sort()) {
    const kind = kinds.get(valveId);
    if (kind === undefined) continue;
    const view = world.devices.get(valveId);
    const transport = transportOf(valveId);
    const status = (fields: Partial<ValveStatus>): void => {
      statuses.set(valveId, {
        valveId,
        name: view?.name ?? valveId,
        membership: kind,
        liveness: "unknown",
        ...readingsOf(view?.state),
        target: undefined,
        sync: valveSync(kind, held, false, false, false),
        ...fields,
      });
    };

    if (kind === "stray") {
      strays.push(valveId);
      continue;
    }
    if (kind === "not_adopted" || kind === "orphan" || kind === "frozen") {
      if (kind === "not_adopted") valveProblems.push(problemValveNotAdopted(valveId));
      if (kind === "orphan") valveProblems.push(problemValveOrphan(valveId));
      status({ liveness: valveLiveness(world, valveId, view?.state, nowMs) });
      continue;
    }

    const old = world.memory.valves.get(valveId);
    const spec = view?.spec;
    const plan = kind === "managed" ? plans.get(roomOf.get(valveId) ?? "") : undefined;
    if (view === undefined || spec === undefined || (kind === "managed" && plan === undefined)) {
      if (old !== undefined) valves.set(valveId, old);
      const unsupported = view === undefined || spec === undefined;
      if (
        kind === "managed" &&
        unsupported &&
        linkUp(world, transport) &&
        !hasFault(world, transport)
      ) {
        valveProblems.push(problemValveUnsupported(valveId));
      }
      if (kind === "releasing") {
        const orderedAt = stored?.releasing.get(valveId);
        if (orderedAt !== undefined && nowMs - orderedAt > RELEASE_STALLED_AFTER_MS) {
          valveProblems.push(problemReleaseStalled(valveId));
        }
      }
      status({});
      continue;
    }

    const run = runValve(ctx, valveId, kind, view, spec, plan);
    valves.set(valveId, run.vm);
    if (run.push !== undefined) valveEffects.push(run.push);
    if (run.action !== undefined) valveEffects.push(run.action);
    if (run.finished) finished.push(valveId);
    valveProblems.push(...run.problems);
    const notHoldingGroups = notHolding(run.vm, nowMs);
    for (const group of notHoldingGroups) {
      valveProblems.push(problemSettingNotHolding(valveId, group));
    }
    status({
      liveness: run.live,
      target: kind === "managed" ? run.target : undefined,
      sync: valveSync(kind, held, run.verified, run.pending, notHoldingGroups.length > 0),
    });
  }

  const saves: Effect[] = [];
  if (finished.length > 0 && world.ledger !== undefined) {
    let ledger = world.ledger;
    for (const valveId of finished) ledger = withoutRecord(ledger, valveId, nowMs, false);
    saves.push({ kind: "saveLedger", ledger }, { kind: "writeOriginalsCopy", ledger });
  }
  const dropped = [...finished, ...strays];
  if (stored !== undefined && dropped.length > 0) {
    const releasing = new Map(stored.releasing);
    for (const valveId of dropped) releasing.delete(valveId);
    saves.push({
      kind: "saveConfig",
      stored: { config: stored.config, revision: stored.revision, releasing },
    });
  }

  const rooms = new Map<string, RoomStatus>();
  const roomMemory = new Map<string, RoomMemory>();
  const roomProblemList: Problem[] = [];
  for (const plan of plans.values()) {
    roomMemory.set(plan.room.id, plan.rm);
    roomProblemList.push(...roomProblems(plan, world));
    const valveStatuses = plan.room.valves.flatMap((ref) => {
      const found = statuses.get(ref.valveId);
      return found === undefined ? [] : [found];
    });
    rooms.set(
      plan.room.id,
      roomStatus(plan.room, plan.week, plan.temperature, plan.fresh, valveStatuses, world.now),
    );
  }

  return {
    memory: { valves, rooms: roomMemory },
    effects: [...saves, ...valveEffects],
    rooms,
    problems: unique([...systemProblems(world, kinds), ...roomProblemList, ...valveProblems]),
  };
}

// Preview ----------------------------------------------------------------------------------------

function withoutMark(vm: ValveMemory, group: Group): ValveMemory {
  const gm = vm.groups[group];
  if (gm === undefined) return vm;
  return { ...vm, groups: { ...vm.groups, [group]: { ...gm, mark: undefined } } };
}

function currentOf(state: DeviceState, values: SettingValues): SettingValues {
  const current: Partial<Record<SettingKey, SettingValue>> = {};
  for (const key of Object.keys(values) as SettingKey[]) {
    const observed = state.values[key];
    if (observed !== undefined) current[key] = observed;
  }
  return current;
}

/**
 * The writes `tick` would make for every managed or releasing valve with a spec, ignoring
 * pacing, hold, links and liveness, with pushes assumed sent and each mark satisfied once.
 */
export function preview(world: World): readonly PlannedWrite[] {
  const nowMs = world.now.epochMilliseconds;
  const kinds = memberships(world.configState, world.stored, world.ledger);
  const config = world.configState === "ok" ? world.stored?.config : undefined;
  const plans =
    config === undefined ? new Map<string, RoomPlan>() : planRooms(config, world, nowMs);
  const roomOf = new Map<string, string>();
  for (const room of config?.rooms ?? []) {
    for (const ref of room.valves) roomOf.set(ref.valveId, room.id);
  }
  const writes: PlannedWrite[] = [];
  for (const valveId of [...kinds.keys()].sort()) {
    const kind = kinds.get(valveId);
    if (kind !== "managed" && kind !== "releasing") continue;
    const view = world.devices.get(valveId);
    const spec = view?.spec;
    if (view === undefined || spec === undefined) continue;
    const plan = kind === "managed" ? plans.get(roomOf.get(valveId) ?? "") : undefined;
    const record = world.ledger?.records.get(valveId);
    if (kind === "managed" ? plan === undefined : record === undefined) continue;
    let state = view.state ?? newState(nowMs);
    // Groups asserted too long ago are marked, as in tick.
    let vm = markByAge(
      world.memory.valves.get(valveId) ?? newValveMemory(spec, nowMs),
      spec,
      nowMs,
    );
    for (let round = 0; round < PREVIEW_ROUNDS; round++) {
      let desired: Desired = {};
      if (plan !== undefined) {
        const source = !spec.externalSensor
          ? undefined
          : plan.fresh === "stale" || plan.fresh === "no_sensors"
            ? "internal"
            : "external";
        const trusted = vm.groups.schedule?.mark === undefined;
        desired = managedDesired(spec, plan.week, state, source, trusted);
      } else if (record !== undefined) {
        desired = releaseDesired(spec, record);
      }
      const first = candidates(spec, desired, state, vm, true)[0];
      if (first === undefined) break;
      writes.push({ valveId, values: first.values, current: currentOf(state, first.values) });
      state = { ...state, values: { ...state.values, ...first.values } };
      vm = withoutMark(vm, first.group);
    }
  }
  return writes;
}
