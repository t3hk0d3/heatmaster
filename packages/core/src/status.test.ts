import { DEFAULT_WINDOW_SETTINGS } from "./model.ts";
import { describe, expect, it } from "vitest";
import { points } from "../test/builders.ts";
import { activePoint, type ResolvedWeek } from "./schedule.ts";
import {
  SYSTEM_ID,
  problemConfigUnreadable,
  problemContactLabelUnused,
  problemContactUnavailable,
  problemFeedLost,
  problemHaLabelFailed,
  problemHaLinkRequired,
  problemId,
  problemLabelForeign,
  problemLegacyLabelPresent,
  problemLedgerUnreadable,
  problemPacingUnreadable,
  problemLinkDown,
  problemNoSchedule,
  problemReleaseStalled,
  problemRoomsFrozen,
  problemRoomNoTemperature,
  problemScheduleClamped,
  problemSensorLivenessUnobservable,
  problemSensorLabelUnused,
  problemSensorOutOfRange,
  problemSensorStale,
  problemSensorUnlabellable,
  problemSettingNotHolding,
  problemStateUnreadable,
  problemStoreWriteFailed,
  problemTickFailed,
  problemTransportUnusable,
  problemValveNotInHa,
  problemValveOrphan,
  problemValvePending,
  problemValveSilent,
  problemValveUnsupported,
  problemWindowOpenTooLong,
  roomStatus,
  valveSync,
  type Problem,
  type ProblemKind,
  type Severity,
  type SubjectKind,
  type SyncState,
  type ValveStatus,
  type WindowStatus,
} from "./status.ts";
import type { Membership } from "./ledger.ts";
import type { Room } from "./model.ts";
import type { Freshness, RoomTemperature } from "./temperature.ts";

const V1 = "z2m:0x00124b0012345678";
const SENSOR = "ha:sensor.living";
const AMS = "Europe/Amsterdam";
/** A Monday at 08:00 in Amsterdam. */
const NOW = Temporal.PlainDateTime.from("2026-11-16T08:00").toZonedDateTime(AMS);

const ROOM: Room = {
  id: "living",
  name: "Living room",
  scheduleId: "default",
  valves: [{ valveId: V1 }],
  sensors: [],
  presets: { comfort: undefined, eco: undefined, frost: undefined, boost: undefined },
  overrideEnd: "next_change",
  overrideDurationMs: 2 * 60 * 60 * 1000,
  contacts: [],
  window: DEFAULT_WINDOW_SETTINGS,
};

const DAY = points("00:00/18 06:30/21 22:00/18");
const WEEK: ResolvedWeek = { mon: DAY, tue: DAY, wed: DAY, thu: DAY, fri: DAY, sat: DAY, sun: DAY };

const TEMPERATURE: RoomTemperature = {
  value: 20.4,
  used: [SENSOR],
  stale: [],
  invalid: [],
  pending: [],
};

function valve(over: Partial<ValveStatus> = {}): ValveStatus {
  return {
    valveId: V1,
    name: "Valve",
    membership: "managed",
    liveness: "live",
    mode: undefined,
    setpoint: undefined,
    target: undefined,
    running: undefined,
    sync: "in_sync",
    battery: undefined,
    ...over,
  };
}

/** The room's status while the state file is unreadable, so its mode is the valves'. */
function status(valves: readonly ValveStatus[], fresh: Freshness = "fresh") {
  return roomStatus(ROOM, WEEK, TEMPERATURE, fresh, valves, NOW, undefined, undefined, undefined);
}

