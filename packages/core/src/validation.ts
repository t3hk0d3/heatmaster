import { scheduleLabelId } from "./house.ts";
import {
  ConfigError,
  DEFAULT_PRESETS,
  DEFAULT_SETTINGS,
  END_RULES,
  OVERRIDE_DURATION_RANGE_MS,
  PRESET_NAMES,
  WEEKDAYS,
} from "./model.ts";
import type {
  Config,
  ConfigIssue,
  EndRule,
  PresetName,
  Presets,
  RoomEntry,
  RoomPresets,
  Schedule,
  SensorRef,
  Settings,
  SetPoint,
  Week,
  Weekday,
} from "./model.ts";
import { sensorId } from "./model.ts";

export const CONFIG_VERSION = 3;

/** A `rooms` key: a Home Assistant area id (a slug; old ones are 32 hex digits). */
export const AREA_ID_PATTERN = /^[a-z0-9_]{1,64}$/;

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
  override_end?: EndRule;
  /** Whole minutes. */
  override_duration_min?: number;
}>;

/** A day plan: "HH:MM" to a temperature or a preset name. */
export type RawDayPlan = Readonly<Record<string, number | PresetName>>;

/** A list of weekday names, or the single string `all`, `weekdays` or `weekend`. */
export type RawDays = string | readonly string[];

/** Days that share one day plan. */
export type RawWeekBlock = Readonly<{ days: RawDays; temperature: RawDayPlan }>;

export type RawSchedule = Readonly<{ id: string; name: string; week: readonly RawWeekBlock[] }>;

export type RawSensor = Readonly<{ ref: string; weight?: number }>;

/** A room entry; `schedule` absent: the room follows `default_schedule`. */
export type RawRoomEntry = Readonly<{
  schedule?: string;
  sensors?: readonly RawSensor[];
  presets?: RawPresets;
  override_end?: EndRule;
  /** Whole minutes. */
  override_duration_min?: number;
}>;

/** `rooms` is keyed by Home Assistant area id. */
export type RawConfig = Readonly<{
  version: 3;
  settings?: RawSettings;
  presets?: RawPresets;
  schedules?: readonly RawSchedule[];
  default_schedule?: string;
  rooms?: Readonly<Record<string, RawRoomEntry>>;
}>;

const ID_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const HA_ENTITY_PATTERN = /^sensor\.[a-z0-9_]+$/;
/** An id ending in `-<digits>` or `_<digits>` after something else. */
const NUMBERED_ID_PATTERN = /^.+[-_][0-9]+$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const CONTROL_PATTERN = /\p{Cc}/u;

const MIN_TEMPERATURE = 4;
const MAX_TEMPERATURE = 35;
/** How many room entries a config may hold. */
export const MAX_ROOMS = 64;
const MAX_SCHEDULES = 64;
/** How many sensors a room entry may list. */
export const MAX_SENSORS = 16;
const MAX_NAME_LENGTH = 64;
const MAX_SENSOR_WEIGHT = 10;
const MAX_DAY_SET_POINTS = 6;
const WEEKDAY_WORDS: readonly Weekday[] = WEEKDAYS;
const ALIASES: Readonly<Record<string, readonly Weekday[]>> = {
  all: WEEKDAYS,
  weekdays: ["mon", "tue", "wed", "thu", "fri"],
  weekend: ["sat", "sun"],
};
const MS_PER_MINUTE = 60 * 1000;
const MIDNIGHT = Temporal.PlainTime.from("00:00");

type Report = (path: string, code: string, message: string) => void;

/**
 * Brings an older document up to CONFIG_VERSION. Version 3 is the current one, so it returns the
 * document unchanged; older documents are refused by `validateConfig`, and only the stored file
 * is upgraded.
 */
export function migrateRaw(raw: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { ...raw };
}

type DayGroup = Readonly<{ days: readonly Weekday[] }>;

