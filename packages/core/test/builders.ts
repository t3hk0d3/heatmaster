import fc from "fast-check";
import {
  EMPTY_CONFIG,
  EMPTY_LEDGER,
  EMPTY_MEMORY,
  EMPTY_READINGS,
  FRESH_STORED,
  applyEvent,
  memberships,
  roomsOf,
  tick,
  withRecord,
} from "../src/index.ts";
import type {
  Config,
  DeviceState,
  DeviceView,
  Event,
  AreaMembership,
  Group,
  GroupSpec,
  HaSnapshot,
  HouseInput,
  Inbox,
  PresetName,
  RawConfig,
  Readings,
  ResolvedDay,
  Room,
  RoomEntry,
  Schedule,
  SensorRef,
  SetPoint,
  SettingValues,
  ValveRecord,
  ValveSpec,
  Week,
  World,
} from "../src/index.ts";

/**
 * A complete valid document: two schedules (`default`, the default schedule, and `night`), and two
 * entries with sensors: `living_room` on the default with a comfort preset, `office` on `night`.
 */
export function validRaw(): RawConfig {
  return {
    version: 3,
    settings: {
      external_write_interval_min: 10,
      sensor_stale_min: 30,
      hold_writes: false,
      timezone: "Europe/Amsterdam",
      language: "ru",
    },
    presets: { comfort: 21, eco: 18, frost: 8, boost: 24 },
    schedules: [
      {
        id: "default",
        name: "Default week",
        week: [
          {
            days: "weekdays",
            temperature: { "00:00": "eco", "06:30": "comfort", "22:00": 18 },
          },
          { days: "weekend", temperature: { "00:00": "eco" } },
        ],
      },
      {
        id: "night",
        name: "Night",
        week: [{ days: "all", temperature: { "00:00": "eco", "19:00": "comfort" } }],
      },
    ],
    default_schedule: "default",
    rooms: {
      living_room: {
        sensors: [
          { ref: "ha:sensor.bedroom_temperature" },
          { ref: "ha:sensor.living_temperature", weight: 2 },
        ],
        presets: { comfort: 22 },
      },
      office: { schedule: "night", sensors: [{ ref: "ha:sensor.office_temperature" }] },
    },
  };
}

const slug = fc.stringMatching(/^[a-z0-9]{1,8}$/);
const areaKey = fc.stringMatching(/^[a-z][a-z0-9_]{0,11}$/);
const halfDegree = fc.integer({ min: 8, max: 70 }).map((n) => n / 2);
const preset = fc.constantFrom<PresetName>("comfort", "eco", "frost", "boost");
const name = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 ]{0,30}$/);

const setPoint: fc.Arbitrary<(time: Temporal.PlainTime) => SetPoint> = fc.oneof(
  preset.map((p) => (time: Temporal.PlainTime): SetPoint => ({
    time,
    preset: p,
    temperature: undefined,
  })),
  halfDegree.map((t) => (time: Temporal.PlainTime): SetPoint => ({
    time,
    preset: undefined,
    temperature: t,
  })),
);

const day: fc.Arbitrary<readonly SetPoint[]> = fc
  .tuple(
    setPoint,
    fc.uniqueArray(fc.integer({ min: 1, max: 1439 }), { minLength: 0, maxLength: 5 }),
    fc.array(setPoint, { minLength: 5, maxLength: 5 }),
  )
  .map(([first, minutes, rest]) => [
    first(Temporal.PlainTime.from("00:00")),
    ...minutes
      .sort((a, b) => a - b)
      .map((m, i) =>
        (rest[i] ?? first)(Temporal.PlainTime.from({ hour: Math.floor(m / 60), minute: m % 60 })),
      ),
  ]);

const week: fc.Arbitrary<Week> = fc.array(day, { minLength: 7, maxLength: 7 }).map((days) => {
  const [mon, tue, wed, thu, fri, sat, sun] = days;
  return { mon, tue, wed, thu, fri, sat, sun } as Week;
});

