import type { ProblemView, RoomView, StateView } from "@heatmaster/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startFakeZ2m, type FakeZ2m } from "../test/fake-z2m.ts";
import {
  ENTITY_TEXTS,
  PRESS_TOPIC,
  PROBLEMS_TOPIC,
  SYNC_OPTIONS,
  SYSTEM_STATE_TOPIC,
  configMessages,
  createDiscovery,
  roomConfigTopic,
  roomStateTopic,
  stateMessages,
  systemConfigTopic,
  type DiscoveryMqtt,
  type DiscoveryOptions,
} from "./discovery.ts";
import { systemClock } from "./clock.ts";
import { createMqttClient, type MqttEvent, type MqttState } from "./mqtt.ts";

const OPTIONS: DiscoveryOptions = { prefix: "homeassistant", version: "1.2.3" };
const WAIT = { timeout: 10 * 1000, interval: 5 };

function room(id: string, extra: Partial<RoomView> = {}): RoomView {
  return {
    roomId: id,
    name: id.toUpperCase(),
    currentTemperature: 19.6,
    target: 20,
    sync: "in_sync",
    degraded: false,
    diverged: false,
    hasProblem: false,
    valveIds: [],
    ...extra,
  };
}

function problem(n: number): ProblemView {
  return {
    kind: "valve_silent",
    subject: { kind: "valve", id: `z2m:${String(n)}` },
    severity: "warning",
    name: `Valve ${String(n)}`,
    data: { n: String(n) },
  };
}

function view(extra: Partial<StateView> = {}): StateView {
  return {
    revision: 1,
    configState: "ok",
    ledgerReadable: true,
    originalsCopyRecords: 0,
    held: false,
    language: "en",
    links: {},
    transportFaults: {},
    rooms: [room("a"), room("b")],
    valves: [],
    unassigned: [],
    problems: [],
    ...extra,
  };
}

// Parsed discovery payloads are walked by key in many places; a typed walk would only repeat them.
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
type Config = any;
function parse(text: string | undefined): Config {
  return JSON.parse(text ?? "null");
}