/** Groups the weekdays that share a key, in the order of each group's first day. */
function groupDays(keys: Readonly<Record<Weekday, string>>): readonly DayGroup[] {
  const groups = new Map<string, Weekday[]>();
  for (const day of WEEKDAYS) {
    const key = keys[day];
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [day]);
    else group.push(day);
  }
  return [...groups.values()].map((days) => ({ days }));
}

/** The `days` of a block: `all`, `weekdays`, `weekend`, or the day names in week order. */
function daysToRaw(days: readonly Weekday[]): RawDays {
  const same = (names: readonly Weekday[]): boolean =>
    days.length === names.length && names.every((name, i) => days[i] === name);
  if (same(WEEKDAYS)) return "all";
  if (same(ALIASES.weekdays ?? [])) return "weekdays";
  if (same(ALIASES.weekend ?? [])) return "weekend";
  return days;
}

function dayPlanKey(plan: readonly [string, number | PresetName][]): string {
  return JSON.stringify(plan);
}

/** A raw version 1 day as sorted `[time, value]` pairs; undefined when it is not well formed. */
function v1DayPlan(day: unknown): [string, number | PresetName][] | undefined {
  if (!isList(day)) return undefined;
  const plan: [string, number | PresetName][] = [];
  for (const item of day) {
    if (!isRecord(item) || typeof item.time !== "string") return undefined;
    const { temperature, preset } = item;
    let value: number | PresetName;
    if (typeof temperature === "number" && preset === undefined) value = temperature;
    else if (typeof preset === "string" && temperature === undefined) {
      const known = PRESET_NAMES.find((name) => name === preset);
      if (known === undefined) return undefined;
      value = known;
    } else return undefined;
    if (plan.some(([time]) => time === item.time)) return undefined;
    plan.push([item.time, value]);
  }
  return plan.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function v1WeekToBlocks(week: unknown): readonly RawWeekBlock[] | undefined {
  if (!isRecord(week)) return undefined;
  const plans = new Map<Weekday, [string, number | PresetName][]>();
  for (const day of WEEKDAYS) {
    const plan = v1DayPlan(week[day]);
    if (plan === undefined) return undefined;
    plans.set(day, plan);
  }
  const plan = (day: Weekday): [string, number | PresetName][] => plans.get(day) ?? [];
  const keys = Object.fromEntries(WEEKDAYS.map((day) => [day, dayPlanKey(plan(day))])) as Record<
    Weekday,
    string
  >;
  return groupDays(keys).map((group) => ({
    days: daysToRaw(group.days),
    temperature: Object.fromEntries(plan(group.days[0] ?? "mon")),
  }));
}

/**
 * Upgrades a stored version 1 config document (a week per schedule under `default_week`) to
 * version 2 (blocks of days under `week`). A schedule that is not well formed is left as it is, so
 * that validation reports it; any other document is returned unchanged.
 */
export function upgradeRawV1(raw: unknown): unknown {
  if (!isRecord(raw) || raw.version !== 1) return raw;
  const schedules = isList(raw.schedules)
    ? raw.schedules.map((schedule: unknown) => {
        if (!isRecord(schedule) || !Object.hasOwn(schedule, "default_week")) return schedule;
        const blocks = v1WeekToBlocks(schedule.default_week);
        if (blocks === undefined) return schedule;
        return {
          ...Object.fromEntries(Object.entries(schedule).filter(([key]) => key !== "default_week")),
          week: blocks,
        };
      })
    : raw.schedules;
  return { ...raw, version: 2, ...(schedules === undefined ? {} : { schedules }) };
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

/** An end rule, or undefined when the key is missing (or reported). */
function parseEndRule(report: Report, path: string, value: unknown): EndRule | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    typeInvalid(report, path, "a text");
    return undefined;
  }
  const rule = END_RULES.find((candidate) => candidate === value);
  if (rule === undefined) {
    report(path, "override_end_unsupported", 'the end rule is "next_change", "timer" or "manual"');
  }
  return rule;
}

