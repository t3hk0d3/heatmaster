import { contactId } from "./model.ts";
import type { ContactRef, TemperatureDetection, WindowSettings } from "./model.ts";
import type { SensorReading } from "./temperature.ts";

/**
 * A contact as Home Assistant shows it (W4). `open` undefined: unavailable or unknown since
 * `changedAt`. `lastOpen` and `lastAt`: the last known open or closed state and its instant.
 */
export type ContactReading = Readonly<{
  open: boolean | undefined;
  changedAt: number | undefined;
  lastOpen: boolean | undefined;
  lastAt: number | undefined;
}>;

/**
 * A room's contacts after debounce. `open` lists the contacts counted open, in the room's order,
 * and `openSince` is the earliest instant one of them opened. `unavailable` lists the contacts
 * counted closed because they have been unavailable too long.
 */
export type ContactVerdict = Readonly<{
  state: "open" | "closed" | "settling";
  openSince: number | undefined;
  open: readonly string[];
  unavailable: readonly string[];
}>;

/** A sensor's value and the instant it was seen. */
export type TrailPoint = Readonly<{ value: number; at: number }>;

/** Short trails of sensor values, oldest first, by sensor id (W5). */
export type Trails = ReadonlyMap<string, readonly TrailPoint[]>;

/**
 * A room's open window, saved in `state.json`. Active while `endedAt` is undefined.
 * `temperatureSince` is set while a drop holds it; `temperatureEndedAt` is when that last ended.
 */
export type WindowOpening = Readonly<{
  startedAt: number;
  temperatureSince: number | undefined;
  temperatureEndedAt: number | undefined;
  suspendedAt: number | undefined;
  limitAt: number | undefined;
  droppedAt: number | undefined;
  endedAt: number | undefined;
}>;

/**
 * What a room's window step looks at. `contacts` undefined: the room lists none. `stillMs` is
 * `stillFor`'s answer. `personChange`: an adopted valve change this tick (W6).
 */
export type WindowInput = Readonly<{
  settings: WindowSettings;
  contacts: ContactVerdict | undefined;
  drop: boolean;
  stillMs: number;
  frozen: boolean;
  personChange: boolean;
  thermostatOff: boolean;
}>;

/**
 * The opening after the step; whether it holds the room and its valves; whether it reached its
 * limit in this step; whether a notification of its limit should go.
 */
export type WindowStep = Readonly<{
  opening: WindowOpening | undefined;
  holds: boolean;
  holdsValves: boolean;
  limitReached: boolean;
  dismissed: boolean;
}>;

/** A value this far below a threshold counts as reaching it (see the styleguide, Rounding). */
const TOLERANCE_C = 0.000000001;

const NEVER_SEEN: ContactReading = {
  open: undefined,
  changedAt: undefined,
  lastOpen: undefined,
  lastAt: undefined,
};

/** One contact's debounced state: whether it counts open or closed, and since when. */
function judgeContact(
  reading: ContactReading,
  settings: WindowSettings,
  nowMs: number,
): Readonly<{
  countsOpen: boolean;
  countsClosed: boolean;
  since: number | undefined;
  gone: boolean;
}> {
  let open: boolean;
  let since: number | undefined;
  let gone = false;
  if (reading.open !== undefined) {
    open = reading.open;
    since = reading.changedAt;
  } else if (
    reading.changedAt !== undefined &&
    nowMs - reading.changedAt < settings.contactUnavailableMs
  ) {
    open = reading.lastOpen ?? false;
    since = reading.lastAt;
  } else {
    // Unavailable too long, or never seen: closed, from when it ran out (never seen: always).
    open = false;
    since =
      reading.changedAt === undefined
        ? undefined
        : reading.changedAt + settings.contactUnavailableMs;
    gone = reading.changedAt !== undefined;
  }
  const countsOpen = open && since !== undefined && nowMs - since >= settings.openDebounceMs;
  const countsClosed = !open && (since === undefined || nowMs - since >= settings.closeDebounceMs);
  return { countsOpen, countsClosed, since, gone };
}

/**
 * The room's contacts after debounce: `open` when any counts open, `closed` when every one counts
 * closed (or none is listed), else `settling`. A contact with no reading counts closed.
 */
