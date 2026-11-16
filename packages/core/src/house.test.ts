import { describe, expect, it } from "vitest";
import { makeMembership, makeSnapshot } from "../test/builders.ts";
import {
  membershipFrom,
  sameMembership,
  scheduleLabelId,
  scheduleLabelName,
  type AreaMembership,
} from "./house.ts";

const A = "z2m:0x00124b0000000001";
const B = "z2m:0x00124b0000000002";

describe("house", () => {
  describe("scheduleLabelId", () => {
    describe('With "day"', () => {
      it('returns "heatmaster_schedule_day"', () => {
        expect(scheduleLabelId("day")).toBe("heatmaster_schedule_day");
      });
    });
    describe('With "work-week"', () => {
      it('returns "heatmaster_schedule_work_week"', () => {
        expect(scheduleLabelId("work-week")).toBe("heatmaster_schedule_work_week");
      });
    });
  });

  describe("scheduleLabelName", () => {
    describe('With "Night"', () => {
      it('returns "Heatmaster: Night"', () => {
        expect(scheduleLabelName("Night")).toBe("Heatmaster: Night");
      });
    });
  });

  describe("membershipFrom", () => {
    describe("With two areas each holding one supported valve", () => {
      const snapshot = makeSnapshot({
        areas: { hall: { name: "Hall" }, study: { name: "Study" } },
        valveAreas: { [A]: "hall", [B]: "study" },
      });
      const view = membershipFrom(snapshot, new Set([A, B]), undefined);
      it("rooms holds both areas, each with its valve", () => {
        expect([...view.membership.rooms].map(([id, r]) => [id, r.valveIds])).toEqual([
          ["hall", [A]],
          ["study", [B]],
        ]);
      });
      it("each room's name is its area's name", () => {
        expect(view.membership.rooms.get("hall")?.name).toBe("Hall");
        expect(view.membership.rooms.get("study")?.name).toBe("Study");
      });
    });

    describe("With two valves in one area, given in descending id order", () => {
      it("the room lists them in ascending id order", () => {
        const snapshot = makeSnapshot({
          areas: { hall: {} },
          valveAreas: { [B]: "hall", [A]: "hall" },
        });
        const view = membershipFrom(snapshot, new Set([B, A]), undefined);
        expect(view.membership.rooms.get("hall")?.valveIds).toEqual([A, B]);
      });
    });

    describe("With a valve whose device has no area", () => {
      const view = membershipFrom(
        makeSnapshot({ valveAreas: { [A]: null } }),
        new Set([A]),
        undefined,
      );
      it("the valve is in no room", () => {
        expect(view.membership.rooms.size).toBe(0);
      });
      it("unplaced gives it no_area", () => {
        expect(view.unplaced.get(A)).toBe("no_area");
      });
    });

    describe("With a valve in an area labelled heatmaster_ignore", () => {
      const view = membershipFrom(
        makeSnapshot({
          areas: { attic: { labels: ["heatmaster_ignore"] } },
          valveAreas: { [A]: "attic" },
        }),
        new Set([A]),
        undefined,
      );
      it("the area is not a room", () => {
        expect(view.membership.rooms.has("attic")).toBe(false);
      });
      it("unplaced gives the valve ignored_area", () => {
        expect(view.unplaced.get(A)).toBe("ignored_area");
      });
      it("ignored lists the area", () => {
        expect(view.membership.ignored).toEqual(["attic"]);
      });
    });

    describe("With an area labelled heatmaster_ignore that holds no valve", () => {
      it("ignored lists the area", () => {
        const view = membershipFrom(
          makeSnapshot({ areas: { shed: { labels: ["heatmaster_ignore"] }, ab: {} } }),
          new Set(),
          undefined,
        );
        expect(view.membership.ignored).toEqual(["shed"]);
      });
    });

    describe("With an area that holds only sensors", () => {
      it("it is not a room", () => {
        const view = membershipFrom(
          makeSnapshot({
            areas: { cellar: {} },
            entities: { "sensor.cellar_temp": { areaId: "cellar" } },
          }),
          new Set(),
          undefined,
        );
        expect(view.membership.rooms.size).toBe(0);
      });
    });

    describe("With a device in an area whose id is not in valveIds", () => {
      const view = membershipFrom(
        makeSnapshot({ areas: { hall: {} }, valveAreas: { [A]: "hall" } }),
        new Set(),
        undefined,
      );
      it("it is in no room and not in unplaced", () => {
        expect(view.membership.rooms.size).toBe(0);
        expect(view.unplaced.has(A)).toBe(false);
      });
    });

    describe("With a valve HA has no device for, that previous put in a room whose area still exists", () => {
      const view = membershipFrom(
        makeSnapshot({ areas: { hall: {} } }),
        new Set([A]),
        makeMembership({ hall: [A] }),
      );
      it("it stays in that room", () => {
        expect(view.membership.rooms.get("hall")?.valveIds).toEqual([A]);
      });
      it("notInHa lists it", () => {
        expect(view.notInHa).toEqual([A]);
      });
    });

    describe("With the same valve and previous undefined", () => {
      it("unplaced gives it not_in_ha", () => {
        const view = membershipFrom(makeSnapshot({ areas: { hall: {} } }), new Set([A]), undefined);
        expect(view.unplaced.get(A)).toBe("not_in_ha");
      });
    });

    describe("With the same valve whose previous area now carries heatmaster_ignore", () => {
      it("unplaced gives it not_in_ha", () => {
        const view = membershipFrom(
          makeSnapshot({ areas: { hall: { labels: ["heatmaster_ignore"] } } }),
          new Set([A]),
          makeMembership({ hall: [A] }),
        );
        expect(view.unplaced.get(A)).toBe("not_in_ha");
      });
    });

    describe("With a valve whose device names an area missing from the area registry", () => {
      it("it is kept in its previous room and listed in notInHa", () => {
        const view = membershipFrom(
          makeSnapshot({ areas: { hall: {} }, valveAreas: { [A]: "gone" } }),
          new Set([A]),
          makeMembership({ hall: [A] }),
        );
        expect(view.membership.rooms.get("hall")?.valveIds).toEqual([A]);
        expect(view.notInHa).toEqual([A]);
      });
    });

    describe("With an area renamed since previous", () => {
      it("the room carries the new name", () => {
        const view = membershipFrom(
          makeSnapshot({ areas: { hall: { name: "Entrance" } }, valveAreas: { [A]: "hall" } }),
          new Set([A]),
          makeMembership({ hall: [A] }),
        );
        expect(view.membership.rooms.get("hall")?.name).toBe("Entrance");
      });
    });
  });

  describe("sameMembership", () => {
    const base = (): AreaMembership => makeMembership({ hall: [A], study: [B] }, ["attic"]);
    describe("With equal rooms, names, valves and ignored lists", () => {
      it("returns true", () => {
        expect(sameMembership(base(), base())).toBe(true);
      });
    });
    describe("With one valve moved to another room", () => {
      it("returns false", () => {
        expect(sameMembership(base(), makeMembership({ hall: [B], study: [A] }, ["attic"]))).toBe(
          false,
        );
      });
    });
    describe("With an area renamed", () => {
      it("returns false", () => {
        const renamed: AreaMembership = {
          ...base(),
          rooms: new Map([...base().rooms, ["hall", { name: "Entrance", valveIds: [A] }]]),
        };
        expect(sameMembership(base(), renamed)).toBe(false);
      });
    });
    describe("With an ignored list that differs", () => {
      it("returns false", () => {
        expect(
          sameMembership(base(), makeMembership({ hall: [A], study: [B] }, ["attic", "shed"])),
        ).toBe(false);
      });
    });
    describe("With both undefined", () => {
      it("returns true", () => {
        expect(sameMembership(undefined, undefined)).toBe(true);
      });
    });
    describe("With one undefined", () => {
      it("returns false", () => {
        expect(sameMembership(base(), undefined)).toBe(false);
        expect(sameMembership(undefined, base())).toBe(false);
      });
    });
  });
});
