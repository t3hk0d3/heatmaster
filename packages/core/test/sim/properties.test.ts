import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BUCKET,
  SCHEDULE,
  WEEKDAYS,
  configToRaw,
  START_TOKENS,
  GROUPS,
  clampTarget,
  confirmedWeek,
  findProfile,
  fitted,
  groupOf,
  reconcile,
  resolveRooms,
  roomLimits,
  roomWeek,
  sensorId,
  weekKey,
} from "../../src/index.ts";
import { Z2M_KEYS } from "../../src/profiles/sonoff-codec.ts";
import {
  HOUR_MS,
  MINUTE_MS,
  createSimDriver,
  desiredTexts,
  inSyncValve,
  kindsOf,
  recordedLedger,
  resolvedRooms,
} from "./driver.ts";
import {
  BY_HAND,
  MODELS,
  NOT_KEPT,
  ROOM_NAMES,
  SLOTS,
  VALVE_IDS,
  createRig,
  faultPlan,
  modelConfig,
  modelMembership,
  ownFault,
  quiesce,
  sensorOf,
  weekMissedAfterRelease,
  weeksMissedInRow,
  zbtResidual,
} from "./faults.ts";
import { factoryWeek, reported } from "./valve.ts";
import type {
  Effect,
  Ledger,
  Room,
  SettingKey,
  SettingValue,
  Thermostat,
  ValveRecord,
  World,
} from "../../src/index.ts";
import type {
  Fault,
  FaultPlan,
  Placement,
  Rig,
  RoomName,
  Slot,
  StepInfo,
  Subset,
  TurnMade,
  Variant,
} from "./faults.ts";
import type { SimDriver } from "./driver.ts";
import type { SimValve } from "./valve.ts";

// What one plan produces -----------------------------------------------------------------------

/** The properties, one id per effect of the skeleton. */
const IDS = [
  "convergence.values",
  "convergence.zbtDays",
  "convergence.releasing",
  "budget.perValve",
  "budget.perGroup",
  "budget.refreshBackoff",
  "budget.pushes",
  "originals.cache",
  "originals.truth",
  "originals.noDays",
  "originals.immutable",
  "release.cache",
  "release.truth",
  "release.noDays",
  "intent.unmanaged",
  "intent.hold",
  "intent.unreadable",
  "intent.firstMessage",
  "intent.zbtGroups",
  "mode.managed",
  "own.schedule",
  "one.matches",
  "keep.value",
] as const;
type Id = (typeof IDS)[number];

type Report = ReadonlyMap<Id, readonly string[]>;

/** The properties of plan 3a's room thermostat (Task 6); the crash-safety property leaves them out. */
const THERMOSTAT_IDS: readonly Id[] = ["own.schedule", "one.matches", "keep.value"];

/** The brief's waits between refreshes of a valve that is not heard: 2 min, 10 min, 1 h, 6 h. */
const REFRESH_BACKOFF_MIN = [2, 10, 60, 360];
const DAY_WINDOW_MS = 24 * HOUR_MS;
const VALVE_EFFECTS = new Set(["publish", "publishSetpoint", "pushTemperature", "refresh"]);

function valveOf(effect: Effect): string | undefined {
  return VALVE_EFFECTS.has(effect.kind) && "valveId" in effect ? effect.valveId : undefined;
}

function slotOf(valveId: string): Slot {
  return valveId === VALVE_IDS[0] ? 0 : 1;
}

