import { describe, expect, it } from "vitest";
import {
  BUCKET,
  REFILL_MS,
  START_TOKENS,
  VALVE_SILENT_AFTER_MS,
  configToRaw,
} from "../../src/index.ts";
import { Z2M_DAY_PAYLOAD } from "../../src/profiles/sonoff-codec.ts";
import { makeConfig } from "../builders.ts";
import {
  HOUR_MS,
  MINUTE_MS,
  STEP_MS,
  createSimDriver,
  desiredTexts,
  factoryValve,
  inSyncValve,
  recordedLedger,
  simRoom,
  valveIdOf,
} from "./driver.ts";
import { factoryWeek } from "./valve.ts";
import type { SimDriver } from "./driver.ts";
import type { Config, Effect, ProblemKind, Room, SettingKey } from "../../src/index.ts";
import type { ValveModel } from "./valve.ts";

// Helpers ----------------------------------------------------------------------------------------

type Placed = readonly (readonly [number, ValveModel])[];
type RoomPlan = Readonly<{ id: string; valves: Placed; sensor?: boolean }>;

type Built = Readonly<{ sim: SimDriver; config: Config }>;

function sensorRef(roomId: string): string {
  return `ha:sensor.${roomId}`;
}

function roomOf(plan: RoomPlan): Room {
  return simRoom(
    plan.id,
    plan.valves.map(([n]) => valveIdOf(n)),
    plan.sensor === false ? [] : [sensorRef(plan.id)],
  );
}

/** Rooms of valves that already hold what Heatmaster wants, a recorded ledger, a fresh sensor each. */
function build(
  options: Readonly<{
    rooms: readonly RoomPlan[];
    /** Valves in no room, in their factory state. */
    extra?: Placed;
    hold?: boolean;
    /** The valves hold their factory settings instead. */
    outOfSync?: boolean;
    recorded?: boolean;
    /** Sensors no room names yet. */
    extraSensors?: readonly string[];
  }>,
): Built {
  const rooms = options.rooms.map(roomOf);
  const config = makeConfig({ rooms, holdWrites: options.hold ?? false });
  const placed = options.rooms.flatMap((plan) =>
    plan.valves.map(([n, model]) => ({ plan, id: valveIdOf(n), model })),
  );
  const valves = [
    ...placed.map(({ plan, id, model }) =>
      options.outOfSync === true
        ? factoryValve(id, model)
        : inSyncValve(config, plan.id, id, model),
    ),
    ...(options.extra ?? []).map(([n, model]) => factoryValve(valveIdOf(n), model)),
  ];
  const sim = createSimDriver({
    config,
    ledger:
      options.recorded === false
        ? recordedLedger([])
        : recordedLedger(placed.map(({ id, model }) => ({ valveId: id, model }))),
    valves,
    sensors: [
      ...options.rooms
        .filter((plan) => plan.sensor !== false)
        .map((plan) => ({ ref: sensorRef(plan.id), value: 20 })),
      ...(options.extraSensors ?? []).map((ref) => ({ ref, value: 20 })),
    ],
  });
  return { sim, config };
}

const seconds = (ms: number): number => ms / 1000;

/** The times, in seconds since the start, of a valve's effects of one kind. */
function times(sim: SimDriver, valveId: string, kind: Effect["kind"]): number[] {
  return sim.effectsOf(valveId, kind).map((entry) => seconds(entry.at));
}

/** The setting keys each publish to the valve held, with its time in seconds. */
function published(sim: SimDriver, valveId: string): { at: number; keys: SettingKey[] }[] {
  return sim.effectsOf(valveId, "publish").map((entry) => ({
    at: seconds(entry.at),
    keys: entry.effect.kind === "publish" ? (Object.keys(entry.effect.values) as SettingKey[]) : [],
  }));
}

const SEVEN_DAYS: SettingKey[] = [
  "day_mon",
  "day_tue",
  "day_wed",
  "day_thu",
  "day_fri",
  "day_sat",
  "day_sun",
];

function sync(sim: SimDriver, valveId: string): string | undefined {
  for (const room of sim.lastResult()?.rooms.values() ?? []) {
    const found = room.valves.find((v) => v.valveId === valveId);
    if (found !== undefined) return found.sync;
  }
  return undefined;
}

/** Tokens spent since the start, rounded: the memory's tokens plus what refilled meanwhile. */
function tokensUsed(sim: SimDriver, valveId: string): number {
  const vm = sim.memory().valves.get(valveId);
  if (vm === undefined) throw new Error(`no memory for ${valveId}`);
  const held = vm.tokens + (sim.now() - vm.tokensAt) / REFILL_MS;
  return Math.round(START_TOKENS - held + sim.elapsed() / REFILL_MS);
}

function problemKinds(sim: SimDriver): ProblemKind[] {
  return (sim.lastResult()?.problems ?? []).map((p) => p.kind);
}

function copyOfRooms(config: Config, rooms: readonly Room[]): Config {
  return { ...config, rooms };
}

/** Everything that reached a valve: writes, setpoint writes and pushes, but not refreshes. */
function writesTo(sim: SimDriver, valveId: string): number {
  return sim
    .effectsOf(valveId)
    .filter((e) => ["publish", "publishSetpoint", "pushTemperature"].includes(e.effect.kind))
    .length;
}

const A = 1;
const B = 2;

// Scenarios --------------------------------------------------------------------------------------

