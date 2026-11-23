import fc from "fast-check";
import { configToRaw, findProfile, reconcile } from "../../src/index.ts";
import { Z2M_DAY_PAYLOAD, Z2M_KEYS } from "../../src/profiles/sonoff-codec.ts";
import { makeConfig, membershipOf, weekOf } from "../builders.ts";
import { HOUR_MS, MINUTE_MS, STEP_MS, createSimDriver, simRoom, valveIdOf } from "./driver.ts";
import { reported } from "./valve.ts";
import type { SimDriver, SimSetup, LoggedEffect } from "./driver.ts";
import type {
  AreaMembership,
  Config,
  Ledger,
  PresetName,
  Room,
  Schedule,
  SetPoint,
  SettingKey,
  SettingValue,
  TickResult,
  World,
} from "../../src/index.ts";
import type { Fate, PersonChange, SelectValue, ValveRequest, ValveTruth } from "./valve.ts";

// The world the plans run in ----------------------------------------------------------------------

/** One TRVZB (slot 0) and one TRV-ZBT (slot 1). */
export type Slot = 0 | 1;
export const SLOTS: readonly Slot[] = [0, 1];
export const VALVE_IDS: readonly [string, string] = [valveIdOf(1), valveIdOf(2)];
export const MODELS = ["trvzb", "trv_zbt"] as const;

/** The rooms a valve can be placed in: `a` and `b` have a sensor each, `c` has none. */
export type RoomName = "a" | "b" | "c";
export const ROOM_NAMES: readonly RoomName[] = ["a", "b", "c"];
export type ScheduleName = "default" | "alt";

/** The longest a late write waits: inside the release hold, as Task 2 checks. */
export const LATE_LIMIT_MS = 10 * MINUTE_MS;
/**
 * The longest a mode or setpoint write waits while the valve is awake, so it lands within the
 * next step and under `SENT_RETIRE_MS` (real echoes take at most 15.8 s, M2, M14). A later one is
 * a known limit of the plan, not a fault the properties cover.
 */
export const THERMOSTAT_LATE_LIMIT_MS = 25 * 1000;
/** The farthest a valve's clock runs from the house's in the plans (M8 saw 40 s). */
export const CLOCK_OFFSET_LIMIT_MS = 90 * 1000;

export function sensorOf(room: RoomName): string {
  return `ha:sensor.${room}`;
}

function point(time: string, preset: PresetName | number): SetPoint {
  return {
    time: Temporal.PlainTime.from(time),
    preset: typeof preset === "string" ? preset : undefined,
    temperature: typeof preset === "number" ? preset : undefined,
  };
}

/** Three weeks of the same day each; the second and third use fewer and more set points. */
const VARIANTS: readonly (readonly SetPoint[])[] = [
  [point("00:00", "eco"), point("06:30", "comfort"), point("22:00", "eco")],
  [
    point("00:00", "eco"),
    point("05:00", "comfort"),
    point("09:00", 18),
    point("17:00", "comfort"),
    point("23:00", "eco"),
  ],
  [point("00:00", 16), point("07:00", 21)],
];

export type Variant = 0 | 1 | 2;
export type Placement = readonly [RoomName | null, RoomName | null];

function scheduleOf(id: ScheduleName, variant: Variant): Schedule {
  return { id, name: id, defaultWeek: weekOf(VARIANTS[variant] ?? []) };
}

// Fault plans ----------------------------------------------------------------------------------------

export type PersonKind =
  | Readonly<{ what: "mode"; mode: "off" | "auto" | "heat" }>
  | Readonly<{ what: "setpoint"; celsius: number }>
  | Readonly<{ what: "select"; select: "local_temperature" | "remote_temperature" }>
  | Readonly<{ what: "group"; group: 1 | 2 | 3 }>
  | Readonly<{ what: "days" }>;

