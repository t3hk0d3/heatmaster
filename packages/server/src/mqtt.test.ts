import net from "node:net";
import type { IConnectPacket, IPublishPacket } from "mqtt-packet";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startFakeZ2m, type FakeZ2m } from "../test/fake-z2m.ts";
import { createManualClock, type ManualClock } from "../test/manual-clock.ts";
import { setTimeout as pause } from "node:timers/promises";
import { rejectionOf } from "../test/rejection.ts";
import { startRawBroker, type RawBroker } from "../test/raw-broker.ts";
import { HeatmasterError } from "./errors.ts";
import {
  PUBLISH_TIMEOUT_MS,
  STATUS_OFFLINE,
  STATUS_ONLINE,
  STATUS_TOPIC,
  createMqttClient,
  type MqttClient,
  type MqttEvent,
  type MqttOptions,
  type MqttTuning,
} from "./mqtt.ts";

const TUNING: MqttTuning = { reconnectPeriodMs: 20, connectTimeoutMs: 2000, authRetryMs: 300 };
const WAIT = { timeout: 8000, interval: 5 };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function until(check: () => void): Promise<void> {
  return vi.waitFor(check, WAIT);
}

async function rawBroker(port?: number): Promise<RawBroker> {
  const broker = await startRawBroker(port === undefined ? {} : { port });
  cleanups.push(() => broker.stop());
  return broker;
}

async function fakeZ2m(): Promise<FakeZ2m> {
  const fake = await startFakeZ2m();
  cleanups.push(() => fake.stop());
  return fake;
}

type Made = Readonly<{ client: MqttClient; events: MqttEvent[]; clock: ManualClock }>;

function make(options: Partial<MqttOptions> & Pick<MqttOptions, "url">, tuning = TUNING): Made {
  const clock = createManualClock(1_000_000);
  const client = createMqttClient(
    { username: undefined, password: undefined, clientId: undefined, ...options },
    clock,
    tuning,
  );
  const events: MqttEvent[] = [];
  client.onEvent((event) => events.push(event));
  cleanups.push(() => {
    // The offline status may wait for an acknowledgement that never comes; its timer is the clock's.
    const ended = client.end();
    clock.advance(PUBLISH_TIMEOUT_MS);
    return ended;
  });
  return { client, events, clock };
}

/** Connects, and waits until the "online" status has been acknowledged. */
async function up(made: Made): Promise<void> {
  await made.client.connect();
  await until(() => {
    expect(made.clock.pending()).toBe(0);
  });
}

function connects(broker: RawBroker): IConnectPacket[] {
  return broker
    .packets()
    .map((recorded) => recorded.packet)
    .filter((packet): packet is IConnectPacket => packet.cmd === "connect");
}

function publishes(broker: RawBroker, topic?: string): IPublishPacket[] {
  return broker
    .packets()
    .map((recorded) => recorded.packet)
    .filter(
      (packet): packet is IPublishPacket =>
        packet.cmd === "publish" && (topic === undefined || packet.topic === topic),
    );
}

function kinds(events: readonly MqttEvent[]): string[] {
  return events.map((event) => event.kind);
}

async function freeAddress(): Promise<{ port: number; url: string }> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return { port, url: `mqtt://127.0.0.1:${String(port)}` };
}

/** Delivers `text` on `topic` again and again until `handler` has seen it. */
async function injectUntilSeen(
  fake: FakeZ2m,
  topic: string,
  seen: () => boolean,
  text = "x",
): Promise<void> {
  await until(() => {
    fake.inject(topic, text);
    expect(seen()).toBe(true);
  });
}

