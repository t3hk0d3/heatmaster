import { ConfigError, DEFAULT_PRESETS, DEFAULT_SETTINGS, PRESET_NAMES, WEEKDAYS } from "./model.ts";
import type {
  Config,
  ConfigIssue,
  PresetName,
  Presets,
  Room,
  RoomPresets,
  Schedule,
  SensorRef,
  Settings,
  SetPoint,
  ValveRef,
  Week,
  Weekday,
} from "./model.ts";
import { sensorId } from "./model.ts";

export const CONFIG_VERSION = 1;

export type RawPresets = Readonly<{
  comfort?: number;
  eco?: number;
  frost?: number;
  boost?: number;
}>;

export type RawSettings = Readonly<{
  external_write_interval_min?: number;
  sensor_stale_min?: number;
  hold_writes?: boolean;
  timezone?: string;
  language?: "en" | "ru";
}>;

export type RawSetPoint = Readonly<
  { time: string; preset: PresetName } | { time: string; temperature: number }
>;

export type RawWeek = Readonly<Record<Weekday, readonly RawSetPoint[]>>;

export type RawSchedule = Readonly<{ id: string; name: string; default_week: RawWeek }>;

export type RawSensor = Readonly<{ ref: string; weight?: number }>;

export type RawRoom = Readonly<{
  id: string;
  name: string;
  area_id?: string;
  schedule_id: string;
  valves: readonly Readonly<{ id: string }>[];
  sensors?: readonly RawSensor[];
  presets?: RawPresets;
}>;

export type RawConfig = Readonly<{
  version: 1;
  settings?: RawSettings;
  presets?: RawPresets;
  schedules?: readonly RawSchedule[];
  rooms?: readonly RawRoom[];
}>;

const ID_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const VALVE_ID_PATTERN = /^[a-z][a-z0-9]*:[0-9a-z_.:-]{1,64}$/;
const HA_ENTITY_PATTERN = /^sensor\.[a-z0-9_]+$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const CONTROL_PATTERN = /\p{Cc}/u;

const MIN_TEMPERATURE = 4;
const MAX_TEMPERATURE = 35;
const MAX_ROOMS = 64;
const MAX_SCHEDULES = 64;
const MAX_VALVES = 8;
const MAX_SENSORS = 16;
const MAX_NAME_LENGTH = 64;
const MAX_SENSOR_WEIGHT = 10;
const MAX_DAY_SET_POINTS = 6;
const MS_PER_MINUTE = 60 * 1000;
const MIDNIGHT = Temporal.PlainTime.from("00:00");

type Report = (path: string, code: string, message: string) => void;

/**
 * Brings an older document up to CONFIG_VERSION. With only version 1 it returns the document
 * unchanged.
 */
export function migrateRaw(raw: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { ...raw };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function at(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

function atIndex(path: string, index: number): string {
  return `${path}[${String(index)}]`;
}

/** The value under `key`, or undefined when the key is absent or holds undefined. */
function read(obj: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

function typeInvalid(report: Report, path: string, expected: string): void {
  report(path, "type_invalid", `expected ${expected}`);
}

/** Stand-ins returned for a value that is not an object; they have no keys to complain about. */
const NOT_AN_OBJECT = new WeakSet<object>();

function asObject(
  report: Report,
  path: string,
  value: unknown,
  allowed: readonly string[],
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    typeInvalid(report, path, "an object");
    const stand: Record<string, unknown> = {};
    NOT_AN_OBJECT.add(stand);
    return stand;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) report(at(path, key), "key_unknown", `unknown key "${key}"`);
  }
  return value;
}

function requiredKey(
  report: Report,
  path: string,
  obj: Readonly<Record<string, unknown>>,
  key: string,
): unknown {
  const value = read(obj, key);
  if (value === undefined && !NOT_AN_OBJECT.has(obj))
    report(at(path, key), "key_missing", `missing required key "${key}"`);
  return value;
}

function parseId(report: Report, path: string, value: unknown): string {
  if (typeof value !== "string") {
    if (value !== undefined) typeInvalid(report, path, "a text");
    return "";
  }
  if (value.length < 1 || value.length > 32 || !ID_PATTERN.test(value)) {
    report(path, "id_invalid", "an id is a lowercase slug of 1 to 32 characters");
  }
  return value;
}

function parseName(report: Report, path: string, value: unknown): string {
  if (typeof value !== "string") {
    if (value !== undefined) typeInvalid(report, path, "a text");
    return "";
  }
  const length = Array.from(value).length;
  if (length < 1 || length > MAX_NAME_LENGTH || CONTROL_PATTERN.test(value)) {
    report(path, "name_invalid", "a name is 1 to 64 characters without control characters");
  }
  return value;
}

function parseText(report: Report, path: string, value: unknown): string {
  if (typeof value !== "string") {
    if (value !== undefined) typeInvalid(report, path, "a text");
    return "";
  }
  return value;
}

function parseTemperature(report: Report, path: string, value: unknown): number {
  if (typeof value !== "number") {
    typeInvalid(report, path, "a number");
    return MIN_TEMPERATURE;
  }
  if (!(value >= MIN_TEMPERATURE && value <= MAX_TEMPERATURE && Number.isInteger(value * 2))) {
    report(path, "temperature_invalid", "a temperature is 4 to 35 in steps of 0.5");
  }
  return value;
}

const PRESET_KEYS: readonly string[] = PRESET_NAMES;

function parsePresetValues(
  report: Report,
  path: string,
  value: unknown,
): Partial<Record<PresetName, number>> {
  const obj = asObject(report, path, value, PRESET_KEYS);
  const out: Partial<Record<PresetName, number>> = {};
  for (const name of PRESET_NAMES) {
    const item = read(obj, name);
    if (item !== undefined) out[name] = parseTemperature(report, at(path, name), item);
  }
  return out;
}

function parseWholeMinutes(
  report: Report,
  path: string,
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number") {
    typeInvalid(report, path, "a number");
    return fallback;
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    report(
      path,
      "setting_out_of_range",
      `expected a whole number from ${String(min)} to ${String(max)}`,
    );
  }
  return value;
}