describe("discovery", () => {
  describe("roomStateTopic / roomConfigTopic / systemConfigTopic", () => {
    describe('With room id "living_room" and prefix "homeassistant"', () => {
      it("return heatmaster/rooms/living_room/state, homeassistant/device/heatmaster/room_living_room/config and homeassistant/device/heatmaster/system/config", () => {
        expect(roomStateTopic("living_room")).toBe("heatmaster/rooms/living_room/state");
        expect(roomConfigTopic("homeassistant", "living_room")).toBe(
          "homeassistant/device/heatmaster/room_living_room/config",
        );
        expect(systemConfigTopic("homeassistant")).toBe(
          "homeassistant/device/heatmaster/system/config",
        );
      });
    });
  });

  describe("configMessages", () => {
    describe("With two rooms", () => {
      it("returns three topics: the system device first, then the rooms in order", () => {
        expect([...configMessages(view(), OPTIONS).keys()]).toEqual([
          systemConfigTopic("homeassistant"),
          roomConfigTopic("homeassistant", "a"),
          roomConfigTopic("homeassistant", "b"),
        ]);
      });
    });

    describe('With prefix "ha_test"', () => {
      it("every topic starts with ha_test/device/heatmaster/", () => {
        for (const topic of configMessages(view(), { ...OPTIONS, prefix: "ha_test" }).keys()) {
          expect(topic.startsWith("ha_test/device/heatmaster/")).toBe(true);
        }
      });
    });

    describe("For a room device", () => {
      const config = parse(
        configMessages(view(), OPTIONS).get(roomConfigTopic("homeassistant", "a")),
      );
      it('identifiers is ["heatmaster_room_<id>"], name is the room\'s name, via_device is "heatmaster"', () => {
        expect(config.device).toMatchObject({
          identifiers: ["heatmaster_room_a"],
          name: "A",
          via_device: "heatmaster",
        });
      });
      it("origin holds the name Heatmaster, the version and the support URL", () => {
        expect(config.origin).toEqual({
          name: "Heatmaster",
          sw_version: "1.2.3",
          support_url: "https://github.com/t3hk0d3/heatmaster",
        });
      });
      it("availability_topic is heatmaster/status", () => {
        expect(config.availability_topic).toBe("heatmaster/status");
      });
      it("components holds exactly temperature, target, problem and sync", () => {
        expect(Object.keys(config.components)).toEqual([
          "temperature",
          "target",
          "problem",
          "sync",
        ]);
      });
      it("every component's state_topic is the room's state topic", () => {
        for (const component of Object.values<Config>(config.components)) {
          expect(component.state_topic).toBe("heatmaster/rooms/a/state");
        }
      });
      it("temperature has device class temperature, unit °C, state class measurement and no name key", () => {
        const temperature = config.components.temperature;
        expect(temperature).toMatchObject({
          device_class: "temperature",
          unit_of_measurement: "°C",
          state_class: "measurement",
          suggested_display_precision: 1,
        });
        expect(Object.hasOwn(temperature, "name")).toBe(false);
      });
      it("problem is a binary_sensor with device class problem and no name key", () => {
        const entity = config.components.problem;
        expect(entity).toMatchObject({
          platform: "binary_sensor",
          device_class: "problem",
          entity_category: "diagnostic",
        });
        expect(Object.hasOwn(entity, "name")).toBe(false);
      });
      it("sync has device class enum, the six options in order, no unit and no state class", () => {
        const entity = config.components.sync;
        expect(entity.device_class).toBe("enum");
        expect(entity.options).toEqual([...SYNC_OPTIONS]);
        expect(SYNC_OPTIONS).toHaveLength(6);
        expect(Object.hasOwn(entity, "unit_of_measurement")).toBe(false);
        expect(Object.hasOwn(entity, "state_class")).toBe(false);
      });
      it("no component has the platform climate", () => {
        for (const message of configMessages(view(), OPTIONS).values()) {
          for (const component of Object.values<Config>(parse(message).components)) {
            expect(component.platform).not.toBe("climate");
          }
        }
      });
    });

    for (const language of ["en", "ru"] as const) {
      describe(`With language "${language}"`, () => {
        const config = parse(
          configMessages(view({ language }), OPTIONS).get(roomConfigTopic("homeassistant", "a")),
        );
        it(`target is named "${ENTITY_TEXTS[language].target}"`, () => {
          expect(config.components.target.name).toBe(ENTITY_TEXTS[language].target);
        });
        it(`sync is named "${ENTITY_TEXTS[language].sync}"`, () => {
          expect(config.components.sync.name).toBe(ENTITY_TEXTS[language].sync);
        });
        it(`the device model is "${ENTITY_TEXTS[language].roomModel}"`, () => {
          expect(config.device.model).toBe(ENTITY_TEXTS[language].roomModel);
        });
      });
    }

    describe("With a room that has an area name", () => {
      it("suggested_area is that name", () => {
        const config = parse(
          configMessages(view({ rooms: [room("a", { areaName: "Upstairs" })] }), OPTIONS).get(
            roomConfigTopic("homeassistant", "a"),
          ),
        );
        expect(config.device.suggested_area).toBe("Upstairs");
      });
    });

    describe("With a room without one", () => {
      it("there is no suggested_area key", () => {
        const config = parse(
          configMessages(view(), OPTIONS).get(roomConfigTopic("homeassistant", "a")),
        );
        expect(Object.hasOwn(config.device, "suggested_area")).toBe(false);
      });
    });

    describe('With a room named Bedroom "north", or Спальня', () => {
      it("the payload parses as JSON and holds the name unchanged", () => {
        for (const name of ['Bedroom "north"', "Спальня"]) {
          const text = configMessages(view({ rooms: [room("a", { name })] }), OPTIONS).get(
            roomConfigTopic("homeassistant", "a"),
          );
          expect(parse(text).device.name).toBe(name);
        }
      });
    });

    describe("For the Heatmaster device", () => {
      const config = parse(configMessages(view(), OPTIONS).get(systemConfigTopic("homeassistant")));
      it('identifiers is ["heatmaster"]', () => {
        expect(config.device.identifiers).toEqual(["heatmaster"]);
      });
      it("components holds exactly problem, problem_count, held and stop_writing", () => {
        expect(Object.keys(config.components)).toEqual([
          "problem",
          "problem_count",
          "held",
          "stop_writing",
        ]);
      });
      it("problem_count is a measurement and a diagnostic", () => {
        expect(config.components.problem_count).toMatchObject({
          state_class: "measurement",
          entity_category: "diagnostic",
        });
      });
      it("problem_count has json_attributes_topic heatmaster/system/problems", () => {
        expect(config.components.problem_count.json_attributes_topic).toBe(
          "heatmaster/system/problems",
        );
      });
      it("stop_writing is a button with command topic heatmaster/system/stop_writing/press and payload_press PRESS", () => {
        expect(config.components.stop_writing).toMatchObject({
          platform: "button",
          command_topic: "heatmaster/system/stop_writing/press",
          payload_press: "PRESS",
        });
      });
      it("stop_writing has no state_topic", () => {
        expect(Object.hasOwn(config.components.stop_writing, "state_topic")).toBe(false);
      });
    });

    describe('With configState "unreadable" or "empty"', () => {
      it("returns only the system device", () => {
        for (const configState of ["unreadable", "empty"] as const) {
          expect([...configMessages(view({ configState }), OPTIONS).keys()]).toEqual([
            systemConfigTopic("homeassistant"),
          ]);
        }
      });
    });

    describe("With the same state twice", () => {
      it("returns equal texts", () => {
        expect([...configMessages(view(), OPTIONS)]).toEqual([...configMessages(view(), OPTIONS)]);
      });
    });
  });

  describe("stateMessages", () => {
    const one = (state: StateView, topic: string): string | undefined =>
      stateMessages(state).get(topic);
    describe("With a room at 19.6 with target 20, in sync, not degraded, no problem", () => {
      it('its message is {"temperature":19.6,"target":20,"problem":"OFF","sync":"in_sync"}', () => {
        expect(one(view(), roomStateTopic("a"))).toBe(
          '{"temperature":19.6,"target":20,"problem":"OFF","sync":"in_sync"}',
        );
      });
    });
    describe("With a room whose temperature is unknown", () => {
      it("temperature is null", () => {
        const state = view({
          rooms: [{ ...room("a"), currentTemperature: undefined } as unknown as RoomView],
        });
        expect(parse(one(state, roomStateTopic("a"))).temperature).toBeNull();
      });
    });
    describe("With a degraded room", () => {
      it('problem is "ON"', () => {
        const state = view({ rooms: [room("a", { degraded: true })] });
        expect(parse(one(state, roomStateTopic("a"))).problem).toBe("ON");
      });
    });
    describe("With a room that is not degraded but has a problem", () => {
      it('problem is "ON"', () => {
        const state = view({ rooms: [room("a", { hasProblem: true })] });
        expect(parse(one(state, roomStateTopic("a"))).problem).toBe("ON");
      });
    });
    describe("With no problems and writes held", () => {
      it('the system message is {"problem":"OFF","problem_count":0,"held":"ON"}', () => {
        expect(one(view({ held: true }), SYSTEM_STATE_TOPIC)).toBe(
          '{"problem":"OFF","problem_count":0,"held":"ON"}',
        );
      });
    });
    describe("With three problems and writes not held", () => {
      const state = view({ problems: [problem(1), problem(2), problem(3)] });
      it('the system message has problem "ON", problem_count 3 and held "OFF"', () => {
        expect(parse(one(state, SYSTEM_STATE_TOPIC))).toEqual({
          problem: "ON",
          problem_count: 3,
          held: "OFF",
        });
      });
      it("the problems message lists the three with kind, subject, name, severity and data, and more is 0", () => {
        const message = parse(one(state, PROBLEMS_TOPIC));
        expect(message.more).toBe(0);
        expect(message.problems).toHaveLength(3);
        expect(Object.keys(message.problems[0])).toEqual([
          "kind",
          "subject",
          "name",
          "severity",
          "data",
        ]);
      });
    });
    describe("With 60 problems", () => {
      const state = view({ problems: Array.from({ length: 60 }, (_, n) => problem(n)) });
      it("the problems message lists 50 and more is 10", () => {
        const message = parse(one(state, PROBLEMS_TOPIC));
        expect(message.problems).toHaveLength(50);
        expect(message.more).toBe(10);
      });
      it("problem_count is 60", () => {
        expect(parse(one(state, SYSTEM_STATE_TOPIC)).problem_count).toBe(60);
      });
    });
  });
});

