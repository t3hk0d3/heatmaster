import { describe, expect, it } from "vitest";
import {
  BUCKET,
  REFILL_MS,
  SCHEDULE,
  START_TOKENS,
  THERMOSTAT_SETTLE_MS,
  VALVE_SILENT_AFTER_MS,
  configToRaw,
  decodeDay,
  encodeDay,
} from "../../src/index.ts";
import { Z2M_DAY_PAYLOAD } from "../../src/profiles/sonoff-codec.ts";
import { entriesOf, makeConfig, membershipOf, weekOf } from "../builders.ts";
import {
  HOUR_MS,
  MINUTE_MS,
  STEP_MS,
  createSimDriver,
  desiredTexts,
  factoryValve,
  inSyncValve,
  recordedLedger,
  resolvedRooms,
  simRoom,
  valveIdOf,
} from "./driver.ts";
import { weekMissedAfterRelease, weeksMissedInRow } from "./faults.ts";
import {
  TRVZB_AUTO_TAKE_MS,
  TRVZB_WEEK_TAKE_MS,
  createSimValve,
  factoryWeek,
  reported,
} from "./valve.ts";
import type { SimDriver } from "./driver.ts";
import type {
  Config,
  Effect,
  ProblemKind,
  Room,
  Schedule,
  SetPoint,
  SettingKey,
  Thermostat,
} from "../../src/index.ts";
import type { DayTexts, SimValve, ValveModel, ValveTruth, ValveWrite } from "./valve.ts";

// Helpers ----------------------------------------------------------------------------------------

type Placed = readonly (readonly [number, ValveModel])[];
type RoomPlan = Readonly<{ id: string; valves: Placed; sensor?: boolean }>;

