/**
 * Keeps Home Assistant's labels and the config in step. `mirror` writes the labels the config
 * wants, in its own serial queue, never under the runtime lock. `pull` turns the label edits made
 * in Home Assistant since the last mirror or pull into a config edit. Heatmaster's own writes are
 * part of the baseline `pull` compares against, so their echoes are no edits.
 *
 * Known limit: a label edit made in the HA_SETTLE_MS before an apply is not pulled; the apply's
 * mirror sets the labels to the new config.
 */

import {
  LEGACY_SENSOR_LABEL,
  SCHEDULE_LABEL_PREFIX,
  SENSOR_LABEL,
  applyLabelOps,
  labelEdits,
  mirrorLabels,
  problemHaLabelFailed,
  problemSensorUnlabellable,
} from "@heatmaster/core";
import type {
  AreaMembership,
  Config,
  HaEdit,
  HaSnapshot,
  LabelOp,
  Problem,
  SensorInfo,
} from "@heatmaster/core";
import type { HaLink, LabelWriteResult } from "./ha-link.ts";

export type LabelScope = "all" | "schedules";

export type LabelSync = Readonly<{
  /** Queues a mirror; resolves once it has run. Nothing waits for it under the runtime lock. */
  mirror(config: Config, membership: AreaMembership, scope?: LabelScope): Promise<void>;
  /** The edit the user's label changes since the last mirror or pull make; undefined for none. */
  pull(config: Config, membership: AreaMembership): HaEdit | undefined;
  /** Whether the last pull saw a Heatmaster schedule label differ from the baseline, edit or not. */
  scheduleLabelsMoved(): boolean;
  problems(): readonly Problem[];
  /** Forgets the baseline: `pull` returns undefined until the next mirror has run. */
  reset(): void;
}>;

type Failure = Readonly<{ op: LabelOp; error: string }>;

/**
 * The codes of a write that may have been applied although it was not reported done: it timed out,
 * or the link dropped after it was sent.
 */
const UNCERTAIN = new Set(["timeout", "link_down"]);
const LABEL_CLASH = "label_clash";

/**
 * The sensor info of every entity in the snapshot that carries `heatmaster_temp_sensor` or
 * `room_temperature_sensor`, keyed by entity id: the entities the core's label functions look up.
 */
export function sensorInfos(
  ha: HaLink,
  snapshot: HaSnapshot,
  valveAddresses: ReadonlySet<string>,
): ReadonlyMap<string, SensorInfo> {
  const infos = new Map<string, SensorInfo>();
  for (const [entityId, entity] of snapshot.entities) {
    if (entity.labels.includes(SENSOR_LABEL) || entity.labels.includes(LEGACY_SENSOR_LABEL)) {
      infos.set(entityId, ha.sensorInfo(entityId, valveAddresses));
    }
  }
  return infos;
}

/** The ops of a schedules-scope mirror leave these alone, so their failures are kept. */
function sensorSide(op: LabelOp): boolean {
  return op.kind === "labelEntity" || (op.kind === "createLabel" && op.name === SENSOR_LABEL);
}

/** The registry entries an op writes, keyed `label:`, `area:` or `entity:`. */
function targetsOf(op: LabelOp, baseline: HaSnapshot): readonly string[] {
  switch (op.kind) {
    case "createLabel":
      return [`label:${op.name}`];
    case "renameLabel":
      return [`label:${op.labelId}`];
    case "deleteLabel": {
      // A delete takes the label off every area and entity that wears it.
      const wearers = [
        ...[...baseline.areas]
          .filter(([, area]) => area.labels.includes(op.labelId))
          .map(([areaId]) => `area:${areaId}`),
        ...[...baseline.entities]
          .filter(([, entity]) => entity.labels.includes(op.labelId))
          .map(([entityId]) => `entity:${entityId}`),
      ];
      return [`label:${op.labelId}`, ...wearers];
    }
    case "labelArea":
      return [`area:${op.areaId}`];
    case "labelEntity":
      return [`entity:${op.entityId}`];
  }
}

