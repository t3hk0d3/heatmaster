import { describe, expect, it } from "vitest";
import {
  BUILDER_DAY,
  BUILDER_NOW,
  BUILDER_SCHEDULE,
  liveHouse,
  makeConfig,
  makeOriginals,
  makeSpec,
  makeState,
  makeWorld,
  membershipOf,
} from "../test/builders.ts";
import {
  ChangeRefused,
  capture,
  forgetValve,
  planChange,
  restoreValve,
  strandedValve,
  withHold,
} from "./change.ts";
import type { ChangeOptions, ChangePlan, ChangeRefusedCode, SensorInfo } from "./change.ts";
import type { DeviceView, Effect, World } from "./control.ts";
import { EMPTY_LEDGER, FRESH_STORED, withRecord } from "./ledger.ts";
import type { HaChangeItem, Ledger, StoredConfig, ValveRecord } from "./ledger.ts";
import { ConfigError } from "./model.ts";
import type { Room, SensorRef } from "./model.ts";
import type { DeviceState } from "./observation.ts";
import { DAY_KEYS } from "./settings.ts";
import type { SettingKey, SettingValues, ValveSpec } from "./settings.ts";
import type { SensorReading } from "./temperature.ts";
import { validateConfig } from "./validation.ts";
import type { RawConfig, RawRoomEntry, RawSensor } from "./validation.ts";

const V1 = "z2m:0x00124b0000000001";
const V2 = "z2m:0x00124b0000000002";
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const NOW_MS = BUILDER_NOW.epochMilliseconds;
const DAY_KEY_LIST: readonly SettingKey[] = Object.values(DAY_KEYS);

const BEDROOM_REF = "ha:sensor.bedroom";
const BEDROOM_SENSOR: RawSensor = { ref: BEDROOM_REF };
const BEDROOM_SENSOR_ID = BEDROOM_REF;
const BEDROOM_MODEL: SensorRef = { ref: BEDROOM_REF, weight: 1 };
const HA_SENSOR: RawSensor = { ref: "ha:sensor.living" };
const HA_SENSOR_ID = "ha:sensor.living";
const HA_MODEL: SensorRef = { ref: "ha:sensor.living", weight: 1 };

const HA_CHANGE_ITEM: HaChangeItem = {
  kind: "schedule",
  areaId: "living",
  entityId: undefined,
  scheduleId: BUILDER_SCHEDULE,
};

type Model = "trvzb" | "trv_zbt";

// Builders --------------------------------------------------------------------------------------

function sevenDays(): SettingValues {
  return Object.fromEntries(DAY_KEY_LIST.map((key) => [key, BUILDER_DAY]));
}

/** Every captured key observed: source internal, and active group 1 on TRV-ZBT. */
function observedValues(model: Model): SettingValues {
  return model === "trvzb"
    ? { sensor_source: "internal" }
    : { active_group: 1, sensor_source: "internal" };
}

function viewWith(model: Model, state: DeviceState | undefined): DeviceView {
  return { name: `valve ${model}`, spec: makeSpec(model), usable: true, state };
}

/** A usable view whose valve has sent a message holding `values`. */
function observedView(model: Model = "trvzb", values = observedValues(model)): DeviceView {
  return viewWith(model, makeState({ values }));
}

function record(valveId: string, model: Model = "trvzb"): ValveRecord {
  return {
    valveId,
    profile: makeSpec(model).profile,
    adoptedAt: NOW_MS - 24 * HOUR_MS,
    originals: makeOriginals(model),
  };
}

/** The world with its live house listing `valveIds` in notInHa. */
function notInHa(world: World, valveIds: readonly string[]): World {
  if (world.house.kind !== "live") throw new Error("the house is not live");
  return { ...world, house: { ...world.house, notInHa: valveIds } };
}

function ledgerOf(...records: readonly ValveRecord[]): Ledger {
  return records.reduce(withRecord, EMPTY_LEDGER);
}

function room(id: string, valveIds: readonly string[], sensors: readonly SensorRef[] = []): Room {
  return {
    id,
    name: id,
    scheduleId: BUILDER_SCHEDULE,
    valves: valveIds.map((valveId) => ({ valveId })),
    sensors,
    presets: { comfort: undefined, eco: undefined, frost: undefined, boost: undefined },
  };
}

/** A world with a readable config (revision 1) whose entries and live house hold `rooms`. */
function current(options: {
  rooms: readonly Room[];
  ledger?: Ledger | undefined;
  releasing?: ReadonlyMap<string, number>;
  devices?: ReadonlyMap<string, DeviceView>;
  timezone?: string | undefined;
}): World {
  const world = makeWorld({
    rooms: options.rooms,
    ledger: "ledger" in options ? options.ledger : EMPTY_LEDGER,
    devices: options.devices ?? new Map(),
  });
  const stored = storedOf(world);
  const settings = { ...stored.config.settings, timezone: options.timezone };
  return {
    ...world,
    stored: {
      ...stored,
      config: "timezone" in options ? { ...stored.config, settings } : stored.config,
      releasing: options.releasing ?? new Map(),
    },
  };
}

/**
 * A world with no config yet (state "empty"), an empty ledger, and a live house whose rooms are
 * `rooms` (by default the room `living` holding V1).
 */
