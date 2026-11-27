import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DAY_KEYS, EMPTY_READINGS } from "../settings.ts";
import { WEEKDAYS } from "../model.ts";
import { decodeDay } from "./sonoff-codec.ts";
import { TRVZB_BINDING as binding } from "./sonoff-trvzb.ts";
import type { ResolvedDay } from "../schedule.ts";

function fixture(name: string): Record<string, unknown> {
  const url = new URL(`../../test/fixtures/z2m/${name}`, import.meta.url);
  return (JSON.parse(readFileSync(url, "utf8")) as { payload: Record<string, unknown> }).payload;
}

const DAY: ResolvedDay = decodeDay("00:00/16 07:00/19.5") ?? [];

describe("TRVZB binding", () => {
  describe("decode", () => {
    describe("With the recorded TRVZB message from packages/core/test/fixtures/z2m", () => {
      const decoded = binding.decode(fixture("trvzb_state.json"));
      it("returns seven days, the sensor source and every reading", () => {
        for (const day of WEEKDAYS) expect(decoded.values[DAY_KEYS[day]]).toHaveLength(6);
        expect(decoded.values.sensor_source).toBe("external");
        expect(decoded.readings).toEqual({
          mode: "heat",
          setpoint: 17,
          localTemperature: 19.3,
          running: false,
          battery: 92,
          feedLost: false,
          editGroup: undefined,
        });
      });
    });
    describe("With the sensor select reading remote_source_offline", () => {
      it('sensor_source is "external" and feedLost is true', () => {
        const decoded = binding.decode({ temperature_sensor_select: "remote_source_offline" });
        expect(decoded.values.sensor_source).toBe("external");
        expect(decoded.readings.feedLost).toBe(true);
      });
    });
    describe("With the sensor select reading an option the binding does not know", () => {
      it("feedLost is false and sensor_source is null", () => {
        const decoded = binding.decode({ temperature_sensor_select: "something_new" });
        expect(decoded.readings.feedLost).toBe(false);
        expect(decoded.values.sensor_source).toBeNull();
      });
    });
    describe("With one day text that is malformed", () => {
      it("that day maps to null and the others decode", () => {
        const decoded = binding.decode({
          ...fixture("trvzb_state.json"),
          weekly_schedule_monday: "garbage",
        });
        expect(decoded.values.day_mon).toBeNull();
        expect(decoded.values.day_tue).toHaveLength(6);
      });
    });
    describe("With a payload missing the sensor select", () => {
      it("sensor_source is left out", () => {
        expect(Object.hasOwn(binding.decode({ battery: 5 }).values, "sensor_source")).toBe(false);
      });
    });
    describe("With a payload of wrong types everywhere", () => {
      it("returns without throwing; every present key maps to null", () => {
        const payload: Record<string, unknown> = { temperature_sensor_select: 5 };
        for (const d of [
          "monday",
          "tuesday",
          "wednesday",
          "thursday",
          "friday",
          "saturday",
          "sunday",
        ])
          payload[`weekly_schedule_${d}`] = { x: 1 };
        Object.assign(payload, {
          occupied_heating_setpoint: "hot",
          local_temperature: null,
          system_mode: 4,
          running_state: [],
          battery: "full",
        });
        const decoded = binding.decode(payload);
        expect(Object.keys(decoded.values)).toHaveLength(10);
        expect(Object.values(decoded.values).every((v) => v === null)).toBe(true);
        expect(decoded.readings).toEqual(EMPTY_READINGS);
      });
    });
    describe("With a payload carrying last_seen", () => {
      it("last_seen appears nowhere in the result", () => {
        const decoded = binding.decode(fixture("trvzb_state.json"));
        expect(JSON.stringify(decoded)).not.toContain("last_seen");
        expect(JSON.stringify(decoded)).not.toContain("2026-11-15T20:01:14");
      });
    });
  });
  describe("encode", () => {
    describe("With two days", () => {
      it("returns exactly those two day keys, each a 6-entry text", () => {
        const message = binding.encode({ day_mon: DAY, day_sun: DAY });
        expect(Object.keys(message).sort()).toEqual([
          "weekly_schedule_monday",
          "weekly_schedule_sunday",
        ]);
        for (const text of Object.values(message)) expect(String(text).split(" ")).toHaveLength(6);
      });
    });
    describe('With sensor_source "external"', () => {
      it("returns the select key with the external option", () => {
        expect(binding.encode({ sensor_source: "external" })).toEqual({
          temperature_sensor_select: "remote_temperature",
        });
      });
    });
  });
  describe("encode, bad input", () => {
    describe("With an unknown sensor source", () => {
      it("throws RangeError", () => {
        expect(() => binding.encode({ sensor_source: "bogus" as "internal" })).toThrow(RangeError);
      });
    });
    describe("With active_group, which the TRVZB does not have", () => {
      it("throws RangeError", () => {
        expect(() => binding.encode({ active_group: 3 })).toThrow(RangeError);
      });
    });
  });
  describe("encodeTemperature", () => {
    describe("With 19.6", () => {
      it("returns the external temperature key with 19.6", () => {
        expect(binding.encodeTemperature(19.6)).toEqual({ external_temperature_input: 19.6 });
      });
    });
  });
  describe("encodeSetpoint", () => {
    describe("With 20.5", () => {
      it("returns the setpoint key with 20.5", () => {
        expect(binding.encodeSetpoint(20.5)).toEqual({ occupied_heating_setpoint: 20.5 });
      });
    });
  });
  describe("encodeRefresh", () => {
    describe("Always", () => {
      it("returns the sensor select key and the thermostat and frost keys, each with an empty text", () => {
        expect(binding.encodeRefresh()).toEqual({
          temperature_sensor_select: "",
          system_mode: "",
          occupied_heating_setpoint: "",
          frost_protection_temperature: "",
          open_window: "",
        });
      });
    });
  });
});
