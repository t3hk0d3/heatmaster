import { preview } from "./control.ts";
import type { Effect, PlannedWrite, World } from "./control.ts";
import { ascending, roomsOf } from "./house.ts";
import type { HouseInput } from "./house.ts";
import { reconcile } from "./join.ts";
import type { Pending } from "./join.ts";
import { FRESH_STORED, memberships, withoutRecord } from "./ledger.ts";
import type { Ledger, Membership, StoredConfig } from "./ledger.ts";
import { sensorId } from "./model.ts";
import type { Config, SensorRef } from "./model.ts";
import type { DeviceState } from "./observation.ts";
import { members } from "./settings.ts";
import type { SettingKey, SettingValue, ValveSpec } from "./settings.ts";
import { validateConfig } from "./validation.ts";

/** `haLinked`: a Home Assistant link is configured and has loaded its data at least once. */
export type ChangeOptions = Readonly<{
  expectedRevision: number | undefined;
  dryRun: boolean;
  overwriteUnreadable: boolean;
  haLinked: boolean;
}>;

/** What the server knows about one sensor reference. */
export type SensorInfo = Readonly<{ exists: boolean; isTemperature: boolean; onValve: boolean }>;

export type ChangeRefusedCode =
  | "config_unreadable"
  | "revision_conflict"
  | "timezone_missing"
  | "ha_link_missing"
  | "sensor_unknown"
  | "sensor_not_temperature"
  | "sensor_on_valve"
  | "valve_unknown"
  | "valve_unsupported"
  | "ledger_unreadable"
  | "valve_not_orphan"
  | "valve_managed"
  | "valve_not_pending"
  | "schedule_in_use";

/** A config change, restore or forget that cannot be done. */
export class ChangeRefused extends Error {
  readonly code: ChangeRefusedCode;
  readonly data: Readonly<Record<string, string>>;

  constructor(code: ChangeRefusedCode, data: Readonly<Record<string, string>> = {}) {
    super(code);
    this.name = "ChangeRefused";
    this.code = code;
    this.data = data;
  }
}

/** The originals of a joining valve, as the transport's cache held them at capture. */
export type Capture = Readonly<{
  valveId: string;
  originals: Readonly<Partial<Record<SettingKey, SettingValue | null>>>;
  unreadable: readonly SettingKey[];
}>;

/**
 * `stored` is what the change saves. `joining` and `pending` are what the next tick's `reconcile`
 * would join and keep waiting over it, in valve-id order; `writes` is the preview over the world
 * after that reconcile.
 */
export type ChangePlan = Readonly<{
  stored: StoredConfig;
  effects: readonly Effect[];
  joining: readonly Capture[];
  pending: readonly Pending[];
  writes: readonly PlannedWrite[];
}>;

/** Each key of a captured group takes its observed value, or null and a place in `unreadable`. */
export function capture(valveId: string, spec: ValveSpec, state: DeviceState | undefined): Capture {
  const originals: Partial<Record<SettingKey, SettingValue | null>> = {};
  const unreadable: SettingKey[] = [];
  for (const group of spec.groups) {
    if (!group.capture) continue;
    for (const key of members(group.group)) {
      const value = state?.values[key];
      originals[key] = value ?? null;
      if (value === undefined) unreadable.push(key);
    }
  }
  return { valveId, originals, unreadable };
}

/** The stored config when the config is readable, otherwise undefined. */
function readable(world: World): StoredConfig | undefined {
  return world.configState === "ok" ? world.stored : undefined;
}

/** Every sensor of every entry, used or not, in the config's order. */
function entrySensors(config: Config | undefined): readonly SensorRef[] {
  return [...(config?.rooms.values() ?? [])].flatMap((entry) => entry.sensors);
}

/** The rooms of the world's house and the entries of the config, as area ids in ascending order. */
function known(world: World, config: Config): readonly string[] {
  const rooms =
    world.house.kind === "unlinked" ? [] : [...(world.house.membership?.rooms.keys() ?? [])];
  return ascending(new Set([...rooms, ...config.rooms.keys()]));
}

/** Each valve's membership over the rooms of the world's house. */
function membershipsIn(world: World, ledger: Ledger | undefined): ReadonlyMap<string, Membership> {
  const rooms = roomsOf(world.configState, world.stored, world.house);
  return memberships(world.configState, world.stored, ledger, rooms, world.house.kind);
}

/**
 * Refuses on the first new sensor, in document order, that fails a check. A sensor is new when no
 * entry of the current config lists it.
 */
function checkSensors(
  config: Config,
  before: Config | undefined,
  haLinked: boolean,
  sensors: ReadonlyMap<string, SensorInfo>,
): void {
  const known = new Set(entrySensors(before).map((sensor) => sensorId(sensor)));
  const fresh = entrySensors(config).filter((sensor) => !known.has(sensorId(sensor)));
  for (const sensor of fresh) {
    const id = sensorId(sensor);
    if (!haLinked) {
      throw new ChangeRefused("ha_link_missing", { sensor: id });
    }
    const info = sensors.get(id);
    if (info?.exists !== true) throw new ChangeRefused("sensor_unknown", { sensor: id });
    if (!info.isTemperature) throw new ChangeRefused("sensor_not_temperature", { sensor: id });
    if (info.onValve) throw new ChangeRefused("sensor_on_valve", { sensor: id });
  }
}