function sameValue(
  a: SettingValue | null | undefined,
  b: SettingValue | null | undefined,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function originalsText(record: ValveRecord): string {
  return JSON.stringify({
    profile: record.profile,
    adoptedAt: record.adoptedAt,
    originals: Object.entries(record.originals).sort(([a], [b]) => (a < b ? -1 : 1)),
  });
}

/** Watches a rig and collects the violations of every property that holds at every moment. */
function observe(rig: Rig, hasSwap: boolean, found: (id: Id, text: string) => void): void {
  const { sim } = rig;
  const spent = new Map<string, number[]>();
  const pushes = new Map<string, { at: number; inc: number }[]>();
  const asks = new Map<string, number[]>();
  const newest = new Map<string, string>();
  let messagesSeen = 0;
  const incSeen = new Map<string, number>();
  const epochs = new Map<string, { inc: number; key: string | undefined; run: number }>();
  const publishes = new Map<string, number[]>();
  const firstSeen = new Map<string, string>();
  const factory = JSON.stringify(factoryWeek("trv_zbt"));

  const incarnation = (valveId: string): number =>
    sim.memoryAppearances().filter((a) => a.valveId === valveId).length;

  rig.onStep((info: StepInfo) => {
    const { world, effects, result } = info;
    const now = sim.now();
    // The memberships the control acted on: after the tick's own joins and releases.
    const reconciled = reconcile(world);
    const kinds = kindsOf({ ...world, stored: reconciled.stored, ledger: reconciled.ledger });
    const held = world.stored?.config.settings.holdWrites === true;
    const unreadable =
      world.configState !== "ok" || world.stored === undefined || world.ledger === undefined;
    const interval = world.stored?.config.settings.externalWriteIntervalMs ?? 5 * 60 * 1000;

    // Which valves got a new memory or were heard since the last step.
    const reset = new Set<string>();
    for (const valveId of VALVE_IDS) {
      const inc = incarnation(valveId);
      if (inc !== (incSeen.get(valveId) ?? 0)) {
        incSeen.set(valveId, inc);
        reset.add(valveId);
      }
    }
    // Heard means the valve spoke: a message with a last_seen newer than every one before. A
    // replay or an echo carries an old one. This does not use the core's own idea of heard. Every
    // message handed over since the last step counts, also one handed over between steps (by a
    // change) whose token a link coming back made the state forget before this step's tick.
    const messages = sim.messages();
    for (const { deviceId, lifeToken } of messages.slice(messagesSeen)) {
      const before = newest.get(deviceId);
      if (lifeToken !== undefined && (before === undefined || lifeToken > before)) {
        newest.set(deviceId, lifeToken);
        reset.add(deviceId);
      }
    }
    messagesSeen = messages.length;
    for (const valveId of reset) asks.set(valveId, []);

    // A group's epoch is one stretch of one desired value in one incarnation of the memory.
    for (const valveId of VALVE_IDS) {
      for (const group of GROUPS) {
        const desiredKey = result.memory.valves.get(valveId)?.groups[group]?.desiredKey;
        const id = `${valveId}|${group}`;
        const inc = incarnation(valveId);
        const epoch = epochs.get(id) ?? { inc, key: undefined, run: 0 };
        if (epoch.inc !== inc) {
          epoch.inc = inc;
          epoch.key = undefined;
          epoch.run++;
        }
        if (desiredKey !== undefined && desiredKey !== epoch.key) {
          epoch.key = desiredKey;
          epoch.run++;
        }
        epochs.set(id, epoch);
      }
    }

    for (const { at, effect } of effects) {
      const valveId = valveOf(effect);
      if (valveId === undefined) continue;
      const tag = `${valveId} ${effect.kind} at ${String(Math.round((at - sim.now() + sim.elapsed()) / 1000))}s`;
      const kind = kinds.get(valveId);
      const binding = sim.valve(valveId).model;

      // intent
      const asked = effect.kind === "refresh" && kind === "pending";
      if (kind !== "managed" && kind !== "releasing" && !asked) {
        found("intent.unmanaged", `${tag}: valve is ${kind ?? "unknown"}`);
      }
      if (effect.kind !== "refresh" && held) found("intent.hold", `${tag} while held`);
      if (unreadable) found("intent.unreadable", `${tag} while a store is unreadable`);
      if (effect.kind !== "refresh" && world.devices.get(valveId)?.state?.messageAt === undefined) {
        found("intent.firstMessage", `${tag} before the first message`);
      }

      // mode and setpoint written only to managed or releasing valves: look at the payload the
      // binding would send
      const payload = payloadOf(sim, valveId, effect);
      const thermostatKeys = [Z2M_KEYS.mode, Z2M_KEYS.setpoint].filter(
        (key) => payload !== undefined && Object.hasOwn(payload, key),
      );
      if (thermostatKeys.length > 0 && kind !== "managed" && kind !== "releasing") {
        found("mode.managed", `${tag} wrote ${thermostatKeys.join(", ")} on the ${binding}`);
      }
      // The group is written whole, mode first (R2); a release restores only what was captured,
      // the setpoint only with a captured heat (R17).
      if (thermostatKeys.length > 0 && kind === "managed" && thermostatKeys[0] !== Z2M_KEYS.mode) {
        found("mode.managed", `${tag} wrote a setpoint without the mode`);
      }
      if (thermostatKeys.length > 0 && kind === "releasing") {
        const originals = world.ledger?.records.get(valveId)?.originals ?? {};
        const restores = (key: string): boolean =>
          key === Z2M_KEYS.mode
            ? originals.system_mode !== undefined && originals.system_mode !== null
            : originals.system_mode === "heat";
        for (const key of thermostatKeys.filter((k) => !restores(k))) {
          found("mode.managed", `${tag} wrote ${key} to a releasing valve that did not capture it`);
        }
      }
      if (effect.kind === "publish" && kind === "releasing") {
        if (Object.keys(effect.values).some((key) => groupOf(key as SettingKey) === "schedule")) {
          found("release.noDays", `${tag} published a day while releasing`);
        }
      }

      // budget: pushes
      if (effect.kind === "pushTemperature") {
        const list = pushes.get(valveId) ?? [];
        const inc = incarnation(valveId);
        const last = list.at(-1);
        const gap = Math.min(interval, 30 * 60 * 1000);
        if (last?.inc === inc && at - last.at < gap) {
          found("budget.pushes", `${tag}: ${String((at - last.at) / 1000)}s after the one before`);
        }
        list.push({ at, inc });
        pushes.set(valveId, list);
        continue;
      }

      // budget: per valve in 24 h
      const times = spent.get(valveId) ?? [];
      times.push(at);
      spent.set(valveId, times);
      const inWindow = times.filter((t) => t > at - DAY_WINDOW_MS).length;
      const created = sim
        .memoryAppearances()
        .filter((a) => a.valveId === valveId && a.at > at - DAY_WINDOW_MS && a.at <= at).length;
      const allowed = BUCKET + 48 + START_TOKENS * created;
      if (inWindow > allowed) {
        found("budget.perValve", `${tag}: ${String(inWindow)} in 24 h, at most ${String(allowed)}`);
      }

      // budget: refresh backoff
      if (effect.kind === "refresh") {
        const list = asks.get(valveId) ?? [];
        const last = list.at(-1);
        if (last !== undefined) {
          const wait = (REFRESH_BACKOFF_MIN[Math.min(list.length, 4) - 1] ?? 0) * MINUTE_MS;
          if (at - last < wait) {
            found(
              "budget.refreshBackoff",
              `${tag}: ask ${String(list.length + 1)} came ${String((at - last) / 1000)}s after the one before`,
            );
          }
        }
        list.push(at);
        asks.set(valveId, list);
      }

      // budget: publishes of one group
      if (effect.kind === "publish") {
        const key = Object.keys(effect.values)[0] as SettingKey | undefined;
        if (key === undefined) continue;
        const group = groupOf(key);
        const id = `${valveId}|${group}`;
        const epoch = epochs.get(id) ?? { inc: 0, key: undefined, run: 0 };
        const epochId = `${id}|${String(epoch.inc)}|${String(epoch.run)}`;
        const list = publishes.get(epochId) ?? [];
        list.push(at);
        publishes.set(epochId, list);
        const n = list.filter((t) => t > at - DAY_WINDOW_MS).length;
        if (n > 7) found("budget.perGroup", `${tag}: ${String(n)} ${group} publishes in 24 h`);
      }
    }

    // originals: a release that finished restored what the ledger recorded
    const saved = effects.flatMap(({ effect }) => (effect.kind === "saveLedger" ? [effect] : []));
    const lastSaved = saved.at(-1);
    if (lastSaved !== undefined && world.ledger !== undefined) {
      for (const [valveId, record] of world.ledger.records) {
        if (lastSaved.ledger.records.has(valveId) || kinds.get(valveId) !== "releasing") continue;
        const slot = slotOf(valveId);
        const cache = decodeCache(sim, valveId);
        const truth = decodeTruth(sim, valveId);
        for (const [key, original] of Object.entries(record.originals)) {
          if (original === null) continue;
          // The setpoint is restored only where the captured mode is heat (R17).
          if (key === "setpoint" && record.originals.system_mode !== "heat") continue;
          if (!sameValue(cache[key as SettingKey], original)) {
            found(
              "release.cache",
              `${valveId} (slot ${String(slot)}) released with ${key} ${JSON.stringify(cache[key as SettingKey])}, recorded ${JSON.stringify(original)}`,
            );
          }
          if (!hasSwap && !sameValue(truth[key as SettingKey], original)) {
            found(
              "release.truth",
              `${valveId} released with ${key} ${JSON.stringify(truth[key as SettingKey])} on the valve, recorded ${JSON.stringify(original)}`,
            );
          }
        }
      }
    }

    // originals: what the ledger holds now
    const ledger: Ledger | undefined = sim.ledger();
    const entries: ValveRecord[] = [
      ...(ledger?.records.values() ?? []),
      ...(ledger?.released.map((r) => r.record) ?? []),
    ];
    for (const record of entries) {
      const key = `${record.valveId}|${String(record.adoptedAt)}`;
      if (Object.keys(record.originals).some((k) => groupOf(k as SettingKey) === "schedule")) {
        found("originals.noDays", `${key} holds a day`);
      }
      const text = originalsText(record);
      const first = firstSeen.get(key);
      if (first === undefined) firstSeen.set(key, text);
      else if (first !== text) found("originals.immutable", `${key} changed`);
      const join = rig.joins.find(
        (j) => j.valveId === record.valveId && j.adoptedAt === record.adoptedAt,
      );
      if (join === undefined) {
        found("originals.cache", `${key} is a record that no join made`);
        continue;
      }
      for (const [k, original] of Object.entries(record.originals)) {
        if (!sameValue(join.cache[k as SettingKey], original)) {
          found(
            "originals.cache",
            `${key}: ${k} is ${JSON.stringify(original)}, the cache held ${JSON.stringify(join.cache[k as SettingKey])}`,
          );
        }
        if (!hasSwap && !sameValue(join.truth[k as SettingKey], original)) {
          found(
            "originals.truth",
            `${key}: ${k} is ${JSON.stringify(original)}, the valve held ${JSON.stringify(join.truth[k as SettingKey])}`,
          );
        }
      }
    }

    // no write reaches groups 1 or 2 of the TRV-ZBT
    const zbt = sim.valve(VALVE_IDS[1]).truth();
    for (const group of [1, 2]) {
      const days = zbt.schedules[group];
      if (JSON.stringify(days) !== factory)
        found("intent.zbtGroups", `group ${String(group)} changed at ${String(now)}`);
    }
  });
}

function payloadOf(
  sim: SimDriver,
  valveId: string,
  effect: Effect,
): Readonly<Record<string, unknown>> | undefined {
  const binding = bindingFor(valveId);
  switch (effect.kind) {
    case "publish":
      return binding.encode(effect.values);
    case "publishSetpoint":
      return binding.encodeSetpoint(effect.celsius);
    case "pushTemperature":
      return binding.encodeTemperature(effect.celsius);
    default:
      return undefined;
  }
}

function bindingFor(valveId: string) {
  const found = findProfile(valveId === VALVE_IDS[0] ? "TRVZB" : "TRV-ZBT", "z2m");
  if (found === undefined) throw new Error("no profile");
  return found.binding;
}

function decodeCache(sim: SimDriver, valveId: string) {
  return bindingFor(valveId).decode(sim.bridge.cache(valveId)).values;
}

function decodeTruth(sim: SimDriver, valveId: string) {
  const valve = sim.valve(valveId);
  return bindingFor(valveId).decode(reportedOf(valve)).values;
}

function reportedOf(valve: SimValve): Record<string, unknown> {
  return reported(valve.model, valve.truth());
}

// Convergence ------------------------------------------------------------------------------------

function converge(rig: Rig, found: (id: Id, text: string) => void): void {
  const { sim } = rig;
  const world = sim.world();
  if (
    world.configState !== "ok" ||
    world.stored === undefined ||
    world.ledger === undefined ||
    world.stored.config.settings.holdWrites
  ) {
    return;
  }
  const config = world.stored.config;
  const rooms = resolvedRooms(world);
  const kinds = kindsOf(world);
  for (const slot of SLOTS) {
    const valveId = VALVE_IDS[slot];
    const model = MODELS[slot];
    const kind = kinds.get(valveId);
    if (kind === "releasing") found("convergence.releasing", `${valveId} is still releasing`);
    if (kind === "pending") found("convergence.values", `${valveId} is in a room but pending`);
    if (kind !== "managed") continue;
    const room = rooms.find((r) => r.valves.some((v) => v.valveId === valveId));
    if (room === undefined) continue;
    const truth = sim.valve(valveId).truth();
    const wanted = desiredTexts(config, rooms, room.id, model);
    const days = truth.schedules[model === "trvzb" ? 1 : 3];
    const text = JSON.stringify(days);
    if (text !== JSON.stringify(wanted)) {
      found(
        model === "trvzb" ? "convergence.values" : "convergence.zbtDays",
        `${valveId} in ${room.id}: days ${text}, wanted ${JSON.stringify(wanted)}`,
      );
    }
    if (model === "trv_zbt" && truth.activeGroup !== 3) {
      found("convergence.values", `${valveId}: active group ${String(truth.activeGroup)}`);
    }
    // Every room stays on its schedule in these plans, so its valves end in auto.
    if (truth.mode !== "auto")
      found("mode.managed", `${valveId}: mode ${truth.mode} after quiesce`);
    const hasSensor = room.sensors.some((s) => sensorId(s).length > 0);
    // A valve that is off is not fed, so Heatmaster leaves its source alone.
    if (hasSensor && truth.mode === "off") continue;
    const source = hasSensor ? "remote_temperature" : "local_temperature";
    if (truth.select !== source) {
      found(
        "convergence.values",
        `${valveId} in ${room.id}: source ${truth.select}, wanted ${source}`,
      );
    }
  }
}

// The room thermostat (plan 3a, Task 6) --------------------------------------------------------

/** The resolved room that holds the valve while it is managed, with its world. */
function managedRoom(
  sim: SimDriver,
  valveId: string,
): Readonly<{ room: Room; world: World }> | undefined {
  const world = sim.world();
  if (kindsOf(world).get(valveId) !== "managed" || world.stored === undefined) return undefined;
  const room = resolvedRooms(world).find((r) => r.valves.some((v) => v.valveId === valveId));
  if (room === undefined || roomWeek(world.stored.config, room) === undefined) return undefined;
  return { room, world };
}

/** The room's saved thermostat. */
function thermostatOf(sim: SimDriver, roomId: string): Thermostat {
  return sim.thermostats().rooms.get(roomId) ?? SCHEDULE;
}

/** Equal in kind and target: what a person's change sets (R5). */
function sameState(a: Thermostat, b: Thermostat): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== "override" || (b.kind === "override" && a.target === b.target);
}

