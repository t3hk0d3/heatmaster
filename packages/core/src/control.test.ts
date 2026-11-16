import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import {
  BUILDER_DAY,
  BUILDER_NOW,
  BUILDER_ROOM,
  BUILDER_SCHEDULE,
  BUILDER_VALVE,
  arbConfig,
  makeManaged,
  makeSpec,
  makeState,
  makeWorld,
  points,
  settled,
  weekOf,
} from "../test/builders.ts";
import {
  RELEASE_HOLD_MS,
  RELEASE_STALLED_AFTER_MS,
  candidates,
  isObservable,
  preview,
  tick,
  transportUsable,
} from "./control.ts";
import type { DeviceView, Effect, TickResult, World } from "./control.ts";
import type { Desired } from "./desired.ts";
import { applyEvent } from "./events.ts";
import type { Event } from "./events.ts";
import { EMPTY_LEDGER, memberships, withRecord } from "./ledger.ts";
import type { ConfigState, Ledger, ValveRecord } from "./ledger.ts";
import { START_TOKENS, mark, newValveMemory } from "./memory.ts";
import type { ValveMemory } from "./memory.ts";
import { DEFAULT_SETTINGS } from "./model.ts";
import type { Room, SensorRef, SetPoint } from "./model.ts";
import { newState } from "./observation.ts";
import type { DeviceState } from "./observation.ts";
import { BUCKET, REFILL_MS, charge, chargeAsk, noteDesired } from "./pacing.ts";
import type { ResolvedDay } from "./schedule.ts";
import { DAY_KEYS, EMPTY_READINGS, groupOf } from "./settings.ts";
import type {
  Group,
  Readings,
  SettingKey,
  SettingValue,
  SettingValues,
  ValveSpec,
} from "./settings.ts";
import type { Problem, ProblemKind, ValveStatus } from "./status.ts";
import type { SensorReading } from "./temperature.ts";

const V = BUILDER_VALVE;
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const NOW_MS = BUILDER_NOW.epochMilliseconds;
const DAY_KEY_LIST: readonly SettingKey[] = Object.values(DAY_KEYS);

const OTHER_DAY: ResolvedDay = points("00:00/16 07:00/21 23:00/16");
const THIRD_DAY: ResolvedDay = points("00:00/18");
const SENSOR: SensorRef = { ref: "ha:sensor.hall", weight: 1 };
const SENSOR_ID = "ha:sensor.hall";
const SENSOR_2: SensorRef = { ref: "ha:sensor.living", weight: 1 };
const SENSOR_2_ID = "ha:sensor.living";

/** The seven days, each holding `day`. */
function sevenDays(day: ResolvedDay): SettingValues {
  return Object.fromEntries(DAY_KEY_LIST.map((key) => [key, day]));
}

/** What a TRVZB holds when it equals the desired values of a room without sensors. */
const EQUAL: SettingValues = { ...sevenDays(BUILDER_DAY), sensor_source: "internal" };
/** The same for a TRV-ZBT, active group 3. */
const EQUAL_ZBT: SettingValues = { ...EQUAL, active_group: 3 };

// World helpers ---------------------------------------------------------------------------------

function atTime(nowMs: number): Temporal.ZonedDateTime {
  return Temporal.Instant.fromEpochMilliseconds(nowMs).toZonedDateTimeISO(BUILDER_NOW.timeZoneId);
}

function nowOf(world: World): number {
  return world.now.epochMilliseconds;
}

function later(world: World, ms: number): World {
  return { ...world, now: atTime(nowOf(world) + ms) };
}

/** The world after `result`, `ms` later. */
function next(world: World, result: TickResult, ms: number): World {
  return later({ ...world, memory: result.memory }, ms);
}

function viewOf(world: World, valveId = V): DeviceView {
  const view = world.devices.get(valveId);
  if (view === undefined) throw new Error(`no view for ${valveId}`);
  return view;
}

function stateOf(world: World, valveId = V): DeviceState {
  const state = viewOf(world, valveId).state;
  if (state === undefined) throw new Error(`no state for ${valveId}`);
  return state;
}

function withView(world: World, view: DeviceView | undefined, valveId = V): World {
  const devices = new Map(world.devices);
  if (view === undefined) devices.delete(valveId);
  else devices.set(valveId, view);
  return { ...world, devices };
}

function withState(world: World, state: DeviceState | undefined, valveId = V): World {
  return withView(world, { ...viewOf(world, valveId), state }, valveId);
}

function withValues(world: World, values: SettingValues, valveId = V): World {
  const state = stateOf(world, valveId);
  return withState(world, { ...state, values: { ...state.values, ...values } }, valveId);
}

function withReadings(world: World, readings: Partial<Readings>, valveId = V): World {
  const state = stateOf(world, valveId);
  return withState(world, { ...state, readings: { ...state.readings, ...readings } }, valveId);
}

function withSpec(world: World, spec: ValveSpec, valveId = V): World {
  return withView(world, { ...viewOf(world, valveId), spec }, valveId);
}

function vmOf(world: World | TickResult, valveId = V): ValveMemory {
  const vm = world.memory.valves.get(valveId);
  if (vm === undefined) throw new Error(`no memory for ${valveId}`);
  return vm;
}

function withVm(world: World, vm: ValveMemory, valveId = V): World {
  const valves = new Map(world.memory.valves);
  valves.set(valveId, vm);
  return { ...world, memory: { ...world.memory, valves } };
}

function updateVm(world: World, update: (vm: ValveMemory) => ValveMemory, valveId = V): World {
  return withVm(world, update(vmOf(world, valveId)), valveId);
}

function storedOf(world: World): NonNullable<World["stored"]> {
  if (world.stored === undefined) throw new Error("no stored config");
  return world.stored;
}

function held(world: World): World {
  const stored = storedOf(world);
  const settings = { ...stored.config.settings, holdWrites: true };
  return { ...world, stored: { ...stored, config: { ...stored.config, settings } } };
}

function withRooms(world: World, update: (rooms: readonly Room[]) => readonly Room[]): World {
  const stored = storedOf(world);
  return {
    ...world,
    stored: { ...stored, config: { ...stored.config, rooms: update(stored.config.rooms) } },
  };
}

/** The valve leaves its room and is put in `releasing`, ordered at `orderedAt`. */
function released(world: World, orderedAt = nowOf(world), valveId = V): World {
  const removed = withRooms(world, (rooms) =>
    rooms.map((room) => ({ ...room, valves: room.valves.filter((v) => v.valveId !== valveId) })),
  );
  const stored = storedOf(removed);
  const releasing = new Map(stored.releasing);
  releasing.set(valveId, orderedAt);
  return { ...removed, stored: { ...stored, releasing } };
}

/** The valve goes back into the builder room and leaves `releasing`. */
function readded(world: World, valveId = V): World {
  const added = withRooms(world, (rooms) =>
    rooms.map((room) =>
      room.id === BUILDER_ROOM ? { ...room, valves: [...room.valves, { valveId }] } : room,
    ),
  );
  const stored = storedOf(added);
  const releasing = new Map(stored.releasing);
  releasing.delete(valveId);
  return { ...added, stored: { ...stored, releasing } };
}

function reading(value: number | undefined, seenAgoMs = 0, nowMs = NOW_MS): SensorReading {
  return {
    sensorId: SENSOR_ID,
    value,
    seenAt: value === undefined ? undefined : nowMs - seenAgoMs,
    pending: false,
  };
}

function withSensor(world: World, value: SensorReading, id = SENSOR_ID): World {
  const sensors = new Map(world.sensors);
  sensors.set(id, { ...value, sensorId: id });
  return { ...world, sensors };
}

function freshReading(world: World, value: number): SensorReading {
  return reading(value, 0, nowOf(world));
}

function staleReading(world: World): SensorReading {
  return reading(19, DEFAULT_SETTINGS.sensorStaleAfterMs + HOUR_MS, nowOf(world));
}

const PENDING_READING: SensorReading = {
  sensorId: SENSOR_ID,
  value: undefined,
  seenAt: undefined,
  pending: true,
};

let tokenCount = 0;

/** Delivers a heard message from the valve at `atMs` (the world's now by default). */
function hear(world: World, values: SettingValues = {}, atMs = nowOf(world), valveId = V): World {
  tokenCount += 1;
  const specs = new Map<string, ValveSpec>();
  for (const [id, view] of world.devices) if (view.spec !== undefined) specs.set(id, view.spec);
  const states = new Map<string, DeviceState>();
  for (const [id, view] of world.devices) if (view.state !== undefined) states.set(id, view.state);
  const event: Event = {
    kind: "device_message",
    deviceId: valveId,
    decoded: { values, readings: EMPTY_READINGS },
    lifeToken: `h${String(tokenCount)}`,
  };
  const inbox = applyEvent({ states, memory: world.memory }, event, specs, atMs);
  const view = viewOf(world, valveId);
  return withView(
    { ...world, memory: inbox.memory },
    { ...view, state: inbox.states.get(valveId) },
  );
}

/** Ticks `rounds` times, `stepMs` apart, answering each write with a heard message. */
function drive(world: World, rounds: number, stepMs: number): [World, Effect[]] {
  let current = world;
  const all: Effect[] = [];
  for (let i = 0; i < rounds; i++) {
    const result = tick(current);
    all.push(...result.effects);
    current = { ...current, memory: result.memory };
    for (const effect of result.effects) {
      if (effect.kind === "publish" || effect.kind === "refresh") {
        const values = effect.kind === "publish" ? effect.values : {};
        current = hear(current, values, nowOf(current) + SECOND_MS, effect.valveId);
      }
    }
    current = later(current, stepMs);
  }
  return [current, all];
}

function valveEffects(result: TickResult, valveId = V): readonly Effect[] {
  return result.effects.filter((e) => "valveId" in e && e.valveId === valveId);
}

function kindsOf(effects: readonly Effect[]): readonly string[] {
  return effects.map((e) => e.kind);
}

function publishes(effects: readonly Effect[]): readonly SettingValues[] {
  return effects.flatMap((e) => (e.kind === "publish" ? [e.values] : []));
}

function problemsOf(result: TickResult, kind: ProblemKind): readonly Problem[] {
  return result.problems.filter((p) => p.kind === kind);
}

function statusOf(result: TickResult, valveId = V): ValveStatus {
  for (const room of result.rooms.values()) {
    const found = room.valves.find((v) => v.valveId === valveId);
    if (found !== undefined) return found;
  }
  throw new Error(`no status for ${valveId}`);
}

function saves(result: TickResult): readonly Effect[] {
  return result.effects.filter(
    (e) => e.kind === "saveLedger" || e.kind === "writeOriginalsCopy" || e.kind === "saveConfig",
  );
}

/** Tokens the valve holds at `nowMs`, refill included. */
function tokensAt(vm: ValveMemory, nowMs: number): number {
  return Math.min(BUCKET, vm.tokens + Math.max(0, nowMs - vm.tokensAt) / REFILL_MS);
}

/** A spec whose groups are all unreadable. */
function unreadable(spec: ValveSpec): ValveSpec {
  return { ...spec, groups: spec.groups.map((g) => ({ ...g, readable: false })) };
}

const SETPOINT_SPEC: ValveSpec = { ...makeSpec("trvzb"), activation: "setpoint" };
/** A TRV-ZBT that writes the setpoint after a schedule change; its schedule is write-only. */
const ZBT_SETPOINT_SPEC: ValveSpec = { ...makeSpec("trv_zbt"), activation: "setpoint" };

/** The world with the room's schedule set to `day` on every weekday. */
function withWeekDay(world: World, day: ResolvedDay): World {
  const stored = storedOf(world);
  const week = weekOf(day.map((p) => ({ ...p, preset: undefined })));
  const config = {
    ...stored.config,
    schedules: [{ id: BUILDER_SCHEDULE, name: "Other", defaultWeek: week }],
  };
  return { ...world, stored: { ...stored, config } };
}

/** A schedule group memory with no write recorded for the desired value the tick will note. */
function neverWritten(vm: ValveMemory): ValveMemory {
  return noteDesired(vm, "schedule", "never written");
}

/** A managed TRVZB showing `EQUAL`, settled: no marks. */
function equalWorld(): World {
  return settled(makeManaged({ state: makeState({ values: EQUAL }) }));
}

/** A managed TRVZB in a room with one fresh sensor at 20 °C, settled, so it is being fed. */
function fedWorld(values: SettingValues = EQUAL, readings: Partial<Readings> = {}): World {
  const base = makeManaged({ sensors: [SENSOR], state: makeState({ values, readings }) });
  return settled(withSensor(base, reading(20)));
}

/** `fedWorld` with the room 1 °C warmer at its now, so a push is due. */
function warmer(world: World): World {
  return withSensor(world, freshReading(world, 21));
}

// Candidates helpers ---------------------------------------------------------------------------

