import { describe, expect, it } from "vitest";
import {
  BUILDER_DAY,
  BUILDER_NOW,
  BUILDER_SCHEDULE,
  makeConfig,
  makeOriginals,
  makeSpec,
  makeState,
  makeWorld,
} from "../test/builders.ts";
import {
  ChangeRefused,
  capture,
  forgetValve,
  planChange,
  restoreValve,
  withHold,
} from "./change.ts";
import type { ChangeOptions, ChangePlan, ChangeRefusedCode, SensorInfo } from "./change.ts";
import type { DeviceView, Effect, World } from "./control.ts";
import { EMPTY_LEDGER, withRecord } from "./ledger.ts";
import type { Ledger, StoredConfig, ValveRecord } from "./ledger.ts";
import { ConfigError } from "./model.ts";
import type { Room, SensorRef } from "./model.ts";
import type { DeviceState } from "./observation.ts";
import { DAY_KEYS } from "./settings.ts";
import type { SettingKey, SettingValues, ValveSpec } from "./settings.ts";
import type { SensorReading } from "./temperature.ts";
import type { RawConfig, RawRoom, RawSensor } from "./validation.ts";

const V1 = "z2m:0x00124b0000000001";
const V2 = "z2m:0x00124b0000000002";
const V3 = "z2m:0x00124b0000000003";
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const NOW_MS = BUILDER_NOW.epochMilliseconds;
const DAY_KEY_LIST: readonly SettingKey[] = Object.values(DAY_KEYS);

const Z_REF = "ha:sensor.bedroom";
const Z_SENSOR: RawSensor = { ref: Z_REF };
const Z_SENSOR_ID = Z_REF;
const Z_MODEL: SensorRef = { ref: Z_REF, weight: 1 };
const HA_SENSOR: RawSensor = { ref: "ha:sensor.living" };
const HA_SENSOR_ID = "ha:sensor.living";
const HA_MODEL: SensorRef = { ref: "ha:sensor.living", weight: 1 };

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

function viewWith(model: Model, state: DeviceState | undefined, usable = true): DeviceView {
  return { name: `valve ${model}`, spec: makeSpec(model), usable, state };
}

/** A usable view whose valve has sent a message holding `values`. */
function observedView(model: Model = "trvzb", values = observedValues(model)): DeviceView {
  return viewWith(model, makeState({ values }));
}

/** A usable view whose valve has sent no message since the start. */
function unobservedView(model: Model = "trvzb"): DeviceView {
  return viewWith(model, { ...makeState(), messageAt: undefined });
}

function record(valveId: string, model: Model = "trvzb"): ValveRecord {
  return {
    valveId,
    profile: makeSpec(model).profile,
    adoptedAt: NOW_MS - 24 * HOUR_MS,
    originals: makeOriginals(model),
  };
}

function ledgerOf(...records: readonly ValveRecord[]): Ledger {
  return records.reduce(withRecord, EMPTY_LEDGER);
}

function room(id: string, valveIds: readonly string[], sensors: readonly SensorRef[] = []): Room {
  return {
    id,
    name: id,
    areaId: undefined,
    scheduleId: BUILDER_SCHEDULE,
    valves: valveIds.map((valveId) => ({ valveId })),
    sensors,
    presets: { comfort: undefined, eco: undefined, frost: undefined, boost: undefined },
  };
}

/** A world with a readable config (revision 1) holding `rooms`. */
function current(options: {
  rooms: readonly Room[];
  ledger?: Ledger | undefined;
  releasing?: ReadonlyMap<string, number>;
  devices?: ReadonlyMap<string, DeviceView>;
  timezone?: string | undefined;
}): World {
  const config = makeConfig({ rooms: options.rooms });
  const settings = { ...config.settings, timezone: options.timezone };
  const world = makeWorld({
    ledger: "ledger" in options ? options.ledger : EMPTY_LEDGER,
    devices: options.devices ?? new Map(),
  });
  return {
    ...world,
    stored: {
      config: "timezone" in options ? { ...config, settings } : config,
      revision: 1,
      releasing: options.releasing ?? new Map(),
    },
  };
}

