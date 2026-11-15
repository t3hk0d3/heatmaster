import { describe, expect, it } from "vitest";
import { pushDue, pushed, stopped, trackRoom, wantedSource } from "./feed.ts";
import { newValveMemory, type RoomMemory } from "./memory.ts";
import type { ValveSpec } from "./settings.ts";
import type { Freshness } from "./temperature.ts";

const MINUTE_MS = 60 * 1000;
const INTERVAL_MS = 5 * MINUTE_MS;
const T0 = 1_700_000_000_000;

const SPEC: ValveSpec = {
  profile: "test",
  minTemp: 4,
  maxTemp: 35,
  tempStep: 0.5,
  maxSetPoints: 6,
  slotCount: 6,
  scheduleGroup: undefined,
  groups: [
    {
      group: "sensor_source",
      evidence: "acked",
      maxAgeMs: undefined,
      capture: true,
      readable: true,
    },
  ],
  activation: "none",
  externalSensor: true,
  feedWhenOff: false,
};

const NEW = newValveMemory(SPEC, T0);
const FED = pushed(NEW, 20, T0);

function freshFor(ms: number, now: number): RoomMemory {
  return { freshSince: now - ms };
}

describe("feed", () => {
  describe("pushDue", () => {
    describe("With nothing pushed yet", () => {
      it("returns true", () => {
        expect(pushDue(NEW, 20, INTERVAL_MS, T0)).toBe(true);
      });
    });
    describe("With a change of 0.2 and the interval passed", () => {
      it("returns true", () => {
        expect(pushDue(FED, 20.2, INTERVAL_MS, T0 + INTERVAL_MS)).toBe(true);
      });
    });
    describe("With a change of 0.2 and the interval not passed", () => {
      it("returns false", () => {
        expect(pushDue(FED, 20.2, INTERVAL_MS, T0 + INTERVAL_MS - 1)).toBe(false);
      });
    });
    describe("With a change of 0.1 after 10 min", () => {
      it("returns false", () => {
        expect(pushDue(FED, 20.1, INTERVAL_MS, T0 + 10 * MINUTE_MS)).toBe(false);
      });
    });
    describe("With 19.6 pushed and 19.8 now, the interval passed", () => {
      it("returns true", () => {
        expect(pushDue(pushed(NEW, 19.6, T0), 19.8, INTERVAL_MS, T0 + INTERVAL_MS)).toBe(true);
      });
    });
    describe("With no change after 30 min", () => {
      it("returns true", () => {
        expect(pushDue(FED, 20, INTERVAL_MS, T0 + 30 * MINUTE_MS)).toBe(true);
      });
    });
    describe("With the feed stopped 1 min after a push and the interval at 5 min", () => {
      it("returns false", () => {
        expect(pushDue(stopped(FED), 20, INTERVAL_MS, T0 + MINUTE_MS)).toBe(false);
      });
    });
    describe("With the feed stopped and 5 min passed since the last push", () => {
      it("returns true", () => {
        expect(pushDue(stopped(FED), 20, INTERVAL_MS, T0 + 5 * MINUTE_MS)).toBe(true);
      });
    });
    describe("With the feed stopped, the interval at 60 min, and 30 min passed since the last push", () => {
      it("returns true", () => {
        expect(pushDue(stopped(FED), 20, 60 * MINUTE_MS, T0 + 30 * MINUTE_MS)).toBe(true);
      });
    });
  });

  describe("pushed", () => {
    describe("Always", () => {
      it("feedValue is the temperature, and feedAt and lastPushAt are now", () => {
        const vm = pushed(NEW, 21.3, T0 + MINUTE_MS);
        expect(vm.feedValue).toBe(21.3);
        expect(vm.feedAt).toBe(T0 + MINUTE_MS);
        expect(vm.lastPushAt).toBe(T0 + MINUTE_MS);
      });
    });
  });

  describe("wantedSource", () => {
    const now = T0 + 60 * MINUTE_MS;
    describe("With freshness stale or no_sensors", () => {
      it("returns internal", () => {
        for (const f of ["stale", "no_sensors"] as const) {
          expect(wantedSource(f, { freshSince: undefined }, FED, now)).toBe("internal");
        }
      });
    });
    describe("With fresh for 5 min and a push sent", () => {
      it("returns undefined", () => {
        expect(wantedSource("fresh", freshFor(5 * MINUTE_MS, now), FED, now)).toBeUndefined();
      });
    });
    describe("With fresh for 10 min and a push sent", () => {
      it("returns external", () => {
        expect(wantedSource("fresh", freshFor(10 * MINUTE_MS, now), FED, now)).toBe("external");
      });
    });
    describe("With fresh for 10 min and nothing pushed", () => {
      it("returns undefined", () => {
        expect(wantedSource("fresh", freshFor(10 * MINUTE_MS, now), NEW, now)).toBeUndefined();
      });
    });
    describe("With freshness pending", () => {
      it("returns undefined", () => {
        expect(wantedSource("pending", freshFor(10 * MINUTE_MS, now), FED, now)).toBeUndefined();
      });
    });
  });

  describe("trackRoom", () => {
    describe("When the room becomes fresh", () => {
      it("freshSince is now", () => {
        expect(trackRoom({ freshSince: undefined }, "fresh", T0)).toEqual({ freshSince: T0 });
      });
    });
    describe("While it stays fresh", () => {
      it("freshSince is unchanged", () => {
        expect(trackRoom({ freshSince: T0 }, "fresh", T0 + MINUTE_MS)).toEqual({ freshSince: T0 });
      });
    });
    describe("When it becomes stale, pending or no_sensors", () => {
      it("freshSince is undefined", () => {
        const others: readonly Freshness[] = ["stale", "pending", "no_sensors"];
        for (const f of others) {
          expect(trackRoom({ freshSince: T0 }, f, T0 + MINUTE_MS).freshSince).toBeUndefined();
        }
      });
    });
  });

  describe("stopped", () => {
    describe("Always", () => {
      it("feedValue and feedAt are undefined and lastPushAt is unchanged", () => {
        const vm = stopped(FED);
        expect(vm.feedValue).toBeUndefined();
        expect(vm.feedAt).toBeUndefined();
        expect(vm.lastPushAt).toBe(T0);
      });
    });
  });
});
