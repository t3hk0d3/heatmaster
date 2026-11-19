import { WEEKDAYS } from "./model.ts";
import { daysEqual, normalizeDay } from "./schedule.ts";
import type { Weekday } from "./model.ts";
import type { ResolvedDay } from "./schedule.ts";

export type ValveMode = "off" | "auto" | "heat";
export type SensorSource = "internal" | "external";

export type SettingKey =
  | "day_mon"
  | "day_tue"
  | "day_wed"
  | "day_thu"
  | "day_fri"
  | "day_sat"
  | "day_sun"
  | "active_group"
  | "sensor_source"
  | "frost_protection"
  | "system_mode"
  | "setpoint";

/** The day key of each weekday. */
export const DAY_KEYS: Readonly<Record<Weekday, SettingKey>> = {
  mon: "day_mon",
  tue: "day_tue",
  wed: "day_wed",
  thu: "day_thu",
  fri: "day_fri",
  sat: "day_sat",
  sun: "day_sun",
};

/**
 * Every setting key: the seven days in weekday order, then the active group, the source, the frost
 * protection temperature, the mode and the setpoint (°C).
 */
export const SETTING_KEYS: readonly SettingKey[] = [
  ...WEEKDAYS.map((d) => DAY_KEYS[d]),
  "active_group",
  "sensor_source",
  "frost_protection",
  "system_mode",
  "setpoint",
];

/** `schedule` is the seven days; `thermostat` is the mode and the setpoint. */
export type Group =
  "schedule" | "active_group" | "sensor_source" | "frost_protection" | "thermostat";

export const GROUPS: readonly Group[] = [
  "schedule",
  "active_group",
  "sensor_source",
  "frost_protection",
  "thermostat",
];

const SCHEDULE_KEYS: readonly SettingKey[] = WEEKDAYS.map((d) => DAY_KEYS[d]);
const THERMOSTAT_KEYS: readonly SettingKey[] = ["system_mode", "setpoint"];

export function groupOf(key: SettingKey): Group {
  switch (key) {
    case "active_group":
    case "sensor_source":
    case "frost_protection":
      return key;
    case "system_mode":
    case "setpoint":
      return "thermostat";
    default:
      return "schedule";
  }
}

export function members(group: Group): readonly SettingKey[] {
  switch (group) {
    case "schedule":
      return SCHEDULE_KEYS;
    case "thermostat":
      return THERMOSTAT_KEYS;
    default:
      return [group];
  }
}

/** A day, a group number, a temperature (°C), a sensor source, or a mode. */
export type SettingValue = ResolvedDay | number | SensorSource | ValveMode;

/** A missing key means "unknown". A key is either absent or holds a value. */
export type SettingValues = Readonly<Partial<Record<SettingKey, SettingValue>>>;

function isDay(value: unknown): value is ResolvedDay {
  return Array.isArray(value);
}

/** Days by `daysEqual`, the rest by `===`. Values of different kinds are not equal. */
export function valuesEqual(key: SettingKey, a: SettingValue, b: SettingValue): boolean {
  if (isDay(a) || isDay(b)) return isDay(a) && isDay(b) && daysEqual(a, b);
  return a === b;
}

/** A stable text, equal for values that `valuesEqual`. */
export function valueKey(key: SettingKey, value: SettingValue): string {
  if (isDay(value)) {
    const day = normalizeDay(value)
      .map((p) => `${p.time.toString()}/${String(p.temperature)}`)
      .join(" ");
    return `day:${day}`;
  }
  return typeof value === "number" ? `number:${String(value)}` : `text:${value}`;
}

/**
 * A JSON-friendly form for people: a day as `"HH:MM/temp"` texts, a source or a mode as its name, a
 * group or a temperature as its number, unknown or unreadable as `null`.
 */
export function describeValue(key: SettingKey, value: SettingValue | null | undefined): unknown {
  if (value === null || value === undefined) return null;
  if (isDay(value)) {
    return value.map(
      (p) => `${p.time.toString({ smallestUnit: "minute" })}/${String(p.temperature)}`,
    );
  }
  return value;
}

export type Evidence = "acked" | "echoed" | "none";
export type Activation = "none" | "setpoint";

/**
 * - `evidence`: `acked` shows a new value only after the valve took the write; `echoed` shows what
 *   was sent; `none` is write-only: nothing the transport shows can be trusted, and the next heard
 *   message after a write is the sign that it took. The core reads `none` only in the tick's
 *   candidates, schedule trust and setpoint write.
 * - `maxAgeMs`: how long a cached value is trusted before the group is marked again; `undefined`
 *   means never by age.
 * - `capture` false: the group's original is not captured and not restored.
 * - `readable` false: a refresh does not return the group's value.
 * - `atomic` true: whenever one desired member differs, every desired member is sent, in one
 *   message.
 */
export type GroupSpec = Readonly<{
  group: Group;
  evidence: Evidence;
  maxAgeMs: number | undefined;
  capture: boolean;
  readable: boolean;
  atomic: boolean;
}>;

/**
 * Everything the core needs to know about a valve model on a transport. `groups` is in write
 * order. `scheduleGroup` is the schedule slot Heatmaster owns, `undefined` where the valve has one
 * schedule. `externalSensor` false: never fed a temperature, no `sensor_source` group.
 * `frostMinTemp`–`frostMaxTemp` is the range of its frost protection temperature.
 */
export type ValveSpec = Readonly<{
  profile: string;
  minTemp: number;
  maxTemp: number;
  frostMinTemp: number;
  frostMaxTemp: number;
  tempStep: number;
  maxSetPoints: number;
  slotCount: number;
  scheduleGroup: number | undefined;
  groups: readonly GroupSpec[];
  activation: Activation;
  externalSensor: boolean;
  feedWhenOff: boolean;
}>;

/** What a valve shows that plan 1 does not own. */
export type Readings = Readonly<{
  mode: ValveMode | undefined;
  setpoint: number | undefined;
  localTemperature: number | undefined;
  running: boolean | undefined;
  battery: number | undefined;
  feedLost: boolean | undefined;
  editGroup: number | undefined;
}>;

export const EMPTY_READINGS: Readings = {
  mode: undefined,
  setpoint: undefined,
  localTemperature: undefined,
  running: undefined,
  battery: undefined,
  feedLost: undefined,
  editGroup: undefined,
};

/** Keeps the old field where the new one is `undefined`. */
export function mergeReadings(old: Readings, fresh: Readings): Readings {
  return {
    mode: fresh.mode ?? old.mode,
    setpoint: fresh.setpoint ?? old.setpoint,
    localTemperature: fresh.localTemperature ?? old.localTemperature,
    running: fresh.running ?? old.running,
    battery: fresh.battery ?? old.battery,
    feedLost: fresh.feedLost ?? old.feedLost,
    editGroup: fresh.editGroup ?? old.editGroup,
  };
}