/** The canonical id of a named IANA zone, or undefined for anything else (offsets, ISO strings). */
function canonicalTimezone(zone: string): string | undefined {
  if (zone === "" || zone.startsWith("+") || zone.startsWith("-")) return undefined;
  try {
    const id = Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(zone).timeZoneId;
    return id.toLowerCase() === zone.toLowerCase() ? id : undefined;
  } catch {
    return undefined;
  }
}

function parseSettings(report: Report, path: string, value: unknown): Settings {
  const obj = asObject(report, path, value === undefined ? {} : value, [
    "external_write_interval_min",
    "sensor_stale_min",
    "hold_writes",
    "timezone",
    "language",
  ]);
  const interval = parseWholeMinutes(
    report,
    at(path, "external_write_interval_min"),
    read(obj, "external_write_interval_min"),
    1,
    60,
    DEFAULT_SETTINGS.externalWriteIntervalMs / MS_PER_MINUTE,
  );
  const stale = parseWholeMinutes(
    report,
    at(path, "sensor_stale_min"),
    read(obj, "sensor_stale_min"),
    10,
    1440,
    DEFAULT_SETTINGS.sensorStaleAfterMs / MS_PER_MINUTE,
  );

  let holdWrites = DEFAULT_SETTINGS.holdWrites;
  const hold = read(obj, "hold_writes");
  if (typeof hold === "boolean") holdWrites = hold;
  else if (hold !== undefined) typeInvalid(report, at(path, "hold_writes"), "true or false");

  let timezone: string | undefined;
  const zone = read(obj, "timezone");
  if (typeof zone === "string") {
    timezone = canonicalTimezone(zone);
    if (timezone === undefined)
      report(at(path, "timezone"), "timezone_invalid", "unknown time zone");
  } else if (zone !== undefined) typeInvalid(report, at(path, "timezone"), "a text");

  let language = DEFAULT_SETTINGS.language;
  const lang = read(obj, "language");
  if (lang === "en" || lang === "ru") language = lang;
  else if (typeof lang === "string") {
    report(at(path, "language"), "language_unsupported", 'the language is "en" or "ru"');
  } else if (lang !== undefined) typeInvalid(report, at(path, "language"), "a text");

  return {
    externalWriteIntervalMs: interval * MS_PER_MINUTE,
    sensorStaleAfterMs: stale * MS_PER_MINUTE,
    holdWrites,
    timezone,
    language,
  };
}