/** A world with no config yet (state "empty") and an empty ledger. */
function first(devices: ReadonlyMap<string, DeviceView> = new Map()): World {
  return makeWorld({ configState: "empty", stored: undefined, devices });
}

function rawRoom(
  id: string,
  valves: readonly string[],
  sensors: readonly RawSensor[] = [],
): RawRoom {
  return {
    id,
    name: id,
    schedule_id: BUILDER_SCHEDULE,
    valves: valves.map((valveId) => ({ id: valveId })),
    sensors,
  };
}

/** The builder schedule (eco, comfort at 06:30, eco at 22:00 every day) and the given rooms. */
function doc(
  rooms: readonly RawRoom[],
  options: { timezone?: string | undefined; eco?: number } = {},
): RawConfig {
  const day = [
    { time: "00:00", preset: "eco" as const },
    { time: "06:30", preset: "comfort" as const },
    { time: "22:00", preset: "eco" as const },
  ];
  const timezone = "timezone" in options ? options.timezone : BUILDER_NOW.timeZoneId;
  return {
    version: 1,
    settings: {
      hold_writes: false,
      ...(timezone === undefined ? {} : { timezone }),
    },
    ...(options.eco === undefined ? {} : { presets: { eco: options.eco } }),
    schedules: [
      {
        id: BUILDER_SCHEDULE,
        name: "Default",
        default_week: { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day },
      },
    ],
    rooms: [...rooms],
  };
}

