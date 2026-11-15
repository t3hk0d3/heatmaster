import { isObservable, preview, transportFaulted, transportOf } from "./control.ts";
import type { DeviceView, Effect, PlannedWrite, World } from "./control.ts";
import { memberships, withRecord, withoutRecord } from "./ledger.ts";
import type { Ledger, StoredConfig } from "./ledger.ts";
import { sensorId } from "./model.ts";
import type { Config, SensorRef } from "./model.ts";
import type { DeviceState } from "./observation.ts";
import { members } from "./settings.ts";
import type { SettingKey, SettingValue, ValveSpec } from "./settings.ts";
import { validateConfig } from "./validation.ts";

/**
 * - `acceptUnknownOriginals`: valve ids whose unreadable originals the caller accepts as unknown.
 * - `haLinked`: a Home Assistant link is configured and has loaded its data at least once.
 */
export type ChangeOptions = Readonly<{
  expectedRevision: number | undefined;
  dryRun: boolean;
  acceptUnknownOriginals: ReadonlySet<string>;
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
  | "transport_unusable"
  | "valve_not_observed"
  | "originals_unreadable"
  | "valve_not_orphan"
  | "valve_managed";

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
 * `joining`: one Capture per new valve (enters a room, has no ledger record), in valve-id order.
 * `rejoining` and `leaving` are in valve-id order.
 */
export type ChangePlan = Readonly<{
  stored: StoredConfig;
  ledger: Ledger | undefined;
  effects: readonly Effect[];
  joining: readonly Capture[];
  rejoining: readonly string[];
  leaving: readonly string[];
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

/** Valve ids of every room, in document order, without repeats. */
function roomValves(config: Config | undefined): readonly string[] {
  const ids = (config?.rooms ?? []).flatMap((room) => room.valves.map((valve) => valve.valveId));
  return [...new Set(ids)];
}

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Refuses on the first new sensor, in document order, that fails a check. */
function checkSensors(
  config: Config,
  before: Config | undefined,
  haLinked: boolean,
  sensors: ReadonlyMap<string, SensorInfo>,
  valveAddresses: ReadonlySet<string>,
): void {
  const known = new Set(
    (before?.rooms ?? []).flatMap((room) => room.sensors.map((sensor) => sensorId(sensor))),
  );
  const fresh: SensorRef[] = config.rooms
    .flatMap((room) => room.sensors)
    .filter((sensor) => !known.has(sensorId(sensor)));
  for (const sensor of fresh) {
    const id = sensorId(sensor);
    if (sensor.ref.startsWith("ha:") && !haLinked) {
      throw new ChangeRefused("ha_link_missing", { sensor: id });
    }
    const info = sensors.get(id);
    if (info?.exists !== true) throw new ChangeRefused("sensor_unknown", { sensor: id });
    if (!info.isTemperature) throw new ChangeRefused("sensor_not_temperature", { sensor: id });
    const onValveAddress =
      sensor.ref.startsWith("z2m:") && valveAddresses.has(sensor.ref.slice("z2m:".length));
    if (info.onValve || onValveAddress) throw new ChangeRefused("sensor_on_valve", { sensor: id });
  }
}

/** Plans the user's config change; see the task's pseudocode for the order of the refusals. */
export function planChange(
  world: World,
  raw: unknown,
  options: ChangeOptions,
  sensors: ReadonlyMap<string, SensorInfo>,
  valveAddresses: ReadonlySet<string>,
): ChangePlan {
  const config = validateConfig(raw);
  const nowMs = world.now.epochMilliseconds;
  const old = readable(world);
  const before = new Set(roomValves(old?.config));
  const afterList = roomValves(config);
  const after = new Set(afterList);
  const entering = afterList.filter((id) => !before.has(id));
  const leaving = [...before].filter((id) => !after.has(id)).sort(byId);

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
  const runningWithoutZone = old !== undefined && old.config.settings.timezone === undefined;
  if (!options.haLinked && config.settings.timezone === undefined && !runningWithoutZone) {
    throw new ChangeRefused("timezone_missing");
  }
  checkSensors(config, old?.config, options.haLinked, sensors, valveAddresses);
  const views = new Map<string, Readonly<{ view: DeviceView; spec: ValveSpec }>>();
  for (const valveId of entering) {
    const view = world.devices.get(valveId);
    if (view === undefined) throw new ChangeRefused("valve_unknown", { valveId });
    if (view.spec === undefined) throw new ChangeRefused("valve_unsupported", { valveId });
    views.set(valveId, { view, spec: view.spec });
  }
  const known = (valveId: string): Readonly<{ view: DeviceView; spec: ValveSpec }> => {
    const entry = views.get(valveId);
    if (entry === undefined) throw new Error(`valve ${valveId} was not checked`);
    return entry;
  };

  const ledger = world.ledger;
  if (ledger === undefined && entering.length > 0) throw new ChangeRefused("ledger_unreadable");
  const newValves = entering.filter((id) => ledger?.records.has(id) !== true);
  const rejoining = entering.filter((id) => ledger?.records.has(id) === true).sort(byId);
  // A link that is down is not a refusal here: the valve is then not observed, or rejoins.
  for (const valveId of newValves) {
    if (transportFaulted(world, known(valveId).view, valveId)) {
      throw new ChangeRefused("transport_unusable", { valveId, transport: transportOf(valveId) });
    }
  }
  const unobserved = newValves.filter((id) => !isObservable(known(id).view)).sort(byId);
  if (unobserved.length > 0) {
    throw new ChangeRefused("valve_not_observed", { valveIds: unobserved.join(",") });
  }
  const captures = new Map<string, Capture>();
  for (const valveId of newValves) {
    const { view, spec } = known(valveId);
    const taken = capture(valveId, spec, view.state);
    if (taken.unreadable.length > 0 && !options.acceptUnknownOriginals.has(valveId)) {
      throw new ChangeRefused("originals_unreadable", {
        valveId,
        settings: taken.unreadable.join(","),
      });
    }
    captures.set(valveId, taken);
  }

  const joining = [...captures.values()].sort((a, b) => byId(a.valveId, b.valveId));
  // `joining` is empty when the ledger is unreadable: entering valves were refused above.
  const nextLedger =
    ledger === undefined
      ? undefined
      : joining.reduce(
          (current, taken) =>
            withRecord(current, {
              valveId: taken.valveId,
              profile: known(taken.valveId).spec.profile,
              adoptedAt: nowMs,
              originals: taken.originals,
            }),
          ledger,
        );
  const releasing = new Map(old?.releasing ?? []);
  for (const valveId of leaving) releasing.set(valveId, nowMs);
  for (const valveId of after) releasing.delete(valveId);
  const stored: StoredConfig = { config, revision: revision + 1, releasing };
  const writes = preview({ ...world, configState: "ok", stored, ledger: nextLedger });

  const effects: Effect[] = [];
  if (!options.dryRun) {
    if (nextLedger !== undefined && joining.length > 0) {
      effects.push({ kind: "saveLedger", ledger: nextLedger });
      effects.push({ kind: "writeOriginalsCopy", ledger: nextLedger });
    }
    effects.push({ kind: "saveConfig", stored });
  }
  return { stored, ledger: nextLedger, effects, joining, rejoining, leaving, writes };
}

/** For an orphan: release it to its originals. Anything else is refused with `valve_not_orphan`. */
export function restoreValve(world: World, valveId: string): readonly Effect[] {
  const kind = memberships(world.configState, world.stored, world.ledger).get(valveId);
  const stored = readable(world);
  if (kind !== "orphan" || stored === undefined) {
    throw new ChangeRefused("valve_not_orphan", { valveId });
  }
  const releasing = new Map(stored.releasing);
  releasing.set(valveId, world.now.epochMilliseconds);
  return [{ kind: "saveConfig", stored: { ...stored, releasing } }];
}

/** Drops an orphan's or a releasing valve's record without restoring its originals. */
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
  const kind = memberships(world.configState, world.stored, ledger).get(valveId);
  if (kind === "managed") throw new ChangeRefused("valve_managed", { valveId });
  // The rest is frozen: the config is unreadable, or missing while the ledger has records.
  if (stored === undefined || (kind !== "orphan" && kind !== "releasing")) {
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
