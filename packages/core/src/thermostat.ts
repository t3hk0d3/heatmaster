import { ChangeRefused } from "./change.ts";
import { membershipsOf, roomWeek } from "./control.ts";
import type { Effect, World } from "./control.ts";
import { EMPTY_ENTRY, mayHoldEntry, withHaEdit } from "./labels.ts";
import type { HaChangeItem, Membership, StoredConfig } from "./ledger.ts";
import { BOOST_DURATION_MS, END_RULES, PRESET_NAMES, effectivePresets } from "./model.ts";
import type {
  EndRule,
  ManualChange,
  PresetName,
  Room,
  RoomEntry,
  WindowAction,
  WindowEnd,
  WindowPatch,
} from "./model.ts";
import { activePoint } from "./schedule.ts";
import type { ValveMode, ValveSpec } from "./settings.ts";
import {
  SCHEDULE,
  SENT_KEPT,
  clampTarget,
  defaultEnd,
  endsAt,
  roomLimits,
  sameThermostat,
  sameWanted,
} from "./thermostat-rules.ts";
import { windowHolds } from "./window.ts";
import type { WindowOpening } from "./window.ts";

export {
  SCHEDULE,
  SENT_KEPT,
  SENT_RETIRE_MS,
  clampTarget,
  defaultEnd,
  ended,
  endsAt,
  roomLimits,
  sameThermostat,
  sameWanted,
} from "./thermostat-rules.ts";

/** Where a room change came from; callers outside a valve pass `valveId: undefined`. */
export type Origin = Readonly<{ source: "valve" | "climate" | "api"; valveId: string | undefined }>;

/**
 * A room's state: on its schedule, overridden at a target, or off. An override or off ends by its
 * `rule`, at `endsAt` (undefined: never); `since` is when it was made.
 */
export type Thermostat =
  | Readonly<{ kind: "schedule" }>
  | Readonly<{
      kind: "override";
      target: number;
      preset: PresetName | undefined;
      rule: EndRule;
      endsAt: number | undefined;
      origin: Origin;
      since: number;
    }>
  | Readonly<{
      kind: "off";
      rule: EndRule;
      endsAt: number | undefined;
      origin: Origin;
      since: number;
    }>;

/** A room that is not on its schedule. */
type Held = Exclude<Thermostat, Readonly<{ kind: "schedule" }>>;

/** What an override and an off share. */
type HeldFields = Pick<Held, "rule" | "endsAt" | "origin" | "since">;

/** By room id. A missing room is `SCHEDULE`; a room on its schedule is never stored. */
export type Thermostats = ReadonlyMap<string, Thermostat>;

/** What a valve is sent for a room state; `scheduled` says it follows the schedule (R18). */
export type ThermostatWanted = Readonly<{
  mode: ValveMode;
  setpoint: number | undefined;
  scheduled: boolean;
}>;

/** What a valve shows. */
export type ThermostatSeen = Readonly<{
  mode: ValveMode | undefined;
  setpoint: number | undefined;
}>;

/** A thermostat write, the instant it was sent, and what the valve showed then (R4.5). */
export type SentWrite = Readonly<{ wanted: ThermostatWanted; at: number; from: ThermostatSeen }>;

/** The week a scheduled state was confirmed under: its week key and its temperatures (R23). */
export type SavedWeek = Readonly<{ key: string; values: readonly number[] }>;

/**
 * What a managed valve is expected to show for its room (R3). `confirmed` undefined: the valve is
 * taken over. `sent` is newest first, holds each wanted state at most once and at most
 * `SENT_KEPT` writes. `written` is the week of the last schedule write sent to the valve, confirmed
 * or not. `previous` is the week written before it, kept until the valve shows a point of its saved
 * week (a TRV-ZBT's day write can be lost while it still reports, so it may still run that one).
 */
export type ValveExpectation = Readonly<{
  roomId: string;
  confirmed: ThermostatWanted | undefined;
  sent: readonly SentWrite[];
  week: SavedWeek | undefined;
  written: SavedWeek | undefined;
  previous: SavedWeek | undefined;
}>;