/** `rooms` are the rooms the house holds at the start, with their entries in `config`. */
type Built = Readonly<{ sim: SimDriver; config: Config; rooms: readonly Room[] }>;

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
    /** Options every valve is built with. */
    valve?: Readonly<{ keyLagMs?: number; clockOffsetMs?: number }>;
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
        ? { ...factoryValve(id, model), ...options.valve }
        : { ...inSyncValve(config, rooms, plan.id, id, model), ...options.valve },
    ),
    ...(options.extra ?? []).map(([n, model]) => factoryValve(valveIdOf(n), model)),
  ];
  const sim = createSimDriver({
    config,
    membership: membershipOf(rooms),
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
  return { sim, config, rooms };
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

/** The seven day texts the valve should hold for its room, as the simulator's world resolves it. */
function wantedTexts(
  sim: SimDriver,
  roomId: string,
  model: ValveModel,
): ReturnType<typeof desiredTexts> {
  const world = sim.world();
  return desiredTexts(world.stored?.config ?? makeConfig(), resolvedRooms(world), roomId, model);
}

/** The config with an entry for each of the rooms (their schedule, sensors and presets). */
function withEntries(config: Config, rooms: readonly Room[]): Config {
  return { ...config, rooms: entriesOf(rooms) };
}

/** Home Assistant now holds the rooms: the devices moved there. */
function placeIn(sim: SimDriver, rooms: readonly Room[]): void {
  sim.setMembership(membershipOf(rooms));
}

/**
 * Home Assistant now holds the rooms, and the tick right after it (no time passes) releases every
 * valve that left them all.
 */
function leaveFor(sim: SimDriver, rooms: readonly Room[]): void {
  placeIn(sim, rooms);
  sim.step(0);
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

/** A set point at a time of day with a temperature. */
function at(time: string, temperature: number): SetPoint {
  return { time: Temporal.PlainTime.from(time), preset: undefined, temperature };
}

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
        expect(truth.schedules[3]).toEqual(wantedTexts(sim, "r2", "trv_zbt"));
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

  // The tick joins a valve that Home Assistant puts in a room; the document only gives the room
  // its entry.
  describe("join", () => {
    /** Home Assistant puts the valve in the new area `new`; the document gets its entry. */
    function joinNew(built: Built, valveId: string): Config {
      const rooms = [...built.rooms, simRoom("new", [valveId], [sensorRef("new")])];
      const next = withEntries(built.config, rooms);
      placeIn(built.sim, rooms);
      expect(built.sim.planChange(configToRaw(next)).ok).toBe(true);
      return next;
    }

    describe("With a new valve that has sent no message since the start", () => {
      function start(): Built & Readonly<{ n: string }> {
        const built = build({
          rooms: [{ id: "r1", valves: [[A, "trvzb"]] }],
          extra: [[3, "trvzb"]],
          extraSensors: [sensorRef("new")],
        });
        const n = valveIdOf(3);
        built.sim.step(0);
        joinNew(built, n);
        return { ...built, n };
      }

      it("it is not joined, and the tick asks the valve to report", () => {
        const { sim, n } = start();
        sim.step(STEP_MS);
        expect(sim.ledger()?.records.has(n)).toBe(false);
        expect(sim.valve(n).received().reads).toBe(1);
      });

      it("it joins at the step after it reported", () => {
        const { sim, n } = start();
        sim.step(STEP_MS);
        sim.step(STEP_MS);
        expect(sim.ledger()?.records.has(n)).toBe(true);
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
        const rooms = [...built.rooms, simRoom("new", [n], [sensorRef("new")])];
        // Its days already equal the new room's: the same default week.
        built.sim.valve(n).setup({
          days: { group: 1, texts: desiredTexts(built.config, rooms, "new", "trvzb") },
        });
        built.sim.step(0);
        built.sim.step(STEP_MS);
        joinNew(built, n);
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
        built.sim.step(0);
        built.sim.step(STEP_MS);
        joinNew(built, n);
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
        expect(truth.schedules[3]).toEqual(wantedTexts(sim, "new", "trv_zbt"));
      });
    });

    describe("With a new TRV-ZBT whose active group is already 3", () => {
      function joined(): Built & Readonly<{ n: string }> {
        const built = build({
          rooms: [{ id: "r1", valves: [[A, "trvzb"]] }],
          extra: [[3, "trv_zbt"]],
          extraSensors: [sensorRef("new")],
        });
        const n = valveIdOf(3);
        built.sim.valve(n).setup({ activeGroup: 3 });
        built.sim.step(0);
        built.sim.step(STEP_MS);
        joinNew(built, n);
        built.sim.runTo(built.sim.elapsed() + 20 * MINUTE_MS);
        return { ...built, n };
      }

      it("it joins, its record's original active group is 3, and its group 3 holds the room's days", () => {
        const { sim, n } = joined();
        expect(sim.ledger()?.records.get(n)?.originals.active_group).toBe(3);
        expect(sim.valve(n).truth().schedules[3]).toEqual(wantedTexts(sim, "new", "trv_zbt"));
      });

      it("the active group is never written, also not on release", () => {
        const { sim, n, rooms } = joined();
        placeIn(sim, rooms);
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
        const { sim } = run(23 * HOUR_MS);
        const id = valveIdOf(A);
        expect(published(sim, id)).toHaveLength(1);
        expect(sim.bridge.cache(id)[Z2M_DAY_PAYLOAD.mon]).toBe(wantedTexts(sim, "r1", "trvzb").mon);
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
        const { sim } = run(27 * HOUR_MS);
        expect(sim.valve(valveIdOf(A)).truth().schedules[1]).toEqual(
          wantedTexts(sim, "r1", "trvzb"),
        );
      });
    });
  });

  describe("late write", () => {
    describe("With a write queued while the valve sleeps, and the valve then removed from its room", () => {
      it("the release does not finish until the queued write has landed and been undone", () => {
        const { sim } = build({
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
        leaveFor(sim, [simRoom("r1", [valveIdOf(B)], [sensorRef("r1")])]);
        expect(sim.config().stored?.releasing.has(id)).toBe(true);
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
    function released(): Built & Readonly<{ id: string; removedAt: number }> {
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
      leaveFor(built.sim, [simRoom("r1", [valveIdOf(B)], [sensorRef("r1")])]);
      return { ...built, id: valveIdOf(A), removedAt: built.sim.elapsed() };
    }

    describe("With a TRVZB removed from its room", () => {
      it("its original sensor source is published and its days are left as they are", () => {
        const { sim, id, removedAt } = released();
        const daysBefore = sim.valve(id).truth().schedules[1];
        sim.runTo(removedAt + 25 * MINUTE_MS);
        // The release is ordered, and its first write sent, by the tick at removedAt.
        const writes = published(sim, id).filter((p) => p.at * 1000 >= removedAt);
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
        expect(sim.valve(id).truth().schedules[1]).toEqual(wantedTexts(sim, "r1", "trvzb"));
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
        const { sim } = build({ rooms: [{ id: "r1", valves: [[A, "trvzb"]] }] });
        const id = valveIdOf(A);
        sim.step(0);
        sim.runTo(15 * MINUTE_MS);
        const before = published(sim, id).length;
        const person = "00:00/10 06:00/21 12:00/10 12:00/10 12:00/10 12:00/10";
        sim.personWrites(id, { [Z2M_DAY_PAYLOAD.mon]: person });
        sim.runTo(40 * MINUTE_MS);
        const fresh = published(sim, id).slice(before);
        expect(fresh.map((p) => p.keys)).toEqual([["day_mon"]]);
        expect(sim.valve(id).truth().schedules[1]).toEqual(wantedTexts(sim, "r1", "trvzb"));
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
        const { sim, id, person } = run(27 * HOUR_MS);
        const writes = sim.effectsOf(id, "publish").filter((e) => e.at > 15 * MINUTE_MS);
        expect(writes.length).toBeGreaterThan(0);
        expect(sim.bridge.editGroup(id)).toBe(3);
        expect(sim.valve(id).truth().schedules[1]?.mon).toBe(person);
        expect(sim.valve(id).truth().schedules[3]).toEqual(wantedTexts(sim, "r1", "trv_zbt"));
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

      it("applying the config again joins nothing: every valve is pending with ledger_unreadable", () => {
        const { sim, config, ids } = lost();
        const result = sim.planChange(configToRaw(config));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.plan.joining).toEqual([]);
        expect(result.plan.pending.map((p) => [p.valveId, p.reason])).toEqual(
          [...ids].sort().map((id) => [id, "ledger_unreadable"]),
        );
        sim.step(STEP_MS);
        expect(sim.ledger()).toBeUndefined();
        expect(
          sim.log().filter((e) => e.effect.kind === "saveLedger" && e.at > sim.now() - HOUR_MS),
        ).toEqual([]);
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

  describe("room thermostat", () => {
    const [a, b] = [valveIdOf(A), valveIdOf(B)];
    const SECOND = 1000;
    const BOTH: Placed = [
      [A, "trvzb"],
      [B, "trv_zbt"],
    ];

    /** Room `r1` holding the valves, in sync, run for an hour from the builders' Monday noon. */
    function settledRoom(
      valves: Placed,
      options: Readonly<{ keyLagMs?: number; clockOffsetMs?: number }> = {},
    ): SimDriver {
      const { sim } = build({ rooms: [{ id: "r1", valves }], valve: options });
      sim.step(0);
      sim.runTo(HOUR_MS);
      return sim;
    }

    /** The room's saved thermostat. */
    function roomState(sim: SimDriver): Thermostat {
      return sim.thermostats().rooms.get("r1") ?? SCHEDULE;
    }

    /** Runs `ms` more in steps of `stepMs`. */
    function runFor(sim: SimDriver, ms: number, stepMs = STEP_MS): void {
      sim.runTo(sim.elapsed() + ms, stepMs);
    }

    /** Every room state saved since `fromMs` (time since the start). */
    function savedRooms(sim: SimDriver, fromMs: number): readonly (Thermostat | undefined)[] {
      const startMs = sim.now() - sim.elapsed();
      return sim
        .log()
        .filter(({ at }) => at - startMs >= fromMs)
        .flatMap(({ effect }) =>
          effect.kind === "saveThermostats" ? [effect.state.rooms.get("r1")] : [],
        );
    }

    /** The thermostat publishes to the valve, with their time since the start in ms. */
    function thermostatPublishes(sim: SimDriver, valveId: string) {
      return sim
        .effectsOf(valveId, "publish")
        .filter(
          (e) =>
            e.effect.kind === "publish" &&
            ("system_mode" in e.effect.values || "setpoint" in e.effect.values),
        );
    }

    describe("A knob turned on the TRVZB in a two-valve room", () => {
      it("the TRV-ZBT follows within one tick after the settle", () => {
        const sim = settledRoom(BOTH);
        // The first click enters heat at the last manual 17, two more make 18 (M11).
        sim.valve(a).knob(3, sim.now());
        const step = 5 * SECOND;
        sim.step(step);
        const adopted = roomState(sim);
        expect(adopted).toMatchObject({ kind: "override", target: 18, origin: { valveId: a } });
        const sinceMs =
          adopted.kind === "override" ? adopted.since - (sim.now() - sim.elapsed()) : 0;
        runFor(sim, MINUTE_MS, step);
        const [first] = thermostatPublishes(sim, b).filter((e) => e.at >= sinceMs);
        expect(first?.effect).toMatchObject({ values: { system_mode: "heat", setpoint: 18 } });
        expect(first?.at).toBeGreaterThanOrEqual(sinceMs + THERMOSTAT_SETTLE_MS);
        expect(first?.at).toBeLessThan(sinceMs + THERMOSTAT_SETTLE_MS + step);
        expect(sim.valve(b).truth()).toMatchObject({ mode: "heat", setpoint: 18 });
      });
    });

    describe("Two valves, an override cancelled while writes are in flight", () => {
      it("the room stays on its schedule and both valves end in auto", () => {
        const sim = settledRoom(BOTH);
        sim.command("r1", { kind: "set_target", celsius: 22, end: undefined });
        // One-second steps, so every half-applied state is seen.
        runFor(sim, THERMOSTAT_SETTLE_MS + SECOND, SECOND);
        expect(thermostatPublishes(sim, a).length).toBeGreaterThan(0);
        runFor(sim, SECOND, SECOND);
        sim.command("r1", { kind: "resume" });
        const resumedAt = sim.elapsed();
        runFor(sim, 10 * MINUTE_MS, SECOND);
        expect(savedRooms(sim, resumedAt)).not.toContainEqual(expect.anything());
        expect(roomState(sim)).toEqual(SCHEDULE);
        expect(sim.valve(a).truth().mode).toBe("auto");
        expect(sim.valve(b).truth().mode).toBe("auto");
      });
    });

    describe("A schedule picked in Home Assistant for a room with a TRVZB", () => {
      it("no override is made and the TRVZB stays in auto", () => {
        const { sim, config } = build({ rooms: [{ id: "r1", valves: [[A, "trvzb"]] }] });
        const evening: Schedule = {
          id: "evening",
          name: "Evening",
          defaultWeek: weekOf([at("00:00", 16), at("07:00", 21), at("23:00", 16)]),
        };
        sim.step(0);
        sim.runTo(HOUR_MS);
        const planned = sim.planChange(
          configToRaw({ ...config, schedules: [...config.schedules, evening] }),
        );
        expect(planned.ok).toBe(true);
        runFor(sim, 10 * MINUTE_MS);
        const pickedAt = sim.elapsed();
        sim.choose("r1", { kind: "schedule", scheduleId: "evening" });
        runFor(sim, 30 * MINUTE_MS, 5 * SECOND);
        expect(savedRooms(sim, pickedAt)).not.toContainEqual(expect.anything());
        // The TRVZB takes the new week's 21 by itself, about 20 s after the day write (M1).
        expect(sim.valve(a).truth()).toMatchObject({ mode: "auto", setpoint: 21 });
      });
    });

    describe("A daily schedule re-check during a timed TRV-ZBT override", () => {
      it("the override is kept", () => {
        const sim = settledRoom([[B, "trv_zbt"]]);
        const end = { rule: "timer", durationMs: 30 * HOUR_MS } as const;
        sim.command("r1", { kind: "set_target", celsius: 23, end });
        const made = roomState(sim);
        runFor(sim, 25 * HOUR_MS, MINUTE_MS);
        expect(roomState(sim)).toEqual(made);
        expect(sim.valve(b).truth()).toMatchObject({ mode: "heat", setpoint: 23 });
      });
    });

    describe("A TRV-ZBT joining in auto with a hand-set value off its week", () => {
      it("nothing is adopted and it ends on its schedule", () => {
        const { sim } = build({
          rooms: [{ id: "r1", valves: [[B, "trv_zbt"]] }],
          outOfSync: true,
          recorded: false,
        });
        sim.valve(b).setup({ setpoint: 23.5 });
        sim.step(0);
        sim.runTo(2 * HOUR_MS);
        expect(savedRooms(sim, 0)).not.toContainEqual(expect.anything());
        const truth = sim.valve(b).truth();
        expect(truth.mode).toBe("auto");
        expect(truth.activeGroup).toBe(3);
        // The builder day holds 20 from 06:30 to 22:00.
        expect(truth.setpoint).toBe(20);
      });
    });

    describe("A boost from Home Assistant with each key reported in its own message", () => {
      it("the room's override keeps its preset, rule and origin", () => {
        const sim = settledRoom(BOTH, { keyLagMs: 5 * SECOND });
        const climate = { source: "climate", valveId: undefined } as const;
        sim.command("r1", { kind: "set_preset", preset: "boost", end: undefined }, climate);
        const made = roomState(sim);
        runFor(sim, 2 * MINUTE_MS, SECOND);
        expect(roomState(sim)).toEqual(made);
        expect(made).toMatchObject({ kind: "override", preset: "boost", rule: "timer" });
        const target = made.kind === "override" ? made.target : undefined;
        expect(sim.valve(a).truth()).toMatchObject({ mode: "heat", setpoint: target });
        expect(sim.valve(b).truth()).toMatchObject({ mode: "heat", setpoint: target });
      });
    });

    describe("A knob turned while Home Assistant is down", () => {
      it("the knob's value becomes the room's override", () => {
        const sim = settledRoom(BOTH);
        sim.linkDown("ha");
        sim.valve(a).knob(3, sim.now());
        runFor(sim, 2 * MINUTE_MS, 5 * SECOND);
        expect(roomState(sim)).toMatchObject({ kind: "override", target: 18 });
        expect(sim.valve(b).truth()).toMatchObject({ mode: "heat", setpoint: 18 });
      });
    });

    describe("Heatmaster restarted during an override", () => {
      it("the override is kept and ends on time", () => {
        const sim = settledRoom(BOTH);
        const end = { rule: "timer", durationMs: HOUR_MS } as const;
        sim.command("r1", { kind: "set_target", celsius: 22, end });
        const made = roomState(sim);
        const endsAt = made.kind === "override" ? (made.endsAt ?? 0) : 0;
        runFor(sim, 10 * MINUTE_MS);
        sim.restart();
        while (sim.now() + STEP_MS < endsAt) sim.step(STEP_MS);
        expect(roomState(sim)).toEqual(made);
        expect(sim.valve(a).truth()).toMatchObject({ mode: "heat", setpoint: 22 });
        runFor(sim, 10 * MINUTE_MS);
        expect(roomState(sim)).toEqual(SCHEDULE);
        expect(sim.valve(a).truth().mode).toBe("auto");
        expect(sim.valve(b).truth().mode).toBe("auto");
      });
    });

    describe("Heatmaster restarted after an override ended", () => {
      it("nothing is adopted and the valves return to auto", () => {
        const sim = settledRoom(BOTH);
        const end = { rule: "timer", durationMs: 30 * MINUTE_MS } as const;
        sim.command("r1", { kind: "set_target", celsius: 22, end });
        runFor(sim, 29 * MINUTE_MS);
        expect(sim.valve(a).truth()).toMatchObject({ mode: "heat", setpoint: 22 });
        // Heatmaster is down across the end: its first tick is 10 min later.
        sim.restart();
        const startedAt = sim.elapsed();
        sim.step(10 * MINUTE_MS);
        runFor(sim, 20 * MINUTE_MS);
        expect(savedRooms(sim, startedAt)).not.toContainEqual(expect.anything());
        expect(roomState(sim)).toEqual(SCHEDULE);
        expect(sim.valve(a).truth().mode).toBe("auto");
        expect(sim.valve(b).truth().mode).toBe("auto");
      });
    });

    describe("A knob turned while Heatmaster was down, on each model", () => {
      it("the knob's value becomes the room's override and is not overwritten", () => {
        // The TRVZB enters heat at 17 and goes to 19; the TRV-ZBT holds 17 + 2.5 in auto.
        for (const [valveId, value] of [
          [a, 19],
          [b, 19.5],
        ] as const) {
          const sim = settledRoom(BOTH);
          sim.whileDown(() => {
            sim.valve(valveId).knob(5, sim.now());
          });
          sim.step(0);
          runFor(sim, 30 * MINUTE_MS);
          expect(roomState(sim)).toMatchObject({
            kind: "override",
            target: value,
            origin: { source: "valve", valveId },
          });
          expect(sim.valve(a).truth()).toMatchObject({ mode: "heat", setpoint: value });
          expect(sim.valve(b).truth()).toMatchObject({ mode: "heat", setpoint: value });
        }
      });
    });

    describe("A TRV-ZBT override held while writes are held, across a restart", () => {
      it("the override is kept until its end and the valve's own point is not adopted", () => {
        // At its clock, and with its clock 90 s ahead: it then takes 22:00's 17 at 21:58:30.
        for (const clockOffsetMs of [0, 90 * SECOND]) {
          const sim = settledRoom([[B, "trv_zbt"]], { clockOffsetMs });
          const config = sim.config().stored?.config;
          if (config === undefined) throw new Error("no config");
          // The knob holds 16.5 (17 - 0.5) in auto; writes are held before its heat write goes out.
          sim.valve(b).knob(-1, sim.now());
          sim.step(5 * SECOND);
          const adopted = roomState(sim);
          expect(adopted).toMatchObject({ kind: "override", target: 16.5 });
          const held = { ...config, settings: { ...config.settings, holdWrites: true } };
          expect(sim.planChange(configToRaw(held)).ok).toBe(true);
          sim.restart();
          const restartedAt = sim.elapsed();
          const endsAt = adopted.kind === "override" ? (adopted.endsAt ?? 0) : 0;
          while (sim.now() + STEP_MS <= endsAt) {
            sim.step(STEP_MS);
            expect(roomState(sim)).toEqual(adopted);
          }
          runFor(sim, 30 * MINUTE_MS);
          expect(sim.valve(b).truth()).toMatchObject({ mode: "auto", setpoint: 17 });
          const saved = savedRooms(sim, restartedAt).filter((t) => t !== undefined);
          expect(saved.filter((t) => t !== adopted)).toEqual([]);
          expect(roomState(sim)).toEqual(SCHEDULE);
        }
      });
    });

    describe("A write confirmed by its echo in the same second as the valve's last message (M14)", () => {
      it("it is confirmed without an ask", () => {
        const sim = settledRoom([[A, "trvzb"]]);
        const step = SECOND / 2;
        sim.step(step);
        sim.command("r1", { kind: "off", end: undefined });
        for (let i = 0; i < 18; i++) sim.step(step);
        // The valve speaks at a whole second; the write goes out half a second later, and the
        // valve's messages after it carry the same `last_seen`.
        sim.atNextStep(() => {
          sim.valve(a).person({}, sim.now());
        });
        sim.step(step);
        sim.step(step);
        const [write] = thermostatPublishes(sim, a).slice(-1);
        expect(write?.effect).toMatchObject({ values: { system_mode: "off" } });
        expect((write?.at ?? 0) % SECOND).toBe(step);
        sim.step(step);
        expect(sim.thermostats().valves.get(a)).toMatchObject({
          confirmed: { mode: "off" },
          sent: [],
        });
        const writtenAt = write?.at ?? 0;
        runFor(sim, 2 * MINUTE_MS, 5 * SECOND);
        expect(times(sim, a, "refresh").filter((t) => t * 1000 > writtenAt)).toEqual([]);
      });
    });

    describe("A knob turned while Heatmaster was down on a TRV-ZBT that never left its schedule since the first start", () => {
      it("the knob's value becomes the room's override and is not overwritten", () => {
        const sim = settledRoom([[B, "trv_zbt"]]);
        runFor(sim, HOUR_MS);
        // It saved its week once confirmed (R22 c), so the week is known after the restart.
        expect(sim.thermostats().valves.get(b)?.week).toBeDefined();
        sim.whileDown(() => {
          sim.valve(b).knob(5, sim.now());
        });
        sim.step(0);
        runFor(sim, 30 * MINUTE_MS);
        expect(roomState(sim)).toMatchObject({ kind: "override", target: 19.5 });
        expect(sim.valve(b).truth()).toMatchObject({ mode: "heat", setpoint: 19.5 });
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
        // The first step has two effects: the ask and the state save of the take-over.
        sim.crashAfterEffects(3);
        sim.step(0);
        expect(sim.memory().valves.size).toBe(1);
        sim.step(STEP_MS);
        // The first step with three effects (the push, the days and the state save) crashes.
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
            [Z2M_DAY_PAYLOAD.mon]: wantedTexts(sim, "r2", "trv_zbt").mon,
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

    describe("sim valve", () => {
      /** The payload of the last message the bridge handed over for the valve. */
      const lastPayload = (sim: SimDriver, valveId: string): Readonly<Record<string, unknown>> => {
        const messages = sim.bridge
          .drain()
          .flatMap((item) => (item.kind === "message" && item.deviceId === valveId ? [item] : []));
        return messages.at(-1)?.payload ?? {};
      };
      describe("With a TRVZB in auto written setpoint 22", () => {
        it("it reports system_mode heat and setpoint 22", () => {
          const { sim, a } = pair();
          sim.bridge.drain();
          sim.bridge.write(a, { occupied_heating_setpoint: 22 }, sim.now());
          expect(lastPayload(sim, a)).toMatchObject({
            system_mode: "heat",
            occupied_heating_setpoint: 22,
          });
        });
      });
      describe("With a TRV-ZBT in auto written setpoint 22", () => {
        it("it reports system_mode auto and setpoint 22", () => {
          const { sim, b } = pair();
          sim.bridge.drain();
          sim.bridge.write(b, { occupied_heating_setpoint: 22 }, sim.now());
          expect(lastPayload(sim, b)).toMatchObject({
            system_mode: "auto",
            occupied_heating_setpoint: 22,
          });
        });
      });
      /** Noon on the builders' Monday. */
      const NOON_MS = Temporal.ZonedDateTime.from(
        "2026-11-16T12:00:00+01:00[Europe/Amsterdam]",
      ).epochMilliseconds;
      /** The same day on every weekday, as the model's day texts. */
      const everyDay = (model: ValveModel, day: string): DayTexts => {
        const points = decodeDay(day);
        if (points === null) throw new Error(`bad day ${day}`);
        const text = encodeDay(points, model === "trvzb" ? 6 : 12);
        return { mon: text, tue: text, wed: text, thu: text, fri: text, sat: text, sun: text };
      };
      /** A valve built alone at noon, running `day`, with every report it makes. */
      const alone = (
        model: ValveModel,
        day: string,
        truth: Readonly<{ mode: ValveTruth["mode"]; setpoint: number }>,
      ): Readonly<{
        valve: SimValve;
        reports: Readonly<{ at: number; payload: Record<string, unknown> }>[];
      }> => {
        const reports: { at: number; payload: Record<string, unknown> }[] = [];
        const group = model === "trvzb" ? 1 : 3;
        const valve: SimValve = createSimValve({
          model,
          nowMs: NOON_MS,
          schedules: { [group]: everyDay(model, day) },
          activeGroup: group,
          ...truth,
          selfReports: false,
          onSpeak: (_speech, at) => {
            reports.push({ at, payload: reported(model, valve.truth()) });
          },
        });
        return { valve, reports };
      };
      const write = (over: Partial<ValveWrite>): ValveWrite => ({
        days: undefined,
        activeGroup: undefined,
        select: undefined,
        frostProtection: undefined,
        mode: undefined,
        setpoint: undefined,
        external: undefined,
        ...over,
      });
      describe("With a TRV-ZBT holding 22 in auto reaching a point of 19", () => {
        it("it reports auto 19", () => {
          const { valve, reports } = alone("trv_zbt", "00:00/17 12:30/19", {
            mode: "auto",
            setpoint: 22,
          });
          valve.advance(NOON_MS + 20 * MINUTE_MS);
          expect(reports).toEqual([]);
          valve.advance(NOON_MS + 30 * MINUTE_MS);
          expect(reports.at(-1)?.payload).toMatchObject({
            system_mode: "auto",
            occupied_heating_setpoint: 19,
          });
        });
      });
      describe("With a TRV-ZBT written auto while in heat 22", () => {
        it("it reports auto and the value in force at once", () => {
          const { valve, reports } = alone("trv_zbt", "00:00/17 09:00/19", {
            mode: "heat",
            setpoint: 22,
          });
          valve.receive({ kind: "write", write: write({ mode: "auto" }) }, NOON_MS);
          // The valve's first message still shows heat 22; the echo shows the new state (M14).
          expect(reports).toHaveLength(2);
          expect(reports[1]).toMatchObject({
            at: NOON_MS,
            payload: { system_mode: "auto", occupied_heating_setpoint: 19 },
          });
        });
      });
      describe("With a TRVZB written auto while in heat 22", () => {
        it("its echo shows auto 22, and the schedule's value after the measured delay", () => {
          const { valve, reports } = alone("trvzb", "00:00/17 09:00/19", {
            mode: "heat",
            setpoint: 22,
          });
          valve.receive({ kind: "write", write: write({ mode: "auto" }) }, NOON_MS);
          expect(reports.at(-1)?.payload).toMatchObject({
            system_mode: "auto",
            occupied_heating_setpoint: 22,
          });
          valve.advance(NOON_MS + TRVZB_AUTO_TAKE_MS);
          expect(reports.at(-1)).toMatchObject({
            at: NOON_MS + TRVZB_AUTO_TAKE_MS,
            payload: { system_mode: "auto", occupied_heating_setpoint: 19 },
          });
        });
      });
      describe("With a TRVZB in auto written a week whose value in force is 21", () => {
        it("it shows auto 21 about 20 s after the day write", () => {
          const { valve, reports } = alone("trvzb", "00:00/17", { mode: "auto", setpoint: 17 });
          const texts = everyDay("trvzb", "00:00/17 09:00/21");
          valve.receive({ kind: "write", write: write({ days: { group: 1, texts } }) }, NOON_MS);
          valve.advance(NOON_MS + TRVZB_WEEK_TAKE_MS - 1000);
          expect(valve.truth().setpoint).toBe(17);
          valve.advance(NOON_MS + TRVZB_WEEK_TAKE_MS);
          expect(TRVZB_WEEK_TAKE_MS).toBe(20 * 1000);
          expect(reports.at(-1)).toMatchObject({
            at: NOON_MS + TRVZB_WEEK_TAKE_MS,
            payload: { system_mode: "auto", occupied_heating_setpoint: 21 },
          });
        });
      });
      describe("By default", () => {
        it("reported() carries frost_protection_temperature", () => {
          const { sim, a, b } = pair();
          for (const id of [a, b]) {
            const valve = sim.valve(id);
            expect(reported(valve.model, valve.truth())).toHaveProperty(
              "frost_protection_temperature",
              valve.truth().frostProtection,
            );
          }
        });
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
        const { sim, rooms } = built;
        const id = valveIdOf(A);
        sim.step(0);
        sim.runTo(10 * MINUTE_MS);
        const first = sim.ledger()?.records.get(id);
        leaveFor(sim, [simRoom("r1", [valveIdOf(B)], [sensorRef("r1")])]);
        sim.runTo(sim.elapsed() + 2 * MINUTE_MS);
        expect(sim.config().stored?.releasing.has(id)).toBe(true);
        // The valve now holds the source Heatmaster restored; adding it back must not recapture.
        placeIn(sim, rooms);
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

    /**
     * Schedule writes to the TRV-ZBT, one word each: its week's letter, then `m` missed or `l`
     * landed; a leading `r` marks the first write after a release.
     */
    const writes = (text: string) =>
      text.split(" ").map((w) => ({
        week: w.replace(/^r/, "").slice(0, 1),
        missed: w.endsWith("m"),
        afterRelease: w.startsWith("r"),
      }));

    describe("weeksMissedInRow", () => {
      it("is false for single missed weeks between landed writes", () => {
        expect(weeksMissedInRow(writes("Al Bm Bl Cm Cl"))).toBe(false);
      });
      it("is false for one week missed several times in a row", () => {
        expect(weeksMissedInRow(writes("Al Bm Bm Bm"))).toBe(false);
      });
      it("is true once two different weeks missed in a row", () => {
        expect(weeksMissedInRow(writes("Al Bm Cm Cl"))).toBe(true);
      });
    });

    describe("weekMissedAfterRelease", () => {
      it("is false when the first write after a release landed", () => {
        expect(weekMissedAfterRelease(writes("Al rBl Cm"))).toBe(false);
      });
      it("is true when the first write after a release missed", () => {
        expect(weekMissedAfterRelease(writes("Al rBm Bl"))).toBe(true);
      });
    });

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
      it("with a filter, lands only the requests it names and keeps the others late", () => {
        const { sim, id } = one();
        const valve = sim.valve(id);
        valve.setPolicy(() => "late");
        sim.bridge.write(id, { temperature_sensor_select: "local_temperature" }, sim.now());
        sim.bridge.write(id, { frost_protection_temperature: 9 }, sim.now());
        valve.flushLate(sim.now(), (request) =>
          request.kind === "write" ? request.write.frostProtection !== undefined : false,
        );
        expect(valve.received().writes).toBe(1);
        expect(valve.truth().frostProtection).toBe(9);
        expect(valve.queued()).toBe(1);
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
      it("cuts the effects of the tick that joins a valve after the ledger", () => {
        const built = build({
          rooms: [{ id: "r1", valves: [[A, "trvzb"]] }],
          extra: [[B, "trvzb"]],
        });
        const { sim } = built;
        sim.runTo(5 * MINUTE_MS);
        const savedConfigs = sim.log().filter((e) => e.effect.kind === "saveConfig").length;
        placeIn(sim, [simRoom("r1", [valveIdOf(A), valveIdOf(B)], [sensorRef("r1")])]);
        sim.valve(valveIdOf(B)).person({}, sim.now());
        sim.deliver();
        sim.crashAfterEffects(1);
        sim.step(0);
        const ledgerFile = sim.disk().ledger;
        expect(ledgerFile.state === "ok" && ledgerFile.ledger.records.has(valveIdOf(B))).toBe(true);
        expect(sim.copy()?.records.has(valveIdOf(B))).toBe(false);
        expect(sim.memory().valves.size).toBe(0);
        // The membership save that followed the join was cut too.
        expect(sim.log().filter((e) => e.effect.kind === "saveConfig")).toHaveLength(savedConfigs);
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
