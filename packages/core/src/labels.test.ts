import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { arbConfig, makeConfig, makeMembership, makeSnapshot, weekOf } from "../test/builders.ts";
import type { ContactInfo, SensorInfo } from "./change.ts";
import {
  NO_WINDOW_PATCH,
  IGNORE_LABEL,
  LEGACY_SENSOR_LABEL,
  SENSOR_LABEL,
  WINDOW_SENSOR_LABEL,
  scheduleLabelId,
  scheduleLabelName,
  type AreaMembership,
  type HaSnapshot,
} from "./house.ts";
import {
  applyLabelOps,
  importDue,
  importSensors,
  labelEdits,
  labelProblems,
  mirrorLabels,
  withHaEdit,
  type HaEdit,
  type LabelOp,
} from "./labels.ts";
import { FRESH_STORED, type HaChange, type HaChangeItem, type StoredConfig } from "./ledger.ts";
import type { Config, RoomEntry, Schedule } from "./model.ts";
import {
  problemContactLabelUnused,
  problemEntryUnavailable,
  problemLabelForeign,
  problemLegacyLabelPresent,
  problemSensorLabelUnused,
} from "./status.ts";

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
    overrideEnd: undefined,
    overrideDurationMs: undefined,
    contacts: [],
    window: NO_WINDOW_PATCH,
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

const EVE: Schedule = { id: "eve", name: "Eve", defaultWeek: weekOf([]) };
const EVE_LABEL = "heatmaster_schedule_eve";
const OFFICE_T = "sensor.office_t";
const GOOD: SensorInfo = { exists: true, isTemperature: true, onValve: false };
const NOW_MS = Date.UTC(2026, 10, 17, 12, 0, 0);
/** office and hall are rooms; attic, kitchen and every other area are not. */
const ROOMS: AreaMembership = makeMembership({ office: ["z2m:a"], hall: ["z2m:b"] });

/** Every entity id given as a good temperature sensor, unless `over` says otherwise. */
function infosOf(
  entityIds: readonly string[],
  over: Readonly<Record<string, SensorInfo | undefined>> = {},
): Map<string, SensorInfo> {
  const infos = new Map(entityIds.map((id) => [id, GOOD] as const));
  for (const [id, info] of Object.entries(over)) {
    if (info === undefined) infos.delete(id);
    else infos.set(id, info);
  }
  return infos;
}

/** `sensor.f0` … `sensor.f<count - 1>`. */
function fillers(count: number): string[] {
  return Array.from({ length: count }, (_, n) => `sensor.f${String(n)}`);
}

/** Areas office, hall and attic wearing the given labels, the given entities, three schedules. */
function scene(
  options: {
    areas?: Record<string, string[]>;
    entities?: Record<string, { areaId?: string; labels?: string[] }>;
  } = {},
): HaSnapshot {
  const areas: Record<string, string[]> = { office: [], hall: [], attic: [], ...options.areas };
  return makeSnapshot({
    areas: Object.fromEntries(Object.entries(areas).map(([id, labels]) => [id, { labels }])),
    entities: options.entities ?? {},
    labels: labelsWith({ [EVE_LABEL]: "Heatmaster: Eve", [SENSOR_LABEL]: "Heatmaster sensor" }),
  });
}

function scheduleItem(areaId: string, scheduleId: string): HaChangeItem {
  return {
    kind: "schedule",
    areaId,
    entityId: undefined,
    scheduleId,
    rule: undefined,
    setting: undefined,
    value: undefined,
  };
}

function sensorItem(
  kind: "sensor_added" | "sensor_removed",
  areaId: string,
  entityId: string,
): HaChangeItem {
  return {
    kind,
    areaId,
    entityId,
    scheduleId: undefined,
    rule: undefined,
    setting: undefined,
    value: undefined,
  };
}

/** The edit; a test that expects one fails here when there is none. */
function required(edit: HaEdit | undefined): HaEdit {
  if (edit === undefined) throw new Error("expected an edit, got none");
  return edit;
}

/** `labelEdits` over schedules day (the default), night and eve, rooms office and hall. */
function edits(
  before: HaSnapshot,
  after: HaSnapshot,
  entries: Readonly<Record<string, RoomEntry>> = {},
  infos: ReadonlyMap<string, SensorInfo> = infosOf([OFFICE_T]),
  contactInfos: ReadonlyMap<string, ContactInfo> = new Map(),
): HaEdit | undefined {
  return labelEdits(
    before,
    after,
    configOf(entries, [DAY, NIGHT, EVE]),
    ROOMS,
    infos,
    contactInfos,
  );
}

/** A stored config at `revision` over schedules day and night, rooms office and hall. */
function storedOf(over: Partial<StoredConfig> = {}): StoredConfig {
  return { ...FRESH_STORED, config: configOf(), revision: 4, membership: ROOMS, ...over };
}

/** The test's own reading of ownership: a numbered schedule label is never Heatmaster's. */
const NUMBERED_LABEL = /^heatmaster_schedule_.+_[0-9]+$/;

function isForeign(labelId: string): boolean {
  return (
    NUMBERED_LABEL.test(labelId) || !labelId.startsWith("heatmaster_") || labelId === IGNORE_LABEL
  );
}

function isOwnedScheduleLabel(labelId: string): boolean {
  return labelId.startsWith("heatmaster_schedule_") && !NUMBERED_LABEL.test(labelId);
}

