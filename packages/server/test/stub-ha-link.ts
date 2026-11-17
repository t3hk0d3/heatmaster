import { applyLabelOps } from "@heatmaster/core";
import type { HaSnapshot, LabelOp, SensorInfo } from "@heatmaster/core";
import type { Clock } from "../src/clock.ts";
import {
  HA_LABEL_TIMEOUT_MS,
  type HaEvent,
  type HaHouse,
  type HaLink,
  type HaLinkState,
  type HaSensor,
  type LabelWriteResult,
} from "../src/ha-link.ts";

export type StubHaLink = HaLink &
  Readonly<{
    /** Sets the state; `up` and `ready` follow from it unless `setReady` was called. */
    setState(state: HaLinkState): void;
    setReady(ready: boolean): void;
    setHouse(house: HaHouse | undefined): void;
    setSensor(entityId: string, sensor: HaSensor | undefined): void;
    setSensorInfo(entityId: string, info: SensorInfo): void;
    setEntityName(entityId: string, name: string): void;
    setAreaName(areaId: string, name: string): void;
    /** What `snapshot()` answers from now on. */
    setSnapshot(snapshot: HaSnapshot | undefined): void;
    /** How many times `snapshot()` was called. */
    snapshotReads(): number;
    emit(event: HaEvent): void;
    /** Every set given to `watch`, oldest first. */
    watched(): readonly ReadonlySet<string>[];
    /** The entity of every `sensorInfo` call, in order. */
    infoCalls(): readonly string[];
    /** The valve addresses of every `sensorInfo` call, in order. */
    infoAddresses(): readonly ReadonlySet<string>[];
    started(): boolean;
    stopped(): boolean;
    /**
     * From now on an op for which `fail` gives a code fails with it and changes nothing. With
     * `timeout` or `link_down` the op was sent and got no answer (`unanswered`).
     */
    failLabels(fail: ((op: LabelOp) => string | undefined) | undefined): void;
    /**
     * From now on every batch answers only after HA_LABEL_TIMEOUT_MS on `clock`, as a link whose
     * Home Assistant never answers: its first reload times out, so no op is sent, each fails with
     * `timeout`, and nothing changes.
     */
    stallLabels(clock: Clock | undefined): void;
    /**
     * With false, from now on a batch's last reload gets no answer: `settled` is false, and the
     * snapshot and `loads()` stay as they were, whatever the ops did.
     */
    settleLabels(settle: boolean): void;
    /**
     * The next batch is carried out and announced (`registries_changed`) as usual, but its result
     * is held until the returned function is called.
     */
    holdLabels(): () => void;
    /** Runs at the start of every batch, before its first op: Home Assistant changed meanwhile. */
    onLabelBatch(run: (() => void) | undefined): void;
    /** The ops of every `writeLabels` call, oldest first. */
    labelBatches(): readonly (readonly LabelOp[])[];
  }>;

const UNKNOWN: SensorInfo = { exists: false, isTemperature: false, onValve: false };

export const EMPTY_HA_SNAPSHOT: HaSnapshot = {
  areas: new Map(),
  valveAreas: new Map(),
  entities: new Map(),
  labels: new Map(),
};

const EMPTY_RESULT: LabelWriteResult = {
  done: [],
  failed: [],
  created: new Map(),
  unanswered: [],
  settled: false,
};
const UNANSWERED = new Set(["timeout", "link_down"]);

/** The labels an op needs to exist: a create earlier in its batch may not have given them. */
function reliesOn(op: LabelOp): readonly string[] {
  if (op.kind === "renameLabel") return [op.labelId];
  if (op.kind === "labelArea" || op.kind === "labelEntity") return op.add;
  return [];
}

/**
 * A new stub is up and ready, with no house, no sensors, no names and an empty snapshot. Like a
 * link whose full load is done, its `start` sends `link_up` at once while it is up and ready.
 *
 * `writeLabels` carries the ops out on the snapshot as Home Assistant would: a create of an id that
 * is taken gives `<id>_2` (`label_clash`, and the ops relying on it fail the same way), an area or
 * entity it does not have is `not_found`, and while it is not up every op fails with `link_down`.
 * When an op was done it sends `registries_changed`, then answers.
 */
