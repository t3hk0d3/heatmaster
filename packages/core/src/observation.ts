import { EMPTY_READINGS, mergeReadings } from "./settings.ts";
import type { Readings, SettingKey, SettingValue, SettingValues } from "./settings.ts";

/** A valve unheard for this long is silent. */
export const VALVE_SILENT_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * - `heardAt`: when the device itself last spoke, on the server's clock.
 * - `messageAt`: when the latest message about it arrived since start; `undefined` until the first.
 * - `since`: the start, or the last time the link came back.
 */
export type DeviceState = Readonly<{
  values: SettingValues;
  readings: Readings;
  lifeToken: string | undefined;
  heardAt: number | undefined;
  messageAt: number | undefined;
  since: number;
}>;

/**
 * What a binding makes of one message. A key mapped to `null` was present but unreadable; a key
 * that is absent was not in the message.
 */
export type Decoded = Readonly<{
  values: Readonly<Partial<Record<SettingKey, SettingValue | null>>>;
  readings: Readings;
}>;

export type Liveness = "unknown" | "live" | "silent";

export function newState(nowMs: number): DeviceState {
  return {
    values: {},
    readings: EMPTY_READINGS,
    lifeToken: undefined,
    heardAt: undefined,
    messageAt: undefined,
    since: nowMs,
  };
}

function mergeValues(old: SettingValues, fresh: Decoded["values"]): SettingValues {
  const values: Partial<Record<SettingKey, SettingValue>> = {};
  const keys = new Set([...Object.keys(old), ...Object.keys(fresh)]) as Set<SettingKey>;
  for (const key of keys) {
    // A key holding undefined counts as absent; null removes the stored value.
    const given = Object.hasOwn(fresh, key) ? fresh[key] : undefined;
    const value = given === undefined ? old[key] : given;
    if (value !== null && value !== undefined) values[key] = value;
  }
  return values;
}

/**
 * A message counts as heard when its token is set and differs from a stored one; the first token
 * after a start or a link coming back is only stored.
 */
export function countsAsHeard(state: DeviceState, lifeToken: string | undefined): boolean {
  return lifeToken !== undefined && state.lifeToken !== undefined && lifeToken !== state.lifeToken;
}

/**
 * Merges one message. The device is heard when the token is set and differs from a stored one;
 * the first token after a start or a link coming back is only stored. The flag is true when the
 * device was silent before the message and is heard now.
 */
export function onMessage(
  state: DeviceState,
  decoded: Decoded,
  lifeToken: string | undefined,
  nowMs: number,
  silentAfterMs: number,
): readonly [DeviceState, boolean] {
  const wasSilent = liveness(state, nowMs, silentAfterMs) === "silent";
  const heard = countsAsHeard(state, lifeToken);
  const next: DeviceState = {
    values: mergeValues(state.values, decoded.values),
    readings: mergeReadings(state.readings, decoded.readings),
    lifeToken: lifeToken ?? state.lifeToken,
    heardAt: heard ? nowMs : state.heardAt,
    messageAt: nowMs,
    since: state.since,
  };
  return [next, wasSilent && heard];
}

/** Forgets the token and `heardAt`; keeps values, readings and `messageAt`. */
export function onLinkUp(state: DeviceState, nowMs: number): DeviceState {
  return { ...state, lifeToken: undefined, heardAt: undefined, since: nowMs };
}

/** Silent past `silentAfterMs` since the device was heard (or since `since`); else live or unknown. */
export function liveness(state: DeviceState, nowMs: number, silentAfterMs: number): Liveness {
  const last = state.heardAt ?? state.since;
  if (nowMs - last > silentAfterMs) return "silent";
  return state.heardAt === undefined ? "unknown" : "live";
}