describe("scenarios", () => {
  describe("start", () => {
    describe("With one TRVZB and one TRV-ZBT in rooms whose sensor is fresh from the first step", () => {
      function run(): Built & Readonly<{ a: string; b: string }> {
        const built = build({
          rooms: [
            { id: "r1", valves: [[A, "trvzb"]] },
            { id: "r2", valves: [[B, "trv_zbt"]] },
          ],
        });
        built.sim.step(0);
        built.sim.runTo(5 * MINUTE_MS);
        return { ...built, a: valveIdOf(A), b: valveIdOf(B) };
      }

      it("each valve gets one refresh at the first step and nothing else before its first message", () => {
        const { sim, a, b } = run();
        for (const id of [a, b]) {
          const early = sim.effectsOf(id).filter((e) => e.at < STEP_MS);
          expect(early.map((e) => [e.effect.kind, seconds(e.at)])).toEqual([["refresh", 0]]);
        }
      });

      it("each valve gets a temperature push at 30 s, after its first message", () => {
        const { sim, a, b } = run();
        expect(times(sim, a, "pushTemperature")[0]).toBe(30);
        expect(times(sim, b, "pushTemperature")[0]).toBe(30);
      });

      it("the seven days are published once, in full, after the valve was heard; the TRV-ZBT's name group 3", () => {
        const { sim, a, b } = run();
        // The TRVZB waits for a second message (1 min). The TRV-ZBT's days cannot be read back, so
        // the core counts them as differing and sends them at its first message (30 s).
        expect(published(sim, a)).toEqual([{ at: 60, keys: SEVEN_DAYS }]);
        expect(published(sim, b)).toEqual([{ at: 30, keys: SEVEN_DAYS }]);
        const truth = sim.valve(b).truth();
        expect(sim.bridge.editGroup(b)).toBe(3);
        expect(truth.schedules[3]).toEqual(
          desiredTexts(sim.world().stored?.config ?? makeConfig(), "r2", "trv_zbt"),
        );
        expect(truth.schedules[1]).toEqual(factoryWeek("trv_zbt"));
        expect(truth.schedules[2]).toEqual(factoryWeek("trv_zbt"));
      });

      it("the sensor source and the active group are never written", () => {
        const { sim, a, b } = run();
        for (const id of [a, b]) {
          for (const entry of published(sim, id)) {
            expect(entry.keys).not.toContain("sensor_source");
            expect(entry.keys).not.toContain("active_group");
          }
        }
      });

      it("each valve is in sync by 1 min 30 s and has used 2 of its 4 start tokens", () => {
        const built = build({
          rooms: [
            { id: "r1", valves: [[A, "trvzb"]] },
            { id: "r2", valves: [[B, "trv_zbt"]] },
          ],
        });
        built.sim.step(0);
        built.sim.runTo(90 * 1000);
        for (const n of [A, B]) {
          expect(sync(built.sim, valveIdOf(n))).toBe("in_sync");
          expect(tokensUsed(built.sim, valveIdOf(n))).toBe(2);
        }
      });
    });

    describe("With a TRVZB in a room that has no sensors", () => {
      function run(until: number): Built {
        const built = build({ rooms: [{ id: "r1", valves: [[A, "trvzb"]], sensor: false }] });
        built.sim.step(0);
        built.sim.runTo(until);
        return built;
      }

      it("the valve gets a refresh at the first step and a second one at 2 min", () => {
        const { sim } = run(5 * MINUTE_MS);
        expect(times(sim, valveIdOf(A), "refresh")).toEqual([0, 120]);
      });

      it("the seven days are published once at 2 min 30 s", () => {
        const { sim } = run(5 * MINUTE_MS);
        expect(published(sim, valveIdOf(A))).toEqual([{ at: 150, keys: SEVEN_DAYS }]);
      });

      it("the valve is in sync by 3 min and has used 3 of its 4 start tokens", () => {
        const { sim } = run(3 * MINUTE_MS);
        expect(sync(sim, valveIdOf(A))).toBe("in_sync");
        expect(tokensUsed(sim, valveIdOf(A))).toBe(3);
      });
    });

    describe("With a valve that never answers", () => {
      function run(until: number): Built {
        const built = build({ rooms: [{ id: "r1", valves: [[A, "trvzb"]] }] });
        built.sim.valve(valveIdOf(A)).setPolicy(() => "lose");
        built.sim.step(0);
        built.sim.runTo(until);
        return built;
      }

      it("it gets refreshes at 0, 2 min, 12 min and 1 h 12 min, and nothing else", () => {
        const { sim } = run(10 * HOUR_MS);
        const id = valveIdOf(A);
        expect(times(sim, id, "refresh")).toEqual([0, 120, 720, 4320]);
        expect(sim.effectsOf(id).filter((e) => e.effect.kind !== "refresh")).toEqual([]);
      });

      it("its sync is unverified throughout", () => {
        const built = build({ rooms: [{ id: "r1", valves: [[A, "trvzb"]] }] });
        built.sim.valve(valveIdOf(A)).setPolicy(() => "lose");
        const seen = new Set<string | undefined>();
        built.sim.step(0);
        seen.add(sync(built.sim, valveIdOf(A)));
        while (built.sim.elapsed() < 3 * HOUR_MS) {
          built.sim.step(STEP_MS);
          seen.add(sync(built.sim, valveIdOf(A)));
        }
        expect([...seen]).toEqual(["unverified"]);
      });

      it("after 2 h it is reported silent (from 2 h 30 s on the 30 s grid), and it is not asked again", () => {
        const { sim } = build({ rooms: [{ id: "r1", valves: [[A, "trvzb"]] }] });
        sim.valve(valveIdOf(A)).setPolicy(() => "lose");
        sim.step(0);
        sim.runTo(VALVE_SILENT_AFTER_MS);
        expect(problemKinds(sim)).not.toContain("valve_silent");
        sim.step(STEP_MS);
        expect(sim.elapsed()).toBe(VALVE_SILENT_AFTER_MS + STEP_MS);
        expect(problemKinds(sim)).toContain("valve_silent");
        sim.runTo(30 * HOUR_MS);
        expect(times(sim, valveIdOf(A), "refresh")).toEqual([0, 120, 720, 4320]);
      });
    });

    describe("With a valve in a fed room, asleep at the start, whose requests are queued, waking after 20 min", () => {
      function run(until: number): Built {
        const built = build({ rooms: [{ id: "r1", valves: [[A, "trvzb"]] }] });
        const valve = built.sim.valve(valveIdOf(A));
        valve.sleep();
        built.sim.step(0);
        built.sim.runTo(20 * MINUTE_MS);
        valve.wake(built.sim.now());
        built.sim.runTo(until);
        return built;
      }

      it("it gets refreshes at 0, 2 min and 12 min, and none after it woke", () => {
        const { sim } = run(2 * HOUR_MS);
        expect(times(sim, valveIdOf(A), "refresh")).toEqual([0, 120, 720]);
      });

      it("the seven days are published once, and the valve is in sync within 90 s of waking", () => {
        const { sim } = run(20 * MINUTE_MS + 90 * 1000);
        expect(published(sim, valveIdOf(A)).map((p) => p.keys)).toEqual([SEVEN_DAYS]);
        expect(sync(sim, valveIdOf(A))).toBe("in_sync");
      });
    });

    describe("With a refresh that is lost and a room that has no sensors", () => {
      it("the valve is asked again 2 min after the lost one", () => {
        const { sim } = build({ rooms: [{ id: "r1", valves: [[A, "trvzb"]], sensor: false }] });
        sim.valve(valveIdOf(A)).setPolicy((_request, nth) => (nth === 0 ? "lose" : "land"));
        sim.step(0);
        sim.runTo(15 * MINUTE_MS);
        // Without the loss one answer at 2 min 30 s ends the asking; with it the next ask follows
        // the backoff (10 min after the second).
        expect(times(sim, valveIdOf(A), "refresh")).toEqual([0, 120, 720]);
        expect(sim.valve(valveIdOf(A)).received().reads).toBe(2);
      });
    });

    describe("With holdWrites true", () => {
      function run(): Built {
        const built = build({
          hold: true,
          rooms: [
            { id: "r1", valves: [[A, "trvzb"]] },
            { id: "r2", valves: [[B, "trv_zbt"]] },
          ],
        });
        built.sim.step(0);
        built.sim.runTo(30 * MINUTE_MS);
        return built;
      }

      it("each valve gets a refresh at the first step and a second one at 2 min, and none after that answer was heard", () => {
        const { sim } = run();
        for (const n of [A, B]) expect(times(sim, valveIdOf(n), "refresh")).toEqual([0, 120]);
      });

      it("no publish and no temperature push reaches any valve", () => {
        const { sim } = run();
        for (const n of [A, B]) expect(writesTo(sim, valveIdOf(n))).toBe(0);
        for (const n of [A, B]) expect(sim.valve(valveIdOf(n)).received().writes).toBe(0);
      });

      it("each valve's sync is held, and it has used 2 of its 4 start tokens", () => {
        const { sim } = run();
        for (const n of [A, B]) {
          expect(sync(sim, valveIdOf(n))).toBe("held");
          expect(tokensUsed(sim, valveIdOf(n))).toBe(2);
        }
      });
    });
  });

  describe("daily check", () => {
    describe("With a TRVZB in a fed room, in sync, 25 h after a start", () => {
      function run(): Built {
        const built = build({ rooms: [{ id: "r1", valves: [[A, "trvzb"]] }] });
        built.sim.step(0);
        built.sim.runTo(25 * HOUR_MS);
        return built;
      }

      it("between hour 24 and hour 25 it gets at most two refreshes and exactly one publish, which holds the seven days", () => {
        const { sim } = run();
        const id = valveIdOf(A);
        const inWindow = (t: number): boolean => t >= 24 * 3600 && t <= 25 * 3600;
        expect(times(sim, id, "refresh").filter(inWindow).length).toBeLessThanOrEqual(2);
        const day = published(sim, id).filter((p) => inWindow(p.at));
        expect(day.map((p) => p.keys)).toEqual([SEVEN_DAYS]);
      });

      it("the sensor source is not written", () => {
        const { sim } = run();
        for (const entry of published(sim, valveIdOf(A))) {
          expect(entry.keys).not.toContain("sensor_source");
        }
      });
    });
  });

  describe("join", () => {
    function withNewRoom(config: Config, valveId: string): Config {
      return copyOfRooms(config, [...config.rooms, simRoom("new", [valveId], [sensorRef("new")])]);
    }

    describe("With a new valve that has sent no message since the start", () => {
      function start(): Built & Readonly<{ n: string; raw: unknown }> {
        const built = build({
          rooms: [{ id: "r1", valves: [[A, "trvzb"]] }],
          extra: [[3, "trvzb"]],
          extraSensors: [sensorRef("new")],
        });
        const n = valveIdOf(3);
        built.sim.step(0);
        return { ...built, n, raw: configToRaw(withNewRoom(built.config, n)) };
      }

      it("the change is refused with valve_not_observed, and the driver asks the valve to report", () => {
        const { sim, n, raw } = start();
        const result = sim.planChange(raw);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.refused.code).toBe("valve_not_observed");
        expect(result.refused.data.valveIds).toBe(n);
        expect(sim.valve(n).received().reads).toBe(1);
      });

      it("the same change is accepted at the next step", () => {
        const { sim, raw } = start();
        sim.planChange(raw);
        sim.step(STEP_MS);
        expect(sim.planChange(raw).ok).toBe(true);
      });
    });

    describe('With a new TRVZB whose days already equal the room\'s and whose source is "internal"', () => {
      function joined(): Built & Readonly<{ n: string; joinedAt: number }> {
        const built = build({
          rooms: [{ id: "r1", valves: [[A, "trvzb"]] }],
          extra: [[3, "trvzb"]],
          extraSensors: [sensorRef("new")],
        });
        const n = valveIdOf(3);
        const next = withNewRoom(built.config, n);
        // Its days already equal the new room's: the same default week.
        built.sim.valve(n).setup({ days: { group: 1, texts: desiredTexts(next, "new", "trvzb") } });
        built.sim.step(0);
        built.sim.planChange(configToRaw(next));
        built.sim.step(STEP_MS);
        const result = built.sim.planChange(configToRaw(next));
        expect(result.ok).toBe(true);
        return { ...built, n, joinedAt: built.sim.elapsed() };
      }

      it('it gets one refresh, then its seven days once, then, after the room has been fresh for 10 min, "external"', () => {
        const { sim, n, joinedAt } = joined();
        sim.runTo(joinedAt + 20 * MINUTE_MS);
        const since = (t: number): number => t - seconds(joinedAt);
        expect(times(sim, n, "refresh").map(since)).toEqual([30]);
        const writes = published(sim, n);
        expect(writes.map((w) => w.keys)).toEqual([SEVEN_DAYS, ["sensor_source"]]);
        expect(since(writes[1]?.at ?? 0)).toBeGreaterThanOrEqual(10 * 60);
      });

      it("it has used 3 of its 4 start tokens", () => {
        const { sim, n, joinedAt } = joined();
        sim.runTo(joinedAt + 20 * MINUTE_MS);
        const vm = sim.memory().valves.get(n);
        const held = (vm?.tokens ?? 0) + (sim.now() - (vm?.tokensAt ?? 0)) / REFILL_MS;
        const refilled = (20 * MINUTE_MS + STEP_MS) / REFILL_MS;
        expect(Math.round(START_TOKENS - held + refilled)).toBe(3);
      });
    });

    describe('With a new TRV-ZBT whose active group is 1 and whose source is "internal"', () => {
      function joined(): Built & Readonly<{ n: string; joinedAt: number }> {
        const built = build({
          rooms: [{ id: "r1", valves: [[A, "trvzb"]] }],
          extra: [[3, "trv_zbt"]],
          extraSensors: [sensorRef("new")],
        });
        const n = valveIdOf(3);
        const next = withNewRoom(built.config, n);
        built.sim.step(0);
        built.sim.planChange(configToRaw(next));
        built.sim.step(STEP_MS);
        expect(built.sim.planChange(configToRaw(next)).ok).toBe(true);
        const joinedAt = built.sim.elapsed();
        built.sim.runTo(joinedAt + 20 * MINUTE_MS);
        return { ...built, n, joinedAt };
      }

      it('it gets one refresh, its seven days with group 3 named, active group 3, and after 10 min "external": 4 of its 4 start tokens', () => {
        const { sim, n, joinedAt } = joined();
        const since = (t: number): number => t - seconds(joinedAt);
        expect(times(sim, n, "refresh").map(since)).toEqual([30]);
        const writes = published(sim, n);
        expect(writes.map((w) => w.keys)).toEqual([
          SEVEN_DAYS,
          ["active_group"],
          ["sensor_source"],
        ]);
        expect(since(writes[2]?.at ?? 0)).toBeGreaterThanOrEqual(10 * 60);
        expect(sim.valve(n).truth().activeGroup).toBe(3);
        expect(sim.valve(n).truth().select).toBe("remote_temperature");
        const vm = sim.memory().valves.get(n);
        const held = (vm?.tokens ?? 0) + (sim.now() - (vm?.tokensAt ?? 0)) / REFILL_MS;
        expect(Math.round(START_TOKENS - held + (20 * MINUTE_MS + STEP_MS) / REFILL_MS)).toBe(4);
      });

      it("groups 1 and 2 are unchanged", () => {
        const { sim, n } = joined();
        const truth = sim.valve(n).truth();
        expect(truth.schedules[1]).toEqual(factoryWeek("trv_zbt"));
        expect(truth.schedules[2]).toEqual(factoryWeek("trv_zbt"));
        expect(truth.schedules[3]).toEqual(
          desiredTexts(sim.world().stored?.config ?? makeConfig(), "new", "trv_zbt"),
        );
      });
    });

    describe("With a new TRV-ZBT whose active group is already 3", () => {
      function joined(): Built & Readonly<{ n: string; next: Config }> {
        const built = build({
          rooms: [{ id: "r1", valves: [[A, "trvzb"]] }],
          extra: [[3, "trv_zbt"]],
          extraSensors: [sensorRef("new")],
        });
        const n = valveIdOf(3);
        built.sim.valve(n).setup({ activeGroup: 3 });
        const next = withNewRoom(built.config, n);
        built.sim.step(0);
        built.sim.planChange(configToRaw(next));
        built.sim.step(STEP_MS);
        expect(built.sim.planChange(configToRaw(next)).ok).toBe(true);
        built.sim.runTo(built.sim.elapsed() + 20 * MINUTE_MS);
        return { ...built, n, next };
      }

      it("it joins, its record's original active group is 3, and its group 3 holds the room's days", () => {
        const { sim, n, next } = joined();
        expect(sim.ledger()?.records.get(n)?.originals.active_group).toBe(3);
        expect(sim.valve(n).truth().schedules[3]).toEqual(desiredTexts(next, "new", "trv_zbt"));
      });

      it("the active group is never written, also not on release", () => {
        const { sim, n, config } = joined();
        sim.planChange(configToRaw(config));
        sim.runTo(sim.elapsed() + 40 * MINUTE_MS);
        expect(sim.ledger()?.records.has(n)).toBe(false);
        for (const entry of published(sim, n)) expect(entry.keys).not.toContain("active_group");
      });
    });
  });

  describe("bridge restart", () => {
    describe("With ten valves in sync and a bridge restart", () => {
      function run(): Built & Readonly<{ restartedAt: number; ids: string[] }> {
        const plans: RoomPlan[] = Array.from({ length: 10 }, (_, i) => ({
          id: `r${String(i)}`,
          valves: [[10 + i, i % 2 === 0 ? "trvzb" : "trv_zbt"]],
        }));
        const built = build({ rooms: plans });
        built.sim.step(0);
        built.sim.runTo(HOUR_MS);
        const restartedAt = built.sim.elapsed();
        built.sim.restartBridge();
        built.sim.runTo(restartedAt + 20 * MINUTE_MS);
        return { ...built, restartedAt, ids: plans.map((_, i) => valveIdOf(10 + i)) };
      }

      /** The effects after the restart began. */
      function after(sim: SimDriver, id: string, restartedAt: number) {
        return sim.effectsOf(id).filter((e) => e.at > restartedAt);
      }

      it("each valve gets one refresh, then its seven days once, only after it was heard", () => {
        const { sim, ids, restartedAt } = run();
        for (const id of ids) {
          const kinds = after(sim, id, restartedAt)
            .filter((e) => e.effect.kind === "refresh" || e.effect.kind === "publish")
            .map((e) => e.effect.kind);
          expect(kinds).toEqual(["refresh", "publish"]);
          const [refresh, publish] = after(sim, id, restartedAt).filter(
            (e) => e.effect.kind === "refresh" || e.effect.kind === "publish",
          );
          // The restart step is `restartedAt + 30 s`; the events come one step later.
          expect((refresh?.at ?? 0) - restartedAt).toBe(2 * STEP_MS);
          expect((publish?.at ?? 0) - (refresh?.at ?? 0)).toBe(STEP_MS);
        }
      });

      it("the sensor source and the active group are not written", () => {
        const { sim, ids, restartedAt } = run();
        for (const id of ids) {
          for (const entry of published(sim, id).filter((p) => p.at * 1000 > restartedAt)) {
            expect(entry.keys).toEqual(SEVEN_DAYS);
          }
        }
      });

      it("a TRV-ZBT's days are written with group 3 named, and groups 1 and 2 are unchanged", () => {
        const { sim, ids } = run();
        for (const [i, id] of ids.entries()) {
          if (i % 2 === 0) continue;
          const truth = sim.valve(id).truth();
          expect(sim.bridge.editGroup(id)).toBe(3);
          expect(truth.schedules[1]).toEqual(factoryWeek("trv_zbt"));
          expect(truth.schedules[2]).toEqual(factoryWeek("trv_zbt"));
        }
      });

      it("each valve has used 2 tokens", () => {
        const { sim, ids, restartedAt } = run();
        for (const id of ids) {
          const charged = after(sim, id, restartedAt).filter(
            (e) => e.effect.kind === "refresh" || e.effect.kind === "publish",
          );
          expect(charged).toHaveLength(2);
        }
      });
    });
  });

  describe("lost write", () => {
    describe("With an acked write lost once", () => {
      it("it is written again after 2 min and then the valve is in sync", () => {
        const { sim } = build({ rooms: [{ id: "r1", valves: [[A, "trvzb"]] }] });
        const id = valveIdOf(A);
        // The valve is on its own sensor; the room is fresh and fed, so "external" is wanted.
        sim.valve(id).setup({ select: "local_temperature" });
        let lost = false;
        sim.valve(id).setPolicy((request) => {
          if (request.kind === "write" && request.write.select !== undefined && !lost) {
            lost = true;
            return "lose";
          }
          return "land";
        });
        sim.step(0);
        sim.runTo(30 * MINUTE_MS);
        const source = published(sim, id).filter((p) => p.keys.includes("sensor_source"));
        expect(source).toHaveLength(2);
        expect((source[1]?.at ?? 0) - (source[0]?.at ?? 0)).toBe(120);
        expect(sim.valve(id).truth().select).toBe("remote_temperature");
        expect(sync(sim, id)).toBe("in_sync");
      });
    });

    describe("With an echoed schedule write lost", () => {
      function run(until: number): Built {
        const built = build({
          rooms: [{ id: "r1", valves: [[A, "trvzb"]], sensor: false }],
          outOfSync: true,
        });
        const id = valveIdOf(A);
        // The valve reports every 10 min on its own, as a healthy valve does.
        built.sim.valve(id).setSelfReports(true);
        let lost = false;
        built.sim.valve(id).setPolicy((request) => {
          if (request.kind === "write" && request.write.days !== undefined && !lost) {
            lost = true;
            return "lose";
          }
          return "land";
        });
        built.sim.step(0);
        built.sim.runTo(until);
        return built;
      }

      it("the bridge shows the new days and nothing is written again that day", () => {
        const { sim, config } = run(23 * HOUR_MS);
        const id = valveIdOf(A);
        expect(published(sim, id)).toHaveLength(1);
        expect(sim.bridge.cache(id)[Z2M_DAY_PAYLOAD.mon]).toBe(
          desiredTexts(config, "r1", "trvzb").mon,
        );
        expect(sim.valve(id).truth().schedules[1]).toEqual(factoryWeek("trvzb"));
      });

      it("when the group is 24 h old it is marked, and once the valve was heard (it is asked if it does not speak by itself) the seven days are published in full", () => {
        const { sim } = run(27 * HOUR_MS);
        const id = valveIdOf(A);
        const writes = published(sim, id);
        expect(writes).toHaveLength(2);
        expect(writes[1]?.keys).toEqual(SEVEN_DAYS);
        expect(writes[1]?.at).toBeGreaterThanOrEqual(24 * 3600);
        const refreshes = times(sim, id, "refresh").filter((t) => t >= 24 * 3600);
        expect(refreshes.length).toBeGreaterThan(0);
        expect(refreshes[0]).toBeLessThan(writes[1]?.at ?? 0);
      });

      it("after that the valve holds the desired days", () => {
        const { sim, config } = run(27 * HOUR_MS);
        expect(sim.valve(valveIdOf(A)).truth().schedules[1]).toEqual(
          desiredTexts(config, "r1", "trvzb"),
        );
      });
    });
  });

  describe("late write", () => {
    describe("With a write queued while the valve sleeps, and the valve then removed from its room", () => {
      it("the release does not finish until the queued write has landed and been undone", () => {
        const { sim, config } = build({
          rooms: [
            {
              id: "r1",
              valves: [
                [A, "trvzb"],
                [B, "trvzb"],
              ],
            },
          ],
        });
        const id = valveIdOf(A);
        sim.step(0);
        // Three quiet hours: the bucket is full and the room has long been fed.
        sim.runTo(3 * HOUR_MS);
        // Something puts the valve on its own sensor and it falls asleep before Heatmaster reacts.
        sim.personWrites(id, { temperature_sensor_select: "local_temperature" });
        sim.valve(id).sleep();
        sim.step(STEP_MS);
        // The source write is waiting inside the sleeping valve.
        expect(sim.valve(id).queued()).toBeGreaterThan(0);
        const without = copyOfRooms(config, [simRoom("r1", [valveIdOf(B)], [sensorRef("r1")])]);
        expect(sim.planChange(configToRaw(without)).ok).toBe(true);
        const removedAt = sim.elapsed();
        sim.runTo(removedAt + 40 * MINUTE_MS);
        // Long past the hold, but the valve was not heard since: still releasing.
        expect(sim.ledger()?.records.has(id)).toBe(true);
        expect(sim.config().stored?.releasing.has(id)).toBe(true);
        sim.valve(id).wake(sim.now());
        sim.runTo(removedAt + 40 * MINUTE_MS + 3 * MINUTE_MS);
        // The queued write landed, and the valve was put back to its original source.
        expect(sim.valve(id).truth().select).toBe("local_temperature");
        expect(sim.ledger()?.records.has(id)).toBe(true);
        sim.runTo(removedAt + 40 * MINUTE_MS + 25 * MINUTE_MS);
        expect(sim.ledger()?.records.has(id)).toBe(false);
        expect(sim.config().stored?.releasing.has(id)).toBe(false);
        const last = published(sim, id).at(-1);
        expect(last?.keys).toEqual(["sensor_source"]);
        // The undo came after the wake-up, not before.
        expect(last?.at ?? 0).toBeGreaterThan(seconds(removedAt) + 40 * 60);
        expect(sim.valve(id).truth().select).toBe("local_temperature");
      });
    });
  });

  describe("release", () => {
    function released(): Built & Readonly<{ id: string; removedAt: number; without: Config }> {
      const built = build({
        rooms: [
          {
            id: "r1",
            valves: [
              [A, "trvzb"],
              [B, "trvzb"],
            ],
          },
        ],
      });
      built.sim.step(0);
      built.sim.runTo(10 * MINUTE_MS);
      const without = copyOfRooms(built.config, [simRoom("r1", [valveIdOf(B)], [sensorRef("r1")])]);
      expect(built.sim.planChange(configToRaw(without)).ok).toBe(true);
      return { ...built, id: valveIdOf(A), removedAt: built.sim.elapsed(), without };
    }

    describe("With a TRVZB removed from its room", () => {
      it("its original sensor source is published and its days are left as they are", () => {
        const { sim, id, removedAt } = released();
        const daysBefore = sim.valve(id).truth().schedules[1];
        sim.runTo(removedAt + 25 * MINUTE_MS);
        const writes = published(sim, id).filter((p) => p.at * 1000 > removedAt);
        expect(writes.map((w) => w.keys)).toEqual([["sensor_source"]]);
        expect(sim.valve(id).truth().select).toBe("local_temperature");
        expect(sim.valve(id).truth().schedules[1]).toEqual(daysBefore);
      });

      it("after the values stayed equal for 15 min and the valve was heard, the record is in released and the valve is not in releasing", () => {
        const { sim, id, removedAt } = released();
        sim.runTo(removedAt + 14 * MINUTE_MS);
        expect(sim.ledger()?.records.has(id)).toBe(true);
        sim.runTo(removedAt + 20 * MINUTE_MS);
        expect(sim.ledger()?.records.has(id)).toBe(false);
        expect(sim.ledger()?.released.map((r) => r.record.valveId)).toContain(id);
        expect(sim.config().stored?.releasing.has(id)).toBe(false);
        expect(sim.copy()?.records.has(id)).toBe(false);
      });
    });

    describe("With a Heatmaster restart during the hold", () => {
      it("the hold starts anew after the valve was asked and heard", () => {
        const { sim, id, removedAt } = released();
        sim.runTo(removedAt + 8 * MINUTE_MS);
        expect(sim.ledger()?.records.has(id)).toBe(true);
        sim.restart();
        const restartedAt = sim.elapsed();
        sim.runTo(restartedAt + 14 * MINUTE_MS);
        // Without the restart the release would be done by now.
        expect(sim.ledger()?.records.has(id)).toBe(true);
        sim.runTo(restartedAt + 20 * MINUTE_MS);
        expect(sim.ledger()?.records.has(id)).toBe(false);
        const refreshes = times(sim, id, "refresh").filter((t) => t * 1000 > restartedAt);
        expect(refreshes.length).toBeGreaterThanOrEqual(2);
        expect(sim.disk().ledger.state).toBe("ok");
      });
    });
  });

  describe("competing writer", () => {
    describe("With a full bucket and something setting the sensor source back every 5 min", () => {
      function run(until: number): Built & Readonly<{ id: string; t0: number }> {
        const built = build({ rooms: [{ id: "r1", valves: [[A, "trvzb"]] }] });
        const id = valveIdOf(A);
        built.sim.step(0);
        // Three quiet hours fill the bucket and the room has long been fed.
        built.sim.runTo(3 * HOUR_MS);
        const t0 = built.sim.elapsed();
        const reset = (): void => {
          built.sim.personWrites(id, { temperature_sensor_select: "local_temperature" });
        };
        reset();
        let nextReset = t0 + 5 * MINUTE_MS;
        while (built.sim.elapsed() + STEP_MS <= t0 + until) {
          if (built.sim.elapsed() >= nextReset) {
            reset();
            nextReset += 5 * MINUTE_MS;
          }
          built.sim.step(STEP_MS);
        }
        return { ...built, id, t0 };
      }

      it("Heatmaster writes it at about 0, 5 min, 15 min and 1 h 15 min, and then once every 6 h: 7 writes in the first 24 h", () => {
        const { sim, id, t0 } = run(24 * HOUR_MS);
        expect(sim.memory().valves.get(id)?.tokens).toBeLessThanOrEqual(BUCKET);
        const writes = published(sim, id)
          .filter((p) => p.keys.includes("sensor_source") && p.at * 1000 > t0)
          .map((p) => (p.at * 1000 - t0) / MINUTE_MS);
        expect(writes).toHaveLength(7);
        const [w1, w2, w3, w4, w5, w6, w7] = writes as [
          number,
          number,
          number,
          number,
          number,
          number,
          number,
        ];
        expect(w1).toBeLessThan(1);
        expect(w2).toBeCloseTo(5.5, 0);
        expect(w3).toBeCloseTo(15.5, 0);
        expect(w4).toBeCloseTo(75.5, 0);
        expect(w5 - w4).toBeCloseTo(360, 0);
        expect(w6 - w5).toBeCloseTo(360, 0);
        expect(w7 - w6).toBeCloseTo(360, 0);
      });

      it("a setting_not_holding problem from the third write on", () => {
        const second = run(8 * MINUTE_MS);
        expect(problemKinds(second.sim)).not.toContain("setting_not_holding");
        const third = run(17 * MINUTE_MS);
        expect(problemKinds(third.sim)).toContain("setting_not_holding");
      });
    });
  });

  describe("battery swap", () => {
    describe("With a swap, while Heatmaster is running, that resets the schedule and the sensor source", () => {
      it("the valve gets one refresh, then its seven days in full, then its sensor source, each once: 3 tokens", () => {
        const { sim } = build({ rooms: [{ id: "r1", valves: [[A, "trvzb"]] }] });
        const id = valveIdOf(A);
        sim.step(0);
        sim.runTo(HOUR_MS);
        const swappedAt = sim.elapsed();
        sim.batterySwap(id);
        sim.runTo(swappedAt + 20 * MINUTE_MS);
        const after = sim
          .effectsOf(id)
          .filter((e) => e.at > swappedAt && ["refresh", "publish"].includes(e.effect.kind));
        expect(
          after.map((e) =>
            e.effect.kind === "publish" ? Object.keys(e.effect.values) : e.effect.kind,
          ),
        ).toEqual(["refresh", SEVEN_DAYS, ["sensor_source"]]);
        expect(sim.valve(id).truth().select).toBe("remote_temperature");
        expect(sim.valve(id).truth().schedules[1]).toEqual(
          desiredTexts(sim.world().stored?.config ?? makeConfig(), "r1", "trvzb"),
        );
      });
    });

    describe("With the same swap while Heatmaster is down", () => {
      it("after the start the seven days are published once, and the sensor source once the room has been fresh for 10 min", () => {
        const { sim } = build({ rooms: [{ id: "r1", valves: [[A, "trvzb"]] }] });
        const id = valveIdOf(A);
        sim.step(0);
        sim.runTo(HOUR_MS);
        sim.whileDown(() => {
          sim.batterySwap(id);
        });
        const startedAt = sim.elapsed();
        sim.step(0);
        sim.runTo(startedAt + 20 * MINUTE_MS);
        const writes = published(sim, id).filter((p) => p.at * 1000 >= startedAt);
        expect(writes.map((w) => w.keys)).toEqual([SEVEN_DAYS, ["sensor_source"]]);
        expect(writes[1]?.at ?? 0).toBeGreaterThanOrEqual(startedAt / 1000 + 10 * 60);
        expect(sim.valve(id).truth().select).toBe("remote_temperature");
      });
    });
  });

  describe("manual schedule edit in Zigbee2MQTT", () => {
    describe("With a person changing a day of a TRVZB", () => {
      it("that day alone is published, once", () => {
        const { sim, config } = build({ rooms: [{ id: "r1", valves: [[A, "trvzb"]] }] });
        const id = valveIdOf(A);
        sim.step(0);
        sim.runTo(15 * MINUTE_MS);
        const before = published(sim, id).length;
        const person = "00:00/10 06:00/21 12:00/10 12:00/10 12:00/10 12:00/10";
        sim.personWrites(id, { [Z2M_DAY_PAYLOAD.mon]: person });
        sim.runTo(40 * MINUTE_MS);
        const fresh = published(sim, id).slice(before);
        expect(fresh.map((p) => p.keys)).toEqual([["day_mon"]]);
        expect(sim.valve(id).truth().schedules[1]).toEqual(desiredTexts(config, "r1", "trvzb"));
      });
    });

    describe("With a person editing group 1 of a TRV-ZBT", () => {
      function run(until: number): Built & Readonly<{ id: string; person: string }> {
        const built = build({ rooms: [{ id: "r1", valves: [[A, "trv_zbt"]] }] });
        const id = valveIdOf(A);
        built.sim.step(0);
        built.sim.runTo(15 * MINUTE_MS);
        const person =
          "00:00/10 06:00/21 12:00/10 12:00/10 12:00/10 12:00/10 12:00/10 12:00/10 12:00/10 12:00/10 12:00/10 12:00/10";
        built.sim.personWrites(id, { schedule_group_to_edit: "1", [Z2M_DAY_PAYLOAD.mon]: person });
        built.sim.runTo(until);
        return { ...built, id, person };
      }

      it("nothing is written and group 1 keeps the person's values", () => {
        const { sim, id, person } = run(23 * HOUR_MS);
        const writes = sim.effectsOf(id, "publish").filter((e) => e.at > 15 * MINUTE_MS);
        expect(writes).toEqual([]);
        expect(sim.valve(id).truth().schedules[1]?.mon).toBe(person);
        expect(sim.bridge.editGroup(id)).toBe(1);
      });

      it("the next day Heatmaster writes still names group 3", () => {
        const { sim, id, person, config } = run(27 * HOUR_MS);
        const writes = sim.effectsOf(id, "publish").filter((e) => e.at > 15 * MINUTE_MS);
        expect(writes.length).toBeGreaterThan(0);
        expect(sim.bridge.editGroup(id)).toBe(3);
        expect(sim.valve(id).truth().schedules[1]?.mon).toBe(person);
        expect(sim.valve(id).truth().schedules[3]).toEqual(desiredTexts(config, "r1", "trv_zbt"));
      });
    });
  });

  describe("store loss", () => {
    function three(): Built & Readonly<{ ids: string[] }> {
      const built = build({
        rooms: [
          { id: "r1", valves: [[1, "trvzb"]] },
          { id: "r2", valves: [[2, "trv_zbt"]] },
          { id: "r3", valves: [[3, "trvzb"]], sensor: false },
        ],
      });
      built.sim.step(0);
      built.sim.runTo(15 * MINUTE_MS);
      return { ...built, ids: [1, 2, 3].map(valveIdOf) };
    }

    /** Effects that reach a valve or change what Heatmaster holds of it, after `since`. */
    function touched(sim: SimDriver, ids: readonly string[], since: number): Effect[] {
      return ids.flatMap((id) =>
        sim
          .effectsOf(id)
          .filter((e) => e.at > since)
          .map((e) => e.effect),
      );
    }

    describe("With the config file lost and three managed valves", () => {
      it("no valve is written to, asked or released", () => {
        const { sim, ids } = three();
        const lostAt = sim.elapsed();
        sim.loseConfig("lost");
        sim.restart();
        sim.step(0);
        sim.runTo(lostAt + 3 * HOUR_MS);
        expect(touched(sim, ids, lostAt)).toEqual([]);
        expect(sim.ledger()?.records.size).toBe(3);
        expect(problemKinds(sim)).toContain("config_unreadable");
      });
    });

    describe("With the ledger file lost", () => {
      it("no valve is written to or asked, and no original is captured again", () => {
        const { sim, ids } = three();
        const lostAt = sim.elapsed();
        sim.loseLedger("lost");
        sim.restart();
        sim.step(0);
        sim.runTo(lostAt + 3 * HOUR_MS);
        expect(touched(sim, ids, lostAt)).toEqual([]);
        expect(sim.ledger()).toBeUndefined();
        expect(sim.disk().ledger.state).toBe("lost");
        expect(problemKinds(sim)).toContain("ledger_unreadable");
      });
    });

    describe("With the config file and the ledger file both lost, three managed valves, and the readable copy intact", () => {
      function lost(): Built & Readonly<{ ids: string[]; lostAt: number }> {
        const built = three();
        const lostAt = built.sim.elapsed();
        built.sim.loseConfig("lost");
        built.sim.loseLedger("lost");
        built.sim.restart();
        built.sim.step(0);
        built.sim.runTo(lostAt + HOUR_MS);
        return { ...built, lostAt };
      }

      it("no valve is written to, asked or captured again", () => {
        const { sim, ids, lostAt } = lost();
        expect(touched(sim, ids, lostAt)).toEqual([]);
        expect(sim.ledger()).toBeUndefined();
        expect(
          sim.log().filter((e) => e.effect.kind === "saveLedger" && e.at > sim.now() - HOUR_MS),
        ).toEqual([]);
      });

      it("a config naming the valves is refused with ledger_unreadable", () => {
        const { sim, config } = lost();
        const result = sim.planChange(configToRaw(config));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.refused.code).toBe("ledger_unreadable");
      });

      it("after the copy is imported and the config applied again, each valve's originals are the ones captured the first time", () => {
        const { sim, config, ids } = lost();
        const first = recordedLedger(
          ids.map((id, i) => ({ valveId: id, model: i === 1 ? "trv_zbt" : "trvzb" })),
        );
        sim.importCopy();
        const result = sim.planChange(configToRaw(config));
        expect(result.ok).toBe(true);
        for (const id of ids) {
          expect(sim.ledger()?.records.get(id)?.originals).toEqual(
            first.records.get(id)?.originals,
          );
          expect(sim.ledger()?.records.get(id)?.adoptedAt).toBe(first.records.get(id)?.adoptedAt);
        }
      });
    });
  });

  describe("simulator", () => {
    // These check the stand-ins against the device notes, so the scenarios above mean something.
    function pair(): Built & Readonly<{ a: string; b: string }> {
      const built = build({
        hold: true,
        rooms: [
          { id: "r1", valves: [[A, "trvzb"]] },
          { id: "r2", valves: [[B, "trv_zbt"]] },
        ],
      });
      return { ...built, a: valveIdOf(A), b: valveIdOf(B) };
    }

    describe("a crash after the n-th effect", () => {
      it("runs n effects, then drops the memory and the device states and reads the disk again", () => {
        const { sim } = build({
          rooms: [
            { id: "r1", valves: [[A, "trvzb"]] },
            { id: "r2", valves: [[B, "trv_zbt"]] },
          ],
        });
        const [a, b] = [valveIdOf(A), valveIdOf(B)];
        sim.crashAfterEffects(1);
        sim.step(0);
        expect(sim.log()).toHaveLength(1);
        expect(sim.memory().valves.size).toBe(0);
        expect(sim.inbox().states.get(a)?.messageAt).toBeUndefined();
        expect(sim.inbox().states.get(b)?.messageAt).toBeUndefined();
        expect(sim.config().stored).toBeDefined();
        expect(sim.ledger()?.records.size).toBe(2);
      });

      it("stays armed through a step with fewer effects", () => {
        const { sim } = build({ rooms: [{ id: "r1", valves: [[A, "trv_zbt"]] }] });
        sim.crashAfterEffects(2);
        sim.step(0);
        expect(sim.memory().valves.size).toBe(1);
        sim.step(STEP_MS);
        // The first step with two effects (the push and the days) crashes.
        expect(sim.memory().valves.size).toBe(0);
      });
    });

    describe("a lost or corrupt ledger file", () => {
      function bare(how: "lost" | "corrupt"): SimDriver {
        const { sim } = build({ rooms: [{ id: "r1", valves: [[A, "trvzb"]] }], recorded: false });
        sim.loseConfig("lost");
        sim.loseLedger(how);
        sim.restart();
        return sim;
      }

      it("is empty when it was not expected and the copy holds no record, if the file is missing", () => {
        expect(bare("lost").ledger()?.records.size).toBe(0);
      });

      it("is unreadable when the file is missing and copy files exist but none can be read", () => {
        const { sim } = build({ rooms: [{ id: "r1", valves: [[A, "trvzb"]] }], recorded: false });
        sim.loseConfig("lost");
        sim.loseLedger("lost");
        sim.corruptCopy();
        sim.restart();
        expect(sim.ledger()).toBeUndefined();
      });

      it("is unreadable when the file is corrupt, whatever else holds", () => {
        expect(bare("corrupt").ledger()).toBeUndefined();
      });
    });

    describe("a Home Assistant replay", () => {
      it("carries old tokens, so it is not a valve report", () => {
        const { sim } = build({ rooms: [{ id: "r1", valves: [[A, "trvzb"]] }] });
        const a = valveIdOf(A);
        sim.step(0);
        sim.runTo(15 * MINUTE_MS);
        const heardAt = sim.inbox().states.get(a)?.heardAt;
        const before = sim.effectsOf(a).length;
        sim.replayCache();
        sim.step(STEP_MS);
        const state = sim.inbox().states.get(a);
        expect(state?.messageAt).toBe(sim.now());
        expect(state?.heardAt).toBe(heardAt);
        expect(sim.effectsOf(a)).toHaveLength(before);
      });
    });

    describe("a TRV-ZBT day write", () => {
      it("is echoed with the old last_seen, and a fresh message with weekly_schedule_status success follows", () => {
        const { sim, b } = pair();
        const before = sim.bridge.lastSeen(b);
        sim.bridge.write(
          b,
          {
            schedule_group_to_edit: "3",
            [Z2M_DAY_PAYLOAD.mon]: desiredTexts(
              sim.world().stored?.config ?? makeConfig(),
              "r2",
              "trv_zbt",
            ).mon,
          },
          sim.now() + 1000,
        );
        const [echo, answer] = sim.bridge.drain();
        expect(echo?.kind === "message" && echo.payload.last_seen).toBe(before);
        expect(answer?.kind === "message" && answer.payload.last_seen).not.toBe(before);
        expect(answer?.kind === "message" && answer.payload.weekly_schedule_status).toBe("success");
        // The days in that answer are the previous edit group's cache, not the written ones.
        expect(answer?.kind === "message" && answer.payload[Z2M_DAY_PAYLOAD.mon]).toBe(
          factoryWeek("trv_zbt").mon,
        );
      });
    });

    describe("a get", () => {
      it("sends one message with a new token when the valve answers, and nothing when it is lost", () => {
        const { sim, a } = pair();
        sim.bridge.get(a, { temperature_sensor_select: "" }, sim.now());
        expect(sim.bridge.drain()).toHaveLength(1);
        sim.valve(a).setPolicy(() => "lose");
        sim.bridge.get(a, { temperature_sensor_select: "" }, sim.now() + 1000);
        expect(sim.bridge.drain()).toEqual([]);
      });
    });

    describe("a setpoint written in auto", () => {
      it("moves a TRVZB to heat and leaves a TRV-ZBT in auto", () => {
        const { sim, a, b } = pair();
        sim.bridge.write(a, { occupied_heating_setpoint: 18 }, sim.now());
        sim.bridge.write(b, { occupied_heating_setpoint: 18 }, sim.now());
        expect(sim.valve(a).truth().mode).toBe("heat");
        expect(sim.valve(b).truth().mode).toBe("auto");
      });
    });

    describe("a bridge restart and a replay", () => {
      it("forget the group to edit, and send the cache with the old tokens", () => {
        const { sim, a, b } = pair();
        sim.bridge.write(b, { schedule_group_to_edit: "3" }, sim.now());
        expect(sim.bridge.editGroup(b)).toBe(3);
        sim.bridge.drain();
        const tokens = [sim.bridge.lastSeen(a), sim.bridge.lastSeen(b)];
        sim.bridge.restart();
        expect(sim.bridge.editGroup(b)).toBeUndefined();
        const items = sim.bridge.drain();
        expect(items.map((i) => i.kind)).toEqual([
          "link_up",
          "bridge_restarted",
          "message",
          "message",
        ]);
        expect(items.flatMap((i) => (i.kind === "message" ? [i.payload.last_seen] : []))).toEqual(
          tokens,
        );
        sim.replayCache();
        expect(sim.bridge.drain().map((i) => i.kind)).toEqual(["message", "message"]);
      });
    });

    describe("requests that arrive while the valve sleeps", () => {
      it("are answered one by one when it wakes, and a late one lands after a later one", () => {
        const { sim, a } = pair();
        const valve = sim.valve(a);
        valve.sleep();
        sim.bridge.get(a, { temperature_sensor_select: "" }, sim.now());
        sim.bridge.get(a, { temperature_sensor_select: "" }, sim.now());
        expect(valve.queued()).toBe(2);
        valve.wake(sim.now() + 1000);
        expect(sim.bridge.drain()).toHaveLength(2);
        let first = true;
        valve.setPolicy(() => {
          const fate = first ? "late" : "land";
          first = false;
          return fate;
        });
        sim.bridge.write(a, { temperature_sensor_select: "local_temperature" }, sim.now());
        expect(valve.received().writes).toBe(0);
        sim.bridge.write(a, { temperature_sensor_select: "remote_temperature" }, sim.now());
        expect(valve.received().writes).toBe(2);
        expect(valve.truth().select).toBe("local_temperature");
      });
    });
  });

  describe("rejoin", () => {
    describe("With a valve removed and added back before its release finished", () => {
      it("its originals are the ones captured the first time", () => {
        const built = build({
          rooms: [
            {
              id: "r1",
              valves: [
                [A, "trvzb"],
                [B, "trvzb"],
              ],
            },
          ],
        });
        const { sim, config } = built;
        const id = valveIdOf(A);
        sim.step(0);
        sim.runTo(10 * MINUTE_MS);
        const first = sim.ledger()?.records.get(id);
        const without = copyOfRooms(config, [simRoom("r1", [valveIdOf(B)], [sensorRef("r1")])]);
        expect(sim.planChange(configToRaw(without)).ok).toBe(true);
        sim.runTo(sim.elapsed() + 2 * MINUTE_MS);
        expect(sim.config().stored?.releasing.has(id)).toBe(true);
        // The valve now holds the source Heatmaster restored; adding it back must not recapture.
        const back = sim.planChange(configToRaw(config));
        expect(back.ok).toBe(true);
        sim.runTo(sim.elapsed() + 20 * MINUTE_MS);
        expect(sim.ledger()?.records.get(id)).toEqual(first);
        expect(sim.config().stored?.releasing.has(id)).toBe(false);
      });
    });
  });

  describe("hooks of the fault plans", () => {
    function one(model: ValveModel = "trvzb"): Built & Readonly<{ id: string }> {
      const built = build({ rooms: [{ id: "r1", valves: [[A, model]] }] });
      return { ...built, id: valveIdOf(A) };
    }

    describe("flushLate", () => {
      it("lands the requests that were running late", () => {
        const { sim, id } = one();
        const valve = sim.valve(id);
        valve.setPolicy(() => "late");
        sim.bridge.write(id, { temperature_sensor_select: "local_temperature" }, sim.now());
        expect(valve.received().writes).toBe(0);
        valve.flushLate(sim.now());
        expect(valve.received().writes).toBe(1);
        expect(valve.truth().select).toBe("local_temperature");
      });
      it("keeps them for the wake-up when the valve sleeps", () => {
        const { sim, id } = one();
        const valve = sim.valve(id);
        valve.setPolicy(() => "late");
        sim.bridge.write(id, { temperature_sensor_select: "local_temperature" }, sim.now());
        valve.sleep();
        valve.flushLate(sim.now());
        expect(valve.received().writes).toBe(0);
        expect(valve.queued()).toBe(1);
      });
    });

    describe("a link that is down", () => {
      it("loses the messages that were sent meanwhile", () => {
        const { sim, id } = one();
        sim.runTo(MINUTE_MS);
        const before = sim.inbox().states.get(id)?.messageAt;
        sim.linkDown("z2m");
        sim.valve(id).person({ setpoint: 22 }, sim.now());
        sim.step(STEP_MS);
        expect(sim.inbox().states.get(id)?.messageAt).toBe(before);
        expect(sim.inbox().states.get(id)?.readings.setpoint).not.toBe(22);
      });
      it("is followed by a link_up that forgets the token and marks the valve", () => {
        const { sim, id } = one();
        sim.runTo(MINUTE_MS);
        sim.linkDown("z2m");
        sim.step(STEP_MS);
        sim.linkUp("z2m");
        sim.step(STEP_MS);
        expect(sim.inbox().states.get(id)?.heardAt).toBeUndefined();
        expect(sim.memory().valves.get(id)?.groups.sensor_source?.mark).toBeDefined();
      });
    });

    describe("a sensor that is pending", () => {
      it("has no value and is not judged", () => {
        const { sim } = one();
        sim.setSensor(sensorRef("r1"), { pending: true });
        expect(sim.world().sensors.get(sensorRef("r1"))).toEqual({
          sensorId: sensorRef("r1"),
          value: undefined,
          seenAt: undefined,
          pending: true,
        });
        sim.setSensor(sensorRef("r1"), { pending: false });
        expect(sim.world().sensors.get(sensorRef("r1"))?.value).toBe(20);
      });
    });

    describe("memoryAppearances", () => {
      it("counts a memory that an event created, once", () => {
        const { sim, id } = one();
        sim.step(STEP_MS);
        expect(sim.memoryAppearances().filter((a) => a.valveId === id)).toHaveLength(1);
        sim.restart();
        sim.rejoin(id);
        sim.step(STEP_MS);
        expect(sim.memoryAppearances().filter((a) => a.valveId === id)).toHaveLength(2);
      });
    });

    describe("tickWorld and deliver", () => {
      it("tickWorld is the world the last tick read, at its time", () => {
        const { sim } = one();
        sim.step(STEP_MS);
        expect(sim.tickWorld()?.now.epochMilliseconds).toBe(sim.now());
      });
      it("deliver hands over what the bridge sent, without a step", () => {
        const { sim, id } = one();
        sim.step(STEP_MS);
        sim.valve(id).person({ setpoint: 22 }, sim.now());
        expect(sim.inbox().states.get(id)?.readings.setpoint).not.toBe(22);
        sim.deliver();
        expect(sim.inbox().states.get(id)?.readings.setpoint).toBe(22);
      });
    });

    describe("crashAfterEffects in a config change", () => {
      it("cuts the join's effects after the ledger and loses the config", () => {
        const built = build({
          rooms: [{ id: "r1", valves: [[A, "trvzb"]] }],
          extra: [[B, "trvzb"]],
        });
        const { sim, config } = built;
        sim.runTo(5 * MINUTE_MS);
        sim.valve(valveIdOf(B)).person({}, sim.now());
        sim.step(STEP_MS);
        const joined = copyOfRooms(config, [
          simRoom("r1", [valveIdOf(A), valveIdOf(B)], [sensorRef("r1")]),
        ]);
        sim.crashAfterEffects(1);
        expect(sim.planChange(configToRaw(joined)).ok).toBe(true);
        const ledgerFile = sim.disk().ledger;
        expect(ledgerFile.state === "ok" && ledgerFile.ledger.records.has(valveIdOf(B))).toBe(true);
        const file = sim.disk().config;
        expect(file.state === "ok" && file.stored.config.rooms[0]?.valves).toHaveLength(1);
        expect(sim.memory().valves.size).toBe(0);
        expect(sim.log().filter((e) => e.effect.kind === "saveConfig")).toHaveLength(0);
      });
      it("stays armed while a change has fewer effects", () => {
        const built = build({ rooms: [{ id: "r1", valves: [[A, "trvzb"]] }] });
        const { sim, config } = built;
        sim.runTo(5 * MINUTE_MS);
        sim.crashAfterEffects(2);
        expect(sim.planChange(configToRaw(config)).ok).toBe(true);
        expect(sim.memory().valves.size).toBe(1);
        expect(sim.log().filter((e) => e.effect.kind === "saveConfig")).toHaveLength(1);
      });
    });

    describe("crashAfterEffects", () => {
      it("is disarmed by undefined", () => {
        const { sim } = one();
        sim.crashAfterEffects(1);
        sim.crashAfterEffects(undefined);
        sim.runTo(MINUTE_MS);
        expect(sim.memory().valves.size).toBe(1);
        expect(sim.inbox().states.size).toBe(1);
      });
    });
  });
});