export type Fault =
  | Readonly<{ k: "wait"; seconds: number }>
  | Readonly<{
      k: "fate";
      valve: Slot;
      on: "write" | "read" | "any";
      fate: "lose" | "queue" | "late";
      delaySeconds: number;
      count: number;
    }>
  | Readonly<{ k: "sleep"; valve: Slot }>
  | Readonly<{ k: "wake"; valve: Slot }>
  | Readonly<{ k: "bridgeRestart" }>
  | Readonly<{ k: "replay" }>
  | Readonly<{ k: "restart" }>
  | Readonly<{ k: "crash"; after: number }>
  | Readonly<{ k: "link"; name: "z2m" | "ha"; up: boolean }>
  | Readonly<{ k: "person"; valve: Slot; change: PersonKind }>
  | Readonly<{ k: "knob"; valve: Slot; clicks: number }>
  | Readonly<{ k: "button"; valve: Slot }>
  | Readonly<{
      k: "compete";
      valve: Slot;
      what: "select" | "group" | "days";
      seconds: number;
    }>
  | Readonly<{ k: "place"; valve: Slot; room: RoomName | null }>
  | Readonly<{ k: "edit"; schedule: ScheduleName; variant: Variant }>
  | Readonly<{ k: "hold"; on: boolean }>
  | Readonly<{
      k: "loseStore";
      config: "keep" | "lost" | "corrupt";
      ledger: "keep" | "lost" | "corrupt";
    }>
  | Readonly<{ k: "importCopy" }>
  | Readonly<{ k: "swap"; valve: Slot }>
  | Readonly<{ k: "rejoin"; valve: Slot }>
  | Readonly<{ k: "sensor"; room: "a" | "b"; delta: number }>;

/** What the two valves hold when Heatmaster first meets them. */
export type Initial = Readonly<{
  trvzbSelect: SelectValue;
  zbtSelect: SelectValue;
  zbtGroup: 1 | 2 | 3;
  /** The configured temperature write interval, in minutes (1 to 60). */
  intervalMin: number;
  /** How far each valve's clock runs from the house's, in ms (TRVZB, TRV-ZBT). */
  offsets: readonly [number, number];
}>;

/** A knob turned after quiesce, for P-one. */
export type Turn = Readonly<{ valve: Slot; clicks: number }>;

/** `turn`: a knob turned once the plan is over and quiesced (P-one); none in hand-made plans. */
export type FaultPlan = Readonly<{ initial: Initial; steps: readonly Fault[]; turn?: Turn }>;

/**
 * Which faults a plan draws from: `all`; `own`, without anything a person does at a valve, a
 * competing writer or a battery swap (P-own); `keep`, an `own` prefix, one knob turn or button
 * press, then faults that neither touch a valve by hand nor change rooms or stores (P-keep).
 */
export type Subset = "all" | "own" | "keep";

/** Faults that a person makes at a valve. */
export const BY_HAND: ReadonlySet<Fault["k"]> = new Set(["knob", "button", "person"]);
/** Kinds of fault P-own leaves out. */
export const NOT_OWN: ReadonlySet<Fault["k"]> = new Set([...BY_HAND, "compete", "swap"]);

/**
 * A write to the TRV-ZBT that is lost, late, or queued (a request queued while the valve is awake
 * waits for a wake-up that may never come). Its days are write-only, so a day write that does not
 * land while the valve still reports counts as confirmed (R23), and the valve's own points of its
 * old week are then judged against the new one. P-own leaves these out: a known limit, in
 * `docs/backlog.md`.
 */
export function zbtWriteMissed(fault: Fault): boolean {
  return fault.k === "fate" && fault.valve === 1 && fault.on !== "read";
}

/** A fault P-own covers. */
export function ownFault(fault: Fault): boolean {
  return !NOT_OWN.has(fault.k) && !zbtWriteMissed(fault);
}

/**
 * Kinds of fault P-keep leaves out after the turn: those P-own leaves out (a competing writer or a
 * battery swap moves a TRV-ZBT to another group, whose points it then takes), and those that
 * change rooms or stores.
 */
export const NOT_KEPT: ReadonlySet<Fault["k"]> = new Set([
  ...NOT_OWN,
  "place",
  "loseStore",
  "importCopy",
]);

const slot: fc.Arbitrary<Slot> = fc.constantFrom<Slot>(0, 1);
const room: fc.Arbitrary<RoomName | null> = fc.constantFrom<RoomName | null>("a", "b", "c", null);