/** Everything `state.json` holds; `valves` is by valve id, `windows` by room id. */
export type ThermostatState = Readonly<{
  rooms: Thermostats;
  valves: ReadonlyMap<string, ValveExpectation>;
  windows: ReadonlyMap<string, WindowOpening>;
}>;

/** Every room on its schedule, no valve expectation, no opening. */
export const EMPTY_THERMOSTAT_STATE: ThermostatState = {
  rooms: new Map(),
  valves: new Map(),
  windows: new Map(),
};

/** How a change ends; `durationMs` undefined: the room's duration. */
export type EndChoice = Readonly<{ rule: EndRule; durationMs: number | undefined }>;

/** A change to a room's thermostat; `end` undefined: the room's default end. */
export type ThermostatCommand =
  | Readonly<{ kind: "set_target"; celsius: number; end: EndChoice | undefined }>
  | Readonly<{ kind: "set_preset"; preset: PresetName; end: EndChoice | undefined }>
  | Readonly<{ kind: "heat" }>
  | Readonly<{ kind: "off"; end: EndChoice | undefined }>
  | Readonly<{ kind: "resume" }>;

/** A choice made on a room's Home Assistant selects (R13). */
export type RoomChoice =
  | Readonly<{ kind: "schedule"; scheduleId: string }>
  | Readonly<{ kind: "override_end"; rule: EndRule }>
  | Readonly<{ kind: "window_enabled"; on: boolean }>
  | Readonly<{ kind: "window_temperature"; on: boolean }>
  | Readonly<{ kind: "window_action"; action: WindowAction }>
  | Readonly<{ kind: "window_end"; end: WindowEnd }>
  | Readonly<{ kind: "window_limit"; limitMs: number | undefined }>
  | Readonly<{ kind: "window_manual_change"; manualChange: ManualChange }>;

/** The temperatures a room's targets are held in, inclusive. */
export type RoomLimits = Readonly<{ min: number; max: number }>;

/** The managed valves' specs of a room. */
function roomSpecs(world: World, room: Room, kinds: ReadonlyMap<string, Membership>): ValveSpec[] {
  return room.valves.flatMap(({ valveId }) => {
    const spec = kinds.get(valveId) === "managed" ? world.devices.get(valveId)?.spec : undefined;
    return spec === undefined ? [] : [spec];
  });
}

/**
 * The room's thermostat after the command (R11: whether writes are held does not matter). Returns
 * `[{ kind: "saveThermostats", state }]` with only the room's thermostat replaced, or `[]` when the
 * result equals the current thermostat (R21). When the room's opening holds it and its
 * `manualChange` is `resume_heating`, the same state carries the opening suspended now (W6). Refuses with `config_unreadable`, then
 * `state_unreadable`, then `room_unknown` for a room that is not resolved, has no plan or has no
 * managed valve with a spec (R12).
 */
