import { ascending } from "./house.ts";
import type { AreaMembership, AreaRoom, HouseInput } from "./house.ts";
import { ConfigError, EMPTY_CONFIG, END_RULES } from "./model.ts";
import { SETTING_KEYS, groupOf } from "./settings.ts";
import { configToRaw, validateConfig } from "./validation.ts";
import type { Config, ConfigIssue, EndRule, Room } from "./model.ts";
import type { ResolvedDay, ResolvedPoint } from "./schedule.ts";
import type { SettingKey, SettingValue, ValveMode } from "./settings.ts";

/** How many released records the ledger keeps, newest first. */
const RELEASED_KEPT = 50;

/**
 * A valve's captured originals. `originals` holds only keys of groups whose `capture` is true in
 * the valve's spec; `null` means "could not be read, accepted by an admin".
 */
export type ValveRecord = Readonly<{
  valveId: string;
  profile: string;
  adoptedAt: number;
  originals: Readonly<Partial<Record<SettingKey, SettingValue | null>>>;
}>;

export type ReleasedRecord = Readonly<{ record: ValveRecord; endedAt: number; forgotten: boolean }>;

/** `records` is keyed by valve id; `released` is newest first and keeps the newest 50. */
export type Ledger = Readonly<{
  records: ReadonlyMap<string, ValveRecord>;
  released: readonly ReleasedRecord[];
}>;

export const EMPTY_LEDGER: Ledger = { records: new Map(), released: [] };

/** How many Home Assistant changes the stored config keeps, oldest dropped first. */
export const HA_CHANGES_KEPT = 20;

export type HaChangeKind =
  "schedule" | "sensor_added" | "sensor_removed" | "sensors_imported" | "override_end";

export type HaChangeItem = Readonly<{
  kind: HaChangeKind;
  areaId: string | undefined;
  entityId: string | undefined;
  scheduleId: string | undefined;
  /** The end rule an `override_end` item chose. */
  rule: EndRule | undefined;
}>;

/** A config revision made from label edits in Home Assistant; `at` is when it was saved. */
export type HaChange = Readonly<{ revision: number; at: number; items: readonly HaChangeItem[] }>;

export type DroppedRoomReason = "no_area" | "area_duplicate" | "area_id_invalid";

/** A version 2 room the conversion to version 3 could not keep. */
export type DroppedRoom = Readonly<{
  roomId: string;
  name: string;
  valveIds: readonly string[];
  reason: DroppedRoomReason;
}>;

export type UpgradeReport = Readonly<{ fromVersion: 2; droppedRooms: readonly DroppedRoom[] }>;

/**
 * `releasing` maps a valve id to the time its release was ordered. `importedAreas` lists, in
 * ascending order, the areas whose one-time `room_temperature_sensor` import has run (each room
 * gets it once). `releasing`, `membership` (the saved membership), `importedAreas`, `haChanges`
 * (oldest first) and `upgrade` are the server's: no document carries or sets them. Whoever rebuilds a stored config spreads the old one and replaces
 * only what it changes.
 */
export type StoredConfig = Readonly<{
  config: Config;
  revision: number;
  releasing: ReadonlyMap<string, number>;
  membership: AreaMembership | undefined;
  importedAreas: readonly string[];
  haChanges: readonly HaChange[];
  upgrade: UpgradeReport | undefined;
}>;

/** A fresh install's stored config: the empty config (writes held), revision 0, nothing else. */
export const FRESH_STORED: StoredConfig = {
  config: EMPTY_CONFIG,
  revision: 0,
  releasing: new Map(),
  membership: undefined,
  importedAreas: [],
  haChanges: [],
  upgrade: undefined,
};

/** The stored config without its upgrade report, the revision unchanged; itself without one. */
export function withoutUpgradeReport(stored: StoredConfig): StoredConfig {
  return stored.upgrade === undefined ? stored : { ...stored, upgrade: undefined };
}

export type ConfigState = "ok" | "empty" | "unreadable";

export type Membership = "managed" | "pending" | "releasing" | "stray" | "orphan" | "frozen";

