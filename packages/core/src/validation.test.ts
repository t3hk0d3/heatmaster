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
import type { Config, ConfigIssue, RawConfig, Room, SensorRef } from "./index.ts";

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

const ROOM = ["rooms", "living_room"] as const;
const SENSORS = [...ROOM, "sensors"] as const;
const WEEK = ["schedules", 0, "week"] as const;
const BLOCK = [...WEEK, 0] as const;
const PLAN = [...BLOCK, "temperature"] as const;
const DAYS = [...BLOCK, "days"] as const;

function onlyRoom(edit: Record<string, unknown>): Record<string, unknown> {
  return patched([...ROOM], { ...(validRaw().rooms?.living_room as object), ...edit });
}

/** The valid document with `rooms` replaced. */
function withRooms(rooms: unknown): Record<string, unknown> {
  return { ...validRaw(), rooms };
}

/** A week whose every day is eco all day. */
const ECO_WEEK = [{ days: "all", temperature: { "00:00": "eco" } }];

const NO_PRESETS = { comfort: undefined, eco: undefined, frost: undefined, boost: undefined };

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
    describe("On {version: 3} alone", () => {
      it("returns a Config equal to EMPTY_CONFIG", () => {
        expect(validateConfig({ version: 3 })).toEqual(EMPTY_CONFIG);
      });
    });

    describe("On a complete valid document", () => {
      it("returns a Config whose rooms, schedules and presets match the document", () => {
        const config = validateConfig(validRaw());
        expect(config.presets).toEqual({ comfort: 21, eco: 18, frost: 8, boost: 24 });
        expect(config.schedules.map((s) => [s.id, s.name])).toEqual([
          ["default", "Default week"],
          ["night", "Night"],
        ]);
        expect(config.schedules[0]?.defaultWeek.mon).toHaveLength(3);
        expect(config.schedules[0]?.defaultWeek.mon[2]).toEqual({
          time: Temporal.PlainTime.from("22:00"),
          preset: undefined,
          temperature: 18,
        });
        expect(config.schedules[0]?.defaultWeek.sat[0]?.preset).toBe("eco");
        expect(config.rooms.get("living_room")).toEqual({
          scheduleId: undefined,
          sensors: [
            { ref: "ha:sensor.bedroom_temperature", weight: 1 },
            { ref: "ha:sensor.living_temperature", weight: 2 },
          ],
          presets: { comfort: 22, eco: undefined, frost: undefined, boost: undefined },
        });
      });

      it('applies defaults: interval 300 000 ms, stale 7 200 000 ms, holdWrites true, language "en", timezone undefined, presets 20/17/7/23, sensor weight 1', () => {
        const raw = {
          version: 3,
          schedules: validRaw().schedules,
          default_schedule: "default",
          rooms: { a: { sensors: [{ ref: "ha:sensor.x" }] } },
        };
        const config = validateConfig(raw);
        expect(config.settings).toEqual({
          externalWriteIntervalMs: 300_000,
          sensorStaleAfterMs: 7_200_000,
          holdWrites: true,
          timezone: undefined,
          language: "en",
          overrideEnd: "next_change",
          overrideDurationMs: 7_200_000,
        });
        expect(config.presets).toEqual({ comfort: 20, eco: 17, frost: 7, boost: 23 });
        expect(config.rooms.get("a")?.sensors[0]?.weight).toBe(1);
      });

      it('turns each "HH:MM" into a Temporal.PlainTime', () => {
        const times = validateConfig(validRaw()).schedules[0]?.defaultWeek.mon.map((p) => p.time);
        expect(times).toEqual(["00:00", "06:30", "22:00"].map((t) => Temporal.PlainTime.from(t)));
        expect(times?.every((t) => t instanceof Temporal.PlainTime)).toBe(true);
      });

      it("keeps a room's partial presets sparse (unset fields are undefined)", () => {
        const presets = validateConfig(validRaw()).rooms.get("living_room")?.presets;
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
        const sensor = validateConfig(validRaw()).rooms.get("living_room")?.sensors[1];
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
      it.each([{}, { version: 4 }, { version: "3" }, { version: null }, { version: 0 }])(
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
        [[...ROOM, "extra"], "rooms.living_room.extra"],
        [[...SENSORS, 0, "extra"], "rooms.living_room.sensors[0].extra"],
        [[...ROOM, "presets", "extra"], "rooms.living_room.presets.extra"],
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
        [[...SENSORS, 0, "ref"], "rooms.living_room.sensors[0].ref"],
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
        ["the default schedule", "default_schedule"],
        ["rooms", "rooms"],
        ["an entry", "rooms.living_room"],
        ["an entry's schedule", "rooms.office.schedule"],
        ["sensors", "rooms.living_room.sensors"],
        ["a sensor ref", "rooms.living_room.sensors[0].ref"],
        ["a weight", "rooms.living_room.sensors[1].weight"],
        ["entry presets", "rooms.living_room.presets"],
      ])("throws ConfigError with code type_invalid (%s)", (_label, path) => {
        const steps = path.match(/[^.[\]]+/g)?.map((s) => (/^\d+$/.test(s) ? Number(s) : s)) ?? [];
        const numeric = [
          "settings.external_write_interval_min",
          "presets.comfort",
          "rooms.living_room.sensors[1].weight",
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

    describe("On weekdays, then [mon, tue, wed], then [thu, fri]", () => {
      it("throws block_unused at the weekdays block, jointly overridden", () => {
        const raw = withWeek([
          { days: "weekdays", temperature: ECO },
          { days: ["mon", "tue", "wed"], temperature: ECO },
          { days: ["thu", "fri"], temperature: ECO },
          { days: "weekend", temperature: ECO },
        ]);
        expectIssue(raw, "block_unused", "schedules[0].week[0]");
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
            "rooms.living_room.presets.comfort",
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

    describe("On duplicate schedule ids", () => {
      it("throws ConfigError with code id_duplicate", () => {
        const doc = validRaw();
        const schedule = doc.schedules?.[0];
        expectIssue({ ...doc, schedules: [schedule, schedule] }, "id_duplicate", "schedules[1].id");
      });
    });

    describe('On an id that is not a lowercase slug of 1–32 characters ("", "Living", "a b", "-a", "a--b", 33 characters)', () => {
      it.each(["", "Living", "a b", "-a", "a--b", "a".repeat(33)])(
        "throws ConfigError with code id_invalid (%j)",
        (id) => {
          expectIssue(patched(["schedules", 0, "id"], id), "id_invalid", "schedules[0].id");
        },
      );

      it.each(["a", "a-b_c", "a".repeat(32), "0"])("accepts %j", (id) => {
        const raw = { ...patched(["schedules", 0, "id"], id), default_schedule: id };
        expect(() => validateConfig(raw)).not.toThrow();
      });
    });

    describe("On a name that is empty, longer than 64 characters or holds control characters", () => {
      it.each(["", "n".repeat(65), "a\nb", "a\u0000b"])(
        "throws ConfigError with code name_invalid (%j)",
        (name) => {
          expectIssue(patched(["schedules", 0, "name"], name), "name_invalid", "schedules[0].name");
        },
      );
    });

    describe("With an entry sensor that is not ha:sensor.<id>", () => {
      it.each([
        "sensor.x",
        "zha:0x00124b0012345678",
        "z2m:0x00124b0087654321",
        "z2m:kitchen",
        "ha:",
      ])("sensor_ref_invalid at its path (%j)", (ref) => {
        expectIssue(
          patched([...SENSORS, 0, "ref"], ref),
          "sensor_ref_invalid",
          "rooms.living_room.sensors[0].ref",
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
            "rooms.living_room.sensors[1].ref",
          );
        },
      );
    });

    describe("On a sensor object that has a key", () => {
      it("throws ConfigError with code key_unknown at the key", () => {
        expectIssue(
          patched([...SENSORS, 1, "key"], "temperature"),
          "key_unknown",
          "rooms.living_room.sensors[1].key",
        );
      });
    });

    describe("With an entry sensor listed twice in an entry", () => {
      it("sensor_duplicate at its path", () => {
        const ha = { ref: "ha:sensor.living_temperature" };
        expectIssue(
          onlyRoom({ sensors: [ha, ha] }),
          "sensor_duplicate",
          "rooms.living_room.sensors[1].ref",
        );
      });
    });

    describe("On the same sensor id in two entries", () => {
      it("returns the Config", () => {
        const room = validRaw().rooms?.living_room;
        expect(validateConfig(withRooms({ living_room: room, other: room })).rooms.size).toBe(2);
      });
    });

    describe("On a sensor weight ≤ 0 or > 10", () => {
      it.each([0, -1, 10.5, 11])("throws ConfigError with code weight_invalid (%j)", (weight) => {
        expectIssue(
          patched([...SENSORS, 1, "weight"], weight),
          "weight_invalid",
          "rooms.living_room.sensors[1].weight",
        );
      });

      it.each([0.1, 10])("accepts %j", (weight) => {
        expect(
          validateConfig(patched([...SENSORS, 1, "weight"], weight)).rooms.get("living_room")
            ?.sensors[1]?.weight,
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
        expectIssue(raw, "sensor_duplicate", "rooms.living_room.sensors[1].ref");
        expectIssue(raw, "weight_invalid", "rooms.living_room.sensors[1].weight");
      });
    });

    describe("On a sensor listed twice that also has an unknown key", () => {
      it("throws key_unknown and sensor_duplicate", () => {
        const ha = { ref: "ha:sensor.living_temperature" };
        const raw = onlyRoom({ sensors: [ha, { ...ha, unexpected: 1 }] });
        expectIssue(raw, "key_unknown", "rooms.living_room.sensors[1].unexpected");
        expectIssue(raw, "sensor_duplicate", "rooms.living_room.sensors[1].ref");
      });
    });

    describe("On a container of the wrong type", () => {
      it.each([
        [[...ROOM], "rooms.living_room"],
        [["schedules", 0], "schedules[0]"],
        [[...BLOCK], "schedules[0].week[0]"],
        [[...SENSORS, 0], "rooms.living_room.sensors[0]"],
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

    describe("On more than 64 schedules or 16 sensors in an entry", () => {
      it("throws ConfigError with code too_many", () => {
        const doc = validRaw();
        const schedule = doc.schedules?.[0] as { id: string };
        const many = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
        expectIssue(
          { ...doc, schedules: many(65).map((i) => ({ ...schedule, id: `s${String(i)}` })) },
          "too_many",
          "schedules",
        );
        expectIssue(
          onlyRoom({ sensors: many(17).map((i) => ({ ref: `ha:sensor.s${String(i)}` })) }),
          "too_many",
          "rooms.living_room.sensors",
        );
      });

      it("accepts exactly 64 entries and 16 sensors", () => {
        const sensors = Array.from({ length: 16 }, (_, i) => ({ ref: `ha:sensor.s${String(i)}` }));
        const rooms = Object.fromEntries(
          Array.from({ length: 64 }, (_, i) => [`area_${String(i)}`, { sensors }]),
        );
        expect(validateConfig(withRooms(rooms)).rooms.get("area_0")?.sensors).toHaveLength(16);
      });
    });

    describe("With a document with several faults", () => {
      it("every issue is listed", () => {
        const doc = validRaw();
        const raw = {
          ...doc,
          settings: { sensor_stale_min: 5, language: "de" },
          default_schedule: "nope",
          rooms: { living_room: { schedule: "nope", valves: [] }, "Living Room": {} },
        };
        expect(issuesOf(raw)).toEqual([
          expect.objectContaining({
            path: "settings.sensor_stale_min",
            code: "setting_out_of_range",
          }),
          expect.objectContaining({ path: "settings.language", code: "language_unsupported" }),
          expect.objectContaining({ path: "default_schedule", code: "schedule_unknown" }),
          expect.objectContaining({ path: "rooms.living_room.valves", code: "key_unknown" }),
          expect.objectContaining({ path: "rooms.living_room.schedule", code: "schedule_unknown" }),
          expect.objectContaining({ path: "rooms.Living Room", code: "area_id_invalid" }),
        ]);
      });
    });

    describe("With validRaw", () => {
      const config = validateConfig(validRaw());

      it("returns a Config whose rooms map holds both entries", () => {
        expect([...config.rooms.keys()]).toEqual(["living_room", "office"]);
        expect(config.rooms.get("office")).toEqual({
          scheduleId: "night",
          sensors: [{ ref: "ha:sensor.office_temperature", weight: 1 }],
          presets: NO_PRESETS,
        });
      });

      it("defaultScheduleId is the schedule default_schedule names", () => {
        expect(config.defaultScheduleId).toBe("default");
      });
    });

    describe("With a version 2 document", () => {
      it('throws ConfigError with one issue, version_unsupported at "version"', () => {
        const v2 = { version: 2, rooms: [{ id: "living", name: "Living", valves: [] }] };
        expect(issuesOf(v2)).toEqual([
          expect.objectContaining({ code: "version_unsupported", path: "version" }),
        ]);
      });
    });

    describe("With a version 1 document", () => {
      it('throws ConfigError with one issue, version_unsupported at "version", whose message names version 3', () => {
        const issues = issuesOf({ ...validRaw(), version: 1 });
        expect(issues).toEqual([
          expect.objectContaining({ code: "version_unsupported", path: "version" }),
        ]);
        expect(issues[0]?.message).toContain("version must be 3");
      });
    });

    describe('With the rooms keys "living_room" and "0f3c9a8e5d2b4c1a9e7f6d5c4b3a2918"', () => {
      it("both are accepted", () => {
        const config = validateConfig(
          withRooms({ living_room: {}, "0f3c9a8e5d2b4c1a9e7f6d5c4b3a2918": {} }),
        );
        expect([...config.rooms.keys()]).toEqual([
          "living_room",
          "0f3c9a8e5d2b4c1a9e7f6d5c4b3a2918",
        ]);
      });
    });

    describe('With each of the rooms keys "Living Room", "living-room" and a key of 65 characters', () => {
      it.each(["Living Room", "living-room", "a".repeat(65)])(
        "area_id_invalid at rooms.<key>, for each (%j)",
        (key) => {
          expectIssue(withRooms({ [key]: {} }), "area_id_invalid", `rooms.${key}`);
        },
      );
    });

    describe("With an entry that is {}", () => {
      it("the entry has no schedule, no sensor and no preset", () => {
        expect(validateConfig(withRooms({ hall: {} })).rooms.get("hall")).toEqual({
          scheduleId: undefined,
          sensors: [],
          presets: NO_PRESETS,
        });
      });
    });

    describe("With an entry naming an unknown schedule", () => {
      it("schedule_unknown at rooms.<key>.schedule", () => {
        expectIssue(
          withRooms({ hall: { schedule: "nope" } }),
          "schedule_unknown",
          "rooms.hall.schedule",
        );
      });
    });

    describe("With schedules and no default_schedule", () => {
      it("key_missing at default_schedule", () => {
        expectIssue(removed(["default_schedule"]), "key_missing", "default_schedule");
      });
    });

    describe("With default_schedule naming an unknown schedule", () => {
      it("schedule_unknown at default_schedule", () => {
        expectIssue(patched(["default_schedule"], "nope"), "schedule_unknown", "default_schedule");
      });
    });

    describe("With no schedule and no default_schedule", () => {
      it("returns a Config with no schedule", () => {
        const config = validateConfig({ version: 3, rooms: { hall: {} } });
        expect(config.schedules).toEqual([]);
        expect(config.defaultScheduleId).toBeUndefined();
      });
    });

    describe("With no schedule and a default_schedule", () => {
      it("schedule_unknown at default_schedule", () => {
        expectIssue(
          { version: 3, default_schedule: "default" },
          "schedule_unknown",
          "default_schedule",
        );
      });
    });

    describe("With an entry holding valves, id, name, area_id or schedule_id", () => {
      it("key_unknown at each of them", () => {
        const entry = {
          valves: [{ id: "z2m:0x00124b0012345678" }],
          id: "living",
          name: "Living room",
          area_id: "living_room",
          schedule_id: "default",
        };
        const issues = issuesOf(withRooms({ living_room: entry }));
        expect(issues).toEqual(
          ["valves", "id", "name", "area_id", "schedule_id"].map((key): unknown =>
            expect.objectContaining({ code: "key_unknown", path: `rooms.living_room.${key}` }),
          ),
        );
      });
    });

    describe('With two schedules named "Night" and "night"', () => {
      it("name_duplicate at the second one's name", () => {
        const raw = {
          version: 3,
          schedules: [
            { id: "a", name: "Night", week: ECO_WEEK },
            { id: "b", name: "night", week: ECO_WEEK },
          ],
          default_schedule: "a",
        };
        expect(issuesOf(raw)).toEqual([
          expect.objectContaining({ code: "name_duplicate", path: "schedules[1].name" }),
        ]);
      });
    });

    describe('With the schedule ids "work-week" and "work_week"', () => {
      it("label_id_duplicate at the second one's id", () => {
        const raw = {
          version: 3,
          schedules: [
            { id: "work-week", name: "Work", week: ECO_WEEK },
            { id: "work_week", name: "Week", week: ECO_WEEK },
          ],
          default_schedule: "work-week",
        };
        expect(issuesOf(raw)).toEqual([
          expect.objectContaining({ code: "label_id_duplicate", path: "schedules[1].id" }),
        ]);
      });
    });

    describe('With the schedule ids "day-2" and "eve_12"', () => {
      it("schedule_id_reserved at each one's id", () => {
        const raw = {
          version: 3,
          schedules: [
            { id: "night", name: "Night", week: ECO_WEEK },
            { id: "day-2", name: "Day", week: ECO_WEEK },
            { id: "eve_12", name: "Evening", week: ECO_WEEK },
          ],
          default_schedule: "night",
        };
        expect(issuesOf(raw)).toEqual([
          expect.objectContaining({ code: "schedule_id_reserved", path: "schedules[1].id" }),
          expect.objectContaining({ code: "schedule_id_reserved", path: "schedules[2].id" }),
        ]);
      });
    });

    describe('With the schedule ids "2", "day2" and "2-day"', () => {
      it("no issue", () => {
        const raw = {
          version: 3,
          schedules: [
            { id: "2", name: "Two", week: ECO_WEEK },
            { id: "day2", name: "Day", week: ECO_WEEK },
            { id: "2-day", name: "Other", week: ECO_WEEK },
          ],
          default_schedule: "2",
        };
        expect(validateConfig(raw).schedules.map((s) => s.id)).toEqual(["2", "day2", "2-day"]);
      });
    });

    describe("With 65 entries", () => {
      it("too_many at rooms", () => {
        const rooms = Object.fromEntries(
          Array.from({ length: 65 }, (_, i) => [`area_${String(i)}`, {}]),
        );
        expectIssue(withRooms(rooms), "too_many", "rooms");
      });
    });
  });

  describe("validateConfig (override end rules)", () => {
    describe('With settings.override_end "timer" and override_duration_min 90', () => {
      const settings = (): Config["settings"] =>
        validateConfig({
          ...validRaw(),
          settings: { override_end: "timer", override_duration_min: 90 },
        }).settings;
      it("settings.overrideEnd is timer and overrideDurationMs is 90 min", () => {
        expect(settings().overrideEnd).toBe("timer");
        expect(settings().overrideDurationMs).toBe(90 * 60 * 1000);
      });
    });
    describe("With neither key", () => {
      it("next_change and 120 min", () => {
        const settings = validateConfig(validRaw()).settings;
        expect(settings.overrideEnd).toBe("next_change");
        expect(settings.overrideDurationMs).toBe(120 * 60 * 1000);
      });
    });
    describe('With override_end "forever"', () => {
      it("issue at settings.override_end", () => {
        expectIssue(
          { ...validRaw(), settings: { override_end: "forever" } },
          "override_end_unsupported",
          "settings.override_end",
        );
      });
    });
    describe("With override_duration_min 10, 1441 or 30.5", () => {
      it.each([10, 1441, 30.5])("issue at settings.override_duration_min (%j)", (minutes) => {
        expectIssue(
          { ...validRaw(), settings: { override_duration_min: minutes } },
          "setting_out_of_range",
          "settings.override_duration_min",
        );
      });
    });
    describe("With a room entry carrying override_end manual", () => {
      it("the entry's overrideEnd is manual and overrideDurationMs undefined", () => {
        const entry = validateConfig(withRooms({ office: { override_end: "manual" } })).rooms.get(
          "office",
        );
        expect(entry?.overrideEnd).toBe("manual");
        expect(entry?.overrideDurationMs).toBeUndefined();
      });
    });
  });

  describe("configToRaw", () => {
    describe("Property: for every arbConfig", () => {
      fcTest.prop([arbConfig])("validateConfig(configToRaw(config)) equals config", (config) => {
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

    describe("With an entry without override keys", () => {
      it("the entry has no override_end or override_duration_min", () => {
        const raw = configToRaw(validateConfig(validRaw()));
        const entry = raw.rooms?.living_room ?? {};
        expect(Object.keys(entry)).not.toContain("override_end");
        expect(Object.keys(entry)).not.toContain("override_duration_min");
      });
    });
    describe("With an entry carrying both override keys", () => {
      it("the entry has both, the duration in whole minutes", () => {
        const config = validateConfig(
          withRooms({ office: { override_end: "timer", override_duration_min: 45 } }),
        );
        expect(configToRaw(config).rooms?.office).toStrictEqual({
          override_end: "timer",
          override_duration_min: 45,
        });
      });
    });
    describe("With the house settings", () => {
      it("the settings carry override_end and override_duration_min always", () => {
        const settings = configToRaw(validateConfig(validRaw())).settings;
        expect(settings?.override_end).toBe("next_change");
        expect(settings?.override_duration_min).toBe(120);
      });
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

    describe("On an entry with partial presets", () => {
      it("the output holds only the fields that were set", () => {
        const raw = configToRaw(validateConfig(validRaw()));
        expect(raw.rooms?.living_room?.presets).toStrictEqual({ comfort: 22 });
      });
    });

    describe("On an entry with sensors", () => {
      it("no sensor has a key", () => {
        const raw = configToRaw(validateConfig(validRaw()));
        for (const sensor of raw.rooms?.living_room?.sensors ?? [])
          expect(sensor).not.toHaveProperty("key");
      });
    });

    describe("For the config of validRaw", () => {
      it("validateConfig of the result equals the config", () => {
        const config = validateConfig(validRaw());
        expect(validateConfig(configToRaw(config))).toEqual(config);
      });
    });

    describe("For a config with an entry that has nothing", () => {
      it("the entry is written as {}", () => {
        const config = validateConfig(withRooms({ hall: {} }));
        expect(configToRaw(config).rooms?.hall).toStrictEqual({});
      });
    });

    describe("For a config with no default schedule", () => {
      it("default_schedule is left out", () => {
        const raw: RawConfig = configToRaw(EMPTY_CONFIG);
        expect(raw).not.toHaveProperty("default_schedule");
      });
    });

    describe("On settings without a timezone", () => {
      it("the output has no timezone key", () => {
        expect(configToRaw(EMPTY_CONFIG).settings).not.toHaveProperty("timezone");
      });
    });
  });

  describe("migrateRaw", () => {
    describe("With a version 3 document", () => {
      it("returns an equal document", () => {
        const doc = validRaw() as unknown as Record<string, unknown>;
        expect(migrateRaw(doc)).toStrictEqual(doc);
        expect(CONFIG_VERSION).toBe(3);
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
      doc.rooms = {};
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
        const config = validateConfig({ ...(upgradeRawV1(doc) as object), version: 3 });
        const week = config.schedules[0]?.defaultWeek;
        expect(week?.mon).toEqual(week?.wed);
        expect(week?.tue.map((p) => p.temperature)).toEqual([17]);
        expect(week?.sun.map((p) => p.preset)).toEqual(["eco", undefined]);
      });

      it("leaves a malformed week as it is so that validation reports it", () => {
        const doc = v1({ mon: "x" });
        const upgraded = upgradeRawV1(doc) as { schedules: [Record<string, unknown>] };
        expect(upgraded.schedules[0]).toHaveProperty("default_week");
        expect(issuesOf({ ...upgraded, version: 3 }).map((i) => i.path)).toContain(
          "schedules[0].default_week",
        );
      });
    });

    describe("With a document of another version", () => {
      it("returns it unchanged", () => {
        const doc = validRaw();
        expect(upgradeRawV1(doc)).toBe(doc);
      });
    });
  });

  describe("effectivePresets", () => {
    const config: Config = validateConfig(validRaw());
    const room: Room = {
      id: "living_room",
      name: "Living room",
      scheduleId: "default",
      valves: [],
      sensors: [],
      presets: { ...NO_PRESETS, comfort: 22 },
      overrideEnd: "next_change",
      overrideDurationMs: 2 * 60 * 60 * 1000,
    };

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
