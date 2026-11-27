import {
  DEFAULT_WINDOW_SETTINGS,
  EMPTY_CONFIG,
  FRESH_STORED,
  capture,
  findProfile,
} from "@heatmaster/core";
import type {
  ChangePlan,
  DeviceState,
  PlannedWrite,
  Problem,
  RoomStatus,
  ValveStatus,
} from "@heatmaster/core";
import { describe, expect, it } from "vitest";
import type { DeviceSnapshot, RoomSnapshot, SensorSnapshot, Snapshot } from "./runtime.ts";
import { planView, stateView } from "./views.ts";

const A = "z2m:0xa1";
const B = "z2m:0xb2";
const C = "z2m:0xc3";

function device(id: string, over: Partial<DeviceSnapshot> = {}): DeviceSnapshot {
  return {
    deviceId: id,
    transport: "z2m",
    name: `valve ${id.slice(4)}`,
    modelId: "TRVZB",
    manufacturer: "SONOFF",
    firmware: "1.0",
    supported: true,
    membership: undefined,
    liveness: "live",
    observed: true,
    heardAt: 1000,
    ...over,
  };
}

function valveStatus(id: string, over: Partial<ValveStatus> = {}): ValveStatus {
  return {
    valveId: id,
    name: `valve ${id.slice(4)}`,
    membership: "managed",
    liveness: "live",
    mode: "auto",
    setpoint: 20,
    target: 21,
    running: true,
    sync: "in_sync",
    battery: 88,
    ...over,
  };
}

function status(roomId: string, valves: readonly ValveStatus[], over: Partial<RoomStatus> = {}) {
  return {
    roomId,
    currentTemperature: 19.5,
    target: 21,
    nextChangeAt: Date.UTC(2026, 10, 16, 18, 0, 0),
    nextTarget: 17,
    mode: "auto",
    heating: true,
    sync: "in_sync",
    degraded: false,
    thermostat: { kind: "schedule" },
    limits: { min: 4, max: 35 },
    overrideEnd: "next_change",
    overrideDurationMs: 2 * 60 * 60 * 1000,
    window: undefined,
    valves,
    ...over,
  } satisfies RoomStatus;
}

function room(roomId: string, over: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    roomId,
    name: `Room ${roomId}`,
    managed: true,
    scheduleId: undefined,
    scheduleName: undefined,
    valveIds: [],
    sensorIds: [],
    window: undefined,
    status: undefined,
    ...over,
  };
}

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    revision: 3,
    configState: "ok",
    house: "live",
    houseFrozenReason: undefined,
    ledgerReadable: true,
    originalsCopyRecords: 0,
    held: false,
    language: "ru",
    timeZone: "Europe/Amsterdam",
    tickedAt: 1,
    rooms: [],
    unusedEntries: [],
    haChanges: [],
    upgrade: undefined,
    problems: [],
    memberships: {},
    stranded: [],
    devices: [],
    unassigned: [],
    pending: [],
    sensors: [],
    links: { z2m: true },
    transportFaults: {},
    areaNames: {},
    schedules: [],
    ...over,
  };
}

function problem(kind: Problem["kind"], subject: Problem["subject"]): Problem {
  return { kind, subject, severity: "warning", data: { note: "x" } };
}

function oneRoom(): Snapshot {
  return snapshot({
    rooms: [
      room("living", {
        valveIds: [A],
        sensorIds: ["ha:sensor.living"],
        status: status("living", [valveStatus(A)]),
      }),
    ],
    memberships: { [A]: "managed" },
    devices: [device(A, { membership: "managed" })],
  });
}

function viewOf(over: Partial<Snapshot>) {
  return stateView(snapshot(over));
}

