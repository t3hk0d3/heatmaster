import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { START_TOKENS, newValveMemory } from "../memory.ts";
import { charge, chargeAsk, mayAsk, mayWrite } from "../pacing.ts";
import { decodeDay } from "./sonoff-codec.ts";
import { TRV_ZBT_BINDING as binding, TRV_ZBT_SPEC } from "./sonoff-trv-zbt.ts";
import type { Group } from "../settings.ts";
import type { ResolvedDay } from "../schedule.ts";

function fixture(name: string): Record<string, unknown> {
  const url = new URL(`../../test/fixtures/z2m/${name}`, import.meta.url);
  return (JSON.parse(readFileSync(url, "utf8")) as { payload: Record<string, unknown> }).payload;
}

const DAY: ResolvedDay = decodeDay("00:00/16 06:00/19 22:00/16") ?? [];

describe("TRV-ZBT binding", () => {
  describe("decode", () => {
    describe("With a recorded message whose group to edit is 3", () => {
      it("no day key is returned and editGroup is 3", () => {
        const decoded = binding.decode(fixture("trv_zbt_state_group3.json"));
        expect(Object.keys(decoded.values).filter((k) => k.startsWith("day_"))).toEqual([]);
        expect(decoded.readings.editGroup).toBe(3);
      });
    });
    describe("With a recorded message whose group to edit is 1, and one right after an edit-group change that carries the old group's days", () => {
      it("no day key is returned and editGroup is 1", () => {
        const fresh = binding.decode(fixture("trv_zbt_state_group1.json"));
        const stale = binding.decode({
          ...fixture("trv_zbt_state_group3.json"),
          schedule_group_to_edit: "1",
        });
        for (const decoded of [fresh, stale]) {
          expect(Object.keys(decoded.values).filter((k) => k.startsWith("day_"))).toEqual([]);
          expect(decoded.readings.editGroup).toBe(1);
        }
      });
    });
    describe("With a message that has no group to edit", () => {
      it("no day key is returned", () => {
        const payload = { ...fixture("trv_zbt_state_group3.json") };
        delete payload.schedule_group_to_edit;
        const decoded = binding.decode(payload);
        expect(Object.keys(decoded.values).filter((k) => k.startsWith("day_"))).toEqual([]);
        expect(decoded.readings.editGroup).toBeUndefined();
      });
    });
    describe("With the active group present", () => {
      it("active_group holds it", () => {
        expect(binding.decode(fixture("trv_zbt_state_group3.json")).values.active_group).toBe(1);
        expect(binding.decode({ schedule_active_group: "3" }).values.active_group).toBe(3);
        expect(binding.decode({ schedule_active_group: "x" }).values.active_group).toBeNull();
      });
    });
  });
  describe("encode", () => {
    describe("With any day", () => {
      it("the message carries the group to edit set to 3 and 12-entry day texts", () => {
        const message = binding.encode({ day_mon: DAY, day_tue: DAY });
        expect(message.schedule_group_to_edit).toBe("3");
        expect(Object.keys(message)[0]).toBe("schedule_group_to_edit");
        for (const [key, text] of Object.entries(message))
          if (key.startsWith("weekly_schedule_")) expect(String(text).split(" ")).toHaveLength(12);
        expect(Object.keys(message).filter((k) => k.startsWith("weekly_schedule_"))).toHaveLength(
          2,
        );
      });
    });
    describe("With days and active_group 3 together", () => {
      it("carries the group to edit first, then the days, then the active group, exactly", () => {
        const message = binding.encode({ day_mon: DAY, active_group: 3 });
        expect(Object.entries(message)).toEqual([
          ["schedule_group_to_edit", "3"],
          ["weekly_schedule_monday", `00:00/16 06:00/19 22:00/16${" 22:00/16".repeat(9)}`],
          ["schedule_active_group", "3"],
        ]);
      });
    });
    describe("With an active_group outside 1-3 or an unknown sensor source", () => {
      it("throws RangeError", () => {
        expect(() => binding.encode({ active_group: 4 })).toThrow(RangeError);
        expect(() => binding.encode({ sensor_source: "bogus" as "internal" })).toThrow(RangeError);
      });
    });
    describe("With active_group 3 alone", () => {
      it("the message carries the active group and no group to edit", () => {
        expect(binding.encode({ active_group: 3 })).toEqual({ schedule_active_group: "3" });
      });
    });
    describe("With active_group 1 (a release)", () => {
      it("the message carries active group 1 and no days", () => {
        const message = binding.encode({ active_group: 1 });
        expect(message).toEqual({ schedule_active_group: "1" });
      });
    });
  });
  describe("encodeRefresh", () => {
    describe("Always", () => {
      it("returns the active group key and the sensor select key, each with an empty text", () => {
        expect(binding.encodeRefresh()).toEqual({
          schedule_active_group: "",
          temperature_sensor_select: "",
        });
      });
      it("holds no day key and no group to edit", () => {
        const keys = Object.keys(binding.encodeRefresh() ?? {});
        expect(keys.some((k) => k.startsWith("weekly_schedule_"))).toBe(false);
        expect(keys).not.toContain("schedule_group_to_edit");
      });
    });
  });
  describe("write budget", () => {
    describe("With the real TRV-ZBT spec, a valve that never answers and never takes a write, second by second for 24 h from a new memory", () => {
      const seconds = Array.from({ length: 86_401 }, (_, s) => s);
      const T0 = 1_700_000_000_000;
      let asks = 0;
      const writes: Partial<Record<Group, number>> = {};
      beforeAll(() => {
        let vm = newValveMemory(TRV_ZBT_SPEC, T0);
        for (const s of seconds) {
          const now = T0 + s * 1000;
          if (mayAsk(vm, now)) {
            vm = chargeAsk(vm, TRV_ZBT_SPEC, now);
            asks += 1;
          }
          for (const gs of TRV_ZBT_SPEC.groups) {
            if (mayWrite(vm, gs.group, now)) {
              vm = charge(vm, gs.group, now, vm.groups[gs.group]?.mark !== undefined);
              writes[gs.group] = (writes[gs.group] ?? 0) + 1;
            }
          }
        }
      });
      it("at most START_TOKENS + 48 asks and writes together", () => {
        const total = asks + Object.values(writes).reduce((a, b) => a + b, 0);
        expect(total).toBeLessThanOrEqual(START_TOKENS + 48);
      });
      it("at most 7 writes per group and 7 asks", () => {
        for (const gs of TRV_ZBT_SPEC.groups) expect(writes[gs.group] ?? 0).toBeLessThanOrEqual(7);
        expect(asks).toBeLessThanOrEqual(7);
      });
    });
  });
});
