import { WEEKDAYS } from "./model.ts";
import { roundHalfUp } from "./rounding.ts";
import type { Presets, SetPoint, Week, Weekday } from "./model.ts";

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

/**
 * One stretch of the schedule. `startAt` is the instant the set point in force began (undefined
 * when none lies within the look-back); `nextAt` is the next set point instant after now, whatever
 * its temperature.
 */
export type Segment = Readonly<{
  temperature: number;
  startAt: number | undefined;
  nextAt: number | undefined;
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

/** One valve's view of a week: rounded half up to `tempStep`, then held inside the range. */
export function fitWeek(
  week: ResolvedWeek,
  minTemp: number,
  maxTemp: number,
  tempStep: number,
): FittedWeek {
  let clamped = false;
  const fit = (temperature: number): number => {
    const rounded = roundHalfUp(temperature, tempStep);
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
    const entries = week[weekdayOf(date)].map((point) => ({
      point,
      at: instantOf(date, point.time, now.timeZoneId),
    }));
    for (const { point, at } of entries) {
      if (offset === 0 && Temporal.PlainTime.compare(point.time, clock) <= 0) continue;
      if (at === undefined || at <= nowMs) continue;
      // Points of one date that resolve to the same instant: the last one is in force there.
      const last = entries.findLast((e) => e.at === at)?.point ?? point;
      if (last.temperature === temperature) continue;
      return { temperature, nextChangeAt: at, nextTemperature: last.temperature };
    }
  }
  return { temperature, nextChangeAt: undefined, nextTemperature: undefined };
}

/**
 * The set point in force at `now`, the instant it began (looking back up to `LOOKAHEAD_DAYS` days)
 * and the first set point instant strictly after `now`, even when it keeps the temperature. A time
 * that does not exist moves to the transition, as in `activePoint`.
 */
export function segmentAt(week: ResolvedWeek, now: Temporal.ZonedDateTime): Segment {
  const { temperature } = activePoint(week, now);
  const today = now.toPlainDate();
  const clock = now.toPlainTime();
  const nowMs = now.epochMilliseconds;
  const weekdayOf = (date: Temporal.PlainDate): Weekday => WEEKDAYS[date.dayOfWeek - 1] ?? "mon";

  let startAt: number | undefined;
  for (let back = 0; back <= LOOKAHEAD_DAYS && startAt === undefined; back++) {
    const date = today.subtract({ days: back });
    const started = week[weekdayOf(date)]
      .filter((p) => back > 0 || Temporal.PlainTime.compare(p.time, clock) <= 0)
      .map((p) => instantOf(date, p.time, now.timeZoneId))
      .findLast((instant) => instant !== undefined);
    startAt = started;
  }

  let nextAt: number | undefined;
  for (let ahead = 0; ahead <= LOOKAHEAD_DAYS && nextAt === undefined; ahead++) {
    const date = today.add({ days: ahead });
    const later = week[weekdayOf(date)]
      .map((p) => instantOf(date, p.time, now.timeZoneId))
      .filter((instant): instant is number => instant !== undefined && instant > nowMs);
    if (later.length > 0) nextAt = Math.min(...later);
  }
  return { temperature, startAt, nextAt };
}
