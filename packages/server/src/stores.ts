/** The config file, the ledger file, the pacing file and the readable copy of the originals. */

import { constants, copyFile, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  EMPTY_LEDGER,
  PROFILES,
  SETTING_KEYS,
  groupOf,
  ledgerFromRaw,
  ledgerToRaw,
  storedFromRaw,
  storedToRaw,
} from "@heatmaster/core";
import type { ConfigState, Ledger, StoredConfig, ValveRecord } from "@heatmaster/core";
import type { Clock } from "./clock.ts";
import { HeatmasterError } from "./errors.ts";

export const CONFIG_FILE_VERSION = 1;
export const LEDGER_FILE_VERSION = 1;
export const PACING_FILE_VERSION = 1;
export const COPY_FILE_VERSION = 1;
/** The readable copy and the four before it. */
export const COPY_GENERATIONS = 5;

export type StoreDirs = Readonly<{ dataDir: string; publicDir: string }>;

export type ConfigStore = Readonly<{
  load(): Promise<Readonly<{ state: ConfigState; stored: StoredConfig | undefined }>>;
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
 * `save` replaces the whole file.
 */
export type PacingStore = Readonly<{
  load(): Promise<Readonly<{ state: "ok" | "unreadable"; stamps: PacingStamps }>>;
  save(stamps: PacingStamps): Promise<void>;
}>;

/** A store that failed to load, or was never loaded, refuses to write. */
export class StoreLocked extends HeatmasterError {
  constructor(store: "config" | "ledger") {
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
  // Version 1 is the only one; a later change of a file's shape adds its step here.
  return file;
}

export function migrateConfigFile(file: File): File {
  return migrateFile(file, CONFIG_FILE_VERSION);
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
  | Readonly<{ kind: "unreadable" }>
  | Readonly<{ kind: "ok"; file: File }>;

/** A file that does not exist is missing; one that exists but is not a JSON object is unreadable. */
async function readJson(file: string): Promise<Read> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return errnoCode(error) === "ENOENT" ? { kind: "missing" } : { kind: "unreadable" };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isFile(parsed) ? { kind: "ok", file: parsed } : { kind: "unreadable" };
  } catch {
    return { kind: "unreadable" };
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

export function createConfigStore(dataDir: string, clock: Clock): ConfigStore {
  const file = path.join(dataDir, "config.json");
  // `undefined` until a load has finished: a store that was never loaded is locked.
  let state: ConfigState | undefined;

  return {
    async load() {
      const read = await readJson(file);
      if (read.kind === "missing") {
        state = "empty";
        return { state: "empty", stored: undefined };
      }
      if (read.kind === "ok") {
        try {
          const stored = storedFromRaw(migrateConfigFile(read.file).data);
          state = "ok";
          return { state: "ok", stored };
        } catch {
          // fall through: unreadable
        }
      }
      state = "unreadable";
      return { state: "unreadable", stored: undefined };
    },

    async save(stored, overwriteUnreadable = false) {
      if (state === undefined || (state === "unreadable" && !overwriteUnreadable)) {
        throw new StoreLocked("config");
      }
      const text = render({ version: CONFIG_FILE_VERSION, data: storedToRaw(stored) });
      if (state === "unreadable") await setAside(file, "config", clock);
      await writeAtomic(file, text);
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

function stampsFromData(data: unknown): PacingStamps {
  if (!isFile(data)) throw new Error("the valves are not an object");
  const stamps = new Map<string, number>();
  for (const [valveId, entry] of Object.entries(data)) {
    if (
      !isFile(entry) ||
      typeof entry.bucketFullAt !== "number" ||
      !Number.isFinite(entry.bucketFullAt)
    ) {
      throw new Error(`the entry of ${valveId} has no bucketFullAt`);
    }
    stamps.set(valveId, entry.bucketFullAt);
  }
  return stamps;
}

export function createPacingStore(dataDir: string): PacingStore {
  const file = path.join(dataDir, "pacing.json");
  return {
    async load() {
      const read = await readJson(file);
      if (read.kind === "missing") return { state: "ok", stamps: new Map() };
      if (read.kind === "ok") {
        try {
          return { state: "ok", stamps: stampsFromData(migratePacingFile(read.file).valves) };
        } catch {
          // fall through: unreadable
        }
      }
      return { state: "unreadable", stamps: new Map() };
    },

    async save(stamps) {
      const valves: Record<string, { bucketFullAt: number }> = {};
      for (const valveId of [...stamps.keys()].sort()) {
        valves[valveId] = { bucketFullAt: stamps.get(valveId) ?? 0 };
      }
      await writeAtomic(file, render({ version: PACING_FILE_VERSION, valves }));
    },
  };
}
