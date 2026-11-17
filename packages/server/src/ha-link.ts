/**
 * The optional Home Assistant link: the house's settings, the registries and the states of the room
 * sensors, over Home Assistant's websocket and, for liveness, its REST API. Its only writes are the
 * five label commands of `writeLabels` (`LABEL_COMMANDS`). It never calls a service and is never
 * used for valves.
 */

import type { HaArea, HaEntity, HaSnapshot, LabelOp, SensorInfo } from "@heatmaster/core";
import {
  createConnection,
  createLongLivedTokenAuth,
  ERR_INVALID_AUTH,
  isConnectionLost,
  type Connection,
} from "home-assistant-js-websocket";
import type { Clock } from "./clock.ts";

/** `url` is Home Assistant's base address; the library adds `/api/websocket`, REST is `<url>/api`. */
export type HaOptions = Readonly<{ url: string; token: string }> | undefined;

export const HA_POLL_MS = 2 * 60 * 1000;
export const HA_RETRY_MS = 5 * 1000;
export const Z2M_IDENTIFIER_PREFIX = "zigbee2mqtt_";
const HA_REQUEST_TIMEOUT_MS = 10 * 1000;
/** How long a label write, or a registry reload of the write queue, waits for its answer. */
export const HA_LABEL_TIMEOUT_MS = 10 * 1000;

export type HaLinkState = "connecting" | "up" | "down" | "auth_invalid";
export type HaHouse = Readonly<{ timeZone: string; language: string }>;
export type HaSensor = Readonly<{
  celsius: number | undefined;
  lastReportedAt: number | undefined;
  observable: boolean;
}>;
export type HaEvent =
  | Readonly<{ kind: "link_up" }>
  | Readonly<{ kind: "link_down" }>
  | Readonly<{ kind: "changed" }>
  | Readonly<{ kind: "registries_changed" }>;

/**
 * What a `writeLabels` batch did. `error` is Home Assistant's error code (`unauthorized`,
 * `invalid_info`, …), `link_down`, `timeout`, `not_found` (the link knows no such area or entity)
 * or `label_clash` (a create was answered with another id). `created` maps each created name to
 * the `label_id` Home Assistant answered.
 */
export type LabelWriteResult = Readonly<{
  done: readonly LabelOp[];
  failed: readonly Readonly<{ op: LabelOp; error: string }>[];
  created: ReadonlyMap<string, string>;
}>;

export type HaLog = Readonly<{
  warn(message: string, data?: Readonly<Record<string, unknown>>): void;
}>;

export type HaLink = Readonly<{
  start(listener: (event: HaEvent) => void): void;
  stop(): Promise<void>;
  state(): HaLinkState;
  up(): boolean;
  ready(): boolean;
  house(): HaHouse | undefined;
  watch(entityIds: ReadonlySet<string>): void;
  sensor(entityId: string): HaSensor | undefined;
  sensorInfo(entityId: string, valveAddresses: ReadonlySet<string>): SensorInfo;
  entityName(entityId: string): string | undefined;
  areaName(areaId: string): string | undefined;
  /** Areas, device areas and labels as loaded; undefined before `ready()`, the last value while down. */
  snapshot(): HaSnapshot | undefined;
  /** Sends the ops to Home Assistant, in order; never rejects. */
  writeLabels(ops: readonly LabelOp[]): Promise<LabelWriteResult>;
}>;

const consoleLog: HaLog = {
  warn(message, data) {
    console.warn(JSON.stringify({ level: "warn", component: "ha-link", msg: message, ...data }));
  },
};

type Raw = Readonly<Record<string, unknown>>;

type EntityEntry = Readonly<{
  deviceId: string | undefined;
  areaId: string | undefined;
  labels: readonly string[];
  disabled: boolean;
  name: string | undefined;
  originalName: string | undefined;
}>;
type DeviceEntry = Readonly<{
  identifiers: readonly (readonly [string, string])[];
  areaId: string | undefined;
}>;
type AreaEntry = HaArea;
type StateRecord = Readonly<{
  state: string;
  unit: string | undefined;
  deviceClass: string | undefined;
  friendlyName: string | undefined;
  reportedAt: number | undefined;
}>;
type Kept = Readonly<{ celsius: number | undefined; lastReportedAt: number | undefined }>;
type RegistryKind = "config" | "entities" | "devices" | "areas" | "labels";

const EVENT_TYPES: readonly [string, RegistryKind | "state"][] = [
  ["state_changed", "state"],
  ["entity_registry_updated", "entities"],
  ["device_registry_updated", "devices"],
  ["area_registry_updated", "areas"],
  ["label_registry_updated", "labels"],
  ["core_config_updated", "config"],
];

