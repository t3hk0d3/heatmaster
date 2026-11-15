import { WEEKDAYS } from "../model.ts";
import { DAY_KEYS } from "../settings.ts";
import {
  Z2M_DAY_PAYLOAD,
  Z2M_KEYS,
  decodeCommon,
  encodeDay,
  selectOption,
} from "./sonoff-codec.ts";
import type { Binding, Profile } from "./base.ts";
import type { GroupSpec, ValveSpec } from "../settings.ts";

const HOUR_MS = 60 * 60 * 1000;

function group(spec: Pick<GroupSpec, "group" | "evidence" | "capture" | "readable">): GroupSpec {
  return { ...spec, maxAgeMs: 24 * HOUR_MS };
}

/** Sonoff TRVZB: one schedule of 6 slots, whose days cannot be read back; an external sensor. */
export const TRVZB_SPEC: ValveSpec = {
  profile: "sonoff_trvzb",
  minTemp: 4,
  maxTemp: 35,
  tempStep: 0.5,
  maxSetPoints: 6,
  slotCount: 6,
  scheduleGroup: undefined,
  groups: [
    group({ group: "schedule", evidence: "echoed", capture: false, readable: false }),
    group({ group: "sensor_source", evidence: "acked", capture: true, readable: true }),
  ],
  activation: "none",
  externalSensor: true,
  feedWhenOff: false,
};

export const TRVZB_BINDING: Binding = {
  decode(payload) {
    return decodeCommon(payload, true);
  },
  encode(values) {
    const message: Record<string, unknown> = {};
    for (const day of WEEKDAYS) {
      const value = values[DAY_KEYS[day]];
      if (Array.isArray(value))
        message[Z2M_DAY_PAYLOAD[day]] = encodeDay(value, TRVZB_SPEC.slotCount);
    }
    if (values.sensor_source !== undefined)
      message[Z2M_KEYS.select] = selectOption(values.sensor_source as "internal" | "external");
    return message;
  },
  encodeSetpoint: (celsius) => ({ [Z2M_KEYS.setpoint]: celsius }),
  encodeTemperature: (celsius) => ({ [Z2M_KEYS.external]: celsius }),
  encodeRefresh: () => ({ [Z2M_KEYS.select]: "" }),
};

export const SONOFF_TRVZB: Profile = {
  key: "sonoff_trvzb",
  modelIds: ["TRVZB"],
  specs: { z2m: TRVZB_SPEC },
  bindings: { z2m: TRVZB_BINDING },
};
