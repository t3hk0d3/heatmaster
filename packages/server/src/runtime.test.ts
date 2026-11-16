import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ChangeRefused,
  ConfigError,
  EMPTY_CONFIG,
  EMPTY_LEDGER,
  configToRaw,
  findProfile,
  ledgerToRaw,
  storedToRaw,
  validateConfig,
} from "@heatmaster/core";
import type {
  Binding,
  Effect,
  Ledger,
  RawConfig,
  StoredConfig,
  ValveRecord,
} from "@heatmaster/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createManualClock, type ManualClock } from "../test/manual-clock.ts";
import { rejectionOf } from "../test/rejection.ts";
import { createStubHaLink, type StubHaLink } from "../test/stub-ha-link.ts";
import { createStubTransport, type StubTransport } from "../test/stub-transport.ts";
import { HeatmasterError } from "./errors.ts";
import {
  CLOCK_JUMP_MS,
  DIRECT_ASK_SPACING_MS,
  EVENT_DEBOUNCE_MS,
  TICK_INTERVAL_MS,
  createRuntime,
  executeEffects,
  type ApplyOptions,
  type EffectContext,
  type HeatmasterRuntime,
  type RuntimeLog,
  type Snapshot,
} from "./runtime.ts";
import {
  createConfigStore,
  createLedgerStore,
  type ConfigStore,
  type LedgerStore,
} from "./stores.ts";
import type { DeviceInfo } from "./transport.ts";

// ---- profile override ----------------------------------------------------------------------------

/** A binding the runtime gets instead of the real one, for the model ids named here. */
const bindingOverrides = new Map<string, Binding>();

vi.mock("@heatmaster/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@heatmaster/core")>();
  return {
    ...core,
    findProfile: (modelId: string, transport: string) => {
      const found = core.findProfile(modelId === "TRVZB-NOREAD" ? "TRVZB" : modelId, transport);
      const binding = bindingOverrides.get(modelId);
      return found === undefined || binding === undefined ? found : { ...found, binding };
    },
  };
});

// ---- fixtures ------------------------------------------------------------------------------------

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
/** Monday 2026-11-16, 10:00 in Amsterdam. */
const T = Date.UTC(2026, 10, 16, 9, 0, 0);
const ZONE = "Europe/Amsterdam";
const A = "z2m:0xa1";
const B = "z2m:0xb2";
const C = "z2m:0xc3";
const S = "z2m:0x5e";
const ROOM_SENSOR = "ha:sensor.living";
const TRVZB = findProfile("TRVZB", "z2m");
if (TRVZB === undefined) throw new Error("no TRVZB profile");
const TRVZB_BINDING = TRVZB.binding;

function trvzb(id: string, modelId = "TRVZB"): DeviceInfo {
  const address = id.slice(4);
  return {
    deviceId: id,
    transport: "z2m",
    address,
    modelId,
    manufacturer: "SONOFF",
    firmware: "1.0",
    name: `valve ${address}`,
  };
}

function sensorDevice(id: string): DeviceInfo {
  return { ...trvzb(id), modelId: "SNZB-02", name: `sensor ${id.slice(4)}` };
}

type RoomSpec = Readonly<{
  id?: string;
  valves?: readonly string[];
  sensors?: readonly string[];
  areaId?: string;
}>;

function week(temperature = 20): NonNullable<RawConfig["schedules"]> {
  const day = [
    { time: "00:00", temperature: 16 },
    { time: "07:00", temperature },
  ];
  return [
    {
      id: "main",
      name: "Main",
      default_week: { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day },
    },
  ];
}

function raw(
  options: Readonly<{
    rooms?: readonly RoomSpec[];
    hold?: boolean;
    timezone?: string | null;
    temperature?: number;
  }> = {},
): RawConfig {
  const timezone = options.timezone === undefined ? ZONE : options.timezone;
  return {
    version: 1,
    settings: {
      hold_writes: options.hold ?? false,
      ...(timezone === null ? {} : { timezone }),
    },
    schedules: week(options.temperature),
    rooms: (options.rooms ?? [{}]).map((room, i) => ({
      id: room.id ?? (i === 0 ? "living" : `room${String(i)}`),
      name: room.id ?? `Room ${String(i)}`,
      ...(room.areaId === undefined ? {} : { area_id: room.areaId }),
      schedule_id: "main",
      valves: (room.valves ?? [A]).map((id) => ({ id })),
      sensors: (room.sensors ?? []).map((ref) => ({ ref })),
    })),
  };
}

function record(valveId: string, source: "internal" | "external" = "internal"): ValveRecord {
  return {
    valveId,
    profile: "sonoff_trvzb",
    adoptedAt: T - HOUR,
    originals: { sensor_source: source },
  };
}

function ledgerOf(records: readonly ValveRecord[]): Ledger {
  return { records: new Map(records.map((r) => [r.valveId, r])), released: [] };
}

function trvzbMessage(
  token: string,
  source = "local_temperature",
  extra: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return { temperature_sensor_select: source, system_mode: "auto", last_seen: token, ...extra };
}

// ---- files ---------------------------------------------------------------------------------------

const folders: string[] = [];
function folder(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "heatmaster-runtime-"));
  folders.push(dir);
  return dir;
}

type Seed = Readonly<{
  config?: RawConfig | "unreadable";
  revision?: number;
  releasing?: Readonly<Record<string, number>>;
  ledger?: readonly ValveRecord[] | "unreadable";
  copy?: readonly ValveRecord[];
}>;

function seedFiles(dataDir: string, publicDir: string, seed: Seed): void {
  if (seed.config === "unreadable") {
    writeFileSync(path.join(dataDir, "config.json"), "{ not json");
  } else if (seed.config !== undefined) {
    const stored: StoredConfig = {
      config: validateConfig(seed.config),
      revision: seed.revision ?? 1,
      releasing: new Map(Object.entries(seed.releasing ?? {})),
    };
    writeFileSync(
      path.join(dataDir, "config.json"),
      JSON.stringify({ version: 1, data: storedToRaw(stored) }),
    );
  }
  if (seed.ledger === "unreadable") {
    writeFileSync(path.join(dataDir, "ledger.json"), "{ not json");
  } else if (seed.ledger !== undefined) {
    writeFileSync(
      path.join(dataDir, "ledger.json"),
      JSON.stringify({ version: 1, data: ledgerToRaw(ledgerOf(seed.ledger)) }),
    );
  }
  if (seed.copy !== undefined) {
    writeFileSync(
      path.join(publicDir, "originals.json"),
      JSON.stringify({
        version: 1,
        written_at: new Date(T).toISOString(),
        heatmaster: "test",
        data: ledgerToRaw(ledgerOf(seed.copy)),
      }),
    );
  }
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

// ---- wrapped stores ------------------------------------------------------------------------------

interface StoreControl {
  calls: string[];
  /** How many sends the transport had attempted when each call in `calls` was made. */
  sendsAtCall: number[];
  sendsSoFar: () => number;
  expected: boolean[];
  overwrite: boolean[];
  fail: { config: number; ledger: number; copy: number };
  /** While set, the ledger store's save or copyRecords waits for it; `reached` notes the call. */
  gates: { ledgerSave?: Promise<void>; copyRecords?: Promise<void> };
  reached: string[];
}

function failure(): HeatmasterError {
  return new HeatmasterError("io_failed");
}

function note(control: StoreControl, call: string): void {
  control.calls.push(call);
  control.sendsAtCall.push(control.sendsSoFar());
}

function wrapConfig(store: ConfigStore, control: StoreControl): ConfigStore {
  return {
    load: () => store.load(),
    async save(stored, overwriteUnreadable) {
      control.overwrite.push(overwriteUnreadable === true);
      if (control.fail.config > 0) {
        control.fail.config -= 1;
        note(control, "config.fail");
        throw failure();
      }
      await store.save(stored, overwriteUnreadable);
      note(control, "config.save");
    },
    remove: () => store.remove(),
  };
}

function wrapLedger(store: LedgerStore, control: StoreControl): LedgerStore {
  return {
    load(expected) {
      control.expected.push(expected);
      return store.load(expected);
    },
    async save(ledger) {
      if (control.gates.ledgerSave !== undefined) {
        control.reached.push("ledger.save");
        await control.gates.ledgerSave;
      }
      if (control.fail.ledger > 0) {
        control.fail.ledger -= 1;
        note(control, "ledger.fail");
        throw failure();
      }
      await store.save(ledger);
      note(control, "ledger.save");
    },
    async writeCopy(ledger) {
      if (control.fail.copy > 0) {
        control.fail.copy -= 1;
        throw failure();
      }
      await store.writeCopy(ledger);
      note(control, "copy.write");
    },
    importCopy: (acceptEmpty) => store.importCopy(acceptEmpty),
    async copyRecords() {
      if (control.gates.copyRecords !== undefined) {
        control.reached.push("copyRecords");
        await control.gates.copyRecords;
      }
      return store.copyRecords();
    },
    remove: () => store.remove(),
  };
}

// ---- a runtime under test ------------------------------------------------------------------------

type Rig = Readonly<{
  rt: HeatmasterRuntime;
  clock: ManualClock;
  z2m: StubTransport;
  ha: StubHaLink | undefined;
  stores: StoreControl;
  dataDir: string;
  publicDir: string;
  logs: string[];
  snapshots: Snapshot[];
  /** Moves both clocks and waits until the runtime has settled. */
  advance(ms: number): Promise<void>;
  say(deviceId: string, token: string, payload?: Readonly<Record<string, unknown>>): void;
  memory(valveId: string): Record<string, unknown> | undefined;
  marks(valveId: string): Record<string, Record<string, number | undefined>>;
}>;

const rigs: Rig[] = [];
afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.rt.stop();
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
  bindingOverrides.clear();
});

async function boot(
  options: Readonly<{
    devices?: readonly DeviceInfo[];
    seed?: Seed;
    ha?: StubHaLink | null;
    start?: boolean;
    processTimeZone?: string;
    /** The transport's start waits for this. */
    gate?: Promise<void>;
  }> = {},
): Promise<Rig> {
  const dataDir = folder();
  const publicDir = folder();
  seedFiles(dataDir, publicDir, options.seed ?? {});
  const clock = createManualClock(T);
  const z2m = createStubTransport("z2m");
  const stores: StoreControl = {
    calls: [],
    sendsAtCall: [],
    sendsSoFar: () => z2m.attempts().length,
    expected: [],
    overwrite: [],
    fail: { config: 0, ledger: 0, copy: 0 },
    gates: {},
    reached: [],
  };
  z2m.setDevices(options.devices ?? [trvzb(A)]);
  const ha = options.ha === null ? undefined : (options.ha ?? createStubHaLink());
  const logs: string[] = [];
  const log: RuntimeLog = {
    info: (message) => logs.push(`info ${message}`),
    warn: (message) => logs.push(`warn ${message}`),
    error: (message) => logs.push(`error ${message}`),
  };
  const rt = createRuntime({
    configStore: wrapConfig(createConfigStore(dataDir, clock), stores),
    ledgerStore: wrapLedger(createLedgerStore({ dataDir, publicDir }, clock, "test"), stores),
    transports: {
      z2m:
        options.gate === undefined
          ? z2m
          : {
              ...z2m,
              start: (next) => (options.gate ?? Promise.resolve()).then(() => z2m.start(next)),
            },
    },
    ha,
    clock,
    processTimeZone: options.processTimeZone ?? "UTC",
    log,
  });
  const snapshots: Snapshot[] = [];
  rt.subscribe((snapshot) => snapshots.push(snapshot));
  const diagnosticsOf = (): Readonly<Record<string, unknown>> => rt.diagnostics();
  const rig: Rig = {
    rt,
    clock,
    z2m,
    ha,
    stores,
    dataDir,
    publicDir,
    logs,
    snapshots,
    async advance(ms) {
      // In steps of at most one tick interval, so every timer's tick runs at its own time.
      for (let left = ms; left > 0; left -= TICK_INTERVAL_MS) {
        clock.advance(Math.min(left, TICK_INTERVAL_MS));
        await rt.settled();
      }
    },
    say(deviceId, token, payload) {
      z2m.emit({
        kind: "message",
        deviceId,
        payload: payload ?? trvzbMessage(token),
        lifeToken: token,
      });
    },
    memory(valveId) {
      const memory = diagnosticsOf().memory as Record<string, Record<string, unknown>>;
      return memory[valveId];
    },
    marks(valveId) {
      return (rig.memory(valveId)?.marks ?? {}) as Record<
        string,
        Record<string, number | undefined>
      >;
    },
  };
  rigs.push(rig);
  if (options.start !== false) {
    await rt.start();
    await rt.settled();
  }
  return rig;
}

/** Valves in one room, with ledger records, hold off. */
function managedSeed(valves: readonly string[], sensors: readonly string[] = []): Seed {
  return {
    config: raw({ rooms: [{ valves, sensors }] }),
    ledger: valves.map((id) => record(id)),
  };
}

/**
 * Makes each valve heard: a first message, one second, a second message. The next tick then
 * publishes each valve's seven days.
 */
async function hear(rig: Rig, valves: readonly string[]): Promise<void> {
  for (const id of valves) rig.say(id, `${id}-1`);
  await rig.advance(1000);
  for (const id of valves) rig.say(id, `${id}-2`);
}

/** Heard, days published, heard again: no group is marked any more. */
async function inSync(rig: Rig, valves: readonly string[]): Promise<void> {
  await hear(rig, valves);
  await rig.advance(1000);
  await rig.advance(1000);
  for (const id of valves) rig.say(id, `${id}-3`);
  await rig.advance(1000);
}

/**
 * Waits until the events queued behind a tick's effects were applied (they arm the debounce timer
 * beside the tick interval), then runs the tick they asked for.
 */
async function drained(rig: Rig): Promise<void> {
  await vi.waitFor(() => {
    expect(rig.clock.pending()).toBe(2);
  });
  await rig.advance(EVENT_DEBOUNCE_MS);
}

/** Moves the clock and waits until a send matching `match` is attempted after the move. */
async function stepUntilAttempt(
  rig: Rig,
  ms: number,
  match: (send: ReturnType<StubTransport["attempts"]>[number]) => boolean,
): Promise<void> {
  const before = rig.z2m.attempts().length;
  rig.clock.advance(ms);
  await vi.waitFor(() => {
    expect(rig.z2m.attempts().slice(before).some(match)).toBe(true);
  });
}

