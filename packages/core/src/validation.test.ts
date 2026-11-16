import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { arbConfig, validRaw } from "../test/builders.ts";
import {
  CONFIG_VERSION,
  ConfigError,
  EMPTY_CONFIG,
  configToRaw,
  effectivePresets,
  migrateRaw,
  upgradeRawV1,
  sensorId,
  validateConfig,
} from "./index.ts";
import { DEFAULT_SETTINGS } from "./model.ts";
import type { Config, ConfigIssue, Room, SensorRef } from "./index.ts";

type Path = readonly (string | number)[];

/** A copy of the valid document with the value at `path` replaced. */
function patched(path: Path, value: unknown): Record<string, unknown> {
  const doc = structuredClone(validRaw()) as Record<string, unknown>;
  let node: unknown = doc;
  path.slice(0, -1).forEach((step) => {
    node = (node as Record<string | number, unknown>)[step];
  });
  const last = path[path.length - 1];
  if (last === undefined) throw new Error("empty path");
  (node as Record<string | number, unknown>)[last] = value;
  return doc;
}

/** A copy of the valid document with the key at `path` removed. */
function removed(path: Path): Record<string, unknown> {
  const doc = patched(path, 0);
  let node: unknown = doc;
  path.slice(0, -1).forEach((step) => {
    node = (node as Record<string | number, unknown>)[step];
  });
  const last = path[path.length - 1];
  if (last === undefined) throw new Error("empty path");
  Reflect.deleteProperty(node as object, last);
  return doc;
}

function issuesOf(raw: unknown): readonly ConfigIssue[] {
  try {
    validateConfig(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).issues;
  }
  throw new Error("validateConfig did not throw");
}

function codesOf(raw: unknown): readonly string[] {
  return issuesOf(raw).map((issue) => issue.code);
}

function expectIssue(raw: unknown, code: string, path?: string): void {
  const issues = issuesOf(raw);
  expect(issues).toContainEqual(
    expect.objectContaining(path === undefined ? { code } : { code, path }),
  );
}

const ROOM = ["rooms", 0] as const;
const SENSORS = [...ROOM, "sensors"] as const;
const WEEK = ["schedules", 0, "week"] as const;
const BLOCK = [...WEEK, 0] as const;
const PLAN = [...BLOCK, "temperature"] as const;
const DAYS = [...BLOCK, "days"] as const;

function onlyRoom(edit: Record<string, unknown>): Record<string, unknown> {
  return patched([...ROOM], { ...(validRaw().rooms?.[0] as object), ...edit });
}

/** The valid document with the weekday block's day plan replaced. */
function withPlan(plan: unknown): Record<string, unknown> {
  return patched([...PLAN], plan);
}

/** The valid document with the whole week replaced. */
function withWeek(blocks: unknown): Record<string, unknown> {
  return patched([...WEEK], blocks);
}

const ECO = { "00:00": "eco" };

function allPaths(value: unknown, prefix: Path = []): readonly Path[] {
  if (typeof value !== "object" || value === null) return [prefix];
  const entries = Object.entries(value);
  return [
    prefix,
    ...entries.flatMap(([key, item]) =>
      allPaths(item, [...prefix, Array.isArray(value) ? Number(key) : key]),
    ),
  ];
}

