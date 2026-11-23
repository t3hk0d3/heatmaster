import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EMPTY_LEDGER,
  EMPTY_THERMOSTAT_STATE,
  ledgerToRaw,
  storedFromRaw,
  storedToRaw,
  thermostatStateToRaw,
} from "@heatmaster/core";
import type { Ledger, Thermostat, ThermostatState } from "@heatmaster/core";
import { rejectionOf } from "../test/rejection.ts";
import { createManualClock } from "../test/manual-clock.ts";
import {
  convertedStored,
  ledgerWith,
  overrideState,
  record,
  releasedOnly,
  sampleLedger,
  sampleStored,
  sampleThermostats,
  SAMPLE_VALVE,
} from "../test/store-samples.ts";
import { HeatmasterError } from "./errors.ts";
import {
  COPY_GENERATIONS,
  StoreLocked,
  createConfigStore,
  createLedgerStore,
  createPacingStore,
  createThermostatStore,
  migrateConfigFile,
  migrateCopyFile,
  migrateLedgerFile,
  migratePacingFile,
  migrateStateFile,
} from "./stores.ts";

const FIXTURES = path.resolve(import.meta.dirname, "../test/fixtures/stores");
const START_MS = 1_700_000_000_000;
const STAMP = "20231114T221320Z";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function temporaryFolder(): string {
  const folder = mkdtempSync(path.join(os.tmpdir(), "heatmaster-stores-"));
  folders.push(folder);
  return folder;
}

function world() {
  const dataDir = temporaryFolder();
  const publicDir = temporaryFolder();
  const clock = createManualClock(START_MS);
  return {
    dataDir,
    publicDir,
    clock,
    config: createConfigStore(dataDir, clock),
    ledger: createLedgerStore({ dataDir, publicDir }, clock, "9.9.9"),
    dirs: () => ({ dataDir, publicDir }),
    file: (name: string) => path.join(dataDir, name),
    copy: (name: string) => path.join(publicDir, name),
  };
}

function put(file: string, content: unknown): void {
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
}

function ledgerFile(ledger: Ledger, version = 1): unknown {
  return { version, data: ledgerToRaw(ledger) };
}

function copyFile(ledger: Ledger): unknown {
  return { version: 1, written_at: "x", heatmaster: "x", data: ledgerToRaw(ledger) };
}