function sends(rig: Rig, deviceId?: string): ReturnType<StubTransport["sent"]> {
  return rig.z2m.sent().filter((s) => deviceId === undefined || s.deviceId === deviceId);
}

function haSensor(
  ha: StubHaLink,
  entity: string,
  celsius: number,
  at: number,
  observable = true,
): void {
  ha.setSensor(entity, { celsius, lastReportedAt: at, observable });
  ha.setSensorInfo(entity, { exists: true, isTemperature: true, onValve: false });
}

function problemKinds(snapshot: Snapshot): string[] {
  return snapshot.problems.map((p) => p.kind);
}

function codeOf(error: unknown): string | undefined {
  return error instanceof HeatmasterError || error instanceof ChangeRefused
    ? error.code
    : undefined;
}

// ---- executeEffects ------------------------------------------------------------------------------

type ExecRig = Readonly<{
  context: EffectContext;
  order: string[];
  publishes: { deviceId: string; payload: unknown }[];
  reads: { deviceId: string; payload: unknown }[];
  overwrite: boolean[];
}>;

const STORED: StoredConfig = { config: EMPTY_CONFIG, revision: 1, releasing: new Map() };

function execRig(
  options: Readonly<{
    fail?: Readonly<Record<string, string>>;
    bindings?: Readonly<Record<string, Binding | undefined>>;
    overwriteUnreadable?: boolean;
  }> = {},
): ExecRig {
  const order: string[] = [];
  const publishes: { deviceId: string; payload: unknown }[] = [];
  const reads: { deviceId: string; payload: unknown }[] = [];
  const overwrite: boolean[] = [];
  const fail = options.fail ?? {};
  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  async function step(name: string): Promise<void> {
    order.push(`start ${name}`);
    await tick();
    const code = fail[name];
    if (code !== undefined) {
      order.push(`fail ${name}`);
      throw new HeatmasterError(code);
    }
    order.push(`end ${name}`);
  }
  const configStore: ConfigStore = {
    load: () => Promise.resolve({ state: "empty", stored: undefined }),
    async save(_stored, overwriteUnreadable) {
      overwrite.push(overwriteUnreadable === true);
      await step("saveConfig");
    },
    remove: () => Promise.resolve(),
  };
  const ledgerStore: LedgerStore = {
    load: () => Promise.resolve(EMPTY_LEDGER),
    save: () => step("saveLedger"),
    writeCopy: () => step("writeOriginalsCopy"),
    importCopy: () => Promise.resolve(EMPTY_LEDGER),
    copyRecords: () => Promise.resolve(0),
    remove: () => Promise.resolve(),
  };
  const transport = createStubTransport("z2m");
  const z2m = {
    ...transport,
    async publish(deviceId: string, payload: Readonly<Record<string, unknown>>) {
      await step(`publish ${deviceId}`);
      publishes.push({ deviceId, payload });
    },
    async read(deviceId: string, payload: Readonly<Record<string, unknown>>) {
      await step(`read ${deviceId}`);
      reads.push({ deviceId, payload });
    },
  };
  const bindings = options.bindings ?? {};
  const context: EffectContext = {
    configStore,
    ledgerStore,
    transports: { z2m },
    bindingOf: (valveId) => (Object.hasOwn(bindings, valveId) ? bindings[valveId] : TRVZB_BINDING),
    overwriteUnreadable: options.overwriteUnreadable ?? false,
    onLedgerSaved: () => order.push("onLedgerSaved"),
    onConfigSaved: () => order.push("onConfigSaved"),
    onSent: (valveId, what) => order.push(`onSent ${valveId} ${what}`),
  };
  return { context, order, publishes, reads, overwrite };
}

const DAY = [
  { time: Temporal.PlainTime.from("00:00"), temperature: 16 },
  { time: Temporal.PlainTime.from("07:00"), temperature: 20 },
];

const APPLY: ApplyOptions = {
  expectedRevision: undefined,
  acceptUnknownOriginals: [],
  overwriteUnreadable: false,
};

const NO_READ: Binding = { ...TRVZB_BINDING, encodeRefresh: () => undefined };