function describeState(t: Thermostat): string {
  return t.kind === "override" ? `override ${String(t.target)}` : t.kind;
}

/**
 * What the room's thermostat becomes after a turn that left the valve showing `truth`, or
 * undefined where a known limit of the spec leaves it unseen: a TRV-ZBT on its schedule turned to
 * a value of its week, or while its desired week is not confirmed on it. A TRV-ZBT put in `auto`
 * from another mode while the room is not on its schedule takes the room back to it, as
 * `personThermostat` does.
 */
function expectedAfter(sim: SimDriver, turn: TurnMade): Thermostat | undefined {
  const valveId = VALVE_IDS[turn.valve];
  const placed = managedRoom(sim, valveId);
  if (placed === undefined) return undefined;
  const { room, world } = placed;
  const config = world.stored?.config;
  const view = world.devices.get(valveId);
  const week = config === undefined ? undefined : roomWeek(config, room);
  if (week === undefined || view?.spec === undefined) return undefined;
  const specs = room.valves.flatMap(({ valveId: id }) => {
    const spec = kindsOf(world).get(id) === "managed" ? world.devices.get(id)?.spec : undefined;
    return spec === undefined ? [] : [spec];
  });
  const limits = roomLimits(specs);
  if (limits === undefined) return undefined;
  // A valve being taken over (moved, joined, managed again) is not judged (R3).
  const expectation = world.thermostats?.valves.get(valveId);
  if (expectation?.roomId !== room.id || expectation.confirmed === undefined) return undefined;
  const { truth } = turn;
  const origin = { source: "valve", valveId } as const;
  if (truth.mode === "off") {
    return { kind: "off", rule: "manual", endsAt: undefined, origin, since: 0 };
  }
  const current = thermostatOf(sim, room.id);
  if (
    truth.mode === "auto" &&
    current.kind !== "schedule" &&
    expectation.confirmed.mode !== "auto"
  ) {
    return SCHEDULE;
  }
  if (truth.mode === "auto" && turn.valve === 1 && current.kind === "schedule") {
    const days = fitted(week, view.spec).days;
    const values = WEEKDAYS.flatMap((day) => days[day].map((p) => p.temperature));
    const vm = world.memory.valves.get(valveId);
    const confirmed = vm === undefined ? undefined : confirmedWeek(view.spec, vm, view.state, days);
    const saved = world.thermostats?.valves.get(valveId);
    const kept = saved?.roomId === room.id && saved.week?.key === weekKey(days);
    const otherGroup =
      view.state?.values.active_group !== undefined && view.state.values.active_group !== 3;
    const known = confirmed !== undefined || (kept && !otherGroup);
    if (values.includes(truth.setpoint) || !known) return undefined;
  }
  return {
    kind: "override",
    target: clampTarget(truth.setpoint, limits),
    preset: undefined,
    rule: "manual",
    endsAt: undefined,
    origin,
    since: 0,
  };
}

