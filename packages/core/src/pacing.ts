import { since, type GroupMemory, type ValveMemory, type WriteRecord } from "./memory.ts";
import type { Group, ValveSpec } from "./settings.ts";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** Least time between two requests to one valve: writes, the setpoint write and refreshes. */
export const SPACING_MS = 2 * 1000;
/** Wait before the n-th repeat (n = 1, 2, 3, 4 and on). */
export const BACKOFF_MS: readonly number[] = [2 * MINUTE_MS, 10 * MINUTE_MS, HOUR_MS, 6 * HOUR_MS];
/** Writes of one desired value count for this long. */
export const WINDOW_MS = 24 * HOUR_MS;
/** Most tokens a valve holds. */
export const BUCKET = 6;
/** One token comes back after this long. */
export const REFILL_MS = 30 * MINUTE_MS;
/** Unmarked writes of one value in the window after which the setting is not holding. */
export const NOT_HOLDING_AFTER = 3;

/**
 * Tokens at `nowMs` in whole milliseconds of refill (one token = `REFILL_MS`), so that a sum of
 * refills that reaches a whole token is not lost to rounding.
 */
function tokenMs(vm: ValveMemory, nowMs: number): number {
  return Math.min(
    BUCKET * REFILL_MS,
    Math.round(vm.tokens * REFILL_MS) + since(vm.tokensAt, nowMs),
  );
}

/**
 * The time the bucket is full again: the one stamp kept across a restart. It carries the level
 * exactly, `BUCKET - max(0, stamp - t) / REFILL_MS` tokens at `t`; a full bucket gives `nowMs`.
 */
export function exportBucket(vm: ValveMemory, nowMs: number): number {
  return nowMs + BUCKET * REFILL_MS - tokenMs(vm, nowMs);
}

/**
 * Sets the bucket from a stamp made by `exportBucket`. A stamp later than a whole empty bucket
 * away (the clock went back) counts as exactly that far; one not after `nowMs` is a full bucket.
 */
export function importBucket(vm: ValveMemory, bucketFullAt: number, nowMs: number): ValveMemory {
  const missing = Math.min(BUCKET * REFILL_MS, Math.max(0, bucketFullAt - nowMs));
  return { ...vm, tokens: (BUCKET * REFILL_MS - missing) / REFILL_MS, tokensAt: nowMs };
}

function hasToken(vm: ValveMemory, nowMs: number): boolean {
  return tokenMs(vm, nowMs) >= REFILL_MS;
}

/** Takes one token and stamps the request. */
function take(vm: ValveMemory, nowMs: number): ValveMemory {
  return {
    ...vm,
    tokens: (tokenMs(vm, nowMs) - REFILL_MS) / REFILL_MS,
    tokensAt: nowMs,
    lastWriteAt: nowMs,
  };
}

function spaced(vm: ValveMemory, nowMs: number): boolean {
  return vm.lastWriteAt === undefined || since(vm.lastWriteAt, nowMs) >= SPACING_MS;
}

function step(n: number): number {
  return BACKOFF_MS[Math.min(n, BACKOFF_MS.length) - 1] ?? 0;
}

/** Whether a request may follow earlier ones at the times `times`, by the backoff. */
function backedOff(times: readonly number[], nowMs: number): boolean {
  if (times.length === 0) return true;
  return since(Math.max(...times), nowMs) >= step(times.length);
}

function recent(gm: GroupMemory, nowMs: number): readonly WriteRecord[] {
  return gm.writes.filter((w) => since(w.at, nowMs) <= WINDOW_MS);
}

/**
 * The write records that can still change an answer: the newest `BACKOFF_MS.length` by `at` and
 * the newest `NOT_HOLDING_AFTER` unmarked ones by `at`. The window keeps a suffix by time, so the
 * capped count, the latest time and the capped unmarked count are the same as with every record,
 * whatever the clock does. Returned oldest first.
 */
function keptWrites(writes: readonly WriteRecord[]): readonly WriteRecord[] {
  const byAt = [...writes].sort((a, b) => a.at - b.at);
  const kept = new Set([
    ...byAt.slice(-BACKOFF_MS.length),
    ...byAt.filter((w) => !w.marked).slice(-NOT_HOLDING_AFTER),
  ]);
  return byAt.filter((w) => kept.has(w));
}

