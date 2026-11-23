import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import {
  BUILDER_DAY,
  BUILDER_NOW,
  BUILDER_ROOM,
  BUILDER_SCHEDULE,
  BUILDER_THERMOSTAT,
  BUILDER_VALVE,
  arbConfig,
  entriesOf,
  liveHouse,
  makeExpectation,
  makeManaged,
  makeMembership,
  makeOriginals,
  makeSpec,
  makeState,
  makeThermostat,
  makeWorld,
  points,
  settled,
  weekOf,
  withExpectation,
} from "../test/builders.ts";
import {
  RELEASE_HOLD_MS,
  RELEASE_STALLED_AFTER_MS,
  THERMOSTAT_SETTLE_MS,
  candidates,
  confirmedWeek,
  isObservable,
  isThermostatWrite,
  preview,
  tick,
  transportUsable,
} from "./control.ts";
import type { DeviceView, Effect, TickResult, World } from "./control.ts";
import { fitted, weekKey } from "./desired.ts";
import type { Desired } from "./desired.ts";
import { applyEvent } from "./events.ts";
import type { Event } from "./events.ts";
import { NO_PRESETS, roomsOf } from "./house.ts";
import type { AreaMembership, HouseInput } from "./house.ts";
import { reconcile } from "./join.ts";
import { EMPTY_LEDGER, FRESH_STORED, memberships, withRecord } from "./ledger.ts";
import type { ConfigState, Ledger, Membership, ValveRecord } from "./ledger.ts";
import { EMPTY_MEMORY, START_TOKENS, mark, newValveMemory } from "./memory.ts";
import type { ValveMemory } from "./memory.ts";
import { DEFAULT_SETTINGS } from "./model.ts";
import type { Config, Room, RoomEntry, SensorRef, SetPoint } from "./model.ts";
import { newState } from "./observation.ts";
import type { DeviceState } from "./observation.ts";
import { BUCKET, REFILL_MS, charge, chargeAsk, noteDesired } from "./pacing.ts";
import type { ResolvedDay, ResolvedWeek } from "./schedule.ts";
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
import {
  EMPTY_THERMOSTAT_STATE,
  SCHEDULE,
  SENT_RETIRE_MS,
  thermostatCommand,
} from "./thermostat.ts";
import type {
  Thermostat,
  ThermostatState,
  ThermostatWanted,
  ValveExpectation,
} from "./thermostat.ts";

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

/**
 * What a TRVZB holds when it equals the desired values of a room without sensors on its schedule:
 * frost protection 7, auto, and setpoint 17 (a value of the builder week).
 */
const EQUAL: SettingValues = {
  ...sevenDays(BUILDER_DAY),
  sensor_source: "internal",
  ...BUILDER_THERMOSTAT,
};
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