/**
 * Watches the plan for P-own and P-keep until `stop`:
 * - P-own: in a plan with nothing done by hand at a valve, no competing writer and no battery
 *   swap, every room stays on its schedule, until the documented residual limit of a lost TRV-ZBT
 *   week is reached (`zbtResidual`), or a valve moves rooms while a thermostat write to it is in
 *   flight (`writeMovedInFlight`, a late write's known limit).
 * - P-keep: in a plan with one turn and, after it, only faults P-own covers and no change of
 *   rooms or stores, the room's thermostat holds what the turn left until it ends, and it is adopted
 *   unless the valve stopped showing it before Heatmaster heard it.
 */
function watchThermostats(
  rig: Rig,
  plan: FaultPlan,
  found: (id: Id, text: string) => void,
): Readonly<{ stop: () => void }> {
  const { sim } = rig;
  const own = plan.steps.every(ownFault);
  const turnAt = plan.steps.findIndex((s) => BY_HAND.has(s.k));
  const keep =
    turnAt >= 0 &&
    plan.steps.filter((s) => BY_HAND.has(s.k)).length === 1 &&
    plan.steps.slice(turnAt + 1).every((s) => ownFault(s) && !NOT_KEPT.has(s.k));
  let watching = true;
  let target: Readonly<{ roomId: string; state: Thermostat }> | undefined;
  let settled: Readonly<{ endsAt: number | undefined }> | undefined;
  const elapsed = (): string => `${String(Math.round(sim.elapsed() / 1000))}s`;
  rig.onStep(() => {
    if (!watching) return;
    // The documented residual limit of a lost TRV-ZBT week (`zbtResidual`), and a write in flight
    // across a room move (`writeMovedInFlight`).
    if (own && !zbtResidual(rig.zbtWeekWrites()) && !rig.writeMovedInFlight()) {
      for (const [roomId, t] of sim.thermostats().rooms) {
        found("own.schedule", `${roomId} is ${describeState(t)} at ${elapsed()}`);
      }
    }
    const turn = rig.turns[0];
    if (!keep || turn === undefined) return;
    if (target === undefined && settled === undefined) {
      const state = expectedAfter(sim, turn);
      const placed = managedRoom(sim, VALVE_IDS[turn.valve]);
      // A turn the spec's known limits leave unseen, or on a valve in no room, holds nothing.
      if (state === undefined || placed === undefined) {
        settled = { endsAt: 0 };
        return;
      }
      target = { roomId: placed.room.id, state };
    }
    if (target === undefined) return;
    // A move made before the turn can take effect after it, once Home Assistant is back: the
    // room then holds nothing more (a change of rooms, which P-keep leaves out).
    if (managedRoom(sim, VALVE_IDS[turn.valve])?.room.id !== target.roomId) {
      target = undefined;
      return;
    }
    const now = thermostatOf(sim, target.roomId);
    if (sameState(now, target.state)) {
      settled = { endsAt: now.kind === "schedule" ? undefined : now.endsAt };
      return;
    }
    const over = settled?.endsAt !== undefined && sim.now() >= settled.endsAt;
    if (settled !== undefined && !over) {
      found(
        "keep.value",
        `${target.roomId} is ${describeState(now)} at ${elapsed()}, the turn left ${describeState(target.state)}`,
      );
    }
    if (over) target = undefined;
  });
  return {
    stop: () => {
      watching = false;
      // Unseen is a failure only while the valve still shows what the turn left: a TRV-ZBT in
      // `auto` drops a held value at its next point, which may come before Heatmaster hears it.
      const turn = rig.turns[0];
      const truth = turn === undefined ? undefined : sim.valve(VALVE_IDS[turn.valve]).truth();
      const shown =
        turn !== undefined &&
        truth?.mode === turn.truth.mode &&
        truth.setpoint === turn.truth.setpoint;
      if (target !== undefined && settled === undefined && shown) {
        found("keep.value", `${target.roomId} never took ${describeState(target.state)}`);
      }
    },
  };
}

/**
 * P-one: once quiesced and idle long enough for the tokens to refill, a knob is turned; with
 * links up and no fault from then on, 3 min later every live valve of the room shows what the
 * room's thermostat wants of it: `heat` at an override's target, `off`, or `auto` on its schedule.
 */
