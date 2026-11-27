import { describe, expect, it } from "vitest";
import { makeSpec } from "../../test/builders.ts";
import { PROFILES, findProfile } from "./index.ts";
import { validateProfile } from "./base.ts";
import type { Profile } from "./base.ts";
import { SONOFF_TRV_ZBT, TRV_ZBT_SPEC, TRV_ZBT_THERMOSTAT } from "./sonoff-trv-zbt.ts";
import { TRVZB_SPEC, TRVZB_THERMOSTAT } from "./sonoff-trvzb.ts";

const HOUR_MS = 60 * 60 * 1000;
const ALL_SPECS = PROFILES.flatMap((p) =>
  Object.entries(p.specs).map(([transport, spec]) => ({ profile: p, transport, spec })),
);

describe("profiles index", () => {
  describe("findProfile", () => {
    describe("With model TRVZB and transport z2m", () => {
      it("returns the TRVZB spec and binding", () => {
        const found = findProfile("TRVZB", "z2m");
        expect(found?.spec).toBe(TRVZB_SPEC);
        expect(found?.binding.encodeRefresh()).toHaveProperty("temperature_sensor_select");
      });
    });
    describe("With model TRV-ZBT and transport z2m", () => {
      it("returns the TRV-ZBT spec and binding", () => {
        const found = findProfile("TRV-ZBT", "z2m");
        expect(found?.spec).toBe(TRV_ZBT_SPEC);
        expect(found?.binding.encodeRefresh()).toHaveProperty("schedule_active_group");
      });
    });
    describe("With an unknown model, or a transport the profile has no binding for", () => {
      it("returns undefined", () => {
        expect(findProfile("NOPE", "z2m")).toBeUndefined();
        expect(findProfile("TRVZB", "zha")).toBeUndefined();
        expect(findProfile("TRVZB", "constructor")).toBeUndefined();
      });
    });
  });
  describe("PROFILES", () => {
    describe("Always", () => {
      it("every spec's schedule group is not captured and not readable, and its evidence is echoed for the TRVZB and none for the TRV-ZBT", () => {
        for (const { spec } of ALL_SPECS) {
          const schedule = spec.groups.find((g) => g.group === "schedule");
          expect(schedule?.capture).toBe(false);
          expect(schedule?.readable).toBe(false);
          expect(schedule?.evidence).toBe(spec.profile === "sonoff_trvzb" ? "echoed" : "none");
        }
      });
      it("every group of every spec but open_window has a maximum age of 24 h", () => {
        for (const { spec } of ALL_SPECS)
          for (const g of spec.groups)
            if (g.group !== "open_window") expect(g.maxAgeMs).toBe(24 * HOUR_MS);
      });
      it("every spec lists schedule before active_group", () => {
        for (const { spec } of ALL_SPECS) {
          const names = spec.groups.map((g) => g.group);
          expect(names[0]).toBe("schedule");
          if (names.includes("active_group"))
            expect(names.indexOf("schedule")).toBeLessThan(names.indexOf("active_group"));
        }
      });
      it("every spec key of a profile has a binding", () => {
        for (const p of PROFILES)
          for (const transport of Object.keys(p.specs))
            expect(p.bindings).toHaveProperty(transport);
      });
      it("encodeRefresh returns a payload exactly when the spec has a readable group", () => {
        for (const { profile, transport, spec } of ALL_SPECS) {
          const refresh = profile.bindings[transport]?.encodeRefresh();
          expect(refresh !== undefined).toBe(spec.groups.some((g) => g.readable));
        }
      });
      it("the specs equal what makeSpec builds", () => {
        expect(TRVZB_SPEC).toEqual(makeSpec("trvzb"));
        expect(TRV_ZBT_SPEC).toEqual(makeSpec("trv_zbt"));
      });
    });
  });
  describe("specs", () => {
    const tail = (groups: readonly { group: string }[]): readonly string[] =>
      groups.slice(-3, -1).map((g) => g.group);
    describe("TRVZB", () => {
      it("frost range 4–35, groups end with frost_protection, thermostat, then open_window", () => {
        expect([TRVZB_SPEC.frostMinTemp, TRVZB_SPEC.frostMaxTemp]).toEqual([4, 35]);
        expect(tail(TRVZB_SPEC.groups)).toEqual(["frost_protection", "thermostat"]);
      });
      it("groups list open_window after thermostat, acked, captured, readable", () => {
        expect(TRVZB_SPEC.groups.at(-1)).toEqual({
          group: "open_window",
          evidence: "acked",
          maxAgeMs: undefined,
          capture: true,
          readable: true,
          atomic: false,
        });
      });
      it("thermostat is TRVZB_THERMOSTAT", () => {
        expect(TRVZB_SPEC.thermostat).toBe(TRVZB_THERMOSTAT);
      });
    });
    describe("TRV-ZBT", () => {
      it("frost range 5–15, groups end with frost_protection, thermostat, then open_window", () => {
        expect([TRV_ZBT_SPEC.frostMinTemp, TRV_ZBT_SPEC.frostMaxTemp]).toEqual([5, 15]);
        expect(tail(TRV_ZBT_SPEC.groups)).toEqual(["frost_protection", "thermostat"]);
      });
      it("groups list open_window after thermostat, acked, captured, readable", () => {
        expect(TRV_ZBT_SPEC.groups.at(-1)).toEqual({
          group: "open_window",
          evidence: "acked",
          maxAgeMs: undefined,
          capture: true,
          readable: true,
          atomic: false,
        });
      });
      it("thermostat is TRV_ZBT_THERMOSTAT", () => {
        expect(TRV_ZBT_SPEC.thermostat).toBe(TRV_ZBT_THERMOSTAT);
      });
    });
  });
  describe("validateProfile", () => {
    const base = SONOFF_TRV_ZBT;
    const spec = TRV_ZBT_SPEC;
    const withSpec = (changed: Partial<typeof spec>): Profile => ({
      ...base,
      specs: { z2m: { ...spec, ...changed } },
    });
    describe("With the shipped profiles", () => {
      it("does not throw", () => {
        for (const p of PROFILES)
          expect(() => {
            validateProfile(p);
          }).not.toThrow();
      });
    });
    describe("With an active_group group and no schedule group", () => {
      it("throws", () => {
        expect(() => {
          validateProfile(withSpec({ scheduleGroup: undefined }));
        }).toThrow(/active_group needs a schedule group/);
      });
    });
    describe("With active_group listed before schedule", () => {
      it("throws", () => {
        expect(() => {
          validateProfile(withSpec({ groups: [...spec.groups].reverse() }));
        }).toThrow(/schedule must come before active_group/);
      });
    });
    describe("With a spec whose profile is not the key, or that has no binding", () => {
      it("throws", () => {
        expect(() => {
          validateProfile(withSpec({ profile: "other" }));
        }).toThrow(/spec.profile is not the key/);
        expect(() => {
          validateProfile({ ...base, bindings: {} });
        }).toThrow(/no binding/);
      });
    });
    describe("With a group listed twice", () => {
      it("throws a repeated-group error", () => {
        expect(() => {
          validateProfile(withSpec({ groups: [...spec.groups, ...spec.groups.slice(0, 1)] }));
        }).toThrow(/a group is repeated/);
      });
    });
    describe("With active_group listed but no schedule group", () => {
      it("throws that active_group needs schedule", () => {
        expect(() => {
          validateProfile(withSpec({ groups: spec.groups.filter((g) => g.group !== "schedule") }));
        }).toThrow(/active_group needs schedule$/);
      });
    });
    describe("With frostMinTemp above frostMaxTemp", () => {
      it("throws", () => {
        expect(() => {
          validateProfile(withSpec({ frostMinTemp: 16, frostMaxTemp: 15 }));
        }).toThrow(/frostMinTemp/);
      });
    });
    describe("With activation setpoint", () => {
      it("throws", () => {
        expect(() => {
          validateProfile(withSpec({ activation: "setpoint" }));
        }).toThrow(/setpoint activation/);
      });
    });
    describe("With sensor_source and no external sensor", () => {
      it("throws", () => {
        expect(() => {
          validateProfile(withSpec({ externalSensor: false }));
        }).toThrow(/sensor_source needs an external sensor/);
      });
    });
  });
});