function holdsAll(
  labels: readonly string[],
  add: readonly string[],
  remove: readonly string[],
): boolean {
  return add.every((id) => labels.includes(id)) && !remove.some((id) => labels.includes(id));
}

/** Whether the snapshot shows the op carried out. */
function shows(snapshot: HaSnapshot, op: LabelOp): boolean {
  switch (op.kind) {
    case "createLabel":
      return snapshot.labels.has(op.name);
    case "renameLabel":
      return snapshot.labels.get(op.labelId) === op.name;
    case "deleteLabel":
      return !snapshot.labels.has(op.labelId);
    case "labelArea": {
      const area = snapshot.areas.get(op.areaId);
      return area !== undefined && holdsAll(area.labels, op.add, op.remove);
    }
    case "labelEntity": {
      const entity = snapshot.entities.get(op.entityId);
      return entity !== undefined && holdsAll(entity.labels, op.add, op.remove);
    }
  }
}

function copyEntry<T>(into: Map<string, T>, from: ReadonlyMap<string, T>, key: string): void {
  const value = from.get(key);
  if (value === undefined) into.delete(key);
  else into.set(key, value);
}

/** The baseline with the targets' entries taken from the snapshot: their changes are no edits. */
function absorb(
  baseline: HaSnapshot,
  snapshot: HaSnapshot,
  targets: ReadonlySet<string>,
): HaSnapshot {
  if (targets.size === 0) return baseline;
  const labels = new Map(baseline.labels);
  const areas = new Map(baseline.areas);
  const entities = new Map(baseline.entities);
  for (const target of targets) {
    const at = target.indexOf(":");
    const kind = target.slice(0, at);
    const id = target.slice(at + 1);
    if (kind === "label") copyEntry(labels, snapshot.labels, id);
    else if (kind === "area") copyEntry(areas, snapshot.areas, id);
    else copyEntry(entities, snapshot.entities, id);
  }
  return { ...baseline, labels, areas, entities };
}

function scheduleLabels(labels: readonly string[]): string {
  return labels
    .filter((id) => id.startsWith(SCHEDULE_LABEL_PREFIX))
    .sort()
    .join(",");
}

/**
 * Whether a label starting with `heatmaster_schedule_` was created, renamed or deleted, or put on
 * or taken off an area. Numbered (foreign) labels count too: the schedules mirror this asks for
 * plans nothing for them.
 */
function scheduleLabelsDiffer(before: HaSnapshot, after: HaSnapshot): boolean {
  const named = (snapshot: HaSnapshot): string =>
    [...snapshot.labels]
      .filter(([id]) => id.startsWith(SCHEDULE_LABEL_PREFIX))
      .map(([id, name]) => `${id}=${name}`)
      .sort()
      .join("\n");
  if (named(before) !== named(after)) return true;
  const areaIds = new Set([...before.areas.keys(), ...after.areas.keys()]);
  return [...areaIds].some(
    (areaId) =>
      scheduleLabels(before.areas.get(areaId)?.labels ?? []) !==
      scheduleLabels(after.areas.get(areaId)?.labels ?? []),
  );
}

