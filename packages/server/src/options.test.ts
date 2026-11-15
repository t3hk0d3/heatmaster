import { describe, expect, it } from "vitest";
import { API_HOST, DEFAULT_PORT, loadOptions } from "./options.ts";

describe("options", () => {
  describe("loadOptions", () => {
    describe("With no HEATMASTER_PORT", () => {
      it("port is 3000", () => {
        expect(DEFAULT_PORT).toBe(3000);
        expect(API_HOST).toBe("127.0.0.1");
        expect(loadOptions({})).toEqual({ port: 3000 });
      });
    });

    describe('With HEATMASTER_PORT "8123"', () => {
      it("port is 8123", () => {
        expect(loadOptions({ HEATMASTER_PORT: "8123" })).toEqual({ port: 8123 });
      });
    });

    describe('With HEATMASTER_PORT "abc", "0", "-1", "70000" or "80.5"', () => {
      it("throws an Error whose message names HEATMASTER_PORT", () => {
        for (const value of ["abc", "0", "-1", "70000", "80.5"]) {
          expect(() => loadOptions({ HEATMASTER_PORT: value }), value).toThrow(/HEATMASTER_PORT/);
        }
      });
    });
  });
});
