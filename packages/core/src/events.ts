import {
  clampRoomToNow,
  clampToNow,
  clearMarks,
  mark,
  newValveMemory,
  noteHeard,
} from "./memory.ts";
import type { GroupMemory, Memory, ValveMemory } from "./memory.ts";
import { stopped } from "./feed.ts";
import { importBucket, importFreeAsk } from "./pacing.ts";
import {
  VALVE_SILENT_AFTER_MS,
  countsAsHeard,
  newState,
  onLinkUp,
  onMessage,
} from "./observation.ts";
import type { Decoded, DeviceState } from "./observation.ts";
import type { Group, ValveSpec } from "./settings.ts";

export type Event =
  | Readonly<{
      kind: "device_message";
      deviceId: string;
      decoded: Decoded;
      lifeToken: string | undefined;
    }>
  | Readonly<{ kind: "rejoined"; deviceId: string }>
  | Readonly<{ kind: "bridge_restarted"; transport: string }>
  | Readonly<{ kind: "link_up"; transport: string }>
  | Readonly<{ kind: "resync_requested"; valveIds: ReadonlySet<string> }>
  | Readonly<{ kind: "push_failed"; valveId: string }>
  | Readonly<{ kind: "sent"; valveId: string; what: "refresh" | "publish"; at: number }>
  /**
   * A read a user triggered went out: it counts for the valve's spacing, not for tokens or asks.
   * A valve with no memory yet starts one with `bucketFullAt` (see `importBucket`) and `freeAskAt`
   * (see `importFreeAsk`), as the tick would start it, so that the stamps are kept.
   */
  | Readonly<{
      kind: "asked_directly";
      valveId: string;
      at: number;
      bucketFullAt: number;
      freeAskAt: number | undefined;
    }>;

export type Inbox = Readonly<{
  states: ReadonlyMap<string, DeviceState>;
  memory: Memory;
}>;

type Specs = ReadonlyMap<string, ValveSpec>;

function withValve(memory: Memory, valveId: string, vm: ValveMemory): Memory {
  const valves = new Map(memory.valves);
  valves.set(valveId, vm);
  return { ...memory, valves };
}

/** Marks every group of the valve, creating its memory first when it has none. */
function markValves(inbox: Inbox, valveIds: Iterable<string>, specs: Specs, nowMs: number): Inbox {
  let memory = inbox.memory;
  for (const id of valveIds) {
    const spec = specs.get(id);
    if (spec === undefined) continue;
    const vm = memory.valves.get(id) ?? newValveMemory(spec, nowMs);
    memory = withValve(memory, id, mark(vm, groupsOf(spec), nowMs));
  }
  return memory === inbox.memory ? inbox : { ...inbox, memory };
}

function groupsOf(spec: ValveSpec): Group[] {
  return spec.groups.map((gs) => gs.group);
}

function valvesOf(specs: Specs, transport: string): string[] {
  const prefix = `${transport}:`;
  return [...specs.keys()].filter((id) => id.startsWith(prefix));
}

function deviceMessage(
  inbox: Inbox,
  event: Extract<Event, { kind: "device_message" }>,
  specs: Specs,
  nowMs: number,
): Inbox {
  const { deviceId, decoded, lifeToken } = event;
  const before = inbox.states.get(deviceId) ?? newState(nowMs);
  const [after, returned] = onMessage(before, decoded, lifeToken, nowMs, VALVE_SILENT_AFTER_MS);
  const states = new Map(inbox.states);
  states.set(deviceId, after);
  const next: Inbox = { ...inbox, states };

  const spec = specs.get(deviceId);
  if (spec === undefined) return next;

  const heard = countsAsHeard(before, lifeToken);
  let memory = next.memory;
  const old = memory.valves.get(deviceId);
  if (heard && old !== undefined && after.heardAt !== undefined) {
    memory = withValve(memory, deviceId, clearMarks(noteHeard(old), spec, after.heardAt));
  }
  const result: Inbox = { ...next, memory };
  return returned ? markValves(result, [deviceId], specs, nowMs) : result;
}