const sensor: fc.Arbitrary<SensorRef> = fc.record({
  ref: fc.integer({ min: 0, max: 5 }).map((n) => `ha:sensor.s${String(n)}`),
  weight: fc.integer({ min: 1, max: 20 }).map((n) => n / 2),
});

const roomPresets = fc.record({
  comfort: fc.option(halfDegree, { nil: undefined }),
  eco: fc.option(halfDegree, { nil: undefined }),
  frost: fc.option(halfDegree, { nil: undefined }),
  boost: fc.option(halfDegree, { nil: undefined }),
});

/**
 * Any valid Config: unique schedule ids and names (ignoring case), a default schedule exactly when
 * there is a schedule, and entries keyed by area id that name existing schedules.
 */
export const arbConfig: fc.Arbitrary<Config> = fc
  .tuple(
    fc.uniqueArray(slug, { minLength: 0, maxLength: 3 }),
    fc.uniqueArray(areaKey, { minLength: 0, maxLength: 4 }),
  )
  .chain(([scheduleIds, areaIds]) =>
    fc.record({
      settings: fc.record({
        externalWriteIntervalMs: fc.integer({ min: 1, max: 60 }).map((n) => n * 60_000),
        sensorStaleAfterMs: fc.integer({ min: 10, max: 1440 }).map((n) => n * 60_000),
        holdWrites: fc.boolean(),
        timezone: fc.option(fc.constantFrom("Europe/Amsterdam", "UTC", "America/New_York"), {
          nil: undefined,
        }),
        language: fc.constantFrom<"en" | "ru">("en", "ru"),
      }),
      presets: fc.record({
        comfort: halfDegree,
        eco: halfDegree,
        frost: halfDegree,
        boost: halfDegree,
      }),
      schedules: fc
        .tuple(
          fc.uniqueArray(name, {
            minLength: scheduleIds.length,
            maxLength: scheduleIds.length,
            selector: (n) => n.toLowerCase(),
          }),
          fc.array(week, { minLength: scheduleIds.length, maxLength: scheduleIds.length }),
        )
        .map(([names, weeks]) =>
          scheduleIds.map((id, i): Schedule => ({
            id,
            name: names[i] ?? "x",
            defaultWeek: weeks[i] ?? weekOf([]),
          })),
        ),
      defaultScheduleId:
        scheduleIds.length === 0
          ? fc.constant(undefined)
          : fc.constantFrom<string | undefined>(...scheduleIds),
      rooms: fc
        .tuple(
          ...areaIds.map(() =>
            fc.record({
              scheduleId:
                scheduleIds.length === 0
                  ? fc.constant(undefined)
                  : fc.option(fc.constantFrom(...scheduleIds), { nil: undefined }),
              sensors: fc.uniqueArray(sensor, { maxLength: 4, selector: (s) => s.ref }),
              presets: roomPresets,
            }),
          ),
        )
        .map(
          (entries) =>
            new Map(entries.map((entry, i): [string, RoomEntry] => [areaIds[i] ?? "x", entry])),
        ),
    }),
  );

/** Reads `"00:00/16 07:00/19"` as a resolved day. */
export function points(text: string): ResolvedDay {
  return text
    .trim()
    .split(/\s+/)
    .map((item) => {
      const [time = "", temperature = ""] = item.split("/");
      return { time: Temporal.PlainTime.from(time), temperature: Number(temperature) };
    });
}

// Control builders (Task 10) ---------------------------------------------------------------------

/** A Monday noon in Amsterdam. Every builder uses it unless told otherwise. */
export const BUILDER_NOW = Temporal.ZonedDateTime.from(
  "2026-11-16T12:00:00+01:00[Europe/Amsterdam]",
);