describe("views", () => {
  describe("stateView", () => {
    describe("With one room holding one managed valve", () => {
      it("the room has its id, name, the status fields and the valve's id in valveIds", () => {
        expect(stateView(oneRoom()).rooms).toEqual([
          {
            roomId: "living",
            name: "Room living",
            managed: true,
            currentTemperature: 19.5,
            target: 21,
            nextChangeAt: Date.UTC(2026, 10, 16, 18, 0, 0),
            nextTarget: 17,
            mode: "auto",
            heating: true,
            sync: "in_sync",
            degraded: false,
            hasProblem: false,
            valveIds: [A],
            thermostat: { kind: "schedule" },
            minTemp: 4,
            maxTemp: 35,
            overrideEnd: "next_change",
            overrideDurationMs: 2 * 60 * 60 * 1000,
          },
        ]);
      });

      it("the valve has its name, modelId, roomId, membership managed, liveness, sync and battery", () => {
        expect(stateView(oneRoom()).valves).toEqual([
          {
            valveId: A,
            name: "valve 0xa1",
            modelId: "TRVZB",
            supported: true,
            roomId: "living",
            membership: "managed",
            liveness: "live",
            mode: "auto",
            setpoint: 20,
            target: 21,
            sync: "in_sync",
            battery: 88,
          },
        ]);
      });
    });

    describe("With a room status holding a window opening", () => {
      it("includes window with state open and the open contacts", () => {
        const opening = {
          state: "open",
          triggers: ["contact"],
          openContacts: ["ha:binary_sensor.window"],
          since: 5000,
          holdsValves: true,
        } as const;
        const view = viewOf({
          rooms: [
            room("living", {
              valveIds: [A],
              status: status("living", [valveStatus(A)], { window: opening }),
            }),
          ],
        });
        expect(view.rooms[0]?.window).toEqual(opening);
      });
    });

    describe("With no opening", () => {
      it("leaves window out", () => {
        expect(Object.hasOwn(stateView(oneRoom()).rooms[0] ?? {}, "window")).toBe(false);
      });
    });

    describe("For every managed room", () => {
      it("includes windowSettings with the merged values", () => {
        const view = viewOf({
          rooms: [
            room("living", { window: { ...DEFAULT_WINDOW_SETTINGS, limitMs: 90 * 60 * 1000 } }),
            room("hall", { window: { ...DEFAULT_WINDOW_SETTINGS, limitMs: undefined } }),
          ],
        });
        expect(view.rooms[0]?.windowSettings).toEqual({
          ...DEFAULT_WINDOW_SETTINGS,
          limitMs: 90 * 60 * 1000,
        });
        expect(view.rooms[1]?.windowSettings?.limitMs).toBeNull();
      });
    });

    describe("With two rooms and three valves given in any order", () => {
      it("rooms are in config order and valves are sorted by id", () => {
        const view = viewOf({
          rooms: [
            room("zeta", { valveIds: [C], status: status("zeta", [valveStatus(C)]) }),
            room("alpha", {
              valveIds: [B, A],
              status: status("alpha", [valveStatus(B), valveStatus(A)]),
            }),
          ],
          memberships: { [C]: "managed", [B]: "managed", [A]: "managed" },
          devices: [device(C), device(B), device(A)],
        });
        expect(view.rooms.map((r) => r.roomId)).toEqual(["zeta", "alpha"]);
        expect(view.valves.map((v) => v.valveId)).toEqual([A, B, C]);
      });
    });

    describe("With a supported device that is in no room and has no ledger record", () => {
      it("it is listed with supported true and without roomId and membership", () => {
        const [valve] = viewOf({ devices: [device(A)] }).valves;
        expect(valve).toEqual({
          valveId: A,
          name: "valve 0xa1",
          modelId: "TRVZB",
          supported: true,
        });
        expect(Object.hasOwn(valve ?? {}, "roomId")).toBe(false);
        expect(Object.hasOwn(valve ?? {}, "membership")).toBe(false);
      });
    });

    describe("With a device that has no valve profile", () => {
      it("it is not listed in valves", () => {
        expect(
          viewOf({ devices: [device(A, { supported: false, modelId: "SNZB-02" })] }).valves,
        ).toEqual([]);
      });
    });

    describe("With an orphan valve", () => {
      it("it is listed with membership orphan and without liveness and sync", () => {
        const [valve] = viewOf({
          memberships: { [A]: "orphan" },
          devices: [device(A, { membership: "orphan" })],
        }).valves;
        expect(valve?.membership).toBe("orphan");
        expect(Object.hasOwn(valve ?? {}, "liveness")).toBe(false);
        expect(Object.hasOwn(valve ?? {}, "sync")).toBe(false);
      });
    });

    describe("With a stranded valve", () => {
      it("it has stranded true, and a valve that is not stranded has no stranded key", () => {
        const view = viewOf({
          rooms: [room("living", { valveIds: [A, B] })],
          memberships: { [A]: "managed", [B]: "managed" },
          stranded: [A],
          devices: [device(B, { membership: "managed" })],
        });
        expect(view.valves.find((v) => v.valveId === A)?.stranded).toBe(true);
        expect(Object.hasOwn(view.valves.find((v) => v.valveId === B) ?? {}, "stranded")).toBe(
          false,
        );
      });
    });

    describe("With a room valve that has no device", () => {
      it("its name is its id and supported is false", () => {
        const [valve] = viewOf({
          rooms: [room("living", { valveIds: [A], status: status("living", [valveStatus(A)]) })],
          memberships: { [A]: "managed" },
        }).valves;
        expect(valve).toMatchObject({ valveId: A, name: A, supported: false });
        expect(Object.hasOwn(valve ?? {}, "modelId")).toBe(false);
      });
    });

    describe("With a room whose temperature and target are unknown", () => {
      it("currentTemperature and target are left out", () => {
        const [view] = viewOf({
          rooms: [
            room("living", {
              status: status("living", [], { currentTemperature: undefined, target: undefined }),
            }),
          ],
        }).rooms;
        expect(Object.hasOwn(view ?? {}, "currentTemperature")).toBe(false);
        expect(Object.hasOwn(view ?? {}, "target")).toBe(false);
      });
    });

    describe("With a managed room on the schedule main named Main", () => {
      it("managed is true and scheduleId and scheduleName are set", () => {
        const [view] = viewOf({
          rooms: [room("living", { scheduleId: "main", scheduleName: "Main" })],
        }).rooms;
        expect(view).toMatchObject({ managed: true, scheduleId: "main", scheduleName: "Main" });
      });
    });

    describe("With a room that is not managed and has no schedule", () => {
      it("managed is false and scheduleId and scheduleName are left out", () => {
        const [view] = viewOf({ rooms: [room("living", { managed: false })] }).rooms;
        expect(view?.managed).toBe(false);
        expect(Object.hasOwn(view ?? {}, "scheduleId")).toBe(false);
        expect(Object.hasOwn(view ?? {}, "scheduleName")).toBe(false);
      });
    });

    describe("With a room overridden at 22 by valve z2m:0x1 until 18:00", () => {
      const endsAt = Date.UTC(2026, 10, 16, 18, 0, 0);
      const since = Date.UTC(2026, 10, 16, 16, 0, 0);
      const overridden = (): Snapshot =>
        snapshot({
          rooms: [
            room("living", {
              status: status("living", [], {
                thermostat: {
                  kind: "override",
                  target: 22,
                  preset: undefined,
                  rule: "next_change",
                  endsAt,
                  origin: { source: "valve", valveId: "z2m:0x1" },
                  since,
                },
              }),
            }),
          ],
        });

      it("thermostat holds kind override, target 22, rule, endsAt, origin source valve with valveId", () => {
        const [view] = stateView(overridden()).rooms;
        expect(view?.thermostat).toEqual({
          kind: "override",
          target: 22,
          rule: "next_change",
          endsAt,
          origin: { source: "valve", valveId: "z2m:0x1" },
          since,
        });
      });
    });

    describe("With a room on its schedule", () => {
      it('thermostat is { kind: "schedule" }', () => {
        const [view] = viewOf({
          rooms: [room("living", { status: status("living", []) })],
        }).rooms;
        expect(view?.thermostat).toEqual({ kind: "schedule" });
      });
    });

    describe("With the state unreadable", () => {
      it("the room has no thermostat key", () => {
        const [view] = viewOf({
          rooms: [room("living", { status: status("living", [], { thermostat: undefined }) })],
        }).rooms;
        expect(Object.hasOwn(view ?? {}, "thermostat")).toBe(false);
      });
    });

    describe("With a room status that has limits and end settings", () => {
      it("minTemp, maxTemp, overrideEnd and overrideDurationMs come from the room status", () => {
        const [view] = viewOf({
          rooms: [
            room("living", {
              status: status("living", [], {
                limits: { min: 5, max: 30 },
                overrideEnd: "timer",
                overrideDurationMs: 5400000,
              }),
            }),
          ],
        }).rooms;
        expect(view).toMatchObject({
          minTemp: 5,
          maxTemp: 30,
          overrideEnd: "timer",
          overrideDurationMs: 5400000,
        });
      });
    });

    describe("With two schedules", () => {
      it("schedules lists both with id and name, in config order", () => {
        const view = viewOf({
          schedules: [
            { id: "weekday", name: "Weekdays" },
            { id: "away", name: "Away" },
          ],
        });
        expect(view.schedules).toEqual([
          { id: "weekday", name: "Weekdays" },
          { id: "away", name: "Away" },
        ]);
      });
    });

    describe("With a live house", () => {
      it("house is live and frozenReason is left out", () => {
        const view = viewOf({ house: "live" });
        expect(view.house).toBe("live");
        expect(Object.hasOwn(view, "frozenReason")).toBe(false);
      });
    });

    describe("With a house frozen because the link is down", () => {
      it("house is frozen and frozenReason is link_down", () => {
        const view = viewOf({ house: "frozen", houseFrozenReason: "link_down" });
        expect(view).toMatchObject({ house: "frozen", frozenReason: "link_down" });
      });
    });

    describe("With the unused entries attic and shed", () => {
      it("unusedEntries lists them in that order", () => {
        expect(viewOf({ unusedEntries: ["attic", "shed"] }).unusedEntries).toEqual([
          "attic",
          "shed",
        ]);
      });
    });

    describe("With an HA change of two items", () => {
      it("haChanges holds it with camelCase keys, at in epoch ms and only the item keys that are set", () => {
        const at = Date.UTC(2026, 10, 16, 9, 0, 0);
        const view = viewOf({
          haChanges: [
            {
              revision: 7,
              at,
              items: [
                {
                  kind: "schedule",
                  areaId: "office",
                  entityId: undefined,
                  scheduleId: "night",
                  rule: undefined,
                  setting: undefined,
                  value: undefined,
                },
                {
                  kind: "sensor_added",
                  areaId: "office",
                  entityId: "sensor.office",
                  scheduleId: undefined,
                  rule: undefined,
                  setting: undefined,
                  value: undefined,
                },
              ],
            },
          ],
        });
        expect(view.haChanges).toEqual([
          {
            revision: 7,
            at,
            items: [
              { kind: "schedule", areaId: "office", scheduleId: "night" },
              { kind: "sensor_added", areaId: "office", entityId: "sensor.office" },
            ],
          },
        ]);
      });
    });

    describe("With an haChanges item of kind override_end with rule timer", () => {
      it("the item view carries kind override_end and rule timer", () => {
        const view = viewOf({
          haChanges: [
            {
              revision: 8,
              at: Date.UTC(2026, 10, 16, 9, 0, 0),
              items: [
                {
                  kind: "override_end",
                  areaId: "office",
                  entityId: undefined,
                  scheduleId: undefined,
                  rule: "timer",
                  setting: undefined,
                  value: undefined,
                },
              ],
            },
          ],
        });
        expect(view.haChanges[0]?.items).toEqual([
          { kind: "override_end", areaId: "office", rule: "timer" },
        ]);
      });
    });

    describe("With an upgrade report", () => {
      it("upgrade holds the old version and the dropped rooms in camelCase", () => {
        const view = viewOf({
          upgrade: {
            fromVersion: 2,
            droppedRooms: [{ roomId: "hall", name: "Hall", valveIds: [A], reason: "no_area" }],
          },
        });
        expect(view.upgrade).toEqual({
          fromVersion: 2,
          droppedRooms: [{ roomId: "hall", name: "Hall", valveIds: [A], reason: "no_area" }],
        });
      });
    });

    describe("Without an upgrade report", () => {
      it("upgrade is left out", () => {
        expect(Object.hasOwn(viewOf({}), "upgrade")).toBe(false);
      });
    });

    describe("With a pending valve", () => {
      it("pending lists it with its name, room and reason", () => {
        const view = viewOf({
          devices: [device(A)],
          pending: [
            { valveId: A, roomId: "office", reason: "valve_not_observed", unreadable: [] },
            {
              valveId: "z2m:0xff",
              roomId: "attic",
              reason: "originals_unreadable",
              unreadable: ["sensor_source"],
            },
          ],
        });
        expect(view.pending).toEqual([
          {
            valveId: A,
            name: "valve 0xa1",
            roomId: "office",
            reason: "valve_not_observed",
            unreadable: [],
          },
          {
            valveId: "z2m:0xff",
            name: "z2m:0xff",
            roomId: "attic",
            reason: "originals_unreadable",
            unreadable: ["sensor_source"],
          },
        ]);
      });
    });

    describe("With an unassigned valve whose device has no area", () => {
      it("its reason is no_area", () => {
        const view = viewOf({
          devices: [device(A)],
          unassigned: [
            {
              valveId: A,
              name: "valve 0xa1",
              observed: true,
              liveness: "live",
              heardAt: 5000,
              values: {},
              reason: "no_area",
            },
          ],
        });
        expect(view.unassigned[0]?.reason).toBe("no_area");
      });
    });

    describe("With a problem on the room, on one of its valves, or on one of its sensors", () => {
      it("hasProblem is true", () => {
        const base = oneRoom();
        for (const subject of [
          { kind: "room", id: "living" },
          { kind: "valve", id: A },
          { kind: "sensor", id: "ha:sensor.living" },
        ] as const) {
          const view = stateView({ ...base, problems: [problem("link_down", subject)] });
          expect(view.rooms[0]?.hasProblem, subject.kind).toBe(true);
        }
      });
    });

    describe("With a problem on another room's valve only", () => {
      it("hasProblem is false", () => {
        const view = stateView({
          ...oneRoom(),
          problems: [problem("valve_silent", { kind: "valve", id: B })],
        });
        expect(view.rooms[0]?.hasProblem).toBe(false);
      });
    });

    describe("With a degraded room and no problem", () => {
      it("degraded is true and hasProblem is false", () => {
        const view = viewOf({
          rooms: [room("living", { status: status("living", [], { degraded: true }) })],
        });
        expect(view.rooms[0]).toMatchObject({ degraded: true, hasProblem: false });
      });
    });

    describe("With problems on a room, a valve, a sensor and the system", () => {
      it("name is the room's name, the device's name, each sensor's name from the snapshot, and the subject id", () => {
        const sensor: SensorSnapshot = {
          sensorId: "ha:sensor.living",
          ref: "ha:sensor.living",
          name: "Living sensor",
          celsius: undefined,
          seenAt: undefined,
          pending: false,
          unobservable: false,
        };
        const view = stateView({
          ...oneRoom(),
          sensors: [sensor],
          problems: [
            problem("room_no_temperature", { kind: "room", id: "living" }),
            problem("valve_silent", { kind: "valve", id: A }),
            problem("sensor_stale", { kind: "sensor", id: "ha:sensor.living" }),
            problem("config_unreadable", { kind: "system", id: "heatmaster" }),
          ],
        });
        expect(view.problems.map((p) => p.name)).toEqual([
          "Room living",
          "valve 0xa1",
          "Living sensor",
          "heatmaster",
        ]);
      });
    });

    describe("With a problem on a sensor that the snapshot does not list", () => {
      it("name is the sensor id", () => {
        const view = viewOf({
          problems: [problem("sensor_stale", { kind: "sensor", id: "ha:x" })],
        });
        expect(view.problems[0]?.name).toBe("ha:x");
      });
    });

    describe("With a room that has no status yet", () => {
      it('sync is "unverified", degraded is false, and valveIds holds the room\'s valves', () => {
        const [view] = viewOf({ rooms: [room("living", { valveIds: [A, B] })] }).rooms;
        expect(view).toEqual({
          roomId: "living",
          name: "Room living",
          managed: true,
          sync: "unverified",
          degraded: false,
          hasProblem: false,
          valveIds: [A, B],
        });
      });
    });

    describe("With a problem on a valve that has no device", () => {
      it("name is the valve id", () => {
        const view = viewOf({ problems: [problem("valve_orphan", { kind: "valve", id: A })] });
        expect(view.problems[0]?.name).toBe(A);
      });
    });

    describe("With an unreadable config", () => {
      it('configState is "unreadable", revision is 0, rooms is empty and language is "en"', () => {
        const view = viewOf({ configState: "unreadable", revision: 0, rooms: [], language: "en" });
        expect(view).toMatchObject({
          configState: "unreadable",
          revision: 0,
          rooms: [],
          language: "en",
        });
      });
    });

    describe("With an unreadable ledger", () => {
      it("ledgerReadable is false", () => {
        expect(viewOf({ ledgerReadable: false }).ledgerReadable).toBe(false);
      });
    });

    describe("With a snapshot whose originalsCopyRecords is 3", () => {
      it("originalsCopyRecords is 3", () => {
        expect(viewOf({ originalsCopyRecords: 3 }).originalsCopyRecords).toBe(3);
      });
    });

    describe("With two unassigned valves in the snapshot, given in descending id order", () => {
      const unassigned = [B, A].map((id) => ({
        valveId: id,
        name: `valve ${id.slice(4)}`,
        observed: id === A,
        liveness: "live" as const,
        heardAt: 5000,
        values: { sensor_source: "internal" },
        reason: undefined,
      }));
      const view = viewOf({ devices: [device(B), device(A)], unassigned });

      it("unassigned lists both in ascending id order, each with observed, liveness and values, and without heardAt", () => {
        expect(view.unassigned).toEqual([
          {
            valveId: A,
            name: "valve 0xa1",
            observed: true,
            liveness: "live",
            values: { sensor_source: "internal" },
          },
          {
            valveId: B,
            name: "valve 0xb2",
            observed: false,
            liveness: "live",
            values: { sensor_source: "internal" },
          },
        ]);
      });

      it("both are also in valves, without roomId", () => {
        expect(view.valves.map((v) => v.valveId)).toEqual([A, B]);
        expect(view.valves.some((v) => Object.hasOwn(v, "roomId"))).toBe(false);
      });
    });

    describe("Always", () => {
      it("JSON.parse(JSON.stringify(view)) equals the view", () => {
        const view = stateView({
          ...oneRoom(),
          problems: [problem("valve_silent", { kind: "valve", id: A })],
          unassigned: [
            {
              valveId: B,
              name: "b",
              observed: false,
              liveness: "unknown",
              heardAt: undefined,
              values: {},
              reason: "ignored_area",
            },
          ],
          house: "frozen",
          houseFrozenReason: "not_loaded",
          unusedEntries: ["attic"],
          haChanges: [
            {
              revision: 2,
              at: 1000,
              items: [
                {
                  kind: "sensor_removed",
                  areaId: "x",
                  entityId: "sensor.x",
                  scheduleId: undefined,
                  rule: undefined,
                  setting: undefined,
                  value: undefined,
                },
              ],
            },
          ],
          upgrade: { fromVersion: 2, droppedRooms: [] },
          devices: [device(A), device(B)],
        });
        expect(JSON.parse(JSON.stringify(view))).toEqual(view);
      });
    });
  });

  describe("problemName", () => {
    const nameOf = (over: Partial<Snapshot>, subject: Problem["subject"]): string | undefined =>
      stateView(snapshot({ ...over, problems: [problem("ha_label_failed", subject)] })).problems[0]
        ?.name;

    describe("With a problem whose subject is an area", () => {
      it("the area's name", () => {
        expect(
          nameOf(
            {
              rooms: [room("office", { name: "Office" })],
              areaNames: { office: "Office in HA" },
            },
            { kind: "area", id: "office" },
          ),
        ).toBe("Office");
      });
    });

    describe("With a problem whose subject is an area that is no room", () => {
      it("Home Assistant's name of the area, else the area id", () => {
        const areaNames = { attic: "Attic" };
        expect(nameOf({ areaNames }, { kind: "area", id: "attic" })).toBe("Attic");
        expect(nameOf({ areaNames }, { kind: "area", id: "shed" })).toBe("shed");
      });
    });

    describe("With a problem whose subject is a label", () => {
      it("the label id", () => {
        expect(nameOf({}, { kind: "label", id: "heatmaster_schedule_day_2" })).toBe(
          "heatmaster_schedule_day_2",
        );
      });
    });
  });

  describe("planView", () => {
    const TRV_ZBT = "z2m:0xd4";

    function spec(modelId: string) {
      const found = findProfile(modelId, "z2m");
      if (found === undefined) throw new Error(`no profile for ${modelId}`);
      return found.spec;
    }

    function state(values: DeviceState["values"]): DeviceState {
      return { values } as unknown as DeviceState;
    }

    /** What a valve shows of its frost protection, mode, setpoint and open window detection. */
    const THERMOSTAT: DeviceState["values"] = {
      frost_protection: 7,
      system_mode: "auto",
      setpoint: 17,
      open_window: "off",
    };

    function plan(over: Partial<ChangePlan> = {}, holdWrites = false): ChangePlan {
      return {
        stored: {
          ...FRESH_STORED,
          config: { ...EMPTY_CONFIG, settings: { ...EMPTY_CONFIG.settings, holdWrites } },
          revision: 4,
        },
        effects: [],
        joining: [],
        pending: [],
        writes: [],
        ...over,
      };
    }

    const devices = [device(A), device(TRV_ZBT, { modelId: "TRV-ZBT", name: "zbt valve" })];
    const snap = snapshot({ devices });

    describe("With a joining TRVZB whose sensor source was captured as external", () => {
      const view = planView(
        plan({
          joining: [
            capture(
              A,
              spec("TRVZB"),
              state({ sensor_source: "external", ...THERMOSTAT, setpoint: 21.5 }),
            ),
          ],
        }),
        false,
        snap,
      );

      it('originals is [{ setting: "sensor_source", value: "external", evidence: "acked" }], then frost protection, mode and setpoint', () => {
        expect(view.joining[0]?.originals).toEqual([
          { setting: "sensor_source", value: "external", evidence: "acked" },
          { setting: "frost_protection", value: 7, evidence: "acked" },
          { setting: "system_mode", value: "auto", evidence: "acked" },
          { setting: "setpoint", value: 21.5, evidence: "acked" },
          { setting: "open_window", value: "off", evidence: "acked" },
        ]);
      });

      it("name is the device's name", () => {
        expect(view.joining[0]).toMatchObject({ valveId: A, name: "valve 0xa1", unreadable: [] });
      });
    });

    describe("With a joining TRV-ZBT whose active group was 1", () => {
      it('originals also holds { setting: "active_group", value: 1, evidence: "acked" }', () => {
        const view = planView(
          plan({
            joining: [
              capture(
                TRV_ZBT,
                spec("TRV-ZBT"),
                state({ active_group: 1, sensor_source: "internal" }),
              ),
            ],
          }),
          false,
          snap,
        );
        expect(view.joining[0]?.originals).toContainEqual({
          setting: "active_group",
          value: 1,
          evidence: "acked",
        });
      });
    });

    describe("With a joining valve whose sensor source could not be read", () => {
      it("that original has value null and the setting is listed in unreadable", () => {
        const view = planView(
          plan({ joining: [capture(A, spec("TRVZB"), state(THERMOSTAT))] }),
          false,
          snap,
        );
        expect(view.joining[0]?.originals).toContainEqual({
          setting: "sensor_source",
          value: null,
          evidence: "acked",
        });
        expect(view.joining[0]?.unreadable).toEqual(["sensor_source"]);
      });
    });

    describe("With a planned write of two days and a known current value for one of them", () => {
      const write: PlannedWrite = {
        valveId: A,
        values: {
          day_tue: [{ time: Temporal.PlainTime.from("06:30"), temperature: 21 }],
          day_mon: [
            { time: Temporal.PlainTime.from("00:00"), temperature: 17 },
            { time: Temporal.PlainTime.from("18:00"), temperature: 20.5 },
          ],
        },
        current: { day_mon: [{ time: Temporal.PlainTime.from("00:00"), temperature: 16 }] },
      };
      const [view] = planView(plan({ writes: [write] }), false, snap).writes;

      it('settings holds both days in the write\'s order, "to" as lists of "HH:MM/temp" texts', () => {
        expect(view?.settings.map((s) => s.setting)).toEqual(["day_tue", "day_mon"]);
        expect(view?.settings.map((s) => s.to)).toEqual([["06:30/21"], ["00:00/17", "18:00/20.5"]]);
      });

      it('the day with a known current value has "from"; the other has no "from" key', () => {
        expect(view?.settings[1]?.from).toEqual(["00:00/16"]);
        expect(Object.hasOwn(view?.settings[0] ?? {}, "from")).toBe(false);
      });
    });

    describe("With a plan with a pending valve", () => {
      it("pending lists it with its name, room and reason", () => {
        const view = planView(
          plan({
            pending: [
              { valveId: A, roomId: "office", reason: "valve_not_observed", unreadable: [] },
              {
                valveId: "z2m:0xff",
                roomId: "attic",
                reason: "originals_unreadable",
                unreadable: ["sensor_source"],
              },
            ],
          }),
          false,
          snap,
        );
        expect(view.pending).toEqual([
          {
            valveId: A,
            name: "valve 0xa1",
            roomId: "office",
            reason: "valve_not_observed",
            unreadable: [],
          },
          {
            valveId: "z2m:0xff",
            name: "z2m:0xff",
            roomId: "attic",
            reason: "originals_unreadable",
            unreadable: ["sensor_source"],
          },
        ]);
      });
    });

    describe("With a plan whose config holds writes", () => {
      it("held is true", () => {
        expect(planView(plan({}, true), false, snap).held).toBe(true);
      });
    });

    describe("With applied true / false", () => {
      it("applied is true / false and revision is the plan's stored revision", () => {
        expect(planView(plan(), true, snap)).toMatchObject({ applied: true, revision: 4 });
        expect(planView(plan(), false, snap)).toMatchObject({ applied: false, revision: 4 });
      });
    });
  });
});
