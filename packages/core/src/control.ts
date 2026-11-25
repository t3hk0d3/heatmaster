import { adopt, recorded, savedWeek, scheduledAuto, withWeek, withWritten } from "./adopt.ts";
import type { JudgedValve } from "./adopt.ts";
import {
  differing,
  fitted,
  frostDesired,
  managedDesired,
  releaseDesired,
  savedPointValues,
  thermostatContext,
  thermostatDesired,
  thermostatWanted,
  weekKey,
} from "./desired.ts";
import type { Desired } from "./desired.ts";
import { FEED_LOST_AFTER_MS, pushDue, pushed, stopped, trackRoom, wantedSource } from "./feed.ts";
import { roomOfValves, roomsOf } from "./house.ts";
import type { HouseInput } from "./house.ts";
import { reconcile } from "./join.ts";
import type { Pending } from "./join.ts";
import { memberships, withoutRecord } from "./ledger.ts";
import type { ConfigState, Ledger, Membership, StoredConfig } from "./ledger.ts";
import { mark, markByAge, markedReady, needsAsk, newValveMemory } from "./memory.ts";
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
  importBucket,
  importFreeAsk,
  noteDesired,
  notHolding,
  spend,
} from "./pacing.ts";
import { activePoint, resolveWeek } from "./schedule.ts";
import type { FittedWeek, ResolvedWeek } from "./schedule.ts";
import { groupOf, members, valueKey } from "./settings.ts";
import type {
  Group,
  Readings,
  SensorSource,
  SettingKey,
  SettingValue,
  SettingValues,
  ValveMode,
  ValveSpec,
} from "./settings.ts";
import {
  problemConfigUnreadable,
  problemFeedLost,
  problemHaLinkRequired,
  problemId,
  problemLedgerUnreadable,
  problemLinkDown,
  problemNoSchedule,
  problemReleaseStalled,
  problemRoomsFrozen,
  problemRoomNoTemperature,
  problemScheduleClamped,
  problemSensorLivenessUnobservable,
  problemSensorOutOfRange,
  problemSensorStale,
  problemSettingNotHolding,
  problemStateUnreadable,
  problemTransportUnusable,
  problemValveNotInHa,
  problemValveOrphan,
  problemValvePending,
  problemValveSilent,
  problemValveUnsupported,
  roomStatus,
  valveSync,
} from "./status.ts";
import type { Problem, RoomStatus, ValveStatus } from "./status.ts";
import { aggregate, freshness } from "./temperature.ts";
import type { Freshness, RoomTemperature, SensorReading } from "./temperature.ts";
import type { AdapterContext } from "./thermostat-adapter.ts";
import {
  SCHEDULE,
  SENT_KEPT,
  SENT_RETIRE_MS,
  ended,
  roomLimits,
  sameWanted,
} from "./thermostat-rules.ts";
import type {
  SavedWeek,
  SentWrite,
  Thermostat,
  ThermostatSeen,
  ThermostatState,
  ThermostatWanted,
  ValveExpectation,
} from "./thermostat.ts";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** How long a releasing valve must stay equal to its originals (*provisional*). */
export const RELEASE_HOLD_MS = 15 * MINUTE_MS;
/** A release older than this is a problem. */
export const RELEASE_STALLED_AFTER_MS = 6 * HOUR_MS;

/** Rounds of `preview` per valve. */
const PREVIEW_ROUNDS = 10;

/**
 * For this long after an override or off starts, its room's valves get no mode or setpoint (R6).
 */
export const THERMOSTAT_SETTLE_MS = 10 * 1000;

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
 * The buckets a valve starts with when the tick finds no memory for it: `stamps` holds a valve's
 * `bucketFullAt` (see `importBucket`), `fallback` is the stamp of a valve with none. `freeAsks`
 * holds the time of a valve's last free ask (see `importFreeAsk`), `freeAskFallback` that of a
 * valve with none (undefined: none was made).
 */
export type BucketStart = Readonly<{
  stamps: ReadonlyMap<string, number>;
  fallback: number;
  freeAsks?: ReadonlyMap<string, number>;
  freeAskFallback?: number;
}>;

/**
 * Everything one tick reads. `house` says where the rooms come from (`roomsOf`). `ledger`
 * undefined: the ledger could not be read. `links` holds one
 * entry per transport (and `ha` when configured); a transport with no entry counts as down.
 * `transportFaults` maps a transport key to why it is unusable. `deviceLists` holds, per
 * transport, the ids of every device it lists (followed or not), once it has delivered its device
 * list since the start; a transport with no entry has not, and its list vouches for nothing.
 * `sensors` and `unobservableSensors` are keyed by sensor id. `now` is in the house's time zone.
 * `thermostats` undefined: the state file could not be read.
 */
export type World = Readonly<{
  configState: ConfigState;
  stored: StoredConfig | undefined;
  house: HouseInput;
  ledger: Ledger | undefined;
  devices: ReadonlyMap<string, DeviceView>;
  links: Readonly<Record<string, boolean>>;
  transportFaults: Readonly<Record<string, string>>;
  deviceLists: Readonly<Record<string, ReadonlySet<string>>>;
  sensors: ReadonlyMap<string, SensorReading>;
  unobservableSensors: ReadonlySet<string>;
  memory: Memory;
  buckets: BucketStart | undefined;
  now: Temporal.ZonedDateTime;
  thermostats: ThermostatState | undefined;
}>;

