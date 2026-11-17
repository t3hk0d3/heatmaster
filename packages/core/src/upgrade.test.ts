import { describe, expect, it } from "vitest";
import { storedFromRaw } from "./ledger.ts";
import { upgradeStoredV2 } from "./upgrade.ts";

const V1 = "z2m:0x00124b0000000001";
const V2 = "z2m:0x00124b0000000002";
const V3 = "z2m:0x00124b0000000003";
const RELEASING = { "z2m:0x00124b0000000009": "2026-11-14T09:30:00.000Z" };

type V2Room = Readonly<{
  id: string;
  name: string;
  area_id?: string;
  schedule_id: string;
  valves: readonly Readonly<{ id: string }>[];
  sensors?: readonly Readonly<{ ref: string; weight?: number }>[];
  presets?: Readonly<Record<string, number>>;
}>;

function v2Schedule(id: string): Record<string, unknown> {
  return { id, name: `Schedule ${id}`, week: [{ days: "all", temperature: { "00:00": 18 } }] };
}

function v2Room(
  id: string,
  areaId: string | undefined,
  scheduleId: string,
  valveIds: readonly string[],
): V2Room {
  return {
    id,
    name: `Room ${id}`,
    ...(areaId === undefined ? {} : { area_id: areaId }),
    schedule_id: scheduleId,
    valves: valveIds.map((valveId) => ({ id: valveId })),
  };
}

/** The data of a version 2 config file: revision 4, one valve releasing, writes not held. */
function v2Stored(
  rooms: readonly V2Room[],
  scheduleIds: readonly string[] = ["a", "b"],
): Record<string, unknown> {
  return {
    revision: 4,
    releasing: RELEASING,
    config: {
      version: 2,
      settings: { hold_writes: false, timezone: "Europe/Amsterdam" },
      presets: { comfort: 21 },
      schedules: scheduleIds.map(v2Schedule),
      rooms,
    },
  };
}

type V3Data = Readonly<{
  revision: unknown;
  releasing: unknown;
  config: Readonly<{
    settings: Readonly<Record<string, unknown>>;
    default_schedule?: string;
    rooms: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  }>;
  membership: Readonly<{
    rooms: Readonly<Record<string, Readonly<{ name: string; valves: readonly string[] }>>>;
    ignored: readonly string[];
  }>;
  sensor_import: unknown;
  ha_changes: unknown;
  upgrade: Readonly<{ from_version: number; dropped_rooms: readonly unknown[] }>;
}>;

function upgraded(data: unknown): V3Data {
  return upgradeStoredV2(data) as V3Data;
}

