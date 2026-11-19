import { WEEKDAYS } from "../model.ts";
import { DAY_KEYS } from "../settings.ts";
import {
  Z2M_DAY_PAYLOAD,
  Z2M_KEYS,
  THERMOSTAT_REFRESH,
  decodeCommon,
  checkGroup,
  encodeDay,
  encodeThermostat,
  groupSpec,
  parseGroup,
  selectOption,
} from "./sonoff-codec.ts";
import { commonMatch, wantedFor } from "../thermostat-adapter.ts";
import type { Binding, Profile } from "./base.ts";
import type { ValveSpec } from "../settings.ts";
import type { ThermostatSeen, ThermostatWanted } from "../thermostat.ts";
import type { AdapterContext, ThermostatAdapter } from "../thermostat-adapter.ts";

/** The schedule group Heatmaster owns. Groups 1 and 2 are never written. */
const OWNED_GROUP = 3;

function holds(values: ReadonlySet<number> | undefined, setpoint: number | undefined): boolean {
  return values !== undefined && setpoint !== undefined && values.has(setpoint);
}

/**
 * In `auto` a scheduled state accepts its own setpoint or any value of its week (the valve takes
 * its points by itself, early or late), and anything while the week is unknown; any other state
 * accepts only its own setpoint.
 */
function zbtMatches(
  expected: ThermostatWanted,
  seen: ThermostatSeen,
  ctx: AdapterContext,
): boolean {
  const common = commonMatch(expected, seen);
  if (common !== undefined) return common;
  if (seen.setpoint === expected.setpoint) return true;
  if (!expected.scheduled) return false;
  return ctx.weekValues === undefined || holds(ctx.weekValues, seen.setpoint);
}

/**
 * The TRV-ZBT keeps a setpoint held in `auto` until its next point (M1), so on its schedule it is
 * wanted in `auto` with the value in force (R18), or `auto` alone while its week is unconfirmed.
 * A state that is not scheduled (adopted from a person) also explains a point the valve took at
 * about the report's time.
 */
export const TRV_ZBT_THERMOSTAT: ThermostatAdapter = {
  wanted: (thermostat, ctx) =>
    wantedFor(thermostat, { mode: "auto", setpoint: ctx.inForce, scheduled: true }),
  matches: zbtMatches,
  explains: (expected, seen, ctx) =>
    zbtMatches(expected, seen, ctx) ||
    (commonMatch(expected, seen) === undefined &&
      !expected.scheduled &&
      holds(ctx.pointValues, seen.setpoint)),
};

/**
 * Sonoff TRV-ZBT: three schedule groups of 12 slots, of which Heatmaster owns the third. Its days
 * are write-only: Zigbee2MQTT shows the previous edit group's cached days in messages that already
 * name the new group, so nothing a message shows about days can be trusted.
 */
export const TRV_ZBT_SPEC: ValveSpec = {
  profile: "sonoff_trv_zbt",
  minTemp: 5,
  maxTemp: 30,
  frostMinTemp: 5,
  frostMaxTemp: 15,
  tempStep: 0.5,
  maxSetPoints: 6,
  slotCount: 12,
  scheduleGroup: OWNED_GROUP,
  groups: [
    groupSpec({ group: "schedule", evidence: "none", capture: false, readable: false }),
    groupSpec({ group: "active_group", evidence: "acked", capture: true, readable: true }),
    groupSpec({ group: "sensor_source", evidence: "acked", capture: true, readable: true }),
    groupSpec({ group: "frost_protection", evidence: "acked", capture: true, readable: true }),
    groupSpec({ group: "thermostat", evidence: "acked", capture: true, readable: true }),
  ],
  activation: "none",
  externalSensor: true,
  feedWhenOff: false,
  thermostat: TRV_ZBT_THERMOSTAT,
};

export const TRV_ZBT_BINDING: Binding = {
  // Day keys are never decoded; the edit group is kept for diagnostics only.
  decode(payload) {
    const decoded = decodeCommon(payload, false);
    if (Object.hasOwn(payload, Z2M_KEYS.activeGroup))
      decoded.values.active_group = parseGroup(payload[Z2M_KEYS.activeGroup]) ?? null;
    return decoded;
  },
  encode(values) {
    const days: Record<string, unknown> = {};
    for (const day of WEEKDAYS) {
      const value = values[DAY_KEYS[day]];
      if (Array.isArray(value))
        days[Z2M_DAY_PAYLOAD[day]] = encodeDay(value, TRV_ZBT_SPEC.slotCount);
    }
    const message: Record<string, unknown> = {};
    // The edit group comes first: the valve applies keys in order.
    if (Object.keys(days).length > 0) message[Z2M_KEYS.editGroup] = String(OWNED_GROUP);
    Object.assign(message, days);
    if (values.active_group !== undefined)
      message[Z2M_KEYS.activeGroup] = String(checkGroup(values.active_group));
    if (values.sensor_source !== undefined)
      message[Z2M_KEYS.select] = selectOption(values.sensor_source);
    Object.assign(message, encodeThermostat(values));
    return message;
  },
  encodeSetpoint: (celsius) => ({ [Z2M_KEYS.setpoint]: celsius }),
  encodeTemperature: (celsius) => ({ [Z2M_KEYS.external]: celsius }),
  encodeRefresh: () => ({
    [Z2M_KEYS.activeGroup]: "",
    [Z2M_KEYS.select]: "",
    ...THERMOSTAT_REFRESH,
  }),
};

export const SONOFF_TRV_ZBT: Profile = {
  key: "sonoff_trv_zbt",
  modelIds: ["TRV-ZBT"],
  specs: { z2m: TRV_ZBT_SPEC },
  bindings: { z2m: TRV_ZBT_BINDING },
};