/** The newest `BACKOFF_MS.length` asks by time, oldest first: all the backoff can read. */
function keptAsks(asks: readonly number[]): readonly number[] {
  return [...asks].sort((a, b) => a - b).slice(-BACKOFF_MS.length);
}

function withGroup(vm: ValveMemory, group: Group, gm: GroupMemory): ValveMemory {
  return { ...vm, groups: { ...vm.groups, [group]: gm } };
}

/** When the key differs from the stored one: stores it and empties the group's writes. */
export function noteDesired(vm: ValveMemory, group: Group, desiredKey: string): ValveMemory {
  const gm = vm.groups[group];
  if (gm === undefined || gm.desiredKey === desiredKey) return vm;
  return withGroup(vm, group, { ...gm, desiredKey, writes: [] });
}

export function mayWrite(vm: ValveMemory, group: Group, nowMs: number): boolean {
  const gm = vm.groups[group];
  const times = gm === undefined ? [] : recent(gm, nowMs).map((w) => w.at);
  return spaced(vm, nowMs) && hasToken(vm, nowMs) && backedOff(times, nowMs);
}

export function charge(vm: ValveMemory, group: Group, nowMs: number, marked: boolean): ValveMemory {
  const taken = take(vm, nowMs);
  const gm = vm.groups[group];
  if (gm === undefined) return taken;
  const m = gm.mark;
  return withGroup(taken, group, {
    ...gm,
    writes: keptWrites([...gm.writes, { at: nowMs, marked }]),
    mark: marked && m !== undefined ? { ...m, writtenAt: nowMs } : m,
  });
}

/** Groups with `NOT_HOLDING_AFTER` or more unmarked writes in the window. */
export function notHolding(vm: ValveMemory, nowMs: number): readonly Group[] {
  const groups: Group[] = [];
  for (const [group, gm] of Object.entries(vm.groups) as [Group, GroupMemory | undefined][]) {
    if (gm === undefined) continue;
    const unmarked = recent(gm, nowMs).filter((w) => !w.marked).length;
    if (unmarked >= NOT_HOLDING_AFTER) groups.push(group);
  }
  return groups;
}

/** For the one write that belongs to no group (the setpoint after a schedule change). */
export function maySpend(vm: ValveMemory, nowMs: number): boolean {
  return spaced(vm, nowMs) && hasToken(vm, nowMs);
}

export function spend(vm: ValveMemory, nowMs: number): ValveMemory {
  return take(vm, nowMs);
}

/**
 * Sets the time of the valve's last free ask from a stamp kept across a restart. A stamp after
 * `nowMs` (the clock went back) counts as `nowMs`.
 */
export function importFreeAsk(
  vm: ValveMemory,
  freeAskAt: number | undefined,
  nowMs: number,
): ValveMemory {
  return { ...vm, freeAskAt: freeAskAt === undefined ? undefined : Math.min(freeAskAt, nowMs) };
}

/** The memory's first ask, with no free ask in the last `REFILL_MS`: it may go without a token. */
function freeAsk(vm: ValveMemory, nowMs: number): boolean {
  return vm.firstAsk && (vm.freeAskAt === undefined || since(vm.freeAskAt, nowMs) >= REFILL_MS);
}

export function mayAsk(vm: ValveMemory, nowMs: number): boolean {
  return (
    spaced(vm, nowMs) && (hasToken(vm, nowMs) || freeAsk(vm, nowMs)) && backedOff(vm.asks, nowMs)
  );
}

/**
 * For a refresh: takes a token, or with none left uses the free ask (`freeAskAt` becomes now), and
 * stamps `askedAt` on the mark of every marked readable group.
 */
export function chargeAsk(vm: ValveMemory, spec: ValveSpec, nowMs: number): ValveMemory {
  const free = !hasToken(vm, nowMs) && freeAsk(vm, nowMs);
  const paid = free ? { ...vm, lastWriteAt: nowMs, freeAskAt: nowMs } : take(vm, nowMs);
  let next: ValveMemory = { ...paid, firstAsk: false, asks: keptAsks([...vm.asks, nowMs]) };
  for (const gs of spec.groups) {
    const gm = next.groups[gs.group];
    if (!gs.readable || gm?.mark === undefined) continue;
    next = withGroup(next, gs.group, { ...gm, mark: { ...gm.mark, askedAt: nowMs } });
  }
  return next;
}
