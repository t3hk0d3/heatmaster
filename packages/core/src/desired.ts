import { WEEKDAYS } from "./model.ts";
import { fitWeek } from "./schedule.ts";
import { DAY_KEYS, SETTING_KEYS, members, valuesEqual } from "./settings.ts";
import type { ValveRecord } from "./ledger.ts";
import type { DeviceState } from "./observation.ts";
import type { FittedWeek, ResolvedWeek } from "./schedule.ts";
import type { Group, SensorSource, SettingKey, SettingValue, ValveSpec } from "./settings.ts";

export type Reason =
  "schedule" | "group_ready" | "room_temperature" | "no_room_temperature" | "release";

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

/** The captured originals to restore. The schedule is never restored. */
export function releaseDesired(spec: ValveSpec, record: ValveRecord): Desired {
  const desired: Partial<Record<SettingKey, DesiredValue>> = {};
  for (const groupSpec of spec.groups) {
    if (!groupSpec.capture || groupSpec.group === "schedule") continue;
    for (const key of members(groupSpec.group)) {
      const original = record.originals[key];
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
