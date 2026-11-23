import { WEEKDAYS, activePoint, decodeDay, encodeDay, segmentAt } from "../../src/index.ts";
import { Z2M_DAY_PAYLOAD, Z2M_KEYS } from "../../src/profiles/sonoff-codec.ts";
import { BUILDER_NOW } from "../builders.ts";
import type { ResolvedDay, ResolvedWeek, Weekday } from "../../src/index.ts";

export type ValveModel = "trvzb" | "trv_zbt";
export type SelectValue = "local_temperature" | "remote_temperature" | "remote_source_offline";
export type DayTexts = Readonly<Record<Weekday, string>>;

/** What a write does to the valve, after the bridge has read the payload. */
export type ValveWrite = Readonly<{
  days: Readonly<{ group: number; texts: Readonly<Partial<Record<Weekday, string>>> }> | undefined;
  activeGroup: number | undefined;
  select: SelectValue | undefined;
  frostProtection: number | undefined;
  mode: ValveTruth["mode"] | undefined;
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
  /**
   * Zigbee2MQTT's echo of a write: it repeats the `last_seen` of the valve's message before it
   * (M14), so it does not count as the valve speaking.
   */
  echo?: boolean;
}>;

/** The valve's own state: the one the tests may look at. */
export type ValveTruth = Readonly<{
  mode: "off" | "auto" | "heat";
  setpoint: number;
  frostProtection: number;
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
  /** The time zone of the valve's clock; the builders' zone by default. */
  zone?: string;
  /** The schedule groups the valve holds; defaults to the factory week in each group. */
  schedules?: Readonly<Record<number, DayTexts>>;
  select?: SelectValue;
  activeGroup?: number;
  mode?: ValveTruth["mode"];
  setpoint?: number;
  frostProtection?: number;
  /** The last setpoint set in `heat`, which `heat` without a setpoint returns to (M12). */
  manualSetpoint?: number;
  /** How far the valve's clock runs ahead of the house's (negative: behind); 0 by default. */
  clockOffsetMs?: number;
  /**
   * Each key of a combined mode and setpoint write is reported in its own message, the second this
   * long after the first (M7); the model's measured lags by default.
   */
  keyLagMs?: number;
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
  /**
   * Lets the requests that were running late land now, only those `which` names when given; an
   * asleep valve keeps them for its wake-up.
   */
  flushLate: (nowMs: number, which?: (request: ValveRequest) => boolean) => void;
  sleep: () => void;
  /** Own reports and the fall-back after a long silence. */
  advance: (nowMs: number) => void;
  /** A person at the valve, or through a tool the bridge does not see. The valve reports. */
  person: (change: PersonChange, nowMs: number) => void;
  /**
   * A person turns the knob by `clicks` steps of 0.5 °C (M11): a TRVZB's first click leaves `auto`
   * for `heat` at its last manual setpoint, and below 4 °C it is off; a TRV-ZBT's setpoint moves and
   * its mode stays. The valve reports once the turn is confirmed. A valve that is off ignores it.
   */
  knob: (clicks: number, nowMs: number) => void;
  /** A TRV-ZBT's top button: `auto` to `heat` at the last manual setpoint, `heat` to `auto` (M11). */
  button: (nowMs: number) => void;
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
/** A TRVZB in auto takes a newly written week's value in force this long after the write (M1). */
export const TRVZB_WEEK_TAKE_MS = 20 * 1000;
/** A TRVZB written `auto` echoes its old setpoint and takes the schedule's value about 2 s later (M12). */
export const TRVZB_AUTO_TAKE_MS = 2 * 1000;
/** A TRVZB sent `heat` from another mode shows its last manual setpoint this long after (M14). */
export const TRVZB_MANUAL_SHOW_MS = 0.8 * 1000;
/** A TRVZB sent `heat` and a setpoint in one message shows the setpoint at most this late (M14). */
export const TRVZB_SETPOINT_LAG_MS = 14.6 * 1000;
/** A TRV-ZBT sent `heat` and a setpoint shows the setpoint first, the mode this much later (M14). */
export const ZBT_MODE_LAG_MS = 0.7 * 1000;
/**
 * A TRV-ZBT sent `auto` and a setpoint from `heat` shows `heat` at its schedule's value in force
 * for up to this long before `auto` and the setpoint (M14).
 */
export const ZBT_AUTO_LAG_MS = 1 * 1000;
/** A TRVZB turned below this is off (M12). */
const TRVZB_KNOB_MIN = 4;
const KNOB_STEP = 0.5;

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
    [Z2M_KEYS.frost]: truth.frostProtection,
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
    manual: options.manualSetpoint ?? options.setpoint ?? 17,
    frostProtection: options.frostProtection ?? 7,
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
  const zone = options.zone ?? BUILDER_NOW.timeZoneId;
  const offsetMs = options.clockOffsetMs ?? 0;
  /** The last instant, on the valve's clock, the valve looked at its schedule's points. */
  let pointsSeenAt = options.nowMs + offsetMs;
  /** A TRVZB's pending take of its schedule's value. */
  let takeAt: number | undefined;
  /** Parts of a write the valve shows later, in order: applied and reported at `at`. */
  let phases: { at: number; apply: () => void }[] = [];

  const speak = (speech: Speech, nowMs: number): void => {
    if (speech.echo !== true) lastSpokeAt = nowMs;
    onSpeak(speech, nowMs);
  };

  const applyDays = (group: number, texts: Readonly<Partial<Record<Weekday, string>>>): void => {
    const week = { ...(schedules[group] ?? factoryWeek(model)), ...texts };
    schedules[group] = week;
  };

  const zoned = (ms: number): Temporal.ZonedDateTime =>
    Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone);

  /** The day texts of the week the valve runs: its one group, or its active group. */
  const runningTexts = (): DayTexts | undefined =>
    schedules[model === "trvzb" ? 1 : state.activeGroup];

  /** The last decoded week, by the texts it came from (a write replaces the texts object). */
  let decoded: Readonly<{ texts: DayTexts; week: ResolvedWeek | undefined }> | undefined;

  /** The week the valve runs, decoded; undefined when a day does not decode. */
  const runningWeek = (): ResolvedWeek | undefined => {
    const texts = runningTexts();
    if (texts === undefined) return undefined;
    if (decoded?.texts === texts) return decoded.week;
    const days = {} as Record<Weekday, ResolvedDay>;
    let week: ResolvedWeek | undefined = days;
    for (const day of WEEKDAYS) {
      const points = decodeDay(texts[day]);
      if (points === null) week = undefined;
      else days[day] = points;
    }
    decoded = { texts, week };
    return week;
  };

  /** The running week's value in force at `nowMs`, on the valve's clock. */
  const inForce = (nowMs: number): number | undefined => {
    const week = runningWeek();
    return week === undefined ? undefined : activePoint(week, zoned(nowMs + offsetMs)).temperature;
  };

  /** In auto, the setpoint becomes the running week's value in force; true when it moved. */
  const takeSchedule = (nowMs: number): boolean => {
    const value = inForce(nowMs);
    if (state.mode !== "auto" || value === undefined || value === state.setpoint) return false;
    state.setpoint = value;
    return true;
  };

  /** The running week's first point after `from`. */
  const pointAfter = (from: number): number | undefined => {
    const week = runningWeek();
    return week === undefined ? undefined : segmentAt(week, zoned(from)).nextAt;
  };

  /** The next point the valve waits for, and the texts it was found in. */
  let upcoming: Readonly<{ texts: DayTexts | undefined; at: number | undefined }> | undefined;

  /** A point of the running week lies after the last look and at or before `nowMs` (valve clock). */
  const pointPassed = (nowMs: number): boolean => {
    const valveNow = nowMs + offsetMs;
    const texts = runningTexts();
    const known =
      upcoming !== undefined && upcoming.texts === texts
        ? upcoming
        : { texts, at: pointAfter(pointsSeenAt) };
    pointsSeenAt = valveNow;
    const passed = known.at !== undefined && known.at <= valveNow;
    upcoming = passed ? { texts, at: pointAfter(valveNow) } : known;
    return passed;
  };

  /** `heat` at the setpoint, which becomes the last manual one. */
  const holdHeat = (setpoint: number): void => {
    state.mode = "heat";
    state.setpoint = setpoint;
    state.manual = setpoint;
  };

  /** `off` shows the frost protection temperature as its setpoint (M12). */
  const turnOff = (): void => {
    state.mode = "off";
    state.setpoint = state.frostProtection;
  };

  /** Shows a part of the write `delayMs` from now, as a message of its own. */
  const later = (nowMs: number, delayMs: number, apply: () => void): void => {
    phases.push({ at: nowMs + delayMs, apply });
  };

  /**
   * The mode and setpoint of a write, as Task 1 measured them (M12, M14, M15). What is shown at
   * once is set here; later parts wait in `phases`.
   */
  const applyThermostat = (
    mode: ValveTruth["mode"] | undefined,
    setpoint: number | undefined,
    nowMs: number,
  ): void => {
    const from = state.mode;
    // A newer write replaces what an older one had yet to show.
    phases = [];
    if (mode === "off") {
      turnOff();
      return;
    }
    if (mode === "heat") {
      if (from === "heat") {
        holdHeat(setpoint ?? state.manual);
        return;
      }
      if (model === "trvzb") {
        // The mode first, at the old setpoint; then the last manual setpoint; then the new one.
        state.mode = "heat";
        later(nowMs, TRVZB_MANUAL_SHOW_MS, () => {
          state.setpoint = state.manual;
        });
        if (setpoint !== undefined) {
          later(nowMs, options.keyLagMs ?? TRVZB_SETPOINT_LAG_MS, () => {
            holdHeat(setpoint);
          });
        }
        return;
      }
      if (setpoint === undefined) {
        holdHeat(state.manual);
        return;
      }
      // The TRV-ZBT shows the setpoint first.
      state.setpoint = setpoint;
      later(nowMs, options.keyLagMs ?? ZBT_MODE_LAG_MS, () => {
        holdHeat(setpoint);
      });
      return;
    }
    if (mode === "auto") {
      if (model === "trvzb") {
        if (from !== "auto") {
          state.mode = "auto";
          takeAt = nowMs + TRVZB_AUTO_TAKE_MS;
        }
        // Measured (M1): a setpoint written in auto moves the TRVZB to heat.
        if (setpoint !== undefined) holdHeat(setpoint);
        return;
      }
      if (setpoint === undefined) {
        // `auto` takes the schedule's value, and drops a held one when already in auto (M15).
        state.mode = "auto";
        const value = inForce(nowMs);
        if (value !== undefined) state.setpoint = value;
        return;
      }
      if (from === "heat") {
        // A moment in `heat` at the schedule's value, then `auto` holding the setpoint (M14).
        const value = inForce(nowMs);
        if (value !== undefined) state.setpoint = value;
        later(nowMs, options.keyLagMs ?? ZBT_AUTO_LAG_MS, () => {
          state.mode = "auto";
          state.setpoint = setpoint;
        });
        return;
      }
      state.mode = "auto";
      state.setpoint = setpoint;
      return;
    }
    if (setpoint === undefined) return;
    if (state.mode === "heat") holdHeat(setpoint);
    // Measured: a setpoint written in auto moves the TRVZB to heat; the TRV-ZBT holds it in auto.
    else if (model === "trvzb" && state.mode === "auto") holdHeat(setpoint);
    else state.setpoint = setpoint;
  };

  const apply = (request: ValveRequest, nowMs: number): void => {
    if (request.kind === "read") {
      reads++;
      speak({ cause: "read", keys: request.keys, wroteDays: false }, nowMs);
      return;
    }
    writes++;
    const w = request.write;
    const before = inForce(nowMs);
    if (w.days !== undefined) applyDays(model === "trvzb" ? 1 : w.days.group, w.days.texts);
    if (w.activeGroup !== undefined) state.activeGroup = w.activeGroup;
    if (w.select !== undefined) state.select = w.select;
    if (w.frostProtection !== undefined) state.frostProtection = w.frostProtection;
    // Measured (M1): a day write that changes the point in force moves a valve in auto to the new
    // value, a TRV-ZBT at once and a TRVZB about 20 s later.
    if (w.days !== undefined && state.mode === "auto" && inForce(nowMs) !== before) {
      if (model === "trvzb") takeAt = nowMs + TRVZB_WEEK_TAKE_MS;
      else takeSchedule(nowMs);
    }
    const thermostat = w.mode !== undefined || w.setpoint !== undefined;
    // The first message after a mode or setpoint write is the valve's, still showing the old state;
    // Zigbee2MQTT's echo of the new state repeats its `last_seen` (M14).
    if (thermostat) speak({ cause: "write", keys: undefined, wroteDays: false }, nowMs);
    applyThermostat(w.mode, w.setpoint, nowMs);
    if (w.external !== undefined) {
      state.external = w.external;
      state.externalAt = nowMs;
      // Measured: one push brings a fallen-back valve back to its remote source.
      if (state.select === "remote_source_offline") state.select = "remote_temperature";
    }
    speak(
      { cause: "write", keys: undefined, wroteDays: w.days !== undefined, echo: thermostat },
      nowMs,
    );
  };

  /** Shows the parts of writes that are due, each in a message of its own. */
  const showPhases = (nowMs: number): void => {
    const due = phases.filter((phase) => phase.at <= nowMs);
    if (due.length === 0) return;
    phases = phases.filter((phase) => phase.at > nowMs);
    for (const phase of due) {
      phase.apply();
      speak({ cause: "write", keys: undefined, wroteDays: false }, phase.at);
    }
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
      frostProtection: state.frostProtection,
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
    flushLate(nowMs, which = () => true) {
      const flushed = late.filter(which);
      if (flushed.length === 0) return;
      late = late.filter((request) => !which(request));
      if (!awake) {
        queue.push(...flushed);
        return;
      }
      for (const request of flushed) apply(request, nowMs);
    },
    sleep() {
      awake = false;
    },
    advance(nowMs) {
      if (!awake) return;
      showPhases(nowMs);
      // In auto the valve follows its own week: a pending take, or each point it passes.
      const due = takeAt !== undefined && nowMs >= takeAt;
      if (due) takeAt = undefined;
      const passed = pointPassed(nowMs);
      if ((due || passed) && takeSchedule(nowMs)) {
        speak({ cause: "self", keys: undefined, wroteDays: false }, nowMs);
        return;
      }
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
    knob(clicks, nowMs) {
      if (state.mode === "off" || clicks === 0) return;
      let left = Math.abs(clicks);
      const step = Math.sign(clicks) * KNOB_STEP;
      if (model === "trvzb" && state.mode !== "heat") {
        // The first click only enters heat: it shows the old setpoint, then the last manual one.
        state.mode = "heat";
        if (awake) speak({ cause: "person", keys: undefined, wroteDays: false }, nowMs);
        state.setpoint = state.manual;
        left -= 1;
      }
      const turned = state.setpoint + left * step;
      if (model === "trvzb" && turned < TRVZB_KNOB_MIN) turnOff();
      else {
        const max = model === "trvzb" ? 35 : 30;
        const min = model === "trvzb" ? TRVZB_KNOB_MIN : 5;
        const value = Math.min(max, Math.max(min, turned));
        if (state.mode === "heat") holdHeat(value);
        else state.setpoint = value;
      }
      if (awake) speak({ cause: "person", keys: undefined, wroteDays: false }, nowMs);
    },
    button(nowMs) {
      if (model !== "trv_zbt" || state.mode === "off") return;
      if (state.mode === "heat") {
        state.mode = "auto";
        const value = inForce(nowMs);
        if (value !== undefined) state.setpoint = value;
      } else holdHeat(state.manual);
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
      phases = [];
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
    if (state.mode === "heat" && change.setpoint !== undefined) state.manual = change.setpoint;
    if (change.select !== undefined) state.select = change.select;
    if (change.activeGroup !== undefined) state.activeGroup = change.activeGroup;
    if (change.days !== undefined) applyDays(change.days.group, change.days.texts);
  }
}