const TRVZB = makeSpec("trvzb");
const C0 = NOW_MS - HOUR_MS;

function want(values: SettingValues): Desired {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, { value, reason: "schedule" }]),
  );
}

/** A valve memory with no mark, built at `C0`. */
function unmarkedVm(spec: ValveSpec): ValveMemory {
  let vm = newValveMemory(spec, C0);
  vm = chargeAsk(vm, spec, C0);
  vm = charge(vm, "schedule", C0, true);
  const event: Event = {
    kind: "device_message",
    deviceId: V,
    decoded: { values: {}, readings: EMPTY_READINGS },
    lifeToken: "t1",
  };
  const inbox = applyEvent(
    {
      states: new Map([[V, makeState({ nowMs: C0 })]]),
      memory: { valves: new Map([[V, vm]]), rooms: new Map() },
    },
    event,
    new Map([[V, spec]]),
    C0 + SECOND_MS,
  );
  const result = inbox.memory.valves.get(V);
  if (result === undefined) throw new Error("no memory");
  return result;
}

function heardAt(at: number | undefined, values: SettingValues = EQUAL): DeviceState {
  return { ...makeState({ values }), heardAt: at };
}

// Arbitrary worlds -------------------------------------------------------------------------------

const GROUP_LIST: readonly Group[] = ["schedule", "active_group", "sensor_source"];

const EXTRA_IDS: readonly string[] = ["z2m:0x00000000000000aa", "z2m:0x00000000000000bb", "zz:1"];

const arbDayValue: fc.Arbitrary<SettingValue> = fc.constantFrom(BUILDER_DAY, OTHER_DAY, THIRD_DAY);

const arbValues: fc.Arbitrary<SettingValues> = fc.record(
  {
    ...Object.fromEntries(DAY_KEY_LIST.map((key) => [key, arbDayValue])),
    active_group: fc.integer({ min: 1, max: 3 }),
    sensor_source: fc.constantFrom("internal", "external"),
  } as Record<SettingKey, fc.Arbitrary<SettingValue>>,
  { requiredKeys: [] },
);

const arbReadings: fc.Arbitrary<Readings> = fc.record({
  mode: fc.option(fc.constantFrom("off", "auto", "heat"), { nil: undefined }),
  setpoint: fc.option(
    fc.integer({ min: 8, max: 60 }).map((n) => n / 2),
    { nil: undefined },
  ),
  localTemperature: fc.constant(undefined),
  running: fc.option(fc.boolean(), { nil: undefined }),
  battery: fc.option(fc.integer({ min: 0, max: 100 }), { nil: undefined }),
  feedLost: fc.option(fc.boolean(), { nil: undefined }),
  editGroup: fc.option(fc.integer({ min: 1, max: 3 }), { nil: undefined }),
});

const arbAgo = fc.integer({ min: -MINUTE_MS, max: 30 * HOUR_MS });
/** Mostly recent, so most valves are live and can be written to. */
const arbRecentAgo = fc.oneof(
  { arbitrary: fc.integer({ min: 0, max: HOUR_MS }), weight: 4 },
  { arbitrary: arbAgo, weight: 1 },
);

const arbState: fc.Arbitrary<DeviceState | undefined> = fc.option(
  fc
    .record({
      values: arbValues,
      readings: arbReadings,
      lifeToken: fc.constantFrom("t0", "t0", "t1", undefined),
      heardAgo: fc.option(arbRecentAgo, { nil: undefined, freq: 3 }),
      messageAgo: fc.option(arbRecentAgo, { nil: undefined, freq: 4 }),
      sinceAgo: arbRecentAgo,
    })
    .map((s): DeviceState => ({
      values: s.values,
      readings: s.readings,
      lifeToken: s.lifeToken,
      heardAt: s.heardAgo === undefined ? undefined : NOW_MS - s.heardAgo,
      messageAt: s.messageAgo === undefined ? undefined : NOW_MS - s.messageAgo,
      since: NOW_MS - s.sinceAgo,
    })),
  { nil: undefined },
);

const SPECS: readonly ValveSpec[] = [
  makeSpec("trvzb"),
  makeSpec("trv_zbt"),
  SETPOINT_SPEC,
  unreadable(makeSpec("trv_zbt")),
  { ...makeSpec("trvzb"), feedWhenOff: true },
];

const arbView: fc.Arbitrary<DeviceView | undefined> = fc.option(
  fc.record({
    name: fc.constant("valve"),
    spec: fc.oneof({ arbitrary: fc.constantFrom(...SPECS), weight: 9 }, fc.constant(undefined)),
    usable: fc.oneof({ arbitrary: fc.constant(true), weight: 9 }, fc.constant(false)),
    state: arbState,
  }),
  { nil: undefined, freq: 10 },
);

const arbOriginal = fc.record(
  {
    active_group: fc.option(fc.integer({ min: 1, max: 3 }), { nil: null }),
    sensor_source: fc.option(fc.constantFrom("internal", "external"), { nil: null }),
  },
  { requiredKeys: [] },
);

const arbReading = (id: string): fc.Arbitrary<SensorReading> =>
  fc.record({
    sensorId: fc.constant(id),
    value: fc.option(
      fc.integer({ min: -400, max: 1200 }).map((n) => n / 10),
      { nil: undefined },
    ),
    seenAt: fc.option(
      arbAgo.map((ago) => NOW_MS - ago),
      { nil: undefined },
    ),
    pending: fc.boolean(),
  });

type Run = Readonly<{ world: World; steps: readonly number[] }>;

const arbRun: fc.Arbitrary<Run> = arbConfig.chain((config) => {
  const roomValves = config.rooms.flatMap((room) => room.valves.map((v) => v.valveId));
  const ids = [...roomValves, ...EXTRA_IDS];
  const sensorIds = [...new Set(config.rooms.flatMap((room) => room.sensors.map((s) => s.ref)))];
  return fc
    .record({
      configState: fc.oneof(
        { arbitrary: fc.constant<ConfigState>("ok"), weight: 8 },
        fc.constantFrom<ConfigState>("empty", "unreadable"),
      ),
      hasStored: fc.oneof({ arbitrary: fc.constant(true), weight: 9 }, fc.constant(false)),
      ledgerReadable: fc.oneof({ arbitrary: fc.constant(true), weight: 9 }, fc.constant(false)),
      recorded: fc.subarray(ids),
      originals: fc.array(arbOriginal, { minLength: ids.length, maxLength: ids.length }),
      releasing: fc.subarray(ids),
      releasingAgo: fc.array(fc.integer({ min: 0, max: 10 * HOUR_MS }), {
        minLength: ids.length,
        maxLength: ids.length,
      }),
      views: fc.array(arbView, { minLength: ids.length, maxLength: ids.length }),
      z2m: fc.oneof({ arbitrary: fc.constant(true), weight: 9 }, fc.constantFrom(false, undefined)),
      ha: fc.option(fc.boolean(), { nil: undefined }),
      fault: fc.oneof(
        { arbitrary: fc.constant(undefined), weight: 9 },
        fc.constant("another_instance"),
      ),
      readings: fc.tuple(...sensorIds.map((id) => fc.option(arbReading(id), { nil: undefined }))),
      unobservable: fc.subarray(sensorIds),
      hold: fc.constantFrom(false, false, true),
      marks: fc.array(fc.tuple(fc.nat(ids.length), fc.constantFrom<Group>(...GROUP_LIST)), {
        maxLength: 4,
      }),
      steps: fc.array(
        fc.oneof(
          fc.integer({ min: 0, max: 5 * MINUTE_MS }),
          fc.integer({ min: 0, max: 3 * HOUR_MS }),
        ),
        { minLength: 1, maxLength: 6 },
      ),
    })
    .map((r): Run => {
      const ledgerBase = r.recorded.reduce<Ledger>(
        (ledger, id) =>
          withRecord(ledger, {
            valveId: id,
            profile: "any",
            adoptedAt: NOW_MS - HOUR_MS,
            originals: r.originals[ids.indexOf(id)] ?? {},
          }),
        EMPTY_LEDGER,
      );
      const devices = new Map<string, DeviceView>();
      ids.forEach((id, i) => {
        const view = r.views[i];
        if (view !== undefined) devices.set(id, view);
      });
      const links: Record<string, boolean> = {};
      if (r.z2m !== undefined) links.z2m = r.z2m;
      if (r.ha !== undefined) links.ha = r.ha;
      const sensors = new Map<string, SensorReading>();
      for (const reading of r.readings)
        if (reading !== undefined) sensors.set(reading.sensorId, reading);
      let memory = { valves: new Map<string, ValveMemory>(), rooms: new Map() };
      for (const [index, group] of r.marks) {
        const id = ids[index];
        const spec = id === undefined ? undefined : devices.get(id)?.spec;
        if (id === undefined || spec === undefined) continue;
        const vm = memory.valves.get(id) ?? newValveMemory(spec, NOW_MS - HOUR_MS);
        memory.valves.set(id, mark(vm, [group], NOW_MS - 30 * MINUTE_MS));
      }
      memory = { ...memory };
      const settings = { ...config.settings, holdWrites: r.hold };
      const world: World = {
        configState: r.configState,
        stored: r.hasStored
          ? {
              config: { ...config, settings },
              revision: 3,
              releasing: new Map(
                r.releasing.map((id) => [id, NOW_MS - (r.releasingAgo[ids.indexOf(id)] ?? 0)]),
              ),
            }
          : undefined,
        ledger: r.ledgerReadable ? ledgerBase : undefined,
        devices,
        links,
        transportFaults: r.fault === undefined ? {} : { z2m: r.fault },
        sensors,
        unobservableSensors: new Set(r.unobservable),
        memory,
        now: BUILDER_NOW,
      };
      return { world, steps: r.steps };
    });
});

/**
 * Ticks once per step, carrying the memory, `step` ms apart, and answers each refresh and publish
 * with a heard message a second later; returns each world and its result.
 */
function runAll(world: World, steps: readonly number[]): readonly [World, TickResult][] {
  const out: [World, TickResult][] = [];
  let current = world;
  for (const step of steps) {
    const result = tick(current);
    out.push([current, result]);
    current = { ...current, memory: result.memory };
    for (const effect of result.effects) {
      if (effect.kind !== "publish" && effect.kind !== "refresh") continue;
      const values = effect.kind === "publish" ? effect.values : {};
      if (current.devices.get(effect.valveId) === undefined) continue;
      current = hear(current, values, nowOf(current) + SECOND_MS, effect.valveId);
    }
    current = later(current, Math.max(step, 2 * SECOND_MS));
  }
  return out;
}