/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */

// ---- the publisher against a recording stub -----------------------------------------------------

type Published = Readonly<{ topic: string; payload: string; qos: number; retain: boolean }>;
type Handler = (topic: string, payload: Buffer, retained: boolean) => void;

function stub(initial: MqttState = "connected") {
  let state: MqttState = initial;
  const published: Published[] = [];
  const filters = new Map<string, Set<Handler>>();
  const listeners = new Set<(event: MqttEvent) => void>();
  let failNext = 0;
  let gate: Promise<void> | undefined;
  const mqtt: DiscoveryMqtt = {
    state: () => state,
    async publish(topic, payload, options) {
      if (gate !== undefined) await gate;
      if (failNext > 0) {
        failNext -= 1;
        throw new Error("refused");
      }
      published.push({ topic, payload, ...options });
    },
    subscribe(filter, handler) {
      const set = filters.get(filter) ?? new Set();
      set.add(handler);
      filters.set(filter, set);
      return () => {
        set.delete(handler);
      };
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    mqtt,
    published,
    filters,
    setState(next: MqttState) {
      state = next;
    },
    connect() {
      state = "connected";
      for (const listener of [...listeners]) listener({ kind: "connected", first: false });
    },
    failNext(n: number) {
      failNext = n;
    },
    hold(): () => void {
      let open: () => void = () => undefined;
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return () => {
        gate = undefined;
        open();
      };
    },
    deliver(topic: string, payload: string, retained: boolean) {
      for (const [filter, handlers] of filters) {
        const f = filter.split("/");
        const t = topic.split("/");
        if (f.length !== t.length || !f.every((l, i) => l === "+" || l === t[i])) continue;
        for (const handler of [...handlers]) handler(topic, Buffer.from(payload), retained);
      }
    },
    topics: () => published.map((m) => m.topic),
    clear() {
      published.length = 0;
    },
    subscribed: () => [...filters.entries()].filter(([, s]) => s.size > 0).map(([f]) => f),
  };
}

function make(mqttStub = stub(), stopWriting: () => Promise<unknown> = () => Promise.resolve()) {
  const discovery = createDiscovery({
    mqtt: mqttStub.mqtt,
    stopWriting,
    options: OPTIONS,
    log: undefined,
  });
  return { discovery, stub: mqttStub };
}

const SYSTEM_CONFIG = systemConfigTopic("homeassistant");
const ROOM_A = roomConfigTopic("homeassistant", "a");
const ROOM_B = roomConfigTopic("homeassistant", "b");

describe("discovery (createDiscovery)", () => {
  describe("start", () => {
    describe("Always", () => {
      it("subscribes to homeassistant/status, to the press topic and to <prefix>/device/heatmaster/+/config", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        expect(s.subscribed()).toEqual([
          "homeassistant/status",
          PRESS_TOPIC,
          "homeassistant/device/heatmaster/+/config",
        ]);
      });
    });
  });

  describe("sync", () => {
    describe("With a first state of two rooms, connected", () => {
      it("publishes the system config, the two room configs, then three state messages and the problems message, in that order", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        await discovery.sync(view());
        expect(s.topics()).toEqual([
          SYSTEM_CONFIG,
          ROOM_A,
          ROOM_B,
          roomStateTopic("a"),
          roomStateTopic("b"),
          SYSTEM_STATE_TOPIC,
          PROBLEMS_TOPIC,
        ]);
      });
      it("every message is retained with QoS 1", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        await discovery.sync(view());
        expect(s.published.every((m) => m.retain && m.qos === 1)).toBe(true);
      });
    });

    describe("With the same state again", () => {
      it("publishes nothing", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        await discovery.sync(view());
        s.clear();
        await discovery.sync(view());
        expect(s.published).toEqual([]);
      });
    });

    describe("With one room's temperature changed", () => {
      it("publishes that room's state topic only", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        await discovery.sync(view());
        s.clear();
        await discovery.sync(view({ rooms: [room("a", { currentTemperature: 21 }), room("b")] }));
        expect(s.topics()).toEqual([roomStateTopic("a")]);
      });
    });

    describe("With one room renamed", () => {
      it("publishes that room's config topic only", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        await discovery.sync(view());
        s.clear();
        await discovery.sync(view({ rooms: [room("a", { name: "Renamed" }), room("b")] }));
        expect(s.topics()).toEqual([ROOM_A]);
      });
    });

    describe("With the language changed from en to ru", () => {
      it("publishes the system config and every room config, and no state message", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        await discovery.sync(view());
        s.clear();
        await discovery.sync(view({ language: "ru" }));
        expect(s.topics()).toEqual([SYSTEM_CONFIG, ROOM_A, ROOM_B]);
      });
    });

    describe('With a room gone and configState "ok"', () => {
      it("publishes an empty retained payload to its config topic and to its state topic", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        await discovery.sync(view());
        s.clear();
        await discovery.sync(view({ rooms: [room("a")] }));
        expect(s.published).toEqual([
          { topic: ROOM_B, payload: "", qos: 1, retain: true },
          { topic: roomStateTopic("b"), payload: "", qos: 1, retain: true },
        ]);
      });
      describe("With that state again", () => {
        it("publishes nothing more", async () => {
          const { discovery, stub: s } = make();
          await discovery.start();
          await discovery.sync(view());
          await discovery.sync(view({ rooms: [room("a")] }));
          s.clear();
          await discovery.sync(view({ rooms: [room("a")] }));
          expect(s.published).toEqual([]);
        });
      });
    });

    describe('With a retained config for room_old received at start and a state with configState "ok" that has no such room', () => {
      it("publishes an empty retained payload to room_old's config topic", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        const old = roomConfigTopic("homeassistant", "old");
        s.deliver(old, "{}", true);
        await discovery.sync(view());
        expect(s.published).toContainEqual({ topic: old, payload: "", qos: 1, retain: true });
      });
    });

    describe("With an empty message received on a room's config topic", () => {
      it("that topic is no longer known", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        const old = roomConfigTopic("homeassistant", "old");
        s.deliver(old, "{}", true);
        s.deliver(old, "", true);
        await discovery.sync(view());
        expect(s.topics()).not.toContain(old);
      });
    });

    describe('With configState "unreadable" after two rooms were published', () => {
      it("publishes nothing to any room topic", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        await discovery.sync(view());
        s.clear();
        await discovery.sync(view({ configState: "unreadable", rooms: [], held: true }));
        expect(s.topics().filter((t) => t.includes("room"))).toEqual([]);
      });
      it("still publishes the system state", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        await discovery.sync(view());
        s.clear();
        await discovery.sync(view({ configState: "unreadable", rooms: [], held: true }));
        expect(s.topics()).toEqual([SYSTEM_STATE_TOPIC]);
      });
    });

    describe('With configState "empty" and a retained config for room_old received at start', () => {
      it("removes nothing", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        s.deliver(roomConfigTopic("homeassistant", "old"), "{}", true);
        await discovery.sync(view({ configState: "empty", rooms: [] }));
        expect(s.published.filter((m) => m.payload === "")).toEqual([]);
      });
    });

    describe("While the client is not connected", () => {
      it("publishes nothing", async () => {
        const { discovery, stub: s } = make(stub("disconnected"));
        await discovery.start();
        await discovery.sync(view());
        expect(s.published).toEqual([]);
      });
      describe("When the client connects after that", () => {
        it("publishes everything once, configs before states", async () => {
          const { discovery, stub: s } = make(stub("disconnected"));
          await discovery.start();
          await discovery.sync(view());
          s.connect();
          await vi.waitFor(() => {
            expect(s.published).toHaveLength(7);
          }, WAIT);
          expect(s.topics().slice(0, 3)).toEqual([SYSTEM_CONFIG, ROOM_A, ROOM_B]);
        });
      });
    });

    describe("With a publish that rejects", () => {
      it("the same message is published at the next sync", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        s.failNext(1);
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        await discovery.sync(view());
        quiet.mockRestore();
        expect(s.topics()).not.toContain(SYSTEM_CONFIG);
        await discovery.sync(view());
        expect(s.topics()).toContain(SYSTEM_CONFIG);
      });
    });

    describe("With two syncs asked for while one is running", () => {
      it("one more sync runs, with the newest state", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        const open = s.hold();
        const first = discovery.sync(view());
        const second = discovery.sync(view({ rooms: [room("a", { currentTemperature: 18 })] }));
        const third = discovery.sync(view({ rooms: [room("a", { currentTemperature: 17 })] }));
        open();
        await Promise.all([first, second, third]);
        const texts = s.published.filter((m) => m.topic === roomStateTopic("a"));
        expect(
          texts.map((m) => (JSON.parse(m.payload) as { temperature: number }).temperature),
        ).toEqual([19.6, 17]);
      });
    });
  });

  describe("Home Assistant status", () => {
    describe('With "online" on homeassistant/status', () => {
      it("every config and state message is published again, configs first", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        await discovery.sync(view());
        s.clear();
        s.deliver("homeassistant/status", "online", false);
        await vi.waitFor(() => {
          expect(s.published).toHaveLength(7);
        }, WAIT);
        expect(s.topics().slice(0, 3)).toEqual([SYSTEM_CONFIG, ROOM_A, ROOM_B]);
      });
    });
    describe('With "offline"', () => {
      it("publishes nothing", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        await discovery.sync(view());
        s.clear();
        s.deliver("homeassistant/status", "offline", false);
        await discovery.sync(view());
        expect(s.published).toEqual([]);
      });
    });
    describe("Before the first sync", () => {
      it("publishes nothing", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        s.deliver("homeassistant/status", "online", false);
        await Promise.resolve();
        expect(s.published).toEqual([]);
      });
    });
  });

  describe("button", () => {
    describe("With PRESS on the press topic", () => {
      it("stopWriting is called once", async () => {
        const stopWriting = vi.fn(() => Promise.resolve());
        const { discovery, stub: s } = make(stub(), stopWriting);
        await discovery.start();
        s.deliver(PRESS_TOPIC, "PRESS", false);
        expect(stopWriting).toHaveBeenCalledTimes(1);
      });
    });
    describe("With PRESS carrying the retain flag", () => {
      it("stopWriting is not called", async () => {
        const stopWriting = vi.fn(() => Promise.resolve());
        const { discovery, stub: s } = make(stub(), stopWriting);
        await discovery.start();
        s.deliver(PRESS_TOPIC, "PRESS", true);
        expect(stopWriting).not.toHaveBeenCalled();
      });
    });
    describe("With another payload", () => {
      it("stopWriting is not called", async () => {
        const stopWriting = vi.fn(() => Promise.resolve());
        const { discovery, stub: s } = make(stub(), stopWriting);
        await discovery.start();
        s.deliver(PRESS_TOPIC, "press", false);
        s.deliver(PRESS_TOPIC, "", false);
        expect(stopWriting).not.toHaveBeenCalled();
      });
    });
    describe("With stopWriting rejecting", () => {
      it("the error is logged and the next press calls it again", async () => {
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const stopWriting = vi.fn(() => Promise.reject(new Error("no")));
        const { discovery, stub: s } = make(stub(), stopWriting);
        await discovery.start();
        s.deliver(PRESS_TOPIC, "PRESS", false);
        await vi.waitFor(() => {
          expect(quiet).toHaveBeenCalledTimes(1);
        }, WAIT);
        s.deliver(PRESS_TOPIC, "PRESS", false);
        expect(stopWriting).toHaveBeenCalledTimes(2);
        await vi.waitFor(() => {
          expect(quiet).toHaveBeenCalledTimes(2);
        }, WAIT);
        quiet.mockRestore();
      });
    });
  });

  describe("stop", () => {
    describe("Always", () => {
      it("the subscriptions are removed", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        await discovery.stop();
        expect(s.subscribed()).toEqual([]);
      });
      it("nothing is published", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        await discovery.stop();
        await discovery.sync(view());
        s.connect();
        expect(s.published).toEqual([]);
      });
    });
  });
});