function oneTurn(
  rig: Rig,
  slot: Slot,
  clicks: number,
  found: (id: Id, text: string) => void,
): void {
  const { sim } = rig;
  const valveId = VALVE_IDS[slot];
  rig.advance(3 * HOUR_MS, MINUTE_MS);
  const placed = managedRoom(sim, valveId);
  // As for convergence: writes must not be held and both stores readable.
  const { configState, stored } = sim.config();
  const writable =
    configState === "ok" &&
    stored?.config.settings.holdWrites === false &&
    sim.ledger() !== undefined;
  if (placed === undefined || !writable || !sim.valve(valveId).isAwake()) return;
  sim.valve(valveId).knob(clicks, sim.now());
  rig.advance(3 * MINUTE_MS, 5 * 1000);
  const t = thermostatOf(sim, placed.room.id);
  const kinds = kindsOf(sim.world());
  for (const { valveId: id } of placed.room.valves) {
    if (kinds.get(id) !== "managed" || !sim.valve(id).isAwake()) continue;
    const truth = sim.valve(id).truth();
    const ok =
      t.kind === "override"
        ? truth.mode === "heat" && truth.setpoint === t.target
        : truth.mode === (t.kind === "off" ? "off" : "auto");
    if (!ok) {
      found(
        "one.matches",
        `${id} shows ${truth.mode} ${String(truth.setpoint)} 3 min after ${String(clicks)} clicks on ${valveId}; the room is ${describeState(t)}`,
      );
    }
  }
}

// Running a plan ---------------------------------------------------------------------------------

const memo = new Map<string, Report>();

function execute(plan: FaultPlan): Readonly<{ report: Map<Id, string[]>; rig: Rig }> {
  const found = new Map<Id, string[]>();
  const add = (id: Id, text: string): void => {
    const list = found.get(id) ?? [];
    if (list.length < 5) list.push(text);
    found.set(id, list);
  };
  const rig = createRig(plan.initial);
  observe(
    rig,
    plan.steps.some((s) => s.k === "swap"),
    add,
  );
  const watch = watchThermostats(rig, plan, add);
  rig.run(plan);
  quiesce(rig.sim);
  converge(rig, add);
  watch.stop();
  if (plan.turn !== undefined) oneTurn(rig, plan.turn.valve, plan.turn.clicks, add);
  return { report: found, rig };
}

function reportOf(plan: FaultPlan): Report {
  const key = JSON.stringify(plan);
  const known = memo.get(key);
  if (known !== undefined) return known;
  const { report } = execute(plan);
  memo.set(key, report);
  if (memo.size > 400) memo.clear();
  return report;
}

const SEED = fc.readConfigureGlobal().seed ?? Math.floor(Math.random() * 2 ** 31);

/** The plans are long (hours of simulated time each), so a dev run takes fewer than the global count. */
const NUM_RUNS = Math.min(fc.readConfigureGlobal().numRuns ?? 100, 100);

function holds(arbitrary: fc.Arbitrary<FaultPlan>, ids: readonly Id[]): void {
  fc.assert(
    fc.property(arbitrary, (plan) => {
      const report = reportOf(plan);
      for (const id of ids) expect(report.get(id) ?? [], id).toEqual([]);
    }),
    { seed: SEED, numRuns: NUM_RUNS },
  );
}

/**
 * Per-test timeouts. Measured under `FC_PROFILE=ci` (50 runs): the fast-check properties take up to
 * 20 s, so their budget is 6x that, which also covers the dev profile's 100 capped runs. The fixed
 * plans below take up to 1.6 s, so their budget is about 12x that.
 */
const SLOW_MS = 120 * 1000;
const PLAN_MS = 20 * 1000;

function propertyTest(
  name: string,
  ids: readonly Id[],
  options: { crashy?: boolean; subset?: Subset } = {},
): void {
  it(
    name,
    () => {
      holds(faultPlan(options), ids);
    },
    SLOW_MS,
  );
}

