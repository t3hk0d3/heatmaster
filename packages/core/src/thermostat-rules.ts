import { NEXT_CHANGE_LEAD_MS } from "./model.ts";
import type { Room } from "./model.ts";
import { roundHalfUp } from "./rounding.ts";
import { segmentAt } from "./schedule.ts";
import type { ResolvedWeek } from "./schedule.ts";
import type { ValveSpec } from "./settings.ts";
import type { EndChoice, RoomLimits, Thermostat, ThermostatWanted } from "./thermostat.ts";

/*
 * The room thermostat's rules that need nothing from the tick: its constants, limits, ends and
 * sameness. They live apart from its commands (`thermostat.ts`), which import `control.ts`, so the
 * tick and adoption can use them without an import cycle; `thermostat.ts` re-exports them.
 */

/** How many sent writes a valve expectation keeps, newest first. */
export const SENT_KEPT = 4;

/** A sent write is retired when a report heard this long after it neither matches nor shows it. */
export const SENT_RETIRE_MS = 60 * 1000;

/**
 * For this long after an override or off starts, its room's valves get no mode or setpoint (R6);
 * as long after a valve change dropped by an open window under `ignore` (W6).
 */
export const THERMOSTAT_SETTLE_MS = 10 * 1000;

/** Targets are rounded half up to this step, in °C. */
const TARGET_STEP = 0.5;

/** A room on its schedule. */
export const SCHEDULE: Thermostat = { kind: "schedule" };

/** The narrowest range of the specs: the largest `minTemp`, the smallest `maxTemp` (R12). */
export function roomLimits(specs: readonly ValveSpec[]): RoomLimits | undefined {
  if (specs.length === 0) return undefined;
  return {
    min: Math.max(...specs.map((spec) => spec.minTemp)),
    max: Math.min(...specs.map((spec) => spec.maxTemp)),
  };
}

/** Held inside the limits, then rounded half up to 0.5. */
export function clampTarget(celsius: number, limits: RoomLimits): number {
  return roundHalfUp(Math.min(Math.max(celsius, limits.min), limits.max), TARGET_STEP);
}

/**
 * When a change made at `now` ends: `next_change` at the first set point after
 * `now + NEXT_CHANGE_LEAD_MS` (R8; the timer when there is none), `timer` after the choice's or
 * the room's duration, `manual` never.
 */
export function endsAt(
  choice: EndChoice,
  room: Room,
  week: ResolvedWeek,
  now: Temporal.ZonedDateTime,
): number | undefined {
  const timer = now.epochMilliseconds + (choice.durationMs ?? room.overrideDurationMs);
  switch (choice.rule) {
    case "manual":
      return undefined;
    case "timer":
      return timer;
    case "next_change":
      return segmentAt(week, now.add({ milliseconds: NEXT_CHANGE_LEAD_MS })).nextAt ?? timer;
  }
}

/** The room's own end rule and duration. */
export function defaultEnd(room: Room): EndChoice {
  return { rule: room.overrideEnd, durationMs: room.overrideDurationMs };
}

/** The thermostat has an end and it is not after `nowMs`. */
export function ended(thermostat: Thermostat, nowMs: number): boolean {
  return (
    thermostat.kind !== "schedule" && thermostat.endsAt !== undefined && thermostat.endsAt <= nowMs
  );
}

/** Equal in kind, target, preset and rule (R21); `endsAt`, `origin` and `since` are ignored. */
export function sameThermostat(a: Thermostat, b: Thermostat): boolean {
  if (a.kind === "schedule" || b.kind === "schedule") return a.kind === b.kind;
  if (a.rule !== b.rule) return false;
  if (a.kind === "off" || b.kind === "off") return a.kind === b.kind;
  return a.target === b.target && a.preset === b.preset;
}

/** Equal in mode, setpoint and `scheduled`. */
export function sameWanted(a: ThermostatWanted, b: ThermostatWanted): boolean {
  return a.mode === b.mode && a.setpoint === b.setpoint && a.scheduled === b.scheduled;
}
