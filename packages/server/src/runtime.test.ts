import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BUCKET,
  ChangeRefused,
  ConfigError,
  EMPTY_CONFIG,
  EMPTY_LEDGER,
  EMPTY_THERMOSTAT_STATE,
  FRESH_STORED,
  REFILL_MS,
  configToRaw,
  findProfile,
  ledgerToRaw,
  storedFromRaw,
  storedToRaw,
  THERMOSTAT_SETTLE_MS,
  thermostatStateToRaw,
  validateConfig,
} from "@heatmaster/core";
import type {
  AreaMembership,
  AreaRoom,
  Binding,
  Effect,
  HaArea,
  HaSnapshot,
  Ledger,
  Origin,
  RawConfig,
  RoomStatus,
  StoredConfig,
  ThermostatCommand,
  ThermostatState,
  ValveRecord,
  World,
} from "@heatmaster/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createManualClock, type ManualClock } from "../test/manual-clock.ts";
import { rejectionOf } from "../test/rejection.ts";
import { createStubHaLink, type StubHaLink } from "../test/stub-ha-link.ts";
import { createStubTransport, type StubTransport } from "../test/stub-transport.ts";
import { HeatmasterError } from "./errors.ts";
import { HA_LABEL_TIMEOUT_MS } from "./ha-link.ts";
import {
  CLOCK_JUMP_MS,
  DIRECT_ASK_SPACING_MS,
  EVENT_DEBOUNCE_MS,
  HA_SETTLE_MS,
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
  createPacingStore,
  createThermostatStore,
  type ConfigStore,
  type LedgerStore,
  type PacingStore,
  type ThermostatStore,
} from "./stores.ts";
import type { DeviceInfo } from "./transport.ts";

// ---- profile override ----------------------------------------------------------------------------

/** A binding the runtime gets instead of the real one, for the model ids named here. */
const bindingOverrides = new Map<string, Binding>();
/** While set, core's `tick` throws an Error with this message. */
const tickFault: { message: string | undefined } = { message: undefined };
/** Every world core's `tick` was given, oldest first. */
const tickWorlds: World[] = [];

vi.mock("@heatmaster/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@heatmaster/core")>();
  return {
    ...core,
    findProfile: (modelId: string, transport: string) => {
      const found = core.findProfile(modelId === "TRVZB-NOREAD" ? "TRVZB" : modelId, transport);
      const binding = bindingOverrides.get(modelId);
      return found === undefined || binding === undefined ? found : { ...found, binding };
    },
    tick: (world: Parameters<typeof core.tick>[0]) => {
      tickWorlds.push(world);
      if (tickFault.message !== undefined) throw new Error(tickFault.message);
      return core.tick(world);
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
const V2_FIXTURE = path.resolve(
  import.meta.dirname,
  "../test/fixtures/stores/house-config.v2.json",
);
const TRVZB = findProfile("TRVZB", "z2m");
if (TRVZB === undefined) throw new Error("no TRVZB profile");
const TRVZB_BINDING = TRVZB.binding;
/** The groups of the TRVZB spec, sorted. */
const TRVZB_GROUPS = TRVZB.spec.groups.map((g) => g.group).sort();

/** The same mark on every group of the TRVZB spec. */
function everyGroup<T>(mark: T): Readonly<Record<string, T>> {
  return Object.fromEntries(TRVZB_GROUPS.map((group) => [group, mark]));
}

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
}>;

/** Area id to the valves Home Assistant puts in it, in any order. */
type House = Readonly<Record<string, readonly string[]>>;

/** The house of `raw()` without options: valve A in the area `living`. */
const DEFAULT_HOUSE: House = { living: [A] };

/**
 * The house each document built by `raw` was written for: its room specs' areas and valves. A
 * version 3 document names no valve, so the rig puts them in Home Assistant (and in the saved
 * membership) from here.
 */
const housesOf = new WeakMap<RawConfig, House>();

function areaName(areaId: string): string {
  return `Area ${areaId}`;
}

/** What Home Assistant says about `house`: one area per key, each valve's device in its area. */
function haSnapshot(house: House): HaSnapshot {
  const areas = new Map<string, HaArea>();
  const valveAreas = new Map<string, string | null>();
  for (const [areaId, valves] of Object.entries(house)) {
    areas.set(areaId, { name: areaName(areaId), labels: [] });
    for (const valveId of valves) valveAreas.set(valveId, areaId);
  }
  return { areas, valveAreas, entities: new Map(), labels: new Map() };
}

/** The saved membership of `house`: its areas that hold a valve. */
function membershipOf(house: House): AreaMembership {
  const rooms = new Map<string, AreaRoom>();
  for (const areaId of Object.keys(house).sort()) {
    const valveIds = [...(house[areaId] ?? [])].sort();
    if (valveIds.length > 0) rooms.set(areaId, { name: areaName(areaId), valveIds });
  }
  return { rooms, ignored: [] };
}

function week(temperature = 20): NonNullable<RawConfig["schedules"]> {
  const day = { "00:00": 16, "07:00": temperature };
  return [
    {
      id: "main",
      name: "Main",
      week: [{ days: "all", temperature: day }],
    },
  ];
}

/**
 * A version 3 document with schedule `main` as the default and one entry per room spec (`living`,
 * then `room1`, `room2`… unless named), holding the spec's sensors. Its house puts each spec's
 * valves (A unless given) in the spec's area.
 */
function raw(
  options: Readonly<{
    rooms?: readonly RoomSpec[];
    hold?: boolean;
    timezone?: string | null;
    temperature?: number;
    /** False: a document without schedules. */
    schedules?: boolean;
  }> = {},
): RawConfig {
  const timezone = options.timezone === undefined ? ZONE : options.timezone;
  const specs = (options.rooms ?? [{}]).map((room, i) => ({
    ...room,
    id: room.id ?? (i === 0 ? "living" : `room${String(i)}`),
  }));
  const document: RawConfig = {
    version: 3,
    settings: {
      hold_writes: options.hold ?? false,
      ...(timezone === null ? {} : { timezone }),
    },
    ...(options.schedules === false
      ? {}
      : { schedules: week(options.temperature), default_schedule: "main" }),
    rooms: Object.fromEntries(
      specs.map((room) => [
        room.id,
        room.sensors === undefined || room.sensors.length === 0
          ? {}
          : { sensors: room.sensors.map((ref) => ({ ref })) },
      ]),
    ),
  };
  housesOf.set(document, Object.fromEntries(specs.map((room) => [room.id, room.valves ?? [A]])));
  return document;
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
  return {
    temperature_sensor_select: source,
    system_mode: "auto",
    occupied_heating_setpoint: 17,
    frost_protection_temperature: 7,
    open_window: "OFF",
    last_seen: token,
    ...extra,
  };
}

// ---- files ---------------------------------------------------------------------------------------

const folders: string[] = [];
function folder(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "heatmaster-runtime-"));
  folders.push(dir);
  return dir;
}

type Seed = Readonly<{
  /** A pacing file: valve id to bucketFullAt, or one that cannot be read. */
  pacing?: Readonly<Record<string, number>> | "unreadable";
  config?: RawConfig | "unreadable";
  /** The saved membership: by default the house of `config`; null for none. */
  membership?: House | null;
  /** The text of the config file, written as it is (in place of `config`). */
  configFile?: string;
  revision?: number;
  releasing?: Readonly<Record<string, number>>;
  ledger?: readonly ValveRecord[] | "unreadable";
  copy?: readonly ValveRecord[];
  /** The state file: the room states and valve expectations, or one that cannot be read. */
  state?: ThermostatState | "unreadable";
}>;