export function contactVerdict(
  contacts: readonly ContactRef[],
  readings: ReadonlyMap<string, ContactReading>,
  settings: WindowSettings,
  nowMs: number,
): ContactVerdict {
  const open: string[] = [];
  const unavailable: string[] = [];
  let openSince: number | undefined;
  let allClosed = true;
  for (const contact of contacts) {
    const id = contactId(contact);
    const judged = judgeContact(readings.get(id) ?? NEVER_SEEN, settings, nowMs);
    if (judged.gone) unavailable.push(id);
    if (judged.countsOpen && judged.since !== undefined) {
      open.push(id);
      openSince = openSince === undefined ? judged.since : Math.min(openSince, judged.since);
    }
    if (!judged.countsClosed) allClosed = false;
  }
  const state = open.length > 0 ? "open" : allClosed ? "closed" : "settling";
  return { state, openSince, open, unavailable };
}

/** The points newer than `nowMs − keepMs`, and the newest older one: the value in force then. */
function pruned(points: readonly TrailPoint[], keepMs: number, nowMs: number): TrailPoint[] {
  const cutoff = nowMs - keepMs;
  const older = points.filter((point) => point.at <= cutoff);
  const inForce = older.at(-1);
  const newer = points.filter((point) => point.at > cutoff);
  return inForce === undefined ? newer : [inForce, ...newer];
}

/**
 * The trails after this tick's readings (W5). A used sensor's value is appended when it differs
 * from its last point, at its `seenAt` (else `nowMs`). A sensor whose reading is not used loses
 * its trail. `keepMs` is the longest `within` of any room.
 */
export function noteTrails(
  trails: Trails,
  readings: ReadonlyMap<string, SensorReading>,
  used: ReadonlySet<string>,
  keepMs: number,
  nowMs: number,
): Trails {
  const next = new Map<string, readonly TrailPoint[]>();
  for (const sensorId of used) {
    const value = readings.get(sensorId)?.value;
    if (value === undefined) continue;
    const points = trails.get(sensorId) ?? [];
    const last = points.at(-1);
    const seenAt = readings.get(sensorId)?.seenAt ?? nowMs;
    const grown = last?.value === value ? points : [...points, { value, at: seenAt }];
    next.set(sensorId, pruned(grown, keepMs, nowMs));
  }
  return next;
}

/** Whether one sensor's trail fell by `dropC` within `withinMs`, counting from `notBefore`. */
function sensorDropped(
  trail: readonly TrailPoint[],
  settings: TemperatureDetection,
  notBefore: number | undefined,
  nowMs: number,
): boolean {
  const points = trail.filter((point) => notBefore === undefined || point.at >= notBefore);
  const latest = points.at(-1);
  if (latest === undefined) return false;
  const cutoff = nowMs - settings.withinMs;
  const inForce = points.filter((point) => point.at <= cutoff).at(-1);
  const recent = points.filter((point) => point.at > cutoff);
  const window = inForce === undefined ? recent : [inForce, ...recent];
  const earlier = window.filter((point) => point !== latest).map((point) => point.value);
  if (earlier.length === 0) return false;
  return Math.max(...earlier) - latest.value >= settings.dropC - TOLERANCE_C;
}

/**
 * Whether any of the sensors fell by `dropC` or more within `withinMs`: from the highest value in
 * that time (or in force at its start) to the latest. Points before `notBefore` are not looked at.
 */
export function dropDetected(
  sensorIds: readonly string[],
  trails: Trails,
  settings: TemperatureDetection,
  notBefore: number | undefined,
  nowMs: number,
): boolean {
  return sensorIds.some((id) => sensorDropped(trails.get(id) ?? [], settings, notBefore, nowMs));
}

/**
 * Milliseconds since the newest point, at or after `since`, that is lower than the point before it,
 * across the sensors; `nowMs − since` when there is none.
 */
export function stillFor(
  sensorIds: readonly string[],
  trails: Trails,
  since: number,
  nowMs: number,
): number {
  let lastFall = since;
  for (const id of sensorIds) {
    const points = trails.get(id) ?? [];
    points.forEach((point, i) => {
      const before = points[i - 1];
      if (before !== undefined && point.at >= since && point.value < before.value) {
        lastFall = Math.max(lastFall, point.at);
      }
    });
  }
  return nowMs - lastFall;
}

/** Active, not suspended, and not past the limit with `afterLimit: heat`. */
export function windowHolds(opening: WindowOpening | undefined, settings: WindowSettings): boolean {
  if (opening === undefined || opening.endedAt !== undefined) return false;
  if (opening.suspendedAt !== undefined) return false;
  return !(opening.limitAt !== undefined && settings.afterLimit === "heat");
}

