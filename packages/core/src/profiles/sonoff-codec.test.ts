import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { daysEqual } from "../schedule.ts";
import { checkGroup, decodeDay, encodeDay, selectOption } from "./sonoff-codec.ts";
import { TRV_ZBT_BINDING } from "./sonoff-trv-zbt.ts";
import { TRVZB_BINDING } from "./sonoff-trvzb.ts";
import type { ResolvedPoint } from "../schedule.ts";
import type { ValveMode } from "../settings.ts";

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

  describe("checkGroup", () => {
    describe("With 3", () => {
      it("returns 3", () => {
        expect(checkGroup(3)).toBe(3);
      });
    });
    describe('With the text "3"', () => {
      it("throws RangeError naming the value", () => {
        expect(() => checkGroup("3")).toThrow(RangeError);
        expect(() => checkGroup("3")).toThrow(/"3"/);
      });
    });
    describe("With 2.5 or 4", () => {
      it("throws RangeError naming the value", () => {
        expect(() => checkGroup(2.5)).toThrow(/2\.5/);
        expect(() => checkGroup(4)).toThrow(/4/);
      });
    });
  });
  describe("selectOption", () => {
    describe("With an unknown source", () => {
      it("throws RangeError naming the value", () => {
        expect(() => selectOption("bogus")).toThrow(/"bogus"/);
      });
    });
  });
});

const BINDINGS = [
  { model: "TRVZB", binding: TRVZB_BINDING, select: { temperature_sensor_select: "" } },
  {
    model: "TRV-ZBT",
    binding: TRV_ZBT_BINDING,
    select: { schedule_active_group: "", temperature_sensor_select: "" },
  },
] as const;

for (const { model, binding, select } of BINDINGS) {
  describe(`sonoff bindings (${model})`, () => {
    describe("decode", () => {
      describe('With system_mode "heat", occupied_heating_setpoint 21.5, frost_protection_temperature 7', () => {
        const decoded = binding.decode({
          system_mode: "heat",
          occupied_heating_setpoint: 21.5,
          frost_protection_temperature: 7,
        });
        it("values hold system_mode heat, setpoint 21.5, frost_protection 7", () => {
          expect(decoded.values).toEqual({
            system_mode: "heat",
            setpoint: 21.5,
            frost_protection: 7,
          });
        });
        it("readings.mode is heat and readings.setpoint 21.5", () => {
          expect(decoded.readings.mode).toBe("heat");
          expect(decoded.readings.setpoint).toBe(21.5);
        });
      });
      describe('With system_mode "cool"', () => {
        it("system_mode is null", () => {
          expect(binding.decode({ system_mode: "cool" }).values.system_mode).toBeNull();
        });
      });
      describe('With occupied_heating_setpoint "x"', () => {
        it("setpoint is null", () => {
          expect(binding.decode({ occupied_heating_setpoint: "x" }).values.setpoint).toBeNull();
        });
      });
      describe("With open_window ON", () => {
        it("yields open_window on", () => {
          expect(binding.decode({ open_window: "ON" }).values.open_window).toBe("on");
        });
      });
      describe("With open_window OFF", () => {
        it("yields open_window off", () => {
          expect(binding.decode({ open_window: "OFF" }).values.open_window).toBe("off");
        });
      });
      describe('With open_window "maybe"', () => {
        it("leaves open_window out", () => {
          const values = binding.decode({ open_window: "maybe" }).values;
          expect(values.open_window ?? null).toBe(null);
        });
      });
      describe("With none of the three keys", () => {
        it("none of the three values is present", () => {
          const values = binding.decode({ battery: 80 }).values;
          for (const key of ["system_mode", "setpoint", "frost_protection"])
            expect(Object.hasOwn(values, key)).toBe(false);
        });
      });
    });
    describe("encode", () => {
      describe("With system_mode auto and setpoint 21", () => {
        it("the message's keys are system_mode then occupied_heating_setpoint", () => {
          const message = binding.encode({ system_mode: "auto", setpoint: 21 });
          expect(Object.entries(message)).toEqual([
            ["system_mode", "auto"],
            ["occupied_heating_setpoint", 21],
          ]);
        });
      });
      describe("With frost_protection 8 alone", () => {
        it("the message is frost_protection_temperature 8", () => {
          expect(binding.encode({ frost_protection: 8 })).toEqual({
            frost_protection_temperature: 8,
          });
        });
      });
      describe("With open_window off", () => {
        it('writes open_window "OFF"', () => {
          expect(binding.encode({ open_window: "off" })).toEqual({ open_window: "OFF" });
        });
      });
      describe('With system_mode "cool"', () => {
        it("throws RangeError", () => {
          expect(() => binding.encode({ system_mode: "cool" as ValveMode })).toThrow(RangeError);
        });
      });
      describe("With setpoint 22 then system_mode heat in the desired order", () => {
        it("system_mode comes first in the message", () => {
          const message = binding.encode({ setpoint: 22, system_mode: "heat" });
          expect(Object.keys(message)).toEqual(["system_mode", "occupied_heating_setpoint"]);
        });
      });
    });
    describe("encodeRefresh", () => {
      describe("By default", () => {
        it("asks for system_mode, occupied_heating_setpoint and frost_protection_temperature with the sensor select", () => {
          expect(binding.encodeRefresh()).toEqual({
            ...select,
            system_mode: "",
            occupied_heating_setpoint: "",
            frost_protection_temperature: "",
            open_window: "",
          });
        });
      });
    });
  });
}
