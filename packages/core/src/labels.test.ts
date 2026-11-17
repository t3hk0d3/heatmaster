import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { arbConfig, makeConfig, makeMembership, makeSnapshot, weekOf } from "../test/builders.ts";
import {
  IGNORE_LABEL,
  LEGACY_SENSOR_LABEL,
  SENSOR_LABEL,
  scheduleLabelId,
  scheduleLabelName,
  type AreaMembership,
  type HaSnapshot,
} from "./house.ts";
import { applyLabelOps, mirrorLabels, type LabelOp } from "./labels.ts";
import type { Config, RoomEntry, Schedule } from "./model.ts";

const DAY: Schedule = { id: "day", name: "Day", defaultWeek: weekOf([]) };
const NIGHT: Schedule = { id: "night", name: "Night", defaultWeek: weekOf([]) };
const DAY_LABEL = "heatmaster_schedule_day";
const NIGHT_LABEL = "heatmaster_schedule_night";
const DAY_CLASH = "heatmaster_schedule_day_2";
const OLD_LABEL = "heatmaster_schedule_old";
const OLD_CLASH = "heatmaster_schedule_old_2";

const NO_PRESETS = { comfort: undefined, eco: undefined, frost: undefined, boost: undefined };
const NO_MEMBERSHIP: AreaMembership = makeMembership({});

/** An entry on `scheduleId` (the default when undefined) listing the given sensor entities. */
function entry(scheduleId: string | undefined, sensors: readonly string[] = []): RoomEntry {
  return {
    scheduleId,
    sensors: sensors.map((entityId) => ({ ref: `ha:${entityId}`, weight: 1 })),
    presets: NO_PRESETS,
  };
}

/** Schedules `day` (the default) and `night`, unless given, with the given entries. */
function configOf(
  entries: Readonly<Record<string, RoomEntry>> = {},
  schedules: readonly Schedule[] = [DAY, NIGHT],
): Config {
  return { ...makeConfig({ schedules }), rooms: new Map(Object.entries(entries)) };
}

/** The labels of both schedules, named as Heatmaster names them, plus the given ones. */
function labelsWith(extra: Record<string, string> = {}): Record<string, string> {
  return {
    [DAY_LABEL]: scheduleLabelName("Day"),
    [NIGHT_LABEL]: scheduleLabelName("Night"),
    ...extra,
  };
}

/** The ops that name `id`: as a label, a created name, a label added or removed, or an entity. */
function naming(ops: readonly LabelOp[], id: string): LabelOp[] {
  return ops.filter((op) => {
    switch (op.kind) {
      case "createLabel":
        return op.name === id;
      case "renameLabel":
      case "deleteLabel":
        return op.labelId === id;
      case "labelArea":
        return op.areaId === id || op.add.includes(id) || op.remove.includes(id);
      case "labelEntity":
        return op.entityId === id || op.add.includes(id) || op.remove.includes(id);
    }
  });
}

function rank(op: LabelOp): number {
  switch (op.kind) {
    case "createLabel":
    case "renameLabel":
      return 0;
    case "labelArea":
    case "labelEntity":
      return 1;
    case "deleteLabel":
      return 2;
  }
}

