import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { arbConfig, validRaw } from "../test/builders.ts";
import {
  EMPTY_LEDGER,
  LedgerError,
  ledgerFromRaw,
  ledgerToRaw,
  memberships,
  storedFromRaw,
  storedToRaw,
  withRecord,
  withoutRecord,
  type ConfigState,
  type Ledger,
  type Membership,
  type ReleasedRecord,
  type StoredConfig,
  type ValveRecord,
} from "./ledger.ts";
import { ConfigError, type Config } from "./model.ts";
import { SETTING_KEYS, type SettingKey, type SettingValue } from "./settings.ts";
import { validateConfig } from "./validation.ts";

const T0 = Temporal.Instant.from("2026-11-14T09:30:00Z").epochMilliseconds;
const V1 = "z2m:0x00124b0012345678";
const V2 = "z2m:0x00124b0087654321";

function record(valveId: string, over: Partial<ValveRecord> = {}): ValveRecord {
  return {
    valveId,
    profile: "sonoff_trvzb",
    adoptedAt: T0,
    originals: { sensor_source: "internal" },
    ...over,
  };
}

function ledgerOf(...records: ValveRecord[]): Ledger {
  return records.reduce(withRecord, EMPTY_LEDGER);
}

/** A config with one room holding the given valves. */
function configWith(valveIds: readonly string[]): Config {
  const config = validateConfig(validRaw());
  const room = config.rooms[0];
  if (room === undefined) throw new Error("builder has no room");
  return { ...config, rooms: [{ ...room, valves: valveIds.map((valveId) => ({ valveId })) }] };
}

function stored(inRoom: readonly string[], releasing: readonly string[] = []): StoredConfig {
  return {
    config: configWith(inRoom),
    revision: 1,
    releasing: new Map(releasing.map((id) => [id, T0])),
  };
}

// Arbitraries -----------------------------------------------------------------------------------

const address = fc
  .integer({ min: 0, max: 0xffff })
  .map((n) => `z2m:0x00124b00${n.toString(16).padStart(8, "0")}`);
const halfDegree = fc.integer({ min: 8, max: 70 }).map((n) => n / 2);
const arbDay = fc
  .array(fc.tuple(fc.integer({ min: 0, max: 1439 }), halfDegree), { maxLength: 12 })
  .map((pairs) =>
    pairs.map(([m, temperature]) => ({
      time: Temporal.PlainTime.from({ hour: Math.floor(m / 60), minute: m % 60 }),
      temperature,
    })),
  );
const arbValueFor = (key: SettingKey): fc.Arbitrary<SettingValue | null> => {
  const value: fc.Arbitrary<SettingValue> =
    key === "sensor_source"
      ? fc.constantFrom("internal" as const, "external" as const)
      : key === "active_group"
        ? fc.integer({ min: 1, max: 3 })
        : arbDay;
  return fc.option(value, { nil: null });
};
const arbOriginals = fc
  .subarray([...SETTING_KEYS])
  .chain((keys) =>
    fc
      .tuple(...keys.map(arbValueFor))
      .map((values) => Object.fromEntries(keys.map((k, i) => [k, values[i] ?? null]))),
  );
// Instants from 2000 to 2100, with milliseconds.
const arbInstant = fc.integer({ min: 946_684_800_000, max: 4_102_444_800_000 });
const arbRecord = (valveId: string): fc.Arbitrary<ValveRecord> =>
  fc.record({
    valveId: fc.constant(valveId),
    profile: fc.constantFrom("sonoff_trvzb", "sonoff_trv_zbt"),
    adoptedAt: arbInstant,
    originals: arbOriginals,
  });
const arbLedger: fc.Arbitrary<Ledger> = fc
  .tuple(
    fc.uniqueArray(address, { maxLength: 4 }),
    fc.array(
      fc
        .tuple(address, arbInstant, fc.boolean())
        .chain(([id, endedAt, forgotten]) =>
          arbRecord(id).map((r): ReleasedRecord => ({ record: r, endedAt, forgotten })),
        ),
      { maxLength: 5 },
    ),
  )
  .chain(([ids, released]) =>
    fc.tuple(...ids.map(arbRecord)).map((records) => ({
      records: new Map(records.map((r) => [r.valveId, r])),
      released,
    })),
  );
const arbStored: fc.Arbitrary<StoredConfig> = fc.record({
  config: arbConfig,
  revision: fc.nat(),
  releasing: fc
    .uniqueArray(fc.tuple(address, arbInstant), { selector: ([id]) => id, maxLength: 3 })
    .map((entries) => new Map(entries)),
});

