import { beforeAll, describe, expect, it } from "vitest";
import { START_TOKENS, mark, newValveMemory, noteHeard, type ValveMemory } from "./memory.ts";
import {
  BUCKET,
  charge,
  chargeAsk,
  mayAsk,
  maySpend,
  mayWrite,
  noteDesired,
  notHolding,
  spend,
} from "./pacing.ts";
import type { Group, GroupSpec, ValveSpec } from "./settings.ts";

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const T0 = 1_700_000_000_000;

function groupSpec(group: Group, readable: boolean): GroupSpec {
  return {
    group,
    evidence: readable ? "acked" : "echoed",
    maxAgeMs: DAY_MS,
    capture: readable,
    readable,
  };
}

/** Shaped like a TRV-ZBT: schedule unreadable, active_group and sensor_source readable. */
const TRV_ZBT: ValveSpec = {
  profile: "sonoff_trv_zbt",
  minTemp: 4,
  maxTemp: 35,
  tempStep: 0.5,
  maxSetPoints: 6,
  slotCount: 6,
  scheduleGroup: 3,
  groups: [
    groupSpec("schedule", false),
    groupSpec("active_group", true),
    groupSpec("sensor_source", true),
  ],
  activation: "setpoint",
  externalSensor: true,
  feedWhenOff: false,
};

/** A new memory with every mark removed. */
function unmarked(at = T0): ValveMemory {
  const vm = newValveMemory(TRV_ZBT, at);
  const groups = { ...vm.groups };
  for (const gs of TRV_ZBT.groups) {
    const gm = groups[gs.group];
    if (gm !== undefined) groups[gs.group] = { ...gm, mark: undefined };
  }
  return { ...vm, groups };
}

/** Unmarked writes of `group` at each of the given offsets from T0. */
function writes(offsets: readonly number[], group: Group = "sensor_source"): ValveMemory {
  return offsets.reduce((vm, offset) => charge(vm, group, T0 + offset, false), unmarked());
}

/** Asks at each of the given offsets from T0. */
function asks(offsets: readonly number[]): ValveMemory {
  return offsets.reduce((vm, offset) => chargeAsk(vm, TRV_ZBT, T0 + offset), unmarked());
}

/**
 * Twenty request times: every 37 min from T0, then the clock is set back 3 h after the twelfth
 * and the rest follow every 41 min from there.
 */
const HISTORY: readonly number[] = Array.from({ length: 20 }, (_, i) =>
  i < 12
    ? T0 + i * 37 * MINUTE_MS
    : T0 + 11 * 37 * MINUTE_MS - 3 * HOUR_MS + (i - 11) * 41 * MINUTE_MS,
);

/** Times around each request time and the backoff and window edges, and one before them all. */
function probes(times: readonly number[]): readonly number[] {
  const offsets = [
    -1,
    0,
    1,
    2 * MINUTE_MS,
    10 * MINUTE_MS,
    HOUR_MS,
    6 * HOUR_MS,
    DAY_MS,
    DAY_MS + 1,
  ];
  return [T0 - 2 * HOUR_MS, ...times.flatMap((t) => offsets.map((o) => t + o))];
}

/** Four tokens spent at T0, T0 + 2 s, T0 + 4 s and T0 + 6 s: none left at T0 + 8 s. */
function drained(): ValveMemory {
  return [0, 2, 4, 6].reduce((vm, s) => spend(vm, T0 + s * SECOND_MS), unmarked());
}

