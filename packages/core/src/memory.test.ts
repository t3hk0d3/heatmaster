import { describe, expect, it } from "vitest";
import {
  START_TOKENS,
  clearMarks,
  mark,
  markByAge,
  markedReady,
  needsAsk,
  newValveMemory,
  noteHeard,
  type GroupMemory,
  type ValveMemory,
} from "./memory.ts";
import { charge, chargeAsk } from "./pacing.ts";
import type { Group, GroupSpec, ValveSpec } from "./settings.ts";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const T0 = 1_700_000_000_000;

function groupSpec(group: Group, readable: boolean, maxAgeMs: number | undefined): GroupSpec {
  return { group, evidence: readable ? "acked" : "echoed", maxAgeMs, capture: readable, readable };
}

function valveSpec(groups: readonly GroupSpec[]): ValveSpec {
  return {
    profile: "test",
    minTemp: 4,
    maxTemp: 35,
    tempStep: 0.5,
    maxSetPoints: 6,
    slotCount: 6,
    scheduleGroup: 3,
    groups,
    activation: "setpoint",
    externalSensor: true,
    feedWhenOff: false,
  };
}

/** schedule unreadable, active_group and sensor_source readable, all with a 24 h maximum age. */
const SPEC = valveSpec([
  groupSpec("schedule", false, DAY_MS),
  groupSpec("active_group", true, DAY_MS),
  groupSpec("sensor_source", true, DAY_MS),
]);

/** A memory created at T0 whose marks were all cleared at T0, so nothing is marked. */
function unmarked(spec: ValveSpec = SPEC, at = T0): ValveMemory {
  const vm = newValveMemory(spec, at);
  const groups: Partial<Record<Group, GroupMemory>> = {};
  for (const [group, gm] of Object.entries(vm.groups) as [Group, GroupMemory][]) {
    groups[group] = { ...gm, mark: undefined };
  }
  return { ...vm, groups };
}