function parseSetPoint(report: Report, path: string, value: unknown): SetPoint | undefined {
  const obj = asObject(report, path, value, ["time", "preset", "temperature"]);
  const rawTime = requiredKey(report, path, obj, "time");
  let time: Temporal.PlainTime | undefined;
  if (typeof rawTime === "string") {
    if (TIME_PATTERN.test(rawTime)) time = Temporal.PlainTime.from(rawTime);
    else report(at(path, "time"), "time_invalid", 'a time is "HH:MM"');
  } else if (rawTime !== undefined) typeInvalid(report, at(path, "time"), "a text");

  const rawPreset = read(obj, "preset");
  let preset: PresetName | undefined;
  if (typeof rawPreset === "string") {
    const known = PRESET_NAMES.find((name) => name === rawPreset);
    if (known === undefined) report(at(path, "preset"), "preset_unknown", "unknown preset name");
    else preset = known;
  } else if (rawPreset !== undefined) typeInvalid(report, at(path, "preset"), "a text");

  const rawTemperature = read(obj, "temperature");
  const temperature =
    rawTemperature === undefined
      ? undefined
      : parseTemperature(report, at(path, "temperature"), rawTemperature);

  if (!NOT_AN_OBJECT.has(obj) && (rawPreset === undefined) === (rawTemperature === undefined)) {
    report(path, "set_point_ambiguous", "a set point has either a preset or a temperature");
  }
  if (time === undefined) return undefined;
  return { time, preset, temperature };
}

function parseDay(report: Report, path: string, value: unknown): readonly SetPoint[] {
  if (!isList(value)) {
    typeInvalid(report, path, "a list");
    return [];
  }
  if (value.length < 1 || value.length > MAX_DAY_SET_POINTS) {
    report(path, "set_point_count", "a day has 1 to 6 set points");
  }
  const points: SetPoint[] = [];
  let previous: Temporal.PlainTime | undefined;
  value.forEach((item, index) => {
    const itemPath = atIndex(path, index);
    const point = parseSetPoint(report, itemPath, item);
    if (point === undefined) return;
    if (index === 0 && !point.time.equals(MIDNIGHT)) {
      report(at(itemPath, "time"), "first_set_point_not_midnight", "the first set point is 00:00");
    }
    if (previous !== undefined && Temporal.PlainTime.compare(point.time, previous) <= 0) {
      report(at(itemPath, "time"), "set_points_not_ascending", "set point times must ascend");
    }
    previous = point.time;
    points.push(point);
  });
  return points;
}

