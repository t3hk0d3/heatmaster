import {
  SCHEDULE_LABEL_PREFIX,
  SENSOR_LABEL,
  scheduleLabelId,
  scheduleLabelName,
  type AreaMembership,
  type HaSnapshot,
} from "./house.ts";
import type { Config } from "./model.ts";

/** One label write to Home Assistant. */
export type LabelOp =
  | Readonly<{ kind: "createLabel"; name: string }>
  | Readonly<{ kind: "renameLabel"; labelId: string; name: string }>
  | Readonly<{ kind: "deleteLabel"; labelId: string }>
  | Readonly<{
      kind: "labelArea";
      areaId: string;
      add: readonly string[];
      remove: readonly string[];
    }>
  | Readonly<{
      kind: "labelEntity";
      entityId: string;
      add: readonly string[];
      remove: readonly string[];
    }>;

/**
 * The label writes that make Home Assistant match the config, in order. `foreign` lists the clash
 * labels (`<schedule label>_<n>`), which no op names; `unlabellable` lists the configured sensor
 * entities Home Assistant has no registry entry for.
 */
export type LabelPlan = Readonly<{
  ops: readonly LabelOp[];
  foreign: readonly string[];
  unlabellable: readonly string[];
}>;

const SENSOR_PREFIX = "ha:";
const NUMBERED = /^(.+)_([0-9]+)$/;

/**
 * Plans the label writes that mirror the config onto Home Assistant: schedule labels created,
 * renamed and deleted, each area wearing its schedule's label, and `heatmaster_temp_sensor` on
 * exactly the configured sensor entities. Scope `schedules` leaves out the sensor label.
 */
export function mirrorLabels(
  config: Config,
  membership: AreaMembership,
  snapshot: HaSnapshot,
  scope: "all" | "schedules" = "all",
): LabelPlan {
  const scheduleLabels = new Map(config.schedules.map((s) => [scheduleLabelId(s.id), s]));
  const clashBases = new Set(scheduleLabels.keys());
  for (const id of snapshot.labels.keys()) {
    if (id.startsWith(SCHEDULE_LABEL_PREFIX)) clashBases.add(id);
  }
  /** The base label a clash label clashes with, or undefined when the label is no clash. */
  const clashBase = (labelId: string): string | undefined => {
    if (scheduleLabels.has(labelId)) return undefined;
    const match = NUMBERED.exec(labelId);
    const base = match?.[1];
    if (base === undefined || Number(match?.[2]) < 2 || !clashBases.has(base)) return undefined;
    return base;
  };
  const owned = (labelId: string): boolean =>
    labelId.startsWith(SCHEDULE_LABEL_PREFIX) && clashBase(labelId) === undefined;

  const foreign: string[] = [];
  const clashed = new Set<string>();
  for (const id of snapshot.labels.keys()) {
    const base = clashBase(id);
    if (base === undefined) continue;
    foreign.push(id);
    clashed.add(base);
  }
  /** A schedule label that is missing and will not be created because a clash label exists. */
  const blocked = (labelId: string): boolean =>
    !snapshot.labels.has(labelId) && clashed.has(labelId);

  const labelOps: LabelOp[] = [];
  for (const [labelId, schedule] of scheduleLabels) {
    const name = scheduleLabelName(schedule.name);
    const current = snapshot.labels.get(labelId);
    if (current === undefined) {
      if (blocked(labelId)) continue;
      labelOps.push({ kind: "createLabel", name: labelId });
      labelOps.push({ kind: "renameLabel", labelId, name });
    } else if (current !== name) {
      labelOps.push({ kind: "renameLabel", labelId, name });
    }
  }

  const wantedSensors = [
    ...new Set(
      [...config.rooms.values()].flatMap((entry) =>
        entry.sensors
          .filter((sensor) => sensor.ref.startsWith(SENSOR_PREFIX))
          .map((sensor) => sensor.ref.slice(SENSOR_PREFIX.length)),
      ),
    ),
  ];
  const withSensors = scope === "all";
  if (withSensors && wantedSensors.length > 0 && !snapshot.labels.has(SENSOR_LABEL)) {
    labelOps.push({ kind: "createLabel", name: SENSOR_LABEL });
  }

  const areaOps: LabelOp[] = [];
  for (const [areaId, area] of snapshot.areas) {
    const wanted = wantedAreaLabel(config, membership, areaId);
    const add =
      wanted !== undefined && !area.labels.includes(wanted) && !blocked(wanted) ? [wanted] : [];
    const remove = area.labels.filter((id) => id !== wanted && owned(id));
    if (add.length > 0 || remove.length > 0) {
      areaOps.push({ kind: "labelArea", areaId, add, remove });
    }
  }

  const entityOps: LabelOp[] = [];
  const unlabellable: string[] = [];
  if (withSensors) {
    const wantedSet = new Set(wantedSensors);
    for (const [entityId, entity] of snapshot.entities) {
      const has = entity.labels.includes(SENSOR_LABEL);
      const wants = wantedSet.has(entityId);
      if (wants && !has) {
        entityOps.push({ kind: "labelEntity", entityId, add: [SENSOR_LABEL], remove: [] });
      } else if (!wants && has) {
        entityOps.push({ kind: "labelEntity", entityId, add: [], remove: [SENSOR_LABEL] });
      }
    }
    unlabellable.push(...wantedSensors.filter((entityId) => !snapshot.entities.has(entityId)));
  }

  const deleteOps: LabelOp[] = [...snapshot.labels.keys()]
    .filter((labelId) => owned(labelId) && !scheduleLabels.has(labelId))
    .map((labelId) => ({ kind: "deleteLabel", labelId }));

  return { ops: [...labelOps, ...areaOps, ...entityOps, ...deleteOps], foreign, unlabellable };
}

