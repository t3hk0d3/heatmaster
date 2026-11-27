/**
 * The config file, the ledger file, the pacing file, the state file and the readable copy of the
 * originals.
 */

import {
  access,
  constants,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  ConfigError,
  EMPTY_LEDGER,
  EMPTY_THERMOSTAT_STATE,
  PROFILES,
  SETTING_KEYS,
  groupOf,
  ledgerFromRaw,
  ledgerToRaw,
  storedFromRaw,
  storedToRaw,
  thermostatStateFromRaw,
  thermostatStateToRaw,
  upgradeRawV1,
  upgradeStoredV2,
} from "@heatmaster/core";
import type {
  ConfigState,
  Ledger,
  StoredConfig,
  ThermostatState,
  ValveRecord,
} from "@heatmaster/core";
import type { Clock } from "./clock.ts";
import { consoleErrorLog, HeatmasterError, type ErrorLog } from "./errors.ts";

/**
 * Version 3 holds rooms from Home Assistant: an entry per area, the saved membership, the HA
 * changes and the upgrade report. Version 2 wrote a schedule's week as blocks of days and listed
 * rooms with their valves; version 1 wrote `default_week`.
 */
export const CONFIG_FILE_VERSION = 3;
export const LEDGER_FILE_VERSION = 1;
export const PACING_FILE_VERSION = 1;
export const STATE_FILE_VERSION = 2;
export const COPY_FILE_VERSION = 1;
/** The readable copy and the four before it. */
export const COPY_GENERATIONS = 5;

export type StoreDirs = Readonly<{ dataDir: string; publicDir: string }>;

export type ConfigStore = Readonly<{
  /**
   * `convertedFrom` is the file version of a readable file older than the current one. `reason`
   * says why a file is unreadable (its JSON, its conversion or its validation), for the log.
   */
  load(): Promise<
    Readonly<{
      state: ConfigState;
      stored: StoredConfig | undefined;
      convertedFrom: number | undefined;
      reason: string | undefined;
    }>
  >;
  save(stored: StoredConfig, overwriteUnreadable?: boolean): Promise<void>;
  remove(): Promise<void>;
}>;

export type LedgerStore = Readonly<{
  load(expected: boolean): Promise<Ledger | undefined>;
  save(ledger: Ledger): Promise<void>;
  writeCopy(ledger: Ledger): Promise<void>;
  importCopy(acceptEmpty?: boolean): Promise<Ledger>;
  copyRecords(): Promise<number>;
  remove(): Promise<void>;
}>;

/** Per valve, when its token bucket is full again (epoch ms); see `exportBucket` in core. */
export type PacingStamps = ReadonlyMap<string, number>;

/**
 * `load` never rejects: no file gives no stamps, a file that cannot be read gives `unreadable`.
 * `save` replaces the whole file. `freeAsks` holds per valve the time of its last free ask (see
 * `importFreeAsk` in core), kept as an optional `freeAskAt` beside `bucketFullAt`; a valve with a
 * free ask and a full bucket is written with `bucketFullAt` equal to it, which reads as full.
 */
export type PacingStore = Readonly<{
  load(): Promise<
    Readonly<{ state: "ok" | "unreadable"; stamps: PacingStamps; freeAsks: PacingStamps }>
  >;
  save(stamps: PacingStamps, freeAsks?: PacingStamps): Promise<void>;
}>;

/**
 * The room states and valve expectations of `state.json` (plan 3a, R10). `load` never rejects: no
 * file is an empty state, a file that cannot be read is `unreadable`, and the store then refuses
 * to `save` until `reset` has set the file aside and saved an empty state.
 */
export type ThermostatStore = Readonly<{
  /** `reason` says why a file is unreadable (its JSON, its version or its content), for the log. */
  load(): Promise<
    Readonly<{
      state: "ok" | "unreadable";
      thermostats: ThermostatState;
      reason: string | undefined;
    }>
  >;
  save(thermostats: ThermostatState): Promise<void>;
  reset(): Promise<void>;
}>;