/** Whole minutes of an override duration, or undefined when the key is missing. */
function parseOverrideMinutes(report: Report, path: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const [min, max] = OVERRIDE_DURATION_RANGE_MS;
  return parseWholeMinutes(report, path, value, min / MS_PER_MINUTE, max / MS_PER_MINUTE, 0);
}

function parseSettings(report: Report, path: string, value: unknown): Settings {
  const obj = asObject(report, path, value === undefined ? {} : value, [
    "external_write_interval_min",
    "sensor_stale_min",
    "hold_writes",
    "timezone",
    "language",
    "override_end",
    "override_duration_min",
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

  const overrideEnd = parseEndRule(report, at(path, "override_end"), read(obj, "override_end"));
  const overrideMinutes = parseOverrideMinutes(
    report,
    at(path, "override_duration_min"),
    read(obj, "override_duration_min"),
  );

  return {
    externalWriteIntervalMs: interval * MS_PER_MINUTE,
    sensorStaleAfterMs: stale * MS_PER_MINUTE,
    holdWrites,
    timezone,
    language,
    overrideEnd: overrideEnd ?? DEFAULT_SETTINGS.overrideEnd,
    overrideDurationMs:
      overrideMinutes === undefined
        ? DEFAULT_SETTINGS.overrideDurationMs
        : overrideMinutes * MS_PER_MINUTE,
  };
}

function timeKeyMessage(key: string): string {
  return /^(0|[1-9]\d*)$/.test(key)
    ? `the key "${key}" is not a time; an unquoted 07:00 is read as a number, write "HH:MM" in quotes`
    : 'a time is "HH:MM"';
}

function parseDayPlan(report: Report, path: string, value: unknown): readonly SetPoint[] {
  if (value === undefined) return [];
  if (!isRecord(value)) {
    typeInvalid(report, path, 'an object of "HH:MM" times');
    return [];
  }
  const keys = Object.keys(value);
  if (keys.length < 1 || keys.length > MAX_DAY_SET_POINTS) {
    report(path, "set_point_count", "a day has 1 to 6 set points");
  }
  const points: SetPoint[] = [];
  let timesValid = true;
  for (const key of keys) {
    const keyPath = at(path, key);
    if (!TIME_PATTERN.test(key)) {
      report(keyPath, "time_invalid", timeKeyMessage(key));
      timesValid = false;
      continue;
    }
    const time = Temporal.PlainTime.from(key);
    const item = value[key];
    if (typeof item === "number") {
      points.push({
        time,
        preset: undefined,
        temperature: parseTemperature(report, keyPath, item),
      });
    } else if (typeof item === "string") {
      const known = PRESET_NAMES.find((name) => name === item);
      if (known === undefined) report(keyPath, "preset_unknown", "unknown preset name");
      else points.push({ time, preset: known, temperature: undefined });
    } else typeInvalid(report, keyPath, "a number or a preset name");
  }
  points.sort((a, b) => Temporal.PlainTime.compare(a.time, b.time));
  const first = points[0];
  if (timesValid && first !== undefined && !first.time.equals(MIDNIGHT)) {
    report(
      at(path, first.time.toString({ smallestUnit: "minute" })),
      "first_set_point_not_midnight",
      "the first set point is 00:00",
    );
  }
  return points;
}

/**
 * The weekdays a `days` value names, in the order written: a list of day names, or the single
 * string `all`, `weekdays` or `weekend`. Undefined when it is not usable.
 */
function parseDays(report: Report, path: string, value: unknown): readonly Weekday[] | undefined {
  if (isList(value)) {
    if (value.length < 1) {
      report(path, "days_empty", "a block needs at least one day");
      return undefined;
    }
    const days: Weekday[] = [];
    const state = { usable: true };
    value.forEach((item, index) => {
      const itemPath = atIndex(path, index);
      if (typeof item !== "string") {
        typeInvalid(report, itemPath, "a day name");
        state.usable = false;
        return;
      }
      const day = WEEKDAY_WORDS.find((name) => name === item);
      if (day === undefined) {
        report(itemPath, "day_invalid", `unknown day "${item}"; use mon to sun`);
        state.usable = false;
      } else days.push(day);
    });
    return state.usable ? days : undefined;
  }
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    typeInvalid(report, path, "a list of day names, all, weekdays or weekend");
    return undefined;
  }
  const alias = Object.hasOwn(ALIASES, value) ? ALIASES[value] : undefined;
  if (alias === undefined) {
    report(
      path,
      "day_invalid",
      `"${value}" is not all, weekdays or weekend; list single days as [mon, tue, ...]`,
    );
    return undefined;
  }
  return alias;
}

function parseWeek(report: Report, path: string, value: unknown): Week {
  const week: Record<Weekday, readonly SetPoint[]> = {
    mon: [],
    tue: [],
    wed: [],
    thu: [],
    fri: [],
    sat: [],
    sun: [],
  };
  if (value === undefined) return week;
  if (!isList(value)) {
    typeInvalid(report, path, "a list");
    return week;
  }
  if (value.length < 1) {
    report(path, "week_empty", "a week needs at least one block of days");
    return week;
  }
  const covered = new Set<Weekday>();
  const owner = new Map<Weekday, number>();
  const blocks: { path: string; days: readonly Weekday[] }[] = [];
  const state = { complete: true };
  value.forEach((item, index) => {
    const blockPath = atIndex(path, index);
    const obj = asObject(report, blockPath, item, ["days", "temperature"]);
    const daysPath = at(blockPath, "days");
    const rawDays = requiredKey(report, blockPath, obj, "days");
    const days = parseDays(report, daysPath, rawDays);
    const plan = parseDayPlan(
      report,
      at(blockPath, "temperature"),
      requiredKey(report, blockPath, obj, "temperature"),
    );
    if (days === undefined) {
      state.complete = false;
      return;
    }
    const repeated = days.filter((day, i) => days.indexOf(day) !== i);
    if (repeated.length > 0) {
      const names = [...new Set(repeated)].join(", ");
      report(daysPath, "day_repeated", `listed twice in this block: ${names}`);
      state.complete = false;
    }
    blocks.push({ path: blockPath, days });
    for (const day of days) {
      covered.add(day);
      owner.set(day, blocks.length - 1);
      week[day] = plan;
    }
  });
  blocks.forEach((block, index) => {
    if (block.days.every((day) => owner.get(day) !== index)) {
      report(block.path, "block_unused", "later blocks override every day of this block");
    }
  });
  if (state.complete) {
    for (const day of WEEKDAYS) {
      if (!covered.has(day)) report(path, "day_missing", `missing weekday "${day}"`);
    }
  }
  return week;
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
  const labelIds = new Set<string>();
  const names = new Set<string>();
  let complete = isList(value) || value === undefined;
  const schedules = list.map((item, index): Schedule => {
    const itemPath = atIndex(path, index);
    const obj = asObject(report, itemPath, item, ["id", "name", "week"]);
    const rawId = requiredKey(report, itemPath, obj, "id");
    const id = parseId(report, at(itemPath, "id"), rawId);
    if (typeof rawId !== "string") complete = false;
    else if (ids.has(id))
      report(at(itemPath, "id"), "id_duplicate", `duplicate schedule id "${id}"`);
    else {
      ids.add(id);
      // Home Assistant slugs a label's name into its id, so "-" and "_" give one label.
      const labelId = scheduleLabelId(id);
      if (NUMBERED_ID_PATTERN.test(id)) {
        // Home Assistant numbers a label whose id is taken (`_2`): such ids are always foreign.
        report(
          at(itemPath, "id"),
          "schedule_id_reserved",
          "a schedule id may not end in a dash or underscore followed by digits",
        );
      } else if (labelIds.has(labelId)) {
        report(
          at(itemPath, "id"),
          "label_id_duplicate",
          `another schedule id gives the label id "${labelId}"`,
        );
      } else labelIds.add(labelId);
    }
    const rawName = requiredKey(report, itemPath, obj, "name");
    const name = parseName(report, at(itemPath, "name"), rawName);
    if (typeof rawName === "string") {
      // Home Assistant label names are unique ignoring case.
      const folded = rawName.toLowerCase();
      if (names.has(folded)) {
        report(at(itemPath, "name"), "name_duplicate", `another schedule is named "${rawName}"`);
      } else names.add(folded);
    }
    const defaultWeek = parseWeek(
      report,
      at(itemPath, "week"),
      requiredKey(report, itemPath, obj, "week"),
    );
    return { id, name, defaultWeek };
  });
  return { schedules, ids, complete };
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

function parseDefaultSchedule(
  report: Report,
  path: string,
  value: unknown,
  schedules: readonly Schedule[],
  scheduleIds: ReadonlySet<string>,
  schedulesComplete: boolean,
): string | undefined {
  if (value === undefined) {
    if (schedules.length > 0) {
      report(path, "key_missing", `missing required key "${path}"`);
    }
    return undefined;
  }
  const id = parseText(report, path, value);
  if (typeof value === "string" && schedulesComplete && !scheduleIds.has(id)) {
    report(path, "schedule_unknown", `no schedule "${id}"`);
  }
  return typeof value === "string" ? id : undefined;
}

function parseEntry(
  report: Report,
  path: string,
  value: unknown,
  scheduleIds: ReadonlySet<string>,
  schedulesComplete: boolean,
): RoomEntry {
  const obj = asObject(report, path, value, [
    "schedule",
    "sensors",
    "presets",
    "override_end",
    "override_duration_min",
  ]);
  const rawSchedule = read(obj, "schedule");
  let scheduleId: string | undefined;
  if (rawSchedule !== undefined) {
    const schedulePath = at(path, "schedule");
    const id = parseText(report, schedulePath, rawSchedule);
    if (typeof rawSchedule === "string") {
      scheduleId = id;
      if (schedulesComplete && !scheduleIds.has(id)) {
        report(schedulePath, "schedule_unknown", `no schedule "${id}"`);
      }
    }
  }
  const sensors = parseSensors(report, at(path, "sensors"), read(obj, "sensors"));
  const rawPresets = read(obj, "presets");
  const partial = parsePresetValues(
    report,
    at(path, "presets"),
    rawPresets === undefined ? {} : rawPresets,
  );
  const presets: RoomPresets = {
    comfort: partial.comfort,
    eco: partial.eco,
    frost: partial.frost,
    boost: partial.boost,
  };
  const overrideEnd = parseEndRule(report, at(path, "override_end"), read(obj, "override_end"));
  const minutes = parseOverrideMinutes(
    report,
    at(path, "override_duration_min"),
    read(obj, "override_duration_min"),
  );
  return {
    scheduleId,
    sensors,
    presets,
    overrideEnd,
    overrideDurationMs: minutes === undefined ? undefined : minutes * MS_PER_MINUTE,
  };
}

/** The entries, keyed by area id, in the document's order. */
function parseRooms(
  report: Report,
  path: string,
  value: unknown,
  scheduleIds: ReadonlySet<string>,
  schedulesComplete: boolean,
): ReadonlyMap<string, RoomEntry> {
  const rooms = new Map<string, RoomEntry>();
  if (value === undefined) return rooms;
  if (!isRecord(value)) {
    typeInvalid(report, path, "an object of area ids");
    return rooms;
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_ROOMS) report(path, "too_many", `at most ${String(MAX_ROOMS)} entries`);
  for (const key of keys) {
    const entryPath = at(path, key);
    if (!AREA_ID_PATTERN.test(key)) {
      report(
        entryPath,
        "area_id_invalid",
        "a rooms key is a Home Assistant area id: 1 to 64 of a-z, 0-9 and _",
      );
    }
    rooms.set(key, parseEntry(report, entryPath, value[key], scheduleIds, schedulesComplete));
  }
  return rooms;
}

function versionMessage(version: unknown): string {
  const wanted = `the document version must be ${String(CONFIG_VERSION)}`;
  if (version === 1) {
    return `${wanted}: the week format changed (write each schedule's week as blocks of days), and rooms now come from Home Assistant areas`;
  }
  if (version === 2) {
    return `${wanted}: rooms now come from Home Assistant areas; list an entry per area id under rooms, with no valves`;
  }
  return wanted;
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
      { path: "version", code: "version_unsupported", message: versionMessage(doc.version) },
    ]);
  }

  const issues: ConfigIssue[] = [];
  const report: Report = (path, code, message) => {
    issues.push({ path, code, message });
  };
  asObject(report, "", doc, [
    "version",
    "settings",
    "presets",
    "schedules",
    "default_schedule",
    "rooms",
  ]);

  const settings = parseSettings(report, "settings", read(doc, "settings"));
  const rawPresets = read(doc, "presets");
  const presetValues = parsePresetValues(
    report,
    "presets",
    rawPresets === undefined ? {} : rawPresets,
  );
  const presets: Presets = { ...DEFAULT_PRESETS, ...presetValues };
  const { schedules, ids, complete } = parseSchedules(report, "schedules", read(doc, "schedules"));
  const defaultScheduleId = parseDefaultSchedule(
    report,
    "default_schedule",
    read(doc, "default_schedule"),
    schedules,
    ids,
    complete,
  );
  const rooms = parseRooms(report, "rooms", read(doc, "rooms"), ids, complete);

  if (issues.length > 0) throw new ConfigError(issues);
  return { settings, presets, schedules, defaultScheduleId, rooms };
}

