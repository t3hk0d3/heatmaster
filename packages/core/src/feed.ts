import { since, type RoomMemory, type ValveMemory } from "./memory.ts";
import { roundHalfUp } from "./rounding.ts";
import type { SensorSource } from "./settings.ts";
import type { Freshness } from "./temperature.ts";

const MINUTE_MS = 60 * 1000;

/** A change of this many °C or more is pushed once the interval has passed. */
export const THRESHOLD = 0.2;
/** A fed valve is pushed at least this often. */
export const HEARTBEAT_MS = 30 * MINUTE_MS;
/** How long a room must stay fresh before the valve is switched back to the external sensor. */
export const RETURN_HOLD_MS = 10 * MINUTE_MS;
/** A fed valve that reports its feed lost for this long has a problem. */
export const FEED_LOST_AFTER_MS = 60 * MINUTE_MS;

function tenths(celsius: number): number {
  return Math.round(roundHalfUp(celsius, 0.1) * 10);
}

export function pushDue(
  vm: ValveMemory,
  temperature: number,
  intervalMs: number,
  nowMs: number,
): boolean {
  if (vm.feedAt === undefined) {
    return (
      vm.lastPushAt === undefined ||
      since(vm.lastPushAt, nowMs) >= Math.min(intervalMs, HEARTBEAT_MS)
    );
  }
  const elapsed = since(vm.feedAt, nowMs);
  const changed =
    vm.feedValue !== undefined &&
    Math.abs(tenths(temperature) - tenths(vm.feedValue)) >= tenths(THRESHOLD);
  return (changed && elapsed >= intervalMs) || elapsed >= HEARTBEAT_MS;
}

export function pushed(vm: ValveMemory, temperature: number, nowMs: number): ValveMemory {
  return { ...vm, feedValue: temperature, feedAt: nowMs, lastPushAt: nowMs };
}

/** Forgets the last pushed value and that the valve is fed; keeps `lastPushAt`. */
export function stopped(vm: ValveMemory): ValveMemory {
  return { ...vm, feedValue: undefined, feedAt: undefined };
}

/** `freshSince` is set when the room becomes fresh and cleared when it is anything else. */
export function trackRoom(rm: RoomMemory, freshness: Freshness, nowMs: number): RoomMemory {
  if (freshness !== "fresh") return { freshSince: undefined };
  return rm.freshSince === undefined ? { freshSince: nowMs } : rm;
}

/** The sensor source the valve should use, or `undefined` for "leave it alone". */
export function wantedSource(
  freshness: Freshness,
  rm: RoomMemory,
  vm: ValveMemory,
  nowMs: number,
): SensorSource | undefined {
  if (freshness === "stale" || freshness === "no_sensors") return "internal";
  if (
    freshness === "fresh" &&
    rm.freshSince !== undefined &&
    since(rm.freshSince, nowMs) >= RETURN_HOLD_MS &&
    vm.feedAt !== undefined
  ) {
    return "external";
  }
  return undefined;
}
