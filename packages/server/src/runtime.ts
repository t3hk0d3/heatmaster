/**
 * The runtime: holds what is known, runs the core's tick and change functions, and executes the
 * effects they return. It decides nothing about writes itself, with three exceptions written out
 * below: the failed-send rule, the direct ask and the clock-jump rule.
 */

import {
  BUCKET,
  ChangeRefused,
  EMPTY_CONFIG,
  EMPTY_MEMORY,
  EMPTY_READINGS,
  EMPTY_THERMOSTAT_STATE,
  FRESH_STORED,
  REFILL_MS,
  SETTING_KEYS,
  VALVE_SILENT_AFTER_MS,
  acceptUnknownOriginals,
  applyEvent,
  clampThermostatState,
  configToRaw,
  describeValue,
  exportBucket,
  findProfile,
  forgetValve as coreForgetValve,
  importDue,
  importSensors,
  isThermostatWrite,
  labelProblems,
  ledgerToRaw,
  liveness,
  membershipFrom,
  memberships,
  newState,
  planChange,
  preview as previewWrites,
  problemPacingUnreadable,
  problemStoreWriteFailed,
  problemTickFailed,
  resolveRooms,
  restoreThermostatGroup,
  restoreValve as coreRestoreValve,
  roomsOf,
  sameMembership,
  sensorId,
  storedToRaw,
  strandedValve,
  thermostatCommand,
  tick,
  transportListed,
  transportOf,
  validateConfig,
  withHaEdit,
  withHold,
  withRoomChoice,
  withoutUpgradeReport,
} from "@heatmaster/core";
import type {
  AreaMembership,
  Binding,
  BucketStart,
  ChangeOptions,
  ChangePlan,
  Config,
  ConfigState,
  ContactReading,
  Decoded,
  DeviceState,
  DeviceView,
  Effect,
  Event,
  Group,
  HaChange,
  HaEdit,
  HouseInput,
  Inbox,
  Ledger,
  Liveness,
  Memory,
  Membership,
  MembershipView,
  Origin,
  Pending,
  Problem,
  Room,
  RoomChoice,
  RoomStatus,
  SensorInfo,
  ContactInfo,
  SensorReading,
  SensorRef,
  SettingKey,
  StoredConfig,
  ThermostatCommand,
  ThermostatState,
  TickResult,
  UnplacedReason,
  UpgradeReport,
  ValveSpec,
  WindowSettings,
  World,
} from "@heatmaster/core";
import type { Clock } from "./clock.ts";
import { HeatmasterError } from "./errors.ts";
import type { HaEvent, HaLink } from "./ha-link.ts";
import {
  configuredContacts,
  contactInfos,
  createLabelSync,
  sensorInfos,
  type LabelScope,
} from "./label-sync.ts";
import type {
  ConfigStore,
  LedgerStore,
  PacingStamps,
  PacingStore,
  ThermostatStore,
} from "./stores.ts";
import type { DeviceInfo, RawEvent, Transport } from "./transport.ts";

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

export const TICK_INTERVAL_MS = 30 * SECOND_MS;
export const EVENT_DEBOUNCE_MS = 1 * SECOND_MS;
export const DIRECT_ASK_SPACING_MS = 60 * SECOND_MS;
export const DIRECT_ASK_WINDOW_MS = 1 * HOUR_MS;
export const DIRECT_ASK_WINDOW_LIMIT = 6;
export const CLOCK_JUMP_MS = 5 * MINUTE_MS;
/** Registry changes are acted on once this long has passed without another one. */
export const HA_SETTLE_MS = 5 * SECOND_MS;
export const HA_LINK_KEY = "ha";

const HA_PREFIX = "ha:";

/** Where the runtime logs; main passes the Fastify logger. */
export type RuntimeLog = Readonly<{
  info(message: string, data?: Readonly<Record<string, unknown>>): void;
  warn(message: string, data?: Readonly<Record<string, unknown>>): void;
  error(message: string, data?: Readonly<Record<string, unknown>>): void;
}>;

export type RuntimeDeps = Readonly<{
  configStore: ConfigStore;
  ledgerStore: LedgerStore;
  pacingStore: PacingStore;
  thermostatStore: ThermostatStore;
  transports: Readonly<Record<string, Transport>>;
  ha: HaLink | undefined;
  clock: Clock;
  processTimeZone: string;
  log: RuntimeLog;
}>;

export type ApplyOptions = Readonly<{
  expectedRevision: number | undefined;
  overwriteUnreadable: boolean;
}>;

/**
 * One room of the membership: the accepted one while the house is live, the saved one while it is
 * frozen or unlinked. `managed` is false while unlinked and when the config has no schedule.
 */
export type RoomSnapshot = Readonly<{
  roomId: string;
  name: string;
  managed: boolean;
  scheduleId: string | undefined;
  scheduleName: string | undefined;
  valveIds: readonly string[];
  sensorIds: readonly string[];
  /** The room's merged window settings; undefined while the room is not resolved. */
  window: WindowSettings | undefined;
  status: RoomStatus | undefined;
}>;

export type DeviceSnapshot = Readonly<{
  deviceId: string;
  transport: string;
  name: string;
  modelId: string;
  manufacturer: string | undefined;
  firmware: string | undefined;
  supported: boolean;
  membership: Membership | undefined;
  liveness: Liveness;
  observed: boolean;
  heardAt: number | undefined;
}>;

export type UnassignedValve = Readonly<{
  valveId: string;
  name: string;
  observed: boolean;
  liveness: Liveness;
  heardAt: number | undefined;
  values: Readonly<Record<string, unknown>>;
  /** Why Home Assistant puts it in no room, while the house is live. */
  reason: UnplacedReason | undefined;
}>;

export type SensorSnapshot = Readonly<{
  sensorId: string;
  ref: string;
  name: string;
  celsius: number | undefined;
  seenAt: number | undefined;
  pending: boolean;
  unobservable: boolean;
}>;

export type Snapshot = Readonly<{
  revision: number;
  configState: ConfigState;
  house: HouseInput["kind"];
  houseFrozenReason: "not_loaded" | "link_down" | undefined;
  ledgerReadable: boolean;
  originalsCopyRecords: number;
  held: boolean;
  language: "en" | "ru";
  timeZone: string;
  tickedAt: number | undefined;
  rooms: readonly RoomSnapshot[];
  /** The config's room entries, in its order, of areas that are no room. */
  unusedEntries: readonly string[];
  haChanges: readonly HaChange[];
  upgrade: UpgradeReport | undefined;
  problems: readonly Problem[];
  memberships: Readonly<Record<string, Membership>>;
  /**
   * Managed valves that Home Assistant no longer has and their transport does not list, while that
   * transport can vouch for its list (`strandedValve`, `transportListed`).
   */
  stranded: readonly string[];
  devices: readonly DeviceSnapshot[];
  unassigned: readonly UnassignedValve[];
  /** The valves that wait to join, as the last tick found them. */
  pending: readonly Pending[];
  sensors: readonly SensorSnapshot[];
  links: Readonly<Record<string, boolean>>;
  transportFaults: Readonly<Record<string, string>>;
  /** Home Assistant's names of the areas that problems name, by area id; JSON like the rest. */
  areaNames: Readonly<Record<string, string>>;
  /** The config's schedules in config order; empty while the config is unreadable. */
  schedules: readonly Readonly<{ id: string; name: string }>[];
}>;

export type HeatmasterRuntime = Readonly<{
  start(): Promise<void>;
  stop(): Promise<void>;
  snapshot(): Snapshot;
  subscribe(listener: (snapshot: Snapshot) => void): () => void;
  apply(raw: unknown, options: ApplyOptions): Promise<ChangePlan>;
  preview(raw: unknown, options: ApplyOptions): Promise<ChangePlan>;
  exportConfig(): Readonly<{ revision: number; config: Readonly<Record<string, unknown>> }>;
  resync(roomId: string | undefined): Promise<void>;
  refreshValve(valveId: string): Promise<void>;
  restoreValve(valveId: string): Promise<void>;
  forgetValve(valveId: string): Promise<void>;
  importOriginals(acceptEmpty: boolean): Promise<void>;
  /** Joins a valve pending with `originals_unreadable`, its unknown originals null; then a tick. */
  acceptOriginals(valveId: string): Promise<void>;
  /** Saves the stored config without its upgrade report; the revision is unchanged. */
  dismissUpgrade(): Promise<void>;
  setHold(on: boolean): Promise<void>;
  /**
   * Changes a room's thermostat (`thermostatCommand`) and saves it; then a tick. `ChangeRefused`
   * propagates; a failed save rejects and leaves the room as it was (R20).
   */
  roomCommand(roomId: string, command: ThermostatCommand, origin: Origin): Promise<void>;
  /** Saves a choice of a room's Home Assistant select (`withRoomChoice`); then a tick. */
  roomChoice(roomId: string, choice: RoomChoice): Promise<void>;
  /**
   * "Start over" (R10): sets an unreadable `state.json` aside and saves an empty state, so every
   * room follows its schedule and every valve is taken over; then a tick. Refuses with
   * `state_readable` while the state is readable.
   */
  resetThermostats(): Promise<void>;
  diagnostics(): Readonly<Record<string, unknown>>;
  settled(): Promise<void>;
}>;

// ---- effects -------------------------------------------------------------------------------------

export type EffectContext = Readonly<{
  configStore: ConfigStore;
  ledgerStore: LedgerStore;
  thermostatStore: ThermostatStore;
  transports: Readonly<Record<string, Transport>>;
  bindingOf: (valveId: string) => Binding | undefined;
  overwriteUnreadable: boolean;
  onLedgerSaved: (ledger: Ledger) => void;
  onConfigSaved: (stored: StoredConfig) => void;
  onThermostatsSaved: (thermostats: ThermostatState) => void;
  onSent: (valveId: string, what: "refresh" | "publish") => void;
  /**
   * Posts a room's window-limit notification (W7). Never rejects: a failure is logged by the
   * callee.
   */
  notify: (roomId: string) => Promise<void>;
  /** Dismisses it; never rejects. */
  dismiss: (roomId: string) => Promise<void>;
}>;