describe("upgrade", () => {
  describe("upgradeStoredV2", () => {
    describe("With v2 rooms on areas office and mancave", () => {
      const result = (): V3Data =>
        upgraded(
          v2Stored([
            v2Room("office", "office", "a", [V1]),
            v2Room("kabinet", "mancave", "a", [V2, V3]),
          ]),
        );
      it("rooms has the entries office and mancave", () => {
        expect(Object.keys(result().config.rooms)).toEqual(["office", "mancave"]);
      });
      it("membership holds office and mancave with the v2 valve lists and the v2 room names", () => {
        expect(result().membership.rooms).toEqual({
          office: { name: "Room office", valves: [V1] },
          mancave: { name: "Room kabinet", valves: [V2, V3] },
        });
      });
    });

    describe("With a v2 room whose valves are listed in descending order", () => {
      it("its membership room lists them in ascending order", () => {
        const result = upgraded(v2Stored([v2Room("office", "office", "a", [V3, V2, V1])]));
        expect(result.membership.rooms.office?.valves).toEqual([V1, V2, V3]);
      });
    });

    describe("With rooms using schedule a twice and b once", () => {
      const result = (): V3Data =>
        upgraded(
          v2Stored([
            v2Room("one", "one", "a", [V1]),
            v2Room("two", "two", "b", [V2]),
            v2Room("three", "three", "a", [V3]),
          ]),
        );
      it("default_schedule is a", () => {
        expect(result().config.default_schedule).toBe("a");
      });
      it("the room on b has schedule b and the rooms on a have no schedule key", () => {
        const rooms = result().config.rooms;
        expect(rooms.two?.schedule).toBe("b");
        expect(Object.hasOwn(rooms.one ?? {}, "schedule")).toBe(false);
        expect(Object.hasOwn(rooms.three ?? {}, "schedule")).toBe(false);
      });
    });

    describe("With a tie between two schedules", () => {
      it("the schedule listed first is the default", () => {
        const result = upgraded(
          v2Stored([v2Room("one", "one", "b", [V1]), v2Room("two", "two", "a", [V2])], ["a", "b"]),
        );
        expect(result.config.default_schedule).toBe("a");
      });
    });

    describe("With no room and two schedules", () => {
      it("the first schedule is the default", () => {
        expect(upgraded(v2Stored([], ["b", "a"])).config.default_schedule).toBe("b");
      });
    });

    describe("With no schedule", () => {
      it("there is no default_schedule", () => {
        expect(Object.hasOwn(upgraded(v2Stored([], [])).config, "default_schedule")).toBe(false);
      });
    });

    describe("With a v2 room without area_id", () => {
      const result = (): V3Data =>
        upgraded(
          v2Stored([
            v2Room("office", "office", "a", [V1]),
            v2Room("attic", undefined, "a", [V3, V2]),
          ]),
        );
      it("it has no entry and no membership room", () => {
        const data = result();
        expect(Object.keys(data.config.rooms)).toEqual(["office"]);
        expect(Object.keys(data.membership.rooms)).toEqual(["office"]);
      });
      it("upgrade.dropped_rooms lists its id, name, valves and reason no_area", () => {
        expect(result().upgrade.dropped_rooms).toEqual([
          { room_id: "attic", name: "Room attic", valves: [V3, V2], reason: "no_area" },
        ]);
      });
      it("releasing is unchanged", () => {
        expect(result().releasing).toEqual(RELEASING);
      });
    });

    describe("With two v2 rooms on one area", () => {
      const result = (): V3Data =>
        upgraded(
          v2Stored([v2Room("first", "office", "b", [V1]), v2Room("second", "office", "a", [V2])]),
        );
      it("the first keeps the entry and the membership room", () => {
        const data = result();
        expect(data.config.rooms.office).toEqual({ schedule: "b" });
        expect(data.membership.rooms).toEqual({ office: { name: "Room first", valves: [V1] } });
      });
      it("the second is dropped with area_duplicate", () => {
        expect(result().upgrade.dropped_rooms).toEqual([
          { room_id: "second", name: "Room second", valves: [V2], reason: "area_duplicate" },
        ]);
      });
    });

    describe('With area_id "Living Room"', () => {
      it("the room is dropped with area_id_invalid", () => {
        const result = upgraded(v2Stored([v2Room("living", "Living Room", "a", [V1])]));
        expect(result.upgrade.dropped_rooms).toEqual([
          { room_id: "living", name: "Room living", valves: [V1], reason: "area_id_invalid" },
        ]);
      });
    });

    describe("With hold_writes false", () => {
      it("hold_writes is true", () => {
        const result = upgraded(v2Stored([v2Room("office", "office", "a", [V1])]));
        expect(result.config.settings.hold_writes).toBe(true);
      });
    });

    describe("Always", () => {
      const data = (): Record<string, unknown> =>
        v2Stored([
          {
            ...v2Room("office", "office", "a", [V1]),
            sensors: [{ ref: "ha:sensor.office_temperature", weight: 2 }],
            presets: { comfort: 22 },
          },
          { ...v2Room("hall", "hall", "b", [V2]), sensors: [{ ref: "ha:sensor.hall" }] },
          v2Room("attic", undefined, "a", [V3]),
        ]);
      it("sensor_import is pending, ha_changes is empty, revision and releasing are unchanged", () => {
        const result = upgraded(data());
        expect(result.sensor_import).toBe("pending");
        expect(result.ha_changes).toEqual([]);
        expect(result.revision).toBe(4);
        expect(result.releasing).toEqual(RELEASING);
      });
      it("each kept room's sensors and presets are carried into its entry", () => {
        expect(upgraded(data()).config.rooms).toEqual({
          office: {
            sensors: [{ ref: "ha:sensor.office_temperature", weight: 2 }],
            presets: { comfort: 22 },
          },
          hall: { schedule: "b", sensors: [{ ref: "ha:sensor.hall" }] },
        });
      });
      it("the result passes storedFromRaw", () => {
        const result = JSON.parse(JSON.stringify(upgradeStoredV2(data()))) as unknown;
        expect(() => storedFromRaw(result)).not.toThrow();
      });
    });

    describe("With data that is not a readable v2 stored config", () => {
      const config = (): Record<string, unknown> => v2Stored([]).config as Record<string, unknown>;
      it.each([
        ["not an object", [v2Stored([])]],
        ["without revision", { releasing: {}, config: config() }],
        ["without releasing", { revision: 1, config: config() }],
        ["without config", { revision: 1, releasing: {} }],
        [
          "with config version 3",
          { revision: 1, releasing: {}, config: { ...config(), version: 3 } },
        ],
        [
          "without a rooms list",
          { revision: 1, releasing: {}, config: { ...config(), rooms: {} } },
        ],
      ])("throws (%s)", (_, data) => {
        expect(() => upgradeStoredV2(data)).toThrow(Error);
      });
    });
  });
});