/** The only writes the link ever sends, one per `LabelOp` kind. */
const LABEL_COMMANDS: Readonly<Record<LabelOp["kind"], string>> = {
  createLabel: "config/label_registry/create",
  renameLabel: "config/label_registry/update",
  deleteLabel: "config/label_registry/delete",
  labelArea: "config/area_registry/update",
  labelEntity: "config/entity_registry/update",
};

/** The registries a label batch reloads at its end; their events during the batch fold into it. */
const BATCH_REGISTRIES: readonly RegistryKind[] = ["labels", "areas", "entities"];
/** The registries a label batch reloads before its first op, for the labels R17 merges with. */
const PRE_BATCH_REGISTRIES: readonly RegistryKind[] = ["areas", "entities"];

const LINK_DOWN = "link_down";
const TIMEOUT = "timeout";
const LABEL_CLASH = "label_clash";
const NOT_FOUND = "not_found";
const UNKNOWN_ERROR = "unknown_error";
/** What a timed command rejects with when it gives up. */
const TIMED_OUT = new Error("no answer within HA_LABEL_TIMEOUT_MS");

/** The code of a failed command: Home Assistant's own, `link_down` or `timeout`. */
function errorCode(error: unknown): string {
  if (error === TIMED_OUT) return TIMEOUT;
  if (isConnectionLost(error)) return LINK_DOWN;
  if (isRecord(error) && typeof error.code === "string") return error.code;
  return UNKNOWN_ERROR;
}

/** The labels a target wears after the op: `remove` dropped, `add` added, sorted (R17). */
function merged(
  current: readonly string[],
  add: readonly string[],
  remove: readonly string[],
): string[] {
  return [...new Set([...current.filter((label) => !remove.includes(label)), ...add])].sort();
}

/** The labels an op relies on: a create earlier in its batch may have failed to give one. */
function reliesOn(op: LabelOp): readonly string[] {
  switch (op.kind) {
    case "renameLabel":
      return [op.labelId];
    case "labelArea":
    case "labelEntity":
      return op.add;
    default:
      return [];
  }
}

/** A websocket command as sent, without its id. */
type Command = Readonly<{ type: string } & Record<string, unknown>>;

type Job =
  | Readonly<{ kind: "reload"; registry: RegistryKind }>
  | Readonly<{ kind: "batch"; run: () => Promise<void> }>;

const REGISTRY_COMMANDS: Readonly<Record<Exclude<RegistryKind, "config">, string>> = {
  entities: "config/entity_registry/list",
  devices: "config/device_registry/list",
  areas: "config/area_registry/list",
  labels: "config/label_registry/list",
};