/** A ledger document that cannot be read. `path` names the faulty part. */
export class LedgerError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path || "(document)"}: ${message}`);
    this.name = "LedgerError";
    this.path = path;
  }
}

/** Adds a record; throws an Error if the valve already has one. Records are create-only. */
export function withRecord(ledger: Ledger, record: ValveRecord): Ledger {
  if (ledger.records.has(record.valveId)) {
    throw new Error(`valve ${record.valveId} already has a ledger record`);
  }
  const records = new Map(ledger.records);
  records.set(record.valveId, record);
  return { records, released: ledger.released };
}

/** Moves the valve's record to `released`; a valve with no record leaves the ledger unchanged. */
export function withoutRecord(
  ledger: Ledger,
  valveId: string,
  nowMs: number,
  forgotten: boolean,
): Ledger {
  const record = ledger.records.get(valveId);
  if (record === undefined) return ledger;
  const records = new Map(ledger.records);
  records.delete(valveId);
  const released = [{ record, endedAt: nowMs, forgotten }, ...ledger.released].slice(
    0,
    RELEASED_KEPT,
  );
  return { records, released };
}

/**
 * Each valve's membership (architecture §8, with "in a room" read from `rooms`, the resolved rooms
 * of `roomsOf`). `ledger` `undefined` means the ledger could not be read; state `ok` without
 * `stored` counts as `unreadable`. `rooms` undefined (no Home Assistant link): every recorded and
 * every releasing valve is frozen. A house that is not live joins and releases nothing: a valve in
 * a room is read as the table says, and every other recorded or releasing valve is frozen, never
 * an orphan (an orphan offers Restore). A valve that matches no row is left out.
 */
export function memberships(
  state: ConfigState,
  stored: StoredConfig | undefined,
  ledger: Ledger | undefined,
  rooms: readonly Room[] | undefined,
  houseKind: HouseInput["kind"],
): ReadonlyMap<string, Membership> {
  const result = new Map<string, Membership>();
  if (state !== "ok" || stored === undefined) {
    for (const valveId of ledger?.records.keys() ?? []) result.set(valveId, "frozen");
    return result;
  }
  if (rooms === undefined) {
    for (const valveId of [...(ledger?.records.keys() ?? []), ...stored.releasing.keys()]) {
      result.set(valveId, "frozen");
    }
    return result;
  }
  const inRoom = new Set(rooms.flatMap((room) => room.valves.map((v) => v.valveId)));
  if (ledger === undefined) {
    for (const valveId of [...inRoom, ...stored.releasing.keys()]) result.set(valveId, "frozen");
    return result;
  }
  for (const valveId of inRoom) {
    result.set(valveId, ledger.records.has(valveId) ? "managed" : "pending");
  }
  if (houseKind !== "live") {
    for (const valveId of [...stored.releasing.keys(), ...ledger.records.keys()]) {
      if (!result.has(valveId)) result.set(valveId, "frozen");
    }
    return result;
  }
  for (const valveId of stored.releasing.keys()) {
    if (!inRoom.has(valveId)) {
      result.set(valveId, ledger.records.has(valveId) ? "releasing" : "stray");
    }
  }
  for (const valveId of ledger.records.keys()) {
    if (!result.has(valveId)) result.set(valveId, "orphan");
  }
  return result;
}

// Raw forms -------------------------------------------------------------------------------------

const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
/** The largest epoch milliseconds a Temporal.Instant can hold. */
const MAX_INSTANT_MS = 8_640_000_000_000_000;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function at(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

function instantToRaw(ms: number): string {
  return Temporal.Instant.fromEpochMilliseconds(ms).toString({ fractionalSecondDigits: 3 });
}

/** Epoch milliseconds of an ISO 8601 UTC text with milliseconds, or undefined. */
function instantFromRaw(value: unknown): number | undefined {
  if (typeof value !== "string" || !INSTANT_PATTERN.test(value)) return undefined;
  try {
    const ms = Temporal.Instant.from(value).epochMilliseconds;
    return instantToRaw(ms) === value ? ms : undefined;
  } catch {
    return undefined;
  }
}

/** The writer refuses what `ledgerFromRaw` would reject, so a saved ledger always loads again. */
function writeFail(path: string, message: string): never {
  throw new Error(`cannot write ${path || "(document)"}: ${message}`);
}

/** `instantToRaw`, refusing an instant the reader would not take back. */
function writeInstant(path: string, ms: number): string {
  if (!Number.isSafeInteger(ms) || Math.abs(ms) > MAX_INSTANT_MS) {
    return writeFail(path, "expected whole epoch milliseconds");
  }
  const text = instantToRaw(ms);
  return INSTANT_PATTERN.test(text) ? text : writeFail(path, "expected a year from 0000 to 9999");
}

function pointToRaw(path: string, point: ResolvedPoint): unknown[] {
  const time = point.time;
  if (
    time.second !== 0 ||
    time.millisecond !== 0 ||
    time.microsecond !== 0 ||
    time.nanosecond !== 0
  ) {
    return writeFail(path, "expected a time in whole minutes");
  }
  if (!Number.isFinite(point.temperature)) return writeFail(path, "expected a finite temperature");
  return [time.toString({ smallestUnit: "minute" }), point.temperature];
}

function isTemperature(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isMode(value: unknown): value is ValveMode {
  return value === "off" || value === "auto" || value === "heat";
}

function valueToRaw(path: string, key: SettingKey, value: SettingValue | null): unknown {
  if (value === null) return null;
  switch (groupOf(key)) {
    case "schedule":
      if (!Array.isArray(value)) return writeFail(path, "expected a day");
      return (value as ResolvedDay).map((p, i) => pointToRaw(`${path}[${String(i)}]`, p));
    case "active_group":
      return typeof value === "number" && Number.isInteger(value)
        ? value
        : writeFail(path, "expected a whole group number");
    case "sensor_source":
      return value === "internal" || value === "external"
        ? value
        : writeFail(path, "expected internal or external");
    case "frost_protection":
      return isTemperature(value) ? value : writeFail(path, "expected a temperature");
    case "thermostat":
      if (key === "setpoint")
        return isTemperature(value) ? value : writeFail(path, "expected a temperature");
      return isMode(value) ? value : writeFail(path, "expected off, auto or heat");
    case "open_window":
      return value === "on" || value === "off" ? value : writeFail(path, "expected on or off");
  }
}

function originalsToRaw(
  path: string,
  originals: ValveRecord["originals"],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(originals).map(([key, value]) => {
      const settingKey = SETTING_KEYS.find((k) => k === key);
      if (settingKey === undefined) return writeFail(at(path, key), "unknown setting key");
      return [key, valueToRaw(at(path, key), settingKey, value)];
    }),
  );
}

function recordToRaw(path: string, record: ValveRecord): Record<string, unknown> {
  return {
    profile: record.profile,
    adopted_at: writeInstant(at(path, "adopted_at"), record.adoptedAt),
    originals: originalsToRaw(at(path, "originals"), record.originals),
  };
}

/** Throws a plain Error, before anything is returned, on a value `ledgerFromRaw` would reject. */
export function ledgerToRaw(ledger: Ledger): Record<string, unknown> {
  return {
    records: Object.fromEntries(
      [...ledger.records].map(([valveId, record]) => [
        valveId,
        recordToRaw(at("records", valveId), record),
      ]),
    ),
    released: ledger.released.map((entry, i) => {
      const path = `released[${String(i)}]`;
      return {
        valve_id: entry.record.valveId,
        ...recordToRaw(path, entry.record),
        ended_at: writeInstant(at(path, "ended_at"), entry.endedAt),
        forgotten: entry.forgotten,
      };
    }),
  };
}

function fail(path: string, message: string): never {
  throw new LedgerError(path, message);
}

/** The object at `path`, which must hold exactly the `keys`. */
function exactObject(
  path: string,
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) return fail(path, "expected an object");
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail(at(path, key), "unknown key");
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(at(path, key), "missing key");
  }
  return value;
}

function textFromRaw(path: string, value: unknown): string {
  return typeof value === "string" ? value : fail(path, "expected a text");
}

function instantOrFail(path: string, value: unknown): number {
  return instantFromRaw(value) ?? fail(path, "expected an ISO 8601 UTC instant with milliseconds");
}

function pointFromRaw(path: string, value: unknown): ResolvedPoint {
  if (!Array.isArray(value) || value.length !== 2)
    return fail(path, "expected a [time, temp] pair");
  const [time, temperature] = value as readonly unknown[];
  if (typeof time !== "string" || !TIME_PATTERN.test(time)) return fail(path, "expected HH:MM");
  if (typeof temperature !== "number" || !Number.isFinite(temperature)) {
    return fail(path, "expected a temperature");
  }
  return { time: Temporal.PlainTime.from(time), temperature };
}

function valueFromRaw(path: string, key: SettingKey, value: unknown): SettingValue | null {
  if (value === null) return null;
  switch (groupOf(key)) {
    case "schedule":
      if (!Array.isArray(value)) return fail(path, "expected a list of [time, temp] pairs");
      return (value as readonly unknown[]).map((p, i) => pointFromRaw(`${path}[${String(i)}]`, p));
    case "active_group":
      return typeof value === "number" && Number.isInteger(value)
        ? value
        : fail(path, "expected a group number");
    case "sensor_source":
      return value === "internal" || value === "external"
        ? value
        : fail(path, "expected internal or external");
    case "frost_protection":
      return isTemperature(value) ? value : fail(path, "expected a temperature");
    case "thermostat":
      if (key === "setpoint")
        return isTemperature(value) ? value : fail(path, "expected a temperature");
      return isMode(value) ? value : fail(path, "expected off, auto or heat");
    case "open_window":
      return value === "on" || value === "off" ? value : fail(path, "expected on or off");
  }
}

function originalsFromRaw(path: string, value: unknown): ValveRecord["originals"] {
  if (!isRecord(value)) return fail(path, "expected an object");
  const originals: Partial<Record<SettingKey, SettingValue | null>> = {};
  for (const [key, item] of Object.entries(value)) {
    const settingKey = SETTING_KEYS.find((k) => k === key);
    if (settingKey === undefined) return fail(at(path, key), "unknown setting key");
    originals[settingKey] = valueFromRaw(at(path, key), settingKey, item);
  }
  return originals;
}

function recordFromRaw(
  path: string,
  valveId: string,
  obj: Readonly<Record<string, unknown>>,
): ValveRecord {
  return {
    valveId,
    profile: textFromRaw(at(path, "profile"), obj.profile),
    adoptedAt: instantOrFail(at(path, "adopted_at"), obj.adopted_at),
    originals: originalsFromRaw(at(path, "originals"), obj.originals),
  };
}

const RECORD_KEYS = ["profile", "adopted_at", "originals"];
const RELEASED_KEYS = ["valve_id", ...RECORD_KEYS, "ended_at", "forgotten"];

/** Reads a ledger document; throws LedgerError on any fault. */
export function ledgerFromRaw(raw: unknown): Ledger {
  const doc = exactObject("", raw, ["records", "released"]);
  if (!isRecord(doc.records)) return fail("records", "expected an object");
  const records = new Map<string, ValveRecord>();
  for (const [valveId, value] of Object.entries(doc.records)) {
    const path = at("records", valveId);
    records.set(valveId, recordFromRaw(path, valveId, exactObject(path, value, RECORD_KEYS)));
  }
  if (!Array.isArray(doc.released)) return fail("released", "expected a list");
  const released = (doc.released as readonly unknown[]).map((value, i): ReleasedRecord => {
    const path = `released[${String(i)}]`;
    const obj = exactObject(path, value, RELEASED_KEYS);
    const valveId = textFromRaw(at(path, "valve_id"), obj.valve_id);
    if (typeof obj.forgotten !== "boolean")
      return fail(at(path, "forgotten"), "expected a boolean");
    return {
      record: recordFromRaw(path, valveId, obj),
      endedAt: instantOrFail(at(path, "ended_at"), obj.ended_at),
      forgotten: obj.forgotten,
    };
  });
  return { records, released };
}

function membershipToRaw(membership: AreaMembership): Record<string, unknown> {
  return {
    rooms: Object.fromEntries(
      [...membership.rooms].map(([areaId, room]) => [
        areaId,
        { name: room.name, valves: [...room.valveIds] },
      ]),
    ),
    ignored: [...membership.ignored],
  };
}

function haChangeToRaw(path: string, change: HaChange): Record<string, unknown> {
  return {
    revision: change.revision,
    at: writeInstant(at(path, "at"), change.at),
    items: change.items.map((item) => ({
      kind: item.kind,
      ...(item.areaId === undefined ? {} : { area_id: item.areaId }),
      ...(item.entityId === undefined ? {} : { entity_id: item.entityId }),
      ...(item.scheduleId === undefined ? {} : { schedule_id: item.scheduleId }),
      ...(item.rule === undefined ? {} : { rule: item.rule }),
    })),
  };
}

function upgradeToRaw(upgrade: UpgradeReport): Record<string, unknown> {
  return {
    from_version: upgrade.fromVersion,
    dropped_rooms: upgrade.droppedRooms.map((room) => ({
      room_id: room.roomId,
      name: room.name,
      valves: [...room.valveIds],
      reason: room.reason,
    })),
  };
}

/** The stored config file's data; `membership` and `upgrade` only when defined. */
export function storedToRaw(stored: StoredConfig): Record<string, unknown> {
  return {
    revision: stored.revision,
    releasing: Object.fromEntries(
      [...stored.releasing].map(([valveId, ms]) => [
        valveId,
        writeInstant(at("releasing", valveId), ms),
      ]),
    ),
    config: configToRaw(stored.config),
    ...(stored.membership === undefined ? {} : { membership: membershipToRaw(stored.membership) }),
    sensor_import: [...stored.importedAreas],
    ha_changes: stored.haChanges.map((change, i) =>
      haChangeToRaw(`ha_changes[${String(i)}]`, change),
    ),
    ...(stored.upgrade === undefined ? {} : { upgrade: upgradeToRaw(stored.upgrade) }),
  };
}

const STORED_REQUIRED = ["revision", "releasing", "config", "sensor_import", "ha_changes"];
const STORED_OPTIONAL = ["membership", "upgrade"];
const HA_CHANGE_KINDS: readonly HaChangeKind[] = [
  "schedule",
  "sensor_added",
  "sensor_removed",
  "sensors_imported",
  "override_end",
];
const DROPPED_ROOM_REASONS: readonly DroppedRoomReason[] = [
  "no_area",
  "area_duplicate",
  "area_id_invalid",
];

/** Collects the issues of a stored config document while its parts are read. */
type StoredReader = Readonly<{
  issue: (path: string, code: string, message: string) => void;
  /** The object at `path` with only the given keys, the `required` ones present; or undefined. */
  object: (
    path: string,
    value: unknown,
    required: readonly string[],
    optional?: readonly string[],
  ) => Readonly<Record<string, unknown>> | undefined;
  text: (path: string, value: unknown) => string | undefined;
  texts: (path: string, value: unknown) => readonly string[] | undefined;
  wholeNumber: (path: string, value: unknown) => number | undefined;
  instant: (path: string, value: unknown) => number | undefined;
  oneOf: <T extends string>(path: string, value: unknown, names: readonly T[]) => T | undefined;
}>;

function storedReader(issues: ConfigIssue[]): StoredReader {
  const issue = (path: string, code: string, message: string): void => {
    issues.push({ path, code, message });
  };
  const typeInvalid = (path: string, expected: string): void => {
    issue(path, "type_invalid", `expected ${expected}`);
  };
  const text = (path: string, value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    typeInvalid(path, "a text");
    return undefined;
  };
  return {
    issue,
    object: (path, value, required, optional = []) => {
      if (!isRecord(value)) {
        typeInvalid(path, "an object");
        return undefined;
      }
      for (const key of Object.keys(value)) {
        if (!required.includes(key) && !optional.includes(key)) {
          issue(at(path, key), "key_unknown", `unknown key "${key}"`);
        }
      }
      for (const key of required) {
        if (value[key] === undefined) {
          issue(at(path, key), "key_missing", `missing required key "${key}"`);
        }
      }
      return value;
    },
    text,
    texts: (path, value) => {
      if (!Array.isArray(value)) {
        typeInvalid(path, "a list of texts");
        return undefined;
      }
      const list = value as readonly unknown[];
      const result = list.map((item, i) => text(`${path}[${String(i)}]`, item));
      return result.every((item) => item !== undefined) ? result : undefined;
    },
    wholeNumber: (path, value) => {
      if (Number.isInteger(value) && (value as number) >= 0) return value as number;
      typeInvalid(path, "a whole number");
      return undefined;
    },
    instant: (path, value) => {
      const ms = instantFromRaw(value);
      if (ms === undefined) typeInvalid(path, "an ISO 8601 UTC instant with milliseconds");
      return ms;
    },
    oneOf: (path, value, names) => {
      const found = names.find((name) => name === value);
      if (found === undefined) typeInvalid(path, `one of ${names.join(", ")}`);
      return found;
    },
  };
}

function membershipFromRaw(read: StoredReader, value: unknown): AreaMembership | undefined {
  const obj = read.object("membership", value, ["rooms", "ignored"]);
  if (obj === undefined) return undefined;
  const rooms = new Map<string, AreaRoom>();
  const rawRooms = obj.rooms;
  if (isRecord(rawRooms)) {
    for (const [areaId, rawRoom] of Object.entries(rawRooms)) {
      const path = at("membership.rooms", areaId);
      const room = read.object(path, rawRoom, ["name", "valves"]);
      if (room === undefined) continue;
      const name = read.text(at(path, "name"), room.name);
      const valveIds = read.texts(at(path, "valves"), room.valves);
      if (name !== undefined && valveIds !== undefined) rooms.set(areaId, { name, valveIds });
    }
  } else if (rawRooms !== undefined) {
    read.issue("membership.rooms", "type_invalid", "expected an object");
  }
  const ignored = obj.ignored === undefined ? [] : read.texts("membership.ignored", obj.ignored);
  return { rooms, ignored: ignored ?? [] };
}

function haChangesFromRaw(read: StoredReader, value: unknown): readonly HaChange[] {
  if (!Array.isArray(value)) {
    read.issue("ha_changes", "type_invalid", "expected a list");
    return [];
  }
  const changes: HaChange[] = [];
  for (const [i, rawChange] of (value as readonly unknown[]).entries()) {
    const path = `ha_changes[${String(i)}]`;
    const change = read.object(path, rawChange, ["revision", "at", "items"]);
    if (change === undefined) continue;
    const revision = read.wholeNumber(at(path, "revision"), change.revision);
    const changedAt = read.instant(at(path, "at"), change.at);
    if (!Array.isArray(change.items)) {
      read.issue(at(path, "items"), "type_invalid", "expected a list");
      continue;
    }
    const items: HaChangeItem[] = [];
    for (const [j, rawItem] of (change.items as readonly unknown[]).entries()) {
      const itemPath = `${at(path, "items")}[${String(j)}]`;
      const item = read.object(
        itemPath,
        rawItem,
        ["kind"],
        ["area_id", "entity_id", "schedule_id", "rule"],
      );
      if (item === undefined) continue;
      const optionalText = (key: string): string | undefined =>
        item[key] === undefined ? undefined : read.text(at(itemPath, key), item[key]);
      const kind = read.oneOf(at(itemPath, "kind"), item.kind, HA_CHANGE_KINDS);
      if (kind === undefined) continue;
      items.push({
        kind,
        areaId: optionalText("area_id"),
        entityId: optionalText("entity_id"),
        scheduleId: optionalText("schedule_id"),
        rule:
          item.rule === undefined
            ? undefined
            : read.oneOf(at(itemPath, "rule"), item.rule, END_RULES),
      });
    }
    if (revision !== undefined && changedAt !== undefined) {
      changes.push({ revision, at: changedAt, items });
    }
  }
  return changes;
}

/**
 * `sensor_import`: the imported areas. A file written before the import was per room holds
 * "pending" (none imported) or "done" (every area of its saved membership counts as imported).
 */
function importedFromRaw(
  read: StoredReader,
  value: unknown,
  membership: AreaMembership | undefined,
): readonly string[] | undefined {
  if (value === "pending") return [];
  if (value === "done") return ascending(membership?.rooms.keys() ?? []);
  if (!Array.isArray(value)) {
    read.issue("sensor_import", "type_invalid", 'expected a list of area ids, "pending" or "done"');
    return undefined;
  }
  const areas = read.texts("sensor_import", value);
  return areas === undefined ? undefined : ascending(new Set(areas));
}

function upgradeFromRaw(read: StoredReader, value: unknown): UpgradeReport | undefined {
  const obj = read.object("upgrade", value, ["from_version", "dropped_rooms"]);
  if (obj === undefined) return undefined;
  if (obj.from_version !== undefined && obj.from_version !== 2) {
    read.issue("upgrade.from_version", "type_invalid", "expected 2");
  }
  if (!Array.isArray(obj.dropped_rooms)) {
    if (obj.dropped_rooms !== undefined) {
      read.issue("upgrade.dropped_rooms", "type_invalid", "expected a list");
    }
    return undefined;
  }
  const droppedRooms: DroppedRoom[] = [];
  for (const [i, rawRoom] of (obj.dropped_rooms as readonly unknown[]).entries()) {
    const path = `upgrade.dropped_rooms[${String(i)}]`;
    const room = read.object(path, rawRoom, ["room_id", "name", "valves", "reason"]);
    if (room === undefined) continue;
    const roomId = read.text(at(path, "room_id"), room.room_id);
    const name = read.text(at(path, "name"), room.name);
    const valveIds = read.texts(at(path, "valves"), room.valves);
    const reason = read.oneOf(at(path, "reason"), room.reason, DROPPED_ROOM_REASONS);
    if (
      roomId !== undefined &&
      name !== undefined &&
      valveIds !== undefined &&
      reason !== undefined
    ) {
      droppedRooms.push({ roomId, name, valveIds, reason });
    }
  }
  return { fromVersion: 2, droppedRooms };
}

/**
 * Reads a stored config document; throws ConfigError listing every issue. Issues of the config
 * part carry its path under `config`.
 */
export function storedFromRaw(raw: unknown): StoredConfig {
  if (!isRecord(raw)) {
    throw new ConfigError([
      { path: "", code: "type_invalid", message: "the document must be an object" },
    ]);
  }
  const issues: ConfigIssue[] = [];
  const read = storedReader(issues);
  read.object("", raw, STORED_REQUIRED, STORED_OPTIONAL);
  const value = (key: string): unknown => (Object.hasOwn(raw, key) ? raw[key] : undefined);

  const rawRevision = value("revision");
  const revision =
    rawRevision === undefined ? undefined : read.wholeNumber("revision", rawRevision);

  const releasing = new Map<string, number>();
  const rawReleasing = value("releasing");
  if (rawReleasing !== undefined && !isRecord(rawReleasing)) {
    read.issue("releasing", "type_invalid", "expected an object");
  } else if (rawReleasing !== undefined) {
    for (const [valveId, item] of Object.entries(rawReleasing)) {
      const ms = read.instant(at("releasing", valveId), item);
      if (ms !== undefined) releasing.set(valveId, ms);
    }
  }

  let config: Config | undefined;
  const rawConfig = value("config");
  if (rawConfig !== undefined) {
    try {
      config = validateConfig(rawConfig);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      for (const issue of error.issues) {
        issues.push({ ...issue, path: at("config", issue.path) });
      }
    }
  }

  const rawMembership = value("membership");
  const membership =
    rawMembership === undefined ? undefined : membershipFromRaw(read, rawMembership);
  const rawImport = value("sensor_import");
  const importedAreas =
    rawImport === undefined ? undefined : importedFromRaw(read, rawImport, membership);
  const rawChanges = value("ha_changes");
  const haChanges = rawChanges === undefined ? [] : haChangesFromRaw(read, rawChanges);
  const rawUpgrade = value("upgrade");
  const upgrade = rawUpgrade === undefined ? undefined : upgradeFromRaw(read, rawUpgrade);

  if (
    issues.length > 0 ||
    config === undefined ||
    revision === undefined ||
    importedAreas === undefined
  ) {
    throw new ConfigError(issues);
  }
  return { config, revision, releasing, membership, importedAreas, haChanges, upgrade };
}