// ---- the real client on the test broker --------------------------------------------------------

describe("discovery on the test broker (the real MQTT client)", () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
  });

  async function setup(stopWriting: () => Promise<unknown>) {
    const fake: FakeZ2m = await startFakeZ2m();
    closers.push(() => fake.stop());
    const options = { url: fake.url, username: undefined, password: undefined };
    const first = createMqttClient({ ...options, clientId: undefined }, systemClock);
    await first.connect();
    closers.push(() => first.end());
    const discovery = createDiscovery({
      mqtt: first,
      stopWriting,
      options: OPTIONS,
      log: undefined,
    });
    await discovery.start();
    closers.push(() => discovery.stop());
    const second = createMqttClient({ ...options, clientId: "second" }, systemClock);
    return { fake, discovery, second };
  }

  describe("With a sync of one room", () => {
    it("a second client that subscribes afterwards receives the room's config and state as retained messages", async () => {
      const { discovery, second } = await setup(() => Promise.resolve());
      await discovery.sync(view({ rooms: [room("a")] }));
      await second.connect();
      closers.push(() => second.end());
      const got = new Map<string, boolean>();
      second.subscribe("homeassistant/device/heatmaster/+/config", (t, _p, retained) => {
        got.set(t, retained);
      });
      second.subscribe("heatmaster/rooms/+/state", (t, _p, retained) => {
        got.set(t, retained);
      });
      await vi.waitFor(() => {
        expect(got.get(ROOM_A)).toBe(true);
        expect(got.get(roomStateTopic("a"))).toBe(true);
      }, WAIT);
    });
  });

  describe("With a PRESS published by a second client", () => {
    it("stopWriting is called", async () => {
      const stopWriting = vi.fn(() => Promise.resolve());
      const { second } = await setup(stopWriting);
      await second.connect();
      closers.push(() => second.end());
      await second.publish(PRESS_TOPIC, "PRESS", { qos: 1, retain: false });
      await vi.waitFor(() => {
        expect(stopWriting).toHaveBeenCalledTimes(1);
      }, WAIT);
    });
  });
});