const BUILDER_NOW_MS = BUILDER_NOW.epochMilliseconds;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** The valve `makeManaged` builds unless told otherwise. */
export const BUILDER_VALVE = "z2m:0x00124b0000000001";
/** The room `makeManaged` builds. */
export const BUILDER_ROOM = "living";
/** The schedule `makeConfig` builds unless told otherwise. */
export const BUILDER_SCHEDULE = "default";
/** Every day of the default schedule with the default presets (eco 17, comfort 20). */
export const BUILDER_DAY: ResolvedDay = points("00:00/17 06:30/20 22:00/17");

function groupSpec(
  group: Group,
  evidence: GroupSpec["evidence"],
  captured: boolean,
  readable: boolean,
): GroupSpec {
  return { group, evidence, maxAgeMs: 24 * HOUR_MS, capture: captured, readable };
}

/** The default values of Task 12's spec tables. */
export function makeSpec(model: "trvzb" | "trv_zbt"): ValveSpec {
  const common = {
    tempStep: 0.5,
    maxSetPoints: 6,
    activation: "none",
    externalSensor: true,
    feedWhenOff: false,
  } as const;
  if (model === "trvzb") {
    return {
      ...common,
      profile: "sonoff_trvzb",
      minTemp: 4,
      maxTemp: 35,
      slotCount: 6,
      scheduleGroup: undefined,
      groups: [
        groupSpec("schedule", "echoed", false, false),
        groupSpec("sensor_source", "acked", true, true),
      ],
    };
  }
  return {
    ...common,
    profile: "sonoff_trv_zbt",
    minTemp: 5,
    maxTemp: 30,
    slotCount: 12,
    scheduleGroup: 3,
    groups: [
      groupSpec("schedule", "none", false, false),
      groupSpec("active_group", "acked", true, true),
      groupSpec("sensor_source", "acked", true, true),
    ],
  };
}

/**
 * Without `heardAgoMs` the valve was not heard; without `messageAgoMs` a message arrived just now.
 * `since` is `nowMs`.
 */
export function makeState(
  options: {
    values?: SettingValues;
    readings?: Partial<Readings>;
    lifeToken?: string;
    heardAgoMs?: number;
    messageAgoMs?: number;
    nowMs?: number;
  } = {},
): DeviceState {
  const nowMs = options.nowMs ?? BUILDER_NOW_MS;
  return {
    values: options.values ?? {},
    readings: { ...EMPTY_READINGS, ...options.readings },
    lifeToken: options.lifeToken ?? "t0",
    heardAt: options.heardAgoMs === undefined ? undefined : nowMs - options.heardAgoMs,
    messageAt: nowMs - (options.messageAgoMs ?? 0),
    since: nowMs,
  };
}

function presetPoint(time: string, preset: PresetName): SetPoint {
  return { time: Temporal.PlainTime.from(time), preset, temperature: undefined };
}

const BUILDER_WEEK_DAY: readonly SetPoint[] = [
  presetPoint("00:00", "eco"),
  presetPoint("06:30", "comfort"),
  presetPoint("22:00", "eco"),
];

/** The same day on all seven weekdays. */
export function weekOf(day: readonly SetPoint[]): Week {
  return { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day };
}

/** One entry per room, keyed by its id: the room's schedule, sensors and presets. */
export function entriesOf(rooms: readonly Room[]): ReadonlyMap<string, RoomEntry> {
  return new Map(
    rooms.map((room): [string, RoomEntry] => [
      room.id,
      { scheduleId: room.scheduleId, sensors: room.sensors, presets: room.presets },
    ]),
  );
}

/** The membership in which each room is an area holding the room's valves, under its name. */
export function membershipOf(rooms: readonly Room[]): AreaMembership {
  return {
    rooms: new Map(
      rooms.map((room) => [
        room.id,
        { name: room.name, valveIds: room.valves.map((v) => v.valveId) },
      ]),
    ),
    ignored: [],
  };
}