export function thermostatCommand(
  world: World,
  roomId: string,
  command: ThermostatCommand,
  origin: Origin,
): readonly Effect[] {
  const config = world.configState === "ok" ? world.stored?.config : undefined;
  if (config === undefined) throw new ChangeRefused("config_unreadable");
  const state = world.thermostats;
  if (state === undefined) throw new ChangeRefused("state_unreadable");
  const { rooms, kinds } = membershipsOf(world);
  const room = rooms.find((r) => r.id === roomId);
  const week = room === undefined ? undefined : roomWeek(config, room);
  const limits = room === undefined ? undefined : roomLimits(roomSpecs(world, room, kinds));
  if (room === undefined || week === undefined || limits === undefined) {
    throw new ChangeRefused("room_unknown", { roomId });
  }

  const now = world.now;
  const current = state.rooms.get(roomId) ?? SCHEDULE;
  const held = (end: EndChoice): HeldFields => ({
    rule: end.rule,
    endsAt: endsAt(end, room, week, now),
    origin,
    since: now.epochMilliseconds,
  });
  const override = (celsius: number, preset: PresetName | undefined, end: EndChoice): Held => ({
    kind: "override",
    target: clampTarget(celsius, limits),
    preset,
    ...held(end),
  });

  let next: Thermostat;
  switch (command.kind) {
    case "set_target":
      next = override(command.celsius, undefined, command.end ?? defaultEnd(room));
      break;
    case "set_preset": {
      const boost: EndChoice = { rule: "timer", durationMs: BOOST_DURATION_MS };
      const end = command.end ?? (command.preset === "boost" ? boost : defaultEnd(room));
      next = override(effectivePresets(config, room)[command.preset], command.preset, end);
      break;
    }
    case "heat":
      next =
        current.kind === "override"
          ? current
          : override(activePoint(week, now).temperature, undefined, defaultEnd(room));
      break;
    case "off":
      next = { kind: "off", ...held(command.end ?? defaultEnd(room)) };
      break;
    case "resume":
      next = SCHEDULE;
      break;
  }
  if (sameThermostat(next, current)) return [];
  const thermostats = new Map(state.rooms);
  if (next.kind === "schedule") thermostats.delete(roomId);
  else thermostats.set(roomId, next);
  const opening = state.windows.get(roomId);
  let windows = state.windows;
  if (
    opening !== undefined &&
    room.window.manualChange === "resume_heating" &&
    windowHolds(opening, room.window)
  ) {
    const suspended = new Map(state.windows);
    suspended.set(roomId, { ...opening, suspendedAt: now.epochMilliseconds });
    windows = suspended;
  }
  return [{ kind: "saveThermostats", state: { ...state, rooms: thermostats, windows } }];
}

type WindowChoice = Extract<RoomChoice, { kind: `window_${string}` }>;

/**
 * The window patch with the choice written over it, with the raw key and the raw text value of
 * the change; undefined when the patch already holds that value.
 */
function windowEdit(
  patch: WindowPatch,
  choice: WindowChoice,
): Readonly<{ window: WindowPatch; setting: string; value: string }> | undefined {
  switch (choice.kind) {
    case "window_enabled":
      if (patch.enabled === choice.on) return undefined;
      return {
        window: { ...patch, enabled: choice.on },
        setting: "enabled",
        value: String(choice.on),
      };
    case "window_temperature":
      if (patch.temperature.enabled === choice.on) return undefined;
      return {
        window: { ...patch, temperature: { ...patch.temperature, enabled: choice.on } },
        setting: "temperature.enabled",
        value: String(choice.on),
      };
    case "window_action":
      if (patch.action === choice.action) return undefined;
      return {
        window: { ...patch, action: choice.action },
        setting: "action",
        value: choice.action,
      };
    case "window_end":
      if (patch.temperature.end === choice.end) return undefined;
      return {
        window: { ...patch, temperature: { ...patch.temperature, end: choice.end } },
        setting: "temperature.end",
        value: choice.end,
      };
    case "window_limit": {
      const limit = choice.limitMs ?? "none";
      if (patch.limitMs === limit) return undefined;
      return {
        window: { ...patch, limitMs: limit },
        setting: "limit_min",
        value: limit === "none" ? "none" : String(limit / 60_000),
      };
    }
    case "window_manual_change":
      if (patch.manualChange === choice.manualChange) return undefined;
      return {
        window: { ...patch, manualChange: choice.manualChange },
        setting: "manual_change",
        value: choice.manualChange,
      };
  }
}

/**
 * The stored config with the room's entry changed by the choice (created when missing), saved as a
 * Home Assistant change through `withHaEdit` (R13). The default schedule clears `scheduleId`. A
 * choice equal to the entry returns `stored` itself. Refuses an unknown schedule with
 * `schedule_unknown`, and an entry the config cannot hold with `room_unknown`.
 */