export function createLabelSync(ha: HaLink, valveAddresses: () => ReadonlySet<string>): LabelSync {
  let baseline: HaSnapshot | undefined;
  /** Rises at every reset: a mirror that began before one leaves no baseline. */
  let generation = 0;
  /** Rises at every pull: a mirror then builds on the pulled snapshot, not on its own. */
  let pulls = 0;
  /** The ops of the batch being written: a pull takes their targets as Home Assistant shows them. */
  let inflight: readonly LabelOp[] = [];
  /**
   * Ops that may have been applied unreported (`UNCERTAIN`): a pull takes their targets as Home
   * Assistant shows them until the snapshot shows them carried out, or until a later batch was
   * answered (Home Assistant handles one connection's commands in order, so by then they were).
   */
  let uncertain: readonly LabelOp[] = [];
  let failures: readonly Failure[] = [];
  let unlabellable: readonly string[] = [];
  let moved = false;

  let tail: Promise<void> = Promise.resolve();
  let queued = 0;

  function enqueue(job: () => Promise<void>): Promise<void> {
    queued += 1;
    const run = tail.then(job).finally(() => {
      queued -= 1;
    });
    tail = run.catch(() => undefined);
    return run;
  }

  async function runMirror(
    config: Config,
    membership: AreaMembership,
    scope: LabelScope,
    followUp: boolean,
  ): Promise<void> {
    // A mirror while the link is not up writes nothing and leaves no baseline: on the reconnect
    // the config wins, so edits made meanwhile must not become revisions.
    if (!ha.up()) return;
    const snapshot = ha.snapshot();
    if (snapshot === undefined) return;
    const startedAt = generation;
    const pullsAtStart = pulls;
    const plan = mirrorLabels(config, membership, snapshot, scope);
    inflight = plan.ops;
    let result: LabelWriteResult;
    try {
      result = await ha.writeLabels(plan.ops);
    } finally {
      inflight = [];
    }
    failures =
      scope === "all"
        ? result.failed
        : [...failures.filter((failure) => sensorSide(failure.op)), ...result.failed];
    if (scope === "all") unlabellable = plan.unlabellable;
    if (startedAt !== generation) return;
    // Own writes are part of the baseline: input bookkeeping, not a write decision. A pull while
    // they ran took the newer snapshot as its baseline; they go on top of that.
    const base = pulls === pullsAtStart ? snapshot : (baseline ?? snapshot);
    const own = applyLabelOps(base, result.done, result.created);
    const answered = result.done.length > 0;
    const after = ha.snapshot();
    baseline =
      answered && after !== undefined && uncertain.length > 0
        ? absorb(own, after, new Set(uncertain.flatMap((op) => targetsOf(op, own))))
        : own;
    uncertain = [
      ...(answered ? [] : uncertain),
      ...result.failed.filter((failure) => UNCERTAIN.has(failure.error)).map((f) => f.op),
    ];
    // A clash means Home Assistant had the wanted label already: the rename and the area labels
    // that relied on it were skipped. One more mirror sees it, unless a newer one is queued.
    const clashed = result.failed.some((failure) => failure.error === LABEL_CLASH);
    if (clashed && !followUp && queued === 1) {
      void enqueue(() => runMirror(config, membership, scope, true)).catch(() => undefined);
    }
  }

  return {
    mirror(config, membership, scope = "all") {
      return enqueue(() => runMirror(config, membership, scope, false));
    },

    pull(config, membership) {
      pulls += 1;
      moved = false;
      const before = baseline;
      if (before === undefined) return undefined;
      const snapshot = ha.snapshot();
      if (snapshot === undefined) return undefined;
      const unsettled = new Set([...uncertain, ...inflight].flatMap((op) => targetsOf(op, before)));
      const compared = absorb(before, snapshot, unsettled);
      uncertain = uncertain.filter((op) => !shows(snapshot, op));
      baseline = snapshot;
      // With no schedule nothing is managed, labels included.
      if (config.schedules.length === 0) return undefined;
      // Against the baseline itself: a write's late echo that the config no longer wants moved a
      // label, and the schedules mirror this asks for moves it back.
      moved = scheduleLabelsDiffer(before, snapshot);
      const infos = sensorInfos(ha, snapshot, valveAddresses());
      return labelEdits(compared, snapshot, config, membership, infos);
    },

    scheduleLabelsMoved: () => moved,

    problems() {
      return [
        ...failures.map((failure) => problemHaLabelFailed(failure.op, failure.error)),
        ...unlabellable.map((entityId) => problemSensorUnlabellable(entityId)),
      ];
    },

    reset() {
      generation += 1;
      baseline = undefined;
      uncertain = [];
      moved = false;
    },
  };
}