describe("labels", () => {
  describe("mirrorLabels", () => {
    describe('With a schedule "day" whose label is missing', () => {
      const plan = mirrorLabels(configOf({}, [DAY]), NO_MEMBERSHIP, makeSnapshot());
      it('ops are createLabel "heatmaster_schedule_day", then renameLabel to "Heatmaster: Day"', () => {
        expect(plan.ops).toEqual([
          { kind: "createLabel", name: DAY_LABEL },
          { kind: "renameLabel", labelId: DAY_LABEL, name: "Heatmaster: Day" },
        ]);
      });
    });

    describe('With the label heatmaster_schedule_day named "heatmaster_schedule_day" (a reinstall)', () => {
      const plan = mirrorLabels(
        configOf(),
        NO_MEMBERSHIP,
        makeSnapshot({ labels: labelsWith({ [DAY_LABEL]: DAY_LABEL }) }),
      );
      it('the only op for it is renameLabel to "Heatmaster: Day"', () => {
        expect(naming(plan.ops, DAY_LABEL)).toEqual([
          { kind: "renameLabel", labelId: DAY_LABEL, name: "Heatmaster: Day" },
        ]);
      });
    });

    describe('With the label already named "Heatmaster: Day"', () => {
      const plan = mirrorLabels(configOf(), NO_MEMBERSHIP, makeSnapshot({ labels: labelsWith() }));
      it("no op names it", () => {
        expect(naming(plan.ops, DAY_LABEL)).toEqual([]);
      });
    });

    describe('With schedule id "work-week"', () => {
      const workWeek: Schedule = { id: "work-week", name: "Work week", defaultWeek: weekOf([]) };
      const plan = mirrorLabels(configOf({}, [workWeek]), NO_MEMBERSHIP, makeSnapshot());
      it("createLabel names heatmaster_schedule_work_week", () => {
        expect(plan.ops).toContainEqual({
          kind: "createLabel",
          name: "heatmaster_schedule_work_week",
        });
      });
    });

    describe("With a renamed schedule", () => {
      const renamed: Schedule = { ...DAY, name: "Weekdays" };
      const plan = mirrorLabels(
        configOf({}, [renamed]),
        NO_MEMBERSHIP,
        makeSnapshot({ labels: { [DAY_LABEL]: "Heatmaster: Day" } }),
      );
      it("renameLabel to the new display name", () => {
        expect(plan.ops).toEqual([
          { kind: "renameLabel", labelId: DAY_LABEL, name: "Heatmaster: Weekdays" },
        ]);
      });
    });

    describe("With a room on the default schedule wearing no label", () => {
      const plan = mirrorLabels(
        configOf(),
        makeMembership({ living: ["z2m:a"] }),
        makeSnapshot({ areas: { living: {} }, labels: labelsWith() }),
      );
      it("labelArea adds the default's label", () => {
        expect(plan.ops).toEqual([
          { kind: "labelArea", areaId: "living", add: [DAY_LABEL], remove: [] },
        ]);
      });
    });

    describe("With a room whose entry names night, wearing day's label", () => {
      const plan = mirrorLabels(
        configOf({ living: entry("night") }),
        makeMembership({ living: ["z2m:a"] }),
        makeSnapshot({ areas: { living: { labels: [DAY_LABEL] } }, labels: labelsWith() }),
      );
      it("labelArea adds night's label and removes day's", () => {
        expect(plan.ops).toEqual([
          { kind: "labelArea", areaId: "living", add: [NIGHT_LABEL], remove: [DAY_LABEL] },
        ]);
      });
    });

    describe("With an unused entry naming night", () => {
      const plan = mirrorLabels(
        configOf({ attic: entry("night") }),
        NO_MEMBERSHIP,
        makeSnapshot({ areas: { attic: {} }, labels: labelsWith() }),
      );
      it("its area gets night's label", () => {
        expect(plan.ops).toEqual([
          { kind: "labelArea", areaId: "attic", add: [NIGHT_LABEL], remove: [] },
        ]);
      });
    });

    describe("With an area that is no room and has no entry, wearing day's label", () => {
      const plan = mirrorLabels(
        configOf(),
        NO_MEMBERSHIP,
        makeSnapshot({ areas: { garage: { labels: [DAY_LABEL] } }, labels: labelsWith() }),
      );
      it("labelArea removes day's label", () => {
        expect(plan.ops).toEqual([
          { kind: "labelArea", areaId: "garage", add: [], remove: [DAY_LABEL] },
        ]);
      });
    });

    describe('With an area also wearing the user\'s label "kids"', () => {
      const plan = mirrorLabels(
        configOf({ bedroom: entry("night") }),
        makeMembership({ bedroom: ["z2m:a"] }),
        makeSnapshot({
          areas: { bedroom: { labels: ["kids", DAY_LABEL] } },
          labels: labelsWith({ kids: "Kids" }),
        }),
      );
      it('"kids" is in no op', () => {
        expect(plan.ops).not.toEqual([]);
        expect(naming(plan.ops, "kids")).toEqual([]);
      });
    });

    describe("With the label heatmaster_schedule_old whose schedule no longer exists", () => {
      const plan = mirrorLabels(
        configOf(),
        makeMembership({ living: ["z2m:a"] }),
        makeSnapshot({
          areas: { living: { labels: [OLD_LABEL] } },
          labels: { [OLD_LABEL]: "Heatmaster: Old" },
        }),
      );
      it("deleteLabel heatmaster_schedule_old is the last op", () => {
        expect(plan.ops.length).toBeGreaterThan(1);
        expect(plan.ops.at(-1)).toEqual({ kind: "deleteLabel", labelId: OLD_LABEL });
      });
    });

    describe("With the label heatmaster_schedule_day_2 while schedule day exists", () => {
      const snapshot = makeSnapshot({
        areas: { living: { labels: [DAY_CLASH] }, garage: { labels: [DAY_CLASH] } },
        labels: labelsWith({ [DAY_CLASH]: "Heatmaster: Something" }),
      });
      const plan = mirrorLabels(configOf(), makeMembership({ living: ["z2m:a"] }), snapshot);
      it("no op names heatmaster_schedule_day_2", () => {
        expect(plan.ops).not.toEqual([]);
        expect(naming(plan.ops, DAY_CLASH)).toEqual([]);
      });
      it("foreign lists it", () => {
        expect(plan.foreign).toEqual([DAY_CLASH]);
      });
      it("with day's own label missing, there is no createLabel for day", () => {
        const missing = mirrorLabels(
          configOf(),
          makeMembership({ living: ["z2m:a"] }),
          makeSnapshot({
            areas: { living: {} },
            labels: { [NIGHT_LABEL]: "Heatmaster: Night", [DAY_CLASH]: "Heatmaster: Day" },
          }),
        );
        expect(naming(missing.ops, DAY_LABEL)).toEqual([]);
      });
    });

    describe("With the label heatmaster_schedule_old_2 while heatmaster_schedule_old exists and schedule old no longer exists", () => {
      const plan = mirrorLabels(
        configOf(),
        NO_MEMBERSHIP,
        makeSnapshot({
          labels: labelsWith({ [OLD_LABEL]: "Heatmaster: Old", [OLD_CLASH]: "Heatmaster: Old" }),
        }),
      );
      it("deleteLabel names heatmaster_schedule_old and not heatmaster_schedule_old_2", () => {
        expect(plan.ops.filter((op) => op.kind === "deleteLabel")).toEqual([
          { kind: "deleteLabel", labelId: OLD_LABEL },
        ]);
      });
      it("foreign lists heatmaster_schedule_old_2", () => {
        expect(plan.foreign).toEqual([OLD_CLASH]);
      });
    });

    describe("With a configured sensor whose entity lacks heatmaster_temp_sensor", () => {
      const plan = mirrorLabels(
        configOf({ living: entry(undefined, ["sensor.living"]) }),
        NO_MEMBERSHIP,
        makeSnapshot({
          entities: { "sensor.living": { labels: ["kids"] } },
          labels: labelsWith({ [SENSOR_LABEL]: "Heatmaster sensor" }),
        }),
      );
      it("labelEntity adds heatmaster_temp_sensor", () => {
        expect(plan.ops).toEqual([
          { kind: "labelEntity", entityId: "sensor.living", add: [SENSOR_LABEL], remove: [] },
        ]);
      });
    });

    describe("With an entity carrying heatmaster_temp_sensor that no entry lists", () => {
      const plan = mirrorLabels(
        configOf(),
        NO_MEMBERSHIP,
        makeSnapshot({
          entities: { "sensor.old": { labels: [SENSOR_LABEL, LEGACY_SENSOR_LABEL] } },
          labels: labelsWith({ [SENSOR_LABEL]: "Heatmaster sensor" }),
        }),
      );
      it("labelEntity removes heatmaster_temp_sensor", () => {
        expect(plan.ops).toEqual([
          { kind: "labelEntity", entityId: "sensor.old", add: [], remove: [SENSOR_LABEL] },
        ]);
      });
    });

    describe("With heatmaster_temp_sensor missing from the label registry and a sensor configured", () => {
      const plan = mirrorLabels(
        configOf({ living: entry(undefined, ["sensor.living", "sensor.hall"]) }),
        NO_MEMBERSHIP,
        makeSnapshot({
          entities: { "sensor.living": {}, "sensor.hall": {} },
          labels: labelsWith(),
        }),
      );
      it('createLabel "heatmaster_temp_sensor" comes before every labelEntity op and is never renamed', () => {
        const created = plan.ops.findIndex(
          (op) => op.kind === "createLabel" && op.name === SENSOR_LABEL,
        );
        const entityOps = plan.ops.flatMap((op, i) => (op.kind === "labelEntity" ? [i] : []));
        expect(created).toBeGreaterThanOrEqual(0);
        expect(entityOps).toHaveLength(2);
        expect(entityOps.every((i) => i > created)).toBe(true);
        expect(
          plan.ops.filter((op) => op.kind === "renameLabel" && op.labelId === SENSOR_LABEL),
        ).toEqual([]);
      });
    });

    describe("With a configured sensor that has no registry entry", () => {
      const plan = mirrorLabels(
        configOf({
          living: entry(undefined, ["sensor.living", "sensor.ghost"]),
          attic: entry(undefined, ["sensor.phantom"]),
        }),
        NO_MEMBERSHIP,
        makeSnapshot({
          entities: { "sensor.living": { labels: [SENSOR_LABEL] } },
          labels: labelsWith({ [SENSOR_LABEL]: "Heatmaster sensor" }),
        }),
      );
      it("unlabellable lists it and no op names it", () => {
        expect(plan.unlabellable).toEqual(["sensor.ghost", "sensor.phantom"]);
        expect(naming(plan.ops, "sensor.ghost")).toEqual([]);
        expect(naming(plan.ops, "sensor.phantom")).toEqual([]);
      });
    });

    describe("With heatmaster_ignore on an area", () => {
      const plan = mirrorLabels(
        configOf({ shed: entry("night") }),
        { rooms: new Map(), ignored: ["shed"] },
        makeSnapshot({
          areas: { shed: { labels: [IGNORE_LABEL, DAY_LABEL] } },
          labels: labelsWith({ [IGNORE_LABEL]: "Heatmaster ignore" }),
        }),
      );
      it("no op names heatmaster_ignore", () => {
        expect(plan.ops).not.toEqual([]);
        expect(naming(plan.ops, IGNORE_LABEL)).toEqual([]);
      });
    });

    describe("With scope schedules, a configured sensor lacking its label and heatmaster_temp_sensor missing", () => {
      const plan = mirrorLabels(
        configOf({ living: entry(undefined, ["sensor.living", "sensor.ghost"]) }, [DAY]),
        makeMembership({ living: ["z2m:a"] }),
        makeSnapshot({
          areas: { living: {} },
          entities: { "sensor.living": {}, "sensor.stale": { labels: [SENSOR_LABEL] } },
        }),
        "schedules",
      );
      it('no labelEntity op and no createLabel "heatmaster_temp_sensor" is planned', () => {
        expect(plan.ops).toEqual([
          { kind: "createLabel", name: DAY_LABEL },
          { kind: "renameLabel", labelId: DAY_LABEL, name: "Heatmaster: Day" },
          { kind: "labelArea", areaId: "living", add: [DAY_LABEL], remove: [] },
        ]);
      });
      it("unlabellable is empty", () => {
        expect(plan.unlabellable).toEqual([]);
      });
    });

    describe("Ordering", () => {
      const plan = mirrorLabels(
        configOf({ living: entry("night", ["sensor.living"]) }, [DAY, NIGHT]),
        makeMembership({ living: ["z2m:a"], hall: ["z2m:b"] }),
        makeSnapshot({
          areas: { hall: { labels: [OLD_LABEL] }, living: { labels: [DAY_LABEL] } },
          entities: { "sensor.living": {}, "sensor.stale": { labels: [SENSOR_LABEL] } },
          labels: { [OLD_LABEL]: "Heatmaster: Old", [DAY_LABEL]: "Day" },
        }),
      );
      it("createLabel and renameLabel come before labelArea and labelEntity, and deleteLabel comes last", () => {
        const ranks = plan.ops.map(rank);
        expect(new Set(ranks)).toEqual(new Set([0, 1, 2]));
        expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      });
    });

    describe("Property: applying the ops with the ids asked for, then mirroring again", () => {
      fcTest.prop([arbScene()])("gives no op", ({ config, membership, snapshot }) => {
        const all = mirrorLabels(config, membership, snapshot);
        const created = new Map(
          all.ops.flatMap((op) => (op.kind === "createLabel" ? [[op.name, op.name] as const] : [])),
        );
        const after = applyLabelOps(snapshot, all.ops, created);
        expect(mirrorLabels(config, membership, after).ops).toEqual([]);
        const schedules = mirrorLabels(config, membership, snapshot, "schedules");
        const afterSchedules = applyLabelOps(snapshot, schedules.ops, created);
        expect(mirrorLabels(config, membership, afterSchedules, "schedules").ops).toEqual([]);
      });
    });
  });

  describe("applyLabelOps", () => {
    const snapshot = makeSnapshot({
      areas: {
        living: { name: "Living", labels: ["kids", DAY_LABEL] },
        hall: { labels: [DAY_LABEL] },
      },
      valveAreas: { "z2m:a": "living" },
      entities: {
        "sensor.living": { areaId: "living", labels: [SENSOR_LABEL, DAY_LABEL] },
        "sensor.hall": { labels: [] },
      },
      labels: { [DAY_LABEL]: "Heatmaster: Day", kids: "Kids", [SENSOR_LABEL]: "Sensor" },
    });

    describe("With a createLabel done and created mapping its name to an id", () => {
      const after = applyLabelOps(
        snapshot,
        [{ kind: "createLabel", name: NIGHT_LABEL }],
        new Map([[NIGHT_LABEL, "heatmaster_schedule_night_2"]]),
      );
      it("labels maps that id to the name", () => {
        expect(after.labels.get("heatmaster_schedule_night_2")).toBe(NIGHT_LABEL);
      });
    });

    describe("With a renameLabel done", () => {
      const after = applyLabelOps(
        snapshot,
        [{ kind: "renameLabel", labelId: DAY_LABEL, name: "Heatmaster: Weekdays" }],
        new Map(),
      );
      it("labels holds the new name", () => {
        expect(after.labels.get(DAY_LABEL)).toBe("Heatmaster: Weekdays");
      });
    });

    describe("With a deleteLabel done", () => {
      const after = applyLabelOps(
        snapshot,
        [{ kind: "deleteLabel", labelId: DAY_LABEL }],
        new Map(),
      );
      it("the label is gone from labels, from every area and from every entity", () => {
        expect(after.labels.has(DAY_LABEL)).toBe(false);
        expect([...after.areas.values()].some((a) => a.labels.includes(DAY_LABEL))).toBe(false);
        expect([...after.entities.values()].some((e) => e.labels.includes(DAY_LABEL))).toBe(false);
      });
    });

    describe("With a labelArea done", () => {
      const after = applyLabelOps(
        snapshot,
        [{ kind: "labelArea", areaId: "living", add: [NIGHT_LABEL], remove: [DAY_LABEL] }],
        new Map(),
      );
      it("the area's labels gain add and lose remove, and nothing else changes", () => {
        const expected: HaSnapshot = {
          ...snapshot,
          areas: new Map([
            ["living", { name: "Living", labels: ["kids", NIGHT_LABEL] }],
            ["hall", { name: "hall", labels: [DAY_LABEL] }],
          ]),
        };
        expect(after).toEqual(expected);
      });
    });

    describe("With a labelEntity done", () => {
      const after = applyLabelOps(
        snapshot,
        [{ kind: "labelEntity", entityId: "sensor.hall", add: [SENSOR_LABEL], remove: ["kids"] }],
        new Map(),
      );
      it("the entity's labels gain add and lose remove, and nothing else changes", () => {
        const expected: HaSnapshot = {
          ...snapshot,
          entities: new Map([
            ["sensor.living", { areaId: "living", labels: [SENSOR_LABEL, DAY_LABEL] }],
            ["sensor.hall", { areaId: undefined, labels: [SENSOR_LABEL] }],
          ]),
        };
        expect(after).toEqual(expected);
      });
    });

    describe("With an op that is not in done", () => {
      const plan = mirrorLabels(
        configOf({ hall: entry("night") }),
        makeMembership({ living: ["z2m:a"], hall: ["z2m:b"] }),
        snapshot,
      );
      const done = plan.ops.filter((op) => op.kind !== "labelArea" || op.areaId !== "hall");
      const after = applyLabelOps(snapshot, done, new Map([[NIGHT_LABEL, NIGHT_LABEL]]));
      it("the snapshot does not show it", () => {
        expect(plan.ops).toContainEqual({
          kind: "labelArea",
          areaId: "hall",
          add: [NIGHT_LABEL],
          remove: [DAY_LABEL],
        });
        expect(after.areas.get("hall")).toEqual(snapshot.areas.get("hall"));
        expect(after.labels.get(NIGHT_LABEL)).toBe("Heatmaster: Night");
      });
    });
  });
});