const initial: fc.Arbitrary<Initial> = fc.record({
  trvzbSelect: fc.constantFrom<SelectValue>("local_temperature", "remote_temperature"),
  zbtSelect: fc.constantFrom<SelectValue>("local_temperature", "remote_temperature"),
  zbtGroup: fc.constantFrom<1 | 2 | 3>(1, 2, 3),
  intervalMin: fc.constantFrom(1, 5, 5, 10, 30, 60),
  offsets: fc
    .tuple(
      fc.integer({ min: -CLOCK_OFFSET_LIMIT_MS / 1000, max: CLOCK_OFFSET_LIMIT_MS / 1000 }),
      fc.integer({ min: -CLOCK_OFFSET_LIMIT_MS / 1000, max: CLOCK_OFFSET_LIMIT_MS / 1000 }),
    )
    .map(([a, b]): readonly [number, number] => [a * 1000, b * 1000]),
});

/** Clicks of a knob turn: mostly a few up or down, now and then far enough to turn a TRVZB off. */
const clicks: fc.Arbitrary<number> = fc.oneof(
  { weight: 8, arbitrary: fc.integer({ min: 1, max: 12 }) },
  { weight: 4, arbitrary: fc.integer({ min: -12, max: -1 }) },
  { weight: 1, arbitrary: fc.constant(-30) },
);

const turnFault: fc.Arbitrary<Fault> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({ valve: slot, clicks }).map((r): Fault => ({ k: "knob", ...r })),
  },
  { weight: 1, arbitrary: fc.constant<Fault>({ k: "button", valve: 1 }) },
);

const person: fc.Arbitrary<PersonKind> = fc.oneof(
  fc
    .constantFrom<"off" | "auto" | "heat">("auto", "heat", "off")
    .map((mode): PersonKind => ({ what: "mode", mode })),
  fc.integer({ min: 10, max: 50 }).map((n): PersonKind => ({ what: "setpoint", celsius: n / 2 })),
  fc
    .constantFrom<"local_temperature" | "remote_temperature">(
      "local_temperature",
      "remote_temperature",
    )
    .map((select): PersonKind => ({ what: "select", select })),
  fc.constantFrom<1 | 2 | 3>(1, 2, 3).map((group): PersonKind => ({ what: "group", group })),
  fc.constant<PersonKind>({ what: "days" }),
);

const seconds = fc.constantFrom(30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 14400);

function faultArbitrary(crashy: boolean): fc.Arbitrary<Fault> {
  const weight = (normal: number, heavy: number): number => (crashy ? heavy : normal);
  return fc.oneof(
    {
      weight: 3,
      arbitrary: fc.record({ valve: slot, clicks }).map((r): Fault => ({ k: "knob", ...r })),
    },
    { weight: 1, arbitrary: fc.constant<Fault>({ k: "button", valve: 1 }) },
    { weight: 12, arbitrary: seconds.map((s): Fault => ({ k: "wait", seconds: s })) },
    {
      weight: 6,
      arbitrary: fc
        .record({
          valve: slot,
          on: fc.constantFrom<"write" | "read" | "any">("any", "write", "read"),
          fate: fc.constantFrom<"lose" | "queue" | "late">("lose", "queue", "late"),
          delaySeconds: fc.integer({ min: 0, max: LATE_LIMIT_MS / 1000 }),
          count: fc.integer({ min: 1, max: 8 }),
        })
        .map((r): Fault => ({ k: "fate", ...r })),
    },
    { weight: 3, arbitrary: slot.map((valve): Fault => ({ k: "sleep", valve })) },
    { weight: 3, arbitrary: slot.map((valve): Fault => ({ k: "wake", valve })) },
    { weight: 2, arbitrary: fc.constant<Fault>({ k: "bridgeRestart" }) },
    { weight: 2, arbitrary: fc.constant<Fault>({ k: "replay" }) },
    { weight: weight(2, 8), arbitrary: fc.constant<Fault>({ k: "restart" }) },
    {
      weight: weight(2, 8),
      arbitrary: fc.integer({ min: 1, max: 6 }).map((after): Fault => ({ k: "crash", after })),
    },
    {
      weight: 3,
      arbitrary: fc
        .record({ name: fc.constantFrom<"z2m" | "ha">("z2m", "ha"), up: fc.boolean() })
        .map((r): Fault => ({ k: "link", ...r })),
    },
    {
      weight: 5,
      arbitrary: fc
        .record({ valve: slot, change: person })
        .map((r): Fault => ({ k: "person", ...r })),
    },
    {
      weight: 3,
      arbitrary: fc
        .record({
          valve: slot,
          what: fc.constantFrom<"select" | "group" | "days">("select", "group", "days"),
          seconds: fc.constantFrom(600, 1800, 7200),
        })
        .map((r): Fault => ({ k: "compete", ...r })),
    },
    {
      weight: 12,
      arbitrary: fc.record({ valve: slot, room }).map((r): Fault => ({ k: "place", ...r })),
    },
    {
      weight: 3,
      arbitrary: fc
        .record({
          schedule: fc.constantFrom<ScheduleName>("default", "alt"),
          variant: fc.constantFrom<Variant>(0, 1, 2),
        })
        .map((r): Fault => ({ k: "edit", ...r })),
    },
    { weight: 1, arbitrary: fc.boolean().map((on): Fault => ({ k: "hold", on })) },
    {
      weight: 1,
      arbitrary: fc
        .record({
          config: fc.constantFrom<"keep" | "lost" | "corrupt">("keep", "keep", "lost", "corrupt"),
          ledger: fc.constantFrom<"keep" | "lost" | "corrupt">("keep", "keep", "lost", "corrupt"),
        })
        .map((r): Fault => ({ k: "loseStore", ...r })),
    },
    { weight: 3, arbitrary: fc.constant<Fault>({ k: "importCopy" }) },
    { weight: 1, arbitrary: slot.map((valve): Fault => ({ k: "swap", valve })) },
    { weight: 2, arbitrary: slot.map((valve): Fault => ({ k: "rejoin", valve })) },
    {
      weight: 6,
      arbitrary: fc
        .record({
          room: fc.constantFrom<"a" | "b">("a", "b"),
          delta: fc.constantFrom(-2, -0.5, -0.1, 0.1, 0.3, 1, 2),
        })
        .map((r): Fault => ({ k: "sensor", ...r })),
    },
  );
}