function isRecord(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function list(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what} is not a list`);
  return value as unknown[];
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? (value as unknown[]).filter((item): item is string => typeof item === "string")
    : [];
}

function parseConfig(raw: unknown): HaHouse {
  if (!isRecord(raw)) throw new Error("get_config answered no object");
  const timeZone = text(raw.time_zone);
  const language = text(raw.language);
  if (timeZone === undefined || language === undefined) {
    throw new Error("get_config has no time_zone or language");
  }
  return { timeZone, language };
}

function parseEntities(raw: unknown): ReadonlyMap<string, EntityEntry> {
  const map = new Map<string, EntityEntry>();
  for (const item of list(raw, "the entity registry")) {
    if (!isRecord(item)) continue;
    const id = text(item.entity_id);
    if (id === undefined) continue;
    map.set(id, {
      deviceId: text(item.device_id),
      areaId: text(item.area_id),
      labels: strings(item.labels),
      disabled: typeof item.disabled_by === "string",
      name: text(item.name),
      originalName: text(item.original_name),
    });
  }
  return map;
}

function parseDevices(raw: unknown): ReadonlyMap<string, DeviceEntry> {
  const map = new Map<string, DeviceEntry>();
  for (const item of list(raw, "the device registry")) {
    if (!isRecord(item)) continue;
    const id = text(item.id);
    if (id === undefined) continue;
    const identifiers: (readonly [string, string])[] = [];
    if (Array.isArray(item.identifiers)) {
      for (const pair of item.identifiers as unknown[]) {
        if (!Array.isArray(pair)) continue;
        const [a, b] = pair as unknown[];
        if (typeof a === "string" && typeof b === "string") identifiers.push([a, b]);
      }
    }
    map.set(id, { identifiers, areaId: text(item.area_id) });
  }
  return map;
}

function parseAreas(raw: unknown): ReadonlyMap<string, AreaEntry> {
  const map = new Map<string, AreaEntry>();
  for (const item of list(raw, "the area registry")) {
    if (!isRecord(item)) continue;
    const id = text(item.area_id);
    const name = text(item.name);
    if (id !== undefined && name !== undefined) map.set(id, { name, labels: strings(item.labels) });
  }
  return map;
}

function parseLabels(raw: unknown): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const item of list(raw, "the label registry")) {
    if (!isRecord(item)) continue;
    const id = text(item.label_id);
    const name = text(item.name);
    if (id !== undefined && name !== undefined) map.set(id, name);
  }
  return map;
}

/** `z2m:<address>` for a device that Zigbee2MQTT announced to Home Assistant. */
function valveIdOf(device: DeviceEntry): string | undefined {
  for (const [domain, value] of device.identifiers) {
    if (domain === "mqtt" && value.startsWith(Z2M_IDENTIFIER_PREFIX)) {
      return `z2m:${value.slice(Z2M_IDENTIFIER_PREFIX.length)}`;
    }
  }
  return undefined;
}

function buildSnapshot(
  entities: ReadonlyMap<string, EntityEntry>,
  devices: ReadonlyMap<string, DeviceEntry>,
  areas: ReadonlyMap<string, AreaEntry>,
  labels: ReadonlyMap<string, string>,
): HaSnapshot {
  const valveAreas = new Map<string, string | null>();
  for (const device of devices.values()) {
    const valveId = valveIdOf(device);
    if (valveId !== undefined) valveAreas.set(valveId, device.areaId ?? null);
  }
  const held = new Map<string, HaEntity>();
  for (const [id, entry] of entities) {
    const deviceArea =
      entry.deviceId === undefined ? undefined : devices.get(entry.deviceId)?.areaId;
    held.set(id, { areaId: entry.areaId ?? deviceArea, labels: entry.labels });
  }
  return { areas, valveAreas, entities: held, labels };
}

function snapshotKey(value: HaSnapshot): string {
  return JSON.stringify([
    [...value.areas],
    [...value.valveAreas],
    [...value.entities],
    [...value.labels],
  ]);
}

function parseTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}

/** A full state object; `last_reported` is missing from some, then `last_updated` stands in. */
function parseState(raw: unknown): { entityId: string; record: StateRecord } | undefined {
  if (!isRecord(raw)) return undefined;
  const entityId = text(raw.entity_id);
  const state = text(raw.state);
  if (entityId === undefined || state === undefined) return undefined;
  const attributes = isRecord(raw.attributes) ? raw.attributes : {};
  return {
    entityId,
    record: {
      state,
      unit: text(attributes.unit_of_measurement),
      deviceClass: text(attributes.device_class),
      friendlyName: text(attributes.friendly_name),
      reportedAt: parseTime(raw.last_reported) ?? parseTime(raw.last_updated),
    },
  };
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** The state text as °C; nothing is rounded. */
function toCelsius(record: StateRecord): number | undefined {
  if (!NUMBER.test(record.state)) return undefined;
  const value = Number(record.state);
  if (!Number.isFinite(value)) return undefined;
  switch (record.unit) {
    case "°C":
      return value;
    case "°F":
      return ((value - 32) * 5) / 9;
    case "K":
      return value - 273.15;
    default:
      return undefined;
  }
}

function sameSensor(a: HaSensor | undefined, b: HaSensor | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.celsius === b.celsius &&
    a.lastReportedAt === b.lastReportedAt &&
    a.observable === b.observable
  );
}

export function createHaLink(
  options: NonNullable<HaOptions>,
  clock: Clock,
  log: HaLog = consoleLog,
): HaLink {
  const baseUrl = options.url.replace(/\/+$/, "");
  const stopController = new AbortController();

  let listener: ((event: HaEvent) => void) | undefined;
  let started = false;
  let stopped = false;
  let state: HaLinkState = "connecting";
  let loadedOnce = false;
  let house: HaHouse | undefined;
  let entities: ReadonlyMap<string, EntityEntry> = new Map();
  let devices: ReadonlyMap<string, DeviceEntry> = new Map();
  let areas: ReadonlyMap<string, AreaEntry> = new Map();
  let labels: ReadonlyMap<string, string> = new Map();
  let current: HaSnapshot | undefined;
  let snapshotSeen = "";
  let byDevice: ReadonlyMap<string, readonly string[]> = new Map();
  // Private and changed in place: one websocket event must not copy the whole house.
  let states = new Map<string, StateRecord>();
  let watched: ReadonlySet<string> = new Set();
  const kept = new Map<string, Kept>();
  let view: ReadonlyMap<string, HaSensor> = new Map();
  const warnedNoDevice = new Set<string>();

  let connection: Connection | undefined;
  let loadId = 0;
  let cancelRetry: (() => void) | undefined;
  let cancelPoll: (() => void) | undefined;
  let polling = false;
  // A subscription is recorded when it is asked for, not when it is answered: the library renews
  // one that was in flight when the connection dropped, so asking again would double it.
  const subscriptions = new Map<string, Promise<unknown>>();
  const pendingReloads = new Set<RegistryKind>();
  // One queue holds registry reloads and label batches; one job runs at a time.
  const jobs: Job[] = [];
  let working = false;
  // The registries whose events the running batch's final reload takes in.
  const folded = new Set<RegistryKind>();

  function emit(event: HaEvent): void {
    if (!stopped) listener?.(event);
  }

  function registriesChanged(): void {
    if (state === "up") emit({ kind: "registries_changed" });
  }

  function changed(): void {
    if (state === "up") emit({ kind: "changed" });
  }

  function reindex(): void {
    const index = new Map<string, string[]>();
    for (const [id, entry] of entities) {
      if (entry.deviceId === undefined) continue;
      const members = index.get(entry.deviceId);
      if (members === undefined) index.set(entry.deviceId, [id]);
      else members.push(id);
    }
    byDevice = index;
  }

  /** The entities whose `last_reported` says whether this sensor is alive, itself included. */
  function deviceMembers(entityId: string): readonly string[] {
    const deviceId = entities.get(entityId)?.deviceId;
    if (deviceId === undefined) return [entityId];
    const members = (byDevice.get(deviceId) ?? []).filter(
      (id) => entities.get(id)?.disabled !== true,
    );
    return members.includes(entityId) ? members : [...members, entityId];
  }

  function computeSensor(entityId: string): HaSensor | undefined {
    const own = states.get(entityId);
    if (own === undefined) return undefined;
    const before = kept.get(entityId);
    const celsius = toCelsius(own) ?? before?.celsius;
    let newest: number | undefined;
    for (const member of deviceMembers(entityId)) {
      const record = states.get(member);
      if (record === undefined || record.state === "unavailable") continue;
      if (record.reportedAt === undefined) continue;
      newest = newest === undefined ? record.reportedAt : Math.max(newest, record.reportedAt);
    }
    const previous = before?.lastReportedAt;
    const lastReportedAt =
      newest === undefined
        ? previous
        : previous === undefined
          ? newest
          : Math.max(previous, newest);
    kept.set(entityId, { celsius, lastReportedAt });
    const observable = entities.get(entityId)?.deviceId !== undefined;
    if (!observable && !warnedNoDevice.has(entityId)) {
      warnedNoDevice.add(entityId);
      log.warn("the sensor entity has no device; it is used as if it were live", { entityId });
    }
    return { celsius, lastReportedAt, observable };
  }

  /** Recomputes every watched sensor; true when any of them differs from before. */
  function refresh(): boolean {
    const next = new Map<string, HaSensor>();
    let differs = false;
    for (const id of watched) {
      const sensor = computeSensor(id);
      if (sensor !== undefined) next.set(id, sensor);
      if (!sameSensor(sensor, view.get(id))) differs = true;
    }
    view = next;
    return differs;
  }

  function setLinkState(next: HaLinkState): void {
    state = next;
  }

  function isStopped(): boolean {
    return stopped;
  }

  /** The state read anew: an await may have changed it. */
  function isUp(): boolean {
    return state === "up";
  }

  function stale(id: number): boolean {
    return stopped || id !== loadId;
  }

  // ---- REST ----------------------------------------------------------------------------------

  async function fetchOne(entityId: string): Promise<StateRecord | null | undefined> {
    try {
      const response = await fetch(`${baseUrl}/api/states/${encodeURIComponent(entityId)}`, {
        headers: { Authorization: `Bearer ${options.token}` },
        signal: AbortSignal.any([
          stopController.signal,
          AbortSignal.timeout(HA_REQUEST_TIMEOUT_MS),
        ]),
      });
      if (response.status === 404) return null;
      if (!response.ok) {
        log.warn("a state request failed", { entityId, status: response.status });
        return undefined;
      }
      const parsed = parseState(await response.json());
      if (parsed?.entityId !== entityId) {
        log.warn("a state request answered something else", { entityId });
        return undefined;
      }
      return parsed.record;
    } catch (error) {
      if (!stopped) log.warn("a state request failed", { entityId, error: String(error) });
      return undefined;
    }
  }

  /** Asks for the states of these entities; nothing changes for one that fails. */
  async function fetchStates(ids: ReadonlySet<string>): Promise<void> {
    if (ids.size === 0) return;
    const answers = await Promise.all(
      [...ids].map(async (id) => [id, await fetchOne(id)] as const),
    );
    if (stopped || state !== "up") return;
    for (const [id, answer] of answers) {
      if (answer === null) {
        states.delete(id);
        continue;
      }
      if (answer === undefined) continue;
      // An event that arrived while the request was in flight is newer than this answer.
      const known = states.get(id)?.reportedAt;
      if (known !== undefined && answer.reportedAt !== undefined && answer.reportedAt < known) {
        continue;
      }
      states.set(id, answer);
    }
    if (refresh()) changed();
  }

  function entitiesToAsk(sensorIds: Iterable<string>): Set<string> {
    const ids = new Set<string>();
    for (const sensorId of sensorIds) for (const id of deviceMembers(sensorId)) ids.add(id);
    return ids;
  }

  async function poll(): Promise<void> {
    if (polling || state !== "up" || watched.size === 0) return;
    polling = true;
    try {
      await fetchStates(entitiesToAsk(watched));
    } finally {
      polling = false;
    }
  }

  // ---- loading -------------------------------------------------------------------------------

  function onStateChanged(event: unknown): void {
    if (!isRecord(event) || !isRecord(event.data)) return;
    const entityId = text(event.data.entity_id);
    if (entityId === undefined) return;
    if (event.data.new_state === null) states.delete(entityId);
    else {
      const parsed = parseState(event.data.new_state);
      if (parsed === undefined) return;
      states.set(entityId, parsed.record);
    }
    if (refresh()) changed();
  }

  function snapshot(kind: RegistryKind): string {
    switch (kind) {
      case "config":
        return JSON.stringify(house ?? null);
      case "entities":
        return JSON.stringify([...entities]);
      case "devices":
        return JSON.stringify([...devices]);
      case "areas":
        return JSON.stringify([...areas]);
      case "labels":
        return JSON.stringify([...labels]);
    }
  }

  /** Settles as `pending` does within HA_LABEL_TIMEOUT_MS, or rejects with TIMED_OUT. */
  function timed<T>(pending: Promise<T>): Promise<T> {
    let cancel: () => void = () => undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      cancel = clock.after(HA_LABEL_TIMEOUT_MS, () => {
        reject(TIMED_OUT);
      });
    });
    return Promise.race([pending, timeout]).finally(() => {
      cancel();
    });
  }

  async function fetchRegistry(
    conn: Connection,
    kind: RegistryKind,
    withTimeout = false,
  ): Promise<() => void> {
    const ask = (type: string): Promise<unknown> => {
      const pending = conn.sendMessagePromise<unknown>({ type });
      return withTimeout ? timed(pending) : pending;
    };
    switch (kind) {
      case "config": {
        const value = parseConfig(await ask("get_config"));
        return () => {
          house = value;
        };
      }
      case "entities": {
        const value = parseEntities(await ask(REGISTRY_COMMANDS.entities));
        return () => {
          entities = value;
        };
      }
      case "devices": {
        const value = parseDevices(await ask(REGISTRY_COMMANDS.devices));
        return () => {
          devices = value;
        };
      }
      case "areas": {
        const value = parseAreas(await ask(REGISTRY_COMMANDS.areas));
        return () => {
          areas = value;
        };
      }
      case "labels": {
        const value = parseLabels(await ask(REGISTRY_COMMANDS.labels));
        return () => {
          labels = value;
        };
      }
    }
  }

  /**
   * Reloads these registries, one after the other, each command timed out, and applies them
   * together: at most one event is sent. `answered` hears each registry as its answer arrives. A
   * failure is logged and changes nothing. Returns undefined, or the code of the failure.
   */
  async function reload(
    conn: Connection,
    kinds: readonly RegistryKind[],
    id: number,
    answered?: (kind: RegistryKind) => void,
  ): Promise<string | undefined> {
    try {
      const applies: (() => void)[] = [];
      for (const kind of kinds) {
        applies.push(await fetchRegistry(conn, kind, true));
        answered?.(kind);
      }
      if (stale(id) || state !== "up") return LINK_DOWN;
      const before = kinds.map(snapshot);
      const keyBefore = snapshotSeen;
      for (const apply of applies) apply();
      if (kinds.every((kind, i) => snapshot(kind) === before[i])) return undefined;
      reindex();
      refresh();
      const held = buildSnapshot(entities, devices, areas, labels);
      const key = snapshotKey(held);
      current = held;
      snapshotSeen = key;
      if (key === keyBefore) changed();
      else registriesChanged();
      return undefined;
    } catch (error) {
      if (stale(id)) return LINK_DOWN;
      log.warn("a registry reload failed", { kind: kinds.join(","), error: String(error) });
      return errorCode(error);
    }
  }

  // ---- the write queue -----------------------------------------------------------------------

  function enqueue(job: Job): void {
    const queued =
      job.kind === "reload" &&
      jobs.some((other) => other.kind === "reload" && other.registry === job.registry);
    if (!queued) jobs.push(job);
    void work();
  }

  async function work(): Promise<void> {
    if (working) return;
    working = true;
    try {
      for (let job = jobs.shift(); job !== undefined; job = jobs.shift()) {
        if (job.kind === "batch") await job.run();
        else if (connection !== undefined && state === "up") {
          // A reload the link missed while it was not up comes with the next loading.
          await reload(connection, [job.registry], loadId);
        }
      }
    } finally {
      working = false;
    }
  }

  /** Takes queued reloads of these registries out: the running batch does them. */
  function dropQueued(kinds: readonly RegistryKind[]): void {
    for (let i = jobs.length - 1; i >= 0; i -= 1) {
      const job = jobs[i];
      if (job?.kind === "reload" && kinds.includes(job.registry)) jobs.splice(i, 1);
    }
  }

  /** The message for one op, or the code it fails with unsent. */
  function messageFor(op: LabelOp, sent: ReadonlyMap<string, readonly string[]>): Command | string {
    const type = LABEL_COMMANDS[op.kind];
    switch (op.kind) {
      case "createLabel":
        return { type, name: op.name };
      case "renameLabel":
        return { type, label_id: op.labelId, name: op.name };
      case "deleteLabel":
        return { type, label_id: op.labelId };
      case "labelArea": {
        const current = sent.get(`area:${op.areaId}`) ?? areas.get(op.areaId)?.labels;
        if (current === undefined) return NOT_FOUND;
        return { type, area_id: op.areaId, labels: merged(current, op.add, op.remove) };
      }
      case "labelEntity": {
        const current = sent.get(`entity:${op.entityId}`) ?? entities.get(op.entityId)?.labels;
        if (current === undefined) return NOT_FOUND;
        return { type, entity_id: op.entityId, labels: merged(current, op.add, op.remove) };
      }
    }
  }

  /** One label batch; see `writeLabels`. */
  async function runBatch(ops: readonly LabelOp[]): Promise<LabelWriteResult> {
    const done: LabelOp[] = [];
    const failed: { op: LabelOp; error: string }[] = [];
    const created = new Map<string, string>();
    const conn = connection;
    const id = loadId;
    if (conn === undefined || state !== "up") {
      return { done, failed: ops.map((op) => ({ op, error: LINK_DOWN })), created };
    }
    for (const kind of BATCH_REGISTRIES) folded.add(kind);
    dropQueued(BATCH_REGISTRIES);
    try {
      // A fresh copy of the labels R17 merges with. Known limit: a user edit that lands between
      // this reload and the op is overwritten, because Home Assistant has no compare-and-set.
      const unloaded = await reload(conn, PRE_BATCH_REGISTRIES, id);
      // The labels each area and entity was last sent in this batch, keyed `area:`/`entity:`.
      const sent = new Map<string, readonly string[]>();
      // The labels whose create in this batch did not give them, with the create's error.
      const missing = new Map<string, string>();
      for (const op of ops) {
        const blocked =
          unloaded ??
          (stale(id) || !isUp() ? LINK_DOWN : undefined) ??
          reliesOn(op)
            .map((label) => missing.get(label))
            .find((error) => error !== undefined);
        if (blocked !== undefined) {
          failed.push({ op, error: blocked });
          continue;
        }
        const message = messageFor(op, sent);
        if (typeof message === "string") {
          failed.push({ op, error: message });
          continue;
        }
        let answer: unknown;
        try {
          answer = await timed(conn.sendMessagePromise<unknown>(message));
        } catch (error) {
          failed.push({ op, error: errorCode(error) });
          if (op.kind === "createLabel") missing.set(op.name, errorCode(error));
          continue;
        }
        if (op.kind === "createLabel") {
          const labelId = isRecord(answer) ? text(answer.label_id) : undefined;
          if (labelId !== undefined) created.set(op.name, labelId);
          if (labelId !== op.name) {
            // Another id (a `_2` of a taken one) is a numbered, foreign label: nothing may use it.
            const error = labelId === undefined ? UNKNOWN_ERROR : LABEL_CLASH;
            failed.push({ op, error });
            missing.set(op.name, error);
            continue;
          }
        }
        if (op.kind === "labelArea" || op.kind === "labelEntity") {
          const key = op.kind === "labelArea" ? `area:${op.areaId}` : `entity:${op.entityId}`;
          sent.set(key, message.labels as readonly string[]);
        }
        done.push(op);
      }
      if (!stale(id)) {
        const unreloaded = await reload(conn, BATCH_REGISTRIES, id, (kind) => folded.delete(kind));
        // The events folded into a reload that failed still need theirs.
        if (unreloaded !== undefined && !stale(id)) {
          for (const kind of BATCH_REGISTRIES) enqueue({ kind: "reload", registry: kind });
        }
      }
    } finally {
      folded.clear();
    }
    return { done, failed, created };
  }

  function onRegistryEvent(kind: RegistryKind): void {
    const conn = connection;
    if (conn === undefined || stopped) return;
    if (state !== "up") {
      pendingReloads.add(kind);
      return;
    }
    if (folded.has(kind)) return;
    enqueue({ kind: "reload", registry: kind });
  }

  async function subscribeAll(conn: Connection): Promise<void> {
    for (const [type, what] of EVENT_TYPES) {
      let pending = subscriptions.get(type);
      if (pending === undefined) {
        pending = conn.subscribeEvents(
          what === "state"
            ? onStateChanged
            : () => {
                onRegistryEvent(what);
              },
          type,
        );
        subscriptions.set(type, pending);
        // An error result means nothing was subscribed: the next loading asks again.
        pending.catch(() => subscriptions.delete(type));
      }
      await pending;
    }
  }

  async function load(conn: Connection, id: number): Promise<void> {
    try {
      await subscribeAll(conn);
      if (stale(id)) return;
      const applyConfig = await fetchRegistry(conn, "config");
      if (stale(id)) return;
      const applyEntities = await fetchRegistry(conn, "entities");
      if (stale(id)) return;
      const applyDevices = await fetchRegistry(conn, "devices");
      if (stale(id)) return;
      const applyAreas = await fetchRegistry(conn, "areas");
      if (stale(id)) return;
      const applyLabels = await fetchRegistry(conn, "labels");
      if (stale(id)) return;
      const raw = list(
        await conn.sendMessagePromise<unknown>({ type: "get_states" }),
        "get_states",
      );
      if (stale(id)) return;
      const loaded = new Map<string, StateRecord>();
      for (const item of raw) {
        const parsed = parseState(item);
        if (parsed !== undefined) loaded.set(parsed.entityId, parsed.record);
      }
      applyConfig();
      applyEntities();
      applyDevices();
      applyAreas();
      applyLabels();
      current = buildSnapshot(entities, devices, areas, labels);
      snapshotSeen = snapshotKey(current);
      states = loaded;
      reindex();
      refresh();
      loadedOnce = true;
      setLinkState("up");
      cancelPoll?.();
      cancelPoll = clock.every(HA_POLL_MS, () => {
        void poll();
      });
      emit({ kind: "link_up" });
      for (const kind of pendingReloads) enqueue({ kind: "reload", registry: kind });
      pendingReloads.clear();
    } catch (error) {
      if (stale(id)) return;
      log.warn("loading from Home Assistant failed", { error: String(error) });
      // A lost connection comes back through the library's `ready` event, which loads again.
      if (isConnectionLost(error) || !conn.connected) return;
      cancelRetry?.();
      cancelRetry = clock.after(HA_RETRY_MS, () => {
        cancelRetry = undefined;
        loadId += 1;
        void load(conn, loadId);
      });
    }
  }

  function beginLoad(conn: Connection): void {
    loadId += 1;
    cancelRetry?.();
    cancelRetry = undefined;
    void load(conn, loadId);
  }

  function onDisconnected(): void {
    loadId += 1;
    cancelRetry?.();
    cancelRetry = undefined;
    cancelPoll?.();
    cancelPoll = undefined;
    if (stopped) return;
    const wasUp = state === "up";
    setLinkState(loadedOnce ? "down" : "connecting");
    if (wasUp) emit({ kind: "link_down" });
  }

  async function connectLoop(): Promise<void> {
    while (!stopped) {
      let conn: Connection;
      try {
        conn = await createConnection({
          auth: createLongLivedTokenAuth(baseUrl, options.token),
          setupRetry: 0,
        });
      } catch (error) {
        if (isStopped()) return;
        if (error === ERR_INVALID_AUTH) {
          // Repeated failed logins make Home Assistant warn its user, so nothing more is tried.
          setLinkState("auth_invalid");
          return;
        }
        await new Promise<void>((resolve) => {
          cancelRetry = clock.after(HA_RETRY_MS, () => {
            cancelRetry = undefined;
            resolve();
          });
        });
        continue;
      }
      if (isStopped()) {
        conn.close();
        return;
      }
      connection = conn;
      conn.addEventListener("disconnected", onDisconnected);
      conn.addEventListener("ready", () => {
        beginLoad(conn);
      });
      conn.addEventListener("reconnect-error", (_conn, error) => {
        if (error === ERR_INVALID_AUTH && !stopped) setLinkState("auth_invalid");
      });
      beginLoad(conn);
      return;
    }
  }

  // ---- the public value ----------------------------------------------------------------------

  return {
    start(next) {
      if (started) return;
      started = true;
      listener = next;
      void connectLoop();
    },
    /**
     * Closes the connection and cancels the Clock's timers. The library keeps at most one of its own
     * reconnect timers (5 s) or a connect time-out (10 s) alive; the process's shutdown must end
     * with `process.exit` and not wait for them.
     */
    async stop() {
      if (stopped) return;
      stopped = true;
      setLinkState("down");
      loadId += 1;
      cancelRetry?.();
      cancelRetry = undefined;
      cancelPoll?.();
      cancelPoll = undefined;
      stopController.abort();
      connection?.close();
      await Promise.resolve();
    },
    state: () => state,
    up: () => state === "up",
    ready: () => loadedOnce,
    house: () => house,
    watch(entityIds) {
      const added = [...entityIds].filter((id) => !watched.has(id));
      watched = new Set(entityIds);
      for (const id of kept.keys()) if (!watched.has(id)) kept.delete(id);
      refresh();
      if (state === "up" && added.length > 0) void fetchStates(entitiesToAsk(added));
    },
    sensor: (entityId) => view.get(entityId),
    sensorInfo(entityId, valveAddresses) {
      const none = { exists: false, isTemperature: false, onValve: false };
      if (!loadedOnce) return none;
      const entry = entities.get(entityId);
      const record = states.get(entityId);
      const deviceId = entry?.deviceId;
      const identifiers = deviceId === undefined ? [] : (devices.get(deviceId)?.identifiers ?? []);
      return {
        exists: entry !== undefined || record !== undefined,
        isTemperature: entityId.startsWith("sensor.") && record?.deviceClass === "temperature",
        onValve: identifiers.some(
          ([domain, value]) =>
            domain === "mqtt" &&
            value.startsWith(Z2M_IDENTIFIER_PREFIX) &&
            valveAddresses.has(value.slice(Z2M_IDENTIFIER_PREFIX.length)),
        ),
      };
    },
    entityName(entityId) {
      return (
        states.get(entityId)?.friendlyName ??
        entities.get(entityId)?.name ??
        entities.get(entityId)?.originalName
      );
    },
    areaName: (areaId) => areas.get(areaId)?.name,
    snapshot: () => current,
    /**
     * Queues the ops as one batch behind the reloads and batches asked for before. The batch
     * reloads the area and entity registries, sends one command per op with no reload between
     * them, then reloads the label, area and entity registries once, so `snapshot()` shows every
     * done op when it resolves. Label, area and entity events that arrive meanwhile fold into that
     * last reload; device and config events queue their reload behind the batch. When the first
     * reload fails, no op is sent and each fails with that reload's code. An op that relies on a
     * label whose create in the batch failed, or was answered with another id (`label_clash`), is
     * not sent and fails with the create's code.
     */
    writeLabels(ops) {
      if (ops.length === 0) return Promise.resolve({ done: [], failed: [], created: new Map() });
      return new Promise((resolve) => {
        enqueue({
          kind: "batch",
          run: async () => {
            try {
              resolve(await runBatch(ops));
            } catch (error) {
              log.warn("a label batch failed", { error: String(error) });
              resolve({
                done: [],
                failed: ops.map((op) => ({ op, error: UNKNOWN_ERROR })),
                created: new Map(),
              });
            }
          },
        });
      });
    },
  };
}

export function buildHaLink(options: HaOptions, clock: Clock, log?: HaLog): HaLink | undefined {
  return options === undefined ? undefined : createHaLink(options, clock, log);
}
