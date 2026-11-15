import { ConfigError } from "./model.ts";
import { SETTING_KEYS, groupOf } from "./settings.ts";
import { configToRaw, validateConfig } from "./validation.ts";
import type { Config, ConfigIssue } from "./model.ts";
import type { ResolvedDay, ResolvedPoint } from "./schedule.ts";
import type { SettingKey, SettingValue } from "./settings.ts";

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

/** `releasing` maps a valve id to the time its release was ordered. */
export type StoredConfig = Readonly<{
  config: Config;
  revision: number;
  releasing: ReadonlyMap<string, number>;
}>;

export type ConfigState = "ok" | "empty" | "unreadable";

export type Membership = "managed" | "not_adopted" | "releasing" | "stray" | "orphan" | "frozen";

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
 * Each valve's membership (architecture §8). `ledger` `undefined` means the ledger could not be
 * read; state `ok` without `stored` counts as `unreadable`. A valve that matches no row is left out.
 */
export function memberships(
  state: ConfigState,
  stored: StoredConfig | undefined,
  ledger: Ledger | undefined,
): ReadonlyMap<string, Membership> {
  const result = new Map<string, Membership>();
  if (state !== "ok" || stored === undefined) {
    for (const valveId of ledger?.records.keys() ?? []) result.set(valveId, "frozen");
    return result;
  }
  const inRoom = new Set(stored.config.rooms.flatMap((room) => room.valves.map((v) => v.valveId)));
  if (ledger === undefined) {
    for (const valveId of [...inRoom, ...stored.releasing.keys()]) result.set(valveId, "frozen");
    return result;
  }
  for (const valveId of inRoom) {
    result.set(valveId, ledger.records.has(valveId) ? "managed" : "not_adopted");
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

function dayToRaw(day: ResolvedDay): unknown[] {
  return day.map((p) => [p.time.toString({ smallestUnit: "minute" }), p.temperature]);
}

function valueToRaw(value: SettingValue | null): unknown {
  return Array.isArray(value) ? dayToRaw(value) : value;
}

function originalsToRaw(originals: ValveRecord["originals"]): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(originals).map(([key, value]) => [key, valueToRaw(value)]),
  );
}

function recordToRaw(record: ValveRecord): Record<string, unknown> {
  return {
    profile: record.profile,
    adopted_at: instantToRaw(record.adoptedAt),
    originals: originalsToRaw(record.originals),
  };
}

export function ledgerToRaw(ledger: Ledger): Record<string, unknown> {
  return {
    records: Object.fromEntries(
      [...ledger.records].map(([valveId, record]) => [valveId, recordToRaw(record)]),
    ),
    released: ledger.released.map((entry) => ({
      valve_id: entry.record.valveId,
      ...recordToRaw(entry.record),
      ended_at: instantToRaw(entry.endedAt),
      forgotten: entry.forgotten,
    })),
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

export function storedToRaw(stored: StoredConfig): Record<string, unknown> {
  return {
    revision: stored.revision,
    releasing: Object.fromEntries(
      [...stored.releasing].map(([valveId, ms]) => [valveId, instantToRaw(ms)]),
    ),
    config: configToRaw(stored.config),
  };
}

const STORED_KEYS = ["revision", "releasing", "config"];

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
  const read = (key: string): unknown => (Object.hasOwn(raw, key) ? raw[key] : undefined);
  const issues: ConfigIssue[] = [];
  for (const key of Object.keys(raw)) {
    if (!STORED_KEYS.includes(key)) {
      issues.push({ path: key, code: "key_unknown", message: `unknown key "${key}"` });
    }
  }
  for (const key of STORED_KEYS) {
    if (read(key) === undefined) {
      issues.push({ path: key, code: "key_missing", message: `missing required key "${key}"` });
    }
  }

  const revision = read("revision");
  if (revision !== undefined && !(Number.isInteger(revision) && (revision as number) >= 0)) {
    issues.push({ path: "revision", code: "type_invalid", message: "expected a whole number" });
  }

  const releasing = new Map<string, number>();
  const rawReleasing = read("releasing");
  if (rawReleasing !== undefined && !isRecord(rawReleasing)) {
    issues.push({ path: "releasing", code: "type_invalid", message: "expected an object" });
  } else if (rawReleasing !== undefined) {
    for (const [valveId, value] of Object.entries(rawReleasing)) {
      const ms = instantFromRaw(value);
      if (ms === undefined) {
        issues.push({
          path: at("releasing", valveId),
          code: "type_invalid",
          message: "expected an ISO 8601 UTC instant with milliseconds",
        });
      } else releasing.set(valveId, ms);
    }
  }

  let config: Config | undefined;
  const rawConfig = read("config");
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

  if (issues.length > 0 || config === undefined) throw new ConfigError(issues);
  return { config, revision: revision as number, releasing };
}