function fixtureText(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

function names(dir: string): string[] {
  return readdirSync(dir).sort();
}

function setAsideNames(dir: string, kind: string): string[] {
  return names(dir).filter((n) => n.startsWith(`${kind}.unreadable.`));
}

function jsonOf(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

describe("ConfigStore", () => {
  describe("load", () => {
    describe("With no file", () => {
      it("returns state empty and no stored config", async () => {
        const w = world();
        expect(await w.config.load()).toEqual({
          state: "empty",
          stored: undefined,
          convertedFrom: undefined,
        });
      });
    });

    describe("With a file saved by save", () => {
      it("returns state ok and an equal StoredConfig", async () => {
        const w = world();
        await w.config.load();
        await w.config.save(sampleStored());
        expect(await w.config.load()).toEqual({
          state: "ok",
          stored: sampleStored(),
          convertedFrom: undefined,
        });
      });
    });

    describe("With a file that is not valid JSON", () => {
      it("returns state unreadable and no stored config", async () => {
        const w = world();
        put(w.file("config.json"), "{ nope");
        expect(await w.config.load()).toEqual({
          state: "unreadable",
          stored: undefined,
          convertedFrom: undefined,
          reason: expect.any(String) as unknown,
        });
      });
    });

    describe("With a file whose version is 2 and whose data is empty", () => {
      it("returns state unreadable and the file is unchanged", async () => {
        const w = world();
        const text = JSON.stringify({ version: 2, data: {} });
        put(w.file("config.json"), text);
        expect((await w.config.load()).state).toBe("unreadable");
        expect(readFileSync(w.file("config.json"), "utf8")).toBe(text);
      });
    });

    describe("With a file that has no version", () => {
      it("returns state unreadable and the file is unchanged", async () => {
        const w = world();
        const text = JSON.stringify({ data: {} });
        put(w.file("config.json"), text);
        expect((await w.config.load()).state).toBe("unreadable");
        expect(readFileSync(w.file("config.json"), "utf8")).toBe(text);
      });
    });

    describe("With valid JSON that is not a valid config", () => {
      it("returns state unreadable and the file is unchanged", async () => {
        const w = world();
        const text = JSON.stringify({ version: 1, data: { revision: 1 } });
        put(w.file("config.json"), text);
        expect((await w.config.load()).state).toBe("unreadable");
        expect(readFileSync(w.file("config.json"), "utf8")).toBe(text);
      });
    });

    describe("With a leftover config.json.tmp holding garbage and a good config.json", () => {
      it("returns state ok", async () => {
        const w = world();
        put(w.file("config.json"), fixtureText("house-config.v1.json"));
        put(w.file("config.json.tmp"), "garbage");
        expect((await w.config.load()).state).toBe("ok");
      });
    });

    describe("With the fixture house-config.v1.json (a stored version 1 config)", () => {
      it("returns state ok and a StoredConfig whose schedules equal the version 1 days", async () => {
        const w = world();
        put(w.file("config.json"), fixtureText("house-config.v1.json"));
        expect(await w.config.load()).toEqual({
          state: "ok",
          stored: convertedStored(),
          convertedFrom: 1,
        });
      });

      it("the next save writes the current file version in the week-block form", async () => {
        const w = world();
        put(w.file("config.json"), fixtureText("house-config.v1.json"));
        const { stored } = await w.config.load();
        if (stored === undefined) throw new Error("the fixture loads");
        await w.config.save(stored);
        const file = jsonOf(w.file("config.json"));
        expect(file.version).toBe(3);
        expect(file.data).toEqual(storedToRaw(convertedStored()));
        expect(JSON.stringify(file)).not.toContain("default_week");
      });
    });

    describe("With the fixture house-config.v2.json", () => {
      it("returns state ok, the converted StoredConfig and convertedFrom 2", async () => {
        const w = world();
        put(w.file("config.json"), fixtureText("house-config.v2.json"));
        expect(await w.config.load()).toEqual({
          state: "ok",
          stored: convertedStored(),
          convertedFrom: 2,
        });
      });

      it("leaves the file as it is until a save", async () => {
        const w = world();
        const text = fixtureText("house-config.v2.json");
        put(w.file("config.json"), text);
        await w.config.load();
        expect(readFileSync(w.file("config.json"), "utf8")).toBe(text);
      });
    });

    describe("With the fixture house-config.v3.json", () => {
      it("returns state ok, the full StoredConfig and convertedFrom undefined", async () => {
        const w = world();
        put(w.file("config.json"), fixtureText("house-config.v3.json"));
        expect(await w.config.load()).toEqual({
          state: "ok",
          stored: sampleStored(),
          convertedFrom: undefined,
        });
      });
    });

    describe("With a version 2 file whose data cannot be converted", () => {
      it("returns state unreadable and the file is unchanged", async () => {
        const w = world();
        const file = jsonOf(path.join(FIXTURES, "house-config.v2.json"));
        // Valid under version 2; under version 3 the schedule id is no longer a valid id.
        const data = file.data as { config: { schedules: { id: string }[] } };
        const text = JSON.stringify(file).replaceAll('"default"', '"Not Valid!"');
        expect(data.config.schedules[0]?.id).toBe("default");
        put(w.file("config.json"), text);
        const loaded = await w.config.load();
        expect(loaded.state).toBe("unreadable");
        expect(loaded.convertedFrom).toBeUndefined();
        expect(readFileSync(w.file("config.json"), "utf8")).toBe(text);
      });

      it("reason names the failure, for the log", async () => {
        const w = world();
        const text = fixtureText("house-config.v2.json").replaceAll('"default"', '"Not Valid!"');
        put(w.file("config.json"), text);
        const { reason } = await w.config.load();
        expect(typeof reason).toBe("string");
        expect(reason).not.toBe("");
      });
    });

    describe("With a version 4 file", () => {
      it("returns state unreadable and the file is unchanged", async () => {
        const w = world();
        const text = JSON.stringify({
          ...jsonOf(path.join(FIXTURES, "house-config.v3.json")),
          version: 4,
        });
        put(w.file("config.json"), text);
        expect((await w.config.load()).state).toBe("unreadable");
        expect(readFileSync(w.file("config.json"), "utf8")).toBe(text);
      });
    });
  });

  describe("save", () => {
    describe("After a load with no file", () => {
      it("the file holds version 3 and the stored document, and a second load returns an equal value", async () => {
        const w = world();
        await w.config.load();
        await w.config.save(sampleStored());
        const file = jsonOf(w.file("config.json"));
        expect(file.version).toBe(3);
        expect(file).toEqual(jsonOf(path.join(FIXTURES, "house-config.v3.json")));
        expect((await w.config.load()).stored).toEqual(sampleStored());
      });

      it("the data directory is created if it was missing", async () => {
        const w = world();
        const nested = path.join(w.dataDir, "a", "b");
        const store = createConfigStore(nested, w.clock);
        await store.load();
        await store.save(sampleStored());
        expect(existsSync(path.join(nested, "config.json"))).toBe(true);
      });
    });

    describe("After loading a v2 file", () => {
      async function convertedAndSaved(w: ReturnType<typeof world>): Promise<void> {
        put(w.file("config.json"), fixtureText("house-config.v2.json"));
        const { stored } = await w.config.load();
        if (stored === undefined) throw new Error("the fixture loads");
        await w.config.save(stored);
      }

      it("config.v2.json beside it holds the original file, byte for byte", async () => {
        const w = world();
        await convertedAndSaved(w);
        expect(readFileSync(w.file("config.v2.json"), "utf8")).toBe(
          fixtureText("house-config.v2.json"),
        );
      });

      it("a second save leaves config.v2.json as it is", async () => {
        const w = world();
        await convertedAndSaved(w);
        await w.config.save({ ...convertedStored(), revision: 9 });
        expect(readFileSync(w.file("config.v2.json"), "utf8")).toBe(
          fixtureText("house-config.v2.json"),
        );
        expect(names(w.dataDir)).toEqual(["config.json", "config.v2.json"]);
      });

      it("the written file has version 3 and the converted data", async () => {
        const w = world();
        put(w.file("config.json"), fixtureText("house-config.v2.json"));
        const { stored } = await w.config.load();
        if (stored === undefined) throw new Error("the fixture loads");
        await w.config.save(stored);
        const file = jsonOf(w.file("config.json"));
        expect(file.version).toBe(3);
        expect(file.data).toEqual(storedToRaw(convertedStored()));
        expect(storedFromRaw(file.data)).toEqual(convertedStored());
      });
    });

    describe("After loading a v2 file, with a config.v2.json already there", () => {
      it("that file is not overwritten", async () => {
        const w = world();
        put(w.file("config.v2.json"), "an older copy");
        put(w.file("config.json"), fixtureText("house-config.v2.json"));
        const { stored } = await w.config.load();
        if (stored === undefined) throw new Error("the fixture loads");
        await w.config.save(stored);
        expect(readFileSync(w.file("config.v2.json"), "utf8")).toBe("an older copy");
        expect(jsonOf(w.file("config.json")).version).toBe(3);
      });
    });

    describe("After loading a v2 file, with the copy failing", () => {
      it("the failure is logged at error level and the converted file is saved", async () => {
        const w = world();
        const errors: string[] = [];
        const store = createConfigStore(w.dataDir, w.clock, {
          error: (message) => errors.push(message),
          warn: () => undefined,
        });
        // A directory where the copy's temporary file goes: opening it for writing fails.
        mkdirSync(w.file("config.v2.json.tmp"));
        put(w.file("config.json"), fixtureText("house-config.v2.json"));
        const { stored } = await store.load();
        if (stored === undefined) throw new Error("the fixture loads");
        await store.save(stored);
        expect(errors).toHaveLength(1);
        expect(jsonOf(w.file("config.json")).version).toBe(3);
        expect(existsSync(w.file("config.v2.json"))).toBe(false);
      });
    });

    describe("After loading a v1 file", () => {
      it("config.v1.json beside it holds the original file", async () => {
        const w = world();
        put(w.file("config.json"), fixtureText("house-config.v1.json"));
        const { stored } = await w.config.load();
        if (stored === undefined) throw new Error("the fixture loads");
        await w.config.save(stored);
        expect(readFileSync(w.file("config.v1.json"), "utf8")).toBe(
          fixtureText("house-config.v1.json"),
        );
      });
    });

    describe("After loading a v3 file", () => {
      it("no copy is written", async () => {
        const w = world();
        put(w.file("config.json"), fixtureText("house-config.v3.json"));
        await w.config.load();
        await w.config.save(sampleStored());
        expect(names(w.dataDir)).toEqual(["config.json"]);
      });
    });

    describe("After a good load", () => {
      it("the file holds the new document", async () => {
        const w = world();
        put(w.file("config.json"), fixtureText("house-config.v1.json"));
        await w.config.load();
        await w.config.save({ ...sampleStored(), revision: 4 });
        expect((jsonOf(w.file("config.json")).data as Record<string, unknown>).revision).toBe(4);
      });

      it("no file ending in .tmp remains", async () => {
        const w = world();
        await w.config.load();
        await w.config.save(sampleStored());
        expect(names(w.dataDir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
      });
    });

    describe("Before any load", () => {
      it("rejects with StoreLocked and writes nothing", async () => {
        const w = world();
        expect(await rejectionOf(w.config.save(sampleStored()))).toBeInstanceOf(StoreLocked);
        expect(names(w.dataDir)).toEqual([]);
      });
    });

    describe("After an unreadable load", () => {
      it('rejects with StoreLocked (data store "config") and the file is unchanged', async () => {
        const w = world();
        put(w.file("config.json"), "junk");
        await w.config.load();
        const error = await rejectionOf(w.config.save(sampleStored()));
        expect(error).toBeInstanceOf(StoreLocked);
        expect((error as StoreLocked).code).toBe("store_locked");
        expect((error as StoreLocked).data).toEqual({ store: "config" });
        expect(readFileSync(w.file("config.json"), "utf8")).toBe("junk");
      });
    });

    describe("After an unreadable load, with overwriteUnreadable", () => {
      it("the old content exists under config.unreadable.<stamp>.json, byte for byte", async () => {
        const w = world();
        put(w.file("config.json"), "junk\u0000bytes");
        await w.config.load();
        await w.config.save(sampleStored(), true);
        expect(readFileSync(w.file(`config.unreadable.${STAMP}.json`), "utf8")).toBe(
          "junk\u0000bytes",
        );
      });

      it("the new document is saved and later saves work without the flag", async () => {
        const w = world();
        put(w.file("config.json"), "junk");
        await w.config.load();
        await w.config.save(sampleStored(), true);
        await w.config.save({ ...sampleStored(), revision: 5 });
        expect((await w.config.load()).stored?.revision).toBe(5);
      });
    });

    describe("With a set-aside file of the same second already there", () => {
      it("the new one gets the suffix -1", async () => {
        const w = world();
        put(w.file(`config.unreadable.${STAMP}.json`), "older");
        put(w.file("config.json"), "junk");
        await w.config.load();
        await w.config.save(sampleStored(), true);
        expect(readFileSync(w.file(`config.unreadable.${STAMP}-1.json`), "utf8")).toBe("junk");
        expect(readFileSync(w.file(`config.unreadable.${STAMP}.json`), "utf8")).toBe("older");
      });
    });

    describe("After a good load, with overwriteUnreadable", () => {
      it("the document is saved and nothing is set aside", async () => {
        const w = world();
        put(w.file("config.json"), fixtureText("house-config.v1.json"));
        await w.config.load();
        await w.config.save({ ...sampleStored(), revision: 8 }, true);
        expect(setAsideNames(w.dataDir, "config")).toEqual([]);
        expect((await w.config.load()).stored?.revision).toBe(8);
      });
    });

    describe("With a directory standing where config.json.tmp must be written", () => {
      it("rejects with the file system's error and config.json is unchanged", async () => {
        const w = world();
        const text = fixtureText("house-config.v1.json");
        put(w.file("config.json"), text);
        mkdirSync(w.file("config.json.tmp"));
        await w.config.load();
        const error = await rejectionOf(w.config.save({ ...sampleStored(), revision: 9 }));
        expect(error).toBeInstanceOf(Error);
        expect((error as NodeJS.ErrnoException).code).toBe("EISDIR");
        expect(readFileSync(w.file("config.json"), "utf8")).toBe(text);
      });
    });

    describe("Always", () => {
      it("the file on disk holds the document when the promise resolves", async () => {
        const w = world();
        await w.config.load();
        await w.config.save(sampleStored());
        // A fresh store reads what is on disk right after the promise resolved.
        const fresh = createConfigStore(w.dataDir, w.clock);
        expect((await fresh.load()).stored).toEqual(sampleStored());
      });
    });
  });

  describe("remove", () => {
    describe("After a good load", () => {
      it("the config file is gone and a later load returns state empty", async () => {
        const w = world();
        put(w.file("config.json"), fixtureText("house-config.v1.json"));
        await w.config.load();
        await w.config.remove();
        expect(existsSync(w.file("config.json"))).toBe(false);
        expect((await w.config.load()).state).toBe("empty");
      });
    });

    describe("After an unreadable load", () => {
      it("rejects with StoreLocked and the file is unchanged", async () => {
        const w = world();
        put(w.file("config.json"), "junk");
        await w.config.load();
        expect(await rejectionOf(w.config.remove())).toBeInstanceOf(StoreLocked);
        expect(readFileSync(w.file("config.json"), "utf8")).toBe("junk");
      });
    });
  });
});

describe("LedgerStore", () => {
  describe("load", () => {
    describe("With no file, expected false and no readable copy", () => {
      it("returns EMPTY_LEDGER and a later save works", async () => {
        const w = world();
        expect(await w.ledger.load(false)).toEqual(EMPTY_LEDGER);
        await w.ledger.save(sampleLedger());
        expect(existsSync(w.file("ledger.json"))).toBe(true);
      });
    });

    describe("With no file, expected false, and an originals.json that holds one record", () => {
      it("returns undefined and the store is locked", async () => {
        const w = world();
        put(w.copy("originals.json"), copyFile(ledgerWith(1)));
        expect(await w.ledger.load(false)).toBeUndefined();
        expect(await rejectionOf(w.ledger.save(EMPTY_LEDGER))).toBeInstanceOf(StoreLocked);
      });
    });

    describe("With no file, expected false, and an originals.json that holds only released entries", () => {
      it("returns EMPTY_LEDGER and a later save works", async () => {
        const w = world();
        put(w.copy("originals.json"), copyFile(releasedOnly()));
        expect(await w.ledger.load(false)).toEqual(EMPTY_LEDGER);
        await w.ledger.save(EMPTY_LEDGER);
        expect(existsSync(w.file("ledger.json"))).toBe(true);
      });
    });

    describe("With no file, expected false, originals.json unreadable and originals.1.json holding one record", () => {
      it("returns undefined and the store is locked", async () => {
        const w = world();
        put(w.copy("originals.json"), "junk");
        put(w.copy("originals.1.json"), copyFile(ledgerWith(1)));
        expect(await w.ledger.load(false)).toBeUndefined();
        expect(await rejectionOf(w.ledger.save(EMPTY_LEDGER))).toBeInstanceOf(StoreLocked);
      });
    });

    describe("With no file, expected false, and copy files that exist but none is readable", () => {
      it("returns undefined and the store is locked", async () => {
        const w = world();
        put(w.copy("originals.json"), "junk");
        put(w.copy("originals.2.json"), { version: 2, data: {} });
        expect(await w.ledger.load(false)).toBeUndefined();
        expect(await rejectionOf(w.ledger.save(EMPTY_LEDGER))).toBeInstanceOf(StoreLocked);
      });
    });

    describe("With no file, expected false, the newest copy unreadable and an older copy holding no record", () => {
      it("returns undefined and the store is locked", async () => {
        const w = world();
        put(w.copy("originals.json"), "junk");
        put(w.copy("originals.1.json"), copyFile(EMPTY_LEDGER));
        expect(await w.ledger.load(false)).toBeUndefined();
        expect(await rejectionOf(w.ledger.save(EMPTY_LEDGER))).toBeInstanceOf(StoreLocked);
      });
    });

    describe("With no file and expected true", () => {
      it("returns undefined and the store is locked", async () => {
        const w = world();
        expect(await w.ledger.load(true)).toBeUndefined();
        expect(await rejectionOf(w.ledger.save(EMPTY_LEDGER))).toBeInstanceOf(StoreLocked);
      });
    });

    describe("With a saved ledger holding a record with an unknown original and a released record", () => {
      it("returns an equal Ledger", async () => {
        const w = world();
        await w.ledger.load(false);
        await w.ledger.save(sampleLedger());
        const fresh = createLedgerStore(
          { dataDir: w.dataDir, publicDir: w.publicDir },
          w.clock,
          "9.9.9",
        );
        expect(await fresh.load(true)).toEqual(sampleLedger());
      });
    });

    describe("With a file that is not valid JSON, has version 2, or holds a document of the wrong shape", () => {
      const cases: [string, string][] = [
        ["not valid JSON", "{ nope"],
        ["version 2", JSON.stringify(ledgerFile(sampleLedger(), 2))],
        ["a wrong shape", JSON.stringify({ version: 1, data: { records: [], released: [] } })],
      ];
      for (const [label, text] of cases) {
        it(`${label}: returns undefined, the store is locked and the file is unchanged`, async () => {
          const w = world();
          put(w.file("ledger.json"), text);
          expect(await w.ledger.load(false)).toBeUndefined();
          expect(await rejectionOf(w.ledger.save(EMPTY_LEDGER))).toBeInstanceOf(StoreLocked);
          expect(readFileSync(w.file("ledger.json"), "utf8")).toBe(text);
        });
      }
    });

    describe("With a ledger whose originals cannot be written back to a valve", () => {
      const bad: [string, Ledger][] = [
        [
          "an active group of 4",
          { records: new Map([["z2m:0x1", record("z2m:0x1", { active_group: 4 })]]), released: [] },
        ],
        [
          "an active group on a TRVZB",
          {
            records: new Map([["z2m:0x1", record("z2m:0x1", { active_group: 1 }, "sonoff_trvzb")]]),
            released: [],
          },
        ],
      ];
      for (const [label, ledger] of bad) {
        it(`${label}: returns undefined and the store is locked`, async () => {
          const w = world();
          put(w.file("ledger.json"), ledgerFile(ledger));
          expect(await w.ledger.load(false)).toBeUndefined();
          expect(await rejectionOf(w.ledger.save(EMPTY_LEDGER))).toBeInstanceOf(StoreLocked);
        });
      }
    });

    describe("With the fixture ledger.v1.json", () => {
      it("returns the expected Ledger", async () => {
        const w = world();
        put(w.file("ledger.json"), fixtureText("ledger.v1.json"));
        expect(await w.ledger.load(false)).toEqual(sampleLedger());
      });
    });
  });

  describe("save", () => {
    describe("After a good load", () => {
      it("the file holds version 1 and the ledger, and a second load returns an equal value", async () => {
        const w = world();
        await w.ledger.load(false);
        await w.ledger.save(sampleLedger());
        const file = jsonOf(w.file("ledger.json"));
        expect(file.version).toBe(1);
        expect(file.data).toEqual(jsonOf(path.join(FIXTURES, "ledger.v1.json")).data);
        expect(await w.ledger.load(true)).toEqual(sampleLedger());
      });
    });

    describe("After an unreadable load", () => {
      it('rejects with StoreLocked (data store "ledger") and writes nothing', async () => {
        const w = world();
        put(w.file("ledger.json"), "junk");
        await w.ledger.load(false);
        const error = await rejectionOf(w.ledger.save(sampleLedger()));
        expect(error).toBeInstanceOf(StoreLocked);
        expect((error as StoreLocked).data).toEqual({ store: "ledger" });
        expect(names(w.dataDir)).toEqual(["ledger.json"]);
        expect(readFileSync(w.file("ledger.json"), "utf8")).toBe("junk");
      });
    });

    describe("Before any load", () => {
      it("rejects with StoreLocked and writes nothing", async () => {
        const w = world();
        expect(await rejectionOf(w.ledger.save(sampleLedger()))).toBeInstanceOf(StoreLocked);
        expect(names(w.dataDir)).toEqual([]);
      });
    });
  });

  describe("writeCopy", () => {
    describe("Always", () => {
      it("originals.json holds version 1, written_at from the clock, the app version and the ledger, in indented JSON", async () => {
        const w = world();
        await w.ledger.load(false);
        await w.ledger.writeCopy(sampleLedger());
        const text = readFileSync(w.copy("originals.json"), "utf8");
        expect(text).toBe(
          `${JSON.stringify(
            {
              version: 1,
              written_at: "2023-11-14T22:13:20.000Z",
              heatmaster: "9.9.9",
              data: ledgerToRaw(sampleLedger()),
            },
            null,
            2,
          )}\n`,
        );
      });

      it("the public directory is created if it was missing", async () => {
        const w = world();
        const nested = path.join(w.publicDir, "x", "y");
        const store = createLedgerStore({ dataDir: w.dataDir, publicDir: nested }, w.clock, "1");
        await store.load(false);
        await store.writeCopy(EMPTY_LEDGER);
        expect(existsSync(path.join(nested, "originals.json"))).toBe(true);
      });
    });

    describe("With one earlier copy", () => {
      it("the earlier copy is now originals.1.json", async () => {
        const w = world();
        await w.ledger.load(false);
        await w.ledger.writeCopy(ledgerWith(1));
        const first = readFileSync(w.copy("originals.json"), "utf8");
        w.clock.advance(1000);
        await w.ledger.writeCopy(ledgerWith(2));
        expect(readFileSync(w.copy("originals.1.json"), "utf8")).toBe(first);
        expect(await w.ledger.copyRecords()).toBe(2);
      });
    });

    describe("With five earlier copies", () => {
      it("originals.4.json is the oldest kept and no sixth file exists", async () => {
        const w = world();
        await w.ledger.load(false);
        for (let n = 1; n <= 6; n += 1) await w.ledger.writeCopy(ledgerWith(n));
        expect(names(w.publicDir)).toEqual([
          "originals.1.json",
          "originals.2.json",
          "originals.3.json",
          "originals.4.json",
          "originals.json",
        ]);
        expect(COPY_GENERATIONS).toBe(5);
        const size = (name: string): number =>
          Object.keys((jsonOf(w.copy(name)).data as { records: object }).records).length;
        expect(size("originals.json")).toBe(6);
        expect(size("originals.4.json")).toBe(2);
      });
    });

    describe("After an unreadable ledger load", () => {
      it("rejects with StoreLocked and writes nothing", async () => {
        const w = world();
        put(w.file("ledger.json"), "junk");
        await w.ledger.load(false);
        expect(await rejectionOf(w.ledger.writeCopy(sampleLedger()))).toBeInstanceOf(StoreLocked);
        expect(names(w.publicDir)).toEqual([]);
      });
    });
  });

  describe("importCopy", () => {
    describe("With an unreadable ledger file and a good originals.json", () => {
      it("the unreadable file exists under ledger.unreadable.<stamp>.json", async () => {
        const w = world();
        put(w.file("ledger.json"), "junk");
        put(w.copy("originals.json"), copyFile(sampleLedger()));
        await w.ledger.load(false);
        await w.ledger.importCopy();
        expect(readFileSync(w.file(`ledger.unreadable.${STAMP}.json`), "utf8")).toBe("junk");
      });

      it("the ledger is saved and returned, and later saves work", async () => {
        const w = world();
        put(w.file("ledger.json"), "junk");
        put(w.copy("originals.json"), copyFile(sampleLedger()));
        await w.ledger.load(false);
        expect(await w.ledger.importCopy()).toEqual(sampleLedger());
        expect(await createLedgerStore(w.dirs(), w.clock, "1").load(true)).toEqual(sampleLedger());
        await w.ledger.save(ledgerWith(1));
      });
    });

    describe("With a missing ledger that was expected, and a good originals.json", () => {
      it("the ledger is saved and returned, and nothing is set aside", async () => {
        const w = world();
        put(w.copy("originals.json"), copyFile(sampleLedger()));
        await w.ledger.load(true);
        expect(await w.ledger.importCopy()).toEqual(sampleLedger());
        expect(setAsideNames(w.dataDir, "ledger")).toEqual([]);
        expect(existsSync(w.file("ledger.json"))).toBe(true);
      });
    });

    describe("With originals.json unreadable and originals.1.json good", () => {
      it("uses originals.1.json", async () => {
        const w = world();
        put(w.copy("originals.json"), "junk");
        put(w.copy("originals.1.json"), copyFile(ledgerWith(1)));
        await w.ledger.load(true);
        expect((await w.ledger.importCopy()).records.size).toBe(1);
      });
    });

    describe("With originals.json missing and originals.2.json good", () => {
      it("uses originals.2.json", async () => {
        const w = world();
        put(w.copy("originals.2.json"), copyFile(ledgerWith(2)));
        await w.ledger.load(true);
        expect((await w.ledger.importCopy()).records.size).toBe(2);
      });
    });

    describe("With the fixture originals.v1.json", () => {
      it("returns the expected Ledger", async () => {
        const w = world();
        put(w.copy("originals.json"), fixtureText("originals.v1.json"));
        await w.ledger.load(true);
        expect(await w.ledger.importCopy()).toEqual(sampleLedger());
      });
    });

    describe("With no readable copy", () => {
      it("rejects with HeatmasterError no_originals_copy and changes nothing", async () => {
        const w = world();
        put(w.file("ledger.json"), "junk");
        await w.ledger.load(false);
        const error = await rejectionOf(w.ledger.importCopy());
        expect(error).toBeInstanceOf(HeatmasterError);
        expect((error as HeatmasterError).code).toBe("no_originals_copy");
        expect(names(w.dataDir)).toEqual(["ledger.json"]);
        expect(readFileSync(w.file("ledger.json"), "utf8")).toBe("junk");
        expect(await rejectionOf(w.ledger.save(EMPTY_LEDGER))).toBeInstanceOf(StoreLocked);
      });
    });

    describe("With no readable copy and acceptEmpty", () => {
      it("the unreadable file is set aside, an empty ledger is saved and returned, and later saves work", async () => {
        const w = world();
        put(w.file("ledger.json"), "junk");
        await w.ledger.load(false);
        expect(await w.ledger.importCopy(true)).toEqual(EMPTY_LEDGER);
        expect(readFileSync(w.file(`ledger.unreadable.${STAMP}.json`), "utf8")).toBe("junk");
        expect(await createLedgerStore(w.dirs(), w.clock, "1").load(true)).toEqual(EMPTY_LEDGER);
        await w.ledger.save(ledgerWith(1));
      });
    });

    describe("With a ledger that loaded normally and holds records", () => {
      it("rejects with HeatmasterError ledger_readable and changes nothing", async () => {
        const w = world();
        const text = JSON.stringify(ledgerFile(sampleLedger()));
        put(w.file("ledger.json"), text);
        put(w.copy("originals.json"), copyFile(ledgerWith(1)));
        await w.ledger.load(false);
        const error = await rejectionOf(w.ledger.importCopy());
        expect((error as HeatmasterError).code).toBe("ledger_readable");
        expect(readFileSync(w.file("ledger.json"), "utf8")).toBe(text);
        expect(names(w.dataDir)).toEqual(["ledger.json"]);
      });
    });

    describe("With a ledger that loaded normally and is empty, and a good originals.json", () => {
      it("the copy's ledger is saved and returned", async () => {
        const w = world();
        put(w.file("ledger.json"), ledgerFile(EMPTY_LEDGER));
        put(w.copy("originals.json"), copyFile(ledgerWith(1)));
        expect(await w.ledger.load(false)).toEqual(EMPTY_LEDGER);
        expect((await w.ledger.importCopy()).records.size).toBe(1);
        expect(await createLedgerStore(w.dirs(), w.clock, "1").load(false)).toEqual(ledgerWith(1));
      });

      it("the old ledger file exists under ledger.unreadable.<stamp>.json", async () => {
        const w = world();
        const old = { records: new Map(), released: releasedOnly().released };
        const text = JSON.stringify(ledgerFile(old));
        put(w.file("ledger.json"), text);
        put(w.copy("originals.json"), copyFile(ledgerWith(1)));
        await w.ledger.load(false);
        await w.ledger.importCopy();
        expect(readFileSync(w.file(`ledger.unreadable.${STAMP}.json`), "utf8")).toBe(text);
      });
    });

    describe("Before any load, with a ledger file that holds records", () => {
      it("rejects with ledger_readable and changes nothing", async () => {
        const w = world();
        const text = JSON.stringify(ledgerFile(sampleLedger()));
        put(w.file("ledger.json"), text);
        put(w.copy("originals.json"), copyFile(ledgerWith(1)));
        const error = await rejectionOf(w.ledger.importCopy());
        expect((error as HeatmasterError).code).toBe("ledger_readable");
        expect(names(w.dataDir)).toEqual(["ledger.json"]);
        expect(readFileSync(w.file("ledger.json"), "utf8")).toBe(text);
      });
    });

    describe("With no ledger file, expected false, and an originals.json that holds one record (the store is locked)", () => {
      it("the copy's ledger is saved and returned, and later saves work", async () => {
        const w = world();
        put(w.copy("originals.json"), copyFile(ledgerWith(1)));
        expect(await w.ledger.load(false)).toBeUndefined();
        expect(await w.ledger.importCopy()).toEqual(ledgerWith(1));
        expect(await createLedgerStore(w.dirs(), w.clock, "1").load(true)).toEqual(ledgerWith(1));
        await w.ledger.save(ledgerWith(2));
        expect(await createLedgerStore(w.dirs(), w.clock, "1").load(true)).toEqual(ledgerWith(2));
      });
    });
  });

  describe("copyRecords", () => {
    describe("With an originals.json that holds two records and one released entry", () => {
      it("returns 2", async () => {
        const w = world();
        const ledger: Ledger = { ...ledgerWith(2), released: releasedOnly().released };
        put(w.copy("originals.json"), copyFile(ledger));
        expect(await w.ledger.copyRecords()).toBe(2);
      });
    });

    describe("With originals.json unreadable and originals.1.json holding one record", () => {
      it("returns 1", async () => {
        const w = world();
        put(w.copy("originals.json"), "junk");
        put(w.copy("originals.1.json"), copyFile(ledgerWith(1)));
        expect(await w.ledger.copyRecords()).toBe(1);
      });
    });

    describe("With no readable copy", () => {
      it("returns 0", async () => {
        const w = world();
        expect(await w.ledger.copyRecords()).toBe(0);
      });
    });

    describe("After an unreadable ledger load", () => {
      it("still returns the number, and changes no file", async () => {
        const w = world();
        put(w.file("ledger.json"), "junk");
        put(w.copy("originals.json"), copyFile(ledgerWith(3)));
        await w.ledger.load(false);
        const before = [names(w.dataDir), names(w.publicDir)];
        expect(await w.ledger.copyRecords()).toBe(3);
        expect([names(w.dataDir), names(w.publicDir)]).toEqual(before);
      });
    });
  });

  describe("remove", () => {
    describe("After a good load", () => {
      it("the ledger file is gone and the readable copies remain", async () => {
        const w = world();
        await w.ledger.load(false);
        await w.ledger.save(ledgerWith(1));
        await w.ledger.writeCopy(ledgerWith(1));
        await w.ledger.remove();
        expect(existsSync(w.file("ledger.json"))).toBe(false);
        expect(existsSync(w.copy("originals.json"))).toBe(true);
      });

      it("the store then behaves as after loading a missing file", async () => {
        const w = world();
        await w.ledger.load(false);
        await w.ledger.save(ledgerWith(1));
        await w.ledger.writeCopy(ledgerWith(1));
        await w.ledger.remove();
        await w.ledger.save(EMPTY_LEDGER);
        expect(existsSync(w.file("ledger.json"))).toBe(true);
      });
    });

    describe("After an unreadable load", () => {
      it("rejects with StoreLocked and the file is unchanged", async () => {
        const w = world();
        put(w.file("ledger.json"), "junk");
        await w.ledger.load(false);
        expect(await rejectionOf(w.ledger.remove())).toBeInstanceOf(StoreLocked);
        expect(readFileSync(w.file("ledger.json"), "utf8")).toBe("junk");
      });
    });
  });
});

describe("migrations", () => {
  describe("migrateConfigFile / migrateLedgerFile / migrateCopyFile", () => {
    const migrations = [migrateLedgerFile, migrateCopyFile];

    describe("With a version 1 file", () => {
      it("returns an equal document", () => {
        const file = { version: 1, data: { a: 1 } };
        for (const migrate of migrations) expect(migrate(file)).toEqual(file);
      });
    });

    describe("With a version 2 file, or no version", () => {
      it("throws", () => {
        for (const migrate of migrations) {
          expect(() => migrate({ version: 2, data: {} })).toThrow();
          expect(() => migrate({ data: {} })).toThrow();
        }
      });
    });
  });
});

describe("migrateConfigFile", () => {
  const v2 = (): Record<string, unknown> => jsonOf(path.join(FIXTURES, "house-config.v2.json"));
  const v1 = (): Record<string, unknown> => jsonOf(path.join(FIXTURES, "house-config.v1.json"));

  describe("With the v2 fixture", () => {
    it("the result has version 3 and its data passes storedFromRaw", () => {
      const migrated = migrateConfigFile(v2());
      expect(migrated.version).toBe(3);
      expect(storedFromRaw(migrated.data)).toEqual(convertedStored());
    });

    it("hold_writes is true and the upgrade report lists no dropped room", () => {
      const stored = storedFromRaw(migrateConfigFile(v2()).data);
      expect(stored.config.settings.holdWrites).toBe(true);
      expect(stored.upgrade).toEqual({ fromVersion: 2, droppedRooms: [] });
    });
  });

  describe("With an inline v2 file holding a room without area_id", () => {
    it("the upgrade report lists that room with reason no_area", () => {
      const file = v2();
      const data = file.data as { config: { rooms: Record<string, unknown>[] } };
      delete data.config.rooms[0]?.area_id;
      const stored = storedFromRaw(migrateConfigFile(file).data);
      expect(stored.upgrade?.droppedRooms).toEqual([
        { roomId: "living", name: "Living room", valveIds: [SAMPLE_VALVE], reason: "no_area" },
      ]);
    });
  });

  describe("With the v1 fixture", () => {
    it("the result has version 3 after both steps", () => {
      expect(migrateConfigFile(v1()).version).toBe(3);
    });
  });

  describe("With version 3", () => {
    it("returns the file unchanged", () => {
      const file = jsonOf(path.join(FIXTURES, "house-config.v3.json"));
      expect(migrateConfigFile(file)).toEqual(file);
    });
  });

  describe("With version 4 or no version", () => {
    it("throws", () => {
      expect(() => migrateConfigFile({ version: 4, data: {} })).toThrow();
      expect(() => migrateConfigFile({ data: {} })).toThrow();
    });
  });
});

describe("stores — pacing.json", () => {
  describe("With the version 1 fixture", () => {
    it("migrates unchanged and loads its stamps", async () => {
      const w = world();
      put(w.file("pacing.json"), fixtureText("pacing.v1.json"));
      const file = JSON.parse(fixtureText("pacing.v1.json")) as Record<string, unknown>;
      expect(migratePacingFile(file)).toEqual(file);
      expect(() => migratePacingFile({ version: 2, valves: {} })).toThrow();
      const loaded = await createPacingStore(w.dataDir).load();
      expect(loaded.state).toBe("ok");
      expect([...loaded.stamps]).toEqual([
        ["z2m:0x00124b0012345678", 1_700_003_600_000],
        ["z2m:0x00124b00abcdef01", 1_700_007_200_000],
      ]);
    });
  });
  const STAMPS = new Map([
    ["z2m:a", START_MS + 3_600_000],
    ["z2m:b", START_MS + 7_200_000],
  ]);
  describe("load", () => {
    describe("With no file", () => {
      it("returns no entries (all buckets full)", async () => {
        const w = world();
        const loaded = await createPacingStore(w.dataDir).load();
        expect(loaded.state).toBe("ok");
        expect(loaded.stamps.size).toBe(0);
      });
    });
    describe("With an invalid file", () => {
      it.each([
        ["not JSON", "{ not json"],
        ["not an object", "[1]"],
        ["no valves", { version: 1 }],
        ["an entry without bucketFullAt", { version: 1, valves: { a: {} } }],
        [
          "a bucketFullAt that is not a number",
          { version: 1, valves: { a: { bucketFullAt: "x" } } },
        ],
        [
          "a bucketFullAt that is not finite",
          { version: 1, valves: { a: { bucketFullAt: null } } },
        ],
      ])(
        "reports unreadable (%s); the caller starts with empty buckets",
        async (_name, content) => {
          const w = world();
          put(w.file("pacing.json"), content);
          const loaded = await createPacingStore(w.dataDir).load();
          expect(loaded.state).toBe("unreadable");
          expect(loaded.stamps.size).toBe(0);
        },
      );
    });
    describe("With version other than 1", () => {
      it.each([0, 2, "1"])("reports unreadable (version %s)", async (version) => {
        const w = world();
        put(w.file("pacing.json"), { version, valves: { a: { bucketFullAt: START_MS } } });
        expect((await createPacingStore(w.dataDir).load()).state).toBe("unreadable");
      });
    });
  });

  describe("save", () => {
    it("writes atomically: the file holds the document and no .tmp file remains", async () => {
      const w = world();
      await createPacingStore(w.dataDir).save(STAMPS);
      expect(jsonOf(w.file("pacing.json"))).toEqual({
        version: 1,
        valves: {
          "z2m:a": { bucketFullAt: START_MS + 3_600_000 },
          "z2m:b": { bucketFullAt: START_MS + 7_200_000 },
        },
      });
      expect(names(w.dataDir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    });
    it("with a directory standing where pacing.json.tmp must be written, rejects and leaves the old file", async () => {
      const w = world();
      const store = createPacingStore(w.dataDir);
      await store.save(STAMPS);
      const before = readFileSync(w.file("pacing.json"), "utf8");
      mkdirSync(w.file("pacing.json.tmp"));
      const error = await rejectionOf(store.save(new Map([["z2m:c", START_MS]])));
      expect((error as NodeJS.ErrnoException).code).toBe("EISDIR");
      expect(readFileSync(w.file("pacing.json"), "utf8")).toBe(before);
    });
    it("round trip save -> load returns the same stamps", async () => {
      const w = world();
      const store = createPacingStore(w.dataDir);
      await store.save(STAMPS);
      const loaded = await createPacingStore(w.dataDir).load();
      expect(loaded.state).toBe("ok");
      expect(new Map(loaded.stamps)).toEqual(STAMPS);
    });
  });
});

describe("stores", () => {
  describe("createThermostatStore", () => {
    const stateFile = (w: ReturnType<typeof world>): string => w.file("state.json");
    const store = (w: ReturnType<typeof world>) => createThermostatStore(w.dataDir, w.clock);

    describe("load", () => {
      describe("With no file", () => {
        it("ok and empty", async () => {
          const w = world();
          expect(await store(w).load()).toEqual({
            state: "ok",
            thermostats: EMPTY_THERMOSTAT_STATE,
          });
        });
      });
      describe("With a valid file holding an override", () => {
        it("ok with that override", async () => {
          const w = world();
          put(stateFile(w), { version: 1, ...thermostatStateToRaw(overrideState()) });
          expect(await store(w).load()).toEqual({ state: "ok", thermostats: overrideState() });
        });
      });
      describe("With bad JSON", () => {
        it("unreadable", async () => {
          const w = world();
          put(stateFile(w), "{ not json");
          expect((await store(w).load()).state).toBe("unreadable");
        });
        it("its reason is the JSON error", async () => {
          const w = world();
          put(stateFile(w), "{ not json");
          expect((await store(w).load()).reason).toMatch(/^SyntaxError: /);
        });
      });
      describe("With version 2", () => {
        it("unreadable", async () => {
          const w = world();
          put(stateFile(w), { version: 2, rooms: {}, valves: {} });
          expect((await store(w).load()).state).toBe("unreadable");
        });
        it("its reason names the version", async () => {
          const w = world();
          put(stateFile(w), { version: 2, rooms: {}, valves: {} });
          expect((await store(w).load()).reason).toContain("2");
        });
      });
      describe("With a valid file", () => {
        it("no reason", async () => {
          const w = world();
          put(stateFile(w), { version: 1, ...thermostatStateToRaw(overrideState()) });
          expect((await store(w).load()).reason).toBeUndefined();
        });
      });
      describe('With a room of kind "boost"', () => {
        it("unreadable", async () => {
          const w = world();
          const raw = thermostatStateToRaw(overrideState());
          const rooms = raw.rooms as Record<string, Record<string, unknown>>;
          const living = rooms.living_room ?? {};
          put(stateFile(w), {
            version: 1,
            ...raw,
            rooms: { living_room: { ...living, kind: "boost" } },
          });
          expect((await store(w).load()).state).toBe("unreadable");
        });
        it("its reason says the file holds no valid room state", async () => {
          const w = world();
          const raw = thermostatStateToRaw(overrideState());
          const rooms = raw.rooms as Record<string, Record<string, unknown>>;
          const living = rooms.living_room ?? {};
          put(stateFile(w), {
            version: 1,
            ...raw,
            rooms: { living_room: { ...living, kind: "boost" } },
          });
          expect((await store(w).load()).reason).toBe("the file holds no valid room state");
        });
      });
    });

    describe("save", () => {
      it("writes { version: 1, rooms, valves } and load reads it back", async () => {
        const w = world();
        const first = store(w);
        await first.load();
        await first.save(sampleThermostats());
        expect(Object.keys(jsonOf(stateFile(w)))).toEqual(["version", "rooms", "valves"]);
        expect(jsonOf(stateFile(w))).toEqual({
          version: 1,
          ...thermostatStateToRaw(sampleThermostats()),
        });
        expect(await store(w).load()).toEqual({ state: "ok", thermostats: sampleThermostats() });
      });
      describe("With a state holding a non-finite number", () => {
        it("rejects with a RangeError and the file is unchanged", async () => {
          const w = world();
          const saving = store(w);
          await saving.load();
          await saving.save(overrideState());
          const before = readFileSync(stateFile(w), "utf8");
          const living = overrideState().rooms.get("living_room");
          const broken: ThermostatState = {
            rooms: new Map([["living_room", { ...living, target: Number.NaN } as Thermostat]]),
            valves: new Map(),
          };
          expect(await rejectionOf(saving.save(broken))).toBeInstanceOf(RangeError);
          expect(readFileSync(stateFile(w), "utf8")).toBe(before);
        });
      });
      describe("While the loaded state is unreadable", () => {
        it("throws StoreLocked state and the file is unchanged", async () => {
          const w = world();
          put(stateFile(w), "junk");
          const locked = store(w);
          await locked.load();
          const error = await rejectionOf(locked.save(sampleThermostats()));
          expect(error).toBeInstanceOf(StoreLocked);
          expect((error as StoreLocked).data).toEqual({ store: "state" });
          expect(readFileSync(stateFile(w), "utf8")).toBe("junk");
        });
      });
    });

    describe("reset", () => {
      describe("With an unreadable file", () => {
        async function resetUnreadable() {
          const w = world();
          put(stateFile(w), "junk");
          const reset = store(w);
          await reset.load();
          await reset.reset();
          return { w, reset };
        }
        it("the file is set aside as state.unreadable.<stamp>.json", async () => {
          const { w } = await resetUnreadable();
          expect(setAsideNames(w.dataDir, "state")).toEqual([`state.unreadable.${STAMP}.json`]);
          expect(readFileSync(w.file(`state.unreadable.${STAMP}.json`), "utf8")).toBe("junk");
        });
        it("state.json holds an empty state", async () => {
          const { w } = await resetUnreadable();
          expect(jsonOf(stateFile(w))).toEqual({ version: 1, rooms: {}, valves: {} });
        });
        it("a later save succeeds", async () => {
          const { w, reset } = await resetUnreadable();
          await reset.save(overrideState());
          expect(await store(w).load()).toEqual({ state: "ok", thermostats: overrideState() });
        });
      });
    });
  });

  describe("migrateStateFile", () => {
    describe("With version 1", () => {
      it("returns the file unchanged", () => {
        const file = { version: 1, rooms: {}, valves: {} };
        expect(migrateStateFile(file)).toEqual(file);
      });
    });
    describe("With version 2 or no version", () => {
      it("throws", () => {
        expect(() => migrateStateFile({ version: 2, rooms: {}, valves: {} })).toThrow();
        expect(() => migrateStateFile({ rooms: {}, valves: {} })).toThrow();
      });
    });
  });
});
