import { WEEKDAYS } from "./model.ts";
import type { Weekday } from "./model.ts";
import { roundHalfUp } from "./rounding.ts";
import { activePoint, fitWeek, normalizeDay } from "./schedule.ts";
import { DAY_KEYS, SETTING_KEYS, members, valuesEqual } from "./settings.ts";
import type { ValveRecord } from "./ledger.ts";
import type { DeviceState } from "./observation.ts";
import type { FittedWeek, ResolvedDay, ResolvedPoint, ResolvedWeek } from "./schedule.ts";
import type { Group, SensorSource, SettingKey, SettingValue, ValveSpec } from "./settings.ts";
import type { SavedWeek, Thermostat, ThermostatWanted } from "./thermostat.ts";
import type { AdapterContext } from "./thermostat-adapter.ts";

/**
 * How far ahead of now a TRV-ZBT's value in force is taken (R18), and how close to a report's time
 * a point must be to explain it (R23): valve clocks run up to 40 s off (M8).
 */
export const SCHEDULE_SKEW_MS = 2 * 60 * 1000;

/** Frost protection temperatures are rounded half up to this step, in °C. */
const FROST_STEP = 0.5;

export type Reason =
  | "schedule"
  | "group_ready"
  | "room_temperature"
  | "no_room_temperature"
  | "release"
  | "thermostat"
  | "frost";

export type DesiredValue = Readonly<{ value: SettingValue; reason: Reason }>;

/** A key that is absent is left alone: never written, never blocking a release. */
export type Desired = Readonly<Partial<Record<SettingKey, DesiredValue>>>;

/** The week as this valve can hold it: its range and step. */
export function fitted(week: ResolvedWeek, spec: ValveSpec): FittedWeek {
  return fitWeek(week, spec.minTemp, spec.maxTemp, spec.tempStep);
}

function hasGroup(spec: ValveSpec, group: Group): boolean {
  return spec.groups.some((g) => g.group === group);
}

/**
 * What a managed valve should hold. `active_group` waits for `scheduleTrusted`, the caller's
 * word that the week was sent and is not in doubt, and for a state to exist. The observed days are
 * not read, because the TRV-ZBT's days are write-only.
 */
export function managedDesired(
  spec: ValveSpec,
  week: ResolvedWeek,
  state: DeviceState | undefined,
  source: SensorSource | undefined,
  scheduleTrusted: boolean,
): Desired {
  const desired: Partial<Record<SettingKey, DesiredValue>> = {};
  const days = fitted(week, spec).days;
  if (hasGroup(spec, "schedule")) {
    for (const weekday of WEEKDAYS)
      desired[DAY_KEYS[weekday]] = { value: days[weekday], reason: "schedule" };
  }
  const ready = scheduleTrusted && state !== undefined;
  if (spec.scheduleGroup !== undefined && ready && hasGroup(spec, "active_group"))
    desired.active_group = { value: spec.scheduleGroup, reason: "group_ready" };
  if (source !== undefined && hasGroup(spec, "sensor_source")) {
    desired.sensor_source = {
      value: source,
      reason: source === "external" ? "room_temperature" : "no_room_temperature",
    };
  }
  return desired;
}

/**
 * The captured originals to restore. The schedule is never restored, and the setpoint only when the
 * captured mode is `heat`: a setpoint written to a TRVZB in `auto` moves it to `heat`.
 */
export function releaseDesired(spec: ValveSpec, record: ValveRecord): Desired {
  const desired: Partial<Record<SettingKey, DesiredValue>> = {};
  for (const groupSpec of spec.groups) {
    if (!groupSpec.capture || groupSpec.group === "schedule") continue;
    for (const key of members(groupSpec.group)) {
      const original = record.originals[key];
      if (key === "setpoint" && record.originals.system_mode !== "heat") continue;
      if (original !== null && original !== undefined)
        desired[key] = { value: original, reason: "release" };
    }
  }
  return desired;
}

/** The desired keys whose observed value is unknown or not equal, in `SETTING_KEYS` order. */
export function differing(desired: Desired, state: DeviceState | undefined): readonly SettingKey[] {
  return SETTING_KEYS.filter((key) => {
    const wanted = desired[key];
    if (wanted === undefined) return false;
    const observed = state?.values[key];
    return observed === undefined || !valuesEqual(key, observed, wanted.value);
  });
}

/** A stable text of the week's days: weeks whose days are `daysEqual` give equal keys. */
export function weekKey(week: ResolvedWeek): string {
  const time = (t: Temporal.PlainTime): number => (t.hour * 60 + t.minute) * 60 + t.second;
  return WEEKDAYS.map((day) =>
    normalizeDay(week[day])
      .map((point) => `${String(time(point.time))}/${String(point.temperature)}`)
      .join(" "),
  ).join(";");
}

/** The week a `weekKey` text describes, or undefined when the text is not one. */
function weekOfKey(key: string): ResolvedWeek | undefined {
  const texts = key.split(";");
  if (texts.length !== WEEKDAYS.length) return undefined;
  const week: Partial<Record<Weekday, ResolvedDay>> = {};
  for (const [i, weekday] of WEEKDAYS.entries()) {
    const day: ResolvedPoint[] = [];
    for (const text of (texts[i] ?? "").split(" ")) {
      const [seconds, temperature] = text.split("/").map(Number);
      const valid =
        seconds !== undefined &&
        temperature !== undefined &&
        Number.isInteger(seconds) &&
        seconds >= 0 &&
        seconds < 24 * 60 * 60 &&
        Number.isFinite(temperature);
      if (!valid) return undefined;
      const time = Temporal.PlainTime.from({
        hour: Math.floor(seconds / 3600),
        minute: Math.floor(seconds / 60) % 60,
        second: seconds % 60,
      });
      day.push({ time, temperature });
    }
    week[weekday] = day;
  }
  return week as ResolvedWeek;
}