/**
 * The schedule label an area should wear (R9): its entry's schedule; else the default's, when the
 * area is a room; else none.
 */
function wantedAreaLabel(
  config: Config,
  membership: AreaMembership,
  areaId: string,
): string | undefined {
  const scheduleId =
    config.rooms.get(areaId)?.scheduleId ??
    (membership.rooms.has(areaId) ? config.defaultScheduleId : undefined);
  if (scheduleId === undefined || !config.schedules.some((s) => s.id === scheduleId)) {
    return undefined;
  }
  return scheduleLabelId(scheduleId);
}

/**
 * The snapshot as it is once the `done` ops have been carried out. `created` maps a created name to
 * the id Home Assistant gave it; a name it lacks is taken as its own id.
 */
export function applyLabelOps(
  snapshot: HaSnapshot,
  done: readonly LabelOp[],
  created: ReadonlyMap<string, string>,
): HaSnapshot {
  const labels = new Map(snapshot.labels);
  const areas = new Map(snapshot.areas);
  const entities = new Map(snapshot.entities);
  for (const op of done) {
    switch (op.kind) {
      case "createLabel":
        labels.set(created.get(op.name) ?? op.name, op.name);
        break;
      case "renameLabel":
        if (labels.has(op.labelId)) labels.set(op.labelId, op.name);
        break;
      case "deleteLabel":
        labels.delete(op.labelId);
        for (const [areaId, area] of areas) {
          if (area.labels.includes(op.labelId)) {
            areas.set(areaId, { ...area, labels: relabel(area.labels, [], [op.labelId]) });
          }
        }
        for (const [entityId, entity] of entities) {
          if (entity.labels.includes(op.labelId)) {
            entities.set(entityId, { ...entity, labels: relabel(entity.labels, [], [op.labelId]) });
          }
        }
        break;
      case "labelArea": {
        const area = areas.get(op.areaId);
        if (area)
          areas.set(op.areaId, { ...area, labels: relabel(area.labels, op.add, op.remove) });
        break;
      }
      case "labelEntity": {
        const entity = entities.get(op.entityId);
        if (entity) {
          entities.set(op.entityId, {
            ...entity,
            labels: relabel(entity.labels, op.add, op.remove),
          });
        }
        break;
      }
    }
  }
  return { ...snapshot, labels, areas, entities };
}

/** `labels` without `remove`, then each of `add` it does not hold yet. */
function relabel(
  labels: readonly string[],
  add: readonly string[],
  remove: readonly string[],
): string[] {
  const result = labels.filter((id) => !remove.includes(id));
  for (const id of add) if (!result.includes(id)) result.push(id);
  return result;
}