export function withRoomChoice(
  stored: StoredConfig,
  roomId: string,
  choice: RoomChoice,
  nowMs: number,
): StoredConfig {
  const config = stored.config;
  const entry = config.rooms.get(roomId) ?? EMPTY_ENTRY;
  let changed: RoomEntry;
  let item: HaChangeItem;
  if (choice.kind === "schedule") {
    const scheduleId = choice.scheduleId;
    if (!config.schedules.some((s) => s.id === scheduleId)) {
      throw new ChangeRefused("schedule_unknown", { scheduleId });
    }
    const wanted = scheduleId === config.defaultScheduleId ? undefined : scheduleId;
    if (entry.scheduleId === wanted) return stored;
    changed = { ...entry, scheduleId: wanted };
    item = {
      kind: "schedule",
      areaId: roomId,
      entityId: undefined,
      scheduleId,
      rule: undefined,
      setting: undefined,
      value: undefined,
    };
  } else if (choice.kind === "override_end") {
    if (entry.overrideEnd === choice.rule) return stored;
    changed = { ...entry, overrideEnd: choice.rule };
    item = {
      kind: "override_end",
      areaId: roomId,
      entityId: undefined,
      scheduleId: undefined,
      rule: choice.rule,
      setting: undefined,
      value: undefined,
    };
  } else {
    const edit = windowEdit(entry.window, choice);
    if (edit === undefined) return stored;
    changed = { ...entry, window: edit.window };
    item = {
      kind: "window_setting",
      areaId: roomId,
      entityId: undefined,
      scheduleId: undefined,
      rule: undefined,
      setting: edit.setting,
      value: edit.value,
    };
  }
  if (!mayHoldEntry(config.rooms, roomId)) throw new ChangeRefused("room_unknown", { roomId });
  const rooms = new Map(config.rooms);
  rooms.set(roomId, changed);
  return withHaEdit(stored, { config: { ...config, rooms }, items: [item] }, nowMs);
}

// Raw form ---------------------------------------------------------------------------------------

/** `{ [key]: value }`, or nothing when the value is undefined. */
function optional(key: string, value: unknown): Record<string, unknown> {
  return value === undefined ? {} : { [key]: value };
}

function thermostatToRaw(thermostat: Held): Record<string, unknown> {
  return {
    kind: thermostat.kind,
    ...(thermostat.kind === "override"
      ? { target: thermostat.target, ...optional("preset", thermostat.preset) }
      : {}),
    rule: thermostat.rule,
    ...optional("ends_at", thermostat.endsAt),
    origin: {
      source: thermostat.origin.source,
      ...optional("valve_id", thermostat.origin.valveId),
    },
    since: thermostat.since,
  };
}

function wantedToRaw(wanted: ThermostatWanted): Record<string, unknown> {
  return {
    mode: wanted.mode,
    ...optional("setpoint", wanted.setpoint),
    scheduled: wanted.scheduled,
  };
}

function expectationToRaw(expectation: ValveExpectation): Record<string, unknown> {
  return {
    room: expectation.roomId,
    ...optional(
      "confirmed",
      expectation.confirmed === undefined ? undefined : wantedToRaw(expectation.confirmed),
    ),
    sent: expectation.sent.map((write) => ({
      ...wantedToRaw(write.wanted),
      at: write.at,
      from: { ...optional("mode", write.from.mode), ...optional("setpoint", write.from.setpoint) },
    })),
    ...optional("week", weekToRaw(expectation.week)),
    ...optional("written", weekToRaw(expectation.written)),
    ...optional("previous", weekToRaw(expectation.previous)),
  };
}

function weekToRaw(week: SavedWeek | undefined): Record<string, unknown> | undefined {
  return week === undefined ? undefined : { key: week.key, values: [...week.values] };
}

function openingToRaw(opening: WindowOpening): Record<string, unknown> {
  return {
    started_at: opening.startedAt,
    ...optional("temperature_since", opening.temperatureSince),
    ...optional("temperature_ended_at", opening.temperatureEndedAt),
    ...optional("suspended_at", opening.suspendedAt),
    ...optional("limit_at", opening.limitAt),
    ...optional("notified_at", opening.notifiedAt),
    ...optional("dropped_at", opening.droppedAt),
    ...optional("ended_at", opening.endedAt),
  };
}

/** `raw` itself; a RangeError naming `what` when it holds an instant the reader refuses. */
function instantsRaw(raw: Record<string, unknown>, what: string): Record<string, unknown> {
  const bad = Object.values(raw).some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0);
  if (bad) throw new RangeError(`the opening of ${what} holds an instant that is not valid`);
  return raw;
}

