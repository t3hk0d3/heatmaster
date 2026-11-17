import { applyLabelOps, validateConfig } from "@heatmaster/core";
import type {
  AreaMembership,
  Config,
  HaArea,
  HaEntity,
  HaSnapshot,
  LabelOp,
  RawConfig,
} from "@heatmaster/core";
import { describe, expect, it, vi } from "vitest";
import { createStubHaLink, type StubHaLink } from "../test/stub-ha-link.ts";
import { createLabelSync, type LabelSync } from "./label-sync.ts";

// ---- fixtures ------------------------------------------------------------------------------------

const DAY = "heatmaster_schedule_day";
const NIGHT = "heatmaster_schedule_night";
const SENSOR = "heatmaster_temp_sensor";
const OFFICE_T = "sensor.office_t";

type EntrySpec = Readonly<{ schedule?: string; sensors?: readonly string[] }>;

/** Schedules day (the default) and night, unless `schedules` says otherwise, and the entries. */
function config(
  rooms: Readonly<Record<string, EntrySpec>> = {},
  schedules: readonly string[] = ["day", "night"],
): Config {
  const document: RawConfig = {
    version: 3,
    settings: { hold_writes: false, timezone: "Europe/Amsterdam" },
    schedules: schedules.map((id) => ({
      id,
      name: id.charAt(0).toUpperCase() + id.slice(1),
      week: [{ days: "all", temperature: { "00:00": 18 } }],
    })),
    ...(schedules.length > 0 ? { default_schedule: schedules[0] } : {}),
    rooms: Object.fromEntries(
      Object.entries(rooms).map(([areaId, entry]) => [
        areaId,
        {
          ...(entry.schedule === undefined ? {} : { schedule: entry.schedule }),
          ...(entry.sensors === undefined
            ? {}
            : { sensors: entry.sensors.map((entity) => ({ ref: `ha:${entity}` })) }),
        },
      ]),
    ),
  };
  return validateConfig(document);
}

/** Rooms office and hall; garage is an area that holds no valve. */
const MEMBERSHIP: AreaMembership = {
  rooms: new Map([
    ["hall", { name: "Hall", valveIds: ["z2m:0xb2"] }],
    ["office", { name: "Office", valveIds: ["z2m:0xa1"] }],
  ]),
  ignored: [],
};

type Scene = Readonly<{
  areas?: Readonly<Record<string, readonly string[]>>;
  entities?: Readonly<Record<string, HaEntity>>;
  labels?: Readonly<Record<string, string>>;
}>;

/** Areas office, hall and garage with no label, unless given. */
function scene(options: Scene = {}): HaSnapshot {
  const areaLabels = options.areas ?? { office: [], hall: [], garage: [] };
  const areas = new Map<string, HaArea>(
    Object.entries(areaLabels).map(([areaId, labels]) => [areaId, { name: areaId, labels }]),
  );
  return {
    areas,
    valveAreas: new Map(),
    entities: new Map(Object.entries(options.entities ?? {})),
    labels: new Map(Object.entries(options.labels ?? {})),
  };
}

type Rig = Readonly<{ ha: StubHaLink; sync: LabelSync }>;

function rig(snapshot: HaSnapshot = scene()): Rig {
  const ha = createStubHaLink();
  ha.setSnapshot(snapshot);
  return { ha, sync: createLabelSync(ha, () => new Set(["0xa1", "0xb2"])) };
}

function current(ha: StubHaLink): HaSnapshot {
  const snapshot = ha.snapshot();
  if (snapshot === undefined) throw new Error("no snapshot");
  return snapshot;
}

/** The user changes an area's labels in Home Assistant. */
function relabelArea(ha: StubHaLink, areaId: string, labels: readonly string[]): void {
  const snapshot = current(ha);
  const area = snapshot.areas.get(areaId);
  if (area === undefined) throw new Error(`no area ${areaId}`);
  ha.setSnapshot({
    ...snapshot,
    areas: new Map([...snapshot.areas, [areaId, { ...area, labels }]]),
  });
}

