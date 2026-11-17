import type { DroppedRoomReason } from "./ledger.ts";
import { AREA_ID_PATTERN } from "./validation.ts";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notReadable(what: string): never {
  throw new Error(`not a readable version 2 stored config: ${what}`);
}

/** The ids of a v2 room's valves; a `valves` that is not a list is passed on as it is. */
function valveIdsOf(room: Readonly<Record<string, unknown>>): unknown {
  const valves = room.valves;
  if (!Array.isArray(valves)) return valves;
  return (valves as readonly unknown[]).map((valve) => (isRecord(valve) ? valve.id : valve));
}

/** Valve ids in ascending order; anything that is not a list of texts is passed on as it is. */
function ascending(valveIds: unknown): unknown {
  if (!Array.isArray(valveIds)) return valveIds;
  const list = valveIds as readonly unknown[];
  if (!list.every((id) => typeof id === "string")) return list;
  return [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The schedule most rooms use; on a tie the one listed first; with no room the first schedule;
 * with no schedule none.
 */
function defaultScheduleOf(
  schedules: unknown,
  rooms: readonly Readonly<Record<string, unknown>>[],
): string | undefined {
  if (!Array.isArray(schedules)) return undefined;
  const ids = (schedules as readonly unknown[]).flatMap((schedule) =>
    isRecord(schedule) && typeof schedule.id === "string" ? [schedule.id] : [],
  );
  let best: string | undefined;
  let bestCount = -1;
  for (const id of ids) {
    const count = rooms.filter((room) => room.schedule_id === id).length;
    if (count > bestCount) {
      best = id;
      bestCount = count;
    }
  }
  return best;
}

/** Why a v2 room cannot become an entry, or undefined when it can. */
function dropReason(areaId: unknown, taken: ReadonlySet<string>): DroppedRoomReason | undefined {
  if (areaId === undefined) return "no_area";
  if (typeof areaId !== "string" || !AREA_ID_PATTERN.test(areaId)) return "area_id_invalid";
  return taken.has(areaId) ? "area_duplicate" : undefined;
}

/**
 * The data of a version 2 config file as the data of version 3 (rulings R3 and R4): each v2 room
 * with a valid, unused `area_id` becomes the entry and the saved membership room of that area,
 * every other room is listed in the upgrade report; the default schedule is the one most rooms
 * use, and an entry names a schedule only where it differs; writes are held; the sensor import is
 * pending. Throws an Error when `data` is not an object with `revision`, `releasing` and a config
 * of version 2 with a `rooms` list; anything else faulty is left for `storedFromRaw`.
 */
export function upgradeStoredV2(data: unknown): unknown {
  if (!isRecord(data)) return notReadable("expected an object");
  if (data.revision === undefined) return notReadable("missing revision");
  if (data.releasing === undefined) return notReadable("missing releasing");
  const config = data.config;
  if (!isRecord(config) || config.version !== 2) return notReadable("expected a version 2 config");
  if (!Array.isArray(config.rooms)) return notReadable("expected a rooms list");

  const rooms = (config.rooms as readonly unknown[]).map((room) => (isRecord(room) ? room : {}));
  const defaultSchedule = defaultScheduleOf(config.schedules, rooms);
  const entries: Record<string, unknown> = {};
  const membershipRooms: Record<string, unknown> = {};
  const droppedRooms: unknown[] = [];
  const taken = new Set<string>();
  for (const room of rooms) {
    const areaId = room.area_id;
    const reason = dropReason(areaId, taken);
    if (reason !== undefined || typeof areaId !== "string") {
      droppedRooms.push({ room_id: room.id, name: room.name, valves: valveIdsOf(room), reason });
      continue;
    }
    taken.add(areaId);
    const scheduleId = room.schedule_id;
    entries[areaId] = {
      ...(scheduleId === undefined || scheduleId === defaultSchedule
        ? {}
        : { schedule: scheduleId }),
      ...(room.sensors === undefined ? {} : { sensors: room.sensors }),
      ...(room.presets === undefined ? {} : { presets: room.presets }),
    };
    membershipRooms[areaId] = { name: room.name, valves: ascending(valveIdsOf(room)) };
  }

  const rest = Object.fromEntries(
    Object.entries(config).filter(([key]) => key !== "rooms" && key !== "default_schedule"),
  );
  const settings = config.settings === undefined ? {} : config.settings;
  return {
    revision: data.revision,
    releasing: data.releasing,
    config: {
      ...rest,
      version: 3,
      settings: isRecord(settings) ? { ...settings, hold_writes: true } : settings,
      ...(defaultSchedule === undefined ? {} : { default_schedule: defaultSchedule }),
      rooms: entries,
    },
    membership: { rooms: membershipRooms, ignored: [] },
    sensor_import: [],
    ha_changes: [],
    upgrade: { from_version: 2, dropped_rooms: droppedRooms },
  };
}
