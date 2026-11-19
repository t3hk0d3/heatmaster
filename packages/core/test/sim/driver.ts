import {
  ChangeRefused,
  EMPTY_LEDGER,
  EMPTY_MEMORY,
  EMPTY_THERMOSTAT_STATE,
  FRESH_STORED,
  TRVZB_SPEC,
  TRV_ZBT_SPEC,
  WEEKDAYS,
  applyEvent,
  effectivePresets,
  encodeDay,
  findProfile,
  fitted,
  forgetValve,
  memberships,
  newState,
  planChange,
  resolveWeek,
  restoreValve,
  roomsOf,
  tick,
  withRecord,
} from "../../src/index.ts";
import { BUILDER_NOW, makeOriginals } from "../builders.ts";
import { createSimBridge } from "./bridge.ts";
import type { BridgeItem, SimBridge } from "./bridge.ts";
import type { DayTexts, PersonChange, SimValve, SimValveOptions, ValveModel } from "./valve.ts";
import type {
  AreaMembership,
  Binding,
  ChangeOptions,
  ChangePlan,
  Config,
  ConfigState,
  DeviceState,
  DeviceView,
  Effect,
  Event,
  Inbox,
  Ledger,
  Membership,
  Memory,
  Room,
  SensorInfo,
  SensorReading,
  StoredConfig,
  TickResult,
  ValveSpec,
  World,
} from "../../src/index.ts";

/** Simulated seconds in a step of the scenarios. */
export const STEP_MS = 30 * 1000;
export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;

/** When a scenario starts: a Monday noon in Amsterdam. */
export const SIM_START_MS = BUILDER_NOW.epochMilliseconds;

const TRANSPORT = "z2m";
const MODEL_IDS = { trvzb: "TRVZB", trv_zbt: "TRV-ZBT" } as const;

export type SimValveSetup = Readonly<
  Omit<SimValveOptions, "nowMs" | "onSpeak"> & { valveId: string }
>;

export type SimSensorSetup = Readonly<{ ref: string; value: number; alive?: boolean }>;

/**
 * `membership` is what Home Assistant says (areas and their valves); the house is live on it while
 * the `ha` link is up, and the config file's saved membership starts as it. No membership: no area
 * holds a valve.
 */
export type SimSetup = Readonly<{
  config: Config;
  membership?: AreaMembership;
  ledger: Ledger | undefined;
  releasing?: ReadonlyMap<string, number>;
  revision?: number;
  valves: readonly SimValveSetup[];
  sensors: readonly SimSensorSetup[];
  startMs?: number;
}>;

/** What is on the disk: the config file and the ledger file. */
export type ConfigFile =
  | Readonly<{ state: "ok"; stored: StoredConfig }>
  | Readonly<{ state: "empty" }>
  | Readonly<{ state: "unreadable" }>;
export type LedgerFile =
  | Readonly<{ state: "ok"; ledger: Ledger }>
  | Readonly<{ state: "lost" }>
  | Readonly<{ state: "corrupt" }>;

export type LoggedEffect = Readonly<{ at: number; effect: Effect }>;

export type ChangeResult =
  Readonly<{ ok: true; plan: ChangePlan }> | Readonly<{ ok: false; refused: ChangeRefused }>;

interface SimSensor {
  value: number;
  alive: boolean;
  seenAt: number;
  /** Home Assistant is not there: Heatmaster cannot judge the sensor and has no value for it. */
  pending: boolean;
}