/**
 * A fast-check arbitrary of fault plans over `subset` (`all` by default), each with a knob turn
 * for after quiesce. `crashy` makes crashes and restarts frequent, for the crash-safety
 * properties.
 */
export function faultPlan(
  options: Readonly<{ crashy?: boolean; subset?: Subset }> = {},
): fc.Arbitrary<FaultPlan> {
  const crashy = options.crashy === true;
  const turn = fc.record({ valve: slot, clicks });
  const steps = (covered: (fault: Fault) => boolean, min: number, max: number) =>
    fc.array(faultArbitrary(crashy).filter(covered), {
      minLength: min,
      maxLength: max,
      size: "large",
    });
  switch (options.subset ?? "all") {
    case "all":
      return fc.record({ initial, steps: steps(() => true, 4, 40), turn });
    case "own":
      return fc.record({ initial, steps: steps(ownFault, 4, 40), turn });
    case "keep":
      return fc
        .record({
          initial,
          before: steps(ownFault, 2, 20),
          at: turnFault,
          after: steps((fault) => ownFault(fault) && !NOT_KEPT.has(fault.k), 2, 20),
          turn,
        })
        .map((r): FaultPlan => ({
          initial: r.initial,
          steps: [...r.before, r.at, ...r.after],
          turn: r.turn,
        }));
  }
}

// The rig ----------------------------------------------------------------------------------------

type FateEntry = Readonly<{
  on: "write" | "read" | "any";
  fate: "lose" | "queue" | "late";
  delayMs: number;
}>;

type Competitor = Readonly<{ what: "select" | "group" | "days"; until: number }>;

interface FaultState {
  fates: [FateEntry[], FateEntry[]];
  lateAt: [number | undefined, number | undefined];
  competitors: [Competitor | undefined, Competitor | undefined];
  linkDown: boolean;
  haDown: boolean;
  /** The rig's step, so that the observers also see the quiescence. */
  step: ((dtMs: number) => void) | undefined;
  /** The user asks again for a change that a crash cut. */
  retry: (() => void) | undefined;
}

const faultStates = new WeakMap<SimDriver, FaultState>();

/** What a person wrote, or a competing writer set back, to a valve's days. */
const COMPETING_DAY = "00:00/30";

