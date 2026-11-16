export const IGNORE_LABEL = "heatmaster_ignore";
export const SENSOR_LABEL = "heatmaster_temp_sensor";
export const LEGACY_SENSOR_LABEL = "room_temperature_sensor";
export const SCHEDULE_LABEL_PREFIX = "heatmaster_schedule_";

export type HaArea = Readonly<{ name: string; labels: readonly string[] }>;

/** `areaId` is the entity's own area, else its device's area. */
export type HaEntity = Readonly<{ areaId: string | undefined; labels: readonly string[] }>;

/**
 * What Home Assistant's registries say. `valveAreas` is keyed by valve id: an area id, `null` when
 * Home Assistant has the device without an area, no key when it has no such device. `labels` maps a
 * label id to its name.
 */
export type HaSnapshot = Readonly<{
  areas: ReadonlyMap<string, HaArea>;
  valveAreas: ReadonlyMap<string, string | null>;
  entities: ReadonlyMap<string, HaEntity>;
  labels: ReadonlyMap<string, string>;
}>;

export type AreaRoom = Readonly<{ name: string; valveIds: readonly string[] }>;

/** The saved membership: area to name and valves, and the ignored areas (ascending). */
export type AreaMembership = Readonly<{
  rooms: ReadonlyMap<string, AreaRoom>;
  ignored: readonly string[];
}>;

export type UnplacedReason = "no_area" | "ignored_area" | "not_in_ha";

export type MembershipView = Readonly<{
  membership: AreaMembership;
  unplaced: ReadonlyMap<string, UnplacedReason>;
  notInHa: readonly string[];
}>;

export function scheduleLabelId(scheduleId: string): string {
  return SCHEDULE_LABEL_PREFIX + scheduleId.replaceAll("-", "_");
}

export function scheduleLabelName(scheduleName: string): string {
  return `Heatmaster: ${scheduleName}`;
}

function ascending(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function membershipFrom(
  snapshot: HaSnapshot,
  valveIds: ReadonlySet<string>,
  previous: AreaMembership | undefined,
): MembershipView {
  const ignored = ascending(
    [...snapshot.areas].filter(([, area]) => area.labels.includes(IGNORE_LABEL)).map(([id]) => id),
  );
  const ignoredSet = new Set(ignored);
  const usable = (areaId: string): boolean => snapshot.areas.has(areaId) && !ignoredSet.has(areaId);

  const placed = new Map<string, string[]>();
  const unplaced = new Map<string, UnplacedReason>();
  const notInHa: string[] = [];
  const place = (areaId: string, valveId: string): void => {
    const list = placed.get(areaId);
    if (list) list.push(valveId);
    else placed.set(areaId, [valveId]);
  };

  for (const valveId of ascending(valveIds)) {
    const areaId = snapshot.valveAreas.get(valveId);
    if (areaId === null) {
      unplaced.set(valveId, "no_area");
    } else if (areaId !== undefined && snapshot.areas.has(areaId)) {
      if (ignoredSet.has(areaId)) unplaced.set(valveId, "ignored_area");
      else place(areaId, valveId);
    } else {
      let kept: string | undefined;
      if (previous) {
        for (const [prevArea, room] of previous.rooms) {
          if (room.valveIds.includes(valveId) && usable(prevArea)) {
            kept = prevArea;
            break;
          }
        }
      }
      if (kept === undefined) {
        unplaced.set(valveId, "not_in_ha");
      } else {
        place(kept, valveId);
        notInHa.push(valveId);
      }
    }
  }

  const rooms = new Map<string, AreaRoom>();
  for (const areaId of ascending(placed.keys())) {
    rooms.set(areaId, {
      name: snapshot.areas.get(areaId)?.name ?? areaId,
      valveIds: placed.get(areaId) ?? [],
    });
  }
  return { membership: { rooms, ignored }, unplaced, notInHa };
}

export function sameMembership(
  a: AreaMembership | undefined,
  b: AreaMembership | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.ignored.length !== b.ignored.length || a.ignored.some((id, i) => id !== b.ignored[i])) {
    return false;
  }
  if (a.rooms.size !== b.rooms.size) return false;
  for (const [areaId, room] of a.rooms) {
    const other = b.rooms.get(areaId);
    if (other?.name !== room.name) return false;
    if (
      other.valveIds.length !== room.valveIds.length ||
      room.valveIds.some((id, i) => id !== other.valveIds[i])
    ) {
      return false;
    }
  }
  return true;
}