export type SimDriver = Readonly<{
  bridge: SimBridge;
  valve: (valveId: string) => SimValve;
  now: () => number;
  /** The simulated time since the start, in milliseconds. */
  elapsed: () => number;
  /** Advances the clock, then runs one step in the order the runtime would. */
  step: (dtMs: number) => TickResult;
  /** Steps of `stepMs` until `elapsed()` reaches `untilElapsedMs`. */
  runTo: (untilElapsedMs: number, stepMs?: number) => void;
  world: () => World;
  /** The world the last tick read: the state that decided its effects. */
  tickWorld: () => World | undefined;
  /** Hands over what the bridge sent so far, as the runtime would have done on arrival. */
  deliver: () => void;
  lastResult: () => TickResult | undefined;
  inbox: () => Inbox;
  memory: () => Memory;
  /** Every effect executed, with its time, oldest first. */
  log: () => readonly LoggedEffect[];
  /** Every time a valve got a memory it had not had, for the budget property. */
  memoryAppearances: () => readonly Readonly<{ at: number; valveId: string }>[];
  /** Every device message handed to Heatmaster, with its time and life token, oldest first. */
  messages: () => readonly Readonly<{
    at: number;
    deviceId: string;
    lifeToken: string | undefined;
  }>[];
  /** The config, ledger and copy as the runtime holds them in memory. */
  config: () => Readonly<{ configState: ConfigState; stored: StoredConfig | undefined }>;
  /** What Home Assistant says now: the areas and their valves. */
  membership: () => AreaMembership;
  /**
   * A device moves in Home Assistant: the house is live on `next` from the next tick on (frozen on
   * the saved membership while the `ha` link is down).
   */
  setMembership: (next: AreaMembership) => void;
  /** Runs `fn` with the world each later tick reads, just before that tick. */
  beforeTick: (fn: (world: World) => void) => void;
  ledger: () => Ledger | undefined;
  disk: () => Readonly<{ config: ConfigFile; ledger: LedgerFile }>;
  copy: () => Ledger | undefined;
  // Faults and hooks.
  /** Runs `fault` at the start of the next step, after the clock moved. */
  atNextStep: (fault: () => void) => void;
  setSensor: (
    ref: string,
    change: Readonly<{ value?: number; alive?: boolean; pending?: boolean }>,
  ) => void;
  /** The application stops and starts: memory and device states are dropped, the disk is read. */
  restart: () => void;
  /** Stays armed until a step has at least n effects; runs the first n, then restarts. */
  crashAfterEffects: (n: number | undefined) => void;
  /** Runs `during` while Heatmaster is not there: what is sent meanwhile is lost; then it starts. */
  whileDown: (during: () => void) => void;
  loseConfig: (how: "lost" | "corrupt") => void;
  loseLedger: (how: "lost" | "corrupt") => void;
  /** What `importCopy` does: the recorded copy becomes the ledger. */
  importCopy: () => void;
  /** Copy files exist but none can be read: they may hide records, so a missing ledger locks. */
  corruptCopy: () => void;
  linkDown: (name: string) => void;
  linkUp: (name: string) => void;
  /** Zigbee2MQTT restarts: the link is down for the next step, then the events and the replay. */
  restartBridge: () => void;
  /** Home Assistant announces itself: the cache is sent again, with no events. */
  replayCache: () => void;
  rejoin: (valveId: string) => void;
  /** A person publishes a payload to the valve through Zigbee2MQTT. */
  personWrites: (valveId: string, payload: Readonly<Record<string, unknown>>) => void;
  batterySwap: (valveId: string) => void;
  planChange: (raw: unknown, options?: Partial<ChangeOptions>) => ChangeResult;
  restoreValve: (valveId: string) => void;
  forgetValve: (valveId: string) => void;
  /** The effects of one valve, optionally of one kind, with the time since the start. */
  effectsOf: (
    valveId: string,
    kind?: Effect["kind"],
  ) => readonly Readonly<{ at: number; effect: Effect }>[];
}>;

function modelOf(spec: ValveSpec): "trvzb" | "trv_zbt" {
  return spec.profile === "sonoff_trvzb" ? "trvzb" : "trv_zbt";
}