describe("runtime", () => {
  describe("executeEffects", () => {
    describe("With saveLedger, writeOriginalsCopy, saveConfig, publish", () => {
      const effects: Effect[] = [
        { kind: "saveLedger", ledger: EMPTY_LEDGER },
        { kind: "writeOriginalsCopy", ledger: EMPTY_LEDGER },
        { kind: "saveConfig", stored: STORED },
        { kind: "publish", valveId: A, values: { day_mon: DAY } },
      ];

      it("they run in that order, each finished before the next starts", async () => {
        const rig = execRig();
        await executeEffects(effects, rig.context);
        expect(rig.order.filter((line) => !line.startsWith("on"))).toEqual([
          "start saveLedger",
          "end saveLedger",
          "start writeOriginalsCopy",
          "end writeOriginalsCopy",
          "start saveConfig",
          "end saveConfig",
          `start publish ${A}`,
          `end publish ${A}`,
        ]);
      });

      it("onLedgerSaved and onConfigSaved are called right after their saves", async () => {
        const rig = execRig();
        await executeEffects(effects, rig.context);
        expect(rig.order.indexOf("onLedgerSaved")).toBe(rig.order.indexOf("end saveLedger") + 1);
        expect(rig.order.indexOf("onConfigSaved")).toBe(rig.order.indexOf("end saveConfig") + 1);
      });

      it("error is undefined, unsent and unpushed are empty, and stores is { ledger: true, copy: true, config: true }", async () => {
        const outcome = await executeEffects(effects, execRig().context);
        expect(outcome).toEqual({
          error: undefined,
          unsent: [],
          unpushed: [],
          stores: { ledger: true, copy: true, config: true },
        });
      });
    });

    describe("With a publish of one TRVZB day", () => {
      it("the transport's publish receives binding.encode of that day, for that valve", async () => {
        const rig = execRig();
        await executeEffects(
          [{ kind: "publish", valveId: A, values: { day_mon: DAY } }],
          rig.context,
        );
        expect(rig.publishes).toEqual([
          { deviceId: A, payload: TRVZB_BINDING.encode({ day_mon: DAY }) },
        ]);
      });
    });

    describe("With publishSetpoint 20.5 and pushTemperature 19.6", () => {
      it("the transport's publish receives binding.encodeSetpoint(20.5), then binding.encodeTemperature(19.6)", async () => {
        const rig = execRig();
        await executeEffects(
          [
            { kind: "publishSetpoint", valveId: A, celsius: 20.5 },
            { kind: "pushTemperature", valveId: A, celsius: 19.6 },
          ],
          rig.context,
        );
        expect(rig.publishes).toEqual([
          { deviceId: A, payload: TRVZB_BINDING.encodeSetpoint(20.5) },
          { deviceId: A, payload: TRVZB_BINDING.encodeTemperature(19.6) },
        ]);
      });
    });

    describe("With a refresh for a TRVZB", () => {
      it("the transport's read receives binding.encodeRefresh()", async () => {
        const rig = execRig();
        await executeEffects([{ kind: "refresh", valveId: A }], rig.context);
        expect(rig.reads).toEqual([{ deviceId: A, payload: TRVZB_BINDING.encodeRefresh() }]);
      });
    });

    describe("With a refresh for a valve whose binding returns nothing to read", () => {
      it("nothing is sent and the valve is not in unsent", async () => {
        const rig = execRig({ bindings: { [A]: NO_READ } });
        const outcome = await executeEffects([{ kind: "refresh", valveId: A }], rig.context);
        expect(rig.reads).toEqual([]);
        expect(outcome.unsent).toEqual([]);
      });

      it("onSent is not called", async () => {
        const rig = execRig({ bindings: { [A]: NO_READ } });
        await executeEffects([{ kind: "refresh", valveId: A }], rig.context);
        expect(rig.order.filter((line) => line.startsWith("onSent"))).toEqual([]);
      });
    });

    describe("With a refresh for A and a publish for B that both go out", () => {
      it('onSent is called with (A, "refresh") right after A\'s read and before B\'s publish starts, then with (B, "publish")', async () => {
        const rig = execRig();
        await executeEffects(
          [
            { kind: "refresh", valveId: A },
            { kind: "publish", valveId: B, values: { day_mon: DAY } },
          ],
          rig.context,
        );
        expect(rig.order).toEqual([
          `start read ${A}`,
          `end read ${A}`,
          `onSent ${A} refresh`,
          `start publish ${B}`,
          `end publish ${B}`,
          `onSent ${B} publish`,
        ]);
      });
    });

    describe("With a publish that rejects, a publishSetpoint and a pushTemperature", () => {
      it("onSent is called for none of them", async () => {
        const rig = execRig({ fail: { [`publish ${A}`]: "mqtt_timeout" } });
        await executeEffects(
          [
            { kind: "publish", valveId: A, values: { day_mon: DAY } },
            { kind: "publishSetpoint", valveId: B, celsius: 20 },
            { kind: "pushTemperature", valveId: B, celsius: 19 },
          ],
          rig.context,
        );
        expect(rig.order.filter((line) => line.startsWith("onSent"))).toEqual([]);
      });
    });

    describe("With saveConfig while overwriteUnreadable is true", () => {
      it("the config store's save receives overwriteUnreadable true", async () => {
        const rig = execRig({ overwriteUnreadable: true });
        await executeEffects([{ kind: "saveConfig", stored: STORED }], rig.context);
        expect(rig.overwrite).toEqual([true]);
      });
    });

    describe("With a saveLedger that rejects, followed by saveConfig, a pushTemperature for valve A and a publish for A", () => {
      const effects: Effect[] = [
        { kind: "saveLedger", ledger: EMPTY_LEDGER },
        { kind: "saveConfig", stored: STORED },
        { kind: "pushTemperature", valveId: A, celsius: 19 },
        { kind: "publish", valveId: A, values: { day_mon: DAY } },
      ];

      it("saveConfig, the push and the publish are not executed", async () => {
        const rig = execRig({ fail: { saveLedger: "io_failed" } });
        await executeEffects(effects, rig.context);
        expect(rig.order).toEqual(["start saveLedger", "fail saveLedger"]);
      });

      it("error is the rejection, unsent is [A] and unpushed is [A]", async () => {
        const outcome = await executeEffects(
          effects,
          execRig({ fail: { saveLedger: "io_failed" } }).context,
        );
        expect(codeOf(outcome.error)).toBe("io_failed");
        expect(outcome.unsent).toEqual([A]);
        expect(outcome.unpushed).toEqual([A]);
      });

      it("stores is { ledger: false }", async () => {
        const outcome = await executeEffects(
          effects,
          execRig({ fail: { saveLedger: "io_failed" } }).context,
        );
        expect(outcome.stores).toEqual({ ledger: false });
      });
    });

    const abc: Effect[] = [A, B, C].map((valveId) => ({
      kind: "publish",
      valveId,
      values: { day_mon: DAY },
    }));

    describe("With publishes for A, B and C, A's rejecting with mqtt_not_connected", () => {
      it("B's and C's are not executed", async () => {
        const rig = execRig({ fail: { [`publish ${A}`]: "mqtt_not_connected" } });
        await executeEffects(abc, rig.context);
        expect(rig.order).toEqual([`start publish ${A}`, `fail publish ${A}`]);
      });

      it("unsent is [A, B, C]", async () => {
        const outcome = await executeEffects(
          abc,
          execRig({ fail: { [`publish ${A}`]: "mqtt_not_connected" } }).context,
        );
        expect(outcome.unsent).toEqual([A, B, C]);
      });
    });

    describe("With publishes for A, B and C, A's rejecting with device_unknown", () => {
      it("B's and C's are executed", async () => {
        const rig = execRig({ fail: { [`publish ${A}`]: "device_unknown" } });
        await executeEffects(abc, rig.context);
        expect(rig.publishes.map((p) => p.deviceId)).toEqual([B, C]);
      });

      it("error is the rejection and unsent is [A]", async () => {
        const outcome = await executeEffects(
          abc,
          execRig({ fail: { [`publish ${A}`]: "device_unknown" } }).context,
        );
        expect(codeOf(outcome.error)).toBe("device_unknown");
        expect(outcome.unsent).toEqual([A]);
      });
    });

    describe("With publishes for A, B and C, A's rejecting with mqtt_refused", () => {
      it("B's and C's are executed", async () => {
        const rig = execRig({ fail: { [`publish ${A}`]: "mqtt_refused" } });
        await executeEffects(abc, rig.context);
        expect(rig.publishes.map((p) => p.deviceId)).toEqual([B, C]);
      });

      it("error is the rejection and unsent is [A]", async () => {
        const outcome = await executeEffects(
          abc,
          execRig({ fail: { [`publish ${A}`]: "mqtt_refused" } }).context,
        );
        expect(codeOf(outcome.error)).toBe("mqtt_refused");
        expect(outcome.unsent).toEqual([A]);
      });
    });

    describe("With a binding whose encode throws for A, followed by a publish for B", () => {
      it("B's publish is executed, error is the thrown value and unsent is [A]", async () => {
        const thrown = new RangeError("unknown sensor source");
        const throwing: Binding = {
          ...TRVZB_BINDING,
          encode: () => {
            throw thrown;
          },
        };
        const rig = execRig({ bindings: { [A]: throwing } });
        const outcome = await executeEffects(
          [
            { kind: "publish", valveId: A, values: { day_mon: DAY } },
            { kind: "publish", valveId: B, values: { day_mon: DAY } },
          ],
          rig.context,
        );
        expect(rig.publishes.map((p) => p.deviceId)).toEqual([B]);
        expect(outcome.error).toBe(thrown);
        expect(outcome.unsent).toEqual([A]);
      });
    });

    describe("With a pushTemperature for A that rejects with mqtt_timeout, followed by a publish for A and a refresh for B", () => {
      const effects: Effect[] = [
        { kind: "pushTemperature", valveId: A, celsius: 19 },
        { kind: "publish", valveId: A, values: { day_mon: DAY } },
        { kind: "refresh", valveId: B },
      ];

      it("A's publish is not executed and B's refresh is", async () => {
        const rig = execRig({ fail: { [`publish ${A}`]: "mqtt_timeout" } });
        await executeEffects(effects, rig.context);
        expect(rig.order.filter((line) => line.startsWith("start"))).toEqual([
          `start publish ${A}`,
          `start read ${B}`,
        ]);
      });

      it("unpushed is [A] and unsent is [A]", async () => {
        const outcome = await executeEffects(
          effects,
          execRig({ fail: { [`publish ${A}`]: "mqtt_timeout" } }).context,
        );
        expect(outcome.unpushed).toEqual([A]);
        expect(outcome.unsent).toEqual([A]);
      });
    });

    describe("With a pushTemperature for A that rejects with mqtt_not_connected, followed by a pushTemperature and a refresh for B", () => {
      it("nothing more is executed; unpushed is [A, B] and unsent is [B]", async () => {
        const rig = execRig({ fail: { [`publish ${A}`]: "mqtt_not_connected" } });
        const outcome = await executeEffects(
          [
            { kind: "pushTemperature", valveId: A, celsius: 19 },
            { kind: "pushTemperature", valveId: B, celsius: 19 },
            { kind: "refresh", valveId: B },
          ],
          rig.context,
        );
        expect(rig.order.filter((line) => line.startsWith("start"))).toEqual([
          `start publish ${A}`,
        ]);
        expect(outcome.unpushed).toEqual([A, B]);
        expect(outcome.unsent).toEqual([B]);
      });
    });

    describe("With a pushTemperature that rejects as the last effect", () => {
      it("error is the rejection, unpushed holds the valve and unsent is empty", async () => {
        const outcome = await executeEffects(
          [{ kind: "pushTemperature", valveId: A, celsius: 19 }],
          execRig({ fail: { [`publish ${A}`]: "mqtt_timeout" } }).context,
        );
        expect(codeOf(outcome.error)).toBe("mqtt_timeout");
        expect(outcome.unpushed).toEqual([A]);
        expect(outcome.unsent).toEqual([]);
      });
    });

    describe("With failures for A and for C", () => {
      it("error is A's", async () => {
        const outcome = await executeEffects(
          abc,
          execRig({
            fail: { [`publish ${A}`]: "mqtt_timeout", [`publish ${C}`]: "device_unknown" },
          }).context,
        );
        expect(codeOf(outcome.error)).toBe("mqtt_timeout");
      });
    });

    describe("With a publish for a valve that has no binding", () => {
      it("error has code device_unknown and unsent holds the valve", async () => {
        const outcome = await executeEffects(
          [{ kind: "publish", valveId: A, values: { day_mon: DAY } }],
          execRig({ bindings: { [A]: undefined } }).context,
        );
        expect(codeOf(outcome.error)).toBe("device_unknown");
        expect(outcome.unsent).toEqual([A]);
      });
    });

    describe("Always", () => {
      it("the returned promise does not reject", async () => {
        const context: EffectContext = {
          ...execRig().context,
          onSent: () => {
            throw new Error("a listener failed");
          },
          bindingOf: () => {
            throw new Error("lookup failed");
          },
        };
        await expect(
          executeEffects(
            [
              { kind: "refresh", valveId: A },
              { kind: "publish", valveId: B, values: { day_mon: DAY } },
            ],
            context,
          ),
        ).resolves.toBeDefined();
      });
    });
  });

  describe("start", () => {
    describe("With no stored files", () => {
      it("snapshot has configState empty, revision 0, no rooms and no problems", async () => {
        const rig = await boot();
        const snapshot = rig.rt.snapshot();
        expect(snapshot.configState).toBe("empty");
        expect(snapshot.revision).toBe(0);
        expect(snapshot.rooms).toEqual([]);
        expect(snapshot.problems).toEqual([]);
      });

      it("one tick has run: tickedAt is set", async () => {
        const rig = await boot();
        expect(rig.rt.snapshot().tickedAt).toBe(T);
      });
    });

    describe("With a stored config that has a valve in a room", () => {
      it("the ledger store was loaded with expected true", async () => {
        const rig = await boot({ seed: managedSeed([A]) });
        expect(rig.stores.expected).toEqual([true]);
      });
    });

    describe("With a stored config that has no rooms and nothing releasing", () => {
      it("the ledger store was loaded with expected false", async () => {
        const rig = await boot({ seed: { config: raw({ rooms: [] }) } });
        expect(rig.stores.expected).toEqual([false]);
      });
    });

    describe("With a stored config that has no rooms and one valve in releasing", () => {
      it("the ledger store was loaded with expected true", async () => {
        const rig = await boot({
          seed: { config: raw({ rooms: [] }), releasing: { [A]: T - HOUR }, ledger: [record(A)] },
        });
        expect(rig.stores.expected).toEqual([true]);
      });
    });

    describe("With an unreadable config file", () => {
      it("the ledger store was loaded with expected true", async () => {
        const rig = await boot({ seed: { config: "unreadable" } });
        expect(rig.stores.expected).toEqual([true]);
      });

      it("snapshot has configState unreadable and a config_unreadable problem", async () => {
        const rig = await boot({ seed: { config: "unreadable" } });
        const snapshot = rig.rt.snapshot();
        expect(snapshot.configState).toBe("unreadable");
        expect(problemKinds(snapshot)).toContain("config_unreadable");
      });
    });

    describe("With no stored files and a readable copy that holds a record", () => {
      const seed: Seed = { copy: [record(A, "external")] };

      it("snapshot has ledgerReadable false, originalsCopyRecords 1 and a ledger_unreadable problem", async () => {
        const rig = await boot({ seed });
        const snapshot = rig.rt.snapshot();
        expect(snapshot.ledgerReadable).toBe(false);
        expect(snapshot.originalsCopyRecords).toBe(1);
        expect(problemKinds(snapshot)).toContain("ledger_unreadable");
      });

      it("apply of a config naming that valve rejects with ChangeRefused ledger_unreadable", async () => {
        const rig = await boot({ seed });
        rig.say(A, "a1");
        const error = await rejectionOf(rig.rt.apply(raw(), APPLY));
        expect(error).toBeInstanceOf(ChangeRefused);
        expect(codeOf(error)).toBe("ledger_unreadable");
      });

      it("after importOriginals(false) and the same apply, the valve is rejoining and its record is the copy's", async () => {
        const rig = await boot({ seed });
        rig.say(A, "a1");
        await rig.rt.importOriginals(false);
        const plan = await rig.rt.apply(raw(), APPLY);
        expect(plan.rejoining).toEqual([A]);
        expect(plan.ledger?.records.get(A)).toEqual(record(A, "external"));
      });
    });

    describe("With a transport listing a TRVZB in a room, a TRVZB in no room, a room's sensor and a sensor of no room", () => {
      it("follow receives both valves and neither sensor (room sensors are read through Home Assistant only)", async () => {
        const rig = await boot({
          devices: [trvzb(A), trvzb(B), sensorDevice(S), sensorDevice("z2m:0x5f")],
          seed: {
            config: raw({ rooms: [{ valves: [A], sensors: [ROOM_SENSOR] }] }),
            ledger: [record(A)],
          },
        });
        expect([...rig.z2m.followed()].sort()).toEqual([A, B]);
      });
    });

    describe("With a managed valve its transport does not list", () => {
      it("follow still holds its id", async () => {
        const rig = await boot({ devices: [], seed: managedSeed([A]) });
        expect([...rig.z2m.followed()]).toEqual([A]);
      });
    });

    describe("With a room sensor ha:sensor.x", () => {
      it("the Home Assistant link is told to watch sensor.x", async () => {
        const ha = createStubHaLink();
        await boot({
          ha,
          seed: {
            config: raw({ rooms: [{ valves: [A], sensors: ["ha:sensor.x"] }] }),
            ledger: [record(A)],
          },
        });
        expect(ha.watched().at(-1)).toEqual(new Set(["sensor.x"]));
      });
    });

    describe("With a managed valve that sends no message for 2 h after the start", () => {
      it("it is asked to report while the tick decides so, and after 2 h the tick reports it silent", async () => {
        const rig = await boot({ seed: managedSeed([A]) });
        expect(sends(rig, A).map((s) => s.kind)).toEqual(["read"]);
        await rig.advance(2 * MINUTE);
        expect(sends(rig, A).map((s) => s.kind)).toEqual(["read", "read"]);
        expect(problemKinds(rig.rt.snapshot())).not.toContain("valve_silent");
        await rig.advance(2 * HOUR - 2 * MINUTE + TICK_INTERVAL_MS);
        expect(problemKinds(rig.rt.snapshot())).toContain("valve_silent");
      });
    });

    describe("With a Home Assistant link that is not up yet", () => {
      it("start resolves without waiting and snapshot has links.ha false", async () => {
        const ha = createStubHaLink();
        ha.setState("connecting");
        const rig = await boot({ ha });
        expect(rig.rt.snapshot().links.ha).toBe(false);
      });
    });

    describe("With no Home Assistant link", () => {
      it("snapshot's links has no ha entry", async () => {
        const rig = await boot({ ha: null });
        expect(Object.hasOwn(rig.rt.snapshot().links, "ha")).toBe(false);
      });
    });

    describe("With a valve whose friendly name holds + or #", () => {
      it("a warning that names the valve is logged", async () => {
        const rig = await boot({ devices: [{ ...trvzb(A), name: "hall/valve+1" }] });
        expect(rig.logs.some((line) => line.startsWith("warn") && line.includes("topic"))).toBe(
          true,
        );
      });

      it("the valve is not in the follow set, and a managed one is reported unsupported", async () => {
        const rig = await boot({
          devices: [{ ...trvzb(A), name: "hall/valve+1" }, trvzb(B)],
          seed: managedSeed([A]),
        });
        expect([...rig.z2m.followed()]).toEqual([B]);
        expect(rig.rt.snapshot().problems).toContainEqual(
          expect.objectContaining({ kind: "valve_unsupported", subject: { kind: "valve", id: A } }),
        );
      });
    });
  });

  describe("events", () => {
    describe("With a message for a TRVZB that is in no room", () => {
      it("diagnostics show its decoded values", async () => {
        const rig = await boot();
        rig.say(A, "a1", trvzbMessage("a1", "remote_temperature"));
        const devices = rig.rt.diagnostics().devices as Record<string, Record<string, unknown>>;
        expect(devices[A]?.values).toMatchObject({ sensor_source: "external" });
      });
    });

    describe("With a message for a managed valve", () => {
      it("a tick runs EVENT_DEBOUNCE_MS later", async () => {
        const rig = await boot({ seed: managedSeed([A]) });
        await rig.advance(5000);
        rig.say(A, "a1");
        rig.clock.advance(EVENT_DEBOUNCE_MS - 1);
        expect(rig.rt.snapshot().tickedAt).toBe(T);
        await rig.advance(1);
        expect(rig.rt.snapshot().tickedAt).toBe(T + 5000 + EVENT_DEBOUNCE_MS);
      });
    });

    describe("With ten messages inside one second", () => {
      it("one tick runs", async () => {
        const rig = await boot({ seed: managedSeed([A]) });
        const before = rig.snapshots.length;
        for (let i = 0; i < 10; i += 1) {
          rig.say(A, `a${String(i)}`);
          rig.clock.advance(90);
        }
        await rig.advance(EVENT_DEBOUNCE_MS);
        expect(rig.snapshots.length - before).toBe(1);
      });
    });

    describe("With bridge_restarted from a transport", () => {
      it("every group of every valve of that transport is marked", async () => {
        const rig = await boot({ devices: [trvzb(A), trvzb(B)], seed: managedSeed([A, B]) });
        await inSync(rig, [A, B]);
        expect(rig.marks(A)).toEqual({});
        const at = rig.clock.nowMs();
        rig.z2m.emit({ kind: "bridge_restarted" });
        for (const id of [A, B]) {
          expect(rig.marks(id).schedule?.at).toBe(at);
          expect(rig.marks(id).sensor_source?.at).toBe(at);
        }
      });
    });

    describe("With rejoined for one valve", () => {
      it("every group of that valve is marked and other valves are untouched", async () => {
        const rig = await boot({ devices: [trvzb(A), trvzb(B)], seed: managedSeed([A, B]) });
        await inSync(rig, [A, B]);
        const at = rig.clock.nowMs();
        rig.z2m.emit({ kind: "rejoined", deviceId: A });
        expect(Object.keys(rig.marks(A)).sort()).toEqual(["schedule", "sensor_source"]);
        expect(rig.marks(A).schedule?.at).toBe(at);
        expect(rig.marks(B)).toEqual({});
      });
    });

    describe("With link_down", () => {
      it("a tick runs EVENT_DEBOUNCE_MS later", async () => {
        const rig = await boot();
        await rig.advance(5000);
        rig.z2m.setLink(false);
        await rig.advance(EVENT_DEBOUNCE_MS);
        expect(rig.rt.snapshot().tickedAt).toBe(T + 5000 + EVENT_DEBOUNCE_MS);
      });

      it("the next snapshot has that transport's link false", async () => {
        const rig = await boot();
        rig.z2m.setLink(false);
        await rig.advance(EVENT_DEBOUNCE_MS);
        expect(rig.snapshots.at(-1)?.links.z2m).toBe(false);
      });
    });

    describe("With link_up", () => {
      it("every group of every valve of that transport is marked", async () => {
        const rig = await boot({ devices: [trvzb(A), trvzb(B)], seed: managedSeed([A, B]) });
        await inSync(rig, [A, B]);
        const at = rig.clock.nowMs();
        rig.z2m.emit({ kind: "link_up" });
        for (const id of [A, B]) {
          expect(rig.marks(id).schedule?.at).toBe(at);
          expect(rig.marks(id).sensor_source?.at).toBe(at);
        }
      });
    });

    describe("With devices_changed after a TRVZB was added", () => {
      it("follow is called again and holds the new valve", async () => {
        const rig = await boot();
        const calls = rig.z2m.followCalls().length;
        rig.z2m.setDevices([trvzb(A), trvzb(B)]);
        expect(rig.z2m.followCalls().length).toBe(calls + 1);
        expect(rig.z2m.followed().has(B)).toBe(true);
      });

      it("a tick runs EVENT_DEBOUNCE_MS later", async () => {
        const rig = await boot();
        await rig.advance(5000);
        rig.z2m.setDevices([trvzb(A), trvzb(B)]);
        await rig.advance(EVENT_DEBOUNCE_MS);
        expect(rig.rt.snapshot().tickedAt).toBe(T + 5000 + EVENT_DEBOUNCE_MS);
      });
    });

    describe("With bridge_restarted arriving while a tick is awaiting a publish", () => {
      it("the valves' groups are still marked after the tick has finished", async () => {
        const rig = await boot({ seed: managedSeed([A]) });
        await hear(rig, [A]);
        const release = rig.z2m.holdSends();
        await stepUntilAttempt(rig, EVENT_DEBOUNCE_MS, (s) => s.kind === "publish");
        const at = rig.clock.nowMs();
        rig.z2m.emit({ kind: "bridge_restarted" });
        release();
        // Not settled(): the queued event arms a debounce, and that tick would ask the valve.
        await vi.waitFor(() => {
          expect(rig.marks(A).schedule).toEqual({ at, askedAt: undefined, writtenAt: undefined });
          expect(rig.marks(A).sensor_source).toEqual({
            at,
            askedAt: undefined,
            writtenAt: undefined,
          });
        });
      });
    });

    describe("With an event of the Home Assistant link", () => {
      it("a tick runs EVENT_DEBOUNCE_MS later", async () => {
        const ha = createStubHaLink();
        const rig = await boot({ ha });
        await rig.advance(5000);
        ha.emit({ kind: "changed" });
        await rig.advance(EVENT_DEBOUNCE_MS);
        expect(rig.rt.snapshot().tickedAt).toBe(T + 5000 + EVENT_DEBOUNCE_MS);
      });
    });
  });

  describe("sensor readings", () => {
    const seed = managedSeed([A], [ROOM_SENSOR]);
    const sensorOf = (rig: Rig) =>
      rig.rt.snapshot().sensors.find((s) => s.sensorId === ROOM_SENSOR);

    describe("With an ha: sensor and no Home Assistant link configured", () => {
      it("it has no value and pending is false", async () => {
        const rig = await boot({ ha: null, seed });
        expect(sensorOf(rig)).toMatchObject({
          celsius: undefined,
          seenAt: undefined,
          pending: false,
        });
      });
    });

    describe("With an ha: sensor and the link down, a value having been known before", () => {
      it("it has no value and pending is true", async () => {
        const ha = createStubHaLink();
        haSensor(ha, "sensor.living", 19.6, T);
        const rig = await boot({ ha, seed });
        expect(sensorOf(rig)?.celsius).toBe(19.6);
        ha.setState("down");
        expect(sensorOf(rig)).toMatchObject({
          celsius: undefined,
          seenAt: undefined,
          pending: true,
        });
      });
    });

    describe("With an ha: sensor, the link up, 19.6 reported at time T", () => {
      it("value is 19.6, seenAt is T and pending is false", async () => {
        const ha = createStubHaLink();
        haSensor(ha, "sensor.living", 19.6, T - MINUTE);
        const rig = await boot({ ha, seed });
        expect(sensorOf(rig)).toMatchObject({ celsius: 19.6, seenAt: T - MINUTE, pending: false });
      });
    });

    describe("With an ha: sensor whose own entity reported at T and another entity of its device at U later than T", () => {
      it("seenAt is U", async () => {
        // The link folds the device's entities into lastReportedAt; the runtime takes that time.
        const ha = createStubHaLink();
        haSensor(ha, "sensor.living", 19.6, T - 30 * 1000);
        const rig = await boot({ ha, seed });
        expect(sensorOf(rig)?.seenAt).toBe(T - 30 * 1000);
      });
    });

    describe("With an ha: sensor that reported 19.6 at T and then turns unavailable", () => {
      it("value is 19.6 and seenAt is T", async () => {
        const ha = createStubHaLink();
        // The link keeps the last value and time of an entity that turned unavailable.
        haSensor(ha, "sensor.living", 19.6, T);
        const rig = await boot({ ha, seed });
        await rig.advance(HOUR);
        expect(sensorOf(rig)).toMatchObject({ celsius: 19.6, seenAt: T });
      });

      it("the room is fresh until the staleness timeout has passed since T, and stale after it", async () => {
        const ha = createStubHaLink();
        haSensor(ha, "sensor.living", 19.6, T);
        const rig = await boot({ ha, seed });
        await rig.advance(2 * HOUR);
        expect(rig.rt.snapshot().rooms[0]?.status?.degraded).toBe(false);
        expect(problemKinds(rig.rt.snapshot())).not.toContain("room_no_temperature");
        await rig.advance(TICK_INTERVAL_MS);
        expect(problemKinds(rig.rt.snapshot())).toContain("room_no_temperature");
      });
    });

    describe("With an ha: sensor the link calls not observable", () => {
      it("seenAt is now and the sensor is in unobservableSensors", async () => {
        const ha = createStubHaLink();
        haSensor(ha, "sensor.living", 19.6, T - HOUR, false);
        const rig = await boot({ ha, seed });
        expect(sensorOf(rig)).toMatchObject({ seenAt: T, unobservable: true });
        expect(rig.rt.diagnostics().sensors).toMatchObject({
          [ROOM_SENSOR]: { seenAt: T, unobservable: true },
        });
      });

      it("the tick raises sensor_liveness_unobservable for it", async () => {
        const ha = createStubHaLink();
        haSensor(ha, "sensor.living", 19.6, T - HOUR, false);
        const rig = await boot({ ha, seed });
        expect(
          rig.rt.snapshot().problems.find((p) => p.kind === "sensor_liveness_unobservable")?.subject
            .id,
        ).toBe(ROOM_SENSOR);
      });
    });

    describe("With an ha: sensor that has no state while the link is up", () => {
      it("it has no value and pending is false", async () => {
        const rig = await boot({ seed });
        expect(sensorOf(rig)).toMatchObject({
          celsius: undefined,
          seenAt: undefined,
          pending: false,
        });
      });
    });
  });

  describe("time zone", () => {
    const tokyo = (): StubHaLink => {
      const ha = createStubHaLink();
      ha.setHouse({ timeZone: "Asia/Tokyo", language: "en" });
      return ha;
    };

    describe('With timezone "Europe/Amsterdam" in the config and a Home Assistant house in "Asia/Tokyo"', () => {
      it("snapshot's timeZone is Europe/Amsterdam", async () => {
        const rig = await boot({ ha: tokyo(), seed: managedSeed([A]) });
        expect(rig.rt.snapshot().timeZone).toBe("Europe/Amsterdam");
      });
    });

    describe('With no timezone in the config and a Home Assistant house in "Asia/Tokyo"', () => {
      it("snapshot's timeZone is Asia/Tokyo", async () => {
        const rig = await boot({
          ha: tokyo(),
          seed: { config: raw({ timezone: null }), ledger: [record(A)] },
        });
        expect(rig.rt.snapshot().timeZone).toBe("Asia/Tokyo");
      });
    });

    describe("With no timezone in the config and a Home Assistant link that has never connected", () => {
      it("snapshot's timeZone is processTimeZone", async () => {
        const ha = createStubHaLink();
        ha.setState("connecting");
        const rig = await boot({
          ha,
          processTimeZone: "America/New_York",
          seed: { config: raw({ timezone: null }), ledger: [record(A)] },
        });
        expect(rig.rt.snapshot().timeZone).toBe("America/New_York");
      });
    });

    describe("With no timezone in the config and no Home Assistant link", () => {
      it("snapshot's timeZone is processTimeZone", async () => {
        const rig = await boot({
          ha: null,
          processTimeZone: "America/New_York",
          seed: { config: raw({ timezone: null }), ledger: [record(A)] },
        });
        expect(rig.rt.snapshot().timeZone).toBe("America/New_York");
      });
    });

    describe("With a Home Assistant zone name Temporal does not accept", () => {
      it("snapshot's timeZone is processTimeZone", async () => {
        const ha = createStubHaLink();
        ha.setHouse({ timeZone: "Mars/Olympus", language: "en" });
        const rig = await boot({
          ha,
          processTimeZone: "America/New_York",
          seed: { config: raw({ timezone: null }), ledger: [record(A)] },
        });
        expect(rig.rt.snapshot().timeZone).toBe("America/New_York");
      });
    });
  });

  describe("ticks", () => {
    describe("Every TICK_INTERVAL_MS", () => {
      it("a tick runs", async () => {
        const rig = await boot();
        await rig.advance(TICK_INTERVAL_MS);
        expect(rig.rt.snapshot().tickedAt).toBe(T + TICK_INTERVAL_MS);
        await rig.advance(TICK_INTERVAL_MS);
        expect(rig.rt.snapshot().tickedAt).toBe(T + 2 * TICK_INTERVAL_MS);
      });
    });

    /** Managed A, observed; returns once the tick at T + 2 min is awaiting its held read of A. */
    async function heldAsk(rig: Rig): Promise<() => void> {
      rig.say(A, "a-1");
      await rig.advance(90 * 1000);
      const release = rig.z2m.holdSends(A);
      const before = rig.z2m.attempts().length;
      rig.clock.advance(TICK_INTERVAL_MS);
      await vi.waitFor(() => {
        expect(rig.z2m.attempts().length).toBe(before + 1);
      });
      return release;
    }

    describe("With two ticks requested while one is executing effects", () => {
      it("exactly one more tick runs after it", async () => {
        const ha = createStubHaLink();
        const rig = await boot({ ha, seed: managedSeed([A]) });
        const release = await heldAsk(rig);
        const before = rig.snapshots.length;
        rig.clock.advance(TICK_INTERVAL_MS);
        ha.emit({ kind: "changed" });
        rig.clock.advance(EVENT_DEBOUNCE_MS);
        release();
        await rig.rt.settled();
        expect(rig.snapshots.length - before).toBe(2);
      });
    });

    describe("With apply called while a tick is executing effects", () => {
      it("apply starts after the tick has finished", async () => {
        const ha = createStubHaLink();
        haSensor(ha, "sensor.living", 19.6, T);
        const rig = await boot({ ha, devices: [trvzb(A), trvzb(B)], seed: managedSeed([A]) });
        rig.say(B, "b-1");
        const release = await heldAsk(rig);
        const applied = rig.rt.apply(
          raw({ rooms: [{ valves: [A] }, { id: "kitchen", valves: [B], sensors: [ROOM_SENSOR] }] }),
          APPLY,
        );
        await new Promise((resolve) => setImmediate(resolve));
        expect(ha.infoCalls()).toEqual([]);
        release();
        await applied;
        expect(ha.infoCalls()).toEqual(["sensor.living"]);
      });
    });

    describe("After each tick", () => {
      it("every listener receives a snapshot with that tick's rooms and problems", async () => {
        const rig = await boot({ seed: managedSeed([A]) });
        const second: Snapshot[] = [];
        rig.rt.subscribe((snapshot) => second.push(snapshot));
        await rig.advance(TICK_INTERVAL_MS);
        const now = rig.rt.snapshot();
        for (const received of [rig.snapshots.at(-1), second.at(-1)]) {
          expect(received?.tickedAt).toBe(T + TICK_INTERVAL_MS);
          expect(received?.rooms).toEqual(now.rooms);
          expect(received?.problems).toEqual(now.problems);
        }
      });
    });

    describe("With a listener that throws", () => {
      it("the other listeners still receive the snapshot", async () => {
        const rig = await boot();
        rig.rt.subscribe(() => {
          throw new Error("listener failed");
        });
        const after: Snapshot[] = [];
        rig.rt.subscribe((snapshot) => after.push(snapshot));
        await rig.advance(TICK_INTERVAL_MS);
        expect(after).toHaveLength(1);
        expect(rig.logs.some((line) => line.startsWith("error"))).toBe(true);
      });
    });

    describe("After the function returned by subscribe was called", () => {
      it("that listener receives no further snapshot", async () => {
        const rig = await boot();
        const got: Snapshot[] = [];
        const unsubscribe = rig.rt.subscribe((snapshot) => got.push(snapshot));
        await rig.advance(TICK_INTERVAL_MS);
        unsubscribe();
        await rig.advance(TICK_INTERVAL_MS);
        expect(got).toHaveLength(1);
      });
    });

    describe("With settled awaited while an event's tick is waiting for its debounce", () => {
      it("it resolves only after that tick has run", async () => {
        const rig = await boot({ seed: managedSeed([A]) });
        await rig.advance(5000);
        rig.say(A, "a-1");
        let resolved = false;
        const settled = rig.rt.settled().then(() => {
          resolved = true;
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(resolved).toBe(false);
        rig.clock.advance(EVENT_DEBOUNCE_MS);
        await settled;
        expect(rig.rt.snapshot().tickedAt).toBe(T + 5000 + EVENT_DEBOUNCE_MS);
      });
    });

    describe("With settled awaited while a tick is executing effects and another is waiting", () => {
      it("it resolves only after both have finished", async () => {
        const rig = await boot({ seed: managedSeed([A]) });
        const release = await heldAsk(rig);
        const before = rig.snapshots.length;
        rig.clock.advance(TICK_INTERVAL_MS);
        let resolved = false;
        const settled = rig.rt.settled().then(() => {
          resolved = true;
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(resolved).toBe(false);
        release();
        await settled;
        expect(rig.snapshots.length - before).toBe(2);
      });
    });
  });

  describe("clock jump", () => {
    const seed = managedSeed([A], [ROOM_SENSOR]);
    async function jumped(by: number): Promise<Rig & { at: number }> {
      const ha = createStubHaLink();
      haSensor(ha, "sensor.living", 19.6, T);
      const rig = await boot({ ha, seed });
      await inSync(rig, [A]);
      await rig.advance(TICK_INTERVAL_MS);
      rig.clock.jump(by);
      await rig.advance(TICK_INTERVAL_MS);
      return Object.assign(rig, { at: rig.rt.snapshot().tickedAt ?? 0 });
    }

    describe("With the wall clock stepping forward 3 h between two ticks (the monotonic clock moves 30 s)", () => {
      it("link_up is applied for every transport before the tick: no valve is reported silent and no sensor stale", async () => {
        const rig = await jumped(3 * HOUR);
        const kinds = problemKinds(rig.rt.snapshot());
        expect(kinds).not.toContain("valve_silent");
        expect(kinds).not.toContain("sensor_stale");
        expect(kinds).not.toContain("room_no_temperature");
        expect(rig.rt.snapshot().devices.find((d) => d.deviceId === A)?.heardAt).toBeUndefined();
      });

      it("every group of every valve is marked", async () => {
        const rig = await jumped(3 * HOUR);
        expect(rig.marks(A).schedule?.at).toBe(rig.at);
        expect(rig.marks(A).sensor_source?.at).toBe(rig.at);
      });

      it("the jump is logged", async () => {
        const rig = await jumped(3 * HOUR);
        expect(rig.logs.some((line) => line.startsWith("warn") && line.includes("clock"))).toBe(
          true,
        );
      });
    });

    describe("With an ha: sensor last reported before a forward jump of 3 h", () => {
      it("its seenAt is the time the jump was seen and the room stays fresh", async () => {
        const rig = await jumped(3 * HOUR);
        const sensor = rig.rt.snapshot().sensors.find((s) => s.sensorId === ROOM_SENSOR);
        expect(sensor?.seenAt).toBe(rig.at);
        expect(rig.rt.snapshot().rooms[0]?.status?.degraded).toBe(false);
      });

      it("the room turns stale one staleness timeout after the jump if nothing new is reported", async () => {
        const rig = await jumped(3 * HOUR);
        await rig.advance(2 * HOUR);
        expect(problemKinds(rig.rt.snapshot())).not.toContain("room_no_temperature");
        await rig.advance(TICK_INTERVAL_MS);
        expect(problemKinds(rig.rt.snapshot())).toContain("room_no_temperature");
      });
    });

    describe("With the wall clock stepping back 3 h between two ticks", () => {
      it("the same is applied", async () => {
        const rig = await jumped(-3 * HOUR);
        expect(rig.marks(A).schedule?.at).toBe(rig.at);
        expect(rig.marks(A).sensor_source?.at).toBe(rig.at);
        expect(rig.logs.some((line) => line.startsWith("warn") && line.includes("clock"))).toBe(
          true,
        );
      });
    });

    describe("With both clocks moving 30 s, or differing by 4 min", () => {
      it("nothing is applied", async () => {
        const rig = await jumped(0);
        expect(rig.marks(A)).toEqual({});
        rig.clock.jump(CLOCK_JUMP_MS - MINUTE);
        await rig.advance(TICK_INTERVAL_MS);
        expect(rig.marks(A)).toEqual({});
        expect(rig.logs.some((line) => line.includes("clock"))).toBe(false);
      });
    });
  });

  describe("send times and events during effects", () => {
    describe("With a refresh for valve B sent 3 s after the tick decided it (the clock advanced while A's publish was awaited)", () => {
      it("the askedAt of B's readable marks is the time of the send, not of the tick", async () => {
        const rig = await boot({
          devices: [trvzb(A), trvzb(B)],
          seed: managedSeed([A, B]),
          start: false,
        });
        const release = rig.z2m.holdSends(A);
        const started = rig.rt.start();
        await vi.waitFor(() => {
          expect(rig.z2m.attempts()).toHaveLength(1);
        });
        rig.clock.advance(3000);
        release();
        await started;
        await rig.rt.settled();
        expect(rig.marks(B).sensor_source?.askedAt).toBe(T + 3000);
      });
    });

    /** A and B (and C) managed and observed; the tick at T + 2 min asks each of them. */
    async function askingAt2Min(valves: readonly string[]): Promise<Rig> {
      const rig = await boot({ devices: valves.map((id) => trvzb(id)), seed: managedSeed(valves) });
      for (const id of valves) rig.say(id, `${id}-1`);
      await rig.advance(90 * 1000);
      return rig;
    }

    describe("With a heard device message from B arriving after the tick decided B's refresh and before the refresh was sent", () => {
      it("B's readable marks are still set after the tick has finished", async () => {
        const rig = await askingAt2Min([A, B]);
        const release = rig.z2m.holdSends(B);
        await stepUntilAttempt(rig, TICK_INTERVAL_MS, (s) => s.deviceId === B);
        rig.say(B, `${B}-2`, trvzbMessage(`${B}-2`, "remote_temperature"));
        rig.clock.advance(1000);
        release();
        await drained(rig);
        expect(rig.marks(B).sensor_source).toBeDefined();
      });

      it("the state holds the message's values", async () => {
        const rig = await askingAt2Min([A, B]);
        const release = rig.z2m.holdSends(B);
        await stepUntilAttempt(rig, TICK_INTERVAL_MS, (s) => s.deviceId === B);
        rig.say(B, `${B}-2`, trvzbMessage(`${B}-2`, "remote_temperature"));
        rig.clock.advance(1000);
        release();
        await drained(rig);
        const devices = rig.rt.diagnostics().devices as Record<string, Record<string, unknown>>;
        expect(devices[B]?.values).toMatchObject({ sensor_source: "external" });
      });
    });

    describe("With a heard device message from B arriving after B's refresh was sent, while a later effect is awaited", () => {
      it("B's readable marks are cleared after the tick has finished", async () => {
        const rig = await askingAt2Min([B, C]);
        const release = rig.z2m.holdSends(C);
        await stepUntilAttempt(rig, TICK_INTERVAL_MS, (s) => s.deviceId === C);
        rig.clock.advance(1000);
        rig.say(B, `${B}-2`);
        release();
        await drained(rig);
        expect(rig.marks(B).sensor_source).toBeUndefined();
      });
    });

    describe("With a heard device message arriving after a schedule publish for its mark was sent", () => {
      it("the schedule mark is cleared", async () => {
        const rig = await boot({ seed: managedSeed([A]) });
        await hear(rig, [A]);
        await rig.advance(1000);
        expect(sends(rig, A).at(-1)?.kind).toBe("publish");
        expect(rig.marks(A).schedule).toBeDefined();
        await rig.advance(1000);
        rig.say(A, "a-3");
        expect(rig.marks(A).schedule).toBeUndefined();
      });
    });

    describe("With three transport events arriving while effects run", () => {
      async function threeDuringEffects(): Promise<Rig & { arrivals: number[]; seen: unknown[] }> {
        const rig = await askingAt2Min([A]);
        const release = rig.z2m.holdSends(A);
        await stepUntilAttempt(rig, TICK_INTERVAL_MS, (s) => s.kind === "read");
        const arrivals: number[] = [];
        const seen: unknown[] = [];
        const messageAt = (): unknown =>
          (rig.rt.diagnostics().devices as Record<string, Record<string, unknown>>)[A]?.messageAt;
        for (const [i, source] of [
          "local_temperature",
          "local_temperature",
          "remote_temperature",
        ].entries()) {
          arrivals.push(rig.clock.nowMs());
          rig.say(A, `a-x${String(i)}`, trvzbMessage(`a-x${String(i)}`, source));
          seen.push(messageAt());
          rig.clock.advance(1000);
        }
        release();
        await drained(rig);
        return Object.assign(rig, { arrivals, seen });
      }

      it("none is applied before the last effect and its sent event", async () => {
        const rig = await threeDuringEffects();
        expect(rig.seen).toEqual([T, T, T]);
      });

      it("they are applied in arrival order, each with its arrival time as nowMs", async () => {
        const rig = await threeDuringEffects();
        const device = (rig.rt.diagnostics().devices as Record<string, Record<string, unknown>>)[A];
        expect(device?.messageAt).toBe(rig.arrivals[2]);
        expect(device?.heardAt).toBe(rig.arrivals[2]);
        expect(device?.values).toMatchObject({ sensor_source: "external" });
      });
    });

    describe("With transport events arriving while a save is awaited and while the copy's record count is read after the saves", () => {
      async function duringSaves(): Promise<Rig & { arrivals: number[]; seen: unknown[] }> {
        const rig = await boot();
        rig.say(A, "a-1");
        let openSave: () => void = () => undefined;
        let openCount: () => void = () => undefined;
        rig.stores.gates.ledgerSave = new Promise((resolve) => {
          openSave = resolve;
        });
        rig.stores.gates.copyRecords = new Promise((resolve) => {
          openCount = resolve;
        });
        const applied = rig.rt.apply(raw(), APPLY);
        const arrivals: number[] = [];
        const seen: unknown[] = [];
        const messageAt = (): unknown =>
          (rig.rt.diagnostics().devices as Record<string, Record<string, unknown>>)[A]?.messageAt;
        await vi.waitFor(() => {
          expect(rig.stores.reached).toContain("ledger.save");
        });
        arrivals.push(rig.clock.nowMs());
        rig.say(A, "a-x1", trvzbMessage("a-x1", "local_temperature"));
        seen.push(messageAt());
        rig.clock.advance(1000);
        openSave();
        await vi.waitFor(() => {
          expect(rig.stores.reached).toContain("copyRecords");
        });
        arrivals.push(rig.clock.nowMs());
        rig.say(A, "a-x2", trvzbMessage("a-x2", "remote_temperature"));
        seen.push(messageAt());
        rig.clock.advance(1000);
        openCount();
        await applied;
        return Object.assign(rig, { arrivals, seen });
      }

      it("none is applied before the copy's count has been read", async () => {
        const rig = await duringSaves();
        expect(rig.seen).toEqual([T, T]);
      });

      it("they are applied in arrival order, each with its arrival time as nowMs", async () => {
        const rig = await duringSaves();
        const device = (rig.rt.diagnostics().devices as Record<string, Record<string, unknown>>)[A];
        expect(device?.messageAt).toBe(rig.arrivals[1]);
        expect(device?.values).toMatchObject({ sensor_source: "external" });
      });
    });

    describe("With a transport event arriving while no effects run", () => {
      it("it is applied at once", async () => {
        const rig = await boot({ seed: managedSeed([A]) });
        await rig.advance(5000);
        rig.say(A, "a-1");
        const device = (rig.rt.diagnostics().devices as Record<string, Record<string, unknown>>)[A];
        expect(device?.messageAt).toBe(T + 5000);
      });
    });
  });

  describe("failed sends", () => {
    const fresh = { at: expect.any(Number) as unknown, askedAt: undefined, writtenAt: undefined };

    describe("With the transport rejecting a publish", () => {
      it("the tick's memory is kept: the valve's token was taken", async () => {
        const rig = await boot({ seed: managedSeed([A]) });
        await hear(rig, [A]);
        const tokens = rig.memory(A)?.tokens as number;
        rig.z2m.failNext(1);
        await rig.advance(1000);
        expect(rig.z2m.attempts().at(-1)?.kind).toBe("publish");
        expect(rig.memory(A)?.tokens as number).toBeLessThan(tokens);
      });

      it("every group of that valve is marked, and none of its marks carries a writtenAt or an askedAt", async () => {
        const rig = await boot({ seed: managedSeed([A]) });
        await hear(rig, [A]);
        rig.z2m.failNext(1);
        await rig.advance(1000);
        expect(rig.marks(A)).toEqual({ schedule: fresh, sensor_source: fresh });
      });
    });

    describe("With the first of three valves' publishes rejected with mqtt_not_connected", () => {
      it("all three valves are marked in that way", async () => {
        const rig = await boot({
          devices: [trvzb(A), trvzb(B), trvzb(C)],
          seed: managedSeed([A, B, C]),
        });
        await hear(rig, [A, B, C]);
        rig.z2m.failNext(1, "mqtt_not_connected");
        await rig.advance(1000);
        expect(sends(rig).filter((s) => s.kind === "publish")).toEqual([]);
        for (const id of [A, B, C]) {
          expect(rig.marks(id)).toEqual({ schedule: fresh, sensor_source: fresh });
        }
      });
    });

    describe("With the first of three valves' publishes rejected with device_unknown", () => {
      async function failedA(): Promise<Rig> {
        const rig = await boot({
          devices: [trvzb(A), trvzb(B), trvzb(C)],
          seed: managedSeed([A, B, C]),
        });
        await hear(rig, [A, B, C]);
        rig.z2m.failNext(1, "device_unknown");
        await rig.advance(1000);
        return rig;
      }

      it("that valve is marked in that way", async () => {
        const rig = await failedA();
        expect(rig.marks(A)).toEqual({ schedule: fresh, sensor_source: fresh });
      });

      it("the other two publishes went out, and their valves are not marked again", async () => {
        const rig = await failedA();
        expect(
          sends(rig)
            .filter((s) => s.kind === "publish")
            .map((s) => s.deviceId),
        ).toEqual([B, C]);
        for (const id of [B, C]) {
          expect(rig.marks(id).sensor_source).toBeUndefined();
          expect(rig.marks(id).schedule?.writtenAt).toBeDefined();
        }
      });
    });

    describe("With a refresh rejected", () => {
      it("the valve's readable groups are marked and carry no askedAt", async () => {
        const rig = await boot({ seed: managedSeed([A]), start: false });
        rig.z2m.failNext(1);
        await rig.rt.start();
        await rig.rt.settled();
        expect(rig.z2m.attempts()[0]?.kind).toBe("read");
        expect(rig.marks(A).sensor_source).toEqual({
          at: T,
          askedAt: undefined,
          writtenAt: undefined,
        });
      });
    });

    describe("With a temperature push rejected and nothing after it", () => {
      async function failedPush(): Promise<Rig & { before: unknown }> {
        const ha = createStubHaLink();
        haSensor(ha, "sensor.living", 19.6, T);
        const rig = await boot({ ha, seed: managedSeed([A], [ROOM_SENSOR]) });
        rig.say(A, "a-1");
        const before = rig.marks(A);
        rig.z2m.failNext(1);
        await rig.advance(1000);
        expect(rig.z2m.attempts().at(-1)?.payload).toEqual(TRVZB_BINDING.encodeTemperature(19.6));
        return Object.assign(rig, { before });
      }

      it("nothing is marked", async () => {
        const rig = await failedPush();
        expect(rig.marks(A)).toEqual(rig.before);
      });

      it('the valve\'s feedValue and feedAt are forgotten (push_failed), so that push does not count towards "external"', async () => {
        const rig = await failedPush();
        expect(rig.memory(A)?.feedValue).toBeUndefined();
        expect(rig.memory(A)?.feedAt).toBeUndefined();
      });

      it("the next push goes out once the write interval has passed since the failed one", async () => {
        const rig = await failedPush();
        const pushes = (): number =>
          sends(rig, A).filter((s) =>
            JSON.stringify(s.payload).includes("external_temperature_input"),
          ).length;
        await rig.advance(5 * MINUTE - 1000);
        expect(pushes()).toBe(0);
        await rig.advance(TICK_INTERVAL_MS);
        expect(pushes()).toBe(1);
      });
    });

    describe("With a config store save that rejects inside a tick", () => {
      const D = "z2m:0xdd";
      const seed: Seed = {
        config: raw({ rooms: [{ valves: [A] }] }),
        releasing: { [D]: T - HOUR },
        ledger: [record(A)],
      };
      async function failing(): Promise<Rig> {
        const rig = await boot({ seed, start: false });
        rig.stores.fail.config = 2;
        await rig.rt.start();
        await rig.rt.settled();
        return rig;
      }

      it("the later effects of that tick are not executed", async () => {
        const rig = await failing();
        expect(rig.stores.calls).toEqual(["config.fail"]);
        expect(rig.z2m.attempts()).toEqual([]);
      });

      it("the next tick returns the save again", async () => {
        const rig = await failing();
        await rig.advance(TICK_INTERVAL_MS);
        expect(rig.stores.calls).toEqual(["config.fail", "config.fail"]);
      });

      it('snapshot\'s problems hold store_write_failed with data.store "config", and the listeners received it', async () => {
        const rig = await failing();
        const match = { kind: "store_write_failed", data: { store: "config" } };
        expect(rig.rt.snapshot().problems).toContainEqual(expect.objectContaining(match));
        expect(rig.snapshots.at(-1)?.problems).toContainEqual(expect.objectContaining(match));
      });

      describe("When that save succeeds at a later tick", () => {
        it("the store_write_failed problem is gone", async () => {
          const rig = await failing();
          await rig.advance(2 * TICK_INTERVAL_MS);
          expect(rig.stores.calls).toEqual(["config.fail", "config.fail", "config.save"]);
          expect(problemKinds(rig.rt.snapshot())).not.toContain("store_write_failed");
        });
      });
    });
  });

  describe("apply", () => {
    describe("With a valid first config naming one TRVZB that is in no room and has sent a message", () => {
      async function applied(): Promise<
        Rig & { plan: Awaited<ReturnType<HeatmasterRuntime["apply"]>> }
      > {
        const rig = await boot();
        rig.say(A, "a-1");
        const plan = await rig.rt.apply(raw(), APPLY);
        return Object.assign(rig, { plan });
      }

      it("the ledger file holds the valve's record before the config file is written", async () => {
        const rig = await applied();
        expect(rig.stores.calls).toEqual(["ledger.save", "copy.write", "config.save"]);
        const ledger = readJson(path.join(rig.dataDir, "ledger.json"));
        expect(Object.keys((ledger.data as { records: object }).records)).toEqual([A]);
      });

      it("the returned plan lists the valve as joining, with its captured originals and the planned writes", async () => {
        const rig = await applied();
        expect(rig.plan.joining).toEqual([
          { valveId: A, originals: { sensor_source: "internal" }, unreadable: [] },
        ]);
        expect(rig.plan.writes.map((w) => w.valveId)).toContain(A);
        expect(rig.plan.writes.length).toBeGreaterThan(0);
      });

      it("the transport received one read for the joining valve before the plan's effects ran (the direct ask)", async () => {
        const rig = await applied();
        const reads = rig.z2m.attempts().filter((s) => s.kind === "read" && s.deviceId === A);
        expect(reads.length).toBeGreaterThanOrEqual(1);
        expect(rig.z2m.attempts()[0]).toEqual({
          kind: "read",
          deviceId: A,
          payload: TRVZB_BINDING.encodeRefresh(),
        });
        expect(rig.stores.sendsAtCall[0]).toBe(1);
      });

      it("snapshot has revision 1, the room with a status and the valve as managed", async () => {
        const rig = await applied();
        const snapshot = rig.rt.snapshot();
        expect(snapshot.revision).toBe(1);
        expect(snapshot.rooms.map((r) => r.roomId)).toEqual(["living"]);
        expect(snapshot.rooms[0]?.status).toBeDefined();
        expect(snapshot.memberships[A]).toBe("managed");
      });

      it("the listeners received that snapshot", async () => {
        const rig = await applied();
        expect(rig.snapshots.at(-1)?.revision).toBe(1);
        expect(rig.snapshots.at(-1)?.memberships[A]).toBe("managed");
      });
    });

    describe("With hold on in the config", () => {
      it("the tick publishes nothing on the transport; it still asks the valve to report", async () => {
        const rig = await boot();
        rig.say(A, "a-1");
        await rig.rt.apply(raw({ hold: true }), APPLY);
        await rig.advance(1000);
        rig.say(A, "a-2");
        await rig.advance(5 * MINUTE);
        expect(sends(rig, A).filter((s) => s.kind === "publish")).toEqual([]);
        expect(sends(rig, A).filter((s) => s.kind === "read").length).toBeGreaterThanOrEqual(2);
      });
    });

    describe("With hold off in the config", () => {
      it("the transport receives what the tick decided", async () => {
        const rig = await boot();
        rig.say(A, "a-1");
        await rig.rt.apply(raw({ hold: false }), APPLY);
        await rig.advance(1000);
        rig.say(A, "a-2");
        await rig.advance(EVENT_DEBOUNCE_MS);
        const publish = sends(rig, A).find((s) => s.kind === "publish");
        expect(Object.keys(publish?.payload as object)).toContain("weekly_schedule_monday");
      });
    });

    describe("With an invalid document", () => {
      it("rejects with ConfigError, nothing is saved, and no sensor was looked up", async () => {
        const ha = createStubHaLink();
        const rig = await boot({ ha });
        rig.say(A, "a-1");
        const bad = { ...raw({ rooms: [{ valves: ["bad id"], sensors: [ROOM_SENSOR] }] }) };
        const error = await rejectionOf(rig.rt.apply(bad, APPLY));
        expect(error).toBeInstanceOf(ConfigError);
        expect(rig.stores.calls).toEqual([]);
        expect(ha.infoCalls()).toEqual([]);
      });
    });

    describe("With a new valve that has sent no message", () => {
      it("rejects with ChangeRefused valve_not_observed", async () => {
        const rig = await boot();
        const error = await rejectionOf(rig.rt.apply(raw(), APPLY));
        expect(error).toBeInstanceOf(ChangeRefused);
        expect(codeOf(error)).toBe("valve_not_observed");
      });

      it("the transport received one read for that valve, holding binding.encodeRefresh()", async () => {
        const rig = await boot();
        await rejectionOf(rig.rt.apply(raw(), APPLY));
        expect(rig.z2m.sent()).toEqual([
          { kind: "read", deviceId: A, payload: TRVZB_BINDING.encodeRefresh() },
        ]);
      });

      it("nothing was saved", async () => {
        const rig = await boot();
        await rejectionOf(rig.rt.apply(raw(), APPLY));
        expect(rig.stores.calls).toEqual([]);
      });
    });

    describe("With two new valves that have sent no message", () => {
      it("the transport received one read for each", async () => {
        const rig = await boot({ devices: [trvzb(A), trvzb(B)] });
        await rejectionOf(rig.rt.apply(raw({ rooms: [{ valves: [A, B] }] }), APPLY));
        expect(rig.z2m.sent().map((s) => [s.kind, s.deviceId])).toEqual([
          ["read", A],
          ["read", B],
        ]);
      });
    });

    const readsOf = (rig: Rig): number => sends(rig, A).filter((s) => s.kind === "read").length;

    describe("With the same call repeated 30 s later", () => {
      it("no second read is sent, and the caller still gets ChangeRefused valve_not_observed", async () => {
        const rig = await boot();
        await rejectionOf(rig.rt.apply(raw(), APPLY));
        await rig.advance(30 * 1000);
        const error = await rejectionOf(rig.rt.apply(raw(), APPLY));
        expect(codeOf(error)).toBe("valve_not_observed");
        expect(readsOf(rig)).toBe(1);
      });
    });

    describe("With the same call repeated 61 s after the first", () => {
      it("a second read is sent", async () => {
        const rig = await boot();
        await rejectionOf(rig.rt.apply(raw(), APPLY));
        await rig.advance(61 * 1000);
        await rejectionOf(rig.rt.apply(raw(), APPLY));
        expect(readsOf(rig)).toBe(2);
      });
    });

    describe("With the same call repeated every 61 s", () => {
      it("the seventh call within the hour sends no read", async () => {
        const rig = await boot();
        for (let i = 0; i < 7; i += 1) {
          if (i > 0) await rig.advance(61 * 1000);
          await rejectionOf(rig.rt.apply(raw(), APPLY));
        }
        expect(readsOf(rig)).toBe(6);
      });

      it("a call made 61 min after the first sends one again", async () => {
        const rig = await boot();
        for (let i = 0; i < 7; i += 1) {
          if (i > 0) await rig.advance(61 * 1000);
          await rejectionOf(rig.rt.apply(raw(), APPLY));
        }
        await rig.advance(61 * MINUTE - 6 * 61 * 1000);
        await rejectionOf(rig.rt.apply(raw(), APPLY));
        expect(readsOf(rig)).toBe(7);
      });
    });

    describe("With a change that adds no valve, or only a rejoining one", () => {
      it("no direct ask is sent", async () => {
        const rig = await boot({
          devices: [trvzb(A), trvzb(B)],
          seed: { config: raw({ rooms: [{ valves: [A] }] }), ledger: [record(A), record(B)] },
        });
        rig.say(A, "a-1");
        rig.say(B, "b-1");
        const before = rig.z2m.attempts().length;
        await rig.rt.apply(raw({ rooms: [{ valves: [A] }], temperature: 21 }), APPLY);
        expect(rig.stores.sendsAtCall.at(-1)).toBe(before);
        const plan = await rig.rt.apply(raw({ rooms: [{ valves: [A, B] }] }), APPLY);
        expect(plan.rejoining).toEqual([B]);
        expect(rig.stores.sendsAtCall.at(-1)).toBe(rig.stores.sendsAtCall.at(-2));
      });
    });

    describe("With the valve having answered and the call repeated", () => {
      it("returns a plan", async () => {
        const rig = await boot();
        await rejectionOf(rig.rt.apply(raw(), APPLY));
        rig.say(A, "a-1");
        const plan = await rig.rt.apply(raw(), APPLY);
        expect(plan.joining.map((c) => c.valveId)).toEqual([A]);
      });
    });

    describe("With a transport read that rejects during that ask", () => {
      it("the caller still gets ChangeRefused valve_not_observed", async () => {
        const rig = await boot();
        rig.z2m.failNext(1);
        const error = await rejectionOf(rig.rt.apply(raw(), APPLY));
        expect(codeOf(error)).toBe("valve_not_observed");
        expect(rig.z2m.attempts()).toHaveLength(1);
      });
    });

    const withSensor = raw({ rooms: [{ valves: [A], sensors: [ROOM_SENSOR] }] });

    describe("With an ha: sensor and no Home Assistant link configured", () => {
      it("rejects with ChangeRefused ha_link_missing", async () => {
        const rig = await boot({ ha: null });
        rig.say(A, "a-1");
        expect(codeOf(await rejectionOf(rig.rt.apply(withSensor, APPLY)))).toBe("ha_link_missing");
      });
    });

    describe("With an ha: sensor and a Home Assistant link that is not ready", () => {
      it("rejects with ChangeRefused ha_link_missing", async () => {
        const ha = createStubHaLink();
        ha.setState("connecting");
        const rig = await boot({ ha });
        rig.say(A, "a-1");
        expect(codeOf(await rejectionOf(rig.rt.apply(withSensor, APPLY)))).toBe("ha_link_missing");
      });
    });

    describe("With a stored config that has an ha: sensor, the Home Assistant link down, and only a schedule edit", () => {
      it("returns a plan", async () => {
        const ha = createStubHaLink();
        ha.setState("down");
        ha.setReady(false);
        const rig = await boot({ ha, seed: managedSeed([A], [ROOM_SENSOR]) });
        const plan = await rig.rt.apply(
          raw({ rooms: [{ valves: [A], sensors: [ROOM_SENSOR] }], temperature: 22 }),
          APPLY,
        );
        expect(plan.stored.revision).toBe(2);
      });
    });

    describe("With an ha: sensor the link reports as a humidity sensor", () => {
      it("rejects with ChangeRefused sensor_not_temperature", async () => {
        const ha = createStubHaLink();
        ha.setSensorInfo("sensor.living", { exists: true, isTemperature: false, onValve: false });
        const rig = await boot({ ha });
        rig.say(A, "a-1");
        expect(codeOf(await rejectionOf(rig.rt.apply(withSensor, APPLY)))).toBe(
          "sensor_not_temperature",
        );
      });
    });

    describe("With an ha: sensor Home Assistant does not know", () => {
      it("rejects with ChangeRefused sensor_unknown", async () => {
        const rig = await boot();
        rig.say(A, "a-1");
        expect(codeOf(await rejectionOf(rig.rt.apply(withSensor, APPLY)))).toBe("sensor_unknown");
      });
    });

    describe("With an ha: sensor on a device that is a valve of the transport", () => {
      it("rejects with ChangeRefused sensor_on_valve", async () => {
        const ha = createStubHaLink();
        ha.setSensorInfo("sensor.living", { exists: true, isTemperature: true, onValve: true });
        const rig = await boot({ ha, devices: [trvzb(A), sensorDevice(S)] });
        rig.say(A, "a-1");
        expect(codeOf(await rejectionOf(rig.rt.apply(withSensor, APPLY)))).toBe("sensor_on_valve");
        expect(ha.infoAddresses().at(-1)).toEqual(new Set(["0xa1"]));
      });
    });

    describe("With a document that has a z2m: sensor", () => {
      it("rejects with ConfigError sensor_ref_invalid", async () => {
        const rig = await boot();
        rig.say(A, "a-1");
        const error = await rejectionOf(
          rig.rt.apply(raw({ rooms: [{ valves: [A], sensors: ["z2m:0x5e"] }] }), APPLY),
        );
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).issues.map((i) => i.code)).toContain("sensor_ref_invalid");
      });
    });

    describe("With overwriteUnreadable over an unreadable config", () => {
      it("the old file is set aside and the new config is saved", async () => {
        const rig = await boot({ seed: { config: "unreadable", ledger: [] } });
        rig.say(A, "a-1");
        await rig.rt.apply(raw({ rooms: [] }), { ...APPLY, overwriteUnreadable: true });
        const { readdirSync } = await import("node:fs");
        expect(readdirSync(rig.dataDir).some((name) => name.startsWith("config.unreadable."))).toBe(
          true,
        );
        expect(rig.stores.overwrite).toEqual([true]);
        expect(rig.rt.snapshot().configState).toBe("ok");
      });
    });

    describe("With an out-of-date expectedRevision", () => {
      it("rejects with ChangeRefused revision_conflict and nothing is saved", async () => {
        const rig = await boot({ seed: { ...managedSeed([A]), revision: 3 } });
        const error = await rejectionOf(rig.rt.apply(raw(), { ...APPLY, expectedRevision: 2 }));
        expect(codeOf(error)).toBe("revision_conflict");
        expect(rig.stores.calls).toEqual([]);
      });
    });

    describe("With a store save that rejects", () => {
      it("the rejection reaches the caller", async () => {
        const rig = await boot();
        rig.say(A, "a-1");
        rig.stores.fail.ledger = 1;
        expect(codeOf(await rejectionOf(rig.rt.apply(raw(), APPLY)))).toBe("io_failed");
      });

      it("one tick still ran before it did, and the listeners received its snapshot", async () => {
        const rig = await boot();
        rig.say(A, "a-1");
        await rig.advance(5000);
        rig.stores.fail.ledger = 1;
        const before = rig.snapshots.length;
        let ticksAtRejection = -1;
        await rig.rt.apply(raw(), APPLY).catch(() => {
          ticksAtRejection = rig.snapshots.length - before;
        });
        expect(ticksAtRejection).toBe(1);
        expect(rig.snapshots.at(-1)?.tickedAt).toBe(T + 5000);
        expect(rig.snapshots.at(-1)?.problems.map((p) => p.kind)).toContain("store_write_failed");
      });
    });

    describe("With a config that has no timezone, and no Home Assistant link configured", () => {
      it("rejects with ChangeRefused timezone_missing and nothing is saved", async () => {
        const rig = await boot({ ha: null });
        rig.say(A, "a-1");
        const error = await rejectionOf(rig.rt.apply(raw({ timezone: null }), APPLY));
        expect(codeOf(error)).toBe("timezone_missing");
        expect(rig.stores.calls).toEqual([]);
      });
    });
  });

  describe("preview", () => {
    describe("With a valid first config", () => {
      it("returns the plan apply would return", async () => {
        const rig = await boot();
        rig.say(A, "a-1");
        const previewed = await rig.rt.preview(raw(), APPLY);
        const applied = await rig.rt.apply(raw(), APPLY);
        expect({ ...previewed, effects: [] }).toEqual({ ...applied, effects: [] });
        expect(applied.effects.length).toBeGreaterThan(0);
      });

      it("no file is written, snapshot is unchanged and no listener is called", async () => {
        const rig = await boot();
        rig.say(A, "a-1");
        const before = rig.rt.snapshot();
        const heard = rig.snapshots.length;
        await rig.rt.preview(raw(), APPLY);
        expect(rig.stores.calls).toEqual([]);
        const { readdirSync } = await import("node:fs");
        expect(readdirSync(rig.dataDir)).toEqual([]);
        expect(rig.rt.snapshot()).toEqual(before);
        expect(rig.snapshots.length).toBe(heard);
      });

      it("the transport received one read for the joining valve", async () => {
        const rig = await boot();
        rig.say(A, "a-1");
        await rig.rt.preview(raw(), APPLY);
        expect(rig.z2m.sent()).toEqual([
          { kind: "read", deviceId: A, payload: TRVZB_BINDING.encodeRefresh() },
        ]);
      });
    });

    describe("With apply called 30 s after that preview", () => {
      it("the apply sends no second direct ask", async () => {
        const rig = await boot();
        rig.say(A, "a-1");
        await rig.rt.preview(raw(), APPLY);
        await rig.advance(30 * 1000);
        await rig.rt.apply(raw(), APPLY);
        expect(rig.stores.sendsAtCall[0]).toBe(1);
      });
    });

    describe("With a new valve that has sent no message", () => {
      it("rejects with ChangeRefused valve_not_observed and one read is sent", async () => {
        const rig = await boot();
        expect(codeOf(await rejectionOf(rig.rt.preview(raw(), APPLY)))).toBe("valve_not_observed");
        expect(rig.z2m.sent().map((s) => [s.kind, s.deviceId])).toEqual([["read", A]]);
      });
    });
  });

  describe("exportConfig", () => {
    describe("With a stored config at revision 3 and one valve releasing", () => {
      const seed: Seed = {
        config: raw(),
        revision: 3,
        releasing: { [B]: T - HOUR },
        ledger: [record(A), record(B)],
      };

      it("returns revision 3 and configToRaw of the config", async () => {
        const rig = await boot({ seed });
        expect(rig.rt.exportConfig()).toEqual({
          revision: 3,
          config: configToRaw(validateConfig(raw())),
        });
      });

      it("the result holds no releasing key", async () => {
        const rig = await boot({ seed });
        expect(JSON.stringify(rig.rt.exportConfig())).not.toContain("releasing");
      });
    });

    describe("With no config", () => {
      it("returns revision 0 and the raw form of EMPTY_CONFIG", async () => {
        const rig = await boot();
        expect(rig.rt.exportConfig()).toEqual({ revision: 0, config: configToRaw(EMPTY_CONFIG) });
      });
    });

    describe("With an unreadable config", () => {
      it("throws HeatmasterError config_unreadable", async () => {
        const rig = await boot({ seed: { config: "unreadable" } });
        let thrown: unknown;
        try {
          rig.rt.exportConfig();
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(HeatmasterError);
        expect(codeOf(thrown)).toBe("config_unreadable");
      });
    });
  });

  describe("resync", () => {
    const seed: Seed = {
      config: raw({ rooms: [{ valves: [A] }, { id: "kitchen", valves: [B] }] }),
      ledger: [record(A), record(B)],
    };

    describe("With a room id", () => {
      it("every group of that room's valves is marked and other rooms' valves are untouched", async () => {
        const rig = await boot({ devices: [trvzb(A), trvzb(B)], seed });
        await inSync(rig, [A, B]);
        await rig.rt.resync("living");
        expect(Object.keys(rig.marks(A)).sort()).toEqual(["schedule", "sensor_source"]);
        expect(rig.marks(B)).toEqual({});
      });

      it("a tick is requested", async () => {
        const rig = await boot({ devices: [trvzb(A), trvzb(B)], seed });
        await rig.advance(5000);
        await rig.rt.resync("living");
        await rig.advance(EVENT_DEBOUNCE_MS);
        expect(rig.rt.snapshot().tickedAt).toBe(T + 5000 + EVENT_DEBOUNCE_MS);
      });
    });

    describe("With no room id", () => {
      it("every group of every valve in memberships is marked", async () => {
        const rig = await boot({ devices: [trvzb(A), trvzb(B)], seed });
        await inSync(rig, [A, B]);
        await rig.rt.resync(undefined);
        for (const id of [A, B]) {
          expect(Object.keys(rig.marks(id)).sort()).toEqual(["schedule", "sensor_source"]);
        }
      });
    });

    describe("With an unknown room id", () => {
      it("rejects with HeatmasterError room_unknown", async () => {
        const rig = await boot({ devices: [trvzb(A), trvzb(B)], seed });
        const error = await rejectionOf(rig.rt.resync("attic"));
        expect(error).toBeInstanceOf(HeatmasterError);
        expect(codeOf(error)).toBe("room_unknown");
        expect((error as HeatmasterError).data).toEqual({ roomId: "attic" });
      });
    });
  });

  describe("refreshValve", () => {
    const held: Seed = { config: raw({ rooms: [], hold: true }) };

    describe("With a followed TRVZB that is in no room, while hold is on", () => {
      it("the transport receives one read holding binding.encodeRefresh()", async () => {
        const rig = await boot({ seed: held });
        await rig.rt.refreshValve(A);
        expect(rig.z2m.sent()).toEqual([
          { kind: "read", deviceId: A, payload: TRVZB_BINDING.encodeRefresh() },
        ]);
      });
    });

    describe("Called twice within 60 s", () => {
      it("one read is sent", async () => {
        const rig = await boot({ seed: held });
        await rig.rt.refreshValve(A);
        await rig.advance(59 * 1000);
        await rejectionOf(rig.rt.refreshValve(A));
        expect(rig.z2m.sent()).toHaveLength(1);
      });

      it("the second call rejects with HeatmasterError ask_limited naming the valve", async () => {
        const rig = await boot({ seed: held });
        await rig.rt.refreshValve(A);
        await rig.advance(59 * 1000);
        const error = await rejectionOf(rig.rt.refreshValve(A));
        expect(error).toBeInstanceOf(HeatmasterError);
        expect(codeOf(error)).toBe("ask_limited");
        expect((error as HeatmasterError).data).toEqual({ valveId: A });
      });
    });

    describe("Called again 61 s after the first", () => {
      it("a second read is sent", async () => {
        const rig = await boot({ seed: held });
        await rig.rt.refreshValve(A);
        await rig.advance(DIRECT_ASK_SPACING_MS + 1000);
        await rig.rt.refreshValve(A);
        expect(rig.z2m.sent()).toHaveLength(2);
      });
    });

    describe("Called every 61 s", () => {
      it("the seventh call within the hour rejects with HeatmasterError ask_limited and sends nothing", async () => {
        const rig = await boot({ seed: held });
        for (let i = 0; i < 6; i += 1) {
          if (i > 0) await rig.advance(61 * 1000);
          await rig.rt.refreshValve(A);
        }
        await rig.advance(61 * 1000);
        expect(codeOf(await rejectionOf(rig.rt.refreshValve(A)))).toBe("ask_limited");
        expect(rig.z2m.sent()).toHaveLength(6);
      });
    });

    describe("With an id no transport lists", () => {
      it("rejects with HeatmasterError valve_unknown", async () => {
        const rig = await boot();
        expect(codeOf(await rejectionOf(rig.rt.refreshValve("z2m:0xffff")))).toBe("valve_unknown");
      });
    });

    describe("With a device that has no profile", () => {
      it("rejects with HeatmasterError valve_unsupported", async () => {
        const rig = await boot({ devices: [trvzb(A), sensorDevice(S)] });
        expect(codeOf(await rejectionOf(rig.rt.refreshValve(S)))).toBe("valve_unsupported");
      });
    });

    describe("With a valve whose friendly name holds + or #", () => {
      it("rejects with HeatmasterError valve_unsupported and nothing is sent", async () => {
        const rig = await boot({ devices: [{ ...trvzb(A), name: "hall/valve+1" }] });
        expect(codeOf(await rejectionOf(rig.rt.refreshValve(A)))).toBe("valve_unsupported");
        expect(rig.z2m.attempts()).toEqual([]);
      });
    });

    describe("With the transport's link down, or the transport faulty", () => {
      it("rejects with HeatmasterError transport_unusable and nothing is sent", async () => {
        const rig = await boot();
        rig.z2m.setLink(false);
        const down = await rejectionOf(rig.rt.refreshValve(A));
        rig.z2m.setLink(true);
        rig.z2m.setFault("last_seen_disabled");
        const faulty = await rejectionOf(rig.rt.refreshValve(A));
        expect(codeOf(down)).toBe("transport_unusable");
        expect(codeOf(faulty)).toBe("transport_unusable");
        expect((faulty as HeatmasterError).data).toEqual({ valveId: A });
        expect(rig.z2m.sent()).toEqual([]);
      });
    });

    describe("With a binding that returns nothing to read", () => {
      it("resolves and nothing is sent", async () => {
        bindingOverrides.set("TRVZB-NOREAD", NO_READ);
        const rig = await boot({ devices: [trvzb(A, "TRVZB-NOREAD")] });
        await expect(rig.rt.refreshValve(A)).resolves.toBeUndefined();
        expect(rig.z2m.attempts()).toEqual([]);
      });
    });

    describe("With a transport read that rejects", () => {
      it("the rejection reaches the caller", async () => {
        const rig = await boot();
        rig.z2m.failNext(1, "mqtt_timeout");
        expect(codeOf(await rejectionOf(rig.rt.refreshValve(A)))).toBe("mqtt_timeout");
      });
    });
  });

  describe("restoreValve / forgetValve", () => {
    const orphan: Seed = { config: raw({ rooms: [] }), ledger: [record(A)] };

    describe("For an orphan", () => {
      it("the core function's effects are executed and one tick runs", async () => {
        const rig = await boot({ seed: orphan });
        await rig.advance(5000);
        await rig.rt.restoreValve(A);
        expect(rig.stores.calls).toEqual(["config.save"]);
        expect(rig.rt.snapshot().tickedAt).toBe(T + 5000);
        await rig.rt.forgetValve(A);
        expect(rig.stores.calls).toEqual([
          "config.save",
          "ledger.save",
          "copy.write",
          "config.save",
        ]);
      });

      it("the listeners receive a snapshot with the valve's new membership", async () => {
        const rig = await boot({ seed: orphan });
        expect(rig.snapshots.at(-1)?.memberships[A]).toBe("orphan");
        await rig.rt.restoreValve(A);
        expect(rig.snapshots.at(-1)?.memberships[A]).toBe("releasing");
        await rig.rt.forgetValve(A);
        expect(rig.snapshots.at(-1)?.memberships[A]).toBeUndefined();
      });
    });

    describe("When the core refuses", () => {
      it("the ChangeRefused reaches the caller and nothing is saved", async () => {
        const rig = await boot({ seed: managedSeed([A]) });
        const error = await rejectionOf(rig.rt.restoreValve(A));
        expect(error).toBeInstanceOf(ChangeRefused);
        expect(codeOf(error)).toBe("valve_not_orphan");
        expect(codeOf(await rejectionOf(rig.rt.forgetValve(A)))).toBe("valve_managed");
        expect(rig.stores.calls).toEqual([]);
      });
    });

    describe("Called while a tick is executing effects", () => {
      it("it starts after the tick has finished", async () => {
        const rig = await boot({
          devices: [trvzb(A), trvzb(B)],
          seed: { config: raw({ rooms: [{ valves: [B] }] }), ledger: [record(A), record(B)] },
        });
        rig.say(B, "b-1");
        await rig.advance(90 * 1000);
        const release = rig.z2m.holdSends(B);
        await stepUntilAttempt(rig, TICK_INTERVAL_MS, (s) => s.deviceId === B);
        const restored = rig.rt.restoreValve(A);
        await new Promise((resolve) => setImmediate(resolve));
        expect(rig.stores.calls).toEqual([]);
        release();
        await restored;
        expect(rig.stores.calls).toEqual(["config.save"]);
      });
    });
  });

  describe("importOriginals", () => {
    describe("With an unreadable ledger and a good copy", () => {
      it("snapshot has ledgerReadable true and one tick has run", async () => {
        const rig = await boot({ seed: { ledger: "unreadable", copy: [record(A)] } });
        expect(rig.rt.snapshot().ledgerReadable).toBe(false);
        await rig.advance(5000);
        const before = rig.snapshots.length;
        await rig.rt.importOriginals(false);
        expect(rig.rt.snapshot().ledgerReadable).toBe(true);
        expect(rig.snapshots.length - before).toBe(1);
        expect(rig.rt.snapshot().tickedAt).toBe(T + 5000);
      });
    });

    describe("With no readable copy", () => {
      it("rejects with HeatmasterError no_originals_copy and snapshot still has ledgerReadable false", async () => {
        const rig = await boot({ seed: { ledger: "unreadable" } });
        const error = await rejectionOf(rig.rt.importOriginals(false));
        expect(error).toBeInstanceOf(HeatmasterError);
        expect(codeOf(error)).toBe("no_originals_copy");
        expect(rig.rt.snapshot().ledgerReadable).toBe(false);
      });
    });

    describe("After an import", () => {
      it("snapshot's originalsCopyRecords is the number the store reports", async () => {
        const rig = await boot({ seed: { ledger: "unreadable", copy: [record(A), record(B)] } });
        await rig.rt.importOriginals(false);
        expect(rig.rt.snapshot().originalsCopyRecords).toBe(2);
      });
    });
  });

  describe("setHold", () => {
    describe("With hold off and on true", () => {
      it("the stored config has hold on, the revision is one higher and nothing else in the config changed", async () => {
        const rig = await boot({ seed: managedSeed([A]) });
        const before = rig.rt.exportConfig();
        await rig.rt.setHold(true);
        const after = rig.rt.exportConfig();
        expect(after.revision).toBe(before.revision + 1);
        expect(after.config).toEqual({
          ...before.config,
          settings: { ...(before.config.settings as object), hold_writes: true },
        });
        const file = readJson(path.join(rig.dataDir, "config.json"));
        expect(file).toMatchObject({
          data: { revision: 2, config: { settings: { hold_writes: true } } },
        });
      });

      it("the next tick publishes nothing", async () => {
        const rig = await boot({ seed: managedSeed([A]) });
        await hear(rig, [A]);
        await rig.rt.setHold(true);
        await rig.advance(5 * MINUTE);
        expect(sends(rig, A).filter((s) => s.kind === "publish")).toEqual([]);
      });
    });

    describe("With the value hold already has", () => {
      it("nothing is saved and the revision is unchanged", async () => {
        const rig = await boot({ seed: managedSeed([A]) });
        await rig.rt.setHold(false);
        expect(rig.stores.calls).toEqual([]);
        expect(rig.rt.snapshot().revision).toBe(1);
      });
    });

    describe("With a config whose room sensor no longer exists in Home Assistant, and on true", () => {
      it("hold is saved", async () => {
        const rig = await boot({ seed: managedSeed([A], ["ha:sensor.gone"]) });
        await rig.rt.setHold(true);
        expect(rig.stores.calls).toEqual(["config.save"]);
        expect(rig.rt.snapshot().held).toBe(true);
      });
    });

    describe("With a config store save that rejects, and on true", () => {
      async function failedHold(): Promise<Rig & { error: unknown }> {
        const rig = await boot({ seed: managedSeed([A]) });
        await hear(rig, [A]);
        rig.stores.fail.config = 1;
        const error = await rejectionOf(rig.rt.setHold(true));
        return Object.assign(rig, { error });
      }

      it("the rejection reaches the caller", async () => {
        const rig = await failedHold();
        expect(codeOf(rig.error)).toBe("io_failed");
      });

      it("the next ticks publish nothing: writes count as held although the file says otherwise", async () => {
        const rig = await failedHold();
        await rig.advance(5 * MINUTE);
        expect(sends(rig, A).filter((s) => s.kind === "publish")).toEqual([]);
        const file = readJson(path.join(rig.dataDir, "config.json"));
        expect(file).toMatchObject({ data: { config: { settings: { hold_writes: false } } } });
      });

      it("snapshot's held is true", async () => {
        const rig = await failedHold();
        expect(rig.rt.snapshot().held).toBe(true);
      });

      it('snapshot\'s problems hold store_write_failed with data.store "config"', async () => {
        const rig = await failedHold();
        expect(rig.rt.snapshot().problems).toContainEqual(
          expect.objectContaining({ kind: "store_write_failed", data: { store: "config" } }),
        );
      });
    });

    describe("With no config and on true", () => {
      it("resolves and nothing is saved", async () => {
        const rig = await boot();
        await expect(rig.rt.setHold(true)).resolves.toBeUndefined();
        expect(rig.stores.calls).toEqual([]);
      });
    });

    describe("With no config and on false", () => {
      it("rejects with HeatmasterError config_missing", async () => {
        const rig = await boot();
        expect(codeOf(await rejectionOf(rig.rt.setHold(false)))).toBe("config_missing");
      });
    });

    describe("With an unreadable config", () => {
      it("rejects with HeatmasterError config_unreadable", async () => {
        const rig = await boot({ seed: { config: "unreadable" } });
        expect(codeOf(await rejectionOf(rig.rt.setHold(true)))).toBe("config_unreadable");
      });
    });
  });

  describe("snapshot", () => {
    describe("Before the first tick", () => {
      it("rooms come from the stored config with status undefined; problems is empty; tickedAt is undefined", async () => {
        let open: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
          open = resolve;
        });
        const rig = await boot({ seed: managedSeed([A]), start: false, gate });
        const started = rig.rt.start();
        await vi.waitFor(() => {
          expect(rig.rt.snapshot().rooms).toHaveLength(1);
        });
        const snapshot = rig.rt.snapshot();
        expect(snapshot.rooms[0]).toMatchObject({
          roomId: "living",
          valveIds: [A],
          status: undefined,
        });
        expect(snapshot.problems).toEqual([]);
        expect(snapshot.tickedAt).toBeUndefined();
        open();
        await started;
      });
    });

    describe("With a room that has an area id the Home Assistant link knows", () => {
      it("the room's areaName is the area's name", async () => {
        const ha = createStubHaLink();
        ha.setAreaName("area_living", "Living room");
        const rig = await boot({
          ha,
          seed: {
            config: raw({ rooms: [{ valves: [A], areaId: "area_living" }] }),
            ledger: [record(A)],
          },
        });
        expect(rig.rt.snapshot().rooms[0]).toMatchObject({
          areaId: "area_living",
          areaName: "Living room",
        });
      });
    });

    describe("With a listed TRVZB in no room and a listed sensor", () => {
      it("devices holds both; the TRVZB has supported true and no membership; the sensor has supported false", async () => {
        const rig = await boot({ devices: [trvzb(A), sensorDevice(S)] });
        const devices = rig.rt.snapshot().devices;
        expect(devices.map((d) => d.deviceId).sort()).toEqual([A, S].sort());
        expect(devices.find((d) => d.deviceId === A)).toMatchObject({
          supported: true,
          membership: undefined,
        });
        expect(devices.find((d) => d.deviceId === S)?.supported).toBe(false);
      });
    });

    describe("With a followed TRVZB in no room that has sent no message", () => {
      it('unassigned lists it with observed false, liveness "unknown" and no values', async () => {
        const rig = await boot();
        expect(rig.rt.snapshot().unassigned).toEqual([
          {
            valveId: A,
            name: "valve 0xa1",
            observed: false,
            liveness: "unknown",
            heardAt: undefined,
            values: {},
          },
        ]);
      });
    });

    describe("With that valve having sent a message", () => {
      it("unassigned lists it with observed true and its values in the describeValue form", async () => {
        const rig = await boot();
        rig.say(
          A,
          "a-1",
          trvzbMessage("a-1", "remote_temperature", {
            weekly_schedule_monday: "00:00/16 07:00/20 07:00/20 07:00/20 07:00/20 07:00/20",
          }),
        );
        const entry = rig.rt.snapshot().unassigned[0];
        expect(entry?.observed).toBe(true);
        expect(entry?.values).toEqual({
          sensor_source: "external",
          day_mon: ["00:00/16", "07:00/20", "07:00/20", "07:00/20", "07:00/20", "07:00/20"],
        });
      });
    });

    describe("With an orphan valve, a managed valve and a releasing valve", () => {
      it("unassigned lists the orphan and neither of the other two", async () => {
        const rig = await boot({
          devices: [trvzb(A), trvzb(B), trvzb(C)],
          seed: {
            config: raw({ rooms: [{ valves: [A] }] }),
            releasing: { [C]: T - MINUTE },
            ledger: [record(A), record(B), record(C)],
          },
        });
        expect(rig.rt.snapshot().unassigned.map((u) => u.valveId)).toEqual([B]);
      });
    });

    describe("With a readable copy of the originals that holds two records", () => {
      it("originalsCopyRecords is 2", async () => {
        const rig = await boot({ seed: { copy: [record(A), record(B)] } });
        expect(rig.rt.snapshot().originalsCopyRecords).toBe(2);
      });
    });

    describe("Always", () => {
      it("the snapshot survives JSON.stringify and JSON.parse unchanged", async () => {
        const ha = createStubHaLink();
        haSensor(ha, "sensor.living", 19.6, T);
        const rig = await boot({
          ha,
          devices: [trvzb(A), trvzb(B), sensorDevice(S)],
          seed: managedSeed([A], [ROOM_SENSOR]),
        });
        await hear(rig, [A]);
        await rig.advance(1000);
        const snapshot = rig.rt.snapshot();
        expect(snapshot.rooms[0]?.status).toBeDefined();
        expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
      });
    });
  });

  describe("diagnostics", () => {
    describe("With one room configured", () => {
      const KEYS = [
        "revision",
        "configState",
        "config",
        "ledger",
        "memberships",
        "devices",
        "sensors",
        "memory",
        "rooms",
        "problems",
        "preview",
        "links",
        "transports",
        "ha",
        "timeZone",
      ];

      async function diagnosed(): Promise<Readonly<Record<string, unknown>>> {
        const ha = createStubHaLink();
        haSensor(ha, "sensor.living", 19.6, T);
        const rig = await boot({ ha, seed: managedSeed([A], [ROOM_SENSOR]) });
        await hear(rig, [A]);
        return rig.rt.diagnostics();
      }

      it("returns every listed key", async () => {
        expect(Object.keys(await diagnosed()).sort()).toEqual([...KEYS].sort());
      });

      it("the result can be serialised to JSON", async () => {
        const result = await diagnosed();
        expect(JSON.parse(JSON.stringify(result))).toEqual(result);
      });

      it("the result holds neither the MQTT password nor the Home Assistant token", async () => {
        // The runtime is never given either; the check guards against a later change.
        const text = JSON.stringify(await diagnosed());
        expect(text).not.toMatch(/"(password|token|access_token)"/i);
      });
    });
  });

  describe("stop", () => {
    describe("Always", () => {
      it("no timer remains and nothing is sent afterwards", async () => {
        const rig = await boot({ seed: managedSeed([A]) });
        rig.say(A, "a-1");
        await rig.rt.stop();
        expect(rig.clock.pending()).toBe(0);
        const sent = rig.z2m.attempts().length;
        rig.clock.advance(HOUR);
        await new Promise((resolve) => setImmediate(resolve));
        expect(rig.z2m.attempts().length).toBe(sent);
      });

      it("the transports and the Home Assistant link were stopped", async () => {
        const ha = createStubHaLink();
        const rig = await boot({ ha });
        await rig.rt.stop();
        expect(rig.z2m.stopped()).toBe(true);
        expect(ha.stopped()).toBe(true);
      });
    });

    describe("With a tick executing effects", () => {
      it("stop resolves after the tick has finished", async () => {
        const rig = await boot({ seed: managedSeed([A]) });
        rig.say(A, "a-1");
        await rig.advance(90 * 1000);
        const release = rig.z2m.holdSends();
        await stepUntilAttempt(rig, TICK_INTERVAL_MS, (s) => s.kind === "read");
        let stopped = false;
        const stopping = rig.rt.stop().then(() => {
          stopped = true;
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(stopped).toBe(false);
        release();
        await stopping;
        expect(rig.z2m.sent().at(-1)?.kind).toBe("read");
      });
    });

    describe("With a transport event queued behind that tick's effects", () => {
      it("no tick runs and no timer remains after stop has resolved", async () => {
        const rig = await boot({ seed: managedSeed([A]) });
        rig.say(A, "a-1");
        await rig.advance(90 * 1000);
        const release = rig.z2m.holdSends();
        await stepUntilAttempt(rig, TICK_INTERVAL_MS, (s) => s.kind === "read");
        rig.say(A, "a-2");
        const stopping = rig.rt.stop();
        release();
        await stopping;
        const tickedAt = rig.rt.snapshot().tickedAt;
        expect(rig.clock.pending()).toBe(0);
        rig.clock.advance(HOUR);
        await new Promise((resolve) => setImmediate(resolve));
        expect(rig.rt.snapshot().tickedAt).toBe(tickedAt);
      });
    });

    describe("After stop, or before start", () => {
      it("apply rejects with HeatmasterError not_started", async () => {
        const before = await boot({ start: false });
        expect(codeOf(await rejectionOf(before.rt.apply(raw(), APPLY)))).toBe("not_started");
        const after = await boot();
        await after.rt.stop();
        const error = await rejectionOf(after.rt.apply(raw(), APPLY));
        expect(error).toBeInstanceOf(HeatmasterError);
        expect(codeOf(error)).toBe("not_started");
        expect(() => after.rt.exportConfig()).toThrow(HeatmasterError);
      });
    });
  });
});
