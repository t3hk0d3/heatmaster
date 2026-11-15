import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rejectionOf } from "../test/rejection.ts";
import { startFakeZ2m, type FakeZ2m } from "../test/fake-z2m.ts";
import { HeatmasterError } from "./errors.ts";
import { systemClock } from "./clock.ts";
import {
  createMqttClient,
  type MqttClient,
  type MqttEvent,
  type MqttFault,
  type MqttState,
} from "./mqtt.ts";
import type { RawEvent, Transport } from "./transport.ts";
import {
  DEFAULT_BASE_TOPIC,
  SUPPORTED_Z2M_MAJOR,
  buildTransports,
  createZ2mTransport,
} from "./z2m.ts";

const FIXTURES = path.resolve(import.meta.dirname, "../../core/test/fixtures/z2m");

function fixture(name: string): Record<string, unknown> & { payload: unknown } {
  return JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8")) as Record<
    string,
    unknown
  > & { payload: unknown };
}

const BASE = "zigbee2mqtt";
const INFO = fixture("bridge_info").payload as {
  version: string;
  config: { advanced: Record<string, unknown> };
};
const DEVICES = fixture("bridge_devices").payload as Record<string, unknown>[];
const ONLINE = fixture("bridge_state_online").payload;
const OFFLINE = fixture("bridge_state_offline").payload;
const ANNOUNCE = fixture("bridge_event_announce").payload as {
  type: string;
  data: Record<string, unknown>;
};

const TRVZB = { id: "z2m:0x0000000000000003", ieee: "0x0000000000000003", name: "test/trvzb" };
const TRV_ZBT = { id: "z2m:0x0000000000000004", ieee: "0x0000000000000004", name: "test/trv_zbt" };
const SENSOR = {
  ieee_address: "0x0000000000000005",
  friendly_name: "test/sensor",
  type: "EndDevice",
  model_id: "SNZB-02",
  manufacturer: "SONOFF",
  software_build_id: "1.0.0",
};
const LIST_WITH_SENSOR = [...DEVICES, SENSOR];

type Stub = MqttClient &
  Readonly<{
    deliver(topic: string, payload: unknown): void;
    emit(event: MqttEvent): void;
    set(state: MqttState, fault?: MqttFault): void;
    filters(): string[];
    sent(): { topic: string; payload: string; qos: number; retain: boolean }[];
  }>;

/** An MQTT client the test drives by hand. */
function stubMqtt(initial: MqttState = "connected"): Stub {
  let state = initial;
  let fault: MqttFault | undefined;
  const handlers = new Map<
    string,
    Set<(topic: string, payload: Buffer, retained: boolean) => void>
  >();
  const listeners = new Set<(event: MqttEvent) => void>();
  const sent: { topic: string; payload: string; qos: number; retain: boolean }[] = [];
  return {
    connect: () => Promise.resolve(),
    state: () => state,
    fault: () => fault,
    protocol: () => 5,
    subscribe(filter, handler) {
      const set = handlers.get(filter) ?? new Set();
      set.add(handler);
      handlers.set(filter, set);
      return () => {
        set.delete(handler);
        if (set.size === 0) handlers.delete(filter);
      };
    },
    publish(topic, payload, options) {
      if (state !== "connected") return Promise.reject(new HeatmasterError("mqtt_not_connected"));
      sent.push({ topic, payload, ...options });
      return Promise.resolve();
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    end: () => Promise.resolve(),
    deliver(topic, payload) {
      const buffer = Buffer.isBuffer(payload)
        ? payload
        : Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));
      for (const handler of [...(handlers.get(topic) ?? [])]) handler(topic, buffer, false);
    },
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
    set(next, nextFault) {
      state = next;
      fault = nextFault;
    },
    filters: () => [...handlers.keys()],
    sent: () => sent,
  };
}

type Harness = Readonly<{ mqtt: Stub; transport: Transport; events: RawEvent[] }>;

async function harness(
  options: { state?: MqttState; baseTopic?: string; start?: boolean } = {},
): Promise<Harness> {
  const mqtt = stubMqtt(options.state ?? "connected");
  const transport = createZ2mTransport(mqtt, { baseTopic: options.baseTopic });
  const events: RawEvent[] = [];
  if (options.start !== false) await transport.start((event) => events.push(event));
  return { mqtt, transport, events };
}

