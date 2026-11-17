import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BUCKET,
  configToRaw,
  START_TOKENS,
  findProfile,
  groupOf,
  reconcile,
  resolveRooms,
  sensorId,
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
  MODELS,
  ROOM_NAMES,
  SLOTS,
  VALVE_IDS,
  createRig,
  faultPlan,
  modelConfig,
  modelMembership,
  quiesce,
  sensorOf,
} from "./faults.ts";
import { factoryWeek, reported } from "./valve.ts";
import type { Effect, Ledger, SettingKey, SettingValue, ValveRecord } from "../../src/index.ts";
import type {
  Fault,
  FaultPlan,
  Placement,
  Rig,
  RoomName,
  Slot,
  StepInfo,
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
  "mode.wire",
] as const;
type Id = (typeof IDS)[number];

type Report = ReadonlyMap<Id, readonly string[]>;

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
      // Heard means the valve spoke: a message with a last_seen newer than every one before. A
      // replay or an echo carries an old one. This does not use the core's own idea of heard.
      const token = world.devices.get(valveId)?.state?.lifeToken;
      const before = newest.get(valveId);
      if (token !== undefined && (before === undefined || token > before)) {
        newest.set(valveId, token);
        reset.add(valveId);
      }
    }
    for (const valveId of reset) asks.set(valveId, []);

    // A group's epoch is one stretch of one desired value in one incarnation of the memory.
    for (const valveId of VALVE_IDS) {
      for (const group of ["schedule", "active_group", "sensor_source"] as const) {
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

      // mode never written: look at the payload the binding would send
      const payload = payloadOf(sim, valveId, effect);
      if (payload !== undefined && Object.hasOwn(payload, Z2M_KEYS.mode)) {
        found("mode.wire", `${tag} wrote ${Z2M_KEYS.mode} on the ${binding}`);
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
  rig.run(plan);
  quiesce(rig.sim);
  converge(rig, add);
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

function propertyTest(name: string, ids: readonly Id[], options: { crashy?: boolean } = {}): void {
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
        "in a plan with no battery swap the valve's true sensor source and active group equal them too",
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
        IDS.filter((id) => id !== "mode.wire"),
        { crashy: true },
      );
    });
  });

  describe("mode", () => {
    describe("At every moment", () => {
      propertyTest("Heatmaster never writes a valve's mode", ["mode.wire"]);
    });
  });

  describe("plans that fast-check does not reach often", () => {
    const initial = {
      trvzbSelect: "local_temperature",
      zbtSelect: "local_temperature",
      zbtGroup: 1,
      intervalMin: 5,
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
        "the publishes the valves receive until 30 min pass without one are exactly the change's planned writes, in order per valve",
        () => {
          fc.assert(fc.property(changeArbitrary, previewHolds), { seed: SEED, numRuns: NUM_RUNS });
        },
        SLOW_MS,
      );
    });
  });
});

// Preview ------------------------------------------------------------------------------------------

type Change = Readonly<{
  placement: Placement;
  schedules: Readonly<{ default: Variant; alt: Variant }>;
  comfort: number;
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
});

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
  const config = { ...base, presets: { ...base.presets, comfort: change.comfort } };
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
