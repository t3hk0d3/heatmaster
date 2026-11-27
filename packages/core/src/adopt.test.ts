import { describe, expect, it } from "vitest";
import {
  BUILDER_DAY,
  BUILDER_ROOM,
  BUILDER_VALVE,
  makeExpectation,
  makeOpening,
  makeSpec,
  makeThermostat,
} from "../test/builders.ts";
import { adopt, clampThermostatState, withWeek, withWritten } from "./adopt.ts";
import type { AdoptInput, Adoption, JudgedValve } from "./adopt.ts";
import { DEFAULT_WINDOW_SETTINGS, DEFAULT_SETTINGS } from "./model.ts";
import type { Room } from "./model.ts";
import type { ResolvedWeek } from "./schedule.ts";
import type { ValveMode } from "./settings.ts";
import type { AdapterContext } from "./thermostat-adapter.ts";
import { SCHEDULE, defaultEnd, endsAt } from "./thermostat-rules.ts";
import type {
  RoomLimits,
  SavedWeek,
  SentWrite,
  Thermostat,
  ThermostatSeen,
  ThermostatState,
  ThermostatWanted,
  ValveExpectation,
} from "./thermostat.ts";

const V = BUILDER_VALVE;
const V2 = "z2m:0x00124b0000000002";
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** A Monday in Amsterdam at the given wall time (`HH:MM` or `HH:MM:SS`). */
function monday(time: string): Temporal.ZonedDateTime {
  const full = time.length === 5 ? `${time}:00` : time;
  return Temporal.ZonedDateTime.from(`2026-11-16T${full}+01:00[Europe/Amsterdam]`);
}

/** The instant of a wall time on that Monday, in epoch ms. */
function at(time: string): number {
  return monday(time).epochMilliseconds;
}

const NOW = monday("10:00:00");
const WEEK: ResolvedWeek = {
  mon: BUILDER_DAY,
  tue: BUILDER_DAY,
  wed: BUILDER_DAY,
  thu: BUILDER_DAY,
  fri: BUILDER_DAY,
  sat: BUILDER_DAY,
  sun: BUILDER_DAY,
};
const TRVZB = makeSpec("trvzb");
const ZBT = makeSpec("trv_zbt");
const ROOM_LIMITS: RoomLimits = { min: 5, max: 30 };

const ROOM: Room = {
  id: BUILDER_ROOM,
  name: "Living room",
  scheduleId: "default",
  valves: [{ valveId: V }, { valveId: V2 }],
  sensors: [],
  presets: { comfort: undefined, eco: undefined, frost: undefined, boost: undefined },
  overrideEnd: DEFAULT_SETTINGS.overrideEnd,
  overrideDurationMs: DEFAULT_SETTINGS.overrideDurationMs,
  contacts: [],
  window: DEFAULT_WINDOW_SETTINGS,
};

// States ------------------------------------------------------------------------------------------

const AUTO: ThermostatWanted = { mode: "auto", setpoint: undefined, scheduled: true };
const OFF: ThermostatWanted = { mode: "off", setpoint: undefined, scheduled: false };

function heat(setpoint: number): ThermostatWanted {
  return { mode: "heat", setpoint, scheduled: false };
}

/** A scheduled `auto` state holding a recorded setpoint. */
function autoAt(setpoint: number): ThermostatWanted {
  return { mode: "auto", setpoint, scheduled: true };
}

/** An `auto` state adopted from a person: not scheduled. */
function adoptedAuto(setpoint: number): ThermostatWanted {
  return { mode: "auto", setpoint, scheduled: false };
}

function seen(mode: ValveMode | undefined, setpoint?: number): ThermostatSeen {
  return { mode, setpoint };
}

function sent(wanted: ThermostatWanted, atMs: number, from: ThermostatSeen): SentWrite {
  return { wanted, at: atMs, from };
}

// Adapter contexts -------------------------------------------------------------------------------

const NO_WEEK: AdapterContext = {
  inForce: undefined,
  weekValues: undefined,
  pointValues: undefined,
};

/** A confirmed week of these values; `points` are the values in force near the report. */
function weekCtx(values: readonly number[], points?: readonly number[]): AdapterContext {
  return {
    inForce: undefined,
    weekValues: new Set(values),
    pointValues: points === undefined ? undefined : new Set(points),
  };
}

/** A week known only from the expectation's saved week: no value in force, no points. */
function savedCtx(values: readonly number[]): AdapterContext {
  return { inForce: undefined, weekValues: new Set(values), pointValues: undefined };
}

// Inputs -----------------------------------------------------------------------------------------

function valve(options: {
  valveId?: string;
  model?: "trvzb" | "trv_zbt";
  shows: ThermostatSeen;
  heardAt?: number | undefined;
  expectation?: ValveExpectation | undefined;
  ctx?: AdapterContext;
  week?: SavedWeek | undefined;
  previousPoints?: readonly number[];
}): JudgedValve {
  return {
    valveId: options.valveId ?? V,
    spec: options.model === "trv_zbt" ? ZBT : TRVZB,
    seen: options.shows,
    heardAt: "heardAt" in options ? options.heardAt : at("10:00:30"),
    expectation:
      "expectation" in options ? options.expectation : makeExpectation({ confirmed: AUTO }),
    ctx: options.ctx ?? NO_WEEK,
    week: options.week,
    previousPoints:
      options.previousPoints === undefined ? undefined : new Set(options.previousPoints),
  };
}

function input(
  valves: readonly JudgedValve[],
  thermostat: Thermostat = SCHEDULE,
  options: { limits?: RoomLimits; now?: Temporal.ZonedDateTime } = {},
): AdoptInput {
  return {
    room: ROOM,
    thermostat,
    valves,
    limits: options.limits ?? ROOM_LIMITS,
    week: WEEK,
    now: options.now ?? NOW,
  };
}

function expectationOf(adoption: Adoption, valveId = V): ValveExpectation | undefined {
  return adoption.expectations.get(valveId);
}

