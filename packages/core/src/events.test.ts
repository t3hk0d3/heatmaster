import { describe, expect, it } from "vitest";
import { TRV_ZBT_THERMOSTAT } from "./profiles/sonoff-trv-zbt.ts";
import { applyEvent } from "./events.ts";
import type { Event, Inbox } from "./events.ts";
import { VALVE_SILENT_AFTER_MS, newState } from "./observation.ts";
import type { Decoded, DeviceState } from "./observation.ts";
import { EMPTY_MEMORY, newValveMemory } from "./memory.ts";
import { REFILL_MS, SPACING_MS, importBucket, mayAsk, maySpend } from "./pacing.ts";
import type { GroupMemory, Mark, Memory, ValveMemory } from "./memory.ts";
import { EMPTY_READINGS } from "./settings.ts";
import type { Group, GroupSpec, ValveSpec } from "./settings.ts";

const T0 = 1_700_000_000_000;
const SECOND_MS = 1000;
const GROUPS: readonly Group[] = ["schedule", "active_group", "sensor_source"];

function groupSpec(group: Group, readable: boolean): GroupSpec {
  return {
    group,
    evidence: readable ? "acked" : "echoed",
    maxAgeMs: undefined,
    capture: readable,
    readable,
    atomic: false,
  };
}

const SPEC: ValveSpec = {
  profile: "test",
  minTemp: 4,
  maxTemp: 35,
  frostMinTemp: 4,
  frostMaxTemp: 35,
  tempStep: 0.5,
  maxSetPoints: 6,
  slotCount: 6,
  scheduleGroup: 3,
  groups: [
    groupSpec("schedule", false),
    groupSpec("active_group", true),
    groupSpec("sensor_source", true),
  ],
  activation: "none",
  externalSensor: true,
  feedWhenOff: false,
  thermostat: TRV_ZBT_THERMOSTAT,
};

const Z1 = "z2m:0x01";
const Z2 = "z2m:0x02";
const SENSOR = "z2m:0x99";
const OTHER = "other:0x01";
const SPECS: ReadonlyMap<string, ValveSpec> = new Map([
  [Z1, SPEC],
  [Z2, SPEC],
  [OTHER, SPEC],
]);

const DECODED: Decoded = { values: {}, readings: EMPTY_READINGS };
const DECODED_RICH: Decoded = {
  values: { sensor_source: "external" },
  readings: { ...EMPTY_READINGS, setpoint: 21 },
};

/** A device heard at `heardAt` with a stored life token. */
function live(heardAt: number, token = "t0"): DeviceState {
  return { ...newState(heardAt), lifeToken: token, heardAt, messageAt: heardAt };
}

function inboxOf(
  states: Iterable<readonly [string, DeviceState]> = [],
  valves: Iterable<readonly [string, ValveMemory]> = [],
): Inbox {
  const memory: Memory = { ...EMPTY_MEMORY, valves: new Map(valves) };
  return { states: new Map(states), memory };
}

function message(deviceId: string, token: string | undefined, decoded: Decoded = DECODED): Event {
  return { kind: "device_message", deviceId, decoded, lifeToken: token };
}

function withMarks(
  vm: ValveMemory,
  marks: Readonly<Partial<Record<Group, Mark | undefined>>>,
): ValveMemory {
  const groups: Partial<Record<Group, GroupMemory>> = { ...vm.groups };
  for (const group of GROUPS) {
    if (!Object.hasOwn(marks, group)) continue;
    const gm = groups[group];
    if (gm !== undefined) groups[group] = { ...gm, mark: marks[group] };
  }
  return { ...vm, groups };
}

const NONE: Readonly<Record<Group, undefined>> = {
  schedule: undefined,
  active_group: undefined,
  sensor_source: undefined,
  frost_protection: undefined,
  thermostat: undefined,
  open_window: undefined,
};

function unmarked(at = T0): ValveMemory {
  return withMarks(newValveMemory(SPEC, at), NONE);
}

function markAt(group: Group, vm: ValveMemory): Mark | undefined {
  return vm.groups[group]?.mark;
}

function valve(inbox: Inbox, id: string): ValveMemory {
  const vm = inbox.memory.valves.get(id);
  if (vm === undefined) throw new Error(`no memory for ${id}`);
  return vm;
}

function apply(inbox: Inbox, event: Event, nowMs: number, specs = SPECS): Inbox {
  return applyEvent(inbox, event, specs, nowMs);
}

