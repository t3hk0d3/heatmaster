import fc from "fast-check";
import type {
  Config,
  PresetName,
  RawConfig,
  RawSetPoint,
  Room,
  Schedule,
  SensorRef,
  SetPoint,
  Week,
} from "../src/index.ts";

/** A complete valid document: one schedule, one room with a valve, a z2m sensor and an ha sensor. */
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
          { ref: "z2m:0x00124b0087654321", key: "temperature" },
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

const sensor: fc.Arbitrary<SensorRef> = fc.oneof(
  fc.record({
    ref: fc.integer({ min: 0, max: 5 }).map((n) => `z2m:${address(n + 1000)}`),
    key: fc.constantFrom("temperature", "humidity", "local_temperature"),
    weight: fc.integer({ min: 1, max: 20 }).map((n) => n / 2),
  }),
  fc.record({
    ref: fc.integer({ min: 0, max: 5 }).map((n) => `ha:sensor.s${String(n)}`),
    key: fc.constant(undefined),
    weight: fc.integer({ min: 1, max: 20 }).map((n) => n / 2),
  }),
);

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
                selector: (s) => `${s.ref}/${s.key ?? ""}`,
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