describe("control", () => {
  describe("candidates", () => {
    const desired = want(EQUAL);
    describe("With every desired key observed equal and no marks", () => {
      it("returns nothing", () => {
        expect(candidates(TRVZB, desired, heardAt(C0), unmarkedVm(TRVZB))).toEqual([]);
      });
    });
    describe("With schedule and sensor_source both differing", () => {
      const state = heardAt(C0, {
        ...EQUAL,
        day_tue: OTHER_DAY,
        day_fri: OTHER_DAY,
        sensor_source: "external",
      });
      it("returns both, schedule first", () => {
        const result = candidates(TRVZB, desired, state, unmarkedVm(TRVZB));
        expect(result.map((s) => s.group)).toEqual(["schedule", "sensor_source"]);
      });
      it("each holds only its differing keys, with differed true and marked false", () => {
        expect(candidates(TRVZB, desired, state, unmarkedVm(TRVZB))).toEqual([
          {
            group: "schedule",
            values: { day_tue: BUILDER_DAY, day_fri: BUILDER_DAY },
            differed: true,
            marked: false,
          },
          {
            group: "sensor_source",
            values: { sensor_source: "internal" },
            differed: true,
            marked: false,
          },
        ]);
      });
    });
    describe("With a desired key that is not observed", () => {
      it("the key counts as differing", () => {
        const observed = Object.fromEntries(
          Object.entries(EQUAL).filter(([key]) => key !== "day_mon"),
        );
        const result = candidates(TRVZB, desired, heardAt(C0, observed), unmarkedVm(TRVZB));
        expect(result).toEqual([
          { group: "schedule", values: { day_mon: BUILDER_DAY }, differed: true, marked: false },
        ]);
      });
    });
    describe("With a group that has no desired key, marked or not", () => {
      it("the group is not listed", () => {
        const daysOnly = want(sevenDays(BUILDER_DAY));
        const state = heardAt(undefined, { ...EQUAL, sensor_source: "external" });
        const marked = mark(unmarkedVm(TRVZB), ["sensor_source"], C0 + MINUTE_MS);
        expect(candidates(TRVZB, daysOnly, state, unmarkedVm(TRVZB))).toEqual([]);
        expect(candidates(TRVZB, daysOnly, state, marked)).toEqual([]);
        expect(candidates(TRVZB, daysOnly, state, newValveMemory(TRVZB, C0), true)).toEqual([
          { group: "schedule", values: sevenDays(BUILDER_DAY), differed: false, marked: true },
        ]);
      });
    });
    describe("With schedule marked, values equal, and the valve heard at or after the marking", () => {
      it("schedule is listed with marked true, differed false and all seven days", () => {
        const at = C0 + MINUTE_MS;
        const vm = mark(unmarkedVm(TRVZB), ["schedule"], at);
        const expected = [
          { group: "schedule", values: sevenDays(BUILDER_DAY), differed: false, marked: true },
        ];
        expect(candidates(TRVZB, desired, heardAt(at), vm)).toEqual(expected);
        expect(candidates(TRVZB, desired, heardAt(at + 1), vm)).toEqual(expected);
      });
    });
    describe("With schedule marked, values equal, and the valve last heard before the marking, or never", () => {
      it("schedule is not listed", () => {
        const at = C0 + MINUTE_MS;
        const vm = mark(unmarkedVm(TRVZB), ["schedule"], at);
        expect(candidates(TRVZB, desired, heardAt(at - 1), vm)).toEqual([]);
        expect(candidates(TRVZB, desired, heardAt(undefined), vm)).toEqual([]);
      });
    });
    describe("With the same and anyMarkReady true", () => {
      it("schedule is listed with all seven days", () => {
        const at = C0 + MINUTE_MS;
        const vm = mark(unmarkedVm(TRVZB), ["schedule"], at);
        for (const heard of [at - 1, undefined]) {
          const result = candidates(TRVZB, desired, heardAt(heard), vm, true);
          expect(result).toEqual([
            { group: "schedule", values: sevenDays(BUILDER_DAY), differed: false, marked: true },
          ]);
        }
      });
    });
    describe("With schedule marked, the valve not heard since, and one day differing", () => {
      it("schedule is listed with marked true, differed true and all seven days", () => {
        const at = C0 + MINUTE_MS;
        const vm = mark(unmarkedVm(TRVZB), ["schedule"], at);
        const state = heardAt(at - 1, { ...EQUAL, day_wed: OTHER_DAY });
        expect(candidates(TRVZB, desired, state, vm)).toEqual([
          { group: "schedule", values: sevenDays(BUILDER_DAY), differed: true, marked: true },
        ]);
      });
    });
    describe("With sensor_source marked and its value equal", () => {
      it("sensor_source is not listed, with or without anyMarkReady", () => {
        const at = C0 + MINUTE_MS;
        const vm = mark(unmarkedVm(TRVZB), ["sensor_source"], at);
        expect(candidates(TRVZB, desired, heardAt(at + 1), vm)).toEqual([]);
        expect(candidates(TRVZB, desired, heardAt(at + 1), vm, true)).toEqual([]);
      });
    });
    describe("With sensor_source marked and its value differing", () => {
      it("sensor_source is listed with marked false", () => {
        const at = C0 + MINUTE_MS;
        const vm = mark(unmarkedVm(TRVZB), ["sensor_source"], at);
        const state = heardAt(at + 1, { ...EQUAL, sensor_source: "external" });
        expect(candidates(TRVZB, desired, state, vm)).toEqual([
          {
            group: "sensor_source",
            values: { sensor_source: "internal" },
            differed: true,
            marked: false,
          },
        ]);
      });
    });
    describe("With a schedule group whose evidence is none, no write recorded for its desired value, and the days observed equal", () => {
      it("schedule is listed with differed true, marked false and all seven days", () => {
        const zbt = makeSpec("trv_zbt");
        const vm = neverWritten(unmarkedVm(zbt));
        const result = candidates(zbt, want(EQUAL_ZBT), heardAt(C0, EQUAL_ZBT), vm);
        expect(result).toEqual([
          { group: "schedule", values: sevenDays(BUILDER_DAY), differed: true, marked: false },
        ]);
      });
    });
    describe("With a schedule group whose evidence is none, a write recorded, and the days observed differing", () => {
      it("schedule is not listed", () => {
        const zbt = makeSpec("trv_zbt");
        const state = heardAt(C0, { ...EQUAL_ZBT, ...sevenDays(OTHER_DAY) });
        expect(candidates(zbt, want(EQUAL_ZBT), state, unmarkedVm(zbt))).toEqual([]);
      });
    });
  });

  describe("isObservable", () => {
    const spec = makeSpec("trvzb");
    describe("With no DeviceView", () => {
      it("returns false", () => {
        expect(isObservable(undefined)).toBe(false);
      });
    });
    describe("With a DeviceView that has no spec", () => {
      it("returns false", () => {
        expect(isObservable({ name: "x", spec: undefined, usable: true, state: makeState() })).toBe(
          false,
        );
      });
    });
    describe("With a spec and no state", () => {
      it("returns false", () => {
        expect(isObservable({ name: "x", spec, usable: true, state: undefined })).toBe(false);
      });
    });
    describe("With a spec and a state that holds no message", () => {
      it("returns false", () => {
        expect(isObservable({ name: "x", spec, usable: true, state: newState(NOW_MS) })).toBe(
          false,
        );
      });
    });
    describe("With a spec and a state that holds a message", () => {
      it("returns true", () => {
        expect(isObservable({ name: "x", spec, usable: true, state: makeState() })).toBe(true);
      });
    });
  });

  describe("transportUsable", () => {
    const world = makeManaged();
    const view = viewOf(world);
    describe("With the link up, the view usable and no fault", () => {
      it("returns true", () => {
        expect(transportUsable(world, view, V)).toBe(true);
      });
    });
    describe("With the link down or missing from links", () => {
      it("returns false", () => {
        expect(transportUsable({ ...world, links: { z2m: false } }, view, V)).toBe(false);
        expect(transportUsable({ ...world, links: { ha: true } }, view, V)).toBe(false);
      });
    });
    describe("With a DeviceView whose usable is false", () => {
      it("returns false", () => {
        expect(transportUsable(world, { ...view, usable: false }, V)).toBe(false);
      });
    });
    describe("With a fault for the valve's transport", () => {
      it("returns false", () => {
        const faulty = { ...world, transportFaults: { z2m: "another_instance" } };
        expect(transportUsable(faulty, view, V)).toBe(false);
      });
    });
    describe("With a fault for another transport only", () => {
      it("returns true", () => {
        const faulty = { ...world, transportFaults: { other: "broken" } };
        expect(transportUsable(faulty, view, V)).toBe(true);
      });
    });
  });

  describe("tick", () => {
    describe("With a managed TRVZB whose observed days and source equal the desired ones, no marks, and the valve heard", () => {
      it("no effects", () => {
        expect(tick(equalWorld()).effects).toEqual([]);
      });
      it('the valve\'s sync is "in_sync"', () => {
        expect(statusOf(tick(equalWorld())).sync).toBe("in_sync");
      });
    });
    describe("With one day differing and no marks", () => {
      const world = withValues(equalWorld(), { day_tue: OTHER_DAY });
      it("one publish holding only that day", () => {
        expect(valveEffects(tick(world))).toEqual([
          { kind: "publish", valveId: V, values: { day_tue: BUILDER_DAY } },
        ]);
      });
      it("a second tick at the same instant publishes nothing more for that valve", () => {
        const first = tick(world);
        expect(valveEffects(tick({ ...world, memory: first.memory }))).toEqual([]);
      });
    });
    describe("With two days and the sensor source differing", () => {
      it("the first publish holds both days and not the source", () => {
        const world = withValues(equalWorld(), {
          day_mon: OTHER_DAY,
          day_sun: OTHER_DAY,
          sensor_source: "external",
        });
        expect(publishes(valveEffects(tick(world)))).toEqual([
          { day_mon: BUILDER_DAY, day_sun: BUILDER_DAY },
        ]);
      });
    });
    describe("With the schedule group in backoff and the sensor source differing", () => {
      it("the publish holds the sensor source", () => {
        let world = withValues(equalWorld(), { day_mon: OTHER_DAY, sensor_source: "external" });
        world = updateVm(world, (vm) =>
          charge(vm, "schedule", nowOf(world) - 30 * SECOND_MS, false),
        );
        expect(publishes(valveEffects(tick(world)))).toEqual([{ sensor_source: "internal" }]);
      });
    });
    describe("With holdWrites true, a day differing, a fresh room, no marks, and the valve heard", () => {
      const base = fedWorld({ ...EQUAL, sensor_source: "external" });
      const world = held(warmer(withValues(base, { day_thu: OTHER_DAY })));
      it("no publish, no publishSetpoint, no pushTemperature and no refresh", () => {
        // Without the hold the same world publishes and pushes.
        expect(
          kindsOf(valveEffects(tick(warmer(withValues(base, { day_thu: OTHER_DAY }))))),
        ).toEqual(["pushTemperature", "publish"]);
        expect(valveEffects(tick(world))).toEqual([]);
      });
      it("tokens, lastWriteAt, asks, each group's writes, feedValue and feedAt are unchanged", () => {
        const before = vmOf(world);
        const after = vmOf(tick(world));
        expect(after.tokens).toBe(before.tokens);
        expect(after.tokensAt).toBe(before.tokensAt);
        expect(after.lastWriteAt).toBe(before.lastWriteAt);
        expect(after.asks).toEqual(before.asks);
        expect(after.groups.schedule?.writes).toEqual(before.groups.schedule?.writes);
        expect(after.groups.sensor_source?.writes).toEqual(before.groups.sensor_source?.writes);
        expect(after.feedValue).toBe(before.feedValue);
        expect(after.feedAt).toBe(before.feedAt);
      });
      it('the valve\'s sync is "held"', () => {
        expect(statusOf(tick(world)).sync).toBe("held");
      });
    });
    describe("With holdWrites true and sensor_source marked and not yet asked", () => {
      const base = equalWorld();
      const world = held(updateVm(base, (vm) => mark(vm, ["sensor_source"], nowOf(base))));
      it("one refresh and no other effect for the valve", () => {
        expect(valveEffects(tick(world))).toEqual([{ kind: "refresh", valveId: V }]);
      });
      it("one token is taken, asks holds now, and the mark has askedAt now", () => {
        const before = vmOf(world);
        const after = vmOf(tick(world));
        expect(after.tokens).toBeCloseTo(tokensAt(before, nowOf(world)) - 1);
        expect(after.asks).toContain(nowOf(world));
        expect(after.groups.sensor_source?.mark?.askedAt).toBe(nowOf(world));
      });
      it('the valve\'s sync is "held"', () => {
        expect(statusOf(tick(world)).sync).toBe("held");
      });
    });
    describe("With holdWrites true, schedule marked, and the valve heard at or after the marking", () => {
      const base = equalWorld();
      const marked = updateVm(base, (vm) => mark(vm, ["schedule"], nowOf(base) - MINUTE_MS));
      const world = held(hear(marked, {}, nowOf(base) - 30 * SECOND_MS));
      it("no publish and no refresh", () => {
        // Without the hold the same world publishes the seven days.
        expect(kindsOf(valveEffects(tick(hear(marked, {}, nowOf(base) - 30 * SECOND_MS))))).toEqual(
          ["publish"],
        );
        expect(valveEffects(tick(world))).toEqual([]);
      });
      it("the mark has no writtenAt and no token is taken", () => {
        const before = vmOf(world);
        const after = vmOf(tick(world));
        expect(after.groups.schedule?.mark).toBeDefined();
        expect(after.groups.schedule?.mark?.writtenAt).toBeUndefined();
        expect(after.tokens).toBe(before.tokens);
      });
    });
    describe("With holdWrites true, a valve that was being fed, and a room that turned stale", () => {
      it('the feed memory is not cleared and "internal" is not published', () => {
        const base = fedWorld({ ...EQUAL, sensor_source: "external" });
        const world = held(withSensor(base, staleReading(base)));
        const before = vmOf(world);
        const result = tick(world);
        expect(before.feedAt).toBeDefined();
        expect(vmOf(result).feedAt).toBe(before.feedAt);
        expect(vmOf(result).feedValue).toBe(before.feedValue);
        expect(publishes(valveEffects(result))).toEqual([]);
      });
    });
    describe("With the valve's transport link down", () => {
      const base = fedWorld();
      const busy = updateVm(warmer(withValues(base, { day_sat: OTHER_DAY })), (vm) =>
        mark(vm, ["sensor_source"], nowOf(base)),
      );
      const world = { ...busy, links: { z2m: false } };
      it("no publish, no pushTemperature and no refresh", () => {
        expect(valveEffects(tick(busy)).length).toBeGreaterThan(0);
        expect(valveEffects(tick(world))).toEqual([]);
      });
      it('the valve\'s sync is "unverified"', () => {
        expect(statusOf(tick(world)).sync).toBe("unverified");
      });
      it('one link_down problem whose subject id is "z2m"', () => {
        const found = problemsOf(tick(world), "link_down");
        expect(found).toHaveLength(1);
        expect(found[0]?.subject.id).toBe("z2m");
      });
      it("no valve_silent problem, even for a valve last heard 3 h ago", () => {
        const old = withState(world, { ...stateOf(world), heardAt: nowOf(world) - 3 * HOUR_MS });
        expect(problemsOf(tick(old), "valve_silent")).toEqual([]);
        expect(problemsOf(tick({ ...old, links: { z2m: true } }), "valve_silent")).toHaveLength(1);
      });
    });
    describe("With the valve's transport missing from links", () => {
      const world = { ...withValues(equalWorld(), { day_sat: OTHER_DAY }), links: {} };
      it("no effects for the valve", () => {
        expect(valveEffects(tick(world))).toEqual([]);
      });
      it("no link_down problem", () => {
        expect(problemsOf(tick(world), "link_down")).toEqual([]);
      });
    });
    describe("With links holding ha false and z2m true", () => {
      const world = {
        ...withValues(equalWorld(), { day_sat: OTHER_DAY }),
        links: { ha: false, z2m: true },
      };
      it('a link_down problem whose subject id is "ha"', () => {
        expect(problemsOf(tick(world), "link_down").map((p) => p.subject.id)).toEqual(["ha"]);
      });
      it("the valve is still written to", () => {
        expect(kindsOf(valveEffects(tick(world)))).toEqual(["publish"]);
      });
    });
    describe("With everything equal, no marks, and the valve not heard since the start", () => {
      it('no effects and the valve\'s sync is "unverified"', () => {
        const base = equalWorld();
        const world = withState(base, { ...stateOf(base), heardAt: undefined, since: nowOf(base) });
        const result = tick(world);
        expect(result.effects).toEqual([]);
        expect(statusOf(result).sync).toBe("unverified");
      });
    });
    describe("With a silent valve", () => {
      const base = fedWorld();
      const busy = updateVm(warmer(withValues(base, { day_sat: OTHER_DAY })), (vm) =>
        mark(vm, ["sensor_source"], nowOf(base)),
      );
      const world = withState(busy, { ...stateOf(busy), heardAt: nowOf(busy) - 3 * HOUR_MS });
      it("no publish, no pushTemperature and no refresh", () => {
        expect(valveEffects(tick(world))).toEqual([]);
      });
      it("a valve_silent problem", () => {
        expect(problemsOf(tick(world), "valve_silent").map((p) => p.subject.id)).toEqual([V]);
      });
    });
    describe("With a fault for the valve's transport in transportFaults, the DeviceView's usable still true", () => {
      const busy = updateVm(withValues(equalWorld(), { day_sat: OTHER_DAY }), (vm) =>
        mark(vm, ["sensor_source"], NOW_MS),
      );
      const world = { ...busy, transportFaults: { z2m: "another_instance" } };
      it("no publish and no refresh", () => {
        expect(valveEffects(tick(world))).toEqual([]);
      });
      it("one transport_unusable problem for the transport, with the fault as its reason", () => {
        const found = problemsOf(tick(world), "transport_unusable");
        expect(found).toHaveLength(1);
        expect(found[0]?.subject.id).toBe("z2m");
        expect(found[0]?.data.reason).toBe("another_instance");
      });
    });
    describe("With a DeviceView whose usable is false and no entry in transportFaults", () => {
      it("no publish and no refresh", () => {
        const busy = updateVm(withValues(equalWorld(), { day_sat: OTHER_DAY }), (vm) =>
          mark(vm, ["sensor_source"], NOW_MS),
        );
        const world = withView(busy, { ...viewOf(busy), usable: false });
        expect(valveEffects(tick(world))).toEqual([]);
      });
    });
    describe("With a managed valve unknown to its transport", () => {
      const world = withView(makeManaged(), undefined);
      it("no effects for it and a valve_unsupported problem", () => {
        const result = tick(world);
        expect(result.effects).toEqual([]);
        expect(problemsOf(result, "valve_unsupported").map((p) => p.subject.id)).toEqual([V]);
      });
      it("no ValveMemory is created for it", () => {
        expect(tick(world).memory.valves.has(V)).toBe(false);
      });
    });
    describe("With a managed valve that has no DeviceView while its transport's link is down", () => {
      it("no valve_unsupported problem", () => {
        const world = { ...withView(makeManaged(), undefined), links: { z2m: false } };
        expect(problemsOf(tick(world), "valve_unsupported")).toEqual([]);
      });
    });
    describe("With a releasing valve that has no DeviceView", () => {
      it("no effects for it and it is never finished", () => {
        const base = released(equalWorld());
        const world = withView(hear(base, {}, nowOf(base) + MINUTE_MS), undefined);
        for (const offset of [0, RELEASE_HOLD_MS + MINUTE_MS, 2 * RELEASE_HOLD_MS]) {
          expect(tick(later(world, offset)).effects).toEqual([]);
        }
      });
    });
    describe("With membership not_adopted / orphan / frozen", () => {
      it("no effects for the valve and its problem is raised", () => {
        const base = withValues(equalWorld(), { day_sat: OTHER_DAY });
        const cases: readonly [World, ProblemKind][] = [
          [{ ...base, ledger: EMPTY_LEDGER }, "valve_not_adopted"],
          [withRooms(base, () => []), "valve_orphan"],
          [{ ...base, ledger: undefined }, "ledger_unreadable"],
        ];
        for (const [world, kind] of cases) {
          const result = tick(world);
          expect(valveEffects(result)).toEqual([]);
          expect(problemsOf(result, kind)).toHaveLength(1);
        }
      });
    });
    describe('With config state "unreadable" and ledger records', () => {
      it("no effects at all and a config_unreadable problem", () => {
        const world = { ...equalWorld(), configState: "unreadable" as const, stored: undefined };
        const result = tick(world);
        expect(result.effects).toEqual([]);
        expect(problemsOf(result, "config_unreadable")).toHaveLength(1);
      });
    });
    describe("With the ledger unreadable", () => {
      it("no effects at all and a ledger_unreadable problem", () => {
        const world = { ...withValues(equalWorld(), { day_sat: OTHER_DAY }), ledger: undefined };
        const result = tick(world);
        expect(result.effects).toEqual([]);
        expect(problemsOf(result, "ledger_unreadable")).toHaveLength(1);
      });
    });
    describe('With config state "empty", an empty ledger and every link up', () => {
      it("no effects and no problems", () => {
        const world = makeWorld({
          configState: "empty",
          stored: undefined,
          links: { z2m: true, ha: true },
        });
        const result = tick(world);
        expect(result.effects).toEqual([]);
        expect(result.problems).toEqual([]);
      });
    });
    describe("With a managed valve whose DeviceView disappears for one tick", () => {
      it("its ValveMemory and marks are kept", () => {
        const base = equalWorld();
        const marked = updateVm(base, (vm) => mark(vm, ["sensor_source"], nowOf(base)));
        const result = tick(withView(marked, undefined));
        expect(vmOf(result)).toEqual(vmOf(marked));
        expect(vmOf(result).groups.sensor_source?.mark).toBeDefined();
      });
    });
    describe("With a valve that is no longer managed or releasing", () => {
      it("the returned memory holds no ValveMemory for it", () => {
        const world = withRooms(equalWorld(), () => []);
        expect(tick(world).memory.valves.has(V)).toBe(false);
      });
    });
    describe("With a TRV-ZBT whose schedule has never been written, and no marks", () => {
      it("a publish of the seven days and no active_group", () => {
        const values = { ...EQUAL_ZBT, active_group: 1 };
        const base = settled(makeManaged({ model: "trv_zbt", state: makeState({ values }) }));
        const world = updateVm(base, neverWritten);
        expect(vmOf(world).groups.schedule?.mark).toBeUndefined();
        expect(publishes(valveEffects(tick(world)))).toEqual([sevenDays(BUILDER_DAY)]);
      });
    });
    describe("With a TRV-ZBT whose schedule was written and heard since, active group 1, and no marks", () => {
      it("a publish of active_group 3", () => {
        const values = { ...EQUAL_ZBT, active_group: 1 };
        const base = settled(makeManaged({ model: "trv_zbt", state: makeState({ values }) }));
        const first = tick(updateVm(base, neverWritten));
        expect(publishes(valveEffects(first))).toEqual([sevenDays(BUILDER_DAY)]);
        const heard = hear(
          { ...base, memory: first.memory },
          sevenDays(OTHER_DAY),
          nowOf(base) + SECOND_MS,
        );
        const world = later(heard, 3 * SECOND_MS);
        expect(publishes(valveEffects(tick(world)))).toEqual([{ active_group: 3 }]);
      });
    });
    describe("With a TRV-ZBT in sync and the room's week then changed", () => {
      it("a publish of the seven days of the new week", () => {
        const base = settled(
          makeManaged({ model: "trv_zbt", state: makeState({ values: EQUAL_ZBT }) }),
        );
        expect(valveEffects(tick(base))).toEqual([]);
        const world = withWeekDay(base, OTHER_DAY);
        expect(publishes(valveEffects(tick(world)))).toEqual([sevenDays(OTHER_DAY)]);
      });
    });
    describe("With a TRV-ZBT whose state holds day keys that differ from the desired week", () => {
      it("no publish of days: the observed days are not compared", () => {
        const base = settled(
          makeManaged({ model: "trv_zbt", state: makeState({ values: EQUAL_ZBT }) }),
        );
        const world = withValues(base, sevenDays(OTHER_DAY));
        expect(publishes(valveEffects(tick(world)))).toEqual([]);
      });
    });
    describe("With a TRV-ZBT whose schedule is marked and in backoff and whose active group is 1", () => {
      it("no publish of active_group", () => {
        const values = { ...EQUAL_ZBT, active_group: 1 };
        const base = settled(makeManaged({ model: "trv_zbt", state: makeState({ values }) }));
        const t = nowOf(base);
        let world = updateVm(base, (vm) => mark(vm, ["schedule"], t - 2 * MINUTE_MS));
        world = hear(world, {}, t - 90 * SECOND_MS);
        world = updateVm(world, (vm) => charge(vm, "schedule", t - 30 * SECOND_MS, true));
        expect(publishes(valveEffects(tick(world)))).toEqual([]);
      });
    });
  });

  describe("tick — a valve that is not observable", () => {
    describe("With a managed valve whose DeviceView has a spec and no state", () => {
      const world = withState(makeManaged(), undefined);
      it("one refresh for the valve and no other effect for it", () => {
        expect(valveEffects(tick(world))).toEqual([{ kind: "refresh", valveId: V }]);
      });
      it("a ValveMemory is created with every group marked", () => {
        const vm = vmOf(tick(world));
        expect(vm.groups.schedule?.mark).toBeDefined();
        expect(vm.groups.sensor_source?.mark).toBeDefined();
      });
      it("one token is taken, asks holds now, and every readable group's mark has askedAt now", () => {
        const vm = vmOf(tick(world));
        expect(vm.tokens).toBe(START_TOKENS - 1);
        expect(vm.asks).toEqual([NOW_MS]);
        expect(vm.groups.sensor_source?.mark?.askedAt).toBe(NOW_MS);
        expect(vm.groups.schedule?.mark?.askedAt).toBeUndefined();
      });
      it('the valve\'s sync is "unverified"', () => {
        expect(statusOf(tick(world)).sync).toBe("unverified");
      });
    });
    describe("With days differing, a fresh room and no message from the valve since the start", () => {
      it("one refresh and no publish or pushTemperature", () => {
        const base = makeManaged({ sensors: [SENSOR] });
        const state = { ...newState(NOW_MS), values: { day_mon: OTHER_DAY } };
        const world = withSensor(withState(base, state), reading(20));
        expect(valveEffects(tick(world))).toEqual([{ kind: "refresh", valveId: V }]);
      });
    });
    describe("With a releasing valve that has no state", () => {
      it("one refresh and no other effect; it is not finished", () => {
        const base = released(makeManaged(), NOW_MS - HOUR_MS);
        const world = withState(base, undefined);
        expect(tick(world).effects).toEqual([{ kind: "refresh", valveId: V }]);
      });
    });
    function askedWorld(asks: readonly number[]): World {
      const spec = makeSpec("trvzb");
      let vm = newValveMemory(spec, NOW_MS - HOUR_MS);
      for (const at of asks) vm = chargeAsk(vm, spec, at);
      return withVm(withState(makeManaged(), newState(NOW_MS - HOUR_MS)), vm);
    }
    describe("With a valve asked 1 min ago and still not observable", () => {
      it("no refresh", () => {
        expect(valveEffects(tick(askedWorld([NOW_MS - MINUTE_MS])))).toEqual([]);
      });
    });
    describe("With a valve asked 3 min ago and still not observable", () => {
      it("a second refresh", () => {
        expect(valveEffects(tick(askedWorld([NOW_MS - 3 * MINUTE_MS])))).toEqual([
          { kind: "refresh", valveId: V },
        ]);
      });
    });
    describe("With a valve asked twice, the last time 5 min ago / 11 min ago", () => {
      it("no refresh / a refresh", () => {
        const first = NOW_MS - 30 * MINUTE_MS;
        expect(valveEffects(tick(askedWorld([first, NOW_MS - 5 * MINUTE_MS])))).toEqual([]);
        expect(valveEffects(tick(askedWorld([first, NOW_MS - 11 * MINUTE_MS])))).toEqual([
          { kind: "refresh", valveId: V },
        ]);
      });
    });
    describe("With a valve that has no tokens left", () => {
      it("no refresh", () => {
        const spec = makeSpec("trvzb");
        let vm = newValveMemory(spec, NOW_MS - 20 * SECOND_MS);
        for (let i = 0; i < START_TOKENS; i++) {
          vm = charge(vm, "schedule", NOW_MS - (10 - i) * SECOND_MS, false);
        }
        const world = withVm(withState(makeManaged(), newState(NOW_MS - HOUR_MS)), vm);
        expect(valveEffects(tick(world))).toEqual([]);
      });
    });
    describe("With the link down or the transport unusable", () => {
      it("no refresh, and tokens and asks are unchanged", () => {
        const base = askedWorld([NOW_MS - 30 * MINUTE_MS]);
        const worlds: readonly World[] = [
          { ...base, links: { z2m: false } },
          { ...base, transportFaults: { z2m: "another_instance" } },
          withView(base, { ...viewOf(base), usable: false }),
        ];
        for (const world of worlds) {
          const result = tick(world);
          expect(valveEffects(result)).toEqual([]);
          expect(vmOf(result).tokens).toBe(vmOf(base).tokens);
          expect(vmOf(result).asks).toEqual(vmOf(base).asks);
        }
      });
    });
    describe("With writes held", () => {
      const base = withState(makeManaged(), undefined);
      it("one refresh, charged as without the hold, and no other effect", () => {
        const result = tick(held(base));
        expect(valveEffects(result)).toEqual([{ kind: "refresh", valveId: V }]);
        expect(vmOf(result)).toEqual(vmOf(tick(base)));
      });
      it('the valve\'s sync is "held"', () => {
        expect(statusOf(tick(held(base))).sync).toBe("held");
      });
    });
    describe("With a state that holds no message and whose since is 3 h ago", () => {
      const world = withState(makeManaged(), newState(NOW_MS - 3 * HOUR_MS));
      it("no refresh", () => {
        expect(valveEffects(tick(world))).toEqual([]);
      });
      it("a valve_silent problem", () => {
        expect(problemsOf(tick(world), "valve_silent")).toHaveLength(1);
      });
    });
    describe("With a spec that has no readable group and a valve that is not observable", () => {
      const world = withSpec(withState(makeManaged(), undefined), unreadable(makeSpec("trvzb")));
      it("no refresh and no token is taken", () => {
        const result = tick(world);
        expect(valveEffects(result)).toEqual([]);
        expect(vmOf(result).tokens).toBe(START_TOKENS);
      });
      it("asks is unchanged", () => {
        expect(vmOf(tick(world)).asks).toEqual([]);
      });
    });
  });

  describe("tick — marks and refresh", () => {
    describe("With sensor_source marked and not yet asked, values equal, and the valve heard", () => {
      const base = equalWorld();
      const world = updateVm(base, (vm) => mark(vm, ["sensor_source"], nowOf(base)));
      it("one refresh and no publish", () => {
        expect(valveEffects(tick(world))).toEqual([{ kind: "refresh", valveId: V }]);
      });
      it("the mark has askedAt now", () => {
        expect(vmOf(tick(world)).groups.sensor_source?.mark?.askedAt).toBe(nowOf(world));
      });
      it('the valve\'s sync is "pending"', () => {
        expect(statusOf(tick(world)).sync).toBe("pending");
      });
    });
    function askedSource(askedAgoMs: number, values: SettingValues = {}): World {
      const base = withValues(equalWorld(), values);
      const t = nowOf(base);
      return updateVm(base, (vm) =>
        chargeAsk(mark(vm, ["sensor_source"], t - askedAgoMs), makeSpec("trvzb"), t - askedAgoMs),
      );
    }
    describe("With sensor_source marked and asked 1 min ago, nothing heard since", () => {
      it("no refresh and no publish", () => {
        expect(valveEffects(tick(askedSource(MINUTE_MS)))).toEqual([]);
      });
    });
    describe("With sensor_source marked and asked 3 min ago, nothing heard since", () => {
      it("a second refresh", () => {
        expect(valveEffects(tick(askedSource(3 * MINUTE_MS)))).toEqual([
          { kind: "refresh", valveId: V },
        ]);
      });
    });
    describe("With sensor_source marked and asked, then a heard message with an equal value", () => {
      const asked = askedSource(MINUTE_MS);
      const world = later(
        hear(asked, { sensor_source: "internal" }, nowOf(asked) - 30 * SECOND_MS),
        0,
      );
      it("no effects", () => {
        expect(tick(world).effects).toEqual([]);
      });
      it('the valve\'s sync is "in_sync"', () => {
        expect(statusOf(tick(world)).sync).toBe("in_sync");
      });
    });
    describe("With sensor_source marked and asked, then a heard message with a different value", () => {
      it("one publish holding the sensor source only", () => {
        const asked = askedSource(MINUTE_MS);
        const world = hear(asked, { sensor_source: "external" }, nowOf(asked) - 30 * SECOND_MS);
        expect(valveEffects(tick(world))).toEqual([
          { kind: "publish", valveId: V, values: { sensor_source: "internal" } },
        ]);
      });
    });
    describe("With sensor_source marked, not yet asked, and its value differing", () => {
      const base = withValues(equalWorld(), { sensor_source: "external" });
      const world = updateVm(base, (vm) => mark(vm, ["sensor_source"], nowOf(base)));
      it("a refresh and no publish in this tick", () => {
        expect(valveEffects(tick(world))).toEqual([{ kind: "refresh", valveId: V }]);
      });
      it("the next tick, 30 s later, publishes the sensor source", () => {
        const first = tick(world);
        expect(valveEffects(tick(next(world, first, 30 * SECOND_MS)))).toEqual([
          { kind: "publish", valveId: V, values: { sensor_source: "internal" } },
        ]);
      });
    });
    function scheduleMarked(heard: boolean, values: SettingValues = {}): World {
      const base = withValues(equalWorld(), values);
      const t = nowOf(base);
      const marked = updateVm(base, (vm) => mark(vm, ["schedule"], t - MINUTE_MS));
      return heard ? hear(marked, {}, t - 30 * SECOND_MS) : marked;
    }
    describe("With schedule marked, values equal, and the valve heard at or after the marking", () => {
      const world = scheduleMarked(true);
      it("one publish holding all seven days", () => {
        expect(valveEffects(tick(world))).toEqual([
          { kind: "publish", valveId: V, values: sevenDays(BUILDER_DAY) },
        ]);
      });
      it("the mark has writtenAt now", () => {
        expect(vmOf(tick(world)).groups.schedule?.mark?.writtenAt).toBe(nowOf(world));
      });
    });
    describe("With schedule marked, values equal, and the valve not heard since the marking", () => {
      it("a refresh and no publish", () => {
        expect(valveEffects(tick(scheduleMarked(false)))).toEqual([
          { kind: "refresh", valveId: V },
        ]);
      });
    });
    function scheduleAsked(values: SettingValues = {}): World {
      const base = withValues(equalWorld(), values);
      const t = nowOf(base);
      return updateVm(base, (vm) =>
        chargeAsk(mark(vm, ["schedule"], t - 2 * MINUTE_MS), makeSpec("trvzb"), t - MINUTE_MS),
      );
    }
    describe("With schedule marked, the valve not heard since the marking, and a refresh sent 1 min ago", () => {
      it("no effects for the valve", () => {
        expect(valveEffects(tick(scheduleAsked()))).toEqual([]);
      });
    });
    describe("With schedule marked, the valve not heard since the marking, one day differing, and a refresh sent 1 min ago", () => {
      const world = scheduleAsked({ day_wed: OTHER_DAY });
      it("a publish holding all seven days", () => {
        expect(valveEffects(tick(world))).toEqual([
          { kind: "publish", valveId: V, values: sevenDays(BUILDER_DAY) },
        ]);
      });
      it("the mark has writtenAt now", () => {
        expect(vmOf(tick(world)).groups.schedule?.mark?.writtenAt).toBe(nowOf(world));
      });
    });
    /** A new valve, asked and heard, whose schedule was sent for its mark `writtenAgoMs` ago. */
    function schedulePublished(writtenAgoMs: number): World {
      const t0 = NOW_MS - 4 * MINUTE_MS;
      const base = makeManaged({ state: makeState({ values: EQUAL, nowMs: t0 }) });
      const start = { ...base, now: atTime(t0) };
      const asked = tick(start);
      expect(kindsOf(valveEffects(asked))).toEqual(["refresh"]);
      const heardWorld = hear({ ...start, memory: asked.memory }, {}, t0 + 30 * SECOND_MS);
      const writing = { ...heardWorld, now: atTime(NOW_MS - writtenAgoMs) };
      const written = tick(writing);
      expect(publishes(valveEffects(written))).toEqual([sevenDays(BUILDER_DAY)]);
      return { ...writing, memory: written.memory, now: BUILDER_NOW };
    }
    describe("With schedule published for its mark 1 min ago and nothing heard since", () => {
      it("no publish and no refresh", () => {
        expect(valveEffects(tick(schedulePublished(MINUTE_MS)))).toEqual([]);
      });
    });
    describe("With schedule published for its mark 3 min ago and nothing heard since", () => {
      it("the seven days are published again", () => {
        expect(valveEffects(tick(schedulePublished(3 * MINUTE_MS)))).toEqual([
          { kind: "publish", valveId: V, values: sevenDays(BUILDER_DAY) },
        ]);
      });
    });
    describe("With a new managed valve that is observable and heard, values equal", () => {
      const world = makeManaged({ state: makeState({ values: EQUAL, heardAgoMs: MINUTE_MS }) });
      it("a ValveMemory is created with every group marked", () => {
        const vm = vmOf(tick(world));
        expect(vm.groups.schedule?.mark).toBeDefined();
        expect(vm.groups.sensor_source?.mark).toBeDefined();
      });
      it("a refresh and no publish", () => {
        expect(valveEffects(tick(world))).toEqual([{ kind: "refresh", valveId: V }]);
      });
    });
    describe("With a group asserted 25 h ago and no mark", () => {
      it("the group is marked", () => {
        const base = equalWorld();
        let world = base;
        // Heard every hour, so the valve never turns silent.
        for (let hour = 1; hour <= 25; hour++) {
          world = hear(world, {}, nowOf(base) + hour * HOUR_MS - MINUTE_MS);
        }
        world = later(world, 25 * HOUR_MS);
        expect(vmOf(world).groups.schedule?.mark).toBeUndefined();
        expect(vmOf(tick(world)).groups.schedule?.mark).toBeDefined();
      });
    });
    describe("With a mark on a group that has no desired key", () => {
      it('the valve\'s sync is not "pending" because of it', () => {
        const base = settled(
          withSensor(
            makeManaged({ sensors: [SENSOR], state: makeState({ values: EQUAL }) }),
            PENDING_READING,
          ),
        );
        const world = updateVm(base, (vm) => mark(vm, ["sensor_source"], nowOf(base)));
        expect(statusOf(tick(world)).sync).toBe("in_sync");
      });
    });
    describe("With a refresh due, a day differing and nudgeDue set", () => {
      it("the valve gets the refresh and neither a publish nor a publishSetpoint", () => {
        const base = withSpec(
          makeManaged({ state: makeState({ values: EQUAL, readings: { mode: "auto" } }) }),
          SETPOINT_SPEC,
        );
        const world = withValues(settled(base), { day_mon: OTHER_DAY });
        const first = tick(world);
        expect(vmOf(first).nudgeDue).toBe(true);
        const second = updateVm(next(world, first, 3 * MINUTE_MS), (vm) =>
          mark(vm, ["sensor_source"], nowOf(world)),
        );
        expect(valveEffects(tick(second))).toEqual([{ kind: "refresh", valveId: V }]);
      });
    });
    describe("With a temperature push due and a refresh due", () => {
      it("the valve gets both, the push first", () => {
        const base = warmer(fedWorld());
        const world = updateVm(base, (vm) => mark(vm, ["sensor_source"], nowOf(base)));
        expect(kindsOf(valveEffects(tick(world)))).toEqual(["pushTemperature", "refresh"]);
      });
    });
    describe("With a spec that has no readable group, schedule marked, and the valve not heard since the marking", () => {
      const spec = unreadable(makeSpec("trvzb"));
      const world = withSpec(
        makeManaged({ state: makeState({ values: EQUAL, heardAgoMs: 5 * MINUTE_MS }) }),
        spec,
      );
      it("no refresh and no token is taken", () => {
        const result = tick(world);
        expect(valveEffects(result)).toEqual([]);
        expect(vmOf(result).tokens).toBe(START_TOKENS);
      });
      it("once the valve was heard, the seven days are published", () => {
        const first = tick(world);
        const heardWorld = hear({ ...world, memory: first.memory }, {}, NOW_MS + SECOND_MS);
        expect(valveEffects(tick(later(heardWorld, 3 * SECOND_MS)))).toEqual([
          { kind: "publish", valveId: V, values: sevenDays(BUILDER_DAY) },
        ]);
      });
    });
  });

  describe("tick — temperature", () => {
    describe("With a managed valve, a fresh room and nothing pushed yet", () => {
      it("a pushTemperature with the room temperature", () => {
        const base = makeManaged({ sensors: [SENSOR], state: makeState({ values: EQUAL }) });
        const world = withSensor(base, reading(20.4));
        expect(valveEffects(tick(world))).toContainEqual({
          kind: "pushTemperature",
          valveId: V,
          celsius: 20.4,
        });
      });
    });
    describe("With a push 2 min ago and a change of 0.5", () => {
      it("no pushTemperature", () => {
        const base = warmer(fedWorld());
        const first = tick(base);
        expect(kindsOf(valveEffects(first))).toContain("pushTemperature");
        const world = next(base, first, 2 * MINUTE_MS);
        const changed = withSensor(world, freshReading(world, 21.5));
        expect(kindsOf(valveEffects(tick(changed)))).not.toContain("pushTemperature");
      });
    });
    describe("With a valve whose mode is off and feedWhenOff false", () => {
      it("no pushTemperature", () => {
        const world = warmer(fedWorld(EQUAL, { mode: "off" }));
        expect(kindsOf(valveEffects(tick(world)))).not.toContain("pushTemperature");
      });
    });
    describe("With a spec whose externalSensor is false", () => {
      it("no pushTemperature and the sensor source is never written", () => {
        // The spec keeps its sensor_source group, so only externalSensor stops the writes.
        const spec: ValveSpec = { ...makeSpec("trvzb"), externalSensor: false };
        const base = makeManaged({
          sensors: [SENSOR],
          state: makeState({ values: { ...EQUAL, sensor_source: "external" }, heardAgoMs: 0 }),
        });
        const world = withSensor(withSpec(base, spec), reading(20));
        const [, effects] = drive(world, 10, 5 * MINUTE_MS);
        expect(kindsOf(effects)).not.toContain("pushTemperature");
        expect(publishes(effects).some((v) => "sensor_source" in v)).toBe(false);
        // Stale and fresh again: still never written.
        const stale = withSensor(
          later(world, 3 * HOUR_MS),
          staleReading(later(world, 3 * HOUR_MS)),
        );
        const [, more] = drive(hear(stale, {}, nowOf(stale)), 3, 5 * MINUTE_MS);
        expect(publishes(more).some((v) => "sensor_source" in v)).toBe(false);
      });
    });
    describe("With a room that turned stale", () => {
      const base = fedWorld({ ...EQUAL, sensor_source: "external" });
      const world = withSensor(base, staleReading(base));
      it('no pushTemperature, the feed memory is cleared, and "internal" is published', () => {
        const result = tick(world);
        expect(vmOf(world).feedAt).toBeDefined();
        expect(kindsOf(valveEffects(result))).not.toContain("pushTemperature");
        expect(vmOf(result).feedAt).toBeUndefined();
        expect(vmOf(result).feedValue).toBeUndefined();
        expect(publishes(valveEffects(result))).toEqual([{ sensor_source: "internal" }]);
      });
    });
    describe("With a room fresh for 10 min and a push sent", () => {
      it('"external" is published', () => {
        const world = fedWorld();
        expect(publishes(valveEffects(tick(world)))).toEqual([{ sensor_source: "external" }]);
      });
    });
    describe("With a room fresh for 3 min", () => {
      it("the sensor source is not written", () => {
        const base = makeManaged({ sensors: [SENSOR], state: makeState({ values: EQUAL }) });
        const stale = settled(withSensor(base, staleReading(base)));
        const fresh = withSensor(stale, freshReading(stale, 20));
        const first = tick(fresh);
        expect(kindsOf(valveEffects(first))).toContain("pushTemperature");
        const world = next(fresh, first, 3 * MINUTE_MS);
        const result = tick(withSensor(world, freshReading(world, 20)));
        expect(publishes(valveEffects(result))).toEqual([]);
      });
    });
    describe("With a room that turned pending and became fresh again 30 s after a push", () => {
      it("no pushTemperature", () => {
        const base = warmer(fedWorld());
        const first = tick(base);
        expect(kindsOf(valveEffects(first))).toContain("pushTemperature");
        const pendingWorld = withSensor(next(base, first, 10 * SECOND_MS), PENDING_READING);
        const second = tick(pendingWorld);
        const world = next(pendingWorld, second, 20 * SECOND_MS);
        const result = tick(withSensor(world, freshReading(world, 23)));
        expect(kindsOf(valveEffects(result))).not.toContain("pushTemperature");
      });
    });
    describe("With a room whose sensors are pending", () => {
      const base = makeManaged({
        sensors: [SENSOR],
        state: makeState({ values: { ...EQUAL, sensor_source: "external" } }),
      });
      const world = settled(withSensor(base, PENDING_READING));
      it("the sensor source is not written and the room is not degraded", () => {
        const result = tick(world);
        expect(publishes(valveEffects(result))).toEqual([]);
        expect(result.rooms.get(BUILDER_ROOM)?.degraded).toBe(false);
      });
    });
    describe("With a valve that is being fed and shows its feed lost for 61 min", () => {
      it("a feed_lost problem", () => {
        const base = fedWorld(EQUAL, { feedLost: true });
        const first = tick(base);
        expect(problemsOf(first, "feed_lost")).toEqual([]);
        const world = next(base, first, 61 * MINUTE_MS);
        const result = tick(withSensor(world, freshReading(world, 20)));
        expect(problemsOf(result, "feed_lost").map((p) => p.subject.id)).toEqual([V]);
      });
    });
    describe("With a valve that is off, not fed, and shows its feed lost", () => {
      it("no feed_lost problem", () => {
        const base = fedWorld(EQUAL, { feedLost: true, mode: "off" });
        const first = tick(base);
        const world = next(base, first, 61 * MINUTE_MS);
        const result = tick(withSensor(world, freshReading(world, 20)));
        expect(problemsOf(result, "feed_lost")).toEqual([]);
      });
    });
  });

  describe("tick — room problems", () => {
    describe("With a week above the valve's maximum", () => {
      it("a schedule_clamped problem with the valve's range", () => {
        const hot: readonly SetPoint[] = [
          { time: Temporal.PlainTime.from("00:00"), preset: undefined, temperature: 32 },
        ];
        const base = makeManaged({ model: "trv_zbt" });
        const stored = storedOf(base);
        const config = {
          ...stored.config,
          schedules: [{ id: BUILDER_SCHEDULE, name: "Hot", defaultWeek: weekOf(hot) }],
        };
        const world = { ...base, stored: { ...stored, config } };
        const found = problemsOf(tick(world), "schedule_clamped");
        expect(found).toHaveLength(1);
        expect(found[0]?.subject.id).toBe(V);
        expect(found[0]?.data).toEqual({ min: "5", max: "30" });
      });
    });
    describe("With a room whose sensors are all stale", () => {
      it("a room_no_temperature problem and a sensor_stale problem per sensor", () => {
        const base = makeManaged({ sensors: [SENSOR, SENSOR_2] });
        const world = withSensor(
          withSensor(base, staleReading(base)),
          staleReading(base),
          SENSOR_2_ID,
        );
        const result = tick(world);
        expect(problemsOf(result, "room_no_temperature").map((p) => p.subject.id)).toEqual([
          BUILDER_ROOM,
        ]);
        expect(problemsOf(result, "sensor_stale").map((p) => p.subject.id)).toEqual([
          SENSOR_ID,
          SENSOR_2_ID,
        ]);
      });
    });
    describe("With a sensor reading 60 °C", () => {
      it("a sensor_out_of_range problem", () => {
        const world = withSensor(makeManaged({ sensors: [SENSOR] }), reading(60));
        expect(problemsOf(tick(world), "sensor_out_of_range").map((p) => p.subject.id)).toEqual([
          SENSOR_ID,
        ]);
      });
    });
    describe("With a sensor listed in unobservableSensors", () => {
      it("a sensor_liveness_unobservable problem", () => {
        const base = withSensor(makeManaged({ sensors: [SENSOR_2] }), reading(20), SENSOR_2_ID);
        const world = { ...base, unobservableSensors: new Set([SENSOR_2_ID]) };
        const found = problemsOf(tick(world), "sensor_liveness_unobservable");
        expect(found.map((p) => p.subject.id)).toEqual([SENSOR_2_ID]);
      });
    });
    describe("With a group that notHolding lists", () => {
      const base = equalWorld();
      const t = nowOf(base);
      const world = updateVm(base, (vm) => {
        let next = vm;
        for (const ago of [3 * HOUR_MS, 2 * HOUR_MS, HOUR_MS]) {
          next = charge(next, "sensor_source", t - ago, false);
        }
        return next;
      });
      it('a setting_not_holding problem naming the setting, and the valve\'s sync is "not_holding"', () => {
        const result = tick(world);
        const found = problemsOf(result, "setting_not_holding");
        expect(found.map((p) => p.data.setting)).toEqual(["sensor_source"]);
        expect(statusOf(result).sync).toBe("not_holding");
      });
    });
  });

  describe("tick — status", () => {
    describe("With a managed, heard valve whose readings show mode auto, setpoint 20, running true and battery 80", () => {
      const readings = { mode: "auto", setpoint: 20, running: true, battery: 80 } as const;
      const world = settled(makeManaged({ state: makeState({ values: EQUAL, readings }) }));
      it('its ValveStatus holds those four values, the DeviceView\'s name and liveness "live"', () => {
        const status = statusOf(tick(world));
        expect(status).toMatchObject({
          mode: "auto",
          setpoint: 20,
          running: true,
          battery: 80,
          name: "Living room valve",
          liveness: "live",
        });
      });
      it("its target is the active set point of its fitted week", () => {
        expect(statusOf(tick(world)).target).toBe(20);
      });
      it("the room's heating is true", () => {
        expect(tick(world).rooms.get(BUILDER_ROOM)?.heating).toBe(true);
      });
    });
    describe("With a managed valve that has no DeviceView", () => {
      it('its ValveStatus has the valve id as its name, liveness "unknown" and no readings', () => {
        const status = statusOf(tick(withView(makeManaged(), undefined)));
        expect(status).toMatchObject({
          name: V,
          liveness: "unknown",
          mode: undefined,
          setpoint: undefined,
          running: undefined,
          battery: undefined,
        });
      });
    });
    describe("With a not_adopted valve in a room, last heard 3 h ago", () => {
      const base = makeManaged({ state: makeState({ heardAgoMs: 3 * HOUR_MS }) });
      const world = { ...base, ledger: EMPTY_LEDGER };
      it('its ValveStatus has liveness "silent"', () => {
        expect(statusOf(tick(world))).toMatchObject({
          membership: "not_adopted",
          liveness: "silent",
        });
      });
      it("no valve_silent problem", () => {
        expect(problemsOf(tick(world), "valve_silent")).toEqual([]);
      });
    });
    describe("With a releasing valve", () => {
      it("no room's status holds a ValveStatus for it", () => {
        const result = tick(released(equalWorld()));
        const all = [...result.rooms.values()].flatMap((r) => r.valves.map((v) => v.valveId));
        expect(all).not.toContain(V);
      });
    });
    describe("With a managed, heard valve whose mode is heat or off", () => {
      it("a valve_not_auto problem naming the mode", () => {
        for (const mode of ["heat", "off"] as const) {
          const world = withReadings(equalWorld(), { mode });
          const found = problemsOf(tick(world), "valve_not_auto");
          expect(found.map((p) => p.data.mode)).toEqual([mode]);
        }
      });
    });
    describe("With a managed valve that shows no mode, or a releasing valve in heat", () => {
      it("no valve_not_auto problem", () => {
        expect(problemsOf(tick(equalWorld()), "valve_not_auto")).toEqual([]);
        const releasing = released(withReadings(equalWorld(), { mode: "heat" }));
        expect(problemsOf(tick(releasing), "valve_not_auto")).toEqual([]);
      });
    });
  });

  describe("tick — activation", () => {
    function activationWorld(spec: ValveSpec, mode: "auto" | "heat" | "off" = "auto"): World {
      const base = makeManaged({ state: makeState({ values: EQUAL, readings: { mode } }) });
      return withValues(settled(withSpec(base, spec)), { day_mon: OTHER_DAY });
    }
    /** Publishes the differing day, then hears it echoed; returns the world 3 s after the publish. */
    function afterDayWrite(world: World): [World, TickResult] {
      const first = tick(world);
      const echoed = hear(
        { ...world, memory: first.memory },
        { day_mon: BUILDER_DAY },
        nowOf(world) + SECOND_MS,
      );
      return [later(echoed, 3 * SECOND_MS), first];
    }
    describe('With activation "setpoint", after a publish of differing days and then days observed equal, mode auto', () => {
      const [world, first] = afterDayWrite(activationWorld(SETPOINT_SPEC));
      it("one publishSetpoint with the active set point's temperature", () => {
        expect(kindsOf(valveEffects(first))).toEqual(["publish"]);
        expect(valveEffects(tick(world))).toEqual([
          { kind: "publishSetpoint", valveId: V, celsius: 20 },
        ]);
      });
      it("no second publishSetpoint on the next tick", () => {
        const second = tick(world);
        expect(valveEffects(tick(next(world, second, 3 * SECOND_MS)))).toEqual([]);
      });
    });
    describe('With activation "setpoint" and a schedule publish caused only by a mark', () => {
      it("no publishSetpoint", () => {
        const base = settled(
          withSpec(
            makeManaged({ state: makeState({ values: EQUAL, readings: { mode: "auto" } }) }),
            SETPOINT_SPEC,
          ),
        );
        const t = nowOf(base);
        const world = hear(
          updateVm(base, (vm) => mark(vm, ["schedule"], t - MINUTE_MS)),
          {},
          t - 30 * SECOND_MS,
        );
        const [, effects] = drive(world, 4, 3 * SECOND_MS);
        expect(kindsOf(effects)).toContain("publish");
        expect(kindsOf(effects)).not.toContain("publishSetpoint");
      });
    });
    describe('With activation "none"', () => {
      it("never a publishSetpoint", () => {
        const [, effects] = drive(activationWorld(makeSpec("trvzb")), 5, 3 * SECOND_MS);
        expect(kindsOf(effects)).toContain("publish");
        expect(kindsOf(effects)).not.toContain("publishSetpoint");
      });
    });
    describe("With nudgeDue and the valve in heat or off", () => {
      it("no publishSetpoint", () => {
        for (const mode of ["heat", "off"] as const) {
          const [world, first] = afterDayWrite(activationWorld(SETPOINT_SPEC, mode));
          expect(vmOf(first).nudgeDue).toBe(true);
          expect(valveEffects(tick(world))).toEqual([]);
        }
      });
    });
    /** nudgeDue set, the days echoed equal, then schedule marked and asked 1 min later, unheard. */
    function nudgedAndMarked(): World {
      const [world, first] = afterDayWrite(activationWorld(SETPOINT_SPEC));
      expect(vmOf(first).nudgeDue).toBe(true);
      const t = nowOf(world);
      const marked = updateVm(world, (vm) =>
        chargeAsk(mark(vm, ["schedule"], t - SECOND_MS), SETPOINT_SPEC, t - SECOND_MS),
      );
      return later(marked, MINUTE_MS);
    }
    describe("With nudgeDue and the schedule still marked", () => {
      it("no publishSetpoint", () => {
        expect(kindsOf(valveEffects(tick(nudgedAndMarked())))).not.toContain("publishSetpoint");
      });
    });
    describe("With nudgeDue, the schedule marked and observed equal, the valve not heard since the marking, and a refresh sent 1 min ago", () => {
      it("no publishSetpoint and no refresh", () => {
        expect(valveEffects(tick(nudgedAndMarked()))).toEqual([]);
      });
    });
    describe('With nudgeDue set and a spec whose activation is "none"', () => {
      it("no publishSetpoint", () => {
        const [world, first] = afterDayWrite(activationWorld(SETPOINT_SPEC));
        expect(vmOf(first).nudgeDue).toBe(true);
        expect(kindsOf(valveEffects(tick(world)))).toEqual(["publishSetpoint"]);
        const stale = withSpec(world, makeSpec("trvzb"));
        expect(vmOf(stale).nudgeDue).toBe(true);
        expect(valveEffects(tick(stale))).toEqual([]);
      });
    });
    describe('With activation "setpoint" on a write-only schedule (evidence "none"), after a publish of the new week, mode auto', () => {
      const base = settled(
        withSpec(
          makeManaged({
            model: "trv_zbt",
            state: makeState({ values: EQUAL_ZBT, readings: { mode: "auto" } }),
          }),
          ZBT_SETPOINT_SPEC,
        ),
      );
      const changed = withWeekDay(base, OTHER_DAY);
      const first = tick(changed);
      const unheard = later({ ...changed, memory: first.memory }, 3 * SECOND_MS);
      it("no publishSetpoint before a heard message follows the write", () => {
        expect(publishes(valveEffects(first))).toEqual([sevenDays(OTHER_DAY)]);
        expect(vmOf(first).nudgeDue).toBe(true);
        expect(valveEffects(tick(unheard))).toEqual([]);
      });
      it("no publishSetpoint for a message heard at the very moment of the write", () => {
        const sameInstant = hear(unheard, {}, nowOf(changed));
        expect(valveEffects(tick(sameInstant))).toEqual([]);
      });
      it("one publishSetpoint with the active set point's temperature once a message is heard after the write", () => {
        const heard = hear(unheard, {}, nowOf(changed) + SECOND_MS);
        expect(valveEffects(tick(heard))).toEqual([
          { kind: "publishSetpoint", valveId: V, celsius: 21 },
        ]);
      });
    });
    describe("With a releasing valve", () => {
      it("never a publishSetpoint and nudgeDue is false", () => {
        const world = activationWorld(SETPOINT_SPEC);
        const first = tick(world);
        expect(vmOf(first).nudgeDue).toBe(true);
        const releasing = released(
          hear(
            { ...world, memory: first.memory },
            { day_mon: BUILDER_DAY },
            nowOf(world) + SECOND_MS,
          ),
        );
        const later3 = later(releasing, 3 * SECOND_MS);
        const result = tick(later3);
        expect(vmOf(result).nudgeDue).toBe(false);
        const [, effects] = drive(later3, 4, 3 * SECOND_MS);
        expect(kindsOf(effects)).not.toContain("publishSetpoint");
      });
    });
  });

  describe("tick — release", () => {
    /** An equal TRVZB released now; the first tick after the order is at the world's now. */
    function releasedEqual(): World {
      return released(equalWorld());
    }
    describe("With a releasing TRVZB whose sensor source differs from the original", () => {
      const world = released(fedWorld({ ...EQUAL, sensor_source: "external" }));
      it("a publish of the original source", () => {
        expect(publishes(valveEffects(tick(world)))).toEqual([{ sensor_source: "internal" }]);
      });
      it("no pushTemperature", () => {
        expect(kindsOf(valveEffects(tick(warmer(world))))).not.toContain("pushTemperature");
      });
    });
    describe("With a releasing TRVZB whose days differ from the room's old schedule", () => {
      it("the days are never published", () => {
        const world = released(withValues(equalWorld(), sevenDays(THIRD_DAY)));
        const [, effects] = drive(world, 10, 3 * MINUTE_MS);
        expect(publishes(effects).some((v) => DAY_KEY_LIST.some((k) => k in v))).toBe(false);
      });
    });
    describe("With a releasing TRV-ZBT", () => {
      it("only active_group and sensor_source are ever published", () => {
        const base = settled(
          makeManaged({ model: "trv_zbt", state: makeState({ values: EQUAL_ZBT }) }),
        );
        const world = released(
          withValues(base, { ...sevenDays(THIRD_DAY), sensor_source: "external" }),
        );
        const [, effects] = drive(world, 10, 3 * MINUTE_MS);
        const keys = new Set(publishes(effects).flatMap((v) => Object.keys(v)));
        expect([...keys].sort()).toEqual(["active_group", "sensor_source"]);
      });
    });
    describe("With everything equal for 5 min", () => {
      it("no saves", () => {
        const world = releasedEqual();
        const first = tick(world);
        expect(saves(tick(next(world, first, 5 * MINUTE_MS)))).toEqual([]);
      });
    });
    /** Equal since the order at T, heard at T + 1 min, schedule marked at T + 2 min; at T + 15 min. */
    function heldFifteen(): World {
      const world = releasedEqual();
      const t = nowOf(world);
      const first = tick(world);
      const heardWorld = hear({ ...world, memory: first.memory }, {}, t + MINUTE_MS);
      const marked = updateVm(heardWorld, (vm) => mark(vm, ["schedule"], t + 2 * MINUTE_MS));
      return later(marked, RELEASE_HOLD_MS);
    }
    describe("With everything equal for 15 min and the valve heard during that time", () => {
      it("saveLedger without the record, then writeOriginalsCopy, then saveConfig without the valve in releasing", () => {
        const world = heldFifteen();
        const result = tick(world);
        const found = saves(result);
        expect(kindsOf(found)).toEqual(["saveLedger", "writeOriginalsCopy", "saveConfig"]);
        const [ledgerSave, copy, configSave] = found;
        if (ledgerSave?.kind !== "saveLedger" || copy?.kind !== "writeOriginalsCopy") {
          throw new Error("unexpected effects");
        }
        if (configSave?.kind !== "saveConfig") throw new Error("unexpected effects");
        expect(ledgerSave.ledger.records.has(V)).toBe(false);
        expect(ledgerSave.ledger.released[0]).toMatchObject({
          record: { valveId: V },
          endedAt: nowOf(world),
          forgotten: false,
        });
        expect(copy.ledger).toEqual(ledgerSave.ledger);
        expect(configSave.stored.releasing.has(V)).toBe(false);
      });
      it("the saves come before every other effect of the tick", () => {
        const result = tick(heldFifteen());
        expect(kindsOf(result.effects)).toEqual([
          "saveLedger",
          "writeOriginalsCopy",
          "saveConfig",
          "refresh",
        ]);
      });
    });
    /** Equal since the order at T, not heard since; at T + 15 min. */
    function unheardFifteen(spec?: ValveSpec): World {
      let world = releasedEqual();
      if (spec !== undefined) world = withSpec(world, spec);
      const first = tick(world);
      return next(world, first, RELEASE_HOLD_MS);
    }
    describe("With everything equal for 15 min and the valve not heard since", () => {
      it("no saves", () => {
        expect(saves(tick(unheardFifteen()))).toEqual([]);
      });
      it("one refresh; after its answer is heard the release finishes", () => {
        const world = unheardFifteen();
        const result = tick(world);
        expect(valveEffects(result)).toEqual([{ kind: "refresh", valveId: V }]);
        const answered = hear({ ...world, memory: result.memory }, {}, nowOf(world) + SECOND_MS);
        expect(kindsOf(saves(tick(later(answered, 3 * SECOND_MS))))).toEqual([
          "saveLedger",
          "writeOriginalsCopy",
          "saveConfig",
        ]);
      });
    });
    describe("With the same and a refresh sent 1 min ago", () => {
      it("no refresh", () => {
        const base = unheardFifteen();
        const world = updateVm(base, (vm) =>
          chargeAsk(vm, makeSpec("trvzb"), nowOf(base) - MINUTE_MS),
        );
        expect(valveEffects(tick(world))).toEqual([]);
      });
    });
    describe("With the same and a spec that has no readable group", () => {
      it("no refresh; the release finishes when the valve speaks by itself", () => {
        const world = unheardFifteen(unreadable(makeSpec("trvzb")));
        const result = tick(world);
        expect(valveEffects(result)).toEqual([]);
        expect(saves(result)).toEqual([]);
        const spoke = hear({ ...world, memory: result.memory }, {}, nowOf(world) + MINUTE_MS);
        expect(saves(tick(later(spoke, 2 * MINUTE_MS)))).toHaveLength(3);
      });
    });
    describe("With everything equal and sensor_source still marked", () => {
      it("equalSince stays undefined and nothing is saved, however long it lasts", () => {
        const base = releasedEqual();
        let world = updateVm(base, (vm) => mark(vm, ["sensor_source"], nowOf(base)));
        world = hear(world, {}, nowOf(base) - SECOND_MS);
        for (let i = 0; i < 6; i++) {
          const result = tick(world);
          expect(vmOf(result).equalSince).toBeUndefined();
          expect(saves(result)).toEqual([]);
          world = next(world, result, 15 * MINUTE_MS);
        }
      });
    });
    describe("With everything equal, the hold passed, and a mark on schedule only", () => {
      it("the release finishes", () => {
        expect(saves(tick(heldFifteen()))).toHaveLength(3);
      });
    });
    describe("With everything equal for 15 min but the link down", () => {
      it("nothing is saved and the hold starts again", () => {
        const down = { ...heldFifteen(), links: { z2m: false } };
        const result = tick(down);
        expect(saves(result)).toEqual([]);
        expect(vmOf(result).equalSince).toBeUndefined();
      });
    });
    describe("With a value changing back during the hold", () => {
      const world = releasedEqual();
      const first = tick(world);
      const changed = withValues(next(world, first, 5 * MINUTE_MS), { sensor_source: "external" });
      it("equalSince is cleared and the original is published again", () => {
        expect(vmOf(first).equalSince).toBe(nowOf(world));
        const result = tick(changed);
        expect(vmOf(result).equalSince).toBeUndefined();
        expect(publishes(valveEffects(result))).toEqual([{ sensor_source: "internal" }]);
      });
    });
    describe("With an original that is unknown", () => {
      it("that setting is never published and does not block the finish", () => {
        const record: ValveRecord = {
          valveId: V,
          profile: "sonoff_trvzb",
          adoptedAt: NOW_MS - HOUR_MS,
          originals: { sensor_source: null },
        };
        const ledger: Ledger = withRecord(EMPTY_LEDGER, record);
        const world = withValues({ ...releasedEqual(), ledger }, { sensor_source: "external" });
        const t = nowOf(world);
        const first = tick(world);
        expect(publishes(valveEffects(first))).toEqual([]);
        const heardWorld = hear({ ...world, memory: first.memory }, {}, t + MINUTE_MS);
        const result = tick(later(heardWorld, RELEASE_HOLD_MS));
        expect(publishes(valveEffects(result))).toEqual([]);
        expect(saves(result)).toHaveLength(3);
      });
    });
    describe("With a valve releasing for 7 h", () => {
      it("a release_stalled problem", () => {
        const base = equalWorld();
        const world = released(base, nowOf(base) - RELEASE_STALLED_AFTER_MS - HOUR_MS);
        expect(problemsOf(tick(world), "release_stalled").map((p) => p.subject.id)).toEqual([V]);
        expect(
          problemsOf(tick(released(base, nowOf(base) - 5 * HOUR_MS)), "release_stalled"),
        ).toEqual([]);
      });
    });
    describe("With a stray valve", () => {
      it("one saveConfig that drops it from releasing and no other effect for it", () => {
        const world = {
          ...released(withValues(equalWorld(), { sensor_source: "external" })),
          ledger: EMPTY_LEDGER,
        };
        const result = tick(world);
        expect(kindsOf(result.effects)).toEqual(["saveConfig"]);
        const save = result.effects[0];
        if (save?.kind !== "saveConfig") throw new Error("expected saveConfig");
        expect(save.stored.releasing.has(V)).toBe(false);
      });
    });
    describe("With a valve released to equality, re-added, and removed again later", () => {
      it("the hold starts anew: no saves in the first tick after the second removal", () => {
        const world = releasedEqual();
        const t = nowOf(world);
        const first = tick(world);
        const heardWorld = hear({ ...world, memory: first.memory }, {}, t + MINUTE_MS);
        const back = later(readded(heardWorld), 10 * MINUTE_MS);
        const second = tick(back);
        expect(vmOf(second).equalSince).toBeUndefined();
        const again = released(next(back, second, 10 * MINUTE_MS));
        const result = tick(again);
        expect(saves(result)).toEqual([]);
        expect(vmOf(result).equalSince).toBe(nowOf(again));
      });
    });
    describe("Always", () => {
      it("a saveConfig from tick keeps the config and its revision", () => {
        const base = { ...released(equalWorld()), ledger: EMPTY_LEDGER };
        const stored = storedOf(base);
        const world = { ...base, stored: { ...stored, revision: 7 } };
        const save = tick(world).effects.find((e) => e.kind === "saveConfig");
        if (save?.kind !== "saveConfig") throw new Error("expected saveConfig");
        expect(save.stored.config).toBe(stored.config);
        expect(save.stored.revision).toBe(7);
        const finished = tick(heldFifteen()).effects.find((e) => e.kind === "saveConfig");
        if (finished?.kind !== "saveConfig") throw new Error("expected saveConfig");
        expect(finished.stored.revision).toBe(storedOf(heldFifteen()).revision);
      });
    });
  });

  describe("tick — robustness", () => {
    describe("With any World built from arbitrary values (fast-check)", () => {
      fcTest.prop([arbRun])("never throws", ({ world, steps }) => {
        expect(() => runAll(world, steps)).not.toThrow();
      });
      fcTest.prop([arbRun])(
        "never returns a publish, publishSetpoint, pushTemperature or refresh for a valve that is not managed or releasing",
        ({ world, steps }) => {
          for (const [w, result] of runAll(world, steps)) {
            const kinds = memberships(w.configState, w.stored, w.ledger);
            for (const effect of result.effects) {
              if (!("valveId" in effect)) continue;
              expect(["managed", "releasing"]).toContain(kinds.get(effect.valveId));
            }
          }
        },
      );
      fcTest.prop([arbRun])(
        "never returns a publish, publishSetpoint or pushTemperature while writes are held",
        ({ world, steps }) => {
          for (const [w, result] of runAll(world, steps)) {
            if (w.stored?.config.settings.holdWrites !== true) continue;
            const writes = result.effects.filter(
              (e) =>
                e.kind === "publish" ||
                e.kind === "publishSetpoint" ||
                e.kind === "pushTemperature",
            );
            expect(writes).toEqual([]);
          }
        },
      );
      fcTest.prop([arbRun])(
        "never returns more than one of refresh, publish and publishSetpoint for one valve",
        ({ world, steps }) => {
          for (const [, result] of runAll(world, steps)) {
            const count = new Map<string, number>();
            for (const effect of result.effects) {
              if (
                effect.kind !== "refresh" &&
                effect.kind !== "publish" &&
                effect.kind !== "publishSetpoint"
              ) {
                continue;
              }
              count.set(effect.valveId, (count.get(effect.valveId) ?? 0) + 1);
            }
            for (const n of count.values()) expect(n).toBeLessThanOrEqual(1);
          }
        },
      );
      fcTest.prop([arbRun])(
        "never returns, for a releasing valve, a publish holding a key of a group whose spec says it is not captured",
        ({ world, steps }) => {
          for (const [w, result] of runAll(world, steps)) {
            const kinds = memberships(w.configState, w.stored, w.ledger);
            for (const effect of result.effects) {
              if (effect.kind !== "publish" || kinds.get(effect.valveId) !== "releasing") continue;
              const spec = w.devices.get(effect.valveId)?.spec;
              for (const key of Object.keys(effect.values) as SettingKey[]) {
                const groupSpec = spec?.groups.find((g) => g.group === groupOf(key));
                expect(groupSpec?.capture).toBe(true);
              }
            }
          }
        },
      );
    });
  });

  describe("preview", () => {
    function twoDaysAndSource(): World {
      return withValues(equalWorld(), {
        day_tue: OTHER_DAY,
        day_wed: OTHER_DAY,
        sensor_source: "external",
      });
    }
    describe('With a TRVZB that has no marks, two days differing and source "internal"', () => {
      it("lists the two days, then the source", () => {
        expect(preview(twoDaysAndSource())).toEqual([
          {
            valveId: V,
            values: { day_tue: BUILDER_DAY, day_wed: BUILDER_DAY },
            current: { day_tue: OTHER_DAY, day_wed: OTHER_DAY },
          },
          {
            valveId: V,
            values: { sensor_source: "internal" },
            current: { sensor_source: "external" },
          },
        ]);
      });
    });
    describe("With a TRV-ZBT never heard from", () => {
      it("lists the seven days with nothing in current, then active_group, then the source", () => {
        const world = withState(makeManaged({ model: "trv_zbt" }), undefined);
        expect(preview(world)).toEqual([
          { valveId: V, values: sevenDays(BUILDER_DAY), current: {} },
          { valveId: V, values: { active_group: 3 }, current: {} },
          { valveId: V, values: { sensor_source: "internal" }, current: {} },
        ]);
      });
    });
    describe("With a TRV-ZBT in sync and the room's week then changed", () => {
      it("lists the seven days of the new week, with the observed days in current", () => {
        const base = settled(
          makeManaged({ model: "trv_zbt", state: makeState({ values: EQUAL_ZBT }) }),
        );
        expect(preview(base)).toEqual([]);
        expect(preview(withWeekDay(base, OTHER_DAY))).toEqual([
          { valveId: V, values: sevenDays(OTHER_DAY), current: sevenDays(BUILDER_DAY) },
        ]);
      });
    });
    describe("With holdWrites true, the link down and every group in backoff", () => {
      it("lists the same writes", () => {
        const base = twoDaysAndSource();
        const t = nowOf(base);
        let world = held({ ...base, links: { z2m: false } });
        world = updateVm(world, (vm) => {
          let next = vm;
          for (const group of ["schedule", "sensor_source"] as const) {
            next = charge(next, group, t - 20 * SECOND_MS, false);
            next = charge(next, group, t - 10 * SECOND_MS, false);
          }
          return next;
        });
        expect(preview(world)).toEqual(preview(base));
        expect(preview(world)).toHaveLength(2);
      });
    });
    describe("With everything equal and no marks", () => {
      it("returns nothing", () => {
        expect(preview(equalWorld())).toEqual([]);
      });
    });
    describe("With everything equal and sensor_source marked", () => {
      it("returns nothing", () => {
        const base = equalWorld();
        expect(preview(updateVm(base, (vm) => mark(vm, ["sensor_source"], nowOf(base))))).toEqual(
          [],
        );
      });
    });
    describe("With everything equal and schedule marked", () => {
      it("lists the seven days once", () => {
        const base = equalWorld();
        const world = updateVm(base, (vm) => mark(vm, ["schedule"], nowOf(base)));
        expect(preview(world)).toEqual([
          { valveId: V, values: sevenDays(BUILDER_DAY), current: sevenDays(BUILDER_DAY) },
        ]);
      });
    });
    describe("With a valve that has no ValveMemory yet and equal values", () => {
      it("lists the seven days once and not the source (a new valve's schedule is asserted)", () => {
        const world = makeManaged({ state: makeState({ values: EQUAL }) });
        expect(world.memory.valves.has(V)).toBe(false);
        expect(preview(world)).toEqual([
          { valveId: V, values: sevenDays(BUILDER_DAY), current: sevenDays(BUILDER_DAY) },
        ]);
      });
    });
    describe("With a room that has no sensors", () => {
      it('the listed source is "internal"', () => {
        const world = withValues(equalWorld(), { sensor_source: "external" });
        expect(preview(world)).toEqual([
          {
            valveId: V,
            values: { sensor_source: "internal" },
            current: { sensor_source: "external" },
          },
        ]);
      });
    });
    describe("With a releasing TRVZB whose source differs from the original", () => {
      it("lists the source and no day", () => {
        const world = released(
          withValues(equalWorld(), { ...sevenDays(THIRD_DAY), sensor_source: "external" }),
        );
        expect(preview(world)).toEqual([
          {
            valveId: V,
            values: { sensor_source: "internal" },
            current: { sensor_source: "external" },
          },
        ]);
      });
    });
    describe("With a valve whose schedule was asserted more than 24 h ago", () => {
      it("lists the seven days like tick does", () => {
        const base = equalWorld();
        let world = base;
        // Heard every hour, so the valve never turns silent.
        for (let hour = 1; hour <= 25; hour++) {
          world = hear(world, {}, nowOf(base) + hour * HOUR_MS - MINUTE_MS);
        }
        world = later(world, 25 * HOUR_MS);
        expect(vmOf(world).groups.schedule?.mark).toBeUndefined();
        const result = tick(world);
        const heardAgain = hear({ ...world, memory: result.memory }, {}, nowOf(world) + SECOND_MS);
        const written = tick(later(heardAgain, 3 * SECOND_MS));
        expect(publishes(valveEffects(written))).toEqual([sevenDays(BUILDER_DAY)]);
        expect(preview(world)).toEqual([
          { valveId: V, values: sevenDays(BUILDER_DAY), current: sevenDays(BUILDER_DAY) },
        ]);
      });
    });
    describe("With a not_adopted, orphan or frozen valve", () => {
      it("lists nothing for it", () => {
        const base = withValues(equalWorld(), { day_sat: OTHER_DAY });
        expect(preview(base)).toHaveLength(1);
        const worlds: readonly World[] = [
          { ...base, ledger: EMPTY_LEDGER },
          withRooms(base, () => []),
          { ...base, ledger: undefined },
        ];
        for (const world of worlds) expect(preview(world)).toEqual([]);
      });
    });
  });
});