type StoreName = "config" | "ledger" | "copy" | "pacing" | "state";

/**
 * `unsent` and `unpushed` list the valves whose sends did not go out; `held` the valves whose
 * mode and setpoint publish was dropped behind a failed save (R20): held, not unsent.
 */
export type EffectOutcome = Readonly<{
  error: unknown;
  unsent: readonly string[];
  unpushed: readonly string[];
  held: readonly string[];
  stores: Readonly<Partial<Record<StoreName, boolean>>>;
}>;

/** A failure as one line of text for the log. */
function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return typeof error === "string" ? error : JSON.stringify(error);
}

/** Raises the first failure of an effect list, as it was raised. */
function raise(outcome: EffectOutcome): void {
  const error = outcome.error;
  if (error === undefined) return;
  if (error instanceof Error) throw error;
  throw new Error(errorText(error));
}

function codeOf(error: unknown): string | undefined {
  return error instanceof HeatmasterError ? error.code : undefined;
}

type ValveEffect = Extract<
  Effect,
  { kind: "publish" | "publishSetpoint" | "pushTemperature" | "refresh" }
>;

/** Sends one valve effect. Resolves true when something went out, false when there was nothing. */
async function sendValveEffect(effect: ValveEffect, context: EffectContext): Promise<boolean> {
  const binding = context.bindingOf(effect.valveId);
  const key = transportOf(effect.valveId);
  const transport = Object.hasOwn(context.transports, key) ? context.transports[key] : undefined;
  if (binding === undefined || transport === undefined) {
    throw new HeatmasterError("device_unknown", { deviceId: effect.valveId });
  }
  switch (effect.kind) {
    case "publish":
      await transport.publish(effect.valveId, binding.encode(effect.values));
      return true;
    case "publishSetpoint":
      await transport.publish(effect.valveId, binding.encodeSetpoint(effect.celsius));
      return true;
    case "pushTemperature":
      await transport.publish(effect.valveId, binding.encodeTemperature(effect.celsius));
      return true;
    case "refresh": {
      const payload = binding.encodeRefresh();
      if (payload === undefined) return false;
      await transport.read(effect.valveId, payload);
      return true;
    }
  }
}

/**
 * Executes the effects in order, each awaited. A failed save, or a send that fails with
 * `mqtt_not_connected`, drops the rest of the list; any other failure of a valve's effect skips
 * that valve's remaining effects. A mode and setpoint publish dropped behind a failed save is
 * listed as held, not unsent (R20). Never rejects.
 */
export async function executeEffects(
  effects: readonly Effect[],
  context: EffectContext,
): Promise<EffectOutcome> {
  let error: unknown;
  let failed = false;
  let dropped = false;
  /** Whether the rest was dropped by a failed save, not by a lost connection. */
  let saveFailed = false;
  const skipped = new Set<string>();
  const unsent: string[] = [];
  const unpushed: string[] = [];
  const held: string[] = [];
  const stores: Partial<Record<StoreName, boolean>> = {};

  const fail = (cause: unknown): void => {
    if (!failed) error = cause;
    failed = true;
  };
  const notOut = (effect: ValveEffect): void => {
    const list =
      effect.kind === "pushTemperature"
        ? unpushed
        : saveFailed && isThermostatWrite(effect)
          ? held
          : unsent;
    if (!list.includes(effect.valveId)) list.push(effect.valveId);
  };

  for (const effect of effects) {
    try {
      switch (effect.kind) {
        case "saveLedger":
        case "writeOriginalsCopy":
        case "saveConfig": {
          if (dropped) continue;
          const store: StoreName =
            effect.kind === "saveLedger"
              ? "ledger"
              : effect.kind === "saveConfig"
                ? "config"
                : "copy";
          try {
            if (effect.kind === "saveLedger") await context.ledgerStore.save(effect.ledger);
            else if (effect.kind === "writeOriginalsCopy") {
              await context.ledgerStore.writeCopy(effect.ledger);
            } else await context.configStore.save(effect.stored, context.overwriteUnreadable);
          } catch (cause) {
            stores[store] = false;
            fail(cause);
            dropped = true;
            saveFailed = true;
            continue;
          }
          stores[store] = true;
          if (effect.kind === "saveLedger") context.onLedgerSaved(effect.ledger);
          if (effect.kind === "saveConfig") context.onConfigSaved(effect.stored);
          break;
        }
        case "notifyWindowOpen":
        case "dismissWindowOpen": {
          // Behind a failed save the notice would go out while `notifiedAt` was not saved.
          if (dropped) continue;
          // Started, not awaited: a Home Assistant that does not answer must not hold back the
          // valve writes after it. The callee logs its own failure and never rejects.
          void (
            effect.kind === "notifyWindowOpen"
              ? context.notify(effect.roomId)
              : context.dismiss(effect.roomId)
          ).catch(() => undefined);
          break;
        }
        case "saveThermostats": {
          if (dropped) continue;
          try {
            await context.thermostatStore.save(effect.state);
          } catch (cause) {
            stores.state = false;
            fail(cause);
            dropped = true;
            saveFailed = true;
            continue;
          }
          stores.state = true;
          context.onThermostatsSaved(effect.state);
          break;
        }
        default: {
          if (dropped || skipped.has(effect.valveId)) {
            notOut(effect);
            continue;
          }
          let went: boolean;
          try {
            went = await sendValveEffect(effect, context);
          } catch (cause) {
            fail(cause);
            notOut(effect);
            if (codeOf(cause) === "mqtt_not_connected") dropped = true;
            else skipped.add(effect.valveId);
            continue;
          }
          if (went && (effect.kind === "publish" || effect.kind === "refresh")) {
            context.onSent(effect.valveId, effect.kind);
          }
        }
      }
    } catch (cause) {
      // A callback threw: the effect went out, so it is not listed; the failure is reported.
      fail(cause);
    }
  }
  return { error, unsent, unpushed, held, stores };
}

// ---- the runtime ---------------------------------------------------------------------------------

type Queued = Readonly<{ key: string; event: RawEvent; at: number }>;

type TickRecord = Readonly<{
  rooms: ReadonlyMap<string, RoomStatus>;
  problems: readonly Problem[];
  pending: readonly Pending[];
  timeZone: string;
  tickedAt: number;
}>;

type Profiled = Readonly<{ spec: ValveSpec; binding: Binding }>;

const STORE_NAMES: readonly StoreName[] = ["config", "ledger", "copy", "pacing", "state"];

function zoneAccepted(zone: string | undefined): zone is string {
  if (zone === undefined || zone === "") return false;
  try {
    Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(zone);
    return true;
  } catch {
    return false;
  }
}

/** The sensors of every room entry, used or not, each once, in the config's order. */
function roomSensors(config: Config | undefined): readonly SensorRef[] {
  const seen = new Set<string>();
  const sensors: SensorRef[] = [];
  for (const entry of config?.rooms.values() ?? []) {
    for (const sensor of entry.sensors) {
      const id = sensorId(sensor);
      if (seen.has(id)) continue;
      seen.add(id);
      sensors.push(sensor);
    }
  }
  return sensors;
}

const UNKNOWN_CONTACT: ContactReading = {
  open: undefined,
  changedAt: undefined,
  lastOpen: undefined,
  lastAt: undefined,
};

function noticeId(roomId: string): string {
  return `heatmaster_window_${roomId}`;
}

/** A limit as the notice says it: whole hours as `2 h` (`2 ч`), else minutes. */
function limitText(limitMs: number, language: "en" | "ru"): string {
  const minutes = Math.round(limitMs / 60000);
  const hours = minutes % 60 === 0;
  const count = String(hours ? minutes / 60 : minutes);
  if (language === "ru") return `${count} ${hours ? "ч" : "мин"}`;
  return `${count} ${hours ? "h" : "min"}`;
}

/** The title and text of a room's window-limit notification, in the entity language. */
export function windowNotice(
  language: "en" | "ru",
  roomName: string,
  limitMs: number,
  afterLimit: "heat" | "stay",
): Readonly<{ title: string; message: string }> {
  const limit = limitText(limitMs, language);
  if (language === "ru") {
    return {
      title: `Окно открыто: ${roomName}`,
      message: `Окно открыто уже ${limit} в ${roomName}; ${
        afterLimit === "stay" ? "защита от замерзания сохранена" : "отопление снова включено"
      }.`,
    };
  }
  return {
    title: `Window open in ${roomName}`,
    message: `A window has been open for ${limit} in ${roomName}; ${
      afterLimit === "stay" ? "freeze protection kept" : "heating resumed"
    }.`,
  };
}

function entityOf(ref: string): string | undefined {
  return ref.startsWith(HA_PREFIX) ? ref.slice(HA_PREFIX.length) : undefined;
}

function sorted<T>(items: Iterable<T>, key: (item: T) => string): T[] {
  return [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

function describeValues(state: DeviceState | undefined): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    const value = state?.values[key];
    if (value !== undefined) values[key] = describeValue(key, value);
  }
  return values;
}

/**
 * A device whose name holds + or # cannot be addressed over MQTT (the Zigbee2MQTT transport
 * drops it), so it is not followed: a managed one shows as unsupported.
 */
