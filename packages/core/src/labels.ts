import type { ContactInfo, SensorInfo } from "./change.ts";
import {
  LEGACY_SENSOR_LABEL,
  NO_PRESETS,
  NO_WINDOW_PATCH,
  SCHEDULE_LABEL_PREFIX,
  SENSOR_LABEL,
  WINDOW_SENSOR_LABEL,
  ascending,
  scheduleLabelId,
  scheduleLabelName,
  type AreaMembership,
  type HaEntity,
  type HaSnapshot,
} from "./house.ts";
import {
  HA_CHANGES_KEPT,
  type HaChangeItem,
  type HaChangeKind,
  type StoredConfig,
} from "./ledger.ts";
import type { Config, RoomEntry } from "./model.ts";
import {
  problemContactLabelUnused,
  problemEntryUnavailable,
  problemLabelForeign,
  problemLegacyLabelPresent,
  problemSensorLabelUnused,
  type Problem,
} from "./status.ts";
import { AREA_ID_PATTERN, MAX_CONTACTS, MAX_ROOMS, MAX_SENSORS } from "./validation.ts";

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
 * The label writes that make Home Assistant match the config, in order. `foreign` lists the
 * numbered labels (`heatmaster_schedule_<x>_<digits>`, as from a clash), which no op names;
 * `unlabellable` lists the configured sensor and contact entities Home Assistant has no registry entry for.
 */
export type LabelPlan = Readonly<{
  ops: readonly LabelOp[];
  foreign: readonly string[];
  unlabellable: readonly string[];
}>;

const SENSOR_PREFIX = "ha:";
/** A schedule-prefixed label id ending in `_<digits>`: Home Assistant's numbering of a taken id. */
const NUMBERED = new RegExp(`^(${SCHEDULE_LABEL_PREFIX}.+)_[0-9]+$`);

/**
 * The label a numbered label (`heatmaster_schedule_<x>_<digits>`) was numbered after, or undefined
 * when the label is not numbered. Numbered labels are always foreign: no op ever names one.
 */
function numberedBase(labelId: string): string | undefined {
  return NUMBERED.exec(labelId)?.[1];
}

/** Heatmaster owns a label whose id starts with `heatmaster_schedule_` and is not numbered. */
function isOwned(labelId: string): boolean {
  return labelId.startsWith(SCHEDULE_LABEL_PREFIX) && numberedBase(labelId) === undefined;
}

/**
 * Plans the label writes that mirror the config onto Home Assistant: schedule labels created,
 * renamed and deleted, each area wearing its schedule's label, `heatmaster_temp_sensor` on exactly
 * the configured sensor entities and `heatmaster_window_sensor` on exactly the configured contact
 * entities. Scope `schedules` leaves out both. With no
 * schedule in the config nothing is managed, labels included: no op is planned (and nothing is
 * unlabellable), so a fresh install never removes labels the user's automations rely on.
 */
