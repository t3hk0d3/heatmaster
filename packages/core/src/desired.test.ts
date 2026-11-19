import { describe, expect, it } from "vitest";
import { points } from "../test/builders.ts";
import { differing, fitted, managedDesired, releaseDesired, type Desired } from "./desired.ts";
import { WEEKDAYS } from "./model.ts";
import { newState, type DeviceState } from "./observation.ts";
import {
  DAY_KEYS,
  type GroupSpec,
  type SettingKey,
  type SettingValues,
  type ValveSpec,
} from "./settings.ts";
import type { ValveRecord } from "./ledger.ts";
import type { Weekday } from "./model.ts";
import type { ResolvedDay, ResolvedWeek } from "./schedule.ts";

const T0 = Temporal.Instant.from("2026-11-14T09:30:00Z").epochMilliseconds;
const V1 = "z2m:0x00124b0012345678";

function group(name: GroupSpec["group"], over: Partial<GroupSpec> = {}): GroupSpec {
  return {
    group: name,
    evidence: "acked",
    maxAgeMs: undefined,
    capture: false,
    readable: true,
    atomic: false,
    ...over,
  };
}

/** A TRVZB-like spec: 4–35 in 0.5 steps, one schedule, an external sensor. */
const TRVZB: ValveSpec = {
  profile: "sonoff_trvzb",
  minTemp: 4,
  maxTemp: 35,
  frostMinTemp: 4,
  frostMaxTemp: 35,
  tempStep: 0.5,
  maxSetPoints: 6,
  slotCount: 6,
  scheduleGroup: undefined,
  groups: [
    group("schedule"),
    group("sensor_source", { capture: true }),
    group("frost_protection", { capture: true }),
    group("thermostat", { capture: true, atomic: true }),
  ],
  activation: "none",
  externalSensor: true,
  feedWhenOff: false,
};

/** A TRV-ZBT-like spec: 5–30 in 0.5 steps, schedule group 3. */
const TRV_ZBT: ValveSpec = {
  ...TRVZB,
  profile: "sonoff_trv_zbt",
  minTemp: 5,
  maxTemp: 30,
  frostMinTemp: 5,
  frostMaxTemp: 15,
  scheduleGroup: 3,
  groups: [
    group("schedule", { evidence: "none", readable: false }),
    group("active_group", { capture: true }),
    group("sensor_source", { capture: true }),
    group("frost_protection", { capture: true }),
    group("thermostat", { capture: true, atomic: true }),
  ],
};

/** No sensor_source group, never fed. */
const NO_SOURCE: ValveSpec = {
  ...TRVZB,
  groups: [group("schedule")],
  externalSensor: false,
};

const DAY = points("00:00/18 06:30/21 22:00/18");

function weekOf(day: ResolvedDay, over: Partial<Record<Weekday, ResolvedDay>> = {}): ResolvedWeek {
  return { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day, ...over };
}

const WEEK = weekOf(DAY, { sat: points("00:00/18"), sun: points("00:00/18") });

function stateWith(values: SettingValues): DeviceState {
  return { ...newState(T0), values };
}

/** Every day of the week as observed values. */
function daysOf(week: ResolvedWeek): SettingValues {
  const values: Partial<Record<SettingKey, ResolvedDay>> = {};
  for (const d of WEEKDAYS) values[DAY_KEYS[d]] = week[d];
  return values;
}

function record(originals: ValveRecord["originals"]): ValveRecord {
  return { valveId: V1, profile: "sonoff_trvzb", adoptedAt: T0, originals };
}