export function createSimDriver(setup: SimSetup): SimDriver {
  const startMs = setup.startMs ?? SIM_START_MS;
  const zone = setup.config.settings.timezone ?? BUILDER_NOW.timeZoneId;
  const bridge = createSimBridge();
  const valves = new Map<string, SimValve>();
  const specs = new Map<string, ValveSpec>();
  const bindings = new Map<string, Binding>();
  for (const v of setup.valves) {
    valves.set(v.valveId, bridge.addValve(v.valveId, { ...v, nowMs: startMs }));
    const model = v.model;
    const found = findProfile(MODEL_IDS[model], TRANSPORT);
    if (found === undefined) throw new Error(`no profile for ${model}`);
    specs.set(v.valveId, found.spec);
    bindings.set(v.valveId, found.binding);
  }
  const sensors = new Map<string, SimSensor>();
  for (const s of setup.sensors) {
    sensors.set(s.ref, { value: s.value, alive: s.alive ?? true, seenAt: startMs, pending: false });
  }

  let nowMs = startMs;
  let membership: AreaMembership = setup.membership ?? { rooms: new Map(), ignored: [] };
  const disk: { config: ConfigFile; ledger: LedgerFile } = {
    config: {
      state: "ok",
      stored: {
        ...FRESH_STORED,
        config: setup.config,
        revision: setup.revision ?? 1,
        releasing: setup.releasing ?? new Map(),
        membership,
      },
    },
    ledger: setup.ledger === undefined ? { state: "lost" } : { state: "ok", ledger: setup.ledger },
  };
  let copy: Ledger | undefined = setup.ledger;
  let copyUnreadable = false;
  let configState: ConfigState = "ok";
  let stored: StoredConfig | undefined;
  let ledger: Ledger | undefined;
  let inbox: Inbox = { states: new Map(), memory: EMPTY_MEMORY };
  const links: Record<string, boolean> = { [TRANSPORT]: true, ha: true };
  let pendingEvents: Event[] = [];
  let faults: (() => void)[] = [];
  let restartingBridge = false;
  let crashAfter: number | undefined;
  let last: TickResult | undefined;
  let lastWorld: World | undefined;
  const log: LoggedEffect[] = [];
  const appearances: { at: number; valveId: string }[] = [];
  const messages: { at: number; deviceId: string; lifeToken: string | undefined }[] = [];
  const tickHooks: ((world: World) => void)[] = [];

  /**
   * The runtime's rule for a ledger file that did not load (plan 1's load rule, with the version 3
   * "expected" rule: the config is unreadable, the saved membership holds a valve, or a valve is
   * releasing).
   */
  const loadLedger = (): Ledger | undefined => {
    if (disk.ledger.state === "ok") return disk.ledger.ledger;
    // An unreadable file always locks the store; only a missing one may become empty.
    if (disk.ledger.state === "corrupt") return undefined;
    const configFile = disk.config;
    if (configFile.state === "unreadable") return undefined;
    if (configFile.state === "ok") {
      const saved = configFile.stored.membership;
      const holdsValve = [...(saved?.rooms.values() ?? [])].some(
        (room) => room.valveIds.length > 0,
      );
      if (holdsValve || configFile.stored.releasing.size > 0) return undefined;
    }
    if (copyUnreadable || (copy?.records.size ?? 0) > 0) return undefined;
    return EMPTY_LEDGER;
  };

  const startApplication = (): void => {
    configState = disk.config.state;
    stored = disk.config.state === "ok" ? disk.config.stored : undefined;
    ledger = loadLedger();
    const states = new Map<string, DeviceState>();
    for (const id of valves.keys()) states.set(id, newState(nowMs));
    inbox = { states, memory: EMPTY_MEMORY };
    pendingEvents = [];
    bridge.discard();
  };
  startApplication();

  const nowZoned = (): Temporal.ZonedDateTime =>
    Temporal.Instant.fromEpochMilliseconds(nowMs).toZonedDateTimeISO(zone);

  const sensorReadings = (): ReadonlyMap<string, SensorReading> => {
    const readings = new Map<string, SensorReading>();
    for (const [ref, s] of sensors) {
      if (s.pending) {
        readings.set(ref, { sensorId: ref, value: undefined, seenAt: undefined, pending: true });
        continue;
      }
      const seenAt = s.alive ? nowMs : s.seenAt;
      readings.set(ref, { sensorId: ref, value: s.value, seenAt, pending: false });
    }
    return readings;
  };

  const buildWorld = (linkOverride?: Record<string, boolean>): World => {
    const devices = new Map<string, DeviceView>();
    for (const id of valves.keys()) {
      devices.set(id, {
        name: id,
        spec: specs.get(id),
        usable: true,
        state: inbox.states.get(id),
      });
    }
    // Rooms freeze on the saved membership while Home Assistant is down.
    const haUp = links.ha !== false;
    return {
      configState,
      stored,
      house: haUp
        ? { kind: "live", membership, notInHa: [] }
        : { kind: "frozen", membership: stored?.membership, reason: "link_down" },
      ledger,
      devices,
      links: { ...links, ...linkOverride },
      transportFaults: {},
      deviceLists: { z2m: new Set(devices.keys()) },
      sensors: sensorReadings(),
      unobservableSensors: new Set(),
      memory: inbox.memory,
      buckets: undefined,
      now: nowZoned(),
      thermostats: EMPTY_THERMOSTAT_STATE,
    };
  };

  /** Notes each valve whose memory the inbox did not hold: the budget counts those. */
  const noteAppearances = (before: Memory, after: Memory): void => {
    for (const id of after.valves.keys()) {
      if (!before.valves.has(id)) appearances.push({ at: nowMs, valveId: id });
    }
  };

  const apply = (event: Event): void => {
    const before = inbox.memory;
    if (event.kind === "device_message") {
      messages.push({ at: nowMs, deviceId: event.deviceId, lifeToken: event.lifeToken });
    }
    inbox = applyEvent(inbox, event, specs, nowMs);
    noteAppearances(before, inbox.memory);
  };

  const eventOf = (item: BridgeItem): Event => {
    switch (item.kind) {
      case "message": {
        const binding = bindings.get(item.deviceId);
        if (binding === undefined) throw new Error(`no binding for ${item.deviceId}`);
        const token = item.payload.last_seen;
        return {
          kind: "device_message",
          deviceId: item.deviceId,
          decoded: binding.decode(item.payload),
          lifeToken: typeof token === "string" ? token : undefined,
        };
      }
      case "rejoined":
        return { kind: "rejoined", deviceId: item.deviceId };
      case "link_up":
        links[item.transport] = true;
        return { kind: "link_up", transport: item.transport };
      case "bridge_restarted":
        return { kind: "bridge_restarted", transport: item.transport };
    }
  };

  const sent = (valveId: string, what: "refresh" | "publish"): void => {
    apply({ kind: "sent", valveId, what, at: nowMs });
  };

  const bindingOf = (valveId: string): Binding => {
    const binding = bindings.get(valveId);
    if (binding === undefined) throw new Error(`no binding for ${valveId}`);
    return binding;
  };

  const execute = (effect: Effect): void => {
    log.push({ at: nowMs, effect });
    switch (effect.kind) {
      case "saveLedger":
        disk.ledger = { state: "ok", ledger: effect.ledger };
        ledger = effect.ledger;
        return;
      case "saveConfig":
        disk.config = { state: "ok", stored: effect.stored };
        configState = "ok";
        stored = effect.stored;
        return;
      case "writeOriginalsCopy":
        copy = effect.ledger;
        copyUnreadable = false;
        return;
      case "publish":
        bridge.write(effect.valveId, bindingOf(effect.valveId).encode(effect.values), nowMs);
        sent(effect.valveId, "publish");
        return;
      case "publishSetpoint":
        bridge.write(
          effect.valveId,
          bindingOf(effect.valveId).encodeSetpoint(effect.celsius),
          nowMs,
        );
        return;
      case "pushTemperature":
        bridge.write(
          effect.valveId,
          bindingOf(effect.valveId).encodeTemperature(effect.celsius),
          nowMs,
        );
        return;
      case "refresh": {
        const payload = bindingOf(effect.valveId).encodeRefresh();
        if (payload !== undefined) bridge.get(effect.valveId, payload, nowMs);
        sent(effect.valveId, "refresh");
        return;
      }
    }
  };

  /** Events that were waiting, then what the bridge sent; a link that is down loses its messages. */
  const deliver = (): void => {
    const items = bridge
      .drain()
      .filter(
        (item) =>
          links[TRANSPORT] !== false || (item.kind !== "message" && item.kind !== "rejoined"),
      );
    const events = [...pendingEvents, ...items.map(eventOf)];
    pendingEvents = [];
    for (const event of events) apply(event);
  };

  const step = (dtMs: number): TickResult => {
    nowMs += dtMs;
    for (const s of sensors.values()) if (s.alive) s.seenAt = nowMs;
    const due = faults;
    faults = [];
    for (const fault of due) fault();
    bridge.advance(nowMs);
    deliver();

    const tickedWorld = buildWorld(restartingBridge ? { [TRANSPORT]: false } : undefined);
    for (const hook of tickHooks) hook(tickedWorld);
    const result = tick(tickedWorld);
    lastWorld = tickedWorld;
    last = result;
    noteAppearances(inbox.memory, result.memory);
    inbox = { ...inbox, memory: result.memory };

    // A crash stays armed until a step has at least that many effects.
    const limit =
      crashAfter !== undefined && result.effects.length >= crashAfter ? crashAfter : undefined;
    if (limit !== undefined) crashAfter = undefined;
    const effects = limit === undefined ? result.effects : result.effects.slice(0, limit);
    for (const effect of effects) execute(effect);
    if (limit !== undefined) {
      startApplication();
      return result;
    }
    if (restartingBridge) {
      restartingBridge = false;
      bridge.restart();
    }
    return result;
  };

  const sensorInfo = (): ReadonlyMap<string, SensorInfo> => {
    const info = new Map<string, SensorInfo>();
    for (const ref of sensors.keys()) {
      info.set(ref, { exists: true, isTemperature: true, onValve: false });
    }
    return info;
  };

  /** A crash armed by `crashAfterEffects` also cuts a change's effects: the rest is lost. */
  const executeAll = (effects: readonly Effect[]): void => {
    const limit = crashAfter !== undefined && effects.length >= crashAfter ? crashAfter : undefined;
    if (limit !== undefined) crashAfter = undefined;
    for (const effect of limit === undefined ? effects : effects.slice(0, limit)) execute(effect);
    if (limit !== undefined) startApplication();
  };

  return {
    bridge,
    valve(valveId) {
      const found = valves.get(valveId);
      if (found === undefined) throw new Error(`no simulated valve ${valveId}`);
      return found;
    },
    now: () => nowMs,
    elapsed: () => nowMs - startMs,
    step,
    runTo(untilElapsedMs, stepMs = STEP_MS) {
      while (nowMs - startMs + stepMs <= untilElapsedMs) step(stepMs);
    },
    world: () => buildWorld(),
    tickWorld: () => lastWorld,
    deliver,
    lastResult: () => last,
    inbox: () => inbox,
    memory: () => inbox.memory,
    log: () => log,
    memoryAppearances: () => appearances,
    messages: () => messages,
    config: () => ({ configState, stored }),
    membership: () => membership,
    setMembership(next) {
      membership = next;
    },
    beforeTick(fn) {
      tickHooks.push(fn);
    },
    ledger: () => ledger,
    disk: () => ({ config: disk.config, ledger: disk.ledger }),
    copy: () => copy,
    atNextStep(fault) {
      faults.push(fault);
    },
    setSensor(ref, change) {
      const sensor = sensors.get(ref);
      if (sensor === undefined) throw new Error(`no simulated sensor ${ref}`);
      if (change.value !== undefined) sensor.value = change.value;
      if (change.alive !== undefined) sensor.alive = change.alive;
      if (change.pending !== undefined) sensor.pending = change.pending;
    },
    restart: startApplication,
    crashAfterEffects(n) {
      crashAfter = n;
    },
    whileDown(during) {
      during();
      startApplication();
    },
    loseConfig(how) {
      disk.config = { state: how === "lost" ? "empty" : "unreadable" };
    },
    loseLedger(how) {
      disk.ledger = { state: how };
    },
    corruptCopy() {
      copyUnreadable = true;
    },
    importCopy() {
      if (copy === undefined) throw new Error("no originals copy was recorded");
      disk.ledger = { state: "ok", ledger: copy };
      ledger = copy;
    },
    linkDown(name) {
      links[name] = false;
    },
    linkUp(name) {
      links[name] = true;
      pendingEvents.push({ kind: "link_up", transport: name });
    },
    restartBridge() {
      restartingBridge = true;
    },
    replayCache() {
      bridge.replay();
    },
    rejoin(valveId) {
      bridge.rejoin(valveId);
    },
    personWrites(valveId, payload) {
      bridge.write(valveId, payload, nowMs);
    },
    batterySwap(valveId) {
      bridge.valve(valveId).batterySwap(nowMs);
      bridge.rejoin(valveId);
    },
    planChange(raw, options = {}) {
      const full: ChangeOptions = {
        expectedRevision: undefined,
        dryRun: false,
        overwriteUnreadable: false,
        haLinked: true,
        ...options,
      };
      try {
        const plan = planChange(buildWorld(), raw, full, sensorInfo());
        // The server's direct ask of pending valves is not simulated: the tick asks them.
        executeAll(plan.effects);
        return { ok: true, plan };
      } catch (error) {
        if (!(error instanceof ChangeRefused)) throw error;
        return { ok: false, refused: error };
      }
    },
    restoreValve(valveId) {
      executeAll(restoreValve(buildWorld(), valveId));
    },
    forgetValve(valveId) {
      executeAll(forgetValve(buildWorld(), valveId));
    },
    effectsOf(valveId, kind) {
      return log
        .filter(
          (entry) =>
            "valveId" in entry.effect &&
            entry.effect.valveId === valveId &&
            (kind === undefined || entry.effect.kind === kind),
        )
        .map((entry) => ({ at: entry.at - startMs, effect: entry.effect }));
    },
  };
}

