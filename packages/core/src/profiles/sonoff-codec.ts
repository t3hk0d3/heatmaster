import { WEEKDAYS } from "../model.ts";
import { normalizeDay } from "../schedule.ts";
import { DAY_KEYS, EMPTY_READINGS } from "../settings.ts";
import type { Weekday } from "../model.ts";
import type { ResolvedDay, ResolvedPoint } from "../schedule.ts";
import type {
  GroupSpec,
  Readings,
  SensorSource,
  SettingKey,
  SettingValue,
  SettingValues,
  Toggle,
  ValveMode,
} from "../settings.ts";

const ENTRY = /^(\d{1,2}):(\d{2})\/(-?\d+(?:\.\d+)?)$/;

function entryText(point: ResolvedPoint): string {
  return `${point.time.toString({ smallestUnit: "minute" })}/${String(point.temperature)}`;
}

/**
 * The onboard day text: `HH:MM/<temp>` entries separated by one space. Normalises first, then
 * pads with the last entry to exactly `slotCount` entries. Throws `RangeError` for no points, for
 * more distinct points than slots, and for a temperature that is not a finite number.
 */
export function encodeDay(points: readonly ResolvedPoint[], slotCount: number): string {
  const day = normalizeDay(points);
  if (day.length === 0) throw new RangeError("a day needs at least one point");
  if (day.length > slotCount) throw new RangeError("more points than slots");
  if (day.some((p) => !Number.isFinite(p.temperature)))
    throw new RangeError("a temperature is not a finite number");
  const entries = day.map(entryText);
  const last = entries[entries.length - 1] ?? "";
  while (entries.length < slotCount) entries.push(last);
  return entries.join(" ");
}

/** Every entry as written, repeats included. `null` for anything it cannot read. */
export function decodeDay(text: unknown): ResolvedDay | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const points: ResolvedPoint[] = [];
  for (const entry of trimmed.split(/\s+/)) {
    const m = ENTRY.exec(entry);
    if (m === null) return null;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    const temperature = Number(m[3]);
    if (hour > 23 || minute > 59 || !Number.isFinite(temperature)) return null;
    points.push({ time: Temporal.PlainTime.from({ hour, minute }), temperature });
  }
  return points;
}

// Shared by the two Zigbee2MQTT bindings.

/** The payload key of each day key. */
export const Z2M_DAY_PAYLOAD: Readonly<Record<Weekday, string>> = {
  mon: "weekly_schedule_monday",
  tue: "weekly_schedule_tuesday",
  wed: "weekly_schedule_wednesday",
  thu: "weekly_schedule_thursday",
  fri: "weekly_schedule_friday",
  sat: "weekly_schedule_saturday",
  sun: "weekly_schedule_sunday",
};

export const Z2M_KEYS = {
  select: "temperature_sensor_select",
  external: "external_temperature_input",
  setpoint: "occupied_heating_setpoint",
  mode: "system_mode",
  frost: "frost_protection_temperature",
  openWindow: "open_window",
  activeGroup: "schedule_active_group",
  editGroup: "schedule_group_to_edit",
} as const;

const SELECT_TO_SOURCE: Readonly<Record<string, SensorSource>> = {
  local_temperature: "internal",
  remote_temperature: "external",
  remote_source_offline: "external",
};
const SOURCE_TO_SELECT: Readonly<Record<SensorSource, string>> = {
  internal: "local_temperature",
  external: "remote_temperature",
};

/** The select option of a sensor source. Throws `RangeError` for anything else. */
export function selectOption(source: unknown): string {
  if (source !== "internal" && source !== "external")
    throw new RangeError(`unknown sensor source: ${JSON.stringify(source)}`);
  return SOURCE_TO_SELECT[source];
}

/** A group number to write: an integer 1-3. Throws `RangeError` for anything else. */
export function checkGroup(value: unknown): number {
  const n = parseGroup(value);
  if (typeof value !== "number" || n === undefined)
    throw new RangeError(`unknown schedule group: ${JSON.stringify(value)}`);
  return n;
}

function parseMode(value: unknown): ValveMode | undefined {
  return value === "off" || value === "auto" || value === "heat" ? value : undefined;
}

/** A mode to write: `off`, `auto` or `heat`. Throws `RangeError` for anything else. */
function checkMode(value: unknown): ValveMode {
  const mode = parseMode(value);
  if (mode === undefined) throw new RangeError(`unknown mode: ${JSON.stringify(value)}`);
  return mode;
}

function parseToggle(value: unknown): Toggle | undefined {
  if (value === "ON") return "on";
  if (value === "OFF") return "off";
  return undefined;
}

/** A toggle to write, as Zigbee2MQTT spells it. Throws `RangeError` for anything else. */
function checkToggle(value: unknown): "ON" | "OFF" {
  if (value === "on") return "ON";
  if (value === "off") return "OFF";
  throw new RangeError(`unknown toggle: ${JSON.stringify(value)}`);
}