describe("desired", () => {
  describe("fitted", () => {
    describe("With a TRV-ZBT spec (5–30 in 0.5 steps) and a week holding 4 and 35", () => {
      it("the days hold 5 and 30 and clamped is true", () => {
        const result = fitted(weekOf(points("00:00/4 08:00/35")), TRV_ZBT);
        for (const d of WEEKDAYS) expect(result.days[d]).toEqual(points("00:00/5 08:00/30"));
        expect(result.clamped).toBe(true);
      });
    });
  });

  describe("managedDesired (scheduleTrusted is true unless a scenario says otherwise)", () => {
    describe("With a room week and a TRVZB spec", () => {
      const desired = managedDesired(TRVZB, WEEK, stateWith(daysOf(WEEK)), undefined, true);
      it("the seven day keys hold the fitted week with reason schedule", () => {
        for (const d of WEEKDAYS)
          expect(desired[DAY_KEYS[d]]).toEqual({ value: WEEK[d], reason: "schedule" });
      });
      it("active_group is absent", () => {
        expect(desired.active_group).toBeUndefined();
      });
    });

    describe("With a week above the valve's maximum", () => {
      it("the days are clamped to the maximum", () => {
        const desired = managedDesired(
          TRV_ZBT,
          weekOf(points("00:00/18 07:00/33")),
          undefined,
          undefined,
          true,
        );
        for (const d of WEEKDAYS)
          expect(desired[DAY_KEYS[d]]?.value).toEqual(points("00:00/18 07:00/30"));
      });
    });

    describe("With a TRV-ZBT spec and scheduleTrusted true, whatever days the state holds", () => {
      it("active_group is 3 with reason group_ready", () => {
        const states = [
          stateWith({}),
          stateWith({ ...daysOf(WEEK), day_sun: points("00:00/17") }),
          stateWith(daysOf(WEEK)),
        ];
        for (const state of states) {
          const desired = managedDesired(TRV_ZBT, WEEK, state, undefined, true);
          expect(desired.active_group).toEqual({ value: 3, reason: "group_ready" });
        }
      });
    });

    describe("With a TRV-ZBT spec and scheduleTrusted false", () => {
      it("active_group is absent", () => {
        const desired = managedDesired(TRV_ZBT, WEEK, stateWith(daysOf(WEEK)), undefined, false);
        expect(desired.active_group).toBeUndefined();
      });
    });

    describe("With source external", () => {
      it("sensor_source is external with reason room_temperature", () => {
        const desired = managedDesired(TRVZB, WEEK, undefined, "external", true);
        expect(desired.sensor_source).toEqual({ value: "external", reason: "room_temperature" });
      });
    });

    describe("With source internal", () => {
      it("sensor_source is internal with reason no_room_temperature", () => {
        const desired = managedDesired(TRVZB, WEEK, undefined, "internal", true);
        expect(desired.sensor_source).toEqual({
          value: "internal",
          reason: "no_room_temperature",
        });
      });
    });

    describe("With source undefined", () => {
      it("sensor_source is absent", () => {
        const desired = managedDesired(TRVZB, WEEK, undefined, undefined, true);
        expect(desired.sensor_source).toBeUndefined();
      });
    });

    describe("With a spec that has no sensor_source group and source external", () => {
      it("sensor_source is absent", () => {
        const desired = managedDesired(NO_SOURCE, WEEK, undefined, "external", true);
        expect(desired.sensor_source).toBeUndefined();
      });
    });

    describe("With state undefined", () => {
      const desired = managedDesired(TRV_ZBT, WEEK, undefined, undefined, true);
      it("the day keys are still present", () => {
        for (const d of WEEKDAYS) expect(desired[DAY_KEYS[d]]?.value).toEqual(WEEK[d]);
      });
      it("active_group is absent", () => {
        expect(desired.active_group).toBeUndefined();
      });
    });
  });

  describe("releaseDesired", () => {
    describe("With a TRVZB record holding a sensor source", () => {
      it("sensor_source is present with reason release and no other key is", () => {
        const desired = releaseDesired(
          TRVZB,
          record({ sensor_source: "internal", active_group: 1 }),
        );
        expect(desired).toEqual({ sensor_source: { value: "internal", reason: "release" } });
      });
    });

    describe("With a TRV-ZBT record holding an active group and a sensor source", () => {
      it("active_group and sensor_source are present and the day keys are absent", () => {
        const desired = releaseDesired(
          TRV_ZBT,
          record({ active_group: 1, sensor_source: "internal" }),
        );
        expect(desired).toEqual({
          active_group: { value: 1, reason: "release" },
          sensor_source: { value: "internal", reason: "release" },
        });
      });
    });

    describe("With an original that is null", () => {
      it("that key is absent", () => {
        const desired = releaseDesired(
          TRV_ZBT,
          record({ active_group: null, sensor_source: "internal" }),
        );
        expect(Object.hasOwn(desired, "active_group")).toBe(false);
      });
    });

    describe("With a record that holds a day key", () => {
      it("the day key is absent", () => {
        const capturing: ValveSpec = {
          ...TRVZB,
          groups: [group("schedule", { capture: true }), group("sensor_source", { capture: true })],
        };
        const desired = releaseDesired(
          capturing,
          record({ day_mon: DAY, sensor_source: "internal" }),
        );
        expect(Object.hasOwn(desired, "day_mon")).toBe(false);
      });
    });

    describe("With a record whose originals are empty", () => {
      it("returns an empty Desired", () => {
        expect(releaseDesired(TRV_ZBT, record({}))).toEqual({});
      });
    });

    describe("For a record with system_mode heat and setpoint 17", () => {
      it("desires system_mode heat and setpoint 17 with reason release", () => {
        const desired = releaseDesired(TRVZB, record({ system_mode: "heat", setpoint: 17 }));
        expect(desired).toEqual({
          system_mode: { value: "heat", reason: "release" },
          setpoint: { value: 17, reason: "release" },
        });
      });
    });

    describe("For a record with system_mode auto and setpoint 17", () => {
      it("desires system_mode auto and no setpoint", () => {
        const desired = releaseDesired(TRVZB, record({ system_mode: "auto", setpoint: 17 }));
        expect(desired).toEqual({ system_mode: { value: "auto", reason: "release" } });
      });
    });

    describe("For a record with system_mode off and setpoint 17", () => {
      it("desires system_mode off and no setpoint", () => {
        const desired = releaseDesired(TRV_ZBT, record({ system_mode: "off", setpoint: 17 }));
        expect(desired).toEqual({ system_mode: { value: "off", reason: "release" } });
      });
    });

    describe("For a record made before 3a (no such originals)", () => {
      it("desires neither system_mode, setpoint nor frost_protection", () => {
        const desired = releaseDesired(TRVZB, record({ sensor_source: "internal" }));
        for (const key of ["system_mode", "setpoint", "frost_protection"])
          expect(Object.hasOwn(desired, key)).toBe(false);
      });
    });
  });

  describe("differing", () => {
    const sourceDesired: Desired = {
      sensor_source: { value: "external", reason: "room_temperature" },
    };

    describe("With a day observed with extra repeats", () => {
      it("the day is not listed", () => {
        const desired: Desired = { day_mon: { value: DAY, reason: "schedule" } };
        const state = stateWith({ day_mon: points("00:00/18 03:00/18 06:30/21 22:00/18") });
        expect(differing(desired, state)).toEqual([]);
      });
    });

    describe("With a sensor source observed different from the desired one", () => {
      it("sensor_source is listed", () => {
        const state = stateWith({ sensor_source: "internal" });
        expect(differing(sourceDesired, state)).toEqual(["sensor_source"]);
      });
    });

    describe("With a key that is not observed", () => {
      it("the key is listed", () => {
        expect(differing(sourceDesired, stateWith({}))).toEqual(["sensor_source"]);
      });
    });

    describe("With state undefined", () => {
      it("every desired key is listed", () => {
        const desired = managedDesired(TRVZB, WEEK, undefined, "external", true);
        expect(differing(desired, undefined)).toEqual([
          "day_mon",
          "day_tue",
          "day_wed",
          "day_thu",
          "day_fri",
          "day_sat",
          "day_sun",
          "sensor_source",
        ]);
      });
    });

    describe("With two days, active_group and sensor_source all differing", () => {
      it("they are listed as the days in weekday order, then active_group, then sensor_source", () => {
        const desired: Desired = {
          sensor_source: { value: "external", reason: "room_temperature" },
          active_group: { value: 3, reason: "group_ready" },
          day_sun: { value: DAY, reason: "schedule" },
          day_tue: { value: DAY, reason: "schedule" },
          day_mon: { value: DAY, reason: "schedule" },
        };
        const state = stateWith({
          day_mon: DAY,
          day_tue: points("00:00/17"),
          day_sun: points("00:00/17"),
          active_group: 1,
          sensor_source: "internal",
        });
        expect(differing(desired, state)).toEqual([
          "day_tue",
          "day_sun",
          "active_group",
          "sensor_source",
        ]);
      });
    });

    describe("With an empty Desired", () => {
      it("returns nothing", () => {
        expect(differing({}, undefined)).toEqual([]);
      });
    });
  });
});