/** A store that failed to load, or was never loaded, refuses to write. */
export class StoreLocked extends HeatmasterError {
  constructor(store: "config" | "ledger" | "state") {
    super("store_locked", { store });
  }
}

type File = Readonly<Record<string, unknown>>;

function isFile(value: unknown): value is File {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Brings a file up to `current`; throws on a missing, older or newer version. */
function migrateFile(file: File, current: number): File {
  const version = file.version;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new Error("the file has no version");
  }
  if (version < 1 || version > current)
    throw new Error(`unsupported file version ${String(version)}`);
  // A change of a file's shape adds its step to the file's own migrate function.
  return file;
}

export function migrateConfigFile(file: File): File {
  let migrated = migrateFile(file, CONFIG_FILE_VERSION);
  if (migrated.version === 1) {
    // Version 1 holds a version 1 config document under `data.config`.
    const data = migrated.data;
    migrated = isFile(data)
      ? { ...migrated, version: 2, data: { ...data, config: upgradeRawV1(data.config) } }
      : { ...migrated, version: 2 };
  }
  if (migrated.version === 2) {
    // Version 3 turns the rooms into entries by area and adds the saved membership.
    migrated = { ...migrated, version: 3, data: upgradeStoredV2(migrated.data) };
  }
  return migrated;
}

export function migrateLedgerFile(file: File): File {
  return migrateFile(file, LEDGER_FILE_VERSION);
}

export function migratePacingFile(file: File): File {
  return migrateFile(file, PACING_FILE_VERSION);
}

export function migrateCopyFile(file: File): File {
  return migrateFile(file, COPY_FILE_VERSION);
}

export function migrateStateFile(file: File): File {
  let migrated = migrateFile(file, STATE_FILE_VERSION);
  if (migrated.version === 1) {
    // Version 2 adds the rooms' window openings; version 1 had none.
    migrated = { ...migrated, version: 2, windows: {} };
  }
  return migrated;
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

/** Writes `text` so that a reader sees the old file or the new one, and flushes it to disk. */
async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  const handle = await open(temporary, "w");
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  try {
    const directory = await open(path.dirname(file), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    // Only "this platform cannot flush a directory" is ignored; EIO and the rest surface.
    if (!["EINVAL", "EISDIR", "EPERM", "ENOTSUP", "EBADF"].includes(errnoCode(error) ?? "")) {
      throw error;
    }
  }
}

function render(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

type Read =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "unreadable"; reason: string }>
  | Readonly<{ kind: "ok"; file: File; text: string }>;

/** A failure as one line of text for the log. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** A file that does not exist is missing; one that exists but is not a JSON object is unreadable. */
async function readJson(file: string): Promise<Read> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return errnoCode(error) === "ENOENT"
      ? { kind: "missing" }
      : { kind: "unreadable", reason: reasonOf(error) };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isFile(parsed)
      ? { kind: "ok", file: parsed, text }
      : { kind: "unreadable", reason: "the file holds no JSON object" };
  } catch (error) {
    return { kind: "unreadable", reason: reasonOf(error) };
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw error;
  }
}

/** `YYYYMMDDTHHMMSSZ`, in UTC. */
function stamp(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replaceAll(/[-:]/g, "");
}

/** Copies `source` to `<dir>/<kind>.unreadable.<stamp>[-n].json` without replacing anything. */
async function setAside(source: string, kind: string, clock: Clock): Promise<void> {
  const base = `${kind}.unreadable.${stamp(clock.nowMs())}`;
  for (let attempt = 0; ; attempt += 1) {
    const name = attempt === 0 ? `${base}.json` : `${base}-${String(attempt)}.json`;
    try {
      await copyFile(source, path.join(path.dirname(source), name), constants.COPYFILE_EXCL);
      return;
    } catch (error) {
      if (errnoCode(error) === "EEXIST") continue;
      if (errnoCode(error) === "ENOENT") return; // the file went away; nothing to keep
      throw error;
    }
  }
}

/**
 * Whether every original in the record can be written back to a valve: a captured group of its
 * profile, and for the active group a number from 1 to 3 (the Sonoff encoders throw otherwise).
 */