describe("status", () => {
  describe("valveSync", () => {
    describe("For each rule, in order", () => {
      it("returns that state", () => {
        const cases: readonly [Membership, boolean, boolean, boolean, boolean, SyncState][] = [
          ["frozen", false, true, false, false, "frozen"],
          ["pending", false, true, false, false, "frozen"],
          ["orphan", false, true, false, false, "frozen"],
          ["managed", true, true, false, false, "held"],
          ["managed", false, false, false, false, "unverified"],
          ["managed", false, true, false, true, "not_holding"],
          ["managed", false, true, true, false, "pending"],
          ["managed", false, true, false, false, "in_sync"],
          ["releasing", false, true, false, false, "in_sync"],
        ];
        for (const [membership, held, verified, pending, notHolding, expected] of cases)
          expect(valveSync(membership, held, verified, pending, notHolding)).toBe(expected);
      });
    });
    describe("With membership frozen and held", () => {
      it("returns frozen", () => {
        expect(valveSync("frozen", true, true, false, false)).toBe("frozen");
      });
    });
    describe("With held and not verified", () => {
      it("returns held", () => {
        expect(valveSync("managed", true, false, false, false)).toBe("held");
      });
    });
    describe("With verified, notHolding and pending", () => {
      it("returns not_holding", () => {
        expect(valveSync("managed", false, true, true, true)).toBe("not_holding");
      });
    });
  });

  describe("roomStatus", () => {
    describe("With valves in_sync and pending", () => {
      it("sync is pending", () => {
        expect(status([valve(), valve({ sync: "pending" })]).sync).toBe("pending");
      });
    });
    describe("With valves held and not_holding", () => {
      it("sync is not_holding", () => {
        expect(status([valve({ sync: "held" }), valve({ sync: "not_holding" })]).sync).toBe(
          "not_holding",
        );
      });
    });
    describe("With valves frozen and in_sync", () => {
      it("sync is frozen", () => {
        expect(status([valve({ sync: "frozen" }), valve()]).sync).toBe("frozen");
      });
    });
    describe("With no valves", () => {
      it("sync is unverified", () => {
        expect(status([]).sync).toBe("unverified");
      });
    });
    describe("With the state unreadable, one valve off and one in auto", () => {
      it("mode is auto", () => {
        expect(status([valve({ mode: "off" }), valve({ mode: "auto" })]).mode).toBe("auto");
      });
    });
    describe("With the state unreadable and every valve off", () => {
      it("mode is off", () => {
        expect(status([valve({ mode: "off" }), valve(), valve({ mode: "off" })]).mode).toBe("off");
      });
    });
    describe("With the state unreadable and no valve showing a mode", () => {
      it("mode is undefined", () => {
        expect(status([valve(), valve()]).mode).toBeUndefined();
      });
    });
    describe("With one valve running and one not", () => {
      it("heating is true", () => {
        expect(status([valve({ running: true }), valve({ running: false })]).heating).toBe(true);
      });
    });
    describe("With every valve that shows it not running", () => {
      it("heating is false", () => {
        expect(status([valve({ running: false }), valve()]).heating).toBe(false);
      });
    });
    describe("With no valve showing its running state", () => {
      it("heating is undefined", () => {
        expect(status([valve(), valve()]).heating).toBeUndefined();
      });
    });
    describe("With a window holding the room's valves and a valve running", () => {
      const window: WindowStatus = {
        state: "open",
        triggers: ["contact"],
        openContacts: ["ha:binary_sensor.window"],
        since: NOW.epochMilliseconds,
        holdsValves: true,
        notes: [],
      };
      const held = roomStatus(
        ROOM,
        WEEK,
        TEMPERATURE,
        "fresh",
        [valve({ running: true })],
        NOW,
        undefined,
        undefined,
        window,
      );
      it("heating is false", () => {
        expect(held.heating).toBe(false);
      });
      it("window is the window's status", () => {
        expect(held.window).toEqual(window);
      });
    });
    describe("With no window", () => {
      it("window is undefined", () => {
        expect(status([valve()]).window).toBeUndefined();
      });
    });
    describe("With freshness no_sensors or stale", () => {
      it("degraded is true", () => {
        expect(status([valve()], "no_sensors").degraded).toBe(true);
        expect(status([valve()], "stale").degraded).toBe(true);
      });
    });
    describe("With freshness pending or fresh", () => {
      it("degraded is false", () => {
        expect(status([valve()], "pending").degraded).toBe(false);
        expect(status([valve()], "fresh").degraded).toBe(false);
      });
    });
    describe("With a room temperature of 20.4", () => {
      it("currentTemperature is 20.4", () => {
        expect(status([]).currentTemperature).toBe(20.4);
      });
    });
    describe("Always", () => {
      it("target, nextChangeAt and nextTarget match activePoint on the room's week", () => {
        const point = activePoint(WEEK, NOW);
        const result = status([]);
        expect(result.roomId).toBe("living");
        expect(result.target).toBe(point.temperature);
        expect(result.nextChangeAt).toBe(point.nextChangeAt);
        expect(result.nextTarget).toBe(point.nextTemperature);
        expect(result.target).toBe(21);
      });
      it("valves holds the given statuses in the given order", () => {
        const valves = [valve({ valveId: "b" }), valve({ valveId: "a" })];
        expect(status(valves).valves).toEqual(valves);
      });
    });
  });

  describe("problem constructors", () => {
    describe("For every ProblemKind", () => {
      it("the kind, severity, subject kind and data keys match the table", () => {
        const table: readonly [Problem, ProblemKind, SubjectKind, Severity, readonly string[]][] = [
          [problemConfigUnreadable(), "config_unreadable", "system", "error", []],
          [problemLedgerUnreadable(), "ledger_unreadable", "system", "error", []],
          [problemPacingUnreadable(), "pacing_unreadable", "system", "warning", []],
          [problemLinkDown("ha"), "link_down", "system", "error", ["link"]],
          [
            problemTransportUnusable("z2m", "bridge_unknown"),
            "transport_unusable",
            "system",
            "error",
            ["reason", "transport"],
          ],
          [problemHaLinkRequired(), "ha_link_required", "system", "error", []],
          [problemRoomsFrozen("link_down"), "rooms_frozen", "system", "warning", ["reason"]],
          [problemNoSchedule(), "no_schedule", "system", "warning", []],
          [
            problemValvePending({
              valveId: V1,
              roomId: "living",
              reason: "originals_unreadable",
              unreadable: ["active_group", "sensor_source"],
            }),
            "valve_pending",
            "valve",
            "warning",
            ["reason", "roomId", "settings"],
          ],
          [problemValveNotInHa(V1), "valve_not_in_ha", "valve", "warning", []],
          [problemValveOrphan(V1), "valve_orphan", "valve", "warning", []],
          [problemValveUnsupported(V1), "valve_unsupported", "valve", "error", []],
          [problemValveSilent(V1), "valve_silent", "valve", "error", []],
          [
            problemSettingNotHolding(V1, "schedule"),
            "setting_not_holding",
            "valve",
            "error",
            ["setting"],
          ],
          [problemReleaseStalled(V1), "release_stalled", "valve", "warning", []],
          [
            problemScheduleClamped(V1, 5, 30),
            "schedule_clamped",
            "valve",
            "warning",
            ["max", "min"],
          ],
          [problemRoomNoTemperature("living"), "room_no_temperature", "room", "warning", []],
          [problemSensorStale(SENSOR), "sensor_stale", "sensor", "warning", []],
          [problemSensorOutOfRange(SENSOR), "sensor_out_of_range", "sensor", "warning", []],
          [
            problemSensorLivenessUnobservable(SENSOR),
            "sensor_liveness_unobservable",
            "sensor",
            "warning",
            [],
          ],
          [problemFeedLost(V1), "feed_lost", "valve", "warning", []],
          [problemStateUnreadable(), "state_unreadable", "system", "error", []],
          [problemStoreWriteFailed("config"), "store_write_failed", "system", "error", ["store"]],
          [problemTickFailed(), "tick_failed", "system", "error", []],
          [
            problemSensorLabelUnused("sensor.office_t", "area_not_room"),
            "sensor_label_unused",
            "sensor",
            "warning",
            ["reason"],
          ],
          [
            problemLegacyLabelPresent("office", ["sensor.a", "sensor.b"]),
            "legacy_label_present",
            "room",
            "warning",
            ["entities"],
          ],
          [
            problemLabelForeign("heatmaster_schedule_day_2"),
            "label_foreign",
            "label",
            "warning",
            [],
          ],
          [
            problemHaLabelFailed({ kind: "deleteLabel", labelId: "heatmaster_schedule_old" }, "x"),
            "ha_label_failed",
            "label",
            "warning",
            ["error", "op"],
          ],
          [
            problemSensorUnlabellable("sensor.office_t"),
            "sensor_unlabellable",
            "sensor",
            "warning",
            [],
          ],
          [
            problemContactLabelUnused("binary_sensor.window", "area_not_room"),
            "contact_label_unused",
            "sensor",
            "warning",
            ["reason"],
          ],
          [
            problemContactUnavailable("ha:binary_sensor.window"),
            "contact_unavailable",
            "sensor",
            "warning",
            [],
          ],
          [problemWindowOpenTooLong("living"), "window_open_too_long", "room", "warning", []],
        ];
        expect(new Set(table.map((row) => row[1])).size).toBe(32);
        for (const [problem, kind, subjectKind, severity, dataKeys] of table) {
          expect(problem.kind).toBe(kind);
          expect(problem.subject.kind).toBe(subjectKind);
          expect(problem.severity).toBe(severity);
          expect(Object.keys(problem.data).sort()).toEqual(dataKeys);
        }
      });
    });
    describe('With problemLinkDown("ha")', () => {
      it('the subject is system with id "ha" and data.link is "ha"', () => {
        const problem = problemLinkDown("ha");
        expect(problem.subject).toEqual({ kind: "system", id: "ha" });
        expect(problem.data.link).toBe("ha");
      });
    });
    describe('With problemTransportUnusable("z2m", "another_instance")', () => {
      it('the subject is system with id "z2m" and data holds transport "z2m" and reason "another_instance"', () => {
        const problem = problemTransportUnusable("z2m", "another_instance");
        expect(problem.subject).toEqual({ kind: "system", id: "z2m" });
        expect(problem.data).toEqual({ transport: "z2m", reason: "another_instance" });
      });
    });
    describe('With problemRoomsFrozen("not_loaded")', () => {
      it('the subject is SYSTEM_ID and data.reason is "not_loaded"', () => {
        const problem = problemRoomsFrozen("not_loaded");
        expect(problem.subject).toEqual({ kind: "system", id: SYSTEM_ID });
        expect(problem.data).toEqual({ reason: "not_loaded" });
      });
    });
    describe("With problemValvePending for a valve whose two originals are unreadable", () => {
      it("the subject is the valve and data holds the reason, the room and the settings", () => {
        const problem = problemValvePending({
          valveId: V1,
          roomId: "living",
          reason: "originals_unreadable",
          unreadable: ["active_group", "sensor_source"],
        });
        expect(problem.subject).toEqual({ kind: "valve", id: V1 });
        expect(problem.data).toEqual({
          reason: "originals_unreadable",
          roomId: "living",
          settings: "active_group,sensor_source",
        });
      });
    });
    describe("With problemConfigUnreadable and problemLedgerUnreadable", () => {
      it("the subject id is SYSTEM_ID", () => {
        expect(SYSTEM_ID).toBe("heatmaster");
        expect(problemConfigUnreadable().subject.id).toBe(SYSTEM_ID);
        expect(problemLedgerUnreadable().subject.id).toBe(SYSTEM_ID);
      });
    });
    describe('With problemSettingNotHolding(valve, "sensor_source")', () => {
      it('data.setting is "sensor_source"', () => {
        expect(problemSettingNotHolding(V1, "sensor_source").data.setting).toBe("sensor_source");
      });
    });
    describe("With problemScheduleClamped(valve, 5, 30) and (valve, 4.5, 30)", () => {
      it('data holds min "5", max "30" and min "4.5", max "30"', () => {
        expect(problemScheduleClamped(V1, 5, 30).data).toEqual({ min: "5", max: "30" });
        expect(problemScheduleClamped(V1, 4.5, 30).data).toEqual({ min: "4.5", max: "30" });
      });
    });
    describe('With a sensor problem for "ha:sensor.living"', () => {
      it("the subject is sensor with that sensor id as its id", () => {
        for (const problem of [
          problemSensorStale(SENSOR),
          problemSensorOutOfRange(SENSOR),
          problemSensorLivenessUnobservable(SENSOR),
        ])
          expect(problem.subject).toEqual({ kind: "sensor", id: SENSOR });
      });
    });
    describe("With problemTickFailed()", () => {
      it("the subject id is SYSTEM_ID and the severity is error", () => {
        const problem = problemTickFailed();
        expect(problem.subject).toEqual({ kind: "system", id: SYSTEM_ID });
        expect(problem.severity).toBe("error");
      });
    });
    describe('With problemStoreWriteFailed("ledger")', () => {
      it('the subject id is SYSTEM_ID, data.store is "ledger" and the severity is error', () => {
        const problem = problemStoreWriteFailed("ledger");
        expect(problem.subject).toEqual({ kind: "system", id: SYSTEM_ID });
        expect(problem.data.store).toBe("ledger");
        expect(problem.severity).toBe("error");
      });
    });
  });

  describe("problemId", () => {
    describe('With problemValveSilent("z2m:0x00124b0012345678")', () => {
      it('returns "valve_silent:valve:z2m:0x00124b0012345678"', () => {
        expect(problemId(problemValveSilent(V1))).toBe("valve_silent:valve:z2m:0x00124b0012345678");
      });
    });
    describe('With problemLinkDown("ha")', () => {
      it('returns "link_down:system:ha"', () => {
        expect(problemId(problemLinkDown("ha"))).toBe("link_down:system:ha");
      });
    });
    describe("With setting_not_holding for schedule and for sensor_source on one valve", () => {
      it("the two ids differ, and each ends with its group", () => {
        const schedule = problemId(problemSettingNotHolding(V1, "schedule"));
        const source = problemId(problemSettingNotHolding(V1, "sensor_source"));
        expect(schedule).not.toBe(source);
        expect(schedule).toBe(`setting_not_holding:valve:${V1}:schedule`);
        expect(source).toBe(`setting_not_holding:valve:${V1}:sensor_source`);
      });
    });
    describe("With store_write_failed for config and for ledger", () => {
      it("the two ids differ", () => {
        expect(problemId(problemStoreWriteFailed("config"))).not.toBe(
          problemId(problemStoreWriteFailed("ledger")),
        );
      });
    });
    describe("For a failed createLabel and a failed renameLabel on one label", () => {
      it("the two problems have different ids", () => {
        const label = "heatmaster_schedule_day";
        const create = problemHaLabelFailed({ kind: "createLabel", name: label }, "timeout");
        const rename = problemHaLabelFailed(
          { kind: "renameLabel", labelId: label, name: "Heatmaster: Day" },
          "timeout",
        );
        expect(create.subject).toEqual(rename.subject);
        expect(problemId(create)).not.toBe(problemId(rename));
      });
    });
    describe("With the same problem built twice", () => {
      it("returns the same id", () => {
        expect(problemId(problemScheduleClamped(V1, 5, 30))).toBe(
          problemId(problemScheduleClamped(V1, 5, 30)),
        );
      });
    });
  });

  describe("problemContactLabelUnused", () => {
    describe('With entity "binary_sensor.window" and reason "contact_limit"', () => {
      it('the subject is the sensor "ha:binary_sensor.window"', () => {
        expect(problemContactLabelUnused("binary_sensor.window", "contact_limit").subject).toEqual({
          kind: "sensor",
          id: "ha:binary_sensor.window",
        });
      });
      it("data.reason is the reason", () => {
        expect(problemContactLabelUnused("binary_sensor.window", "contact_limit").data).toEqual({
          reason: "contact_limit",
        });
      });
    });
  });

  describe("problemContactUnavailable", () => {
    describe('With the contact id "ha:binary_sensor.window"', () => {
      it("the subject is the sensor with that id", () => {
        expect(problemContactUnavailable("ha:binary_sensor.window").subject).toEqual({
          kind: "sensor",
          id: "ha:binary_sensor.window",
        });
      });
    });
  });

  describe("problemWindowOpenTooLong", () => {
    describe('With room "living"', () => {
      it("the subject is the room", () => {
        expect(problemWindowOpenTooLong("living").subject).toEqual({ kind: "room", id: "living" });
      });
    });
  });

  describe("problemSensorUnlabellable", () => {
    describe("For the entity sensor.office_t", () => {
      it("the problem is of kind sensor_unlabellable, warning, with subject ha:sensor.office_t", () => {
        expect(problemSensorUnlabellable("sensor.office_t")).toEqual({
          kind: "sensor_unlabellable",
          subject: { kind: "sensor", id: "ha:sensor.office_t" },
          severity: "warning",
          data: {},
        });
      });
    });
  });

  describe("problemHaLabelFailed", () => {
    describe("For a failed op of each kind", () => {
      it("the subject is the area, the sensor or the label the op names, and data holds op and error", () => {
        const failed = [
          problemHaLabelFailed({ kind: "createLabel", name: "heatmaster_schedule_day" }, "e1"),
          problemHaLabelFailed(
            { kind: "renameLabel", labelId: "heatmaster_schedule_day", name: "Heatmaster: Day" },
            "e2",
          ),
          problemHaLabelFailed({ kind: "deleteLabel", labelId: "heatmaster_schedule_old" }, "e3"),
          problemHaLabelFailed(
            { kind: "labelArea", areaId: "office", add: ["heatmaster_schedule_day"], remove: [] },
            "e4",
          ),
          problemHaLabelFailed(
            {
              kind: "labelEntity",
              entityId: "sensor.office_t",
              add: [],
              remove: ["heatmaster_temp_sensor"],
            },
            "e5",
          ),
        ];
        expect(failed.map((p) => [p.subject, p.data])).toEqual([
          [
            { kind: "label", id: "heatmaster_schedule_day" },
            { op: "createLabel", error: "e1" },
          ],
          [
            { kind: "label", id: "heatmaster_schedule_day" },
            { op: "renameLabel", error: "e2" },
          ],
          [
            { kind: "label", id: "heatmaster_schedule_old" },
            { op: "deleteLabel", error: "e3" },
          ],
          [
            { kind: "area", id: "office" },
            { op: "labelArea", error: "e4" },
          ],
          [
            { kind: "sensor", id: "ha:sensor.office_t" },
            { op: "labelEntity", error: "e5" },
          ],
        ]);
      });
    });
  });

  describe("problemLegacyLabelPresent", () => {
    describe("For room office and two entities", () => {
      it("data.entities joins them with commas", () => {
        expect(problemLegacyLabelPresent("office", ["sensor.a", "sensor.b"]).data).toEqual({
          entities: "sensor.a,sensor.b",
        });
      });
    });
  });

  describe("problems", () => {
    describe("problemStateUnreadable", () => {
      it("kind state_unreadable, subject system, severity error", () => {
        expect(problemStateUnreadable()).toEqual({
          kind: "state_unreadable",
          subject: { kind: "system", id: SYSTEM_ID },
          severity: "error",
          data: {},
        });
      });
    });
  });
});
