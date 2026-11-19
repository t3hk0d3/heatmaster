import { describe, expect, it } from "vitest";
import { makeThermostat } from "../test/builders.ts";
import { TRV_ZBT_THERMOSTAT } from "./profiles/sonoff-trv-zbt.ts";
import { TRVZB_THERMOSTAT } from "./profiles/sonoff-trvzb.ts";
import { SCHEDULE } from "./thermostat.ts";
import type { ThermostatSeen, ThermostatWanted } from "./thermostat.ts";
import { commonMatch } from "./thermostat-adapter.ts";
import type { AdapterContext } from "./thermostat-adapter.ts";
import type { ValveMode } from "./settings.ts";

/** No week known. */
const NO_WEEK: AdapterContext = {
  inForce: undefined,
  weekValues: undefined,
  pointValues: undefined,
};

/** A confirmed week of 17, 19 and 21, with 19 in force. */
const WEEK: AdapterContext = {
  inForce: 19,
  weekValues: new Set([17, 19, 21]),
  pointValues: new Set([19]),
};

function expected(mode: ValveMode, setpoint?: number, scheduled = false): ThermostatWanted {
  return { mode, setpoint, scheduled };
}

function seen(mode: ValveMode | undefined, setpoint?: number): ThermostatSeen {
  return { mode, setpoint };
}

const OVERRIDE_NEXT = makeThermostat({ target: 22, rule: "next_change" });
const OVERRIDE_TIMER = makeThermostat({ target: 22, rule: "timer" });
const OVERRIDE_MANUAL = makeThermostat({ target: 22, rule: "manual", endsAt: undefined });
const OFF = makeThermostat({ kind: "off" });