/**
 * Memory stamped later than now, after a wall clock was set back (the shell turns that into
 * link_up): the transport's valves and every room are brought back to now.
 */
function clampMemory(memory: Memory, transport: string, nowMs: number): Memory {
  const prefix = `${transport}:`;
  const valves = new Map(memory.valves);
  for (const [id, vm] of memory.valves) {
    if (id.startsWith(prefix)) valves.set(id, clampToNow(vm, nowMs));
  }
  const rooms = new Map([...memory.rooms].map(([id, rm]) => [id, clampRoomToNow(rm, nowMs)]));
  return { ...memory, valves, rooms };
}

function linkUp(inbox: Inbox, transport: string, specs: Specs, nowMs: number): Inbox {
  const prefix = `${transport}:`;
  let states = inbox.states;
  for (const [id, state] of inbox.states) {
    if (!id.startsWith(prefix)) continue;
    if (states === inbox.states) states = new Map(inbox.states);
    (states as Map<string, DeviceState>).set(id, onLinkUp(state, nowMs));
  }
  const memory = clampMemory(inbox.memory, transport, nowMs);
  return markValves({ states, memory }, valvesOf(specs, transport), specs, nowMs);
}

function pushFailed(inbox: Inbox, valveId: string): Inbox {
  const vm = inbox.memory.valves.get(valveId);
  if (vm === undefined) return inbox;
  return { ...inbox, memory: withValve(inbox.memory, valveId, stopped(vm)) };
}

function sent(inbox: Inbox, event: Extract<Event, { kind: "sent" }>): Inbox {
  const vm = inbox.memory.valves.get(event.valveId);
  if (vm === undefined) return inbox;
  const field = event.what === "refresh" ? "askedAt" : "writtenAt";
  const groups: Partial<Record<Group, GroupMemory>> = {};
  for (const [group, gm] of Object.entries(vm.groups) as [Group, GroupMemory | undefined][]) {
    if (gm === undefined) continue;
    const m = gm.mark;
    const stamp = m?.[field];
    groups[group] =
      m !== undefined && stamp !== undefined && event.at > stamp
        ? { ...gm, mark: { ...m, [field]: event.at } }
        : gm;
  }
  return { ...inbox, memory: withValve(inbox.memory, event.valveId, { ...vm, groups }) };
}

function askedDirectly(
  inbox: Inbox,
  event: Extract<Event, { kind: "asked_directly" }>,
  specs: Specs,
): Inbox {
  const spec = specs.get(event.valveId);
  const vm =
    inbox.memory.valves.get(event.valveId) ??
    (spec === undefined
      ? undefined
      : importFreeAsk(
          importBucket(newValveMemory(spec, event.at), event.bucketFullAt, event.at),
          event.freeAskAt,
          event.at,
        ));
  if (vm === undefined) return inbox;
  const lastWriteAt = Math.max(vm.lastWriteAt ?? event.at, event.at);
  return { ...inbox, memory: withValve(inbox.memory, event.valveId, { ...vm, lastWriteAt }) };
}

/**
 * Applies what happened between two ticks. Never throws and never changes the given inbox.
 * `sent` and `asked_directly` do not use `nowMs`.
 */
export function applyEvent(inbox: Inbox, event: Event, specs: Specs, nowMs: number): Inbox {
  switch (event.kind) {
    case "device_message":
      return deviceMessage(inbox, event, specs, nowMs);
    case "rejoined":
      return markValves(inbox, [event.deviceId], specs, nowMs);
    case "bridge_restarted":
      return markValves(inbox, valvesOf(specs, event.transport), specs, nowMs);
    case "link_up":
      return linkUp(inbox, event.transport, specs, nowMs);
    case "resync_requested":
      return markValves(inbox, event.valveIds, specs, nowMs);
    case "push_failed":
      return pushFailed(inbox, event.valveId);
    case "sent":
      return sent(inbox, event);
    case "asked_directly":
      return askedDirectly(inbox, event, specs);
  }
}