/** Every number in `raw`, at any depth, is finite. */
function allFinite(raw: unknown): boolean {
  if (typeof raw === "number") return Number.isFinite(raw);
  if (Array.isArray(raw)) return raw.every(allFinite);
  if (isRecord(raw)) return Object.values(raw).every(allFinite);
  return true;
}

/** `raw` itself; a RangeError naming `what` when it holds a number JSON cannot hold. */
function finiteRaw(raw: Record<string, unknown>, what: string): Record<string, unknown> {
  if (!allFinite(raw)) throw new RangeError(`the room state of ${what} holds a non-finite number`);
  return raw;
}

/**
 * `{ rooms, valves, windows }` of `state.json`; the store adds `version`. Keys left undefined are
 * left out. Throws a RangeError for a state holding a number that is not finite (JSON would write
 * `null`, and the file could not be read back), or an opening holding a negative instant.
 */
export function thermostatStateToRaw(state: ThermostatState): Record<string, unknown> {
  const rooms: Record<string, unknown> = {};
  for (const [roomId, thermostat] of state.rooms) {
    if (thermostat.kind !== "schedule") {
      rooms[roomId] = finiteRaw(thermostatToRaw(thermostat), `room ${roomId}`);
    }
  }
  const valves: Record<string, unknown> = {};
  for (const [valveId, expectation] of state.valves) {
    valves[valveId] = finiteRaw(expectationToRaw(expectation), `valve ${valveId}`);
  }
  const windows: Record<string, unknown> = {};
  for (const [roomId, opening] of state.windows) {
    windows[roomId] = instantsRaw(openingToRaw(opening), `room ${roomId}`);
  }
  return { rooms, valves, windows };
}

/** Thrown inside the reader on anything not well formed; never leaves this module. */
const MALFORMED = new Error("malformed thermostat state");

function malformed(): never {
  throw MALFORMED;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The object, which holds every `required` key and no key outside `required` and `optional`. */
function objectOf(
  value: unknown,
  required: readonly string[],
  optionalKeys: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) return malformed();
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optionalKeys.includes(key)) malformed();
  }
  for (const key of required) if (value[key] === undefined) malformed();
  return value;
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : malformed();
}

/** An instant: a finite number of epoch milliseconds, not negative. */
function instant(value: unknown): number {
  const ms = finite(value);
  return ms >= 0 ? ms : malformed();
}

function text(value: unknown): string {
  return typeof value === "string" ? value : malformed();
}

function flag(value: unknown): boolean {
  return typeof value === "boolean" ? value : malformed();
}

function oneOf<T extends string>(value: unknown, names: readonly T[]): T {
  return names.find((name) => name === value) ?? malformed();
}

function maybe<T>(value: unknown, read: (value: unknown) => T): T | undefined {
  return value === undefined ? undefined : read(value);
}

const MODES: readonly ValveMode[] = ["off", "auto", "heat"];
const SOURCES: readonly Origin["source"][] = ["valve", "climate", "api"];
const HELD_KINDS: readonly Held["kind"][] = ["override", "off"];

function originFromRaw(value: unknown): Origin {
  const obj = objectOf(value, ["source"], ["valve_id"]);
  return { source: oneOf(obj.source, SOURCES), valveId: maybe(obj.valve_id, text) };
}

function thermostatFromRaw(value: unknown): Held {
  const kind = oneOf(isRecord(value) ? value.kind : undefined, HELD_KINDS);
  const common = ["kind", "rule", "origin", "since"];
  const obj =
    kind === "override"
      ? objectOf(value, [...common, "target"], ["preset", "ends_at"])
      : objectOf(value, common, ["ends_at"]);
  const held: HeldFields = {
    rule: oneOf(obj.rule, END_RULES),
    endsAt: maybe(obj.ends_at, finite),
    origin: originFromRaw(obj.origin),
    since: finite(obj.since),
  };
  if (kind === "off") return { kind, ...held };
  const preset = maybe(obj.preset, (raw) => oneOf(raw, PRESET_NAMES));
  return { kind, target: finite(obj.target), preset, ...held };
}

