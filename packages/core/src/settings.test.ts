import { describe, expect, it } from "vitest";
import { points } from "../test/builders.ts";
import { WEEKDAYS } from "./model.ts";
import {
  DAY_KEYS,
  EMPTY_READINGS,
  GROUPS,
  SETTING_KEYS,
  describeValue,
  groupOf,
  members,
  mergeReadings,
  valueKey,
  valuesEqual,
  type Readings,
} from "./settings.ts";

describe("settings", () => {
  describe("valuesEqual", () => {
    describe("With two days that differ only by repeats", () => {
      it("returns true", () => {
        const a = points("00:00/17 07:00/20 12:00/20 22:00/17");
        const b = points("00:00/17 07:00/20 22:00/17 23:00/17");
        expect(valuesEqual("day_mon", a, b)).toBe(true);
      });
    });
    describe("With two days differing in one temperature", () => {
      it("returns false", () => {
        const a = points("00:00/17 07:00/20 22:00/17");
        const b = points("00:00/17 07:00/20.5 22:00/17");
        expect(valuesEqual("day_tue", a, b)).toBe(false);
      });
    });
    describe("With two sensor sources or two group numbers", () => {
      it("compares them directly", () => {
        expect(valuesEqual("sensor_source", "internal", "internal")).toBe(true);
        expect(valuesEqual("sensor_source", "internal", "external")).toBe(false);
        expect(valuesEqual("active_group", 3, 3)).toBe(true);
        expect(valuesEqual("active_group", 1, 3)).toBe(false);
      });
    });
    describe('For system_mode "auto" and "auto"', () => {
      it("true", () => {
        expect(valuesEqual("system_mode", "auto", "auto")).toBe(true);
      });
    });
    describe("For setpoint 20 and 20.5", () => {
      it("false", () => {
        expect(valuesEqual("setpoint", 20, 20.5)).toBe(false);
      });
    });
    describe("With values of different kinds", () => {
      it("returns false and does not throw", () => {
        const day = points("00:00/17");
        expect(valuesEqual("day_mon", day, 17)).toBe(false);
        expect(valuesEqual("day_mon", 17, day)).toBe(false);
        expect(valuesEqual("active_group", 1, "internal")).toBe(false);
        expect(valuesEqual("sensor_source", "external", day)).toBe(false);
      });
    });
  });

  describe("valueKey", () => {
    describe("With two days that differ only by repeats", () => {
      it("returns the same text", () => {
        const a = points("00:00/17 07:00/20 12:00/20");
        const b = points("00:00/17 07:00/20");
        expect(valueKey("day_wed", a)).toBe(valueKey("day_wed", b));
      });
    });
    describe("With two different days", () => {
      it("returns different texts", () => {
        const a = points("00:00/17 07:00/20");
        const b = points("00:00/17 07:30/20");
        expect(valueKey("day_wed", a)).not.toBe(valueKey("day_wed", b));
      });
    });
    describe("With group numbers 1 and 3", () => {
      it("returns different texts", () => {
        expect(valueKey("active_group", 1)).not.toBe(valueKey("active_group", 3));
      });
    });
  });

  describe("describeValue", () => {
    describe("With a day of two points", () => {
      it('returns ["00:00/17", "07:00/20"]', () => {
        expect(describeValue("day_mon", points("00:00/17 07:00/20"))).toEqual([
          "00:00/17",
          "07:00/20",
        ]);
      });
    });
    describe("With a day holding 20.5", () => {
      it('writes "20.5"', () => {
        expect(describeValue("day_sun", points("00:00/20.5"))).toEqual(["00:00/20.5"]);
      });
    });
    describe("With a sensor source", () => {
      it('returns "internal" or "external"', () => {
        expect(describeValue("sensor_source", "internal")).toBe("internal");
        expect(describeValue("sensor_source", "external")).toBe("external");
      });
    });
    describe("With a group number", () => {
      it("returns the number", () => {
        expect(describeValue("active_group", 3)).toBe(3);
      });
    });
    describe("With null or undefined", () => {
      it("returns null", () => {
        expect(describeValue("sensor_source", null)).toBeNull();
        expect(describeValue("day_mon", undefined)).toBeNull();
      });
    });
  });

  describe("groupOf / members", () => {
    describe("Always", () => {
      it("every SettingKey belongs to exactly one Group", () => {
        for (const key of SETTING_KEYS) {
          const owners = GROUPS.filter((group) => members(group).includes(key));
          expect(owners).toEqual([groupOf(key)]);
        }
      });
      it("schedule has the seven day keys in weekday order", () => {
        expect(members("schedule")).toEqual([
          "day_mon",
          "day_tue",
          "day_wed",
          "day_thu",
          "day_fri",
          "day_sat",
          "day_sun",
        ]);
      });
      it("active_group and sensor_source each have one member", () => {
        expect(members("active_group")).toEqual(["active_group"]);
        expect(members("sensor_source")).toEqual(["sensor_source"]);
      });
      it("SETTING_KEYS and GROUPS are in write order", () => {
        expect(SETTING_KEYS.slice(7)).toEqual([
          "active_group",
          "sensor_source",
          "frost_protection",
          "system_mode",
          "setpoint",
        ]);
        expect(GROUPS).toEqual([
          "schedule",
          "active_group",
          "sensor_source",
          "frost_protection",
          "thermostat",
        ]);
      });
    });
    describe("For system_mode and setpoint", () => {
      it("the group is thermostat, members in the order system_mode, setpoint", () => {
        expect(groupOf("system_mode")).toBe("thermostat");
        expect(groupOf("setpoint")).toBe("thermostat");
        expect(members("thermostat")).toEqual(["system_mode", "setpoint"]);
      });
    });
    describe("For frost_protection", () => {
      it("the group is frost_protection", () => {
        expect(groupOf("frost_protection")).toBe("frost_protection");
        expect(members("frost_protection")).toEqual(["frost_protection"]);
      });
    });
  });

  describe("DAY_KEYS", () => {
    describe("Always", () => {
      it("maps every weekday to its day key", () => {
        expect(WEEKDAYS.map((d) => DAY_KEYS[d])).toEqual([
          "day_mon",
          "day_tue",
          "day_wed",
          "day_thu",
          "day_fri",
          "day_sat",
          "day_sun",
        ]);
      });
    });
  });

  describe("mergeReadings", () => {
    const old: Readings = {
      mode: "auto",
      setpoint: 19,
      localTemperature: 20.4,
      running: true,
      battery: 80,
      feedLost: false,
      editGroup: 3,
    };
    describe("With a new mode and no new setpoint", () => {
      it("takes the new mode and keeps the old setpoint", () => {
        const merged = mergeReadings(old, { ...EMPTY_READINGS, mode: "heat" });
        expect(merged.mode).toBe("heat");
        expect(merged.setpoint).toBe(19);
      });
    });
    describe("With EMPTY_READINGS as the new value", () => {
      it("returns the old readings", () => {
        expect(mergeReadings(old, EMPTY_READINGS)).toEqual(old);
      });
    });
  });
});