/** A temperature to write: a finite number. Throws `RangeError` for anything else. */
function checkTemperature(value: unknown): number {
  const n = finite(value);
  if (n === undefined) throw new RangeError(`not a temperature: ${JSON.stringify(value)}`);
  return n;
}

/**
 * The frost protection temperature, the mode, the setpoint and the open window detection of
 * `values`, in that order, for the keys present. Throws `RangeError` for a value of the wrong kind.
 */
export function encodeThermostat(values: SettingValues): Record<string, unknown> {
  const message: Record<string, unknown> = {};
  if (values.frost_protection !== undefined)
    message[Z2M_KEYS.frost] = checkTemperature(values.frost_protection);
  if (values.system_mode !== undefined) message[Z2M_KEYS.mode] = checkMode(values.system_mode);
  if (values.setpoint !== undefined) message[Z2M_KEYS.setpoint] = checkTemperature(values.setpoint);
  if (values.open_window !== undefined)
    message[Z2M_KEYS.openWindow] = checkToggle(values.open_window);
  return message;
}

/** The refresh keys of the frost protection, thermostat and open window groups, each with an empty text. */
export const THERMOSTAT_REFRESH: Readonly<Record<string, string>> = {
  [Z2M_KEYS.mode]: "",
  [Z2M_KEYS.setpoint]: "",
  [Z2M_KEYS.frost]: "",
  [Z2M_KEYS.openWindow]: "",
};

const HOUR_MS = 60 * 60 * 1000;

/**
 * A group of a spec; every group but `open_window` is trusted for 24 h before it is marked again,
 * and only the `thermostat` group is atomic.
 */
export function groupSpec(
  spec: Pick<GroupSpec, "group" | "evidence" | "capture" | "readable">,
): GroupSpec {
  return {
    ...spec,
    maxAgeMs: spec.group === "open_window" ? undefined : 24 * HOUR_MS,
    atomic: spec.group === "thermostat",
  };
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** `null` for a present key that cannot be read; the key is left out when it is not present. */
function decodeKey(
  values: Partial<Record<SettingKey, SettingValue | null>>,
  key: SettingKey,
  payload: Readonly<Record<string, unknown>>,
  payloadKey: string,
  parse: (value: unknown) => SettingValue | undefined,
): void {
  if (Object.hasOwn(payload, payloadKey)) values[key] = parse(payload[payloadKey]) ?? null;
}

/** A group number from `1`, `"1"` … `3`; `undefined` for anything else. */
export function parseGroup(value: unknown): number | undefined {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 3 ? n : undefined;
}

function readings(payload: Readonly<Record<string, unknown>>, editGroup: number | undefined) {
  const mode = payload[Z2M_KEYS.mode];
  const running = payload.running_state;
  const select = payload[Z2M_KEYS.select];
  let feedLost: boolean | undefined;
  if (typeof select === "string") feedLost = select === "remote_source_offline";
  const out: Readings = {
    ...EMPTY_READINGS,
    mode: parseMode(mode),
    setpoint: finite(payload[Z2M_KEYS.setpoint]),
    localTemperature: finite(payload.local_temperature),
    running: running === "heat" ? true : running === "idle" ? false : undefined,
    battery: finite(payload.battery),
    feedLost,
    editGroup,
  };
  return out;
}

/** The part of a decode that is the same for both models; `days` is added by the caller. */
export function decodeCommon(
  payload: Readonly<Record<string, unknown>>,
  days: boolean,
): { values: Partial<Record<SettingKey, SettingValue | null>>; readings: Readings } {
  const values: Partial<Record<SettingKey, SettingValue | null>> = {};
  if (days) {
    for (const d of WEEKDAYS) {
      const payloadKey = Z2M_DAY_PAYLOAD[d];
      if (Object.hasOwn(payload, payloadKey)) values[DAY_KEYS[d]] = decodeDay(payload[payloadKey]);
    }
  }
  if (Object.hasOwn(payload, Z2M_KEYS.select)) {
    const select = payload[Z2M_KEYS.select];
    values.sensor_source =
      typeof select === "string" && Object.hasOwn(SELECT_TO_SOURCE, select)
        ? (SELECT_TO_SOURCE[select] ?? null)
        : null;
  }
  decodeKey(values, "frost_protection", payload, Z2M_KEYS.frost, finite);
  decodeKey(values, "system_mode", payload, Z2M_KEYS.mode, parseMode);
  decodeKey(values, "setpoint", payload, Z2M_KEYS.setpoint, finite);
  decodeKey(values, "open_window", payload, Z2M_KEYS.openWindow, parseToggle);
  const editGroup = parseGroup(payload[Z2M_KEYS.editGroup]);
  return { values, readings: readings(payload, editGroup) };
}