function setPointValue(point: SetPoint): number | PresetName {
  if (point.temperature !== undefined) return point.temperature;
  if (point.preset === undefined) throw new Error("a set point holds a preset or a temperature");
  return point.preset;
}

function weekToRaw(week: Week): readonly RawWeekBlock[] {
  const plans = Object.fromEntries(
    WEEKDAYS.map((day) => [
      day,
      week[day].map((point): [string, number | PresetName] => [
        point.time.toString({ smallestUnit: "minute" }),
        setPointValue(point),
      ]),
    ]),
  ) as Record<Weekday, [string, number | PresetName][]>;
  const keys = Object.fromEntries(WEEKDAYS.map((day) => [day, dayPlanKey(plans[day])])) as Record<
    Weekday,
    string
  >;
  return groupDays(keys).map((group) => ({
    days: daysToRaw(group.days),
    temperature: Object.fromEntries(plans[group.days[0] ?? "mon"]),
  }));
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

/** Leaves out a missing schedule, empty sensors, empty presets and missing override keys: an entry with none is `{}`. */
function entryToRaw(entry: RoomEntry): RawRoomEntry {
  const presets = presetsToRaw(entry.presets);
  return {
    ...(entry.scheduleId === undefined ? {} : { schedule: entry.scheduleId }),
    ...(entry.sensors.length === 0 ? {} : { sensors: entry.sensors.map(sensorToRaw) }),
    ...(Object.keys(presets).length === 0 ? {} : { presets }),
    ...(entry.overrideEnd === undefined ? {} : { override_end: entry.overrideEnd }),
    ...(entry.overrideDurationMs === undefined
      ? {}
      : { override_duration_min: entry.overrideDurationMs / MS_PER_MINUTE }),
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
      override_end: settings.overrideEnd,
      override_duration_min: settings.overrideDurationMs / MS_PER_MINUTE,
    },
    presets: presetsToRaw(config.presets),
    schedules: config.schedules.map((schedule) => ({
      id: schedule.id,
      name: schedule.name,
      week: weekToRaw(schedule.defaultWeek),
    })),
    ...(config.defaultScheduleId === undefined
      ? {}
      : { default_schedule: config.defaultScheduleId }),
    rooms: Object.fromEntries(
      [...config.rooms].map(([areaId, entry]) => [areaId, entryToRaw(entry)]),
    ),
  };
}
