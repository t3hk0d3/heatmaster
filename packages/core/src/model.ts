export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

/** The seven weekdays, Monday first. */
export const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** How a manual change to a room ends: at the next schedule change, after a time, or never. */
export type EndRule = "next_change" | "timer" | "manual";

export const END_RULES: readonly EndRule[] = ["next_change", "timer", "manual"];

/** How long a boost lasts unless the command names an end. */
export const BOOST_DURATION_MS = 30 * 60 * 1000;

/** "Until the next schedule change" looks this far ahead of now, so a point about to fire is skipped. */
export const NEXT_CHANGE_LEAD_MS = 10 * 60 * 1000;

/** How long a `timer` override lasts unless the config says otherwise. */
export const DEFAULT_OVERRIDE_DURATION_MS = 2 * 60 * 60 * 1000;

/** The accepted `overrideDurationMs` range, inclusive: 15 minutes to 24 hours. */
export const OVERRIDE_DURATION_RANGE_MS: readonly [number, number] = [
  15 * 60 * 1000,
  24 * 60 * 60 * 1000,
];

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

/** `ref` is `ha:<binary_sensor entity id>`: `on` is open, `off` is closed. */
export type ContactRef = Readonly<{ ref: string }>;

/** A transport-qualified id, `z2m:<IEEE address>`. */
export type ValveRef = Readonly<{ valveId: string }>;

export type WindowAction = "frost_heat" | "off";
export type WindowEnd = "fixed" | "stopped_falling";
export type AfterLimit = "heat" | "stay";
export type ManualChange = "resume_heating" | "ignore";
export type ValveDetection = "off_when_watched" | "always_off" | "leave";

export const WINDOW_ACTIONS: readonly WindowAction[] = ["frost_heat", "off"];
export const WINDOW_ENDS: readonly WindowEnd[] = ["fixed", "stopped_falling"];
export const AFTER_LIMITS: readonly AfterLimit[] = ["heat", "stay"];
export const MANUAL_CHANGES: readonly ManualChange[] = ["resume_heating", "ignore"];
export const VALVE_DETECTIONS: readonly ValveDetection[] = [
  "off_when_watched",
  "always_off",
  "leave",
];

/** The window limits the Home Assistant select offers, in milliseconds; "none" is the sixth option. */
export const WINDOW_LIMIT_CHOICES_MS: readonly number[] = [
  30 * 60 * 1000,
  60 * 60 * 1000,
  2 * 60 * 60 * 1000,
  4 * 60 * 60 * 1000,
  8 * 60 * 60 * 1000,
];

/** What an open window holds the room's valves at: a preset's temperature or a number of degrees. */
export type WindowTarget =
  Readonly<{ kind: "preset"; preset: PresetName }> | Readonly<{ kind: "celsius"; celsius: number }>;

/** The fast-fall detection; durations are milliseconds. */
export type TemperatureDetection = Readonly<{
  enabled: boolean;
  dropC: number;
  withinMs: number;
  end: WindowEnd;
  fixedMs: number;
  stillMs: number;
  rejoinMs: number;
}>;

/** Everything about open-window mode; `limitMs` undefined means no limit. */
export type WindowSettings = Readonly<{
  enabled: boolean;
  action: WindowAction;
  target: WindowTarget;
  openDebounceMs: number;
  closeDebounceMs: number;
  contactUnavailableMs: number;
  temperature: TemperatureDetection;
  limitMs: number | undefined;
  afterLimit: AfterLimit;
  notify: boolean;
  manualChange: ManualChange;
  valveDetection: ValveDetection;
}>;

export type TemperaturePatch = Readonly<{
  [K in keyof TemperatureDetection]: TemperatureDetection[K] | undefined;
}>;

/** A room's sparse overrides of the house window settings; `limitMs` `"none"` means no limit. */
export type WindowPatch = Readonly<{
  enabled: boolean | undefined;
  action: WindowAction | undefined;
  target: WindowTarget | undefined;
  openDebounceMs: number | undefined;
  closeDebounceMs: number | undefined;
  contactUnavailableMs: number | undefined;
  temperature: TemperaturePatch;
  limitMs: number | "none" | undefined;
  afterLimit: AfterLimit | undefined;
  notify: boolean | undefined;
  manualChange: ManualChange | undefined;
  valveDetection: ValveDetection | undefined;
}>;