/** The world after `result`, `ms` later, with the tick's memory and thermostat state. */
function next(world: World, result: TickResult, ms: number): World {
  return later({ ...world, memory: result.memory, thermostats: result.thermostats }, ms);
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

/**
 * The world's resolved rooms, changed by `update`: entries and a live house that hold them, and
 * the saved membership equal to the house's.
 */
function withRooms(world: World, update: (rooms: readonly Room[]) => readonly Room[]): World {
  const stored = storedOf(world);
  const rooms = update(roomsOf(world.configState, stored, world.house) ?? []);
  const house = liveHouse(rooms);
  return {
    ...world,
    stored: {
      ...stored,
      config: { ...stored.config, rooms: entriesOf(rooms) },
      membership: house.kind === "live" ? house.membership : undefined,
    },
    house,
  };
}

/** Each valve's membership in the world, over the rooms of its house. */
function kindsIn(world: World): ReadonlyMap<string, Membership> {
  const rooms = roomsOf(world.configState, world.stored, world.house);
  return memberships(world.configState, world.stored, world.ledger, rooms, world.house.kind);
}

/** Each valve's membership once the tick's reconcile has joined and released. */
function reconciledKinds(world: World): ReadonlyMap<string, Membership> {
  const reconciled = reconcile(world);
  return kindsIn({ ...world, stored: reconciled.stored, ledger: reconciled.ledger });
}

/**
 * The valve leaves its room and is put in `releasing`, ordered at `orderedAt`. Its expectation is
 * gone, as the tick that saw the release dropped it (R16).
 */
function released(world: World, orderedAt = nowOf(world), valveId = V): World {
  const removed = withRooms(withExpectation(world, undefined, valveId), (rooms) =>
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
    current = { ...current, memory: result.memory, thermostats: result.thermostats };
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

/** The world's config without schedules: nothing joins or is released. */
function withoutSchedules(world: World): World {
  const stored = storedOf(world);
  const config = { ...stored.config, schedules: [], defaultScheduleId: undefined };
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

/** Each area of the config's entries, plus one without an entry, holding 1 to 3 valves. */
const arbAreas = (config: Config): fc.Arbitrary<Readonly<Record<string, readonly string[]>>> =>
  fc
    .array(fc.integer({ min: 1, max: 3 }), {
      minLength: config.rooms.size + 1,
      maxLength: config.rooms.size + 1,
    })
    .map((counts) => {
      let next = 1;
      const areas = [...config.rooms.keys(), "no_entry"];
      return Object.fromEntries(
        areas.map((areaId, i) => [
          areaId,
          Array.from(
            { length: counts[i] ?? 1 },
            () => `z2m:0x${(next++).toString(16).padStart(16, "0")}`,
          ),
        ]),
      );
    });

const arbRun: fc.Arbitrary<Run> = arbConfig.chain((config) =>
  arbAreas(config).chain((areas) => {
    const roomValves = Object.values(areas).flat();
    const ids = [...roomValves, ...EXTRA_IDS];
    const sensorIds = [
      ...new Set([...config.rooms.values()].flatMap((entry) => entry.sensors.map((s) => s.ref))),
    ];
    const membership = makeMembership(areas);
    const arbHouse: fc.Arbitrary<HouseInput> = fc.oneof(
      { arbitrary: fc.constant<HouseInput>({ kind: "live", membership, notInHa: [] }), weight: 6 },
      fc.constantFrom<HouseInput>(
        { kind: "frozen", membership, reason: "link_down" },
        { kind: "frozen", membership: undefined, reason: "not_loaded" },
        { kind: "unlinked" },
      ),
    );
    return fc
      .record({
        house: arbHouse,
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
        z2m: fc.oneof(
          { arbitrary: fc.constant(true), weight: 9 },
          fc.constantFrom(false, undefined),
        ),
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
                ...FRESH_STORED,
                config: { ...config, settings },
                revision: 3,
                releasing: new Map(
                  r.releasing.map((id) => [id, NOW_MS - (r.releasingAgo[ids.indexOf(id)] ?? 0)]),
                ),
              }
            : undefined,
          house: r.house,
          ledger: r.ledgerReadable ? ledgerBase : undefined,
          devices,
          links,
          transportFaults: r.fault === undefined ? {} : { z2m: r.fault },
          deviceLists: { z2m: new Set(devices.keys()) },
          sensors,
          unobservableSensors: new Set(r.unobservable),
          memory,
          buckets: undefined,
          now: BUILDER_NOW,
          thermostats: EMPTY_THERMOSTAT_STATE,
        };
        return { world, steps: r.steps };
      });
  }),
);

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
    current = { ...current, memory: result.memory, thermostats: result.thermostats };
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
    describe("For the thermostat group desiring auto and 19 on a valve showing auto and 22", () => {
      it("both system_mode and setpoint are sent", () => {
        const thermostat = want({ ...EQUAL, system_mode: "auto", setpoint: 19 });
        const state = heardAt(C0, { ...EQUAL, system_mode: "auto", setpoint: 22 });
        expect(candidates(TRVZB, thermostat, state, unmarkedVm(TRVZB))).toEqual([
          {
            group: "thermostat",
            values: { system_mode: "auto", setpoint: 19 },
            differed: true,
            marked: false,
          },
        ]);
      });
    });
    describe("For the schedule group with one day differing", () => {
      it("only that day is sent", () => {
        const state = heardAt(C0, { ...EQUAL, day_thu: OTHER_DAY });
        expect(candidates(TRVZB, desired, state, unmarkedVm(TRVZB))).toEqual([
          { group: "schedule", values: { day_thu: BUILDER_DAY }, differed: true, marked: false },
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

  describe("isThermostatWrite", () => {
    describe("With a publish of system_mode and a setpoint", () => {
      it("returns true", () => {
        const values = { system_mode: "heat", setpoint: 22 } as const;
        expect(isThermostatWrite({ kind: "publish", valveId: "z2m:a", values })).toBe(true);
      });
    });
    describe("With a publish of another group, a push or a refresh", () => {
      it("returns false", () => {
        const values = { frost_protection: 7 } as const;
        expect(isThermostatWrite({ kind: "publish", valveId: "z2m:a", values })).toBe(false);
        expect(isThermostatWrite({ kind: "pushTemperature", valveId: "z2m:a", celsius: 20 })).toBe(
          false,
        );
        expect(isThermostatWrite({ kind: "refresh", valveId: "z2m:a" })).toBe(false);
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
    describe("With membership pending / orphan / frozen", () => {
      it("no effects for the valve and its problem is raised", () => {
        const base = withValues(equalWorld(), { day_sat: OTHER_DAY });
        // Its sensor source is not observed, so it cannot join and stays pending.
        const values = { ...sevenDays(BUILDER_DAY), day_sat: OTHER_DAY };
        const unjoinable = withState(base, { ...stateOf(base), values });
        const cases: readonly [World, ProblemKind][] = [
          [{ ...unjoinable, ledger: EMPTY_LEDGER }, "valve_pending"],
          // Without a schedule a valve in no room is not released: it stays an orphan.
          [withoutSchedules(withRooms(base, () => [])), "valve_orphan"],
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
        const world = { ...withRooms(equalWorld(), () => []), ledger: EMPTY_LEDGER };
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
    describe("With a pending valve in a room, last heard 3 h ago", () => {
      const base = makeManaged({ state: makeState({ heardAgoMs: 3 * HOUR_MS }) });
      const world = { ...base, ledger: EMPTY_LEDGER };
      it('its ValveStatus has liveness "silent"', () => {
        expect(statusOf(tick(world))).toMatchObject({
          membership: "pending",
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
      const unheard = next(changed, first, 3 * SECOND_MS);
      it("no publishSetpoint before a heard message follows the write", () => {
        expect(publishes(valveEffects(first))).toEqual([sevenDays(OTHER_DAY)]);
        expect(vmOf(first).nudgeDue).toBe(true);
        expect(valveEffects(tick(unheard))).toEqual([]);
      });
      it("no publishSetpoint for a message heard at the very moment of the write", () => {
        const sameInstant = hear(unheard, {}, nowOf(changed));
        expect(valveEffects(tick(sameInstant))).toEqual([]);
      });
      it("once a message is heard after the write, the thermostat group's publish of auto and the active set point's temperature, not a publishSetpoint (R26)", () => {
        const heard = hear(unheard, {}, nowOf(changed) + SECOND_MS);
        expect(valveEffects(tick(heard))).toEqual([
          { kind: "publish", valveId: V, values: { system_mode: "auto", setpoint: 21 } },
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
    describe("With a release ordered at the instant the valve was last heard, equal for 15 min and not heard since", () => {
      it("no saves until the valve is heard after the order", () => {
        const base = releasedEqual();
        const world = hear(base, {}, nowOf(base));
        const first = tick(world);
        expect(vmOf(first).equalSince).toBe(nowOf(world));
        const result = tick(next(world, first, RELEASE_HOLD_MS));
        expect(saves(result)).toEqual([]);
        expect(valveEffects(result)).toEqual([{ kind: "refresh", valveId: V }]);
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
    describe("With a release ordered under a clock 1 h fast, the clock then corrected, and the valve equal since", () => {
      /** Ordered at T + 1 h; ticked every 15 min from T until the order, heard 1 min after it. */
      function aheadOrder(ms: number): World {
        const base = equalWorld();
        const orderedAt = nowOf(base) + HOUR_MS;
        const world = released(base, orderedAt);
        let current = world;
        while (nowOf(current) < orderedAt) {
          const result = tick(current);
          current = next(current, result, 15 * MINUTE_MS);
        }
        const heardWorld = hear(current, {}, orderedAt + MINUTE_MS);
        return { ...heardWorld, now: atTime(orderedAt + ms) };
      }
      it("nothing is saved before the hold has passed from the order", () => {
        expect(saves(tick(aheadOrder(5 * MINUTE_MS)))).toEqual([]);
      });
      it("the release finishes once the hold has passed from the order", () => {
        expect(kindsOf(saves(tick(aheadOrder(RELEASE_HOLD_MS))))).toEqual([
          "saveLedger",
          "writeOriginalsCopy",
          "saveConfig",
        ]);
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
    describe("With a release whose orderedAt is later than now", () => {
      const base = withValues(equalWorld(), { sensor_source: "external" });
      const future = released(base, nowOf(base) + HOUR_MS);
      const configSaves = (result: TickResult): readonly Effect[] =>
        result.effects.filter((e) => e.kind === "saveConfig");
      it("effects include saveConfig with orderedAt = now", () => {
        const [save, ...rest] = configSaves(tick(future));
        if (save?.kind !== "saveConfig") throw new Error("expected saveConfig");
        expect(rest).toEqual([]);
        expect(save.stored.releasing.get(V)).toBe(nowOf(future));
      });
      it("the release proceeds as if ordered now", () => {
        const now = released(base, nowOf(base));
        expect(valveEffects(tick(future))).toEqual(valveEffects(tick(now)));
        expect(publishes(valveEffects(tick(future)))).toEqual([{ sensor_source: "internal" }]);
      });
      it("the hold is counted from the clamped time: equal for 15 min, the release finishes", () => {
        const world = released(equalWorld(), nowOf(equalWorld()) + HOUR_MS);
        const t = nowOf(world);
        const first = tick(world);
        const save = first.effects.find((e) => e.kind === "saveConfig");
        if (save?.kind !== "saveConfig") throw new Error("expected saveConfig");
        const kept = { ...world, memory: first.memory, stored: save.stored };
        const heardWorld = hear(kept, {}, t + MINUTE_MS);
        const marked = updateVm(heardWorld, (vm) => mark(vm, ["schedule"], t + 2 * MINUTE_MS));
        const result = tick(later(marked, RELEASE_HOLD_MS));
        expect(kindsOf(saves(result))).toContain("saveLedger");
      });
      it("release_stalled fires measured from the clamped time", () => {
        const save = configSaves(tick(future))[0];
        if (save?.kind !== "saveConfig") throw new Error("expected saveConfig");
        const clamped = { ...future, stored: save.stored };
        const near = later(clamped, RELEASE_STALLED_AFTER_MS - MINUTE_MS);
        const past = later(clamped, RELEASE_STALLED_AFTER_MS + MINUTE_MS);
        expect(problemsOf(tick(near), "release_stalled")).toEqual([]);
        expect(problemsOf(tick(past), "release_stalled").map((p) => p.subject.id)).toEqual([V]);
      });
      it("a stray one is dropped in the same single saveConfig", () => {
        const stray = {
          ...released(base, nowOf(base) + HOUR_MS),
          ledger: EMPTY_LEDGER,
        };
        const [save, ...rest] = tick(stray).effects.filter((e) => e.kind === "saveConfig");
        if (save?.kind !== "saveConfig") throw new Error("expected saveConfig");
        expect(rest).toEqual([]);
        expect(save.stored.releasing.has(V)).toBe(false);
      });
    });
    describe("With a release whose orderedAt is not later than now", () => {
      it("no extra saveConfig", () => {
        const base = withValues(equalWorld(), { sensor_source: "external" });
        expect(saves(tick(released(base, nowOf(base))))).toEqual([]);
        expect(saves(tick(released(base, nowOf(base) - HOUR_MS)))).toEqual([]);
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

  describe("tick — clock set back", () => {
    /** Applies link_up for z2m at the world's now, as the shell does when the clock was set. */
    function linkUp(world: World): World {
      const specs = new Map<string, ValveSpec>();
      for (const [id, view] of world.devices) if (view.spec !== undefined) specs.set(id, view.spec);
      const states = new Map<string, DeviceState>();
      for (const [id, view] of world.devices) {
        if (view.state !== undefined) states.set(id, view.state);
      }
      const event: Event = { kind: "link_up", transport: "z2m" };
      const inbox = applyEvent({ states, memory: world.memory }, event, specs, nowOf(world));
      const view = viewOf(world);
      return withView({ ...world, memory: inbox.memory }, { ...view, state: inbox.states.get(V) });
    }
    /**
     * A fed TRVZB with one day differing that wrote and pushed under a clock 2 h fast; the clock is
     * then set back by 2 h and link_up is applied. The world is 30 s (one tick) after the link_up.
     */
    function setBack(): World {
      const base = withValues(fedWorld(), { [DAY_KEYS.mon]: OTHER_DAY });
      // Heard during the fast period, so the valve stays live.
      const heard = hear(hear(base, {}, nowOf(base) + HOUR_MS), {}, nowOf(base) + 2 * HOUR_MS);
      const fast = later(heard, 2 * HOUR_MS);
      const ahead = tick(withSensor(fast, freshReading(fast, 20)));
      expect(kindsOf(valveEffects(ahead))).toEqual(["pushTemperature", "publish"]);
      const back = later(linkUp({ ...base, memory: ahead.memory }), 30 * SECOND_MS);
      return withSensor(back, freshReading(back, 20));
    }
    describe("With memory stamped 2 h ahead and link_up applied after the clock was set back by 2 h", () => {
      it("the next tick sends a refresh", () => {
        expect(valveEffects(tick(setBack()))).toContainEqual({ kind: "refresh", valveId: V });
      });
      it("after the answer, the differing day is published again once its backoff has passed from the link_up", () => {
        const world = setBack();
        const first = tick(world);
        const answered = hear({ ...world, memory: first.memory }, {}, nowOf(world) + SECOND_MS);
        // Two writes of this week are recorded in the window, so the backoff is 10 min.
        const [, effects] = drive(later(answered, 10 * MINUTE_MS), 2, 30 * SECOND_MS);
        expect(publishes(effects).some((v) => DAY_KEYS.mon in v)).toBe(true);
      });
      it("a changed room temperature is pushed once the push interval has passed from the link_up", () => {
        const world = setBack();
        const first = tick(world);
        const due = next(world, first, DEFAULT_SETTINGS.externalWriteIntervalMs);
        const warm = withSensor(due, freshReading(due, 21));
        expect(valveEffects(tick(warm))).toContainEqual({
          kind: "pushTemperature",
          valveId: V,
          celsius: 21,
        });
      });
    });
  });

  describe("tick — rooms from the house", () => {
    /** A settled managed TRV-ZBT, so a changed week is published at the next tick. */
    function zbtWorld(): World {
      return settled(makeManaged({ model: "trv_zbt", state: makeState({ values: EQUAL_ZBT }) }));
    }

    function liveHouseOf(world: World): HouseInput & { kind: "live" } {
      if (world.house.kind !== "live") throw new Error("the builder house is live");
      return world.house;
    }

    describe("With house frozen on a saved membership that holds a managed valve", () => {
      it("the valve gets its schedule as with a live house", () => {
        const live = withWeekDay(zbtWorld(), OTHER_DAY);
        const frozen: World = {
          ...live,
          house: { kind: "frozen", membership: liveHouseOf(live).membership, reason: "link_down" },
        };
        expect(publishes(valveEffects(tick(live)))).toEqual([sevenDays(OTHER_DAY)]);
        expect(tick(frozen).effects).toEqual(tick(live).effects);
      });
    });

    describe("With house unlinked and a managed valve", () => {
      it("no effect names the valve", () => {
        const live = withWeekDay(zbtWorld(), OTHER_DAY);
        expect(valveEffects(tick({ ...live, house: { kind: "unlinked" } }))).toEqual([]);
      });
    });

    describe("With a room that has no entry", () => {
      it("its valve gets the default schedule", () => {
        const base = zbtWorld();
        const stored = storedOf(base);
        const other = {
          id: "other",
          name: "Other",
          defaultWeek: weekOf(OTHER_DAY.map((p) => ({ ...p, preset: undefined }))),
        };
        const config = {
          ...stored.config,
          schedules: [...stored.config.schedules, other],
          defaultScheduleId: "other",
          rooms: new Map(),
        };
        const world: World = { ...base, stored: { ...stored, config } };
        expect(publishes(valveEffects(tick(world)))).toEqual([sevenDays(OTHER_DAY)]);
      });
    });

    describe("With a saved membership that lists the valve under two areas (a hand edit)", () => {
      it("the valve follows the first area's room, the one its pending entry would name", () => {
        const base = withWeekDay(zbtWorld(), OTHER_DAY);
        const stored = storedOf(base);
        const third = {
          id: "third",
          name: "Third",
          defaultWeek: weekOf(THIRD_DAY.map((p) => ({ ...p, preset: undefined }))),
        };
        const entry = (scheduleId: string): RoomEntry => ({
          scheduleId,
          sensors: [],
          presets: NO_PRESETS,
          overrideEnd: undefined,
          overrideDurationMs: undefined,
        });
        const config = {
          ...stored.config,
          schedules: [...stored.config.schedules, third],
          rooms: new Map([
            ["alpha", entry(BUILDER_SCHEDULE)],
            ["zeta", entry("third")],
          ]),
        };
        const membership: AreaMembership = {
          rooms: new Map([
            ["alpha", { name: "Alpha", valveIds: [V] }],
            ["zeta", { name: "Zeta", valveIds: [V] }],
          ]),
          ignored: [],
        };
        const world: World = {
          ...base,
          stored: { ...stored, config, membership },
          house: { kind: "live", membership, notInHa: [] },
        };
        expect(publishes(valveEffects(tick(world)))).toEqual([sevenDays(OTHER_DAY)]);
        expect(preview(world).map((write) => write.values)).toContainEqual(sevenDays(OTHER_DAY));
      });
    });
  });

  describe("tick — robustness", () => {
    describe("With any World built from arbitrary values (fast-check)", () => {
      fcTest.prop([arbRun])("never throws", ({ world, steps }) => {
        expect(() => runAll(world, steps)).not.toThrow();
      });
      fcTest.prop([arbRun])(
        "never returns a publish, publishSetpoint, pushTemperature or refresh for a valve that is not managed or releasing after the tick's reconcile, except a refresh for a pending one",
        ({ world, steps }) => {
          for (const [w, result] of runAll(world, steps)) {
            const kinds = reconciledKinds(w);
            for (const effect of result.effects) {
              if (!("valveId" in effect)) continue;
              const allowed =
                effect.kind === "refresh"
                  ? ["managed", "releasing", "pending"]
                  : ["managed", "releasing"];
              expect(allowed).toContain(kinds.get(effect.valveId));
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
            const kinds = reconciledKinds(w);
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
      it("lists the seven days with nothing in current, then active_group, the source, the frost protection and auto", () => {
        const world = withState(makeManaged({ model: "trv_zbt" }), undefined);
        expect(preview(world)).toEqual([
          { valveId: V, values: sevenDays(BUILDER_DAY), current: {} },
          { valveId: V, values: { active_group: 3 }, current: {} },
          { valveId: V, values: { sensor_source: "internal" }, current: {} },
          { valveId: V, values: { frost_protection: 7 }, current: {} },
          { valveId: V, values: { system_mode: "auto" }, current: {} },
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
    describe("With a pending, orphan or frozen valve", () => {
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

  describe("tick — joins, pending valves and releases", () => {
    const V2 = "z2m:0x00124b0000000002";
    /** The builder room's TRVZB without a ledger record, heard just now holding `values`. */
    const joining = (
      values: SettingValues = { sensor_source: "internal", ...BUILDER_THERMOSTAT },
    ): World => ({
      ...makeManaged({ state: makeState({ values, heardAgoMs: 0 }), expectation: null }),
      ledger: EMPTY_LEDGER,
    });
    /** Adds V2 to the builder room: a TRVZB without a record that has sent no message. */
    const withPendingV2 = (world: World): World => {
      const placed = withRooms(world, (rooms) =>
        rooms.map((room) => ({ ...room, valves: [...room.valves, { valveId: V2 }] })),
      );
      return withView(
        placed,
        { name: "second", spec: makeSpec("trvzb"), usable: true, state: undefined },
        V2,
      );
    };
    const VALVE_WRITES = new Set(["publish", "publishSetpoint", "pushTemperature"]);

    describe("With a valve that joins this tick", () => {
      /** A valve that was pending, has been asked and answered, and now joins: one day differs. */
      const answered = (): World => ({
        ...withValues(equalWorld(), { day_sat: OTHER_DAY, ...BUILDER_THERMOSTAT }),
        ledger: EMPTY_LEDGER,
      });
      it("the effects start with saveLedger and writeOriginalsCopy", () => {
        expect(kindsOf(tick(answered()).effects).slice(0, 2)).toEqual([
          "saveLedger",
          "writeOriginalsCopy",
        ]);
        expect(kindsOf(tick(joining()).effects).slice(0, 2)).toEqual([
          "saveLedger",
          "writeOriginalsCopy",
        ]);
      });
      it("the valve's writes come after them", () => {
        const result = tick(answered());
        expect(kindsOf(result.effects)).toEqual(["saveLedger", "writeOriginalsCopy", "publish"]);
        expect(publishes(valveEffects(result))).toEqual([{ day_sat: BUILDER_DAY }]);
      });
    });
    describe("With a pending valve that is not observable", () => {
      it("one paced refresh is its only effect", () => {
        const world = withState(joining(), undefined);
        const first = tick(world);
        expect(first.effects).toEqual([{ kind: "refresh", valveId: V }]);
        expect(tick(next(world, first, MINUTE_MS)).effects).toEqual([]);
      });
    });
    // With no schedule nothing joins (R7), so a valve without a record waits for nothing.
    describe("With a config that has no schedule and a room holding a valve without a record", () => {
      const world = ((): World => {
        const base = withState(joining(), undefined);
        const stored = storedOf(base);
        const config = { ...stored.config, schedules: [], defaultScheduleId: undefined };
        return { ...base, stored: { ...stored, config } };
      })();
      it("it is not pending: no membership, no ask, no valve_pending problem, no pending entry", () => {
        const kinds = memberships(
          world.configState,
          world.stored,
          world.ledger,
          roomsOf(world.configState, world.stored, world.house),
          world.house.kind,
        );
        expect(kinds.has(V)).toBe(false);
        const result = tick(world);
        expect(result.effects).toEqual([]);
        expect(problemsOf(result, "valve_pending")).toEqual([]);
        expect(result.pending).toEqual([]);
      });
    });
    describe("With a pending valve and a managed valve in one room", () => {
      it("the managed valve is written as without the pending one", () => {
        const world = withValues(equalWorld(), { day_sat: OTHER_DAY });
        const alone = valveEffects(tick(world));
        expect(publishes(alone)).toHaveLength(1);
        const shared = tick(withPendingV2(world));
        expect(valveEffects(shared)).toEqual(alone);
        expect(valveEffects(shared, V2)).toEqual([{ kind: "refresh", valveId: V2 }]);
      });
    });
    describe("With a valve released this tick while writes are not held", () => {
      it("its originals are written", () => {
        const world = withRooms(withValues(equalWorld(), { sensor_source: "external" }), (rooms) =>
          rooms.map((room) => ({ ...room, valves: [] })),
        );
        const result = tick(world);
        const saved = result.effects.find((e) => e.kind === "saveConfig");
        expect(saved?.kind === "saveConfig" && saved.stored.releasing.get(V)).toBe(nowOf(world));
        expect(publishes(valveEffects(result))).toEqual([{ sensor_source: "internal" }]);
      });
    });
    describe("With writes held", () => {
      it("joins still record originals and no valve is written", () => {
        const result = tick(held(joining()));
        expect(kindsOf(result.effects).slice(0, 2)).toEqual(["saveLedger", "writeOriginalsCopy"]);
        const saved = result.effects[0];
        expect(saved?.kind === "saveLedger" && saved.ledger.records.get(V)?.originals).toEqual({
          sensor_source: "internal",
          ...BUILDER_THERMOSTAT,
        });
        expect(result.effects.filter((e) => VALVE_WRITES.has(e.kind))).toEqual([]);
      });
    });

    describe("problems", () => {
      const frozen = (reason: "not_loaded" | "link_down"): World => {
        const world = equalWorld();
        return {
          ...world,
          house: { kind: "frozen", membership: storedOf(world).membership, reason },
        };
      };
      describe("With house unlinked", () => {
        it("ha_link_required", () => {
          const result = tick({ ...equalWorld(), house: { kind: "unlinked" } });
          expect(problemsOf(result, "ha_link_required")).toEqual([
            {
              kind: "ha_link_required",
              subject: { kind: "system", id: "heatmaster" },
              severity: "error",
              data: {},
            },
          ]);
        });
      });
      describe("With house frozen before the first load", () => {
        it("rooms_frozen with reason not_loaded", () => {
          expect(problemsOf(tick(frozen("not_loaded")), "rooms_frozen")).toEqual([
            {
              kind: "rooms_frozen",
              subject: { kind: "system", id: "heatmaster" },
              severity: "warning",
              data: { reason: "not_loaded" },
            },
          ]);
        });
      });
      describe("With house frozen after the link went down", () => {
        it("rooms_frozen with reason link_down", () => {
          expect(problemsOf(tick(frozen("link_down")), "rooms_frozen").map((p) => p.data)).toEqual([
            { reason: "link_down" },
          ]);
        });
      });
      describe("With a config with no schedule and a room", () => {
        it("no_schedule", () => {
          const world = makeWorld({
            config: {
              ...storedOf(makeWorld()).config,
              schedules: [],
              defaultScheduleId: undefined,
            },
            house: {
              kind: "live",
              membership: makeMembership({ [BUILDER_ROOM]: [V] }),
              notInHa: [],
            },
          });
          expect(problemsOf(tick(world), "no_schedule")).toEqual([
            {
              kind: "no_schedule",
              subject: { kind: "system", id: "heatmaster" },
              severity: "warning",
              data: {},
            },
          ]);
          expect(problemsOf(tick(makeWorld()), "no_schedule")).toEqual([]);
        });
      });
      describe("With a pending valve", () => {
        it("valve_pending with its reason and room", () => {
          const result = tick(joining(BUILDER_THERMOSTAT));
          expect(problemsOf(result, "valve_pending")).toEqual([
            {
              kind: "valve_pending",
              subject: { kind: "valve", id: V },
              severity: "warning",
              data: {
                reason: "originals_unreadable",
                roomId: BUILDER_ROOM,
                settings: "sensor_source",
              },
            },
          ]);
          expect(result.pending).toEqual([
            {
              valveId: V,
              roomId: BUILDER_ROOM,
              reason: "originals_unreadable",
              unreadable: ["sensor_source"],
            },
          ]);
        });
      });
      describe("With a valve in notInHa", () => {
        it("valve_not_in_ha", () => {
          const world = equalWorld();
          const house: HouseInput = {
            kind: "live",
            membership: storedOf(world).membership ?? makeMembership({}),
            notInHa: [V],
          };
          expect(problemsOf(tick({ ...world, house }), "valve_not_in_ha")).toEqual([
            {
              kind: "valve_not_in_ha",
              subject: { kind: "valve", id: V },
              severity: "warning",
              data: {},
            },
          ]);
        });
      });
    });
  });

  describe("tick — start buckets", () => {
    const fresh = (buckets: World["buckets"]): World => ({
      ...equalWorld(),
      memory: { valves: new Map(), rooms: new Map() },
      buckets,
    });
    describe("With a valve that has no memory and a stamp for it", () => {
      it("its memory starts with the bucket the stamp carries", () => {
        const base = fresh(undefined);
        const now = nowOf(base);
        const world = fresh({ stamps: new Map([[V, now + 2.5 * REFILL_MS]]), fallback: 0 });
        expect(tokensAt(vmOf(tick(world)), now)).toBeCloseTo(BUCKET - 2.5 - 1, 9);
      });
    });
    describe("With a valve that has no memory and no stamp", () => {
      it("its memory starts with the fallback bucket", () => {
        const now = nowOf(fresh(undefined));
        const empty = fresh({ stamps: new Map(), fallback: now + BUCKET * REFILL_MS });
        expect(tokensAt(vmOf(tick(empty)), now)).toBe(0);
        const full = fresh({ stamps: new Map(), fallback: 0 });
        // The valve has not been heard, so the tick asks it once: one token.
        expect(tokensAt(vmOf(tick(full)), now)).toBe(BUCKET - 1);
      });
    });
    describe("With a valve that already has memory", () => {
      it("the stamps are not applied", () => {
        const base = equalWorld();
        const first = tick(base);
        const held = vmOf(first);
        expect(held.tokens).toBeGreaterThan(0);
        const world = {
          ...base,
          memory: first.memory,
          buckets: { stamps: new Map(), fallback: nowOf(base) + BUCKET * REFILL_MS },
        };
        expect(vmOf(tick(world)).tokens).toBe(held.tokens);
      });
    });
  });

  // The room thermostat (plan 3a, Task 5) ------------------------------------------------------

  /** A second valve of the builder room: a TRV-ZBT. */
  const V2 = "z2m:0x00124b0000000002";

  /** Heat at 22, as an override at 22 wants it. */
  const HEAT_22: ThermostatWanted = { mode: "heat", setpoint: 22, scheduled: false };

  /**
   * The world with the valve's expectation confirmed at `wanted`, its saved week kept: what an
   * earlier tick left when the valve showed it (an override that has since ended, a held value).
   */
  function confirmedAt(world: World, wanted: ThermostatWanted, valveId = V): World {
    const week = world.thermostats?.valves.get(valveId)?.week;
    return withExpectation(world, makeExpectation({ confirmed: wanted, week }), valveId);
  }

  /** The valve shows heat 22 and is confirmed there, as in an override at 22. */
  function overridden(world: World, valveId = V): World {
    return confirmedAt(
      withValues(world, { system_mode: "heat", setpoint: 22 }, valveId),
      HEAT_22,
      valveId,
    );
  }

  /** The world with the room's thermostat set. */
  function withThermostat(world: World, thermostat: Thermostat, roomId = BUILDER_ROOM): World {
    const state = world.thermostats ?? EMPTY_THERMOSTAT_STATE;
    const rooms = new Map(state.rooms);
    rooms.set(roomId, thermostat);
    return { ...world, thermostats: { ...state, rooms } };
  }

  /** The resolved week holding `day` on every weekday. */
  function everyDay(day: ResolvedDay): ResolvedWeek {
    return { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day };
  }

  /** The thermostat state after the tick, which must be readable. */
  function stateAfter(result: TickResult): ThermostatState {
    if (result.thermostats === undefined) throw new Error("the state is unreadable");
    return result.thermostats;
  }

  /** An override at 22 made `agoMs` before the world's now, ending in an hour unless told. */
  function overrideAt(
    world: World,
    agoMs: number,
    over: Parameters<typeof makeThermostat>[0] = {},
  ) {
    return makeThermostat({
      since: nowOf(world) - agoMs,
      endsAt: nowOf(world) + HOUR_MS,
      ...over,
    });
  }

  /** A settled TRV-ZBT in the builder room showing `EQUAL_ZBT`, on the builder week unless told. */
  function zbtWorld(day?: ResolvedDay): World {
    const base = makeManaged({ model: "trv_zbt", state: makeState({ values: EQUAL_ZBT }) });
    return settled(day === undefined ? base : withWeekDay(base, day));
  }

  /** The builder room holding the TRVZB `V` and the TRV-ZBT `V2`, both equal, settled. */
  function pairWorld(sensors: readonly SensorRef[] = []): World {
    const base = makeManaged({ sensors, state: makeState({ values: EQUAL }) });
    const placed = withRooms(base, (rooms) =>
      rooms.map((room) => ({ ...room, valves: [...room.valves, { valveId: V2 }] })),
    );
    const ledger = withRecord(placed.ledger ?? EMPTY_LEDGER, {
      valveId: V2,
      profile: "sonoff_trv_zbt",
      adoptedAt: NOW_MS - 24 * HOUR_MS,
      originals: makeOriginals("trv_zbt"),
    });
    const world = withView(
      { ...placed, ledger },
      {
        name: "second",
        spec: makeSpec("trv_zbt"),
        usable: true,
        state: makeState({ values: EQUAL_ZBT }),
      },
      V2,
    );
    return settled(sensors.length > 0 ? withSensor(world, reading(20)) : world);
  }

  /** The publishes that carry a mode or a setpoint. */
  function thermostatWrites(effects: readonly Effect[], valveId?: string): readonly Effect[] {
    return effects.filter(
      (e) =>
        e.kind === "publish" &&
        (valveId === undefined || e.valveId === valveId) &&
        ("system_mode" in e.values || "setpoint" in e.values),
    );
  }

  function saveIndex(result: TickResult): number {
    return result.effects.findIndex((e) => e.kind === "saveThermostats");
  }

  describe("tick", () => {
    describe("expiry", () => {
      describe("With an override whose endsAt has passed", () => {
        const base = confirmedAt(
          withValues(equalWorld(), { system_mode: "heat", setpoint: 22 }),
          HEAT_22,
        );
        const world = withThermostat(
          base,
          overrideAt(base, HOUR_MS, { rule: "timer", endsAt: nowOf(base) - MINUTE_MS }),
        );
        const result = tick(world);
        it("the room's thermostat is schedule", () => {
          expect(stateAfter(result).rooms.has(BUILDER_ROOM)).toBe(false);
          expect(result.rooms.get(BUILDER_ROOM)?.thermostat).toEqual(SCHEDULE);
        });
        it("saveThermostats comes before any valve write", () => {
          const writes = thermostatWrites(result.effects);
          expect(writes).not.toEqual([]);
          for (const write of writes) {
            expect(saveIndex(result)).toBeLessThan(result.effects.indexOf(write));
          }
          expect(saveIndex(result)).toBeGreaterThanOrEqual(0);
        });
        it("the valves are wanted in auto", () => {
          expect(publishes(valveEffects(result))).toEqual([{ system_mode: "auto" }]);
        });
      });
      describe("With a manual override a week old", () => {
        it("it stays", () => {
          const base = confirmedAt(
            withValues(equalWorld(), { system_mode: "heat", setpoint: 22 }),
            HEAT_22,
          );
          const manual = overrideAt(base, 7 * 24 * HOUR_MS, { rule: "manual", endsAt: undefined });
          const result = tick(withThermostat(base, manual));
          expect(stateAfter(result).rooms.get(BUILDER_ROOM)).toEqual(manual);
          expect(saveIndex(result)).toBe(-1);
        });
      });
      describe("With a TRV-ZBT in heat 22 after a timed override ended, its confirmed week at 19 now", () => {
        it("a publish of system_mode auto and setpoint 19 in one message", () => {
          const base = confirmedAt(
            withValues(zbtWorld(points("00:00/17 06:30/19 22:00/17")), {
              system_mode: "heat",
              setpoint: 22,
            }),
            HEAT_22,
          );
          const ended = overrideAt(base, HOUR_MS, { rule: "timer", endsAt: nowOf(base) });
          const result = tick(withThermostat(base, ended));
          expect(publishes(valveEffects(result))).toEqual([{ system_mode: "auto", setpoint: 19 }]);
        });
      });
    });

    describe("desired", () => {
      describe("With a room on its schedule and a TRVZB in heat", () => {
        it("a publish of the thermostat group with system_mode auto", () => {
          // The override that put it there has ended.
          const world = confirmedAt(
            withValues(equalWorld(), { system_mode: "heat", setpoint: 22 }),
            HEAT_22,
          );
          expect(publishes(valveEffects(tick(world)))).toEqual([{ system_mode: "auto" }]);
        });
      });
      describe("With a room on its schedule and a TRVZB showing auto 23 after its week was rewritten", () => {
        it("no thermostat write", () => {
          const world = withValues(equalWorld(), { system_mode: "auto", setpoint: 23 });
          expect(thermostatWrites(tick(world).effects)).toEqual([]);
        });
      });
      describe("With a room overridden next_change at 22 and a TRV-ZBT in auto at 22", () => {
        it("a publish with system_mode heat then setpoint 22, both in one message", () => {
          const base = withValues(zbtWorld(), { system_mode: "auto", setpoint: 22 });
          const world = withThermostat(base, overrideAt(base, 10 * MINUTE_MS));
          const [values] = publishes(valveEffects(tick(world)));
          expect(values).toEqual({ system_mode: "heat", setpoint: 22 });
          expect(Object.keys(values ?? {})).toEqual(["system_mode", "setpoint"]);
        });
      });
      describe("With a TRV-ZBT on schedule holding 22 in auto, no value of its week", () => {
        it("a publish of system_mode auto and the value in force", () => {
          // The held value was recorded while the week was unconfirmed (R22 a).
          const world = confirmedAt(withValues(zbtWorld(), { system_mode: "auto", setpoint: 22 }), {
            mode: "auto",
            setpoint: 22,
            scheduled: true,
          });
          expect(publishes(valveEffects(tick(world)))).toEqual([
            { system_mode: "auto", setpoint: 20 },
          ]);
        });
      });
      describe("With a room off", () => {
        it("each valve is wanted off", () => {
          const base = pairWorld();
          const result = tick(withThermostat(base, overrideAt(base, MINUTE_MS, { kind: "off" })));
          expect(publishes(valveEffects(result, V))).toEqual([{ system_mode: "off" }]);
          expect(publishes(valveEffects(result, V2))).toEqual([{ system_mode: "off" }]);
        });
      });
      describe("With the frost protection differing", () => {
        it("a publish of frost_protection", () => {
          const world = withValues(equalWorld(), { frost_protection: 10 });
          expect(publishes(valveEffects(tick(world)))).toEqual([{ frost_protection: 7 }]);
        });
      });
      describe("With thermostats undefined", () => {
        const base = withValues(equalWorld(), {
          system_mode: "heat",
          setpoint: 22,
          frost_protection: 10,
        });
        const world: World = { ...base, thermostats: undefined };
        const [, effects] = drive(world, 4, 3 * SECOND_MS);
        it("no publish carries system_mode or setpoint", () => {
          expect(thermostatWrites(effects)).toEqual([]);
        });
        it("frost_protection is still written", () => {
          expect(publishes(effects)).toEqual([{ frost_protection: 7 }]);
        });
        it("problem state_unreadable", () => {
          expect(problemsOf(tick(world), "state_unreadable")).toHaveLength(1);
        });
      });
      describe("With writes held and an override", () => {
        it("nothing is published and the thermostat is kept", () => {
          const base = held(equalWorld());
          const override = overrideAt(base, MINUTE_MS);
          const result = tick(withThermostat(base, override));
          expect(publishes(result.effects)).toEqual([]);
          expect(stateAfter(result).rooms.get(BUILDER_ROOM)).toEqual(override);
        });
      });
    });

    describe("settle", () => {
      const settle = (since: (world: World) => number, origin: Thermostat["kind"] = "override") => {
        const base = pairWorld();
        const thermostat = makeThermostat({
          kind: origin === "off" ? "off" : "override",
          since: since(base),
          endsAt: nowOf(base) + HOUR_MS,
        });
        return tick(withThermostat(base, thermostat));
      };
      describe("With a valve-origin override 4 s old", () => {
        it("no valve of the room gets a thermostat write", () => {
          const base = pairWorld();
          const thermostat = overrideAt(base, 4 * SECOND_MS, {
            origin: { source: "valve", valveId: V },
          });
          expect(thermostatWrites(tick(withThermostat(base, thermostat)).effects)).toEqual([]);
        });
      });
      describe("With a climate-origin override 4 s old", () => {
        it("no valve of the room gets a thermostat write", () => {
          const base = pairWorld();
          const thermostat = overrideAt(base, 4 * SECOND_MS, {
            origin: { source: "climate", valveId: undefined },
          });
          expect(thermostatWrites(tick(withThermostat(base, thermostat)).effects)).toEqual([]);
        });
      });
      describe("With an override 11 s old", () => {
        it("every valve that differs gets the thermostat write", () => {
          const result = settle((world) => nowOf(world) - 11 * SECOND_MS);
          expect(publishes(valveEffects(result, V))).toEqual([
            { system_mode: "heat", setpoint: 22 },
          ]);
          expect(publishes(valveEffects(result, V2))).toEqual([
            { system_mode: "heat", setpoint: 22 },
          ]);
        });
      });
      describe("With an override whose since is 1 min in the future", () => {
        it("the thermostat write goes out", () => {
          const result = settle((world) => nowOf(world) + MINUTE_MS);
          expect(thermostatWrites(result.effects, V)).toHaveLength(1);
          expect(thermostatWrites(result.effects, V2)).toHaveLength(1);
        });
      });
      describe("With a resume 1 s old", () => {
        it("the thermostat write goes out", () => {
          // A resume puts the room back on its schedule, which has no start to settle from.
          const shown = withValues(pairWorld(), { system_mode: "heat", setpoint: 22 });
          const base = confirmedAt(shown, HEAT_22);
          const result = tick(withThermostat(base, SCHEDULE));
          expect(publishes(valveEffects(result, V))).toEqual([{ system_mode: "auto" }]);
        });
      });
    });

    describe("schedule points", () => {
      describe("With a TRV-ZBT on schedule showing the next point's value 70 s before Heatmaster's point", () => {
        it("no thermostat write", () => {
          // The builder week moves from 17 to 20 at 06:30; the valve's clock runs ahead.
          const base = zbtWorld();
          const tuesday = Temporal.ZonedDateTime.from(
            "2026-11-17T06:28:50+01:00[Europe/Amsterdam]",
          );
          const world = withValues(
            { ...base, now: tuesday },
            { system_mode: "auto", setpoint: 20 },
          );
          expect(thermostatWrites(tick(world).effects)).toEqual([]);
        });
      });
      describe("With a TRV-ZBT on schedule and its week unconfirmed", () => {
        it("it is wanted in auto alone", () => {
          const base = confirmedAt(
            withValues(zbtWorld(), { system_mode: "heat", setpoint: 22 }),
            HEAT_22,
          );
          const changed = withWeekDay(base, OTHER_DAY);
          const first = tick(changed);
          expect(publishes(valveEffects(first))).toEqual([sevenDays(OTHER_DAY)]);
          // The new week is written and not heard since.
          const second = tick(next(changed, first, 3 * SECOND_MS));
          expect(publishes(valveEffects(second))).toEqual([{ system_mode: "auto" }]);
        });
      });
    });

    describe("release", () => {
      describe("With a releasing TRV-ZBT captured in auto and showing auto 17", () => {
        const base = zbtWorld();
        const ledger = withRecord(EMPTY_LEDGER, {
          valveId: V,
          profile: "sonoff_trv_zbt",
          adoptedAt: NOW_MS - 24 * HOUR_MS,
          originals: {
            active_group: 3,
            sensor_source: "internal",
            frost_protection: 7,
            system_mode: "auto",
            setpoint: 17,
          },
        });
        const world = released({ ...base, ledger });
        const [, effects] = drive(world, 10, 3 * MINUTE_MS);
        it("no thermostat candidate, and the release finishes", () => {
          expect(thermostatWrites(effects)).toEqual([]);
          const ledgers = effects.flatMap((e) => (e.kind === "saveLedger" ? [e.ledger] : []));
          expect(ledgers.at(-1)?.records.has(V)).toBe(false);
        });
      });
    });

    describe("effect order", () => {
      describe("With a push due, a frost write on one valve and a thermostat write on another", () => {
        it("the push and the frost publish come before saveThermostats, and the thermostat publish after it", () => {
          // Both valves are fed from the room's sensor.
          let base = pairWorld([SENSOR]);
          base = withValues(base, { sensor_source: "external" }, V2);
          base = withValues(base, { sensor_source: "external", frost_protection: 10 }, V);
          base = withValues(base, { system_mode: "heat", setpoint: 22 }, V2);
          base = confirmedAt(base, HEAT_22, V2);
          base = warmer(base);
          const ended = overrideAt(base, HOUR_MS, { rule: "timer", endsAt: nowOf(base) });
          const result = tick(withThermostat(base, ended));
          const at = (find: (e: Effect) => boolean): number => result.effects.findIndex(find);
          const push = at((e) => e.kind === "pushTemperature" && e.valveId === V);
          const frost = at((e) => e.kind === "publish" && "frost_protection" in e.values);
          const mode = at((e) => e.kind === "publish" && "system_mode" in e.values);
          expect([push, frost, mode].every((i) => i >= 0)).toBe(true);
          expect(push).toBeLessThan(saveIndex(result));
          expect(frost).toBeLessThan(saveIndex(result));
          expect(mode).toBeGreaterThan(saveIndex(result));
        });
      });
    });

    describe("pruning", () => {
      const gone = (world: World): World =>
        withThermostat(world, overrideAt(world, MINUTE_MS), "gone");
      describe("With a saved thermostat for a room that is no longer resolved", () => {
        it("saveThermostats without it", () => {
          const result = tick(gone(equalWorld()));
          const save = result.effects.find((e) => e.kind === "saveThermostats");
          expect(save?.kind === "saveThermostats" && save.state.rooms.has("gone")).toBe(false);
          expect(save).toBeDefined();
        });
      });
      describe("With the house frozen", () => {
        it("the thermostat is kept", () => {
          const base = gone(equalWorld());
          const membership = storedOf(base).membership;
          const world: World = {
            ...base,
            house: { kind: "frozen", membership, reason: "link_down" },
          };
          const result = tick(world);
          expect(stateAfter(result).rooms.has("gone")).toBe(true);
          expect(saveIndex(result)).toBe(-1);
        });
      });
    });

    describe("saving", () => {
      describe("With nothing changed", () => {
        it("no saveThermostats", () => {
          const base = overridden(equalWorld());
          expect(saveIndex(tick(withThermostat(base, overrideAt(base, MINUTE_MS))))).toBe(-1);
        });
      });
      describe("By default", () => {
        it("result.thermostats is the state after the tick", () => {
          const base = overridden(equalWorld());
          const kept = withThermostat(base, overrideAt(base, MINUTE_MS));
          expect(tick(kept).thermostats).toBe(kept.thermostats);
          const ended = withThermostat(base, overrideAt(base, HOUR_MS, { endsAt: nowOf(base) }));
          const result = tick(ended);
          const save = result.effects.find((e) => e.kind === "saveThermostats");
          expect(save?.kind === "saveThermostats" ? save.state : undefined).toBe(
            result.thermostats,
          );
          expect(stateAfter(result).rooms.size).toBe(0);
        });
      });
    });

    describe("status", () => {
      describe("With an override at 22 until 18:00", () => {
        const base = equalWorld();
        const until = Temporal.ZonedDateTime.from("2026-11-16T18:00:00+01:00[Europe/Amsterdam]");
        const override = overrideAt(base, MINUTE_MS, { endsAt: until.epochMilliseconds });
        const room = tick(withThermostat(base, override)).rooms.get(BUILDER_ROOM);
        it("the room's thermostat, target 22, limits and end settings are reported", () => {
          expect(room).toMatchObject({
            thermostat: override,
            target: 22,
            limits: { min: 4, max: 35 },
            overrideEnd: DEFAULT_SETTINGS.overrideEnd,
            overrideDurationMs: DEFAULT_SETTINGS.overrideDurationMs,
          });
        });
        it("the room's mode is heat", () => {
          expect(room?.mode).toBe("heat");
        });
      });
      describe("With the room off", () => {
        it("the room's target is undefined and its mode off", () => {
          const base = equalWorld();
          const off = overrideAt(base, MINUTE_MS, { kind: "off" });
          const room = tick(withThermostat(base, off)).rooms.get(BUILDER_ROOM);
          expect(room?.target).toBeUndefined();
          expect(room?.mode).toBe("off");
        });
      });
      describe("With a TRVZB in heat in a room on its schedule", () => {
        it("the valve's sync is pending", () => {
          const world = confirmedAt(
            withValues(equalWorld(), { system_mode: "heat", setpoint: 22 }),
            HEAT_22,
          );
          expect(statusOf(tick(world)).sync).toBe("pending");
        });
      });
    });
  });

  // Expectations and adoption (plan 3a, Task 6) ------------------------------------------------

  /** A valve that is in no room and has no record. */
  const STRAY = "z2m:0x00124b00000000ff";

  /** The valve's expectation in the tick's saved state. */
  function expectationAfter(result: TickResult, valveId = V): ValveExpectation | undefined {
    return stateAfter(result).valves.get(valveId);
  }

  /** The state of the tick's `saveThermostats`, which must be there. */
  function savedState(result: TickResult): ThermostatState {
    const save = result.effects.find((e) => e.kind === "saveThermostats");
    if (save?.kind !== "saveThermostats") throw new Error("expected saveThermostats");
    return save.state;
  }

  /** Every thermostat publish of the tick comes after its `saveThermostats`. */
  function savedBeforeWrites(result: TickResult): boolean {
    const save = saveIndex(result);
    return (
      save >= 0 &&
      thermostatWrites(result.effects).every((write) => result.effects.indexOf(write) > save)
    );
  }

  /** The house frozen on its saved membership, Home Assistant down. */
  function frozen(world: World): World {
    return {
      ...world,
      house: { kind: "frozen", membership: storedOf(world).membership, reason: "link_down" },
    };
  }

  /** The world as the application finds it after a start: no memory. */
  function restarted(world: World): World {
    return { ...world, memory: EMPTY_MEMORY };
  }

  const AUTO_ON_SCHEDULE: ThermostatWanted = { mode: "auto", setpoint: undefined, scheduled: true };

  describe("tick", () => {
    describe("With thermostats undefined and a valve that differs", () => {
      const world: World = {
        ...withValues(equalWorld(), { system_mode: "heat", setpoint: 22 }),
        thermostats: undefined,
      };
      const result = tick(world);
      it("nothing is judged and no expectation changes", () => {
        expect(result.thermostats).toBeUndefined();
        expect(saveIndex(result)).toBe(-1);
      });
      it("no thermostat write", () => {
        expect(thermostatWrites(result.effects)).toEqual([]);
      });
    });

    describe("With the house frozen (Home Assistant down) and a knob turned on a TRVZB", () => {
      const base = frozen(withExpectation(pairWorld(), makeExpectation(), STRAY));
      const world = hear(base, { system_mode: "heat", setpoint: 23 });
      const result = tick(world);
      it("an override is adopted and saved before any write to the room's valves", () => {
        expect(savedState(result).rooms.get(BUILDER_ROOM)).toMatchObject({
          kind: "override",
          target: 23,
          origin: { source: "valve", valveId: V },
        });
        expect(savedBeforeWrites(result)).toBe(true);
      });
      it("nothing is pruned", () => {
        expect(savedState(result).valves.has(STRAY)).toBe(true);
      });
    });

    describe("With a page command applied while the house is frozen", () => {
      it("the writes it causes join sent, and nothing is adopted once the house is live", () => {
        const base = frozen(equalWorld());
        const [save] = thermostatCommand(
          base,
          BUILDER_ROOM,
          { kind: "set_target", celsius: 23, end: undefined },
          { source: "api", valveId: undefined },
        );
        if (save?.kind !== "saveThermostats") throw new Error("expected saveThermostats");
        const commanded = later({ ...base, thermostats: save.state }, THERMOSTAT_SETTLE_MS);
        const written = tick(commanded);
        expect(publishes(valveEffects(written))).toEqual([{ system_mode: "heat", setpoint: 23 }]);
        expect(expectationAfter(written)?.sent[0]?.wanted).toEqual({
          mode: "heat",
          setpoint: 23,
          scheduled: false,
        });
        // The TRVZB shows the mode first, at its last manual setpoint; Home Assistant is back.
        const shown = hear(next(commanded, written, SECOND_MS), { system_mode: "heat" });
        const live = { ...shown, house: liveHouse(roomsOf("ok", storedOf(shown), shown.house)) };
        const result = tick(later(live, SECOND_MS));
        expect(stateAfter(result).rooms.get(BUILDER_ROOM)).toEqual(
          save.state.rooms.get(BUILDER_ROOM),
        );
      });
    });

    describe("With a valve whose sent write is unconfirmed 60 s after it was sent and not heard since", () => {
      it("it gets one refresh, and no second one for that write", () => {
        const base = equalWorld();
        const world = withThermostat(base, overrideAt(base, MINUTE_MS));
        const sent = tick(world);
        expect(thermostatWrites(sent.effects)).toHaveLength(1);
        const due = tick(next(world, sent, SENT_RETIRE_MS + SECOND_MS));
        expect(valveEffects(due)).toEqual([{ kind: "refresh", valveId: V }]);
        const after = tick(next(world, due, SENT_RETIRE_MS + 30 * SECOND_MS));
        expect(valveEffects(after).filter((e) => e.kind === "refresh")).toEqual([]);
      });
    });

    describe("With a person's change on one of two valves", () => {
      const world = hear(pairWorld(), { system_mode: "heat", setpoint: 23 });
      const first = tick(world);
      it("saveThermostats with the override and both expectations comes first", () => {
        const state = savedState(first);
        expect(state.rooms.get(BUILDER_ROOM)).toMatchObject({ kind: "override", target: 23 });
        expect(state.valves.get(V)?.confirmed).toEqual({
          mode: "heat",
          setpoint: 23,
          scheduled: false,
        });
        expect(state.valves.has(V2)).toBe(true);
        expect(savedBeforeWrites(first)).toBe(true);
      });
      it("neither valve is written before THERMOSTAT_SETTLE_MS, the other one after", () => {
        expect(thermostatWrites(first.effects)).toEqual([]);
        const settling = tick(next(world, first, THERMOSTAT_SETTLE_MS - SECOND_MS));
        expect(thermostatWrites(settling.effects)).toEqual([]);
        const settled = tick(next(world, first, THERMOSTAT_SETTLE_MS));
        expect(publishes(valveEffects(settled, V2))).toEqual([
          { system_mode: "heat", setpoint: 23 },
        ]);
        expect(thermostatWrites(settled.effects, V)).toEqual([]);
      });
    });

    describe("With a release in progress for a valve of the room", () => {
      it("its reports are not judged and its expectation is dropped", () => {
        const base = equalWorld();
        const kept = base.thermostats?.valves.get(V);
        const releasing = withExpectation(released(base), kept);
        const result = tick(hear(releasing, { system_mode: "heat", setpoint: 23 }));
        const state = savedState(result);
        expect(state.valves.has(V)).toBe(false);
        expect(state.rooms.has(BUILDER_ROOM)).toBe(false);
      });
    });

    describe("With a valve managed again after its release had begun, showing the release's heat 23", () => {
      it("nothing is adopted and it is written auto", () => {
        const world = readded(
          withValues(released(equalWorld()), { system_mode: "heat", setpoint: 23 }),
        );
        const result = tick(world);
        expect(stateAfter(result).rooms.has(BUILDER_ROOM)).toBe(false);
        expect(expectationAfter(result)?.roomId).toBe(BUILDER_ROOM);
        expect(publishes(valveEffects(result))).toEqual([{ system_mode: "auto" }]);
      });
    });

    describe("With a valve that moved to another room", () => {
      it("it is taken over and written what its new room wants", () => {
        const base = equalWorld();
        const moved = withRooms(base, (rooms) => [
          ...rooms.map((room) => ({ ...room, valves: [] })),
          ...rooms.map((room) => ({ ...room, id: "kitchen", name: "Kitchen" })),
        ]);
        const world = withThermostat(moved, overrideAt(moved, MINUTE_MS), "kitchen");
        const result = tick(world);
        expect(expectationAfter(result)?.roomId).toBe("kitchen");
        expect(stateAfter(result).rooms.get("kitchen")).toEqual(
          world.thermostats?.rooms.get("kitchen"),
        );
        expect(publishes(valveEffects(result))).toEqual([{ system_mode: "heat", setpoint: 22 }]);
      });
    });

    describe('With a valve joined through "accept unknown originals" (a record, no expectation)', () => {
      it("it is taken over: nothing is adopted and it is written auto", () => {
        const world = withExpectation(
          withValues(equalWorld(), { system_mode: "heat", setpoint: 23 }),
          undefined,
        );
        const result = tick(world);
        expect(stateAfter(result).rooms.has(BUILDER_ROOM)).toBe(false);
        expect(expectationAfter(result)).toMatchObject({
          roomId: BUILDER_ROOM,
          confirmed: undefined,
        });
        expect(publishes(valveEffects(result))).toEqual([{ system_mode: "auto" }]);
      });
    });

    describe("With no state file (the first start of 0.3.0) and a valve in heat 17", () => {
      it("nothing is adopted and it is written auto", () => {
        const base = withValues(equalWorld(), { system_mode: "heat", setpoint: 17 });
        const result = tick({ ...base, thermostats: EMPTY_THERMOSTAT_STATE });
        expect(stateAfter(result).rooms.has(BUILDER_ROOM)).toBe(false);
        expect(publishes(valveEffects(result))).toEqual([{ system_mode: "auto" }]);
      });
    });

    describe("With a restart, an expectation confirmed auto and a cached report heat 22 (a knob turned while Heatmaster was down)", () => {
      it("an override at 22 is saved before any write to the room's valves", () => {
        const base = pairWorld();
        const cached = withState(
          base,
          makeState({
            values: { ...EQUAL, system_mode: "heat", setpoint: 22 },
            nowMs: nowOf(base),
          }),
        );
        const result = tick(restarted(cached));
        expect(savedState(result).rooms.get(BUILDER_ROOM)).toMatchObject({
          kind: "override",
          target: 22,
        });
        expect(savedBeforeWrites(result)).toBe(true);
      });
    });

    describe("With a restart after an override ended while Heatmaster was down, confirmed heat 22 and the valve at heat 22", () => {
      it("nothing is adopted and the valve is written auto", () => {
        const base = overridden(equalWorld());
        const ended = overrideAt(base, 3 * HOUR_MS, {
          rule: "timer",
          endsAt: nowOf(base) - HOUR_MS,
        });
        const world = restarted(withThermostat(base, ended));
        const [last, effects] = drive(world, 6, 30 * SECOND_MS);
        expect(last.thermostats?.rooms.has(BUILDER_ROOM)).toBe(false);
        expect(publishes(effects.filter((e) => "valveId" in e && e.valveId === V))).toContainEqual({
          system_mode: "auto",
        });
      });
    });

    describe("With a restart after a timed override ended on a TRV-ZBT, its week unconfirmed at the start", () => {
      it("nothing is adopted, then or once the week is confirmed", () => {
        const base = overridden(zbtWorld());
        const ended = overrideAt(base, 3 * HOUR_MS, {
          rule: "timer",
          endsAt: nowOf(base) - HOUR_MS,
        });
        const world = restarted(withThermostat(base, ended));
        const [last, effects] = drive(world, 10, 30 * SECOND_MS);
        const saves = effects.flatMap((e) => (e.kind === "saveThermostats" ? [e.state] : []));
        expect(saves.some((state) => state.rooms.has(BUILDER_ROOM))).toBe(false);
        expect(last.thermostats?.rooms.has(BUILDER_ROOM)).toBe(false);
        expect(stateOf(last).values.system_mode).toBe("auto");
      });
    });

    describe("With a TRV-ZBT confirmed auto 19 scheduled, week values undefined, showing auto 24, the desired week changed", () => {
      const base = confirmedAt(
        withValues(zbtWorld(points("00:00/17 06:30/19 22:00/17")), {
          system_mode: "auto",
          setpoint: 24,
        }),
        { mode: "auto", setpoint: 19, scheduled: true },
      );
      const changed = withWeekDay(base, OTHER_DAY);
      const first = tick(changed);
      it("its confirmed state becomes auto 24 scheduled", () => {
        expect(stateAfter(first).rooms.has(BUILDER_ROOM)).toBe(false);
        expect(expectationAfter(first)?.confirmed).toEqual({
          mode: "auto",
          setpoint: 24,
          scheduled: true,
        });
      });
      it("once the week is confirmed it is written auto with the value in force", () => {
        expect(publishes(valveEffects(first))).toEqual([sevenDays(OTHER_DAY)]);
        const heard = hear(next(changed, first, 3 * SECOND_MS), sevenDays(OTHER_DAY));
        const result = tick(later(heard, SECOND_MS));
        expect(stateAfter(result).rooms.has(BUILDER_ROOM)).toBe(false);
        // OTHER_DAY holds 21 from 07:00 to 23:00.
        expect(publishes(valveEffects(result))).toEqual([{ system_mode: "auto", setpoint: 21 }]);
      });
    });

    describe("With a TRV-ZBT on schedule passing its own points", () => {
      it("no saveThermostats", () => {
        const base = zbtWorld();
        const evening = (time: string): Temporal.ZonedDateTime =>
          Temporal.ZonedDateTime.from(`2026-11-17T${time}+01:00[Europe/Amsterdam]`);
        let world = withValues({ ...base, now: evening("21:58:00") }, { setpoint: 20 });
        const before = tick(world);
        world = hear(next(world, before, 2 * MINUTE_MS), { setpoint: 17 });
        const after = tick(later(world, 30 * SECOND_MS));
        expect(saveIndex(before)).toBe(-1);
        expect(saveIndex(after)).toBe(-1);
        expect(thermostatWrites([...before.effects, ...after.effects])).toEqual([]);
      });
    });

    describe("With a TRV-ZBT confirmed auto 19 scheduled and no saved week, once its week is confirmed, showing auto 19", () => {
      const day = points("00:00/17 06:30/19 22:00/17");
      const base = zbtWorld(day);
      const world = withExpectation(
        withValues(base, { setpoint: 19 }),
        makeExpectation({ confirmed: { mode: "auto", setpoint: 19, scheduled: true } }),
      );
      const result = tick(world);
      it("its week is saved with the week's key and values, and saveThermostats follows", () => {
        const week = fitted(everyDay(day), makeSpec("trv_zbt")).days;
        expect(savedState(result).valves.get(V)?.week).toEqual({
          key: weekKey(week),
          values: [17, 19],
        });
      });
      it("no thermostat write", () => {
        expect(thermostatWrites(result.effects)).toEqual([]);
      });
    });

    describe("With a TRV-ZBT whose week edit was just confirmed on the valve", () => {
      it("its saved week carries the new key, saved once", () => {
        const changed = withWeekDay(zbtWorld(), OTHER_DAY);
        const [, effects] = drive(changed, 8, 30 * SECOND_MS);
        const newKey = weekKey(fitted(everyDay(OTHER_DAY), makeSpec("trv_zbt")).days);
        const keys = effects.flatMap((e) =>
          e.kind === "saveThermostats" ? [e.state.valves.get(V)?.week?.key] : [],
        );
        expect(keys.filter((key) => key === newKey)).toHaveLength(1);
        expect(keys.at(-1)).toBe(newKey);
      });
    });

    describe("With a TRV-ZBT confirmed auto 24 scheduled (recorded), its week confirmed, showing its own point's 21", () => {
      // OTHER_DAY holds 21 from 07:00 to 23:00.
      const base = confirmedAt(withValues(zbtWorld(OTHER_DAY), { setpoint: 21 }), {
        mode: "auto",
        setpoint: 24,
        scheduled: true,
      });
      const first = tick(base);
      it("its confirmed state becomes auto 21 scheduled and no write goes out", () => {
        expect(expectationAfter(first)?.confirmed).toEqual({
          mode: "auto",
          setpoint: 21,
          scheduled: true,
        });
        expect(thermostatWrites(first.effects)).toEqual([]);
      });
      it("a later report auto 24 is a person's change", () => {
        const turned = hear(next(base, first, MINUTE_MS), { setpoint: 24 });
        const result = tick(later(turned, SECOND_MS));
        expect(stateAfter(result).rooms.get(BUILDER_ROOM)).toMatchObject({
          kind: "override",
          target: 24,
        });
      });
    });

    describe("With a TRV-ZBT with a saved week, its week unconfirmed and another group seen active, showing auto 24", () => {
      it("nothing is adopted", () => {
        const world = hear(zbtWorld(), { active_group: 1, setpoint: 24 });
        const result = tick(world);
        expect(stateAfter(result).rooms.has(BUILDER_ROOM)).toBe(false);
      });
    });

    describe("With a sent write", () => {
      it("its from is what the valve showed in the tick it was published", () => {
        const base = equalWorld();
        const result = tick(withThermostat(base, overrideAt(base, MINUTE_MS)));
        expect(expectationAfter(result)?.sent[0]?.from).toEqual({ mode: "auto", setpoint: 17 });
      });
    });

    describe("With a thermostat publish to a valve", () => {
      const base = equalWorld();
      const result = tick(withThermostat(base, overrideAt(base, MINUTE_MS)));
      it("the wanted state is first in its sent list", () => {
        expect(expectationAfter(result)?.sent[0]).toMatchObject({
          wanted: { mode: "heat", setpoint: 22, scheduled: false },
          at: nowOf(base),
        });
      });
      it("saveThermostats comes before the publish", () => {
        expect(thermostatWrites(result.effects)).toHaveLength(1);
        expect(savedBeforeWrites(result)).toBe(true);
      });
    });

    describe("With the same wanted state written again after a backoff", () => {
      it("sent holds it once", () => {
        const base = equalWorld();
        let world = withThermostat(base, overrideAt(base, MINUTE_MS));
        let writes = 0;
        // Long enough for the backoff and a token to come back.
        for (let i = 0; i < 90; i++) {
          const result = tick(world);
          writes += thermostatWrites(result.effects).length;
          world = next(world, result, 30 * SECOND_MS);
        }
        expect(writes).toBeGreaterThanOrEqual(2);
        const sent = world.thermostats?.valves.get(V)?.sent ?? [];
        expect(sent.filter((s) => s.wanted.mode === "heat")).toHaveLength(1);
      });
    });

    describe("With a valve already matching a new wanted state", () => {
      it("its confirmed state is the wanted one and no write goes out", () => {
        const result = tick(withExpectation(equalWorld(), undefined));
        expect(expectationAfter(result)?.confirmed).toEqual(AUTO_ON_SCHEDULE);
        expect(thermostatWrites(result.effects)).toEqual([]);
      });
    });

    describe("With a stray valve's expectation and the house live", () => {
      it("it is dropped from the saved state", () => {
        const world = withExpectation(equalWorld(), makeExpectation(), STRAY);
        expect(savedState(tick(world)).valves.has(STRAY)).toBe(false);
      });
    });

    describe("With nothing changed", () => {
      it("no saveThermostats", () => {
        expect(saveIndex(tick(equalWorld()))).toBe(-1);
      });
    });
  });

  describe("confirmedWeek (a TRV-ZBT)", () => {
    const ZBT = makeSpec("trv_zbt");
    const world = zbtWorld();
    const week = fitted(everyDay(BUILDER_DAY), ZBT).days;
    describe("With the schedule written, unmarked and heard since", () => {
      it("the fitted week", () => {
        expect(confirmedWeek(ZBT, vmOf(world), stateOf(world), week)).toBe(week);
      });
    });
    describe("With a day write pending", () => {
      it("undefined", () => {
        expect(confirmedWeek(ZBT, neverWritten(vmOf(world)), stateOf(world), week)).toBeUndefined();
      });
    });
    describe("With a TRV-ZBT whose schedule was written but not heard since", () => {
      it("undefined", () => {
        const unheard = { ...stateOf(world), heardAt: undefined };
        expect(confirmedWeek(ZBT, vmOf(world), unheard, week)).toBeUndefined();
      });
    });
    describe("With a TRV-ZBT whose observed active_group is 1", () => {
      it("undefined", () => {
        const other = stateOf(withValues(world, { active_group: 1 }));
        expect(confirmedWeek(ZBT, vmOf(world), other, week)).toBeUndefined();
      });
    });
    describe("With the room's week changed in this tick", () => {
      it("undefined", () => {
        // Writes are held, so the tick notes the new week and sends nothing.
        const changed = held(withWeekDay(world, OTHER_DAY));
        const vm = vmOf(tick(changed));
        const otherWeek = fitted(everyDay(OTHER_DAY), ZBT).days;
        expect(confirmedWeek(ZBT, vm, stateOf(changed), otherWeek)).toBeUndefined();
      });
    });
  });

  describe("preview", () => {
    describe("With a change that joins a room whose TRVZB is in heat", () => {
      it("the planned writes include system_mode auto and frost_protection for it", () => {
        const values = {
          sensor_source: "internal",
          system_mode: "heat",
          setpoint: 22,
          frost_protection: 10,
        } as const;
        const joining: World = {
          ...makeManaged({ state: makeState({ values, heardAgoMs: 0 }) }),
          ledger: EMPTY_LEDGER,
        };
        const reconciled = reconcile(joining);
        const writes = preview({
          ...joining,
          stored: reconciled.stored,
          ledger: reconciled.ledger,
        });
        const planned = writes.filter((w) => w.valveId === V).map((w) => w.values);
        expect(planned).toContainEqual({ system_mode: "auto" });
        expect(planned).toContainEqual({ frost_protection: 7 });
      });
    });
  });
});
