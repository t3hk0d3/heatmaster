import { test as fcTest } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import {
  BUILDER_NOW,
  arbThermostatState,
  BUILDER_ROOM,
  BUILDER_SCHEDULE,
  BUILDER_VALVE,
  makeManaged,
  makeOpening,
  makeSpec,
  makeThermostat,
  points,
  weekOf,
  windowPatchOf,
} from "../test/builders.ts";
import { ChangeRefused } from "./change.ts";
import type { Effect, World } from "./control.ts";
import { NO_WINDOW_PATCH } from "./house.ts";
import { FRESH_STORED } from "./ledger.ts";
import type { HaChangeItem, StoredConfig } from "./ledger.ts";
import { BOOST_DURATION_MS, DEFAULT_WINDOW_SETTINGS, EMPTY_CONFIG } from "./model.ts";
import type { Config, Presets, Room, RoomEntry, Schedule, SetPoint, Week } from "./model.ts";
import type { ResolvedWeek } from "./schedule.ts";
import {
  EMPTY_THERMOSTAT_STATE,
  clampTarget,
  ended,
  endsAt,
  roomLimits,
  thermostatCommand,
  thermostatStateFromRaw,
  thermostatStateToRaw,
  withRoomChoice,
} from "./thermostat.ts";
import type {
  Origin,
  Thermostat,
  ThermostatCommand,
  ThermostatState,
  ValveExpectation,
} from "./thermostat.ts";
import { MAX_ROOMS } from "./validation.ts";

const MINUTE_MS = 60 * 1000;
const NOW_MS = BUILDER_NOW.epochMilliseconds;
const V2 = "z2m:0x00124b0000000002";
const VALVE_ORIGIN: Origin = { source: "valve", valveId: BUILDER_VALVE };
const API_ORIGIN: Origin = { source: "api", valveId: undefined };
const NO_PRESETS = { comfort: undefined, eco: undefined, frost: undefined, boost: undefined };

// Builders --------------------------------------------------------------------------------------

/** A Monday in Amsterdam, the day of `BUILDER_NOW`, at the given wall time. */
function monday(time: string): Temporal.ZonedDateTime {
  return Temporal.ZonedDateTime.from(`2026-11-16T${time}:00+01:00[Europe/Amsterdam]`);
}

function resolvedWeek(text: string): ResolvedWeek {
  const day = points(text);
  return { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day };
}

function makeRoom(fields: Partial<Room> = {}): Room {
  return {
    id: BUILDER_ROOM,
    name: "Living room",
    scheduleId: BUILDER_SCHEDULE,
    valves: [{ valveId: BUILDER_VALVE }],
    sensors: [],
    presets: NO_PRESETS,
    overrideEnd: "next_change",
    overrideDurationMs: 120 * MINUTE_MS,
    contacts: [],
    window: DEFAULT_WINDOW_SETTINGS,
    ...fields,
  };
}

/**
 * `makeManaged` (one TRVZB unless told otherwise, the builder's day: eco 17 from 00:00, comfort 20
 * from 06:30, eco 17 from 22:00) with the room's entry and the house presets changed as given.
 */
function roomWorld(
  options: {
    model?: "trvzb" | "trv_zbt";
    entry?: Partial<RoomEntry>;
    presets?: Partial<Presets>;
    schedules?: readonly Schedule[];
    thermostats?: ThermostatState | undefined;
    holdWrites?: boolean;
  } = {},
): World {
  const world = makeManaged({
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.holdWrites === undefined ? {} : { holdWrites: options.holdWrites }),
  });
  const stored = world.stored ?? FRESH_STORED;
  const rooms = new Map(stored.config.rooms);
  const entry = rooms.get(BUILDER_ROOM);
  if (entry !== undefined) rooms.set(BUILDER_ROOM, { ...entry, ...options.entry });
  const config: Config = {
    ...stored.config,
    presets: { ...stored.config.presets, ...options.presets },
    schedules: options.schedules ?? stored.config.schedules,
    rooms,
  };
  return {
    ...world,
    stored: { ...stored, config },
    thermostats: "thermostats" in options ? options.thermostats : EMPTY_THERMOSTAT_STATE,
  };
}

/** A state with only the given room's thermostat. */
function overridden(thermostat: Thermostat): ThermostatState {
  return { rooms: new Map([[BUILDER_ROOM, thermostat]]), valves: new Map(), windows: new Map() };
}

