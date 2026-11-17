import { describe, expect, it } from "vitest";
import {
  BUILDER_NOW,
  BUILDER_ROOM,
  makeConfig,
  makeMembership,
  makeOriginals,
  makeSnapshot,
  makeSpec,
  makeState,
  makeWorld,
} from "../test/builders.ts";
import { ChangeRefused } from "./change.ts";
import type { ChangeRefusedCode } from "./change.ts";
import type { DeviceView, Effect, World } from "./control.ts";
import { membershipFrom } from "./house.ts";
import type { AreaMembership, HouseInput } from "./house.ts";
import { acceptUnknownOriginals, reconcile } from "./join.ts";
import type { Reconciliation } from "./join.ts";
import { EMPTY_LEDGER, withRecord } from "./ledger.ts";
import type { Ledger, StoredConfig, ValveRecord } from "./ledger.ts";
import type { Room } from "./model.ts";
import type { DeviceState } from "./observation.ts";
import type { SettingValues } from "./settings.ts";

const V1 = "z2m:0x00124b0000000001";
const V2 = "z2m:0x00124b0000000002";
const V3 = "z2m:0x00124b0000000003";
const HOUR_MS = 60 * 60 * 1000;
const NOW_MS = BUILDER_NOW.epochMilliseconds;
const OFFICE = "office";

type Model = "trvzb" | "trv_zbt";

// Builders --------------------------------------------------------------------------------------

function room(id: string, valveIds: readonly string[]): Room {
  return {
    id,
    name: id,
    scheduleId: "default",
    valves: valveIds.map((valveId) => ({ valveId })),
    sensors: [],
    presets: { comfort: undefined, eco: undefined, frost: undefined, boost: undefined },
  };
}

function viewWith(model: Model, state: DeviceState | undefined, usable = true): DeviceView {
  return { name: `valve ${model}`, spec: makeSpec(model), usable, state };
}

/** A usable view whose valve has sent a message holding every captured key. */
function observed(
  model: Model = "trvzb",
  values: SettingValues = makeOriginalsOf(model),
): DeviceView {
  return viewWith(model, makeState({ values }));
}

function makeOriginalsOf(model: Model): SettingValues {
  return model === "trvzb"
    ? { sensor_source: "internal" }
    : { active_group: 1, sensor_source: "internal" };
}

/** A usable view of a valve that has sent no message since the start. */
function silent(model: Model = "trvzb"): DeviceView {
  return viewWith(model, undefined);
}

function record(valveId: string, model: Model = "trvzb"): ValveRecord {
  return {
    valveId,
    profile: makeSpec(model).profile,
    adoptedAt: NOW_MS - 24 * HOUR_MS,
    originals: makeOriginals(model),
  };
}

function ledgerOf(...valveIds: readonly string[]): Ledger {
  return valveIds.reduce((ledger, valveId) => withRecord(ledger, record(valveId)), EMPTY_LEDGER);
}

/** A live house whose rooms are `rooms`, the config's entries from them, the saved membership equal. */
function liveWorld(
  rooms: readonly Room[],
  devices: Readonly<Record<string, DeviceView>> = {},
  options: Partial<World> = {},
): World {
  return makeWorld({ rooms, devices: new Map(Object.entries(devices)), ...options });
}

function storedOf(world: World): StoredConfig {
  if (world.stored === undefined) throw new Error("no stored config");
  return world.stored;
}

function withStored(world: World, change: Partial<StoredConfig>): World {
  return { ...world, stored: { ...storedOf(world), ...change } };
}

function kinds(effects: readonly Effect[]): readonly Effect["kind"][] {
  return effects.map((effect) => effect.kind);
}

function savedConfig(result: Reconciliation): StoredConfig | undefined {
  const found = result.effects.find((effect) => effect.kind === "saveConfig");
  return found?.kind === "saveConfig" ? found.stored : undefined;
}

function refusal(run: () => unknown): ChangeRefused {
  try {
    run();
  } catch (error) {
    if (error instanceof ChangeRefused) return error;
    throw error;
  }
  throw new Error("expected ChangeRefused, got a result");
}

