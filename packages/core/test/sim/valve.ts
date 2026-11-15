import { WEEKDAYS, decodeDay, encodeDay } from "../../src/index.ts";
import { Z2M_DAY_PAYLOAD, Z2M_KEYS } from "../../src/profiles/sonoff-codec.ts";
import type { Weekday } from "../../src/index.ts";

export type ValveModel = "trvzb" | "trv_zbt";
export type SelectValue = "local_temperature" | "remote_temperature" | "remote_source_offline";
export type DayTexts = Readonly<Record<Weekday, string>>;

/** What a write does to the valve, after the bridge has read the payload. */
export type ValveWrite = Readonly<{
  days: Readonly<{ group: number; texts: Readonly<Partial<Record<Weekday, string>>> }> | undefined;
  activeGroup: number | undefined;
  select: SelectValue | undefined;
  setpoint: number | undefined;
  external: number | undefined;
}>;

export type ValveRequest =
  | Readonly<{ kind: "write"; write: ValveWrite }>
  | Readonly<{ kind: "read"; keys: readonly string[] }>;

/** What happens to a request: it lands, is lost, waits for the wake-up, or lands after a later one. */
export type Fate = "land" | "lose" | "queue" | "late";

export type Speech = Readonly<{
  cause: "write" | "read" | "wake" | "self" | "rejoin" | "person";
  /** The payload keys a read asked for; `undefined` means the valve reports everything it owns. */
  keys: readonly string[] | undefined;
  wroteDays: boolean;
}>;

/** The valve's own state: the one the tests may look at. */
export type ValveTruth = Readonly<{
  mode: "off" | "auto" | "heat";
  setpoint: number;
  select: SelectValue;
  activeGroup: number;
  schedules: Readonly<Record<number, DayTexts>>;
  external: number | undefined;
  localTemperature: number;
  battery: number;
}>;

export type PersonChange = Readonly<{
  mode?: ValveTruth["mode"];
  setpoint?: number;
  select?: SelectValue;
  activeGroup?: number;
  days?: Readonly<{ group: number; texts: Readonly<Partial<Record<Weekday, string>>> }>;
}>;

export type SimValveOptions = Readonly<{
  model: ValveModel;
  nowMs: number;
  /** The schedule groups the valve holds; defaults to the factory week in each group. */
  schedules?: Readonly<Record<number, DayTexts>>;
  select?: SelectValue;
  activeGroup?: number;
  mode?: ValveTruth["mode"];
  setpoint?: number;
  selfReports?: boolean;
  selfReportMs?: number;
  onSpeak: (speech: Speech, nowMs: number) => void;
}>;

export type SimValve = Readonly<{
  model: ValveModel;
  truth: () => ValveTruth;
  isAwake: () => boolean;
  /** How many requests wait for the wake-up. */
  queued: () => number;
  /** How many requests were handed to the valve, by kind. */
  received: () => Readonly<{ writes: number; reads: number }>;
  receive: (request: ValveRequest, nowMs: number) => void;
  wake: (nowMs: number) => void;
  sleep: () => void;
  /** Own reports and the fall-back after a long silence. */
  advance: (nowMs: number) => void;
  /** A person at the valve, or through a tool the bridge does not see. The valve reports. */
  person: (change: PersonChange, nowMs: number) => void;
  /** Resets what a new battery resets, drops the queue, and reports. */
  batterySwap: (nowMs: number) => void;
  setSelfReports: (on: boolean, intervalMs?: number) => void;
  /** Decides the fate of each request handed to the valve; `undefined` means "land". */
  setPolicy: (
    policy: ((request: ValveRequest, nth: number) => Fate | undefined) | undefined,
  ) => void;
  /** Sets the truth without any report, for building a scenario's starting point. */
  setup: (change: PersonChange) => void;
}>;

/** The longest gap between two reports of a healthy valve that is not being written to. */
export const DEFAULT_SELF_REPORT_MS = 10 * 60 * 1000;
/** A valve whose feed stopped this long ago falls back to its own sensor. */
const FEED_FALLBACK_MS = 2 * 60 * 60 * 1000;

const FACTORY_DAY_TRVZB = "00:00/16 07:00/19 10:00/16 10:00/16 17:00/19 23:00/16";

function factoryText(model: ValveModel): string {
  const day = decodeDay(FACTORY_DAY_TRVZB);
  if (day === null) throw new Error("factory day does not decode");
  return encodeDay(day, model === "trvzb" ? 6 : 12);
}

/** The week a new or reset valve holds. */
export function factoryWeek(model: ValveModel): DayTexts {
  const text = factoryText(model);
  return { mon: text, tue: text, wed: text, thu: text, fri: text, sat: text, sun: text };
}

export function groupsOf(model: ValveModel): readonly number[] {
  return model === "trvzb" ? [1] : [1, 2, 3];
}

/** The payload keys of one group's days. */
export function dayPayload(texts: DayTexts): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const day of WEEKDAYS) out[Z2M_DAY_PAYLOAD[day]] = texts[day];
  return out;
}

/** The keys a valve reports by itself, in the form Zigbee2MQTT publishes them. */
export function reported(model: ValveModel, truth: ValveTruth): Record<string, unknown> {
  const out: Record<string, unknown> = {
    [Z2M_KEYS.mode]: truth.mode,
    [Z2M_KEYS.setpoint]: truth.setpoint,
    [Z2M_KEYS.select]: truth.select,
    local_temperature: truth.localTemperature,
    running_state: "idle",
    battery: truth.battery,
  };
  if (model === "trv_zbt") out[Z2M_KEYS.activeGroup] = String(truth.activeGroup);
  return out;
}