function fresh(at: number): Mark {
  return { at, askedAt: undefined, writtenAt: undefined };
}

describe("events", () => {
  describe("applyEvent", () => {
    describe("With a device_message for a device with no state", () => {
      const out = apply(inboxOf(), message(Z1, "a", DECODED_RICH), T0 + 5);
      const state = out.states.get(Z1);
      it("a state is created with since now and holds the message", () => {
        expect(state?.since).toBe(T0 + 5);
        expect(state?.values).toEqual({ sensor_source: "external" });
        expect(state?.readings.setpoint).toBe(21);
      });
    });

    describe("With a device_message that counts as heard, a readable group asked earlier and an unreadable group written earlier", () => {
      const vm = withMarks(unmarked(), {
        schedule: { at: T0, askedAt: undefined, writtenAt: T0 + 10 },
        active_group: { at: T0, askedAt: T0 + 10, writtenAt: undefined },
      });
      const heardAt = T0 + 60 * SECOND_MS;
      const start = { ...vm, asks: [T0 + 10] };
      const out = apply(inboxOf([[Z1, live(T0)]], [[Z1, start]]), message(Z1, "t1"), heardAt);
      const after = valve(out, Z1);
      it("both marks are cleared and both groups' assertedAt is the new heardAt", () => {
        expect(markAt("schedule", after)).toBeUndefined();
        expect(markAt("active_group", after)).toBeUndefined();
        expect(after.groups.schedule?.assertedAt).toBe(heardAt);
        expect(after.groups.active_group?.assertedAt).toBe(heardAt);
      });
      it("asks is empty", () => {
        expect(after.asks).toEqual([]);
      });
    });

    describe("With a device_message that counts as heard and a readable group marked but not asked", () => {
      const vm = withMarks(unmarked(), { active_group: fresh(T0 + 5) });
      const out = apply(
        inboxOf([[Z1, live(T0)]], [[Z1, { ...vm, asks: [T0 + 1] }]]),
        message(Z1, "t1"),
        T0 + 60 * SECOND_MS,
      );
      const after = valve(out, Z1);
      it("the mark stays", () => {
        expect(markAt("active_group", after)).toEqual(fresh(T0 + 5));
      });
      it("asks is empty", () => {
        expect(after.asks).toEqual([]);
      });
    });

    describe("With a device_message that does not count as heard", () => {
      const vm = withMarks(unmarked(), {
        active_group: { at: T0, askedAt: T0 + 1, writtenAt: undefined },
      });
      const start = { ...vm, asks: [T0 + 1] };
      const out = apply(
        inboxOf([[Z1, live(T0)]], [[Z1, start]]),
        message(Z1, "t0", DECODED_RICH),
        T0 + 60 * SECOND_MS,
      );
      it("marks and asks are unchanged", () => {
        expect(valve(out, Z1)).toEqual(start);
      });
      it("the state holds the message's values", () => {
        expect(out.states.get(Z1)?.values).toEqual({ sensor_source: "external" });
        expect(out.states.get(Z1)?.heardAt).toBe(T0);
      });
    });

    describe("With two heard device_messages for one valve at the same nowMs", () => {
      const now = T0 + 60 * SECOND_MS;
      const first = apply(inboxOf([[Z1, live(T0)]], [[Z1, unmarked()]]), message(Z1, "t1"), now);
      // Between the two messages the valve was marked and asked, strictly before `now`.
      const asked = withMarks(valve(first, Z1), {
        active_group: { at: now - 2, askedAt: now - 1, writtenAt: undefined },
      });
      const second = apply(
        {
          ...first,
          memory: { ...first.memory, valves: new Map([[Z1, { ...asked, asks: [now - 1] }]]) },
        },
        message(Z1, "t2"),
        now,
      );
      it("both count as heard, and the result equals applying them one after the other", () => {
        expect(first.states.get(Z1)?.heardAt).toBe(now);
        expect(second.states.get(Z1)?.lifeToken).toBe("t2");
        expect(markAt("active_group", valve(second, Z1))).toBeUndefined();
        expect(valve(second, Z1).asks).toEqual([]);
      });
    });

    describe("With the first message after start, or after link_up", () => {
      const vm = withMarks(unmarked(), {
        active_group: { at: T0, askedAt: T0 + 1, writtenAt: undefined },
      });
      const afterStart = apply(
        inboxOf([[Z1, newState(T0)]], [[Z1, { ...vm, asks: [T0 + 1] }]]),
        message(Z1, "t1"),
        T0 + 60 * SECOND_MS,
      );
      const upBase = inboxOf([[Z1, live(T0)]], [[Z1, unmarked()]]);
      const up = apply(upBase, { kind: "link_up", transport: "z2m" }, T0 + 10);
      const upAsked = {
        ...up,
        memory: {
          ...up.memory,
          valves: new Map([
            [
              Z1,
              {
                ...withMarks(valve(up, Z1), {
                  active_group: { at: T0 + 10, askedAt: T0 + 11, writtenAt: undefined },
                }),
                asks: [T0 + 11],
              },
            ],
          ]),
        },
      };
      const afterUp = apply(upAsked, message(Z1, "t1"), T0 + 60 * SECOND_MS);
      it("does not clear an asked mark after start", () => {
        expect(markAt("active_group", valve(afterStart, Z1))?.askedAt).toBe(T0 + 1);
        expect(valve(afterStart, Z1).asks).toEqual([T0 + 1]);
        expect(afterStart.states.get(Z1)?.heardAt).toBeUndefined();
      });
      it("does not clear an asked mark after link_up", () => {
        expect(markAt("active_group", valve(afterUp, Z1))?.askedAt).toBe(T0 + 11);
        expect(valve(afterUp, Z1).asks).toEqual([T0 + 11]);
      });
    });

    describe("With a device_message whose lifeToken is undefined", () => {
      const vm = withMarks(unmarked(), {
        active_group: { at: T0, askedAt: T0 + 1, writtenAt: undefined },
      });
      const out = apply(
        inboxOf([[Z1, live(T0)]], [[Z1, { ...vm, asks: [T0 + 1] }]]),
        message(Z1, undefined),
        T0 + 60 * SECOND_MS,
      );
      it("is not heard: mark and asks stay, heardAt and token are kept", () => {
        expect(markAt("active_group", valve(out, Z1))?.askedAt).toBe(T0 + 1);
        expect(valve(out, Z1).asks).toEqual([T0 + 1]);
        expect(out.states.get(Z1)?.heardAt).toBe(T0);
        expect(out.states.get(Z1)?.lifeToken).toBe("t0");
      });
    });

    describe("With a device_message from a valve that was silent", () => {
      const now = T0 + VALVE_SILENT_AFTER_MS + 60 * SECOND_MS;
      const vm = withMarks(unmarked(), {
        schedule: { at: T0, askedAt: undefined, writtenAt: T0 + 1 },
        active_group: fresh(T0 + 7),
        sensor_source: undefined,
      });
      const start = { ...vm, asks: [T0 + 1] };
      const out = apply(inboxOf([[Z1, live(T0)]], [[Z1, start]]), message(Z1, "t1"), now);
      const after = valve(out, Z1);
      it("every group of its spec has a mark with no askedAt and no writtenAt", () => {
        for (const group of GROUPS) {
          expect(markAt(group, after)?.askedAt).toBeUndefined();
          expect(markAt(group, after)?.writtenAt).toBeUndefined();
        }
      });
      it("a group that had no mark, or whose older mark was asked or written, has a fresh mark at now", () => {
        expect(markAt("schedule", after)).toEqual(fresh(now));
        expect(markAt("sensor_source", after)).toEqual(fresh(now));
      });
      it("a group whose older mark was not acted on keeps that mark and its time", () => {
        expect(markAt("active_group", after)).toEqual(fresh(T0 + 7));
      });
      it("asks is empty", () => {
        expect(after.asks).toEqual([]);
      });
    });

    describe("With a device_message from a silent valve that has a spec and no ValveMemory", () => {
      const now = T0 + VALVE_SILENT_AFTER_MS + 60 * SECOND_MS;
      const out = apply(inboxOf([[Z1, live(T0)]]), message(Z1, "t1"), now);
      it("a ValveMemory is created and every group is marked", () => {
        const after = valve(out, Z1);
        for (const group of GROUPS) expect(markAt(group, after)).toEqual(fresh(now));
      });
    });

    describe("With a heard device_message from a live valve that has a spec and no ValveMemory", () => {
      const out = apply(inboxOf([[Z1, live(T0)]]), message(Z1, "t1"), T0 + 60 * SECOND_MS);
      it("no ValveMemory is created", () => {
        expect(out.memory.valves.has(Z1)).toBe(false);
      });
    });

    describe("With rejoined for a valve that has no marks", () => {
      const base = inboxOf([[Z1, live(T0)]], [[Z1, unmarked()]]);
      const out = apply(base, { kind: "rejoined", deviceId: Z1 }, T0 + 99);
      it("every group of the valve is marked at now", () => {
        for (const group of GROUPS) expect(markAt(group, valve(out, Z1))).toEqual(fresh(T0 + 99));
      });
      it("states are unchanged", () => {
        expect(out.states).toEqual(base.states);
      });
    });

    describe("With rejoined twice, 10 s apart, and nothing asked or written in between", () => {
      const once = apply(
        inboxOf([], [[Z1, unmarked()]]),
        { kind: "rejoined", deviceId: Z1 },
        T0 + 100,
      );
      const twice = apply(once, { kind: "rejoined", deviceId: Z1 }, T0 + 100 + 10 * SECOND_MS);
      it("every mark keeps the time of the first event", () => {
        for (const group of GROUPS)
          expect(markAt(group, valve(twice, Z1))).toEqual(fresh(T0 + 100));
      });
    });

    describe("With rejoined after the readable groups were asked", () => {
      const vm = withMarks(unmarked(), {
        active_group: { at: T0, askedAt: T0 + 5, writtenAt: undefined },
        sensor_source: { at: T0, askedAt: T0 + 5, writtenAt: undefined },
      });
      const out = apply(inboxOf([], [[Z1, vm]]), { kind: "rejoined", deviceId: Z1 }, T0 + 500);
      it("their marks are fresh, at now, with no askedAt", () => {
        expect(markAt("active_group", valve(out, Z1))).toEqual(fresh(T0 + 500));
        expect(markAt("sensor_source", valve(out, Z1))).toEqual(fresh(T0 + 500));
      });
    });

    describe("With rejoined for a valve that has a spec and no ValveMemory", () => {
      const out = apply(inboxOf(), { kind: "rejoined", deviceId: Z1 }, T0 + 9);
      it("a ValveMemory is created and every group is marked at now", () => {
        for (const group of GROUPS) expect(markAt(group, valve(out, Z1))).toEqual(fresh(T0 + 9));
      });
    });

    describe("With rejoined for a device that has no spec", () => {
      const base = inboxOf([[SENSOR, live(T0)]]);
      it("the inbox is unchanged", () => {
        expect(apply(base, { kind: "rejoined", deviceId: SENSOR }, T0 + 9)).toEqual(base);
      });
    });

    describe("With bridge_restarted for z2m", () => {
      const other = unmarked();
      const base = inboxOf(
        [
          [Z1, live(T0)],
          [OTHER, live(T0)],
        ],
        [
          [Z1, unmarked()],
          [OTHER, other],
        ],
      );
      const out = apply(base, { kind: "bridge_restarted", transport: "z2m" }, T0 + 50);
      it("every group of every z2m valve is marked", () => {
        for (const id of [Z1, Z2]) {
          for (const group of GROUPS) expect(markAt(group, valve(out, id))).toEqual(fresh(T0 + 50));
        }
      });
      it("valves of another transport are untouched", () => {
        expect(valve(out, OTHER)).toBe(other);
      });
      it("states are unchanged", () => {
        expect(out.states).toEqual(base.states);
      });
    });

    describe("With link_up for z2m", () => {
      const other = unmarked();
      const otherState = live(T0);
      const base = inboxOf(
        [
          [Z1, { ...live(T0), values: { sensor_source: "external" } }],
          [SENSOR, live(T0)],
          [OTHER, otherState],
        ],
        [
          [Z1, unmarked()],
          [OTHER, other],
        ],
      );
      const out = apply(base, { kind: "link_up", transport: "z2m" }, T0 + 70);
      it("every z2m device has heardAt undefined and since now, and keeps its values", () => {
        for (const id of [Z1, SENSOR]) {
          expect(out.states.get(id)?.heardAt).toBeUndefined();
          expect(out.states.get(id)?.since).toBe(T0 + 70);
        }
        expect(out.states.get(Z1)?.values).toEqual({ sensor_source: "external" });
      });
      it("every group of every z2m valve is marked", () => {
        for (const id of [Z1, Z2]) {
          for (const group of GROUPS) expect(markAt(group, valve(out, id))).toEqual(fresh(T0 + 70));
        }
      });
      it("devices and valves of another transport are untouched", () => {
        expect(out.states.get(OTHER)).toBe(otherState);
        expect(valve(out, OTHER)).toBe(other);
      });
    });

    describe("With link_up for z2m after the wall clock was set back, memory stamped after now", () => {
      const now = T0;
      const ahead = T0 + 2 * 60 * 60 * SECOND_MS;
      const earlier = T0 - 60 * SECOND_MS;
      /**
       * A valve memory whose every stamp is `at`: schedule written and marked (asked and written),
       * sensor_source marked and not acted on, active_group unmarked.
       */
      function stampedAt(at: number): ValveMemory {
        const vm = newValveMemory(SPEC, at);
        const group = (
          mark: Mark | undefined,
          writes: GroupMemory["writes"] = [],
        ): GroupMemory => ({
          desiredKey: undefined,
          writes,
          mark,
          assertedAt: at,
        });
        return {
          ...vm,
          groups: {
            schedule: group({ at, askedAt: at, writtenAt: at }, [{ at, marked: true }]),
            active_group: group(undefined),
            sensor_source: group(fresh(at)),
          },
          lastWriteAt: at,
          asks: [at],
          freeAskAt: at,
          feedValue: 20,
          feedAt: at,
          lastPushAt: at,
          feedLostSince: at,
          equalSince: at,
        };
      }
      const other = stampedAt(ahead);
      const base = inboxOf(
        [[Z1, live(earlier)]],
        [
          [Z1, stampedAt(ahead)],
          [Z2, stampedAt(earlier)],
          [OTHER, other],
        ],
      );
      const withRooms: Inbox = {
        ...base,
        memory: {
          ...base.memory,
          rooms: new Map([
            ["ahead", { freshSince: ahead }],
            ["earlier", { freshSince: earlier }],
          ]),
        },
      };
      const out = apply(withRooms, { kind: "link_up", transport: "z2m" }, now);
      const vm = valve(out, Z1);
      it("lastWriteAt, tokensAt, freeAskAt, feedAt, lastPushAt, feedLostSince and equalSince are now", () => {
        expect([
          vm.lastWriteAt,
          vm.tokensAt,
          vm.freeAskAt,
          vm.feedAt,
          vm.lastPushAt,
          vm.feedLostSince,
          vm.equalSince,
        ]).toEqual([now, now, now, now, now, now, now]);
      });
      it("every write record, every ask and every assertedAt is now", () => {
        expect(vm.groups.schedule?.writes).toEqual([{ at: now, marked: true }]);
        expect(vm.asks).toEqual([now]);
        for (const group of GROUPS) expect(vm.groups[group]?.assertedAt).toBe(now);
      });
      it("an acted-on mark is replaced by a fresh mark at now; a mark not acted on keeps its place, at now", () => {
        expect(markAt("schedule", vm)).toEqual(fresh(now));
        expect(markAt("sensor_source", vm)).toEqual(fresh(now));
      });
      it("stamps at or before now are unchanged", () => {
        const kept = valve(out, Z2);
        expect([kept.lastWriteAt, kept.tokensAt, kept.lastPushAt, kept.equalSince]).toEqual([
          earlier,
          earlier,
          earlier,
          earlier,
        ]);
        expect(kept.groups.schedule?.writes).toEqual([{ at: earlier, marked: true }]);
      });
      it("every room's freshSince after now is now, an earlier one is unchanged", () => {
        expect(out.memory.rooms.get("ahead")).toEqual({ freshSince: now });
        expect(out.memory.rooms.get("earlier")).toEqual({ freshSince: earlier });
      });
      it("valves of another transport keep their stamps", () => {
        expect(valve(out, OTHER)).toBe(other);
      });
    });

    describe("With link_up for a transport that has no device states and no valves", () => {
      const base = inboxOf([[Z1, live(T0)]], [[Z1, unmarked()]]);
      it("the inbox is unchanged", () => {
        expect(apply(base, { kind: "link_up", transport: "matter" }, T0 + 1)).toEqual(base);
      });
    });

    describe("With resync_requested for one valve", () => {
      const untouched = unmarked();
      const base = inboxOf(
        [],
        [
          [Z1, unmarked()],
          [Z2, untouched],
        ],
      );
      const out = apply(base, { kind: "resync_requested", valveIds: new Set([Z1]) }, T0 + 4);
      it("every group of that valve is marked and other valves are untouched", () => {
        for (const group of GROUPS) expect(markAt(group, valve(out, Z1))).toEqual(fresh(T0 + 4));
        expect(valve(out, Z2)).toBe(untouched);
      });
    });

    describe("With resync_requested naming a device that has no spec", () => {
      const base = inboxOf([[SENSOR, live(T0)]]);
      it("the inbox is unchanged", () => {
        expect(
          apply(base, { kind: "resync_requested", valveIds: new Set([SENSOR]) }, T0 + 4),
        ).toEqual(base);
      });
    });

    describe("With a device_message for a room sensor", () => {
      const base = inboxOf([[SENSOR, live(T0)]], [[Z1, unmarked()]]);
      const out = apply(base, message(SENSOR, "t1", DECODED_RICH), T0 + 60 * SECOND_MS);
      it("its state is updated and memory is unchanged", () => {
        expect(out.states.get(SENSOR)?.heardAt).toBe(T0 + 60 * SECOND_MS);
        expect(out.states.get(SENSOR)?.readings.setpoint).toBe(21);
        expect(out.memory).toEqual(base.memory);
      });
    });

    describe("With push_failed for a valve that was being fed", () => {
      const fed: ValveMemory = {
        ...unmarked(),
        feedValue: 20.5,
        feedAt: T0 + 3,
        lastPushAt: T0 + 3,
        feedLostSince: T0 + 2,
        tokens: 2,
        asks: [T0 + 1],
      };
      const base = inboxOf([[Z1, live(T0)]], [[Z1, fed]]);
      const out = apply(base, { kind: "push_failed", valveId: Z1 }, T0 + 9);
      it("feedValue and feedAt are undefined, lastPushAt is unchanged, and nothing else in its memory changed", () => {
        const after = valve(out, Z1);
        expect(after.feedValue).toBeUndefined();
        expect(after.feedAt).toBeUndefined();
        expect(after.lastPushAt).toBe(T0 + 3);
        expect(after).toEqual({ ...fed, feedValue: undefined, feedAt: undefined });
      });
      it("states are unchanged", () => {
        expect(out.states).toEqual(base.states);
      });
    });

    describe("With push_failed for a valve that has no ValveMemory", () => {
      const base = inboxOf([[Z1, live(T0)]]);
      it("the inbox is unchanged", () => {
        expect(apply(base, { kind: "push_failed", valveId: Z1 }, T0 + 9)).toEqual(base);
      });
    });

    describe("With a direct ask to a valve at t", () => {
      const t = T0 + 10 * SECOND_MS;
      const before = { ...unmarked(), tokens: 4, tokensAt: t, asks: [t - 10 * 60 * SECOND_MS] };
      const base = inboxOf([[Z1, live(T0)]], [[Z1, before]]);
      const out = apply(
        base,
        { kind: "asked_directly", valveId: Z1, at: t, bucketFullAt: T0, freeAskAt: undefined },
        T0 + 1,
      );
      it("no refresh or setpoint write is allowed before t + SPACING_MS", () => {
        const after = valve(out, Z1);
        expect(mayAsk(after, t + SPACING_MS - 1)).toBe(false);
        expect(maySpend(after, t + SPACING_MS - 1)).toBe(false);
      });
      it("a refresh is allowed at t + SPACING_MS, which it was not one ms before", () => {
        const after = valve(out, Z1);
        expect(mayAsk(after, t + SPACING_MS - 1)).toBe(false);
        expect(mayAsk(after, t + SPACING_MS)).toBe(true);
        expect(maySpend(after, t + SPACING_MS - 1)).toBe(false);
        expect(maySpend(after, t + SPACING_MS)).toBe(true);
      });
      it("tokens and asks are unchanged, and only lastWriteAt differs", () => {
        const after = valve(out, Z1);
        expect(after.lastWriteAt).toBe(t);
        expect(after).toEqual({ ...before, lastWriteAt: t });
      });
    });

    describe("With a direct ask earlier than the valve's last request", () => {
      const t = T0 + 10 * SECOND_MS;
      const later = { ...unmarked(), lastWriteAt: t + 5 * SECOND_MS };
      const out = apply(
        inboxOf([[Z1, live(T0)]], [[Z1, later]]),
        { kind: "asked_directly", valveId: Z1, at: t, bucketFullAt: T0, freeAskAt: undefined },
        T0 + 1,
      );
      it("lastWriteAt is not lowered", () => {
        expect(valve(out, Z1).lastWriteAt).toBe(t + 5 * SECOND_MS);
      });
    });

    describe("With a direct ask to a valve that has no ValveMemory and a free ask stamp", () => {
      it("its memory starts with that free ask", () => {
        const t = T0 + 10 * SECOND_MS;
        const event = {
          kind: "asked_directly" as const,
          valveId: Z1,
          at: t,
          bucketFullAt: T0,
          freeAskAt: t - 60 * SECOND_MS,
        };
        expect(valve(apply(inboxOf([[Z1, live(T0)]]), event, T0), Z1).freeAskAt).toBe(
          t - 60 * SECOND_MS,
        );
      });
    });
    describe("With a direct ask to a valve that has no ValveMemory", () => {
      const t = T0 + 10 * SECOND_MS;
      const bucketFullAt = t + 3 * REFILL_MS;
      const base = inboxOf([[Z1, live(T0)]]);
      const out = apply(
        base,
        { kind: "asked_directly", valveId: Z1, at: t, bucketFullAt, freeAskAt: undefined },
        T0,
      );
      it("its memory starts at t with the bucket the event gives, lastWriteAt t", () => {
        const fresh = importBucket(newValveMemory(SPEC, t), bucketFullAt, t);
        expect(valve(out, Z1)).toEqual({ ...fresh, lastWriteAt: t });
      });
      it("no refresh or setpoint write is allowed before t + SPACING_MS", () => {
        const after = valve(out, Z1);
        expect(mayAsk(after, t + SPACING_MS - 1)).toBe(false);
        expect(maySpend(after, t + SPACING_MS - 1)).toBe(false);
        expect(mayAsk(after, t + SPACING_MS)).toBe(true);
      });
      it("states are unchanged", () => {
        expect(out.states).toEqual(base.states);
      });
    });

    describe("With a direct ask to a valve that has no ValveMemory and no spec", () => {
      const base = inboxOf([[SENSOR, live(T0)]]);
      it("the inbox is unchanged", () => {
        expect(
          apply(
            base,
            {
              kind: "asked_directly",
              valveId: SENSOR,
              at: T0,
              bucketFullAt: T0,
              freeAskAt: undefined,
            },
            T0,
          ),
        ).toEqual(base);
      });
    });

    describe('With sent "refresh" 3 s after a readable group was asked', () => {
      const vm = withMarks(unmarked(), {
        active_group: { at: T0, askedAt: T0 + 100, writtenAt: undefined },
        sensor_source: fresh(T0 + 50),
        schedule: { at: T0, askedAt: undefined, writtenAt: T0 + 60 },
      });
      const at = T0 + 100 + 3 * SECOND_MS;
      const out = apply(
        inboxOf([], [[Z1, vm]]),
        { kind: "sent", valveId: Z1, what: "refresh", at },
        T0 + 1,
      );
      it("that group's askedAt is atMs", () => {
        expect(markAt("active_group", valve(out, Z1))?.askedAt).toBe(at);
      });
      it("a mark that was not asked still has no askedAt, and no writtenAt changed", () => {
        expect(markAt("sensor_source", valve(out, Z1))).toEqual(fresh(T0 + 50));
        expect(markAt("schedule", valve(out, Z1))?.askedAt).toBeUndefined();
        expect(markAt("schedule", valve(out, Z1))?.writtenAt).toBe(T0 + 60);
      });
    });

    describe('With sent "publish" 3 s after an unreadable group was written for its mark', () => {
      const vm = withMarks(unmarked(), {
        schedule: { at: T0, askedAt: undefined, writtenAt: T0 + 100 },
        sensor_source: fresh(T0 + 50),
        active_group: { at: T0, askedAt: T0 + 70, writtenAt: undefined },
      });
      const at = T0 + 100 + 3 * SECOND_MS;
      const out = apply(
        inboxOf([], [[Z1, vm]]),
        { kind: "sent", valveId: Z1, what: "publish", at },
        T0 + 1,
      );
      it("that group's writtenAt is atMs", () => {
        expect(markAt("schedule", valve(out, Z1))?.writtenAt).toBe(at);
      });
      it("a mark that was not written still has no writtenAt, and no askedAt changed", () => {
        expect(markAt("sensor_source", valve(out, Z1))?.writtenAt).toBeUndefined();
        expect(markAt("active_group", valve(out, Z1))?.writtenAt).toBeUndefined();
        expect(markAt("active_group", valve(out, Z1))?.askedAt).toBe(T0 + 70);
      });
    });

    describe("With sent whose atMs is earlier than the stamp, or equal to it", () => {
      const vm = withMarks(unmarked(), {
        active_group: { at: T0, askedAt: T0 + 100, writtenAt: undefined },
      });
      const base = inboxOf([], [[Z1, vm]]);
      it("the stamp is unchanged", () => {
        for (const at of [T0 + 100, T0 + 40]) {
          const out = apply(base, { kind: "sent", valveId: Z1, what: "refresh", at }, T0);
          expect(markAt("active_group", valve(out, Z1))?.askedAt).toBe(T0 + 100);
        }
      });
    });

    describe('With sent "refresh", then a heard device_message between the old askedAt and atMs (applied afterwards with its own time)', () => {
      const vm = withMarks(unmarked(), {
        active_group: { at: T0, askedAt: T0 + 100, writtenAt: undefined },
      });
      const base = inboxOf([[Z1, live(T0)]], [[Z1, vm]]);
      const sentOut = apply(
        base,
        { kind: "sent", valveId: Z1, what: "refresh", at: T0 + 300 },
        T0 + 300,
      );
      const out = apply(sentOut, message(Z1, "t1"), T0 + 200);
      it("the mark stays", () => {
        expect(markAt("active_group", valve(out, Z1))).toBeDefined();
      });
    });

    describe('With sent "refresh", then a heard device_message later than atMs', () => {
      const vm = withMarks(unmarked(), {
        active_group: { at: T0, askedAt: T0 + 100, writtenAt: undefined },
      });
      const base = inboxOf([[Z1, live(T0)]], [[Z1, vm]]);
      const sentOut = apply(
        base,
        { kind: "sent", valveId: Z1, what: "refresh", at: T0 + 300 },
        T0 + 300,
      );
      const out = apply(sentOut, message(Z1, "t1"), T0 + 400);
      it("the mark is cleared", () => {
        expect(markAt("active_group", valve(out, Z1))).toBeUndefined();
      });
    });

    describe("With sent for a valve that has no ValveMemory, or for a device with no spec", () => {
      const base = inboxOf([
        [Z1, live(T0)],
        [SENSOR, live(T0)],
      ]);
      it("the inbox is unchanged", () => {
        for (const id of [Z1, SENSOR]) {
          expect(
            apply(base, { kind: "sent", valveId: id, what: "refresh", at: T0 + 5 }, T0),
          ).toEqual(base);
        }
      });
    });

    describe("With sent for a valve", () => {
      const vm = withMarks(
        { ...unmarked(), tokens: 2, lastWriteAt: T0 + 3, asks: [T0 + 1, T0 + 2] },
        {
          active_group: { at: T0, askedAt: T0 + 100, writtenAt: undefined },
          schedule: { at: T0, askedAt: undefined, writtenAt: T0 + 100 },
        },
      );
      const base = inboxOf([[Z1, live(T0)]], [[Z1, vm]]);
      const out = apply(base, { kind: "sent", valveId: Z1, what: "refresh", at: T0 + 900 }, T0);
      it("tokens, asks, writes, lastWriteAt and the states are unchanged", () => {
        const after = valve(out, Z1);
        expect(after.tokens).toBe(2);
        expect(after.asks).toEqual([T0 + 1, T0 + 2]);
        expect(after.lastWriteAt).toBe(T0 + 3);
        expect(after.groups.schedule?.writes).toEqual(vm.groups.schedule?.writes);
        expect(out.states).toEqual(base.states);
      });
    });

    describe("Always", () => {
      const events: readonly Event[] = [
        message(Z1, "t1", DECODED_RICH),
        { kind: "rejoined", deviceId: Z1 },
        { kind: "bridge_restarted", transport: "z2m" },
        { kind: "link_up", transport: "z2m" },
        { kind: "resync_requested", valveIds: new Set([Z1, Z2]) },
        { kind: "push_failed", valveId: Z1 },
        { kind: "sent", valveId: Z1, what: "refresh", at: T0 + 99 },
        { kind: "sent", valveId: Z1, what: "publish", at: T0 + 99 },
      ];
      it("the given inbox is not changed", () => {
        for (const event of events) {
          const vm = withMarks(unmarked(), {
            schedule: { at: T0, askedAt: T0 + 1, writtenAt: T0 + 1 },
            active_group: { at: T0, askedAt: T0 + 1, writtenAt: undefined },
          });
          const base = inboxOf([[Z1, live(T0)]], [[Z1, { ...vm, feedValue: 20, feedAt: T0 }]]);
          const snapshot = structuredClone(base);
          apply(base, event, T0 + VALVE_SILENT_AFTER_MS + 10 * SECOND_MS);
          expect(base).toEqual(snapshot);
        }
      });
    });
  });
});
