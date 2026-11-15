import { describe, expect, it } from "vitest";
import { points } from "../test/builders.ts";
import {
  liveness,
  newState,
  onLinkUp,
  onMessage,
  type Decoded,
  type DeviceState,
} from "./observation.ts";
import { EMPTY_READINGS } from "./settings.ts";

const HOUR_MS = 60 * 60 * 1000;
const SILENT_MS = 2 * HOUR_MS;
const T0 = 1_700_000_000_000;

function decoded(over: Partial<Decoded> = {}): Decoded {
  return { values: {}, readings: EMPTY_READINGS, ...over };
}

/** A state whose stored token is "a", heard at `heardAt`. */
function heardState(heardAt: number | undefined, since = T0): DeviceState {
  return {
    values: { sensor_source: "internal", active_group: 1 },
    readings: { ...EMPTY_READINGS, mode: "auto", setpoint: 19 },
    lifeToken: "a",
    heardAt,
    messageAt: heardAt ?? since,
    since,
  };
}

describe("observation", () => {
  describe("newState", () => {
    describe("Always", () => {
      it("values is empty, readings is EMPTY_READINGS, lifeToken, heardAt and messageAt are undefined", () => {
        const state = newState(T0);
        expect(state.values).toEqual({});
        expect(state.readings).toEqual(EMPTY_READINGS);
        expect(state.lifeToken).toBeUndefined();
        expect(state.heardAt).toBeUndefined();
        expect(state.messageAt).toBeUndefined();
      });
      it("since is now", () => {
        expect(newState(T0).since).toBe(T0);
      });
    });
  });

  describe("onMessage", () => {
    const now = T0 + HOUR_MS;
    describe("With a key that has a value", () => {
      it("the value replaces the stored one", () => {
        const [state] = onMessage(
          heardState(T0),
          decoded({ values: { sensor_source: "external" } }),
          "a",
          now,
          SILENT_MS,
        );
        expect(state.values.sensor_source).toBe("external");
      });
    });
    describe("With a key mapped to null", () => {
      it("the key is removed from values", () => {
        const [state] = onMessage(
          heardState(T0),
          decoded({ values: { active_group: null } }),
          "a",
          now,
          SILENT_MS,
        );
        expect(Object.hasOwn(state.values, "active_group")).toBe(false);
      });
    });
    describe("With a key absent from the message", () => {
      it("the stored value is kept", () => {
        const day = points("00:00/17 07:00/20");
        const [state] = onMessage(
          heardState(T0),
          decoded({ values: { day_mon: day } }),
          "a",
          now,
          SILENT_MS,
        );
        expect(state.values).toEqual({ sensor_source: "internal", active_group: 1, day_mon: day });
      });
    });
    describe("With new readings", () => {
      it("they are merged over the stored ones", () => {
        const [state] = onMessage(
          heardState(T0),
          decoded({ readings: { ...EMPTY_READINGS, setpoint: 21, battery: 70 } }),
          "a",
          now,
          SILENT_MS,
        );
        expect(state.readings).toEqual({
          ...EMPTY_READINGS,
          mode: "auto",
          setpoint: 21,
          battery: 70,
        });
      });
    });
    describe('With the first message after newState, carrying token "a"', () => {
      const [state] = onMessage(newState(T0), decoded(), "a", now, SILENT_MS);
      it("messageAt is now", () => {
        expect(state.messageAt).toBe(now);
      });
      it("heardAt stays undefined", () => {
        expect(state.heardAt).toBeUndefined();
      });
      it("the token is stored", () => {
        expect(state.lifeToken).toBe("a");
      });
    });
    describe("With a later message carrying the same token", () => {
      const [state] = onMessage(heardState(T0), decoded(), "a", now, SILENT_MS);
      it("heardAt is unchanged", () => {
        expect(state.heardAt).toBe(T0);
      });
      it("messageAt is now", () => {
        expect(state.messageAt).toBe(now);
      });
    });
    describe("With a later message carrying a different token", () => {
      it("heardAt is now", () => {
        const [state] = onMessage(heardState(T0), decoded(), "b", now, SILENT_MS);
        expect(state.heardAt).toBe(now);
      });
    });
    describe("With a message whose token is undefined", () => {
      const [state] = onMessage(heardState(T0), decoded(), undefined, now, SILENT_MS);
      it("heardAt is unchanged", () => {
        expect(state.heardAt).toBe(T0);
      });
      it("the stored token is unchanged", () => {
        expect(state.lifeToken).toBe("a");
      });
    });
    describe("With a device that was silent and a message with a new token", () => {
      it("the returned flag is true", () => {
        const late = T0 + 3 * HOUR_MS;
        const [, back] = onMessage(heardState(T0), decoded(), "b", late, SILENT_MS);
        expect(back).toBe(true);
      });
    });
    describe("With a device that was live or unknown and a message with a new token", () => {
      it("the returned flag is false", () => {
        const [, fromLive] = onMessage(heardState(T0), decoded(), "b", now, SILENT_MS);
        const unknown: DeviceState = { ...heardState(undefined), since: T0 };
        const [, fromUnknown] = onMessage(unknown, decoded(), "b", now, SILENT_MS);
        expect(fromLive).toBe(false);
        expect(fromUnknown).toBe(false);
      });
    });
    describe("With a device that was silent and a message that does not count as heard", () => {
      it("the returned flag is false", () => {
        const late = T0 + 3 * HOUR_MS;
        const [, same] = onMessage(heardState(T0), decoded(), "a", late, SILENT_MS);
        const [, none] = onMessage(heardState(T0), decoded(), undefined, late, SILENT_MS);
        const [, first] = onMessage(newState(T0), decoded(), "a", late, SILENT_MS);
        expect([same, none, first]).toEqual([false, false, false]);
      });
    });
  });

  describe("onLinkUp", () => {
    describe("Always", () => {
      const before = heardState(T0);
      const later = T0 + HOUR_MS;
      const state = onLinkUp(before, later);
      it("heardAt is undefined and since is now", () => {
        expect(state.heardAt).toBeUndefined();
        expect(state.since).toBe(later);
      });
      it("values, readings and messageAt are kept", () => {
        expect(state.values).toEqual(before.values);
        expect(state.readings).toEqual(before.readings);
        expect(state.messageAt).toBe(before.messageAt);
      });
      it("the next token is stored without counting as heard", () => {
        const [next] = onMessage(state, decoded(), "b", later + 1000, SILENT_MS);
        expect(next.heardAt).toBeUndefined();
        expect(next.lifeToken).toBe("b");
      });
    });
  });

  describe("liveness", () => {
    const now = T0 + 10 * HOUR_MS;
    describe("With heardAt 1 h ago and silentAfterMs 2 h", () => {
      it("returns live", () => {
        expect(liveness(heardState(now - HOUR_MS), now, SILENT_MS)).toBe("live");
      });
    });
    describe("With heardAt 3 h ago", () => {
      it("returns silent", () => {
        expect(liveness(heardState(now - 3 * HOUR_MS), now, SILENT_MS)).toBe("silent");
      });
    });
    describe("With nothing heard and since 1 h ago", () => {
      it("returns unknown", () => {
        expect(liveness(newState(now - HOUR_MS), now, SILENT_MS)).toBe("unknown");
      });
    });
    describe("With nothing heard and since 3 h ago", () => {
      it("returns silent", () => {
        expect(liveness(newState(now - 3 * HOUR_MS), now, SILENT_MS)).toBe("silent");
      });
    });
    describe("With heardAt exactly 2 h ago and silentAfterMs 2 h", () => {
      it("returns live", () => {
        expect(liveness(heardState(now - SILENT_MS), now, SILENT_MS)).toBe("live");
      });
    });
    describe("With nothing heard and since exactly 2 h ago", () => {
      it("returns unknown", () => {
        expect(liveness(newState(now - SILENT_MS), now, SILENT_MS)).toBe("unknown");
      });
    });
  });
});