/** The label ids an op names: created, renamed, deleted, added or removed. */
function labelsOf(op: LabelOp): readonly string[] {
  switch (op.kind) {
    case "createLabel":
      return [op.name];
    case "renameLabel":
    case "deleteLabel":
      return [op.labelId];
    case "labelArea":
    case "labelEntity":
      return [...op.add, ...op.remove];
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
      const snapshot = makeSnapshot({
        areas: { garage: { labels: [OLD_LABEL, OLD_CLASH] } },
        labels: labelsWith({ [OLD_LABEL]: "Heatmaster: Old", [OLD_CLASH]: "Heatmaster: Old" }),
      });
      const plan = mirrorLabels(configOf(), NO_MEMBERSHIP, snapshot);
      const again = mirrorLabels(
        configOf(),
        NO_MEMBERSHIP,
        applyLabelOps(snapshot, plan.ops, new Map()),
      );
      it("deleteLabel names heatmaster_schedule_old and not heatmaster_schedule_old_2", () => {
        expect(plan.ops.filter((op) => op.kind === "deleteLabel")).toEqual([
          { kind: "deleteLabel", labelId: OLD_LABEL },
        ]);
        expect(naming(plan.ops, OLD_CLASH)).toEqual([]);
      });
      it("foreign lists heatmaster_schedule_old_2", () => {
        expect(plan.foreign).toEqual([OLD_CLASH]);
      });
      it("once those ops are applied, mirroring again gives no op and foreign still lists heatmaster_schedule_old_2", () => {
        expect(again.ops).toEqual([]);
        expect(again.foreign).toEqual([OLD_CLASH]);
      });
    });

    describe("With the label heatmaster_schedule_lone_3, no label heatmaster_schedule_lone and no schedule lone", () => {
      const lone = "heatmaster_schedule_lone_3";
      const plan = mirrorLabels(
        configOf(),
        makeMembership({ living: ["z2m:a"] }),
        makeSnapshot({
          areas: { living: { labels: [lone] } },
          entities: { "sensor.lone": { labels: [lone, SENSOR_LABEL] } },
          labels: labelsWith({ [lone]: "Heatmaster: Lone" }),
        }),
      );
      it("no op names heatmaster_schedule_lone_3", () => {
        expect(plan.ops).not.toEqual([]);
        expect(naming(plan.ops, lone)).toEqual([]);
      });
      it("foreign lists it", () => {
        expect(plan.foreign).toEqual([lone]);
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

    describe("With a config that has no schedule", () => {
      const config = configOf({ living: entry(undefined, ["sensor.living"]) }, []);
      const membership = makeMembership({ living: ["z2m:a"] });
      const snapshot = makeSnapshot({
        areas: { living: { labels: [DAY_LABEL] }, garage: { labels: [OLD_LABEL] } },
        entities: { "sensor.living": {}, "sensor.old": { labels: [SENSOR_LABEL] } },
        labels: { [DAY_LABEL]: "Heatmaster: Day", [OLD_LABEL]: "Heatmaster: Old" },
      });
      it("no op is planned in scope all: no delete, create, area or entity op", () => {
        expect(mirrorLabels(config, membership, snapshot).ops).toEqual([]);
      });
      it("no op is planned in scope schedules", () => {
        expect(mirrorLabels(config, membership, snapshot, "schedules").ops).toEqual([]);
      });
    });

    describe("Property: over any scene, in either scope", () => {
      fcTest.prop([arbScene()])(
        "no op names a foreign label, and only Heatmaster's own labels are removed or deleted",
        ({ config, membership, snapshot }) => {
          const current = new Set(config.schedules.map((s) => scheduleLabelId(s.id)));
          for (const scope of ["all", "schedules"] as const) {
            for (const op of mirrorLabels(config, membership, snapshot, scope).ops) {
              const what = JSON.stringify(op);
              for (const id of labelsOf(op)) expect(isForeign(id), what).toBe(false);
              switch (op.kind) {
                case "createLabel":
                  expect(
                    current.has(op.name) ||
                      op.name === SENSOR_LABEL ||
                      op.name === WINDOW_SENSOR_LABEL,
                    what,
                  ).toBe(true);
                  break;
                case "renameLabel":
                  expect(current.has(op.labelId), what).toBe(true);
                  break;
                case "deleteLabel":
                  expect(isOwnedScheduleLabel(op.labelId) && !current.has(op.labelId), what).toBe(
                    true,
                  );
                  break;
                case "labelArea":
                  expect(
                    op.add.every((id) => current.has(id)),
                    what,
                  ).toBe(true);
                  expect(op.remove.every(isOwnedScheduleLabel), what).toBe(true);
                  break;
                case "labelEntity":
                  expect([SENSOR_LABEL, WINDOW_SENSOR_LABEL], what).toContain(
                    [...op.add, ...op.remove][0],
                  );
                  expect([...op.add, ...op.remove], what).toHaveLength(1);
                  break;
              }
            }
          }
        },
      );
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

  describe("labelEdits", () => {
    describe("With night's label added to room office whose entry names no schedule", () => {
      const edit = (): HaEdit =>
        required(
          edits(
            scene({ areas: { office: [DAY_LABEL] } }),
            scene({ areas: { office: [DAY_LABEL, NIGHT_LABEL] } }),
            { office: entry(undefined, ["sensor.office_a"]) },
          ),
        );
      it("office's entry names night", () => {
        expect(edit().config.rooms.get("office")).toEqual(entry("night", ["sensor.office_a"]));
      });
      it("one item: schedule, office, night", () => {
        expect(edit().items).toEqual([scheduleItem("office", "night")]);
      });
    });

    describe("With the default's label added to a room on night, night's label still there", () => {
      const edit = (): HaEdit =>
        required(
          edits(
            scene({ areas: { office: [NIGHT_LABEL] } }),
            scene({ areas: { office: [NIGHT_LABEL, DAY_LABEL] } }),
            { office: entry("night") },
          ),
        );
      it("the entry's schedule is cleared", () => {
        expect(edit().config.rooms.get("office")).toEqual(entry(undefined));
      });
      it("the item names the default", () => {
        expect(edit().items).toEqual([scheduleItem("office", "day")]);
      });
    });

    describe("With two schedule labels added to one area at once, neither current", () => {
      it("the schedule of the lowest label id wins", () => {
        const edit = required(
          edits(
            scene({ areas: { office: [DAY_LABEL] } }),
            scene({ areas: { office: [DAY_LABEL, NIGHT_LABEL, EVE_LABEL] } }),
          ),
        );
        expect(edit.config.rooms.get("office")?.scheduleId).toBe("eve");
        expect(edit.items).toEqual([scheduleItem("office", "eve")]);
      });
    });

    describe("With a schedule label added to an area that is no room", () => {
      it("an entry for that area names the schedule", () => {
        const edit = required(
          edits(scene(), scene({ areas: { attic: [NIGHT_LABEL] } }), { office: entry("night") }),
        );
        expect(edit.config.rooms.get("attic")).toEqual(entry("night"));
        expect(edit.items).toEqual([scheduleItem("attic", "night")]);
      });
    });

    describe("With the room's only schedule label removed while its entry names night", () => {
      it("the entry's schedule is cleared", () => {
        const edit = required(
          edits(scene({ areas: { office: [NIGHT_LABEL] } }), scene(), {
            office: entry("night", ["sensor.office_a"]),
          }),
        );
        expect(edit.config.rooms.get("office")).toEqual(entry(undefined, ["sensor.office_a"]));
        expect(edit.items).toEqual([scheduleItem("office", "day")]);
      });
    });

    describe("With a schedule label removed from an area whose entry also holds override_end manual", () => {
      it("the entry keeps override_end manual", () => {
        const edit = required(
          edits(scene({ areas: { office: [NIGHT_LABEL] } }), scene(), {
            office: { ...entry("night", ["sensor.office_a"]), overrideEnd: "manual" },
          }),
        );
        expect(edit.config.rooms.get("office")?.scheduleId).toBeUndefined();
        expect(edit.config.rooms.get("office")?.overrideEnd).toBe("manual");
      });
    });

    describe("With the default's label removed from a room on the default", () => {
      it("returns undefined", () => {
        expect(edits(scene({ areas: { office: [DAY_LABEL] } }), scene())).toBeUndefined();
      });
    });

    describe("With heatmaster_temp_sensor added to sensor.office_t, whose own area is office, a room", () => {
      const edit = (): HaEdit =>
        required(
          edits(
            scene({ entities: { [OFFICE_T]: { areaId: "office" } } }),
            scene({ entities: { [OFFICE_T]: { areaId: "office", labels: [SENSOR_LABEL] } } }),
            { office: entry(undefined, ["sensor.office_a"]) },
          ),
        );
      it("office's entry gains ha:sensor.office_t with weight 1", () => {
        expect(edit().config.rooms.get("office")?.sensors).toEqual([
          { ref: "ha:sensor.office_a", weight: 1 },
          { ref: "ha:sensor.office_t", weight: 1 },
        ]);
      });
      it("one item: sensor_added, office, sensor.office_t", () => {
        expect(edit().items).toEqual([sensorItem("sensor_added", "office", OFFICE_T)]);
      });
    });

    describe("With the entity having no area of its own and its device in office", () => {
      // The snapshot's areaId is already the entity's own area, else its device's (Task 2).
      it("office's entry gains it", () => {
        const edit = required(
          edits(
            scene({ entities: { [OFFICE_T]: { areaId: "office" } } }),
            scene({ entities: { [OFFICE_T]: { areaId: "office", labels: [SENSOR_LABEL] } } }),
          ),
        );
        expect(edit.config.rooms.get("office")).toEqual(entry(undefined, [OFFICE_T]));
      });
    });

    describe("With the entity's area not a room", () => {
      it("returns undefined", () => {
        expect(
          edits(
            scene({ entities: { [OFFICE_T]: { areaId: "attic" } } }),
            scene({ entities: { [OFFICE_T]: { areaId: "attic", labels: [SENSOR_LABEL] } } }),
          ),
        ).toBeUndefined();
      });
    });

    describe("With the entity not a temperature sensor, on a valve, or unknown", () => {
      it.each([
        ["not a temperature sensor", { exists: true, isTemperature: false, onValve: false }],
        ["on a valve", { exists: true, isTemperature: true, onValve: true }],
        ["unknown", undefined],
      ] as const)("returns undefined (%s)", (_, info) => {
        expect(
          edits(
            scene({ entities: { [OFFICE_T]: { areaId: "office" } } }),
            scene({ entities: { [OFFICE_T]: { areaId: "office", labels: [SENSOR_LABEL] } } }),
            {},
            infosOf([OFFICE_T], { [OFFICE_T]: info }),
          ),
        ).toBeUndefined();
      });
    });

    describe("With an entity deleted from the registry that carried the label before", () => {
      it("returns undefined", () => {
        expect(
          edits(
            scene({ entities: { [OFFICE_T]: { areaId: "office", labels: [SENSOR_LABEL] } } }),
            scene(),
            { office: entry(undefined, [OFFICE_T]) },
          ),
        ).toBeUndefined();
      });
    });

    describe("With office's entry already holding 16 sensors", () => {
      it("returns undefined", () => {
        expect(
          edits(
            scene({ entities: { [OFFICE_T]: { areaId: "office" } } }),
            scene({ entities: { [OFFICE_T]: { areaId: "office", labels: [SENSOR_LABEL] } } }),
            { office: entry(undefined, fillers(16)) },
          ),
        ).toBeUndefined();
      });
    });

    describe("With the entity already listed by office", () => {
      it("returns undefined", () => {
        expect(
          edits(
            scene({ entities: { [OFFICE_T]: { areaId: "office" } } }),
            scene({ entities: { [OFFICE_T]: { areaId: "office", labels: [SENSOR_LABEL] } } }),
            { office: entry(undefined, [OFFICE_T]) },
          ),
        ).toBeUndefined();
      });
    });

    describe("With heatmaster_temp_sensor added to an entity that hall lists, whose own area is office", () => {
      it("returns undefined", () => {
        expect(
          edits(
            scene({ entities: { [OFFICE_T]: { areaId: "office" } } }),
            scene({ entities: { [OFFICE_T]: { areaId: "office", labels: [SENSOR_LABEL] } } }),
            { hall: entry("night", [OFFICE_T]) },
          ),
        ).toBeUndefined();
      });
    });

    describe("With heatmaster_temp_sensor removed from an entity listed by office and hall", () => {
      const edit = (): HaEdit =>
        required(
          edits(
            scene({ entities: { [OFFICE_T]: { areaId: "office", labels: [SENSOR_LABEL] } } }),
            scene({ entities: { [OFFICE_T]: { areaId: "office" } } }),
            {
              office: entry(undefined, [OFFICE_T, "sensor.office_a"]),
              hall: entry("night", [OFFICE_T]),
            },
          ),
        );
      it("both entries drop it", () => {
        expect(edit().config.rooms.get("office")).toEqual(entry(undefined, ["sensor.office_a"]));
        expect(edit().config.rooms.get("hall")).toEqual(entry("night"));
      });
      it("two items, sensor_removed, one per area", () => {
        expect(edit().items).toEqual([
          sensorItem("sensor_removed", "office", OFFICE_T),
          sensorItem("sensor_removed", "hall", OFFICE_T),
        ]);
      });
    });

    describe("With before equal to after", () => {
      it("returns undefined", () => {
        const same = scene({
          areas: { office: [NIGHT_LABEL], attic: [EVE_LABEL] },
          entities: { [OFFICE_T]: { areaId: "office", labels: [SENSOR_LABEL] } },
        });
        expect(edits(same, same, { office: entry("night", [OFFICE_T]) })).toBeUndefined();
      });
    });

    describe('With a change to the user\'s label "kids"', () => {
      it("returns undefined", () => {
        expect(
          edits(
            scene({
              areas: { office: [DAY_LABEL] },
              entities: { [OFFICE_T]: { areaId: "office" } },
            }),
            scene({
              areas: { office: [DAY_LABEL, "kids"] },
              entities: { [OFFICE_T]: { areaId: "office", labels: ["kids"] } },
            }),
          ),
        ).toBeUndefined();
      });
    });

    describe("With the label of a deleted schedule added to an area", () => {
      it("returns undefined", () => {
        expect(
          edits(
            scene({ areas: { office: [DAY_LABEL] } }),
            scene({ areas: { office: [DAY_LABEL, OLD_LABEL] } }),
          ),
        ).toBeUndefined();
      });
    });

    describe("With a schedule label added to an area whose id cannot key an entry", () => {
      it("returns undefined", () => {
        const long = "a".repeat(65);
        expect(edits(scene(), scene({ areas: { [long]: [NIGHT_LABEL] } }))).toBeUndefined();
      });
    });

    describe("With heatmaster_temp_sensor added in room office, which has no entry, while the config holds 64 entries", () => {
      it("returns undefined", () => {
        const full = Object.fromEntries(
          Array.from({ length: 64 }, (_, n) => [`area${String(n)}`, entry("night")]),
        );
        expect(
          edits(
            scene({ entities: { [OFFICE_T]: { areaId: "office" } } }),
            scene({ entities: { [OFFICE_T]: { areaId: "office", labels: [SENSOR_LABEL] } } }),
            full,
          ),
        ).toBeUndefined();
      });
    });
  });

  describe("withHaEdit", () => {
    describe("With a stored config at revision 4", () => {
      const held = configOf();
      const stored = storedOf({
        config: { ...held, settings: { ...held.settings, holdWrites: true } },
        releasing: new Map([["z2m:c", 1000]]),
        importedAreas: ["hall"],
        haChanges: [{ revision: 3, at: 1, items: [scheduleItem("hall", "night")] }],
      });
      const config: Config = { ...stored.config, rooms: new Map([["office", entry("night")]]) };
      const edit: HaEdit = { config, items: [scheduleItem("office", "night")] };
      const next = withHaEdit(stored, edit, NOW_MS);
      it("the revision is 5 and haChanges ends with revision 5, at now, and the edit's items", () => {
        expect(next.revision).toBe(5);
        expect(next.config).toBe(config);
        expect(next.haChanges).toEqual([
          ...stored.haChanges,
          { revision: 5, at: NOW_MS, items: edit.items },
        ]);
      });
      it("releasing, membership, hold and importedAreas are unchanged", () => {
        expect(next.releasing).toBe(stored.releasing);
        expect(next.membership).toBe(stored.membership);
        expect(next.config.settings.holdWrites).toBe(true);
        expect(next.importedAreas).toBe(stored.importedAreas);
        expect(next.upgrade).toBe(stored.upgrade);
      });
    });

    describe("With 20 HA changes kept", () => {
      it("20 are kept and the oldest is dropped", () => {
        const kept: HaChange[] = Array.from({ length: 20 }, (_, i) => ({
          revision: i + 1,
          at: i,
          items: [scheduleItem("office", "night")],
        }));
        const next = withHaEdit(
          storedOf({ revision: 20, haChanges: kept }),
          { config: configOf(), items: [scheduleItem("office", "day")] },
          NOW_MS,
        );
        expect(next.haChanges).toHaveLength(20);
        expect(next.haChanges.map((change) => change.revision)).toEqual(
          Array.from({ length: 20 }, (_, i) => i + 2),
        );
      });
    });
  });

  describe("importSensors", () => {
    const LEGACY = [LEGACY_SENSOR_LABEL];

    describe("With the import pending, room office without sensors, two temperature entities in office carrying room_temperature_sensor", () => {
      const stored = storedOf({ config: configOf({ hall: entry(undefined, ["sensor.hall_a"]) }) });
      const snapshot = scene({
        entities: {
          "sensor.office_b": { areaId: "office", labels: LEGACY },
          "sensor.office_a": { areaId: "office", labels: LEGACY },
          "sensor.hall_x": { areaId: "hall", labels: LEGACY },
        },
      });
      const infos = infosOf(["sensor.office_a", "sensor.office_b", "sensor.hall_x"]);
      const next = importSensors(stored, ROOMS, snapshot, infos, NOW_MS);
      it("office's entry holds both, weight 1, in entity-id order", () => {
        expect(next.config.rooms.get("office")).toEqual(
          entry(undefined, ["sensor.office_a", "sensor.office_b"]),
        );
      });
      it("both rooms are marked imported, the revision is one higher, and one HA change has a sensors_imported item for office", () => {
        expect(next.importedAreas).toEqual(["hall", "office"]);
        expect(next.revision).toBe(5);
        expect(next.haChanges).toEqual([
          {
            revision: 5,
            at: NOW_MS,
            items: [
              {
                kind: "sensors_imported",
                areaId: "office",
                entityId: undefined,
                scheduleId: undefined,
              },
            ],
          },
        ]);
      });
    });

    describe("With room hall that already has a sensor", () => {
      it("hall's entry is unchanged", () => {
        const stored = storedOf({ config: configOf({ hall: entry("night", ["sensor.hall_a"]) }) });
        const next = importSensors(
          stored,
          ROOMS,
          scene({ entities: { "sensor.hall_x": { areaId: "hall", labels: LEGACY } } }),
          infosOf(["sensor.hall_x"]),
          NOW_MS,
        );
        expect(next.config.rooms.get("hall")).toBe(stored.config.rooms.get("hall"));
        expect(next.revision).toBe(4);
      });
      it("hall is marked imported", () => {
        const stored = storedOf({ config: configOf({ hall: entry("night", ["sensor.hall_a"]) }) });
        const next = importSensors(stored, ROOMS, scene(), infosOf([]), NOW_MS);
        expect(next.importedAreas).toContain("hall");
      });
    });

    describe("With office imported already and hall not, each with a labelled temperature entity", () => {
      const stored = storedOf({ importedAreas: ["office"] });
      const snapshot = scene({
        entities: {
          "sensor.office_a": { areaId: "office", labels: LEGACY },
          "sensor.hall_a": { areaId: "hall", labels: LEGACY },
        },
      });
      const next = importSensors(
        stored,
        ROOMS,
        snapshot,
        infosOf(["sensor.office_a", "sensor.hall_a"]),
        NOW_MS,
      );
      it("hall gets its entity and office is left alone", () => {
        expect(next.config.rooms.get("hall")).toEqual(entry(undefined, ["sensor.hall_a"]));
        expect(next.config.rooms.get("office")).toBeUndefined();
      });
      it("importedAreas holds both, and the HA change names hall only", () => {
        expect(next.importedAreas).toEqual(["hall", "office"]);
        expect(next.haChanges.at(-1)?.items.map((item) => item.areaId)).toEqual(["hall"]);
      });
    });

    describe("With a room whose area cannot hold an entry", () => {
      it("it is marked imported and gets no entry", () => {
        const long = "a".repeat(65);
        const next = importSensors(
          storedOf(),
          makeMembership({ [long]: ["z2m:a"] }),
          scene({ entities: { "sensor.x": { areaId: long, labels: LEGACY } } }),
          infosOf(["sensor.x"]),
          NOW_MS,
        );
        expect(next.importedAreas).toEqual([long]);
        expect(next.config.rooms.has(long)).toBe(false);
      });
    });

    describe("With a labelled entity whose own area is kitchen and whose device is in office", () => {
      // The snapshot's areaId is the entity's own area when it has one (Task 2).
      it("it goes to kitchen's room and not to office's", () => {
        const next = importSensors(
          storedOf(),
          makeMembership({ office: ["z2m:a"], kitchen: ["z2m:c"] }),
          scene({ entities: { "sensor.k": { areaId: "kitchen", labels: LEGACY } } }),
          infosOf(["sensor.k"]),
          NOW_MS,
        );
        expect(next.config.rooms.get("kitchen")).toEqual(entry(undefined, ["sensor.k"]));
        expect(next.config.rooms.get("office")).toBeUndefined();
      });
    });

    describe("With a labelled entity that is not a temperature sensor, or one that is on a valve", () => {
      it.each([
        ["not a temperature sensor", { exists: true, isTemperature: false, onValve: false }],
        ["on a valve", { exists: true, isTemperature: true, onValve: true }],
      ] as const)("it is left out (%s)", (_, info) => {
        const next = importSensors(
          storedOf(),
          ROOMS,
          scene({
            entities: {
              "sensor.office_a": { areaId: "office", labels: LEGACY },
              "sensor.office_b": { areaId: "office", labels: LEGACY },
            },
          }),
          infosOf(["sensor.office_b"], { "sensor.office_a": info }),
          NOW_MS,
        );
        expect(next.config.rooms.get("office")).toEqual(entry(undefined, ["sensor.office_b"]));
      });
    });

    describe("With 17 labelled temperature entities in office", () => {
      it("office's entry holds the first 16 in entity-id order", () => {
        const ids = Array.from({ length: 17 }, (_, n) => `sensor.t${String(n).padStart(2, "0")}`);
        const next = importSensors(
          storedOf(),
          ROOMS,
          scene({
            entities: Object.fromEntries(
              [...ids].reverse().map((id) => [id, { areaId: "office", labels: LEGACY }]),
            ),
          }),
          infosOf(ids),
          NOW_MS,
        );
        expect(next.config.rooms.get("office")).toEqual(entry(undefined, ids.slice(0, 16)));
      });
    });

    describe("With nothing to import", () => {
      it("every room is marked imported, the revision is unchanged and no HA change is added", () => {
        const stored = storedOf();
        const next = importSensors(
          stored,
          ROOMS,
          scene({ entities: { "sensor.office_a": { areaId: "office" } } }),
          infosOf(["sensor.office_a"]),
          NOW_MS,
        );
        expect(next).toEqual({ ...stored, importedAreas: ["hall", "office"] });
      });
    });

    describe("With every room imported", () => {
      it("returns the given value itself", () => {
        const stored = storedOf({ importedAreas: ["hall", "office"] });
        const snapshot = scene({
          entities: { "sensor.office_a": { areaId: "office", labels: LEGACY } },
        });
        expect(importSensors(stored, ROOMS, snapshot, infosOf(["sensor.office_a"]), NOW_MS)).toBe(
          stored,
        );
      });
    });
  });

  describe("importDue", () => {
    describe("With a room of the membership not in importedAreas", () => {
      it("is true", () => {
        expect(importDue(storedOf({ importedAreas: ["office"] }), ROOMS)).toBe(true);
      });
    });
    describe("With every room in importedAreas, and an area that is no room", () => {
      it("is false", () => {
        expect(importDue(storedOf({ importedAreas: ["attic", "hall", "office"] }), ROOMS)).toBe(
          false,
        );
      });
    });
  });

  describe("labelProblems", () => {
    const LEGACY = [LEGACY_SENSOR_LABEL];
    const problemsOf = (
      entries: Readonly<Record<string, RoomEntry>>,
      snapshot: HaSnapshot,
      infos: ReadonlyMap<string, SensorInfo> = infosOf([OFFICE_T]),
    ) => labelProblems(configOf(entries), ROOMS, snapshot, infos, new Map());

    describe("With an entity carrying heatmaster_temp_sensor in an area that is no room, listed nowhere", () => {
      it("sensor_label_unused with reason area_not_room", () => {
        expect(
          problemsOf(
            {},
            scene({ entities: { [OFFICE_T]: { areaId: "attic", labels: [SENSOR_LABEL] } } }),
          ),
        ).toEqual([problemSensorLabelUnused(OFFICE_T, "area_not_room")]);
      });
    });

    describe("With such an entity in room office, which has no entry, while the config holds 64 entries", () => {
      it("sensor_label_unused with reason entry_unavailable", () => {
        const full = Object.fromEntries(
          Array.from({ length: 64 }, (_, n) => [`area${String(n)}`, entry("night")]),
        );
        expect(
          problemsOf(
            full,
            scene({ entities: { [OFFICE_T]: { areaId: "office", labels: [SENSOR_LABEL] } } }),
          ),
        ).toContainEqual(problemSensorLabelUnused(OFFICE_T, "entry_unavailable"));
      });
    });

    describe("With areas whose id cannot key an entry", () => {
      const long = "a".repeat(65);
      const other = "b".repeat(65);
      const rooms = makeMembership({ office: ["z2m:a"], [long]: ["z2m:c"] });
      const problems = labelProblems(
        configOf(),
        rooms,
        scene({
          areas: { [long]: [NIGHT_LABEL, DAY_LABEL, "kids"], [other]: [DAY_LABEL] },
          entities: { "sensor.old": { areaId: long, labels: LEGACY } },
        }),
        infosOf([]),
        new Map(),
      );
      it("entry_unavailable for the room naming the other schedule's label and room_temperature_sensor", () => {
        expect(problems).toContainEqual(
          problemEntryUnavailable(long, [NIGHT_LABEL, LEGACY_SENSOR_LABEL]),
        );
      });
      it("entry_unavailable for the area that is no room, naming the schedule label it wears", () => {
        expect(problems).toContainEqual(problemEntryUnavailable(other, [DAY_LABEL]));
      });
    });

    describe("With a room whose id cannot key an entry wearing only the default's label", () => {
      it("no problem", () => {
        const long = "a".repeat(65);
        expect(
          labelProblems(
            configOf(),
            makeMembership({ [long]: ["z2m:c"] }),
            scene({ areas: { [long]: [DAY_LABEL] } }),
            infosOf([]),
            new Map(),
          ),
        ).toEqual([]);
      });
    });

    describe("With such an entity in a room, passing every check", () => {
      it("no problem", () => {
        expect(
          problemsOf(
            {},
            scene({ entities: { [OFFICE_T]: { areaId: "office", labels: [SENSOR_LABEL] } } }),
          ),
        ).toEqual([]);
      });
    });

    describe("With room office that has a sensor and an entity in office still carrying room_temperature_sensor", () => {
      it("legacy_label_present for office naming the entity", () => {
        expect(
          problemsOf(
            { office: entry(undefined, ["sensor.office_a"]) },
            scene({
              entities: {
                "sensor.office_a": { areaId: "office", labels: [SENSOR_LABEL] },
                "sensor.office_old": { areaId: "office", labels: LEGACY },
                "sensor.attic_old": { areaId: "attic", labels: LEGACY },
              },
            }),
          ),
        ).toEqual([problemLegacyLabelPresent("office", ["sensor.office_old"])]);
      });
    });

    describe("With office's entry holding no sensor", () => {
      it("no legacy_label_present", () => {
        expect(
          problemsOf(
            { office: entry("night") },
            scene({ entities: { "sensor.office_old": { areaId: "office", labels: LEGACY } } }),
          ),
        ).toEqual([]);
      });
    });

    describe("With an entity carrying heatmaster_temp_sensor that has no area, listed nowhere", () => {
      it("sensor_label_unused with reason no_area", () => {
        expect(
          problemsOf({}, scene({ entities: { [OFFICE_T]: { labels: [SENSOR_LABEL] } } })),
        ).toEqual([problemSensorLabelUnused(OFFICE_T, "no_area")]);
      });
    });

    describe("With room office whose entry already lists 16 sensors and another labelled entity in office", () => {
      it("sensor_label_unused with reason sensor_limit", () => {
        expect(
          problemsOf(
            { office: entry(undefined, fillers(16)) },
            scene({ entities: { [OFFICE_T]: { areaId: "office", labels: [SENSOR_LABEL] } } }),
          ),
        ).toEqual([problemSensorLabelUnused(OFFICE_T, "sensor_limit")]);
      });
    });

    describe("With the label heatmaster_schedule_day_2", () => {
      it("label_foreign for it", () => {
        const snapshot = makeSnapshot({
          labels: labelsWith({ [DAY_CLASH]: "Heatmaster: Day", kids: "Kids" }),
        });
        expect(problemsOf({}, snapshot)).toEqual([problemLabelForeign(DAY_CLASH)]);
      });
    });
  });
  describe("mirrorLabels (contacts)", () => {
    const WINDOW = "binary_sensor.office_window";
    const withContact = (over: Partial<RoomEntry> = {}): RoomEntry => ({
      ...entry(undefined),
      contacts: [{ ref: `ha:${WINDOW}` }],
      ...over,
    });
    const labelled = (labels: string[]) =>
      makeSnapshot({
        entities: { [WINDOW]: { areaId: "office", labels } },
        labels: labelsWith({ [WINDOW_SENSOR_LABEL]: WINDOW_SENSOR_LABEL }),
      });

    describe("With a contact listed in a room and not labelled", () => {
      it("plans labelEntity adding heatmaster_window_sensor", () => {
        const plan = mirrorLabels(configOf({ office: withContact() }), ROOMS, labelled([]));
        expect(plan.ops).toContainEqual({
          kind: "labelEntity",
          entityId: WINDOW,
          add: [WINDOW_SENSOR_LABEL],
          remove: [],
        });
      });
    });

    describe("With a labelled entity no room lists", () => {
      it("plans labelEntity removing it", () => {
        const plan = mirrorLabels(configOf(), ROOMS, labelled([WINDOW_SENSOR_LABEL]));
        expect(plan.ops).toContainEqual({
          kind: "labelEntity",
          entityId: WINDOW,
          add: [],
          remove: [WINDOW_SENSOR_LABEL],
        });
      });
    });

    describe("With no heatmaster_window_sensor label in Home Assistant", () => {
      const plan = mirrorLabels(
        configOf({ office: withContact() }),
        ROOMS,
        makeSnapshot({
          entities: { [WINDOW]: { areaId: "office" } },
          labels: labelsWith(),
        }),
      );
      it("plans createLabel before the entity ops", () => {
        const created = plan.ops.findIndex(
          (op) => op.kind === "createLabel" && op.name === WINDOW_SENSOR_LABEL,
        );
        const entityOps = plan.ops.flatMap((op, i) => (op.kind === "labelEntity" ? [i] : []));
        expect(created).toBeGreaterThanOrEqual(0);
        expect(entityOps).toHaveLength(1);
        expect(entityOps.every((i) => i > created)).toBe(true);
      });
    });

    describe("With scope schedules", () => {
      it("plans no contact op", () => {
        const plan = mirrorLabels(
          configOf({ office: withContact() }),
          ROOMS,
          makeSnapshot({
            entities: { [WINDOW]: { areaId: "office" } },
            labels: labelsWith(),
          }),
          "schedules",
        );
        expect(naming(plan.ops, WINDOW_SENSOR_LABEL)).toEqual([]);
        expect(naming(plan.ops, WINDOW)).toEqual([]);
      });
    });

    describe("With a configured contact Home Assistant has no entry for", () => {
      it("lists it as unlabellable", () => {
        const plan = mirrorLabels(
          configOf({ office: withContact() }),
          ROOMS,
          makeSnapshot({ labels: labelsWith() }),
        );
        expect(plan.unlabellable).toEqual([WINDOW]);
      });
    });
  });

  describe("labelEdits (contacts)", () => {
    const WINDOW = "binary_sensor.office_window";
    const GOOD_CONTACT: ContactInfo = { exists: true, isBinary: true };
    const contacts = new Map([[WINDOW, GOOD_CONTACT]]);
    const listing = (): Record<string, RoomEntry> => ({
      office: { ...entry(undefined), contacts: [{ ref: `ha:${WINDOW}` }] },
    });
    const sceneOf = (entityId: string, labels: string[]) =>
      scene({ entities: { [entityId]: { areaId: "office", labels } } });
    const item = (kind: "contact_added" | "contact_removed"): HaChangeItem => ({
      kind,
      areaId: "office",
      entityId: WINDOW,
      scheduleId: undefined,
      rule: undefined,
      setting: undefined,
      value: undefined,
    });

    describe("With the label added to a binary_sensor in a room's area", () => {
      const edit = edits(
        sceneOf(WINDOW, []),
        sceneOf(WINDOW, [WINDOW_SENSOR_LABEL]),
        {},
        new Map(),
        contacts,
      );
      it("adds the contact to that room's entry", () => {
        expect(required(edit).config.rooms.get("office")?.contacts).toEqual([
          { ref: `ha:${WINDOW}` },
        ]);
      });
      it("records an item contact_added", () => {
        expect(required(edit).items).toEqual([item("contact_added")]);
      });
    });

    describe("With the label removed from a listed contact", () => {
      const edit = edits(
        sceneOf(WINDOW, [WINDOW_SENSOR_LABEL]),
        sceneOf(WINDOW, []),
        listing(),
        new Map(),
        contacts,
      );
      it("removes it from every entry", () => {
        expect(required(edit).config.rooms.get("office")?.contacts).toEqual([]);
      });
      it("records an item contact_removed", () => {
        expect(required(edit).items).toEqual([item("contact_removed")]);
      });
    });

    describe("With the label added to a sensor.* entity", () => {
      it("changes nothing", () => {
        const sensor = "sensor.office_t";
        expect(
          edits(
            sceneOf(sensor, []),
            sceneOf(sensor, [WINDOW_SENSOR_LABEL]),
            {},
            new Map(),
            new Map([[sensor, { exists: true, isBinary: false }]]),
          ),
        ).toBeUndefined();
      });
    });
  });

  describe("labelProblems (contacts)", () => {
    const WINDOW = "binary_sensor.office_window";
    const GOOD_CONTACT: ContactInfo = { exists: true, isBinary: true };
    const problemsOf = (
      snapshot: HaSnapshot,
      contacts: ReadonlyMap<string, ContactInfo>,
      entries: Readonly<Record<string, RoomEntry>> = {},
    ) => labelProblems(configOf(entries), ROOMS, snapshot, new Map(), contacts);

    describe("With a labelled binary_sensor in an area that is no room", () => {
      it("raises contact_label_unused with reason area_not_room", () => {
        expect(
          problemsOf(
            scene({ entities: { [WINDOW]: { areaId: "attic", labels: [WINDOW_SENSOR_LABEL] } } }),
            new Map([[WINDOW, GOOD_CONTACT]]),
          ),
        ).toEqual([problemContactLabelUnused(WINDOW, "area_not_room")]);
      });
    });

    describe("With a labelled entity that is not a binary_sensor", () => {
      it("raises contact_label_unused with reason contact_not_binary", () => {
        const id = "sensor.office_t";
        expect(
          problemsOf(
            scene({ entities: { [id]: { areaId: "office", labels: [WINDOW_SENSOR_LABEL] } } }),
            new Map([[id, { exists: true, isBinary: false }]]),
          ),
        ).toEqual([problemContactLabelUnused(id, "contact_not_binary")]);
      });
    });

    describe("With a labelled entity whose room already lists 16 contacts", () => {
      it("raises contact_label_unused with reason contact_limit", () => {
        const full = Array.from({ length: 16 }, (_, n) => ({
          ref: `ha:binary_sensor.c${String(n)}`,
        }));
        expect(
          problemsOf(
            scene({ entities: { [WINDOW]: { areaId: "office", labels: [WINDOW_SENSOR_LABEL] } } }),
            new Map([[WINDOW, GOOD_CONTACT]]),
            { office: { ...entry(undefined), contacts: full } },
          ),
        ).toEqual([problemContactLabelUnused(WINDOW, "contact_limit")]);
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
 * Random label ids: numbered schedule labels (`_0` and up), other `heatmaster_` ids (owned schedule
 * labels among them) and ids without the prefix.
 */
const arbRandomLabel: fc.Arbitrary<string> = fc.oneof(
  fc
    .tuple(fc.stringMatching(/^[a-z0-9]{1,6}$/), fc.integer({ min: 0, max: 12 }))
    .map(([x, n]) => `heatmaster_schedule_${x}_${String(n)}`),
  fc.stringMatching(/^heatmaster_[a-z0-9_]{1,12}$/),
  fc.stringMatching(/^[a-z][a-z0-9_]{0,12}$/),
);

/**
 * Any valid config (with no schedule too), rooms out of its entry areas and two more, and a
 * snapshot in which each schedule's label may be missing, misnamed or right and may have `_2` and
 * `_1` clash labels; a stale owned label, its numbered labels `_2`, `_1` and `_0`, a numbered
 * label of no label, the sensor label, user labels and random labels may exist; areas and sensor
 * entities wear any of these.
 */
function arbScene(): fc.Arbitrary<Scene> {
  return fc
    .tuple(arbConfig, fc.uniqueArray(arbRandomLabel, { maxLength: 4 }))
    .chain(([config, random]) => {
      const areaIds = [...config.rooms.keys(), ...EXTRA_AREAS.filter((a) => !config.rooms.has(a))];
      const scheduleLabels = config.schedules.map((s) => scheduleLabelId(s.id));
      const labelPool = [
        ...new Set([
          ...scheduleLabels,
          ...scheduleLabels.map((id) => `${id}_2`),
          ...scheduleLabels.map((id) => `${id}_1`),
          STALE_LABEL,
          `${STALE_LABEL}_2`,
          `${STALE_LABEL}_1`,
          `${STALE_LABEL}_0`,
          "heatmaster_schedule_lone_3",
          SENSOR_LABEL,
          ...USER_LABELS,
          ...random,
        ]),
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
                    .subarray([...new Set([SENSOR_LABEL, "kids", LEGACY_SENSOR_LABEL, ...random])])
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