/** The user changes an entity's labels in Home Assistant. */
function relabelEntity(ha: StubHaLink, entityId: string, labels: readonly string[]): void {
  const snapshot = current(ha);
  const entity = snapshot.entities.get(entityId);
  if (entity === undefined) throw new Error(`no entity ${entityId}`);
  ha.setSnapshot({
    ...snapshot,
    entities: new Map([...snapshot.entities, [entityId, { ...entity, labels }]]),
  });
}

function writtenOps(ha: StubHaLink): LabelOp[] {
  return ha.labelBatches().flat();
}

function kinds(sync: LabelSync): string[] {
  return sync.problems().map((p) => `${p.kind}:${p.subject.kind}:${p.subject.id}`);
}

const OK_SENSOR = { exists: true, isTemperature: true, onValve: false };
const ECO = "heatmaster_schedule_eco";
/** Schedules day (the default), night and eco. */
const THREE: readonly string[] = ["day", "night", "eco"];

/** The office area write fails as sent without an answer. */
function officeTimesOut(op: LabelOp): string | undefined {
  return op.kind === "labelArea" && op.areaId === "office" ? "timeout" : undefined;
}

// ---- tests ---------------------------------------------------------------------------------------

describe("label-sync", () => {
  describe("mirror", () => {
    describe("With two schedules and no Heatmaster label in Home Assistant", () => {
      it("both labels are created and renamed", async () => {
        const { ha, sync } = rig();
        await sync.mirror(config(), MEMBERSHIP);
        expect(current(ha).labels).toEqual(
          new Map([
            [DAY, "Heatmaster: Day"],
            [NIGHT, "Heatmaster: Night"],
          ]),
        );
      });
    });

    describe("With an op failing", () => {
      const officeFails = (op: LabelOp): string | undefined =>
        op.kind === "labelArea" && op.areaId === "office" ? "unauthorized" : undefined;

      it("problems holds ha_label_failed for its target", async () => {
        const { ha, sync } = rig();
        ha.failLabels(officeFails);
        await sync.mirror(config(), MEMBERSHIP);
        expect(sync.problems()).toEqual([
          {
            kind: "ha_label_failed",
            subject: { kind: "area", id: "office" },
            severity: "warning",
            data: { op: "labelArea", error: "unauthorized" },
          },
        ]);
      });

      it("the next mirror in which it succeeds clears it", async () => {
        const { ha, sync } = rig();
        ha.failLabels(officeFails);
        await sync.mirror(config(), MEMBERSHIP);
        ha.failLabels(undefined);
        await sync.mirror(config(), MEMBERSHIP);
        expect(sync.problems()).toEqual([]);
        expect(current(ha).areas.get("office")?.labels).toEqual([DAY]);
      });
    });

    describe("With a labelEntity op failing, then a mirror of scope schedules", () => {
      it("problems still holds that failure", async () => {
        const { ha, sync } = rig(
          scene({ entities: { [OFFICE_T]: { areaId: "office", labels: [] } } }),
        );
        ha.failLabels((op) => (op.kind === "labelEntity" ? "unauthorized" : undefined));
        const wanted = config({ office: { sensors: [OFFICE_T] } });
        await sync.mirror(wanted, MEMBERSHIP);
        await sync.mirror(wanted, MEMBERSHIP, "schedules");
        expect(kinds(sync)).toEqual([`ha_label_failed:sensor:ha:${OFFICE_T}`]);
      });
    });

    describe("With scope schedules and a sensor lacking its label", () => {
      it("no labelEntity op is written", async () => {
        const { ha, sync } = rig(
          scene({ entities: { [OFFICE_T]: { areaId: "office", labels: [] } } }),
        );
        await sync.mirror(config({ office: { sensors: [OFFICE_T] } }), MEMBERSHIP, "schedules");
        expect(writtenOps(ha)).not.toEqual([]);
        expect(writtenOps(ha).filter((op) => op.kind === "labelEntity")).toEqual([]);
      });
    });

    describe("With a configured sensor that has no registry entry", () => {
      it("problems holds sensor_unlabellable for it", async () => {
        const { sync } = rig();
        await sync.mirror(config({ office: { sensors: [OFFICE_T] } }), MEMBERSHIP);
        expect(kinds(sync)).toEqual([`sensor_unlabellable:sensor:ha:${OFFICE_T}`]);
      });
    });

    describe("With a batch in which an op failed with label_clash", () => {
      it("one follow-up mirror is written, which renames the wanted label and puts it on its areas", async () => {
        const { ha, sync } = rig();
        // Home Assistant gained a label "heatmaster_schedule_day" after the plan was made.
        ha.onLabelBatch(() => {
          ha.onLabelBatch(undefined);
          const snapshot = current(ha);
          ha.setSnapshot({ ...snapshot, labels: new Map([[DAY, "Made by hand"]]) });
        });
        await sync.mirror(config(), MEMBERSHIP);
        await vi.waitFor(() => {
          expect(ha.labelBatches()).toHaveLength(2);
        });
        await sync.mirror(config(), MEMBERSHIP);
        expect(current(ha).labels.get(DAY)).toBe("Heatmaster: Day");
        expect(current(ha).areas.get("office")?.labels).toEqual([DAY]);
        expect(kinds(sync)).toEqual([]);
      });

      it("a follow-up that clashes again is followed by no further mirror", async () => {
        const { ha, sync } = rig();
        ha.failLabels((op) => (op.kind === "createLabel" ? "label_clash" : undefined));
        await sync.mirror(config(), MEMBERSHIP);
        await vi.waitFor(() => {
          expect(ha.labelBatches()).toHaveLength(2);
        });
        await sync.mirror(config(), MEMBERSHIP);
        // The second mirror asked for here is the third batch and has its own one follow-up.
        await vi.waitFor(() => {
          expect(ha.labelBatches()).toHaveLength(4);
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(ha.labelBatches()).toHaveLength(4);
      });
    });

    describe("With a rename that Home Assistant refuses because the name is taken", () => {
      const taken = (op: LabelOp): string | undefined =>
        op.kind === "renameLabel" ? "invalid_info" : undefined;
      const misnamed = (): HaSnapshot =>
        scene({ labels: { [DAY]: "Old day", [NIGHT]: "Heatmaster: Night" } });

      it("problems holds ha_label_failed with error invalid_info for the label", async () => {
        const { ha, sync } = rig(misnamed());
        ha.failLabels(taken);
        await sync.mirror(config(), MEMBERSHIP);
        expect(sync.problems()).toContainEqual({
          kind: "ha_label_failed",
          subject: { kind: "label", id: DAY },
          severity: "warning",
          data: { op: "renameLabel", error: "invalid_info" },
        });
      });

      it("each later mirror that is refused again keeps it, and none follows up by itself", async () => {
        const { ha, sync } = rig(misnamed());
        ha.failLabels(taken);
        await sync.mirror(config(), MEMBERSHIP);
        await sync.mirror(config(), MEMBERSHIP, "schedules");
        await new Promise((resolve) => setImmediate(resolve));
        expect(ha.labelBatches()).toHaveLength(2);
        expect(kinds(sync)).toContain(`ha_label_failed:label:${DAY}`);
      });
    });

    describe("With an op failing with each code writeLabels returns", () => {
      it.each([
        "unauthorized",
        "invalid_info",
        "unknown_error",
        "not_found",
        "label_clash",
        "timeout",
        "link_down",
      ])(
        "%s: problems holds ha_label_failed whose data names the op and the code",
        async (code) => {
          const { ha, sync } = rig();
          ha.failLabels((op) =>
            op.kind === "labelArea" && op.areaId === "hall" ? code : undefined,
          );
          await sync.mirror(config(), MEMBERSHIP);
          expect(sync.problems().find((p) => p.subject.id === "hall")).toEqual({
            kind: "ha_label_failed",
            subject: { kind: "area", id: "hall" },
            severity: "warning",
            data: { op: "labelArea", error: code },
          });
        },
      );
    });

    describe("While the link is not up", () => {
      it("nothing is written and pull returns undefined", async () => {
        const { ha, sync } = rig();
        ha.setReady(true);
        ha.setState("down");
        await sync.mirror(config(), MEMBERSHIP);
        expect(ha.labelBatches()).toEqual([]);
        ha.setState("up");
        relabelArea(ha, "office", [NIGHT]);
        expect(sync.pull(config(), MEMBERSHIP)).toBeUndefined();
      });
    });
  });

  describe("pull", () => {
    describe("Before any mirror", () => {
      it("returns undefined", () => {
        const { ha, sync } = rig(scene({ labels: { [NIGHT]: "Heatmaster: Night" } }));
        expect(sync.pull(config(), MEMBERSHIP)).toBeUndefined();
        relabelArea(ha, "office", [NIGHT]);
        expect(sync.pull(config(), MEMBERSHIP)).toBeUndefined();
      });
    });

    describe("After a mirror, with the snapshot showing only Heatmaster's own writes", () => {
      it("returns undefined", async () => {
        const { ha, sync } = rig(
          scene({ entities: { [OFFICE_T]: { areaId: "office", labels: [] } } }),
        );
        ha.setSensorInfo(OFFICE_T, OK_SENSOR);
        await sync.mirror(config({ office: { sensors: [OFFICE_T] } }), MEMBERSHIP);
        expect(writtenOps(ha)).not.toEqual([]);
        expect(sync.pull(config({ office: { sensors: [OFFICE_T] } }), MEMBERSHIP)).toBeUndefined();
        expect(sync.scheduleLabelsMoved()).toBe(false);
      });
    });

    describe("With the user moving night's label onto office after the mirror", () => {
      it("returns an edit naming night for office", async () => {
        const { ha, sync } = rig();
        await sync.mirror(config(), MEMBERSHIP);
        relabelArea(ha, "office", [NIGHT]);
        const edit = sync.pull(config(), MEMBERSHIP);
        expect(edit?.config.rooms.get("office")?.scheduleId).toBe("night");
        expect(edit?.items).toEqual([
          { kind: "schedule", areaId: "office", entityId: undefined, scheduleId: "night" },
        ]);
      });
    });

    describe("With the user's edit landing while a mirror's writes ran", () => {
      it("the next pull returns that edit", async () => {
        const { ha, sync } = rig();
        const release = ha.holdLabels();
        const mirrored = sync.mirror(config(), MEMBERSHIP);
        await vi.waitFor(() => {
          expect(current(ha).areas.get("hall")?.labels).toEqual([DAY]);
        });
        relabelArea(ha, "hall", [NIGHT]);
        release();
        await mirrored;
        expect(sync.pull(config(), MEMBERSHIP)?.items).toEqual([
          { kind: "schedule", areaId: "hall", entityId: undefined, scheduleId: "night" },
        ]);
      });
    });

    describe("With Home Assistant announcing a mirror's writes before its result, and a pull in between under a newer config", () => {
      it("the pull returns undefined: Heatmaster's own writes are no edit", async () => {
        const { ha, sync } = rig();
        await sync.mirror(config(), MEMBERSHIP);
        // The mirror of a config with office on night runs; its result is held after its writes.
        const release = ha.holdLabels();
        const mirrored = sync.mirror(config({ office: { schedule: "night" } }), MEMBERSHIP);
        await vi.waitFor(() => {
          expect(current(ha).areas.get("office")?.labels).toEqual([NIGHT]);
        });
        // Meanwhile the user applied office back on the default.
        expect(sync.pull(config(), MEMBERSHIP)).toBeUndefined();
        release();
        await mirrored;
      });

      it("scheduleLabelsMoved is true, so a schedules mirror sets the labels to the newer config", async () => {
        const { ha, sync } = rig();
        await sync.mirror(config(), MEMBERSHIP);
        const release = ha.holdLabels();
        const mirrored = sync.mirror(config({ office: { schedule: "night" } }), MEMBERSHIP);
        await vi.waitFor(() => {
          expect(current(ha).areas.get("office")?.labels).toEqual([NIGHT]);
        });
        sync.pull(config(), MEMBERSHIP);
        expect(sync.scheduleLabelsMoved()).toBe(true);
        release();
        await mirrored;
        await sync.mirror(config(), MEMBERSHIP, "schedules");
        expect(current(ha).areas.get("office")?.labels).toEqual([DAY]);
        expect(sync.pull(config(), MEMBERSHIP)).toBeUndefined();
      });
    });

    describe("With a write sent without an answer, whose batch's last reload got none either, applied by Home Assistant after a later mirror", () => {
      async function late(): Promise<Rig> {
        const { ha, sync } = rig();
        await sync.mirror(config({}, THREE), MEMBERSHIP);
        // The mirror of office on night: its office write gets no answer, nor does the reload.
        ha.failLabels(officeTimesOut);
        ha.settleLabels(false);
        await sync.mirror(config({ office: { schedule: "night" } }, THREE), MEMBERSHIP);
        ha.failLabels(undefined);
        ha.settleLabels(true);
        // The user applies office back on the default: Home Assistant still shows day, so nothing
        // is written. Then the link loads what Home Assistant did: it carried out the write.
        await sync.mirror(config({}, THREE), MEMBERSHIP);
        const op = ha
          .labelBatches()[1]
          ?.find((o) => o.kind === "labelArea" && o.areaId === "office");
        if (op === undefined) throw new Error("no office op");
        ha.setSnapshot(applyLabelOps(current(ha), [op], new Map()));
        return { ha, sync };
      }

      it("the pull after its echo returns undefined", async () => {
        const { sync } = await late();
        expect(sync.pull(config({}, THREE), MEMBERSHIP)).toBeUndefined();
      });

      it("scheduleLabelsMoved is true, so the labels go back to the config", async () => {
        const { sync } = await late();
        sync.pull(config({}, THREE), MEMBERSHIP);
        expect(sync.scheduleLabelsMoved()).toBe(true);
      });

      it("once a snapshot loaded after the batch was pulled, a user edit to that area is taken by the next pull", async () => {
        const { ha, sync } = await late();
        sync.pull(config({}, THREE), MEMBERSHIP);
        relabelArea(ha, "office", [ECO]);
        expect(sync.pull(config({}, THREE), MEMBERSHIP)?.items).toEqual([
          { kind: "schedule", areaId: "office", entityId: undefined, scheduleId: "eco" },
        ]);
      });
    });

    describe("With a write sent without an answer, whose batch's last reload got none either, applied by Home Assistant while a later mirror's writes ran", () => {
      it("the pull after that mirror returns undefined", async () => {
        const { ha, sync } = rig();
        await sync.mirror(config(), MEMBERSHIP);
        ha.failLabels(officeTimesOut);
        ha.settleLabels(false);
        await sync.mirror(config({ office: { schedule: "night" } }), MEMBERSHIP);
        ha.failLabels(undefined);
        ha.settleLabels(true);
        const op = ha
          .labelBatches()[1]
          ?.find((o) => o.kind === "labelArea" && o.areaId === "office");
        if (op === undefined) throw new Error("no office op");
        // The user applies hall on night and office back on the default; Home Assistant carries
        // out the unanswered write before it answers the new batch.
        ha.onLabelBatch(() => {
          ha.onLabelBatch(undefined);
          ha.setSnapshot(applyLabelOps(current(ha), [op], new Map()));
        });
        const wanted = config({ hall: { schedule: "night" } });
        await sync.mirror(wanted, MEMBERSHIP);
        expect(current(ha).areas.get("hall")?.labels).toEqual([NIGHT]);
        expect(sync.pull(wanted, MEMBERSHIP)).toBeUndefined();
      });
    });

    describe("With a write sent without an answer in a batch whose last reload answered", () => {
      it("a later user edit to its target is returned by the next pull", async () => {
        const { ha, sync } = rig();
        await sync.mirror(config({}, THREE), MEMBERSHIP);
        ha.failLabels(officeTimesOut);
        await sync.mirror(config({ office: { schedule: "night" } }, THREE), MEMBERSHIP);
        ha.failLabels(undefined);
        relabelArea(ha, "office", [ECO]);
        expect(
          sync.pull(config({ office: { schedule: "night" } }, THREE), MEMBERSHIP)?.items,
        ).toEqual([{ kind: "schedule", areaId: "office", entityId: undefined, scheduleId: "eco" }]);
      });
    });

    describe("With ops failing unsent because the create they rely on got no answer", () => {
      it("a user edit to their targets in the first snapshot loaded after the batch is returned", async () => {
        const { ha, sync } = rig();
        await sync.mirror(
          config(
            {},
            THREE.filter((id) => id !== "night"),
          ),
          MEMBERSHIP,
        );
        expect(current(ha).labels.has(NIGHT)).toBe(false);
        // The create of night is sent and gets no answer, nor does the reload; the rename and the
        // office label that rely on it are never sent.
        ha.failLabels((op) => (op.kind === "createLabel" ? "timeout" : undefined));
        ha.settleLabels(false);
        await sync.mirror(config({ office: { schedule: "night" } }, THREE), MEMBERSHIP);
        expect(ha.labelBatches()[1]?.map((op) => op.kind)).toEqual([
          "createLabel",
          "renameLabel",
          "labelArea",
        ]);
        ha.failLabels(undefined);
        ha.settleLabels(true);
        relabelArea(ha, "office", [ECO]);
        expect(
          sync.pull(config({ office: { schedule: "night" } }, THREE), MEMBERSHIP)?.items,
        ).toEqual([{ kind: "schedule", areaId: "office", entityId: undefined, scheduleId: "eco" }]);
      });
    });

    describe("With a config that has no schedule", () => {
      it("returns undefined, even for a sensor label added to an entity in a room", async () => {
        const { ha, sync } = rig(
          scene({
            entities: { [OFFICE_T]: { areaId: "office", labels: [] } },
            labels: { [SENSOR]: SENSOR },
          }),
        );
        ha.setSensorInfo(OFFICE_T, OK_SENSOR);
        await sync.mirror(config({}, []), MEMBERSHIP);
        relabelEntity(ha, OFFICE_T, [SENSOR]);
        expect(sync.pull(config({}, []), MEMBERSHIP)).toBeUndefined();
      });
    });
  });

  describe("scheduleLabelsMoved", () => {
    describe("With the user taking the default's label off a room on the default", () => {
      it("is true although pull returns undefined", async () => {
        const { ha, sync } = rig();
        await sync.mirror(config(), MEMBERSHIP);
        relabelArea(ha, "office", []);
        expect(sync.pull(config(), MEMBERSHIP)).toBeUndefined();
        expect(sync.scheduleLabelsMoved()).toBe(true);
      });
    });
  });

  describe("reset", () => {
    describe("After a reset", () => {
      it("pull returns undefined until the next mirror", async () => {
        const { ha, sync } = rig();
        await sync.mirror(config(), MEMBERSHIP);
        sync.reset();
        relabelArea(ha, "office", [NIGHT]);
        expect(sync.pull(config(), MEMBERSHIP)).toBeUndefined();
        await sync.mirror(config(), MEMBERSHIP);
        relabelArea(ha, "hall", [NIGHT]);
        expect(sync.pull(config(), MEMBERSHIP)?.items).toEqual([
          { kind: "schedule", areaId: "hall", entityId: undefined, scheduleId: "night" },
        ]);
      });
    });

    describe("While a mirror's writes ran", () => {
      it("that mirror leaves no baseline: pull returns undefined after it", async () => {
        const { ha, sync } = rig();
        const release = ha.holdLabels();
        const mirrored = sync.mirror(config(), MEMBERSHIP);
        await vi.waitFor(() => {
          expect(ha.labelBatches()).toHaveLength(1);
        });
        sync.reset();
        release();
        await mirrored;
        relabelArea(ha, "office", [NIGHT]);
        expect(sync.pull(config(), MEMBERSHIP)).toBeUndefined();
      });
    });
  });
});