describe("mqtt", () => {
  describe("connect", () => {
    describe("With a broker that speaks MQTT 5 (the raw broker)", () => {
      it("connect resolves; state is connected and protocol is 5", async () => {
        const broker = await rawBroker();
        const { client } = make({ url: broker.url });
        await client.connect();
        expect(client.state()).toBe("connected");
        expect(client.protocol()).toBe(5);
      });

      it('the CONNECT packet carries client id "heatmaster", a clean session, and the will "offline" on heatmaster/status, QoS 1, retained', async () => {
        const broker = await rawBroker();
        const { client } = make({ url: broker.url });
        await client.connect();
        const [connect] = connects(broker);
        expect(connect?.clientId).toBe("heatmaster");
        expect(connect?.clean).toBe(true);
        expect(connect?.protocolVersion).toBe(5);
        expect(connect?.will?.topic).toBe("heatmaster/status");
        expect(String(connect?.will?.payload)).toBe("offline");
        expect(connect?.will?.qos).toBe(1);
        expect(connect?.will?.retain).toBe(true);
      });

      it('"online" is published on heatmaster/status, QoS 1, retained', async () => {
        const broker = await rawBroker();
        const { client } = make({ url: broker.url });
        await client.connect();
        await until(() => {
          expect(publishes(broker, STATUS_TOPIC)).toHaveLength(1);
        });
        const [status] = publishes(broker, STATUS_TOPIC);
        expect(String(status?.payload)).toBe(STATUS_ONLINE);
        expect(status?.qos).toBe(1);
        expect(status?.retain).toBe(true);
      });

      it("one connected event with first true", async () => {
        const broker = await rawBroker();
        const { client, events } = make({ url: broker.url });
        await client.connect();
        expect(events).toEqual([{ kind: "connected", first: true }]);
      });
    });

    describe('With clientId "heatmaster-test", a username and a password in the options', () => {
      it("the CONNECT packet carries all three", async () => {
        const broker = await rawBroker();
        const { client } = make({
          url: broker.url,
          clientId: "heatmaster-test",
          username: "user",
          password: "pass",
        });
        await client.connect();
        const [connect] = connects(broker);
        expect(connect?.clientId).toBe("heatmaster-test");
        expect(connect?.username).toBe("user");
        expect(String(connect?.password)).toBe("pass");
      });
    });

    describe("With a broker that speaks only MQTT 3.1.1 (the fake Zigbee2MQTT)", () => {
      it("connect resolves; state is connected and protocol is 4", async () => {
        const fake = await fakeZ2m();
        const { client } = make({ url: fake.url });
        await client.connect();
        expect(client.state()).toBe("connected");
        expect(client.protocol()).toBe(4);
      });
    });

    describe("With no broker at the address", () => {
      it("connect resolves after two failed attempts, both made with MQTT 5", async () => {
        const address = await freeAddress();
        const { client } = make({ url: address.url });
        await client.connect();
        // A broker that appears afterwards sees MQTT 5 first: the version was never changed.
        const broker = await rawBroker(address.port);
        await until(() => {
          expect(connects(broker).length).toBeGreaterThan(0);
        });
        expect(connects(broker)[0]?.protocolVersion).toBe(5);
      });

      it("state is not connected and fault is mqtt_unavailable", async () => {
        const address = await freeAddress();
        const { client } = make({ url: address.url });
        await client.connect();
        expect(client.state()).not.toBe("connected");
        expect(client.fault()).toBe("mqtt_unavailable");
        expect(client.protocol()).toBeUndefined();
      });
    });

    describe("With a broker that turns a version 5 CONNECT down (the fake Zigbee2MQTT)", () => {
      it("the next attempt uses 3.1.1", async () => {
        const fake = await fakeZ2m();
        const { client } = make({ url: fake.url });
        await client.connect();
        expect(client.protocol()).toBe(4);
        expect(fake.attempts()).toBe(2);
      });
    });

    describe("With a broker that refuses the login (the raw broker)", () => {
      it("fault is mqtt_auth_failed and state is not connected", async () => {
        const broker = await rawBroker();
        broker.refuseLogin(true);
        const { client } = make({ url: broker.url });
        await client.connect();
        expect(client.fault()).toBe("mqtt_auth_failed");
        expect(client.state()).not.toBe("connected");
      });

      it("the next attempt is made after authRetryMs, not after reconnectPeriodMs, and again with MQTT 5", async () => {
        const broker = await rawBroker();
        broker.refuseLogin(true);
        const { client } = make({ url: broker.url });
        await client.connect();
        const stamps = broker
          .packets()
          .filter((recorded) => recorded.packet.cmd === "connect")
          .map((recorded) => recorded.at);
        expect(stamps).toHaveLength(2);
        expect((stamps[1] ?? 0) - (stamps[0] ?? 0)).toBeGreaterThanOrEqual(TUNING.authRetryMs - 30);
        expect(connects(broker).map((packet) => packet.protocolVersion)).toEqual([5, 5]);
      });
    });

    describe("When that broker accepts the login afterwards", () => {
      it("state becomes connected and fault is undefined", async () => {
        const broker = await rawBroker();
        broker.refuseLogin(true);
        const { client } = make({ url: broker.url });
        await client.connect();
        broker.refuseLogin(false);
        await until(() => {
          expect(client.state()).toBe("connected");
        });
        expect(client.fault()).toBeUndefined();
      });
    });

    describe("When the broker appears afterwards", () => {
      it("state becomes connected and fault is undefined", async () => {
        const address = await freeAddress();
        const { client } = make({ url: address.url });
        await client.connect();
        await rawBroker(address.port);
        await until(() => {
          expect(client.state()).toBe("connected");
        });
        expect(client.fault()).toBeUndefined();
      });
    });
  });

  describe("subscribe", () => {
    describe("With a handler registered before connect", () => {
      it("a message on its topic reaches it once the client is connected", async () => {
        const fake = await fakeZ2m();
        const { client } = make({ url: fake.url });
        const handler = vi.fn();
        client.subscribe("t/a", handler);
        await client.connect();
        await injectUntilSeen(fake, "t/a", () => handler.mock.calls.length > 0, "hello");
        const [topic, payload] = handler.mock.calls[0] as [string, Buffer, boolean];
        expect(topic).toBe("t/a");
        expect(payload.toString()).toBe("hello");
      });
    });

    describe("With two handlers on one topic", () => {
      it("both receive the message", async () => {
        const fake = await fakeZ2m();
        const { client } = make({ url: fake.url });
        const first = vi.fn();
        const second = vi.fn();
        client.subscribe("t/a", first);
        client.subscribe("t/a", second);
        await client.connect();
        await injectUntilSeen(fake, "t/a", () => first.mock.calls.length > 0);
        await until(() => {
          expect(second).toHaveBeenCalled();
        });
      });
    });

    describe("With a message on another topic", () => {
      it("the handler is not called", async () => {
        const fake = await fakeZ2m();
        const { client } = make({ url: fake.url });
        const handler = vi.fn();
        const barrier = vi.fn();
        client.subscribe("t/a", handler);
        client.subscribe("t/barrier", barrier);
        await client.connect();
        await until(() => {
          fake.inject("t/b", "x");
          fake.inject("t/barrier", "x");
          expect(barrier).toHaveBeenCalled();
        });
        expect(handler).not.toHaveBeenCalled();
      });
    });

    describe("After the returned function was called", () => {
      it("the handler is not called again", async () => {
        const fake = await fakeZ2m();
        const { client } = make({ url: fake.url });
        const removed = vi.fn();
        const kept = vi.fn();
        const off = client.subscribe("t/a", removed);
        client.subscribe("t/a", kept);
        await client.connect();
        await injectUntilSeen(fake, "t/a", () => removed.mock.calls.length > 0);
        off();
        const before = removed.mock.calls.length;
        const keptBefore = kept.mock.calls.length;
        await injectUntilSeen(fake, "t/a", () => kept.mock.calls.length > keptBefore + 1);
        expect(removed.mock.calls.length).toBe(before);
      });
    });

    describe("After the connection was lost and came back", () => {
      it("a message on the topic reaches the handler again", async () => {
        const fake = await fakeZ2m();
        const { client, events } = make({ url: fake.url });
        const handler = vi.fn();
        client.subscribe("t/a", handler);
        await client.connect();
        await injectUntilSeen(fake, "t/a", () => handler.mock.calls.length > 0);
        fake.dropClients();
        await until(() => {
          expect(events.filter((event) => event.kind === "connected")).toHaveLength(2);
        });
        const before = handler.mock.calls.length;
        await injectUntilSeen(fake, "t/a", () => handler.mock.calls.length > before);
      });
    });

    describe("With a handler that throws", () => {
      it("the other handler still receives the message and the client stays connected", async () => {
        const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const fake = await fakeZ2m();
        const { client } = make({ url: fake.url });
        const other = vi.fn();
        client.subscribe("t/a", () => {
          throw new Error("boom");
        });
        client.subscribe("t/a", other);
        await client.connect();
        await injectUntilSeen(fake, "t/a", () => other.mock.calls.length > 0);
        expect(client.state()).toBe("connected");
        expect(logged).toHaveBeenCalled();
      });
    });

    describe("With the filter a/+/c and messages on a/b/c and a/b/d", () => {
      it("the handler receives the first, with the topic a/b/c, and not the second", async () => {
        const fake = await fakeZ2m();
        const { client } = make({ url: fake.url });
        const handler = vi.fn();
        client.subscribe("a/+/c", handler);
        await client.connect();
        await until(() => {
          fake.inject("a/b/d", "x");
          fake.inject("a/b/c", "x");
          expect(handler).toHaveBeenCalled();
        });
        const topics = new Set(handler.mock.calls.map((call: unknown[]) => call[0]));
        expect([...topics]).toEqual(["a/b/c"]);
      });
    });

    describe("With a retained message that the broker delivers on subscribing", () => {
      it("the handler's retained flag is true", async () => {
        const fake = await fakeZ2m();
        fake.inject("t/kept", "old", true);
        const { client } = make({ url: fake.url });
        const handler = vi.fn();
        client.subscribe("t/kept", handler);
        await client.connect();
        await until(() => {
          expect(handler).toHaveBeenCalled();
        });
        expect((handler.mock.calls[0] as unknown[])[2]).toBe(true);
      });
    });

    describe("With a message published after subscribing", () => {
      it("the handler's retained flag is false", async () => {
        const fake = await fakeZ2m();
        const { client } = make({ url: fake.url });
        const handler = vi.fn();
        client.subscribe("t/live", handler);
        await client.connect();
        await injectUntilSeen(fake, "t/live", () => handler.mock.calls.length > 0);
        for (const call of handler.mock.calls as unknown[][]) expect(call[2]).toBe(false);
      });
    });

    describe('With a filter holding #, or + inside a level ("a/b+/c")', () => {
      it("throws HeatmasterError topic_invalid", () => {
        const { client } = make({ url: "mqtt://127.0.0.1:1" });
        for (const filter of ["a/#", "#", "a/b+/c", "+a", ""]) {
          let thrown: unknown;
          try {
            client.subscribe(filter, () => undefined);
          } catch (error) {
            thrown = error;
          }
          expect(thrown, filter).toBeInstanceOf(HeatmasterError);
          expect((thrown as HeatmasterError).code).toBe("topic_invalid");
        }
      });
    });
  });

  describe("publish", () => {
    describe("While connected, with qos 1 and retain false", () => {
      it("the broker receives the payload on the topic with QoS 1, not retained", async () => {
        const broker = await rawBroker();
        const { client } = make({ url: broker.url });
        await client.connect();
        await client.publish("x/y", "payload", { qos: 1, retain: false });
        const [sent] = publishes(broker, "x/y");
        expect(String(sent?.payload)).toBe("payload");
        expect(sent?.qos).toBe(1);
        expect(sent?.retain).toBe(false);
      });

      it("the promise resolves", async () => {
        const broker = await rawBroker();
        const { client } = make({ url: broker.url });
        await client.connect();
        await expect(
          client.publish("x/y", "p", { qos: 1, retain: false }),
        ).resolves.toBeUndefined();
      });
    });

    describe("While not connected", () => {
      it("rejects with HeatmasterError mqtt_not_connected", async () => {
        const broker = await rawBroker();
        const { client } = make({ url: broker.url });
        const error = await rejectionOf(client.publish("x/y", "p", { qos: 1, retain: false }));
        expect(error).toBeInstanceOf(HeatmasterError);
        expect((error as HeatmasterError).code).toBe("mqtt_not_connected");
      });

      it("the broker receives nothing after the client has reconnected", async () => {
        const broker = await rawBroker();
        const { client } = make({ url: broker.url });
        await client.publish("x/y", "p", { qos: 1, retain: false }).catch(() => undefined);
        await client.connect();
        await until(() => {
          expect(publishes(broker, STATUS_TOPIC)).toHaveLength(1);
        });
        expect(publishes(broker, "x/y")).toHaveLength(0);
      });
    });

    describe("With no acknowledgement within PUBLISH_TIMEOUT_MS", () => {
      async function withheld(): Promise<{ broker: RawBroker; made: Made; error: unknown }> {
        const broker = await rawBroker();
        const made = make({ url: broker.url });
        await made.client.connect();
        await until(() => {
          expect(publishes(broker, STATUS_TOPIC)).toHaveLength(1);
        });
        broker.withholdAcks(true);
        const settled = made.client.publish("x/y", "p", { qos: 1, retain: false }).then(
          () => undefined,
          (e: unknown) => e,
        );
        await until(() => {
          expect(publishes(broker, "x/y")).toHaveLength(1);
        });
        made.clock.advance(PUBLISH_TIMEOUT_MS);
        return { broker, made, error: await settled };
      }

      it("rejects with HeatmasterError mqtt_timeout", async () => {
        const { error } = await withheld();
        expect(error).toBeInstanceOf(HeatmasterError);
        expect((error as HeatmasterError).code).toBe("mqtt_timeout");
      });

      it("the message is not sent again after a reconnect", async () => {
        const { broker, made } = await withheld();
        broker.withholdAcks(false);
        broker.drop();
        await until(() => {
          expect(made.events.filter((event) => event.kind === "connected")).toHaveLength(2);
        });
        await until(() => {
          expect(publishes(broker, STATUS_TOPIC)).toHaveLength(2);
        });
        expect(publishes(broker, "x/y")).toHaveLength(1);
      });
    });

    describe("With a PUBACK that carries a refusing reason code", () => {
      it("rejects with HeatmasterError mqtt_refused, with the reason code in data", async () => {
        const broker = await rawBroker();
        const made = make({ url: broker.url });
        await up(made);
        broker.refusePublishes(135);
        const error = await rejectionOf(made.client.publish("x/y", "p", { qos: 1, retain: false }));
        expect(error).toBeInstanceOf(HeatmasterError);
        expect(error).toMatchObject({ code: "mqtt_refused", data: { reasonCode: "135" } });
      });
    });

    describe("With an empty payload and retain true", () => {
      it("the broker receives an empty retained message", async () => {
        const broker = await rawBroker();
        const { client } = make({ url: broker.url });
        await client.connect();
        await client.publish("x/clear", "", { qos: 1, retain: true });
        const [sent] = publishes(broker, "x/clear");
        expect(sent?.payload).toHaveLength(0);
        expect(sent?.retain).toBe(true);
      });
    });
  });

  describe("connection events", () => {
    describe("When the connection is lost and comes back", () => {
      it("a disconnected event, then a connected event with first false", async () => {
        const broker = await rawBroker();
        const made = make({ url: broker.url });
        const { events } = made;
        await up(made);
        broker.drop();
        await until(() => {
          expect(events).toHaveLength(3);
        });
        expect(events).toEqual([
          { kind: "connected", first: true },
          { kind: "disconnected" },
          { kind: "connected", first: false },
        ]);
      });

      it('"online" is published again', async () => {
        const broker = await rawBroker();
        const made = make({ url: broker.url });
        await up(made);
        broker.drop();
        await until(() => {
          expect(publishes(broker, STATUS_TOPIC)).toHaveLength(2);
        });
        expect(publishes(broker, STATUS_TOPIC).map((packet) => String(packet.payload))).toEqual([
          STATUS_ONLINE,
          STATUS_ONLINE,
        ]);
      });

      it("fault stays undefined", async () => {
        const broker = await rawBroker();
        const made = make({ url: broker.url });
        const { client, events } = made;
        await up(made);
        broker.drop();
        await until(() => {
          expect(kinds(events)).toContain("disconnected");
        });
        expect(client.fault()).toBeUndefined();
        await until(() => {
          expect(client.state()).toBe("connected");
        });
        expect(client.fault()).toBeUndefined();
      });
    });

    describe("After the function returned by onEvent was called", () => {
      it("that listener receives no further event and the other listeners still do", async () => {
        const broker = await rawBroker();
        const made = make({ url: broker.url });
        const { client, events } = made;
        const removed = vi.fn();
        const off = client.onEvent(removed);
        await up(made);
        expect(removed).toHaveBeenCalledTimes(1);
        off();
        broker.drop();
        await until(() => {
          expect(events).toHaveLength(3);
        });
        expect(removed).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe("takeover", () => {
    /** Drops the connection `count` times; before each drop after the first, time passes. */
    async function drops(made: Made, drop: () => void, gapsMs: readonly number[]): Promise<void> {
      const before = made.events.filter((event) => event.kind === "disconnected").length;
      let lost = before;
      for (const gap of gapsMs) {
        made.clock.advance(gap);
        drop();
        lost += 1;
        await until(() => {
          expect(made.events.filter((event) => event.kind === "disconnected")).toHaveLength(lost);
        });
        if (made.client.state() === "ended") return;
        await until(() => {
          expect(made.events.filter((event) => event.kind === "connected")).toHaveLength(lost + 1);
        });
      }
    }

    async function expectTakenOver(made: Made, attempts: () => number): Promise<void> {
      expect(made.client.state()).toBe("ended");
      expect(made.client.fault()).toBe("another_instance");
      expect(made.events.filter((event) => event.kind === "taken_over")).toHaveLength(1);
      // No new connection is attempted afterwards; give a stray attempt real time to show up.
      const before = attempts();
      await pause(150);
      expect(attempts()).toBe(before);
    }

    function expectKeepsGoing(made: Made): void {
      expect(made.client.state()).toBe("connected");
      expect(made.client.fault()).toBeUndefined();
    }

    describe("With MQTT 5 and a DISCONNECT packet carrying reason code 142", () => {
      async function takenOver(): Promise<{ broker: RawBroker; made: Made }> {
        const broker = await rawBroker();
        const made = make({ url: broker.url });
        await up(made);
        await until(() => {
          expect(publishes(broker, STATUS_TOPIC)).toHaveLength(1);
        });
        vi.useFakeTimers({
          toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
        });
        broker.disconnect(142);
        await until(() => {
          expect(made.client.state()).toBe("ended");
        });
        return { broker, made };
      }

      it("state is ended and fault is another_instance", async () => {
        const { made } = await takenOver();
        expect(made.client.state()).toBe("ended");
        expect(made.client.fault()).toBe("another_instance");
      });

      it("one taken_over event", async () => {
        const { made } = await takenOver();
        expect(made.events.filter((event) => event.kind === "taken_over")).toHaveLength(1);
      });

      it("no further connection attempt is made", async () => {
        const { broker } = await takenOver();
        vi.advanceTimersByTime(10 * 60 * 1000);
        expect(vi.getTimerCount()).toBe(0);
        expect(connects(broker)).toHaveLength(1);
      });

      it("the client publishes nothing afterwards", async () => {
        const { broker } = await takenOver();
        const count = broker.packets().length;
        vi.advanceTimersByTime(10 * 60 * 1000);
        // A stray packet would arrive over the network, so give it real time to show up.
        await pause(150);
        expect(broker.packets()).toHaveLength(count);
        expect(publishes(broker, STATUS_TOPIC).map((packet) => String(packet.payload))).toEqual([
          STATUS_ONLINE,
        ]);
      });
    });

    describe("With MQTT 5 and a DISCONNECT packet carrying another reason code", () => {
      it("the client reconnects and fault is undefined", async () => {
        const broker = await rawBroker();
        const made = make({ url: broker.url });
        await up(made);
        broker.disconnect(137);
        await until(() => {
          expect(made.events.filter((event) => event.kind === "connected")).toHaveLength(2);
        });
        expectKeepsGoing(made);
      });
    });

    describe("With MQTT 5 and losses of established connections at 0 s, 10 s and 25 s, none with reason code 142", () => {
      it("after the third: state is ended, fault is another_instance, one taken_over event", async () => {
        const broker = await rawBroker();
        const made = make({ url: broker.url });
        await up(made);
        await drops(made, () => {
          broker.drop();
        }, [0, 10_000, 15_000]);
        await expectTakenOver(made, () => connects(broker).length);
      });
    });

    describe("With MQTT 5 and losses at 0 s, 10 s and 31 s", () => {
      it("the client reconnects and fault is undefined", async () => {
        const broker = await rawBroker();
        const made = make({ url: broker.url });
        await up(made);
        await drops(made, () => {
          broker.drop();
        }, [0, 10_000, 21_000]);
        expectKeepsGoing(made);
      });
    });

    describe("With MQTT 3.1.1 and losses of established connections at 0 s, 10 s and 25 s", () => {
      it("after the third: state is ended, fault is another_instance, one taken_over event", async () => {
        const fake = await fakeZ2m();
        const made = make({ url: fake.url });
        await up(made);
        expect(made.client.protocol()).toBe(4);
        await drops(made, () => {
          fake.dropClients();
        }, [0, 10_000, 15_000]);
        await expectTakenOver(made, () => fake.attempts());
      });
    });

    describe("With MQTT 3.1.1 and losses at 0 s, 10 s and 31 s", () => {
      it("the client reconnects and fault is undefined", async () => {
        const fake = await fakeZ2m();
        const made = make({ url: fake.url });
        await up(made);
        await drops(made, () => {
          fake.dropClients();
        }, [0, 10_000, 21_000]);
        expectKeepsGoing(made);
      });
    });

    describe("With MQTT 3.1.1 and losses at 0 s, 10 s, 31 s and 35 s", () => {
      it("after the fourth: fault is another_instance (10 s to 35 s is 25 s)", async () => {
        const fake = await fakeZ2m();
        const made = make({ url: fake.url });
        await up(made);
        await drops(made, () => {
          fake.dropClients();
        }, [0, 10_000, 21_000]);
        expectKeepsGoing(made);
        await drops(made, () => {
          fake.dropClients();
        }, [4_000]);
        await expectTakenOver(made, () => fake.attempts());
      });
    });

    describe("With MQTT 3.1.1, one loss, and then refused connection attempts for 30 s", () => {
      it("the refused attempts are not counted and fault is undefined", async () => {
        const fake = await fakeZ2m();
        const made = make({ url: fake.url });
        await up(made);
        fake.refuseConnections(true);
        const before = fake.attempts();
        fake.dropClients();
        await until(() => {
          expect(fake.attempts()).toBeGreaterThanOrEqual(before + 4);
        });
        made.clock.advance(30_000);
        fake.refuseConnections(false);
        await until(() => {
          expect(made.client.state()).toBe("connected");
        });
        expectKeepsGoing(made);
      });
    });

    describe("After a takeover", () => {
      async function takenOver(): Promise<{ broker: RawBroker; made: Made }> {
        const broker = await rawBroker();
        const made = make({ url: broker.url });
        await up(made);
        vi.useFakeTimers({
          toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
        });
        broker.disconnect(142);
        await until(() => {
          expect(made.client.state()).toBe("ended");
        });
        return { broker, made };
      }

      it("publish rejects with HeatmasterError mqtt_not_connected", async () => {
        const { made } = await takenOver();
        const error = await rejectionOf(made.client.publish("x/y", "p", { qos: 1, retain: false }));
        expect((error as HeatmasterError).code).toBe("mqtt_not_connected");
      });

      it("no connection attempt is made when 10 min pass", async () => {
        const { broker, made } = await takenOver();
        made.clock.advance(10 * 60 * 1000);
        vi.advanceTimersByTime(10 * 60 * 1000);
        await pause(150);
        expect(vi.getTimerCount()).toBe(0);
        expect(connects(broker)).toHaveLength(1);
      });
    });
  });

  describe("end", () => {
    describe("While connected", () => {
      it('"offline" is published on heatmaster/status, retained, and then the connection is closed', async () => {
        const broker = await rawBroker();
        const { client } = make({ url: broker.url });
        await client.connect();
        await client.end();
        const statuses = publishes(broker, STATUS_TOPIC);
        expect(statuses.map((packet) => String(packet.payload))).toEqual([
          STATUS_ONLINE,
          STATUS_OFFLINE,
        ]);
        expect(statuses[1]?.retain).toBe(true);
        const commands = broker.packets().map((recorded) => recorded.packet.cmd);
        expect(commands.indexOf("disconnect")).toBeGreaterThan(commands.lastIndexOf("publish"));
      });

      it("state is ended", async () => {
        const broker = await rawBroker();
        const { client } = make({ url: broker.url });
        await client.connect();
        await client.end();
        expect(client.state()).toBe("ended");
      });
    });

    describe("Called twice", () => {
      it("the second call resolves and publishes nothing", async () => {
        const broker = await rawBroker();
        const { client } = make({ url: broker.url });
        await client.connect();
        await client.end();
        const count = broker.packets().length;
        await expect(client.end()).resolves.toBeUndefined();
        expect(broker.packets()).toHaveLength(count);
      });
    });
  });
});