describe("properties (fast-check, each over arbitrary fault plans with one TRVZB and one TRV-ZBT)", () => {
  describe("convergence", () => {
    describe("After quiesce, with writes not held and both stores readable", () => {
      propertyTest(
        "every managed, reachable valve's true days, active group and sensor source equal the desired ones",
        ["convergence.values"],
      );
      propertyTest("a TRV-ZBT's true days in group 3 are the desired ones", [
        "convergence.zbtDays",
      ]);
      propertyTest("no valve is left in releasing unless it is unreachable", [
        "convergence.releasing",
      ]);
    });
  });

  describe("budget", () => {
    describe("At every moment", () => {
      propertyTest(
        "the refreshes, publishes and setpoint writes decided for one valve in any 24 h number at most 54 + 4 per creation of its memory",
        ["budget.perValve"],
      );
      propertyTest(
        "publishes of one group number at most 7 in any 24 h while its desired value stays the same and the memory is not created anew",
        ["budget.perGroup"],
      );
      propertyTest(
        "refreshes to a valve that is not heard in between come no sooner than 2 min, 10 min, 1 h and then 6 h after the one before",
        ["budget.refreshBackoff"],
      );
      propertyTest(
        "temperature pushes to a valve number at most one per min(configured interval, 30 min), plus one per creation of its memory",
        ["budget.pushes"],
      );
    });
  });

  describe("originals", () => {
    describe("At every moment", () => {
      propertyTest(
        "a ledger original equals the value the bridge's cache held when the valve joined",
        ["originals.cache"],
      );
      propertyTest(
        "in a plan with no battery swap it also equals the valve's true value at that moment",
        ["originals.truth"],
      );
      propertyTest("no ledger record holds a day", ["originals.noDays"]);
      propertyTest("a ledger entry never changes once written", ["originals.immutable"]);
    });
    describe("After a release finished", () => {
      propertyTest(
        "the bridge's cache holds the record's originals for the captured settings (unknown originals aside)",
        ["release.cache"],
      );
      propertyTest(
        "in a plan with no battery swap the valve's true captured settings equal them too, the setpoint only where the captured mode is heat",
        ["release.truth"],
      );
      propertyTest("no day was published to the valve while it was releasing", ["release.noDays"]);
    });
  });

  describe("intent", () => {
    describe("At every moment", () => {
      propertyTest(
        "no publish, setpoint write, temperature push or refresh reaches a valve that is not managed or releasing after the tick's reconcile, except a refresh to a pending valve (the driver's own `get` after a valve_not_observed refusal aside)",
        ["intent.unmanaged"],
      );
      propertyTest(
        "no publish, setpoint write or temperature push reaches a valve while holdWrites is true",
        ["intent.hold"],
      );
      propertyTest(
        "none of those four reaches a valve while the config or the ledger is unreadable",
        ["intent.unreadable"],
      );
      propertyTest("nothing but a refresh reaches a valve before its first message after a start", [
        "intent.firstMessage",
      ]);
      propertyTest("no write reaches groups 1 or 2 of a TRV-ZBT", ["intent.zbtGroups"]);
    });
  });

  describe("crash safety", () => {
    describe("With a crash after any effect and with a restart at any step", () => {
      propertyTest(
        "the four properties above still hold",
        IDS.filter((id) => id !== "mode.managed" && !THERMOSTAT_IDS.includes(id)),
        { crashy: true },
      );
    });
  });

  describe("mode.managed", () => {
    describe("At every moment", () => {
      propertyTest(
        "holds over the fault plans: system_mode and occupied_heating_setpoint are written only to valves that are managed or releasing, a setpoint only after the mode, to a releasing valve only where its record captured them, and after quiesce every managed valve is in auto",
        ["mode.managed"],
      );
    });
  });

  describe("P-own", () => {
    propertyTest("holds over its fault subset", ["own.schedule"], { subset: "own" });
  });

  describe("P-one", () => {
    propertyTest("holds over its fault subset", ["one.matches"]);
  });

  describe("P-keep", () => {
    propertyTest(
      "holds over the fault plans without knob or person faults after the turn",
      ["keep.value"],
      { subset: "keep" },
    );
  });

  describe("plans that fast-check does not reach often", () => {
    const initial = {
      trvzbSelect: "local_temperature",
      zbtSelect: "local_temperature",
      zbtGroup: 1,
      intervalMin: 5,
      offsets: [0, 0],
    } as const;
    const nothingBroken = (report: Report): void => {
      for (const id of IDS) expect(report.get(id) ?? [], id).toEqual([]);
    };
    const waits = (hours: number): Fault[] =>
      Array.from({ length: hours / 4 }, (): Fault => ({ k: "wait", seconds: 14400 }));
    /** The most requests (refreshes, publishes, setpoint writes) in any 24 h window. */
    const busiest = (rig: Rig, valveId: string): number => {
      const times = rig.sim
        .log()
        .flatMap(({ at, effect }) =>
          "valveId" in effect &&
          effect.valveId === valveId &&
          ["refresh", "publish", "publishSetpoint"].includes(effect.kind)
            ? [at]
            : [],
        );
      return Math.max(
        0,
        ...times.map((t) => times.filter((u) => u <= t && u > t - DAY_WINDOW_MS).length),
      );
    };

    describe("With a valve removed from its room, a person changing its source, and the link down for an hour", () => {
      const plan: FaultPlan = {
        initial: { ...initial, intervalMin: 1 },
        steps: [
          ...waits(4),
          { k: "place", valve: 0, room: null },
          { k: "wait", seconds: 120 },
          { k: "person", valve: 0, change: { what: "setpoint", celsius: 5 } },
          { k: "person", valve: 0, change: { what: "select", select: "remote_temperature" } },
          { k: "link", name: "z2m", up: false },
          { k: "wait", seconds: 3600 },
        ],
      };
      it(
        "the release does not finish from stale state, and every property holds",
        () => {
          nothingBroken(execute(plan).report);
        },
        PLAN_MS,
      );
    });

    describe("With a TRVZB that answers a refresh between two steps, then the link down until quiesce", () => {
      // Found by seed 1264016427. The answer is handed over by the edit, outside a step, and the
      // link coming back forgets its token before the next step: only the message shows it.
      const plan: FaultPlan = {
        initial: { ...initial, intervalMin: 1 },
        steps: [
          { k: "rejoin", valve: 0 },
          { k: "wait", seconds: 30 },
          { k: "edit", schedule: "default", variant: 0 },
          { k: "link", name: "z2m", up: false },
        ],
      };
      it(
        "it is asked at 390 s and again at 450 s, heard in between, and every property holds",
        () => {
          const { report, rig } = execute(plan);
          nothingBroken(report);
          const asks = rig.sim.effectsOf(VALVE_IDS[0], "refresh").map((e) => e.at / 1000);
          expect(asks.filter((t) => t >= 390 && t <= 450)).toEqual([390, 450]);
          const startMs = rig.sim.now() - rig.sim.elapsed();
          // Heard: a message whose last_seen is newer than every one before it.
          let newest = "";
          const heard = rig.sim.messages().flatMap(({ at, deviceId, lifeToken }) => {
            if (deviceId !== VALVE_IDS[0] || lifeToken === undefined || lifeToken <= newest) {
              return [];
            }
            newest = lifeToken;
            return [(at - startMs) / 1000];
          });
          expect(heard.filter((t) => t >= 390 && t < 450)).not.toEqual([]);
        },
        PLAN_MS,
      );
    });

    describe("With a TRVZB captured in auto with setpoint 17, set to heat at 22 by a person, then removed from its room", () => {
      const plan: FaultPlan = {
        initial,
        steps: [
          ...waits(4),
          { k: "person", valve: 0, change: { what: "mode", mode: "heat" } },
          { k: "person", valve: 0, change: { what: "setpoint", celsius: 22 } },
          { k: "wait", seconds: 120 },
          { k: "place", valve: 0, room: null },
          { k: "wait", seconds: 3600 },
        ],
      };
      it(
        "a valve captured in auto with setpoint 17 ends in auto, whatever its setpoint",
        () => {
          const { report, rig } = execute(plan);
          nothingBroken(report);
          const released = rig.sim
            .ledger()
            ?.released.find((r) => r.record.valveId === VALVE_IDS[0]);
          expect(released?.record.originals).toMatchObject({ system_mode: "auto", setpoint: 17 });
          expect(rig.sim.valve(VALVE_IDS[0]).truth().mode).toBe("auto");
        },
        PLAN_MS,
      );
    });

    describe("With a crash after the first effect of a join, made by the tick once the valve is placed again", () => {
      const plan: FaultPlan = {
        initial,
        steps: [
          ...waits(4),
          { k: "place", valve: 0, room: null },
          ...waits(4),
          { k: "crash", after: 1 },
          { k: "place", valve: 0, room: "a" },
          { k: "wait", seconds: 600 },
        ],
      };
      it(
        "the valve ends up adopted and in sync, and every property holds",
        () => {
          const { report, rig } = execute(plan);
          nothingBroken(report);
          const world = rig.sim.world();
          expect(kindsOf(world).get(VALVE_IDS[0])).toBe("managed");
          expect(rig.sim.valve(VALVE_IDS[0]).truth().select).toBe("remote_temperature");
        },
        PLAN_MS,
      );
    });

    describe("With a TRV-ZBT that sleeps for two days after both valves were placed", () => {
      const plan: FaultPlan = {
        initial,
        steps: [...waits(4), { k: "sleep", valve: 1 }, { k: "bridgeRestart" }, ...waits(48)],
      };
      it(
        "it is asked 2 min, 10 min and 1 h after the one before, then not any more once it is silent",
        () => {
          const { report, rig } = execute(plan);
          nothingBroken(report);
          const asks = rig.sim
            .effectsOf(VALVE_IDS[1], "refresh")
            .map((e) => e.at / 1000)
            .filter((t) => t < 20 * 3600);
          const first = asks.findIndex((t) => t >= 4 * 3600);
          const gaps = asks
            .slice(first)
            .flatMap((t, i, all) => (i === 0 ? [] : [t - (all[i - 1] ?? 0)]));
          expect(gaps).toHaveLength(3);
          for (const [i, minutes] of [2, 10, 60].entries()) {
            expect(gaps[i]).toBeGreaterThanOrEqual(minutes * 60);
            expect(gaps[i]).toBeLessThan(minutes * 60 + 61);
          }
        },
        PLAN_MS,
      );
    });

    describe("With every write to the TRV-ZBT lost for a day after its week changed", () => {
      const plan: FaultPlan = {
        initial,
        steps: [
          { k: "fate", valve: 1, on: "write", fate: "lose", delaySeconds: 0, count: 500 },
          { k: "edit", schedule: "alt", variant: 2 },
          ...waits(24),
        ],
      };
      it(
        "the week is sent at least once and at most 7 times in 24 h, and every property holds",
        () => {
          const { report, rig } = execute(plan);
          // One week, lost however often it is sent: P-own covers it.
          expect(zbtResidual(rig.zbtWeekWrites())).toBe(false);
          nothingBroken(report);
          const weeks = rig.sim
            .effectsOf(VALVE_IDS[1], "publish")
            .filter((e) => e.at > 6 * 60 * 1000 && e.at <= 24 * HOUR_MS + 6 * 60 * 1000)
            .filter(
              (e) => e.effect.kind === "publish" && Object.hasOwn(e.effect.values, "day_mon"),
            );
          expect(weeks.length).toBeGreaterThanOrEqual(1);
          expect(weeks.length).toBeLessThanOrEqual(7);
        },
        PLAN_MS,
      );
    });

    describe("With the TRV-ZBT released, managed again in another room, and its first week write lost (seed 1578396460)", () => {
      const plan: FaultPlan = {
        initial: { ...initial, intervalMin: 1 },
        steps: [
          { k: "place", valve: 1, room: null },
          { k: "fate", valve: 1, on: "any", fate: "lose", delaySeconds: 0, count: 2 },
          { k: "wait", seconds: 30 },
          { k: "place", valve: 1, room: "c" },
          { k: "wait", seconds: 14400 },
          { k: "fate", valve: 0, on: "any", fate: "lose", delaySeconds: 0, count: 1 },
          { k: "fate", valve: 0, on: "any", fate: "lose", delaySeconds: 0, count: 1 },
        ],
        turn: { valve: 0, clicks: 1 },
      };
      it(
        "P-own leaves it out (the documented residual limit) and every other property holds",
        () => {
          const { report, rig } = execute(plan);
          expect(weekMissedAfterRelease(rig.zbtWeekWrites())).toBe(true);
          expect(weeksMissedInRow(rig.zbtWeekWrites())).toBe(false);
          nothingBroken(report);
        },
        PLAN_MS,
      );
    });

    describe("With the TRV-ZBT moved to another room while its window write is in flight (seed 1481946975)", () => {
      const plan: FaultPlan = {
        initial: { ...initial, intervalMin: 1 },
        steps: [
          { k: "edit", schedule: "alt", variant: 0 },
          { k: "wait", seconds: 7200 },
          { k: "edit", schedule: "alt", variant: 1 },
          { k: "sensor", room: "b", delta: -2 },
          { k: "wait", seconds: 60 },
          { k: "place", valve: 1, room: "a" },
          { k: "link", name: "z2m", up: false },
          { k: "fate", valve: 0, on: "any", fate: "lose", delaySeconds: 0, count: 1 },
          { k: "wait", seconds: 30 },
          { k: "wake", valve: 0 },
        ],
        turn: { valve: 0, clicks: -30 },
      };
      it(
        "P-own leaves it out (a late write's known limit) and every other property holds",
        () => {
          const { report, rig } = execute(plan);
          expect(rig.writeMovedInFlight()).toBe(true);
          nothingBroken(report);
        },
        PLAN_MS,
      );
    });

    describe("With the writes of two weeks in a row to the TRV-ZBT lost after it moved rooms (seed 1838578502, second counterexample)", () => {
      const plan: FaultPlan = {
        initial: { ...initial, intervalMin: 1 },
        steps: [
          { k: "edit", schedule: "alt", variant: 2 },
          { k: "wait", seconds: 30 },
          { k: "place", valve: 1, room: "a" },
          { k: "fate", valve: 1, on: "any", fate: "lose", delaySeconds: 0, count: 5 },
          { k: "crash", after: 3 },
          { k: "place", valve: 0, room: null },
          { k: "wait", seconds: 1200 },
          { k: "link", name: "ha", up: false },
          { k: "edit", schedule: "default", variant: 1 },
          { k: "wait", seconds: 30 },
          { k: "wait", seconds: 30 },
        ],
        turn: { valve: 0, clicks: 1 },
      };
      it(
        "P-own leaves it out (the documented residual limit) and every other property holds",
        () => {
          const { report, rig } = execute(plan);
          expect(weeksMissedInRow(rig.zbtWeekWrites())).toBe(true);
          nothingBroken(report);
        },
        PLAN_MS,
      );
    });

    describe("With the TRV-ZBT's first request lost after it joined, and the schedule edited before its first week was confirmed (seed 1838578502)", () => {
      const plan: FaultPlan = {
        initial: { ...initial, intervalMin: 1 },
        steps: [
          { k: "place", valve: 1, room: "a" },
          { k: "fate", valve: 1, on: "any", fate: "lose", delaySeconds: 0, count: 1 },
          { k: "wait", seconds: 30 },
          { k: "link", name: "ha", up: false },
          { k: "edit", schedule: "default", variant: 0 },
          { k: "wait", seconds: 30 },
          { k: "wait", seconds: 30 },
        ],
        turn: { valve: 0, clicks: 1 },
      };
      it(
        "P-own covers it (one missed write) and every property holds",
        () => {
          const { report, rig } = execute(plan);
          expect(zbtResidual(rig.zbtWeekWrites())).toBe(false);
          nothingBroken(report);
        },
        PLAN_MS,
      );
    });

    describe("With the schedules edited every 5 min for a day, so that only the tokens can stop the writes", () => {
      const edits: Fault[] = [];
      let dv = 0;
      let av = 1;
      for (let i = 0; i < 288; i++) {
        if (i % 2 === 0) {
          dv = (dv + 1) % 3;
          edits.push({ k: "edit", schedule: "default", variant: dv as 0 | 1 | 2 });
        } else {
          av = (av + 1) % 3;
          edits.push({ k: "edit", schedule: "alt", variant: av as 0 | 1 | 2 });
        }
        edits.push({ k: "wait", seconds: 300 });
      }
      const plan: FaultPlan = { initial, steps: edits };
      it(
        "a valve gets about the bucket and its refills in 24 h, never more, and every property holds",
        () => {
          const { report, rig } = execute(plan);
          nothingBroken(report);
          for (const valveId of VALVE_IDS) {
            const most = busiest(rig, valveId);
            expect(most).toBeGreaterThanOrEqual(BUCKET + 40);
            expect(most).toBeLessThanOrEqual(BUCKET + 48 + START_TOKENS);
          }
        },
        PLAN_MS,
      );
    });
  });

  describe("preview", () => {
    describe("Starting from a settled system, with a valid config change and no faults", () => {
      it(
        "previewHolds: the publishes the valves receive until 30 min pass without one, mode and frost writes included, are exactly the change's planned writes, in order per valve",
        () => {
          fc.assert(fc.property(changeArbitrary, previewHolds), { seed: SEED, numRuns: NUM_RUNS });
        },
        SLOW_MS,
      );
    });
  });
});