export type { PersonChange };
export { modelOf };

// Setup helpers ----------------------------------------------------------------------------------

/** The n-th simulated valve's id. */
export function valveIdOf(n: number): string {
  return `z2m:0x00124b${n.toString(16).padStart(10, "0")}`;
}

/** A room with the valves and the Home Assistant sensors, on the builders' default schedule. */
export function simRoom(
  id: string,
  valveIds: readonly string[],
  sensorRefs: readonly string[] = [],
): Room {
  return {
    id,
    name: id,
    scheduleId: "default",
    valves: valveIds.map((valveId) => ({ valveId })),
    sensors: sensorRefs.map((ref) => ({ ref, weight: 1 })),
    presets: { comfort: undefined, eco: undefined, frost: undefined, boost: undefined },
    overrideEnd: "next_change",
    overrideDurationMs: 2 * 60 * 60 * 1000,
  };
}

/** The resolved rooms of a world (none when its house is unlinked). */
export function resolvedRooms(world: World): readonly Room[] {
  return roomsOf(world.configState, world.stored, world.house) ?? [];
}

/** Each valve's membership in a world, over the rooms of its house. */
export function kindsOf(world: World): ReadonlyMap<string, Membership> {
  const rooms = roomsOf(world.configState, world.stored, world.house);
  return memberships(world.configState, world.stored, world.ledger, rooms, world.house.kind);
}