function command(world: World, given: ThermostatCommand, origin = API_ORIGIN): readonly Effect[] {
  return thermostatCommand(world, BUILDER_ROOM, given, origin);
}

/** The room's thermostat in the only effect, a `saveThermostats`. */
function savedRoom(effects: readonly Effect[]): Thermostat | undefined {
  const [effect] = effects;
  if (effects.length !== 1 || effect?.kind !== "saveThermostats") {
    throw new Error("expected one saveThermostats");
  }
  return effect.state.rooms.get(BUILDER_ROOM);
}

function refusal(run: () => unknown): ChangeRefused {
  try {
    run();
  } catch (error) {
    if (error instanceof ChangeRefused) return error;
    throw error;
  }
  throw new Error("expected a ChangeRefused");
}

function presetPoint(time: string, preset: "eco" | "comfort"): SetPoint {
  return { time: Temporal.PlainTime.from(time), preset, temperature: undefined };
}

const DEFAULT_WEEK: Week = weekOf([presetPoint("00:00", "eco"), presetPoint("06:30", "comfort")]);
const NIGHT_WEEK: Week = weekOf([presetPoint("00:00", "eco"), presetPoint("19:00", "comfort")]);

/** Two schedules (`default`, the default, and `night`) and an entry for the builder's room. */
function storedWith(entry: Partial<RoomEntry> = {}): StoredConfig {
  const config: Config = {
    ...EMPTY_CONFIG,
    schedules: [
      { id: "default", name: "Default", defaultWeek: DEFAULT_WEEK },
      { id: "night", name: "Night", defaultWeek: NIGHT_WEEK },
    ],
    defaultScheduleId: "default",
    rooms: new Map([
      [
        BUILDER_ROOM,
        {
          scheduleId: undefined,
          sensors: [],
          presets: NO_PRESETS,
          overrideEnd: undefined,
          overrideDurationMs: undefined,
          contacts: [],
          window: NO_WINDOW_PATCH,
          ...entry,
        },
      ],
    ]),
  };
  return { ...FRESH_STORED, config, revision: 4 };
}

function entryOf(stored: StoredConfig, roomId = BUILDER_ROOM): RoomEntry | undefined {
  return stored.config.rooms.get(roomId);
}

/** A raw state with one valve whose `sent` list is given. */
function rawWithSent(sent: readonly unknown[]): unknown {
  return { rooms: {}, valves: { [BUILDER_VALVE]: { room: BUILDER_ROOM, sent } }, windows: {} };
}

function rawSent(mode: string, setpoint: number, at: number): unknown {
  return { mode, setpoint, scheduled: false, at, from: { mode: "auto", setpoint: 20 } };
}

// Tests ------------------------------------------------------------------------------------------