// Preview ------------------------------------------------------------------------------------------

/**
 * A config change; with `overridden`, room `a` (the TRVZB's) was overridden at 22 until cancelled
 * through the API and its valves settled in `heat`, so that a change that moves a valve in or out
 * of it plans mode writes (a take-over); `frost` is the house frost preset, for frost writes. A
 * person's change at a valve is adopted (Task 6), so it no longer makes Heatmaster plan writes.
 */
type Change = Readonly<{
  placement: Placement;
  schedules: Readonly<{ default: Variant; alt: Variant }>;
  comfort: number;
  frost: number;
  overridden: boolean;
}>;

const changeArbitrary: fc.Arbitrary<Change> = fc.record({
  placement: fc.tuple(
    fc.constantFrom<RoomName | null>("a", "b", "c", null),
    fc.constantFrom<RoomName | null>("a", "b", "c", null),
  ),
  schedules: fc.record({
    default: fc.constantFrom<Variant>(0, 1, 2),
    alt: fc.constantFrom<Variant>(0, 1, 2),
  }),
  comfort: fc.integer({ min: 36, max: 48 }).map((n) => n / 2),
  frost: fc.integer({ min: 8, max: 34 }).map((n) => n / 2),
  overridden: fc.boolean(),
});

/** Steps until no valve is written to for 30 min, or 6 h passed. */
function untilQuiet(sim: SimDriver): void {
  let quiet = 0;
  let logged = sim.log().length;
  const start = sim.elapsed();
  while (quiet < 30 * MINUTE_MS && sim.elapsed() - start < 6 * HOUR_MS) {
    sim.step(30 * 1000);
    const writes = sim
      .log()
      .slice(logged)
      .filter((e) => e.effect.kind === "publish").length;
    logged = sim.log().length;
    quiet = writes > 0 ? 0 : quiet + 30 * 1000;
  }
}