/**
 * A config entry for one Home Assistant area (`Config.rooms` is keyed by area id). `scheduleId`
 * undefined: the room follows the default schedule.
 */
export type RoomEntry = Readonly<{
  scheduleId: string | undefined;
  sensors: readonly SensorRef[];
  presets: RoomPresets;
  /** Undefined: the house value. */
  overrideEnd: EndRule | undefined;
  /** Milliseconds; undefined: the house value. */
  overrideDurationMs: number | undefined;
  contacts: readonly ContactRef[];
  window: WindowPatch;
}>;

/**
 * A resolved room: a Home Assistant area that holds a supported valve, with what its config entry
 * (or the default schedule) says. `id` is the area id, `name` the area's name.
 */
export type Room = Readonly<{
  id: string;
  name: string;
  scheduleId: string;
  valves: readonly ValveRef[];
  sensors: readonly SensorRef[];
  presets: RoomPresets;
  /** The entry's rule, else the house's. */
  overrideEnd: EndRule;
  /** Milliseconds: the entry's, else the house's. */
  overrideDurationMs: number;
  contacts: readonly ContactRef[];
  /** The entry's values over the house's. */
  window: WindowSettings;
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
  /** How a manual change ends in a room whose entry does not say. */
  overrideEnd: EndRule;
  /** Milliseconds; how long a `timer` override lasts in a room whose entry does not say. */
  overrideDurationMs: number;
  /** The house's window settings; a room entry may override each. */
  window: WindowSettings;
}>;

/** `rooms` holds the entries, keyed by area id; entries for areas that are no room are kept. */
export type Config = Readonly<{
  settings: Settings;
  presets: Presets;
  schedules: readonly Schedule[];
  defaultScheduleId: string | undefined;
  rooms: ReadonlyMap<string, RoomEntry>;
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

export const DEFAULT_WINDOW_SETTINGS: WindowSettings = {
  enabled: true,
  action: "frost_heat",
  target: { kind: "preset", preset: "frost" },
  openDebounceMs: 30 * 1000,
  closeDebounceMs: 60 * 1000,
  contactUnavailableMs: 30 * 60 * 1000,
  temperature: {
    enabled: true,
    dropC: 0.4,
    withinMs: 20 * 60 * 1000,
    end: "fixed",
    fixedMs: 30 * 60 * 1000,
    stillMs: 20 * 60 * 1000,
    rejoinMs: 60 * 60 * 1000,
  },
  limitMs: 2 * 60 * 60 * 1000,
  afterLimit: "heat",
  notify: true,
  manualChange: "resume_heating",
  valveDetection: "off_when_watched",
};

export const DEFAULT_SETTINGS: Settings = {
  externalWriteIntervalMs: 5 * 60 * 1000,
  sensorStaleAfterMs: 120 * 60 * 1000,
  holdWrites: true,
  timezone: undefined,
  language: "en",
  overrideEnd: "next_change",
  overrideDurationMs: DEFAULT_OVERRIDE_DURATION_MS,
  window: DEFAULT_WINDOW_SETTINGS,
};

/** Defaults (writes held), no schedule, no default schedule, no entry. */
export const EMPTY_CONFIG: Config = {
  settings: DEFAULT_SETTINGS,
  presets: DEFAULT_PRESETS,
  schedules: [],
  defaultScheduleId: undefined,
  rooms: new Map(),
};

/** The id that identifies a sensor everywhere: its ref. */
export function sensorId(sensor: SensorRef): string {
  return sensor.ref;
}

/** The id that identifies a contact everywhere: its ref. */
export function contactId(contact: ContactRef): string {
  return contact.ref;
}

/** The temperature an open window holds the room at: the preset's (the room's own, else the house's) or the number. */
export function windowTargetCelsius(config: Config, room: Room): number {
  const { target } = room.window;
  return target.kind === "celsius" ? target.celsius : effectivePresets(config, room)[target.preset];
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