/** One join that Heatmaster accepted: what the cache and the valve held at that moment. */
export type Join = Readonly<{
  valveId: string;
  adoptedAt: number;
  cache: Readonly<Partial<Record<SettingKey, SettingValue | null>>>;
  truth: Readonly<Partial<Record<SettingKey, SettingValue | null>>>;
  originals: Readonly<Partial<Record<SettingKey, SettingValue | null>>>;
}>;

export type StepInfo = Readonly<{
  result: TickResult;
  world: World;
  effects: readonly LoggedEffect[];
  /** The ledger before this step's effects were executed. */
  ledgerBefore: Ledger | undefined;
}>;

/** A knob turn or button press at a valve: when, and what the valve showed right after it. */
export type TurnMade = Readonly<{ at: number; valve: Slot; truth: ValveTruth }>;

export type Rig = Readonly<{
  sim: SimDriver;
  /** Every knob turn and button press the plan made, oldest first. */
  turns: readonly TurnMade[];
  /** What the user last asked for: the config the rig submits. */
  model: () => Config;
  joins: readonly Join[];
  /** Runs `fn` after every step. */
  onStep: (fn: (info: StepInfo) => void) => void;
  /** One step: the faults due at its start, then the simulator's step, then the observers. */
  step: (dtMs: number) => void;
  /** Steps until `ms` of simulated time have passed. */
  advance: (ms: number, stepMs?: number) => void;
  apply: (fault: Fault) => void;
  /** The plan: a prelude that joins both valves, then the steps. */
  run: (plan: FaultPlan) => void;
}>;

function factorySetup(plan: Initial): SimSetup["valves"] {
  return [
    {
      valveId: VALVE_IDS[0],
      model: "trvzb",
      selfReports: true,
      select: plan.trvzbSelect,
      activeGroup: 1,
      clockOffsetMs: plan.offsets[0],
    },
    {
      valveId: VALVE_IDS[1],
      model: "trv_zbt",
      selfReports: true,
      select: plan.zbtSelect,
      activeGroup: plan.zbtGroup,
      clockOffsetMs: plan.offsets[1],
    },
  ];
}

/** The rooms `a`, `b` and `c` with the valves the placement puts in them (rooms of no valve too). */
function modelRooms(placement: Placement): readonly Room[] {
  return ROOM_NAMES.map((name) =>
    simRoom(
      name,
      VALVE_IDS.filter((_, i) => placement[i] === name),
      name === "c" ? [] : [sensorOf(name)],
    ),
  ).map((r) => ({ ...r, scheduleId: r.id === "b" ? "alt" : "default" }));
}

/** The document the user asks for: an entry for each of `a`, `b` and `c`, `b` on `alt`. */
export function modelConfig(
  schedules: Readonly<Record<ScheduleName, Variant>>,
  hold: boolean,
  intervalMs?: number,
): Config {
  const config = makeConfig({
    rooms: modelRooms([null, null]),
    holdWrites: hold,
    schedules: [scheduleOf("default", schedules.default), scheduleOf("alt", schedules.alt)],
  });
  return intervalMs === undefined
    ? config
    : { ...config, settings: { ...config.settings, externalWriteIntervalMs: intervalMs } };
}

/** What Home Assistant says for a placement: an area with no valve is no room. */
export function modelMembership(placement: Placement): AreaMembership {
  return membershipOf(modelRooms(placement).filter((r) => r.valves.length > 0));
}

/** The values a binding reads from a payload: the cache's, or what the valve would report. */
function decoded(
  sim: SimDriver,
  slotOf: Slot,
  source: "cache" | "truth",
): Readonly<Partial<Record<SettingKey, SettingValue | null>>> {
  const id = VALVE_IDS[slotOf];
  const valve = sim.valve(id);
  const payload = source === "cache" ? sim.bridge.cache(id) : reported(valve.model, valve.truth());
  return bindingDecode(slotOf, payload);
}

function bindingDecode(
  slotOf: Slot,
  payload: Readonly<Record<string, unknown>>,
): Readonly<Partial<Record<SettingKey, SettingValue | null>>> {
  const found = findProfile(slotOf === 0 ? "TRVZB" : "TRV-ZBT", "z2m");
  if (found === undefined) throw new Error("no profile");
  return found.binding.decode(payload).values;
}

/**
 * The rig for a plan's initial state: both valves in the factory state, Heatmaster just started.
 * Home Assistant has the TRVZB in `a` and the TRV-ZBT in `b`; the config has no schedule yet, so
 * no room is managed until the first document with schedules joins both valves. Later joins are
 * the tick's, as Home Assistant moves the devices.
 */
