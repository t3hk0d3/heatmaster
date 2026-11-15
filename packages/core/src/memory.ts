import type { Group, ValveSpec } from "./settings.ts";

/**
 * "Do not trust the cached value of this group." `askedAt` is when the valve was last asked to
 * report since the marking; `writtenAt` is when the group was last sent in full since the marking.
 */
export type Mark = Readonly<{
  at: number;
  askedAt: number | undefined;
  writtenAt: number | undefined;
}>;

export type WriteRecord = Readonly<{ at: number; marked: boolean }>;

export type GroupMemory = Readonly<{
  desiredKey: string | undefined;
  writes: readonly WriteRecord[];
  mark: Mark | undefined;
  assertedAt: number;
}>;

/**
 * Per valve, in memory only. `asks` holds the times of the refreshes sent since the valve was last
 * heard, oldest first. `lastWriteAt` is the last write, setpoint write or refresh. `lastPushAt` is
 * the last temperature push since this memory was created; `stopped` does not clear it.
 */
export type ValveMemory = Readonly<{
  groups: Readonly<Partial<Record<Group, GroupMemory>>>;
  tokens: number;
  tokensAt: number;
  lastWriteAt: number | undefined;
  asks: readonly number[];
  nudgeDue: boolean;
  feedValue: number | undefined;
  feedAt: number | undefined;
  lastPushAt: number | undefined;
  feedLostSince: number | undefined;
  equalSince: number | undefined;
}>;

export type RoomMemory = Readonly<{ freshSince: number | undefined }>;

export type Memory = Readonly<{
  valves: ReadonlyMap<string, ValveMemory>;
  rooms: ReadonlyMap<string, RoomMemory>;
}>;

export const EMPTY_MEMORY: Memory = { valves: new Map(), rooms: new Map() };

/** Tokens a valve starts with (*provisional*). */
export const START_TOKENS = 4;

/** Elapsed time from `at` to `nowMs`; a clock that went back counts as zero. */
export function since(at: number, nowMs: number): number {
  return Math.max(0, nowMs - at);
}

function freshMark(nowMs: number): Mark {
  return { at: nowMs, askedAt: undefined, writtenAt: undefined };
}

/** Applies `update` to each group the memory holds, keeping the others as they are. */
function mapGroups(
  vm: ValveMemory,
  update: (group: Group, gm: GroupMemory) => GroupMemory,
): ValveMemory {
  const groups: Partial<Record<Group, GroupMemory>> = {};
  for (const [group, gm] of Object.entries(vm.groups) as [Group, GroupMemory | undefined][]) {
    if (gm !== undefined) groups[group] = update(group, gm);
  }
  return { ...vm, groups };
}

function isReadable(spec: ValveSpec, group: Group): boolean {
  return spec.groups.some((g) => g.group === group && g.readable);
}

export function newValveMemory(spec: ValveSpec, nowMs: number): ValveMemory {
  const groups: Partial<Record<Group, GroupMemory>> = {};
  for (const gs of spec.groups) {
    groups[gs.group] = {
      desiredKey: undefined,
      writes: [],
      mark: freshMark(nowMs),
      assertedAt: nowMs,
    };
  }
  return {
    groups,
    tokens: START_TOKENS,
    tokensAt: nowMs,
    lastWriteAt: undefined,
    asks: [],
    nudgeDue: false,
    feedValue: undefined,
    feedAt: undefined,
    lastPushAt: undefined,
    feedLostSince: undefined,
    equalSince: undefined,
  };
}

/**
 * Sets a fresh mark on each named group that has none, or whose mark was acted on (asked or
 * written). A mark not acted on yet is kept. Groups the memory does not hold are skipped.
 */
export function mark(vm: ValveMemory, groups: Iterable<Group>, nowMs: number): ValveMemory {
  const named = new Set(groups);
  return mapGroups(vm, (group, gm) => {
    if (!named.has(group)) return gm;
    const m = gm.mark;
    if (m !== undefined && m.askedAt === undefined && m.writtenAt === undefined) return gm;
    return { ...gm, mark: freshMark(nowMs) };
  });
}

/** Marks each unmarked group whose `maxAgeMs` is set and has passed since `assertedAt`. */
export function markByAge(vm: ValveMemory, spec: ValveSpec, nowMs: number): ValveMemory {
  const due: Group[] = [];
  for (const gs of spec.groups) {
    const gm = vm.groups[gs.group];
    if (gm === undefined || gm.mark !== undefined || gs.maxAgeMs === undefined) continue;
    if (since(gm.assertedAt, nowMs) >= gs.maxAgeMs) due.push(gs.group);
  }
  return due.length === 0 ? vm : mark(vm, due, nowMs);
}

/** Empties `asks`. Called whenever the valve is heard. */
export function noteHeard(vm: ValveMemory): ValveMemory {
  return { ...vm, asks: [] };
}

/**
 * Removes a readable group's mark when it was asked strictly before `heardAt`, and an unreadable
 * group's mark when it was written strictly before `heardAt`; each removal sets `assertedAt`.
 */
export function clearMarks(vm: ValveMemory, spec: ValveSpec, heardAt: number): ValveMemory {
  return mapGroups(vm, (group, gm) => {
    const m = gm.mark;
    if (m === undefined) return gm;
    const evidence = isReadable(spec, group) ? m.askedAt : m.writtenAt;
    if (evidence === undefined || evidence >= heardAt) return gm;
    return { ...gm, mark: undefined, assertedAt: heardAt };
  });
}

/** An unreadable, marked group of a valve heard at or after the marking: send it in full. */
export function markedReady(
  vm: ValveMemory,
  spec: ValveSpec,
  group: Group,
  heardAt: number | undefined,
): boolean {
  const m = vm.groups[group]?.mark;
  if (m === undefined || isReadable(spec, group)) return false;
  return heardAt !== undefined && heardAt >= m.at;
}

/**
 * True when a readable group is marked, or an unreadable group is marked and the valve was not
 * heard at or after the marking.
 */
export function needsAsk(vm: ValveMemory, spec: ValveSpec, heardAt: number | undefined): boolean {
  return spec.groups.some((gs) => {
    const m = vm.groups[gs.group]?.mark;
    if (m === undefined) return false;
    if (gs.readable) return true;
    return heardAt === undefined || heardAt < m.at;
  });
}