/**
 * Plans the user's config change; see the task's pseudocode for the order of the refusals. The
 * document names no valve: what joins, waits or leaves is what the next tick's `reconcile` does
 * over the world with the new stored config, so the plan previews that and saves the config only.
 */
export function planChange(
  world: World,
  raw: unknown,
  options: ChangeOptions,
  sensors: ReadonlyMap<string, SensorInfo>,
): ChangePlan {
  const config = validateConfig(raw);
  const old = readable(world);

  // State "ok" without a stored config counts as unreadable, as in `memberships`.
  const unreadable = world.configState === "unreadable" || (world.configState === "ok" && !old);
  if (unreadable && !options.overwriteUnreadable) {
    throw new ChangeRefused("config_unreadable");
  }
  const revision = old?.revision ?? 0;
  if (options.expectedRevision !== undefined && options.expectedRevision !== revision) {
    throw new ChangeRefused("revision_conflict", {
      expected: String(options.expectedRevision),
      current: String(revision),
    });
  }
  // A config without a schedule runs nothing: a fresh install's, whatever raised its revision (a
  // released hold, the sensor import), does not count as running.
  const runningWithoutZone =
    old !== undefined &&
    old.config.schedules.length > 0 &&
    old.config.settings.timezone === undefined;
  if (!options.haLinked && config.settings.timezone === undefined && !runningWithoutZone) {
    throw new ChangeRefused("timezone_missing");
  }
  checkSensors(config, old?.config, options.haLinked, sensors);
  const inUse = roomsOf(world.configState, world.stored, world.house)?.[0];
  if (config.schedules.length === 0 && inUse !== undefined) {
    throw new ChangeRefused("schedule_in_use", { roomId: inUse.id });
  }

  // The server's own fields (releasing, membership, sensor import, HA changes, report) are kept.
  // Over an unreadable config the user's document is the truth: the sensor import does not run
  // again for the rooms there are, or for the areas the document has entries for.
  const base =
    old ?? (unreadable ? { ...FRESH_STORED, importedAreas: known(world, config) } : FRESH_STORED);
  const stored: StoredConfig = { ...base, config, revision: revision + 1 };
  const next = reconcile({ ...world, configState: "ok", stored });
  const writes = preview({
    ...world,
    configState: "ok",
    stored: next.stored,
    ledger: next.ledger,
  });
  // Joins and releases are made by the next tick's reconcile, after the config is saved.
  const effects: Effect[] = options.dryRun ? [] : [{ kind: "saveConfig", stored }];
  return { stored, effects, joining: next.joined, pending: next.pending, writes };
}

/** For an orphan: release it to its originals. Anything else is refused with `valve_not_orphan`. */
export function restoreValve(world: World, valveId: string): readonly Effect[] {
  const kind = membershipsIn(world, world.ledger).get(valveId);
  const stored = readable(world);
  if (kind !== "orphan" || stored === undefined) {
    throw new ChangeRefused("valve_not_orphan", { valveId });
  }
  const releasing = new Map(stored.releasing);
  releasing.set(valveId, world.now.epochMilliseconds);
  return [{ kind: "saveConfig", stored: { ...stored, releasing } }];
}

/**
 * A managed valve that Home Assistant no longer has (the live house keeps it in its previous room,
 * listed in `notInHa`) and that no transport lists (`listed` false): nothing can reach it, so it
 * may be forgotten.
 */
export function strandedValve(house: HouseInput, valveId: string, listed: boolean): boolean {
  return house.kind === "live" && house.notInHa.includes(valveId) && !listed;
}

/**
 * Drops an orphan's, a releasing valve's or a stranded valve's record without restoring its
 * originals.
 */
export function forgetValve(world: World, valveId: string): readonly Effect[] {
  const stored = readable(world);
  const ledger = world.ledger;
  const configUnreadable =
    world.configState === "unreadable" || (world.configState === "ok" && stored === undefined);
  if (ledger === undefined) {
    throw new ChangeRefused(configUnreadable ? "config_unreadable" : "ledger_unreadable", {
      valveId,
    });
  }
  if (!ledger.records.has(valveId)) throw new ChangeRefused("valve_unknown", { valveId });
  const kind = membershipsIn(world, ledger).get(valveId);
  const stranded =
    kind === "managed" && strandedValve(world.house, valveId, world.devices.has(valveId));
  if (kind === "managed" && !stranded) throw new ChangeRefused("valve_managed", { valveId });
  // The rest is frozen: the config is unreadable or missing while the ledger has records, or the
  // house is not live (no Home Assistant link, or rooms frozen).
  if (stored === undefined || (kind !== "orphan" && kind !== "releasing" && !stranded)) {
    throw new ChangeRefused("config_unreadable", { valveId });
  }
  const next = withoutRecord(ledger, valveId, world.now.epochMilliseconds, true);
  const effects: Effect[] = [
    { kind: "saveLedger", ledger: next },
    { kind: "writeOriginalsCopy", ledger: next },
  ];
  if (kind === "releasing") {
    const releasing = new Map(stored.releasing);
    releasing.delete(valveId);
    effects.push({ kind: "saveConfig", stored: { ...stored, releasing } });
  }
  return effects;
}

/** Sets `holdWrites` and raises the revision; returns `stored` itself when nothing changes. */
export function withHold(stored: StoredConfig, on: boolean): StoredConfig {
  if (stored.config.settings.holdWrites === on) return stored;
  const settings = { ...stored.config.settings, holdWrites: on };
  return { ...stored, config: { ...stored.config, settings }, revision: stored.revision + 1 };
}