describe("memory", () => {
  describe("newValveMemory", () => {
    describe("Always", () => {
      const vm = newValveMemory(SPEC, T0);
      it("tokens is START_TOKENS (4) and tokensAt is now", () => {
        expect(START_TOKENS).toBe(4);
        expect(vm.tokens).toBe(START_TOKENS);
        expect(vm.tokensAt).toBe(T0);
      });
      it("every group of the spec is marked at now, with no askedAt and no writtenAt", () => {
        for (const gs of SPEC.groups) {
          expect(vm.groups[gs.group]?.mark).toEqual({
            at: T0,
            askedAt: undefined,
            writtenAt: undefined,
          });
        }
      });
      it("every group's assertedAt is now, its writes are empty and its desiredKey is undefined", () => {
        for (const gs of SPEC.groups) {
          const gm = vm.groups[gs.group];
          expect(gm?.assertedAt).toBe(T0);
          expect(gm?.writes).toEqual([]);
          expect(gm?.desiredKey).toBeUndefined();
        }
      });
      it("asks is empty, nudgeDue is false, and lastWriteAt, feedValue, feedAt, lastPushAt, feedLostSince and equalSince are undefined", () => {
        expect(vm.asks).toEqual([]);
        expect(vm.nudgeDue).toBe(false);
        expect(vm.lastWriteAt).toBeUndefined();
        expect(vm.feedValue).toBeUndefined();
        expect(vm.feedAt).toBeUndefined();
        expect(vm.lastPushAt).toBeUndefined();
        expect(vm.feedLostSince).toBeUndefined();
        expect(vm.equalSince).toBeUndefined();
      });
    });
    describe("With a spec that has no sensor_source group", () => {
      it("groups has no sensor_source entry", () => {
        const spec = valveSpec([groupSpec("schedule", false, DAY_MS)]);
        const vm = newValveMemory(spec, T0);
        expect(Object.keys(vm.groups)).toEqual(["schedule"]);
        expect(vm.groups.sensor_source).toBeUndefined();
      });
    });
  });

  describe("mark", () => {
    const now = T0 + HOUR_MS;
    describe("On a group with no mark", () => {
      it("the group has a mark at now with no askedAt and no writtenAt", () => {
        const vm = mark(unmarked(), ["schedule"], now);
        expect(vm.groups.schedule?.mark).toEqual({
          at: now,
          askedAt: undefined,
          writtenAt: undefined,
        });
      });
    });
    describe("On a group whose mark was already asked or written", () => {
      it("the mark is replaced by a fresh one", () => {
        const asked = chargeAsk(newValveMemory(SPEC, T0), SPEC, T0 + MINUTE_MS);
        const written = charge(newValveMemory(SPEC, T0), "schedule", T0 + MINUTE_MS, true);
        expect(mark(asked, ["sensor_source"], now).groups.sensor_source?.mark).toEqual({
          at: now,
          askedAt: undefined,
          writtenAt: undefined,
        });
        expect(mark(written, ["schedule"], now).groups.schedule?.mark).toEqual({
          at: now,
          askedAt: undefined,
          writtenAt: undefined,
        });
      });
    });
    describe("On a group whose mark has neither askedAt nor writtenAt", () => {
      it("the mark is kept as it is: its at does not move", () => {
        const vm = mark(newValveMemory(SPEC, T0), ["schedule"], now);
        expect(vm.groups.schedule?.mark?.at).toBe(T0);
      });
    });
    describe("On a group the memory does not hold", () => {
      it("the memory is unchanged", () => {
        const spec = valveSpec([groupSpec("schedule", false, DAY_MS)]);
        const vm = unmarked(spec);
        expect(mark(vm, ["sensor_source"], now)).toEqual(vm);
      });
    });
    describe("With two groups named", () => {
      it("both are marked and the others are untouched", () => {
        const before = unmarked();
        const vm = mark(before, ["schedule", "sensor_source"], now);
        expect(vm.groups.schedule?.mark?.at).toBe(now);
        expect(vm.groups.sensor_source?.mark?.at).toBe(now);
        expect(vm.groups.active_group).toEqual(before.groups.active_group);
      });
    });
  });

  describe("markByAge", () => {
    describe("With a maxAgeMs of 24 h and assertedAt 25 h ago", () => {
      it("the group is marked at now", () => {
        const now = T0 + 25 * HOUR_MS;
        const vm = markByAge(unmarked(), SPEC, now);
        expect(vm.groups.schedule?.mark?.at).toBe(now);
      });
    });
    describe("With assertedAt exactly 24 h ago", () => {
      it("the group is marked", () => {
        const now = T0 + DAY_MS;
        const vm = markByAge(unmarked(), SPEC, now);
        expect(vm.groups.schedule?.mark?.at).toBe(now);
      });
    });
    describe("With assertedAt 23 h ago", () => {
      it("the group is not marked", () => {
        const vm = markByAge(unmarked(), SPEC, T0 + 23 * HOUR_MS);
        expect(vm.groups.schedule?.mark).toBeUndefined();
      });
    });
    describe("With maxAgeMs undefined", () => {
      it("the group is never marked", () => {
        const spec = valveSpec([groupSpec("schedule", false, undefined)]);
        const vm = markByAge(unmarked(spec), spec, T0 + 365 * DAY_MS);
        expect(vm.groups.schedule?.mark).toBeUndefined();
      });
    });
    describe("With a group that is already marked", () => {
      it("its mark is kept as it is", () => {
        const asked = chargeAsk(newValveMemory(SPEC, T0), SPEC, T0 + MINUTE_MS);
        const vm = markByAge(asked, SPEC, T0 + 25 * HOUR_MS);
        expect(vm.groups.sensor_source?.mark).toEqual(asked.groups.sensor_source?.mark);
      });
    });
  });

  describe("noteHeard", () => {
    describe("With two asks recorded", () => {
      const before = chargeAsk(
        chargeAsk(newValveMemory(SPEC, T0), SPEC, T0),
        SPEC,
        T0 + 3 * MINUTE_MS,
      );
      const vm = noteHeard(before);
      it("asks is empty", () => {
        expect(before.asks).toHaveLength(2);
        expect(vm.asks).toEqual([]);
      });
      it("marks, tokens and lastWriteAt are unchanged", () => {
        expect(vm.groups).toEqual(before.groups);
        expect(vm.tokens).toBe(before.tokens);
        expect(vm.lastWriteAt).toBe(before.lastWriteAt);
      });
    });
  });

  describe("clearMarks", () => {
    const heardAt = T0 + 10 * MINUTE_MS;
    describe("With a readable group asked before heardAt", () => {
      it("the mark is removed and assertedAt is heardAt", () => {
        const vm = clearMarks(chargeAsk(newValveMemory(SPEC, T0), SPEC, T0), SPEC, heardAt);
        expect(vm.groups.sensor_source?.mark).toBeUndefined();
        expect(vm.groups.sensor_source?.assertedAt).toBe(heardAt);
      });
    });
    describe("With a readable group marked and not asked", () => {
      it("the mark stays", () => {
        const vm = clearMarks(newValveMemory(SPEC, T0), SPEC, heardAt);
        expect(vm.groups.sensor_source?.mark?.at).toBe(T0);
      });
    });
    describe("With a readable group asked at exactly heardAt", () => {
      it("the mark stays", () => {
        const vm = clearMarks(chargeAsk(newValveMemory(SPEC, T0), SPEC, heardAt), SPEC, heardAt);
        expect(vm.groups.sensor_source?.mark?.askedAt).toBe(heardAt);
      });
    });
    describe("With a readable group whose mark has a writtenAt before heardAt and no askedAt", () => {
      it("the mark stays", () => {
        const vm = clearMarks(
          charge(newValveMemory(SPEC, T0), "sensor_source", T0, true),
          SPEC,
          heardAt,
        );
        expect(vm.groups.sensor_source?.mark?.writtenAt).toBe(T0);
      });
    });
    describe("With an unreadable group written before heardAt", () => {
      it("the mark is removed and assertedAt is heardAt", () => {
        const vm = clearMarks(
          charge(newValveMemory(SPEC, T0), "schedule", T0, true),
          SPEC,
          heardAt,
        );
        expect(vm.groups.schedule?.mark).toBeUndefined();
        expect(vm.groups.schedule?.assertedAt).toBe(heardAt);
      });
    });
    describe("With an unreadable group marked and not written", () => {
      it("the mark stays", () => {
        const vm = clearMarks(chargeAsk(newValveMemory(SPEC, T0), SPEC, T0), SPEC, heardAt);
        expect(vm.groups.schedule?.mark?.at).toBe(T0);
      });
    });
    describe("With an unreadable group written after heardAt", () => {
      it("the mark stays", () => {
        const written = charge(newValveMemory(SPEC, T0), "schedule", heardAt + 1, true);
        const vm = clearMarks(written, SPEC, heardAt);
        expect(vm.groups.schedule?.mark?.writtenAt).toBe(heardAt + 1);
      });
    });
    describe("With a group that has no mark", () => {
      it("its assertedAt is unchanged", () => {
        const vm = clearMarks(unmarked(), SPEC, heardAt);
        expect(vm.groups.schedule?.assertedAt).toBe(T0);
        expect(vm.groups.sensor_source?.assertedAt).toBe(T0);
      });
    });
  });

  describe("markedReady", () => {
    const vm = newValveMemory(SPEC, T0);
    describe("With an unreadable group marked and the valve heard after the marking", () => {
      it("returns true", () => {
        expect(markedReady(vm, SPEC, "schedule", T0 + 1)).toBe(true);
      });
    });
    describe("With an unreadable group marked and the valve heard exactly at the marking", () => {
      it("returns true", () => {
        expect(markedReady(vm, SPEC, "schedule", T0)).toBe(true);
      });
    });
    describe("With an unreadable group marked and the valve last heard before the marking, or never", () => {
      it("returns false", () => {
        expect(markedReady(vm, SPEC, "schedule", T0 - 1)).toBe(false);
        expect(markedReady(vm, SPEC, "schedule", undefined)).toBe(false);
      });
    });
    describe("With an unreadable group marked, written, and the valve heard between the marking and the write", () => {
      it("returns true", () => {
        const written = charge(vm, "schedule", T0 + MINUTE_MS, true);
        expect(markedReady(written, SPEC, "schedule", T0 + 30 * 1000)).toBe(true);
      });
    });
    describe("With a readable group marked and the valve heard after the marking", () => {
      it("returns false", () => {
        expect(markedReady(vm, SPEC, "sensor_source", T0 + 1)).toBe(false);
      });
    });
    describe("With a group that has no mark", () => {
      it("returns false", () => {
        expect(markedReady(unmarked(), SPEC, "schedule", T0 + 1)).toBe(false);
      });
    });
  });

  describe("needsAsk", () => {
    const onlySchedule = mark(unmarked(), ["schedule"], T0 + MINUTE_MS);
    describe("With a readable group marked and not asked", () => {
      it("returns true", () => {
        const vm = mark(unmarked(), ["sensor_source"], T0 + MINUTE_MS);
        expect(needsAsk(vm, SPEC, T0 + HOUR_MS)).toBe(true);
      });
    });
    describe("With a readable group marked and asked", () => {
      it("returns true", () => {
        const vm = chargeAsk(
          mark(unmarked(), ["sensor_source"], T0 + MINUTE_MS),
          SPEC,
          T0 + HOUR_MS,
        );
        expect(needsAsk(vm, SPEC, T0 + 2 * HOUR_MS)).toBe(true);
      });
    });
    describe("With only an unreadable group marked and the valve never heard", () => {
      it("returns true", () => {
        expect(needsAsk(onlySchedule, SPEC, undefined)).toBe(true);
      });
    });
    describe("With only an unreadable group marked and the valve last heard before the marking", () => {
      it("returns true", () => {
        expect(needsAsk(onlySchedule, SPEC, T0)).toBe(true);
      });
    });
    describe("With only an unreadable group marked and the valve heard at or after the marking", () => {
      it("returns false", () => {
        expect(needsAsk(onlySchedule, SPEC, T0 + MINUTE_MS)).toBe(false);
        expect(needsAsk(onlySchedule, SPEC, T0 + HOUR_MS)).toBe(false);
      });
    });
    describe("With no group marked", () => {
      it("returns false", () => {
        expect(needsAsk(unmarked(), SPEC, undefined)).toBe(false);
      });
    });
  });
});