export function createSimValve(options: SimValveOptions): SimValve {
  const { model, onSpeak } = options;
  const schedules: Record<number, DayTexts> = {};
  for (const group of groupsOf(model)) {
    schedules[group] = options.schedules?.[group] ?? factoryWeek(model);
  }
  const state = {
    mode: options.mode ?? "auto",
    setpoint: options.setpoint ?? 17,
    select: options.select ?? "local_temperature",
    activeGroup: options.activeGroup ?? 1,
    external: undefined as number | undefined,
    externalAt: undefined as number | undefined,
    localTemperature: 19.5,
    battery: 90,
  };
  let awake = true;
  let selfReports = options.selfReports ?? true;
  let selfReportMs = options.selfReportMs ?? DEFAULT_SELF_REPORT_MS;
  let lastSpokeAt = options.nowMs;
  let policy: ((request: ValveRequest, nth: number) => Fate | undefined) | undefined;
  let handed = 0;
  let writes = 0;
  let reads = 0;
  let queue: ValveRequest[] = [];
  let late: ValveRequest[] = [];

  const speak = (speech: Speech, nowMs: number): void => {
    lastSpokeAt = nowMs;
    onSpeak(speech, nowMs);
  };

  const applyDays = (group: number, texts: Readonly<Partial<Record<Weekday, string>>>): void => {
    const week = { ...(schedules[group] ?? factoryWeek(model)), ...texts };
    schedules[group] = week;
  };

  const apply = (request: ValveRequest, nowMs: number): void => {
    if (request.kind === "read") {
      reads++;
      speak({ cause: "read", keys: request.keys, wroteDays: false }, nowMs);
      return;
    }
    writes++;
    const w = request.write;
    if (w.days !== undefined) applyDays(model === "trvzb" ? 1 : w.days.group, w.days.texts);
    if (w.activeGroup !== undefined) state.activeGroup = w.activeGroup;
    if (w.select !== undefined) state.select = w.select;
    if (w.setpoint !== undefined) {
      state.setpoint = w.setpoint;
      // Measured: a setpoint written in auto moves the TRVZB to heat; the TRV-ZBT stays in auto.
      if (model === "trvzb" && state.mode === "auto") state.mode = "heat";
    }
    if (w.external !== undefined) {
      state.external = w.external;
      state.externalAt = nowMs;
      // Measured: one push brings a fallen-back valve back to its remote source.
      if (state.select === "remote_source_offline") state.select = "remote_temperature";
    }
    speak({ cause: "write", keys: undefined, wroteDays: w.days !== undefined }, nowMs);
  };

  const landLate = (nowMs: number): void => {
    const waiting = late;
    late = [];
    for (const request of waiting) apply(request, nowMs);
  };

  return {
    model,
    truth: () => ({
      mode: state.mode,
      setpoint: state.setpoint,
      select: state.select,
      activeGroup: state.activeGroup,
      schedules: { ...schedules },
      external: state.external,
      localTemperature: state.localTemperature,
      battery: state.battery,
    }),
    isAwake: () => awake,
    queued: () => queue.length + late.length,
    received: () => ({ writes, reads }),
    receive(request, nowMs) {
      const nth = handed++;
      let fate: Fate = policy?.(request, nth) ?? "land";
      if (fate === "land" && !awake) fate = "queue";
      if (fate === "lose") return;
      if (fate === "queue") {
        queue.push(request);
        return;
      }
      if (fate === "late" && !awake) {
        queue.push(request);
        return;
      }
      if (fate === "late") {
        late.push(request);
        return;
      }
      apply(request, nowMs);
      landLate(nowMs);
    },
    wake(nowMs) {
      awake = true;
      const waiting = queue;
      queue = [];
      if (waiting.length === 0) {
        speak({ cause: "wake", keys: undefined, wroteDays: false }, nowMs);
        return;
      }
      for (const request of waiting) apply(request, nowMs);
      landLate(nowMs);
    },
    sleep() {
      awake = false;
    },
    advance(nowMs) {
      if (!awake) return;
      if (
        state.select === "remote_temperature" &&
        state.externalAt !== undefined &&
        nowMs - state.externalAt >= FEED_FALLBACK_MS
      ) {
        state.select = "remote_source_offline";
        speak({ cause: "self", keys: undefined, wroteDays: false }, nowMs);
        return;
      }
      if (selfReports && nowMs - lastSpokeAt >= selfReportMs) {
        speak({ cause: "self", keys: undefined, wroteDays: false }, nowMs);
      }
    },
    person(change, nowMs) {
      setup(change);
      if (awake) speak({ cause: "person", keys: undefined, wroteDays: false }, nowMs);
    },
    batterySwap(nowMs) {
      for (const group of groupsOf(model)) schedules[group] = factoryWeek(model);
      state.select = "local_temperature";
      state.activeGroup = 1;
      state.external = undefined;
      state.externalAt = undefined;
      queue = [];
      late = [];
      awake = true;
      speak({ cause: "rejoin", keys: undefined, wroteDays: false }, nowMs);
    },
    setSelfReports(on, intervalMs) {
      selfReports = on;
      if (intervalMs !== undefined) selfReportMs = intervalMs;
    },
    setPolicy(next) {
      policy = next;
    },
    setup,
  };

  function setup(change: PersonChange): void {
    if (change.mode !== undefined) state.mode = change.mode;
    if (change.setpoint !== undefined) state.setpoint = change.setpoint;
    if (change.select !== undefined) state.select = change.select;
    if (change.activeGroup !== undefined) state.activeGroup = change.activeGroup;
    if (change.days !== undefined) applyDays(change.days.group, change.days.texts);
  }
}
