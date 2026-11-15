import { describe, expect, it } from "vitest";
import { fastCheckProfile } from "../../../vitest.setup.ts";

describe("Node runtime", () => {
  describe("Temporal", () => {
    describe("Always", () => {
      it("the global Temporal exists without a polyfill", () => {
        expect(typeof Temporal).toBe("object");
        expect(typeof Temporal.Now.instant).toBe("function");
      });

      it("2027-03-28 in Europe/Amsterdam has 23 hours and 2027-10-31 has 25", () => {
        const hours = (date: string): number =>
          Temporal.PlainDate.from(date).toZonedDateTime("Europe/Amsterdam").hoursInDay;
        expect(hours("2027-03-28")).toBe(23);
        expect(hours("2027-10-31")).toBe(25);
      });
    });
  });

  describe("toEqual on Temporal values", () => {
    describe("With two PlainTime values of 07:00", () => {
      it("they are equal", () => {
        expect(Temporal.PlainTime.from("07:00")).toEqual(Temporal.PlainTime.from("07:00"));
      });
    });

    describe("With PlainTime values 07:00 and 08:00", () => {
      it("they are not equal", () => {
        expect(Temporal.PlainTime.from("07:00")).not.toEqual(Temporal.PlainTime.from("08:00"));
      });
    });

    describe("With Temporal values of different classes", () => {
      it("they are not equal", () => {
        expect(Temporal.PlainTime.from("07:00")).not.toEqual(
          Temporal.ZonedDateTime.from("2027-03-28T07:00:00[Europe/Amsterdam]"),
        );
      });
    });

    describe("With two objects that hold different ZonedDateTime values in a nested field", () => {
      it("they are not equal", () => {
        const at = (iso: string): { inner: { at: Temporal.ZonedDateTime } } => ({
          inner: { at: Temporal.ZonedDateTime.from(`${iso}[Europe/Amsterdam]`) },
        });
        expect(at("2027-03-28T07:00:00")).not.toEqual(at("2027-03-28T08:00:00"));
      });
    });
  });

  describe("fastCheckProfile", () => {
    describe('With undefined or "dev"', () => {
      it("returns 200 runs and no seed", () => {
        expect(fastCheckProfile(undefined)).toEqual({ numRuns: 200, seed: undefined });
        expect(fastCheckProfile("dev")).toEqual({ numRuns: 200, seed: undefined });
      });
    });

    describe('With "ci"', () => {
      it("returns 50 runs and a seed that is the same on every call", () => {
        const first = fastCheckProfile("ci");
        expect(first.numRuns).toBe(50);
        expect(typeof first.seed).toBe("number");
        expect(fastCheckProfile("ci").seed).toBe(first.seed);
      });
    });

    describe("With any other name", () => {
      it("throws", () => {
        expect(() => fastCheckProfile("nightly")).toThrow();
      });
    });
  });
});