function codeOf(run: () => unknown): ChangeRefusedCode {
  return refusal(run).code;
}

/** The world after `result`: its stored config and ledger. */
function after(world: World, result: Reconciliation): World {
  return { ...world, stored: result.stored, ledger: result.ledger };
}

// Tests -----------------------------------------------------------------------------------------

describe("join", () => {
  describe("reconcile", () => {
    describe("With a live house and a room with an observable TRVZB that has no record", () => {
      const world = liveWorld([room(BUILDER_ROOM, [V1])], { [V1]: observed() });
      it("joined holds its capture", () => {
        expect(reconcile(world).joined).toEqual([
          { valveId: V1, originals: { sensor_source: "internal" }, unreadable: [] },
        ]);
      });
      it("effects start with saveLedger and writeOriginalsCopy", () => {
        const result = reconcile(world);
        expect(kinds(result.effects).slice(0, 2)).toEqual(["saveLedger", "writeOriginalsCopy"]);
        expect(result.effects[0]).toEqual({ kind: "saveLedger", ledger: result.ledger });
        expect(result.effects[1]).toEqual({ kind: "writeOriginalsCopy", ledger: result.ledger });
      });
      it("the new record's adoptedAt is now", () => {
        expect(reconcile(world).ledger?.records.get(V1)).toEqual({
          valveId: V1,
          profile: "sonoff_trvzb",
          adoptedAt: NOW_MS,
          originals: { sensor_source: "internal" },
        });
      });
    });

    describe("With two joining valves, one not observable", () => {
      const world = liveWorld([room(BUILDER_ROOM, [V1, V2])], {
        [V1]: observed(),
        [V2]: silent(),
      });
      it("the observable one joins", () => {
        const result = reconcile(world);
        expect(result.joined.map((c) => c.valveId)).toEqual([V1]);
        expect(result.ledger?.records.has(V1)).toBe(true);
      });
      it("the other is pending with valve_not_observed", () => {
        const result = reconcile(world);
        expect(result.pending).toEqual([
          { valveId: V2, roomId: BUILDER_ROOM, reason: "valve_not_observed", unreadable: [] },
        ]);
        expect(result.ledger?.records.has(V2)).toBe(false);
      });
    });

    describe("With a joining valve whose DeviceView is not usable", () => {
      it("it is pending with transport_unusable", () => {
        const world = liveWorld([room(BUILDER_ROOM, [V1])], {
          [V1]: viewWith("trvzb", makeState({ values: { sensor_source: "internal" } }), false),
        });
        const result = reconcile(world);
        expect(result.pending.map((p) => [p.valveId, p.reason])).toEqual([
          [V1, "transport_unusable"],
        ]);
        expect(result.joined).toEqual([]);
      });
    });

    describe("With a joining valve whose transport has a fault", () => {
      it("it is pending with transport_unusable", () => {
        const world = liveWorld(
          [room(BUILDER_ROOM, [V1])],
          { [V1]: observed() },
          { transportFaults: { z2m: "another_instance" } },
        );
        const result = reconcile(world);
        expect(result.pending.map((p) => [p.valveId, p.reason])).toEqual([
          [V1, "transport_unusable"],
        ]);
        expect(result.joined).toEqual([]);
      });
    });

    describe("With a joining valve that has no DeviceView", () => {
      it("it is pending with transport_unusable", () => {
        const result = reconcile(liveWorld([room(BUILDER_ROOM, [V1])]));
        expect(result.pending).toEqual([
          { valveId: V1, roomId: BUILDER_ROOM, reason: "transport_unusable", unreadable: [] },
        ]);
      });
    });

    describe("With a joining valve whose link is down and that has never reported", () => {
      it("it is pending with valve_not_observed, not transport_unusable", () => {
        const world = liveWorld(
          [room(BUILDER_ROOM, [V1])],
          { [V1]: silent() },
          { links: { z2m: false } },
        );
        expect(reconcile(world).pending.map((p) => p.reason)).toEqual(["valve_not_observed"]);
      });
    });

    describe("With the ledger unreadable", () => {
      const world = liveWorld(
        [room(BUILDER_ROOM, [V1, V2])],
        { [V1]: observed(), [V2]: observed() },
        { ledger: undefined },
      );
      it("every joining valve is pending with ledger_unreadable", () => {
        const result = reconcile(world);
        expect(result.pending.map((p) => [p.valveId, p.reason])).toEqual([
          [V1, "ledger_unreadable"],
          [V2, "ledger_unreadable"],
        ]);
        expect(result.joined).toEqual([]);
        expect(result.ledger).toBeUndefined();
      });
      it("nothing is released", () => {
        const result = reconcile(world);
        expect(result.released).toEqual([]);
        expect(result.effects).toEqual([]);
      });
    });

    describe("With a joining TRVZB whose sensor source is not observed", () => {
      const world = liveWorld([room(BUILDER_ROOM, [V1])], { [V1]: observed("trvzb", {}) });
      it("it is pending with originals_unreadable and sensor_source in unreadable", () => {
        expect(reconcile(world).pending).toEqual([
          {
            valveId: V1,
            roomId: BUILDER_ROOM,
            reason: "originals_unreadable",
            unreadable: ["sensor_source"],
          },
        ]);
      });
      it("no record is made, on this call and on the next", () => {
        const first = reconcile(world);
        expect(first.ledger?.records.has(V1)).toBe(false);
        expect(first.effects).toEqual([]);
        const second = reconcile(after(world, first));
        expect(second.ledger?.records.has(V1)).toBe(false);
        expect(second.pending.map((p) => p.reason)).toEqual(["originals_unreadable"]);
      });
    });

    describe("With a joining TRV-ZBT whose active group is not observed", () => {
      const world = liveWorld([room(BUILDER_ROOM, [V1])], {
        [V1]: observed("trv_zbt", { sensor_source: "internal" }),
      });
      it("it is pending with originals_unreadable and active_group in unreadable", () => {
        expect(reconcile(world).pending).toEqual([
          {
            valveId: V1,
            roomId: BUILDER_ROOM,
            reason: "originals_unreadable",
            unreadable: ["active_group"],
          },
        ]);
      });
      it("it stays pending until the user accepts", () => {
        const first = reconcile(world);
        const second = reconcile(after(world, first));
        expect(second.joined).toEqual([]);
        expect(second.ledger?.records.has(V1)).toBe(false);
        const accepted = acceptUnknownOriginals(world, V1);
        const saved = accepted[0];
        const ledger = saved?.kind === "saveLedger" ? saved.ledger : undefined;
        const third = reconcile({ ...world, ledger });
        expect(third.pending).toEqual([]);
      });
    });

    describe("With a recorded valve in releasing that is in a room again", () => {
      const base = liveWorld(
        [room(BUILDER_ROOM, [V1])],
        { [V1]: observed() },
        {
          ledger: ledgerOf(V1),
        },
      );
      const world = withStored(base, { releasing: new Map([[V1, NOW_MS - HOUR_MS]]) });
      it("releasing no longer holds it", () => {
        const result = reconcile(world);
        expect(result.stored?.releasing.has(V1)).toBe(false);
        expect(savedConfig(result)?.releasing.has(V1)).toBe(false);
      });
      it("its record is unchanged and there is no saveLedger", () => {
        const result = reconcile(world);
        expect(result.ledger?.records.get(V1)).toEqual(record(V1));
        expect(kinds(result.effects)).not.toContain("saveLedger");
        expect(result.joined).toEqual([]);
      });
    });

    describe("With a recorded valve that is in no room", () => {
      const world = liveWorld(
        [room(BUILDER_ROOM, [V2])],
        { [V1]: observed(), [V2]: observed() },
        {
          ledger: ledgerOf(V1, V2),
        },
      );
      it("releasing holds it at now and released lists it", () => {
        const result = reconcile(world);
        expect(result.stored?.releasing.get(V1)).toBe(NOW_MS);
        expect(result.released).toEqual([V1]);
      });
      it("saveConfig keeps the revision", () => {
        const saved = savedConfig(reconcile(world));
        expect(saved?.releasing.get(V1)).toBe(NOW_MS);
        expect(saved?.revision).toBe(storedOf(world).revision);
        expect(saved?.config).toBe(storedOf(world).config);
      });
    });

    describe("With a valve moved from one room to another", () => {
      it("it is neither joined nor released and its record is unchanged", () => {
        const before = liveWorld(
          [room(BUILDER_ROOM, [V1]), room(OFFICE, [])],
          { [V1]: observed() },
          {
            ledger: ledgerOf(V1),
          },
        );
        const moved: World = {
          ...before,
          house: { kind: "live", membership: makeMembership({ [OFFICE]: [V1] }), notInHa: [] },
        };
        const result = reconcile(moved);
        expect(result.joined).toEqual([]);
        expect(result.released).toEqual([]);
        expect(result.stored?.releasing.size).toBe(0);
        expect(result.ledger).toBe(moved.ledger);
      });
    });

    describe("With a recorded valve listed in notInHa", () => {
      it("it is not released", () => {
        const world: World = {
          ...liveWorld([], { [V1]: observed() }, { ledger: ledgerOf(V1) }),
          house: { kind: "live", membership: makeMembership({}), notInHa: [V1] },
        };
        const result = reconcile(world);
        expect(result.released).toEqual([]);
        expect(result.stored?.releasing.has(V1)).toBe(false);
      });
    });

    describe("With a recorded valve unplaced as not_in_ha with no previous room (not listed in notInHa)", () => {
      const view = membershipFrom(
        makeSnapshot({ areas: { [OFFICE]: {} }, valveAreas: { [V2]: OFFICE } }),
        new Set([V1, V2]),
        undefined,
      );
      const world: World = {
        ...liveWorld(
          [room(OFFICE, [V2])],
          { [V1]: observed(), [V2]: observed() },
          {
            ledger: ledgerOf(V1, V2),
          },
        ),
        house: { kind: "live", membership: view.membership, notInHa: view.notInHa },
      };
      it("releasing holds it at now and released lists it", () => {
        expect(view.unplaced.get(V1)).toBe("not_in_ha");
        const result = reconcile(world);
        expect(result.stored?.releasing.get(V1)).toBe(NOW_MS);
        expect(result.released).toEqual([V1]);
      });
    });

    describe.each(["not_loaded", "link_down"] as const)("With the house frozen (%s)", (reason) => {
      /** Saved rooms: V1 recorded, V2 observable without a record; V3 recorded and in no room. */
      const frozen = (): World => {
        const base = liveWorld(
          [room(BUILDER_ROOM, [V1, V2])],
          { [V1]: observed(), [V2]: observed(), [V3]: observed() },
          { ledger: ledgerOf(V1, V3) },
        );
        const saved = storedOf(base).membership;
        return { ...base, house: { kind: "frozen", membership: saved, reason } };
      };
      it("nothing joins and nothing is released", () => {
        const world = frozen();
        const result = reconcile(world);
        expect(result.joined).toEqual([]);
        expect(result.released).toEqual([]);
        expect(result.ledger).toBe(world.ledger);
        expect(result.stored).toBe(world.stored);
      });
      it("valves of saved rooms without a record are pending with house_frozen", () => {
        expect(reconcile(frozen()).pending).toEqual([
          { valveId: V2, roomId: BUILDER_ROOM, reason: "house_frozen", unreadable: [] },
        ]);
      });
      it("there is no saveConfig", () => {
        const world = frozen();
        // A membership HA would now report differently changes nothing while frozen.
        const result = reconcile(withStored(world, { membership: makeMembership({}) }));
        expect(result.effects).toEqual([]);
      });
    });

    describe("With the house unlinked", () => {
      it("effects and pending are empty", () => {
        const world: World = {
          ...liveWorld(
            [room(BUILDER_ROOM, [V1, V2])],
            { [V1]: observed(), [V2]: observed() },
            {
              ledger: ledgerOf(V1, V3),
            },
          ),
          house: { kind: "unlinked" },
        };
        const result = reconcile(world);
        expect(result.effects).toEqual([]);
        expect(result.pending).toEqual([]);
        expect(result.joined).toEqual([]);
        expect(result.released).toEqual([]);
      });
    });

    describe("With a config that has no schedule and a recorded valve in no room", () => {
      it("nothing is released", () => {
        const world = makeWorld({
          config: makeConfig({ schedules: [] }),
          ledger: ledgerOf(V1),
          devices: new Map([[V1, observed()]]),
        });
        const result = reconcile(world);
        expect(result.released).toEqual([]);
        expect(result.effects).toEqual([]);
      });
    });

    describe("With a live membership that differs from stored.membership", () => {
      it("saveConfig carries the new membership and keeps the revision", () => {
        const base = liveWorld(
          [room(BUILDER_ROOM, [V1])],
          { [V1]: observed() },
          {
            ledger: ledgerOf(V1),
          },
        );
        const membership: AreaMembership = makeMembership({ [BUILDER_ROOM]: [V1], hall: [] });
        const house: HouseInput = { kind: "live", membership, notInHa: [] };
        const result = reconcile({ ...base, house });
        expect(kinds(result.effects)).toEqual(["saveConfig"]);
        expect(savedConfig(result)?.membership).toBe(membership);
        expect(savedConfig(result)?.revision).toBe(storedOf(base).revision);
        expect(result.stored?.membership).toBe(membership);
      });
    });

    describe("With nothing to change", () => {
      it("effects are empty", () => {
        const world = liveWorld(
          [room(BUILDER_ROOM, [V1])],
          { [V1]: observed() },
          {
            ledger: ledgerOf(V1),
          },
        );
        const result = reconcile(world);
        expect(result.effects).toEqual([]);
        expect(result.stored).toBe(world.stored);
        expect(result.ledger).toBe(world.ledger);
      });
    });

    describe("With configState unreadable", () => {
      it("effects are empty", () => {
        const world = liveWorld([room(BUILDER_ROOM, [V1])], { [V1]: observed() });
        const result = reconcile({ ...world, configState: "unreadable", stored: undefined });
        expect(result.effects).toEqual([]);
        expect(result.pending).toEqual([]);
      });
    });
  });

  describe("acceptUnknownOriginals", () => {
    describe("For a valve pending with originals_unreadable", () => {
      it("saveLedger with a record whose unreadable originals are null, then writeOriginalsCopy", () => {
        const world = liveWorld([room(BUILDER_ROOM, [V1])], {
          [V1]: observed("trv_zbt", { sensor_source: "internal" }),
        });
        const effects = acceptUnknownOriginals(world, V1);
        expect(kinds(effects)).toEqual(["saveLedger", "writeOriginalsCopy"]);
        const saved = effects[0];
        const ledger = saved?.kind === "saveLedger" ? saved.ledger : undefined;
        expect(ledger?.records.get(V1)).toEqual({
          valveId: V1,
          profile: "sonoff_trv_zbt",
          adoptedAt: NOW_MS,
          originals: { active_group: null, sensor_source: "internal" },
        });
        expect(effects[1]).toEqual({ kind: "writeOriginalsCopy", ledger });
      });
    });

    describe("For a valve pending with valve_not_observed", () => {
      it("throws ChangeRefused valve_not_pending", () => {
        const world = liveWorld([room(BUILDER_ROOM, [V1])], { [V1]: silent() });
        const refused = refusal(() => acceptUnknownOriginals(world, V1));
        expect(refused.code).toBe("valve_not_pending");
        expect(refused.data).toEqual({ valveId: V1 });
      });
    });

    describe("For a managed valve, or a valve that is in no room", () => {
      it("throws ChangeRefused valve_not_pending", () => {
        const managed = liveWorld(
          [room(BUILDER_ROOM, [V1])],
          { [V1]: observed() },
          {
            ledger: ledgerOf(V1),
          },
        );
        const roomless = liveWorld([], { [V1]: observed("trvzb", {}) });
        expect(codeOf(() => acceptUnknownOriginals(managed, V1))).toBe("valve_not_pending");
        expect(codeOf(() => acceptUnknownOriginals(roomless, V1))).toBe("valve_not_pending");
      });
    });
  });
});