function seedFiles(dataDir: string, publicDir: string, seed: Seed): void {
  if (seed.configFile !== undefined) {
    writeFileSync(path.join(dataDir, "config.json"), seed.configFile);
  } else if (seed.config === "unreadable") {
    writeFileSync(path.join(dataDir, "config.json"), "{ not json");
  } else if (seed.config !== undefined) {
    const house = seed.membership === undefined ? housesOf.get(seed.config) : seed.membership;
    const stored: StoredConfig = {
      ...FRESH_STORED,
      config: validateConfig(seed.config),
      revision: seed.revision ?? 1,
      releasing: new Map(Object.entries(seed.releasing ?? {})),
      membership: house === null || house === undefined ? undefined : membershipOf(house),
      // As a running install: every area of its house has had its sensor import.
      importedAreas: house === null || house === undefined ? [] : Object.keys(house).sort(),
    };
    writeFileSync(
      path.join(dataDir, "config.json"),
      JSON.stringify({ version: 3, data: storedToRaw(stored) }),
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
  if (seed.pacing === "unreadable") {
    writeFileSync(path.join(dataDir, "pacing.json"), "{ not json");
  } else if (seed.pacing !== undefined) {
    const valves = Object.fromEntries(
      Object.entries(seed.pacing).map(([id, bucketFullAt]) => [id, { bucketFullAt }]),
    );
    writeFileSync(path.join(dataDir, "pacing.json"), JSON.stringify({ version: 1, valves }));
  }
  if (seed.state === "unreadable") {
    writeFileSync(path.join(dataDir, "state.json"), "{ not json");
  } else if (seed.state !== undefined) {
    writeFileSync(
      path.join(dataDir, "state.json"),
      JSON.stringify({ version: 1, ...thermostatStateToRaw(seed.state) }),
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
  fail: { config: number; ledger: number; copy: number; pacing: number; state: number };
  /**
   * The state file's saves ("state.save", "state.fail"), apart from `calls`: ticks save the valve
   * expectations, which the other stores' checks do not expect.
   */
  stateCalls: string[];
  /** Every state written to state.json, with the sends attempted when it was written. */
  stateSaves: { state: ThermostatState; sends: number }[];
  /** One entry per save of the pacing file that reached it, with the sends made so far. */
  pacingSaves: number[];
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

function wrapPacing(store: PacingStore, control: StoreControl): PacingStore {
  return {
    load: () => store.load(),
    async save(stamps, freeAsks) {
      if (control.fail.pacing > 0) {
        control.fail.pacing -= 1;
        throw failure();
      }
      await store.save(stamps, freeAsks);
      control.pacingSaves.push(control.sendsSoFar());
    },
  };
}

function wrapThermostats(store: ThermostatStore, control: StoreControl): ThermostatStore {
  return {
    load: () => store.load(),
    async save(thermostats) {
      if (control.fail.state > 0) {
        control.fail.state -= 1;
        control.stateCalls.push("state.fail");
        throw failure();
      }
      await store.save(thermostats);
      control.stateCalls.push("state.save");
      control.stateSaves.push({ state: thermostats, sends: control.sendsSoFar() });
    },
    reset: () => store.reset(),
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

type Logged = Readonly<{
  level: "info" | "warn" | "error";
  message: string;
  data: Readonly<Record<string, unknown>> | undefined;
}>;

type Rig = Readonly<{
  rt: HeatmasterRuntime;
  clock: ManualClock;
  z2m: StubTransport;
  ha: StubHaLink | undefined;
  stores: StoreControl;
  dataDir: string;
  publicDir: string;
  logs: string[];
  /** Every log line with its level and data. */
  logged: Logged[];
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
  tickFault.message = undefined;
  tickWorlds.length = 0;
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
    /** A restart: the same folders and clock as this earlier rig, which is stopped first. */
    after?: Rig;
    /** Home Assistant's areas: by default the house of the seed's config, else DEFAULT_HOUSE. */
    house?: House;
    /** Home Assistant's snapshot, in place of the one of `house`. */
    snapshot?: HaSnapshot;
  }> = {},
): Promise<Rig> {
  if (options.after !== undefined) await options.after.rt.stop();
  const dataDir = options.after?.dataDir ?? folder();
  const publicDir = options.after?.publicDir ?? folder();
  if (options.after === undefined) seedFiles(dataDir, publicDir, options.seed ?? {});
  const clock = options.after?.clock ?? createManualClock(T);
  const z2m = createStubTransport("z2m");
  const stores: StoreControl = {
    calls: [],
    sendsAtCall: [],
    sendsSoFar: () => z2m.attempts().length,
    expected: [],
    overwrite: [],
    fail: { config: 0, ledger: 0, copy: 0, pacing: 0, state: 0 },
    stateCalls: [],
    stateSaves: [],
    pacingSaves: [],
    gates: {},
    reached: [],
  };
  z2m.setDevices(options.devices ?? [trvzb(A)]);
  const ha = options.ha === null ? undefined : (options.ha ?? createStubHaLink());
  const seeded = options.seed?.config;
  const house =
    options.house ??
    (seeded === undefined || seeded === "unreadable" ? undefined : housesOf.get(seeded)) ??
    DEFAULT_HOUSE;
  ha?.setSnapshot(options.snapshot ?? haSnapshot(house));
  const logs: string[] = [];
  const logged: Logged[] = [];
  const logAt =
    (level: Logged["level"]) =>
    (message: string, data?: Readonly<Record<string, unknown>>): void => {
      logs.push(`${level} ${message}`);
      logged.push({ level, message, data });
    };
  const log: RuntimeLog = { info: logAt("info"), warn: logAt("warn"), error: logAt("error") };
  const rt = createRuntime({
    configStore: wrapConfig(createConfigStore(dataDir, clock), stores),
    ledgerStore: wrapLedger(createLedgerStore({ dataDir, publicDir }, clock, "test"), stores),
    pacingStore: wrapPacing(createPacingStore(dataDir), stores),
    thermostatStore: wrapThermostats(createThermostatStore(dataDir, clock), stores),
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
    logged,
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

/**
 * A fresh install, booted. Its start saved the empty config (writes held) and its first tick the
 * membership; those store calls are dropped, so the test sees only its own.
 */
async function bootFresh(options: Parameters<typeof boot>[0] = {}): Promise<Rig> {
  const rig = await boot(options);
  rig.stores.calls.length = 0;
  rig.stores.sendsAtCall.length = 0;
  rig.stores.overwrite.length = 0;
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

const STORED: StoredConfig = { ...FRESH_STORED, config: EMPTY_CONFIG, revision: 1 };

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
    load: () =>
      Promise.resolve({
        state: "empty",
        stored: undefined,
        convertedFrom: undefined,
        reason: undefined,
      }),
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
  const thermostatStore: ThermostatStore = {
    load: () =>
      Promise.resolve({ state: "ok", thermostats: EMPTY_THERMOSTAT_STATE, reason: undefined }),
    save: () => step("saveThermostats"),
    reset: () => Promise.resolve(),
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
    thermostatStore,
    transports: { z2m },
    bindingOf: (valveId) => (Object.hasOwn(bindings, valveId) ? bindings[valveId] : TRVZB_BINDING),
    overwriteUnreadable: options.overwriteUnreadable ?? false,
    onLedgerSaved: () => order.push("onLedgerSaved"),
    onConfigSaved: () => order.push("onConfigSaved"),
    onThermostatsSaved: () => order.push("onThermostatsSaved"),
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
  overwriteUnreadable: false,
};

const NO_READ: Binding = { ...TRVZB_BINDING, encodeRefresh: () => undefined };

// ---- room thermostats ----------------------------------------------------------------------------

const API: Origin = { source: "api", valveId: undefined };

function setTarget(celsius: number): ThermostatCommand {
  return { kind: "set_target", celsius, end: undefined };
}

/** What a TRVZB reports back once it holds the days of `week()`. */
const DAYS_ECHO: Readonly<Record<string, string>> = Object.fromEntries(
  ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((day) => [
    `weekly_schedule_${day}`,
    "00:00/16 07:00/20 07:00/20 07:00/20 07:00/20 07:00/20",
  ]),
);

/** A TRVZB set to heat at `celsius` by hand. */
function heatMessage(token: string, celsius = 23): Readonly<Record<string, unknown>> {
  return trvzbMessage(token, "local_temperature", {
    system_mode: "heat",
    occupied_heating_setpoint: celsius,
  });
}

/** As `inSync`, every message made by `message`. */
async function inSyncWith(
  rig: Rig,
  valves: readonly string[],
  message: (token: string) => Readonly<Record<string, unknown>>,
): Promise<void> {
  for (const step of [1, 2]) {
    for (const id of valves) rig.say(id, `${id}-${String(step)}`, message(`${id}-${String(step)}`));
    await rig.advance(1000);
  }
  await rig.advance(1000);
  for (const id of valves) rig.say(id, `${id}-3`, message(`${id}-3`));
  await rig.advance(1000);
}

/** The index in the transport's attempts of the first mode or setpoint publish to `valveId`; -1 if none. */
function firstThermostatWrite(rig: Rig, valveId: string): number {
  return rig.z2m
    .attempts()
    .findIndex(
      (send) =>
        send.kind === "publish" &&
        send.deviceId === valveId &&
        (Object.hasOwn(send.payload as object, "system_mode") ||
          Object.hasOwn(send.payload as object, "occupied_heating_setpoint")),
    );
}

function stateText(rig: Rig): string {
  return readFileSync(path.join(rig.dataDir, "state.json"), "utf8");
}

/** The `rooms` of state.json, as written. */
function savedRooms(rig: Rig): Record<string, unknown> {
  return readJson(path.join(rig.dataDir, "state.json")).rooms as Record<string, unknown>;
}

/** The `valves` of state.json, as written. */
function savedValves(rig: Rig): Record<string, unknown> {
  return readJson(path.join(rig.dataDir, "state.json")).valves as Record<string, unknown>;
}

function roomStatus(rig: Rig, roomId: string): RoomStatus | undefined {
  return rig.rt.snapshot().rooms.find((room) => room.roomId === roomId)?.status;
}

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

      it("error is undefined, unsent, unpushed and held are empty, and stores is { ledger: true, copy: true, config: true }", async () => {
        const outcome = await executeEffects(effects, execRig().context);
        expect(outcome).toEqual({
          error: undefined,
          unsent: [],
          unpushed: [],
          held: [],
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

  describe("house", () => {
    const roomIds = (rig: Rig): string[] => rig.rt.snapshot().rooms.map((room) => room.roomId);
    const valvesOf = (rig: Rig, roomId: string): readonly string[] | undefined =>
      rig.rt.snapshot().rooms.find((room) => room.roomId === roomId)?.valveIds;

    describe("Without a Home Assistant link", () => {
      it("start resolves", async () => {
        const rig = await boot({ ha: null, seed: managedSeed([A]) });
        expect(rig.rt.snapshot().tickedAt).toBe(T);
      });

      it("the snapshot's house is unlinked", async () => {
        const rig = await boot({ ha: null, seed: managedSeed([A]) });
        expect(rig.rt.snapshot().house).toBe("unlinked");
      });

      it("rooms lists the stored membership's rooms, none of them managed (none are listed when no membership is saved)", async () => {
        const rig = await boot({ ha: null, seed: managedSeed([A]) });
        expect(rig.rt.snapshot().rooms.map((room) => [room.roomId, room.managed])).toEqual([
          ["living", false],
        ]);
        const bare = await boot({ ha: null, seed: { ...managedSeed([A]), membership: null } });
        expect(bare.rt.snapshot().rooms).toEqual([]);
      });

      it("every recorded valve is frozen", async () => {
        const rig = await boot({
          ha: null,
          devices: [trvzb(A), trvzb(B)],
          seed: { config: raw({ rooms: [{ valves: [A] }] }), ledger: [record(A), record(B)] },
        });
        expect(rig.rt.snapshot().memberships).toEqual({ [A]: "frozen", [B]: "frozen" });
      });
    });

    describe("Before the link has loaded", () => {
      async function loading(): Promise<Rig> {
        const ha = createStubHaLink();
        ha.setState("connecting");
        return boot({ ha, seed: managedSeed([A]), house: { office: [A] } });
      }

      it("rooms come from the stored membership and house is frozen", async () => {
        const rig = await loading();
        expect(roomIds(rig)).toEqual(["living"]);
        expect(rig.rt.snapshot().house).toBe("frozen");
      });

      it("frozenReason is not_loaded", async () => {
        const rig = await loading();
        expect(rig.rt.snapshot().houseFrozenReason).toBe("not_loaded");
      });
    });

    describe("After the first load", () => {
      async function loaded(): Promise<Rig> {
        const ha = createStubHaLink();
        ha.setState("connecting");
        const rig = await boot({ ha, seed: managedSeed([A]), house: { office: [A] } });
        ha.setState("up");
        ha.emit({ kind: "link_up" });
        await vi.waitFor(() => {
          expect(rig.rt.snapshot().house).toBe("live");
        });
        return rig;
      }

      it("rooms come from Home Assistant at once and house is live", async () => {
        const rig = await loaded();
        expect(roomIds(rig)).toEqual(["office"]);
        expect(rig.rt.snapshot().house).toBe("live");
        expect(rig.clock.nowMs()).toBe(T);
      });

      it("frozenReason is absent", async () => {
        const rig = await loaded();
        expect(rig.rt.snapshot().houseFrozenReason).toBeUndefined();
      });
    });

    describe("When a device moves to another area", () => {
      async function moved(): Promise<Rig> {
        const rig = await boot({ seed: managedSeed([A]) });
        rig.ha?.setSnapshot(haSnapshot({ office: [A] }));
        rig.ha?.emit({ kind: "registries_changed" });
        return rig;
      }

      it("rooms are unchanged until HA_SETTLE_MS has passed without another registry change", async () => {
        const rig = await moved();
        await rig.advance(3000);
        rig.ha?.emit({ kind: "registries_changed" });
        await rig.advance(HA_SETTLE_MS - 1);
        expect(roomIds(rig)).toEqual(["living"]);
        await rig.advance(1);
        expect(roomIds(rig)).toEqual(["office"]);
      });

      it("after that the valve is in the new room", async () => {
        const rig = await moved();
        await rig.advance(HA_SETTLE_MS);
        expect(valvesOf(rig, "office")).toEqual([A]);
        expect(valvesOf(rig, "living")).toBeUndefined();
      });
    });

    describe("With three registries_changed 2 s apart", () => {
      it("the membership is taken once, HA_SETTLE_MS after the last", async () => {
        const ha = createStubHaLink();
        const rig = await boot({ ha, seed: managedSeed([A]) });
        const before = ha.snapshotReads();
        const ticks = rig.snapshots.length;
        for (const areaId of ["office", "hall", "kitchen"]) {
          if (areaId !== "office") await rig.advance(2000);
          ha.setSnapshot(haSnapshot({ [areaId]: [A] }));
          ha.emit({ kind: "registries_changed" });
        }
        await rig.advance(HA_SETTLE_MS - 1);
        expect(ha.snapshotReads()).toBe(before);
        await rig.advance(1);
        // One settle: it reads the snapshot (for the membership, the label pull and the snapshot's
        // label problems) and runs one tick.
        expect(ha.snapshotReads()).toBeGreaterThan(before);
        expect(rig.snapshots.length).toBe(ticks + 1);
        expect(roomIds(rig)).toEqual(["kitchen"]);
      });
    });

    describe("When the link goes down", () => {
      async function down(): Promise<Rig> {
        const rig = await boot({ seed: managedSeed([A]), house: { office: [A] } });
        rig.ha?.setReady(true);
        rig.ha?.setState("down");
        rig.ha?.emit({ kind: "link_down" });
        return rig;
      }

      it("rooms are those Home Assistant last reported, saved with the config, and house is frozen", async () => {
        const rig = await down();
        expect(roomIds(rig)).toEqual(["office"]);
        expect(rig.rt.snapshot().house).toBe("frozen");
        const file = readJson(path.join(rig.dataDir, "config.json"));
        expect(file).toMatchObject({
          data: { membership: { rooms: { office: { valves: [A] } } } },
        });
      });

      it("those rooms stay managed, so their Home Assistant room devices stay published", async () => {
        const rig = await down();
        await rig.advance(TICK_INTERVAL_MS);
        expect(rig.rt.snapshot().rooms.map((room) => [room.roomId, room.managed])).toEqual([
          ["office", true],
        ]);
      });

      it("frozenReason is link_down", async () => {
        const rig = await down();
        expect(rig.rt.snapshot().houseFrozenReason).toBe("link_down");
      });

      it("no settle runs while it is down", async () => {
        const ha = createStubHaLink();
        const rig = await boot({ ha, seed: managedSeed([A]) });
        ha.emit({ kind: "registries_changed" });
        await rig.advance(1000);
        ha.setReady(true);
        ha.setState("down");
        ha.emit({ kind: "link_down" });
        const before = ha.snapshotReads();
        await rig.advance(HA_SETTLE_MS);
        ha.emit({ kind: "registries_changed" });
        await rig.advance(HA_SETTLE_MS);
        expect(ha.snapshotReads()).toBe(before);
      });
    });

    describe("With Home Assistant loaded before Zigbee2MQTT has listed a recorded valve", () => {
      it("the valve stays in its room", async () => {
        const rig = await boot({ devices: [], seed: managedSeed([A]) });
        expect(rig.rt.snapshot().house).toBe("live");
        expect(valvesOf(rig, "living")).toEqual([A]);
      });
    });

    describe("With Home Assistant loaded before Zigbee2MQTT lists a new valve that Home Assistant puts in a room", () => {
      it("once Zigbee2MQTT lists it, the snapshot lists it in that room, with no settle wait", async () => {
        const rig = await boot({ seed: managedSeed([A]), house: { living: [A], office: [B] } });
        expect(roomIds(rig)).toEqual(["living"]);
        rig.z2m.setDevices([trvzb(A), trvzb(B)]);
        await rig.advance(EVENT_DEBOUNCE_MS);
        expect(valvesOf(rig, "office")).toEqual([B]);
      });
    });

    describe("On a reconnect, between ha.up() and the link_up handler", () => {
      it("house is frozen with reason link_down", async () => {
        const rig = await boot({ seed: managedSeed([A]) });
        rig.ha?.setReady(true);
        rig.ha?.setState("down");
        rig.ha?.emit({ kind: "link_down" });
        rig.ha?.setState("up");
        const snapshot = rig.rt.snapshot();
        expect(snapshot.house).toBe("frozen");
        expect(snapshot.houseFrozenReason).toBe("link_down");
      });
    });
  });

  describe("automatic join", () => {
    const recordsOf = (rig: Rig): string[] =>
      Object.keys(
        (readJson(path.join(rig.dataDir, "ledger.json")).data as { records: object }).records,
      ).sort();
    const publishes = (rig: Rig, valveId: string): ReturnType<StubTransport["sent"]> =>
      sends(rig, valveId).filter((s) => s.kind === "publish");
    const scheduleWritten = (rig: Rig, valveId: string): boolean =>
      publishes(rig, valveId).some((s) =>
        Object.hasOwn(s.payload as object, "weekly_schedule_monday"),
      );
    /** Home Assistant's registries change to `house`; the settle has not passed yet. */
    const moveTo = (rig: Rig, house: House): void => {
      rig.ha?.setSnapshot(haSnapshot(house));
      rig.ha?.emit({ kind: "registries_changed" });
    };

    describe("With writes released and a new area holding an observable valve", () => {
      async function joined(): Promise<Rig> {
        const rig = await boot({ devices: [trvzb(A), trvzb(B)], seed: managedSeed([A]) });
        rig.say(B, "b-1");
        await rig.advance(1000);
        moveTo(rig, { living: [A], office: [B] });
        return rig;
      }

      it("after the settle the valve's record is saved", async () => {
        const rig = await joined();
        await rig.advance(HA_SETTLE_MS - 1);
        expect(recordsOf(rig)).toEqual([A]);
        await rig.advance(1);
        expect(recordsOf(rig)).toEqual([A, B]);
        expect(rig.rt.snapshot().memberships[B]).toBe("managed");
      });

      it("its schedule is written with no apply", async () => {
        const rig = await joined();
        await rig.advance(HA_SETTLE_MS);
        await hear(rig, [B]);
        await rig.advance(2 * MINUTE);
        expect(scheduleWritten(rig, B)).toBe(true);
        expect(rig.rt.snapshot().revision).toBe(1);
      });
    });

    describe("With a schedule applied on a fresh install by a document that does not set hold_writes", () => {
      it("the records are saved and nothing is written to a valve until writes are released", async () => {
        const rig = await boot({ devices: [trvzb(A), trvzb(B)], house: { living: [A, B] } });
        rig.say(A, "a-1");
        rig.say(B, "b-1");
        // The fresh install's hold, not the document, keeps the writes held.
        const document = raw();
        await rig.rt.apply({ ...document, settings: { timezone: ZONE } }, APPLY);
        expect(rig.rt.snapshot().held).toBe(true);
        expect(recordsOf(rig)).toEqual([A, B]);
        await hear(rig, [A, B]);
        await rig.advance(10 * MINUTE);
        expect(publishes(rig, A)).toEqual([]);
        expect(publishes(rig, B)).toEqual([]);
        await rig.rt.setHold(false);
        await rig.advance(2 * MINUTE);
        expect(scheduleWritten(rig, A)).toBe(true);
        expect(scheduleWritten(rig, B)).toBe(true);
      });
    });

    describe("With a joining valve that never reports", () => {
      async function waiting(): Promise<Rig> {
        return boot({
          devices: [trvzb(A), trvzb(B)],
          house: { living: [A, B] },
          seed: { config: raw(), ledger: [record(A)] },
        });
      }
      const readsOf = (rig: Rig): number => sends(rig, B).filter((s) => s.kind === "read").length;

      it("it is pending and asked to report, paced", async () => {
        const rig = await waiting();
        expect(rig.rt.snapshot().memberships[B]).toBe("pending");
        expect(rig.rt.snapshot().pending).toEqual([
          { valveId: B, roomId: "living", reason: "valve_not_observed", unreadable: [] },
        ]);
        expect(readsOf(rig)).toBe(1);
        await rig.advance(TICK_INTERVAL_MS);
        expect(readsOf(rig)).toBe(1);
        await rig.advance(30 * MINUTE);
        // Sixty ticks have run since; the asks are paced, not one per tick.
        expect(readsOf(rig)).toBeGreaterThanOrEqual(2);
        expect(readsOf(rig)).toBeLessThan(10);
        expect(rig.rt.snapshot().memberships[B]).toBe("pending");
      });

      it("the other valve of its room is managed", async () => {
        const rig = await waiting();
        expect(rig.rt.snapshot().memberships[A]).toBe("managed");
        await hear(rig, [A]);
        await rig.advance(2 * MINUTE);
        expect(scheduleWritten(rig, A)).toBe(true);
      });
    });

    describe("With Home Assistant loaded before Zigbee2MQTT lists a new valve in a room", () => {
      it("once Zigbee2MQTT lists it, it joins", async () => {
        const rig = await boot({ seed: managedSeed([A]), house: { living: [A, B] } });
        expect(rig.rt.snapshot().memberships[B]).toBeUndefined();
        rig.z2m.setDevices([trvzb(A), trvzb(B)]);
        await rig.advance(EVENT_DEBOUNCE_MS);
        rig.say(B, "b-1");
        await rig.advance(EVENT_DEBOUNCE_MS);
        expect(recordsOf(rig)).toEqual([A, B]);
        expect(rig.rt.snapshot().memberships[B]).toBe("managed");
      });
    });

    describe("With a valve whose device is taken out of its area", () => {
      it("after the settle it is releasing and its originals are written", async () => {
        const rig = await boot({
          seed: { config: raw(), ledger: [record(A, "external")] },
          house: { living: [A] },
        });
        await inSync(rig, [A]);
        const before = publishes(rig, A).length;
        rig.ha?.setSnapshot({ ...haSnapshot({ living: [] }), valveAreas: new Map([[A, null]]) });
        rig.ha?.emit({ kind: "registries_changed" });
        await rig.advance(HA_SETTLE_MS);
        expect(rig.rt.snapshot().memberships[A]).toBe("releasing");
        rig.say(A, "a-9");
        await rig.advance(2 * MINUTE);
        expect(
          publishes(rig, A)
            .slice(before)
            .map((s) => s.payload),
        ).toContainEqual(TRVZB_BINDING.encode({ sensor_source: "external" }));
      });
    });

    describe("With a membership change", () => {
      it("the saved config holds the new membership and its revision is unchanged", async () => {
        const rig = await boot({ seed: managedSeed([A]) });
        moveTo(rig, { office: [A] });
        await rig.advance(HA_SETTLE_MS);
        const file = readJson(path.join(rig.dataDir, "config.json"));
        expect(file).toMatchObject({
          data: { revision: 1, membership: { rooms: { office: { valves: [A] } } } },
        });
        expect(
          Object.keys((file.data as { membership: { rooms: object } }).membership.rooms),
        ).toEqual(["office"]);
        expect(rig.rt.snapshot().revision).toBe(1);
      });
    });

    describe("With a device moved while the link is down", () => {
      async function movedWhileDown(): Promise<Rig> {
        const rig = await boot({
          devices: [trvzb(A), trvzb(B)],
          seed: { config: raw(), ledger: [record(A)] },
          house: { living: [A] },
        });
        rig.say(B, "b-1");
        rig.ha?.setReady(true);
        rig.ha?.setState("down");
        rig.ha?.emit({ kind: "link_down" });
        // A leaves its area for none, B is put in the room.
        rig.ha?.setSnapshot({
          ...haSnapshot({ living: [B] }),
          valveAreas: new Map([
            [A, null],
            [B, "living"],
          ]),
        });
        rig.ha?.emit({ kind: "registries_changed" });
        await rig.advance(HA_SETTLE_MS + TICK_INTERVAL_MS);
        return rig;
      }

      it("nothing joins or releases while it is down", async () => {
        const rig = await movedWhileDown();
        expect(recordsOf(rig)).toEqual([A]);
        expect(rig.rt.snapshot().memberships).toEqual({ [A]: "managed" });
        const file = readJson(path.join(rig.dataDir, "config.json")) as {
          data: { releasing?: Record<string, unknown> };
        };
        expect(file.data.releasing?.[A]).toBeUndefined();
      });

      it("after link_up the move is acted on", async () => {
        const rig = await movedWhileDown();
        rig.ha?.setState("up");
        rig.ha?.emit({ kind: "link_up" });
        await rig.advance(EVENT_DEBOUNCE_MS);
        expect(recordsOf(rig)).toEqual([A, B]);
        expect(rig.rt.snapshot().memberships).toEqual({ [A]: "releasing", [B]: "managed" });
      });
    });
  });

  describe("start", () => {
    describe("With an unreadable state file", () => {
      /** Valve A by hand in heat at 23 °C, the state file unreadable. */
      async function unreadable(): Promise<Rig> {
        const rig = await boot({ seed: { ...managedSeed([A]), state: "unreadable" } });
        await inSyncWith(rig, [A], heatMessage);
        return rig;
      }

      it("the reason is logged at error level", async () => {
        const rig = await unreadable();
        expect(rig.logged).toContainEqual({
          level: "error",
          message: "the saved room states cannot be read; no mode or setpoint is written",
          data: { reason: expect.stringMatching(/^SyntaxError: /) as unknown },
        });
      });

      it("the world's thermostats are undefined and problem state_unreadable shows", async () => {
        const rig = await unreadable();
        expect(tickWorlds.length).toBeGreaterThan(0);
        expect(tickWorlds.every((world) => world.thermostats === undefined)).toBe(true);
        expect(problemKinds(rig.rt.snapshot())).toContain("state_unreadable");
      });

      it("no publish carries system_mode or setpoint", async () => {
        const rig = await unreadable();
        await rig.advance(10 * MINUTE);
        expect(sends(rig, A).some((send) => send.kind === "publish")).toBe(true);
        expect(firstThermostatWrite(rig, A)).toBe(-1);
      });
    });

    describe("With a config file of version 2", () => {
      const seed: Seed = { configFile: readFileSync(V2_FIXTURE, "utf8") };

      it("the converted file is saved once, then by the sensor import, then once more by the tick with Home Assistant's membership", async () => {
        const rig = await boot({ seed });
        expect(rig.stores.calls.filter((call) => call === "config.save")).toHaveLength(3);
        const file = readJson(path.join(rig.dataDir, "config.json"));
        expect(file.version).toBe(3);
        expect(file).toMatchObject({
          data: { revision: 3, membership: { rooms: { living: {} } } },
        });
        await rig.advance(TICK_INTERVAL_MS);
        expect(rig.stores.calls.filter((call) => call === "config.save")).toHaveLength(3);
      });

      it('"config converted" is logged once', async () => {
        const rig = await boot({ seed });
        expect(rig.logged.filter((line) => line.message === "config converted")).toEqual([
          { level: "info", message: "config converted", data: { fromVersion: 2 } },
        ]);
      });

      it("writes are held", async () => {
        const rig = await boot({ seed });
        expect(rig.rt.snapshot().held).toBe(true);
      });

      it("the original file is kept next to it as config.v2.json", async () => {
        const rig = await boot({ seed });
        expect(readFileSync(path.join(rig.dataDir, "config.v2.json"), "utf8")).toBe(
          seed.configFile,
        );
      });
    });

    describe("With no config file, no ledger and an empty readable copy", () => {
      it("FRESH_STORED is saved and configState is ok", async () => {
        // Without a Home Assistant link the first tick saves no membership after it.
        const rig = await boot({ ha: null });
        expect(rig.stores.calls).toEqual(["config.save"]);
        expect(readJson(path.join(rig.dataDir, "config.json"))).toEqual(
          JSON.parse(JSON.stringify({ version: 3, data: storedToRaw(FRESH_STORED) })),
        );
        expect(rig.rt.snapshot().configState).toBe("ok");
        expect(rig.rt.snapshot().revision).toBe(0);
      });

      it("writes are held", async () => {
        const rig = await boot();
        expect(rig.rt.snapshot().held).toBe(true);
      });

      it("snapshot has revision 0, no rooms and no problems", async () => {
        const rig = await boot({ house: {} });
        const snapshot = rig.rt.snapshot();
        expect(snapshot.revision).toBe(0);
        expect(snapshot.rooms).toEqual([]);
        expect(snapshot.problems).toEqual([]);
      });

      it("one tick has run after the save: tickedAt is set", async () => {
        const rig = await boot();
        expect(rig.rt.snapshot().tickedAt).toBe(T);
      });
    });

    describe("With no config file, no ledger and an empty copy, and the first save of the config failing", () => {
      async function failedFresh(): Promise<Rig> {
        const rig = await boot({ start: false });
        rig.stores.fail.config = 1;
        await rig.rt.start();
        await rig.rt.settled();
        rig.say(A, "a-1");
        await rig.advance(TICK_INTERVAL_MS);
        return rig;
      }

      it("store_write_failed shows, the config stays empty and nothing is written to a valve", async () => {
        const rig = await failedFresh();
        expect(rig.stores.calls[0]).toBe("config.fail");
        const snapshot = rig.rt.snapshot();
        expect(snapshot.configState).toBe("empty");
        expect(snapshot.problems.map((problem) => problem.kind)).toContain("store_write_failed");
        expect(sends(rig, A).filter((sent) => sent.kind === "publish")).toEqual([]);
      });

      it("a later apply saves revision 1, with writes held by the document's default", async () => {
        const rig = await failedFresh();
        const document = raw();
        await rig.rt.apply({ ...document, settings: { timezone: ZONE } }, APPLY);
        expect(readJson(path.join(rig.dataDir, "config.json"))).toMatchObject({
          data: { revision: 1, config: { settings: { hold_writes: true } } },
        });
        expect(rig.rt.snapshot().held).toBe(true);
      });
    });

    describe("With no config file and a ledger with a record", () => {
      it("nothing is saved and the recorded valve is frozen", async () => {
        const rig = await boot({ seed: { ledger: [record(A)] } });
        expect(rig.stores.calls).toEqual([]);
        expect(rig.rt.snapshot().configState).toBe("empty");
        expect(rig.rt.snapshot().memberships).toEqual({ [A]: "frozen" });
      });
    });

    describe("With a config file of version 3", () => {
      it("nothing is saved at start", async () => {
        const rig = await boot({ seed: managedSeed([A]) });
        expect(rig.stores.calls.filter((call) => call.startsWith("config."))).toEqual([]);
      });
    });

    describe("With no ledger file and a stored membership that holds a valve", () => {
      it("the ledger counts as expected and its absence is handled as plan 1 handles a missing ledger", async () => {
        const rig = await boot({ seed: { config: raw() } });
        expect(rig.stores.expected).toEqual([true]);
        expect(rig.rt.snapshot().ledgerReadable).toBe(false);
        expect(problemKinds(rig.rt.snapshot())).toContain("ledger_unreadable");
      });
    });

    describe("With no ledger file, entries in the config, an empty membership and nothing releasing", () => {
      it("the ledger does not count as expected", async () => {
        const rig = await boot({ seed: { config: raw(), membership: {} } });
        expect(rig.stores.expected).toEqual([false]);
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

      it("the reason is logged at error level", async () => {
        const rig = await boot({ seed: { config: "unreadable" } });
        expect(rig.logged).toContainEqual({
          level: "error",
          message: "the config cannot be read",
          data: { reason: expect.any(String) as unknown },
        });
      });
    });

    describe("With a version 2 config file that cannot be converted", () => {
      it("the conversion's error is logged at error level and the page shows config_unreadable", async () => {
        const v2 = JSON.parse(readFileSync(V2_FIXTURE, "utf8")) as { data: { revision?: unknown } };
        delete v2.data.revision;
        const rig = await boot({ seed: { configFile: JSON.stringify(v2) } });
        const line = rig.logged.find((entry) => entry.message === "the config cannot be read");
        expect(line?.level).toBe("error");
        expect(line?.data?.reason).toEqual(expect.any(String));
        expect(problemKinds(rig.rt.snapshot())).toContain("config_unreadable");
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

      it("apply of a config whose room holds that valve lists it pending with ledger_unreadable, and no record is made", async () => {
        const rig = await boot({ seed });
        rig.say(A, "a1");
        const plan = await rig.rt.apply(raw(), APPLY);
        expect(plan.joining).toEqual([]);
        expect(plan.pending).toEqual([
          { valveId: A, roomId: "living", reason: "ledger_unreadable", unreadable: [] },
        ]);
        expect(rig.stores.calls).not.toContain("ledger.save");
      });

      it("after importOriginals(false) and the same apply, nothing joins and the valve is managed on the copy's record", async () => {
        const rig = await boot({ seed });
        rig.say(A, "a1");
        await rig.rt.importOriginals(false);
        const plan = await rig.rt.apply(raw(), APPLY);
        expect(plan.joining).toEqual([]);
        expect(plan.pending).toEqual([]);
        expect(rig.rt.snapshot().memberships[A]).toBe("managed");
        const ledger = readJson(path.join(rig.dataDir, "ledger.json"));
        expect((ledger.data as { records: Record<string, unknown> }).records[A]).toEqual(
          (ledgerToRaw(ledgerOf([record(A, "external")])) as { records: Record<string, unknown> })
            .records[A],
        );
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
        // The echo of the start's label mirror settles at T + 5 s, with a tick.
        const before = rig.rt.snapshot().tickedAt;
        rig.say(A, "a1");
        rig.clock.advance(EVENT_DEBOUNCE_MS - 1);
        expect(rig.rt.snapshot().tickedAt).toBe(before);
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
        expect(Object.keys(rig.marks(A)).sort()).toEqual(TRVZB_GROUPS);
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

    describe("With a tick that throws after the start", () => {
      /** Started and ticked once; the next two interval ticks throw the same error. */
      async function failing(): Promise<Rig> {
        const rig = await boot({ seed: managedSeed([A]) });
        tickFault.message = "tick broke";
        await rig.advance(TICK_INTERVAL_MS);
        return rig;
      }
      it("the error is logged once, however often the same error repeats", async () => {
        const rig = await failing();
        await rig.advance(TICK_INTERVAL_MS);
        expect(rig.logs.filter((line) => line.startsWith("error a tick failed"))).toHaveLength(1);
      });
      it("the listeners still receive a snapshot, and its problems hold tick_failed", async () => {
        const rig = await boot({ seed: managedSeed([A]) });
        const before = rig.snapshots.length;
        tickFault.message = "tick broke";
        await rig.advance(TICK_INTERVAL_MS);
        expect(rig.snapshots.length).toBe(before + 1);
        expect(problemKinds(rig.snapshots.at(-1) ?? rig.rt.snapshot())).toContain("tick_failed");
        expect(problemKinds(rig.rt.snapshot())).toContain("tick_failed");
      });
      it("the next interval tick still runs, and once it succeeds tick_failed is gone", async () => {
        const rig = await failing();
        tickFault.message = undefined;
        await rig.advance(TICK_INTERVAL_MS);
        expect(rig.rt.snapshot().tickedAt).toBe(T + 2 * TICK_INTERVAL_MS);
        expect(problemKinds(rig.rt.snapshot())).not.toContain("tick_failed");
      });
      it("an error that comes back after a good tick is logged again", async () => {
        const rig = await failing();
        tickFault.message = undefined;
        await rig.advance(TICK_INTERVAL_MS);
        tickFault.message = "tick broke";
        await rig.advance(TICK_INTERVAL_MS);
        expect(rig.logs.filter((line) => line.startsWith("error a tick failed"))).toHaveLength(2);
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
        expect(rig.marks(A)).toEqual(everyGroup(fresh));
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
          expect(rig.marks(id)).toEqual(everyGroup(fresh));
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
        expect(rig.marks(A)).toEqual(everyGroup(fresh));
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
        const rig = await bootFresh();
        rig.say(A, "a-1");
        const plan = await rig.rt.apply(raw(), APPLY);
        return Object.assign(rig, { plan });
      }

      it("the config file is written, then the tick after it saves the valve's record and its copy", async () => {
        const rig = await applied();
        // The membership Home Assistant reports was saved at the start, and the change keeps it.
        expect(rig.stores.calls).toEqual(["config.save", "ledger.save", "copy.write"]);
        const ledger = readJson(path.join(rig.dataDir, "ledger.json"));
        expect(Object.keys((ledger.data as { records: object }).records)).toEqual([A]);
      });

      it("the returned plan lists the valve as joining, with its captured originals and the planned writes", async () => {
        const rig = await applied();
        expect(rig.plan.joining).toEqual([
          {
            valveId: A,
            originals: {
              sensor_source: "internal",
              frost_protection: 7,
              system_mode: "auto",
              setpoint: 17,
              open_window: "off",
            },
            unreadable: [],
          },
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
        // The tick right after the apply kept the direct ask's spacing, so the valve was asked
        // once more before its first write.
        await rig.advance(1000);
        rig.say(A, "a-3");
        await rig.advance(TICK_INTERVAL_MS);
        const publish = sends(rig, A).find((s) => s.kind === "publish");
        expect(Object.keys(publish?.payload as object)).toContain("weekly_schedule_monday");
      });
    });

    describe("With an invalid document", () => {
      it("rejects with ConfigError, nothing is saved, and no sensor was looked up", async () => {
        const ha = createStubHaLink();
        const rig = await bootFresh({ ha });
        rig.say(A, "a-1");
        const bad = { ...raw({ rooms: [{ sensors: [ROOM_SENSOR] }] }), default_schedule: "nope" };
        const error = await rejectionOf(rig.rt.apply(bad, APPLY));
        expect(error).toBeInstanceOf(ConfigError);
        expect(rig.stores.calls).toEqual([]);
        expect(ha.infoCalls()).toEqual([]);
      });
    });

    // A preview asks as an apply does; it is used here because the tick after an apply asks a
    // pending valve too.
    describe("With a new valve that has sent no message", () => {
      it("returns a plan that lists it pending with valve_not_observed", async () => {
        const rig = await boot();
        const plan = await rig.rt.preview(raw(), APPLY);
        expect(plan.joining).toEqual([]);
        expect(plan.pending).toEqual([
          { valveId: A, roomId: "living", reason: "valve_not_observed", unreadable: [] },
        ]);
      });

      it("the transport received one read for that valve, holding binding.encodeRefresh()", async () => {
        const rig = await boot();
        await rig.rt.preview(raw(), APPLY);
        expect(rig.z2m.sent()).toEqual([
          { kind: "read", deviceId: A, payload: TRVZB_BINDING.encodeRefresh() },
        ]);
      });

      it("the tick right after an apply sends no second read: the direct ask counts for the valve's spacing", async () => {
        const rig = await boot();
        await rig.rt.apply(raw(), APPLY);
        const reads = (): number => sends(rig, A).filter((s) => s.kind === "read").length;
        expect(reads()).toBe(1);
        expect(rig.memory(A)?.lastWriteAt).toBe(T);
        await rig.advance(TICK_INTERVAL_MS);
        expect(reads()).toBe(2);
      });

      it("an apply sends that read before the config is saved", async () => {
        const rig = await bootFresh();
        await rig.rt.apply(raw(), APPLY);
        expect(rig.stores.calls[0]).toBe("config.save");
        expect(rig.stores.sendsAtCall[0]).toBe(1);
        expect(rig.z2m.attempts()[0]).toEqual({
          kind: "read",
          deviceId: A,
          payload: TRVZB_BINDING.encodeRefresh(),
        });
      });
    });

    describe("With two new valves that have sent no message", () => {
      it("the transport received one read for each", async () => {
        const rig = await boot({ devices: [trvzb(A), trvzb(B)], house: { living: [A, B] } });
        await rig.rt.preview(raw(), APPLY);
        expect(rig.z2m.sent().map((s) => [s.kind, s.deviceId])).toEqual([
          ["read", A],
          ["read", B],
        ]);
      });
    });

    const readsOf = (rig: Rig): number => sends(rig, A).filter((s) => s.kind === "read").length;

    describe("With the same call repeated 30 s later", () => {
      it("no second read is sent, and the plan still lists the valve pending", async () => {
        const rig = await boot();
        await rig.rt.preview(raw(), APPLY);
        await rig.advance(30 * 1000);
        const plan = await rig.rt.preview(raw(), APPLY);
        expect(plan.pending.map((p) => p.reason)).toEqual(["valve_not_observed"]);
        expect(readsOf(rig)).toBe(1);
      });
    });

    describe("With the same call repeated 61 s after the first", () => {
      it("a second read is sent", async () => {
        const rig = await boot();
        await rig.rt.preview(raw(), APPLY);
        await rig.advance(61 * 1000);
        await rig.rt.preview(raw(), APPLY);
        expect(readsOf(rig)).toBe(2);
      });
    });

    describe("With the same call repeated every 61 s", () => {
      it("the seventh call within the hour sends no read", async () => {
        const rig = await boot();
        for (let i = 0; i < 7; i += 1) {
          if (i > 0) await rig.advance(61 * 1000);
          await rig.rt.preview(raw(), APPLY);
        }
        expect(readsOf(rig)).toBe(6);
      });

      it("a call made 61 min after the first sends one again", async () => {
        const rig = await boot();
        for (let i = 0; i < 7; i += 1) {
          if (i > 0) await rig.advance(61 * 1000);
          await rig.rt.preview(raw(), APPLY);
        }
        await rig.advance(61 * MINUTE - 6 * 61 * 1000);
        await rig.rt.preview(raw(), APPLY);
        expect(readsOf(rig)).toBe(7);
      });
    });

    describe("With a change whose valves all have a record", () => {
      it("no direct ask is sent", async () => {
        const rig = await boot({
          devices: [trvzb(A), trvzb(B)],
          house: { living: [A, B] },
          seed: { ledger: [record(A), record(B)] },
        });
        rig.say(A, "a-1");
        rig.say(B, "b-1");
        const before = rig.z2m.attempts().length;
        const plan = await rig.rt.apply(raw(), APPLY);
        expect(plan.joining).toEqual([]);
        expect(plan.pending).toEqual([]);
        expect(rig.stores.sendsAtCall.at(-1)).toBe(before);
        const again = rig.z2m.attempts().length;
        await rig.rt.apply(raw({ temperature: 21 }), APPLY);
        expect(rig.stores.sendsAtCall.at(-1)).toBe(again);
      });
    });

    describe("With the valve having answered and the call repeated", () => {
      it("the plan lists it joining", async () => {
        const rig = await boot();
        await rig.rt.preview(raw(), APPLY);
        rig.say(A, "a-1");
        const plan = await rig.rt.preview(raw(), APPLY);
        expect(plan.joining.map((c) => c.valveId)).toEqual([A]);
        expect(plan.pending).toEqual([]);
      });
    });

    describe("With a transport read that rejects during that ask", () => {
      it("the caller still gets the plan", async () => {
        const rig = await boot();
        rig.z2m.failNext(1);
        const plan = await rig.rt.preview(raw(), APPLY);
        expect(plan.pending.map((p) => p.valveId)).toEqual([A]);
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
        // The apply overwrites; the tick after it saves the membership as an ordinary save.
        expect(rig.stores.overwrite).toEqual([true, false]);
        expect(rig.rt.snapshot().configState).toBe("ok");
      });
    });

    describe("With overwriteUnreadable over an unreadable config and a recorded valve in no room", () => {
      it("the next tick releases it", async () => {
        const rig = await boot({
          devices: [trvzb(A), trvzb(B)],
          house: { living: [A] },
          seed: { config: "unreadable", ledger: [record(A), record(B, "external")] },
        });
        rig.say(A, "a-1");
        rig.say(B, "b-1");
        const plan = await rig.rt.apply(raw(), { ...APPLY, overwriteUnreadable: true });
        expect(plan.writes.map((w) => w.valveId)).toContain(B);
        expect(rig.rt.snapshot().memberships).toEqual({ [A]: "managed", [B]: "releasing" });
        const file = readJson(path.join(rig.dataDir, "config.json")) as {
          data: { releasing: Record<string, unknown> };
        };
        expect(Object.keys(file.data.releasing)).toEqual([B]);
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
        rig.stores.fail.config = 1;
        expect(codeOf(await rejectionOf(rig.rt.apply(raw(), APPLY)))).toBe("io_failed");
      });

      it("one tick still ran before it did, and the listeners received its snapshot", async () => {
        const rig = await boot();
        rig.say(A, "a-1");
        await rig.advance(5000);
        rig.stores.fail.config = 1;
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
        const rig = await bootFresh({ ha: null });
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
        const rig = await bootFresh();
        rig.say(A, "a-1");
        const { readdirSync } = await import("node:fs");
        const files = readdirSync(rig.dataDir);
        const config = readFileSync(path.join(rig.dataDir, "config.json"), "utf8");
        const before = rig.rt.snapshot();
        const heard = rig.snapshots.length;
        await rig.rt.preview(raw(), APPLY);
        expect(rig.stores.calls).toEqual([]);
        expect(readdirSync(rig.dataDir)).toEqual(files);
        expect(readFileSync(path.join(rig.dataDir, "config.json"), "utf8")).toBe(config);
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
        const rig = await bootFresh();
        rig.say(A, "a-1");
        await rig.rt.preview(raw(), APPLY);
        await rig.advance(30 * 1000);
        await rig.rt.apply(raw(), APPLY);
        expect(rig.stores.sendsAtCall[0]).toBe(1);
      });
    });

    describe("With a new valve that has sent no message", () => {
      it("returns a plan listing it pending with valve_not_observed, and one read is sent", async () => {
        const rig = await boot();
        const plan = await rig.rt.preview(raw(), APPLY);
        expect(plan.pending.map((p) => [p.valveId, p.reason])).toEqual([[A, "valve_not_observed"]]);
        expect(rig.z2m.sent().map((s) => [s.kind, s.deviceId])).toEqual([["read", A]]);
      });
    });
    describe("With a valve pending with valve_not_observed", () => {
      it("the valve is asked to report", async () => {
        // B waits in a room the change does not touch; the change only edits the schedule.
        const rig = await boot({
          devices: [trvzb(A), trvzb(B)],
          house: { living: [A, B] },
          seed: { config: raw(), ledger: [record(A)] },
        });
        await rig.advance(DIRECT_ASK_SPACING_MS);
        const before = sends(rig, B).filter((s) => s.kind === "read").length;
        const plan = await rig.rt.preview(raw({ temperature: 21 }), APPLY);
        expect(plan.pending.map((p) => [p.valveId, p.reason])).toEqual([[B, "valve_not_observed"]]);
        expect(sends(rig, B).filter((s) => s.kind === "read")).toHaveLength(before + 1);
      });
    });

    describe("With a pending valve whose direct ask its limit refuses", () => {
      it("the refusal is logged below warn level", async () => {
        const rig = await boot();
        await rig.rt.preview(raw(), APPLY);
        await rig.rt.preview(raw(), APPLY);
        expect(rig.logged.filter((line) => line.level !== "info")).toEqual([]);
        expect(rig.logged).toContainEqual({
          level: "info",
          message: "a direct ask was not sent",
          data: { valveId: A, error: expect.stringContaining("ask_limited") as unknown },
        });
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

    describe("Always", () => {
      it("returns a version 3 document", async () => {
        const rig = await boot({ seed: managedSeed([A]) });
        expect(rig.rt.exportConfig().config.version).toBe(3);
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
        expect(Object.keys(rig.marks(A)).sort()).toEqual(TRVZB_GROUPS);
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
          expect(Object.keys(rig.marks(id)).sort()).toEqual(TRVZB_GROUPS);
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

    describe("With a direct ask 1 s before the tick that would refresh the same valve", () => {
      const silent: Seed = {
        config: raw({ rooms: [{ valves: [A] }], hold: true }),
        ledger: [record(A)],
      };
      const reads = (rig: Rig): number => sends(rig, A).filter((s) => s.kind === "read").length;

      async function askedBeforeTick(): Promise<Rig> {
        const rig = await boot({ seed: silent });
        await rig.advance(119 * 1000);
        await rig.rt.refreshValve(A);
        return rig;
      }

      it("the tick sends no refresh to that valve before SPACING_MS has passed", async () => {
        const rig = await askedBeforeTick();
        const before = reads(rig);
        await rig.advance(1000);
        expect(rig.clock.nowMs()).toBe(T + 120 * 1000);
        expect(reads(rig)).toBe(before);
      });

      it("a refresh follows at the next tick, and not before the tick at 150 s", async () => {
        const rig = await askedBeforeTick();
        await rig.advance(1000);
        const before = reads(rig);
        await rig.advance(TICK_INTERVAL_MS - 1000);
        expect(reads(rig)).toBe(before);
        await rig.advance(1000);
        expect(reads(rig)).toBe(before + 1);
      });

      it("a tick that runs while the ask's read is still awaited sends nothing to that valve", async () => {
        const rig = await boot({ seed: silent });
        await rig.advance(119 * 1000);
        const release = rig.z2m.holdSends(A);
        const before = rig.z2m.attempts().length;
        const asking = rig.rt.refreshValve(A);
        await vi.waitFor(() => {
          expect(rig.z2m.attempts().length).toBe(before + 1);
        });
        rig.clock.advance(1000);
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        expect(rig.z2m.attempts().length).toBe(before + 1);
        release();
        await asking;
        await rig.rt.settled();
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
    // Without a schedule nothing is released, so a recorded valve in no room stays an orphan.
    const orphan: Seed = { config: raw({ rooms: [], schedules: false }), ledger: [record(A)] };

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

    describe("For a managed valve that Home Assistant and Zigbee2MQTT no longer have", () => {
      // A and B were in living; A's device is gone from Home Assistant and from Zigbee2MQTT.
      const strandedRig = (): Promise<Rig> =>
        boot({ seed: managedSeed([A, B]), devices: [trvzb(B)], house: { living: [B] } });

      it("the snapshot lists it as stranded, still managed", async () => {
        const rig = await strandedRig();
        expect(rig.rt.snapshot().memberships[A]).toBe("managed");
        expect(rig.rt.snapshot().stranded).toEqual([A]);
      });

      it("forgetValve drops its record and it leaves the room", async () => {
        const rig = await strandedRig();
        await rig.rt.forgetValve(A);
        await rig.rt.settled();
        expect(rig.stores.calls.slice(0, 2)).toEqual(["ledger.save", "copy.write"]);
        const snapshot = rig.rt.snapshot();
        expect(snapshot.memberships[A]).toBeUndefined();
        expect(snapshot.stranded).toEqual([]);
        expect(snapshot.rooms.find((room) => room.roomId === "living")?.valveIds).toEqual([B]);
      });

      it("forgetValve of the listed valve beside it is refused with valve_managed", async () => {
        const rig = await strandedRig();
        expect(codeOf(await rejectionOf(rig.rt.forgetValve(B)))).toBe("valve_managed");
      });
    });

    describe("With a recorded notInHa valve and the broker down at start", () => {
      it("the valve is not in stranded; Forget not offered", async () => {
        const rig = await boot({ seed: managedSeed([A, B]), house: { living: [B] }, start: false });
        rig.z2m.setHasDeviceList(false);
        rig.z2m.setFault("mqtt_unavailable");
        rig.z2m.setLink(false);
        await rig.rt.start();
        await rig.rt.settled();
        expect(rig.rt.snapshot().stranded).toEqual([]);
        expect(codeOf(await rejectionOf(rig.rt.forgetValve(A)))).toBe("valve_managed");
      });
    });

    describe("With a recorded notInHa valve before bridge/devices arrived", () => {
      it("the valve is not in stranded", async () => {
        const rig = await boot({ seed: managedSeed([A, B]), house: { living: [B] }, start: false });
        rig.z2m.setHasDeviceList(false);
        await rig.rt.start();
        await rig.rt.settled();
        expect(rig.rt.snapshot().stranded).toEqual([]);
      });
    });

    describe("After bridge/devices arrives without the valve", () => {
      it("the valve is in stranded", async () => {
        const rig = await boot({ seed: managedSeed([A, B]), house: { living: [B] }, start: false });
        rig.z2m.setHasDeviceList(false);
        await rig.rt.start();
        await rig.rt.settled();
        rig.z2m.setDevices([trvzb(B)]);
        await rig.advance(EVENT_DEBOUNCE_MS);
        expect(rig.rt.snapshot().stranded).toEqual([A]);
      });
    });

    describe("With a recorded notInHa valve its transport lists but Heatmaster cannot follow", () => {
      it("the valve is not in stranded and forgetValve is refused with valve_managed", async () => {
        const unfollowable = { ...trvzb(A), name: "living/valve+1" };
        const rig = await boot({
          seed: managedSeed([A, B]),
          devices: [unfollowable, trvzb(B)],
          house: { living: [B] },
        });
        expect(rig.rt.snapshot().stranded).toEqual([]);
        expect(codeOf(await rejectionOf(rig.rt.forgetValve(A)))).toBe("valve_managed");
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
        // No schedule: A stays an orphan, and B is releasing, so the ticks write to it.
        const rig = await boot({
          devices: [trvzb(A), trvzb(B)],
          seed: {
            config: raw({ rooms: [], schedules: false }),
            releasing: { [B]: T - MINUTE },
            ledger: [record(A), record(B, "external")],
          },
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

  describe("acceptOriginals", () => {
    /** B is in the room with A and has reported without its sensor source. */
    async function unreadable(): Promise<Rig> {
      const rig = await boot({
        devices: [trvzb(A), trvzb(B)],
        house: { living: [A, B] },
        seed: { config: raw(), ledger: [record(A)] },
      });
      rig.say(B, "b-1", {
        system_mode: "auto",
        occupied_heating_setpoint: 17,
        frost_protection_temperature: 7,
        open_window: "OFF",
        last_seen: "b-1",
      });
      await rig.advance(EVENT_DEBOUNCE_MS);
      return rig;
    }

    describe("For a valve pending with originals_unreadable", () => {
      it("its record is saved with null originals and it is managed at the next tick", async () => {
        const rig = await unreadable();
        expect(rig.rt.snapshot().pending).toEqual([
          {
            valveId: B,
            roomId: "living",
            reason: "originals_unreadable",
            unreadable: ["sensor_source"],
          },
        ]);
        await rig.rt.acceptOriginals(B);
        const ledger = readJson(path.join(rig.dataDir, "ledger.json")) as {
          data: { records: Record<string, { originals: Record<string, unknown> }> };
        };
        expect(ledger.data.records[B]?.originals).toEqual({
          sensor_source: null,
          frost_protection: 7,
          system_mode: "auto",
          setpoint: 17,
          open_window: "off",
        });
        expect(rig.stores.calls.slice(-2)).toEqual(["ledger.save", "copy.write"]);
        expect(rig.rt.snapshot().memberships[B]).toBe("managed");
        expect(rig.rt.snapshot().pending).toEqual([]);
      });
    });

    describe("For any other valve", () => {
      it("rejects with valve_not_pending", async () => {
        const rig = await unreadable();
        for (const valveId of [A, C]) {
          const error = await rejectionOf(rig.rt.acceptOriginals(valveId));
          expect(error).toBeInstanceOf(ChangeRefused);
          expect(codeOf(error)).toBe("valve_not_pending");
        }
        expect(rig.stores.calls).not.toContain("ledger.save");
      });
    });
  });

  describe("dismissUpgrade", () => {
    describe("With an upgrade report", () => {
      it("the report is gone from the snapshot and from the file, and the revision is unchanged", async () => {
        const rig = await boot({ seed: { configFile: readFileSync(V2_FIXTURE, "utf8") } });
        expect(rig.rt.snapshot().upgrade).toBeDefined();
        const revision = rig.rt.snapshot().revision;
        await rig.rt.dismissUpgrade();
        expect(rig.rt.snapshot().upgrade).toBeUndefined();
        expect(rig.snapshots.at(-1)?.upgrade).toBeUndefined();
        const file = readJson(path.join(rig.dataDir, "config.json")) as {
          data: Record<string, unknown>;
        };
        expect(Object.hasOwn(file.data, "upgrade")).toBe(false);
        expect(file.data.revision).toBe(revision);
        expect(rig.rt.snapshot().revision).toBe(revision);
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

    // A ledger record: not a fresh install, so no config is saved at the start.
    const noConfig: Seed = { ledger: [record(A)] };

    describe("With no config and on true", () => {
      it("resolves and nothing is saved", async () => {
        const rig = await boot({ seed: noConfig });
        await expect(rig.rt.setHold(true)).resolves.toBeUndefined();
        expect(rig.stores.calls).toEqual([]);
      });
    });

    describe("With no config and on false", () => {
      it("rejects with HeatmasterError config_missing", async () => {
        const rig = await boot({ seed: noConfig });
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

    describe("With membership {office: [v1], hall: [v2]} and entries for office and attic", () => {
      async function office(): Promise<Rig> {
        const house: House = { office: [A], hall: [B] };
        return boot({
          devices: [trvzb(A), trvzb(B)],
          house,
          seed: {
            config: raw({ rooms: [{ id: "office" }, { id: "attic" }] }),
            membership: house,
            ledger: [record(A), record(B)],
          },
        });
      }

      it("rooms lists office and hall as managed, each with its area's name", async () => {
        const rig = await office();
        expect(
          rig.rt.snapshot().rooms.map((room) => [room.roomId, room.name, room.managed]),
        ).toEqual([
          ["hall", "Area hall", true],
          ["office", "Area office", true],
        ]);
      });

      it("unusedEntries lists attic", async () => {
        const rig = await office();
        expect(rig.rt.snapshot().unusedEntries).toEqual(["attic"]);
      });
    });

    describe("With a config that has no schedule", () => {
      it("rooms are listed with managed false", async () => {
        const rig = await boot({
          seed: { config: raw({ schedules: false }), ledger: [record(A)] },
        });
        expect(rig.rt.snapshot().rooms.map((room) => [room.roomId, room.managed])).toEqual([
          ["living", false],
        ]);
      });
    });

    describe("With a valve whose device has no area", () => {
      it("unassigned lists it with reason no_area", async () => {
        const house = haSnapshot({ living: [A] });
        const snapshot: HaSnapshot = {
          ...house,
          valveAreas: new Map([...house.valveAreas, [B, null]]),
        };
        const rig = await boot({ devices: [trvzb(A), trvzb(B)], seed: managedSeed([A]), snapshot });
        expect(rig.rt.snapshot().unassigned).toEqual([
          expect.objectContaining({ valveId: B, reason: "no_area" }),
        ]);
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
          frost_protection: 7,
          system_mode: "auto",
          setpoint: 17,
          open_window: "off",
          day_mon: ["00:00/16", "07:00/20", "07:00/20", "07:00/20", "07:00/20", "07:00/20"],
        });
      });
    });

    describe("With a managed valve, a recorded valve in no room and a releasing valve", () => {
      it("the valve in no room is released at once, so unassigned lists none of the three", async () => {
        const rig = await boot({
          devices: [trvzb(A), trvzb(B), trvzb(C)],
          seed: {
            config: raw({ rooms: [{ valves: [A] }] }),
            releasing: { [C]: T - MINUTE },
            ledger: [record(A), record(B), record(C)],
          },
        });
        expect(rig.rt.snapshot().memberships[B]).toBe("releasing");
        expect(rig.rt.snapshot().unassigned.map((u) => u.valveId)).toEqual([]);
      });
    });

    describe("With an orphan valve and a releasing valve, under a config with no schedule", () => {
      it("unassigned lists the orphan and not the releasing valve", async () => {
        const rig = await boot({
          devices: [trvzb(B), trvzb(C)],
          seed: {
            config: raw({ rooms: [], schedules: false }),
            releasing: { [C]: T - MINUTE },
            ledger: [record(B), record(C)],
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
        "house",
        "rooms",
        "unusedEntries",
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

  describe("pacing.json", () => {
    const requests = (rig: Rig): number => sends(rig, A).length;
    const stampOf = (rig: Rig): number | undefined => {
      const file = readJson(path.join(rig.dataDir, "pacing.json")) as {
        valves: Record<string, { bucketFullAt: number }>;
      };
      return file.valves[A]?.bucketFullAt;
    };

    describe("On start with stamps saved by a previous run", () => {
      it("a valve whose bucket was empty is asked to report once, free, and gets nothing else until its token refills", async () => {
        const rig = await boot({
          seed: { ...managedSeed([A]), pacing: { [A]: T + BUCKET * REFILL_MS } },
        });
        await rig.advance(REFILL_MS - 2 * MINUTE);
        expect(sends(rig, A).map((s) => s.kind)).toEqual(["read"]);
        await rig.advance(3 * MINUTE);
        expect(requests(rig)).toBe(2);
      });
      it("the free ask is saved in pacing.json as freeAskAt, so a restart within 30 min makes none", async () => {
        const rig = await boot({
          seed: { ...managedSeed([A]), pacing: { [A]: T + BUCKET * REFILL_MS } },
        });
        const file = readJson(path.join(rig.dataDir, "pacing.json")) as {
          valves: Record<string, { freeAskAt?: number }>;
        };
        expect(file.valves[A]?.freeAskAt).toBe(T);
        const again = await boot({ after: rig });
        await again.advance(10 * MINUTE);
        expect(requests(again)).toBe(0);
      });
      it("with a free ask saved 10 min before the start, the valve's free ask waits until 30 min after that one", async () => {
        const rig = await boot({
          seed: { ...managedSeed([A]), pacing: { [A]: T + BUCKET * REFILL_MS } },
          start: false,
        });
        const file = path.join(rig.dataDir, "pacing.json");
        writeFileSync(
          file,
          JSON.stringify({
            version: 1,
            valves: { [A]: { bucketFullAt: T + BUCKET * REFILL_MS, freeAskAt: T - 10 * MINUTE } },
          }),
        );
        await rig.rt.start();
        await rig.rt.settled();
        await rig.advance(REFILL_MS - 10 * MINUTE - TICK_INTERVAL_MS);
        expect(requests(rig)).toBe(0);
        await rig.advance(2 * TICK_INTERVAL_MS);
        expect(sends(rig, A).map((s) => s.kind)).toEqual(["read"]);
      });
    });

    describe("With an unreadable config and a free ask saved 5 min before the start", () => {
      it("the free ask stays in pacing.json, so a restart once the config is fixed makes none before 30 min", async () => {
        const rig = await boot({ seed: { config: "unreadable" }, start: false });
        writeFileSync(
          path.join(rig.dataDir, "pacing.json"),
          JSON.stringify({
            version: 1,
            valves: { [A]: { bucketFullAt: T + BUCKET * REFILL_MS, freeAskAt: T - 5 * MINUTE } },
          }),
        );
        await rig.rt.start();
        await rig.rt.settled();
        await rig.advance(TICK_INTERVAL_MS);
        const file = readJson(path.join(rig.dataDir, "pacing.json")) as {
          valves: Record<string, { freeAskAt?: number }>;
        };
        expect(file.valves[A]?.freeAskAt).toBe(T - 5 * MINUTE);
      });
    });

    describe("Restart loop (start, ask until empty, stop, start again, repeat)", () => {
      it("total requests to one valve over 24 h of simulated time <= BUCKET + 24 h / REFILL_MS, plus one free ask per REFILL_MS", async () => {
        let rig = await boot({ seed: managedSeed([A]) });
        await rig.advance(14 * MINUTE);
        for (let run = 1; run < (24 * HOUR) / (15 * MINUTE); run++) {
          rig = await boot({ after: rig });
          await rig.advance(14 * MINUTE);
        }
        const total = rigs.reduce((sum, each) => sum + requests(each), 0);
        expect(total).toBeLessThanOrEqual(BUCKET + (2 * 24 * HOUR) / REFILL_MS);
        // Not vacuous: the valve did use its budget.
        expect(total).toBeGreaterThanOrEqual(BUCKET);
      }, 120_000);
    });

    describe("On a tick that charged a valve", () => {
      it("pacing.json is saved once, with the time the bucket is full again", async () => {
        const rig = await boot({ seed: managedSeed([A]) });
        // The start tick asked the valve to report: one token of a full bucket.
        expect(rig.stores.pacingSaves).toHaveLength(1);
        expect(stampOf(rig)).toBe(T + REFILL_MS);
        // The second ask waits for its 2 min backoff, then is the next charge.
        await rig.advance(2 * MINUTE);
        expect(requests(rig)).toBe(2);
        expect(rig.stores.pacingSaves).toHaveLength(2);
      });
    });

    describe("On a tick that charged nothing", () => {
      it("pacing.json is not written", async () => {
        const rig = await boot({ seed: managedSeed([A]) });
        const saved = rig.stores.pacingSaves.length;
        const before = readFileSync(path.join(rig.dataDir, "pacing.json"), "utf8");
        await rig.advance(TICK_INTERVAL_MS);
        await rig.advance(TICK_INTERVAL_MS);
        expect(requests(rig)).toBe(1);
        expect(rig.stores.pacingSaves).toHaveLength(saved);
        expect(readFileSync(path.join(rig.dataDir, "pacing.json"), "utf8")).toBe(before);
      });
    });

    describe("On start with an unreadable pacing.json", () => {
      it("a pacing_unreadable problem is shown", async () => {
        const rig = await boot({ seed: { ...managedSeed([A]), pacing: "unreadable" } });
        expect(problemKinds(rig.rt.snapshot())).toContain("pacing_unreadable");
      });
      it("no valve write goes out before REFILL_MS", async () => {
        const rig = await boot({ seed: { ...managedSeed([A]), pacing: "unreadable" } });
        await rig.advance(REFILL_MS - MINUTE);
        expect(rig.z2m.attempts()).toEqual([]);
        await rig.advance(2 * MINUTE);
        expect(requests(rig)).toBe(1);
      });
      it("the file is rewritten with the empty buckets", async () => {
        const rig = await boot({ seed: { ...managedSeed([A]), pacing: "unreadable" } });
        expect(stampOf(rig)).toBe(T + BUCKET * REFILL_MS);
      });
    });

    describe("On a failing pacing save", () => {
      it("a store_write_failed problem for pacing is shown and control continues", async () => {
        const rig = await boot({ seed: managedSeed([A]), start: false });
        rig.stores.fail.pacing = 1;
        await rig.rt.start();
        await rig.rt.settled();
        const problem = rig.rt.snapshot().problems.find((p) => p.kind === "store_write_failed");
        expect(problem?.data).toEqual({ store: "pacing" });
        expect(requests(rig)).toBe(1);
        await rig.advance(2 * MINUTE);
        expect(requests(rig)).toBe(2);
      });
      it("the next tick saves again and the problem goes", async () => {
        const rig = await boot({ seed: managedSeed([A]), start: false });
        rig.stores.fail.pacing = 1;
        await rig.rt.start();
        await rig.rt.settled();
        await rig.advance(TICK_INTERVAL_MS);
        expect(problemKinds(rig.rt.snapshot())).not.toContain("store_write_failed");
        expect(stampOf(rig)).toBe(T + REFILL_MS);
      });
    });

    describe("With an entry for a valve that is no longer configured", () => {
      it("it is dropped on the next save", async () => {
        const rig = await boot({
          seed: { ...managedSeed([A]), pacing: { "z2m:0xgone": T + 3 * REFILL_MS } },
        });
        const file = readJson(path.join(rig.dataDir, "pacing.json")) as {
          valves: Record<string, unknown>;
        };
        expect(Object.keys(file.valves)).toEqual([A]);
      });
    });

    describe("With an unreadable file and no device listed before the first tick", () => {
      it("the file is rewritten with an empty bucket for every configured valve, so a restart stays empty", async () => {
        const rig = await boot({
          devices: [],
          seed: { ...managedSeed([A]), pacing: "unreadable" },
        });
        expect(stampOf(rig)).toBe(T + BUCKET * REFILL_MS);
        const again = await boot({ after: rig, devices: [trvzb(A)] });
        await again.advance(REFILL_MS - MINUTE);
        expect(again.z2m.attempts()).toEqual([]);
        await again.advance(2 * MINUTE);
        expect(requests(again)).toBe(1);
      });
    });

    describe("With a file holding an entry of a valve that is gone and no bucket changing", () => {
      it("the entry counts as a change: the file is rewritten without it", async () => {
        const rig = await boot({
          seed: {
            ...managedSeed([A]),
            pacing: { [A]: T + BUCKET * REFILL_MS, "z2m:0xgone": T + 3 * REFILL_MS },
          },
        });
        expect(rig.stores.pacingSaves).toHaveLength(1);
        const file = readJson(path.join(rig.dataDir, "pacing.json")) as {
          valves: Record<string, unknown>;
        };
        expect(Object.keys(file.valves)).toEqual([A]);
      });
    });

    describe("With a stamp later than a whole empty bucket away", () => {
      it("it counts as an empty bucket: after the free ask at the start, the first token comes after REFILL_MS", async () => {
        const rig = await boot({
          seed: { ...managedSeed([A]), pacing: { [A]: T + 100 * REFILL_MS } },
        });
        await rig.advance(REFILL_MS - MINUTE);
        expect(requests(rig)).toBe(1);
        await rig.advance(2 * MINUTE);
        expect(requests(rig)).toBe(2);
      });
    });
  });

  describe("a hold forced after a failed setHold(true)", () => {
    describe("With a release finishing while the hold is forced and the user has applied hold_writes false", () => {
      it("the config tick saves keeps hold_writes false in config.json", async () => {
        const rig = await boot({ seed: managedSeed([A]) });
        await hear(rig, [A]);
        rig.stores.fail.config = 1;
        await rejectionOf(rig.rt.setHold(true));
        // The device leaves its area: after the settle the tick releases the valve.
        rig.ha?.setSnapshot(haSnapshot({}));
        rig.ha?.emit({ kind: "registries_changed" });
        await rig.advance(HA_SETTLE_MS);
        expect(rig.rt.snapshot().memberships[A]).toBe("releasing");
        await rig.rt.apply(raw(), APPLY);
        for (let minute = 0; minute < 20; minute++) {
          rig.say(A, `a-r${String(minute)}`);
          await rig.advance(MINUTE);
        }
        expect(
          (readJson(path.join(rig.dataDir, "ledger.json")).data as { records: object }).records,
        ).toEqual({});
        expect(readJson(path.join(rig.dataDir, "config.json"))).toMatchObject({
          data: { config: { settings: { hold_writes: false } } },
        });
        expect(rig.rt.snapshot().held).toBe(true);
      });
    });
  });

  describe("a release ordered in the future while config saves fail", () => {
    it("release_stalled is measured from the first clamp, not from the latest tick", async () => {
      const rig = await boot({
        start: false,
        seed: {
          config: raw({ rooms: [] }),
          releasing: { [A]: T + HOUR },
          ledger: [record(A, "external")],
        },
      });
      rig.stores.fail.config = 100_000;
      await rig.rt.start();
      await rig.rt.settled();
      await rig.advance(6 * HOUR - MINUTE);
      expect(problemKinds(rig.rt.snapshot())).not.toContain("release_stalled");
      await rig.advance(2 * MINUTE);
      expect(problemKinds(rig.rt.snapshot())).toContain("release_stalled");
    });
  });

  describe("label sync", () => {
    const MAIN = "heatmaster_schedule_main";
    const NIGHT = "heatmaster_schedule_night";
    const SENSOR_LABEL = "heatmaster_temp_sensor";
    const LIVING_T = "sensor.living_t";
    const NIGHT_SCHEDULE = {
      id: "night",
      name: "Night",
      week: [{ days: "all", temperature: { "00:00": 17 } }],
    } as const;

    /** `document` with schedule night after main, and these entries when given; same house. */
    function withNight(document: RawConfig, rooms?: RawConfig["rooms"]): RawConfig {
      const next: RawConfig = {
        ...document,
        schedules: [...(document.schedules ?? []), NIGHT_SCHEDULE],
        ...(rooms === undefined ? {} : { rooms }),
      };
      const house = housesOf.get(document);
      if (house !== undefined) housesOf.set(next, house);
      return next;
    }

    function labelsOf(ha: StubHaLink | undefined): HaSnapshot {
      const snapshot = ha?.snapshot();
      if (snapshot === undefined) throw new Error("no snapshot");
      return snapshot;
    }

    function areaLabels(rig: Rig, areaId: string): readonly string[] | undefined {
      return labelsOf(rig.ha).areas.get(areaId)?.labels;
    }

    function entityLabels(rig: Rig, entityId: string): readonly string[] | undefined {
      return labelsOf(rig.ha).entities.get(entityId)?.labels;
    }

    /** The user changes an area's labels in Home Assistant, which announces it. */
    function relabelArea(rig: Rig, areaId: string, labels: readonly string[]): void {
      const snapshot = labelsOf(rig.ha);
      const area = snapshot.areas.get(areaId);
      if (area === undefined) throw new Error(`no area ${areaId}`);
      rig.ha?.setSnapshot({
        ...snapshot,
        areas: new Map([...snapshot.areas, [areaId, { ...area, labels }]]),
      });
      rig.ha?.emit({ kind: "registries_changed" });
    }

    /** The user changes an entity's labels in Home Assistant, which announces it. */
    function relabelEntity(rig: Rig, entityId: string, labels: readonly string[]): void {
      const snapshot = labelsOf(rig.ha);
      const entity = snapshot.entities.get(entityId);
      if (entity === undefined) throw new Error(`no entity ${entityId}`);
      rig.ha?.setSnapshot({
        ...snapshot,
        entities: new Map([...snapshot.entities, [entityId, { ...entity, labels }]]),
      });
      rig.ha?.emit({ kind: "registries_changed" });
    }

    /** Home Assistant's snapshot of `house` with these labels named and these entities. */
    function labelled(
      house: House,
      options: Readonly<{
        labels?: Readonly<Record<string, string>>;
        areaLabels?: Readonly<Record<string, readonly string[]>>;
        entities?: Readonly<
          Record<string, Readonly<{ areaId: string; labels: readonly string[] }>>
        >;
      }>,
    ): HaSnapshot {
      const base = haSnapshot(house);
      const areas = new Map(base.areas);
      for (const [areaId, labels] of Object.entries(options.areaLabels ?? {})) {
        areas.set(areaId, { name: areaName(areaId), labels });
      }
      return {
        ...base,
        areas,
        labels: new Map(Object.entries(options.labels ?? {})),
        entities: new Map(Object.entries(options.entities ?? {})),
      };
    }

    /** Booted, its start's mirror written and its echo settled. */
    async function mirrored(options: Parameters<typeof boot>[0]): Promise<Rig> {
      const rig = await boot(options);
      await vi.waitFor(() => {
        expect(rig.ha?.labelBatches().length).toBeGreaterThan(0);
      });
      await rig.advance(HA_SETTLE_MS);
      return rig;
    }

    const stored = (rig: Rig): Record<string, unknown> =>
      readJson(path.join(rig.dataDir, "config.json")).data as Record<string, unknown>;

    const OK_SENSOR = { exists: true, isTemperature: true, onValve: false };

    describe("At start, once Home Assistant has loaded", () => {
      async function movedWhileDown(): Promise<Rig> {
        const config = withNight(raw());
        return mirrored({
          seed: { config, ledger: [record(A)] },
          snapshot: labelled(DEFAULT_HOUSE, {
            labels: { [MAIN]: "Heatmaster: Main", [NIGHT]: "Heatmaster: Night" },
            areaLabels: { living: [NIGHT] },
          }),
        });
      }

      it("a schedule label moved while Heatmaster was down is moved back", async () => {
        const rig = await movedWhileDown();
        expect(areaLabels(rig, "living")).toEqual([MAIN]);
      });

      it("no revision is made", async () => {
        const rig = await movedWhileDown();
        await rig.advance(HA_SETTLE_MS);
        expect(rig.rt.snapshot().revision).toBe(1);
        expect(rig.rt.snapshot().haChanges).toEqual([]);
      });
    });

    describe("On a reconnect", () => {
      it("labels are set to match the config", async () => {
        const rig = await mirrored({ seed: { config: withNight(raw()), ledger: [record(A)] } });
        expect(areaLabels(rig, "living")).toEqual([MAIN]);
        rig.ha?.setReady(true);
        rig.ha?.setState("down");
        rig.ha?.emit({ kind: "link_down" });
        relabelArea(rig, "living", [NIGHT]);
        await rig.advance(HA_SETTLE_MS);
        rig.ha?.setState("up");
        rig.ha?.emit({ kind: "link_up" });
        await vi.waitFor(() => {
          expect(areaLabels(rig, "living")).toEqual([MAIN]);
        });
        await rig.advance(HA_SETTLE_MS);
        expect(rig.rt.snapshot().revision).toBe(1);
      });
    });

    describe("After an apply", () => {
      it("labels follow the new config", async () => {
        const rig = await mirrored({ seed: managedSeed([A]) });
        expect(labelsOf(rig.ha).labels.has(NIGHT)).toBe(false);
        await rig.rt.apply(withNight(raw(), { living: { schedule: "night" } }), APPLY);
        await vi.waitFor(() => {
          expect(areaLabels(rig, "living")).toEqual([NIGHT]);
        });
        expect(labelsOf(rig.ha).labels.get(NIGHT)).toBe("Heatmaster: Night");
      });
    });

    describe("When the user moves a schedule label onto a room while running", () => {
      async function moved(): Promise<Rig> {
        const rig = await mirrored({ seed: { config: withNight(raw()), ledger: [record(A)] } });
        relabelArea(rig, "living", [MAIN, NIGHT]);
        return rig;
      }

      it("after HA_SETTLE_MS one revision is saved and haChanges names it", async () => {
        const rig = await moved();
        await rig.advance(HA_SETTLE_MS - 1);
        expect(rig.rt.snapshot().revision).toBe(1);
        await rig.advance(1);
        expect(rig.rt.snapshot().revision).toBe(2);
        expect(rig.rt.snapshot().haChanges).toEqual([
          {
            revision: 2,
            at: rig.clock.nowMs(),
            items: [
              { kind: "schedule", areaId: "living", entityId: undefined, scheduleId: "night" },
            ],
          },
        ]);
        expect(rig.rt.exportConfig().config).toMatchObject({
          rooms: { living: { schedule: "night" } },
        });
      });

      it("the room's other schedule label is removed", async () => {
        const rig = await moved();
        await rig.advance(HA_SETTLE_MS);
        await vi.waitFor(() => {
          expect(areaLabels(rig, "living")).toEqual([NIGHT]);
        });
        await rig.advance(HA_SETTLE_MS);
        expect(rig.rt.snapshot().revision).toBe(2);
      });

      it("the room's valves get the new schedule with no apply", async () => {
        const rig = await moved();
        await inSync(rig, [A]);
        const before = sends(rig, A).length;
        await rig.advance(HA_SETTLE_MS);
        rig.say(A, "a-9");
        await rig.advance(2 * MINUTE);
        expect(
          sends(rig, A)
            .slice(before)
            .filter((s) => s.kind === "publish")
            .map((s) => (s.payload as Record<string, unknown>).weekly_schedule_monday),
        ).toContain("00:00/17 00:00/17 00:00/17 00:00/17 00:00/17 00:00/17");
      });
    });

    describe("With a label moved as a remove and an add 1 s apart", () => {
      it("exactly one revision is saved", async () => {
        const rig = await mirrored({ seed: { config: withNight(raw()), ledger: [record(A)] } });
        relabelArea(rig, "living", []);
        await rig.advance(1000);
        relabelArea(rig, "living", [NIGHT]);
        await rig.advance(3 * HA_SETTLE_MS);
        expect(rig.rt.snapshot().revision).toBe(2);
        expect(rig.rt.snapshot().haChanges.map((change) => change.revision)).toEqual([2]);
        expect(rig.rt.exportConfig().config).toMatchObject({
          rooms: { living: { schedule: "night" } },
        });
      });
    });

    describe("When the user adds heatmaster_temp_sensor to an entity in a room", () => {
      it("one revision adds it to that room with weight 1", async () => {
        const ha = createStubHaLink();
        ha.setSensorInfo(LIVING_T, OK_SENSOR);
        const rig = await mirrored({
          ha,
          seed: managedSeed([A]),
          snapshot: labelled(DEFAULT_HOUSE, {
            entities: { [LIVING_T]: { areaId: "living", labels: [] } },
          }),
        });
        relabelEntity(rig, LIVING_T, [SENSOR_LABEL]);
        await rig.advance(3 * HA_SETTLE_MS);
        expect(rig.rt.snapshot().revision).toBe(2);
        expect(rig.rt.exportConfig().config).toMatchObject({
          rooms: { living: { sensors: [{ ref: `ha:${LIVING_T}`, weight: 1 }] } },
        });
      });
    });

    describe("When the user removes it", () => {
      it("one revision removes it from every room", async () => {
        const ha = createStubHaLink();
        ha.setSensorInfo(LIVING_T, OK_SENSOR);
        const rig = await mirrored({
          ha,
          seed: managedSeed([A], [`ha:${LIVING_T}`]),
          snapshot: labelled(DEFAULT_HOUSE, {
            entities: { [LIVING_T]: { areaId: "living", labels: [] } },
          }),
        });
        expect(entityLabels(rig, LIVING_T)).toEqual([SENSOR_LABEL]);
        relabelEntity(rig, LIVING_T, []);
        await rig.advance(3 * HA_SETTLE_MS);
        expect(rig.rt.snapshot().revision).toBe(2);
        expect(JSON.stringify(rig.rt.exportConfig().config)).not.toContain(LIVING_T);
        expect(entityLabels(rig, LIVING_T)).toEqual([]);
      });
    });

    describe("When the user adds it to an entity in an area that is no room", () => {
      async function unused(): Promise<Rig> {
        const ha = createStubHaLink();
        ha.setSensorInfo("sensor.garage_t", OK_SENSOR);
        const rig = await mirrored({
          ha,
          seed: managedSeed([A]),
          snapshot: labelled(
            { living: [A], garage: [] },
            { entities: { "sensor.garage_t": { areaId: "garage", labels: [] } } },
          ),
        });
        relabelEntity(rig, "sensor.garage_t", [SENSOR_LABEL]);
        await rig.advance(3 * HA_SETTLE_MS);
        return rig;
      }

      it("no revision; sensor_label_unused is shown; the label stays", async () => {
        const rig = await unused();
        expect(rig.rt.snapshot().revision).toBe(1);
        expect(rig.rt.snapshot().problems).toContainEqual({
          kind: "sensor_label_unused",
          subject: { kind: "sensor", id: "ha:sensor.garage_t" },
          severity: "warning",
          data: { reason: "area_not_room" },
        });
        expect(entityLabels(rig, "sensor.garage_t")).toEqual([SENSOR_LABEL]);
      });
    });

    describe("When a new area becomes a room", () => {
      it("it gets the default's label", async () => {
        const rig = await mirrored({
          devices: [trvzb(A), trvzb(B)],
          seed: managedSeed([A]),
          house: { living: [A], office: [] },
        });
        expect(areaLabels(rig, "office")).toEqual([]);
        const snapshot = labelsOf(rig.ha);
        rig.ha?.setSnapshot({
          ...snapshot,
          valveAreas: new Map([...snapshot.valveAreas, [B, "office"]]),
        });
        rig.ha?.emit({ kind: "registries_changed" });
        await rig.advance(HA_SETTLE_MS);
        await vi.waitFor(() => {
          expect(areaLabels(rig, "office")).toEqual([MAIN]);
        });
        expect(rig.rt.snapshot().revision).toBe(1);
      });
    });

    describe("When Zigbee2MQTT lists a valve that makes an area a room", () => {
      it("it gets the default's label with no settle", async () => {
        const rig = await mirrored({ seed: managedSeed([A]), house: { living: [A], office: [B] } });
        expect(areaLabels(rig, "office")).toEqual([]);
        rig.z2m.setDevices([trvzb(A), trvzb(B)]);
        await rig.advance(EVENT_DEBOUNCE_MS);
        await vi.waitFor(() => {
          expect(areaLabels(rig, "office")).toEqual([MAIN]);
        });
      });
    });

    describe("When the user removes the default's label from a room on the default", () => {
      it("it is put back and no revision is saved", async () => {
        const rig = await mirrored({ seed: managedSeed([A]) });
        relabelArea(rig, "living", []);
        await rig.advance(HA_SETTLE_MS);
        await vi.waitFor(() => {
          expect(areaLabels(rig, "living")).toEqual([MAIN]);
        });
        await rig.advance(HA_SETTLE_MS);
        expect(rig.rt.snapshot().revision).toBe(1);
      });
    });

    describe("With a label write failing", () => {
      async function failing(fail: boolean): Promise<Rig> {
        const ha = createStubHaLink();
        if (fail) ha.failLabels(() => "unauthorized");
        const rig = await boot({ ha, seed: managedSeed([A]) });
        await vi.waitFor(() => {
          expect(ha.labelBatches().length).toBeGreaterThan(0);
        });
        await rig.advance(HA_SETTLE_MS);
        return rig;
      }

      it("ha_label_failed is shown", async () => {
        const rig = await failing(true);
        expect(rig.rt.snapshot().problems).toContainEqual({
          kind: "ha_label_failed",
          subject: { kind: "area", id: "living" },
          severity: "warning",
          data: { op: "labelArea", error: "unauthorized" },
        });
      });

      it("the valves are written in the same tick as without the failure", async () => {
        const firstScheduleAt = async (rig: Rig): Promise<number | undefined> => {
          await hear(rig, [A]);
          for (let i = 0; i < 180; i += 1) {
            if (
              sends(rig, A).some((s) =>
                Object.hasOwn(s.payload as object, "weekly_schedule_monday"),
              )
            ) {
              return rig.clock.nowMs();
            }
            await rig.advance(1000);
          }
          return undefined;
        };
        const failed = await firstScheduleAt(await failing(true));
        const clean = await firstScheduleAt(await failing(false));
        expect(failed).toBeDefined();
        expect(failed).toBe(clean);
      });

      it("while the link is down, ha_label_failed is not shown", async () => {
        const rig = await failing(true);
        expect(problemKinds(rig.rt.snapshot())).toContain("ha_label_failed");
        // The link is down; its link_down event (which also resets the label sync) is still due.
        rig.ha?.setState("down");
        expect(rig.rt.snapshot().house).toBe("frozen");
        expect(problemKinds(rig.rt.snapshot())).not.toContain("ha_label_failed");
      });

      it("after the link_down event and the link coming back with labels writable, none is shown", async () => {
        const rig = await failing(true);
        rig.ha?.setState("down");
        rig.ha?.emit({ kind: "link_down" });
        rig.ha?.failLabels(undefined);
        rig.ha?.setState("up");
        rig.ha?.emit({ kind: "link_up" });
        await rig.advance(EVENT_DEBOUNCE_MS);
        await vi.waitFor(() => {
          expect(rig.ha?.labelBatches().length).toBeGreaterThan(1);
        });
        expect(problemKinds(rig.rt.snapshot())).not.toContain("ha_label_failed");
      });

      it("a label problem that names an area carries the area's name in areaNames", async () => {
        const ha = createStubHaLink();
        ha.setAreaName("living", "Living room");
        ha.failLabels(() => "unauthorized");
        const rig = await boot({ ha, seed: managedSeed([A]) });
        await vi.waitFor(() => {
          expect(problemKinds(rig.rt.snapshot())).toContain("ha_label_failed");
        });
        expect(rig.rt.snapshot().areaNames).toEqual({ living: "Living room" });
      });
    });

    describe("With a label write that never answers", () => {
      async function stalled(): Promise<Rig> {
        const rig = await boot({ seed: managedSeed([A]), start: false });
        rig.ha?.stallLabels(rig.clock);
        await rig.rt.start();
        await rig.rt.settled();
        await vi.waitFor(() => {
          expect(rig.ha?.labelBatches().length).toBe(1);
        });
        return rig;
      }

      it("ticks keep running", async () => {
        const rig = await stalled();
        rig.say(A, "a-1");
        await rig.advance(EVENT_DEBOUNCE_MS);
        expect(rig.rt.snapshot().tickedAt).toBe(T + EVENT_DEBOUNCE_MS);
        await rig.advance(TICK_INTERVAL_MS);
        expect(rig.rt.snapshot().tickedAt).toBe(T + EVENT_DEBOUNCE_MS + TICK_INTERVAL_MS);
      });

      it("ha_label_failed with error timeout is shown after HA_LABEL_TIMEOUT_MS", async () => {
        const rig = await stalled();
        await rig.advance(HA_LABEL_TIMEOUT_MS - 1);
        expect(problemKinds(rig.rt.snapshot())).not.toContain("ha_label_failed");
        await rig.advance(1);
        await vi.waitFor(() => {
          expect(rig.rt.snapshot().problems).toContainEqual({
            kind: "ha_label_failed",
            subject: { kind: "area", id: "living" },
            severity: "warning",
            data: { op: "labelArea", error: "timeout" },
          });
        });
      });
    });

    describe("After a Home Assistant stall that timed out an apply's label writes", () => {
      const ECO_LABEL = "heatmaster_schedule_eco";
      const ECO = { id: "eco", name: "Eco", week: [{ days: "all", temperature: { "00:00": 15 } }] };
      /** Schedules main (the default), night and eco, with these entries; living holds A. */
      const three = (rooms: RawConfig["rooms"] = { living: {} }): RawConfig => {
        const next = withNight(raw(), rooms);
        const document: RawConfig = { ...next, schedules: [...(next.schedules ?? []), ECO] };
        housesOf.set(document, DEFAULT_HOUSE);
        return document;
      };

      async function stalledApply(): Promise<Rig> {
        const rig = await mirrored({ seed: { config: three(), ledger: [record(A)] } });
        rig.ha?.stallLabels(rig.clock);
        await rig.rt.apply(three({ living: { schedule: "night" } }), APPLY);
        await vi.waitFor(() => {
          expect(rig.ha?.labelBatches()).toHaveLength(2);
        });
        await rig.advance(HA_LABEL_TIMEOUT_MS);
        rig.ha?.stallLabels(undefined);
        expect(areaLabels(rig, "living")).toEqual([MAIN]);
        // Home Assistant has recovered; the user moves living onto eco.
        relabelArea(rig, "living", [ECO_LABEL]);
        await rig.advance(HA_SETTLE_MS);
        return rig;
      }

      it("a later user edit to the same target becomes a revision", async () => {
        const rig = await stalledApply();
        expect(rig.rt.snapshot().revision).toBe(3);
        expect(rig.rt.exportConfig().config).toMatchObject({
          rooms: { living: { schedule: "eco" } },
        });
      });

      it("the edit is not reverted", async () => {
        const rig = await stalledApply();
        await rig.advance(3 * HA_SETTLE_MS);
        expect(areaLabels(rig, "living")).toEqual([ECO_LABEL]);
        expect(rig.rt.snapshot().revision).toBe(3);
      });
    });

    describe("With a label pull that throws", () => {
      it("the settle still accepts the membership, and the failure is logged", async () => {
        const stub = createStubHaLink();
        let armed = false;
        const ha: StubHaLink = {
          ...stub,
          sensorInfo: (entityId, addresses) => {
            if (!armed) return stub.sensorInfo(entityId, addresses);
            armed = false;
            throw new Error("sensor info failed");
          },
        };
        const rig = await mirrored({
          ha,
          seed: managedSeed([A]),
          snapshot: labelled(DEFAULT_HOUSE, {
            entities: { [LIVING_T]: { areaId: "living", labels: [] } },
          }),
        });
        const snapshot = labelsOf(rig.ha);
        rig.ha?.setSnapshot({
          ...snapshot,
          areas: new Map([...snapshot.areas, ["office", { name: areaName("office"), labels: [] }]]),
          valveAreas: new Map([[A, "office"]]),
          entities: new Map([[LIVING_T, { areaId: "living", labels: [SENSOR_LABEL] }]]),
        });
        rig.ha?.emit({ kind: "registries_changed" });
        // The pull is the first to look the labelled sensor up.
        armed = true;
        await rig.advance(HA_SETTLE_MS);
        expect(armed).toBe(false);
        expect(rig.rt.snapshot().rooms.map((room) => room.roomId)).toEqual(["office"]);
        expect(rig.logs).toContain("error a label pull failed");
      });
    });

    describe("With writes held", () => {
      it("labels are still mirrored", async () => {
        const rig = await mirrored({ seed: { config: raw({ hold: true }), ledger: [record(A)] } });
        expect(rig.rt.snapshot().held).toBe(true);
        expect(areaLabels(rig, "living")).toEqual([MAIN]);
      });
    });

    describe("With the config unreadable", () => {
      it("no mirror and no pull run", async () => {
        const rig = await boot({ seed: { config: "unreadable" } });
        // Live, so the settle does run and reaches the pull's guard.
        expect(rig.rt.snapshot().house).toBe("live");
        relabelArea(rig, "living", [MAIN]);
        await rig.advance(2 * HA_SETTLE_MS);
        expect(rig.ha?.labelBatches()).toEqual([]);
        expect(readFileSync(path.join(rig.dataDir, "config.json"), "utf8")).toBe("{ not json");
      });
    });

    describe("With a label edit while the user changes the hold before the settle", () => {
      it("the revision holds the label edit and the user's hold: an HA label edit never changes hold_writes", async () => {
        const rig = await mirrored({ seed: { config: withNight(raw()), ledger: [record(A)] } });
        relabelArea(rig, "living", [NIGHT]);
        await rig.rt.setHold(true);
        await rig.advance(HA_SETTLE_MS);
        expect(rig.rt.snapshot().revision).toBe(3);
        expect(stored(rig)).toMatchObject({
          revision: 3,
          config: { settings: { hold_writes: true }, rooms: { living: { schedule: "night" } } },
        });
        expect(rig.rt.snapshot().held).toBe(true);
      });
    });
  });

  describe("sensor import", () => {
    const LEGACY = "room_temperature_sensor";
    const SENSOR_LABEL = "heatmaster_temp_sensor";
    const LIVING_T = "sensor.living_t";
    const OK_SENSOR = { exists: true, isTemperature: true, onValve: false };

    /** The version 2 fixture, its room in area living with valve A and no sensors. */
    function v2WithoutSensors(): string {
      const file = JSON.parse(readFileSync(V2_FIXTURE, "utf8")) as {
        data: { releasing: object; config: { rooms: Record<string, unknown>[] } };
      };
      file.data.releasing = {};
      const room = file.data.config.rooms[0] ?? {};
      room.area_id = "living";
      room.valves = [{ id: A }];
      delete room.sensors;
      return JSON.stringify(file);
    }

    function legacyHouse(): HaSnapshot {
      return {
        ...haSnapshot(DEFAULT_HOUSE),
        entities: new Map([[LIVING_T, { areaId: "living", labels: [LEGACY] }]]),
      };
    }

    const storedData = (rig: Rig): Record<string, unknown> =>
      readJson(path.join(rig.dataDir, "config.json")).data as Record<string, unknown>;

    describe("On the first start after a v2 conversion, with a room without sensors whose temperature entity carries room_temperature_sensor", () => {
      async function converted(): Promise<Rig> {
        const ha = createStubHaLink();
        ha.setSensorInfo(LIVING_T, OK_SENSOR);
        return boot({
          ha,
          seed: { configFile: v2WithoutSensors(), ledger: [record(A)] },
          snapshot: legacyHouse(),
        });
      }

      it("the room gets that sensor, it is marked imported and one revision is saved", async () => {
        const rig = await converted();
        expect(storedData(rig)).toMatchObject({
          revision: 4,
          sensor_import: ["living"],
          config: { rooms: { living: { sensors: [{ ref: `ha:${LIVING_T}`, weight: 1 }] } } },
        });
        expect(rig.rt.snapshot().haChanges).toEqual([
          {
            revision: 4,
            at: T,
            items: [
              {
                kind: "sensors_imported",
                areaId: "living",
                entityId: undefined,
                scheduleId: undefined,
              },
            ],
          },
        ]);
      });

      it("the entity gets heatmaster_temp_sensor", async () => {
        const rig = await converted();
        await vi.waitFor(() => {
          expect(rig.ha?.snapshot()?.entities.get(LIVING_T)?.labels).toEqual([
            LEGACY,
            SENSOR_LABEL,
          ]);
        });
      });

      it("legacy_label_present names the room", async () => {
        const rig = await converted();
        expect(rig.rt.snapshot().problems).toContainEqual({
          kind: "legacy_label_present",
          subject: { kind: "room", id: "living" },
          severity: "warning",
          data: { entities: LIVING_T },
        });
      });
    });

    describe("After a v2 conversion, with a second room whose valve Zigbee2MQTT lists only after Home Assistant has loaded", () => {
      const OFFICE_T = "sensor.office_t";

      async function lateListing(): Promise<Rig> {
        const ha = createStubHaLink();
        ha.setSensorInfo(LIVING_T, OK_SENSOR);
        ha.setSensorInfo(OFFICE_T, OK_SENSOR);
        const snapshot = haSnapshot({ living: [A], office: [B] });
        const rig = await boot({
          ha,
          devices: [trvzb(A)],
          seed: { configFile: v2WithoutSensors(), ledger: [record(A)] },
          snapshot: {
            ...snapshot,
            entities: new Map([
              [LIVING_T, { areaId: "living", labels: [LEGACY] }],
              [OFFICE_T, { areaId: "office", labels: [LEGACY] }],
            ]),
          },
        });
        rig.z2m.setDevices([trvzb(A), trvzb(B)]);
        await rig.advance(EVENT_DEBOUNCE_MS);
        await rig.rt.settled();
        return rig;
      }

      it("the second room gets its legacy sensor when it joins, and both rooms are marked imported", async () => {
        const rig = await lateListing();
        await vi.waitFor(() => {
          expect(storedData(rig)).toMatchObject({
            sensor_import: ["living", "office"],
            config: {
              rooms: {
                living: { sensors: [{ ref: `ha:${LIVING_T}`, weight: 1 }] },
                office: { sensors: [{ ref: `ha:${OFFICE_T}`, weight: 1 }] },
              },
            },
          });
        });
      });

      it("each room's import is one HA change of its own", async () => {
        const rig = await lateListing();
        await vi.waitFor(() => {
          expect(
            rig.rt.snapshot().haChanges.map((change) => change.items.map((item) => item.areaId)),
          ).toEqual([["living"], ["office"]]);
        });
      });
    });

    describe("With a running install's stored sensor_import done", () => {
      it("every area of its saved membership counts as imported, and nothing is imported", async () => {
        const ha = createStubHaLink();
        ha.setSensorInfo(LIVING_T, OK_SENSOR);
        const stored: StoredConfig = {
          ...FRESH_STORED,
          config: validateConfig(raw()),
          revision: 1,
          membership: membershipOf(DEFAULT_HOUSE),
        };
        const data = { ...storedToRaw(stored), sensor_import: "done" };
        const rig = await boot({
          ha,
          seed: {
            configFile: JSON.stringify({ version: 3, data }),
            ledger: [record(A)],
          },
          snapshot: legacyHouse(),
        });
        expect(JSON.stringify(rig.rt.exportConfig().config)).not.toContain(LIVING_T);
        expect(rig.rt.snapshot().haChanges).toEqual([]);
      });
    });

    describe("On a later start", () => {
      it("nothing is imported", async () => {
        const ha = createStubHaLink();
        ha.setSensorInfo(LIVING_T, OK_SENSOR);
        const rig = await boot({ ha, seed: managedSeed([A]), snapshot: legacyHouse() });
        expect(storedData(rig)).toMatchObject({ revision: 1, sensor_import: ["living"] });
        expect(JSON.stringify(rig.rt.exportConfig().config)).not.toContain(LIVING_T);
      });
    });

    describe("On a fresh install with Home Assistant loaded before Zigbee2MQTT lists the room's valve", () => {
      it("the import waits for the room, then runs", async () => {
        const ha = createStubHaLink();
        ha.setSensorInfo(LIVING_T, OK_SENSOR);
        const rig = await boot({ ha, devices: [], snapshot: legacyHouse() });
        expect(rig.rt.snapshot().house).toBe("live");
        expect(storedData(rig)).toMatchObject({ sensor_import: [] });
        rig.z2m.setDevices([trvzb(A)]);
        await rig.advance(EVENT_DEBOUNCE_MS);
        await vi.waitFor(() => {
          expect(storedData(rig)).toMatchObject({
            sensor_import: ["living"],
            config: { rooms: { living: { sensors: [{ ref: `ha:${LIVING_T}`, weight: 1 }] } } },
          });
        });
      });
    });

    describe("On a fresh install", () => {
      it("the import runs once Home Assistant has loaded", async () => {
        const ha = createStubHaLink();
        ha.setSensorInfo(LIVING_T, OK_SENSOR);
        ha.setState("connecting");
        const rig = await boot({ ha, snapshot: legacyHouse() });
        expect(storedData(rig)).toMatchObject({ sensor_import: [] });
        ha.setState("up");
        ha.emit({ kind: "link_up" });
        await vi.waitFor(() => {
          expect(storedData(rig)).toMatchObject({
            sensor_import: ["living"],
            config: { rooms: { living: { sensors: [{ ref: `ha:${LIVING_T}`, weight: 1 }] } } },
          });
        });
      });
    });
  });

  describe("roomCommand", () => {
    describe("With set_target 22 for a managed room", () => {
      async function overridden(): Promise<Rig> {
        const rig = await boot({ seed: managedSeed([A]) });
        await inSync(rig, [A]);
        await rig.rt.roomCommand("living", setTarget(22), API);
        // The room settles for THERMOSTAT_SETTLE_MS; the next tick writes the valve.
        await rig.advance(TICK_INTERVAL_MS);
        return rig;
      }

      it("state.json holds the override before the first valve publish", async () => {
        const rig = await overridden();
        const first = firstThermostatWrite(rig, A);
        expect(first).toBeGreaterThanOrEqual(0);
        expect(rig.z2m.attempts()[first]?.payload).toEqual({
          system_mode: "heat",
          occupied_heating_setpoint: 22,
        });
        const saved = rig.stores.stateSaves.find(
          (save) => save.state.rooms.get("living")?.kind === "override",
        );
        expect(saved?.sends).toBeLessThanOrEqual(first);
        expect(savedRooms(rig)).toMatchObject({ living: { kind: "override", target: 22 } });
      });

      it("the snapshot's room status shows the override", async () => {
        const rig = await overridden();
        expect(roomStatus(rig, "living")?.thermostat).toMatchObject({
          kind: "override",
          target: 22,
          origin: API,
        });
      });
    });

    describe("With an unknown room", () => {
      it("rejects with ChangeRefused room_unknown and nothing is saved", async () => {
        const rig = await boot({ seed: managedSeed([A]) });
        await inSync(rig, [A]);
        const saves = rig.stores.stateCalls.length;
        const error = await rejectionOf(rig.rt.roomCommand("attic", setTarget(22), API));
        expect(error).toBeInstanceOf(ChangeRefused);
        expect(codeOf(error)).toBe("room_unknown");
        expect(rig.stores.stateCalls.length).toBe(saves);
      });
    });

    describe("With the state unreadable", () => {
      it("rejects with ChangeRefused state_unreadable", async () => {
        const rig = await boot({ seed: { ...managedSeed([A]), state: "unreadable" } });
        await inSync(rig, [A]);
        const error = await rejectionOf(rig.rt.roomCommand("living", setTarget(22), API));
        expect(error).toBeInstanceOf(ChangeRefused);
        expect(codeOf(error)).toBe("state_unreadable");
      });
    });

    describe("With the state save failing", () => {
      it("rejects, store_write_failed for state shows, no valve is written", async () => {
        const rig = await boot({ seed: managedSeed([A]) });
        await inSync(rig, [A]);
        rig.stores.fail.state = 1;
        const error = await rejectionOf(rig.rt.roomCommand("living", setTarget(22), API));
        expect(codeOf(error)).toBe("io_failed");
        expect(rig.rt.snapshot().problems).toContainEqual(
          expect.objectContaining({ kind: "store_write_failed", data: { store: "state" } }),
        );
        await rig.advance(2 * TICK_INTERVAL_MS);
        expect(firstThermostatWrite(rig, A)).toBe(-1);
        expect(roomStatus(rig, "living")?.thermostat).toEqual({ kind: "schedule" });
      });
    });
  });

  describe("roomChoice", () => {
    describe("With override_end manual", () => {
      async function chosen(): Promise<Rig> {
        const rig = await boot({ seed: managedSeed([A]) });
        await rig.rt.roomChoice("living", { kind: "override_end", rule: "manual" });
        return rig;
      }

      it("config.json's revision rises and the entry holds manual", async () => {
        const rig = await chosen();
        const saved = storedFromRaw(readJson(path.join(rig.dataDir, "config.json")).data);
        expect(saved.revision).toBe(2);
        expect(saved.config.rooms.get("living")?.overrideEnd).toBe("manual");
      });

      it("haChanges lists an override_end item", async () => {
        const rig = await chosen();
        expect(rig.rt.snapshot().haChanges.flatMap((change) => change.items)).toContainEqual(
          expect.objectContaining({ kind: "override_end", areaId: "living", rule: "manual" }),
        );
      });
    });

    describe("With the schedule the room already has", () => {
      it("no save", async () => {
        const rig = await boot({ seed: managedSeed([A]) });
        await rig.rt.roomChoice("living", { kind: "schedule", scheduleId: "main" });
        expect(rig.stores.calls).toEqual([]);
        expect(rig.rt.snapshot().revision).toBe(1);
      });
    });
  });

  describe("resetThermostats", () => {
    describe("With the state unreadable", () => {
      it("every room follows its schedule and the problem clears", async () => {
        const rig = await boot({ seed: { ...managedSeed([A]), state: "unreadable" } });
        await inSync(rig, [A]);
        expect(problemKinds(rig.rt.snapshot())).toContain("state_unreadable");
        await rig.rt.resetThermostats();
        expect(problemKinds(rig.rt.snapshot())).not.toContain("state_unreadable");
        expect(roomStatus(rig, "living")?.thermostat).toEqual({ kind: "schedule" });
      });
    });

    describe("With the state unreadable and a valve in heat 23", () => {
      it("the valve is written auto in the next tick and nothing is adopted", async () => {
        const rig = await boot({ seed: { ...managedSeed([A]), state: "unreadable" } });
        await inSyncWith(rig, [A], heatMessage);
        expect(firstThermostatWrite(rig, A)).toBe(-1);
        await rig.rt.resetThermostats();
        const first = firstThermostatWrite(rig, A);
        expect(rig.z2m.attempts()[first]?.payload).toEqual({ system_mode: "auto" });
        expect(savedRooms(rig)).toEqual({});
        expect(roomStatus(rig, "living")?.thermostat).toEqual({ kind: "schedule" });
      });
    });

    describe("With the state readable", () => {
      it("rejects with HeatmasterError state_readable", async () => {
        const rig = await boot({ seed: managedSeed([A]) });
        const error = await rejectionOf(rig.rt.resetThermostats());
        expect(error).toBeInstanceOf(HeatmasterError);
        expect(codeOf(error)).toBe("state_readable");
      });
    });
  });

  describe("tick", () => {
    /** Valves A and B in the living room, in sync, the room on its schedule. */
    async function twoValves(): Promise<Rig> {
      const rig = await boot({ devices: [trvzb(A), trvzb(B)], seed: managedSeed([A, B]) });
      await inSync(rig, [A, B]);
      return rig;
    }

    /** Someone sets valve A to heat 23 °C; the debounced tick runs. */
    async function knob(rig: Rig): Promise<void> {
      rig.say(A, "a-knob", heatMessage("a-knob"));
      await rig.advance(1000);
    }

    describe("With an adopted knob change", () => {
      it("state.json holds the override before the other valve is written", async () => {
        const rig = await twoValves();
        await knob(rig);
        await rig.advance(TICK_INTERVAL_MS);
        const first = firstThermostatWrite(rig, B);
        expect(rig.z2m.attempts()[first]?.payload).toEqual({
          system_mode: "heat",
          occupied_heating_setpoint: 23,
        });
        const saved = rig.stores.stateSaves.find(
          (save) => save.state.rooms.get("living")?.kind === "override",
        );
        expect(saved?.sends).toBeLessThanOrEqual(first);
        expect(savedRooms(rig)).toMatchObject({
          living: { kind: "override", target: 23, origin: { source: "valve", valve_id: A } },
        });
      });
    });

    describe("With the state save failing after an adopted knob change", () => {
      it("no valve is written and the runtime's thermostats are unchanged", async () => {
        const rig = await twoValves();
        const before = stateText(rig);
        rig.stores.fail.state = 99;
        await knob(rig);
        await rig.advance(2 * TICK_INTERVAL_MS);
        expect(rig.stores.stateCalls).toContain("state.fail");
        expect(firstThermostatWrite(rig, B)).toBe(-1);
        expect(stateText(rig)).toBe(before);
        expect(tickWorlds.at(-1)?.thermostats?.rooms.get("living")).toBeUndefined();
        expect(roomStatus(rig, "living")?.thermostat).toEqual({ kind: "schedule" });
      });

      it("the next tick adopts the same change again and saves it before any write", async () => {
        const rig = await twoValves();
        rig.stores.fail.state = 1;
        await knob(rig);
        expect(rig.stores.stateCalls.at(-1)).toBe("state.fail");
        await rig.advance(2 * TICK_INTERVAL_MS);
        const first = firstThermostatWrite(rig, B);
        expect(rig.z2m.attempts()[first]?.payload).toEqual({
          system_mode: "heat",
          occupied_heating_setpoint: 23,
        });
        const saved = rig.stores.stateSaves.find(
          (save) => save.state.rooms.get("living")?.kind === "override",
        );
        expect(saved?.sends).toBeLessThanOrEqual(first);
        expect(savedRooms(rig)).toMatchObject({
          living: { kind: "override", target: 23, origin: { source: "valve", valve_id: A } },
        });
      });
    });

    /** A in sync and B waiting to join the living room until it is first heard. */
    async function bWaiting(): Promise<Rig> {
      const rig = await boot({
        devices: [trvzb(A), trvzb(B)],
        house: { living: [A, B] },
        seed: { config: raw(), ledger: [record(A)] },
      });
      await inSync(rig, [A]);
      expect(rig.rt.snapshot().memberships[B]).toBe("pending");
      return rig;
    }

    describe("With the ledger save failing in the tick that adopts a knob change", () => {
      /** B is heard and A turned in one tick, whose ledger save (B's join) fails. */
      async function failedJoin(): Promise<Rig & { before: string; sent: number }> {
        const rig = await bWaiting();
        const before = stateText(rig);
        const sent = rig.z2m.attempts().length;
        rig.stores.fail.ledger = 1;
        rig.say(B, "b-1");
        await knob(rig);
        expect(rig.stores.calls).toContain("ledger.fail");
        return Object.assign(rig, { before, sent });
      }

      it("state.json is unchanged and no valve is written", async () => {
        const rig = await failedJoin();
        expect(stateText(rig)).toBe(rig.before);
        expect(rig.z2m.attempts().slice(rig.sent)).toEqual([]);
      });

      it("the next tick adopts the same change again", async () => {
        const rig = await failedJoin();
        await rig.advance(TICK_INTERVAL_MS);
        expect(rig.rt.snapshot().memberships[B]).toBe("managed");
        expect(savedRooms(rig)).toMatchObject({
          living: { kind: "override", target: 23, origin: { source: "valve", valve_id: A } },
        });
      });
    });

    describe("With a valve joining and the state save failing in that tick", () => {
      it("the next tick still takes the valve over and adopts nothing", async () => {
        const rig = await bWaiting();
        rig.stores.fail.state = 1;
        rig.say(B, "b-1", heatMessage("b-1"));
        await rig.advance(1000);
        expect(rig.stores.calls).toContain("ledger.save");
        expect(rig.stores.stateCalls.at(-1)).toBe("state.fail");
        expect(rig.rt.snapshot().memberships[B]).toBe("managed");
        rig.say(B, "b-2", heatMessage("b-2"));
        await rig.advance(2 * TICK_INTERVAL_MS);
        expect(savedRooms(rig)).toEqual({});
        expect(savedValves(rig)[B]).toMatchObject({ room: "living" });
        expect(roomStatus(rig, "living")?.thermostat).toEqual({ kind: "schedule" });
        const first = firstThermostatWrite(rig, B);
        expect(rig.z2m.attempts()[first]?.payload).toEqual({ system_mode: "auto" });
      });
    });

    describe("With the state save failing while another valve has a push and a schedule write due", () => {
      /**
       * Valve A (living, with a room sensor) and valve B (office) while writes are held: B in sync
       * and its room overridden at 22, A heard twice, its days not written, the sensor fresh. The
       * release's tick pushes to A, writes A's days, and its state save (B's write) fails.
       */
      async function released(): Promise<
        Rig & { memoryBefore: Record<string, unknown> | undefined; roomsBefore: unknown }
      > {
        const ha = createStubHaLink();
        const rig = await boot({
          ha,
          devices: [trvzb(A), trvzb(B)],
          seed: {
            config: raw({
              rooms: [
                { valves: [A], sensors: [ROOM_SENSOR] },
                { id: "office", valves: [B] },
              ],
            }),
            ledger: [record(A, "external"), record(B)],
          },
        });
        await inSync(rig, [B]);
        rig.say(B, "b-4", trvzbMessage("b-4", "local_temperature", DAYS_ECHO));
        await rig.rt.setHold(true);
        rig.say(A, "a-1", trvzbMessage("a-1", "external"));
        await rig.advance(1000);
        rig.say(A, "a-2", trvzbMessage("a-2", "external"));
        await rig.advance(1000);
        await rig.rt.roomCommand("office", setTarget(22), API);
        await rig.advance(2 * THERMOSTAT_SETTLE_MS);
        haSensor(ha, "sensor.living", 19.6, rig.clock.nowMs());
        const memoryBefore = rig.memory(B);
        const roomsBefore = rig.rt.snapshot().rooms;
        rig.stores.fail.state = 99;
        await rig.rt.setHold(false);
        return Object.assign(rig, { memoryBefore, roomsBefore });
      }
      const pushes = (rig: Rig): number =>
        sends(rig, A).filter((s) =>
          Object.hasOwn(s.payload as object, "external_temperature_input"),
        ).length;
      const dayWrites = (rig: Rig, valveId: string): number =>
        sends(rig, valveId).filter((s) =>
          Object.hasOwn(s.payload as object, "weekly_schedule_monday"),
        ).length;

      it("the push and the schedule write go out; only mode and setpoint writes are dropped", async () => {
        const rig = await released();
        expect(pushes(rig)).toBe(1);
        expect(dayWrites(rig, A)).toBe(1);
        expect(firstThermostatWrite(rig, B)).toBe(-1);
        expect(rig.logged.find((line) => line.message === "an effect failed")?.data).toMatchObject({
          unsent: [],
          held: [B],
        });
      });

      it("no resync_requested for the held valves, no schedule rewrite, and no setting_not_holding after three ticks", async () => {
        const rig = await released();
        rig.say(A, "a-3", trvzbMessage("a-3", "external", DAYS_ECHO));
        await rig.advance(3 * TICK_INTERVAL_MS);
        expect(rig.marks(B)).toEqual({});
        expect(dayWrites(rig, A)).toBe(1);
        expect(dayWrites(rig, B)).toBe(1);
        expect(firstThermostatWrite(rig, B)).toBe(-1);
        expect(problemKinds(rig.rt.snapshot())).not.toContain("setting_not_holding");
      });

      it("each held valve's tokens are as before the tick", async () => {
        const rig = await released();
        const tokensOf = (memory: Record<string, unknown> | undefined): unknown[] => [
          memory?.tokens,
          memory?.tokensAt,
          memory?.lastWriteAt,
        ];
        expect(tokensOf(rig.memory(B))).toEqual(tokensOf(rig.memoryBefore));
        expect((rig.memory(B)?.writes24h as Record<string, number>).thermostat).toBe(0);
      });

      it("the pushed valve is not pushed again in the next tick", async () => {
        const rig = await released();
        await rig.advance(TICK_INTERVAL_MS);
        expect(pushes(rig)).toBe(1);
      });

      it("the snapshot shows the state before the failed save", async () => {
        const rig = await released();
        expect(rig.rt.snapshot().rooms).toEqual(rig.roomsBefore);
      });
    });

    describe("With the ledger save failing in a tick that also publishes a thermostat write", () => {
      it("the publish is held: no resync_requested and the valve's thermostat tokens are as before", async () => {
        const rig = await bWaiting();
        await rig.rt.roomCommand("living", setTarget(22), API);
        // The ticks already asked for run while the room settles; B's tick is the first after it.
        await rig.advance(1000);
        await rig.advance(THERMOSTAT_SETTLE_MS - 2000);
        const before = rig.memory(A);
        rig.stores.fail.ledger = 1;
        rig.say(B, "b-1");
        await rig.advance(1000);
        expect(rig.stores.calls).toContain("ledger.fail");
        expect(firstThermostatWrite(rig, A)).toBe(-1);
        expect(rig.logged.find((line) => line.message === "an effect failed")?.data).toMatchObject({
          held: [A],
        });
        expect(rig.marks(A)).toEqual({});
        expect([rig.memory(A)?.tokens, rig.memory(A)?.tokensAt]).toEqual([
          before?.tokens,
          before?.tokensAt,
        ]);
        expect((rig.memory(A)?.writes24h as Record<string, number>).thermostat).toBe(0);
      });
    });

    describe("With a sent write's at and a since later than the clock at start (the clock went back)", () => {
      it("both are clamped to now in the first tick's world", async () => {
        const later = T + HOUR;
        const state: ThermostatState = {
          rooms: new Map([
            [
              "living",
              {
                kind: "override",
                target: 22,
                preset: undefined,
                rule: "manual",
                endsAt: undefined,
                origin: API,
                since: later,
              },
            ],
          ]),
          valves: new Map([
            [
              A,
              {
                roomId: "living",
                confirmed: { mode: "auto", setpoint: undefined, scheduled: true },
                sent: [
                  {
                    wanted: { mode: "heat", setpoint: 22, scheduled: false },
                    at: later,
                    from: { mode: "auto", setpoint: 17 },
                  },
                ],
                week: undefined,
                written: undefined,
                previous: undefined,
              },
            ],
          ]),
        };
        await boot({ seed: { ...managedSeed([A]), state } });
        const world = tickWorlds[0];
        expect(world?.now.epochMilliseconds).toBe(T);
        expect(world?.thermostats?.rooms.get("living")).toMatchObject({ since: T });
        expect(world?.thermostats?.valves.get(A)?.sent[0]?.at).toBe(T);
      });
    });
  });
});