/** The override (or off) a person's change at `now` makes, with the room's default end. */
function byValve(
  target: number | "off",
  valveId = V,
  now: Temporal.ZonedDateTime = NOW,
): Thermostat {
  const held = {
    rule: ROOM.overrideEnd,
    endsAt: endsAt(defaultEnd(ROOM), ROOM, WEEK, now),
    origin: { source: "valve", valveId },
    since: now.epochMilliseconds,
  } as const;
  if (target === "off") return { kind: "off", ...held };
  return { kind: "override", target, preset: undefined, ...held };
}

/** An override at `target` made through the API an hour ago. */
function apiOverride(target: number, rule: "next_change" | "timer" | "manual" = "next_change") {
  return makeThermostat({ target, rule, since: at("09:00"), endsAt: at("22:00") });
}

describe("adopt", () => {
  describe("adopt", () => {
    describe("take-over", () => {
      describe("With a valve that has no expectation, showing heat 23", () => {
        const result = adopt(input([valve({ shows: seen("heat", 23), expectation: undefined })]));
        it("the thermostat is unchanged", () => {
          expect(result.thermostat).toBe(SCHEDULE);
        });
        it("its expectation is for the room, with no confirmed state and nothing sent", () => {
          expect(expectationOf(result)).toEqual({
            roomId: BUILDER_ROOM,
            confirmed: undefined,
            sent: [],
            week: undefined,
            written: undefined,
            previous: undefined,
          });
        });
      });
      describe("With an expectation kept for another room", () => {
        it("the valve is taken over the same way", () => {
          const other = makeExpectation({ roomId: "kitchen", confirmed: heat(23) });
          const result = adopt(input([valve({ shows: seen("heat", 23), expectation: other })]));
          expect(result.thermostat).toBe(SCHEDULE);
          expect(expectationOf(result)).toEqual({
            roomId: BUILDER_ROOM,
            confirmed: undefined,
            sent: [],
            week: undefined,
            written: undefined,
            previous: undefined,
          });
        });
      });
      describe("With an expectation kept for another room, holding a written and a previous week", () => {
        it("the valve is taken over, keeping the weeks written to it", () => {
          const written = { key: "b", values: [16, 21] };
          const previous = { key: "a", values: [17, 20] };
          const other = makeExpectation({
            roomId: "kitchen",
            confirmed: heat(23),
            week: written,
            written,
            previous,
          });
          const result = adopt(input([valve({ shows: seen("heat", 23), expectation: other })]));
          expect(expectationOf(result)).toEqual({
            roomId: BUILDER_ROOM,
            confirmed: undefined,
            sent: [],
            week: undefined,
            written,
            previous,
          });
        });
      });
      describe("With a taken-over valve whose report matches its sent auto", () => {
        const expectation = makeExpectation({
          confirmed: undefined,
          sent: [sent(AUTO, at("10:00"), seen("heat", 23))],
        });
        const result = adopt(
          input([valve({ shows: seen("auto", 19), heardAt: at("10:00:02"), expectation })]),
        );
        it("its confirmed state is auto and sent is empty", () => {
          expect(expectationOf(result)?.confirmed).toMatchObject({ mode: "auto", scheduled: true });
          expect(expectationOf(result)?.sent).toEqual([]);
        });
        it("the thermostat is unchanged", () => {
          expect(result.thermostat).toBe(SCHEDULE);
        });
      });
      describe("With a taken-over valve still showing heat 23 after its auto write was sent", () => {
        it("nothing is adopted and its expectation is unchanged", () => {
          const expectation = makeExpectation({
            confirmed: undefined,
            sent: [sent(AUTO, at("10:00"), seen("heat", 23))],
          });
          const result = adopt(
            input([valve({ shows: seen("heat", 23), heardAt: at("10:00:30"), expectation })]),
          );
          expect(result.thermostat).toBe(SCHEDULE);
          expect(expectationOf(result)).toEqual(expectation);
        });
      });
    });

    describe("confirming", () => {
      describe("With sent [heat 22] and a report heat 22", () => {
        it("confirmed is heat 22 and sent is empty", () => {
          const expectation = makeExpectation({
            sent: [sent(heat(22), at("10:00"), seen("auto", 19))],
          });
          const result = adopt(
            input(
              [valve({ shows: seen("heat", 22), heardAt: at("10:00:02"), expectation })],
              apiOverride(22),
            ),
          );
          expect(expectationOf(result)?.confirmed).toEqual(heat(22));
          expect(expectationOf(result)?.sent).toEqual([]);
        });
      });
      describe("With sent [heat 22] at 10:00:00.700 and a report heat 22 heard at 10:00:00.200, its last_seen in the same second (M14)", () => {
        it("confirmed is heat 22 and sent is empty", () => {
          const expectation = makeExpectation({
            sent: [sent(heat(22), at("10:00:00") + 700, seen("auto", 19))],
          });
          const result = adopt(
            input(
              [valve({ shows: seen("heat", 22), heardAt: at("10:00:00") + 200, expectation })],
              apiOverride(22),
            ),
          );
          expect(expectationOf(result)?.confirmed).toEqual(heat(22));
          expect(expectationOf(result)?.sent).toEqual([]);
        });
      });
      describe("With sent [heat 22, heat 21] and a report heat 21", () => {
        it("nothing is adopted and the expectation is unchanged", () => {
          const expectation = makeExpectation({
            sent: [
              sent(heat(22), at("10:01"), seen("heat", 21)),
              sent(heat(21), at("10:00"), seen("auto", 19)),
            ],
          });
          const thermostat = apiOverride(22);
          const result = adopt(
            input(
              [valve({ shows: seen("heat", 21), heardAt: at("10:01:05"), expectation })],
              thermostat,
            ),
          );
          expect(result.thermostat).toBe(thermostat);
          expect(expectationOf(result)).toEqual(expectation);
        });
      });
      describe("With a TRV-ZBT taken over in auto holding a hand-set 17, its week unconfirmed, sent [auto]", () => {
        it("confirmed is auto 17 scheduled (the held value recorded) and nothing is adopted", () => {
          const expectation = makeExpectation({
            confirmed: undefined,
            sent: [sent(AUTO, at("10:00"), seen("auto", 17))],
          });
          const result = adopt(
            input([
              valve({
                model: "trv_zbt",
                shows: seen("auto", 17),
                heardAt: at("10:00:02"),
                expectation,
                ctx: NO_WEEK,
              }),
            ]),
          );
          expect(expectationOf(result)?.confirmed).toEqual(autoAt(17));
          expect(result.thermostat).toBe(SCHEDULE);
        });
      });
      describe("With that valve once its week (16, 19, 21) is confirmed, still showing auto 17", () => {
        it("nothing is adopted", () => {
          const expectation = makeExpectation({ confirmed: autoAt(17) });
          const result = adopt(
            input([
              valve({
                model: "trv_zbt",
                shows: seen("auto", 17),
                expectation,
                ctx: weekCtx([16, 19, 21], [16]),
              }),
            ]),
          );
          expect(result.thermostat).toBe(SCHEDULE);
          expect(expectationOf(result)).toEqual(expectation);
        });
      });
    });

    describe("retiring", () => {
      describe("With sent [heat 22] sent at 10:00 and a report auto heard at 10:01:30", () => {
        it("sent is empty and nothing is adopted", () => {
          const expectation = makeExpectation({
            sent: [sent(heat(22), at("10:00"), seen("auto", 19))],
          });
          const result = adopt(
            input([valve({ shows: seen("auto", 19), heardAt: at("10:01:30"), expectation })]),
          );
          expect(expectationOf(result)?.sent).toEqual([]);
          expect(result.thermostat).toBe(SCHEDULE);
        });
      });
      describe("With sent [heat 22] lost, the room cancelled, and days later a person setting heat 22", () => {
        it("an override at 22", () => {
          const lost = makeExpectation({ sent: [sent(heat(22), at("10:00"), seen("auto", 19))] });
          // A report heard more than a minute after the write retires it.
          const first = adopt(
            input([valve({ shows: seen("auto", 19), heardAt: at("10:01:30"), expectation: lost })]),
          );
          const later = NOW.add({ days: 3 });
          const result = adopt(
            input(
              [
                valve({
                  shows: seen("heat", 22),
                  heardAt: later.epochMilliseconds,
                  expectation: expectationOf(first),
                }),
              ],
              first.thermostat,
              { now: later },
            ),
          );
          expect(result.thermostat).toEqual(byValve(22, V, later));
        });
      });
    });

    describe("landing and partial writes", () => {
      const inFlight = makeExpectation({ sent: [sent(heat(25), at("10:00"), seen("auto", 19))] });
      describe("With confirmed auto, sent [heat 25] at 10:00 and a report heat 19 heard at 10:00:01 (mode first)", () => {
        it("nothing is adopted and the expectation is unchanged", () => {
          const result = adopt(
            input(
              [valve({ shows: seen("heat", 19), heardAt: at("10:00:01"), expectation: inFlight })],
              apiOverride(25),
            ),
          );
          expect(result.thermostat).toEqual(apiOverride(25));
          expect(expectationOf(result)).toEqual(inFlight);
        });
      });
      describe("With the next report heat 25 heard at 10:00:02", () => {
        it("confirmed is heat 25 and nothing is adopted", () => {
          const result = adopt(
            input(
              [valve({ shows: seen("heat", 25), heardAt: at("10:00:02"), expectation: inFlight })],
              apiOverride(25),
            ),
          );
          expect(expectationOf(result)?.confirmed).toEqual(heat(25));
          expect(result.thermostat).toEqual(apiOverride(25));
        });
      });
      describe("With a TRVZB confirmed auto, sent [heat 25 from auto 19] at 10:00 and a report heat 19 heard at 10:01:05 (the setpoint write lost)", () => {
        it("nothing is adopted and heat 25 stays sent", () => {
          const result = adopt(
            input(
              [valve({ shows: seen("heat", 19), heardAt: at("10:01:05"), expectation: inFlight })],
              apiOverride(25),
            ),
          );
          expect(result.thermostat).toEqual(apiOverride(25));
          expect(expectationOf(result)?.sent).toEqual(inFlight.sent);
        });
      });
      describe("With a TRVZB confirmed auto, sent [heat 25 from auto 19] at 10:00 and a report heat 17, its last manual setpoint, heard at 10:01:05 (the setpoint write lost, M14)", () => {
        it("nothing is adopted and heat 25 stays sent", () => {
          const result = adopt(
            input(
              [valve({ shows: seen("heat", 17), heardAt: at("10:01:05"), expectation: inFlight })],
              apiOverride(25),
            ),
          );
          expect(result.thermostat).toEqual(apiOverride(25));
          expect(expectationOf(result)?.sent).toEqual(inFlight.sent);
        });
      });
      describe("With that report judged again in a tick 2 min before a point, and in a tick with the schedule group marked", () => {
        it("nothing is adopted and heat 25 stays sent", () => {
          const report = {
            shows: seen("heat", 19),
            heardAt: at("10:01:05"),
            expectation: inFlight,
          };
          const nearPoint = adopt(
            input([valve({ ...report, ctx: weekCtx([17, 20], [20]) })], apiOverride(25), {
              now: monday("22:58"),
            }),
          );
          const marked = adopt(input([valve({ ...report, ctx: NO_WEEK })], apiOverride(25)));
          for (const result of [nearPoint, marked]) {
            expect(result.thermostat).toEqual(apiOverride(25));
            expect(expectationOf(result)?.sent).toEqual(inFlight.sent);
          }
        });
      });
      describe("With a TRV-ZBT confirmed auto 19 scheduled that took 21 at its own point, sent [heat 25 from auto 21] and a report heat 21 heard 70 s later", () => {
        it("nothing is adopted and heat 25 stays sent", () => {
          const expectation = makeExpectation({
            confirmed: autoAt(19),
            sent: [sent(heat(25), at("10:00"), seen("auto", 21))],
          });
          const result = adopt(
            input(
              [
                valve({
                  model: "trv_zbt",
                  shows: seen("heat", 21),
                  heardAt: at("10:01:10"),
                  expectation,
                  ctx: weekCtx([17, 19, 21], [21]),
                }),
              ],
              apiOverride(25),
            ),
          );
          expect(result.thermostat).toEqual(apiOverride(25));
          expect(expectationOf(result)?.sent).toEqual(expectation.sent);
        });
      });
      // Carry ruling 2 (M14): a report in the write's mode with any other setpoint is a partial
      // write, since a TRVZB shows its last manual setpoint until the setpoint lands.
      describe("With confirmed auto, sent [heat 25 from auto 19] at 10:00 and a report heat 22 heard at 10:01:05", () => {
        it("nothing is adopted and heat 25 stays sent (a partial write, carry ruling 2)", () => {
          const result = adopt(
            input(
              [valve({ shows: seen("heat", 22), heardAt: at("10:01:05"), expectation: inFlight })],
              apiOverride(25),
            ),
          );
          expect(result.thermostat).toEqual(apiOverride(25));
          expect(expectationOf(result)?.sent).toEqual(inFlight.sent);
        });
      });
      describe("With confirmed auto, sent [heat 25] and a report heat 19 with heardAt undefined (after a link-up)", () => {
        it("nothing is adopted", () => {
          const result = adopt(
            input(
              [valve({ shows: seen("heat", 19), heardAt: undefined, expectation: inFlight })],
              apiOverride(25),
            ),
          );
          expect(result.thermostat).toEqual(apiOverride(25));
          expect(expectationOf(result)?.confirmed).toEqual(AUTO);
        });
      });
      describe("With sent [heat 22] at 10:00 and a report heat 22 heard at 09:59:59 (an older message)", () => {
        it("it is not confirmed", () => {
          const expectation = makeExpectation({
            sent: [sent(heat(22), at("10:00"), seen("auto", 19))],
          });
          const result = adopt(
            input(
              [valve({ shows: seen("heat", 22), heardAt: at("09:59:59"), expectation })],
              apiOverride(22),
            ),
          );
          expect(expectationOf(result)?.confirmed).toEqual(AUTO);
          expect(expectationOf(result)?.sent).toEqual(expectation.sent);
        });
      });
      // Carry ruling 3 (M14): a TRV-ZBT sent `auto` from `heat` passes through `heat` at its
      // schedule's current value.
      describe("With a TRV-ZBT confirmed heat 22, sent [auto 21 scheduled from heat 22] at 09:58:30 and a report heat 19, the schedule's value in force, heard 1 s later (week 17, 19, 21)", () => {
        it("nothing is adopted", () => {
          const expectation = makeExpectation({
            confirmed: heat(22),
            sent: [sent(autoAt(21), at("09:58:30"), seen("heat", 22))],
          });
          const result = adopt(
            input([
              valve({
                model: "trv_zbt",
                shows: seen("heat", 19),
                heardAt: at("09:58:31"),
                expectation,
                ctx: weekCtx([17, 19, 21], [19, 21]),
              }),
            ]),
          );
          expect(result.thermostat).toBe(SCHEDULE);
          expect(expectationOf(result)).toEqual(expectation);
        });
      });
    });

    describe("a person's change", () => {
      describe("With a TRVZB confirmed auto showing heat 22", () => {
        const result = adopt(input([valve({ shows: seen("heat", 22) })]));
        it("an override at 22, origin the valve, rule the room's default", () => {
          expect(result.thermostat).toEqual(byValve(22));
          expect(result.thermostat).toMatchObject({
            origin: { source: "valve", valveId: V },
            rule: ROOM.overrideEnd,
          });
        });
        it("its confirmed state is heat 22", () => {
          expect(expectationOf(result)?.confirmed).toEqual(heat(22));
        });
      });
      describe("With a TRVZB confirmed auto showing heat 17, its last manual setpoint (the first click of its knob, M11)", () => {
        it("an override at 17", () => {
          const result = adopt(input([valve({ shows: seen("heat", 17) })]));
          expect(result.thermostat).toEqual(byValve(17));
        });
      });
      describe("With a TRV-ZBT confirmed auto 19 scheduled, week values 17, 19, 21, showing auto 24", () => {
        it("an override at 24", () => {
          const result = adopt(
            input([
              valve({
                model: "trv_zbt",
                shows: seen("auto", 24),
                expectation: makeExpectation({ confirmed: autoAt(19) }),
                ctx: weekCtx([17, 19, 21], [19]),
              }),
            ]),
          );
          expect(result.thermostat).toEqual(byValve(24));
        });
      });
      describe("With a TRV-ZBT confirmed auto 19 scheduled showing heat 17, its last manual heat setpoint (its top button, M11)", () => {
        it("an override at 17", () => {
          const result = adopt(
            input([
              valve({
                model: "trv_zbt",
                shows: seen("heat", 17),
                expectation: makeExpectation({ confirmed: autoAt(19) }),
                ctx: weekCtx([17, 19, 21], [19]),
              }),
            ]),
          );
          expect(result.thermostat).toEqual(byValve(17));
        });
      });
      describe("With a TRV-ZBT confirmed heat 22 in a timed override, showing heat 25", () => {
        it("an override at 25", () => {
          const result = adopt(
            input(
              [
                valve({
                  model: "trv_zbt",
                  shows: seen("heat", 25),
                  expectation: makeExpectation({ confirmed: heat(22) }),
                  ctx: weekCtx([17, 19, 21], [19]),
                }),
              ],
              apiOverride(22, "timer"),
            ),
          );
          expect(result.thermostat).toEqual(byValve(25));
        });
      });
      describe("With a TRV-ZBT confirmed heat 23 in an override turned to 21, a value of its week", () => {
        it("an override at 21", () => {
          const result = adopt(
            input(
              [
                valve({
                  model: "trv_zbt",
                  shows: seen("heat", 21),
                  expectation: makeExpectation({ confirmed: heat(23) }),
                  ctx: weekCtx([17, 19, 21], [19]),
                }),
              ],
              apiOverride(23),
            ),
          );
          expect(result.thermostat).toEqual(byValve(21));
        });
      });
      describe("With a TRV-ZBT confirmed auto 20.5 (adopted) turned to 21, a value of its week, no point near", () => {
        it("an override at 21", () => {
          const result = adopt(
            input(
              [
                valve({
                  model: "trv_zbt",
                  shows: seen("auto", 21),
                  expectation: makeExpectation({ confirmed: adoptedAuto(20.5) }),
                  ctx: weekCtx([17, 19, 21], [19]),
                }),
              ],
              apiOverride(20.5),
            ),
          );
          expect(result.thermostat).toEqual(byValve(21));
        });
      });
      describe("With a TRV-ZBT confirmed auto 20.5 (adopted) showing 19, the point it took at heardAt", () => {
        it("nothing is adopted", () => {
          const thermostat = apiOverride(20.5);
          const result = adopt(
            input(
              [
                valve({
                  model: "trv_zbt",
                  shows: seen("auto", 19),
                  expectation: makeExpectation({ confirmed: adoptedAuto(20.5) }),
                  ctx: weekCtx([17, 19, 21], [17, 19]),
                }),
              ],
              thermostat,
            ),
          );
          expect(result.thermostat).toBe(thermostat);
        });
      });
      describe("With a valve going to off", () => {
        it("the room is off with the room's default end", () => {
          const result = adopt(input([valve({ shows: seen("off", 7) })]));
          expect(result.thermostat).toEqual(byValve("off"));
        });
      });
      describe("With a TRVZB confirmed heat 22 in a manual override, showing auto 19", () => {
        it("the room returns to its schedule", () => {
          const result = adopt(
            input(
              [
                valve({
                  shows: seen("auto", 19),
                  expectation: makeExpectation({ confirmed: heat(22) }),
                }),
              ],
              apiOverride(22, "manual"),
            ),
          );
          expect(result.thermostat).toBe(SCHEDULE);
        });
      });
      describe("With a TRV-ZBT confirmed heat 22 in a manual override, showing auto 19", () => {
        it("the room returns to its schedule", () => {
          const result = adopt(
            input(
              [
                valve({
                  model: "trv_zbt",
                  shows: seen("auto", 19),
                  expectation: makeExpectation({ confirmed: heat(22) }),
                  ctx: weekCtx([17, 19, 21], [19]),
                }),
              ],
              apiOverride(22, "manual"),
            ),
          );
          expect(result.thermostat).toBe(SCHEDULE);
        });
      });
      describe("With a valve confirmed off showing off and a new setpoint", () => {
        it("nothing is adopted", () => {
          const off = makeThermostat({ kind: "off", since: at("09:00"), endsAt: at("22:00") });
          const result = adopt(
            input(
              [valve({ shows: seen("off", 12), expectation: makeExpectation({ confirmed: OFF }) })],
              off,
            ),
          );
          expect(result.thermostat).toBe(off);
        });
      });
      describe("With a valve showing heat and no setpoint", () => {
        it("an override at the room's target now", () => {
          const result = adopt(input([valve({ shows: seen("heat", undefined) })]));
          // The builder day holds 20 from 06:30 to 22:00.
          expect(result.thermostat).toEqual(byValve(20));
        });
      });
      describe("With a setpoint of 33 in a room limited to 30", () => {
        it("the override is at 30", () => {
          const result = adopt(
            input([valve({ shows: seen("heat", 33) })], SCHEDULE, { limits: { min: 5, max: 30 } }),
          );
          expect(result.thermostat).toEqual(byValve(30));
        });
      });
      describe("With a knob set to the value the room is already overridden at, with the same rule", () => {
        it("the thermostat is kept, since unchanged", () => {
          const thermostat = apiOverride(22);
          const result = adopt(input([valve({ shows: seen("heat", 22) })], thermostat));
          expect(result.thermostat).toBe(thermostat);
        });
        it("reports a person's change all the same", () => {
          const thermostat = apiOverride(22);
          const result = adopt(input([valve({ shows: seen("heat", 22) })], thermostat));
          expect(result.personChange).toBe(true);
        });
      });
      describe("With a report explained by the confirmed state", () => {
        it("reports no person's change", () => {
          const thermostat = apiOverride(22);
          const result = adopt(
            input(
              [
                valve({
                  shows: seen("heat", 22),
                  expectation: makeExpectation({ confirmed: heat(22) }),
                }),
              ],
              thermostat,
            ),
          );
          expect(result.personChange).toBe(false);
        });
      });
      describe("With confirmed auto, sent [heat 22] at 10:00 and a report heat 24 heard at 10:01:05", () => {
        it("nothing is adopted and heat 22 stays sent (a partial write, carry ruling 2)", () => {
          const expectation = makeExpectation({
            sent: [sent(heat(22), at("10:00"), seen("auto", 19))],
          });
          const thermostat = apiOverride(22);
          const result = adopt(
            input(
              [valve({ shows: seen("heat", 24), heardAt: at("10:01:05"), expectation })],
              thermostat,
            ),
          );
          expect(result.thermostat).toBe(thermostat);
          expect(expectationOf(result)?.sent).toEqual(expectation.sent);
        });
      });
      describe("With a person's change while a write is in flight", () => {
        it("sent is kept, so the write's later echo is not adopted", () => {
          // The room went off through the API; a knob is turned before the write lands.
          const off = makeThermostat({ kind: "off", since: at("09:59:50"), endsAt: at("22:00") });
          const writing = makeExpectation({ sent: [sent(OFF, at("10:00"), seen("auto", 19))] });
          const turned = adopt(
            input(
              [valve({ shows: seen("heat", 23), heardAt: at("10:00:20"), expectation: writing })],
              off,
            ),
          );
          expect(turned.thermostat).toEqual(byValve(23));
          expect(expectationOf(turned)?.sent).toEqual(writing.sent);
          const echoed = adopt(
            input(
              [
                valve({
                  shows: seen("off", 7),
                  heardAt: at("10:00:40"),
                  expectation: expectationOf(turned),
                }),
              ],
              turned.thermostat,
            ),
          );
          expect(echoed.thermostat).toBe(turned.thermostat);
        });
      });
    });

    describe("Heatmaster's own doing", () => {
      const echo = makeExpectation({
        confirmed: heat(22),
        sent: [sent(AUTO, at("10:00"), seen("heat", 22))],
      });
      describe("With a TRVZB confirmed heat 22, sent [auto], showing auto 22 (the echo keeps the old setpoint)", () => {
        const result = adopt(
          input([valve({ shows: seen("auto", 22), heardAt: at("10:00:01"), expectation: echo })]),
        );
        it("nothing is adopted and its confirmed state is auto", () => {
          expect(result.thermostat).toBe(SCHEDULE);
          expect(expectationOf(result)?.confirmed).toMatchObject({ mode: "auto", scheduled: true });
        });
      });
      describe("With that TRVZB then showing auto 19 (the schedule's value)", () => {
        it("nothing is adopted", () => {
          const first = adopt(
            input([valve({ shows: seen("auto", 22), heardAt: at("10:00:01"), expectation: echo })]),
          );
          const result = adopt(
            input([
              valve({
                shows: seen("auto", 19),
                heardAt: at("10:00:03"),
                expectation: expectationOf(first),
              }),
            ]),
          );
          expect(result.thermostat).toBe(SCHEDULE);
        });
      });
      describe("With a TRVZB confirmed auto showing auto 23 after its week was rewritten", () => {
        it("nothing is adopted", () => {
          const result = adopt(input([valve({ shows: seen("auto", 23), ctx: weekCtx([16, 23]) })]));
          expect(result.thermostat).toBe(SCHEDULE);
        });
      });
      describe("With a TRVZB confirmed heat 22 and sent [auto] going out 5 min late, still showing heat 22", () => {
        it("nothing is adopted", () => {
          const result = adopt(
            input([valve({ shows: seen("heat", 22), heardAt: at("10:05"), expectation: echo })]),
          );
          expect(result.thermostat).toBe(SCHEDULE);
        });
      });
      describe("With a TRVZB confirmed heat 21 showing heat 21 in the tick a climate command moves the room to 21.5", () => {
        it("nothing is adopted and the room stays at 21.5", () => {
          const climate = makeThermostat({
            target: 21.5,
            origin: { source: "climate", valveId: undefined },
            since: at("10:00:30"),
            endsAt: at("22:00"),
          });
          const result = adopt(
            input(
              [
                valve({
                  shows: seen("heat", 21),
                  expectation: makeExpectation({ confirmed: heat(21) }),
                }),
              ],
              climate,
            ),
          );
          expect(result.thermostat).toBe(climate);
        });
      });
      describe("With confirmed auto, sent [heat 22] not yet landed, showing auto 19", () => {
        it("nothing is adopted", () => {
          const expectation = makeExpectation({
            sent: [sent(heat(22), at("10:00"), seen("auto", 19))],
          });
          const thermostat = apiOverride(22);
          const result = adopt(
            input(
              [valve({ shows: seen("auto", 19), heardAt: at("09:59:00"), expectation })],
              thermostat,
            ),
          );
          expect(result.thermostat).toBe(thermostat);
        });
      });
      describe("With a TRV-ZBT on schedule showing the next point's value 70 s early", () => {
        it("nothing is adopted", () => {
          // The builder week moves from 17 to 20 at 06:30; the valve's clock runs ahead.
          const result = adopt(
            input(
              [
                valve({
                  model: "trv_zbt",
                  shows: seen("auto", 20),
                  heardAt: at("06:28:50"),
                  expectation: makeExpectation({ confirmed: autoAt(17) }),
                  ctx: weekCtx([17, 20], [17, 20]),
                }),
              ],
              SCHEDULE,
              { now: monday("06:29") },
            ),
          );
          expect(result.thermostat).toBe(SCHEDULE);
        });
      });
    });

    describe("the valve's week", () => {
      describe("With a TRV-ZBT confirmed auto 19 scheduled under a saved week (17, 19, 21), its week unconfirmed after a restart but unchanged, showing auto 24", () => {
        it("an override at 24", () => {
          const result = adopt(
            input([
              valve({
                model: "trv_zbt",
                shows: seen("auto", 24),
                expectation: makeExpectation({
                  confirmed: autoAt(19),
                  week: { key: "k", values: [17, 19, 21] },
                }),
                ctx: savedCtx([17, 19, 21]),
              }),
            ]),
          );
          expect(result.thermostat).toEqual(byValve(24));
        });
      });
      describe("With a person's change on a TRV-ZBT with a saved week", () => {
        it("its saved week is kept with the adopted state", () => {
          const week = { key: "k", values: [17, 19, 21] };
          const result = adopt(
            input([
              valve({
                model: "trv_zbt",
                shows: seen("auto", 24),
                expectation: makeExpectation({ confirmed: autoAt(19), week }),
                ctx: savedCtx([17, 19, 21]),
              }),
            ]),
          );
          expect(expectationOf(result)).toMatchObject({ confirmed: adoptedAuto(24), week });
        });
      });
      describe("With a TRV-ZBT confirmed auto 19 scheduled, the desired week changed and unconfirmed, showing auto 24", () => {
        it("nothing is adopted (known limit)", () => {
          const result = adopt(
            input([
              valve({
                model: "trv_zbt",
                shows: seen("auto", 24),
                expectation: makeExpectation({ confirmed: autoAt(19) }),
                ctx: NO_WEEK,
              }),
            ]),
          );
          expect(result.thermostat).toBe(SCHEDULE);
        });
      });
      describe("With a TRVZB with its week unconfirmed showing heat 22", () => {
        it("an override at 22", () => {
          const result = adopt(input([valve({ shows: seen("heat", 22), ctx: NO_WEEK })]));
          expect(result.thermostat).toEqual(byValve(22));
        });
      });
      describe("With a TRV-ZBT confirmed auto 19 scheduled turned to auto 21, a value of its week", () => {
        it("nothing is adopted (known limit)", () => {
          const result = adopt(
            input([
              valve({
                model: "trv_zbt",
                shows: seen("auto", 21),
                expectation: makeExpectation({ confirmed: autoAt(19) }),
                ctx: weekCtx([17, 19, 21], [19]),
              }),
            ]),
          );
          expect(result.thermostat).toBe(SCHEDULE);
        });
      });
      describe("With a TRV-ZBT confirmed auto 20.5 (adopted, not scheduled), the value in force 19 and no point within 2 min, showing auto 19", () => {
        it("nothing is adopted (known limit: the value in force is in pointValues)", () => {
          const thermostat = apiOverride(20.5);
          const result = adopt(
            input(
              [
                valve({
                  model: "trv_zbt",
                  shows: seen("auto", 19),
                  expectation: makeExpectation({ confirmed: adoptedAuto(20.5) }),
                  ctx: weekCtx([17, 19, 21], [19]),
                }),
              ],
              thermostat,
            ),
          );
          expect(result.thermostat).toBe(thermostat);
        });
      });
    });

    describe("a lost day write", () => {
      // The valve's old week holds 17 and 20, its new week 16 and 21.
      const OLD_WEEK: SavedWeek = { key: "old", values: [17, 20] };
      const NEW_WEEK: SavedWeek = { key: "new", values: [16, 21] };
      /** Confirmed auto 21 under its new week, its old week kept as the previous one. */
      const underNew = makeExpectation({
        confirmed: autoAt(21),
        week: NEW_WEEK,
        previous: OLD_WEEK,
      });

      describe("With a TRV-ZBT whose week changed and whose day write was lost, showing auto 20, its old week's point at heardAt", () => {
        const result = adopt(
          input([
            valve({
              model: "trv_zbt",
              shows: seen("auto", 20),
              expectation: underNew,
              ctx: weekCtx([16, 21], [21]),
              previousPoints: [20],
            }),
          ]),
        );
        it("its old week's point is not adopted", () => {
          expect(result.thermostat).toBe(SCHEDULE);
        });
        it("the schedule group is written again", () => {
          expect(result.resend).toEqual(new Set([V]));
        });
        it("its expectation is unchanged", () => {
          expect(expectationOf(result)).toBe(underNew);
        });
      });
      describe("With that valve showing auto 24, a value of neither week", () => {
        const result = adopt(
          input([
            valve({
              model: "trv_zbt",
              shows: seen("auto", 24),
              expectation: underNew,
              ctx: weekCtx([16, 21], [21]),
              previousPoints: [20],
            }),
          ]),
        );
        it("an override at 24", () => {
          expect(result.thermostat).toEqual(byValve(24));
        });
        it("the schedule group is not written again", () => {
          expect(result.resend).toEqual(new Set());
        });
      });
      describe("With a TRV-ZBT confirmed heat 22 in an override, showing auto 20, its old week's point at heardAt", () => {
        const result = adopt(
          input(
            [
              valve({
                model: "trv_zbt",
                shows: seen("auto", 20),
                expectation: makeExpectation({
                  confirmed: heat(22),
                  week: NEW_WEEK,
                  previous: OLD_WEEK,
                }),
                ctx: weekCtx([16, 21], [21]),
                previousPoints: [20],
              }),
            ],
            apiOverride(22),
          ),
        );
        it("the room goes back to its schedule (auto pressed at the valve)", () => {
          expect(result.thermostat).toBe(SCHEDULE);
        });
        it("the schedule group is not written again", () => {
          expect(result.resend).toEqual(new Set());
        });
      });
      describe("With a TRV-ZBT under its old week, its new week written, sent [auto 21 scheduled], showing auto 21 once its new week is confirmed", () => {
        it("its saved week is the new one and its previous week stays the old one", () => {
          const result = adopt(
            input([
              valve({
                model: "trv_zbt",
                shows: seen("auto", 21),
                heardAt: at("10:00:02"),
                expectation: makeExpectation({
                  confirmed: autoAt(20),
                  sent: [sent(autoAt(21), at("10:00"), seen("auto", 20))],
                  week: OLD_WEEK,
                  written: NEW_WEEK,
                  previous: OLD_WEEK,
                }),
                ctx: weekCtx([16, 21], [21]),
                week: NEW_WEEK,
              }),
            ]),
          );
          expect(expectationOf(result)).toMatchObject({
            confirmed: autoAt(21),
            week: NEW_WEEK,
            previous: OLD_WEEK,
          });
        });
      });

      describe("the previous week", () => {
        describe("With a TRV-ZBT whose previous week is kept, showing auto 16, a point only its new week has at heardAt", () => {
          const result = adopt(
            input([
              valve({
                model: "trv_zbt",
                shows: seen("auto", 16),
                expectation: underNew,
                ctx: weekCtx([16, 21], [16, 21]),
                previousPoints: [17],
              }),
            ]),
          );
          it("its previous week is dropped", () => {
            expect(expectationOf(result)).toEqual({ ...underNew, previous: undefined });
          });
          it("nothing is adopted", () => {
            expect(result.thermostat).toBe(SCHEDULE);
          });
        });
        describe("With that valve showing auto 21, the value Heatmaster wrote", () => {
          it("its previous week is kept", () => {
            const result = adopt(
              input([
                valve({
                  model: "trv_zbt",
                  shows: seen("auto", 21),
                  expectation: underNew,
                  ctx: weekCtx([16, 21], [21]),
                  previousPoints: [20],
                }),
              ]),
            );
            expect(expectationOf(result)).toBe(underNew);
          });
        });
        describe("With that valve showing auto 16 at a point its old week has too", () => {
          it("its previous week is kept", () => {
            const result = adopt(
              input([
                valve({
                  model: "trv_zbt",
                  shows: seen("auto", 16),
                  expectation: underNew,
                  ctx: weekCtx([16, 21], [16]),
                  previousPoints: [16, 17],
                }),
              ]),
            );
            expect(expectationOf(result)).toBe(underNew);
          });
        });
      });
    });

    describe("several valves", () => {
      describe("With two valves differing, heard 5 s apart", () => {
        const result = adopt(
          input([
            valve({ shows: seen("heat", 23), heardAt: at("10:00:30") }),
            valve({
              valveId: V2,
              model: "trv_zbt",
              shows: seen("heat", 21),
              heardAt: at("10:00:35"),
              ctx: weekCtx([17, 20], [20]),
            }),
          ]),
        );
        it("the newer one's value is adopted", () => {
          expect(result.thermostat).toEqual(byValve(21, V2));
        });
        it("both confirmed states are what they show", () => {
          expect(expectationOf(result, V)?.confirmed).toEqual(heat(23));
          expect(expectationOf(result, V2)?.confirmed).toEqual(heat(21));
        });
      });
      describe("With two valves differing, heard at the same instant", () => {
        it("the lower valve id's value is adopted", () => {
          const result = adopt(
            input([
              valve({
                valveId: V2,
                model: "trv_zbt",
                shows: seen("heat", 21),
                ctx: weekCtx([17, 20], [20]),
              }),
              valve({ shows: seen("heat", 23) }),
            ]),
          );
          expect(result.thermostat).toEqual(byValve(23, V));
        });
      });
      describe("With a TRV-ZBT on schedule, week 17, 19, 21, reports in four ticks auto 19.5, 20, 20.5, 21", () => {
        it("the room ends at an override at 21", () => {
          let thermostat: Thermostat = SCHEDULE;
          let expectation: ValveExpectation | undefined = makeExpectation({ confirmed: AUTO });
          let now = NOW;
          for (const value of [19.5, 20, 20.5, 21]) {
            now = now.add({ seconds: 3 });
            const result = adopt(
              input(
                [
                  valve({
                    model: "trv_zbt",
                    shows: seen("auto", value),
                    heardAt: now.epochMilliseconds,
                    expectation,
                    ctx: weekCtx([17, 19, 21], [19]),
                  }),
                ],
                thermostat,
                { now },
              ),
            );
            thermostat = result.thermostat;
            expectation = expectationOf(result);
          }
          expect(thermostat).toEqual(byValve(21, V, now));
        });
      });
    });
  });

  describe("withWeek", () => {
    const A: SavedWeek = { key: "a", values: [17, 20] };
    const B: SavedWeek = { key: "b", values: [16, 21] };
    const C: SavedWeek = { key: "c", values: [18] };

    describe("With a saved week A and a previous week C, given B", () => {
      it("its week is B and its previous week stays C", () => {
        const result = withWeek(makeExpectation({ week: A, previous: C }), B);
        expect(result).toMatchObject({ week: B, previous: C });
      });
    });
    describe("With week B, given a week with B's key", () => {
      it("the expectation itself", () => {
        const expectation = makeExpectation({ week: B });
        expect(withWeek(expectation, { key: "b", values: [16, 21] })).toBe(expectation);
      });
    });
  });

  describe("withWritten", () => {
    const A: SavedWeek = { key: "a", values: [17, 20] };
    const B: SavedWeek = { key: "b", values: [16, 21] };

    describe("With a written week A, given B", () => {
      it("its written week is B and its previous week A", () => {
        const result = withWritten(makeExpectation({ written: A }), B);
        expect(result).toMatchObject({ written: B, previous: A });
      });
    });
    describe("With no written week and a saved week A, given B (a state saved before 0.3.1)", () => {
      it("its written week is B and its previous week A", () => {
        const result = withWritten(makeExpectation({ week: A }), B);
        expect(result).toMatchObject({ written: B, previous: A });
      });
    });
    describe("With no written and no saved week (a valve being taken over), given A", () => {
      it("its written week is A and it has no previous week", () => {
        const result = withWritten(makeExpectation({ confirmed: undefined }), A);
        expect(result).toMatchObject({ written: A, previous: undefined });
      });
    });
    describe("With no written week, a saved week A and a previous week B, given A", () => {
      it("its written week is A and its previous week stays B", () => {
        const result = withWritten(makeExpectation({ week: A, previous: B }), A);
        expect(result).toMatchObject({ written: A, previous: B });
      });
    });
    describe("With a written week B, given a week with B's key (the week sent again)", () => {
      it("the expectation itself", () => {
        const expectation = makeExpectation({ written: B, previous: A });
        expect(withWritten(expectation, { key: "b", values: [16, 21] })).toBe(expectation);
      });
    });
  });

  describe("clampThermostatState", () => {
    const nowMs = at("10:00");
    describe("With a sent write and a since later than now", () => {
      it("both become now", () => {
        const state: ThermostatState = {
          rooms: new Map([[BUILDER_ROOM, apiOverride(22)]]),
          valves: new Map([
            [V, makeExpectation({ sent: [sent(heat(22), nowMs + DAY_MS, seen("auto", 19))] })],
          ]),
          windows: new Map(),
        };
        const future: ThermostatState = {
          ...state,
          rooms: new Map([
            [BUILDER_ROOM, makeThermostat({ since: nowMs + DAY_MS, endsAt: nowMs + 2 * DAY_MS })],
          ]),
        };
        const clamped = clampThermostatState(future, nowMs);
        expect(clamped.rooms.get(BUILDER_ROOM)).toMatchObject({ since: nowMs });
        expect(clamped.valves.get(V)?.sent[0]?.at).toBe(nowMs);
      });
    });
    describe("With an opening whose instants are later than now", () => {
      it("each of them becomes now, and an earlier one is kept", () => {
        const opening = makeOpening({
          startedAt: nowMs - MINUTE_MS,
          temperatureSince: nowMs + DAY_MS,
          temperatureEndedAt: nowMs + DAY_MS,
          suspendedAt: nowMs + DAY_MS,
          limitAt: nowMs + DAY_MS,
          notifiedAt: nowMs + DAY_MS,
          droppedAt: nowMs + DAY_MS,
          endedAt: nowMs + DAY_MS,
        });
        const state: ThermostatState = {
          rooms: new Map(),
          valves: new Map(),
          windows: new Map([[BUILDER_ROOM, opening]]),
        };
        expect(clampThermostatState(state, nowMs).windows.get(BUILDER_ROOM)).toEqual({
          startedAt: nowMs - MINUTE_MS,
          temperatureSince: nowMs,
          temperatureEndedAt: nowMs,
          suspendedAt: nowMs,
          limitAt: nowMs,
          notifiedAt: nowMs,
          droppedAt: nowMs,
          endedAt: nowMs,
        });
      });
    });
    describe("With nothing later than now", () => {
      it("returns the same state", () => {
        const state: ThermostatState = {
          rooms: new Map([[BUILDER_ROOM, apiOverride(22)]]),
          valves: new Map([
            [V, makeExpectation({ sent: [sent(heat(22), nowMs - MINUTE_MS, seen("auto", 19))] })],
          ]),
          windows: new Map(),
        };
        expect(clampThermostatState(state, nowMs)).toBe(state);
      });
    });
  });
});