export function createStubHaLink(): StubHaLink {
  let state: HaLinkState = "up";
  let ready: boolean | undefined;
  let house: HaHouse | undefined;
  let snapshot: HaSnapshot | undefined = EMPTY_HA_SNAPSHOT;
  let snapshotReads = 0;
  let listener: ((event: HaEvent) => void) | undefined;
  const sensors = new Map<string, HaSensor>();
  const infos = new Map<string, SensorInfo>();
  const names = new Map<string, string>();
  const areas = new Map<string, string>();
  const watched: ReadonlySet<string>[] = [];
  const infoCalls: string[] = [];
  const infoAddresses: ReadonlySet<string>[] = [];
  let started = false;
  let stopped = false;
  let fail: ((op: LabelOp) => string | undefined) | undefined;
  let stall: Clock | undefined;
  let hold: Promise<void> | undefined;
  let beforeBatch: (() => void) | undefined;
  let settle = true;
  let loads = 0;
  const batches: (readonly LabelOp[])[] = [];

  /** Carries the ops out on the snapshot; true when something changed. */
  function carryOut(
    ops: readonly LabelOp[],
  ): Readonly<{ result: LabelWriteResult; changed: boolean }> {
    if (state !== "up" || snapshot === undefined) {
      return {
        result: { ...EMPTY_RESULT, failed: ops.map((op) => ({ op, error: "link_down" })) },
        changed: false,
      };
    }
    let current = snapshot;
    const done: LabelOp[] = [];
    const failed: { op: LabelOp; error: string }[] = [];
    const created = new Map<string, string>();
    const missing = new Map<string, string>();
    const unanswered: LabelOp[] = [];
    for (const op of ops) {
      // Not sent: it relies on a create that did not give its label, or its target is unknown.
      const unsent =
        reliesOn(op)
          .map((label) => missing.get(label))
          .find((code) => code !== undefined) ??
        ((op.kind === "labelArea" && !current.areas.has(op.areaId)) ||
        (op.kind === "labelEntity" && !current.entities.has(op.entityId))
          ? "not_found"
          : undefined);
      const error = unsent ?? fail?.(op);
      if (error !== undefined) {
        failed.push({ op, error });
        if (unsent === undefined && UNANSWERED.has(error)) unanswered.push(op);
        if (op.kind === "createLabel") missing.set(op.name, error);
        continue;
      }
      if (op.kind === "createLabel" && current.labels.has(op.name)) {
        const labelId = `${op.name}_2`;
        created.set(op.name, labelId);
        current = applyLabelOps(current, [op], created);
        failed.push({ op, error: "label_clash" });
        missing.set(op.name, "label_clash");
        continue;
      }
      if (op.kind === "createLabel") created.set(op.name, op.name);
      current = applyLabelOps(current, [op], created);
      done.push(op);
    }
    if (!settle) {
      return { result: { done, failed, created, unanswered, settled: false }, changed: false };
    }
    const changed = current !== snapshot;
    snapshot = current;
    loads += 1;
    return { result: { done, failed, created, unanswered, settled: true }, changed };
  }

  return {
    start(next) {
      started = true;
      listener = next;
      if (state === "up" && (ready ?? true)) next({ kind: "link_up" });
    },
    stop() {
      stopped = true;
      listener = undefined;
      return Promise.resolve();
    },
    state: () => state,
    up: () => state === "up",
    ready: () => ready ?? state === "up",
    house: () => house,
    watch(entityIds) {
      watched.push(new Set(entityIds));
    },
    sensor: (entityId) => sensors.get(entityId),
    sensorInfo(entityId, valveAddresses) {
      infoCalls.push(entityId);
      infoAddresses.push(new Set(valveAddresses));
      return infos.get(entityId) ?? UNKNOWN;
    },
    entityName: (entityId) => names.get(entityId),
    areaName: (areaId) => areas.get(areaId),
    snapshot() {
      snapshotReads += 1;
      return snapshot;
    },
    writeLabels(ops) {
      batches.push([...ops]);
      if (ops.length === 0) return Promise.resolve(EMPTY_RESULT);
      const clock = stall;
      if (clock !== undefined) {
        const timedOut = { ...EMPTY_RESULT, failed: ops.map((op) => ({ op, error: "timeout" })) };
        return new Promise((resolve) => {
          clock.after(HA_LABEL_TIMEOUT_MS, () => {
            resolve(timedOut);
          });
        });
      }
      const held = hold;
      hold = undefined;
      return Promise.resolve().then(async () => {
        beforeBatch?.();
        const { result, changed } = carryOut(ops);
        if (changed && state === "up") listener?.({ kind: "registries_changed" });
        await held;
        return result;
      });
    },
    failLabels(next) {
      fail = next;
    },
    stallLabels(next) {
      stall = next;
    },
    settleLabels(next) {
      settle = next;
    },
    holdLabels() {
      let release: () => void = () => undefined;
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    onLabelBatch(run) {
      beforeBatch = run;
    },
    labelBatches: () => [...batches],
    setState(next) {
      state = next;
    },
    setReady(next) {
      ready = next;
    },
    setHouse(next) {
      house = next;
    },
    setSensor(entityId, sensor) {
      if (sensor === undefined) sensors.delete(entityId);
      else sensors.set(entityId, sensor);
    },
    setSensorInfo(entityId, info) {
      infos.set(entityId, info);
    },
    setEntityName(entityId, name) {
      names.set(entityId, name);
    },
    setAreaName(areaId, name) {
      areas.set(areaId, name);
    },
    setSnapshot(next) {
      snapshot = next;
      loads += 1;
    },
    loads: () => loads,
    snapshotReads: () => snapshotReads,
    emit(event) {
      listener?.(event);
    },
    watched: () => [...watched],
    infoCalls: () => [...infoCalls],
    infoAddresses: () => [...infoAddresses],
    started: () => started,
    stopped: () => stopped,
  };
}