/** A live house whose membership holds the rooms' valves (`membershipOf`), nothing not in HA. */
export function liveHouse(rooms: readonly Room[] = []): HouseInput {
  return { kind: "live", membership: membershipOf(rooms), notInHa: [] };
}

/**
 * One schedule, `BUILDER_SCHEDULE`, whose every day is `BUILDER_DAY`, unless `schedules` is
 * given; the first schedule is the default; one entry per given room; writes not held.
 */
export function makeConfig(
  options: { rooms?: readonly Room[]; schedules?: readonly Schedule[]; holdWrites?: boolean } = {},
): Config {
  const schedules = options.schedules ?? [
    { id: BUILDER_SCHEDULE, name: "Default", defaultWeek: weekOf(BUILDER_WEEK_DAY) },
  ];
  return {
    ...EMPTY_CONFIG,
    settings: {
      ...EMPTY_CONFIG.settings,
      holdWrites: options.holdWrites ?? false,
      timezone: BUILDER_NOW.timeZoneId,
    },
    schedules,
    defaultScheduleId: schedules[0]?.id,
    rooms: entriesOf(options.rooms ?? []),
  };
}

/**
 * Config state `ok` (revision 1, nothing releasing), an empty ledger, `z2m` up, no faults, and a
 * live house with no room. With `rooms`, the config's entries and the live house come from them.
 */
export function makeWorld(
  options: Partial<World> & { config?: Config; rooms?: readonly Room[] } = {},
): World {
  const { config, rooms, ...rest } = options;
  const base = config ?? makeConfig();
  return {
    configState: "ok",
    stored: {
      ...FRESH_STORED,
      config: rooms === undefined ? base : { ...base, rooms: entriesOf(rooms) },
      revision: 1,
    },
    house: liveHouse(rooms ?? []),
    ledger: EMPTY_LEDGER,
    devices: new Map(),
    links: { z2m: true },
    transportFaults: {},
    sensors: new Map(),
    unobservableSensors: new Set(),
    memory: EMPTY_MEMORY,
    buckets: undefined,
    now: BUILDER_NOW,
    ...rest,
  };
}

/** The captured originals `makeManaged` records: source internal, and active group 1 on TRV-ZBT. */
export function makeOriginals(model: "trvzb" | "trv_zbt"): ValveRecord["originals"] {
  return model === "trvzb"
    ? { sensor_source: "internal" }
    : { active_group: 1, sensor_source: "internal" };
}

/**
 * One schedule, one room (`BUILDER_ROOM`) holding the valve and the given sensors, a ledger record
 * with the captured originals, and a usable device with `makeSpec(model)` and the state.
 */
export function makeManaged(
  options: {
    model?: "trvzb" | "trv_zbt";
    valveId?: string;
    sensors?: readonly SensorRef[];
    state?: DeviceState;
    holdWrites?: boolean;
  } = {},
): World {
  const model = options.model ?? "trvzb";
  const valveId = options.valveId ?? BUILDER_VALVE;
  const spec = makeSpec(model);
  const room: Room = {
    id: BUILDER_ROOM,
    name: "Living room",
    scheduleId: BUILDER_SCHEDULE,
    valves: [{ valveId }],
    sensors: options.sensors ?? [],
    presets: { comfort: undefined, eco: undefined, frost: undefined, boost: undefined },
  };
  const config = makeConfig({
    ...(options.holdWrites === undefined ? {} : { holdWrites: options.holdWrites }),
  });
  const ledger = withRecord(EMPTY_LEDGER, {
    valveId,
    profile: spec.profile,
    adoptedAt: BUILDER_NOW_MS - 24 * HOUR_MS,
    originals: makeOriginals(model),
  });
  const view: DeviceView = {
    name: "Living room valve",
    spec,
    usable: true,
    state: options.state ?? makeState(),
  };
  return makeWorld({ config, rooms: [room], ledger, devices: new Map([[valveId, view]]) });
}

function atMs(world: World, nowMs: number): Temporal.ZonedDateTime {
  return Temporal.Instant.fromEpochMilliseconds(nowMs).toZonedDateTimeISO(world.now.timeZoneId);
}