export function mirrorLabels(
  config: Config,
  membership: AreaMembership,
  snapshot: HaSnapshot,
  scope: "all" | "schedules" = "all",
): LabelPlan {
  const scheduleLabels = new Map(config.schedules.map((s) => [scheduleLabelId(s.id), s]));

  const foreign: string[] = [];
  const clashed = new Set<string>();
  for (const id of snapshot.labels.keys()) {
    const base = numberedBase(id);
    if (base === undefined) continue;
    foreign.push(id);
    clashed.add(base);
  }
  if (config.schedules.length === 0) return { ops: [], foreign, unlabellable: [] };
  /**
   * A schedule label Heatmaster will not write: a numbered one (validation refuses the schedule
   * ids that give one), or a missing one that a numbered label was numbered after.
   */
  const blocked = (labelId: string): boolean =>
    !isOwned(labelId) || (!snapshot.labels.has(labelId) && clashed.has(labelId));

  const labelOps: LabelOp[] = [];
  for (const [labelId, schedule] of scheduleLabels) {
    const name = scheduleLabelName(schedule.name);
    const current = snapshot.labels.get(labelId);
    if (blocked(labelId)) continue;
    if (current === undefined) {
      labelOps.push({ kind: "createLabel", name: labelId });
      labelOps.push({ kind: "renameLabel", labelId, name });
    } else if (current !== name) {
      labelOps.push({ kind: "renameLabel", labelId, name });
    }
  }

  const wantedSensors = listedEntities(config.rooms, (entry) =>
    entry.sensors.map((sensor) => sensor.ref),
  );
  const wantedContacts = listedEntities(config.rooms, (entry) =>
    entry.contacts.map((contact) => contact.ref),
  );
  const withSensors = scope === "all";
  if (withSensors && wantedSensors.length > 0 && !snapshot.labels.has(SENSOR_LABEL)) {
    labelOps.push({ kind: "createLabel", name: SENSOR_LABEL });
  }
  if (withSensors && wantedContacts.length > 0 && !snapshot.labels.has(WINDOW_SENSOR_LABEL)) {
    labelOps.push({ kind: "createLabel", name: WINDOW_SENSOR_LABEL });
  }

  const areaOps: LabelOp[] = [];
  for (const [areaId, area] of snapshot.areas) {
    const wanted = wantedAreaLabel(config, membership, areaId);
    const add =
      wanted !== undefined && !area.labels.includes(wanted) && !blocked(wanted) ? [wanted] : [];
    const remove = area.labels.filter((id) => id !== wanted && isOwned(id));
    if (add.length > 0 || remove.length > 0) {
      areaOps.push({ kind: "labelArea", areaId, add, remove });
    }
  }

  const entityOps: LabelOp[] = [];
  const unlabellable: string[] = [];
  if (withSensors) {
    for (const [label, wantedList] of [
      [SENSOR_LABEL, wantedSensors],
      [WINDOW_SENSOR_LABEL, wantedContacts],
    ] as const) {
      const wantedSet = new Set(wantedList);
      for (const [entityId, entity] of snapshot.entities) {
        const has = entity.labels.includes(label);
        const wants = wantedSet.has(entityId);
        if (wants && !has) {
          entityOps.push({ kind: "labelEntity", entityId, add: [label], remove: [] });
        } else if (!wants && has) {
          entityOps.push({ kind: "labelEntity", entityId, add: [], remove: [label] });
        }
      }
    }
    unlabellable.push(
      ...[...wantedSensors, ...wantedContacts].filter(
        (entityId) => !snapshot.entities.has(entityId),
      ),
    );
  }

  const deleteOps: LabelOp[] = [...snapshot.labels.keys()]
    .filter((labelId) => isOwned(labelId) && !scheduleLabels.has(labelId))
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

/** A config revision taken from label edits made in Home Assistant, and what it changed. */
export type HaEdit = Readonly<{ config: Config; items: readonly HaChangeItem[] }>;

/** Why an entity carrying `heatmaster_temp_sensor` cannot be added to a room's entry. */
type UnusedReason =
  | "no_area"
  | "area_not_room"
  | "entry_unavailable"
  | "sensor_unknown"
  | "sensor_not_temperature"
  | "sensor_on_valve"
  | "sensor_limit";

/** Why an entity carrying `heatmaster_window_sensor` cannot be added to a room's entry. */
type ContactUnusedReason =
  | "no_area"
  | "area_not_room"
  | "entry_unavailable"
  | "contact_unknown"
  | "contact_not_binary"
  | "contact_limit";

/** An entry that sets nothing: the default schedule, no sensor, the house presets and rules. */
export const EMPTY_ENTRY: RoomEntry = {
  scheduleId: undefined,
  sensors: [],
  presets: NO_PRESETS,
  overrideEnd: undefined,
  overrideDurationMs: undefined,
  contacts: [],
  window: NO_WINDOW_PATCH,
};

/** The schedule id each existing schedule's own label stands for, by label id. */
function labelSchedules(config: Config): ReadonlyMap<string, string> {
  return new Map(
    config.schedules
      .map((s) => [scheduleLabelId(s.id), s.id] as const)
      .filter(([labelId]) => isOwned(labelId)),
  );
}

/**
 * Whether the entries may hold one for the area: they have one, or a new one would still pass
 * validation (a valid area id, at most `MAX_ROOMS` entries). A label edit that needs an entry the
 * config cannot hold changes nothing, so the saved config always stays readable.
 */
export function mayHoldEntry(rooms: ReadonlyMap<string, RoomEntry>, areaId: string): boolean {
  return rooms.has(areaId) || (AREA_ID_PATTERN.test(areaId) && rooms.size < MAX_ROOMS);
}

/** The sensor check the entity fails, or undefined when it exists, is a temperature, is no valve's. */
function failedSensorCheck(info: SensorInfo | undefined): UnusedReason | undefined {
  if (info?.exists !== true) return "sensor_unknown";
  if (!info.isTemperature) return "sensor_not_temperature";
  if (info.onValve) return "sensor_on_valve";
  return undefined;
}

/** Why the entity's place leaves no room entry for it (the checks sensors and contacts share). */
function placementReason(
  entity: HaEntity,
  rooms: ReadonlyMap<string, RoomEntry>,
  membership: AreaMembership,
): "no_area" | "area_not_room" | "entry_unavailable" | undefined {
  const areaId = entity.areaId;
  if (areaId === undefined) return "no_area";
  if (!membership.rooms.has(areaId)) return "area_not_room";
  if (!mayHoldEntry(rooms, areaId)) return "entry_unavailable";
  return undefined;
}

/** Why the entity cannot join its room's entry, or undefined when it can. */
function unusedReason(
  entityId: string,
  entity: HaEntity,
  rooms: ReadonlyMap<string, RoomEntry>,
  membership: AreaMembership,
  infos: ReadonlyMap<string, SensorInfo>,
): UnusedReason | undefined {
  const placed = placementReason(entity, rooms, membership);
  if (placed !== undefined) return placed;
  const failed = failedSensorCheck(infos.get(entityId));
  if (failed !== undefined) return failed;
  if ((rooms.get(entity.areaId ?? "")?.sensors.length ?? 0) >= MAX_SENSORS) return "sensor_limit";
  return undefined;
}

/** Why the entity cannot join its room's entry as a contact, or undefined when it can. */
function contactUnusedReason(
  entityId: string,
  entity: HaEntity,
  rooms: ReadonlyMap<string, RoomEntry>,
  membership: AreaMembership,
  infos: ReadonlyMap<string, ContactInfo>,
): ContactUnusedReason | undefined {
  const placed = placementReason(entity, rooms, membership);
  if (placed !== undefined) return placed;
  const info = infos.get(entityId);
  if (info?.exists !== true) return "contact_unknown";
  if (!info.isBinary) return "contact_not_binary";
  if ((rooms.get(entity.areaId ?? "")?.contacts.length ?? 0) >= MAX_CONTACTS) {
    return "contact_limit";
  }
  return undefined;
}

/**
 * What differs between the two entity labels: the entry's list of refs and how to add to and
 * remove from it, the reason an entity cannot join, the HA change kinds and the problem.
 */
type EntityLabel = Readonly<{
  label: string;
  refs(entry: RoomEntry): readonly string[];
  with(entry: RoomEntry, refs: readonly string[]): RoomEntry;
  reason(entityId: string, entity: HaEntity): string | undefined;
  added: HaChangeKind;
  removed: HaChangeKind;
  problem(entityId: string, reason: string): Problem;
}>;

/** The entity ids of every `ha:` ref the entries list through `refsOf`, without repeats. */
function listedEntities(
  rooms: ReadonlyMap<string, RoomEntry>,
  refsOf: (entry: RoomEntry) => readonly string[],
): string[] {
  return [
    ...new Set(
      [...rooms.values()].flatMap((entry) =>
        refsOf(entry)
          .filter((ref) => ref.startsWith(SENSOR_PREFIX))
          .map((ref) => ref.slice(SENSOR_PREFIX.length)),
      ),
    ),
  ];
}

function entityLabels(
  rooms: ReadonlyMap<string, RoomEntry>,
  membership: AreaMembership,
  infos: ReadonlyMap<string, SensorInfo>,
  contactInfos: ReadonlyMap<string, ContactInfo>,
): readonly EntityLabel[] {
  return [
    {
      label: SENSOR_LABEL,
      refs: (entry) => entry.sensors.map((sensor) => sensor.ref),
      with: (entry, refs) => ({
        ...entry,
        sensors: refs.map(
          (ref) => entry.sensors.find((sensor) => sensor.ref === ref) ?? { ref, weight: 1 },
        ),
      }),
      reason: (entityId, entity) => unusedReason(entityId, entity, rooms, membership, infos),
      added: "sensor_added",
      removed: "sensor_removed",
      problem: problemSensorLabelUnused,
    },
    {
      label: WINDOW_SENSOR_LABEL,
      refs: (entry) => entry.contacts.map((contact) => contact.ref),
      with: (entry, refs) => ({ ...entry, contacts: refs.map((ref) => ({ ref })) }),
      reason: (entityId, entity) =>
        contactUnusedReason(entityId, entity, rooms, membership, contactInfos),
      added: "contact_added",
      removed: "contact_removed",
      problem: problemContactLabelUnused,
    },
  ];
}

/**
 * The config revision the user's label edits in Home Assistant make, from `before` to `after`
 * (see the task's pseudocode): a schedule label added to or removed from an area sets the area's
 * entry's schedule (R9, R10); `heatmaster_temp_sensor` added to an entity in a room adds it to the
 * room's entry with weight 1, removed drops it from every entry; `heatmaster_window_sensor` does the
 * same for a room's contacts. Undefined when nothing changes. `infos` and `contactInfos` are keyed
 * by entity id.
 */
export function labelEdits(
  before: HaSnapshot,
  after: HaSnapshot,
  config: Config,
  membership: AreaMembership,
  infos: ReadonlyMap<string, SensorInfo>,
  contactInfos: ReadonlyMap<string, ContactInfo>,
): HaEdit | undefined {
  const rooms = new Map(config.rooms);
  const items: HaChangeItem[] = [];
  const schedules = labelSchedules(config);
  const scheduleLabelsOf = (snapshot: HaSnapshot, areaId: string): ReadonlySet<string> =>
    new Set(snapshot.areas.get(areaId)?.labels.filter((id) => schedules.has(id)) ?? []);

  for (const areaId of ascending(after.areas.keys())) {
    const was = scheduleLabelsOf(before, areaId);
    const now = scheduleLabelsOf(after, areaId);
    const added = ascending([...now].filter((id) => !was.has(id)));
    const isRoom = membership.rooms.has(areaId);
    const entry = rooms.get(areaId);
    const current = entry?.scheduleId ?? (isRoom ? config.defaultScheduleId : undefined);
    const currentLabel = current === undefined ? undefined : scheduleLabelId(current);
    let winner: string | undefined;
    if (added.length > 0) {
      winner = currentLabel !== undefined && added.includes(currentLabel) ? currentLabel : added[0];
    } else if (currentLabel !== undefined && was.has(currentLabel) && !now.has(currentLabel)) {
      winner = ascending(now)[0];
    } else {
      continue;
    }
    const scheduleId = winner === undefined ? undefined : schedules.get(winner);
    const wanted =
      scheduleId === undefined || (isRoom && scheduleId === config.defaultScheduleId)
        ? undefined
        : scheduleId;
    if (wanted === entry?.scheduleId || !mayHoldEntry(rooms, areaId)) continue;
    rooms.set(areaId, { ...(entry ?? EMPTY_ENTRY), scheduleId: wanted });
    items.push({
      kind: "schedule",
      areaId,
      entityId: undefined,
      scheduleId: scheduleId ?? config.defaultScheduleId,
      rule: undefined,
      setting: undefined,
      value: undefined,
    });
  }

  // An entity deleted from the registry is left alone: sensor_unknown reports it.
  for (const kind of entityLabels(rooms, membership, infos, contactInfos)) {
    for (const entityId of ascending(after.entities.keys())) {
      const was = before.entities.get(entityId);
      const entity = after.entities.get(entityId);
      if (was === undefined || entity === undefined) continue;
      const has = entity.labels.includes(kind.label);
      if (was.labels.includes(kind.label) === has) continue;
      const ref = SENSOR_PREFIX + entityId;
      const item = (areaId: string, itemKind: HaChangeKind): HaChangeItem => ({
        kind: itemKind,
        areaId,
        entityId,
        scheduleId: undefined,
        rule: undefined,
        setting: undefined,
        value: undefined,
      });
      if (has) {
        // The mirror puts this label on every listed entity, so on one any entry lists it says
        // nothing new (an own write's echo, or a repair): it stays where it is.
        if ([...rooms.values()].some((e) => kind.refs(e).includes(ref))) continue;
        const areaId = entity.areaId;
        // The reason checks this first too; repeated here only so areaId is narrowed below.
        if (areaId === undefined) continue;
        // With a reason nothing changes; labelProblems reports it while the label stays.
        if (kind.reason(entityId, entity) !== undefined) continue;
        const entry = rooms.get(areaId) ?? EMPTY_ENTRY;
        rooms.set(areaId, kind.with(entry, [...kind.refs(entry), ref]));
        items.push(item(areaId, kind.added));
      } else {
        for (const [areaId, entry] of [...rooms]) {
          if (!kind.refs(entry).includes(ref)) continue;
          rooms.set(
            areaId,
            kind.with(
              entry,
              kind.refs(entry).filter((listed) => listed !== ref),
            ),
          );
          items.push(item(areaId, kind.removed));
        }
      }
    }
  }

  return items.length === 0 ? undefined : { config: { ...config, rooms }, items };
}

/**
 * The stored config with the edit's config, the revision one higher and one HA change for it,
 * keeping the newest `HA_CHANGES_KEPT`; everything else unchanged.
 */
export function withHaEdit(stored: StoredConfig, edit: HaEdit, nowMs: number): StoredConfig {
  const revision = stored.revision + 1;
  const haChanges = [...stored.haChanges, { revision, at: nowMs, items: edit.items }].slice(
    -HA_CHANGES_KEPT,
  );
  return { ...stored, config: edit.config, revision, haChanges };
}

/** True when a room of the membership has not had its sensor import yet. */
export function importDue(stored: StoredConfig, membership: AreaMembership): boolean {
  const imported = new Set(stored.importedAreas);
  return [...membership.rooms.keys()].some((areaId) => !imported.has(areaId));
}

/**
 * The import of `room_temperature_sensor`, once per room: each room of the membership not yet in
 * `importedAreas` joins it, and if its entry has no sensor it gets the entities in its area that
 * carry the label and pass the sensor checks, weight 1, in entity-id order, at most
 * `MAX_SENSORS`. When anything was imported the revision rises by one with one HA change. The
 * given value itself when no room is due. `infos` is keyed by entity id.
 */
export function importSensors(
  stored: StoredConfig,
  membership: AreaMembership,
  snapshot: HaSnapshot,
  infos: ReadonlyMap<string, SensorInfo>,
  nowMs: number,
): StoredConfig {
  if (!importDue(stored, membership)) return stored;
  const imported = new Set(stored.importedAreas);
  const rooms = new Map(stored.config.rooms);
  const items: HaChangeItem[] = [];
  for (const areaId of ascending(membership.rooms.keys())) {
    if (imported.has(areaId)) continue;
    imported.add(areaId);
    const entry = rooms.get(areaId);
    if ((entry?.sensors.length ?? 0) > 0 || !mayHoldEntry(rooms, areaId)) continue;
    const found = ascending(
      [...snapshot.entities]
        .filter(
          ([entityId, entity]) =>
            entity.areaId === areaId &&
            entity.labels.includes(LEGACY_SENSOR_LABEL) &&
            failedSensorCheck(infos.get(entityId)) === undefined,
        )
        .map(([entityId]) => entityId),
    ).slice(0, MAX_SENSORS);
    if (found.length === 0) continue;
    const sensors = found.map((entityId) => ({ ref: SENSOR_PREFIX + entityId, weight: 1 }));
    rooms.set(areaId, { ...(entry ?? EMPTY_ENTRY), sensors });
    items.push({
      kind: "sensors_imported",
      areaId,
      entityId: undefined,
      scheduleId: undefined,
      rule: undefined,
      setting: undefined,
      value: undefined,
    });
  }
  const done: StoredConfig = { ...stored, importedAreas: ascending(imported) };
  if (items.length === 0) return done;
  return withHaEdit(done, { config: { ...stored.config, rooms }, items }, nowMs);
}

/**
 * The label problems Home Assistant shows: `sensor_label_unused` for each entity carrying
 * `heatmaster_temp_sensor` that no entry lists and that cannot join its room (one that can is
 * waiting for the next pull); `legacy_label_present` for each room whose entry has a sensor while
 * entities in its area still carry `room_temperature_sensor`; `entry_unavailable` for each area,
 * in area-id order, that cannot hold an entry while it wears a label one would take in;
 * `label_foreign` for each numbered label, in registry order; `contact_label_unused` the same for
 * `heatmaster_window_sensor`. `infos` and `contactInfos` are keyed by entity id.
 */
export function labelProblems(
  config: Config,
  membership: AreaMembership,
  snapshot: HaSnapshot,
  infos: ReadonlyMap<string, SensorInfo>,
  contactInfos: ReadonlyMap<string, ContactInfo>,
): readonly Problem[] {
  const problems: Problem[] = [];
  for (const kind of entityLabels(config.rooms, membership, infos, contactInfos)) {
    const listed = new Set([...config.rooms.values()].flatMap((entry) => kind.refs(entry)));
    for (const entityId of ascending(snapshot.entities.keys())) {
      const entity = snapshot.entities.get(entityId);
      if (entity?.labels.includes(kind.label) !== true) continue;
      if (listed.has(SENSOR_PREFIX + entityId)) continue;
      const reason = kind.reason(entityId, entity);
      if (reason !== undefined) problems.push(kind.problem(entityId, reason));
    }
  }
  for (const areaId of ascending(membership.rooms.keys())) {
    if ((config.rooms.get(areaId)?.sensors.length ?? 0) === 0) continue;
    const legacy = ascending(
      [...snapshot.entities]
        .filter(
          ([, entity]) => entity.areaId === areaId && entity.labels.includes(LEGACY_SENSOR_LABEL),
        )
        .map(([entityId]) => entityId),
    );
    if (legacy.length > 0) problems.push(problemLegacyLabelPresent(areaId, legacy));
  }
  const schedules = labelSchedules(config);
  for (const areaId of ascending(snapshot.areas.keys())) {
    const area = snapshot.areas.get(areaId);
    if (area === undefined || mayHoldEntry(config.rooms, areaId)) continue;
    const isRoom = membership.rooms.has(areaId);
    const follows = isRoom ? config.defaultScheduleId : undefined;
    const labels = area.labels.filter((id) => schedules.has(id) && schedules.get(id) !== follows);
    const legacy = [...snapshot.entities.values()].some(
      (entity) => entity.areaId === areaId && entity.labels.includes(LEGACY_SENSOR_LABEL),
    );
    if (isRoom && legacy) labels.push(LEGACY_SENSOR_LABEL);
    if (labels.length > 0) problems.push(problemEntryUnavailable(areaId, labels));
  }
  for (const labelId of snapshot.labels.keys()) {
    if (numberedBase(labelId) !== undefined) problems.push(problemLabelForeign(labelId));
  }
  return problems;
}