function parseWeek(report: Report, path: string, value: unknown): Week {
  if (value === undefined) return { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
  const obj = asObject(report, path, value, WEEKDAYS);
  const day = (name: Weekday): readonly SetPoint[] => {
    const item = read(obj, name);
    if (item === undefined) {
      if (isRecord(value)) report(at(path, name), "day_missing", `missing weekday "${name}"`);
      return [];
    }
    return parseDay(report, at(path, name), item);
  };
  return {
    mon: day("mon"),
    tue: day("tue"),
    wed: day("wed"),
    thu: day("thu"),
    fri: day("fri"),
    sat: day("sat"),
    sun: day("sun"),
  };
}

function parseList(report: Report, path: string, value: unknown, max: number): readonly unknown[] {
  if (value === undefined) return [];
  if (!isList(value)) {
    typeInvalid(report, path, "a list");
    return [];
  }
  if (value.length > max) report(path, "too_many", `at most ${String(max)} entries`);
  return value;
}

function parseSchedules(
  report: Report,
  path: string,
  value: unknown,
): Readonly<{ schedules: readonly Schedule[]; ids: ReadonlySet<string>; complete: boolean }> {
  const list = parseList(report, path, value, MAX_SCHEDULES);
  const ids = new Set<string>();
  let complete = isList(value) || value === undefined;
  const schedules = list.map((item, index): Schedule => {
    const itemPath = atIndex(path, index);
    const obj = asObject(report, itemPath, item, ["id", "name", "default_week"]);
    const rawId = requiredKey(report, itemPath, obj, "id");
    const id = parseId(report, at(itemPath, "id"), rawId);
    if (typeof rawId !== "string") complete = false;
    else if (ids.has(id))
      report(at(itemPath, "id"), "id_duplicate", `duplicate schedule id "${id}"`);
    else ids.add(id);
    const name = parseName(
      report,
      at(itemPath, "name"),
      requiredKey(report, itemPath, obj, "name"),
    );
    const defaultWeek = parseWeek(
      report,
      at(itemPath, "default_week"),
      requiredKey(report, itemPath, obj, "default_week"),
    );
    return { id, name, defaultWeek };
  });
  return { schedules, ids, complete };
}

function parseValves(
  report: Report,
  path: string,
  value: unknown,
  seen: Set<string>,
): readonly ValveRef[] {
  if (value === undefined) return [];
  const list = parseList(report, path, value, MAX_VALVES);
  if (isList(value) && value.length === 0) report(path, "valves_empty", "a room needs a valve");
  return list.map((item, index): ValveRef => {
    const itemPath = atIndex(path, index);
    const obj = asObject(report, itemPath, item, ["id"]);
    const raw = requiredKey(report, itemPath, obj, "id");
    const idPath = at(itemPath, "id");
    if (typeof raw !== "string") {
      if (raw !== undefined) typeInvalid(report, idPath, "a text");
      return { valveId: "" };
    }
    if (!VALVE_ID_PATTERN.test(raw)) {
      report(idPath, "valve_id_invalid", "a valve id is <transport>:<address>");
    } else if (seen.has(raw)) {
      report(idPath, "valve_duplicate", `valve "${raw}" is already in use`);
    } else seen.add(raw);
    return { valveId: raw };
  });
}

function parseSensor(report: Report, path: string, value: unknown): SensorRef {
  const obj = asObject(report, path, value, ["ref", "weight"]);
  const refPath = at(path, "ref");
  const rawRef = requiredKey(report, path, obj, "ref");
  let ref = "";
  if (typeof rawRef === "string") {
    ref = rawRef;
    if (!(rawRef.startsWith("ha:") && HA_ENTITY_PATTERN.test(rawRef.slice(3)))) {
      report(refPath, "sensor_ref_invalid", "a sensor is ha:sensor.<id>");
    }
  } else if (rawRef !== undefined) typeInvalid(report, refPath, "a text");

  let weight = 1;
  const rawWeight = read(obj, "weight");
  if (typeof rawWeight === "number") {
    if (!(rawWeight > 0 && rawWeight <= MAX_SENSOR_WEIGHT)) {
      report(at(path, "weight"), "weight_invalid", "a weight is above 0 and at most 10");
    }
    weight = rawWeight;
  } else if (rawWeight !== undefined) typeInvalid(report, at(path, "weight"), "a number");
  return { ref, weight };
}

function parseSensors(report: Report, path: string, value: unknown): readonly SensorRef[] {
  const list = parseList(report, path, value, MAX_SENSORS);
  const seen = new Set<string>();
  return list.map((item, index) => {
    const itemPath = atIndex(path, index);
    let faults = 0;
    const sensor = parseSensor(
      (p, code, message) => {
        if (p === itemPath || p.endsWith(".ref")) faults += 1;
        report(p, code, message);
      },
      itemPath,
      item,
    );
    if (faults === 0) {
      const id = sensorId(sensor);
      if (seen.has(id)) {
        report(at(itemPath, "ref"), "sensor_duplicate", `sensor "${id}" is listed twice`);
      } else seen.add(id);
    }
    return sensor;
  });
}

function parseRooms(
  report: Report,
  path: string,
  value: unknown,
  scheduleIds: ReadonlySet<string>,
  schedulesComplete: boolean,
): readonly Room[] {
  const list = parseList(report, path, value, MAX_ROOMS);
  const ids = new Set<string>();
  const valveIds = new Set<string>();
  return list.map((item, index): Room => {
    const itemPath = atIndex(path, index);
    const obj = asObject(report, itemPath, item, [
      "id",
      "name",
      "area_id",
      "schedule_id",
      "valves",
      "sensors",
      "presets",
    ]);
    const rawId = requiredKey(report, itemPath, obj, "id");
    const id = parseId(report, at(itemPath, "id"), rawId);
    if (typeof rawId === "string") {
      if (ids.has(id)) report(at(itemPath, "id"), "id_duplicate", `duplicate room id "${id}"`);
      else ids.add(id);
    }
    const name = parseName(
      report,
      at(itemPath, "name"),
      requiredKey(report, itemPath, obj, "name"),
    );
    const rawArea = read(obj, "area_id");
    const areaId =
      rawArea === undefined ? undefined : parseText(report, at(itemPath, "area_id"), rawArea);
    const scheduleId = parseText(
      report,
      at(itemPath, "schedule_id"),
      requiredKey(report, itemPath, obj, "schedule_id"),
    );
    if (scheduleId !== "" && schedulesComplete && !scheduleIds.has(scheduleId)) {
      report(at(itemPath, "schedule_id"), "schedule_unknown", `no schedule "${scheduleId}"`);
    }
    const valvesPath = at(itemPath, "valves");
    const rawValves = requiredKey(report, itemPath, obj, "valves");
    const valves = parseValves(report, valvesPath, rawValves, valveIds);
    const sensors = parseSensors(report, at(itemPath, "sensors"), read(obj, "sensors"));
    const rawRoomPresets = read(obj, "presets");
    const partial = parsePresetValues(
      report,
      at(itemPath, "presets"),
      rawRoomPresets === undefined ? {} : rawRoomPresets,
    );
    const presets: RoomPresets = {
      comfort: partial.comfort,
      eco: partial.eco,
      frost: partial.frost,
      boost: partial.boost,
    };
    return { id, name, areaId, scheduleId, valves, sensors, presets };
  });
}

/** Turns a raw document into a Config; throws ConfigError listing every issue. */
export function validateConfig(raw: unknown): Config {
  if (!isRecord(raw)) {
    throw new ConfigError([
      { path: "", code: "type_invalid", message: "the document must be an object" },
    ]);
  }
  const doc = migrateRaw(raw);
  if (doc.version !== CONFIG_VERSION) {
    throw new ConfigError([
      {
        path: "version",
        code: "version_unsupported",
        message: `the document version must be ${String(CONFIG_VERSION)}`,
      },
    ]);
  }

  const issues: ConfigIssue[] = [];
  const report: Report = (path, code, message) => {
    issues.push({ path, code, message });
  };
  asObject(report, "", doc, ["version", "settings", "presets", "schedules", "rooms"]);

  const settings = parseSettings(report, "settings", read(doc, "settings"));
  const rawPresets = read(doc, "presets");
  const presetValues = parsePresetValues(
    report,
    "presets",
    rawPresets === undefined ? {} : rawPresets,
  );
  const presets: Presets = { ...DEFAULT_PRESETS, ...presetValues };
  const { schedules, ids, complete } = parseSchedules(report, "schedules", read(doc, "schedules"));
  const rooms = parseRooms(report, "rooms", read(doc, "rooms"), ids, complete);

  if (issues.length > 0) throw new ConfigError(issues);
  return { settings, presets, schedules, rooms };
}

function setPointToRaw(point: SetPoint): RawSetPoint {
  const time = point.time.toString({ smallestUnit: "minute" });
  if (point.temperature !== undefined) return { time, temperature: point.temperature };
  if (point.preset === undefined) throw new Error("a set point holds a preset or a temperature");
  return { time, preset: point.preset };
}

function weekToRaw(week: Week): RawWeek {
  const day = (name: Weekday): readonly RawSetPoint[] => week[name].map(setPointToRaw);
  return {
    mon: day("mon"),
    tue: day("tue"),
    wed: day("wed"),
    thu: day("thu"),
    fri: day("fri"),
    sat: day("sat"),
    sun: day("sun"),
  };
}

function presetsToRaw(presets: Readonly<Record<PresetName, number | undefined>>): RawPresets {
  const out: Partial<Record<PresetName, number>> = {};
  for (const name of PRESET_NAMES) {
    const value = presets[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

function sensorToRaw(sensor: SensorRef): RawSensor {
  return { ref: sensor.ref, weight: sensor.weight };
}

function roomToRaw(room: Room): RawRoom {
  const presets = presetsToRaw(room.presets);
  return {
    id: room.id,
    name: room.name,
    ...(room.areaId === undefined ? {} : { area_id: room.areaId }),
    schedule_id: room.scheduleId,
    valves: room.valves.map((valve) => ({ id: valve.valveId })),
    sensors: room.sensors.map(sensorToRaw),
    ...(Object.keys(presets).length === 0 ? {} : { presets }),
  };
}

/** The raw document of a Config; it holds only JSON types. */
export function configToRaw(config: Config): RawConfig {
  const { settings } = config;
  return {
    version: CONFIG_VERSION,
    settings: {
      external_write_interval_min: settings.externalWriteIntervalMs / MS_PER_MINUTE,
      sensor_stale_min: settings.sensorStaleAfterMs / MS_PER_MINUTE,
      hold_writes: settings.holdWrites,
      ...(settings.timezone === undefined ? {} : { timezone: settings.timezone }),
      language: settings.language,
    },
    presets: presetsToRaw(config.presets),
    schedules: config.schedules.map((schedule) => ({
      id: schedule.id,
      name: schedule.name,
      default_week: weekToRaw(schedule.defaultWeek),
    })),
    rooms: config.rooms.map(roomToRaw),
  };
}
