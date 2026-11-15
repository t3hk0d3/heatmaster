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
import { EMPTY_LEDGER, ledgerToRaw } from "@heatmaster/core";
import type { Ledger } from "@heatmaster/core";
import { rejectionOf } from "../test/rejection.ts";
import { createManualClock } from "../test/manual-clock.ts";
import {
  SAMPLE_VALVE,
  ledgerWith,
  record,
  releasedOnly,
  sampleLedger,
  sampleStored,
} from "../test/store-samples.ts";
import { HeatmasterError } from "./errors.ts";
import {
  COPY_GENERATIONS,
  StoreLocked,
  createConfigStore,
  createLedgerStore,
  migrateConfigFile,
  migrateCopyFile,
  migrateLedgerFile,
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
        expect(await w.config.load()).toEqual({ state: "empty", stored: undefined });
      });
    });

    describe("With a file saved by save", () => {
      it("returns state ok and an equal StoredConfig", async () => {
        const w = world();
        await w.config.load();
        await w.config.save(sampleStored());
        expect(await w.config.load()).toEqual({ state: "ok", stored: sampleStored() });
      });
    });

    describe("With a file that is not valid JSON", () => {
      it("returns state unreadable and no stored config", async () => {
        const w = world();
        put(w.file("config.json"), "{ nope");
        expect(await w.config.load()).toEqual({ state: "unreadable", stored: undefined });
      });
    });

    describe("With a file whose version is 2", () => {
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
        put(w.file("config.json"), fixtureText("config.v1.json"));
        put(w.file("config.json.tmp"), "garbage");
        expect((await w.config.load()).state).toBe("ok");
      });
    });

    describe("With the fixture config.v1.json", () => {
      it("returns state ok and the expected StoredConfig", async () => {
        const w = world();
        put(w.file("config.json"), fixtureText("config.v1.json"));
        expect(await w.config.load()).toEqual({ state: "ok", stored: sampleStored() });
      });
    });
  });

  describe("save", () => {
    describe("After a load with no file", () => {
      it("the file holds version 1 and the stored document, and a second load returns an equal value", async () => {
        const w = world();
        await w.config.load();
        await w.config.save(sampleStored());
        const file = jsonOf(w.file("config.json"));
        expect(file.version).toBe(1);
        expect(file.data).toEqual(jsonOf(path.join(FIXTURES, "config.v1.json")).data);
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

    describe("After a good load", () => {
      it("the file holds the new document", async () => {
        const w = world();
        put(w.file("config.json"), fixtureText("config.v1.json"));
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
        put(w.file("config.json"), fixtureText("config.v1.json"));
        await w.config.load();
        await w.config.save({ ...sampleStored(), revision: 8 }, true);
        expect(setAsideNames(w.dataDir, "config")).toEqual([]);
        expect((await w.config.load()).stored?.revision).toBe(8);
      });
    });

    describe("With a directory standing where config.json.tmp must be written", () => {
      it("rejects with the file system's error and config.json is unchanged", async () => {
        const w = world();
        const text = fixtureText("config.v1.json");
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
        put(w.file("config.json"), fixtureText("config.v1.json"));
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
    });

    describe("With no ledger file, expected false, and an originals.json that holds one record (the store is locked)", () => {
      it("the copy's ledger is saved and returned, and later saves work", async () => {
        const w = world();
        put(w.copy("originals.json"), copyFile(ledgerWith(1)));
        expect(await w.ledger.load(false)).toBeUndefined();
        expect(await w.ledger.importCopy()).toEqual(ledgerWith(1));
        await w.ledger.save(ledgerWith(2));
        expect(SAMPLE_VALVE).toBeTypeOf("string");
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
    const migrations = [migrateConfigFile, migrateLedgerFile, migrateCopyFile];

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