function unaddressable(info: DeviceInfo): boolean {
  return /[+#]/.test(info.name);
}

const NOTHING_DECODED: Decoded = { values: {}, readings: EMPTY_READINGS };

export function createRuntime(deps: RuntimeDeps): HeatmasterRuntime {
  const { clock, log, ha } = deps;
  const transports = deps.transports;
  const keys = Object.keys(transports).sort();

  let started = false;
  let stopping = false;
  let configState: ConfigState = "empty";
  let stored: StoredConfig | undefined;
  let ledger: Ledger | undefined;
  let copyRecords = 0;
  let forcedHold = false;
  let inbox: Inbox = { states: new Map(), memory: EMPTY_MEMORY };
  const lastPayloads = new Map<string, Readonly<Record<string, unknown>>>();
  let followed = new Map<string, ReadonlySet<string>>();
  const warnedTopics = new Set<string>();
  let lastTick: TickRecord | undefined;
  /**
   * The room states and valve expectations as last written to `state.json` (R20: a tick's or a
   * command's state is taken only once saved); undefined while the file cannot be read (R10).
   */
  let thermostats: ThermostatState | undefined = EMPTY_THERMOSTAT_STATE;
  const storeFailed: Partial<Record<StoreName, boolean>> = {};
  /**
   * The write budget. `buckets` is what a valve with no memory starts with: the stamps known for
   * the valves, and the stamp of a valve with none (full, or empty after a file that could not be
   * read). `persisted` is what `pacing.json` holds, undefined when it holds nothing usable.
   * `pacingUnreadableUntil` keeps the problem shown while the made-up empty buckets refill.
   */
  type PacingFile = Readonly<{ stamps: PacingStamps; freeAsks: PacingStamps }>;
  let buckets: BucketStart = { stamps: new Map(), fallback: 0, freeAsks: new Map() };
  let persisted: PacingFile | undefined = { stamps: new Map(), freeAsks: new Map() };
  let pacingUnreadableUntil: number | undefined;
  /** The error of the last timed or event tick, while it keeps failing; undefined once one runs. */
  let tickError: string | undefined;
  const directAsks = new Map<string, number[]>();
  const listeners = new Set<(snapshot: Snapshot) => void>();
  /** Keeps Home Assistant's labels and the config in step; see label-sync.ts. */
  const labelSync = ha === undefined ? undefined : createLabelSync(ha, valveAddresses);

  /** The membership acted on while the house is live, and the valves it was placed for. */
  let accepted: MembershipView | undefined;
  let acceptedFor: ReadonlySet<string> = new Set();
  /** Whether the link_up handler has accepted a membership for the current connection. */
  let acceptedLive = false;
  /** Counts the link's drops: a link_up handler queued before a drop is for a connection gone. */
  let connection = 0;
  let cancelSettle: (() => void) | undefined;
  let placingAgain = false;

  let cancelInterval: (() => void) | undefined;
  let cancelDebounce: (() => void) | undefined;
  let executing = false;
  const queue: Queued[] = [];
  let lastWall: number | undefined;
  let lastMono: number | undefined;
  let jumpSeenAt: number | undefined;

  // The lock: one task at a time, in the order asked.
  let tail: Promise<void> = Promise.resolve();
  let busy = 0;
  let tickQueued = false;
  const idle: (() => void)[] = [];

  /** Resolves `settled` waiters once nothing runs, nothing is queued and no debounce is armed. */
  function wakeIdle(): void {
    if (busy === 0 && cancelDebounce === undefined) {
      for (const resolve of idle.splice(0)) resolve();
    }
  }

  function withLock<T>(task: () => Promise<T>): Promise<T> {
    busy += 1;
    const run = tail.then(task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    void tail.then(() => {
      busy -= 1;
      wakeIdle();
    });
    return run;
  }

  function notStarted(): HeatmasterError {
    return new HeatmasterError("not_started");
  }

  /** Read through a function: `stop` may set it while `start` awaits. */
  function isStopping(): boolean {
    return stopping;
  }

  function requireStarted(): void {
    if (!started || stopping) throw notStarted();
  }

  // ---- what is known --------------------------------------------------------------------------

  function readableStored(): StoredConfig | undefined {
    return configState === "ok" ? stored : undefined;
  }

  /**
   * The house: unlinked without a Home Assistant link; frozen on the saved membership until the
   * link has loaded, while it is down, and on a reconnect until its link_up handler has run; live
   * on the accepted membership otherwise.
   */
  function houseInput(): HouseInput {
    if (ha === undefined) return { kind: "unlinked" };
    const saved = stored?.membership;
    if (!ha.ready()) return { kind: "frozen", membership: saved, reason: "not_loaded" };
    if (!ha.up() || !acceptedLive || accepted === undefined) {
      return { kind: "frozen", membership: saved, reason: "link_down" };
    }
    return { kind: "live", membership: accepted.membership, notInHa: accepted.notInHa };
  }

  function currentMemberships(): ReadonlyMap<string, Membership> {
    const house = houseInput();
    const rooms = roomsOf(configState, stored, house);
    return memberships(configState, stored, ledger, rooms, house.kind);
  }

  function listed(
    deviceId: string,
  ): Readonly<{ info: DeviceInfo; transport: Transport }> | undefined {
    const key = transportOf(deviceId);
    const transport = Object.hasOwn(transports, key) ? transports[key] : undefined;
    const info = transport?.devices().get(deviceId);
    return transport === undefined || info === undefined ? undefined : { info, transport };
  }

  function profileOf(deviceId: string): Profiled | undefined {
    const found = listed(deviceId);
    return found === undefined ? undefined : findProfile(found.info.modelId, found.transport.key);
  }

  function isFollowed(deviceId: string): boolean {
    return followed.get(transportOf(deviceId))?.has(deviceId) === true;
  }

  /** Spec by valve id, for every followed device with a profile. */
  function specs(): ReadonlyMap<string, ValveSpec> {
    const map = new Map<string, ValveSpec>();
    for (const ids of followed.values()) {
      for (const id of ids) {
        const profile = profileOf(id);
        if (profile !== undefined) map.set(id, profile.spec);
      }
    }
    return map;
  }

  function zone(): string {
    const configured = readableStored()?.config.settings.timezone;
    if (zoneAccepted(configured)) return configured;
    const house = ha?.house()?.timeZone;
    if (zoneAccepted(house)) return house;
    return deps.processTimeZone;
  }

  function heldNow(): boolean {
    return forcedHold || readableStored()?.config.settings.holdWrites === true;
  }

  /** The stored config as the world sees it: hold forced on after a failed `setHold(true)`. */
  function worldStored(): StoredConfig | undefined {
    if (stored === undefined || !forcedHold) return stored;
    const settings = { ...stored.config.settings, holdWrites: true };
    return { ...stored, config: { ...stored.config, settings } };
  }

  function linkStates(): Record<string, boolean> {
    const links: Record<string, boolean> = {};
    for (const key of keys) links[key] = transports[key]?.linkUp() === true;
    if (ha !== undefined) links[HA_LINK_KEY] = ha.up();
    return links;
  }

  /** Every device each transport lists, for the transports that have delivered a list. */
  function deviceLists(): Record<string, ReadonlySet<string>> {
    const lists: Record<string, ReadonlySet<string>> = {};
    for (const key of keys) {
      const transport = transports[key];
      if (transport?.hasDeviceList() === true) lists[key] = new Set(transport.devices().keys());
    }
    return lists;
  }

  function faults(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const key of keys) {
      const fault = transports[key]?.fault();
      if (fault !== undefined) result[key] = fault;
    }
    return result;
  }

  type Readings = Readonly<{
    sensors: ReadonlyMap<string, SensorReading>;
    unobservable: ReadonlySet<string>;
  }>;

  /** One reading per sensor; see the task's table. Sensors are read through Home Assistant only. */
  function readSensors(sensors: readonly SensorRef[], nowMs: number): Readings {
    const readings = new Map<string, SensorReading>();
    const unobservable = new Set<string>();
    for (const sensor of sensors) {
      const id = sensorId(sensor);
      const entity = entityOf(sensor.ref);
      const none = (pending: boolean): SensorReading => ({
        sensorId: id,
        value: undefined,
        seenAt: undefined,
        pending,
      });
      if (ha === undefined || entity === undefined) {
        readings.set(id, none(false));
        continue;
      }
      // While the link is down an old value must not be fed to a valve.
      if (!ha.up()) {
        readings.set(id, none(true));
        continue;
      }
      const found = ha.sensor(entity);
      if (found === undefined) {
        readings.set(id, none(false));
        continue;
      }
      if (!found.observable) {
        unobservable.add(id);
        readings.set(id, { sensorId: id, value: found.celsius, seenAt: nowMs, pending: false });
        continue;
      }
      let seenAt = found.lastReportedAt;
      // Home Assistant's stamps from before a clock jump are off by the same step.
      if (seenAt !== undefined && jumpSeenAt !== undefined && seenAt < jumpSeenAt) {
        seenAt = jumpSeenAt;
      }
      readings.set(id, { sensorId: id, value: found.celsius, seenAt, pending: false });
    }
    return { sensors: readings, unobservable };
  }

  /** Every configured contact as Home Assistant shows it; unknown while the link is not up. */
  function readContacts(config: Config | undefined): ReadonlyMap<string, ContactReading> {
    const readings = new Map<string, ContactReading>();
    for (const entity of config === undefined ? [] : configuredContacts(config)) {
      readings.set(
        `${HA_PREFIX}${entity}`,
        (ha?.up() === true ? ha.contact(entity) : undefined) ?? UNKNOWN_CONTACT,
      );
    }
    return readings;
  }

  // ---- rooms from Home Assistant ---------------------------------------------------------------

  /** The transport addresses of every listed device that has a valve profile. */
  function valveAddresses(): ReadonlySet<string> {
    const addresses = new Set<string>();
    for (const transport of Object.values(transports)) {
      for (const info of transport.devices().values()) {
        if (findProfile(info.modelId, transport.key) !== undefined) addresses.add(info.address);
      }
    }
    return addresses;
  }

  /**
   * The valves Home Assistant may place in a room: every followed valve with a profile, and every
   * valve with a ledger record or in releasing, listed by its transport or not.
   */
  function placedValves(): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const followedIds of followed.values()) {
      for (const id of followedIds) if (profileOf(id) !== undefined) ids.add(id);
    }
    for (const id of ledger?.records.keys() ?? []) ids.add(id);
    for (const id of stored?.releasing.keys() ?? []) ids.add(id);
    return ids;
  }

  function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
    return a.size === b.size && [...a].every((id) => b.has(id));
  }

  type Placing = Readonly<{ view: MembershipView; placed: ReadonlySet<string> }>;

  /** The membership Home Assistant gives now, not yet accepted; undefined before its first load. */
  function placing(previous: AreaMembership | undefined): Placing | undefined {
    const snapshot = ha?.snapshot();
    if (snapshot === undefined) return undefined;
    const placed = placedValves();
    return { view: membershipFrom(snapshot, placed, previous), placed };
  }

  function commit(next: Placing): void {
    accepted = next.view;
    acceptedFor = next.placed;
  }

  /**
   * Takes the membership Home Assistant gives now. Runs under the lock; its callers then queue a
   * tick at once (a debounce would only delay one change).
   */
  function accept(previous: AreaMembership | undefined): boolean {
    const next = placing(previous);
    if (next === undefined) return false;
    commit(next);
    return true;
  }

  /**
   * Queues a label mirror; a failed one is logged and never fails its caller. When it changes the
   * label problems, the listeners hear of it at once.
   */
  function queueMirror(
    config: Config,
    membership: AreaMembership,
    scope: LabelScope = "all",
  ): void {
    if (labelSync === undefined) return;
    const shown = (): string =>
      labelSync
        .problems()
        .map((p) => JSON.stringify([p.kind, p.subject, p.data]))
        .join("\n");
    const before = shown();
    labelSync.mirror(config, membership, scope).then(
      () => {
        if (started && !stopping && shown() !== before) notify();
      },
      (error: unknown) => {
        log.error("a label mirror failed", { error: errorText(error) });
      },
    );
  }

  /** After an apply saved its config: the labels follow it while the house is live. */
  function mirrorApplied(): void {
    const current = readableStored();
    if (current !== undefined && accepted !== undefined && houseInput().kind === "live") {
      queueMirror(current.config, accepted.membership);
    }
  }

  /**
   * The sensor import, once per room: on every accepted membership, each room that has not had it
   * yet gets it. Home Assistant may load before the transports list the valves, so a room that
   * joins later gets its import when it joins. True when it saved.
   */
  async function importIfDue(membership: AreaMembership): Promise<boolean> {
    const current = readableStored();
    const snapshot = ha?.snapshot();
    if (
      ha === undefined ||
      snapshot === undefined ||
      current === undefined ||
      !importDue(current, membership)
    ) {
      return false;
    }
    const infos = sensorInfos(ha, snapshot, valveAddresses());
    const next = importSensors(current, membership, snapshot, infos, clock.nowMs());
    const outcome = await execute([{ kind: "saveConfig", stored: next }], false);
    if (outcome.stores.config !== true) return false;
    if (next.revision !== current.revision) {
      log.info("room sensors imported from room_temperature_sensor", { revision: next.revision });
    }
    refollow();
    return true;
  }

  /**
   * The link_up handler: after the link's full load the house is live at once. With a readable
   * config the sensor import runs when it is due, then the labels are mirrored: the config wins.
   */
  async function linkUp(at: number): Promise<void> {
    if (!started || stopping || at !== connection || ha?.up() !== true) return;
    if (!accept(accepted?.membership ?? stored?.membership)) return;
    acceptedLive = true;
    const membership = accepted?.membership;
    try {
      if (membership !== undefined) {
        await importIfDue(membership);
        const current = readableStored();
        if (current !== undefined) queueMirror(current.config, membership);
      }
    } catch (error) {
      log.error("the sensor import or the label mirror failed", { error: errorText(error) });
    }
    queueTick();
  }

  /**
   * The settle: the user's label edits since the last mirror or pull become one config revision,
   * computed from the stored config and saved under this one hold of the lock, so an apply or a
   * hold change is never lost to it; then the membership is accepted. Without an edit, a changed
   * membership or a moved schedule label is answered by a mirror of the schedule labels.
   */
  async function settle(): Promise<void> {
    const next = placing(accepted?.membership);
    if (next === undefined) return;
    const previous = accepted?.membership;
    const membership = next.view.membership;
    const current = readableStored();
    let edit: HaEdit | undefined;
    try {
      edit = current === undefined ? undefined : labelSync?.pull(current.config, membership);
    } catch (error) {
      // A failed pull is no edit: the membership is still accepted.
      log.error("a label pull failed", { error: errorText(error) });
    }
    let saved = false;
    if (current !== undefined && edit !== undefined) {
      const edited = withHaEdit(current, edit, clock.nowMs());
      const outcome = await execute([{ kind: "saveConfig", stored: edited }], false);
      saved = outcome.stores.config === true;
      if (saved) {
        log.info("a label edit in Home Assistant was saved", {
          revision: edited.revision,
          items: edit.items,
        });
      }
    }
    commit(next);
    if (saved) refollow();
    if (await importIfDue(membership)) saved = true;
    // An edit that could not be saved: the config wins, and the labels go back to it.
    const full = saved || edit !== undefined;
    const config = readableStored()?.config;
    if (config !== undefined && full) {
      queueMirror(config, membership);
    } else if (
      config !== undefined &&
      (!sameMembership(previous, membership) || labelSync?.scheduleLabelsMoved() === true)
    ) {
      // A heatmaster_temp_sensor the user added stays until the next full mirror.
      queueMirror(config, membership, "schedules");
    }
    queueTick();
  }

  /** A burst of registry changes gives one settle, HA_SETTLE_MS after the last of them. */
  function armSettle(): void {
    if (!started || stopping) return;
    cancelSettle?.();
    cancelSettle = clock.after(HA_SETTLE_MS, () => {
      cancelSettle = undefined;
      void withLock(async () => {
        if (stopping || houseInput().kind !== "live") return;
        try {
          await settle();
        } catch (error) {
          log.error("a settle failed", { error: errorText(error) });
        }
      });
    });
  }

  /**
   * While live, a change of the valves Home Assistant may place (a transport lists or drops one, a
   * record is added or removed) places them again at once: no label edit is involved, so no settle.
   */
  function placeAgainIfChanged(): void {
    if (placingAgain || houseInput().kind !== "live" || sameSet(placedValves(), acceptedFor)) {
      return;
    }
    placingAgain = true;
    void withLock(async () => {
      placingAgain = false;
      const previous = accepted?.membership;
      if (
        houseInput().kind !== "live" ||
        sameSet(placedValves(), acceptedFor) ||
        !accept(previous)
      ) {
        return;
      }
      const membership = accepted?.membership;
      try {
        if (membership !== undefined) {
          const imported = await importIfDue(membership);
          const config = readableStored()?.config;
          if (config !== undefined && imported) queueMirror(config, membership);
          else if (config !== undefined && !sameMembership(previous, membership)) {
            queueMirror(config, membership, "schedules");
          }
        }
      } catch (error) {
        log.error("the sensor import or the label mirror failed", { error: errorText(error) });
      }
      queueTick();
    });
  }

  function onHaEvent(event: HaEvent): void {
    if (stopping) return;
    switch (event.kind) {
      case "link_up": {
        const at = connection;
        void withLock(() => linkUp(at));
        break;
      }
      case "link_down":
        connection += 1;
        acceptedLive = false;
        labelSync?.reset();
        cancelSettle?.();
        cancelSettle = undefined;
        requestTick();
        break;
      case "registries_changed":
        armSettle();
        break;
      case "changed":
        requestTick();
        break;
    }
  }

  function buildWorld(nowMs: number, extraSensors: readonly SensorRef[] = []): World {
    const devices = new Map<string, DeviceView>();
    for (const [key, ids] of followed) {
      const transport = transports[key];
      if (transport === undefined) continue;
      const usable = transport.fault() === undefined;
      for (const id of ids) {
        const info = transport.devices().get(id);
        if (info === undefined) continue;
        devices.set(id, {
          name: info.name,
          spec: findProfile(info.modelId, key)?.spec,
          usable,
          state: inbox.states.get(id),
        });
      }
    }
    const readable = readableStored();
    const { sensors, unobservable } = readSensors(
      [...roomSensors(readable?.config), ...extraSensors],
      nowMs,
    );
    return {
      configState,
      stored: worldStored(),
      house: houseInput(),
      ledger,
      devices,
      links: linkStates(),
      transportFaults: faults(),
      deviceLists: deviceLists(),
      sensors,
      unobservableSensors: unobservable,
      contacts: readContacts(readable?.config),
      memory: inbox.memory,
      buckets,
      now: Temporal.Instant.fromEpochMilliseconds(nowMs).toZonedDateTimeISO(zone()),
      thermostats: thermostats === undefined ? undefined : clampThermostatState(thermostats, nowMs),
    };
  }

  // ---- following ------------------------------------------------------------------------------

  /** Works out the devices to follow, tells each transport and the Home Assistant link. */
  function refollow(): void {
    const nowMs = clock.nowMs();
    const kinds = currentMemberships();
    const next = new Map<string, ReadonlySet<string>>();
    for (const key of keys) {
      const transport = transports[key];
      if (transport === undefined) continue;
      const ids = new Set<string>();
      for (const info of transport.devices().values()) {
        if (findProfile(info.modelId, key) === undefined) continue;
        if (unaddressable(info)) {
          if (!warnedTopics.has(`${info.deviceId}|${info.name}`)) {
            warnedTopics.add(`${info.deviceId}|${info.name}`);
            log.warn("a valve's name holds + or #, which no topic can carry; it is not followed", {
              valveId: info.deviceId,
              name: info.name,
            });
          }
          continue;
        }
        ids.add(info.deviceId);
      }
      for (const valveId of kinds.keys()) {
        const info = transport.devices().get(valveId);
        if (transportOf(valveId) === key && (info === undefined || !unaddressable(info))) {
          ids.add(valveId);
        }
      }
      next.set(key, ids);
    }
    const before = followed;
    followed = next;
    let states = inbox.states;
    const edit = (): Map<string, DeviceState> => {
      if (states === inbox.states) states = new Map(inbox.states);
      return states as Map<string, DeviceState>;
    };
    for (const ids of next.values()) {
      for (const id of ids) if (!states.has(id)) edit().set(id, newState(nowMs));
    }
    // A followed device without a profile that is no longer followed loses its state.
    for (const [key, ids] of before) {
      for (const id of ids) {
        if (next.get(key)?.has(id) === true || profileOf(id) !== undefined) continue;
        edit().delete(id);
        lastPayloads.delete(id);
      }
    }
    if (states !== inbox.states) inbox = { ...inbox, states };
    for (const key of keys) transports[key]?.follow(next.get(key) ?? new Set());
    if (ha !== undefined) {
      const entities = new Set<string>();
      for (const sensor of roomSensors(readableStored()?.config)) {
        const entity = entityOf(sensor.ref);
        if (entity !== undefined) entities.add(entity);
      }
      const config = readableStored()?.config;
      for (const entity of config === undefined ? [] : configuredContacts(config)) {
        entities.add(entity);
      }
      ha.watch(entities);
    }
    placeAgainIfChanged();
  }

  // ---- events ---------------------------------------------------------------------------------

  function applyCore(event: Event, nowMs: number): void {
    inbox = applyEvent(inbox, event, specs(), nowMs);
  }

  /** A tick after EVENT_DEBOUNCE_MS; none while a queued tick has not begun (it sees the change). */
  function requestTick(): void {
    if (!started || stopping || tickQueued || cancelDebounce !== undefined) return;
    cancelDebounce = clock.after(EVENT_DEBOUNCE_MS, () => {
      cancelDebounce = undefined;
      queueTick();
      wakeIdle();
    });
  }

  function handleRaw(key: string, event: RawEvent, at: number): void {
    switch (event.kind) {
      case "message": {
        if (!isFollowed(event.deviceId)) break;
        const profile = profileOf(event.deviceId);
        let decoded = NOTHING_DECODED;
        if (profile === undefined) lastPayloads.set(event.deviceId, event.payload);
        else decoded = profile.binding.decode(event.payload);
        applyCore(
          { kind: "device_message", deviceId: event.deviceId, decoded, lifeToken: event.lifeToken },
          at,
        );
        break;
      }
      case "rejoined":
        applyCore({ kind: "rejoined", deviceId: event.deviceId }, at);
        break;
      case "bridge_restarted":
        applyCore({ kind: "bridge_restarted", transport: key }, at);
        break;
      case "link_up":
        applyCore({ kind: "link_up", transport: key }, at);
        break;
      case "link_down":
        break;
      case "devices_changed":
        refollow();
        break;
    }
    requestTick();
  }

  function onTransportEvent(key: string, event: RawEvent): void {
    if (stopping) return;
    const at = clock.nowMs();
    if (executing) {
      queue.push({ key, event, at });
      return;
    }
    handleRaw(key, event, at);
  }

  // ---- ticks ----------------------------------------------------------------------------------

  function cancelTimers(): void {
    cancelInterval?.();
    cancelInterval = undefined;
    cancelDebounce?.();
    cancelDebounce = undefined;
    cancelSettle?.();
    cancelSettle = undefined;
    wakeIdle();
  }

  function queueTick(): void {
    if (!started || stopping || tickQueued) return;
    tickQueued = true;
    void withLock(async () => {
      tickQueued = false;
      try {
        await runTick();
      } catch (error) {
        tickFailed(error);
      }
    });
  }

  /**
   * A tick that threw: logged once while the same error repeats, shown as a problem, and the
   * listeners still hear of it. The next tick runs as usual.
   */
  function tickFailed(error: unknown): void {
    const message = String(error);
    if (message !== tickError) log.error("a tick failed", { error: message });
    tickError = message;
    try {
      notify();
    } catch (failure) {
      log.error("a snapshot could not be built", { error: String(failure) });
    }
  }

  /** The clock-jump rule: a wall clock that moved unlike the monotonic one was set. */
  function checkJump(nowMs: number): void {
    const mono = clock.monoMs();
    if (lastWall !== undefined && lastMono !== undefined) {
      const drift = nowMs - lastWall - (mono - lastMono);
      if (Math.abs(drift) > CLOCK_JUMP_MS) {
        log.warn("the wall clock was set; every link counts as new", { driftMs: drift });
        jumpSeenAt = nowMs;
        for (const key of keys) applyCore({ kind: "link_up", transport: key }, nowMs);
      }
    }
    lastWall = nowMs;
    lastMono = mono;
  }

  function effectContext(overwriteUnreadable: boolean): EffectContext {
    return {
      configStore: deps.configStore,
      ledgerStore: deps.ledgerStore,
      thermostatStore: deps.thermostatStore,
      transports,
      bindingOf: (valveId) => profileOf(valveId)?.binding,
      overwriteUnreadable,
      onLedgerSaved: (saved) => {
        ledger = saved;
      },
      onConfigSaved: (saved) => {
        stored = saved;
        configState = "ok";
      },
      onThermostatsSaved: (saved) => {
        thermostats = saved;
      },
      onSent: (valveId, what) => {
        applyCore({ kind: "sent", valveId, what, at: clock.nowMs() }, clock.nowMs());
      },
      notify: notifyWindowOpen,
      dismiss: dismissWindowOpen,
    };
  }

  /** The window-limit notice of a room (W7); a failure is logged and not retried. */
  async function notifyWindowOpen(roomId: string): Promise<void> {
    const room = roomsOf(configState, stored, houseInput())?.find((found) => found.id === roomId);
    if (ha === undefined || room?.window.limitMs === undefined) {
      log.warn("a window notification was not sent: the room is unknown", { roomId });
      return;
    }
    const text = windowNotice(
      readableStored()?.config.settings.language ?? "en",
      room.name,
      room.window.limitMs,
      room.window.afterLimit,
    );
    try {
      await ha.notify(noticeId(roomId), text.title, text.message);
    } catch (error) {
      log.warn("a window notification failed", { roomId, error: errorText(error) });
    }
  }

  async function dismissWindowOpen(roomId: string): Promise<void> {
    if (ha === undefined) return;
    try {
      await ha.dismiss(noticeId(roomId));
    } catch (error) {
      log.warn("dismissing a window notification failed", { roomId, error: errorText(error) });
    }
  }

  /** What a tick's effects need besides the effects: see `execute`. */
  type TickRun = Readonly<{
    /** Runs before the first effect. */
    before: () => Promise<void>;
    /** The memory the tick started from, for the valves whose publish is held. */
    start: Memory;
  }>;

  /**
   * Executes effects; afterwards the held publishes, the failed-send rule, the stores' state and
   * the queued events. A held valve's `thermostat` group memory and its tokens go back to `start`
   * (R20); one that had no memory at the start loses its memory, as before the tick.
   */
  async function execute(
    effects: readonly Effect[],
    overwriteUnreadable: boolean,
    run?: TickRun,
  ): Promise<EffectOutcome> {
    // Events stay queued until every await of this function is done: one that skipped the
    // queue would be applied before older ones and before the failed-send rule.
    executing = true;
    let outcome: EffectOutcome;
    try {
      await run?.before();
      outcome = await executeEffects(effects, effectContext(overwriteUnreadable));
      if (outcome.stores.ledger === true || outcome.stores.copy === true) {
        copyRecords = await deps.ledgerStore.copyRecords().catch((error: unknown) => {
          log.error("reading the copy's record count failed", { error: errorText(error) });
          return copyRecords;
        });
      }
    } finally {
      executing = false;
    }
    for (const name of STORE_NAMES) {
      const result = outcome.stores[name];
      if (result !== undefined) storeFailed[name] = !result;
    }
    // Nothing below awaits: the queue is drained before any new event can arrive.
    const nowMs = clock.nowMs();
    if (outcome.error !== undefined) {
      log.error("an effect failed", {
        error: errorText(outcome.error),
        unsent: outcome.unsent,
        unpushed: outcome.unpushed,
        held: outcome.held,
      });
    }
    // Only a tick holds publishes back: outside one there is no start to go back to, and deleting
    // a held valve's memory would forget far more than the publish.
    if (outcome.held.length > 0 && run !== undefined) {
      const valves = new Map(inbox.memory.valves);
      for (const valveId of outcome.held) {
        const current = valves.get(valveId);
        const start = run.start.valves.get(valveId);
        if (current === undefined) continue;
        if (start === undefined) valves.delete(valveId);
        else valves.set(valveId, restoreThermostatGroup(current, start));
      }
      inbox = { ...inbox, memory: { ...inbox.memory, valves } };
    }
    if (outcome.unsent.length > 0) {
      applyCore({ kind: "resync_requested", valveIds: new Set(outcome.unsent) }, nowMs);
    }
    for (const valveId of outcome.unpushed) applyCore({ kind: "push_failed", valveId }, nowMs);
    for (const queued of queue.splice(0)) handleRaw(queued.key, queued.event, queued.at);
    return outcome;
  }

  /**
   * The free asks made in the last `REFILL_MS`, by valve, so that a restart loop gets at most one
   * per valve in that time. A valve with no memory yet keeps the one known of it while configured;
   * after a file that could not be read every configured valve counts as asked at the start.
   */
  function pacingFreeAsks(memory: Memory, nowMs: number): PacingStamps {
    const kinds = currentMemberships();
    const recent = (at: number | undefined): at is number =>
      at !== undefined && nowMs - at < REFILL_MS;
    const configured = (valveId: string): boolean => {
      const kind = kinds.get(valveId);
      return kind === "managed" || kind === "releasing" || kind === "frozen";
    };
    const next = new Map<string, number>();
    for (const [valveId, vm] of memory.valves) {
      if (recent(vm.freeAskAt)) next.set(valveId, Math.min(vm.freeAskAt, nowMs));
    }
    // As for the buckets: with an unreadable config nothing known is dropped.
    for (const [valveId, at] of buckets.freeAsks ?? new Map<string, number>()) {
      if (next.has(valveId) || memory.valves.has(valveId) || !recent(at)) continue;
      if (configState !== "ok" || configured(valveId)) next.set(valveId, Math.min(at, nowMs));
    }
    const fallback = buckets.freeAskFallback;
    if (recent(fallback)) {
      for (const valveId of kinds.keys()) {
        if (next.has(valveId) || memory.valves.has(valveId)) continue;
        if (configState !== "ok" || configured(valveId))
          next.set(valveId, Math.min(fallback, nowMs));
      }
    }
    return next;
  }

  /** The buckets that are not full, by valve: a full bucket has no entry. */
  function pacingStamps(memory: Memory, nowMs: number): PacingStamps {
    const kinds = currentMemberships();
    const next = new Map<string, number>();
    for (const [valveId, vm] of memory.valves) {
      const stamp = exportBucket(vm, nowMs);
      if (stamp > nowMs) next.set(valveId, stamp);
    }
    // A valve that has no memory yet (its device is not listed yet) keeps what was known of it,
    // while it is configured; with an unreadable config nothing is dropped.
    for (const [valveId, stamp] of buckets.stamps) {
      if (next.has(valveId) || stamp <= nowMs) continue;
      const kind = kinds.get(valveId);
      const configured = kind === "managed" || kind === "releasing" || kind === "frozen";
      if (configState !== "ok" || configured) {
        next.set(valveId, Math.min(stamp, nowMs + BUCKET * REFILL_MS));
      }
    }
    // After a file that could not be read the starting buckets are empty, and the file must say
    // so for every configured valve, also those not listed yet: a rewrite as "all full" would
    // fail open at the next restart.
    if (buckets.fallback > nowMs) {
      const emptyAt = Math.min(buckets.fallback, nowMs + BUCKET * REFILL_MS);
      for (const [valveId, kind] of kinds) {
        const configured = kind === "managed" || kind === "releasing" || kind === "frozen";
        if (!next.has(valveId) && (configured || configState !== "ok")) next.set(valveId, emptyAt);
      }
    }
    return next;
  }

  /**
   * Saves the buckets when one of them changed. A failure is logged and shown as a problem; the
   * next tick tries again.
   */
  async function savePacing(memory: Memory, nowMs: number): Promise<void> {
    const next = pacingStamps(memory, nowMs);
    const freeAsks = pacingFreeAsks(memory, nowMs);
    buckets = { ...buckets, stamps: next, freeAsks };
    const same = (a: PacingStamps | undefined, b: PacingStamps): boolean =>
      a?.size === b.size && [...b].every(([valveId, stamp]) => a.get(valveId) === stamp);
    if (same(persisted?.stamps, next) && same(persisted?.freeAsks, freeAsks)) return;
    try {
      await deps.pacingStore.save(next, freeAsks);
      persisted = { stamps: next, freeAsks };
      storeFailed.pacing = false;
    } catch (error) {
      if (storeFailed.pacing !== true) {
        log.error("saving the write budget failed", { error: errorText(error) });
      }
      storeFailed.pacing = true;
    }
  }

  /**
   * A save of the config made by `tick` holds the real config, not the one with the hold forced
   * on after a failed `setHold(true)`: the forced hold is not the user's choice.
   */
  function withoutForcedHold(result: TickResult, worldConfig: Config | undefined): TickResult {
    if (!forcedHold || stored === undefined) return result;
    const effects = result.effects.map((effect) =>
      effect.kind === "saveConfig" && effect.stored.config === worldConfig
        ? { ...effect, stored: { ...effect.stored, config: stored?.config ?? worldConfig } }
        : effect,
    );
    return { ...result, effects };
  }

  /**
   * A release ordered after now was clamped by the tick. Kept here whether or not its save
   * works, so that a failing save does not move the order forward at every tick.
   */
  function keepClamped(nowMs: number): void {
    if (stored === undefined) return;
    if (![...stored.releasing.values()].some((orderedAt) => orderedAt > nowMs)) return;
    const releasing = new Map<string, number>();
    for (const [valveId, orderedAt] of stored.releasing) {
      releasing.set(valveId, Math.min(orderedAt, nowMs));
    }
    stored = { ...stored, releasing };
  }

  async function runTick(): Promise<void> {
    if (!started || stopping) return;
    const nowMs = clock.nowMs();
    checkJump(nowMs);
    const world = buildWorld(nowMs);
    const given = tick(world);
    const result = withoutForcedHold(given, world.stored?.config);
    keepClamped(nowMs);
    inbox = { ...inbox, memory: result.memory };
    const previousRooms = lastTick?.rooms;
    // The budget is saved before anything is sent: a crash after a send never loses a charge.
    const outcome = await execute(result.effects, false, {
      before: () => savePacing(result.memory, nowMs),
      start: world.memory,
    });
    // R20: the room statuses show the committed state; a state save that failed or was skipped
    // keeps those of the previous tick.
    const uncommitted =
      outcome.stores.state !== true && result.effects.some((e) => e.kind === "saveThermostats");
    lastTick = {
      rooms: uncommitted ? (previousRooms ?? new Map()) : result.rooms,
      problems: result.problems,
      pending: result.pending,
      timeZone: world.now.timeZoneId,
      tickedAt: nowMs,
    };
    if (outcome.stores.config === true || outcome.stores.ledger === true) refollow();
    tickError = undefined;
    notify();
  }

  function notify(): void {
    const snapshot = makeSnapshot();
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        log.error("a snapshot listener failed", { error: String(error) });
      }
    }
  }

  // ---- the direct ask -------------------------------------------------------------------------

  /** A read a user triggered; see the task's direct-ask rule. */
  async function directAsk(valveId: string): Promise<void> {
    const found = listed(valveId);
    if (found === undefined) throw new HeatmasterError("valve_unknown", { valveId });
    const profile = findProfile(found.info.modelId, found.transport.key);
    // A name that holds + or # cannot be addressed, and the valve is not followed (see refollow).
    if (profile === undefined || unaddressable(found.info)) {
      throw new HeatmasterError("valve_unsupported", { valveId });
    }
    if (found.transport.fault() !== undefined || !found.transport.linkUp()) {
      throw new HeatmasterError("transport_unusable", { valveId });
    }
    const nowMs = clock.nowMs();
    const recent = (directAsks.get(valveId) ?? []).filter(
      (at) => nowMs - at < DIRECT_ASK_WINDOW_MS && at <= nowMs,
    );
    const last = recent.at(-1);
    if (
      (last !== undefined && nowMs - last < DIRECT_ASK_SPACING_MS) ||
      recent.length >= DIRECT_ASK_WINDOW_LIMIT
    ) {
      directAsks.set(valveId, recent);
      throw new HeatmasterError("ask_limited", { valveId });
    }
    const payload = profile.binding.encodeRefresh();
    if (payload === undefined) return;
    directAsks.set(valveId, [...recent, nowMs]);
    // Stamped before the send, so a tick that runs while the read is awaited already waits; a
    // failed read only delays the core by the spacing. A valve with no memory yet starts one with
    // the bucket the tick would start it with.
    const bucketFullAt = buckets.stamps.get(valveId) ?? buckets.fallback;
    const freeAskAt = buckets.freeAsks?.get(valveId) ?? buckets.freeAskFallback;
    applyCore({ kind: "asked_directly", valveId, at: nowMs, bucketFullAt, freeAskAt }, nowMs);
    await found.transport.read(valveId, payload);
    // And again once it went out, so the spacing is measured from the end of a slow send.
    const sentAt = clock.nowMs();
    applyCore({ kind: "asked_directly", valveId, at: sentAt, bucketFullAt, freeAskAt }, sentAt);
  }

  /** Asks each valve directly; a refusal (its limit, an unusable transport) is logged at info. */
  async function askQuietly(valveIds: readonly string[]): Promise<void> {
    for (const valveId of valveIds) {
      try {
        await directAsk(valveId);
      } catch (error) {
        log.info("a direct ask was not sent", { valveId, error: String(error) });
      }
    }
  }

  // ---- changes --------------------------------------------------------------------------------

  async function plan(raw: unknown, options: ApplyOptions, dryRun: boolean): Promise<ChangePlan> {
    const config = validateConfig(raw);
    const nowMs = clock.nowMs();
    const world = buildWorld(nowMs, roomSensors(config));
    const addresses = valveAddresses();
    const infos = new Map<string, SensorInfo>();
    for (const sensor of roomSensors(config)) {
      const entity = entityOf(sensor.ref);
      infos.set(
        sensorId(sensor),
        ha === undefined || entity === undefined
          ? { exists: false, isTemperature: false, onValve: false }
          : ha.sensorInfo(entity, addresses),
      );
    }
    const changeOptions: ChangeOptions = {
      expectedRevision: options.expectedRevision,
      dryRun,
      overwriteUnreadable: options.overwriteUnreadable,
      haLinked: ha?.ready() === true,
    };
    const contacts = new Map<string, ContactInfo>();
    for (const entityId of configuredContacts(config)) {
      contacts.set(
        entityId,
        ha === undefined ? { exists: false, isBinary: false } : ha.contactInfo(entityId),
      );
    }
    const result = planChange(world, raw, changeOptions, infos, contacts);
    // The joining valves, and those that wait because they have not reported, are asked to report.
    const unobserved = result.pending.filter((p) => p.reason === "valve_not_observed");
    const asked = [...result.joining, ...unobserved].map((entry) => entry.valveId);
    if (asked.length > 0) await askQuietly(asked);
    return result;
  }

  /** Executes a change's effects, then follows again and ticks; raises a failure afterwards. */
  async function carryOut(effects: readonly Effect[], overwriteUnreadable: boolean): Promise<void> {
    const outcome = await execute(effects, overwriteUnreadable);
    refollow();
    await runTick();
    raise(outcome);
  }

  // ---- snapshot -------------------------------------------------------------------------------

  function deviceLiveness(deviceId: string, nowMs: number): Liveness {
    const state = inbox.states.get(deviceId);
    const transport = transports[transportOf(deviceId)];
    if (state === undefined || transport?.linkUp() !== true) return "unknown";
    return liveness(state, nowMs, VALVE_SILENT_AFTER_MS);
  }

  function storeProblems(): Problem[] {
    return STORE_NAMES.filter((name) => storeFailed[name] === true).map((name) =>
      problemStoreWriteFailed(name),
    );
  }

  /** The label problems Home Assistant shows, while the house is live and the config readable. */
  function haLabelProblems(house: HouseInput, readable: StoredConfig | undefined): Problem[] {
    if (ha === undefined || house.kind !== "live" || readable === undefined) return [];
    const snapshot = ha.snapshot();
    if (snapshot === undefined) return [];
    const infos = sensorInfos(ha, snapshot, valveAddresses());
    const contacts = contactInfos(ha, snapshot, configuredContacts(readable.config));
    return [...labelProblems(readable.config, house.membership, snapshot, infos, contacts)];
  }

  function makeSnapshot(): Snapshot {
    const nowMs = clock.nowMs();
    const readable = readableStored();
    const kinds = currentMemberships();
    const membershipRecord: Record<string, Membership> = {};
    for (const [id, kind] of sorted(kinds, ([id]) => id)) membershipRecord[id] = kind;

    const house = houseInput();
    const listing = { transportFaults: faults(), deviceLists: deviceLists() };
    const stranded = [...kinds]
      .filter(
        ([id, kind]) =>
          kind === "managed" && strandedValve(house, id, transportListed(listing, id)),
      )
      .map(([id]) => id)
      .sort();
    const membership = house.kind === "unlinked" ? stored?.membership : house.membership;
    const config = readable?.config ?? EMPTY_CONFIG;
    const resolved = resolveRooms(config, membership);
    const resolvedById = new Map(resolved.rooms.map((room) => [room.id, room]));
    const managed = new Set((roomsOf(configState, stored, house) ?? []).map((room) => room.id));
    const rooms: RoomSnapshot[] = sorted(membership?.rooms ?? [], ([id]) => id).map(
      ([areaId, area]) => {
        const room = resolvedById.get(areaId);
        const scheduleId = room?.scheduleId;
        const sensors = room?.sensors ?? config.rooms.get(areaId)?.sensors ?? [];
        return {
          roomId: areaId,
          name: area.name,
          managed: managed.has(areaId),
          scheduleId,
          scheduleName: config.schedules.find((schedule) => schedule.id === scheduleId)?.name,
          valveIds: area.valveIds,
          sensorIds: sensors.map((sensor) => sensorId(sensor)),
          window: room?.window,
          status: lastTick?.rooms.get(areaId),
        };
      },
    );

    const devices: DeviceSnapshot[] = [];
    for (const key of keys) {
      const transport = transports[key];
      if (transport === undefined) continue;
      for (const info of transport.devices().values()) {
        const state = inbox.states.get(info.deviceId);
        devices.push({
          deviceId: info.deviceId,
          transport: key,
          name: info.name,
          modelId: info.modelId,
          manufacturer: info.manufacturer,
          firmware: info.firmware,
          supported: findProfile(info.modelId, key) !== undefined,
          membership: kinds.get(info.deviceId),
          liveness: deviceLiveness(info.deviceId, nowMs),
          observed: state?.messageAt !== undefined,
          heardAt: state?.heardAt,
        });
      }
    }
    devices.sort((a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0));

    const unassigned: UnassignedValve[] = [];
    for (const device of devices) {
      if (!device.supported || !isFollowed(device.deviceId)) continue;
      if (device.membership !== undefined && device.membership !== "orphan") continue;
      unassigned.push({
        valveId: device.deviceId,
        name: device.name,
        observed: device.observed,
        liveness: device.liveness,
        heardAt: device.heardAt,
        values: describeValues(inbox.states.get(device.deviceId)),
        reason: house.kind === "live" ? accepted?.unplaced.get(device.deviceId) : undefined,
      });
    }

    const refs = roomSensors(readable?.config);
    const { sensors: readings, unobservable } = readSensors(refs, nowMs);
    const sensors: SensorSnapshot[] = refs.map((sensor) => {
      const id = sensorId(sensor);
      const reading = readings.get(id);
      const entity = entityOf(sensor.ref);
      return {
        sensorId: id,
        ref: sensor.ref,
        name: (entity === undefined ? undefined : ha?.entityName(entity)) ?? sensor.ref,
        celsius: reading?.value,
        seenAt: reading?.seenAt,
        pending: reading?.pending === true,
        unobservable: unobservable.has(id),
      };
    });

    const problems: Problem[] = [
      ...(lastTick?.problems ?? []),
      ...storeProblems(),
      ...(pacingUnreadableUntil !== undefined && clock.nowMs() < pacingUnreadableUntil
        ? [problemPacingUnreadable()]
        : []),
      ...(tickError === undefined ? [] : [problemTickFailed()]),
      // Label write problems belong to the live house: while the link is down or the config is
      // unreadable no mirror runs that could clear them.
      ...(house.kind === "live" && readable !== undefined ? (labelSync?.problems() ?? []) : []),
      ...haLabelProblems(house, readable),
    ];
    // After every problem is in: the label problems name areas.
    const areaNames: Record<string, string> = {};
    for (const { subject } of problems) {
      const name = subject.kind === "area" ? ha?.areaName(subject.id) : undefined;
      if (name !== undefined) areaNames[subject.id] = name;
    }

    return {
      revision: readable?.revision ?? 0,
      configState,
      house: house.kind,
      houseFrozenReason: house.kind === "frozen" ? house.reason : undefined,
      ledgerReadable: ledger !== undefined,
      originalsCopyRecords: copyRecords,
      held: heldNow(),
      language: readable?.config.settings.language ?? "en",
      timeZone: lastTick?.timeZone ?? zone(),
      tickedAt: lastTick?.tickedAt,
      rooms,
      unusedEntries: resolved.unused,
      haChanges: readable?.haChanges ?? [],
      upgrade: readable?.upgrade,
      problems,
      memberships: membershipRecord,
      stranded,
      devices,
      unassigned,
      pending: lastTick?.pending ?? [],
      sensors,
      links: linkStates(),
      transportFaults: faults(),
      areaNames,
      schedules: config.schedules.map(({ id, name }) => ({ id, name })),
    };
  }

  // ---- diagnostics ----------------------------------------------------------------------------

  function memoryDiagnostics(nowMs: number): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [valveId, vm] of sorted(inbox.memory.valves, ([id]) => id)) {
      const marks: Record<string, unknown> = {};
      const writes: Record<string, number> = {};
      for (const [group, gm] of Object.entries(vm.groups) as [Group, (typeof vm.groups)[Group]][]) {
        if (gm === undefined) continue;
        if (gm.mark !== undefined) marks[group] = { ...gm.mark };
        writes[group] = gm.writes.filter((w) => nowMs - w.at <= 24 * HOUR_MS).length;
      }
      result[valveId] = {
        tokens: vm.tokens,
        tokensAt: vm.tokensAt,
        lastWriteAt: vm.lastWriteAt,
        marks,
        writes24h: writes,
        asks: [...vm.asks],
        lastPushAt: vm.lastPushAt,
        feedValue: vm.feedValue,
        feedAt: vm.feedAt,
      };
    }
    return result;
  }

  function diagnostics(): Readonly<Record<string, unknown>> {
    const nowMs = clock.nowMs();
    const snapshot = makeSnapshot();
    const devices: Record<string, unknown> = {};
    for (const ids of followed.values()) {
      for (const id of sorted(ids, (x) => x)) {
        const found = listed(id);
        const state = inbox.states.get(id);
        devices[id] = {
          info: found?.info,
          liveness: deviceLiveness(id, nowMs),
          heardAt: state?.heardAt,
          messageAt: state?.messageAt,
          values: describeValues(state),
          readings: state === undefined ? undefined : { ...state.readings },
          payload: lastPayloads.get(id),
        };
      }
    }
    const sensors: Record<string, unknown> = {};
    for (const sensor of snapshot.sensors) {
      sensors[sensor.sensorId] = { ...sensor };
    }
    let previewed: unknown;
    try {
      previewed = previewWrites(buildWorld(nowMs)).map((write) => ({
        valveId: write.valveId,
        values: Object.fromEntries(
          Object.entries(write.values).map(([key, value]) => [
            key,
            describeValue(key as SettingKey, value),
          ]),
        ),
        current: Object.fromEntries(
          Object.entries(write.current).map(([key, value]) => [
            key,
            describeValue(key as SettingKey, value),
          ]),
        ),
      }));
    } catch (error) {
      previewed = { error: String(error) };
    }
    const result = {
      revision: snapshot.revision,
      configState,
      config: stored === undefined ? undefined : storedToRaw(stored),
      ledger: ledger === undefined ? undefined : ledgerToRaw(ledger),
      memberships: snapshot.memberships,
      devices,
      sensors,
      memory: memoryDiagnostics(nowMs),
      house: snapshot.house,
      houseFrozenReason: snapshot.houseFrozenReason,
      rooms: snapshot.rooms,
      unusedEntries: snapshot.unusedEntries,
      problems: snapshot.problems,
      preview: previewed,
      links: snapshot.links,
      transports: keys.map((key) => ({
        key,
        fault: transports[key]?.fault(),
        link: transports[key]?.linkUp() === true,
      })),
      ha:
        ha === undefined ? undefined : { state: ha.state(), ready: ha.ready(), house: ha.house() },
      timeZone: snapshot.timeZone,
    };
    // One plain JSON value: no undefined, no Map, nothing shared with the runtime's state.
    return JSON.parse(JSON.stringify(result)) as Readonly<Record<string, unknown>>;
  }

  // ---- the public value -----------------------------------------------------------------------

  return {
    async start() {
      if (started) return;
      const loaded = await deps.configStore.load();
      configState = loaded.state;
      stored = loaded.stored;
      if (loaded.state === "unreadable") {
        log.error("the config cannot be read", { reason: loaded.reason });
      }
      if (loaded.convertedFrom !== undefined && stored !== undefined) {
        log.info("config converted", { fromVersion: loaded.convertedFrom });
        // Saved once: the file holds version 3 from now on (the store keeps the original's copy).
        await execute([{ kind: "saveConfig", stored }], false);
      }
      // A ledger file is expected when the stored state implies records.
      const expected =
        configState === "unreadable" ||
        (stored !== undefined &&
          ([...(stored.membership?.rooms.values() ?? [])].some(
            (room) => room.valveIds.length > 0,
          ) ||
            stored.releasing.size > 0));
      ledger = await deps.ledgerStore.load(expected);
      copyRecords = await deps.ledgerStore.copyRecords();
      // A fresh install (R5): no config file, no ledger record, none in the copy. It starts with
      // writes held, saved before the first tick.
      if (configState === "empty" && ledger?.records.size === 0 && copyRecords === 0) {
        log.info("a fresh install: the empty config is saved with writes held");
        await execute([{ kind: "saveConfig", stored: FRESH_STORED }], false);
      }
      // Before the first tick: what a valve may still be sent comes from the last run.
      const pacing = await deps.pacingStore.load();
      const startedAt = clock.nowMs();
      const unreadable = pacing.state === "unreadable";
      const emptyAt = startedAt + BUCKET * REFILL_MS;
      // A file that cannot be read may have held a free ask: every valve counts as asked now.
      buckets = {
        stamps: pacing.stamps,
        fallback: unreadable ? emptyAt : 0,
        freeAsks: pacing.freeAsks,
        ...(unreadable ? { freeAskFallback: startedAt } : {}),
      };
      persisted = unreadable ? undefined : { stamps: pacing.stamps, freeAsks: pacing.freeAsks };
      pacingUnreadableUntil = unreadable ? emptyAt : undefined;
      if (unreadable) log.error("the saved write budget cannot be read; every valve starts empty");
      // R10: while the room states cannot be read, no mode or setpoint is written.
      const state = await deps.thermostatStore.load();
      thermostats = state.state === "ok" ? state.thermostats : undefined;
      if (thermostats === undefined) {
        log.error("the saved room states cannot be read; no mode or setpoint is written", {
          reason: state.reason,
        });
      }
      started = true;
      stopping = false;
      // The first tick below sees every event that arrives before it begins: none needs a debounce.
      tickQueued = true;
      try {
        // Nothing waits for Home Assistant or for a replay. After a restart a valve is left alone
        // until its first message; the tick asks it to report. The feed gap this leaves: with
        // sensors through Home Assistant, a room is fresh as soon as the link is up and the
        // sensor's newest report is under the 120-min staleness, so the gap is 30 min since the
        // last heartbeat push plus the downtime plus the time until the valve answers.
        ha?.start(onHaEvent);
        for (const key of keys) {
          await transports[key]?.start((event) => {
            onTransportEvent(key, event);
          });
        }
        refollow();
        await withLock(async () => {
          tickQueued = false;
          await runTick();
        });
      } catch (error) {
        tickQueued = false;
        throw error;
      }
      if (!isStopping()) {
        cancelInterval = clock.every(TICK_INTERVAL_MS, () => {
          queueTick();
        });
      }
    },

    async stop() {
      if (!started || stopping) return;
      stopping = true;
      cancelTimers();
      await withLock(() => Promise.resolve());
      cancelTimers();
      queue.length = 0;
      acceptedLive = false;
      await ha?.stop();
      for (const key of keys) await transports[key]?.stop();
      started = false;
    },

    snapshot: makeSnapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    apply(raw, options) {
      if (!started || stopping) return Promise.reject(notStarted());
      return withLock(async () => {
        requireStarted();
        const result = await plan(raw, options, false);
        const outcome = await execute(result.effects, options.overwriteUnreadable);
        refollow();
        await runTick();
        if (outcome.stores.config === true) mirrorApplied();
        raise(outcome);
        return result;
      });
    },

    preview(raw, options) {
      if (!started || stopping) return Promise.reject(notStarted());
      return withLock(async () => {
        requireStarted();
        return plan(raw, options, true);
      });
    },

    exportConfig() {
      requireStarted();
      if (configState === "unreadable" || (configState === "ok" && stored === undefined)) {
        throw new HeatmasterError("config_unreadable");
      }
      if (stored === undefined) return { revision: 0, config: configToRaw(EMPTY_CONFIG) };
      return { revision: stored.revision, config: configToRaw(stored.config) };
    },

    resync(roomId) {
      // Thrown inside the executor, a failure becomes the rejection.
      return new Promise<void>((resolve) => {
        requireStarted();
        let valveIds: string[];
        if (roomId === undefined) {
          valveIds = [...currentMemberships().keys()];
        } else {
          const rooms: readonly Room[] = roomsOf(configState, stored, houseInput()) ?? [];
          const room = rooms.find((r) => r.id === roomId);
          if (room === undefined) throw new HeatmasterError("room_unknown", { roomId });
          valveIds = room.valves.map((v) => v.valveId);
        }
        applyCore({ kind: "resync_requested", valveIds: new Set(valveIds) }, clock.nowMs());
        requestTick();
        resolve();
      });
    },

    async refreshValve(valveId) {
      requireStarted();
      try {
        await directAsk(valveId);
      } catch (error) {
        if (codeOf(error) === "ask_limited") {
          log.warn("a direct ask was refused by its limit", { valveId });
        }
        throw error;
      }
    },

    restoreValve(valveId) {
      if (!started || stopping) return Promise.reject(notStarted());
      return withLock(async () => {
        requireStarted();
        const effects = coreRestoreValve(buildWorld(clock.nowMs()), valveId);
        await carryOut(effects, false);
      });
    },

    forgetValve(valveId) {
      if (!started || stopping) return Promise.reject(notStarted());
      return withLock(async () => {
        requireStarted();
        const effects = coreForgetValve(buildWorld(clock.nowMs()), valveId);
        await carryOut(effects, false);
      });
    },

    importOriginals(acceptEmpty) {
      if (!started || stopping) return Promise.reject(notStarted());
      return withLock(async () => {
        requireStarted();
        ledger = await deps.ledgerStore.importCopy(acceptEmpty);
        copyRecords = await deps.ledgerStore.copyRecords();
        refollow();
        await runTick();
      });
    },

    acceptOriginals(valveId) {
      if (!started || stopping) return Promise.reject(notStarted());
      return withLock(async () => {
        requireStarted();
        const effects = acceptUnknownOriginals(buildWorld(clock.nowMs()), valveId);
        await carryOut(effects, false);
      });
    },

    dismissUpgrade() {
      if (!started || stopping) return Promise.reject(notStarted());
      return withLock(async () => {
        requireStarted();
        const current = readableStored();
        if (current === undefined) return;
        const next = withoutUpgradeReport(current);
        if (next === current) return;
        const outcome = await execute([{ kind: "saveConfig", stored: next }], false);
        notify();
        raise(outcome);
      });
    },

    setHold(on) {
      if (!started || stopping) return Promise.reject(notStarted());
      return withLock(async () => {
        requireStarted();
        if (configState === "unreadable" || (configState === "ok" && stored === undefined)) {
          throw new HeatmasterError("config_unreadable");
        }
        if (stored === undefined) {
          if (on) return;
          throw new HeatmasterError("config_missing");
        }
        const next = withHold(stored, on);
        if (next === stored) {
          if (forcedHold) {
            forcedHold = false;
            await runTick();
          }
          return;
        }
        const outcome = await execute([{ kind: "saveConfig", stored: next }], false);
        if (outcome.error === undefined) forcedHold = false;
        else if (on) forcedHold = true;
        await runTick();
        raise(outcome);
      });
    },

    roomCommand(roomId, command, origin) {
      if (!started || stopping) return Promise.reject(notStarted());
      return withLock(async () => {
        requireStarted();
        const effects = thermostatCommand(buildWorld(clock.nowMs()), roomId, command, origin);
        await carryOut(effects, false);
      });
    },

    roomChoice(roomId, choice) {
      if (!started || stopping) return Promise.reject(notStarted());
      return withLock(async () => {
        requireStarted();
        const current = readableStored();
        if (current === undefined) throw new ChangeRefused("config_unreadable");
        const next = withRoomChoice(current, roomId, choice, clock.nowMs());
        if (next === current) return;
        const outcome = await execute([{ kind: "saveConfig", stored: next }], false);
        refollow();
        await runTick();
        if (outcome.stores.config === true) mirrorApplied();
        raise(outcome);
      });
    },

    resetThermostats() {
      if (!started || stopping) return Promise.reject(notStarted());
      return withLock(async () => {
        requireStarted();
        if (thermostats !== undefined) throw new HeatmasterError("state_readable");
        await deps.thermostatStore.reset();
        thermostats = EMPTY_THERMOSTAT_STATE;
        storeFailed.state = false;
        await runTick();
      });
    },

    diagnostics,

    /** Also waits for an armed debounce: its tick counts as waiting to run. */
    settled() {
      if (busy === 0 && cancelDebounce === undefined) return Promise.resolve();
      return new Promise<void>((resolve) => idle.push(resolve));
    },
  };
}
