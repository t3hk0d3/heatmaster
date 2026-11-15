import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { daysEqual } from "../schedule.ts";
import { decodeDay, encodeDay } from "./sonoff-codec.ts";
import type { ResolvedPoint } from "../schedule.ts";

function point(hhmm: string, temperature: number): ResolvedPoint {
  return { time: Temporal.PlainTime.from(hhmm), temperature };
}

function entries(text: string): string[] {
  return text.split(" ");
}

const DAY_6 = "00:00/16 07:00/19 10:00/16 10:00/16 17:00/19 23:00/16";

describe("sonoff-codec", () => {
  describe("encodeDay", () => {
    describe("With 3 points and slotCount 6", () => {
      it("returns 6 entries, the last point repeated 3 more times", () => {
        const text = encodeDay([point("00:00", 16), point("07:00", 19), point("22:00", 17)], 6);
        expect(entries(text)).toEqual([
          "00:00/16",
          "07:00/19",
          "22:00/17",
          "22:00/17",
          "22:00/17",
          "22:00/17",
        ]);
      });
    });
    describe("With 6 points and slotCount 12", () => {
      it("returns 12 entries", () => {
        const points = [
          point("00:00", 16),
          point("06:00", 19),
          point("09:00", 16),
          point("16:00", 19),
          point("20:00", 18),
          point("22:00", 16),
        ];
        expect(entries(encodeDay(points, 12))).toHaveLength(12);
      });
    });
    describe("With 12 entries of which 5 are distinct and slotCount 6", () => {
      it("returns the 5 distinct points padded to 6", () => {
        const decoded = decodeDay("00:00/16 06:00/19 06:00/19 09:00/16 16:00/19 22:00/16 22:00/16");
        const text = encodeDay(decoded ?? [], 6);
        expect(entries(text)).toEqual([
          "00:00/16",
          "06:00/19",
          "09:00/16",
          "16:00/19",
          "22:00/16",
          "22:00/16",
        ]);
      });
    });
    describe("With a whole and a half temperature", () => {
      it('writes "16" and "16.5"', () => {
        expect(entries(encodeDay([point("00:00", 16), point("07:00", 16.5)], 2))).toEqual([
          "00:00/16",
          "07:00/16.5",
        ]);
      });
    });
    describe("With more distinct points than slotCount", () => {
      it("throws RangeError", () => {
        const points = [point("00:00", 16), point("01:00", 17), point("02:00", 16)];
        expect(() => encodeDay(points, 2)).toThrow(RangeError);
      });
    });
    describe("With no points", () => {
      it("throws RangeError", () => {
        expect(() => encodeDay([], 6)).toThrow(RangeError);
      });
    });
  });

  describe("decodeDay", () => {
    describe('With "00:00/16 07:00/19 10:00/16 10:00/16 17:00/19 23:00/16"', () => {
      it("returns all 6 entries in order", () => {
        const day = decodeDay(DAY_6);
        expect(day?.map((p) => `${p.time.toString()}/${String(p.temperature)}`)).toEqual([
          "00:00:00/16",
          "07:00:00/19",
          "10:00:00/16",
          "10:00:00/16",
          "17:00:00/19",
          "23:00:00/16",
        ]);
      });
    });
    describe("With a 12-entry text", () => {
      it("returns all 12 entries", () => {
        const text = Array.from({ length: 12 }, () => "22:00/16").join(" ");
        expect(decodeDay(text)).toHaveLength(12);
      });
    });
    describe('With "16.0" and "16"', () => {
      it("both decode to 16", () => {
        expect(decodeDay("00:00/16.0")?.[0]?.temperature).toBe(16);
        expect(decodeDay("00:00/16")?.[0]?.temperature).toBe(16);
      });
    });
    describe("With repeated spaces or leading/trailing spaces", () => {
      it("decodes as if single-spaced", () => {
        expect(decodeDay("  00:00/16   07:00/19 ")).toEqual(decodeDay("00:00/16 07:00/19"));
      });
    });
    describe('With null, undefined, "", "unknown", "unavailable" or a non-text value', () => {
      it("returns null", () => {
        for (const value of [null, undefined, "", "unknown", "unavailable", 5, {}, []]) {
          expect(decodeDay(value)).toBeNull();
        }
      });
    });
    describe("With a malformed entry", () => {
      it("returns null", () => {
        for (const text of ["00:00/16 7:0/19x", "24:00/16", "00:60/16", "00:00", "00:00/abc"]) {
          expect(decodeDay(text)).toBeNull();
        }
      });
    });
    describe("With any list of 1–6 points (fast-check)", () => {
      const pointArb = fc
        .record({
          minute: fc.integer({ min: 0, max: 1439 }),
          halves: fc.integer({ min: 8, max: 70 }),
        })
        .map(({ minute, halves }) =>
          point(
            `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`,
            halves / 2,
          ),
        );
      fcTest.prop([fc.array(pointArb, { minLength: 1, maxLength: 6 })])(
        "daysEqual(decodeDay(encodeDay(points, n)), points) is true for n 6 and 12",
        (points) => {
          for (const n of [6, 12]) {
            const decoded = decodeDay(encodeDay(points, n));
            expect(decoded !== null && daysEqual(decoded, points)).toBe(true);
          }
        },
      );
    });
  });
});