function options(overrides: Partial<ChangeOptions> = {}): ChangeOptions {
  return {
    expectedRevision: undefined,
    dryRun: false,
    acceptUnknownOriginals: new Set(),
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

function recordOf(ledger: Ledger | undefined, valveId: string): ValveRecord | undefined {
  return ledger?.records.get(valveId);
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
    describe("With a first config naming one observable valve", () => {
      const world = first(devicesOf({ [V1]: observedView() }));
      const result = plan(world, doc([rawRoom("living", [V1])]));

      it("effects are saveLedger, writeOriginalsCopy, saveConfig, in that order", () => {
        expect(kinds(result.effects)).toEqual(["saveLedger", "writeOriginalsCopy", "saveConfig"]);
      });

      it("the ledger holds a record with the captured originals", () => {
        expect(recordOf(result.ledger, V1)).toEqual({
          valveId: V1,
          profile: "sonoff_trvzb",
          adoptedAt: NOW_MS,
          originals: { sensor_source: "internal" },
        });
      });

      it("the stored revision is 1", () => {
        expect(result.stored.revision).toBe(1);
      });

      it("writes lists what the config leads to", () => {
        expect(result.writes).toEqual([{ valveId: V1, values: sevenDays(), current: {} }]);
      });
    });

    describe("With dryRun true", () => {
      it("effects is empty and joining, leaving and writes are filled", () => {
        const world = current({
          rooms: [room("living", [V2])],
          ledger: ledgerOf(record(V2)),
          devices: devicesOf({ [V1]: observedView(), [V2]: observedView() }),
        });
        const result = plan(world, doc([rawRoom("living", [V1])]), { dryRun: true });
        expect(result.effects).toEqual([]);
        expect(result.joining.map((c) => c.valveId)).toEqual([V1]);
        expect(result.leaving).toEqual([V2]);
        expect(result.writes.map((w) => w.valveId)).toContain(V1);
      });
    });

    describe("With one new valve, one rejoining valve and one leaving valve", () => {
      const world = current({
        rooms: [room("living", [V3])],
        ledger: ledgerOf(record(V2), record(V3)),
        devices: devicesOf({ [V1]: observedView(), [V2]: observedView(), [V3]: observedView() }),
      });
      const result = plan(world, doc([rawRoom("living", [V1, V2])]));

      it("joining holds a Capture for the new valve only", () => {
        expect(result.joining).toEqual([
          { valveId: V1, originals: { sensor_source: "internal" }, unreadable: [] },
        ]);
      });

      it("rejoining names the second and leaving the third", () => {
        expect(result.rejoining).toEqual([V2]);
        expect(result.leaving).toEqual([V3]);
      });
    });

    describe("With two new valves given in the document in descending id order", () => {
      it("joining lists them in ascending id order", () => {
        const world = first(devicesOf({ [V1]: observedView(), [V2]: observedView() }));
        const result = plan(world, doc([rawRoom("living", [V2, V1])]));
        expect(result.joining.map((c) => c.valveId)).toEqual([V1, V2]);
      });
    });

    describe("With an invalid document", () => {
      it("throws ConfigError and returns nothing", () => {
        const world = first(devicesOf({ [V1]: observedView() }));
        const raw = { version: 1, presets: { eco: "warm" }, rooms: "none" };
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
        const refused = refusal(() => plan(world, doc([]), { expectedRevision: 0 }));
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
        });
        expect(codeOf(() => plan(world, doc([rawRoom("living", [V1])])))).toBe("config_unreadable");
      });
    });

    describe('With config state "unreadable" and overwriteUnreadable', () => {
      it("returns a plan; ledger records in no room are untouched and not in releasing", () => {
        const kept = record(V2);
        const world = makeWorld({
          configState: "unreadable",
          stored: undefined,
          ledger: ledgerOf(kept),
          devices: devicesOf({ [V1]: observedView() }),
        });
        const result = plan(world, doc([rawRoom("living", [V1])]), { overwriteUnreadable: true });
        expect(recordOf(result.ledger, V2)).toBe(kept);
        expect(result.stored.releasing.has(V2)).toBe(false);
      });
    });

    describe('With config state "ok" and no stored config', () => {
      it("throws ChangeRefused config_unreadable", () => {
        const world = makeWorld({
          stored: undefined,
          devices: devicesOf({ [V1]: observedView() }),
        });
        expect(codeOf(() => plan(world, doc([rawRoom("living", [V1])])))).toBe("config_unreadable");
      });
    });

    describe("With a leaving valve that is already in releasing", () => {
      it("its release time becomes the time now", () => {
        const world = current({
          rooms: [room("living", [V1, V2])],
          ledger: ledgerOf(record(V1), record(V2)),
          releasing: new Map([[V1, NOW_MS - HOUR_MS]]),
        });
        const result = plan(world, doc([rawRoom("living", [V2])]));
        expect(result.stored.releasing.get(V1)).toBe(NOW_MS);
      });
    });

    describe("With a valve removed from its room", () => {
      const world = current({
        rooms: [room("living", [V1, V2])],
        ledger: ledgerOf(record(V1), record(V2)),
        devices: devicesOf({ [V1]: observedView(), [V2]: observedView() }),
      });
      const result = plan(world, doc([rawRoom("living", [V2])]));

      it("the valve is in stored.releasing with the time now", () => {
        expect([...result.stored.releasing]).toEqual([[V1, NOW_MS]]);
      });

      it("effects hold saveConfig only", () => {
        expect(kinds(result.effects)).toEqual(["saveConfig"]);
      });
    });

    describe("With a valve moved to another room", () => {
      it("it is neither joining nor leaving and releasing is unchanged", () => {
        const releasing = new Map([[V3, NOW_MS - HOUR_MS]]);
        const world = current({
          rooms: [room("living", [V1, V2])],
          ledger: ledgerOf(record(V1), record(V2), record(V3)),
          releasing,
          devices: devicesOf({ [V1]: observedView(), [V2]: observedView() }),
        });
        const result = plan(world, doc([rawRoom("living", [V2]), rawRoom("bedroom", [V1])]));
        expect(result.joining).toEqual([]);
        expect(result.rejoining).toEqual([]);
        expect(result.leaving).toEqual([]);
        expect(result.stored.releasing).toEqual(releasing);
      });
    });

    describe("With a releasing valve added to a room again", () => {
      it("it is rejoining, removed from releasing, and its record is unchanged", () => {
        const kept = record(V1);
        const world = current({
          rooms: [room("living", [V2])],
          ledger: ledgerOf(kept, record(V2)),
          releasing: new Map([[V1, NOW_MS - HOUR_MS]]),
          devices: devicesOf({ [V1]: observedView(), [V2]: observedView() }),
        });
        const result = plan(world, doc([rawRoom("living", [V1, V2])]));
        expect(result.rejoining).toEqual([V1]);
        expect(result.stored.releasing.has(V1)).toBe(false);
        expect(recordOf(result.ledger, V1)).toBe(kept);
      });
    });

    describe("With an orphan valve added to a room", () => {
      it("it is rejoining and its record is unchanged", () => {
        const kept = record(V1);
        const world = current({
          rooms: [room("living", [V2])],
          ledger: ledgerOf(kept, record(V2)),
          devices: devicesOf({ [V1]: observedView(), [V2]: observedView() }),
        });
        const result = plan(world, doc([rawRoom("living", [V1, V2])]));
        expect(result.rejoining).toEqual([V1]);
        expect(recordOf(result.ledger, V1)).toBe(kept);
      });
    });

    describe("With the ledger unreadable and a new valve", () => {
      it("throws ChangeRefused ledger_unreadable", () => {
        const world = current({
          rooms: [room("living", [V2])],
          ledger: undefined,
          devices: devicesOf({ [V1]: observedView(), [V2]: observedView() }),
        });
        expect(codeOf(() => plan(world, doc([rawRoom("living", [V1, V2])])))).toBe(
          "ledger_unreadable",
        );
      });
    });

    describe("With the ledger unreadable and only a schedule edit", () => {
      it("returns a plan with saveConfig only", () => {
        const world = current({ rooms: [room("living", [V2])], ledger: undefined });
        const result = plan(world, doc([rawRoom("living", [V2])], { eco: 16 }));
        expect(kinds(result.effects)).toEqual(["saveConfig"]);
      });
    });

    describe("With a new TRVZB whose sensor source cannot be read", () => {
      it("throws ChangeRefused originals_unreadable naming the valve and the setting", () => {
        const world = first(devicesOf({ [V1]: observedView("trvzb", sevenDays()) }));
        const refused = refusal(() => plan(world, doc([rawRoom("living", [V1])])));
        expect(refused.code).toBe("originals_unreadable");
        expect(refused.data).toEqual({ valveId: V1, settings: "sensor_source" });
      });
    });

    describe("With the same valve listed in acceptUnknownOriginals", () => {
      it("the record's sensor source original is null", () => {
        const world = first(devicesOf({ [V1]: observedView("trvzb", sevenDays()) }));
        const result = plan(world, doc([rawRoom("living", [V1])]), {
          acceptUnknownOriginals: new Set([V1]),
        });
        expect(recordOf(result.ledger, V1)?.originals).toEqual({ sensor_source: null });
      });
    });

    describe("With a new TRVZB whose days are not observed and whose source is", () => {
      it("returns a plan", () => {
        const world = first(
          devicesOf({ [V1]: observedView("trvzb", { sensor_source: "internal" }) }),
        );
        expect(plan(world, doc([rawRoom("living", [V1])])).joining).toHaveLength(1);
      });
    });

    describe("With a new TRV-ZBT whose active group is 3", () => {
      it("returns a plan and the record's original active group is 3", () => {
        const view = observedView("trv_zbt", { active_group: 3, sensor_source: "internal" });
        const result = plan(first(devicesOf({ [V1]: view })), doc([rawRoom("living", [V1])]));
        expect(recordOf(result.ledger, V1)?.originals.active_group).toBe(3);
      });
    });

    describe("With a new TRV-ZBT whose active group is not observed", () => {
      it("throws ChangeRefused originals_unreadable", () => {
        const view = observedView("trv_zbt", { sensor_source: "internal" });
        const world = first(devicesOf({ [V1]: view }));
        expect(codeOf(() => plan(world, doc([rawRoom("living", [V1])])))).toBe(
          "originals_unreadable",
        );
      });
    });

    describe("With a new valve that has sent no message since the start, listed in acceptUnknownOriginals", () => {
      it("throws ChangeRefused valve_not_observed with the valve in valveIds", () => {
        const world = first(devicesOf({ [V1]: unobservedView() }));
        const refused = refusal(() =>
          plan(world, doc([rawRoom("living", [V1])]), { acceptUnknownOriginals: new Set([V1]) }),
        );
        expect(refused.code).toBe("valve_not_observed");
        expect(refused.data).toEqual({ valveIds: V1 });
      });
    });

    describe("With two new valves that have sent no message since the start", () => {
      it("valveIds names both, in id order", () => {
        const world = first(devicesOf({ [V1]: unobservedView(), [V2]: unobservedView() }));
        const refused = refusal(() => plan(world, doc([rawRoom("living", [V2, V1])])));
        expect(refused.data).toEqual({ valveIds: `${V1},${V2}` });
      });
    });

    describe("With a new valve that has sent no message since the start, and dryRun true", () => {
      it("throws ChangeRefused valve_not_observed", () => {
        const world = first(devicesOf({ [V1]: unobservedView() }));
        expect(codeOf(() => plan(world, doc([rawRoom("living", [V1])]), { dryRun: true }))).toBe(
          "valve_not_observed",
        );
      });
    });

    describe("With a rejoining valve that has sent no message since the start", () => {
      it("returns a plan", () => {
        const world = current({
          rooms: [],
          ledger: ledgerOf(record(V1)),
          devices: devicesOf({ [V1]: viewWith("trvzb", undefined) }),
        });
        expect(plan(world, doc([rawRoom("living", [V1])])).rejoining).toEqual([V1]);
      });
    });

    describe('With a first config while configState is "empty"', () => {
      it("writes lists the valve's writes (the preview does not see it as frozen)", () => {
        const world = first(devicesOf({ [V1]: observedView() }));
        const result = plan(world, doc([rawRoom("living", [V1])]));
        expect(result.writes.map((w) => w.valveId)).toEqual([V1]);
      });
    });

    describe("With a first config whose room has a sensor with a value", () => {
      it('the previewed sensor source is "external"', () => {
        const reading: SensorReading = {
          sensorId: Z_SENSOR_ID,
          value: 20,
          seenAt: NOW_MS,
          pending: false,
        };
        const world: World = {
          ...first(devicesOf({ [V1]: observedView() })),
          sensors: new Map([[Z_SENSOR_ID, reading]]),
        };
        const result = plan(
          world,
          doc([rawRoom("living", [V1], [Z_SENSOR])]),
          {},
          sensorsOf({ [Z_SENSOR_ID]: GOOD }),
        );
        const source = result.writes.find((w) => "sensor_source" in w.values);
        expect(source?.values.sensor_source).toBe("external");
      });
    });

    describe("With a new valve whose days already equal the room's schedule", () => {
      it("writes still lists the seven days", () => {
        const values = { ...sevenDays(), sensor_source: "internal" as const };
        const world = first(devicesOf({ [V1]: observedView("trvzb", values) }));
        const result = plan(world, doc([rawRoom("living", [V1])]));
        expect(result.writes.map((w) => w.values)).toContainEqual(sevenDays());
      });
    });

    describe("With a new valve whose transport is unusable", () => {
      it("throws ChangeRefused transport_unusable", () => {
        const view = viewWith("trvzb", makeState({ values: observedValues("trvzb") }), false);
        const world = first(devicesOf({ [V1]: view }));
        expect(codeOf(() => plan(world, doc([rawRoom("living", [V1])])))).toBe(
          "transport_unusable",
        );
      });
    });

    describe("With a new valve id no transport knows", () => {
      it("throws ChangeRefused valve_unknown", () => {
        const refused = refusal(() => plan(first(), doc([rawRoom("living", [V1])])));
        expect(refused.code).toBe("valve_unknown");
        expect(refused.data).toEqual({ valveId: V1 });
      });
    });

    describe("With a new valve whose model has no profile", () => {
      it("throws ChangeRefused valve_unsupported", () => {
        const view: DeviceView = { ...observedView(), spec: undefined };
        const refused = refusal(() =>
          plan(first(devicesOf({ [V1]: view })), doc([rawRoom("living", [V1])])),
        );
        expect(refused.code).toBe("valve_unsupported");
        expect(refused.data).toEqual({ valveId: V1 });
      });
    });

    describe("With an orphan valve added to a room while it has no DeviceView", () => {
      it("throws ChangeRefused valve_unknown", () => {
        const world = current({ rooms: [], ledger: ledgerOf(record(V1)) });
        expect(codeOf(() => plan(world, doc([rawRoom("living", [V1])])))).toBe("valve_unknown");
      });
    });

    describe("With a managed valve that has no DeviceView and only a schedule edit", () => {
      it("returns a plan", () => {
        const world = current({ rooms: [room("living", [V1])], ledger: ledgerOf(record(V1)) });
        const result = plan(world, doc([rawRoom("living", [V1])], { eco: 16 }));
        expect(result.stored.revision).toBe(2);
      });
    });

    describe("With no timezone in the document, no current config and haLinked false", () => {
      it("throws ChangeRefused timezone_missing", () => {
        const world = first(devicesOf({ [V1]: observedView() }));
        const raw = doc([rawRoom("living", [V1])], { timezone: undefined });
        expect(codeOf(() => plan(world, raw, { haLinked: false }))).toBe("timezone_missing");
      });
    });

    describe("With no timezone in the document and haLinked true", () => {
      it("returns a plan", () => {
        const world = first(devicesOf({ [V1]: observedView() }));
        const raw = doc([rawRoom("living", [V1])], { timezone: undefined });
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
        const raw = doc([rawRoom("living", [V1])], { timezone: undefined, eco: 16 });
        expect(plan(world, raw, { haLinked: false }).stored.revision).toBe(2);
      });
    });

    describe("With no timezone in the document, no current config, haLinked false and an out-of-date expectedRevision", () => {
      it("throws ChangeRefused revision_conflict (it comes first)", () => {
        const raw = doc([], { timezone: undefined });
        const refused = refusal(() => plan(first(), raw, { haLinked: false, expectedRevision: 3 }));
        expect(refused.code).toBe("revision_conflict");
        expect(refused.data).toEqual({ expected: "3", current: "0" });
      });
    });

    describe("With a new valve whose DeviceView is usable while transportFaults has an entry for its transport", () => {
      it("throws ChangeRefused transport_unusable with the valve and the transport in data", () => {
        const world: World = {
          ...first(devicesOf({ [V1]: observedView() })),
          transportFaults: { z2m: "second_instance" },
        };
        const refused = refusal(() => plan(world, doc([rawRoom("living", [V1])])));
        expect(refused.code).toBe("transport_unusable");
        expect(refused.data).toEqual({ valveId: V1, transport: "z2m" });
      });
    });

    describe("With a new valve whose transport's link is down and that has sent no message", () => {
      it("throws ChangeRefused valve_not_observed, not transport_unusable", () => {
        const world: World = {
          ...first(devicesOf({ [V1]: unobservedView() })),
          links: { z2m: false },
        };
        expect(codeOf(() => plan(world, doc([rawRoom("living", [V1])])))).toBe(
          "valve_not_observed",
        );
      });
    });

    describe("With a new sensor that has no entry in sensors / is not a temperature sensor / is on a valve", () => {
      const world = first(devicesOf({ [V1]: observedView() }));
      const raw = doc([rawRoom("living", [V1], [Z_SENSOR])]);

      it("throws ChangeRefused sensor_unknown, with the sensor id in data", () => {
        const missing = refusal(() => plan(world, raw));
        expect(missing.code).toBe("sensor_unknown");
        expect(missing.data).toEqual({ sensor: Z_SENSOR_ID });
        const gone = refusal(() =>
          plan(world, raw, {}, sensorsOf({ [Z_SENSOR_ID]: { ...GOOD, exists: false } })),
        );
        expect(gone.code).toBe("sensor_unknown");
      });

      it("throws ChangeRefused sensor_not_temperature, with the sensor id in data", () => {
        const refused = refusal(() =>
          plan(world, raw, {}, sensorsOf({ [Z_SENSOR_ID]: { ...GOOD, isTemperature: false } })),
        );
        expect(refused.code).toBe("sensor_not_temperature");
        expect(refused.data).toEqual({ sensor: Z_SENSOR_ID });
      });

      it("throws ChangeRefused sensor_on_valve, with the sensor id in data", () => {
        const refused = refusal(() =>
          plan(world, raw, {}, sensorsOf({ [Z_SENSOR_ID]: { ...GOOD, onValve: true } })),
        );
        expect(refused.code).toBe("sensor_on_valve");
        expect(refused.data).toEqual({ sensor: Z_SENSOR_ID });
      });
    });

    describe('With a new "ha:" sensor and haLinked false', () => {
      it("throws ChangeRefused ha_link_missing, also when sensors has no entry for it", () => {
        const world = first(devicesOf({ [V1]: observedView() }));
        const raw = doc([rawRoom("living", [V1], [HA_SENSOR])]);
        const known = refusal(() =>
          plan(world, raw, { haLinked: false }, sensorsOf({ [HA_SENSOR_ID]: GOOD })),
        );
        expect(known.code).toBe("ha_link_missing");
        expect(known.data).toEqual({ sensor: HA_SENSOR_ID });
        expect(codeOf(() => plan(world, raw, { haLinked: false }))).toBe("ha_link_missing");
      });
    });

    describe('With an "ha:" sensor that is already in a room of the current config, haLinked false, and only a schedule edit', () => {
      it("returns a plan", () => {
        const world = current({
          rooms: [room("living", [V1], [HA_MODEL])],
          ledger: ledgerOf(record(V1)),
        });
        const raw = doc([rawRoom("living", [V1], [HA_SENSOR])], { eco: 16 });
        expect(plan(world, raw, { haLinked: false }).stored.revision).toBe(2);
      });
    });

    describe("With a sensor of the current config that has no entry in sensors, and only a schedule edit", () => {
      it("returns a plan", () => {
        const world = current({
          rooms: [room("living", [V1], [Z_MODEL])],
          ledger: ledgerOf(record(V1)),
        });
        const raw = doc([rawRoom("living", [V1], [Z_SENSOR])], { eco: 16 });
        expect(plan(world, raw).stored.revision).toBe(2);
      });
    });

    describe("With a sensor of the current config whose isTemperature is now false, moved to another room", () => {
      it("returns a plan", () => {
        const world = current({
          rooms: [room("living", [V1], [Z_MODEL]), room("bedroom", [V2])],
          ledger: ledgerOf(record(V1), record(V2)),
        });
        const raw = doc([rawRoom("living", [V1]), rawRoom("bedroom", [V2], [Z_SENSOR])]);
        const sensors = sensorsOf({ [Z_SENSOR_ID]: { ...GOOD, isTemperature: false } });
        expect(plan(world, raw, {}, sensors).stored.revision).toBe(2);
      });
    });

    describe('With config state "unreadable", overwriteUnreadable, an "ha:" sensor and haLinked false', () => {
      it("throws ChangeRefused ha_link_missing (with no readable config every sensor is new)", () => {
        const world = makeWorld({
          configState: "unreadable",
          stored: {
            config: makeConfig({ rooms: [room("living", [V1], [HA_MODEL])] }),
            revision: 4,
            releasing: new Map(),
          },
          ledger: ledgerOf(record(V1)),
          devices: devicesOf({ [V1]: observedView() }),
        });
        const raw = doc([rawRoom("living", [V1], [HA_SENSOR])]);
        const run = (): ChangePlan =>
          plan(world, raw, { overwriteUnreadable: true, haLinked: false });
        expect(codeOf(run)).toBe("ha_link_missing");
      });
    });

    describe("With a config with no rooms applied over three managed valves", () => {
      it("all three are in releasing", () => {
        const world = current({
          rooms: [room("living", [V1, V2, V3])],
          ledger: ledgerOf(record(V1), record(V2), record(V3)),
        });
        const result = plan(world, doc([]));
        expect([...result.stored.releasing.keys()].sort()).toEqual([V1, V2, V3]);
      });
    });

    describe("Always", () => {
      it('a caller cannot set releasing: a "releasing" key in the document is a ConfigError key_unknown', () => {
        const raw = { ...doc([]), releasing: { [V1]: "2026-11-16T11:00:00.000Z" } };
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
  });

  describe("withHold", () => {
    const storedWith = (
      holdWrites: boolean,
      releasing = new Map<string, number>(),
    ): StoredConfig => {
      const config = makeConfig({ rooms: [room("living", [V2])], holdWrites });
      return { config, revision: 5, releasing };
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