/** The seven day texts a valve of the model should hold for the resolved room's schedule. */
export function desiredTexts(
  config: Config,
  rooms: readonly Room[],
  roomId: string,
  model: ValveModel,
): DayTexts {
  const room = rooms.find((r) => r.id === roomId);
  if (room === undefined) throw new Error(`no room ${roomId}`);
  const schedule = config.schedules.find((s) => s.id === room.scheduleId);
  if (schedule === undefined) throw new Error(`no schedule ${room.scheduleId}`);
  const spec = model === "trvzb" ? TRVZB_SPEC : TRV_ZBT_SPEC;
  const week = fitted(resolveWeek(schedule.defaultWeek, effectivePresets(config, room)), spec);
  const texts = {} as Record<(typeof WEEKDAYS)[number], string>;
  for (const day of WEEKDAYS) texts[day] = encodeDay(week.days[day], spec.slotCount);
  return texts;
}

/**
 * A valve whose own settings are what Heatmaster wants: the room's days in the owned group, the
 * source external when the room has sensors, and the TRV-ZBT's active group 3. It reports only
 * when it is asked, written to or woken.
 */
export function inSyncValve(
  config: Config,
  rooms: readonly Room[],
  roomId: string,
  valveId: string,
  model: ValveModel,
): SimValveSetup {
  const room = rooms.find((r) => r.id === roomId);
  const texts = desiredTexts(config, rooms, roomId, model);
  const select = (room?.sensors.length ?? 0) > 0 ? "remote_temperature" : "local_temperature";
  return {
    valveId,
    model,
    selfReports: false,
    select,
    ...(model === "trvzb"
      ? { schedules: { 1: texts } }
      : { schedules: { 3: texts }, activeGroup: 3 }),
  };
}

/** A valve in its factory state, not in any room: what the user's original settings look like. */
export function factoryValve(valveId: string, model: ValveModel): SimValveSetup {
  return { valveId, model, selfReports: false, select: "local_temperature", activeGroup: 1 };
}

/** The ledger of valves whose originals were captured with the factory settings. */
export function recordedLedger(
  valves: readonly Readonly<{ valveId: string; model: ValveModel }>[],
  atMs = SIM_START_MS - 24 * HOUR_MS,
): Ledger {
  let ledger = EMPTY_LEDGER;
  for (const { valveId, model } of valves) {
    ledger = withRecord(ledger, {
      valveId,
      profile: model === "trvzb" ? TRVZB_SPEC.profile : TRV_ZBT_SPEC.profile,
      adoptedAt: atMs,
      originals: makeOriginals(model),
    });
  }
  return ledger;
}