export function createRig(start: Initial): Rig {
  let placement: [RoomName | null, RoomName | null] = ["a", "b"];
  let schedules: Record<ScheduleName, Variant> = { default: 0, alt: 1 };
  let hold = false;
  const levels: Record<string, number> = { a: 20, b: 20 };
  const intervalMs = start.intervalMin * MINUTE_MS;
  const config = modelConfig(schedules, hold, intervalMs);
  const sim = createSimDriver({
    config: { ...config, schedules: [], defaultScheduleId: undefined, rooms: new Map() },
    membership: modelMembership(placement),
    ledger: { records: new Map(), released: [] },
    valves: factorySetup(start),
    sensors: ROOM_NAMES.filter((n) => n !== "c").map((n) => ({ ref: sensorOf(n), value: 20 })),
  });
  const state: FaultState = {
    fates: [[], []],
    lateAt: [undefined, undefined],
    competitors: [undefined, undefined],
    linkDown: false,
    haDown: false,
    step: undefined,
    retry: undefined,
  };
  faultStates.set(sim, state);
  const joins: Join[] = [];
  const turns: TurnMade[] = [];
  let cut = false;
  const observers: ((info: StepInfo) => void)[] = [];

  // A tick joins what its reconcile joins, with what the cache and the valve hold at that moment.
  sim.beforeTick((world) => {
    for (const taken of reconcile(world).joined) {
      const s: Slot = taken.valveId === VALVE_IDS[0] ? 0 : 1;
      joins.push({
        valveId: taken.valveId,
        adoptedAt: world.now.epochMilliseconds,
        cache: decoded(sim, s, "cache"),
        truth: decoded(sim, s, "truth"),
        originals: taken.originals,
      });
    }
  });

  for (const s of SLOTS) {
    const valve = sim.valve(VALVE_IDS[s]);
    valve.setPolicy((request: ValveRequest): Fate | undefined => {
      const list = state.fates[s];
      const i = list.findIndex((f) => f.on === "any" || f.on === request.kind);
      const entry = list[i];
      if (entry === undefined) return undefined;
      list.splice(i, 1);
      const thermostat =
        request.kind === "write" &&
        (request.write.mode !== undefined || request.write.setpoint !== undefined);
      // A mode or setpoint write that is late or queued while the valve is awake lands within
      // the next step (THERMOSTAT_LATE_LIMIT_MS); one queued while it sleeps lands at its wake-up,
      // before it speaks.
      if (thermostat && entry.fate !== "lose" && valve.isAwake()) {
        const due = sim.now() + Math.min(entry.delayMs, THERMOSTAT_LATE_LIMIT_MS);
        state.lateAt[s] = Math.min(state.lateAt[s] ?? due, due);
        return "late";
      }
      if (entry.fate === "late" && state.lateAt[s] === undefined) {
        state.lateAt[s] = sim.now() + Math.min(entry.delayMs, LATE_LIMIT_MS);
      }
      return entry.fate;
    });
  }

  /**
   * Asks for the model; true when Heatmaster accepted the change (a crash may still have cut it).
   * The change joins nothing: the next tick does, and `beforeTick` records it.
   */
  const submit = (): boolean => {
    sim.deliver();
    const asked = modelConfig(schedules, hold, intervalMs);
    const result = sim.planChange(configToRaw(asked));
    if (!result.ok) return false;
    // A crash that cut the change leaves the saved revision behind the planned one.
    cut = sim.config().stored?.revision !== result.plan.stored.revision;
    return true;
  };

  /** The change the user asks for, kept only when Heatmaster accepts it. */
  const change = (edit: () => void, undo: () => void): boolean => {
    edit();
    sim.deliver();
    // A refusal is undone; a change that a crash cut stays asked, and is asked again.
    if (submit()) return true;
    undo();
    return false;
  };

  const place = (next: Placement): void => {
    placement = [next[0], next[1]];
    sim.setMembership(modelMembership(next));
  };

  const competitorWrite = (s: Slot, what: "select" | "group" | "days"): void => {
    const id = VALVE_IDS[s];
    const truth = sim.valve(id).truth();
    if (what === "select") {
      if (truth.select !== "local_temperature") {
        sim.personWrites(id, { [Z2M_KEYS.select]: "local_temperature" });
      }
      return;
    }
    if (what === "group") {
      if (s === 1 && truth.activeGroup !== 1) sim.personWrites(id, { [Z2M_KEYS.activeGroup]: "1" });
      return;
    }
    const days = truth.schedules[s === 0 ? 1 : 3];
    if (days !== undefined && days.mon !== COMPETING_DAY) {
      sim.personWrites(id, {
        ...(s === 1 ? { [Z2M_KEYS.editGroup]: "3" } : {}),
        [Z2M_DAY_PAYLOAD.mon]: COMPETING_DAY,
      });
    }
  };

  /** What happens at the start of a step, after the clock moved. */
  const atStart = (): void => {
    const now = sim.now();
    for (const s of SLOTS) {
      const due = state.lateAt[s];
      if (due !== undefined && now >= due) {
        state.lateAt[s] = undefined;
        sim.valve(VALVE_IDS[s]).flushLate(now);
      }
      const competitor = state.competitors[s];
      if (competitor !== undefined) {
        if (now >= competitor.until) state.competitors[s] = undefined;
        else competitorWrite(s, competitor.what);
      }
    }
  };

  const step = (dtMs: number): void => {
    const ledgerBefore = sim.ledger();
    const logged = sim.log().length;
    sim.atNextStep(atStart);
    const result = sim.step(dtMs);
    const world = sim.tickWorld();
    if (world === undefined) throw new Error("no tick ran");
    const info: StepInfo = {
      result,
      world,
      effects: sim.log().slice(logged),
      ledgerBefore,
    };
    for (const observer of observers) observer(info);
  };

  state.step = step;
  state.retry = () => {
    if (!cut) return;
    cut = false;
    submit();
  };

  const advance = (ms: number, stepMs = STEP_MS): void => {
    const end = sim.elapsed() + ms;
    while (sim.elapsed() < end) step(Math.min(stepMs, end - sim.elapsed()));
  };

  const personChange = (s: Slot, what: PersonKind): PersonChange => {
    switch (what.what) {
      case "mode":
        return { mode: what.mode };
      case "setpoint":
        return { setpoint: what.celsius };
      case "select":
        return { select: what.select };
      case "group":
        return s === 1 ? { activeGroup: what.group } : {};
      case "days": {
        const texts = { mon: COMPETING_DAY };
        return { days: { group: s === 0 ? 1 : 3, texts } };
      }
    }
  };

  const apply = (fault: Fault): void => {
    switch (fault.k) {
      case "wait":
        state.retry?.();
        advance(fault.seconds * 1000);
        return;
      case "fate":
        for (let i = 0; i < fault.count; i++) {
          state.fates[fault.valve].push({
            on: fault.on,
            fate: fault.fate,
            delayMs: fault.delaySeconds * 1000,
          });
        }
        return;
      case "sensor": {
        const ref = sensorOf(fault.room);
        const next = Math.min(28, Math.max(12, (levels[fault.room] ?? 20) + fault.delta));
        levels[fault.room] = next;
        sim.setSensor(ref, { value: next });
        return;
      }
      case "sleep":
        sim.valve(VALVE_IDS[fault.valve]).sleep();
        return;
      case "wake":
        if (!sim.valve(VALVE_IDS[fault.valve]).isAwake()) {
          sim.valve(VALVE_IDS[fault.valve]).wake(sim.now());
        }
        return;
      case "bridgeRestart":
        sim.restartBridge();
        return;
      case "replay":
        sim.replayCache();
        return;
      case "restart":
        sim.restart();
        return;
      case "crash":
        sim.crashAfterEffects(fault.after);
        return;
      case "link":
        if (fault.name === "z2m") {
          if (fault.up && state.linkDown) {
            state.linkDown = false;
            sim.linkUp("z2m");
          } else if (!fault.up) {
            state.linkDown = true;
            sim.linkDown("z2m");
          }
          return;
        }
        state.haDown = !fault.up;
        if (fault.up) sim.linkUp("ha");
        else sim.linkDown("ha");
        for (const n of ROOM_NAMES) {
          if (n !== "c") sim.setSensor(sensorOf(n), { pending: !fault.up });
        }
        return;
      case "person": {
        const valve = sim.valve(VALVE_IDS[fault.valve]);
        if (valve.isAwake()) valve.person(personChange(fault.valve, fault.change), sim.now());
        return;
      }
      case "knob": {
        const valve = sim.valve(VALVE_IDS[fault.valve]);
        if (!valve.isAwake()) return;
        valve.knob(fault.clicks, sim.now());
        turns.push({ at: sim.now(), valve: fault.valve, truth: valve.truth() });
        return;
      }
      case "button": {
        const valve = sim.valve(VALVE_IDS[fault.valve]);
        if (!valve.isAwake()) return;
        valve.button(sim.now());
        turns.push({ at: sim.now(), valve: fault.valve, truth: valve.truth() });
        return;
      }
      case "compete":
        state.competitors[fault.valve] = {
          what: fault.what,
          until: sim.now() + fault.seconds * 1000,
        };
        return;
      case "place": {
        // The device moves in Home Assistant; the tick joins or releases the valve.
        const old = placement;
        place(fault.valve === 0 ? [fault.room, old[1]] : [old[0], fault.room]);
        return;
      }
      case "edit": {
        const old = schedules;
        change(
          () => {
            schedules = { ...old, [fault.schedule]: fault.variant };
          },
          () => {
            schedules = old;
          },
        );
        return;
      }
      case "hold": {
        const old = hold;
        change(
          () => {
            hold = fault.on;
          },
          () => {
            hold = old;
          },
        );
        return;
      }
      case "loseStore":
        if (fault.config !== "keep") sim.loseConfig(fault.config === "lost" ? "lost" : "corrupt");
        if (fault.ledger !== "keep") sim.loseLedger(fault.ledger === "lost" ? "lost" : "corrupt");
        if (fault.config !== "keep" || fault.ledger !== "keep") sim.restart();
        return;
      case "importCopy":
        if (sim.copy() !== undefined) sim.importCopy();
        return;
      case "swap":
        sim.batterySwap(VALVE_IDS[fault.valve]);
        return;
      case "rejoin":
        sim.rejoin(VALVE_IDS[fault.valve]);
        return;
    }
  };

  const run = (plan: FaultPlan): void => {
    // Heatmaster hears from both valves, then the first document with schedules joins both; a
    // refused first try is repeated.
    const asIs = (): void => undefined;
    advance(60 * 1000);
    change(asIs, asIs);
    advance(3 * MINUTE_MS);
    change(asIs, asIs);
    advance(2 * MINUTE_MS);
    for (const fault of plan.steps) apply(fault);
  };

  return {
    sim,
    turns,
    model: () => modelConfig(schedules, hold, intervalMs),
    joins,
    onStep: (fn) => {
      observers.push(fn);
    },
    step,
    advance,
    apply,
    run,
  };
}