type Scene = Readonly<{ config: Config; membership: AreaMembership; snapshot: HaSnapshot }>;

const USER_LABELS = ["kids", IGNORE_LABEL, LEGACY_SENSOR_LABEL];
const STALE_LABEL = "heatmaster_schedule_stale_x";
const SENSOR_ENTITIES = [0, 1, 2, 3, 4, 5].map((n) => `sensor.s${String(n)}`);
const EXTRA_AREAS = ["spare", "garage"];

/**
 * Any valid config, rooms out of its entry areas and two more, and a snapshot in which each
 * schedule's label may be missing, misnamed or right and may have a `_2` clash label; a stale
 * owned label, the sensor label and user labels may exist; areas and sensor entities wear any of
 * these. A clash of a stale label is left out (see the report: it is owned once its base is gone).
 */
function arbScene(): fc.Arbitrary<Scene> {
  return arbConfig.chain((config) => {
    const areaIds = [...config.rooms.keys(), ...EXTRA_AREAS.filter((a) => !config.rooms.has(a))];
    const scheduleLabels = config.schedules.map((s) => scheduleLabelId(s.id));
    const labelPool = [
      ...scheduleLabels,
      ...scheduleLabels.map((id) => `${id}_2`),
      STALE_LABEL,
      SENSOR_LABEL,
      ...USER_LABELS,
    ];
    const nameOf = (id: string): fc.Arbitrary<string> => {
      const schedule = config.schedules.find((s) => scheduleLabelId(s.id) === id);
      return schedule === undefined
        ? fc.constant(id)
        : fc.constantFrom(scheduleLabelName(schedule.name), id, "Something else");
    };
    return fc
      .record({
        config: fc.constant(config),
        rooms: fc.subarray(areaIds),
        registry: fc
          .subarray(labelPool)
          .chain((ids) => fc.tuple(...ids.map((id) => nameOf(id).map((n) => [id, n] as const)))),
        areas: fc
          .subarray(areaIds)
          .chain((ids) =>
            fc.tuple(...ids.map((id) => fc.subarray(labelPool).map((ls) => [id, ls] as const))),
          ),
        entities: fc
          .subarray(SENSOR_ENTITIES)
          .chain((ids) =>
            fc.tuple(
              ...ids.map((id) =>
                fc
                  .subarray([SENSOR_LABEL, "kids", LEGACY_SENSOR_LABEL])
                  .map((ls) => [id, ls] as const),
              ),
            ),
          ),
      })
      .map(({ config: c, rooms, registry, areas, entities }) => ({
        config: c,
        membership: makeMembership(Object.fromEntries(rooms.map((id) => [id, [`z2m:${id}`]]))),
        snapshot: makeSnapshot({
          areas: Object.fromEntries(areas.map(([id, labels]) => [id, { labels: [...labels] }])),
          entities: Object.fromEntries(
            entities.map(([id, labels]) => [id, { labels: [...labels] }]),
          ),
          labels: Object.fromEntries(registry),
        }),
      }));
  });
}
