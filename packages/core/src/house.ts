import type { ConfigState, StoredConfig } from "./ledger.ts";
import type { Config, Room, RoomPresets } from "./model.ts";

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

/**
 * What the house says about rooms. `live`: Home Assistant's registries are loaded and the link is
 * up; `notInHa` lists the valves kept in a previous room because Home Assistant has no device for
 * them. `frozen`: rooms are frozen on the saved membership (nothing joins or releases), until the
 * registries are loaded or while the link is down. `unlinked`: there is no Home Assistant link, so
 * no room is managed.
 */
export type HouseInput =
  | Readonly<{ kind: "live"; membership: AreaMembership; notInHa: readonly string[] }>
  | Readonly<{
      kind: "frozen";
      membership: AreaMembership | undefined;
      reason: "not_loaded" | "link_down";
    }>
  | Readonly<{ kind: "unlinked" }>;

/** `unused` lists the entry keys, in the config's order, of areas that are no room. */
export type ResolvedRooms = Readonly<{ rooms: readonly Room[]; unused: readonly string[] }>;

/** A room entry that overrides no house preset. */
export const NO_PRESETS: RoomPresets = {
  comfort: undefined,
  eco: undefined,
  frost: undefined,
  boost: undefined,
};

export function scheduleLabelId(scheduleId: string): string {
  return SCHEDULE_LABEL_PREFIX + scheduleId.replaceAll("-", "_");
}

export function scheduleLabelName(scheduleName: string): string {
  return `Heatmaster: ${scheduleName}`;
}

/** The order of ids everywhere (valves, areas, entities): ascending UTF-16 code units. */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The values in ascending code-unit order. */
export function ascending(values: Iterable<string>): string[] {
  return [...values].sort(byCodeUnit);
}

/**
 * Each valve of the rooms with its room id. A valve two rooms list (only a hand-edited saved
 * membership can do that) keeps the first room, in the rooms' order.
 */
export function roomOfValves(rooms: readonly Room[]): ReadonlyMap<string, string> {
  const roomOf = new Map<string, string>();
  for (const room of rooms) {
    for (const ref of room.valves) if (!roomOf.has(ref.valveId)) roomOf.set(ref.valveId, room.id);
  }
  return roomOf;
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

/**
 * One Room per room of the membership, in area-id order: its schedule is the entry's, else the
 * default; its sensors and presets are the entry's, none without one; its override end rule and duration
 * are the entry's, else the house's. No room when the config has
 * no schedule. `unused` lists the entries that are no room (all of them without a membership).
 */
export function resolveRooms(
  config: Config,
  membership: AreaMembership | undefined,
): ResolvedRooms {
  const unused = [...config.rooms.keys()].filter(
    (areaId) => membership?.rooms.has(areaId) !== true,
  );
  if (membership === undefined || config.schedules.length === 0) return { rooms: [], unused };
  const rooms: Room[] = [];
  for (const areaId of ascending(membership.rooms.keys())) {
    const area = membership.rooms.get(areaId);
    const entry = config.rooms.get(areaId);
    const scheduleId = entry?.scheduleId ?? config.defaultScheduleId;
    // Validation requires a default schedule whenever there is a schedule.
    if (area === undefined || scheduleId === undefined) continue;
    rooms.push({
      id: areaId,
      name: area.name,
      scheduleId,
      valves: area.valveIds.map((valveId) => ({ valveId })),
      sensors: entry?.sensors ?? [],
      presets: entry?.presets ?? NO_PRESETS,
      overrideEnd: entry?.overrideEnd ?? config.settings.overrideEnd,
      overrideDurationMs: entry?.overrideDurationMs ?? config.settings.overrideDurationMs,
    });
  }
  return { rooms, unused };
}

/**
 * The rooms control acts on. Undefined when the house is unlinked: no room is managed. Empty
 * unless the config is readable. Otherwise the rooms of the live or the frozen membership.
 */
export function roomsOf(
  state: ConfigState,
  stored: StoredConfig | undefined,
  house: HouseInput,
): readonly Room[] | undefined {
  if (house.kind === "unlinked") return undefined;
  if (state !== "ok" || stored === undefined) return [];
  return resolveRooms(stored.config, house.membership).rooms;
}
