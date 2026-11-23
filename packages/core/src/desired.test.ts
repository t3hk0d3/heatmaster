import { describe, expect, it } from "vitest";
import { TRV_ZBT_THERMOSTAT } from "./profiles/sonoff-trv-zbt.ts";
import { TRVZB_THERMOSTAT } from "./profiles/sonoff-trvzb.ts";
import { points } from "../test/builders.ts";
import {
  differing,
  fitted,
  frostDesired,
  managedDesired,
  releaseDesired,
  savedPointValues,
  thermostatContext,
  thermostatDesired,
  thermostatWanted,
  weekKey,
  type Desired,
} from "./desired.ts";
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
import type { SavedWeek } from "./thermostat.ts";

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
  thermostat: TRVZB_THERMOSTAT,
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
  thermostat: TRV_ZBT_THERMOSTAT,
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

  describe("thermostatContext", () => {
    const AMS = "Europe/Amsterdam";
    /** Monday 2026-11-16 at the given wall-clock time in Amsterdam. */
    const at = (time: string): Temporal.ZonedDateTime =>
      Temporal.PlainDateTime.from(`2026-11-16T${time}`).toZonedDateTime(AMS);
    const NOON = at("12:00");
    /** 17 at night, 19 in the morning, 21 in the evening: 19 is in force at noon. */
    const WORK = weekOf(points("00:00/17 09:00/19 17:00/21 23:00/17"));
    const sorted = (values: ReadonlySet<number> | undefined): readonly number[] | undefined =>
      values === undefined ? undefined : [...values].sort((a, b) => a - b);

    describe("With a week whose value in force is 19 and whose temperatures are 17, 19 and 21", () => {
      const ctx = thermostatContext(TRVZB, WORK, undefined, WORK, undefined, NOON);
      it("inForce 19, weekValues 17, 19, 21", () => {
        expect(ctx.inForce).toBe(19);
        expect(sorted(ctx.weekValues)).toEqual([17, 19, 21]);
      });
    });
    describe("With a week temperature of 34 on a TRV-ZBT", () => {
      it("weekValues holds 30", () => {
        const hot = weekOf(points("00:00/17 09:00/34"));
        const ctx = thermostatContext(TRV_ZBT, hot, undefined, hot, undefined, NOON);
        expect(ctx.weekValues?.has(30)).toBe(true);
      });
    });
    describe("With no week", () => {
      it("inForce, weekValues and pointValues undefined", () => {
        const heardAt = NOON.epochMilliseconds;
        expect(thermostatContext(TRV_ZBT, undefined, undefined, WORK, heardAt, NOON)).toEqual({
          inForce: undefined,
          weekValues: undefined,
          pointValues: undefined,
        });
      });
    });
    describe("With 08:59 and a point at 09:00 (19 → 21)", () => {
      it("inForce 21", () => {
        const week = weekOf(points("00:00/19 09:00/21"));
        const now = at("08:59");
        expect(thermostatContext(TRV_ZBT, week, undefined, week, undefined, now).inForce).toBe(21);
      });
    });
    describe("With the week unconfirmed and the saved week's key equal to the desired week's", () => {
      const saved: SavedWeek = { key: weekKey(WORK), values: [17, 19, 21] };
      const ctx = thermostatContext(TRV_ZBT, undefined, saved, WORK, undefined, NOON);
      it("weekValues are the saved values, inForce undefined", () => {
        expect(sorted(ctx.weekValues)).toEqual([17, 19, 21]);
        expect(ctx.inForce).toBeUndefined();
      });
    });
    describe("With the week unconfirmed, the saved week's key equal to the desired week's, and heardAt 22:59:30 next to a point at 23:00 (21 → 17)", () => {
      it("pointValues 17, 21, taken from the saved week as from a confirmed one", () => {
        const saved: SavedWeek = { key: weekKey(WORK), values: [17, 19, 21] };
        const heardAt = at("22:59:30").epochMilliseconds;
        const ctx = thermostatContext(TRV_ZBT, undefined, saved, WORK, heardAt, NOON);
        expect(sorted(ctx.pointValues)).toEqual([17, 21]);
      });
    });
    describe("With the week unconfirmed and a different desired week", () => {
      it("weekValues undefined", () => {
        const saved: SavedWeek = { key: weekKey(WORK), values: [17, 19, 21] };
        const other = weekOf(points("00:00/16 07:00/21"));
        const ctx = thermostatContext(TRV_ZBT, undefined, saved, other, undefined, NOON);
        expect(ctx.weekValues).toBeUndefined();
      });
    });
    describe("With heardAt 06:59:30 and a point at 07:00 (17 → 21)", () => {
      it("pointValues 17, 21", () => {
        const week = weekOf(points("00:00/17 07:00/21 22:00/17"));
        const heardAt = at("06:59:30").epochMilliseconds;
        const ctx = thermostatContext(TRV_ZBT, week, undefined, week, heardAt, NOON);
        expect(sorted(ctx.pointValues)).toEqual([17, 21]);
      });
    });
  });

  describe("savedPointValues", () => {
    const AMS = "Europe/Amsterdam";
    const at = (time: string): number =>
      Temporal.PlainDateTime.from(`2026-11-16T${time}`).toZonedDateTime(AMS).epochMilliseconds;
    const saved = (day: ResolvedDay): SavedWeek => ({ key: weekKey(weekOf(day)), values: [] });
    const OLD = saved(points("00:00/17 06:30/20 22:00/17"));
    const NEW = saved(points("00:00/16 07:00/21 23:00/16"));
    const sorted = (values: ReadonlySet<number> | undefined): readonly number[] | undefined =>
      values === undefined ? undefined : [...values].sort((a, b) => a - b);

    describe("With a saved week and heardAt 06:29:30, next to its point at 06:30 (17 → 20)", () => {
      it("17 and 20", () => {
        expect(sorted(savedPointValues(TRV_ZBT, [OLD], at("06:29:30"), AMS))).toEqual([17, 20]);
      });
    });
    describe("With a saved week and heardAt 12:00, no point near", () => {
      it("its value in force, 20", () => {
        expect(sorted(savedPointValues(TRV_ZBT, [OLD], at("12:00:00"), AMS))).toEqual([20]);
      });
    });
    describe("With two saved weeks and heardAt 12:00", () => {
      it("the values in force of both", () => {
        expect(sorted(savedPointValues(TRV_ZBT, [OLD, NEW], at("12:00:00"), AMS))).toEqual([
          20, 21,
        ]);
      });
    });
    describe("With a saved week holding 34 on a TRV-ZBT", () => {
      it("30", () => {
        const hot = saved(points("00:00/34"));
        expect(sorted(savedPointValues(TRV_ZBT, [hot], at("12:00:00"), AMS))).toEqual([30]);
      });
    });
    describe("With no heardAt", () => {
      it("undefined", () => {
        expect(savedPointValues(TRV_ZBT, [OLD], undefined, AMS)).toBeUndefined();
      });
    });
    describe("With no saved week", () => {
      it("undefined", () => {
        expect(savedPointValues(TRV_ZBT, [], at("12:00:00"), AMS)).toBeUndefined();
      });
    });
    describe("With a saved key that is no week key", () => {
      it("it is skipped", () => {
        const odd: SavedWeek = { key: "not a week", values: [19] };
        expect(savedPointValues(TRV_ZBT, [odd], at("12:00:00"), AMS)).toBeUndefined();
        expect(sorted(savedPointValues(TRV_ZBT, [odd, OLD], at("12:00:00"), AMS))).toEqual([20]);
      });
    });
  });

  describe("thermostatWanted", () => {
    describe("For a target of 34 on a TRV-ZBT", () => {
      it("the setpoint is 30", () => {
        const override = {
          kind: "override",
          target: 34,
          preset: undefined,
          rule: "manual",
          endsAt: undefined,
          origin: { source: "api", valveId: undefined },
          since: T0,
        } as const;
        const ctx = { inForce: undefined, weekValues: undefined, pointValues: undefined };
        expect(thermostatWanted(TRV_ZBT, override, ctx).setpoint).toBe(30);
      });
    });
  });

  describe("thermostatDesired", () => {
    describe("With heat and 22", () => {
      it("system_mode heat and setpoint 22, reason thermostat", () => {
        expect(thermostatDesired({ mode: "heat", setpoint: 22, scheduled: false })).toEqual({
          system_mode: { value: "heat", reason: "thermostat" },
          setpoint: { value: 22, reason: "thermostat" },
        });
      });
    });
    describe("With auto and no setpoint", () => {
      it("system_mode auto only", () => {
        expect(thermostatDesired({ mode: "auto", setpoint: undefined, scheduled: true })).toEqual({
          system_mode: { value: "auto", reason: "thermostat" },
        });
      });
    });
  });

  describe("frostDesired", () => {
    describe("With frost preset 7 on a TRV-ZBT", () => {
      it("frost_protection 7, reason frost", () => {
        expect(frostDesired(TRV_ZBT, 7)).toEqual({
          frost_protection: { value: 7, reason: "frost" },
        });
      });
    });
    describe("With frost preset 3 on a TRV-ZBT", () => {
      it("frost_protection 5", () => {
        expect(frostDesired(TRV_ZBT, 3).frost_protection?.value).toBe(5);
      });
    });
    describe("With frost preset 3 on a TRVZB", () => {
      it("frost_protection 4", () => {
        expect(frostDesired(TRVZB, 3).frost_protection?.value).toBe(4);
      });
    });
  });
});