describe("pacing", () => {
  describe("mayWrite", () => {
    describe("With a new valve memory", () => {
      it("returns true", () => {
        expect(mayWrite(newValveMemory(TRV_ZBT, T0), "schedule", T0)).toBe(true);
      });
    });
    describe("Within 2 s of the last write, setpoint write or refresh to the valve", () => {
      it("returns false", () => {
        const now = T0 + SECOND_MS;
        expect(mayWrite(charge(unmarked(), "active_group", T0, false), "schedule", now)).toBe(
          false,
        );
        expect(mayWrite(spend(unmarked(), T0), "schedule", now)).toBe(false);
        expect(mayWrite(chargeAsk(unmarked(), TRV_ZBT, T0), "schedule", now)).toBe(false);
      });
    });
    describe("With no tokens left", () => {
      it("returns false", () => {
        expect(mayWrite(drained(), "schedule", T0 + 8 * SECOND_MS)).toBe(false);
      });
    });
    describe("With 1 write of this value 1 min ago", () => {
      it("returns false", () => {
        expect(mayWrite(writes([0]), "sensor_source", T0 + MINUTE_MS)).toBe(false);
      });
    });
    describe("With 1 write of this value 3 min ago", () => {
      it("returns true", () => {
        expect(mayWrite(writes([0]), "sensor_source", T0 + 3 * MINUTE_MS)).toBe(true);
      });
    });
    describe("With 2 writes, the last 5 min ago / 11 min ago", () => {
      it("returns false / true", () => {
        const last = 3 * MINUTE_MS;
        const vm = writes([0, last]);
        expect(mayWrite(vm, "sensor_source", T0 + last + 5 * MINUTE_MS)).toBe(false);
        expect(mayWrite(vm, "sensor_source", T0 + last + 11 * MINUTE_MS)).toBe(true);
      });
    });
    describe("With 3 writes, the last 30 min ago / 61 min ago", () => {
      it("returns false / true", () => {
        const last = 14 * MINUTE_MS;
        const vm = writes([0, 3 * MINUTE_MS, last]);
        expect(mayWrite(vm, "sensor_source", T0 + last + 30 * MINUTE_MS)).toBe(false);
        expect(mayWrite(vm, "sensor_source", T0 + last + 61 * MINUTE_MS)).toBe(true);
      });
    });
    describe("With 4 or more writes, the last 5 h ago / 7 h ago", () => {
      it("returns false / true", () => {
        const four = [0, 3 * MINUTE_MS, 14 * MINUTE_MS, 75 * MINUTE_MS];
        const five = [...four, 75 * MINUTE_MS + 7 * HOUR_MS];
        for (const offsets of [four, five]) {
          const last = offsets[offsets.length - 1] ?? 0;
          const vm = writes(offsets);
          expect(mayWrite(vm, "sensor_source", T0 + last + 5 * HOUR_MS)).toBe(false);
          expect(mayWrite(vm, "sensor_source", T0 + last + 7 * HOUR_MS)).toBe(true);
        }
      });
    });
    describe("With writes older than 24 h only", () => {
      it("returns true", () => {
        const last = 75 * MINUTE_MS;
        const vm = writes([0, 3 * MINUTE_MS, 14 * MINUTE_MS, last]);
        expect(mayWrite(vm, "sensor_source", T0 + last + DAY_MS + 1)).toBe(true);
      });
    });
    describe("With unmarked writes at 0, 2 min, 12 min and 20 h", () => {
      const vm = writes([0, 2 * MINUTE_MS, 12 * MINUTE_MS, 20 * HOUR_MS]);
      it("returns false at exactly 24 h: the write at 0 is still in the window, count 4, step 6 h, last 4 h ago", () => {
        expect(mayWrite(vm, "sensor_source", T0 + DAY_MS)).toBe(false);
      });
      it("returns true at 24 h + 1 ms: the write at 0 has left the window, count 3, step 1 h", () => {
        expect(mayWrite(vm, "sensor_source", T0 + DAY_MS + 1)).toBe(true);
      });
    });
    describe("With another group written 1 min ago and this group never", () => {
      it("returns true", () => {
        expect(mayWrite(writes([0], "active_group"), "sensor_source", T0 + MINUTE_MS)).toBe(true);
      });
    });
    describe("With a new valve memory and nowMs 1 h before its tokensAt (the clock was set back)", () => {
      const vm = newValveMemory(TRV_ZBT, T0);
      const now = T0 - HOUR_MS;
      it("returns true", () => {
        expect(mayWrite(vm, "schedule", now)).toBe(true);
      });
      it("charge then leaves START_TOKENS − 1 tokens: none was lost to the negative time", () => {
        expect(charge(vm, "schedule", now, true).tokens).toBe(START_TOKENS - 1);
      });
    });
    describe("With nowMs 1 h before the last write", () => {
      it("returns false: zero elapsed is under the spacing", () => {
        expect(mayWrite(writes([0], "active_group"), "schedule", T0 - HOUR_MS)).toBe(false);
      });
    });
  });

  describe("noteDesired", () => {
    const old = [0, 3 * MINUTE_MS, 14 * MINUTE_MS].reduce(
      (vm, offset) => charge(vm, "sensor_source", T0 + offset, false),
      noteDesired(unmarked(), "sensor_source", "internal"),
    );
    describe("With a new desired key after 3 writes of the old one", () => {
      it("writes is empty and mayWrite returns true", () => {
        const vm = noteDesired(old, "sensor_source", "external");
        expect(vm.groups.sensor_source?.writes).toEqual([]);
        expect(vm.groups.sensor_source?.desiredKey).toBe("external");
        expect(mayWrite(vm, "sensor_source", T0 + 15 * MINUTE_MS)).toBe(true);
      });
    });
    describe("With the same desired key", () => {
      it("writes is unchanged", () => {
        const vm = noteDesired(old, "sensor_source", "internal");
        expect(vm.groups.sensor_source?.writes).toEqual(old.groups.sensor_source?.writes);
      });
    });
  });

  describe("charge", () => {
    describe("Always", () => {
      const before = chargeAsk(unmarked(), TRV_ZBT, T0);
      const now = T0 + 3 * MINUTE_MS;
      const vm = charge(before, "sensor_source", now, false);
      it("one token is taken, lastWriteAt is now, and a WriteRecord is appended", () => {
        expect(vm.tokens).toBeCloseTo(START_TOKENS - 2 + 3 / 30, 9);
        expect(vm.tokensAt).toBe(now);
        expect(vm.lastWriteAt).toBe(now);
        expect(vm.groups.sensor_source?.writes).toEqual([{ at: now, marked: false }]);
      });
      it("asks is unchanged", () => {
        expect(vm.asks).toEqual(before.asks);
      });
    });
    describe("With marked true", () => {
      it("the group's mark has writtenAt now", () => {
        const vm = charge(newValveMemory(TRV_ZBT, T0), "schedule", T0 + MINUTE_MS, true);
        expect(vm.groups.schedule?.mark).toEqual({
          at: T0,
          askedAt: undefined,
          writtenAt: T0 + MINUTE_MS,
        });
      });
    });
    describe("With marked true on a group that has no mark", () => {
      it("no mark is created", () => {
        const vm = charge(unmarked(), "schedule", T0, true);
        expect(vm.groups.schedule?.mark).toBeUndefined();
      });
    });
    describe("With marked false on a marked group", () => {
      it("the mark is unchanged", () => {
        const before = newValveMemory(TRV_ZBT, T0);
        const vm = charge(before, "schedule", T0 + MINUTE_MS, false);
        expect(vm.groups.schedule?.mark).toEqual(before.groups.schedule?.mark);
      });
    });
    describe("After many writes, one of them after the clock was set back", () => {
      const full = HISTORY.map((at, i) => ({ at, marked: i % 3 === 0 }));
      const pruned = full.reduce(
        (vm, w) => charge(vm, "sensor_source", w.at, w.marked),
        unmarked(T0 - DAY_MS),
      );
      const gm = pruned.groups.sensor_source;
      if (gm === undefined) throw new Error("no sensor_source");
      const unpruned: ValveMemory = {
        ...pruned,
        groups: { ...pruned.groups, sensor_source: { ...gm, writes: full } },
      };
      it("keeps at most 7 write records: the newest 4 and the newest 3 unmarked, by at", () => {
        const kept = gm.writes;
        expect(kept.length).toBeLessThanOrEqual(7);
        const byAt = [...full].sort((a, b) => a.at - b.at);
        const want = new Set([...byAt.slice(-4), ...byAt.filter((w) => !w.marked).slice(-3)]);
        expect([...kept].sort((a, b) => a.at - b.at)).toEqual(byAt.filter((w) => want.has(w)));
      });
      it("mayWrite and notHolding answer as with the whole history, at every probe time", () => {
        for (const now of probes(HISTORY)) {
          expect(mayWrite(pruned, "sensor_source", now)).toBe(
            mayWrite(unpruned, "sensor_source", now),
          );
          expect(notHolding(pruned, now)).toEqual(notHolding(unpruned, now));
        }
      });
    });
    describe("After 30 min without writes", () => {
      it("one token has come back, up to BUCKET", () => {
        const once = charge(unmarked(), "schedule", T0, false);
        expect(charge(once, "schedule", T0 + 30 * MINUTE_MS, false).tokens).toBe(START_TOKENS - 1);
        const full = { ...unmarked(), tokens: BUCKET };
        expect(charge(full, "schedule", T0 + 30 * MINUTE_MS, false).tokens).toBe(BUCKET - 1);
      });
    });
  });

  describe("notHolding", () => {
    describe("With unmarked writes at 0, 2 min, 12 min and 20 h", () => {
      const vm = writes([0, 2 * MINUTE_MS, 12 * MINUTE_MS, 20 * HOUR_MS]);
      it("lists the group at exactly 24 h + 2 min: three writes are still in the window", () => {
        expect(notHolding(vm, T0 + DAY_MS + 2 * MINUTE_MS)).toEqual(["sensor_source"]);
      });
      it("does not list the group at 24 h + 2 min + 1 ms: two writes are left", () => {
        expect(notHolding(vm, T0 + DAY_MS + 2 * MINUTE_MS + 1)).toEqual([]);
      });
    });
    describe("With 3 unmarked writes of the same value in 24 h", () => {
      it("lists the group", () => {
        const vm = writes([0, 3 * MINUTE_MS, 14 * MINUTE_MS]);
        expect(notHolding(vm, T0 + HOUR_MS)).toEqual(["sensor_source"]);
      });
    });
    describe("With 2 unmarked writes and 2 marked ones", () => {
      it("does not list the group", () => {
        const offsets = [0, 3 * MINUTE_MS, 14 * MINUTE_MS, 75 * MINUTE_MS];
        const vm = offsets.reduce(
          (acc, offset, i) => charge(acc, "sensor_source", T0 + offset, i % 2 === 0),
          unmarked(),
        );
        expect(notHolding(vm, T0 + 2 * HOUR_MS)).toEqual([]);
      });
    });
    describe("After the desired value changed", () => {
      it("does not list the group", () => {
        const vm = noteDesired(writes([0, 3 * MINUTE_MS, 14 * MINUTE_MS]), "sensor_source", "x");
        expect(notHolding(vm, T0 + HOUR_MS)).toEqual([]);
      });
    });
  });

  describe("maySpend", () => {
    describe("With a new valve memory", () => {
      it("returns true", () => {
        expect(maySpend(newValveMemory(TRV_ZBT, T0), T0)).toBe(true);
      });
    });
    describe("Within 2 s of the last write, or with no tokens", () => {
      it("returns false", () => {
        expect(maySpend(writes([0]), T0 + SECOND_MS)).toBe(false);
        expect(maySpend(drained(), T0 + 8 * SECOND_MS)).toBe(false);
      });
    });
  });

  describe("spend", () => {
    describe("Always", () => {
      it("one token is taken, lastWriteAt is now, and no WriteRecord is added", () => {
        const before = unmarked();
        const vm = spend(before, T0);
        expect(vm.tokens).toBe(START_TOKENS - 1);
        expect(vm.lastWriteAt).toBe(T0);
        expect(vm.groups).toEqual(before.groups);
      });
    });
  });

  describe("mayAsk", () => {
    describe("With a new valve memory", () => {
      it("returns true", () => {
        expect(mayAsk(newValveMemory(TRV_ZBT, T0), T0)).toBe(true);
      });
    });
    describe("Within 2 s of the last write, setpoint write or refresh", () => {
      it("returns false", () => {
        const now = T0 + SECOND_MS;
        expect(mayAsk(writes([0]), now)).toBe(false);
        expect(mayAsk(spend(unmarked(), T0), now)).toBe(false);
        expect(mayAsk(asks([0]), now)).toBe(false);
      });
    });
    describe("With no tokens left", () => {
      it("returns false", () => {
        expect(mayAsk(drained(), T0 + 8 * SECOND_MS)).toBe(false);
      });
    });
    describe("With 1 ask, 1 min ago / 3 min ago", () => {
      it("returns false / true", () => {
        expect(mayAsk(asks([0]), T0 + MINUTE_MS)).toBe(false);
        expect(mayAsk(asks([0]), T0 + 3 * MINUTE_MS)).toBe(true);
      });
    });
    describe("With 2 asks, the last 5 min ago / 11 min ago", () => {
      it("returns false / true", () => {
        const last = 3 * MINUTE_MS;
        const vm = asks([0, last]);
        expect(mayAsk(vm, T0 + last + 5 * MINUTE_MS)).toBe(false);
        expect(mayAsk(vm, T0 + last + 11 * MINUTE_MS)).toBe(true);
      });
    });
    describe("With 3 asks, the last 30 min ago / 61 min ago", () => {
      it("returns false / true", () => {
        const last = 14 * MINUTE_MS;
        const vm = asks([0, 3 * MINUTE_MS, last]);
        expect(mayAsk(vm, T0 + last + 30 * MINUTE_MS)).toBe(false);
        expect(mayAsk(vm, T0 + last + 61 * MINUTE_MS)).toBe(true);
      });
    });
    describe("With 4 or more asks, the last 5 h ago / 7 h ago", () => {
      it("returns false / true", () => {
        const four = [0, 3 * MINUTE_MS, 14 * MINUTE_MS, 75 * MINUTE_MS];
        const five = [...four, 75 * MINUTE_MS + 7 * HOUR_MS];
        for (const offsets of [four, five]) {
          const last = offsets[offsets.length - 1] ?? 0;
          const vm = asks(offsets);
          expect(mayAsk(vm, T0 + last + 5 * HOUR_MS)).toBe(false);
          expect(mayAsk(vm, T0 + last + 7 * HOUR_MS)).toBe(true);
        }
      });
    });
    describe("With 4 asks, the first 30 h ago and the last 5 h ago", () => {
      it("returns false (asks are not dropped by age)", () => {
        const vm = asks([0, 3 * MINUTE_MS, 14 * MINUTE_MS, 25 * HOUR_MS]);
        expect(mayAsk(vm, T0 + 30 * HOUR_MS)).toBe(false);
      });
    });
    describe("With an ask 1 min ago and then noteHeard", () => {
      it("returns true", () => {
        expect(mayAsk(noteHeard(asks([0])), T0 + MINUTE_MS)).toBe(true);
      });
    });
  });

  describe("chargeAsk", () => {
    describe("Always", () => {
      const before = unmarked();
      const vm = chargeAsk(before, TRV_ZBT, T0);
      it("one token is taken, lastWriteAt is now, and now is appended to asks", () => {
        expect(vm.tokens).toBe(START_TOKENS - 1);
        expect(vm.lastWriteAt).toBe(T0);
        expect(chargeAsk(vm, TRV_ZBT, T0 + 3 * MINUTE_MS).asks).toEqual([T0, T0 + 3 * MINUTE_MS]);
      });
      it("no WriteRecord is added to any group", () => {
        for (const gs of TRV_ZBT.groups) {
          expect(vm.groups[gs.group]?.writes).toEqual([]);
        }
      });
    });
    describe("With a marked readable group", () => {
      it("its mark has askedAt now", () => {
        const vm = chargeAsk(newValveMemory(TRV_ZBT, T0), TRV_ZBT, T0 + MINUTE_MS);
        expect(vm.groups.sensor_source?.mark).toEqual({
          at: T0,
          askedAt: T0 + MINUTE_MS,
          writtenAt: undefined,
        });
      });
    });
    describe("With a marked readable group that was asked before", () => {
      it("its askedAt is replaced by now", () => {
        const once = chargeAsk(newValveMemory(TRV_ZBT, T0), TRV_ZBT, T0);
        const vm = chargeAsk(once, TRV_ZBT, T0 + 3 * MINUTE_MS);
        expect(vm.groups.active_group?.mark?.askedAt).toBe(T0 + 3 * MINUTE_MS);
      });
    });
    describe("With a marked unreadable group", () => {
      it("its mark is unchanged", () => {
        const before = newValveMemory(TRV_ZBT, T0);
        const vm = chargeAsk(before, TRV_ZBT, T0 + MINUTE_MS);
        expect(vm.groups.schedule?.mark).toEqual(before.groups.schedule?.mark);
      });
    });
    describe("After many asks, one of them after the clock was set back", () => {
      const pruned = HISTORY.reduce((vm, at) => chargeAsk(vm, TRV_ZBT, at), unmarked(T0 - DAY_MS));
      const unpruned: ValveMemory = { ...pruned, asks: HISTORY };
      it("keeps the newest 4 asks, by time", () => {
        expect([...pruned.asks].sort((a, b) => a - b)).toEqual(
          [...HISTORY].sort((a, b) => a - b).slice(-4),
        );
      });
      it("mayAsk answers as with the whole history, at every probe time", () => {
        for (const now of probes(HISTORY)) {
          expect(mayAsk(pruned, now)).toBe(mayAsk(unpruned, now));
        }
      });
    });
    describe("With a readable group that has no mark", () => {
      it("no mark is created", () => {
        const vm = chargeAsk(mark(unmarked(), ["schedule"], T0), TRV_ZBT, T0 + MINUTE_MS);
        expect(vm.groups.sensor_source?.mark).toBeUndefined();
      });
    });
  });

  describe("budget", () => {
    const seconds = Array.from({ length: 86_401 }, (_, s) => s);
    const backoffTimes = [0, 120, 720, 4320, 25_920, 47_520, 69_120];

    describe("With one group whose value never takes, written whenever mayWrite allows, for t = 0 s … 86 400 s inclusive, from a new memory", () => {
      it("the writes fall at 0, 2 min, 12 min, 1 h 12 min, 7 h 12 min, 13 h 12 min and 19 h 12 min: 7 in all", () => {
        let vm = newValveMemory(TRV_ZBT, T0);
        const at: number[] = [];
        for (const s of seconds) {
          const now = T0 + s * SECOND_MS;
          if (mayWrite(vm, "sensor_source", now)) {
            vm = charge(vm, "sensor_source", now, false);
            at.push(s);
          }
        }
        expect(at).toEqual(backoffTimes);
      });
    });

    describe("With a valve that is never heard, asked whenever mayAsk allows, for t = 0 s … 86 400 s inclusive, from a new memory", () => {
      it("the asks fall at the same seven times: 7 in all", () => {
        let vm = newValveMemory(TRV_ZBT, T0);
        const at: number[] = [];
        for (const s of seconds) {
          const now = T0 + s * SECOND_MS;
          if (mayAsk(vm, now)) {
            vm = chargeAsk(vm, TRV_ZBT, now);
            at.push(s);
          }
        }
        expect(at).toEqual(backoffTimes);
      });
    });

    describe("With a TRV-ZBT spec, a valve that never answers and never takes a write, and every ask and write the rules allow taken second by second for t = 0 s … 86 400 s inclusive, from a new memory", () => {
      let askCount = 0;
      let total = 0;
      const writeCount: Partial<Record<Group, number>> = {};
      beforeAll(() => {
        let vm = newValveMemory(TRV_ZBT, T0);
        for (const s of seconds) {
          const now = T0 + s * SECOND_MS;
          if (mayAsk(vm, now)) {
            vm = chargeAsk(vm, TRV_ZBT, now);
            askCount += 1;
          }
          for (const gs of TRV_ZBT.groups) {
            if (mayWrite(vm, gs.group, now)) {
              const marked = vm.groups[gs.group]?.mark !== undefined;
              vm = charge(vm, gs.group, now, marked);
              writeCount[gs.group] = (writeCount[gs.group] ?? 0) + 1;
            }
          }
        }
        total = askCount + Object.values(writeCount).reduce((a, b) => a + b, 0);
      });
      it("at most START_TOKENS + 48 = 52 asks and writes together", () => {
        expect(total).toBeLessThanOrEqual(START_TOKENS + 48);
      });
      it("at most 7 writes per group", () => {
        for (const gs of TRV_ZBT.groups) {
          expect(writeCount[gs.group] ?? 0).toBeLessThanOrEqual(7);
        }
      });
      it("at most 7 asks", () => {
        expect(askCount).toBeLessThanOrEqual(7);
      });
    });

    describe("With a token spent every time maySpend allows (maySpend, then spend), second by second for t = 0 s … 86 400 s inclusive, from a new memory", () => {
      it("exactly 52 are spent: at 0, 2, 4 and 6 s, then one every 30 min from 30 min to 24 h", () => {
        let vm = newValveMemory(TRV_ZBT, T0);
        const at: number[] = [];
        for (const s of seconds) {
          const now = T0 + s * SECOND_MS;
          if (maySpend(vm, now)) {
            vm = spend(vm, now);
            at.push(s);
          }
        }
        const expected = [0, 2, 4, 6, ...Array.from({ length: 48 }, (_, k) => (k + 1) * 1800)];
        expect(at).toHaveLength(52);
        expect(at).toEqual(expected);
      });
    });
  });
});
