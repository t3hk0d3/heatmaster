import { sensorId } from "./model.ts";
import type { SensorRef } from "./model.ts";

/** The lowest room temperature, in °C, that counts as a real reading. */
const MIN_VALID_C = -10;
/** The highest room temperature, in °C, that counts as a real reading. */
const MAX_VALID_C = 45;
/** A value this far below a half counts as the half (see the styleguide, Rounding). */
const HALF_TOLERANCE = 0.000000001;

/**
 * What is known about one sensor. `value` is in °C; `seenAt` is when the sensor was last known
 * alive, in epoch milliseconds; `pending` is true while Heatmaster cannot yet judge the sensor.
 */
export type SensorReading = Readonly<{
  sensorId: string;
  value: number | undefined;
  seenAt: number | undefined;
  pending: boolean;
}>;

/** Every configured sensor is in exactly one list, in the order the room lists its sensors. */
export type RoomTemperature = Readonly<{
  value: number | undefined;
  used: readonly string[];
  stale: readonly string[];
  invalid: readonly string[];
  pending: readonly string[];
}>;

export type Freshness = "fresh" | "pending" | "stale" | "no_sensors";

type Verdict = "used" | "stale" | "invalid" | "pending";

function judge(reading: SensorReading | undefined, nowMs: number, staleAfterMs: number): Verdict {
  if (reading === undefined) return "stale";
  const { value, seenAt, pending } = reading;
  const tooOld = seenAt !== undefined && nowMs - seenAt > staleAfterMs;
  if (pending) {
    if (value === undefined) return "pending";
    if (tooOld) return "pending";
  } else {
    if (value === undefined || seenAt === undefined) return "stale";
    if (tooOld) return "stale";
  }
  if (!Number.isFinite(value) || value < MIN_VALID_C || value > MAX_VALID_C) return "invalid";
  return "used";
}

/** Rounds half up to 0.1. */
function roundTenth(value: number): number {
  return Math.floor(value * 10 + 0.5 + HALF_TOLERANCE) / 10 + 0;
}

export function aggregate(
  sensors: readonly SensorRef[],
  readings: ReadonlyMap<string, SensorReading>,
  nowMs: number,
  staleAfterMs: number,
): RoomTemperature {
  const lists: Record<Verdict, string[]> = { used: [], stale: [], invalid: [], pending: [] };
  let weighted = 0;
  let totalWeight = 0;
  for (const sensor of sensors) {
    const id = sensorId(sensor);
    const reading = readings.get(id);
    const verdict = judge(reading, nowMs, staleAfterMs);
    lists[verdict].push(id);
    if (verdict === "used" && reading?.value !== undefined) {
      weighted += sensor.weight * reading.value;
      totalWeight += sensor.weight;
    }
  }
  const value =
    lists.used.length === 0 || totalWeight <= 0 ? undefined : roundTenth(weighted / totalWeight);
  return { value, ...lists };
}

export function freshness(sensors: readonly SensorRef[], temperature: RoomTemperature): Freshness {
  if (sensors.length === 0) return "no_sensors";
  if (temperature.value !== undefined) return "fresh";
  return temperature.pending.length > 0 ? "pending" : "stale";
}
