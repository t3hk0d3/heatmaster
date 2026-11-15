import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { points } from "../test/builders.ts";
import { WEEKDAYS } from "./index.ts";
import {
  activePoint,
  daysEqual,
  fitWeek,
  normalizeDay,
  resolveWeek,
  type ResolvedDay,
  type ResolvedWeek,
} from "./schedule.ts";
import type { Presets, SetPoint, Week, Weekday } from "./model.ts";

const PRESETS: Presets = { comfort: 21, eco: 18, frost: 8, boost: 24 };
const AMS = "Europe/Amsterdam";

function sp(time: string, over: Partial<SetPoint>): SetPoint {
  return {
    time: Temporal.PlainTime.from(time),
    preset: undefined,
    temperature: undefined,
    ...over,
  };
}

function weekOf(day: ResolvedDay, over: Partial<Record<Weekday, ResolvedDay>> = {}): ResolvedWeek {
  return { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day, ...over };
}

function at(iso: string, zone = AMS): Temporal.ZonedDateTime {
  return Temporal.PlainDateTime.from(iso).toZonedDateTime(zone);
}

function ms(iso: string): number {
  return Temporal.Instant.from(iso).epochMilliseconds;
}

function timesOf(day: ResolvedDay): string[] {
  return day.map((p) => `${p.time.toString({ smallestUnit: "minute" })}/${String(p.temperature)}`);
}

