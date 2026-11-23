import { WEEKDAYS } from "../../src/index.ts";
import { Z2M_DAY_PAYLOAD, Z2M_KEYS } from "../../src/profiles/sonoff-codec.ts";
import { createSimValve, dayPayload, reported } from "./valve.ts";
import type { Weekday } from "../../src/index.ts";
import type { SelectValue, SimValve, SimValveOptions, Speech, ValveWrite } from "./valve.ts";

/** What the bridge hands to the application, in order. */
export type BridgeItem =
  | Readonly<{ kind: "message"; deviceId: string; payload: Readonly<Record<string, unknown>> }>
  | Readonly<{ kind: "rejoined"; deviceId: string }>
  | Readonly<{ kind: "link_up"; transport: string }>
  | Readonly<{ kind: "bridge_restarted"; transport: string }>;

export type SimBridge = Readonly<{
  addValve: (valveId: string, options: Omit<SimValveOptions, "onSpeak">) => SimValve;
  valve: (valveId: string) => SimValve;
  valveIds: () => readonly string[];
  /** A `set` message: the payload the real binding encodes. */
  write: (valveId: string, payload: Readonly<Record<string, unknown>>, nowMs: number) => void;
  /** A `get` message: the payload the real binding's `encodeRefresh` returns. */
  get: (valveId: string, payload: Readonly<Record<string, unknown>>, nowMs: number) => void;
  /** Lets the valves report by themselves. */
  advance: (nowMs: number) => void;
  /** Everything sent since the last call. */
  drain: () => readonly BridgeItem[];
  /** What was sent and has not been drained is lost (Heatmaster was not there). */
  discard: () => void;
  /** Zigbee2MQTT restarts: the group to edit is forgotten; `link_up`, `bridge_restarted`, then the replay. */
  restart: () => void;
  /** Home Assistant announces itself: the cache is sent again with the old tokens. */
  replay: () => void;
  rejoin: (valveId: string) => void;
  cache: (valveId: string) => Readonly<Record<string, unknown>>;
  editGroup: (valveId: string) => number | undefined;
  lastSeen: (valveId: string) => string;
}>;

interface Entry {
  valve: SimValve;
  cache: Record<string, unknown>;
  tokenMs: number;
  editGroup: number | undefined;
  /** The group whose days the cache holds (TRV-ZBT). */
  dayGroup: number;
}

const TRANSPORT = "z2m";
const HOUR_MS = 60 * 60 * 1000;