/**
 * Runs `tick` and answers every refresh, write and setpoint write with a heard message that holds
 * what was written, a second after the tick, until no managed valve's memory holds a mark. Returns
 * that world with `now` 10 min after the last refresh or write.
 */
export function settled(world: World): World {
  const specs = new Map<string, ValveSpec>();
  for (const [id, view] of world.devices) if (view.spec !== undefined) specs.set(id, view.spec);
  let current = world;
  let nowMs = world.now.epochMilliseconds;
  let lastActionAt = nowMs;
  for (let round = 0; round < 40; round++) {
    const result = tick(current);
    const answers = new Map<string, SettingValues>();
    for (const effect of result.effects) {
      if (effect.kind === "publish") {
        answers.set(effect.valveId, { ...answers.get(effect.valveId), ...effect.values });
      } else if (effect.kind === "refresh" || effect.kind === "publishSetpoint") {
        answers.set(effect.valveId, answers.get(effect.valveId) ?? {});
      }
    }
    const states = new Map<string, DeviceState>();
    for (const [id, view] of current.devices) if (view.state) states.set(id, view.state);
    let inbox: Inbox = { states, memory: result.memory };
    const messageAt = nowMs + 1000;
    for (const [deviceId, values] of answers) {
      const event: Event = {
        kind: "device_message",
        deviceId,
        decoded: { values, readings: EMPTY_READINGS },
        lifeToken: `settle-${String(round)}-${String(messageAt)}`,
      };
      inbox = applyEvent(inbox, event, specs, messageAt);
    }
    if (answers.size > 0) lastActionAt = nowMs;
    const devices = new Map(
      [...current.devices].map(([id, view]) => [id, { ...view, state: inbox.states.get(id) }]),
    );
    current = { ...current, devices, memory: inbox.memory, now: atMs(current, nowMs) };
    const kinds = memberships(
      current.configState,
      current.stored,
      current.ledger,
      roomsOf(current.configState, current.stored, current.house),
      current.house.kind,
    );
    const pending = [...kinds].some(([id, kind]) => {
      if (kind !== "managed" || !specs.has(id)) return false;
      const vm = inbox.memory.valves.get(id);
      return vm === undefined || Object.values(vm.groups).some((gm) => gm.mark !== undefined);
    });
    if (!pending) return { ...current, now: atMs(current, lastActionAt + 10 * MINUTE_MS) };
    nowMs = answers.size > 0 ? messageAt + 2000 : nowMs + 2 * MINUTE_MS;
  }
  throw new Error("the world did not settle");
}

/** A Home Assistant snapshot; an area's name defaults to its id. */
export function makeSnapshot(
  options: {
    areas?: Record<string, { name?: string; labels?: string[] }>;
    valveAreas?: Record<string, string | null>;
    entities?: Record<string, { areaId?: string; labels?: string[] }>;
    labels?: Record<string, string>;
  } = {},
): HaSnapshot {
  return {
    areas: new Map(
      Object.entries(options.areas ?? {}).map(([id, area]) => [
        id,
        { name: area.name ?? id, labels: area.labels ?? [] },
      ]),
    ),
    valveAreas: new Map(Object.entries(options.valveAreas ?? {})),
    entities: new Map(
      Object.entries(options.entities ?? {}).map(([id, entity]) => [
        id,
        { areaId: entity.areaId, labels: entity.labels ?? [] },
      ]),
    ),
    labels: new Map(Object.entries(options.labels ?? {})),
  };
}

/** A saved membership whose area names equal their ids. */
export function makeMembership(
  rooms: Record<string, readonly string[]>,
  ignored: readonly string[] = [],
): AreaMembership {
  return {
    rooms: new Map(Object.entries(rooms).map(([id, valveIds]) => [id, { name: id, valveIds }])),
    ignored,
  };
}