function kinds(events: readonly RawEvent[]): string[] {
  return events.map((event) => event.kind);
}

function topic(suffix: string): string {
  return `${BASE}/${suffix}`;
}

/** A started transport that has seen a good bridge/info and the fixture device list. */
async function withDevices(list: unknown = DEVICES): Promise<Harness> {
  const made = await harness();
  made.mqtt.deliver(topic("bridge/info"), INFO);
  made.mqtt.deliver(topic("bridge/devices"), list);
  made.events.length = 0;
  return made;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("z2m", () => {
  describe("constants", () => {
    it("the base topic defaults to zigbee2mqtt and major version 2 is supported", () => {
      expect(DEFAULT_BASE_TOPIC).toBe("zigbee2mqtt");
      expect(SUPPORTED_Z2M_MAJOR).toBe(2);
    });
  });

  describe("start", () => {
    describe("With no base topic in the options", () => {
      it("the four bridge topics under zigbee2mqtt are subscribed", async () => {
        const { mqtt } = await harness();
        expect(mqtt.filters().sort()).toEqual(
          [
            "zigbee2mqtt/bridge/devices",
            "zigbee2mqtt/bridge/event",
            "zigbee2mqtt/bridge/info",
            "zigbee2mqtt/bridge/state",
          ].sort(),
        );
      });
    });

    describe('With base topic "z2m_home"', () => {
      it("they are subscribed under z2m_home", async () => {
        const { mqtt } = await harness({ baseTopic: "z2m_home" });
        expect(mqtt.filters().sort()).toEqual(
          [
            "z2m_home/bridge/devices",
            "z2m_home/bridge/event",
            "z2m_home/bridge/info",
            "z2m_home/bridge/state",
          ].sort(),
        );
      });
    });

    describe("Always", () => {
      it('key is "z2m"', async () => {
        const { transport } = await harness({ start: false });
        expect(transport.key).toBe("z2m");
      });

      it("start resolves before any bridge message has arrived", async () => {
        const { mqtt, transport } = await harness({ start: false });
        await expect(transport.start(() => undefined)).resolves.toBeUndefined();
        expect(mqtt.sent()).toEqual([]);
      });
    });

    describe("With an MQTT client that was connected before start, and the bridge state online", () => {
      it("linkUp is true", async () => {
        const { mqtt, transport } = await harness();
        mqtt.deliver(topic("bridge/state"), ONLINE);
        expect(transport.linkUp()).toBe(true);
      });

      it("one link_up was sent and no bridge_restarted", async () => {
        const { mqtt, events } = await harness();
        mqtt.deliver(topic("bridge/state"), ONLINE);
        expect(kinds(events)).toEqual(["link_up"]);
      });
    });
  });

  describe("fault", () => {
    describe("With an MQTT client that has never connected", () => {
      it("returns mqtt_unavailable", async () => {
        const { mqtt, transport } = await harness({ state: "disconnected" });
        mqtt.set("disconnected", "mqtt_unavailable");
        expect(transport.fault()).toBe("mqtt_unavailable");
      });
    });

    describe("With an MQTT client that was taken over", () => {
      it("returns another_instance", async () => {
        const { mqtt, transport } = await harness();
        mqtt.set("ended", "another_instance");
        expect(transport.fault()).toBe("another_instance");
      });
    });

    describe("With an MQTT client whose login was refused", () => {
      it("returns mqtt_auth_failed", async () => {
        const { mqtt, transport } = await harness({ state: "disconnected" });
        mqtt.set("disconnected", "mqtt_auth_failed");
        expect(transport.fault()).toBe("mqtt_auth_failed");
      });
    });

    describe("With MQTT connected and no bridge/info yet", () => {
      it("returns bridge_unknown", async () => {
        const { transport } = await harness();
        expect(transport.fault()).toBe("bridge_unknown");
      });
    });

    describe("With bridge/info reporting version 3.0.0", () => {
      it("returns version_unsupported", async () => {
        const { mqtt, transport } = await harness();
        mqtt.deliver(topic("bridge/info"), { ...INFO, version: "3.0.0" });
        expect(transport.fault()).toBe("version_unsupported");
      });
    });

    describe("With bridge/info whose version cannot be read", () => {
      it("returns version_unsupported", async () => {
        for (const version of [undefined, 2, "", "latest", null]) {
          const { mqtt, transport } = await harness();
          mqtt.deliver(topic("bridge/info"), { ...INFO, version });
          expect(transport.fault(), String(version)).toBe("version_unsupported");
        }
      });
    });

    describe('With bridge/info reporting last_seen "disable"', () => {
      it("returns last_seen_disabled", async () => {
        const { mqtt, transport } = await harness();
        mqtt.deliver(topic("bridge/info"), {
          ...INFO,
          config: { advanced: { ...INFO.config.advanced, last_seen: "disable" } },
        });
        expect(transport.fault()).toBe("last_seen_disabled");
      });
    });

    describe("With bridge/info without config.advanced.last_seen, without config, or with null", () => {
      it("returns last_seen_disabled", async () => {
        for (const config of [
          { advanced: {} },
          {},
          undefined,
          null,
          { advanced: { last_seen: null } },
        ]) {
          const { mqtt, transport } = await harness();
          mqtt.deliver(topic("bridge/info"), { ...INFO, config });
          expect(transport.fault(), JSON.stringify(config)).toBe("last_seen_disabled");
        }
      });
    });

    describe("With an unknown last_seen value", () => {
      it("returns last_seen_disabled", async () => {
        const { mqtt, transport } = await harness();
        mqtt.deliver(topic("bridge/info"), {
          ...INFO,
          config: { advanced: { last_seen: "ISO_9601" } },
        });
        expect(transport.fault()).toBe("last_seen_disabled");
      });
    });

    describe("With last_seen ISO_8601_local (as recorded) or epoch", () => {
      it("returns undefined", async () => {
        expect(INFO.config.advanced.last_seen).toBe("ISO_8601_local");
        for (const lastSeen of ["ISO_8601_local", "epoch"]) {
          const { mqtt, transport } = await harness();
          mqtt.deliver(topic("bridge/info"), {
            ...INFO,
            config: { advanced: { last_seen: lastSeen } },
          });
          expect(transport.fault(), lastSeen).toBeUndefined();
        }
      });
    });

    describe('With version 2.14.3 and last_seen "ISO_8601"', () => {
      it("returns undefined", async () => {
        const { mqtt, transport } = await harness();
        mqtt.deliver(topic("bridge/info"), {
          ...INFO,
          version: "2.14.3",
          config: { advanced: { last_seen: "ISO_8601" } },
        });
        expect(transport.fault()).toBeUndefined();
      });
    });

    describe("With a good bridge/info and the bridge state offline", () => {
      it("returns undefined", async () => {
        const { mqtt, transport } = await harness();
        mqtt.deliver(topic("bridge/info"), INFO);
        mqtt.deliver(topic("bridge/state"), OFFLINE);
        expect(transport.fault()).toBeUndefined();
      });
    });

    describe("With a good bridge/info seen and the MQTT connection then lost", () => {
      it("returns undefined", async () => {
        const { mqtt, transport } = await harness();
        mqtt.deliver(topic("bridge/info"), INFO);
        mqtt.set("disconnected");
        mqtt.emit({ kind: "disconnected" });
        expect(transport.fault()).toBeUndefined();
      });
    });
  });

  describe("devices", () => {
    describe("With a bridge/devices message listing a coordinator, a TRVZB and a sensor", () => {
      it("returns the TRVZB and the sensor under ids z2m:<ieee>, and not the coordinator", async () => {
        const { transport } = await withDevices(LIST_WITH_SENSOR);
        expect([...transport.devices().keys()].sort()).toEqual([
          TRVZB.id,
          TRV_ZBT.id,
          "z2m:0x0000000000000005",
        ]);
      });

      it("the TRVZB's info holds transport z2m, its address, modelId TRVZB, manufacturer, firmware and friendly name", async () => {
        const { transport } = await withDevices(LIST_WITH_SENSOR);
        expect(transport.devices().get(TRVZB.id)).toEqual({
          deviceId: TRVZB.id,
          transport: "z2m",
          address: TRVZB.ieee,
          modelId: "TRVZB",
          manufacturer: "SONOFF",
          firmware: "1.4.4",
          name: TRVZB.name,
        });
      });

      it("sends devices_changed", async () => {
        const made = await harness();
        made.mqtt.deliver(topic("bridge/devices"), LIST_WITH_SENSOR);
        expect(kinds(made.events)).toEqual(["devices_changed"]);
      });
    });

    describe("With an entry that has no model id", () => {
      it("its modelId is the empty text", async () => {
        const { transport } = await withDevices([
          ...DEVICES,
          { ...SENSOR, model_id: undefined, software_build_id: undefined, manufacturer: undefined },
        ]);
        const info = transport.devices().get("z2m:0x0000000000000005");
        expect(info?.modelId).toBe("");
        expect(info?.manufacturer).toBeUndefined();
        expect(info?.firmware).toBeUndefined();
      });
    });

    describe("With an entry without an address or a name", () => {
      it("it is left out", async () => {
        const { transport } = await withDevices([
          ...DEVICES,
          { ...SENSOR, ieee_address: undefined },
          { ...SENSOR, ieee_address: "0x0000000000000006", friendly_name: undefined },
        ]);
        expect([...transport.devices().keys()].sort()).toEqual([TRVZB.id, TRV_ZBT.id]);
      });
    });

    describe("With the same list published again", () => {
      it("sends nothing", async () => {
        const made = await withDevices();
        made.mqtt.deliver(topic("bridge/devices"), DEVICES);
        expect(made.events).toEqual([]);
      });
    });

    describe("With a later list where the followed TRVZB is renamed", () => {
      const renamed = DEVICES.map((entry) =>
        entry.ieee_address === TRVZB.ieee ? { ...entry, friendly_name: "test/renamed" } : entry,
      );

      it("sends devices_changed", async () => {
        const made = await withDevices();
        made.transport.follow(new Set([TRVZB.id]));
        made.mqtt.deliver(topic("bridge/devices"), renamed);
        expect(kinds(made.events)).toEqual(["devices_changed"]);
      });

      it("messages on the new topic are delivered and on the old one are not", async () => {
        const made = await withDevices();
        made.transport.follow(new Set([TRVZB.id]));
        made.mqtt.deliver(topic("bridge/devices"), renamed);
        made.events.length = 0;
        made.mqtt.deliver(topic("test/renamed"), { last_seen: "a" });
        made.mqtt.deliver(topic("test/trvzb"), { last_seen: "b" });
        expect(made.events).toEqual([
          { kind: "message", deviceId: TRVZB.id, payload: { last_seen: "a" }, lifeToken: "a" },
        ]);
      });
    });

    describe("With a later list without the sensor", () => {
      it("devices no longer holds it and its messages are not delivered", async () => {
        const made = await withDevices(LIST_WITH_SENSOR);
        const sensorId = "z2m:0x0000000000000005";
        made.transport.follow(new Set([sensorId]));
        made.mqtt.deliver(topic("bridge/devices"), DEVICES);
        expect(made.transport.devices().has(sensorId)).toBe(false);
        made.events.length = 0;
        made.mqtt.deliver(topic("test/sensor"), { last_seen: "a" });
        expect(made.events).toEqual([]);
      });
    });

    describe("With a payload that is not a JSON array", () => {
      it("the list is kept and nothing is sent", async () => {
        const made = await withDevices();
        for (const payload of ["not json", "{}", "null", "5", Buffer.alloc(0)]) {
          made.mqtt.deliver(topic("bridge/devices"), payload);
        }
        expect(made.events).toEqual([]);
        expect([...made.transport.devices().keys()].sort()).toEqual([TRVZB.id, TRV_ZBT.id]);
      });
    });
  });

  describe("messages", () => {
    async function following(): Promise<Harness> {
      const made = await withDevices();
      made.transport.follow(new Set([TRVZB.id]));
      return made;
    }

    describe('With a followed device publishing a JSON object with last_seen "2026-01-01T00:00:01.000Z"', () => {
      const payload = { last_seen: "2026-01-01T00:00:01.000Z", system_mode: "auto" };

      it("sends a message event with the payload and the device id", async () => {
        const made = await following();
        made.mqtt.deliver(topic(TRVZB.name), payload);
        expect(made.events).toEqual([
          {
            kind: "message",
            deviceId: TRVZB.id,
            payload,
            lifeToken: "2026-01-01T00:00:01.000Z",
          },
        ]);
      });

      it('lifeToken is "2026-01-01T00:00:01.000Z"', async () => {
        const made = await following();
        made.mqtt.deliver(topic(TRVZB.name), payload);
        expect(made.events[0]).toMatchObject({ lifeToken: "2026-01-01T00:00:01.000Z" });
      });
    });

    describe("With last_seen given as the number 1767225601000", () => {
      it('lifeToken is "1767225601000"', async () => {
        const made = await following();
        made.mqtt.deliver(topic(TRVZB.name), { last_seen: 1767225601000 });
        expect(made.events[0]).toMatchObject({ lifeToken: "1767225601000" });
      });
    });

    describe("With no last_seen in the payload", () => {
      it("lifeToken is undefined", async () => {
        const made = await following();
        made.mqtt.deliver(topic(TRVZB.name), { system_mode: "auto" });
        expect(made.events).toHaveLength(1);
        expect(made.events[0]).toMatchObject({ kind: "message", lifeToken: undefined });
      });
    });

    describe("With a device that is not followed", () => {
      it("sends nothing", async () => {
        const made = await following();
        made.mqtt.deliver(topic(TRV_ZBT.name), { last_seen: "a" });
        expect(made.mqtt.filters()).not.toContain(topic(TRV_ZBT.name));
        expect(made.events).toEqual([]);
      });
    });

    describe("With a payload that is empty, not JSON, or JSON that is not an object", () => {
      it("sends nothing and does not throw", async () => {
        const made = await following();
        for (const payload of [Buffer.alloc(0), "garbage", "[1]", "5", "null", '"text"']) {
          expect(() => {
            made.mqtt.deliver(topic(TRVZB.name), payload);
          }).not.toThrow();
        }
        expect(made.events).toEqual([]);
      });
    });

    describe("With a message on <name>/set, <name>/get or <name>/availability", () => {
      it("sends nothing", async () => {
        const made = await following();
        for (const suffix of ["set", "get", "availability"]) {
          made.mqtt.deliver(topic(`${TRVZB.name}/${suffix}`), { state: "online" });
        }
        expect(made.mqtt.filters().filter((filter) => filter.includes("/set"))).toEqual([]);
        expect(made.mqtt.filters()).toContain(topic(TRVZB.name));
        expect(
          made.mqtt.filters().filter((filter) => filter.startsWith(topic(`${TRVZB.name}/`))),
        ).toEqual([]);
        expect(made.events).toEqual([]);
      });
    });

    describe('With a friendly name holding a slash ("kitchen/valve")', () => {
      it("its messages are delivered", async () => {
        const made = await withDevices([
          ...DEVICES,
          { ...SENSOR, ieee_address: "0x0000000000000007", friendly_name: "kitchen/valve" },
        ]);
        made.transport.follow(new Set(["z2m:0x0000000000000007"]));
        made.mqtt.deliver(topic("kitchen/valve"), { last_seen: "a" });
        expect(made.events).toHaveLength(1);
        expect(made.events[0]).toMatchObject({ deviceId: "z2m:0x0000000000000007" });
      });
    });
  });

  describe("follow", () => {
    describe("With a new set", () => {
      it("devices dropped from the set stop being delivered", async () => {
        const made = await withDevices();
        made.transport.follow(new Set([TRVZB.id]));
        made.transport.follow(new Set([TRV_ZBT.id]));
        made.mqtt.deliver(topic(TRVZB.name), { last_seen: "a" });
        expect(made.events).toEqual([]);
      });

      it("devices added to the set are delivered", async () => {
        const made = await withDevices();
        made.transport.follow(new Set([TRVZB.id]));
        made.transport.follow(new Set([TRVZB.id, TRV_ZBT.id]));
        made.mqtt.deliver(topic(TRV_ZBT.name), { last_seen: "a" });
        expect(made.events).toHaveLength(1);
        expect(made.events[0]).toMatchObject({ deviceId: TRV_ZBT.id });
      });
    });

    describe("With an id that is not in the device list yet", () => {
      it("its messages are delivered once the device is listed", async () => {
        const made = await harness();
        made.transport.follow(new Set([TRVZB.id]));
        made.mqtt.deliver(topic("bridge/devices"), DEVICES);
        made.events.length = 0;
        made.mqtt.deliver(topic(TRVZB.name), { last_seen: "a" });
        expect(made.events).toHaveLength(1);
        expect(made.events[0]).toMatchObject({ kind: "message", deviceId: TRVZB.id });
      });
    });
  });

  describe("publish", () => {
    describe("Always", () => {
      it("publishes the payload as JSON to <base>/<friendly name>/set with QoS 1, not retained", async () => {
        const made = await withDevices();
        await made.transport.publish(TRVZB.id, { occupied_heating_setpoint: 19.5 });
        expect(made.mqtt.sent()).toEqual([
          {
            topic: topic(`${TRVZB.name}/set`),
            payload: JSON.stringify({ occupied_heating_setpoint: 19.5 }),
            qos: 1,
            retain: false,
          },
        ]);
      });
    });

    describe("With a device id that is not in the list", () => {
      it("rejects with HeatmasterError device_unknown and publishes nothing", async () => {
        const made = await withDevices();
        const error = await rejectionOf(made.transport.publish("z2m:0x00ff", { a: 1 }));
        expect(error).toBeInstanceOf(HeatmasterError);
        expect(error).toMatchObject({ code: "device_unknown", data: { deviceId: "z2m:0x00ff" } });
        expect(made.mqtt.sent()).toEqual([]);
      });
    });

    describe("While the MQTT client is not connected", () => {
      it("rejects with HeatmasterError mqtt_not_connected", async () => {
        const made = await withDevices();
        made.mqtt.set("disconnected");
        const error = await rejectionOf(made.transport.publish(TRVZB.id, { a: 1 }));
        expect((error as HeatmasterError).code).toBe("mqtt_not_connected");
      });
    });
  });

  describe("read", () => {
    describe("Always", () => {
      it("publishes the payload as JSON to <base>/<friendly name>/get with QoS 1, not retained", async () => {
        const made = await withDevices();
        await made.transport.read(TRVZB.id, { system_mode: "" });
        expect(made.mqtt.sent()).toEqual([
          {
            topic: topic(`${TRVZB.name}/get`),
            payload: JSON.stringify({ system_mode: "" }),
            qos: 1,
            retain: false,
          },
        ]);
      });
    });

    describe("With a device id that is not in the list", () => {
      it("rejects with HeatmasterError device_unknown and publishes nothing", async () => {
        const made = await withDevices();
        const error = await rejectionOf(made.transport.read("z2m:0x00ff", { a: "" }));
        expect(error).toMatchObject({ code: "device_unknown", data: { deviceId: "z2m:0x00ff" } });
        expect(made.mqtt.sent()).toEqual([]);
      });
    });
  });

  describe("link", () => {
    describe("With MQTT connected and the bridge state online", () => {
      it("linkUp is true", async () => {
        const { mqtt, transport } = await harness();
        mqtt.deliver(topic("bridge/state"), ONLINE);
        expect(transport.linkUp()).toBe(true);
      });

      it("one link_up was sent and no bridge_restarted", async () => {
        const { mqtt, events } = await harness();
        mqtt.deliver(topic("bridge/state"), ONLINE);
        expect(kinds(events)).toEqual(["link_up"]);
      });
    });

    describe('With the bridge state given as plain text "online"', () => {
      it("it is understood like the JSON form", async () => {
        const { mqtt, transport, events } = await harness();
        mqtt.deliver(topic("bridge/state"), "online");
        expect(transport.linkUp()).toBe(true);
        expect(kinds(events)).toEqual(["link_up"]);
        mqtt.deliver(topic("bridge/state"), "offline");
        expect(transport.linkUp()).toBe(false);
      });
    });

    describe("When the bridge state turns offline", () => {
      it("sends link_down and linkUp is false", async () => {
        const { mqtt, transport, events } = await harness();
        mqtt.deliver(topic("bridge/state"), ONLINE);
        events.length = 0;
        mqtt.deliver(topic("bridge/state"), OFFLINE);
        expect(kinds(events)).toEqual(["link_down"]);
        expect(transport.linkUp()).toBe(false);
      });
    });

    describe("When it turns online again", () => {
      it("sends link_up, then bridge_restarted", async () => {
        const { mqtt, events } = await harness();
        mqtt.deliver(topic("bridge/state"), ONLINE);
        mqtt.deliver(topic("bridge/state"), OFFLINE);
        events.length = 0;
        mqtt.deliver(topic("bridge/state"), ONLINE);
        expect(kinds(events)).toEqual(["link_up", "bridge_restarted"]);
      });
    });

    describe("With the first bridge state seen being offline, then online", () => {
      it("sends link_up, then bridge_restarted", async () => {
        const { mqtt, events } = await harness();
        mqtt.deliver(topic("bridge/state"), OFFLINE);
        mqtt.deliver(topic("bridge/state"), ONLINE);
        expect(kinds(events)).toEqual(["link_up", "bridge_restarted"]);
      });
    });

    describe("With an online that follows an online", () => {
      it("sends nothing more (a replay of the state is not a restart)", async () => {
        const { mqtt, events } = await harness();
        mqtt.deliver(topic("bridge/state"), ONLINE);
        mqtt.deliver(topic("bridge/state"), ONLINE);
        expect(kinds(events)).toEqual(["link_up"]);
      });
    });

    describe("When the MQTT connection is lost and comes back, the bridge still online", () => {
      it("sends link_down, then link_up, then bridge_restarted", async () => {
        const { mqtt, transport, events } = await harness();
        mqtt.deliver(topic("bridge/state"), ONLINE);
        events.length = 0;
        mqtt.set("disconnected");
        mqtt.emit({ kind: "disconnected" });
        expect(transport.linkUp()).toBe(false);
        mqtt.set("connected");
        mqtt.emit({ kind: "connected", first: false });
        mqtt.deliver(topic("bridge/state"), ONLINE);
        expect(kinds(events)).toEqual(["link_down", "link_up", "bridge_restarted"]);
      });
    });

    describe("When the MQTT client is taken over", () => {
      it("sends link_down; linkUp is false and fault is another_instance", async () => {
        const { mqtt, transport, events } = await harness();
        mqtt.deliver(topic("bridge/state"), ONLINE);
        events.length = 0;
        mqtt.set("ended", "another_instance");
        mqtt.emit({ kind: "taken_over" });
        expect(kinds(events)).toEqual(["link_down"]);
        expect(transport.linkUp()).toBe(false);
        expect(transport.fault()).toBe("another_instance");
      });
    });
  });

  describe("rejoin", () => {
    function event(type: string, data: Record<string, unknown>): unknown {
      return { type, data };
    }

    describe("With a bridge/event device_announce for a known device", () => {
      it("sends rejoined with its id", async () => {
        const made = await withDevices();
        made.mqtt.deliver(topic("bridge/event"), ANNOUNCE);
        expect(made.events).toEqual([{ kind: "rejoined", deviceId: TRVZB.id }]);
      });
    });

    describe("With device_joined, device_interview with any status, device_leave, or any event for an unknown device", () => {
      it("sends nothing", async () => {
        const made = await withDevices();
        const data = { friendly_name: TRVZB.name, ieee_address: TRVZB.ieee };
        made.mqtt.deliver(topic("bridge/event"), event("device_joined", data));
        for (const status of ["started", "successful", "failed"]) {
          made.mqtt.deliver(topic("bridge/event"), event("device_interview", { ...data, status }));
        }
        made.mqtt.deliver(topic("bridge/event"), event("device_leave", data));
        made.mqtt.deliver(
          topic("bridge/event"),
          event("device_announce", { ...data, ieee_address: "0x00ff" }),
        );
        made.mqtt.deliver(topic("bridge/event"), "not json");
        expect(made.events).toEqual([]);
      });
    });

    describe("With device_joined, a successful device_interview and device_announce for one device, in that order", () => {
      it("sends rejoined once", async () => {
        const made = await withDevices();
        const data = { friendly_name: TRVZB.name, ieee_address: TRVZB.ieee };
        made.mqtt.deliver(topic("bridge/event"), event("device_joined", data));
        made.mqtt.deliver(
          topic("bridge/event"),
          event("device_interview", { ...data, status: "successful" }),
        );
        made.mqtt.deliver(topic("bridge/event"), event("device_announce", data));
        expect(made.events).toEqual([{ kind: "rejoined", deviceId: TRVZB.id }]);
      });
    });
  });

  describe("stop", () => {
    describe("Always", () => {
      it("later bridge and device messages produce no events", async () => {
        const made = await withDevices();
        made.transport.follow(new Set([TRVZB.id]));
        await made.transport.stop();
        made.events.length = 0;
        made.mqtt.deliver(topic("bridge/state"), ONLINE);
        made.mqtt.deliver(topic("bridge/devices"), LIST_WITH_SENSOR);
        made.mqtt.deliver(topic("bridge/event"), ANNOUNCE);
        made.mqtt.deliver(topic(TRVZB.name), { last_seen: "a" });
        made.mqtt.emit({ kind: "disconnected" });
        expect(made.events).toEqual([]);
        expect(made.mqtt.filters()).toEqual([]);
      });

      it("the MQTT client is still connected", async () => {
        const made = await withDevices();
        await made.transport.stop();
        expect(made.mqtt.state()).toBe("connected");
      });
    });
  });

  describe("buildTransports", () => {
    describe("Always", () => {
      it("returns one transport under the key z2m", () => {
        const transports = buildTransports(stubMqtt(), { baseTopic: undefined });
        expect(Object.keys(transports)).toEqual(["z2m"]);
        expect(transports.z2m?.key).toBe("z2m");
      });
    });
  });

  describe("with the real MQTT client and the fake Zigbee2MQTT", () => {
    async function live(options: { lastSeen?: string } = {}): Promise<{
      fake: FakeZ2m;
      client: MqttClient;
      transport: Transport;
      events: RawEvent[];
    }> {
      const fake = await startFakeZ2m(options);
      cleanups.push(() => fake.stop());
      fake.addDevice(
        { ieee: TRVZB.ieee, name: TRVZB.name, modelId: "TRVZB" },
        { system_mode: "auto" },
      );
      const client = createMqttClient(
        { url: fake.url, username: undefined, password: undefined, clientId: undefined },
        systemClock,
        { reconnectPeriodMs: 20, connectTimeoutMs: 2000, authRetryMs: 300 },
      );
      cleanups.push(() => client.end());
      const transport = createZ2mTransport(client, { baseTopic: undefined });
      cleanups.push(() => transport.stop());
      const events: RawEvent[] = [];
      await client.connect();
      await transport.start((event) => events.push(event));
      await vi.waitFor(
        () => {
          expect(transport.devices().has(TRVZB.id)).toBe(true);
          expect(transport.linkUp()).toBe(true);
        },
        { timeout: 5000, interval: 5 },
      );
      transport.follow(new Set([TRVZB.id]));
      return { fake, client, transport, events };
    }

    it("a followed device that speaks produces a message event with its last_seen as lifeToken", async () => {
      const { fake, events } = await live();
      await vi.waitFor(
        () => {
          fake.speak(TRVZB.ieee, { system_mode: "heat" });
          expect(events.some((event) => event.kind === "message")).toBe(true);
        },
        { timeout: 5000, interval: 5 },
      );
      const message = events.find((event) => event.kind === "message");
      expect(message).toMatchObject({
        deviceId: TRVZB.id,
        payload: { system_mode: "heat" },
      });
      expect((message as { lifeToken: string | undefined }).lifeToken).toMatch(
        /^2026-01-01T00:00:\d\d\.000Z$/,
      );
    });

    it("a numeric last_seen becomes its decimal text", async () => {
      const { fake, events } = await live({ lastSeen: "epoch" });
      await vi.waitFor(
        () => {
          fake.speak(TRVZB.ieee);
          expect(events.some((event) => event.kind === "message")).toBe(true);
        },
        { timeout: 5000, interval: 5 },
      );
      const message = events.find((event) => event.kind === "message");
      expect((message as { lifeToken: string | undefined }).lifeToken).toMatch(/^1767225\d{6}$/);
    });

    it("publish and read reach the broker on the set and get topics with QoS 1, not retained", async () => {
      const { fake, transport } = await live();
      await transport.publish(TRVZB.id, { occupied_heating_setpoint: 20 });
      await transport.read(TRVZB.id, { system_mode: "" });
      await vi.waitFor(
        () => {
          expect(fake.received(TRVZB.ieee)).toHaveLength(2);
        },
        { timeout: 5000, interval: 5 },
      );
      expect(fake.received(TRVZB.ieee)).toEqual([
        { kind: "set", payload: { occupied_heating_setpoint: 20 }, qos: 1, retain: false },
        { kind: "get", payload: { system_mode: "" }, qos: 1, retain: false },
      ]);
    });
  });
});
