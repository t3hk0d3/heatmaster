import { describe, expect, it } from "vitest";
import { aggregate, freshness } from "./index.ts";
import type { RoomTemperature, SensorReading, SensorRef } from "./index.ts";

const NOW = 10_000_000;
const STALE = 60_000;

function sensor(ref: string, weight = 1): SensorRef {
  return { ref, key: undefined, weight };
}

function reading(id: string, over: Partial<SensorReading> = {}): SensorReading {
  return { sensorId: id, value: 20, seenAt: NOW, pending: false, ...over };
}

function readingsOf(...list: SensorReading[]): ReadonlyMap<string, SensorReading> {
  return new Map(list.map((r) => [r.sensorId, r]));
}

function one(r: Partial<SensorReading> | undefined): RoomTemperature {
  const readings = r === undefined ? readingsOf() : readingsOf(reading("a", r));
  return aggregate([sensor("a")], readings, NOW, STALE);
}

function temp(over: Partial<RoomTemperature>): RoomTemperature {
  return { value: undefined, used: [], stale: [], invalid: [], pending: [], ...over };
}

describe("temperature", () => {
  describe("aggregate", () => {
    describe("With two fresh sensors of weights 2 and 1 reading 19.0 and 22.0", () => {
      const result = aggregate(
        [sensor("a", 2), sensor("b", 1)],
        readingsOf(reading("a", { value: 19 }), reading("b", { value: 22 })),
        NOW,
        STALE,
      );
      it("value is 20.0", () => {
        expect(result.value).toBe(20.0);
      });
      it("used lists both sensors", () => {
        expect(result.used).toEqual(["a", "b"]);
      });
    });

    describe("With fresh sensors reading 19.2 and 19.3 at equal weights", () => {
      it("value is 19.3 (19.25 rounded half up to 0.1)", () => {
        const result = aggregate(
          [sensor("a"), sensor("b")],
          readingsOf(reading("a", { value: 19.2 }), reading("b", { value: 19.3 })),
          NOW,
          STALE,
        );
        expect(result.value).toBe(19.3);
      });
    });

    describe("With one sensor seen longer ago than staleAfterMs", () => {
      it("it is listed in stale and left out of the value", () => {
        const result = aggregate(
          [sensor("a"), sensor("b")],
          readingsOf(
            reading("a", { value: 18 }),
            reading("b", { value: 25, seenAt: NOW - STALE - 1 }),
          ),
          NOW,
          STALE,
        );
        expect(result).toEqual(temp({ value: 18, used: ["a"], stale: ["b"] }));
      });
    });

    describe("With a sensor seen exactly staleAfterMs ago", () => {
      it("it still counts as fresh", () => {
        expect(one({ seenAt: NOW - STALE }).used).toEqual(["a"]);
      });
    });

    describe("With a sensor that is not pending and whose value or seenAt is undefined", () => {
      it("it is listed in stale", () => {
        expect(one({ value: undefined }).stale).toEqual(["a"]);
        expect(one({ seenAt: undefined }).stale).toEqual(["a"]);
      });
    });

    describe("With a pending sensor that has a value and no seenAt", () => {
      it("it is used", () => {
        expect(one({ pending: true, seenAt: undefined }).used).toEqual(["a"]);
      });
    });

    describe("With a pending sensor that has a value and a seenAt within staleAfterMs", () => {
      it("it is used", () => {
        expect(one({ pending: true, seenAt: NOW - STALE }).used).toEqual(["a"]);
      });
    });

    describe("With a pending sensor that has a value and a seenAt older than staleAfterMs", () => {
      it("it is listed in pending and left out of the value", () => {
        const result = one({ pending: true, seenAt: NOW - STALE - 1 });
        expect(result).toEqual(temp({ pending: ["a"] }));
      });
    });

    describe("With a pending sensor that has no value", () => {
      it("it is listed in pending and not in stale", () => {
        const result = one({ pending: true, value: undefined });
        expect(result.pending).toEqual(["a"]);
        expect(result.stale).toEqual([]);
      });
    });

    describe("With a sensor that has no entry in readings", () => {
      it("it is listed in stale", () => {
        expect(one(undefined).stale).toEqual(["a"]);
      });
    });

    describe("With a sensor reading below −10 or above 45", () => {
      it("it is listed in invalid and left out of the value", () => {
        const result = aggregate(
          [sensor("a"), sensor("b"), sensor("c")],
          readingsOf(
            reading("a", { value: -10.1 }),
            reading("b", { value: 45.1 }),
            reading("c", { value: 21 }),
          ),
          NOW,
          STALE,
        );
        expect(result).toEqual(temp({ value: 21, used: ["c"], invalid: ["a", "b"] }));
      });
    });

    describe("With sensors reading exactly −10 and exactly 45", () => {
      it("both are used", () => {
        const result = aggregate(
          [sensor("a"), sensor("b")],
          readingsOf(reading("a", { value: -10 }), reading("b", { value: 45 })),
          NOW,
          STALE,
        );
        expect(result.used).toEqual(["a", "b"]);
      });
    });

    describe("With a sensor reading NaN or infinity", () => {
      it("it is listed in invalid", () => {
        const result = aggregate(
          [sensor("a"), sensor("b"), sensor("c")],
          readingsOf(
            reading("a", { value: Number.NaN }),
            reading("b", { value: Infinity }),
            reading("c", { value: -Infinity }),
          ),
          NOW,
          STALE,
        );
        expect(result.invalid).toEqual(["a", "b", "c"]);
      });
    });

    describe("With a stale sensor whose last value is out of range", () => {
      it("it is listed in stale and not in invalid", () => {
        const result = one({ value: 99, seenAt: NOW - STALE - 1 });
        expect(result.stale).toEqual(["a"]);
        expect(result.invalid).toEqual([]);
      });
    });

    describe("With every sensor stale or invalid", () => {
      it("value is undefined", () => {
        const result = aggregate(
          [sensor("a"), sensor("b")],
          readingsOf(reading("a", { value: 99 }), reading("b", { seenAt: undefined })),
          NOW,
          STALE,
        );
        expect(result.value).toBeUndefined();
      });
    });

    describe("With no sensors configured", () => {
      it("value is undefined and all four lists are empty", () => {
        expect(aggregate([], readingsOf(), NOW, STALE)).toEqual(temp({}));
      });
    });

    describe("With three sensors of which the second is stale", () => {
      it("used lists the first and third in the room's order", () => {
        const result = aggregate(
          [sensor("a"), sensor("b"), sensor("c")],
          readingsOf(
            reading("c", { value: 20 }),
            reading("b", { seenAt: NOW - STALE - 1 }),
            reading("a", { value: 20 }),
          ),
          NOW,
          STALE,
        );
        expect(result.used).toEqual(["a", "c"]);
      });
    });
  });

  describe("freshness", () => {
    describe("With no sensors configured", () => {
      it('returns "no_sensors"', () => {
        expect(freshness([], temp({}))).toBe("no_sensors");
      });
    });

    describe("With a value", () => {
      it('returns "fresh"', () => {
        expect(freshness([sensor("a")], temp({ value: 20, used: ["a"] }))).toBe("fresh");
      });
    });

    describe("With no value and one sensor pending", () => {
      it('returns "pending"', () => {
        const sensors = [sensor("a"), sensor("b")];
        expect(freshness(sensors, temp({ pending: ["a"], stale: ["b"] }))).toBe("pending");
      });
    });

    describe("With no value and every sensor stale or invalid", () => {
      it('returns "stale"', () => {
        const sensors = [sensor("a"), sensor("b")];
        expect(freshness(sensors, temp({ stale: ["a"], invalid: ["b"] }))).toBe("stale");
      });
    });
  });
});