describe("validation", () => {
  describe("validateConfig", () => {
    describe("On {version: 2} alone", () => {
      it("returns a Config equal to EMPTY_CONFIG", () => {
        expect(validateConfig({ version: 2 })).toEqual(EMPTY_CONFIG);
      });
    });

    describe("On a complete valid document", () => {
      it("returns a Config whose rooms, schedules and presets match the document", () => {
        const config = validateConfig(validRaw());
        expect(config.presets).toEqual({ comfort: 21, eco: 18, frost: 8, boost: 24 });
        expect(config.schedules.map((s) => [s.id, s.name])).toEqual([["default", "Default week"]]);
        expect(config.schedules[0]?.defaultWeek.mon).toHaveLength(3);
        expect(config.schedules[0]?.defaultWeek.mon[2]).toEqual({
          time: Temporal.PlainTime.from("22:00"),
          preset: undefined,
          temperature: 18,
        });
        expect(config.schedules[0]?.defaultWeek.sat[0]?.preset).toBe("eco");
        expect(config.rooms).toEqual([
          {
            id: "living",
            name: "Living room",
            areaId: "living_room",
            scheduleId: "default",
            valves: [{ valveId: "z2m:0x00124b0012345678" }],
            sensors: [
              { ref: "ha:sensor.bedroom_temperature", weight: 1 },
              { ref: "ha:sensor.living_temperature", weight: 2 },
            ],
            presets: { comfort: 22, eco: undefined, frost: undefined, boost: undefined },
          },
        ]);
      });

      it('applies defaults: interval 300 000 ms, stale 7 200 000 ms, holdWrites true, language "en", timezone undefined, presets 20/17/7/23, sensor weight 1', () => {
        const raw = {
          version: 2,
          schedules: validRaw().schedules,
          rooms: [
            {
              id: "a",
              name: "A",
              schedule_id: "default",
              valves: [{ id: "z2m:0x00124b0012345678" }],
              sensors: [{ ref: "ha:sensor.x" }],
            },
          ],
        };
        const config = validateConfig(raw);
        expect(config.settings).toEqual({
          externalWriteIntervalMs: 300_000,
          sensorStaleAfterMs: 7_200_000,
          holdWrites: true,
          timezone: undefined,
          language: "en",
        });
        expect(config.presets).toEqual({ comfort: 20, eco: 17, frost: 7, boost: 23 });
        expect(config.rooms[0]?.sensors[0]?.weight).toBe(1);
      });

      it('turns each "HH:MM" into a Temporal.PlainTime', () => {
        const times = validateConfig(validRaw()).schedules[0]?.defaultWeek.mon.map((p) => p.time);
        expect(times).toEqual(["00:00", "06:30", "22:00"].map((t) => Temporal.PlainTime.from(t)));
        expect(times?.every((t) => t instanceof Temporal.PlainTime)).toBe(true);
      });

      it("keeps a room's partial presets sparse (unset fields are undefined)", () => {
        const presets = validateConfig(validRaw()).rooms[0]?.presets;
        expect(presets?.comfort).toBe(22);
        expect([presets?.eco, presets?.frost, presets?.boost]).toEqual([
          undefined,
          undefined,
          undefined,
        ]);
      });
    });

    describe("On settings with external_write_interval_min 10 and sensor_stale_min 30", () => {
      it("externalWriteIntervalMs is 600 000 and sensorStaleAfterMs is 1 800 000", () => {
        const settings = validateConfig(validRaw()).settings;
        expect(settings.externalWriteIntervalMs).toBe(600_000);
        expect(settings.sensorStaleAfterMs).toBe(1_800_000);
      });
    });

    describe('On a sensor ref "ha:sensor.<id>"', () => {
      it("the sensor id equals the ref", () => {
        const sensor = validateConfig(validRaw()).rooms[0]?.sensors[1];
        expect(sensor === undefined ? undefined : sensorId(sensor)).toBe(
          "ha:sensor.living_temperature",
        );
      });
    });

    describe("On a value that is not an object (null, a list, a text)", () => {
      it.each([null, [], "text", 3, true, undefined])(
        "throws ConfigError with code type_invalid and an empty path (%j)",
        (value) => {
          expect(issuesOf(value)).toEqual([
            expect.objectContaining({ code: "type_invalid", path: "" }),
          ]);
        },
      );
    });

    describe("On a missing or unsupported version", () => {
      it.each([{}, { version: 3 }, { version: "2" }, { version: null }, { version: 0 }])(
        "throws ConfigError with code version_unsupported (%j)",
        (raw) => {
          expect(codesOf(raw)).toEqual(["version_unsupported"]);
        },
      );
    });

    describe("On an unknown key at any level", () => {
      it.each([
        [["extra"], "extra"],
        [["settings", "extra"], "settings.extra"],
        [["presets", "extra"], "presets.extra"],
        [["schedules", 0, "extra"], "schedules[0].extra"],
        [[...BLOCK, "extra"], "schedules[0].week[0].extra"],
        [[...ROOM, "extra"], "rooms[0].extra"],
        [[...ROOM, "valves", 0, "extra"], "rooms[0].valves[0].extra"],
        [[...SENSORS, 0, "extra"], "rooms[0].sensors[0].extra"],
        [[...ROOM, "presets", "extra"], "rooms[0].presets.extra"],
      ] as const)("throws ConfigError with code key_unknown (%j)", (path, expected) => {
        const raw = path[0] === "extra" ? { ...validRaw(), extra: 1 } : patched(path, 1);
        expectIssue(raw, "key_unknown", expected);
      });
    });

    describe("On a missing required key", () => {
      it.each([
        [["schedules", 0, "id"], "schedules[0].id"],
        [["schedules", 0, "name"], "schedules[0].name"],
        [[...WEEK], "schedules[0].week"],
        [[...DAYS], "schedules[0].week[0].days"],
        [[...PLAN], "schedules[0].week[0].temperature"],
        [[...ROOM, "id"], "rooms[0].id"],
        [[...ROOM, "name"], "rooms[0].name"],
        [[...ROOM, "schedule_id"], "rooms[0].schedule_id"],
        [[...ROOM, "valves"], "rooms[0].valves"],
        [[...ROOM, "valves", 0, "id"], "rooms[0].valves[0].id"],
        [[...SENSORS, 0, "ref"], "rooms[0].sensors[0].ref"],
      ] as const)("throws ConfigError with code key_missing (%j)", (path, expected) => {
        expectIssue(removed(path), "key_missing", expected);
      });
    });

    describe("On a value of the wrong type anywhere", () => {
      it.each([
        ["settings", "settings"],
        ["a text in a number", "settings.external_write_interval_min"],
        ["a text in a flag", "settings.hold_writes"],
        ["a number in a text", "settings.timezone"],
        ["a number in a language", "settings.language"],
        ["a text in a preset", "presets.comfort"],
        ["schedules", "schedules"],
        ["a name", "schedules[0].name"],
        ["a week", "schedules[0].week"],
        ["a block", "schedules[0].week[0]"],
        ["days", "schedules[0].week[0].days"],
        ["a day plan", "schedules[0].week[0].temperature"],
        ["rooms", "rooms"],
        ["a room id", "rooms[0].id"],
        ["an area", "rooms[0].area_id"],
        ["valves", "rooms[0].valves"],
        ["a valve", "rooms[0].valves[0]"],
        ["a sensor ref", "rooms[0].sensors[0].ref"],
        ["a weight", "rooms[0].sensors[1].weight"],
        ["room presets", "rooms[0].presets"],
      ])("throws ConfigError with code type_invalid (%s)", (_label, path) => {
        const steps = path.match(/[^.[\]]+/g)?.map((s) => (/^\d+$/.test(s) ? Number(s) : s)) ?? [];
        const numeric = [
          "settings.external_write_interval_min",
          "presets.comfort",
          "rooms[0].sensors[1].weight",
        ];
        const wrong = numeric.includes(path) ? "x" : 7;
        expectIssue(patched(steps, wrong), "type_invalid", path);
      });

      fcTest.prop([fc.nat(), fc.jsonValue()])(
        "never throws anything but ConfigError, whatever replaces any value",
        (n, value) => {
          const paths = allPaths(validRaw()).filter((p) => p.length > 0);
          const path = paths[n % paths.length] ?? ["version"];
          try {
            validateConfig(patched(path, value));
          } catch (error) {
            expect(error).toBeInstanceOf(ConfigError);
          }
        },
      );
    });

    describe("On a day name or a plan value of the wrong type", () => {
      it("throws type_invalid at that item", () => {
        expectIssue(patched([...DAYS], [7]), "type_invalid", "schedules[0].week[0].days[0]");
        expectIssue(
          withPlan({ "00:00": true }),
          "type_invalid",
          "schedules[0].week[0].temperature.00:00",
        );
      });
    });

    describe("On a time key that is not HH:MM", () => {
      it.each(["7:00", "24:00", "07:60", "07:00:00", "0700", "", " 07:00"])(
        "throws ConfigError with code time_invalid (%j)",
        (time) => {
          const raw = withPlan({ "00:00": "eco", [time]: "comfort" });
          expectIssue(raw, "time_invalid", `schedules[0].week[0].temperature.${time}`);
        },
      );
    });

    describe("On an unquoted time key that YAML read as a number", () => {
      it("a key with a leading zero gets the plain message", () => {
        const raw = withPlan({ "00:00": "eco", "0700": 22 });
        expectIssue(raw, "time_invalid", "schedules[0].week[0].temperature.0700");
        const issue = issuesOf(raw).find((i) => i.code === "time_invalid");
        expect(issue?.message).toBe('a time is "HH:MM"');
      });

      it("throws time_invalid at that key and says to quote the time", () => {
        const raw = withPlan({ "00:00": "eco", "420": 22 });
        expectIssue(raw, "time_invalid", "schedules[0].week[0].temperature.420");
        const issue = issuesOf(raw).find((i) => i.code === "time_invalid");
        expect(issue?.message).toContain("quotes");
      });
    });

    describe("On a plan without 00:00", () => {
      it("throws ConfigError with code first_set_point_not_midnight", () => {
        expectIssue(
          withPlan({ "00:01": "eco" }),
          "first_set_point_not_midnight",
          "schedules[0].week[0].temperature.00:01",
        );
      });
    });

    describe("On times out of order in the file", () => {
      it("sorts the set points by time", () => {
        const config = validateConfig(
          withPlan({ "22:00": 18, "00:00": "eco", "06:30": "comfort" }),
        );
        const times = config.schedules[0]?.defaultWeek.mon.map((p) => p.time.toString());
        expect(times).toEqual(["00:00:00", "06:30:00", "22:00:00"]);
      });
    });

    describe("On a day plan with 0 or 7 set points", () => {
      it("throws ConfigError with code set_point_count", () => {
        expectIssue(withPlan({}), "set_point_count", "schedules[0].week[0].temperature");
        const seven = Object.fromEntries(
          ["00:00", "01:00", "02:00", "03:00", "04:00", "05:00", "06:00"].map((t) => [t, "eco"]),
        );
        expectIssue(withPlan(seven), "set_point_count", "schedules[0].week[0].temperature");
      });
    });

    describe("On a week with blocks covering every day once", () => {
      it("accepts it and gives each day its block's set points, sorted by time", () => {
        const config = validateConfig(
          withWeek([
            { days: ["mon", "tue", "wed", "thu"], temperature: { "07:00": 20, "00:00": 16 } },
            { days: ["fri", "sat", "sun"], temperature: ECO },
          ]),
        );
        const week = config.schedules[0]?.defaultWeek;
        for (const day of ["mon", "tue", "wed", "thu"] as const) {
          expect(week?.[day].map((p) => [p.time.toString(), p.temperature])).toEqual([
            ["00:00:00", 16],
            ["07:00:00", 20],
          ]);
        }
        expect(week?.sun[0]?.preset).toBe("eco");
      });
    });

    describe("On days: weekdays", () => {
      it("gives mon to fri the block's set points", () => {
        const week = validateConfig(validRaw()).schedules[0]?.defaultWeek;
        for (const day of ["mon", "tue", "wed", "thu", "fri"] as const) {
          expect(week?.[day]).toHaveLength(3);
        }
      });
    });

    describe("On days: weekend", () => {
      it("gives sat and sun the block's set points", () => {
        const week = validateConfig(validRaw()).schedules[0]?.defaultWeek;
        expect(week?.sat.map((p) => p.preset)).toEqual(["eco"]);
        expect(week?.sun.map((p) => p.preset)).toEqual(["eco"]);
      });
    });

    describe("On days: all", () => {
      it("gives every day the block's set points", () => {
        const config = validateConfig(withWeek([{ days: "all", temperature: ECO }]));
        const week = config.schedules[0]?.defaultWeek;
        for (const day of ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const) {
          expect(week?.[day].map((p) => p.preset)).toEqual(["eco"]);
        }
      });
    });

    describe("On days: [all]", () => {
      it("throws day_invalid at the list item", () => {
        const rest = { days: ["tue", "wed", "thu", "fri", "sat", "sun"], temperature: ECO };
        expectIssue(
          withWeek([{ days: ["all"], temperature: ECO }, rest]),
          "day_invalid",
          "schedules[0].week[0].days[0]",
        );
      });
    });

    describe("On days: [weekdays, sat] and another block for sun", () => {
      it("throws day_invalid at the list item", () => {
        const raw = withWeek([
          { days: ["weekdays", "sat"], temperature: ECO },
          { days: ["sun"], temperature: ECO },
        ]);
        expectIssue(raw, "day_invalid", "schedules[0].week[0].days[0]");
      });
    });

    describe("On days: mon (a bare day string)", () => {
      it("throws day_invalid at days", () => {
        const raw = withWeek([
          { days: "mon", temperature: ECO },
          { days: ["tue", "wed", "thu", "fri", "sat", "sun"], temperature: ECO },
        ]);
        expectIssue(raw, "day_invalid", "schedules[0].week[0].days");
      });
    });

    describe("On an unknown day word", () => {
      it("throws day_invalid at the list item", () => {
        expectIssue(patched([...DAYS], ["funday"]), "day_invalid", "schedules[0].week[0].days[0]");
      });
    });

    describe("On days: all then days: [fri]", () => {
      it("gives fri the second block's set points and the other days the first", () => {
        const week = validateConfig(
          withWeek([
            { days: "all", temperature: { "00:00": 16, "07:00": 22 } },
            { days: ["fri"], temperature: { "00:00": 18 } },
          ]),
        ).schedules[0]?.defaultWeek;
        expect(week?.fri.map((p) => p.temperature)).toEqual([18]);
        for (const day of ["mon", "tue", "wed", "thu", "sat", "sun"] as const) {
          expect(week?.[day].map((p) => p.temperature)).toEqual([16, 22]);
        }
      });
    });

    describe("On weekdays, then [mon], then weekend", () => {
      it("gives mon the [mon] block, tue to fri weekdays, sat and sun weekend", () => {
        const week = validateConfig(
          withWeek([
            { days: "weekdays", temperature: { "00:00": 16 } },
            { days: ["mon"], temperature: { "00:00": 17 } },
            { days: "weekend", temperature: { "00:00": 18 } },
          ]),
        ).schedules[0]?.defaultWeek;
        const temperatures = (day: "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun") =>
          week?.[day].map((p) => p.temperature);
        expect(temperatures("mon")).toEqual([17]);
        for (const day of ["tue", "wed", "thu", "fri"] as const) {
          expect(temperatures(day)).toEqual([16]);
        }
        expect(temperatures("sat")).toEqual([18]);
        expect(temperatures("sun")).toEqual([18]);
      });
    });

    describe("On a later block naming a day an earlier block also names", () => {
      it("does not throw day_repeated", () => {
        const raw = withWeek([
          { days: "weekdays", temperature: ECO },
          { days: ["fri", "sat", "sun"], temperature: ECO },
        ]);
        expect(() => validateConfig(raw)).not.toThrow();
      });
    });

    describe("On days: [fri] then days: all", () => {
      it("throws block_unused at the [fri] block", () => {
        const raw = withWeek([
          { days: ["fri"], temperature: ECO },
          { days: "all", temperature: ECO },
        ]);
        expectIssue(raw, "block_unused", "schedules[0].week[0]");
        expect(codesOf(raw)).not.toContain("day_repeated");
      });
    });

    describe("On mon listed twice in one list", () => {
      it("throws day_repeated at that block's days", () => {
        const raw = withWeek([
          { days: ["mon", "mon", "tue", "wed", "thu", "fri"], temperature: ECO },
          { days: "weekend", temperature: ECO },
        ]);
        expectIssue(raw, "day_repeated", "schedules[0].week[0].days");
      });
    });

    describe("On a weekday in no block", () => {
      it("throws ConfigError with code day_missing at week", () => {
        const raw = withWeek([
          { days: ["mon", "tue", "thu", "fri"], temperature: ECO },
          { days: "weekend", temperature: ECO },
        ]);
        expectIssue(raw, "day_missing", "schedules[0].week");
        expect(issuesOf(raw).map((i) => i.message)).toContain('missing weekday "wed"');
      });
    });

    describe("On an empty week or an empty days list", () => {
      it("throws an issue at that path", () => {
        expectIssue(withWeek([]), "week_empty", "schedules[0].week");
        expectIssue(patched([...DAYS], []), "days_empty", "schedules[0].week[0].days");
      });
    });

    describe("On a block key other than days and temperature", () => {
      it("throws key_unknown at that key", () => {
        expectIssue(patched([...BLOCK, "plan"], {}), "key_unknown", "schedules[0].week[0].plan");
      });
    });

    describe("On temperature values as a number and as a preset name", () => {
      it("accepts them and resolves the preset", () => {
        const config = validateConfig(withPlan({ "00:00": 16.5, "08:00": "comfort" }));
        expect(config.schedules[0]?.defaultWeek.mon).toEqual([
          { time: Temporal.PlainTime.from("00:00"), preset: undefined, temperature: 16.5 },
          { time: Temporal.PlainTime.from("08:00"), preset: "comfort", temperature: undefined },
        ]);
      });
    });

    describe("On a set point or preset temperature outside 4–35 or not a multiple of 0.5", () => {
      it.each([3.5, 35.5, 20.2, 0, -5])(
        "throws ConfigError with code temperature_invalid (%j)",
        (t) => {
          expectIssue(
            withPlan({ "00:00": t }),
            "temperature_invalid",
            "schedules[0].week[0].temperature.00:00",
          );
          expectIssue(patched(["presets", "eco"], t), "temperature_invalid", "presets.eco");
          expectIssue(
            patched([...ROOM, "presets", "comfort"], t),
            "temperature_invalid",
            "rooms[0].presets.comfort",
          );
        },
      );

      it.each([4, 35, 20.5])("accepts %j", (t) => {
        expect(() => validateConfig(withPlan({ "00:00": t }))).not.toThrow();
      });
    });

    describe("On an unknown preset name", () => {
      it("throws ConfigError with code preset_unknown at that time", () => {
        expectIssue(
          withPlan({ "00:00": "party" }),
          "preset_unknown",
          "schedules[0].week[0].temperature.00:00",
        );
      });
    });

    describe("On a version 1 document", () => {
      it("throws version_unsupported at version and says the week format changed", () => {
        const issues = issuesOf({ ...validRaw(), version: 1 });
        expect(issues).toEqual([
          expect.objectContaining({ code: "version_unsupported", path: "version" }),
        ]);
        expect(issues[0]?.message).toContain("week format changed");
      });
    });

    describe("On duplicate schedule ids or duplicate room ids", () => {
      it("throws ConfigError with code id_duplicate", () => {
        const doc = validRaw();
        const schedule = doc.schedules?.[0];
        const room = doc.rooms?.[0];
        expectIssue({ ...doc, schedules: [schedule, schedule] }, "id_duplicate", "schedules[1].id");
        const second = { ...room, valves: [{ id: "z2m:0x00124b00aaaaaaaa" }] };
        expectIssue({ ...doc, rooms: [room, second] }, "id_duplicate", "rooms[1].id");
      });
    });

    describe('On an id that is not a lowercase slug of 1–32 characters ("", "Living", "a b", "-a", "a--b", 33 characters)', () => {
      it.each(["", "Living", "a b", "-a", "a--b", "a".repeat(33)])(
        "throws ConfigError with code id_invalid (%j)",
        (id) => {
          expectIssue(patched(["schedules", 0, "id"], id), "id_invalid", "schedules[0].id");
          expectIssue(patched([...ROOM, "id"], id), "id_invalid", "rooms[0].id");
        },
      );

      it.each(["a", "a-b_c", "a".repeat(32), "0"])("accepts %j", (id) => {
        expect(() => validateConfig(patched([...ROOM, "id"], id))).not.toThrow();
      });
    });

    describe("On a name that is empty, longer than 64 characters or holds control characters", () => {
      it.each(["", "n".repeat(65), "a\nb", "a\u0000b"])(
        "throws ConfigError with code name_invalid (%j)",
        (name) => {
          expectIssue(patched(["schedules", 0, "name"], name), "name_invalid", "schedules[0].name");
          expectIssue(patched([...ROOM, "name"], name), "name_invalid", "rooms[0].name");
        },
      );
    });

    describe("On a room whose schedule_id matches no schedule", () => {
      it("throws ConfigError with code schedule_unknown", () => {
        expectIssue(
          patched([...ROOM, "schedule_id"], "nope"),
          "schedule_unknown",
          "rooms[0].schedule_id",
        );
      });
    });

    describe("On a room with no valves", () => {
      it("throws ConfigError with code valves_empty", () => {
        expectIssue(patched([...ROOM, "valves"], []), "valves_empty", "rooms[0].valves");
      });
    });

    describe("On the same valve id in two rooms, or twice in one room", () => {
      it("throws ConfigError with code valve_duplicate", () => {
        const doc = validRaw();
        const room = doc.rooms?.[0];
        const other = { ...room, id: "other", valves: [{ id: "z2m:0x00124b0012345678" }] };
        expectIssue({ ...doc, rooms: [room, other] }, "valve_duplicate", "rooms[1].valves[0].id");
        expectIssue(
          onlyRoom({
            valves: [{ id: "z2m:0x00124b0012345678" }, { id: "z2m:0x00124b0012345678" }],
          }),
          "valve_duplicate",
          "rooms[0].valves[1].id",
        );
      });
    });

    describe("On a valve id that is not `<transport>:<address>` with a lowercase transport name", () => {
      it.each(["0x00124b0012345678", "Z2M:0x00124b0012345678", "z2m:", `z2m:${"a".repeat(65)}`])(
        "throws ConfigError with code valve_id_invalid (%j)",
        (id) => {
          expectIssue(
            patched([...ROOM, "valves", 0, "id"], id),
            "valve_id_invalid",
            "rooms[0].valves[0].id",
          );
        },
      );
    });

    describe("On a sensor ref that is not `ha:` with an entity id", () => {
      it.each([
        "sensor.x",
        "zha:0x00124b0012345678",
        "z2m:0x00124b0087654321",
        "z2m:kitchen",
        "ha:",
      ])("throws ConfigError with code sensor_ref_invalid (%j)", (ref) => {
        expectIssue(
          patched([...SENSORS, 0, "ref"], ref),
          "sensor_ref_invalid",
          "rooms[0].sensors[0].ref",
        );
      });
    });

    describe("On an ha sensor whose entity is not in the sensor domain", () => {
      it.each(["ha:binary_sensor.x", "ha:climate.x", "ha:sensor.X", "ha:sensor."])(
        "throws ConfigError with code sensor_ref_invalid (%j)",
        (ref) => {
          expectIssue(
            patched([...SENSORS, 1, "ref"], ref),
            "sensor_ref_invalid",
            "rooms[0].sensors[1].ref",
          );
        },
      );
    });

    describe("On a sensor object that has a key", () => {
      it("throws ConfigError with code key_unknown at the key", () => {
        expectIssue(
          patched([...SENSORS, 1, "key"], "temperature"),
          "key_unknown",
          "rooms[0].sensors[1].key",
        );
      });
    });

    describe("On the same sensor ref twice in one room", () => {
      it("throws ConfigError with code sensor_duplicate", () => {
        const ha = { ref: "ha:sensor.living_temperature" };
        expectIssue(onlyRoom({ sensors: [ha, ha] }), "sensor_duplicate", "rooms[0].sensors[1].ref");
      });
    });

    describe("On the same sensor id in two rooms", () => {
      it("returns the Config", () => {
        const doc = validRaw();
        const room = doc.rooms?.[0];
        const other = { ...room, id: "other", valves: [{ id: "z2m:0x00124b00aaaaaaaa" }] };
        expect(validateConfig({ ...doc, rooms: [room, other] }).rooms).toHaveLength(2);
      });
    });

    describe("On a sensor weight ≤ 0 or > 10", () => {
      it.each([0, -1, 10.5, 11])("throws ConfigError with code weight_invalid (%j)", (weight) => {
        expectIssue(
          patched([...SENSORS, 1, "weight"], weight),
          "weight_invalid",
          "rooms[0].sensors[1].weight",
        );
      });

      it.each([0.1, 10])("accepts %j", (weight) => {
        expect(
          validateConfig(patched([...SENSORS, 1, "weight"], weight)).rooms[0]?.sensors[1]?.weight,
        ).toBe(weight);
      });
    });

    describe("On an interval outside 1–60 min or a stale timeout outside 10–1440 min (9 and 1441 are refused, 10 and 1440 accepted)", () => {
      it.each([0, 61, -1])("refuses an interval of %j with code setting_out_of_range", (value) => {
        expectIssue(
          patched(["settings", "external_write_interval_min"], value),
          "setting_out_of_range",
          "settings.external_write_interval_min",
        );
      });

      it.each([9, 1441, 0])(
        "refuses a stale timeout of %j with code setting_out_of_range",
        (value) => {
          expectIssue(
            patched(["settings", "sensor_stale_min"], value),
            "setting_out_of_range",
            "settings.sensor_stale_min",
          );
        },
      );

      it("accepts 1 and 60 for the interval and 10 and 1440 for the stale timeout", () => {
        for (const value of [1, 60]) {
          expect(
            validateConfig(patched(["settings", "external_write_interval_min"], value)).settings
              .externalWriteIntervalMs,
          ).toBe(value * 60_000);
        }
        for (const value of [10, 1440]) {
          expect(
            validateConfig(patched(["settings", "sensor_stale_min"], value)).settings
              .sensorStaleAfterMs,
          ).toBe(value * 60_000);
        }
      });
    });

    describe("On an interval of 5.5 min or a stale timeout of 30.5 min", () => {
      it("throws ConfigError with code setting_out_of_range", () => {
        expectIssue(
          patched(["settings", "external_write_interval_min"], 5.5),
          "setting_out_of_range",
        );
        expectIssue(patched(["settings", "sensor_stale_min"], 30.5), "setting_out_of_range");
      });
    });

    describe('On a timezone the runtime does not know ("Mars/Olympus", "")', () => {
      it.each(["Mars/Olympus", "", "+01:00"])(
        "throws ConfigError with code timezone_invalid (%j)",
        (zone) => {
          expectIssue(
            patched(["settings", "timezone"], zone),
            "timezone_invalid",
            "settings.timezone",
          );
        },
      );
    });

    describe('On timezone "Europe/Amsterdam"', () => {
      it("returns it unchanged in settings.timezone", () => {
        expect(validateConfig(validRaw()).settings.timezone).toBe("Europe/Amsterdam");
      });
    });

    describe("On a timezone that is not a named zone, or that differs only in case", () => {
      it.each(["2020-01-01T00:00+01:00", "2020-01-01T00:00:00Z[Europe/Amsterdam]"])(
        "throws ConfigError with code timezone_invalid for %j",
        (zone) => {
          expectIssue(
            patched(["settings", "timezone"], zone),
            "timezone_invalid",
            "settings.timezone",
          );
        },
      );

      it.each([
        ["europe/amsterdam", "Europe/Amsterdam"],
        ["utc", "UTC"],
      ])("accepts %j and stores %j", (zone, canonical) => {
        expect(validateConfig(patched(["settings", "timezone"], zone)).settings.timezone).toBe(
          canonical,
        );
      });
    });

    describe("On a sensor listed twice that also has an unrelated fault", () => {
      it("throws sensor_duplicate together with the other issue", () => {
        const ha = { ref: "ha:sensor.living_temperature", weight: 0 };
        const raw = onlyRoom({ sensors: [{ ref: ha.ref }, ha] });
        expectIssue(raw, "sensor_duplicate", "rooms[0].sensors[1].ref");
        expectIssue(raw, "weight_invalid", "rooms[0].sensors[1].weight");
      });
    });

    describe("On a sensor listed twice that also has an unknown key", () => {
      it("throws key_unknown and sensor_duplicate", () => {
        const ha = { ref: "ha:sensor.living_temperature" };
        const raw = onlyRoom({ sensors: [ha, { ...ha, unexpected: 1 }] });
        expectIssue(raw, "key_unknown", "rooms[0].sensors[1].unexpected");
        expectIssue(raw, "sensor_duplicate", "rooms[0].sensors[1].ref");
      });
    });

    describe("On a container of the wrong type", () => {
      it.each([
        [["rooms", 0], "rooms[0]"],
        [["schedules", 0], "schedules[0]"],
        [[...BLOCK], "schedules[0].week[0]"],
        [[...ROOM, "valves", 0], "rooms[0].valves[0]"],
        [[...SENSORS, 0], "rooms[0].sensors[0]"],
      ] as const)("reports only type_invalid at %j", (path, expected) => {
        expect(issuesOf(patched(path, 7))).toEqual([
          expect.objectContaining({ code: "type_invalid", path: expected }),
        ]);
      });
    });

    describe('On a language other than "en" or "ru"', () => {
      it.each(["de", "EN", ""])(
        "throws ConfigError with code language_unsupported (%j)",
        (language) => {
          expectIssue(
            patched(["settings", "language"], language),
            "language_unsupported",
            "settings.language",
          );
        },
      );
    });

    describe("On more than 64 rooms, 64 schedules, 8 valves or 16 sensors in a room", () => {
      it("throws ConfigError with code too_many", () => {
        const doc = validRaw();
        const schedule = doc.schedules?.[0] as { id: string };
        const room = doc.rooms?.[0] as { id: string };
        const many = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
        expectIssue(
          { ...doc, schedules: many(65).map((i) => ({ ...schedule, id: `s${String(i)}` })) },
          "too_many",
          "schedules",
        );
        expectIssue(
          { ...doc, rooms: many(65).map((i) => ({ ...room, id: `r${String(i)}` })) },
          "too_many",
          "rooms",
        );
        expectIssue(
          onlyRoom({
            valves: many(9).map((i) => ({ id: `z2m:0x${String(i).padStart(16, "0")}` })),
          }),
          "too_many",
          "rooms[0].valves",
        );
        expectIssue(
          onlyRoom({ sensors: many(17).map((i) => ({ ref: `ha:sensor.s${String(i)}` })) }),
          "too_many",
          "rooms[0].sensors",
        );
      });

      it("accepts exactly 8 valves and 16 sensors", () => {
        const room = onlyRoom({
          valves: Array.from({ length: 8 }, (_, i) => ({
            id: `z2m:0x${String(i).padStart(16, "0")}`,
          })),
          sensors: Array.from({ length: 16 }, (_, i) => ({ ref: `ha:sensor.s${String(i)}` })),
        });
        expect(validateConfig(room).rooms[0]?.sensors).toHaveLength(16);
      });
    });

    describe("On a document with several faults", () => {
      it("throws one ConfigError listing every issue, each with its path", () => {
        const doc = validRaw();
        const raw = {
          ...doc,
          settings: { sensor_stale_min: 5, language: "de" },
          rooms: [{ ...doc.rooms?.[0], schedule_id: "nope", valves: [] }],
        };
        expect(issuesOf(raw)).toEqual([
          expect.objectContaining({
            path: "settings.sensor_stale_min",
            code: "setting_out_of_range",
          }),
          expect.objectContaining({ path: "settings.language", code: "language_unsupported" }),
          expect.objectContaining({ path: "rooms[0].schedule_id", code: "schedule_unknown" }),
          expect.objectContaining({ path: "rooms[0].valves", code: "valves_empty" }),
        ]);
      });
    });
  });

  describe("configToRaw", () => {
    describe("On any valid Config", () => {
      fcTest.prop([arbConfig])("validateConfig(configToRaw(c)) equals c", (config) => {
        expect(validateConfig(configToRaw(config))).toEqual(config);
      });

      fcTest.prop([arbConfig])(
        "the output survives JSON.stringify and JSON.parse unchanged",
        (config) => {
          const raw = configToRaw(config);
          expect(JSON.parse(JSON.stringify(raw))).toStrictEqual(raw);
        },
      );
    });

    describe("On a week with mon to fri equal and sat and sun equal", () => {
      it("writes two blocks, weekdays and weekend", () => {
        const raw = configToRaw(validateConfig(validRaw()));
        expect(raw.schedules?.[0]?.week).toStrictEqual([
          { days: "weekdays", temperature: { "00:00": "eco", "06:30": "comfort", "22:00": 18 } },
          { days: "weekend", temperature: { "00:00": "eco" } },
        ]);
      });
    });

    describe("On a week built from overrides", () => {
      it("writes disjoint blocks and round-trips unchanged", () => {
        const config = validateConfig(
          withWeek([
            { days: "all", temperature: { "00:00": 16, "07:00": 22 } },
            { days: ["fri"], temperature: { "00:00": 16, "07:00": 22, "23:00": 18 } },
          ]),
        );
        const blocks = configToRaw(config).schedules?.[0]?.week ?? [];
        const days = blocks.flatMap((block) =>
          block.days === "all" ? ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] : block.days,
        );
        expect(new Set(days).size).toBe(days.length);
        expect(validateConfig(configToRaw(config))).toEqual(config);
      });
    });

    describe("On a week with all seven days equal", () => {
      it("writes one block with days: all", () => {
        const raw = configToRaw(validateConfig(withWeek([{ days: "all", temperature: ECO }])));
        expect(raw.schedules?.[0]?.week).toStrictEqual([{ days: "all", temperature: ECO }]);
      });
    });

    describe("On a week with mon and wed equal and the rest different", () => {
      it("writes a block days: [mon, wed], blocks in the order of their first day", () => {
        const plan = (t: number): unknown => ({ "00:00": t });
        const raw = configToRaw(
          validateConfig(
            withWeek([
              { days: ["tue", "thu", "fri", "sat", "sun"], temperature: plan(18) },
              { days: ["mon", "wed"], temperature: plan(20) },
            ]),
          ),
        );
        expect(raw.schedules?.[0]?.week).toStrictEqual([
          { days: ["mon", "wed"], temperature: { "00:00": 20 } },
          { days: ["tue", "thu", "fri", "sat", "sun"], temperature: { "00:00": 18 } },
        ]);
      });
    });

    describe("On a day plan with several set points", () => {
      it("writes the times ascending", () => {
        const raw = configToRaw(
          validateConfig(withPlan({ "22:00": 18, "00:00": "eco", "06:30": "comfort" })),
        );
        expect(Object.keys(raw.schedules?.[0]?.week[0]?.temperature ?? {})).toEqual([
          "00:00",
          "06:30",
          "22:00",
        ]);
      });
    });

    describe("On a room with partial presets", () => {
      it("the output holds only the fields that were set", () => {
        const raw = configToRaw(validateConfig(validRaw()));
        expect(raw.rooms?.[0]?.presets).toStrictEqual({ comfort: 22 });
      });
    });

    describe("On a room with sensors", () => {
      it("no sensor has a key", () => {
        const raw = configToRaw(validateConfig(validRaw()));
        for (const sensor of raw.rooms?.[0]?.sensors ?? [])
          expect(sensor).not.toHaveProperty("key");
      });

      it("the round trip config -> raw -> config leaves the config unchanged", () => {
        const config = validateConfig(validRaw());
        expect(validateConfig(configToRaw(config))).toEqual(config);
      });
    });

    describe("On settings without a timezone", () => {
      it("the output has no timezone key", () => {
        expect(configToRaw(EMPTY_CONFIG).settings).not.toHaveProperty("timezone");
      });
    });
  });

  describe("migrateRaw", () => {
    describe("With a version 2 document", () => {
      it("returns an equal document", () => {
        const doc = validRaw() as unknown as Record<string, unknown>;
        expect(migrateRaw(doc)).toStrictEqual(doc);
        expect(CONFIG_VERSION).toBe(2);
      });
    });
  });

  describe("upgradeRawV1", () => {
    const day = [
      { time: "00:00", preset: "eco" },
      { time: "06:30", temperature: 20 },
    ];
    const weekend = [{ time: "00:00", temperature: 17 }];
    function v1(week: unknown): Record<string, unknown> {
      const doc = structuredClone(validRaw()) as Record<string, unknown>;
      doc.version = 1;
      doc.schedules = [{ id: "default", name: "Default week", default_week: week }];
      return doc;
    }

    describe("With a version 1 document", () => {
      it("groups equal days into blocks and sets version 2", () => {
        const doc = v1({
          mon: day,
          tue: day,
          wed: day,
          thu: day,
          fri: day,
          sat: weekend,
          sun: weekend,
        });
        const upgraded = upgradeRawV1(doc) as Record<string, unknown>;
        expect(upgraded.version).toBe(2);
        expect(upgraded.schedules).toStrictEqual([
          {
            id: "default",
            name: "Default week",
            week: [
              { days: "weekdays", temperature: { "00:00": "eco", "06:30": 20 } },
              { days: "weekend", temperature: { "00:00": 17 } },
            ],
          },
        ]);
      });

      it("keeps every day's set points", () => {
        const doc = v1({
          mon: day,
          tue: weekend,
          wed: day,
          thu: weekend,
          fri: day,
          sat: day,
          sun: day,
        });
        const config = validateConfig(upgradeRawV1(doc));
        const week = config.schedules[0]?.defaultWeek;
        expect(week?.mon).toEqual(week?.wed);
        expect(week?.tue.map((p) => p.temperature)).toEqual([17]);
        expect(week?.sun.map((p) => p.preset)).toEqual(["eco", undefined]);
      });

      it("leaves a malformed week as it is so that validation reports it", () => {
        const doc = v1({ mon: "x" });
        const upgraded = upgradeRawV1(doc) as { schedules: [Record<string, unknown>] };
        expect(upgraded.schedules[0]).toHaveProperty("default_week");
        expect(() => validateConfig(upgraded)).toThrow(ConfigError);
      });
    });

    describe("With a version 2 document", () => {
      it("returns it unchanged", () => {
        const doc = validRaw();
        expect(upgradeRawV1(doc)).toBe(doc);
      });
    });
  });

  describe("effectivePresets", () => {
    const config: Config = validateConfig(validRaw());
    const room = config.rooms[0];
    if (room === undefined) throw new Error("the valid document has a room");

    describe("With a room that sets comfort only", () => {
      it("comfort is the room's value and the other three are the house values", () => {
        expect(effectivePresets(config, room)).toEqual({
          comfort: 22,
          eco: 18,
          frost: 8,
          boost: 24,
        });
      });
    });

    describe("With a room that sets nothing", () => {
      it("equals the house presets", () => {
        const bare: Room = {
          ...room,
          presets: { comfort: undefined, eco: undefined, frost: undefined, boost: undefined },
        };
        expect(effectivePresets(config, bare)).toEqual(config.presets);
      });
    });
  });

  describe("DEFAULT_SETTINGS", () => {
    it("sensorStaleAfterMs is 120 minutes", () => {
      expect(DEFAULT_SETTINGS.sensorStaleAfterMs).toBe(120 * 60 * 1000);
    });
  });

  describe("sensorId", () => {
    describe("With an ha sensor", () => {
      it("returns its ref", () => {
        const sensor: SensorRef = { ref: "ha:sensor.x", weight: 1 };
        expect(sensorId(sensor)).toBe("ha:sensor.x");
      });
    });
  });
});