describe("thermostat", () => {
  describe("roomLimits", () => {
    describe("With a TRVZB and a TRV-ZBT", () => {
      it("min 5, max 30", () => {
        expect(roomLimits([makeSpec("trvzb"), makeSpec("trv_zbt")])).toEqual({ min: 5, max: 30 });
      });
    });
    describe("With no spec", () => {
      it("undefined", () => {
        expect(roomLimits([])).toBeUndefined();
      });
    });
  });

  describe("clampTarget", () => {
    describe("With 31.3 in 5–30", () => {
      it("30", () => {
        expect(clampTarget(31.3, { min: 5, max: 30 })).toBe(30);
      });
    });
    describe("With 21.26", () => {
      it("21.5", () => {
        expect(clampTarget(21.26, { min: 5, max: 30 })).toBe(21.5);
      });
    });
  });

  describe("endsAt", () => {
    const week = resolvedWeek("00:00/17 09:00/20 12:00/18");
    describe("With next_change at 07:30 and a next point at 09:00", () => {
      it("09:00", () => {
        const at = endsAt(
          { rule: "next_change", durationMs: undefined },
          makeRoom(),
          week,
          monday("07:30"),
        );
        expect(at).toBe(monday("09:00").epochMilliseconds);
      });
    });
    describe("With timer and no duration, room duration 90 min", () => {
      it("now + 90 min", () => {
        const room = makeRoom({ overrideDurationMs: 90 * MINUTE_MS });
        const now = monday("07:30");
        const at = endsAt({ rule: "timer", durationMs: undefined }, room, week, now);
        expect(at).toBe(now.epochMilliseconds + 90 * MINUTE_MS);
      });
    });
    describe("With timer and duration 45 min", () => {
      it("now + 45 min", () => {
        const now = monday("07:30");
        const at = endsAt({ rule: "timer", durationMs: 45 * MINUTE_MS }, makeRoom(), week, now);
        expect(at).toBe(now.epochMilliseconds + 45 * MINUTE_MS);
      });
    });
    describe("With next_change at 08:55 and points at 09:00 and 12:00", () => {
      it("12:00", () => {
        const at = endsAt(
          { rule: "next_change", durationMs: undefined },
          makeRoom(),
          week,
          monday("08:55"),
        );
        expect(at).toBe(monday("12:00").epochMilliseconds);
      });
    });
    describe("With next_change at 08:45 and points at 09:00 and 12:00", () => {
      it("09:00", () => {
        const at = endsAt(
          { rule: "next_change", durationMs: undefined },
          makeRoom(),
          week,
          monday("08:45"),
        );
        expect(at).toBe(monday("09:00").epochMilliseconds);
      });
    });
    describe("With manual", () => {
      it("undefined", () => {
        const at = endsAt(
          { rule: "manual", durationMs: undefined },
          makeRoom(),
          week,
          monday("07:30"),
        );
        expect(at).toBeUndefined();
      });
    });
  });

  describe("ended", () => {
    describe("With endsAt equal to now", () => {
      it("true", () => {
        expect(ended(makeThermostat({ endsAt: NOW_MS }), NOW_MS)).toBe(true);
      });
    });
    describe("With manual", () => {
      it("false", () => {
        expect(ended(makeThermostat({ rule: "manual", endsAt: undefined }), NOW_MS)).toBe(false);
      });
    });
  });

  describe("thermostatCommand", () => {
    describe("set_target", () => {
      describe("With 22 and no end, room default next_change", () => {
        it("saveThermostats with an override at 22, rule next_change, endsAt the next point, origin as given, since now", () => {
          const world = roomWorld({ entry: { overrideEnd: "next_change" } });
          const effects = command(
            world,
            { kind: "set_target", celsius: 22, end: undefined },
            VALVE_ORIGIN,
          );
          const expected: Thermostat = {
            kind: "override",
            target: 22,
            preset: undefined,
            rule: "next_change",
            endsAt: monday("22:00").epochMilliseconds,
            origin: VALVE_ORIGIN,
            since: NOW_MS,
          };
          expect(effects).toEqual([
            {
              kind: "saveThermostats",
              state: {
                rooms: new Map([[BUILDER_ROOM, expected]]),
                valves: new Map(),
                windows: new Map(),
              },
            },
          ]);
        });
      });
      describe("With 40 in a room limited to 30", () => {
        it("the target is 30", () => {
          const world = roomWorld({ model: "trv_zbt" });
          const effects = command(world, { kind: "set_target", celsius: 40, end: undefined });
          expect(savedRoom(effects)).toMatchObject({ kind: "override", target: 30 });
        });
      });
    });

    describe("set_preset", () => {
      describe("With eco and a room eco preset of 18", () => {
        it("an override at 18 with preset eco", () => {
          const world = roomWorld({ entry: { presets: { ...NO_PRESETS, eco: 18 } } });
          const effects = command(world, { kind: "set_preset", preset: "eco", end: undefined });
          expect(savedRoom(effects)).toMatchObject({ kind: "override", target: 18, preset: "eco" });
        });
      });
      describe("With boost and no end", () => {
        it("rule timer, endsAt now + 30 min", () => {
          const effects = command(roomWorld(), {
            kind: "set_preset",
            preset: "boost",
            end: undefined,
          });
          expect(savedRoom(effects)).toMatchObject({
            rule: "timer",
            endsAt: NOW_MS + BOOST_DURATION_MS,
          });
        });
      });
      describe("With boost and end manual", () => {
        it("rule manual, endsAt undefined", () => {
          const effects = command(roomWorld(), {
            kind: "set_preset",
            preset: "boost",
            end: { rule: "manual", durationMs: undefined },
          });
          const saved = savedRoom(effects);
          expect(saved).toMatchObject({ rule: "manual" });
          expect(saved?.kind === "override" && saved.endsAt).toBeUndefined();
        });
      });
      describe("With 22 again while the room is overridden at 22 with the same rule", () => {
        it("no effects", () => {
          const world = roomWorld({
            entry: { presets: { ...NO_PRESETS, comfort: 22 } },
            thermostats: overridden(
              makeThermostat({ target: 22, preset: "comfort", rule: "next_change" }),
            ),
          });
          expect(command(world, { kind: "set_preset", preset: "comfort", end: undefined })).toEqual(
            [],
          );
        });
      });
      describe("With 23 while the room is overridden at 22", () => {
        it("an override at 23 with since now", () => {
          // Only the target differs: same preset, and the room's default rule is the override's.
          const world = roomWorld({
            entry: { presets: { ...NO_PRESETS, comfort: 23 }, overrideEnd: "next_change" },
            thermostats: overridden(
              makeThermostat({ target: 22, preset: "comfort", rule: "next_change" }),
            ),
          });
          const effects = command(world, { kind: "set_preset", preset: "comfort", end: undefined });
          expect(savedRoom(effects)).toMatchObject({
            kind: "override",
            target: 23,
            since: NOW_MS,
          });
        });
      });
    });

    describe("heat", () => {
      describe("With the room on its schedule at 19", () => {
        it("an override at 19", () => {
          const world = roomWorld({ entry: { presets: { ...NO_PRESETS, comfort: 19 } } });
          expect(savedRoom(command(world, { kind: "heat" }))).toMatchObject({
            kind: "override",
            target: 19,
          });
        });
      });
      describe("With the room already overridden", () => {
        it("no effects", () => {
          const world = roomWorld({ thermostats: overridden(makeThermostat({ target: 24 })) });
          expect(command(world, { kind: "heat" })).toEqual([]);
        });
      });
    });

    describe("off", () => {
      describe("With no end and room default timer 120 min", () => {
        it("off with endsAt now + 120 min", () => {
          const world = roomWorld({
            entry: { overrideEnd: "timer", overrideDurationMs: 120 * MINUTE_MS },
          });
          expect(savedRoom(command(world, { kind: "off", end: undefined }))).toMatchObject({
            kind: "off",
            endsAt: NOW_MS + 120 * MINUTE_MS,
          });
        });
      });
    });

    describe("resume", () => {
      describe("With an override", () => {
        it("saveThermostats without the room", () => {
          const world = roomWorld({ thermostats: overridden(makeThermostat()) });
          expect(command(world, { kind: "resume" })).toEqual([
            { kind: "saveThermostats", state: EMPTY_THERMOSTAT_STATE },
          ]);
        });
      });
      describe("With the room on its schedule", () => {
        it("no effects", () => {
          expect(command(roomWorld(), { kind: "resume" })).toEqual([]);
        });
      });
    });

    describe("With a set_target while an opening holds, resume_heating", () => {
      it("suspends the opening in the same state", () => {
        const opening = makeOpening();
        const world = roomWorld({
          thermostats: { ...EMPTY_THERMOSTAT_STATE, windows: new Map([[BUILDER_ROOM, opening]]) },
        });
        const effects = command(world, { kind: "set_target", celsius: 22, end: undefined });
        const [effect] = effects;
        if (effect?.kind !== "saveThermostats") throw new Error("expected a saveThermostats");
        expect(effects).toHaveLength(1);
        expect(effect.state.rooms.get(BUILDER_ROOM)).toMatchObject({ target: 22 });
        expect(effect.state.windows.get(BUILDER_ROOM)).toEqual({
          ...opening,
          suspendedAt: NOW_MS,
        });
      });
    });
    describe("With a set_target while an opening holds, ignore", () => {
      it("leaves the opening as it is", () => {
        const opening = makeOpening();
        const world = roomWorld({
          entry: {
            window: windowPatchOf({ ...DEFAULT_WINDOW_SETTINGS, manualChange: "ignore" }),
          },
          thermostats: { ...EMPTY_THERMOSTAT_STATE, windows: new Map([[BUILDER_ROOM, opening]]) },
        });
        const effects = command(world, { kind: "set_target", celsius: 22, end: undefined });
        const [effect] = effects;
        if (effect?.kind !== "saveThermostats") throw new Error("expected a saveThermostats");
        expect(effect.state.windows.get(BUILDER_ROOM)).toBe(opening);
      });
    });

    describe("refusals", () => {
      const setTarget: ThermostatCommand = { kind: "set_target", celsius: 22, end: undefined };
      describe("With the config unreadable", () => {
        it("throws ChangeRefused config_unreadable", () => {
          const world: World = { ...roomWorld(), configState: "unreadable" };
          expect(refusal(() => command(world, setTarget)).code).toBe("config_unreadable");
        });
      });
      describe("With thermostats undefined", () => {
        it("throws ChangeRefused state_unreadable", () => {
          const world = roomWorld({ thermostats: undefined });
          expect(refusal(() => command(world, setTarget)).code).toBe("state_unreadable");
        });
      });
      describe("With a room that is not resolved", () => {
        it("throws ChangeRefused room_unknown with the room id", () => {
          const refused = refusal(() =>
            thermostatCommand(roomWorld(), "attic", setTarget, API_ORIGIN),
          );
          expect([refused.code, refused.data]).toEqual(["room_unknown", { roomId: "attic" }]);
        });
      });
      describe("With a room whose schedule has an empty day (no plan)", () => {
        it("throws ChangeRefused room_unknown", () => {
          const day = [presetPoint("00:00", "eco")];
          const schedules: Schedule[] = [
            { id: BUILDER_SCHEDULE, name: "Default", defaultWeek: { ...weekOf(day), sun: [] } },
          ];
          const world = roomWorld({ schedules });
          expect(refusal(() => command(world, setTarget)).code).toBe("room_unknown");
        });
      });
      describe("With writes held", () => {
        it("the effects are the same as with writes released", () => {
          const held = command(roomWorld({ holdWrites: true }), setTarget);
          const released = command(roomWorld({ holdWrites: false }), setTarget);
          expect(held).toEqual(released);
        });
      });
    });
  });

  describe("withRoomChoice", () => {
    describe("schedule", () => {
      describe("With an existing schedule other than the default", () => {
        const stored = storedWith();
        const next = withRoomChoice(
          stored,
          BUILDER_ROOM,
          { kind: "schedule", scheduleId: "night" },
          NOW_MS,
        );
        it("the entry's scheduleId is set", () => {
          expect(entryOf(next)?.scheduleId).toBe("night");
        });
        it("the revision rises by one", () => {
          expect(next.revision).toBe(stored.revision + 1);
        });
        it("haChanges ends with a schedule item", () => {
          const item: HaChangeItem = {
            kind: "schedule",
            areaId: BUILDER_ROOM,
            entityId: undefined,
            scheduleId: "night",
            rule: undefined,
            setting: undefined,
            value: undefined,
          };
          expect(next.haChanges.at(-1)?.items).toEqual([item]);
        });
      });
      describe("With the default schedule", () => {
        it("the entry's scheduleId is cleared", () => {
          const next = withRoomChoice(
            storedWith({ scheduleId: "night" }),
            BUILDER_ROOM,
            { kind: "schedule", scheduleId: "default" },
            NOW_MS,
          );
          expect(entryOf(next)?.scheduleId).toBeUndefined();
        });
      });
      describe("With an unknown schedule id", () => {
        it("throws ChangeRefused schedule_unknown", () => {
          const refused = refusal(() =>
            withRoomChoice(
              storedWith(),
              BUILDER_ROOM,
              { kind: "schedule", scheduleId: "gone" },
              NOW_MS,
            ),
          );
          expect([refused.code, refused.data]).toEqual([
            "schedule_unknown",
            { scheduleId: "gone" },
          ]);
        });
      });
      describe("With a room that has no entry while the config holds the most entries it may", () => {
        it("throws ChangeRefused room_unknown", () => {
          const base = storedWith();
          const rooms = new Map<string, RoomEntry>();
          const entry = entryOf(base);
          if (entry === undefined) throw new Error("no entry");
          for (let i = 0; i < MAX_ROOMS; i++) rooms.set(`area_${String(i)}`, entry);
          const stored: StoredConfig = { ...base, config: { ...base.config, rooms } };
          const refused = refusal(() =>
            withRoomChoice(stored, BUILDER_ROOM, { kind: "schedule", scheduleId: "night" }, NOW_MS),
          );
          expect([refused.code, refused.data]).toEqual(["room_unknown", { roomId: BUILDER_ROOM }]);
        });
      });
      describe("With a room that has no entry", () => {
        it("an entry is created with that schedule", () => {
          const next = withRoomChoice(
            storedWith(),
            "attic",
            { kind: "schedule", scheduleId: "night" },
            NOW_MS,
          );
          expect(entryOf(next, "attic")).toEqual({
            scheduleId: "night",
            sensors: [],
            presets: NO_PRESETS,
            overrideEnd: undefined,
            overrideDurationMs: undefined,
            contacts: [],
            window: NO_WINDOW_PATCH,
          });
        });
      });
    });

    describe("override_end", () => {
      describe("With manual", () => {
        it("the entry's overrideEnd is manual and haChanges ends with an override_end item with rule manual", () => {
          const next = withRoomChoice(
            storedWith(),
            BUILDER_ROOM,
            { kind: "override_end", rule: "manual" },
            NOW_MS,
          );
          const item: HaChangeItem = {
            kind: "override_end",
            areaId: BUILDER_ROOM,
            entityId: undefined,
            scheduleId: undefined,
            rule: "manual",
            setting: undefined,
            value: undefined,
          };
          expect([entryOf(next)?.overrideEnd, next.haChanges.at(-1)?.items]).toEqual([
            "manual",
            [item],
          ]);
        });
      });
      describe("With the rule the entry already has", () => {
        it("returns the same stored config", () => {
          const stored = storedWith({ overrideEnd: "timer" });
          const next = withRoomChoice(
            stored,
            BUILDER_ROOM,
            { kind: "override_end", rule: "timer" },
            NOW_MS,
          );
          expect(next).toBe(stored);
        });
      });
    });
  });

  describe("withRoomChoice, window choices", () => {
    describe("With window_limit none", () => {
      const next = withRoomChoice(
        storedWith(),
        BUILDER_ROOM,
        { kind: "window_limit", limitMs: undefined },
        NOW_MS,
      );
      it("sets the entry's limitMs to none", () => {
        expect(entryOf(next)?.window.limitMs).toBe("none");
      });
      it("records an HA change item window_setting with setting limit_min and value none", () => {
        const item: HaChangeItem = {
          kind: "window_setting",
          areaId: BUILDER_ROOM,
          entityId: undefined,
          scheduleId: undefined,
          rule: undefined,
          setting: "limit_min",
          value: "none",
        };
        expect(next.haChanges.at(-1)?.items).toEqual([item]);
      });
    });
    describe("With window_limit 4 h", () => {
      it("sets the entry's limitMs to 4 h and records the minutes", () => {
        const next = withRoomChoice(
          storedWith(),
          BUILDER_ROOM,
          { kind: "window_limit", limitMs: 4 * 60 * MINUTE_MS },
          NOW_MS,
        );
        expect([entryOf(next)?.window.limitMs, next.haChanges.at(-1)?.items[0]?.value]).toEqual([
          4 * 60 * MINUTE_MS,
          "240",
        ]);
      });
    });
    describe("With window_enabled false for a room with no entry", () => {
      it("creates the entry with window.enabled false", () => {
        const next = withRoomChoice(
          storedWith(),
          "attic",
          { kind: "window_enabled", on: false },
          NOW_MS,
        );
        expect(entryOf(next, "attic")?.window).toEqual({ ...NO_WINDOW_PATCH, enabled: false });
      });
    });
    describe("With window_temperature on", () => {
      it("sets window.temperature.enabled only", () => {
        const next = withRoomChoice(
          storedWith(),
          BUILDER_ROOM,
          { kind: "window_temperature", on: true },
          NOW_MS,
        );
        expect(entryOf(next)?.window).toEqual({
          ...NO_WINDOW_PATCH,
          temperature: { ...NO_WINDOW_PATCH.temperature, enabled: true },
        });
      });
    });
    describe("With window_action off, window_end stopped_falling and window_manual_change ignore", () => {
      it("sets action, temperature.end and manualChange", () => {
        let next = storedWith();
        next = withRoomChoice(next, BUILDER_ROOM, { kind: "window_action", action: "off" }, NOW_MS);
        next = withRoomChoice(
          next,
          BUILDER_ROOM,
          { kind: "window_end", end: "stopped_falling" },
          NOW_MS,
        );
        next = withRoomChoice(
          next,
          BUILDER_ROOM,
          { kind: "window_manual_change", manualChange: "ignore" },
          NOW_MS,
        );
        expect(entryOf(next)?.window).toEqual({
          ...NO_WINDOW_PATCH,
          action: "off",
          temperature: { ...NO_WINDOW_PATCH.temperature, end: "stopped_falling" },
          manualChange: "ignore",
        });
      });
    });
    describe("With a choice equal to the entry's value", () => {
      it("returns stored itself", () => {
        const stored = storedWith({ window: { ...NO_WINDOW_PATCH, action: "off" } });
        const next = withRoomChoice(
          stored,
          BUILDER_ROOM,
          { kind: "window_action", action: "off" },
          NOW_MS,
        );
        expect(next).toBe(stored);
      });
    });
  });

  describe("thermostatStateToRaw", () => {
    describe("With an override whose target is NaN", () => {
      it("throws a RangeError naming the room", () => {
        const state: ThermostatState = {
          rooms: new Map([[BUILDER_ROOM, makeThermostat({ target: Number.NaN })]]),
          valves: new Map(),
          windows: new Map(),
        };
        expect(() => thermostatStateToRaw(state)).toThrow(RangeError);
        expect(() => thermostatStateToRaw(state)).toThrow(BUILDER_ROOM);
      });
    });
    describe("With a valve's saved week holding Infinity", () => {
      it("throws a RangeError naming the valve", () => {
        const expectation: ValveExpectation = {
          roomId: BUILDER_ROOM,
          confirmed: undefined,
          sent: [],
          week: { key: "week-key", values: [17, Number.POSITIVE_INFINITY] },
          written: undefined,
          previous: undefined,
        };
        const state: ThermostatState = {
          rooms: new Map(),
          valves: new Map([[BUILDER_VALVE, expectation]]),
          windows: new Map(),
        };
        expect(() => thermostatStateToRaw(state)).toThrow(RangeError);
        expect(() => thermostatStateToRaw(state)).toThrow(BUILDER_VALVE);
      });
    });
  });

  describe("thermostatStateToRaw / thermostatStateFromRaw", () => {
    describe("With an override from a valve, an off from the api, a valve confirmed auto scheduled with a saved, a written and a previous week and one sent heat 22, and a taken-over valve", () => {
      it("they round-trip", () => {
        const confirmed: ValveExpectation = {
          roomId: BUILDER_ROOM,
          confirmed: { mode: "auto", setpoint: 20, scheduled: true },
          sent: [
            {
              wanted: { mode: "heat", setpoint: 22, scheduled: false },
              at: NOW_MS - MINUTE_MS,
              from: { mode: "auto", setpoint: undefined },
            },
          ],
          week: { key: "week-key", values: [17, 20] },
          written: { key: "week-key", values: [17, 20] },
          previous: { key: "old-key", values: [16, 21] },
        };
        const takenOver: ValveExpectation = {
          roomId: "bedroom",
          confirmed: undefined,
          sent: [],
          week: undefined,
          written: undefined,
          previous: undefined,
        };
        const state: ThermostatState = {
          rooms: new Map<string, Thermostat>([
            [
              BUILDER_ROOM,
              makeThermostat({ target: 21.5, preset: "comfort", origin: VALVE_ORIGIN }),
            ],
            ["bedroom", makeThermostat({ kind: "off", rule: "manual", endsAt: undefined })],
          ]),
          valves: new Map([
            [BUILDER_VALVE, confirmed],
            [V2, takenOver],
          ]),
          windows: new Map(),
        };
        const raw: unknown = JSON.parse(JSON.stringify(thermostatStateToRaw(state)));
        expect(thermostatStateFromRaw(raw)).toEqual(state);
      });
    });
    describe("With no valves key", () => {
      it("valves is an empty map", () => {
        expect(thermostatStateFromRaw({ rooms: {}, windows: {} })?.valves).toEqual(new Map());
      });
    });
    describe("With five sent entries", () => {
      it("the newest four are kept", () => {
        const sent = [18, 19, 20, 21, 22].map((setpoint, i) =>
          rawSent("heat", setpoint, NOW_MS - i * MINUTE_MS),
        );
        const state = thermostatStateFromRaw(rawWithSent(sent));
        const kept = state?.valves.get(BUILDER_VALVE)?.sent.map((write) => write.wanted.setpoint);
        expect(kept).toEqual([18, 19, 20, 21]);
      });
    });
    describe("With a valve without room", () => {
      it("undefined", () => {
        const raw = { rooms: {}, valves: { [BUILDER_VALVE]: { sent: [] } }, windows: {} };
        expect(thermostatStateFromRaw(raw)).toBeUndefined();
      });
    });
    describe("With two sent entries of equal wanted states", () => {
      it("the newer is kept", () => {
        const sent = [rawSent("heat", 22, NOW_MS - 2 * MINUTE_MS), rawSent("heat", 22, NOW_MS)];
        const state = thermostatStateFromRaw(rawWithSent(sent));
        const kept = state?.valves.get(BUILDER_VALVE)?.sent.map((write) => write.at);
        expect(kept).toEqual([NOW_MS]);
      });
    });
    describe('With an entry of kind "boost"', () => {
      it("thermostatStateFromRaw is undefined", () => {
        const raw = {
          rooms: {
            [BUILDER_ROOM]: {
              kind: "boost",
              target: 23,
              rule: "timer",
              origin: { source: "api" },
              since: NOW_MS,
            },
          },
          windows: {},
        };
        expect(thermostatStateFromRaw(raw)).toBeUndefined();
      });
    });
    describe("With an override without target", () => {
      it("undefined", () => {
        const raw = {
          rooms: {
            [BUILDER_ROOM]: {
              kind: "override",
              rule: "manual",
              origin: { source: "api" },
              since: NOW_MS,
            },
          },
          windows: {},
        };
        expect(thermostatStateFromRaw(raw)).toBeUndefined();
      });
    });
    describe("With an unknown key", () => {
      it("undefined", () => {
        expect(
          thermostatStateFromRaw({ rooms: {}, valves: {}, windows: {}, extra: true }),
        ).toBeUndefined();
      });
    });
    describe("With only an empty windows object", () => {
      it("EMPTY_THERMOSTAT_STATE", () => {
        expect(thermostatStateFromRaw({ windows: {} })).toEqual(EMPTY_THERMOSTAT_STATE);
      });
    });
  });

  describe("thermostatStateFromRaw", () => {
    describe("With a windows entry", () => {
      it("reads the opening", () => {
        const raw = {
          rooms: {},
          valves: {},
          windows: {
            [BUILDER_ROOM]: { started_at: NOW_MS - 2 * 60 * MINUTE_MS, limit_at: NOW_MS },
          },
        };
        expect(thermostatStateFromRaw(raw)?.windows).toEqual(
          new Map([
            [
              BUILDER_ROOM,
              makeOpening({ startedAt: NOW_MS - 2 * 60 * MINUTE_MS, limitAt: NOW_MS }),
            ],
          ]),
        );
      });
    });
    describe("With an opening that was notified", () => {
      it("reads notifiedAt", () => {
        const raw = {
          rooms: {},
          valves: {},
          windows: { [BUILDER_ROOM]: { started_at: NOW_MS - MINUTE_MS, notified_at: NOW_MS } },
        };
        expect(thermostatStateFromRaw(raw)?.windows.get(BUILDER_ROOM)?.notifiedAt).toBe(NOW_MS);
      });
    });
    describe("With an opening whose notified_at is -1", () => {
      it("is unreadable", () => {
        const raw = {
          rooms: {},
          valves: {},
          windows: { [BUILDER_ROOM]: { started_at: NOW_MS, notified_at: -1 } },
        };
        expect(thermostatStateFromRaw(raw)).toBeUndefined();
      });
    });
    describe("With windows missing", () => {
      it("is unreadable", () => {
        expect(thermostatStateFromRaw({ rooms: {}, valves: {} })).toBeUndefined();
      });
    });
    describe("With an opening whose started_at is -1", () => {
      it("is unreadable", () => {
        const raw = { rooms: {}, valves: {}, windows: { [BUILDER_ROOM]: { started_at: -1 } } };
        expect(thermostatStateFromRaw(raw)).toBeUndefined();
      });
    });
  });

  describe("thermostatStateToRaw", () => {
    describe("Round trip", () => {
      fcTest.prop([arbThermostatState])(
        "reading what it writes gives the same state (property)",
        (state) => {
          const raw: unknown = JSON.parse(JSON.stringify(thermostatStateToRaw(state)));
          expect(thermostatStateFromRaw(raw)).toEqual(state);
        },
      );
    });
  });
});