describe("schedule", () => {
  describe("resolveWeek", () => {
    describe("With preset set points", () => {
      it("each takes the temperature of that preset from the given Presets", () => {
        const day = [sp("00:00", { preset: "eco" }), sp("07:00", { preset: "boost" })];
        const week = Object.fromEntries(WEEKDAYS.map((d) => [d, day])) as unknown as Week;
        expect(timesOf(resolveWeek(week, PRESETS).tue)).toEqual(["00:00/18", "07:00/24"]);
      });
    });
    describe("With free-temperature set points", () => {
      it("each keeps its temperature", () => {
        const day = [sp("00:00", { temperature: 16.5 }), sp("07:00", { temperature: 19 })];
        const week = Object.fromEntries(WEEKDAYS.map((d) => [d, day])) as unknown as Week;
        expect(timesOf(resolveWeek(week, PRESETS).mon)).toEqual(["00:00/16.5", "07:00/19"]);
      });
    });
    describe("Always", () => {
      it("every weekday is present, with set points in input order", () => {
        const day = [
          sp("00:00", { preset: "frost" }),
          sp("06:00", { temperature: 20 }),
          sp("22:00", { preset: "comfort" }),
        ];
        const week = Object.fromEntries(WEEKDAYS.map((d) => [d, day])) as unknown as Week;
        const resolved = resolveWeek(week, PRESETS);
        expect(Object.keys(resolved)).toEqual([...WEEKDAYS]);
        for (const d of WEEKDAYS) {
          expect(timesOf(resolved[d])).toEqual(["00:00/8", "06:00/20", "22:00/21"]);
        }
      });
    });
  });

  describe("fitWeek", () => {
    describe("With a temperature above maxTemp or below minTemp", () => {
      const week = weekOf(points("00:00/3 06:00/20 12:00/40"));
      const fitted = fitWeek(week, 5, 30, 0.5);
      it("it is set to the limit", () => {
        expect(timesOf(fitted.days.wed)).toEqual(["00:00/5", "06:00/20", "12:00/30"]);
      });
      it("clamped is true", () => {
        expect(fitted.clamped).toBe(true);
      });
    });
    describe("With every temperature inside the range", () => {
      it("clamped is false", () => {
        expect(fitWeek(weekOf(points("00:00/16 07:00/19")), 5, 30, 0.5).clamped).toBe(false);
      });
    });
    describe("With 17.25 and a step of 0.5", () => {
      const fitted = fitWeek(weekOf(points("00:00/17.25")), 5, 30, 0.5);
      it("it becomes 17.5", () => {
        expect(fitted.days.mon[0]?.temperature).toBe(17.5);
      });
      it("clamped stays false", () => {
        expect(fitted.clamped).toBe(false);
      });
    });
  });

  describe("normalizeDay", () => {
    describe("With points 00:00/16, 07:00/19, 10:00/16, 10:00/16, 17:00/19", () => {
      it("returns 00:00/16, 07:00/19, 10:00/16, 17:00/19", () => {
        expect(
          timesOf(normalizeDay(points("00:00/16 07:00/19 10:00/16 10:00/16 17:00/19"))),
        ).toEqual(["00:00/16", "07:00/19", "10:00/16", "17:00/19"]);
      });
    });
    describe("With points 00:00/17, 06:00/17, 09:00/20", () => {
      it("returns 00:00/17, 09:00/20", () => {
        expect(timesOf(normalizeDay(points("00:00/17 06:00/17 09:00/20")))).toEqual([
          "00:00/17",
          "09:00/20",
        ]);
      });
    });
    describe("With a single point", () => {
      it("returns it unchanged", () => {
        expect(normalizeDay(points("00:00/17"))).toEqual(points("00:00/17"));
      });
    });
    describe("With 12 points of which 5 differ from the point before them", () => {
      it("returns those 5 and the first point", () => {
        const day = points(
          "00:00/16 01:00/16 02:00/18 03:00/18 04:00/18 05:00/20 06:00/20 07:00/16 08:00/16 09:00/19 10:00/19 11:00/21",
        );
        expect(day).toHaveLength(12);
        expect(timesOf(normalizeDay(day))).toEqual([
          "00:00/16",
          "02:00/18",
          "05:00/20",
          "07:00/16",
          "09:00/19",
          "11:00/21",
        ]);
      });
    });
  });

  describe("daysEqual", () => {
    describe("With one day padded by repeats and the other not", () => {
      it("returns true", () => {
        expect(
          daysEqual(points("00:00/16 05:00/16 07:00/19 08:00/19"), points("00:00/16 07:00/19")),
        ).toBe(true);
      });
    });
    describe("With days differing in one temperature or one time", () => {
      it("returns false", () => {
        const base = points("00:00/16 07:00/19");
        expect(daysEqual(base, points("00:00/16 07:00/20"))).toBe(false);
        expect(daysEqual(base, points("00:00/16 07:30/19"))).toBe(false);
      });
    });
  });

  describe("activePoint", () => {
    const day = points("00:00/16 07:00/19 22:00/17");
    const week = weekOf(day);
    // 2027-03-22 is a Monday.
    describe("At a time between two set points", () => {
      it("temperature is that of the earlier one", () => {
        expect(activePoint(week, at("2027-03-22T12:00")).temperature).toBe(19);
      });
    });
    describe("Exactly at a set point's time", () => {
      it("temperature is that set point's", () => {
        expect(activePoint(week, at("2027-03-22T07:00")).temperature).toBe(19);
      });
    });
    describe("When the next set point has a different temperature", () => {
      const result = activePoint(week, at("2027-03-22T12:00"));
      it("nextChangeAt is the instant of that set point today, nextTemperature its temperature", () => {
        expect(result.nextChangeAt).toBe(at("2027-03-22T22:00").epochMilliseconds);
        expect(result.nextTemperature).toBe(17);
      });
    });
    describe("When the next set point has the same temperature", () => {
      it("it is skipped; nextChangeAt is the following one that differs", () => {
        const w = weekOf(points("00:00/16 07:00/16 09:00/20"));
        const result = activePoint(w, at("2027-03-22T06:00"));
        expect(result.nextChangeAt).toBe(at("2027-03-22T09:00").epochMilliseconds);
        expect(result.nextTemperature).toBe(20);
      });
    });
    describe("Late in the day with no later change today", () => {
      it("nextChangeAt falls on the next day whose set point differs", () => {
        const w = weekOf(points("00:00/17"), { tue: points("00:00/17 06:00/21") });
        const result = activePoint(w, at("2027-03-22T23:00"));
        expect(result.nextChangeAt).toBe(at("2027-03-23T06:00").epochMilliseconds);
        expect(result.nextTemperature).toBe(21);
      });
    });
    describe("With a week where every set point has the same temperature", () => {
      it("nextChangeAt and nextTemperature are undefined", () => {
        const result = activePoint(weekOf(points("00:00/17 08:00/17")), at("2027-03-22T09:00"));
        expect(result.nextChangeAt).toBeUndefined();
        expect(result.nextTemperature).toBeUndefined();
      });
    });
    describe("With Monday 00:00/17 08:00/20 08:30/17 and every other day 00:00/17, on a Monday at 09:00", () => {
      it("nextChangeAt is the following Monday at 08:00 and nextTemperature is 20", () => {
        const w = weekOf(points("00:00/17"), { mon: points("00:00/17 08:00/20 08:30/17") });
        const result = activePoint(w, at("2027-03-22T09:00"));
        expect(result.nextChangeAt).toBe(at("2027-03-29T08:00").epochMilliseconds);
        expect(result.nextTemperature).toBe(20);
      });
    });
    describe("On 2027-03-28 in Europe/Amsterdam at 01:30 with a set point at 02:30", () => {
      it("nextChangeAt is 2027-03-28T01:00:00Z (03:00 local, the first instant after the skipped hour)", () => {
        const w = weekOf(points("00:00/16 02:30/20"));
        const result = activePoint(w, at("2027-03-28T01:30"));
        expect(result.nextChangeAt).toBe(ms("2027-03-28T01:00:00Z"));
      });
    });
    describe("On 2027-03-28 in Europe/Amsterdam at 03:00 with a set point at 02:30", () => {
      it("temperature is the 02:30 set point's", () => {
        const w = weekOf(points("00:00/16 02:30/20"));
        expect(activePoint(w, at("2027-03-28T03:00")).temperature).toBe(20);
      });
    });
    describe("On 2027-10-31 in Europe/Amsterdam at 01:30 with a set point at 02:30", () => {
      it("nextChangeAt is 2027-10-31T00:30:00Z (the first 02:30 of that night)", () => {
        const w = weekOf(points("00:00/16 02:30/20"));
        expect(activePoint(w, at("2027-10-31T01:30")).nextChangeAt).toBe(
          ms("2027-10-31T00:30:00Z"),
        );
      });
    });
    describe("On 2027-10-31 in Europe/Amsterdam with a set point at 02:00, at 02:30 on the first pass", () => {
      it("temperature is the 02:00 set point's", () => {
        const w = weekOf(points("00:00/16 02:00/20"));
        const now = Temporal.Instant.from("2027-10-31T00:30:00Z").toZonedDateTimeISO(AMS);
        expect(now.toPlainTime().toString()).toBe("02:30:00");
        expect(activePoint(w, now).temperature).toBe(20);
      });
    });
    describe("On 2027-10-31 in Europe/Amsterdam with a set point at 02:00, at 02:30 on the second pass", () => {
      it("temperature is the 02:00 set point's", () => {
        const w = weekOf(points("00:00/16 02:00/20"));
        const now = Temporal.Instant.from("2027-10-31T01:30:00Z").toZonedDateTimeISO(AMS);
        expect(now.toPlainTime().toString()).toBe("02:30:00");
        expect(activePoint(w, now).temperature).toBe(20);
      });
    });
    describe("At any instant of 2027-03-28 or 2027-10-31 in Europe/Amsterdam, with any valid week", () => {
      const arbDay = fc
        .uniqueArray(fc.integer({ min: 1, max: 1439 }), { maxLength: 6 })
        .chain((minutes) =>
          fc
            .array(fc.integer({ min: 8, max: 40 }), {
              minLength: minutes.length + 1,
              maxLength: minutes.length + 1,
            })
            .map((temps) =>
              [0, ...minutes.sort((a, b) => a - b)].map((m, i) => ({
                time: Temporal.PlainTime.from({ hour: Math.floor(m / 60), minute: m % 60 }),
                temperature: (temps[i] ?? 20) / 2,
              })),
            ),
        );
      const arbWeek = fc
        .array(arbDay, { minLength: 7, maxLength: 7 })
        .map(
          (days) =>
            Object.fromEntries(WEEKDAYS.map((d, i) => [d, days[i]])) as unknown as ResolvedWeek,
        );
      const arbNow = fc
        .tuple(
          fc.constantFrom("2027-03-28", "2027-10-31"),
          fc.integer({ min: 0, max: 24 * 60 * 60 - 1 }),
        )
        .map(([date, s]) =>
          Temporal.Instant.from(`${date}T00:00:00+01:00`)
            .add({ seconds: s - (date === "2027-03-28" ? 0 : 3600) })
            .toZonedDateTimeISO(AMS),
        );
      fcTest.prop([arbWeek, arbNow])("does not throw", (w, now) => {
        expect(() => activePoint(w, now)).not.toThrow();
      });
      fcTest.prop([arbWeek, arbNow])("nextChangeAt, when set, is later than now", (w, now) => {
        const { nextChangeAt } = activePoint(w, now);
        if (nextChangeAt !== undefined) expect(nextChangeAt).toBeGreaterThan(now.epochMilliseconds);
      });
    });
  });
});