const WANTED_KEYS = ["mode", "scheduled"];

function wantedOf(obj: Readonly<Record<string, unknown>>): ThermostatWanted {
  return {
    mode: oneOf(obj.mode, MODES),
    setpoint: maybe(obj.setpoint, finite),
    scheduled: flag(obj.scheduled),
  };
}

function sentFromRaw(value: unknown): SentWrite {
  const obj = objectOf(value, [...WANTED_KEYS, "at", "from"], ["setpoint"]);
  const from = objectOf(obj.from, [], ["mode", "setpoint"]);
  return {
    wanted: wantedOf(obj),
    at: finite(obj.at),
    from: {
      mode: maybe(from.mode, (raw) => oneOf(raw, MODES)),
      setpoint: maybe(from.setpoint, finite),
    },
  };
}

/** Newest first; of equal wanted states the newer is kept; at most `SENT_KEPT`. */
function sentListFromRaw(value: unknown): readonly SentWrite[] {
  if (!Array.isArray(value)) return malformed();
  const writes = (value as readonly unknown[]).map(sentFromRaw).sort((a, b) => b.at - a.at);
  return writes
    .filter(
      (write, i) => !writes.slice(0, i).some((newer) => sameWanted(newer.wanted, write.wanted)),
    )
    .slice(0, SENT_KEPT);
}

function weekFromRaw(value: unknown): SavedWeek {
  const obj = objectOf(value, ["key", "values"]);
  if (!Array.isArray(obj.values)) return malformed();
  return { key: text(obj.key), values: (obj.values as readonly unknown[]).map(finite) };
}

function expectationFromRaw(value: unknown): ValveExpectation {
  const obj = objectOf(value, ["room", "sent"], ["confirmed", "week", "written", "previous"]);
  return {
    roomId: text(obj.room),
    confirmed: maybe(obj.confirmed, (raw) => wantedOf(objectOf(raw, WANTED_KEYS, ["setpoint"]))),
    sent: sentListFromRaw(obj.sent),
    week: maybe(obj.week, weekFromRaw),
    written: maybe(obj.written, weekFromRaw),
    previous: maybe(obj.previous, weekFromRaw),
  };
}

function openingFromRaw(value: unknown): WindowOpening {
  const obj = objectOf(
    value,
    ["started_at"],
    [
      "temperature_since",
      "temperature_ended_at",
      "suspended_at",
      "limit_at",
      "notified_at",
      "dropped_at",
      "ended_at",
    ],
  );
  return {
    startedAt: instant(obj.started_at),
    temperatureSince: maybe(obj.temperature_since, instant),
    temperatureEndedAt: maybe(obj.temperature_ended_at, instant),
    suspendedAt: maybe(obj.suspended_at, instant),
    limitAt: maybe(obj.limit_at, instant),
    notifiedAt: maybe(obj.notified_at, instant),
    droppedAt: maybe(obj.dropped_at, instant),
    endedAt: maybe(obj.ended_at, instant),
  };
}

/** An object keyed by id, each item read; a missing one is an empty map. */
function mapFromRaw<T>(value: unknown, read: (value: unknown) => T): ReadonlyMap<string, T> {
  if (value === undefined) return new Map();
  if (!isRecord(value)) return malformed();
  return new Map(Object.entries(value).map(([id, item]) => [id, read(item)]));
}

/**
 * Reads `{ rooms, valves, windows }` of `state.json`; undefined for anything not well formed,
 * including a missing `windows` key or an opening's instant that is negative. A missing `rooms` or
 * `valves` key is an empty map.
 */
export function thermostatStateFromRaw(raw: unknown): ThermostatState | undefined {
  try {
    const doc = objectOf(raw, ["windows"], ["rooms", "valves"]);
    return {
      rooms: mapFromRaw(doc.rooms, thermostatFromRaw),
      valves: mapFromRaw(doc.valves, expectationFromRaw),
      windows: mapFromRaw(doc.windows, openingFromRaw),
    };
  } catch (error) {
    if (error === MALFORMED) return undefined;
    throw error;
  }
}
