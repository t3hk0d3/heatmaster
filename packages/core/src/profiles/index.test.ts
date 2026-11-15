import { describe, expect, it } from "vitest";
import { makeSpec } from "../../test/builders.ts";
import { PROFILES, findProfile } from "./index.ts";
import { validateProfile } from "./base.ts";
import type { Profile } from "./base.ts";
import { SONOFF_TRV_ZBT, TRV_ZBT_SPEC } from "./sonoff-trv-zbt.ts";
import { TRVZB_SPEC } from "./sonoff-trvzb.ts";

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
        expect(found?.binding.encodeRefresh()).toEqual({ temperature_sensor_select: "" });
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
      it("every group of every spec has a maximum age of 24 h", () => {
        for (const { spec } of ALL_SPECS)
          for (const g of spec.groups) expect(g.maxAgeMs).toBe(24 * HOUR_MS);
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
      it("encode, encodeSetpoint, encodeTemperature and encodeRefresh never return the mode key", () => {
        for (const { profile, transport } of ALL_SPECS) {
          const b = profile.bindings[transport];
          const messages = [
            b?.encode({
              sensor_source: "internal",
              active_group: 3,
              day_mon: [{ time: Temporal.PlainTime.from("07:00"), temperature: 19 }],
            }),
            b?.encodeSetpoint(20),
            b?.encodeTemperature(20),
            b?.encodeRefresh(),
          ];
          for (const m of messages) expect(Object.keys(m ?? {})).not.toContain("system_mode");
        }
      });
      it("the specs equal what makeSpec builds", () => {
        expect(TRVZB_SPEC).toEqual(makeSpec("trvzb"));
        expect(TRV_ZBT_SPEC).toEqual(makeSpec("trv_zbt"));
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
        }).toThrow();
      });
    });
    describe("With active_group listed before schedule", () => {
      it("throws", () => {
        expect(() => {
          validateProfile(withSpec({ groups: [...spec.groups].reverse() }));
        }).toThrow();
      });
    });
    describe("With a spec whose profile is not the key, or that has no binding", () => {
      it("throws", () => {
        expect(() => {
          validateProfile(withSpec({ profile: "other" }));
        }).toThrow();
        expect(() => {
          validateProfile({ ...base, bindings: {} });
        }).toThrow();
      });
    });
    describe("With sensor_source and no external sensor", () => {
      it("throws", () => {
        expect(() => {
          validateProfile(withSpec({ externalSensor: false }));
        }).toThrow();
      });
    });
  });
});