/** A fresh opening. */
function newOpening(startedAt: number, temperatureSince: number | undefined): WindowOpening {
  return {
    startedAt,
    temperatureSince,
    temperatureEndedAt: undefined,
    suspendedAt: undefined,
    limitAt: undefined,
    droppedAt: undefined,
    endedAt: undefined,
  };
}

/** Whether the temperature side of an active opening, held by a drop since `since`, ends now. */
function temperatureEnds(
  opening: WindowOpening,
  since: number,
  input: WindowInput,
  nowMs: number,
): boolean {
  const detection = input.settings.temperature;
  const quiet = input.stillMs >= detection.stillMs;
  const fixedOver = nowMs - since >= detection.fixedMs;
  // A suspended opening, or one past its limit, ends its temperature side once it stopped falling.
  if (opening.suspendedAt !== undefined || opening.limitAt !== undefined) {
    return !input.frozen && quiet;
  }
  if (detection.end === "fixed") return fixedOver;
  // While frozen the sensors are unknown: only the fixed end may end it.
  return !input.frozen && quiet;
}

/**
 * One tick of a room's opening. It starts on open contacts (at their `openSince`) or a drop, ends
 * when neither contacts nor a drop hold it, rejoins on a new drop within `rejoinMs` of a
 * temperature end, and is dropped `rejoinMs` after it ended or when window handling is off. It
 * reaches its limit `limitMs` after it started, and is suspended by a person's change under
 * `resume_heating` (W6). While the house is frozen nothing starts, and contacts and temperature
 * end nothing but the fixed end (W13).
 */
export function windowStep(
  opening: WindowOpening | undefined,
  input: WindowInput,
  nowMs: number,
): WindowStep {
  const { settings, contacts, frozen } = input;
  if (!settings.enabled) {
    return {
      opening: undefined,
      holds: false,
      holdsValves: false,
      limitReached: false,
      dismissed: opening?.limitAt !== undefined,
    };
  }

  let o = opening;
  if (o?.endedAt !== undefined && nowMs - o.endedAt > settings.temperature.rejoinMs) o = undefined;

  const startByContacts = !frozen && contacts?.state === "open";
  const startByDrop = !frozen && settings.temperature.enabled && input.drop;
  if ((o === undefined || o.endedAt !== undefined) && (startByContacts || startByDrop)) {
    const rejoin =
      o !== undefined && startByDrop && !startByContacts && o.temperatureEndedAt !== undefined;
    o =
      o !== undefined && rejoin
        ? { ...o, endedAt: undefined, temperatureSince: nowMs }
        : newOpening(
            startByContacts ? (contacts.openSince ?? nowMs) : nowMs,
            startByDrop ? nowMs : undefined,
          );
  }

  let limitReached = false;
  let dismissed = false;
  if (o !== undefined && o.endedAt === undefined) {
    if (
      startByDrop &&
      o.temperatureSince === undefined &&
      o.suspendedAt === undefined &&
      o.limitAt === undefined
    ) {
      o = { ...o, temperatureSince: nowMs };
    }
    if (o.temperatureSince !== undefined && temperatureEnds(o, o.temperatureSince, input, nowMs)) {
      o = { ...o, temperatureEndedAt: nowMs, temperatureSince: undefined };
    }
    const contactsHold = contacts !== undefined && (frozen || contacts.state !== "closed");
    const temperatureHolds = o.temperatureSince !== undefined;
    if (!contactsHold && !temperatureHolds) {
      dismissed = o.limitAt !== undefined;
      o = { ...o, endedAt: nowMs };
    } else {
      if (
        settings.limitMs !== undefined &&
        o.limitAt === undefined &&
        nowMs - o.startedAt >= settings.limitMs
      ) {
        o = { ...o, limitAt: nowMs };
        limitReached = !input.thermostatOff && settings.notify;
      }
      if (
        input.personChange &&
        settings.manualChange === "resume_heating" &&
        windowHolds(opening, settings)
      ) {
        o = { ...o, suspendedAt: nowMs };
      }
    }
  }

  const holds = windowHolds(o, settings);
  return {
    opening: o,
    holds,
    holdsValves: holds && !input.thermostatOff,
    limitReached,
    dismissed,
  };
}