/** The error `fn` throws, or undefined. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

function aRawLedger(): Record<string, unknown> {
  return {
    records: {
      [V1]: {
        profile: "sonoff_trvzb",
        adopted_at: "2026-11-14T09:30:00.000Z",
        originals: { sensor_source: "internal" },
      },
    },
    released: [],
  };
}

function aRawStored(): Record<string, unknown> {
  return {
    revision: 7,
    releasing: { [V1]: "2026-11-14T09:30:00.000Z" },
    config: validRaw(),
  };
}

// Tests -----------------------------------------------------------------------------------------

describe("ledger", () => {
  describe("withRecord", () => {
    describe("For a valve with no record", () => {
      it("the ledger holds the record", () => {
        const r = record(V1);
        expect(withRecord(EMPTY_LEDGER, r).records.get(V1)).toEqual(r);
      });
      it("the given ledger is not changed", () => {
        const before = ledgerOf(record(V2));
        withRecord(before, record(V1));
        expect([...before.records.keys()]).toEqual([V2]);
      });
    });
    describe("For a valve that has a record", () => {
      it("throws an Error", () => {
        expect(() => withRecord(ledgerOf(record(V1)), record(V1))).toThrow(Error);
      });
    });
  });

  describe("withoutRecord", () => {
    describe("With forgotten false", () => {
      it("the record is gone from records and first in released, with endedAt now and forgotten false", () => {
        const r = record(V1);
        const older: ReleasedRecord = { record: record(V2), endedAt: T0, forgotten: true };
        const ledger: Ledger = { records: new Map([[V1, r]]), released: [older] };
        const after = withoutRecord(ledger, V1, T0 + 5, false);
        expect(after.records.has(V1)).toBe(false);
        expect(after.released).toEqual([{ record: r, endedAt: T0 + 5, forgotten: false }, older]);
      });
    });
    describe("With forgotten true", () => {
      it("the released entry has forgotten true", () => {
        const after = withoutRecord(ledgerOf(record(V1)), V1, T0, true);
        expect(after.released[0]?.forgotten).toBe(true);
      });
    });
    describe("With 50 released records already", () => {
      it("the oldest is dropped", () => {
        const released = Array.from({ length: 50 }, (_, i): ReleasedRecord => ({
          record: record(V2),
          endedAt: T0 - i,
          forgotten: false,
        }));
        const ledger: Ledger = { records: new Map([[V1, record(V1)]]), released };
        const after = withoutRecord(ledger, V1, T0 + 1, false);
        expect(after.released).toHaveLength(50);
        expect(after.released[0]?.record.valveId).toBe(V1);
        expect(after.released.at(-1)?.endedAt).toBe(T0 - 48);
      });
    });
    describe("For a valve with no record", () => {
      it("the ledger is returned unchanged", () => {
        const ledger = ledgerOf(record(V2));
        expect(withoutRecord(ledger, V1, T0, false)).toBe(ledger);
      });
    });
  });

  describe("memberships", () => {
    describe("For each row of the membership table", () => {
      const rows: readonly (readonly [
        string,
        ConfigState,
        StoredConfig | undefined,
        Ledger | undefined,
        Membership,
      ])[] = [
        ["ok, in a room, record", "ok", stored([V1]), ledgerOf(record(V1)), "managed"],
        ["ok, in a room, no record", "ok", stored([V1]), EMPTY_LEDGER, "not_adopted"],
        ["ok, releasing only, record", "ok", stored([], [V1]), ledgerOf(record(V1)), "releasing"],
        ["ok, releasing only, no record", "ok", stored([], [V1]), EMPTY_LEDGER, "stray"],
        ["ok, neither, record", "ok", stored([]), ledgerOf(record(V1)), "orphan"],
        ["ok, ledger unreadable, in a room", "ok", stored([V1]), undefined, "frozen"],
        ["ok, ledger unreadable, releasing", "ok", stored([], [V1]), undefined, "frozen"],
        ["empty, record", "empty", undefined, ledgerOf(record(V1)), "frozen"],
        ["unreadable, record", "unreadable", undefined, ledgerOf(record(V1)), "frozen"],
      ];
      it.each(rows)("returns that membership (%s)", (_, state, config, ledger, expected) => {
        expect(memberships(state, config, ledger)).toEqual(new Map([[V1, expected]]));
      });
    });
    describe("With a valve in a room and in releasing", () => {
      it("returns managed", () => {
        const result = memberships("ok", stored([V1], [V1]), ledgerOf(record(V1)));
        expect(result.get(V1)).toBe("managed");
      });
    });
    describe("With state empty and no records", () => {
      it("returns an empty mapping", () => {
        expect(memberships("empty", undefined, EMPTY_LEDGER).size).toBe(0);
      });
    });
    describe("With state ok, the ledger unreadable, and a valve in neither a room nor releasing", () => {
      it("the valve is not in the result", () => {
        const result = memberships("ok", stored([V1]), undefined);
        expect(result.has(V2)).toBe(false);
        expect(result.size).toBe(1);
      });
    });
    describe("With state unreadable and the ledger unreadable", () => {
      it("returns an empty mapping", () => {
        expect(memberships("unreadable", undefined, undefined).size).toBe(0);
      });
    });
    describe("With state ok and stored undefined, and a ledger record", () => {
      it("returns frozen for that valve", () => {
        expect(memberships("ok", undefined, ledgerOf(record(V1))).get(V1)).toBe("frozen");
      });
    });
  });

  describe("ledgerFromRaw / ledgerToRaw", () => {
    describe("With any ledger, including 12-point days and unknown originals (fast-check)", () => {
      fcTest.prop([arbLedger])("ledgerFromRaw(ledgerToRaw(l)) equals l", (ledger) => {
        const raw: unknown = JSON.parse(JSON.stringify(ledgerToRaw(ledger)));
        expect(ledgerFromRaw(raw)).toEqual(ledger);
      });
    });
    describe("With a TRV-ZBT record holding active group 1 and an unknown sensor source", () => {
      it("the document holds active_group 1 and sensor_source null", () => {
        const r = record(V2, {
          profile: "sonoff_trv_zbt",
          originals: { active_group: 1, sensor_source: null },
        });
        const raw = ledgerToRaw(ledgerOf(r));
        expect(raw).toMatchObject({
          records: { [V2]: { originals: { active_group: 1, sensor_source: null } } },
        });
      });
    });
    describe("With a record", () => {
      it("adopted_at is ISO 8601 text in UTC with milliseconds", () => {
        const raw = ledgerToRaw(ledgerOf(record(V1, { adoptedAt: T0 + 7 })));
        expect(raw).toMatchObject({
          records: { [V1]: { adopted_at: "2026-11-14T09:30:00.007Z" } },
        });
      });
    });
    describe("With a document of the wrong shape", () => {
      fcTest.prop([fc.jsonValue()])("throws LedgerError, never another error", (raw) => {
        const error = thrown(() => ledgerFromRaw(raw));
        if (error !== undefined) expect(error).toBeInstanceOf(LedgerError);
      });
      it.each([
        ["not an object", 7, ""],
        ["a list", [], ""],
        ["records missing", { released: [] }, "records"],
        ["released not a list", { records: {}, released: {} }, "released"],
        ["an unknown top key", { ...aRawLedger(), extra: 1 }, "extra"],
        [
          "a record that is not an object",
          { records: { [V1]: "x" }, released: [] },
          `records.${V1}`,
        ],
        [
          "a released entry without valve_id",
          { records: {}, released: [{ profile: "p" }] },
          "released[0].valve_id",
        ],
      ])("throws LedgerError (%s)", (_, raw, path) => {
        const error = thrown(() => ledgerFromRaw(raw));
        expect(error).toBeInstanceOf(LedgerError);
        expect((error as LedgerError).path).toBe(path);
      });
    });
    describe("With an unknown setting key, a malformed day or a malformed instant", () => {
      const withRecordPart = (part: Record<string, unknown>): Record<string, unknown> => {
        const raw = aRawLedger();
        const records = raw.records as Record<string, Record<string, unknown>>;
        return { ...raw, records: { [V1]: { ...records[V1], ...part } } };
      };
      it.each([
        [
          "an unknown setting key",
          withRecordPart({ originals: { day_xyz: [] } }),
          `records.${V1}.originals.day_xyz`,
        ],
        [
          "a day that is not a list",
          withRecordPart({ originals: { day_mon: "00:00/17" } }),
          `records.${V1}.originals.day_mon`,
        ],
        [
          "a day pair with a bad time",
          withRecordPart({ originals: { day_mon: [["7:00", 17]] } }),
          `records.${V1}.originals.day_mon[0]`,
        ],
        [
          "a day pair with text",
          withRecordPart({ originals: { day_mon: [["07:00", "17"]] } }),
          `records.${V1}.originals.day_mon[0]`,
        ],
        [
          "a day pair of three",
          withRecordPart({ originals: { day_mon: [["07:00", 17, 1]] } }),
          `records.${V1}.originals.day_mon[0]`,
        ],
        [
          "a bad sensor source",
          withRecordPart({ originals: { sensor_source: "both" } }),
          `records.${V1}.originals.sensor_source`,
        ],
        [
          "a group that is text",
          withRecordPart({ originals: { active_group: "3" } }),
          `records.${V1}.originals.active_group`,
        ],
        [
          "an instant without ms",
          withRecordPart({ adopted_at: "2026-11-14T09:30:00Z" }),
          `records.${V1}.adopted_at`,
        ],
        [
          "an instant not in UTC",
          withRecordPart({ adopted_at: "2026-11-14T09:30:00.000+01:00" }),
          `records.${V1}.adopted_at`,
        ],
        [
          "an impossible instant",
          withRecordPart({ adopted_at: "2026-13-14T09:30:00.000Z" }),
          `records.${V1}.adopted_at`,
        ],
      ])("throws LedgerError (%s)", (_, raw, path) => {
        const error = thrown(() => ledgerFromRaw(raw));
        expect(error).toBeInstanceOf(LedgerError);
        expect((error as LedgerError).path).toBe(path);
      });
    });
    describe("With a value the reader would reject", () => {
      const sec = (text: string): ValveRecord["originals"] => ({
        day_mon: [{ time: Temporal.PlainTime.from(text), temperature: 17 }],
      });
      const released = (over: Partial<ReleasedRecord>): Ledger => ({
        records: new Map(),
        released: [{ record: record(V2), endedAt: T0, forgotten: false, ...over }],
      });
      it.each([
        ["a fractional group", ledgerOf(record(V1, { originals: { active_group: 1.5 } }))],
        [
          "a non-finite temperature",
          ledgerOf(
            record(V1, {
              originals: {
                day_mon: [{ time: Temporal.PlainTime.from("07:00"), temperature: Infinity }],
              },
            }),
          ),
        ],
        [
          "NaN as a temperature",
          ledgerOf(
            record(V1, {
              originals: {
                day_mon: [{ time: Temporal.PlainTime.from("07:00"), temperature: Number.NaN }],
              },
            }),
          ),
        ],
        ["a time with seconds", ledgerOf(record(V1, { originals: sec("07:00:30") }))],
        ["a fractional adoptedAt", ledgerOf(record(V1, { adoptedAt: T0 + 0.5 }))],
        ["a fractional endedAt", released({ endedAt: T0 + 0.5 })],
        [
          "a sensor source that is not internal or external",
          ledgerOf(record(V1, { originals: { sensor_source: "both" as "internal" } })),
        ],
        [
          "an unknown setting key",
          ledgerOf(
            record(V1, { originals: { day_xyz: 1 } as unknown as ValveRecord["originals"] }),
          ),
        ],
        [
          "a value of the wrong kind for its key",
          ledgerOf(record(V1, { originals: { active_group: "internal" } })),
        ],
      ])("throws a plain Error before anything is serialized (%s)", (_, ledger) => {
        const error = thrown(() => ledgerToRaw(ledger));
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(LedgerError);
        expect(error).not.toBeInstanceOf(RangeError);
      });
    });
  });

  describe("storedFromRaw / storedToRaw", () => {
    describe("With any stored config (fast-check)", () => {
      fcTest.prop([arbStored])("the round trip returns an equal value", (value) => {
        const raw: unknown = JSON.parse(JSON.stringify(storedToRaw(value)));
        expect(storedFromRaw(raw)).toEqual(value);
      });
    });
    describe("With an invalid config inside", () => {
      it("throws ConfigError", () => {
        const raw = { ...aRawStored(), config: { ...validRaw(), presets: { comfort: "warm" } } };
        const error = thrown(() => storedFromRaw(raw));
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).issues.map((i) => i.path)).toEqual([
          "config.presets.comfort",
        ]);
      });
    });
    describe("With a missing revision or a releasing entry that is not an instant", () => {
      it.each([
        ["a missing revision", { ...aRawStored(), revision: undefined }, "revision", "key_missing"],
        ["a revision that is text", { ...aRawStored(), revision: "7" }, "revision", "type_invalid"],
        [
          "a releasing entry that is not an instant",
          { ...aRawStored(), releasing: { [V1]: "yesterday" } },
          `releasing.${V1}`,
          "type_invalid",
        ],
        ["an unknown key", { ...aRawStored(), extra: 1 }, "extra", "key_unknown"],
      ])("throws ConfigError, never another error (%s)", (_, raw, path, code) => {
        const error = thrown(() => storedFromRaw(JSON.parse(JSON.stringify(raw))));
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).issues).toContainEqual(
          expect.objectContaining({ path, code }),
        );
      });
      fcTest.prop([fc.jsonValue()])(
        "throws ConfigError, never another error (any document)",
        (raw) => {
          const error = thrown(() => storedFromRaw(raw));
          if (error !== undefined) expect(error).toBeInstanceOf(ConfigError);
        },
      );
    });
  });
});
