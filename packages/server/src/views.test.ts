import { EMPTY_CONFIG, capture, findProfile } from "@heatmaster/core";
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
    diverged: false,
    valves,
    ...over,
  } satisfies RoomStatus;
}

function room(roomId: string, over: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    roomId,
    name: `Room ${roomId}`,
    areaId: undefined,
    areaName: undefined,
    valveIds: [],
    sensorIds: [],
    status: undefined,
    ...over,
  };
}

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    revision: 3,
    configState: "ok",
    ledgerReadable: true,
    originalsCopyRecords: 0,
    held: false,
    language: "ru",
    timeZone: "Europe/Amsterdam",
    tickedAt: 1,
    rooms: [],
    problems: [],
    memberships: {},
    devices: [],
    unassigned: [],
    sensors: [],
    links: { z2m: true },
    transportFaults: {},
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
            currentTemperature: 19.5,
            target: 21,
            nextChangeAt: Date.UTC(2026, 10, 16, 18, 0, 0),
            nextTarget: 17,
            mode: "auto",
            heating: true,
            sync: "in_sync",
            degraded: false,
            diverged: false,
            hasProblem: false,
            valveIds: [A],
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

    describe("With a room that has an area name", () => {
      it("areaName is set", () => {
        const [view] = viewOf({ rooms: [room("living", { areaName: "Living room" })] }).rooms;
        expect(view?.areaName).toBe("Living room");
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
      it('sync is "unverified", degraded and diverged are false, and valveIds holds the room\'s valves', () => {
        const [view] = viewOf({ rooms: [room("living", { valveIds: [A, B] })] }).rooms;
        expect(view).toEqual({
          roomId: "living",
          name: "Room living",
          sync: "unverified",
          degraded: false,
          diverged: false,
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
            },
          ],
          devices: [device(A), device(B)],
        });
        expect(JSON.parse(JSON.stringify(view))).toEqual(view);
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

    function plan(over: Partial<ChangePlan> = {}, holdWrites = false): ChangePlan {
      return {
        stored: {
          config: { ...EMPTY_CONFIG, settings: { ...EMPTY_CONFIG.settings, holdWrites } },
          revision: 4,
          releasing: new Map(),
        },
        ledger: undefined,
        effects: [],
        joining: [],
        rejoining: [],
        leaving: [],
        writes: [],
        ...over,
      };
    }

    const devices = [device(A), device(TRV_ZBT, { modelId: "TRV-ZBT", name: "zbt valve" })];
    const snap = snapshot({ devices });

    describe("With a joining TRVZB whose sensor source was captured as external", () => {
      const view = planView(
        plan({ joining: [capture(A, spec("TRVZB"), state({ sensor_source: "external" }))] }),
        false,
        snap,
      );

      it('originals is [{ setting: "sensor_source", value: "external", evidence: "acked" }]', () => {
        expect(view.joining[0]?.originals).toEqual([
          { setting: "sensor_source", value: "external", evidence: "acked" },
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
          plan({ joining: [capture(A, spec("TRVZB"), state({}))] }),
          false,
          snap,
        );
        expect(view.joining[0]?.originals).toEqual([
          { setting: "sensor_source", value: null, evidence: "acked" },
        ]);
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

    describe("With rejoining and leaving valves", () => {
      it("each is listed with its id and name", () => {
        const view = planView(
          plan({ rejoining: [A], leaving: [TRV_ZBT, "z2m:0xff"] }),
          false,
          snap,
        );
        expect(view.rejoining).toEqual([{ valveId: A, name: "valve 0xa1" }]);
        expect(view.leaving).toEqual([
          { valveId: TRV_ZBT, name: "zbt valve" },
          { valveId: "z2m:0xff", name: "z2m:0xff" },
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