export type Effect =
  | Readonly<{ kind: "saveLedger"; ledger: Ledger }>
  | Readonly<{ kind: "writeOriginalsCopy"; ledger: Ledger }>
  | Readonly<{ kind: "saveConfig"; stored: StoredConfig }>
  | Readonly<{ kind: "publish"; valveId: string; values: SettingValues }>
  | Readonly<{ kind: "publishSetpoint"; valveId: string; celsius: number }>
  | Readonly<{ kind: "pushTemperature"; valveId: string; celsius: number }>
  | Readonly<{ kind: "refresh"; valveId: string }>
  | Readonly<{ kind: "saveThermostats"; state: ThermostatState }>;

/**
 * `pending` lists the valves that wait to join, in valve-id order (see `reconcile`).
 * `thermostats` is the thermostat state after this tick (undefined: the state file is unreadable).
 */
export type TickResult = Readonly<{
  memory: Memory;
  effects: readonly Effect[];
  rooms: ReadonlyMap<string, RoomStatus>;
  problems: readonly Problem[];
  pending: readonly Pending[];
  thermostats: ThermostatState | undefined;
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

/** No write is recorded for the group's current desired value (`noteDesired` empties them). */
function unwritten(vm: ValveMemory, group: Group): boolean {
  return (vm.groups[group]?.writes.length ?? 0) === 0;
}

function writeOnly(spec: ValveSpec, group: Group): boolean {
  return spec.groups.some((gs) => gs.group === group && gs.evidence === "none");
}

/**
 * The schedule has no mark and, when it is write-only, a write is recorded for its current
 * desired value. `vm` must already have noted that value.
 */
function scheduleTrusted(vm: ValveMemory, spec: ValveSpec): boolean {
  return (
    vm.groups.schedule?.mark === undefined &&
    (!writeOnly(spec, "schedule") || !unwritten(vm, "schedule"))
  );
}

/**
 * Where the schedule is write-only, nothing shows that it took except a message heard after its
 * last write. Elsewhere the observed days already said so.
 */
function scheduleHeard(vm: ValveMemory, spec: ValveSpec, state: DeviceState): boolean {
  if (!writeOnly(spec, "schedule")) return true;
  const writes = vm.groups.schedule?.writes ?? [];
  if (writes.length === 0 || state.heardAt === undefined) return false;
  return state.heardAt > Math.max(...writes.map((w) => w.at));
}

/**
 * The week a valve is known to run (R23): its fitted week while the schedule is trusted and heard
 * and, on a model with a schedule group, while the valve shows that group active; otherwise
 * undefined. `vm` must already have noted this tick's desired schedule values.
 */
export function confirmedWeek(
  spec: ValveSpec,
  vm: ValveMemory,
  state: DeviceState | undefined,
  fittedWeek: ResolvedWeek,
): ResolvedWeek | undefined {
  if (state === undefined || !scheduleTrusted(vm, spec) || !scheduleHeard(vm, spec, state)) {
    return undefined;
  }
  if (spec.scheduleGroup !== undefined && state.values.active_group !== spec.scheduleGroup) {
    return undefined;
  }
  return fittedWeek;
}

/**
 * Groups in the spec's order; see the task's candidate rule. A marked group, and an atomic group
 * with a differing key, carry every desired member. Pacing is not considered. `thermostatMatches`
 * is the adapter's verdict for a managed valve (R24): when it is given, the `thermostat` group
 * differs exactly when it is false; undefined compares the group key by key (R25).
 */
export function candidates(
  spec: ValveSpec,
  desired: Desired,
  state: DeviceState,
  vm: ValveMemory,
  anyMarkReady = false,
  thermostatMatches?: boolean,
): readonly Selection[] {
  const result: Selection[] = [];
  const differs = new Set(differing(desired, state));
  for (const gs of spec.groups) {
    const keys = members(gs.group).filter((key) => desired[key] !== undefined);
    if (keys.length === 0) continue;
    // A write-only group's observed keys are never compared: it differs until a write is recorded.
    let diff: readonly SettingKey[];
    if (gs.evidence === "none") diff = unwritten(vm, gs.group) ? keys : [];
    else if (gs.group === "thermostat" && thermostatMatches !== undefined) {
      diff = thermostatMatches ? [] : keys;
    } else diff = keys.filter((key) => differs.has(key));
    const marked = !gs.readable && vm.groups[gs.group]?.mark !== undefined;
    const ready = marked && (anyMarkReady || markedReady(vm, spec, gs.group, state.heardAt));
    if (diff.length === 0 && !ready) continue;
    const whole = marked || (gs.atomic && diff.length > 0);
    result.push({
      group: gs.group,
      values: valuesOf(desired, whole ? keys : diff),
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

/**
 * `thermostat` undefined: the state file is unreadable. `frost` is the room's frost preset.
 * `settling`: no mode or setpoint is written to the room's valves (R6).
 */
type RoomPlan = Readonly<{
  room: Room;
  week: ResolvedWeek;
  temperature: RoomTemperature;
  fresh: Freshness;
  rm: RoomMemory;
  thermostat: Thermostat | undefined;
  frost: number;
  settling: boolean;
}>;

/**
 * The room's week with its presets resolved, or undefined when the room has no plan: its schedule
 * does not exist or has an empty day.
 */
export function roomWeek(config: Config, room: Room): ResolvedWeek | undefined {
  const schedule = config.schedules.find((s) => s.id === room.scheduleId);
  if (schedule === undefined) return undefined;
  if (WEEKDAYS.some((day) => schedule.defaultWeek[day].length === 0)) return undefined;
  return resolveWeek(schedule.defaultWeek, effectivePresets(config, room));
}

/** An override or off made less than `THERMOSTAT_SETTLE_MS` ago, and not in the future (R6). */
function settles(thermostat: Thermostat | undefined, nowMs: number): boolean {
  if (thermostat === undefined || thermostat.kind === "schedule") return false;
  const age = nowMs - thermostat.since;
  return age >= 0 && age < THERMOSTAT_SETTLE_MS;
}

/**
 * Each room whose schedule exists and has no empty day (`roomWeek`); others are left out. Each
 * plan carries the room's thermostat from `thermostats` (undefined: unreadable).
 */
function planRooms(
  config: Config,
  rooms: readonly Room[],
  world: World,
  nowMs: number,
  thermostats: ThermostatState | undefined,
): ReadonlyMap<string, RoomPlan> {
  const plans = new Map<string, RoomPlan>();
  for (const room of rooms) {
    const week = roomWeek(config, room);
    if (week === undefined) continue;
    const temperature = aggregate(
      room.sensors,
      world.sensors,
      nowMs,
      config.settings.sensorStaleAfterMs,
    );
    const fresh = freshness(room.sensors, temperature);
    const old = world.memory.rooms.get(room.id) ?? { freshSince: undefined };
    const thermostat =
      thermostats === undefined ? undefined : (thermostats.rooms.get(room.id) ?? SCHEDULE);
    plans.set(room.id, {
      room,
      week,
      temperature,
      fresh,
      rm: trackRoom(old, fresh, nowMs),
      thermostat,
      frost: effectivePresets(config, room).frost,
      settling: settles(thermostat, nowMs),
    });
  }
  return plans;
}

/**
 * The thermostat state after the tick's own changes (undefined while unreadable), the same object
 * when nothing changed:
 * - an ended override or off of a planned room that holds a managed valve is back on its schedule;
 * - while the house is live and the config readable, a room that is not resolved is dropped (R16).
 */
function nextThermostats(
  world: World,
  config: Config | undefined,
  resolved: readonly Room[],
  kinds: ReadonlyMap<string, Membership>,
  nowMs: number,
): ThermostatState | undefined {
  const state = world.thermostats;
  if (state === undefined) return undefined;
  const rooms = new Map(state.rooms);
  for (const room of resolved) {
    const thermostat = rooms.get(room.id);
    if (thermostat === undefined || !ended(thermostat, nowMs)) continue;
    const planned = config !== undefined && roomWeek(config, room) !== undefined;
    const managed = room.valves.some(({ valveId }) => kinds.get(valveId) === "managed");
    if (planned && managed) rooms.delete(room.id);
  }
  if (world.house.kind === "live" && config !== undefined) {
    const ids = new Set(resolved.map((room) => room.id));
    for (const roomId of [...rooms.keys()]) if (!ids.has(roomId)) rooms.delete(roomId);
  }
  return rooms.size === state.rooms.size ? state : { rooms, valves: state.valves };
}

/** A valve's memory marked by age, with this tick's desired schedule values noted. */
function scheduleNoted(
  world: World,
  valveId: string,
  spec: ValveSpec,
  week: ResolvedWeek,
  state: DeviceState | undefined,
): ValveMemory {
  const nowMs = world.now.epochMilliseconds;
  const old = world.memory.valves.get(valveId) ?? startMemory(world, valveId, spec);
  const vm = markByAge(old, spec, nowMs);
  return noteAll(vm, spec, managedDesired(spec, week, state, undefined, false));
}

/**
 * Judges every managed valve with a spec of each planned room and adopts a person's change as the
 * room's state (R3–R5). Returns the plans with the adopted thermostats (settling from their start)
 * and each judged valve's judging, with `resend` for a valve whose report, heard after its
 * schedule's last write, shows a point of the week it ran before. Nothing is judged while the
 * state file is unreadable (R10).
 */
function judgeRooms(
  world: World,
  plans: ReadonlyMap<string, RoomPlan>,
  kinds: ReadonlyMap<string, Membership>,
  state: ThermostatState | undefined,
  nowMs: number,
): Readonly<{
  plans: ReadonlyMap<string, RoomPlan>;
  valves: ReadonlyMap<string, ValveThermostat>;
}> {
  const valves = new Map<string, ValveThermostat>();
  if (state === undefined) return { plans, valves };
  const judgedPlans = new Map<string, RoomPlan>();
  const heardSince = new Set<string>();
  for (const [roomId, plan] of plans) {
    const judged: JudgedValve[] = [];
    for (const { valveId } of plan.room.valves) {
      const view = world.devices.get(valveId);
      const spec = view?.spec;
      if (kinds.get(valveId) !== "managed" || view === undefined || spec === undefined) continue;
      const vm = scheduleNoted(world, valveId, spec, plan.week, view.state);
      const expectation = state.valves.get(valveId);
      judged.push(judgedValve(valveId, spec, plan, view.state, vm, expectation, world.now));
      // Only a report heard after the schedule's last write tells that write did not land.
      if (view.state !== undefined && scheduleHeard(vm, spec, view.state)) heardSince.add(valveId);
    }
    const limits = roomLimits(judged.map((j) => j.spec));
    if (plan.thermostat === undefined || limits === undefined) {
      judgedPlans.set(roomId, plan);
      continue;
    }
    const adoption = adopt({
      room: plan.room,
      thermostat: plan.thermostat,
      valves: judged,
      limits,
      week: plan.week,
      now: world.now,
    });
    const thermostat = adoption.thermostat;
    judgedPlans.set(
      roomId,
      thermostat === plan.thermostat
        ? plan
        : { ...plan, thermostat, settling: settles(thermostat, nowMs) },
    );
    for (const j of judged) {
      const expectation = adoption.expectations.get(j.valveId);
      const resend = adoption.resend.has(j.valveId) && heardSince.has(j.valveId);
      if (expectation !== undefined) valves.set(j.valveId, { judged: j, expectation, resend });
    }
  }
  return { plans: judgedPlans, valves };
}

/**
 * The state the tick saves (R22): the planned rooms' thermostats and the run valves'
 * expectations over `given`; while `prune` holds (the house live, the config readable), the
 * expectation of a valve that is not managed is dropped, unless its membership is frozen (R16).
 * `given` itself when nothing changed.
 */
function committed(
  given: ThermostatState,
  plans: ReadonlyMap<string, RoomPlan>,
  expectations: ReadonlyMap<string, ValveExpectation>,
  kinds: ReadonlyMap<string, Membership>,
  prune: boolean,
): ThermostatState {
  let changed = false;
  const rooms = new Map(given.rooms);
  for (const [roomId, plan] of plans) {
    const thermostat = plan.thermostat;
    if (thermostat === undefined || thermostat === (given.rooms.get(roomId) ?? SCHEDULE)) continue;
    if (thermostat.kind === "schedule") rooms.delete(roomId);
    else rooms.set(roomId, thermostat);
    changed = true;
  }
  const valves = new Map(given.valves);
  for (const [valveId, expectation] of expectations) {
    if (given.valves.get(valveId) === expectation) continue;
    valves.set(valveId, expectation);
    changed = true;
  }
  if (prune) {
    for (const valveId of [...valves.keys()]) {
      const kind = kinds.get(valveId);
      if (kind === "managed" || kind === "frozen") continue;
      valves.delete(valveId);
      changed = true;
    }
  }
  return changed ? { rooms, valves } : given;
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

/**
 * A managed valve of a planned room as judged, its expectation after judging, and whether its
 * schedule group is marked to be written again (its new week did not land).
 */
type ValveThermostat = Readonly<{
  judged: JudgedValve;
  expectation: ValveExpectation;
  resend: boolean;
}>;

/** `expectation`: the valve's expectation after the tick (undefined: not judged). */
type ValveRun = Readonly<{
  vm: ValveMemory;
  expectation: ValveExpectation | undefined;
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

/** `noteDesired` for every group of the spec that has a desired key. */
function noteAll(vm: ValveMemory, spec: ValveSpec, desired: Desired): ValveMemory {
  let noted = vm;
  for (const gs of spec.groups) {
    const key = desiredKeyOf(desired, gs.group);
    if (key !== undefined) noted = noteDesired(noted, gs.group, key);
  }
  return noted;
}

/**
 * `managedDesired` with `scheduleTrusted` taken from `vm` once the days are noted, so a changed
 * week counts as unwritten. Returns the desired values and the memory with all of them noted.
 */
function managedFor(
  spec: ValveSpec,
  week: ResolvedWeek,
  state: DeviceState | undefined,
  source: SensorSource | undefined,
  vm: ValveMemory,
): [Desired, ValveMemory] {
  const days = noteAll(vm, spec, managedDesired(spec, week, state, source, false));
  const desired = managedDesired(spec, week, state, source, scheduleTrusted(days, spec));
  return [desired, noteAll(days, spec, desired)];
}

const MODES: readonly ValveMode[] = ["off", "auto", "heat"];

/** The mode and setpoint the valve shows. */
function seenOf(state: DeviceState): ThermostatSeen {
  const { system_mode: mode, setpoint } = state.values;
  return {
    mode: MODES.find((m) => m === mode),
    setpoint: typeof setpoint === "number" ? setpoint : undefined,
  };
}

/** The valve is seen with another schedule group active than the one Heatmaster owns. */
function otherGroupActive(spec: ValveSpec, state: DeviceState | undefined): boolean {
  const active = state?.values.active_group;
  return spec.scheduleGroup !== undefined && active !== undefined && active !== spec.scheduleGroup;
}

/** The saved week, unless the valve is seen with another schedule group active (R23). */
function usableSavedWeek(
  spec: ValveSpec,
  state: DeviceState | undefined,
  saved: SavedWeek | undefined,
): SavedWeek | undefined {
  return otherGroupActive(spec, state) ? undefined : saved;
}

/** A fitted week as its key and its temperatures, as a valve's expectation keeps it (R23). */
function savedOf(days: ResolvedWeek): SavedWeek {
  const values = new Set(WEEKDAYS.flatMap((day) => days[day].map((point) => point.temperature)));
  return { key: weekKey(days), values: [...values].sort((a, b) => a - b) };
}

/** A valve that has shown nothing. */
const NOTHING_SEEN: ThermostatSeen = { mode: undefined, setpoint: undefined };

/**
 * A managed valve of a planned room as it is judged (R4): what it shows, what its adapter is told
 * of its week (R18, R23) and its confirmed week as a key and values (undefined while unconfirmed).
 * `vm` must already have noted this tick's desired schedule values. The expectation's saved week
 * counts only when it was kept for this room. The weeks the valve may still run instead of the
 * desired one are its previous week and a saved week of another key; their points near its
 * `heardAt` are `previousPoints`.
 */
function judgedValve(
  valveId: string,
  spec: ValveSpec,
  plan: RoomPlan,
  state: DeviceState | undefined,
  vm: ValveMemory,
  expectation: ValveExpectation | undefined,
  now: Temporal.ZonedDateTime,
): JudgedValve {
  const days = fitted(plan.week, spec).days;
  const saved = expectation?.roomId === plan.room.id ? expectation.week : undefined;
  const confirmed = confirmedWeek(spec, vm, state, days);
  const key = weekKey(days);
  const ctx: AdapterContext = thermostatContext(
    spec,
    confirmed,
    usableSavedWeek(spec, state, saved),
    days,
    state?.heardAt,
    now,
  );
  const values = ctx.weekValues;
  const week =
    confirmed === undefined || values === undefined
      ? undefined
      : { key, values: [...values].sort((a, b) => a - b) };
  const previous = expectation?.roomId === plan.room.id ? expectation.previous : undefined;
  const others = [previous, saved?.key === key ? undefined : saved].flatMap((w) =>
    w === undefined ? [] : [w],
  );
  return {
    valveId,
    spec,
    seen: state === undefined ? NOTHING_SEEN : seenOf(state),
    heardAt: state?.heardAt,
    expectation,
    ctx,
    week,
    previousPoints: otherGroupActive(spec, state)
      ? undefined
      : savedPointValues(spec, others, state?.heardAt, now.timeZoneId),
  };
}

/**
 * What a managed valve of a planned room is wanted at for the room's state: its frost protection,
 * always; and, while the state is readable, its mode and setpoint (`wanted`) with the adapter's
 * verdict on what it shows (`matches`, undefined without a state).
 */
function thermostatPart(
  spec: ValveSpec,
  plan: RoomPlan,
  judged: JudgedValve | undefined,
  state: DeviceState | undefined,
): Readonly<{
  desired: Desired;
  wanted: ThermostatWanted | undefined;
  matches: boolean | undefined;
}> {
  const frost = frostDesired(spec, plan.frost);
  if (plan.thermostat === undefined || judged === undefined) {
    return { desired: frost, wanted: undefined, matches: undefined };
  }
  const wanted = thermostatWanted(spec, plan.thermostat, judged.ctx);
  return {
    desired: { ...frost, ...thermostatDesired(wanted) },
    wanted,
    matches:
      state === undefined ? undefined : spec.thermostat.matches(wanted, judged.seen, judged.ctx),
  };
}

/**
 * The expectation once the valve matches `wanted` (R22): the wanted state is confirmed, with the
 * setpoint it shows recorded and its week saved (`recorded`, `savedWeek`). Between two scheduled
 * `auto` states it is not replaced: (a) while no week values are known the shown setpoint is
 * recorded; (b) a recorded setpoint that is no value of the confirmed week becomes the shown one;
 * (c) a confirmed week with another key is saved. `e` itself when nothing changes.
 */
function matched(
  judged: JudgedValve,
  e: ValveExpectation,
  wanted: ThermostatWanted,
): ValveExpectation {
  const confirmed = e.confirmed;
  const { seen, ctx, week } = judged;
  if (confirmed !== undefined && scheduledAuto(confirmed) && scheduledAuto(wanted)) {
    let setpoint = confirmed.setpoint;
    if (ctx.weekValues === undefined) setpoint = seen.setpoint;
    else if (week !== undefined && setpoint !== undefined && !week.values.includes(setpoint)) {
      setpoint = seen.setpoint;
    }
    const weekly = week === undefined ? e : withWeek(e, week);
    if (setpoint === confirmed.setpoint) return weekly;
    return { ...weekly, confirmed: { ...confirmed, setpoint } };
  }
  const next = recorded(wanted, judged);
  const weekly = withWeek(e, savedWeek(wanted, e, judged));
  if (confirmed !== undefined && sameWanted(confirmed, next)) return weekly;
  return { ...weekly, confirmed: next };
}

/**
 * The expectation after the tick: confirmed where the valve matches `wanted`, and, when the tick
 * publishes the thermostat group to it, the write first in `sent` (an equal one dropped, at most
 * `SENT_KEPT`) with what the valve showed.
 */
function nextExpectation(
  judged: JudgedValve,
  e: ValveExpectation,
  wanted: ThermostatWanted,
  matches: boolean | undefined,
  published: boolean,
  nowMs: number,
): ValveExpectation {
  const next = matches === true ? matched(judged, e, wanted) : e;
  if (!published) return next;
  const write: SentWrite = { wanted, at: nowMs, from: judged.seen };
  const sent = [write, ...next.sent.filter((s) => !sameWanted(s.wanted, wanted))];
  return { ...next, sent: sent.slice(0, SENT_KEPT) };
}

/**
 * The newest sent write is unconfirmed `SENT_RETIRE_MS` after it was sent, the valve was not
 * heard since then, and it was not asked since then (R4, one ask per write).
 */
function writeUnheard(
  e: ValveExpectation,
  heardAt: number | undefined,
  asks: readonly number[],
  nowMs: number,
): boolean {
  const newest = e.sent[0];
  if (newest === undefined) return false;
  const due = newest.at + SENT_RETIRE_MS;
  return nowMs >= due && (heardAt === undefined || heardAt < due) && !asks.some((at) => at >= due);
}

/**
 * A managed valve's target: its wanted setpoint, or the schedule's value while it is wanted in
 * `auto` without one, or while no state is readable.
 */
function valveTarget(
  wanted: ThermostatWanted | undefined,
  scheduled: number | undefined,
): number | undefined {
  if (wanted === undefined) return scheduled;
  return wanted.setpoint ?? (wanted.mode === "auto" ? scheduled : undefined);
}

/**
 * A publish of the `thermostat` group: one that carries a mode or a setpoint. The runtime holds
 * these, not unsends them, when a save before them failed (R20).
 */
export function isThermostatWrite(effect: Effect): boolean {
  return (
    effect.kind === "publish" &&
    Object.keys(effect.values).some((key) => groupOf(key as SettingKey) === "thermostat")
  );
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

/** A valve's first memory: with the bucket the world says it starts with, when it says. */
function startMemory(world: World, valveId: string, spec: ValveSpec): ValveMemory {
  const nowMs = world.now.epochMilliseconds;
  const fresh = newValveMemory(spec, nowMs);
  const buckets = world.buckets;
  if (buckets === undefined) return fresh;
  const filled = importBucket(fresh, buckets.stamps.get(valveId) ?? buckets.fallback, nowMs);
  const freeAskAt = buckets.freeAsks?.get(valveId) ?? buckets.freeAskFallback;
  return importFreeAsk(filled, freeAskAt, nowMs);
}

/**
 * Runs a managed or releasing valve that has a spec (and, when managed, a planned room).
 * `thermostat` is the managed valve's judging, undefined while the state file is unreadable.
 */
function runValve(
  ctx: Context,
  valveId: string,
  kind: "managed" | "releasing",
  view: DeviceView,
  spec: ValveSpec,
  plan: RoomPlan | undefined,
  thermostat: ValveThermostat | undefined,
): ValveRun {
  const { world, nowMs, held } = ctx;
  const state = view.state;
  const live: Liveness = valveLiveness(world, valveId, state, nowMs);
  let vm = markByAge(
    world.memory.valves.get(valveId) ?? startMemory(world, valveId, spec),
    spec,
    nowMs,
  );
  vm = kind === "managed" ? { ...vm, equalSince: undefined } : { ...vm, nudgeDue: false };
  // The valve still runs the week it ran before: its schedule is written again in full.
  if (thermostat?.resend === true) vm = mark(vm, ["schedule"], nowMs);
  const canRead = transportUsable(world, view, valveId) && live !== "silent";
  const canAct = canRead && !held;
  const readable = spec.groups.some((g) => g.readable);
  const problems: Problem[] = [];
  if (live === "silent") problems.push(problemValveSilent(valveId));

  const week: FittedWeek | undefined = plan === undefined ? undefined : fitted(plan.week, spec);
  const scheduled = week === undefined ? undefined : activePoint(week.days, world.now).temperature;
  const managedPlan = kind === "managed" ? plan : undefined;
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
    const part =
      managedPlan === undefined || week === undefined
        ? undefined
        : thermostatPart(spec, managedPlan, thermostat?.judged, state);
    // A release counts its hold only while the valve is observed.
    if (kind === "releasing") vm = { ...vm, equalSince: undefined };
    vm = withFeedLost(vm, state, nowMs);
    return {
      vm,
      expectation: thermostat?.expectation,
      push: undefined,
      action,
      finished: false,
      live,
      verified: false,
      pending: false,
      target: managedPlan === undefined ? undefined : valveTarget(part?.wanted, scheduled),
      problems,
    };
  }

  const record = world.ledger?.records.get(valveId);
  let desired: Desired = {};
  let wanted: ThermostatWanted | undefined;
  let matches: boolean | undefined;
  if (managedPlan !== undefined && week !== undefined) {
    const source = spec.externalSensor
      ? wantedSource(managedPlan.fresh, managedPlan.rm, vm, nowMs)
      : undefined;
    [desired, vm] = managedFor(spec, managedPlan.week, state, source, vm);
    const part = thermostatPart(spec, managedPlan, thermostat?.judged, state);
    desired = { ...desired, ...part.desired };
    vm = noteAll(vm, spec, part.desired);
    wanted = part.wanted;
    matches = part.matches;
  } else if (kind === "releasing" && record !== undefined) {
    desired = releaseDesired(spec, record);
    vm = noteAll(vm, spec, desired);
  }
  const cands = candidates(spec, desired, state, vm, false, matches);
  // While the room settles, its valves get no mode or setpoint write (R6).
  const settling = managedPlan?.settling === true;
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
  // R4: one ask per write still unconfirmed a minute after it was sent.
  const writeAsk =
    thermostat !== undefined && writeUnheard(thermostat.expectation, state.heardAt, vm.asks, nowMs);
  if (canRead && readable && (needsAsk(vm, spec, state.heardAt) || writeAsk) && mayAsk(vm, nowMs)) {
    action = ask();
  }
  let published = false;
  let scheduleSent = false;
  if (canAct && action === undefined) {
    const pick = cands.find(
      (s) => !(settling && s.group === "thermostat") && mayWrite(vm, s.group, nowMs),
    );
    if (pick !== undefined) {
      action = { kind: "publish", valveId, values: pick.values };
      vm = charge(vm, pick.group, nowMs, pick.marked);
      published = pick.group === "thermostat";
      scheduleSent = pick.group === "schedule";
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
    scheduled !== undefined &&
    !cands.some((s) => s.group === "schedule") &&
    vm.groups.schedule?.mark === undefined &&
    scheduleHeard(vm, spec, state) &&
    mode === "auto" &&
    action === undefined &&
    maySpend(vm, nowMs)
  ) {
    action = { kind: "publishSetpoint", valveId, celsius: scheduled };
    vm = { ...spend(vm, nowMs), nudgeDue: false };
  }

  vm = withFeedLost(vm, state, nowMs);

  let finished = false;
  if (kind === "releasing") {
    // The hold counts only while the valve can be observed: a link that is down hides changes.
    const settled = canRead && cands.length === 0 && !markedDesired;
    const equalSince = settled ? (vm.equalSince ?? nowMs) : undefined;
    vm = { ...vm, equalSince };
    // Counted from the later of the two, so an order stamped by a clock that ran ahead cannot
    // leave an earlier equalSince short of it forever.
    const holdFrom =
      equalSince === undefined || orderedAt === undefined
        ? undefined
        : Math.max(equalSince, orderedAt);
    const holdPassed = holdFrom !== undefined && nowMs - holdFrom >= RELEASE_HOLD_MS;
    // A message heard at the very instant of the order came before it: a tick orders a release
    // after every message up to its now, so only a later one shows the valve after the order.
    const heardAt = state.heardAt;
    const heardSince =
      holdFrom !== undefined &&
      heardAt !== undefined &&
      heardAt >= holdFrom &&
      orderedAt !== undefined &&
      heardAt > orderedAt;
    finished = holdPassed && heardSince;
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
  const next =
    thermostat === undefined || wanted === undefined
      ? thermostat?.expectation
      : nextExpectation(
          thermostat.judged,
          thermostat.expectation,
          wanted,
          matches,
          published,
          nowMs,
        );
  // The week a schedule write carries is kept, so a lost one leaves the week before explained.
  const expectation =
    next === undefined || week === undefined || !scheduleSent
      ? next
      : withWritten(next, savedOf(week.days));
  return {
    vm,
    expectation,
    push,
    action,
    finished,
    live,
    verified: canRead && live === "live",
    pending: cands.length > 0 || markedDesired,
    target: managedPlan === undefined ? undefined : valveTarget(wanted, scheduled),
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
  if (world.thermostats === undefined) problems.push(problemStateUnreadable());
  const house = world.house;
  if (house.kind === "unlinked") problems.push(problemHaLinkRequired());
  if (house.kind === "frozen") problems.push(problemRoomsFrozen(house.reason));
  const hasRoom = house.kind !== "unlinked" && (house.membership?.rooms.size ?? 0) > 0;
  if (world.configState === "ok" && world.stored?.config.schedules.length === 0 && hasRoom) {
    problems.push(problemNoSchedule());
  }
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

/**
 * The stored config with every release ordered after `nowMs` (the clock ran fast) ordered at
 * `nowMs`; undefined when there is none.
 */
function clampReleases(stored: StoredConfig | undefined, nowMs: number): StoredConfig | undefined {
  if (stored === undefined) return undefined;
  if (![...stored.releasing.values()].some((orderedAt) => orderedAt > nowMs)) return undefined;
  const releasing = new Map<string, number>();
  for (const [valveId, orderedAt] of stored.releasing) {
    releasing.set(valveId, Math.min(orderedAt, nowMs));
  }
  return { ...stored, releasing };
}

/** The resolved rooms (none when unlinked) and each valve's membership over them. */
export function membershipsOf(
  world: World,
): Readonly<{ rooms: readonly Room[]; kinds: ReadonlyMap<string, Membership> }> {
  const rooms = roomsOf(world.configState, world.stored, world.house);
  const kinds = memberships(world.configState, world.stored, world.ledger, rooms, world.house.kind);
  return { rooms: rooms ?? [], kinds };
}

/**
 * One control step: `reconcile` first (joins, releases, the saved membership), then the control
 * over the world with the reconciliation's stored config and ledger. The effects are the
 * reconciliation's followed by the control's, so a joining valve's record is saved before any
 * write reaches it.
 */
export function tick(given: World): TickResult {
  const nowMs = given.now.epochMilliseconds;
  const clamp = clampReleases(given.stored, nowMs);
  const world: World = clamp === undefined ? given : { ...given, stored: clamp };
  const reconciled = reconcile(world);
  const result = control(
    { ...world, stored: reconciled.stored, ledger: reconciled.ledger },
    clamp !== undefined,
    reconciled.pending,
  );
  return { ...result, effects: [...reconciled.effects, ...result.effects] };
}

/**
 * Asks a valve that waits to join and is not observable to report, paced as for a managed valve.
 * Returns its memory (undefined when it has none and is not asked) and the ask.
 */
function askPending(
  ctx: Context,
  valveId: string,
  view: DeviceView | undefined,
  live: Liveness,
): Readonly<{ vm: ValveMemory | undefined; action: Effect | undefined }> {
  const { world, nowMs } = ctx;
  const old = world.memory.valves.get(valveId);
  const spec = view?.spec;
  if (view === undefined || spec === undefined || isObservable(view)) {
    return { vm: old, action: undefined };
  }
  const vm = old ?? startMemory(world, valveId, spec);
  const canRead = transportUsable(world, view, valveId) && live !== "silent";
  const readable = spec.groups.some((g) => g.readable);
  if (!canRead || !readable || !mayAsk(vm, nowMs)) return { vm: old, action: undefined };
  return { vm: chargeAsk(vm, spec, nowMs), action: { kind: "refresh", valveId } };
}

/** The control over a reconciled world; `clamped` says a release order was clamped to now. */
function control(world: World, clamped: boolean, pending: readonly Pending[]): TickResult {
  const nowMs = world.now.epochMilliseconds;
  const { rooms: resolved, kinds } = membershipsOf(world);
  const stored = world.stored;
  const held = stored?.config.settings.holdWrites === true;
  const config = world.configState === "ok" ? stored?.config : undefined;
  const expired = nextThermostats(world, config, resolved, kinds, nowMs);
  const planned =
    config === undefined
      ? new Map<string, RoomPlan>()
      : planRooms(config, resolved, world, nowMs, expired);
  const judging = judgeRooms(world, planned, kinds, expired, nowMs);
  const plans = judging.plans;
  const roomOf = roomOfValves(resolved);
  const ctx: Context = { world, nowMs, held, config };
  const expectations = new Map<string, ValveExpectation>();

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
    if (kind === "pending") {
      const live = valveLiveness(world, valveId, view?.state, nowMs);
      const asked = askPending(ctx, valveId, view, live);
      if (asked.vm !== undefined) valves.set(valveId, asked.vm);
      if (asked.action !== undefined) valveEffects.push(asked.action);
      status({ liveness: live });
      continue;
    }
    if (kind === "orphan" || kind === "frozen") {
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

    const run = runValve(ctx, valveId, kind, view, spec, plan, judging.valves.get(valveId));
    valves.set(valveId, run.vm);
    if (run.expectation !== undefined) expectations.set(valveId, run.expectation);
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
  if (stored !== undefined && (dropped.length > 0 || clamped)) {
    const releasing = new Map(stored.releasing);
    for (const valveId of dropped) releasing.delete(valveId);
    saves.push({ kind: "saveConfig", stored: { ...stored, releasing } });
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
    const specs = plan.room.valves.flatMap(({ valveId }) => {
      const spec = kinds.get(valveId) === "managed" ? world.devices.get(valveId)?.spec : undefined;
      return spec === undefined ? [] : [spec];
    });
    rooms.set(
      plan.room.id,
      roomStatus(
        plan.room,
        plan.week,
        plan.temperature,
        plan.fresh,
        valveStatuses,
        world.now,
        plan.thermostat,
        roomLimits(specs),
      ),
    );
  }

  const houseProblems: Problem[] = pending.map(problemValvePending);
  if (world.house.kind === "live") {
    for (const valveId of world.house.notInHa) houseProblems.push(problemValveNotInHa(valveId));
  }

  const thermostats =
    expired === undefined
      ? undefined
      : committed(
          expired,
          plans,
          expectations,
          kinds,
          world.house.kind === "live" && config !== undefined,
        );
  // R20: mode and setpoint writes come after the state is saved, everything else before it.
  const save: Effect[] =
    thermostats === undefined || thermostats === world.thermostats
      ? []
      : [{ kind: "saveThermostats", state: thermostats }];
  return {
    memory: { valves, rooms: roomMemory },
    effects: [
      ...saves,
      ...valveEffects.filter((e) => !isThermostatWrite(e)),
      ...save,
      ...valveEffects.filter(isThermostatWrite),
    ],
    rooms,
    problems: unique([
      ...systemProblems(world, kinds),
      ...roomProblemList,
      ...houseProblems,
      ...valveProblems,
    ]),
    pending,
    thermostats,
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
 * pacing, hold, links and liveness, with pushes assumed sent and each mark satisfied once. Room
 * states are the current ones after expiry; the settle rule holds as in `tick`.
 */
export function preview(world: World): readonly PlannedWrite[] {
  const nowMs = world.now.epochMilliseconds;
  const { rooms: resolved, kinds } = membershipsOf(world);
  const config = world.configState === "ok" ? world.stored?.config : undefined;
  const thermostats = nextThermostats(world, config, resolved, kinds, nowMs);
  const plans =
    config === undefined
      ? new Map<string, RoomPlan>()
      : planRooms(config, resolved, world, nowMs, thermostats);
  const roomOf = roomOfValves(resolved);
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
      let matches: boolean | undefined;
      if (plan !== undefined) {
        const source = !spec.externalSensor
          ? undefined
          : plan.fresh === "stale" || plan.fresh === "no_sensors"
            ? "internal"
            : "external";
        [desired, vm] = managedFor(spec, plan.week, state, source, vm);
        const expectation = world.thermostats?.valves.get(valveId);
        const judged = judgedValve(valveId, spec, plan, state, vm, expectation, world.now);
        const part = thermostatPart(spec, plan, judged, state);
        desired = { ...desired, ...part.desired };
        vm = noteAll(vm, spec, part.desired);
        matches = part.matches;
      } else if (record !== undefined) {
        desired = releaseDesired(spec, record);
        vm = noteAll(vm, spec, desired);
      }
      const settling = plan?.settling === true;
      const first = candidates(spec, desired, state, vm, true, matches).find(
        (s) => !(settling && s.group === "thermostat"),
      );
      if (first === undefined) break;
      writes.push({ valveId, values: first.values, current: currentOf(state, first.values) });
      state = { ...state, values: { ...state.values, ...first.values } };
      // The copy records the write, so a write-only group counts as written.
      vm = withoutMark(charge(vm, first.group, nowMs, first.marked), first.group);
    }
  }
  return writes;
}
