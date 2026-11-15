export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

/** The seven weekdays, Monday first. */
export const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export type PresetName = "comfort" | "eco" | "frost" | "boost";

export const PRESET_NAMES: readonly PresetName[] = ["comfort", "eco", "frost", "boost"];

/** Exactly one of `preset` and `temperature` is set. */
export type SetPoint = Readonly<{
  time: Temporal.PlainTime;
  preset: PresetName | undefined;
  temperature: number | undefined;
}>;

export type Week = Readonly<Record<Weekday, readonly SetPoint[]>>;

export type Schedule = Readonly<{ id: string; name: string; defaultWeek: Week }>;

export type Presets = Readonly<{ comfort: number; eco: number; frost: number; boost: number }>;

/** A room's sparse overrides of the house presets. */
export type RoomPresets = Readonly<{
  comfort: number | undefined;
  eco: number | undefined;
  frost: number | undefined;
  boost: number | undefined;
}>;

/** `ref` is `ha:<entity id>`: room sensors are read through Home Assistant only. */
export type SensorRef = Readonly<{ ref: string; weight: number }>;

/** A transport-qualified id, `z2m:<IEEE address>`. */
export type ValveRef = Readonly<{ valveId: string }>;

export type Room = Readonly<{
  id: string;
  name: string;
  areaId: string | undefined;
  scheduleId: string;
  valves: readonly ValveRef[];
  sensors: readonly SensorRef[];
  presets: RoomPresets;
}>;

export type Settings = Readonly<{
  /** Milliseconds. */
  externalWriteIntervalMs: number;
  /** Milliseconds. */
  sensorStaleAfterMs: number;
  /** While true nothing is written to any valve; valves are still asked to report. */
  holdWrites: boolean;
  /** The house's IANA time zone name; `undefined` leaves the choice to the server. */
  timezone: string | undefined;
  /** The language of entity names. */
  language: "en" | "ru";
}>;

export type Config = Readonly<{
  settings: Settings;
  presets: Presets;
  schedules: readonly Schedule[];
  rooms: readonly Room[];
}>;

export type ConfigIssue = Readonly<{ path: string; code: string; message: string }>;

export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    const first = issues[0];
    const head =
      first === undefined ? "invalid config" : `${first.path || "(document)"}: ${first.message}`;
    super(issues.length > 1 ? `${head} (and ${String(issues.length - 1)} more)` : head);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export const DEFAULT_PRESETS: Presets = { comfort: 20, eco: 17, frost: 7, boost: 23 };

export const DEFAULT_SETTINGS: Settings = {
  externalWriteIntervalMs: 5 * 60 * 1000,
  sensorStaleAfterMs: 120 * 60 * 1000,
  holdWrites: true,
  timezone: undefined,
  language: "en",
};

/** Defaults, no schedules, no rooms. */
export const EMPTY_CONFIG: Config = {
  settings: DEFAULT_SETTINGS,
  presets: DEFAULT_PRESETS,
  schedules: [],
  rooms: [],
};

/** The id that identifies a sensor everywhere: its ref. */
export function sensorId(sensor: SensorRef): string {
  return sensor.ref;
}

/** The room's own presets over the house presets. */
export function effectivePresets(config: Config, room: Room): Presets {
  return {
    comfort: room.presets.comfort ?? config.presets.comfort,
    eco: room.presets.eco ?? config.presets.eco,
    frost: room.presets.frost ?? config.presets.frost,
    boost: room.presets.boost ?? config.presets.boost,
  };
}