// Quiescence -------------------------------------------------------------------------------------

/**
 * Stops every fault, wakes every valve and runs for the longest maximum age of any group plus 26
 * simulated hours: long enough for every group to be marked by age, asked, written and heard.
 */
export function quiesce(sim: SimDriver): void {
  const state = faultStates.get(sim);
  const now = sim.now();
  if (state !== undefined) {
    state.fates = [[], []];
    state.competitors = [undefined, undefined];
    state.lateAt = [undefined, undefined];
    sim.crashAfterEffects(undefined);
  }
  state?.retry?.();
  const world = sim.world();
  let longest = 0;
  for (const [id, device] of world.devices) {
    const valve = sim.valve(id);
    valve.flushLate(now);
    if (!valve.isAwake()) valve.wake(now);
    for (const group of device.spec?.groups ?? []) {
      longest = Math.max(longest, group.maxAgeMs ?? 0);
    }
  }
  if (state?.linkDown === true) {
    state.linkDown = false;
    sim.linkUp("z2m");
  }
  if (state?.haDown === true) {
    state.haDown = false;
    sim.linkUp("ha");
    for (const n of ROOM_NAMES) {
      if (n !== "c") sim.setSensor(sensorOf(n), { pending: false });
    }
  }
  const end = sim.elapsed() + longest + 26 * HOUR_MS;
  const stepMs = 60 * 1000;
  while (sim.elapsed() + stepMs <= end) {
    if (state?.step === undefined) sim.step(stepMs);
    else state.step(stepMs);
  }
}