function first(
  devices: ReadonlyMap<string, DeviceView> = new Map(),
  rooms: readonly Room[] = [room("living", [V1])],
): World {
  return makeWorld({ configState: "empty", stored: undefined, devices, house: liveHouse(rooms) });
}

/** The builder schedule (eco, comfort at 06:30, eco at 22:00 every day) and the given entries. */
function doc(
  entries: Readonly<Record<string, RawRoomEntry>> = {},
  options: { timezone?: string | undefined; eco?: number } = {},
): RawConfig {
  const day = { "00:00": "eco", "06:30": "comfort", "22:00": "eco" } as const;
  const timezone = "timezone" in options ? options.timezone : BUILDER_NOW.timeZoneId;
  return {
    version: 3,
    settings: {
      hold_writes: false,
      ...(timezone === undefined ? {} : { timezone }),
    },
    ...(options.eco === undefined ? {} : { presets: { eco: options.eco } }),
    schedules: [
      {
        id: BUILDER_SCHEDULE,
        name: "Default",
        week: [{ days: "all", temperature: day }],
      },
    ],
    default_schedule: BUILDER_SCHEDULE,
    rooms: { ...entries },
  };
}

/** The document with no schedule, no default schedule and no entry. */
function noSchedule(): RawConfig {
  return {
    version: 3,
    settings: { hold_writes: false, timezone: BUILDER_NOW.timeZoneId },
    schedules: [],
  };
}

function options(overrides: Partial<ChangeOptions> = {}): ChangeOptions {
  return {
    expectedRevision: undefined,
    dryRun: false,
    overwriteUnreadable: false,
    haLinked: true,
    ...overrides,
  };
}

const GOOD: SensorInfo = { exists: true, isTemperature: true, onValve: false };

function sensorsOf(entries: Readonly<Record<string, SensorInfo>> = {}): Map<string, SensorInfo> {
  return new Map(Object.entries(entries));
}

function devicesOf(entries: Readonly<Record<string, DeviceView>>): Map<string, DeviceView> {
  return new Map(Object.entries(entries));
}

function plan(
  world: World,
  raw: unknown,
  overrides: Partial<ChangeOptions> = {},
  sensors: ReadonlyMap<string, SensorInfo> = sensorsOf(),
): ChangePlan {
  return planChange(world, raw, options(overrides), sensors);
}

function refusal(run: () => unknown): ChangeRefused {
  try {
    run();
  } catch (error) {
    if (error instanceof ChangeRefused) return error;
    throw error;
  }
  throw new Error("expected ChangeRefused, got a result");
}

function codeOf(run: () => unknown): ChangeRefusedCode {
  return refusal(run).code;
}

function kinds(effects: readonly Effect[]): readonly string[] {
  return effects.map((effect) => effect.kind);
}

function storedOf(world: World): StoredConfig {
  if (world.stored === undefined) throw new Error("no stored config");
  return world.stored;
}

function savedConfig(effects: readonly Effect[]): StoredConfig {
  const save = effects.find((effect) => effect.kind === "saveConfig");
  if (save?.kind !== "saveConfig") throw new Error("no saveConfig");
  return save.stored;
}

function savedLedger(effects: readonly Effect[]): Ledger {
  const save = effects.find((effect) => effect.kind === "saveLedger");
  if (save?.kind !== "saveLedger") throw new Error("no saveLedger");
  return save.ledger;
}

// Tests -----------------------------------------------------------------------------------------

