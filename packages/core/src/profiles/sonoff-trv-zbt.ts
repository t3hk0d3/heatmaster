import { WEEKDAYS } from "../model.ts";
import { DAY_KEYS } from "../settings.ts";
import {
  Z2M_DAY_PAYLOAD,
  Z2M_KEYS,
  decodeCommon,
  encodeDay,
  parseGroup,
  selectOption,
} from "./sonoff-codec.ts";
import type { Binding, Profile } from "./base.ts";
import type { GroupSpec, ValveSpec } from "../settings.ts";

const HOUR_MS = 60 * 60 * 1000;
/** The schedule group Heatmaster owns. Groups 1 and 2 are never written. */
const OWNED_GROUP = 3;

function group(spec: Pick<GroupSpec, "group" | "evidence" | "capture" | "readable">): GroupSpec {
  return { ...spec, maxAgeMs: 24 * HOUR_MS };
}

/**
 * Sonoff TRV-ZBT: three schedule groups of 12 slots, of which Heatmaster owns the third. Its days
 * are write-only: Zigbee2MQTT shows the previous edit group's cached days in messages that already
 * name the new group, so nothing a message shows about days can be trusted.
 */
export const TRV_ZBT_SPEC: ValveSpec = {
  profile: "sonoff_trv_zbt",
  minTemp: 5,
  maxTemp: 30,
  tempStep: 0.5,
  maxSetPoints: 6,
  slotCount: 12,
  scheduleGroup: OWNED_GROUP,
  groups: [
    group({ group: "schedule", evidence: "none", capture: false, readable: false }),
    group({ group: "active_group", evidence: "acked", capture: true, readable: true }),
    group({ group: "sensor_source", evidence: "acked", capture: true, readable: true }),
  ],
  activation: "none",
  externalSensor: true,
  feedWhenOff: false,
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
    if (typeof values.active_group === "number")
      message[Z2M_KEYS.activeGroup] = String(values.active_group);
    if (values.sensor_source !== undefined)
      message[Z2M_KEYS.select] = selectOption(values.sensor_source as "internal" | "external");
    return message;
  },
  encodeSetpoint: (celsius) => ({ [Z2M_KEYS.setpoint]: celsius }),
  encodeTemperature: (celsius) => ({ [Z2M_KEYS.external]: celsius }),
  encodeRefresh: () => ({ [Z2M_KEYS.activeGroup]: "", [Z2M_KEYS.select]: "" }),
};

export const SONOFF_TRV_ZBT: Profile = {
  key: "sonoff_trv_zbt",
  modelIds: ["TRV-ZBT"],
  specs: { z2m: TRV_ZBT_SPEC },
  bindings: { z2m: TRV_ZBT_BINDING },
};