function restorable(record: ValveRecord): boolean {
  const profile = PROFILES.find((p) => p.key === record.profile);
  for (const key of SETTING_KEYS) {
    const value = record.originals[key];
    if (value === undefined || value === null) continue;
    const group = groupOf(key);
    if (group === "schedule") return false;
    if (
      group === "active_group" &&
      !(typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 3)
    ) {
      return false;
    }
    if (profile !== undefined) {
      const spec = Object.values(profile.specs).find((s) =>
        s.groups.some((g) => g.group === group),
      );
      const groupSpec = spec?.groups.find((g) => g.group === group);
      if (!groupSpec?.capture) return false;
    }
  }
  return true;
}

function ledgerFromData(data: unknown): Ledger | undefined {
  try {
    const ledger = ledgerFromRaw(data);
    return [...ledger.records.values()].every(restorable) ? ledger : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The config file. A file converted from an older version is kept as it was, as
 * `config.v<old version>.json` beside it, before the first save overwrites it; that copy is never
 * replaced, and a copy that cannot be written is logged and the save goes on.
 */
export function createConfigStore(
  dataDir: string,
  clock: Clock,
  log: ErrorLog = consoleErrorLog,
): ConfigStore {
  const file = path.join(dataDir, "config.json");
  // `undefined` until a load has finished: a store that was never loaded is locked.
  let state: ConfigState | undefined;
  /** The text of a converted file, until a save has overwritten it. */
  let original: Readonly<{ version: number; text: string }> | undefined;

  async function keepOriginal(): Promise<void> {
    if (original === undefined) return;
    const copy = path.join(dataDir, `config.v${String(original.version)}.json`);
    try {
      if (!(await exists(copy))) await writeAtomic(copy, original.text);
    } catch (error) {
      log.error("the copy of the converted config file was not written", {
        file: copy,
        err: reasonOf(error),
      });
    }
  }

  return {
    async load() {
      original = undefined;
      const read = await readJson(file);
      if (read.kind === "missing") {
        state = "empty";
        return { state: "empty", stored: undefined, convertedFrom: undefined, reason: undefined };
      }
      let reason = read.kind === "unreadable" ? read.reason : "";
      if (read.kind === "ok") {
        try {
          const stored = storedFromRaw(migrateConfigFile(read.file).data);
          state = "ok";
          const version = read.file.version as number;
          const convertedFrom = version < CONFIG_FILE_VERSION ? version : undefined;
          if (convertedFrom !== undefined) original = { version, text: read.text };
          return { state: "ok", stored, convertedFrom, reason: undefined };
        } catch (error) {
          reason =
            error instanceof ConfigError
              ? error.issues.map((issue) => `${issue.path}: ${issue.code}`).join("; ")
              : reasonOf(error);
        }
      }
      state = "unreadable";
      return { state: "unreadable", stored: undefined, convertedFrom: undefined, reason };
    },

    async save(stored, overwriteUnreadable = false) {
      if (state === undefined || (state === "unreadable" && !overwriteUnreadable)) {
        throw new StoreLocked("config");
      }
      const text = render({ version: CONFIG_FILE_VERSION, data: storedToRaw(stored) });
      if (state === "unreadable") await setAside(file, "config", clock);
      await keepOriginal();
      await writeAtomic(file, text);
      original = undefined;
      state = "ok";
    },

    async remove() {
      if (state === undefined || state === "unreadable") throw new StoreLocked("config");
      await unlink(file).catch((error: unknown) => {
        if (errnoCode(error) !== "ENOENT") throw error;
      });
      state = "empty";
    },
  };
}

export function createLedgerStore(dirs: StoreDirs, clock: Clock, appVersion: string): LedgerStore {
  const file = path.join(dirs.dataDir, "ledger.json");
  const copyName = (generation: number): string =>
    path.join(
      dirs.publicDir,
      generation === 0 ? "originals.json" : `originals.${String(generation)}.json`,
    );
  let locked = true;
  let holdsRecords = false;
  // False until a load or an import has looked at the ledger file.
  let fileKnown = false;

  async function readCopy(generation: number): Promise<Ledger | undefined> {
    const read = await readJson(copyName(generation));
    if (read.kind !== "ok") return undefined;
    try {
      return ledgerFromData(migrateCopyFile(read.file).data);
    } catch {
      return undefined;
    }
  }

  async function newestCopy(): Promise<Ledger | undefined> {
    for (let generation = 0; generation < COPY_GENERATIONS; generation += 1) {
      const ledger = await readCopy(generation);
      if (ledger !== undefined) return ledger;
    }
    return undefined;
  }

  /**
   * True when there is no copy file, or the newest copy file is readable and holds no record. A
   * newest copy that exists but cannot be read may hide records, so it is not empty.
   */
  async function newestCopyEmpty(): Promise<boolean> {
    for (let generation = 0; generation < COPY_GENERATIONS; generation += 1) {
      const read = await readJson(copyName(generation));
      if (read.kind === "missing") continue;
      return (await readCopy(generation))?.records.size === 0;
    }
    return true;
  }

  async function saveLedger(ledger: Ledger): Promise<void> {
    await writeAtomic(file, render({ version: LEDGER_FILE_VERSION, data: ledgerToRaw(ledger) }));
    holdsRecords = ledger.records.size > 0;
    locked = false;
    fileKnown = true;
  }

  return {
    async load(expected) {
      fileKnown = true;
      const read = await readJson(file);
      holdsRecords = false;
      if (read.kind === "missing") {
        const empty = await newestCopyEmpty();
        if (!expected && empty) {
          locked = false;
          holdsRecords = false;
          return EMPTY_LEDGER;
        }
        locked = true;
        return undefined;
      }
      if (read.kind === "ok") {
        try {
          const ledger = ledgerFromData(migrateLedgerFile(read.file).data);
          if (ledger !== undefined) {
            locked = false;
            holdsRecords = ledger.records.size > 0;
            return ledger;
          }
        } catch {
          // fall through: unreadable
        }
      }
      locked = true;
      return undefined;
    },

    async save(ledger) {
      if (locked) throw new StoreLocked("ledger");
      await saveLedger(ledger);
    },

    async writeCopy(ledger) {
      if (locked) throw new StoreLocked("ledger");
      const text = render({
        version: COPY_FILE_VERSION,
        written_at: new Date(clock.nowMs()).toISOString(),
        heatmaster: appVersion,
        data: ledgerToRaw(ledger),
      });
      await mkdir(dirs.publicDir, { recursive: true });
      await unlink(copyName(COPY_GENERATIONS - 1)).catch((error: unknown) => {
        if (errnoCode(error) !== "ENOENT") throw error;
      });
      for (let generation = COPY_GENERATIONS - 1; generation >= 1; generation -= 1) {
        const from = copyName(generation - 1);
        try {
          await rename(from, copyName(generation));
        } catch (error) {
          if (errnoCode(error) !== "ENOENT") throw error;
        }
      }
      await writeAtomic(copyName(0), text);
    },

    async importCopy(acceptEmpty = false) {
      if (!fileKnown) {
        // Never loaded: look at the file itself and refuse as after a normal load.
        const read = await readJson(file);
        if (read.kind === "ok") {
          try {
            const current = ledgerFromData(migrateLedgerFile(read.file).data);
            holdsRecords = (current?.records.size ?? 0) > 0;
          } catch {
            holdsRecords = false;
          }
        }
      }
      if (holdsRecords) throw new HeatmasterError("ledger_readable");
      const copy = (await newestCopy()) ?? (acceptEmpty ? EMPTY_LEDGER : undefined);
      if (copy === undefined) throw new HeatmasterError("no_originals_copy");
      // Whatever file is there is kept; a missing one is skipped.
      await setAside(file, "ledger", clock);
      await saveLedger(copy);
      return copy;
    },

    async copyRecords() {
      return (await newestCopy())?.records.size ?? 0;
    },

    async remove() {
      if (locked) throw new StoreLocked("ledger");
      await unlink(file).catch((error: unknown) => {
        if (errnoCode(error) !== "ENOENT") throw error;
      });
      holdsRecords = false;
    },
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function stampsFromData(data: unknown): Readonly<{ stamps: PacingStamps; freeAsks: PacingStamps }> {
  if (!isFile(data)) throw new Error("the valves are not an object");
  const stamps = new Map<string, number>();
  const freeAsks = new Map<string, number>();
  for (const [valveId, entry] of Object.entries(data)) {
    if (!isFile(entry) || !isFiniteNumber(entry.bucketFullAt)) {
      throw new Error(`the entry of ${valveId} has no bucketFullAt`);
    }
    stamps.set(valveId, entry.bucketFullAt);
    if (entry.freeAskAt === undefined) continue;
    if (!isFiniteNumber(entry.freeAskAt)) {
      throw new Error(`the entry of ${valveId} has a freeAskAt that is not a number`);
    }
    freeAsks.set(valveId, entry.freeAskAt);
  }
  return { stamps, freeAsks };
}

export function createPacingStore(dataDir: string): PacingStore {
  const file = path.join(dataDir, "pacing.json");
  return {
    async load() {
      const read = await readJson(file);
      if (read.kind === "missing") return { state: "ok", stamps: new Map(), freeAsks: new Map() };
      if (read.kind === "ok") {
        try {
          return { state: "ok", ...stampsFromData(migratePacingFile(read.file).valves) };
        } catch {
          // fall through: unreadable
        }
      }
      return { state: "unreadable", stamps: new Map(), freeAsks: new Map() };
    },

    async save(stamps, freeAsks = new Map()) {
      const valves: Record<string, { bucketFullAt: number; freeAskAt?: number }> = {};
      for (const valveId of [...new Set([...stamps.keys(), ...freeAsks.keys()])].sort()) {
        const freeAskAt = freeAsks.get(valveId);
        const bucketFullAt = stamps.get(valveId) ?? freeAskAt ?? 0;
        valves[valveId] = freeAskAt === undefined ? { bucketFullAt } : { bucketFullAt, freeAskAt };
      }
      await writeAtomic(file, render({ version: PACING_FILE_VERSION, valves }));
    },
  };
}

/** The state of a `state.json` document: everything but its `version`, read by the core. */
function thermostatsFromFile(file: File): ThermostatState | undefined {
  const document = Object.fromEntries(
    Object.entries(migrateStateFile(file)).filter(([key]) => key !== "version"),
  );
  return thermostatStateFromRaw(document);
}

export function createThermostatStore(dataDir: string, clock: Clock): ThermostatStore {
  const file = path.join(dataDir, "state.json");
  // True until a load found the file readable or missing: an unreadable file is never overwritten.
  let locked = true;

  async function write(thermostats: ThermostatState): Promise<void> {
    const document = { version: STATE_FILE_VERSION, ...thermostatStateToRaw(thermostats) };
    await writeAtomic(file, render(document));
  }

  return {
    async load() {
      const read = await readJson(file);
      if (read.kind === "missing") {
        locked = false;
        return { state: "ok", thermostats: EMPTY_THERMOSTAT_STATE, reason: undefined };
      }
      let reason = read.kind === "unreadable" ? read.reason : "the file holds no valid room state";
      if (read.kind === "ok") {
        try {
          const thermostats = thermostatsFromFile(read.file);
          if (thermostats !== undefined) {
            locked = false;
            return { state: "ok", thermostats, reason: undefined };
          }
        } catch (error) {
          reason = reasonOf(error);
        }
      }
      locked = true;
      return { state: "unreadable", thermostats: EMPTY_THERMOSTAT_STATE, reason };
    },

    async save(thermostats) {
      if (locked) throw new StoreLocked("state");
      await write(thermostats);
    },

    async reset() {
      // Whatever file is there is kept; a missing one is skipped.
      await setAside(file, "state", clock);
      await write(EMPTY_THERMOSTAT_STATE);
      locked = false;
    },
  };
}
