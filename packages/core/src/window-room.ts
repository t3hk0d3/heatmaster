import { sensorId } from "./model.ts";
import type { Room, WindowSettings } from "./model.ts";
import { problemContactUnavailable, problemWindowOpenTooLong } from "./status.ts";
import type { Problem, WindowNote, WindowStatus } from "./status.ts";
import type { Thermostat } from "./thermostat.ts";
import { THERMOSTAT_SETTLE_MS } from "./thermostat-rules.ts";
import { contactVerdict, dropDetected, stillFor } from "./window.ts";
import type {
  ContactReading,
  ContactVerdict,
  Trails,
  WindowInput,
  WindowOpening,
} from "./window.ts";

/*
 * The tick's view of one room's window (plan 3b): what the window step reads, the room's status
 * and problems, and the pruning of saved openings. The rules themselves live in `window.ts`.
 */

/** What a room's window step reads before judging: all but the person change and the thermostat. */
export type WindowSense = Omit<WindowInput, "personChange" | "thermostatOff">;

/** The verdict of a room that lists contacts while the house is frozen: nothing is known (W13). */
const FROZEN_VERDICT: ContactVerdict = {
  state: "settling",
  openSince: undefined,
  open: [],
  unavailable: [],
};

/**
 * Heatmaster watches the room's windows (W15): window handling is on, and the room lists a contact
 * or detects drops (`temperature.enabled`) with at least one sensor.
 */
export function windowWatched(room: Room): boolean {
  const { window } = room;
  if (!window.enabled) return false;
  return room.contacts.length > 0 || (window.temperature.enabled && room.sensors.length > 0);
}

/** How long the drop trails are kept: the longest `within` and `still` of the rooms; 0 with none. */
export function trailKeepMs(rooms: readonly Room[]): number {
  return Math.max(
    0,
    ...rooms.map((room) =>
      Math.max(room.window.temperature.withinMs, room.window.temperature.stillMs),
    ),
  );
}

/**
 * What the room's window step reads this tick. `opening` is the saved one.
 * - `contacts`: undefined when the room lists none; while the house is frozen, a verdict that
 *   knows nothing, so the contacts neither start nor end an opening (W13).
 * - `drop`: judged only while the house is live, `temperature.enabled` is on and the room has no
 *   active opening; points before the opening's end (else its temperature end) are not used.
 * - `stillMs`: since the opening's temperature start, else its start (0 with no opening).
 */
export function windowSense(
  room: Room,
  opening: WindowOpening | undefined,
  contacts: ReadonlyMap<string, ContactReading>,
  trails: Trails,
  frozen: boolean,
  nowMs: number,
): WindowSense {
  const settings = room.window;
  const verdict =
    room.contacts.length === 0
      ? undefined
      : frozen
        ? FROZEN_VERDICT
        : contactVerdict(room.contacts, contacts, settings, nowMs);
  const sensors = room.sensors.map(sensorId);
  const active = opening !== undefined && opening.endedAt === undefined;
  const notBefore = opening?.endedAt ?? opening?.temperatureEndedAt;
  const drop =
    !frozen &&
    !active &&
    settings.temperature.enabled &&
    dropDetected(sensors, trails, settings.temperature, notBefore, nowMs);
  const since = opening === undefined ? 0 : (opening.temperatureSince ?? opening.startedAt);
  return {
    settings,
    contacts: verdict,
    drop,
    stillMs: stillFor(sensors, trails, since, nowMs),
    frozen,
  };
}

/** A valve change was dropped under `ignore` less than `THERMOSTAT_SETTLE_MS` ago (W6). */
export function windowDropSettles(opening: WindowOpening | undefined, nowMs: number): boolean {
  if (opening?.droppedAt === undefined) return false;
  const age = nowMs - opening.droppedAt;
  return age >= 0 && age < THERMOSTAT_SETTLE_MS;
}

/**
 * The notes on an opening that holds the valves: `knob_does_nothing` under `action: off`;
 * `command_waits` under `ignore` while the thermostat is an override a room command made since
 * the opening started (W6 leaves no other trace of the command).
 */
function windowNotes(
  opening: WindowOpening,
  holdsValves: boolean,
  settings: WindowSettings,
  thermostat: Thermostat | undefined,
): readonly WindowNote[] {
  if (!holdsValves) return [];
  const notes: WindowNote[] = [];
  if (settings.action === "off") notes.push("knob_does_nothing");
  if (
    settings.manualChange === "ignore" &&
    thermostat?.kind === "override" &&
    thermostat.origin.source !== "valve" &&
    thermostat.since >= opening.startedAt
  ) {
    notes.push("command_waits");
  }
  return notes;
}

/** The status of the room's active opening; undefined when it has none. */
export function windowStatus(
  opening: WindowOpening | undefined,
  contacts: ContactVerdict | undefined,
  holdsValves: boolean,
  settings: WindowSettings,
  thermostat: Thermostat | undefined,
  nowMs: number,
): WindowStatus | undefined {
  if (opening === undefined || opening.endedAt !== undefined) return undefined;
  const state = windowDropSettles(opening, nowMs)
    ? "dropped"
    : opening.limitAt !== undefined
      ? "limit_reached"
      : opening.suspendedAt !== undefined
        ? "suspended"
        : "open";
  const triggers: ("contact" | "temperature")[] = [];
  if (contacts !== undefined && contacts.state !== "closed") triggers.push("contact");
  if (opening.temperatureSince !== undefined) triggers.push("temperature");
  return {
    state,
    triggers,
    openContacts: contacts?.open ?? [],
    since: opening.startedAt,
    holdsValves,
    notes: windowNotes(opening, holdsValves, settings, thermostat),
  };
}

/**
 * `contact_unavailable` for each contact counted closed for being unavailable too long, and
 * `window_open_too_long` while the opening is past its limit and has not ended, unless the room
 * is off (nothing heats). None while the room's window handling is off.
 */
export function windowProblems(
  roomId: string,
  settings: WindowSettings,
  contacts: ContactVerdict | undefined,
  opening: WindowOpening | undefined,
  thermostatOff: boolean,
): readonly Problem[] {
  if (!settings.enabled) return [];
  const problems = (contacts?.unavailable ?? []).map(problemContactUnavailable);
  if (opening?.limitAt !== undefined && opening.endedAt === undefined && !thermostatOff) {
    problems.push(problemWindowOpenTooLong(roomId));
  }
  return problems;
}

/**
 * The openings of the rooms in `roomIds` (W14), the same map when none is dropped. `dismissed`
 * lists the rooms whose dropped opening was active past its limit, in the map's order.
 */
export function pruneOpenings(
  windows: ReadonlyMap<string, WindowOpening>,
  roomIds: ReadonlySet<string>,
): Readonly<{ windows: ReadonlyMap<string, WindowOpening>; dismissed: readonly string[] }> {
  const kept = new Map(windows);
  const dismissed: string[] = [];
  for (const [roomId, opening] of windows) {
    if (roomIds.has(roomId)) continue;
    kept.delete(roomId);
    if (opening.limitAt !== undefined && opening.endedAt === undefined) dismissed.push(roomId);
  }
  return { windows: kept.size === windows.size ? windows : kept, dismissed };
}