describe("thermostat adapters", () => {
  describe("commonMatch", () => {
    describe("With expected heat 22 and seen heat 22", () => {
      it("true", () => {
        expect(commonMatch(expected("heat", 22), seen("heat", 22))).toBe(true);
      });
    });
    describe("With expected heat 22 and seen heat 21.5", () => {
      it("false", () => {
        expect(commonMatch(expected("heat", 22), seen("heat", 21.5))).toBe(false);
      });
    });
    describe("With expected off and seen off 30", () => {
      it("true", () => {
        expect(commonMatch(expected("off"), seen("off", 30))).toBe(true);
      });
    });
    describe("With expected heat 22 and seen auto 22", () => {
      it("false", () => {
        expect(commonMatch(expected("heat", 22), seen("auto", 22))).toBe(false);
      });
    });
    describe("With seen mode undefined", () => {
      it("false", () => {
        expect(commonMatch(expected("heat", 22), seen(undefined, 22))).toBe(false);
        expect(commonMatch(expected("auto", undefined, true), seen(undefined))).toBe(false);
      });
    });
    describe("With expected auto and seen auto", () => {
      it("undefined", () => {
        expect(commonMatch(expected("auto", undefined, true), seen("auto", 17))).toBeUndefined();
      });
    });
  });

  describe("TRVZB_THERMOSTAT", () => {
    describe("wanted", () => {
      describe("With schedule", () => {
        it("auto, no setpoint, scheduled", () => {
          expect(TRVZB_THERMOSTAT.wanted(SCHEDULE, WEEK)).toEqual(
            expected("auto", undefined, true),
          );
        });
      });
      describe("With an override next_change at 22", () => {
        it("heat 22, not scheduled", () => {
          expect(TRVZB_THERMOSTAT.wanted(OVERRIDE_NEXT, WEEK)).toEqual(expected("heat", 22));
        });
      });
      describe("With an override timer at 22", () => {
        it("heat 22", () => {
          expect(TRVZB_THERMOSTAT.wanted(OVERRIDE_TIMER, WEEK)).toEqual(expected("heat", 22));
        });
      });
      describe("With an override manual at 22", () => {
        it("heat 22", () => {
          expect(TRVZB_THERMOSTAT.wanted(OVERRIDE_MANUAL, WEEK)).toEqual(expected("heat", 22));
        });
      });
      describe("With off", () => {
        it("off, no setpoint", () => {
          expect(TRVZB_THERMOSTAT.wanted(OFF, WEEK)).toEqual(expected("off"));
        });
      });
    });
    describe("matches", () => {
      describe("With expected auto and seen auto 17", () => {
        it("true", () => {
          expect(
            TRVZB_THERMOSTAT.matches(expected("auto", undefined, true), seen("auto", 17), WEEK),
          ).toBe(true);
        });
      });
    });
    describe("explains", () => {
      describe("With expected auto and seen heat 22 (a knob)", () => {
        it("false", () => {
          expect(
            TRVZB_THERMOSTAT.explains(expected("auto", undefined, true), seen("heat", 22), WEEK),
          ).toBe(false);
        });
      });
      describe("With expected auto and seen auto 23 (a new week taking effect)", () => {
        it("true", () => {
          expect(
            TRVZB_THERMOSTAT.explains(expected("auto", undefined, true), seen("auto", 23), WEEK),
          ).toBe(true);
        });
      });
    });
  });

  describe("TRV_ZBT_THERMOSTAT", () => {
    describe("wanted", () => {
      describe("With schedule and inForce 19", () => {
        it("auto 19, scheduled", () => {
          expect(TRV_ZBT_THERMOSTAT.wanted(SCHEDULE, WEEK)).toEqual(expected("auto", 19, true));
        });
      });
      describe("With schedule and inForce undefined", () => {
        it("auto, no setpoint, scheduled", () => {
          expect(TRV_ZBT_THERMOSTAT.wanted(SCHEDULE, NO_WEEK)).toEqual(
            expected("auto", undefined, true),
          );
        });
      });
      describe("With an override next_change at 22", () => {
        it("heat 22, not scheduled", () => {
          expect(TRV_ZBT_THERMOSTAT.wanted(OVERRIDE_NEXT, WEEK)).toEqual(expected("heat", 22));
        });
      });
      describe("With an override timer at 22", () => {
        it("heat 22", () => {
          expect(TRV_ZBT_THERMOSTAT.wanted(OVERRIDE_TIMER, WEEK)).toEqual(expected("heat", 22));
        });
      });
      describe("With an override manual at 22", () => {
        it("heat 22", () => {
          expect(TRV_ZBT_THERMOSTAT.wanted(OVERRIDE_MANUAL, WEEK)).toEqual(expected("heat", 22));
        });
      });
      describe("With off", () => {
        it("off, no setpoint", () => {
          expect(TRV_ZBT_THERMOSTAT.wanted(OFF, WEEK)).toEqual(expected("off"));
        });
      });
    });
    describe("matches", () => {
      describe("With expected auto 19 scheduled and seen auto 21, a value of its week", () => {
        it("true", () => {
          expect(
            TRV_ZBT_THERMOSTAT.matches(expected("auto", 19, true), seen("auto", 21), WEEK),
          ).toBe(true);
        });
      });
      describe("With expected auto 19 scheduled and seen auto 22, no value of its week", () => {
        it("false", () => {
          expect(
            TRV_ZBT_THERMOSTAT.matches(expected("auto", 19, true), seen("auto", 22), WEEK),
          ).toBe(false);
        });
      });
      describe("With expected auto 24 scheduled (a held value recorded) and seen auto 24, no value of its week", () => {
        it("true", () => {
          expect(
            TRV_ZBT_THERMOSTAT.matches(expected("auto", 24, true), seen("auto", 24), WEEK),
          ).toBe(true);
        });
      });
      describe("With expected auto scheduled without setpoint, weekValues undefined and seen auto 22", () => {
        it("true", () => {
          expect(
            TRV_ZBT_THERMOSTAT.matches(
              expected("auto", undefined, true),
              seen("auto", 22),
              NO_WEEK,
            ),
          ).toBe(true);
        });
      });
      describe("With expected auto 20.5 not scheduled (adopted) and seen auto 21, a value of its week", () => {
        it("false", () => {
          expect(TRV_ZBT_THERMOSTAT.matches(expected("auto", 20.5), seen("auto", 21), WEEK)).toBe(
            false,
          );
        });
      });
    });
    describe("explains", () => {
      describe("With expected auto 19 scheduled and seen auto 24, no value of its week", () => {
        it("false", () => {
          expect(
            TRV_ZBT_THERMOSTAT.explains(expected("auto", 19, true), seen("auto", 24), WEEK),
          ).toBe(false);
        });
      });
      describe("With expected auto 20.5 not scheduled and seen auto 21, a value of its week, no point near", () => {
        it("false", () => {
          const ctx = { ...WEEK, pointValues: new Set([19]) };
          expect(TRV_ZBT_THERMOSTAT.explains(expected("auto", 20.5), seen("auto", 21), ctx)).toBe(
            false,
          );
        });
      });
      describe("With expected auto 20.5 not scheduled and seen auto 19, the point in force within 2 min of heardAt", () => {
        it("true", () => {
          const ctx = { ...WEEK, pointValues: new Set([17, 19]) };
          expect(TRV_ZBT_THERMOSTAT.explains(expected("auto", 20.5), seen("auto", 19), ctx)).toBe(
            true,
          );
        });
      });
      describe("With weekValues undefined and seen auto 24", () => {
        it("true", () => {
          expect(
            TRV_ZBT_THERMOSTAT.explains(
              expected("auto", undefined, true),
              seen("auto", 24),
              NO_WEEK,
            ),
          ).toBe(true);
        });
      });
      describe("With expected heat 23 and seen heat 21, a value of its week", () => {
        it("false", () => {
          expect(TRV_ZBT_THERMOSTAT.explains(expected("heat", 23), seen("heat", 21), WEEK)).toBe(
            false,
          );
        });
      });
    });
  });
});