describe("change", () => {
  describe("capture", () => {
    describe("With a TRVZB whose days and source are observed", () => {
      const result = capture(
        V1,
        makeSpec("trvzb"),
        makeState({ values: { ...sevenDays(), sensor_source: "external" } }),
      );

      it("originals hold the sensor source only", () => {
        expect(result.originals).toEqual({ sensor_source: "external" });
      });

      it("unreadable is empty", () => {
        expect(result.unreadable).toEqual([]);
      });
    });

    describe("With a TRVZB whose source is not observed", () => {
      it("the source is null and listed in unreadable", () => {
        const result = capture(V1, makeSpec("trvzb"), makeState({ values: sevenDays() }));
        expect(result.originals).toEqual({ sensor_source: null });
        expect(result.unreadable).toEqual(["sensor_source"]);
      });
    });

    describe("With a TRVZB whose Tuesday is not observed and whose source is", () => {
      it("unreadable is empty", () => {
        const days = Object.entries(sevenDays()).filter(([key]) => key !== "day_tue");
        const values = { ...Object.fromEntries(days), sensor_source: "internal" } as SettingValues;
        const state = makeState({ values });
        expect(capture(V1, makeSpec("trvzb"), state).unreadable).toEqual([]);
      });
    });

    describe("With a TRV-ZBT", () => {
      const state = makeState({
        values: { ...sevenDays(), active_group: 1, sensor_source: "internal" },
      });
      const result = capture(V1, makeSpec("trv_zbt"), state);

      it("active_group and sensor_source are captured", () => {
        expect(result.originals).toEqual({ active_group: 1, sensor_source: "internal" });
      });

      it("originals hold no day key", () => {
        expect(Object.keys(result.originals).filter((key) => key.startsWith("day_"))).toEqual([]);
      });
    });

    describe("With state undefined", () => {
      it("every captured key is null and listed in unreadable", () => {
        const result = capture(V1, makeSpec("trv_zbt"), undefined);
        expect(result.originals).toEqual({ active_group: null, sensor_source: null });
        expect(result.unreadable).toEqual(["active_group", "sensor_source"]);
      });
    });

    describe("With a spec that has no captured group", () => {
      it("originals and unreadable are empty", () => {
        const base = makeSpec("trv_zbt");
        const spec: ValveSpec = {
          ...base,
          groups: base.groups.map((group) => ({ ...group, capture: false })),
        };
        const result = capture(V1, spec, makeState({ values: observedValues("trv_zbt") }));
        expect(result.originals).toEqual({});
        expect(result.unreadable).toEqual([]);
      });
    });
  });

  describe("planChange", () => {
    describe("With the first document with a schedule, over a live house with two rooms of observable valves", () => {
      const world = first(devicesOf({ [V1]: observedView(), [V2]: observedView() }), [
        room("living", [V1]),
        room("bedroom", [V2]),
      ]);
      const result = plan(world, doc());

      it("joining holds both captures", () => {
        expect(result.joining).toEqual([
          { valveId: V1, originals: { sensor_source: "internal" }, unreadable: [] },
          { valveId: V2, originals: { sensor_source: "internal" }, unreadable: [] },
        ]);
      });

      it("effects hold saveConfig only and the revision is 1", () => {
        expect(result.effects).toEqual([{ kind: "saveConfig", stored: result.stored }]);
        expect(result.stored.revision).toBe(1);
      });

      it("writes lists both valves' days", () => {
        expect(result.writes).toEqual([
          { valveId: V1, values: sevenDays(), current: {} },
          { valveId: V2, values: sevenDays(), current: {} },
        ]);
      });
    });

    describe("With dryRun true", () => {
      it("effects is empty and joining, pending and writes are filled", () => {
        const world = first(
          devicesOf({ [V1]: observedView(), [V2]: viewWith("trvzb", undefined) }),
          [room("living", [V1, V2])],
        );
        const result = plan(world, doc(), { dryRun: true });
        expect(result.effects).toEqual([]);
        expect(result.joining.map((c) => c.valveId)).toEqual([V1]);
        expect(result.pending.map((p) => p.valveId)).toEqual([V2]);
        expect(result.writes.map((w) => w.valveId)).toEqual([V1]);
      });
    });

    describe("With a room whose valve has not reported", () => {
      it("pending lists it with valve_not_observed and a plan is returned", () => {
        const world = first(devicesOf({ [V1]: viewWith("trvzb", undefined) }));
        const result = plan(world, doc());
        expect(result.pending).toEqual([
          { valveId: V1, roomId: "living", reason: "valve_not_observed", unreadable: [] },
        ]);
        expect(result.joining).toEqual([]);
        expect(result.stored.revision).toBe(1);
      });
    });

    describe("With a document with no schedule while the house has a room", () => {
      it("throws ChangeRefused schedule_in_use with that room's id", () => {
        const world = current({
          rooms: [room("office", [V2]), room("bedroom", [V1])],
          ledger: ledgerOf(record(V1), record(V2)),
        });
        const refused = refusal(() => plan(world, noSchedule()));
        expect(refused.code).toBe("schedule_in_use");
        expect(refused.data).toEqual({ roomId: "bedroom" });
      });
    });

    describe("With a document with no schedule and no room", () => {
      it("returns a plan", () => {
        const result = plan(current({ rooms: [] }), noSchedule());
        expect(result.stored.config.schedules).toEqual([]);
        expect(result.stored.revision).toBe(2);
      });
    });

    describe("With a version 2 document", () => {
      it("throws ConfigError version_unsupported", () => {
        let caught: unknown;
        try {
          plan(current({ rooms: [] }), { ...doc(), version: 2 });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).issues).toContainEqual(
          expect.objectContaining({ path: "version", code: "version_unsupported" }),
        );
      });
    });

    describe("With a current stored config holding a membership, HA changes, an upgrade report and a releasing valve", () => {
      it("stored keeps all four", () => {
        const base = current({
          rooms: [room("living", [V1])],
          ledger: ledgerOf(record(V1), record(V2)),
          releasing: new Map([[V2, NOW_MS - HOUR_MS]]),
        });
        const kept = {
          membership: storedOf(base).membership,
          haChanges: [{ revision: 1, at: NOW_MS - HOUR_MS, items: [HA_CHANGE_ITEM] }],
          upgrade: { fromVersion: 2 as const, droppedRooms: [] },
          releasing: new Map([[V2, NOW_MS - HOUR_MS]]),
        };
        const world: World = { ...base, stored: { ...storedOf(base), ...kept } };
        const result = plan(world, doc({}, { eco: 16 }));
        expect(kept.membership?.rooms.has("living")).toBe(true);
        expect(result.stored).toMatchObject(kept);
      });
    });

    describe("With a schedule edit only", () => {
      const days = { ...sevenDays(), sensor_source: "internal" as const };
      const world = current({
        rooms: [room("living", [V1])],
        ledger: ledgerOf(record(V1)),
        devices: devicesOf({ [V1]: observedView("trvzb", days) }),
      });
      const result = plan(world, doc({}, { eco: 16 }));

      it("joining and pending are empty and writes lists the changed days", () => {
        expect(result.joining).toEqual([]);
        expect(result.pending).toEqual([]);
        expect(result.writes.map((w) => w.valveId)).toEqual([V1]);
        expect(Object.keys(result.writes[0]?.values ?? {}).sort()).toEqual(
          [...DAY_KEY_LIST].sort(),
        );
        expect(result.writes[0]?.values).not.toEqual(sevenDays());
      });
    });

    describe("With a sensor that only an unused entry names, unknown to Home Assistant", () => {
      it("throws ChangeRefused sensor_unknown", () => {
        const world = current({ rooms: [room("living", [V1])], ledger: ledgerOf(record(V1)) });
        const refused = refusal(() => plan(world, doc({ attic: { sensors: [BEDROOM_SENSOR] } })));
        expect(refused.code).toBe("sensor_unknown");
        expect(refused.data).toEqual({ sensor: BEDROOM_SENSOR_ID });
      });
    });

    describe("With config state unreadable and overwriteUnreadable", () => {
      it("stored is FRESH_STORED with the new config and revision 1", () => {
        const world = makeWorld({
          configState: "unreadable",
          stored: { ...FRESH_STORED, config: makeConfig(), revision: 4 },
          ledger: ledgerOf(record(V2)),
          devices: devicesOf({ [V1]: observedView() }),
          house: liveHouse([room("living", [V1])]),
        });
        const raw = doc();
        const result = plan(world, raw, { overwriteUnreadable: true });
        expect(result.stored).toEqual({
          ...FRESH_STORED,
          config: validateConfig(raw),
          revision: 1,
          importedAreas: ["living"],
        });
      });

      it("every room of the house and every entry of the document count as imported: the import does not run again", () => {
        const world = makeWorld({
          configState: "unreadable",
          stored: undefined,
          house: {
            kind: "frozen",
            membership: membershipOf([room("living", [V1])]),
            reason: "link_down",
          },
        });
        const result = plan(world, doc({ bedroom: {} }), { overwriteUnreadable: true });
        expect(result.stored.importedAreas).toEqual(["bedroom", "living"]);
      });
    });

    describe("With config state empty (a fresh install's first apply)", () => {
      it("no area counts as imported", () => {
        expect(plan(first(), doc({ living: {} })).stored.importedAreas).toEqual([]);
      });
    });

    describe("With a document holding hold_writes false", () => {
      it("stored has writes released", () => {
        const base = current({ rooms: [] });
        const stored = storedOf(base);
        const held = {
          ...stored.config,
          settings: { ...stored.config.settings, holdWrites: true },
        };
        const world: World = { ...base, stored: { ...stored, config: held } };
        expect(plan(world, doc()).stored.config.settings.holdWrites).toBe(false);
      });
    });

    describe("With two new valves held by the house in descending id order", () => {
      it("joining lists them in ascending id order", () => {
        const world = first(devicesOf({ [V1]: observedView(), [V2]: observedView() }), [
          room("living", [V2, V1]),
        ]);
        const result = plan(world, doc({ living: {} }));
        expect(result.joining.map((c) => c.valveId)).toEqual([V1, V2]);
      });
    });

    describe("With an invalid document", () => {
      it("throws ConfigError and returns nothing", () => {
        const world = first(devicesOf({ [V1]: observedView() }));
        const raw = { version: 3, presets: { eco: "warm" }, rooms: "none" };
        let caught: unknown;
        let result: ChangePlan | undefined;
        try {
          result = plan(world, raw);
        } catch (error) {
          caught = error;
        }
        expect(result).toBeUndefined();
        expect(caught).toBeInstanceOf(ConfigError);
        const paths = (caught as ConfigError).issues.map((issue) => issue.path);
        expect(paths).toEqual(expect.arrayContaining(["presets.eco", "rooms"]));
      });
    });

    describe("With an out-of-date expectedRevision", () => {
      it("throws ChangeRefused revision_conflict with both revisions in data", () => {
        const world = current({ rooms: [] });
        const refused = refusal(() => plan(world, doc(), { expectedRevision: 0 }));
        expect(refused.code).toBe("revision_conflict");
        expect(refused.data).toEqual({ expected: "0", current: "1" });
      });
    });

    describe('With config state "unreadable"', () => {
      it("throws ChangeRefused config_unreadable", () => {
        const world = makeWorld({
          configState: "unreadable",
          stored: undefined,
          ledger: ledgerOf(record(V2)),
          devices: devicesOf({ [V1]: observedView() }),
          house: liveHouse([room("living", [V1])]),
        });
        expect(codeOf(() => plan(world, doc({ living: {} })))).toBe("config_unreadable");
      });
    });

    describe('With config state "ok" and no stored config', () => {
      it("throws ChangeRefused config_unreadable", () => {
        const world = makeWorld({
          stored: undefined,
          devices: devicesOf({ [V1]: observedView() }),
        });
        expect(codeOf(() => plan(world, doc({ living: {} })))).toBe("config_unreadable");
      });
    });

    describe("With the ledger unreadable and a new valve", () => {
      it("pending lists it with ledger_unreadable and a plan is returned", () => {
        const world: World = { ...first(devicesOf({ [V1]: observedView() })), ledger: undefined };
        const result = plan(world, doc({ living: {} }));
        expect(result.pending).toEqual([
          { valveId: V1, roomId: "living", reason: "ledger_unreadable", unreadable: [] },
        ]);
        expect(result.joining).toEqual([]);
      });
    });

    describe("With the ledger unreadable and only a schedule edit", () => {
      it("returns a plan with saveConfig only", () => {
        const world = current({ rooms: [room("living", [V2])], ledger: undefined });
        const result = plan(world, doc({ living: {} }, { eco: 16 }));
        expect(kinds(result.effects)).toEqual(["saveConfig"]);
      });
    });

    describe("With a new TRVZB whose days are not observed and whose source is", () => {
      it("returns a plan", () => {
        const world = first(
          devicesOf({ [V1]: observedView("trvzb", { sensor_source: "internal" }) }),
        );
        expect(plan(world, doc({ living: {} })).joining).toHaveLength(1);
      });
    });

    describe("With a new TRV-ZBT whose active group is 3", () => {
      it("returns a plan and the captured original active group is 3", () => {
        const view = observedView("trv_zbt", { active_group: 3, sensor_source: "internal" });
        const result = plan(first(devicesOf({ [V1]: view })), doc({ living: {} }));
        expect(result.joining[0]?.originals.active_group).toBe(3);
      });
    });

    describe('With a first config while configState is "empty"', () => {
      it("writes lists the valve's writes (the preview does not see it as frozen)", () => {
        const world = first(devicesOf({ [V1]: observedView() }));
        const result = plan(world, doc({ living: {} }));
        expect(result.writes.map((w) => w.valveId)).toEqual([V1]);
      });
    });

    describe("With a first config whose entry has a sensor with a value", () => {
      it('the previewed sensor source is "external"', () => {
        const reading: SensorReading = {
          sensorId: BEDROOM_SENSOR_ID,
          value: 20,
          seenAt: NOW_MS,
          pending: false,
        };
        const world: World = {
          ...first(devicesOf({ [V1]: observedView() })),
          sensors: new Map([[BEDROOM_SENSOR_ID, reading]]),
        };
        const result = plan(
          world,
          doc({ living: { sensors: [BEDROOM_SENSOR] } }),
          {},
          sensorsOf({ [BEDROOM_SENSOR_ID]: GOOD }),
        );
        const source = result.writes.find((w) => "sensor_source" in w.values);
        expect(source?.values.sensor_source).toBe("external");
      });
    });

    describe("With a new valve whose days already equal the room's schedule", () => {
      it("writes still lists the seven days", () => {
        const values = { ...sevenDays(), sensor_source: "internal" as const };
        const world = first(devicesOf({ [V1]: observedView("trvzb", values) }));
        const result = plan(world, doc({ living: {} }));
        expect(result.writes.map((w) => w.values)).toContainEqual(sevenDays());
      });
    });

    describe("With a managed valve that has no DeviceView and only a schedule edit", () => {
      it("returns a plan", () => {
        const world = current({ rooms: [room("living", [V1])], ledger: ledgerOf(record(V1)) });
        const result = plan(world, doc({ living: {} }, { eco: 16 }));
        expect(result.stored.revision).toBe(2);
      });
    });

    describe("With no timezone in the document, no current config and haLinked false", () => {
      it("throws ChangeRefused timezone_missing", () => {
        const world = first(devicesOf({ [V1]: observedView() }));
        const raw = doc({ living: {} }, { timezone: undefined });
        expect(codeOf(() => plan(world, raw, { haLinked: false }))).toBe("timezone_missing");
      });
    });

    describe("With no timezone in the document, a fresh install's stored config and haLinked false", () => {
      it("throws ChangeRefused timezone_missing (the fresh install's empty config does not run)", () => {
        const world: World = {
          ...first(devicesOf({ [V1]: observedView() })),
          configState: "ok",
          stored: FRESH_STORED,
        };
        const raw = doc({ living: {} }, { timezone: undefined });
        expect(codeOf(() => plan(world, raw, { haLinked: false }))).toBe("timezone_missing");
      });
    });

    describe("With no timezone in the document, haLinked false, and a fresh install raised to revision 1 without a schedule", () => {
      const raised = (stored: StoredConfig): World => ({
        ...first(devicesOf({ [V1]: observedView() })),
        configState: "ok",
        stored,
      });
      const raw = doc({ living: {} }, { timezone: undefined });

      it("throws ChangeRefused timezone_missing after the hold was released", () => {
        const world = raised(withHold(FRESH_STORED, false));
        expect(world.stored?.revision).toBe(1);
        expect(codeOf(() => plan(world, raw, { haLinked: false }))).toBe("timezone_missing");
      });

      it("throws ChangeRefused timezone_missing after the sensor import raised it", () => {
        const world = raised({ ...FRESH_STORED, revision: 1, importedAreas: ["living"] });
        expect(codeOf(() => plan(world, raw, { haLinked: false }))).toBe("timezone_missing");
      });
    });

    describe("With no timezone in the document and haLinked true", () => {
      it("returns a plan", () => {
        const world = first(devicesOf({ [V1]: observedView() }));
        const raw = doc({ living: {} }, { timezone: undefined });
        expect(plan(world, raw, { haLinked: true }).stored.config.settings.timezone).toBe(
          undefined,
        );
      });
    });

    describe("With no timezone in the document or in the current config, haLinked false and only a schedule edit", () => {
      it("returns a plan", () => {
        const world = current({
          rooms: [room("living", [V1])],
          ledger: ledgerOf(record(V1)),
          timezone: undefined,
        });
        const raw = doc({ living: {} }, { timezone: undefined, eco: 16 });
        expect(plan(world, raw, { haLinked: false }).stored.revision).toBe(2);
      });
    });

    describe("With no timezone in the document, no current config, haLinked false and an out-of-date expectedRevision", () => {
      it("throws ChangeRefused revision_conflict (it comes first)", () => {
        const raw = doc({}, { timezone: undefined });
        const refused = refusal(() => plan(first(), raw, { haLinked: false, expectedRevision: 3 }));
        expect(refused.code).toBe("revision_conflict");
        expect(refused.data).toEqual({ expected: "3", current: "0" });
      });
    });

    describe("With a new sensor that has no entry in sensors / is not a temperature sensor / is on a valve", () => {
      const world = first(devicesOf({ [V1]: observedView() }));
      const raw = doc({ living: { sensors: [BEDROOM_SENSOR] } });

      it("throws ChangeRefused sensor_unknown, with the sensor id in data", () => {
        const missing = refusal(() => plan(world, raw));
        expect(missing.code).toBe("sensor_unknown");
        expect(missing.data).toEqual({ sensor: BEDROOM_SENSOR_ID });
        const gone = refusal(() =>
          plan(world, raw, {}, sensorsOf({ [BEDROOM_SENSOR_ID]: { ...GOOD, exists: false } })),
        );
        expect(gone.code).toBe("sensor_unknown");
      });

      it("throws ChangeRefused sensor_not_temperature, with the sensor id in data", () => {
        const refused = refusal(() =>
          plan(
            world,
            raw,
            {},
            sensorsOf({ [BEDROOM_SENSOR_ID]: { ...GOOD, isTemperature: false } }),
          ),
        );
        expect(refused.code).toBe("sensor_not_temperature");
        expect(refused.data).toEqual({ sensor: BEDROOM_SENSOR_ID });
      });

      it("throws ChangeRefused sensor_on_valve, with the sensor id in data", () => {
        const refused = refusal(() =>
          plan(world, raw, {}, sensorsOf({ [BEDROOM_SENSOR_ID]: { ...GOOD, onValve: true } })),
        );
        expect(refused.code).toBe("sensor_on_valve");
        expect(refused.data).toEqual({ sensor: BEDROOM_SENSOR_ID });
      });
    });

    describe('With a new "ha:" sensor and haLinked false', () => {
      it("throws ChangeRefused ha_link_missing, also when sensors has no entry for it", () => {
        const world = first(devicesOf({ [V1]: observedView() }));
        const raw = doc({ living: { sensors: [HA_SENSOR] } });
        const known = refusal(() =>
          plan(world, raw, { haLinked: false }, sensorsOf({ [HA_SENSOR_ID]: GOOD })),
        );
        expect(known.code).toBe("ha_link_missing");
        expect(known.data).toEqual({ sensor: HA_SENSOR_ID });
        expect(codeOf(() => plan(world, raw, { haLinked: false }))).toBe("ha_link_missing");
      });
    });

    describe('With an "ha:" sensor that an entry of the current config already lists, haLinked false, and only a schedule edit', () => {
      it("returns a plan", () => {
        const world = current({
          rooms: [room("living", [V1], [HA_MODEL])],
          ledger: ledgerOf(record(V1)),
        });
        const raw = doc({ living: { sensors: [HA_SENSOR] } }, { eco: 16 });
        expect(plan(world, raw, { haLinked: false }).stored.revision).toBe(2);
      });
    });

    describe("With a sensor of the current config that has no entry in sensors, and only a schedule edit", () => {
      it("returns a plan", () => {
        const world = current({
          rooms: [room("living", [V1], [BEDROOM_MODEL])],
          ledger: ledgerOf(record(V1)),
        });
        const raw = doc({ living: { sensors: [BEDROOM_SENSOR] } }, { eco: 16 });
        expect(plan(world, raw).stored.revision).toBe(2);
      });
    });

    describe("With a sensor of the current config whose isTemperature is now false, moved to another entry", () => {
      it("returns a plan", () => {
        const world = current({
          rooms: [room("living", [V1], [BEDROOM_MODEL]), room("bedroom", [V2])],
          ledger: ledgerOf(record(V1), record(V2)),
        });
        const raw = doc({ living: {}, bedroom: { sensors: [BEDROOM_SENSOR] } });
        const sensors = sensorsOf({ [BEDROOM_SENSOR_ID]: { ...GOOD, isTemperature: false } });
        expect(plan(world, raw, {}, sensors).stored.revision).toBe(2);
      });
    });

    describe('With config state "unreadable", overwriteUnreadable, an "ha:" sensor and haLinked false', () => {
      it("throws ChangeRefused ha_link_missing (with no readable config every sensor is new)", () => {
        const world = makeWorld({
          configState: "unreadable",
          stored: {
            ...FRESH_STORED,
            config: makeConfig({ rooms: [room("living", [V1], [HA_MODEL])] }),
            revision: 4,
          },
          ledger: ledgerOf(record(V1)),
          devices: devicesOf({ [V1]: observedView() }),
        });
        const raw = doc({ living: { sensors: [HA_SENSOR] } });
        const run = (): ChangePlan =>
          plan(world, raw, { overwriteUnreadable: true, haLinked: false });
        expect(codeOf(run)).toBe("ha_link_missing");
      });
    });

    describe("Always", () => {
      it('a caller cannot set releasing: a "releasing" key in the document is a ConfigError key_unknown', () => {
        const raw = { ...doc(), releasing: { [V1]: "2026-11-16T11:00:00.000Z" } };
        let caught: unknown;
        try {
          plan(first(), raw);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).issues).toContainEqual(
          expect.objectContaining({ path: "releasing", code: "key_unknown" }),
        );
      });
    });
  });

  describe("restoreValve", () => {
    describe("For an orphan", () => {
      it("saveConfig with the valve in releasing at the time now", () => {
        const world = current({ rooms: [], ledger: ledgerOf(record(V1)) });
        const stored = storedOf(world);
        expect(restoreValve(world, V1)).toEqual([
          { kind: "saveConfig", stored: { ...stored, releasing: new Map([[V1, NOW_MS]]) } },
        ]);
      });
    });

    describe("For a managed valve", () => {
      it("throws ChangeRefused valve_not_orphan", () => {
        const world = current({ rooms: [room("living", [V1])], ledger: ledgerOf(record(V1)) });
        const refused = refusal(() => restoreValve(world, V1));
        expect(refused.code).toBe("valve_not_orphan");
        expect(refused.data).toEqual({ valveId: V1 });
      });
    });

    describe("With a live house and a recorded valve that is in no room", () => {
      it("the result is plan 1's, with the rooms taken from the live house", () => {
        const world = current({
          rooms: [room("living", [V2])],
          ledger: ledgerOf(record(V1), record(V2)),
        });
        const stored = storedOf(world);
        expect(restoreValve(world, V1)).toEqual([
          { kind: "saveConfig", stored: { ...stored, releasing: new Map([[V1, NOW_MS]]) } },
        ]);
        expect(codeOf(() => restoreValve(world, V2))).toBe("valve_not_orphan");
      });
    });

    describe("With house unlinked", () => {
      it("it is refused as a frozen valve is refused today", () => {
        const world: World = {
          ...current({ rooms: [], ledger: ledgerOf(record(V1)) }),
          house: { kind: "unlinked" },
        };
        expect(codeOf(() => restoreValve(world, V1))).toBe("valve_not_orphan");
      });
    });
  });

  describe("forgetValve", () => {
    const releasingWorld = (): World =>
      current({
        rooms: [room("living", [V2])],
        ledger: ledgerOf(record(V1), record(V2)),
        releasing: new Map([[V1, NOW_MS - HOUR_MS]]),
      });

    describe("For a releasing valve", () => {
      it("saveLedger with the record in released and forgotten true, writeOriginalsCopy, saveConfig without it in releasing", () => {
        const world = releasingWorld();
        const effects = forgetValve(world, V1);
        expect(kinds(effects)).toEqual(["saveLedger", "writeOriginalsCopy", "saveConfig"]);
        const ledger = savedLedger(effects);
        expect(ledger.records.has(V1)).toBe(false);
        expect(ledger.released[0]).toEqual({
          record: record(V1),
          endedAt: NOW_MS,
          forgotten: true,
        });
        expect(effects[1]).toEqual({ kind: "writeOriginalsCopy", ledger });
        expect(savedConfig(effects).releasing.has(V1)).toBe(false);
      });
    });

    describe("For an orphan", () => {
      it("saveLedger and writeOriginalsCopy only", () => {
        const world = current({ rooms: [], ledger: ledgerOf(record(V1)) });
        expect(kinds(forgetValve(world, V1))).toEqual(["saveLedger", "writeOriginalsCopy"]);
      });
    });

    describe("For a managed valve", () => {
      it("throws ChangeRefused valve_managed", () => {
        const world = current({ rooms: [room("living", [V1])], ledger: ledgerOf(record(V1)) });
        expect(codeOf(() => forgetValve(world, V1))).toBe("valve_managed");
      });
    });

    describe("For a managed valve in notInHa that no transport lists", () => {
      const strandedWorld = (devices: ReadonlyMap<string, DeviceView> = new Map()): World => {
        const world = current({
          rooms: [room("living", [V1, V2])],
          ledger: ledgerOf(record(V1), record(V2)),
          devices,
        });
        return notInHa(world, [V1]);
      };

      it("saveLedger without its record, then writeOriginalsCopy", () => {
        const effects = forgetValve(strandedWorld(), V1);
        expect(kinds(effects)).toEqual(["saveLedger", "writeOriginalsCopy"]);
        const ledger = savedLedger(effects);
        expect(ledger.records.has(V1)).toBe(false);
        expect(ledger.records.has(V2)).toBe(true);
        expect(effects[1]).toEqual({ kind: "writeOriginalsCopy", ledger });
      });

      it("strandedValve is true for it", () => {
        const world = strandedWorld();
        expect(strandedValve(world.house, V1, false)).toBe(true);
      });
    });

    describe("For a managed valve in notInHa that a transport still lists", () => {
      it("throws ChangeRefused valve_managed", () => {
        const world = current({
          rooms: [room("living", [V1])],
          ledger: ledgerOf(record(V1)),
          devices: new Map([[V1, observedView()]]),
        });
        const listed = notInHa(world, [V1]);
        expect(codeOf(() => forgetValve(listed, V1))).toBe("valve_managed");
        expect(strandedValve(listed.house, V1, true)).toBe(false);
      });
    });

    describe("For a managed valve no transport lists that Home Assistant has", () => {
      it("throws ChangeRefused valve_managed", () => {
        const world = current({ rooms: [room("living", [V1])], ledger: ledgerOf(record(V1)) });
        expect(codeOf(() => forgetValve(world, V1))).toBe("valve_managed");
        expect(strandedValve(world.house, V1, false)).toBe(false);
      });
    });

    describe("For a valve with no record", () => {
      it("throws ChangeRefused valve_unknown", () => {
        const world = current({ rooms: [room("living", [V2])], ledger: ledgerOf(record(V2)) });
        const refused = refusal(() => forgetValve(world, V1));
        expect(refused.code).toBe("valve_unknown");
        expect(refused.data).toEqual({ valveId: V1 });
      });
    });

    describe("While the config is unreadable", () => {
      it("throws ChangeRefused config_unreadable", () => {
        const world = makeWorld({
          configState: "unreadable",
          stored: undefined,
          ledger: ledgerOf(record(V1)),
        });
        expect(codeOf(() => forgetValve(world, V1))).toBe("config_unreadable");
      });
    });

    describe("While the ledger and the config are both unreadable", () => {
      it("throws ChangeRefused config_unreadable", () => {
        const world = makeWorld({
          configState: "unreadable",
          stored: undefined,
          ledger: undefined,
        });
        expect(codeOf(() => forgetValve(world, V1))).toBe("config_unreadable");
      });
    });

    describe('For a valve with a record while configState is "empty"', () => {
      it("throws ChangeRefused config_unreadable", () => {
        const world = makeWorld({
          configState: "empty",
          stored: undefined,
          ledger: ledgerOf(record(V1)),
        });
        expect(codeOf(() => forgetValve(world, V1))).toBe("config_unreadable");
      });
    });

    describe("While the ledger is unreadable", () => {
      it("throws ChangeRefused ledger_unreadable", () => {
        const world = current({ rooms: [], ledger: undefined, releasing: new Map([[V1, NOW_MS]]) });
        expect(codeOf(() => forgetValve(world, V1))).toBe("ledger_unreadable");
      });
    });

    describe("Always", () => {
      it("the saveConfig keeps the revision", () => {
        const world = releasingWorld();
        const saved = savedConfig(forgetValve(world, V1));
        expect(saved.revision).toBe(storedOf(world).revision);
        expect(saved.config).toBe(storedOf(world).config);
      });
    });

    describe("With a live house and a recorded valve", () => {
      it("the result is plan 1's, with the rooms taken from the live house", () => {
        const world = current({
          rooms: [room("living", [V2])],
          ledger: ledgerOf(record(V1), record(V2)),
        });
        expect(kinds(forgetValve(world, V1))).toEqual(["saveLedger", "writeOriginalsCopy"]);
        expect(codeOf(() => forgetValve(world, V2))).toBe("valve_managed");
      });
    });

    describe("With house unlinked", () => {
      it("it is refused as a frozen valve is refused today", () => {
        const world: World = {
          ...current({ rooms: [room("living", [V1])], ledger: ledgerOf(record(V1)) }),
          house: { kind: "unlinked" },
        };
        expect(codeOf(() => forgetValve(world, V1))).toBe("config_unreadable");
      });
    });
  });

  describe("withHold", () => {
    const storedWith = (
      holdWrites: boolean,
      releasing = new Map<string, number>(),
    ): StoredConfig => {
      const config = makeConfig({ rooms: [room("living", [V2])], holdWrites });
      return { ...FRESH_STORED, config, revision: 5, releasing };
    };

    describe("With hold off and on true", () => {
      it("holdWrites is true, the revision is one higher, and everything else is equal", () => {
        const stored = storedWith(false);
        expect(withHold(stored, true)).toEqual({
          ...stored,
          config: { ...stored.config, settings: { ...stored.config.settings, holdWrites: true } },
          revision: 6,
        });
      });
    });

    describe("With hold on and on false", () => {
      it("holdWrites is false and the revision is one higher", () => {
        const result = withHold(storedWith(true), false);
        expect(result.config.settings.holdWrites).toBe(false);
        expect(result.revision).toBe(6);
      });
    });

    describe("With the value the hold already has", () => {
      it("returns the given StoredConfig itself", () => {
        const stored = storedWith(true);
        expect(withHold(stored, true)).toBe(stored);
      });
    });

    describe("With a stored config that has a valve in releasing", () => {
      it("releasing is unchanged", () => {
        const releasing = new Map([[V1, NOW_MS - HOUR_MS]]);
        expect(withHold(storedWith(false, releasing), true).releasing).toEqual(releasing);
      });
    });
  });
});
