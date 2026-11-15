import { WEEKDAYS } from "./model.ts";
import type { Presets, SetPoint, Week, Weekday } from "./model.ts";

/** A value this far below a half counts as the half (see the styleguide, Rounding). */
const HALF_TOLERANCE = 0.000000001;
/** How many days after today `activePoint` looks through for a change. */
const LOOKAHEAD_DAYS = 7;

export type ResolvedPoint = Readonly<{ time: Temporal.PlainTime; temperature: number }>;
export type ResolvedDay = readonly ResolvedPoint[];
export type ResolvedWeek = Readonly<Record<Weekday, ResolvedDay>>;
export type FittedWeek = Readonly<{ days: ResolvedWeek; clamped: boolean }>;
export type ActivePoint = Readonly<{
  temperature: number;
  nextChangeAt: number | undefined;
  nextTemperature: number | undefined;
}>;

function resolvePoint(point: SetPoint, presets: Presets): ResolvedPoint {
  const temperature = point.preset === undefined ? point.temperature : presets[point.preset];
  if (temperature === undefined)
    throw new RangeError("set point has neither preset nor temperature");
  return { time: point.time, temperature };
}

/** The room's view of its week: every preset replaced by its temperature. */
export function resolveWeek(week: Week, presets: Presets): ResolvedWeek {
  const days = {} as Record<Weekday, ResolvedDay>;
  for (const weekday of WEEKDAYS)
    days[weekday] = week[weekday].map((p) => resolvePoint(p, presets));
  return days;
}

function roundToStep(value: number, step: number): number {
  const stepped = Math.floor(value / step + 0.5 + HALF_TOLERANCE) * step;
  return Math.round(stepped * 1_000_000) / 1_000_000 + 0;
}

/** One valve's view of a week: rounded half up to `tempStep`, then held inside the range. */
export function fitWeek(
  week: ResolvedWeek,
  minTemp: number,
  maxTemp: number,
  tempStep: number,
): FittedWeek {
  let clamped = false;
  const fit = (temperature: number): number => {
    const rounded = roundToStep(temperature, tempStep);
    if (rounded < minTemp) {
      clamped = true;
      return minTemp;
    }
    if (rounded > maxTemp) {
      clamped = true;
      return maxTemp;
    }
    return rounded;
  };
  const days = {} as Record<Weekday, ResolvedDay>;
  for (const weekday of WEEKDAYS) {
    days[weekday] = week[weekday].map((p) => ({ time: p.time, temperature: fit(p.temperature) }));
  }
  return { days, clamped };
}

/** Drops every point whose temperature equals that of the point before it. */
export function normalizeDay(points: readonly ResolvedPoint[]): ResolvedDay {
  return points.filter((p, i) => i === 0 || p.temperature !== points[i - 1]?.temperature);
}

/** True when both days are the same after `normalizeDay`. */
export function daysEqual(a: readonly ResolvedPoint[], b: readonly ResolvedPoint[]): boolean {
  const left = normalizeDay(a);
  const right = normalizeDay(b);
  return (
    left.length === right.length &&
    left.every((p, i) => {
      const other = right[i];
      return p.temperature === other?.temperature && p.time.equals(other.time);
    })
  );
}

/**
 * The instant at which `date`'s wall clock shows `time`: the first of two if it happens twice, the
 * first instant after the skipped hour if it is skipped.
 */
function instantOf(
  date: Temporal.PlainDate,
  time: Temporal.PlainTime,
  timeZone: string,
): number | undefined {
  const earlier = date
    .toPlainDateTime(time)
    .toZonedDateTime(timeZone, { disambiguation: "earlier" });
  if (earlier.toPlainTime().equals(time)) return earlier.epochMilliseconds;
  return earlier.getTimeZoneTransition("next")?.epochMilliseconds;
}

/** The set point in force at `now` and the next instant it changes to another temperature. */
export function activePoint(week: ResolvedWeek, now: Temporal.ZonedDateTime): ActivePoint {
  const today = now.toPlainDate();
  const clock = now.toPlainTime();
  const weekdayOf = (date: Temporal.PlainDate): Weekday => WEEKDAYS[date.dayOfWeek - 1] ?? "mon";
  const todays = week[weekdayOf(today)];
  const active =
    todays.findLast((p) => Temporal.PlainTime.compare(p.time, clock) <= 0) ??
    week[weekdayOf(today.subtract({ days: 1 }))].at(-1) ??
    todays[0];
  if (active === undefined) throw new RangeError("the day has no set points");
  const temperature = active.temperature;
  const nowMs = now.epochMilliseconds;
  for (let offset = 0; offset <= LOOKAHEAD_DAYS; offset++) {
    const date = today.add({ days: offset });
    for (const point of week[weekdayOf(date)]) {
      if (point.temperature === temperature) continue;
      if (offset === 0 && Temporal.PlainTime.compare(point.time, clock) <= 0) continue;
      const at = instantOf(date, point.time, now.timeZoneId);
      if (at !== undefined && at > nowMs) {
        return { temperature, nextChangeAt: at, nextTemperature: point.temperature };
      }
    }
  }
  return { temperature, nextChangeAt: undefined, nextTemperature: undefined };
}