/** Held in the valve's setpoint range, then rounded half up to its step. */
function asSetpoint(spec: ValveSpec, celsius: number): number {
  return roundHalfUp(Math.min(Math.max(celsius, spec.minTemp), spec.maxTemp), spec.tempStep);
}

function setpointsOf(spec: ValveSpec, temperatures: readonly number[]): ReadonlySet<number> {
  return new Set(temperatures.map((celsius) => asSetpoint(spec, celsius)));
}

/** Every temperature in force at some instant within `SCHEDULE_SKEW_MS` of `at`. */
function temperaturesNear(week: ResolvedWeek, at: number, timeZone: string): readonly number[] {
  const zoned = (ms: number): Temporal.ZonedDateTime =>
    Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(timeZone);
  let point = activePoint(week, zoned(at - SCHEDULE_SKEW_MS));
  const temperatures = [point.temperature];
  while (point.nextChangeAt !== undefined && point.nextChangeAt <= at + SCHEDULE_SKEW_MS) {
    point = activePoint(week, zoned(point.nextChangeAt));
    temperatures.push(point.temperature);
  }
  return temperatures;
}

/**
 * What the adapter is told of the valve's week (R18, R23). With a `confirmed` week: `inForce` is
 * its value `SCHEDULE_SKEW_MS` from now, `weekValues` every temperature of it, and `pointValues`
 * every temperature in force within `SCHEDULE_SKEW_MS` of `heardAt` (undefined without it).
 * Without one, while `saved` has the key of the desired week (`desired`, the valve's fitted week),
 * the saved week stands in for the confirmed one: `weekValues` are its values and `pointValues`
 * are taken from it at `heardAt` as above (it is the desired week, by key); `inForce` stays
 * undefined. Otherwise all three are undefined. Every temperature is held in the valve's range and
 * rounded to its step.
 */
export function thermostatContext(
  spec: ValveSpec,
  confirmed: ResolvedWeek | undefined,
  saved: SavedWeek | undefined,
  desired: ResolvedWeek,
  heardAt: number | undefined,
  now: Temporal.ZonedDateTime,
): AdapterContext {
  const points = (week: ResolvedWeek): ReadonlySet<number> | undefined =>
    heardAt === undefined
      ? undefined
      : setpointsOf(spec, temperaturesNear(week, heardAt, now.timeZoneId));
  if (confirmed === undefined) {
    const kept = saved?.key === weekKey(desired);
    return {
      inForce: undefined,
      weekValues: kept ? setpointsOf(spec, saved.values) : undefined,
      pointValues: kept ? points(desired) : undefined,
    };
  }
  const ahead = now.add({ milliseconds: SCHEDULE_SKEW_MS });
  return {
    inForce: asSetpoint(spec, activePoint(confirmed, ahead).temperature),
    weekValues: setpointsOf(
      spec,
      WEEKDAYS.flatMap((day) => confirmed[day].map((point) => point.temperature)),
    ),
    pointValues: points(confirmed),
  };
}

/**
 * Every temperature in force at some instant within `SCHEDULE_SKEW_MS` of `heardAt` in any of
 * `weeks`, saved weeks the valve may still run (R23, a lost day write): read back from their keys,
 * held in the valve's range and rounded to its step. Undefined without `heardAt` or without a week
 * whose key is a `weekKey` text.
 */
export function savedPointValues(
  spec: ValveSpec,
  weeks: readonly SavedWeek[],
  heardAt: number | undefined,
  timeZone: string,
): ReadonlySet<number> | undefined {
  if (heardAt === undefined) return undefined;
  const resolved = weeks.flatMap((saved) => {
    const week = weekOfKey(saved.key);
    return week === undefined ? [] : [week];
  });
  if (resolved.length === 0) return undefined;
  return setpointsOf(
    spec,
    resolved.flatMap((week) => temperaturesNear(week, heardAt, timeZone)),
  );
}

/** The adapter's wanted state, its setpoint held in the valve's range and rounded to its step. */
export function thermostatWanted(
  spec: ValveSpec,
  thermostat: Thermostat,
  ctx: AdapterContext,
): ThermostatWanted {
  const wanted = spec.thermostat.wanted(thermostat, ctx);
  const setpoint = wanted.setpoint === undefined ? undefined : asSetpoint(spec, wanted.setpoint);
  return { ...wanted, setpoint };
}

/** `system_mode`, and `setpoint` when the wanted state has one. */
export function thermostatDesired(wanted: ThermostatWanted): Desired {
  const desired: Partial<Record<SettingKey, DesiredValue>> = {
    system_mode: { value: wanted.mode, reason: "thermostat" },
  };
  if (wanted.setpoint !== undefined) {
    desired.setpoint = { value: wanted.setpoint, reason: "thermostat" };
  }
  return desired;
}

/** The room's frost preset, held in the valve's frost range and rounded half up to 0.5. */
export function frostDesired(spec: ValveSpec, frostPreset: number): Desired {
  const held = Math.min(Math.max(frostPreset, spec.frostMinTemp), spec.frostMaxTemp);
  return { frost_protection: { value: roundHalfUp(held, FROST_STEP), reason: "frost" } };
}
