import { ChangeRefused, capture } from "./change.ts";
import type { Capture } from "./change.ts";
import { isObservable, transportFaulted } from "./control.ts";
import type { Effect, World } from "./control.ts";
import { roomsOf, sameMembership } from "./house.ts";
import { withRecord } from "./ledger.ts";
import type { Ledger, StoredConfig } from "./ledger.ts";
import type { SettingKey } from "./settings.ts";

/** Why a valve that is in a room and has no ledger record has not joined. */
export type PendingReason =
  | "house_frozen"
  | "ledger_unreadable"
  | "transport_unusable"
  | "valve_not_observed"
  | "originals_unreadable";

/** A valve that waits to join; `unreadable` is filled for `originals_unreadable` only. */
export type Pending = Readonly<{
  valveId: string;
  roomId: string;
  reason: PendingReason;
  unreadable: readonly SettingKey[];
}>;

/**
 * What one reconcile decided: the stored config and ledger after it (the world's own when nothing
 * changed), the effects that save them, and the valves that joined, wait or were released, each
 * in valve-id order.
 */
export type Reconciliation = Readonly<{
  stored: StoredConfig | undefined;
  ledger: Ledger | undefined;
  effects: readonly Effect[];
  joined: readonly Capture[];
  pending: readonly Pending[];
  released: readonly string[];
}>;

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function unchanged(world: World, pending: readonly Pending[] = []): Reconciliation {
  return {
    stored: world.stored,
    ledger: world.ledger,
    effects: [],
    joined: [],
    pending,
    released: [],
  };
}

function sameReleasing(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [valveId, orderedAt] of a) if (b.get(valveId) !== orderedAt) return false;
  return true;
}

/** Each valve of the rooms with its room id; a valve listed twice keeps its first room. */
function wantedValves(world: World): ReadonlyMap<string, string> | undefined {
  const rooms = roomsOf(world.configState, world.stored, world.house);
  if (rooms === undefined) return undefined;
  const wanted = new Map<string, string>();
  for (const room of rooms) {
    for (const ref of room.valves) if (!wanted.has(ref.valveId)) wanted.set(ref.valveId, room.id);
  }
  return wanted;
}

type Check =
  | Readonly<{ ok: false; reason: PendingReason; unreadable: readonly SettingKey[] }>
  | Readonly<{ ok: true; taken: Capture; profile: string }>;

/**
 * The first join check a valve without a record fails, or its capture when it fails none. The
 * ledger is readable (its check comes first, in `reconcile`).
 */
function joinCheck(world: World, valveId: string): Check {
  const failed = (reason: PendingReason, unreadable: readonly SettingKey[] = []): Check => ({
    ok: false,
    reason,
    unreadable,
  });
  const view = world.devices.get(valveId);
  if (view === undefined || transportFaulted(world, view, valveId)) {
    return failed("transport_unusable");
  }
  const spec = view.spec;
  if (!isObservable(view) || spec === undefined) return failed("valve_not_observed");
  const taken = capture(valveId, spec, view.state);
  // Unknown originals are never accepted here: only `acceptUnknownOriginals` does that.
  if (taken.unreadable.length > 0) return failed("originals_unreadable", taken.unreadable);
  return { ok: true, taken, profile: spec.profile };
}

/**
 * Joins and releases valve by valve as the house's rooms say; see the task's pseudocode, whose
 * order is the contract. Nothing changes unless the config is readable and the house is linked;
 * while the house is frozen only the waiting valves are listed; without a schedule nothing joins
 * or is released, and only the membership is saved.
 */
export function reconcile(world: World): Reconciliation {
  const stored = world.stored;
  if (world.configState !== "ok" || stored === undefined) return unchanged(world);
  const wanted = wantedValves(world);
  if (wanted === undefined) return unchanged(world);
  const ids = [...wanted.keys()].sort(byId);
  const ledger = world.ledger;
  const house = world.house;
  if (house.kind !== "live") {
    const pending = ids
      .filter((valveId) => ledger?.records.has(valveId) !== true)
      .map((valveId): Pending => ({
        valveId,
        roomId: wanted.get(valveId) ?? "",
        reason: "house_frozen",
        unreadable: [],
      }));
    return unchanged(world, pending);
  }

  const nowMs = world.now.epochMilliseconds;
  const releasing = new Map(stored.releasing);
  let nextLedger = ledger;
  const joined: Capture[] = [];
  const pending: Pending[] = [];
  const released: string[] = [];
  const hasSchedule = stored.config.schedules.length > 0;
  if (hasSchedule && ledger === undefined) {
    for (const valveId of ids) {
      const roomId = wanted.get(valveId) ?? "";
      pending.push({ valveId, roomId, reason: "ledger_unreadable", unreadable: [] });
    }
  } else if (hasSchedule && ledger !== undefined) {
    let grown = ledger;
    for (const valveId of ids) {
      const roomId = wanted.get(valveId) ?? "";
      if (ledger.records.has(valveId)) {
        // A rejoin, or a valve moved from another room: its record is kept (R1).
        releasing.delete(valveId);
        continue;
      }
      const check = joinCheck(world, valveId);
      if (!check.ok) {
        pending.push({ valveId, roomId, reason: check.reason, unreadable: check.unreadable });
        continue;
      }
      grown = withRecord(grown, {
        valveId,
        profile: check.profile,
        adoptedAt: nowMs,
        originals: check.taken.originals,
      });
      // A valve releasing without a record (a stray) is in a room again, now with one.
      releasing.delete(valveId);
      joined.push(check.taken);
    }
    nextLedger = grown;
    const notInHa = new Set(house.notInHa);
    for (const valveId of [...ledger.records.keys()].sort(byId)) {
      if (wanted.has(valveId) || releasing.has(valveId) || notInHa.has(valveId)) continue;
      releasing.set(valveId, nowMs);
      released.push(valveId);
    }
  }

  const membershipChanged = !sameMembership(house.membership, stored.membership);
  const configChanged = membershipChanged || !sameReleasing(releasing, stored.releasing);
  const nextStored: StoredConfig = configChanged
    ? {
        ...stored,
        releasing,
        membership: membershipChanged ? house.membership : stored.membership,
      }
    : stored;
  const effects: Effect[] = [];
  if (joined.length > 0 && nextLedger !== undefined) {
    effects.push({ kind: "saveLedger", ledger: nextLedger });
    effects.push({ kind: "writeOriginalsCopy", ledger: nextLedger });
  }
  if (configChanged) effects.push({ kind: "saveConfig", stored: nextStored });
  return { stored: nextStored, ledger: nextLedger, effects, joined, pending, released };
}

/**
 * For a valve that `reconcile(world)` lists as pending with `originals_unreadable`: saves its
 * record, the unreadable originals `null`, then the copy. Any other valve is refused with
 * `valve_not_pending`.
 */
export function acceptUnknownOriginals(world: World, valveId: string): readonly Effect[] {
  const waiting = reconcile(world).pending.find((p) => p.valveId === valveId);
  const spec = world.devices.get(valveId)?.spec;
  const ledger = world.ledger;
  if (waiting?.reason !== "originals_unreadable" || spec === undefined || ledger === undefined) {
    throw new ChangeRefused("valve_not_pending", { valveId });
  }
  const taken = capture(valveId, spec, world.devices.get(valveId)?.state);
  const next = withRecord(ledger, {
    valveId,
    profile: spec.profile,
    adoptedAt: world.now.epochMilliseconds,
    originals: taken.originals,
  });
  return [
    { kind: "saveLedger", ledger: next },
    { kind: "writeOriginalsCopy", ledger: next },
  ];
}
