import { describe, expect, it } from "vitest";
import { roundHalfUp } from "./rounding.ts";

describe("rounding", () => {
  describe("roundHalfUp", () => {
    describe("With 19.25 and a step of 0.1", () => {
      it("returns 19.3", () => {
        expect(roundHalfUp(19.25, 0.1)).toBe(19.3);
      });
    });
    describe("With 19.75 and a step of 0.5", () => {
      it("returns 20", () => {
        expect(roundHalfUp(19.75, 0.5)).toBe(20);
      });
    });
    describe("With 19.2499999995, within 1e-9 below a half, and a step of 0.1", () => {
      it("returns 19.3", () => {
        expect(roundHalfUp(19.2499999995, 0.1)).toBe(19.3);
      });
    });
    describe("With 19.249999, further than 1e-9 below a half, and a step of 0.1", () => {
      it("returns 19.2", () => {
        expect(roundHalfUp(19.249999, 0.1)).toBe(19.2);
      });
    });
    describe("With 17.2 and a step of 0.5", () => {
      it("returns 17", () => {
        expect(roundHalfUp(17.2, 0.5)).toBe(17);
      });
    });
    describe("With 17.5 and a step of 1", () => {
      it("returns 18", () => {
        expect(roundHalfUp(17.5, 1)).toBe(18);
      });
    });
    describe("With a value already on the grid", () => {
      it("returns it unchanged", () => {
        expect(roundHalfUp(20.1, 0.1)).toBe(20.1);
      });
    });
  });
});