function settledSystem(): SimDriver {
  const config = modelConfig({ default: 0, alt: 1 }, false);
  const membership = modelMembership(["a", "b"]);
  const rooms = resolveRooms(config, membership).rooms;
  const sim = createSimDriver({
    config,
    membership,
    ledger: recordedLedger([
      { valveId: VALVE_IDS[0], model: "trvzb" },
      { valveId: VALVE_IDS[1], model: "trv_zbt" },
    ]),
    valves: [
      { ...inSyncValve(config, rooms, "a", VALVE_IDS[0], "trvzb"), selfReports: true },
      { ...inSyncValve(config, rooms, "b", VALVE_IDS[1], "trv_zbt"), selfReports: true },
    ],
    sensors: ROOM_NAMES.filter((n) => n !== "c").map((n) => ({ ref: sensorOf(n), value: 20 })),
  });
  // Until no valve is written to for 30 min.
  let quiet = 0;
  let logged = 0;
  while (quiet < 30 * MINUTE_MS && sim.elapsed() < 6 * HOUR_MS) {
    sim.step(30 * 1000);
    const writes = sim
      .log()
      .slice(logged)
      .filter((e) => e.effect.kind === "publish").length;
    logged = sim.log().length;
    quiet = writes > 0 ? 0 : quiet + 30 * 1000;
  }
  return sim;
}

function previewHolds(change: Change): void {
  const sim = settledSystem();
  const base = modelConfig(change.schedules, false);
  const config = {
    ...base,
    presets: { ...base.presets, comfort: change.comfort, frost: change.frost },
  };
  if (change.overridden) {
    const end = { rule: "manual", durationMs: undefined } as const;
    sim.command("a", { kind: "set_target", celsius: 22, end });
    untilQuiet(sim);
  }
  const before = sim.log().length;
  // The devices move in Home Assistant; the change's preview reconciles over the new house, so
  // it sees the valves the next tick releases.
  sim.setMembership(modelMembership(change.placement));
  const result = sim.planChange(configToRaw(config));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const planned = new Map<string, unknown[]>();
  for (const write of result.plan.writes) {
    planned.set(write.valveId, [...(planned.get(write.valveId) ?? []), write.values]);
  }
  let quiet = 0;
  const start = sim.elapsed();
  while (quiet < 30 * MINUTE_MS && sim.elapsed() - start < 12 * HOUR_MS) {
    const logged = sim.log().length;
    sim.step(30 * 1000);
    const writes = sim
      .log()
      .slice(logged)
      .filter((e) => e.effect.kind === "publish").length;
    quiet = writes > 0 ? 0 : quiet + 30 * 1000;
  }
  const received = new Map<string, unknown[]>();
  for (const { effect } of sim.log().slice(before)) {
    if (effect.kind !== "publish") continue;
    received.set(effect.valveId, [...(received.get(effect.valveId) ?? []), effect.values]);
  }
  for (const valveId of VALVE_IDS) {
    expect(received.get(valveId) ?? [], valveId).toEqual(planned.get(valveId) ?? []);
  }
}
