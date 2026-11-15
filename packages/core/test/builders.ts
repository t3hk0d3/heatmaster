import fc from "fast-check";
import {
  EMPTY_CONFIG,
  EMPTY_LEDGER,
  EMPTY_MEMORY,
  EMPTY_READINGS,
  applyEvent,
  memberships,
  tick,
  withRecord,
} from "../src/index.ts";
import type {
  Config,
  DeviceState,
  DeviceView,
  Event,
  Group,
  GroupSpec,
  Inbox,
  PresetName,
  RawConfig,
  RawSetPoint,
  Readings,
  ResolvedDay,
  Room,
  Schedule,
  SensorRef,
  SetPoint,
  SettingValues,
  ValveRecord,
  ValveSpec,
  Week,
  World,
} from "../src/index.ts";

/** A complete valid document: one schedule, one room with a valve and two ha sensors. */
export function validRaw(): RawConfig {
  const day = (): RawSetPoint[] => [
    { time: "00:00", preset: "eco" as const },
    { time: "06:30", preset: "comfort" as const },
    { time: "22:00", temperature: 18 },
  ];
  return {
    version: 1,
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
        default_week: {
          mon: day(),
          tue: day(),
          wed: day(),
          thu: day(),
          fri: day(),
          sat: [{ time: "00:00", preset: "eco" }],
          sun: [{ time: "00:00", preset: "eco" }],
        },
      },
    ],
    rooms: [
      {
        id: "living",
        name: "Living room",
        area_id: "living_room",
        schedule_id: "default",
        valves: [{ id: "z2m:0x00124b0012345678" }],
        sensors: [
          { ref: "ha:sensor.bedroom_temperature" },
          { ref: "ha:sensor.living_temperature", weight: 2 },
        ],
        presets: { comfort: 22 },
      },
    ],
  };
}

const slug = fc.stringMatching(/^[a-z0-9]{1,8}$/);
const halfDegree = fc.integer({ min: 8, max: 70 }).map((n) => n / 2);
const preset = fc.constantFrom<PresetName>("comfort", "eco", "frost", "boost");
const name = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 ]{0,30}$/);
const address = (n: number): string => `0x${n.toString(16).padStart(16, "0")}`;

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

/** Any valid Config: unique ids, rooms that name existing schedules, no valve twice. */
export const arbConfig: fc.Arbitrary<Config> = fc
  .tuple(
    fc.uniqueArray(slug, { minLength: 1, maxLength: 3 }),
    fc.uniqueArray(slug, { minLength: 0, maxLength: 4 }),
  )
  .chain(([scheduleIds, roomIds]) =>
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
      schedules: fc.tuple(...scheduleIds.map(() => fc.tuple(name, week))).map((items) =>
        items.map(([scheduleName, defaultWeek], i): Schedule => ({
          id: scheduleIds[i] ?? "x",
          name: scheduleName,
          defaultWeek,
        })),
      ),
      rooms: fc
        .tuple(
          ...roomIds.map(() =>
            fc.record({
              name,
              areaId: fc.option(slug, { nil: undefined }),
              schedule: fc.nat(scheduleIds.length - 1),
              valveCount: fc.integer({ min: 1, max: 3 }),
              sensors: fc.uniqueArray(sensor, {
                maxLength: 4,
                selector: (s) => s.ref,
              }),
              presets: roomPresets,
            }),
          ),
        )
        .map((items) => {
          let nextValve = 1;
          return items.map((item, i): Room => {
            const valves = Array.from({ length: item.valveCount }, () => ({
              valveId: `z2m:${address(nextValve++)}`,
            }));
            return {
              id: roomIds[i] ?? "x",
              name: item.name,
              areaId: item.areaId,
              scheduleId: scheduleIds[item.schedule] ?? "x",
              valves,
              sensors: item.sensors,
              presets: item.presets,
            };
          });
        }),
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
      groupSpec("schedule", "echoed", false, false),
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

/** One schedule, `BUILDER_SCHEDULE`, whose every day is `BUILDER_DAY`; no rooms; writes not held. */
export function makeConfig(
  options: { rooms?: readonly Room[]; schedules?: readonly Schedule[]; holdWrites?: boolean } = {},
): Config {
  return {
    ...EMPTY_CONFIG,
    settings: {
      ...EMPTY_CONFIG.settings,
      holdWrites: options.holdWrites ?? false,
      timezone: BUILDER_NOW.timeZoneId,
    },
    schedules: options.schedules ?? [
      { id: BUILDER_SCHEDULE, name: "Default", defaultWeek: weekOf(BUILDER_WEEK_DAY) },
    ],
    rooms: options.rooms ?? [],
  };
}

/** Config state `ok` (revision 1, nothing releasing), an empty ledger, `z2m` up, no faults. */
export function makeWorld(options: Partial<World> & { config?: Config } = {}): World {
  const { config, ...rest } = options;
  return {
    configState: "ok",
    stored: { config: config ?? makeConfig(), revision: 1, releasing: new Map() },
    ledger: EMPTY_LEDGER,
    devices: new Map(),
    links: { z2m: true },
    transportFaults: {},
    sensors: new Map(),
    unobservableSensors: new Set(),
    memory: EMPTY_MEMORY,
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
    areaId: undefined,
    scheduleId: BUILDER_SCHEDULE,
    valves: [{ valveId }],
    sensors: options.sensors ?? [],
    presets: { comfort: undefined, eco: undefined, frost: undefined, boost: undefined },
  };
  const config = makeConfig({
    rooms: [room],
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
  return makeWorld({ config, ledger, devices: new Map([[valveId, view]]) });
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
    const kinds = memberships(current.configState, current.stored, current.ledger);
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