function iso(ms: number): string {
  return Temporal.Instant.fromEpochMilliseconds(ms).toString({ fractionalSecondDigits: 3 });
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function groupNumber(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 3 ? n : undefined;
}

export function createSimBridge(): SimBridge {
  const entries = new Map<string, Entry>();
  let out: BridgeItem[] = [];

  const entryOf = (valveId: string): Entry => {
    const entry = entries.get(valveId);
    if (entry === undefined) throw new Error(`no simulated valve ${valveId}`);
    return entry;
  };

  const message = (valveId: string, entry: Entry, extra: Record<string, unknown> = {}): void => {
    out.push({
      kind: "message",
      deviceId: valveId,
      payload: { ...entry.cache, ...extra, last_seen: iso(entry.tokenMs) },
    });
  };

  const refreshDays = (entry: Entry): void => {
    if (entry.valve.model !== "trv_zbt") return;
    const group = entry.editGroup ?? 1;
    const texts = entry.valve.truth().schedules[group];
    if (texts !== undefined) Object.assign(entry.cache, dayPayload(texts));
    entry.dayGroup = group;
  };

  const spoke = (valveId: string, speech: Speech, nowMs: number): void => {
    const entry = entryOf(valveId);
    // An echo repeats the token of the message before it; the valve's own message has a new one.
    if (speech.echo !== true) entry.tokenMs = Math.max(nowMs, entry.tokenMs + 1);
    const truth = reported(entry.valve.model, entry.valve.truth());
    if (speech.cause === "read" && speech.keys !== undefined) {
      for (const key of speech.keys) {
        if (Object.hasOwn(truth, key)) entry.cache[key] = truth[key];
      }
    } else {
      Object.assign(entry.cache, truth);
    }
    const extra: Record<string, unknown> = {};
    if (entry.valve.model === "trv_zbt" && speech.wroteDays)
      extra.weekly_schedule_status = "success";
    // The days in the message are the cache's: after a change of the group to edit they are the
    // previous group's, with a fresh token. The valve's own report of them reaches the cache later.
    message(valveId, entry, extra);
    if (speech.cause !== "read") refreshDays(entry);
  };

  return {
    addValve(valveId, options) {
      const valve: SimValve = createSimValve({
        ...options,
        onSpeak: (speech, nowMs) => {
          spoke(valveId, speech, nowMs);
        },
      });
      const truth = valve.truth();
      const cache: Record<string, unknown> = reported(valve.model, truth);
      if (valve.model === "trv_zbt") cache[Z2M_KEYS.editGroup] = "1";
      const days = truth.schedules[1];
      if (days !== undefined) Object.assign(cache, dayPayload(days));
      entries.set(valveId, {
        valve,
        cache,
        tokenMs: options.nowMs - HOUR_MS,
        editGroup: undefined,
        dayGroup: 1,
      });
      return valve;
    },
    valve: (valveId) => entryOf(valveId).valve,
    valveIds: () => [...entries.keys()],
    write(valveId, payload, nowMs) {
      const entry = entryOf(valveId);
      const model = entry.valve.model;
      const echoed: Record<string, unknown> = {};
      if (model === "trv_zbt" && Object.hasOwn(payload, Z2M_KEYS.editGroup)) {
        const group = groupNumber(payload[Z2M_KEYS.editGroup]);
        if (group !== undefined) {
          entry.editGroup = group;
          echoed[Z2M_KEYS.editGroup] = String(group);
        }
      }
      const texts: Partial<Record<Weekday, string>> = {};
      for (const day of WEEKDAYS) {
        const key = Z2M_DAY_PAYLOAD[day];
        const value = payload[key];
        if (!Object.hasOwn(payload, key) || typeof value !== "string") continue;
        texts[day] = value;
        // The TRVZB's days are echoed into the cache whether or not the write lands; the
        // TRV-ZBT's days are write-only and never enter the cache from a write.
        if (model === "trvzb") echoed[key] = value;
      }
      const days =
        Object.keys(texts).length === 0
          ? undefined
          : { group: model === "trvzb" ? 1 : (entry.editGroup ?? 1), texts };
      const activeGroup =
        model === "trv_zbt" ? groupNumber(payload[Z2M_KEYS.activeGroup]) : undefined;
      const rawSelect = payload[Z2M_KEYS.select];
      const select: SelectValue | undefined =
        rawSelect === "local_temperature" || rawSelect === "remote_temperature"
          ? rawSelect
          : undefined;
      const frostProtection = numberOf(payload[Z2M_KEYS.frost]);
      const rawMode = payload[Z2M_KEYS.mode];
      const mode =
        rawMode === "off" || rawMode === "auto" || rawMode === "heat" ? rawMode : undefined;
      const setpoint = numberOf(payload[Z2M_KEYS.setpoint]);
      const external = numberOf(payload[Z2M_KEYS.external]);
      if (external !== undefined) echoed[Z2M_KEYS.external] = external;

      if (Object.keys(echoed).length > 0) {
        Object.assign(entry.cache, echoed);
        message(valveId, entry); // the echo: the valve has not spoken, so the token is the old one
      }
      const write: ValveWrite = {
        days,
        activeGroup,
        select,
        frostProtection,
        mode,
        setpoint,
        external,
      };
      if (
        days === undefined &&
        activeGroup === undefined &&
        select === undefined &&
        frostProtection === undefined &&
        mode === undefined &&
        setpoint === undefined &&
        external === undefined
      ) {
        return;
      }
      entry.valve.receive({ kind: "write", write }, nowMs);
    },
    get(valveId, payload, nowMs) {
      entryOf(valveId).valve.receive({ kind: "read", keys: Object.keys(payload) }, nowMs);
    },
    advance(nowMs) {
      for (const entry of entries.values()) entry.valve.advance(nowMs);
    },
    drain() {
      const items = out;
      out = [];
      return items;
    },
    discard() {
      out = [];
    },
    restart() {
      for (const entry of entries.values()) entry.editGroup = undefined;
      out.push({ kind: "link_up", transport: TRANSPORT });
      out.push({ kind: "bridge_restarted", transport: TRANSPORT });
      for (const [valveId, entry] of entries) message(valveId, entry);
    },
    replay() {
      for (const [valveId, entry] of entries) message(valveId, entry);
    },
    rejoin(valveId) {
      out.push({ kind: "rejoined", deviceId: valveId });
    },
    cache: (valveId) => ({ ...entryOf(valveId).cache }),
    editGroup: (valveId) => entryOf(valveId).editGroup,
    lastSeen: (valveId) => iso(entryOf(valveId).tokenMs),
  };
}
