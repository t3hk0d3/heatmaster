import mqtt from "mqtt";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startFakeZ2m, type FakeZ2m } from "./fake-z2m.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("fake-z2m", () => {
  describe("publishing", () => {
    describe("With a retained message followed at once by a plain one", () => {
      it("a subscribed client receives both, in that order", async () => {
        const fake: FakeZ2m = await startFakeZ2m();
        cleanups.push(() => fake.stop());
        fake.addDevice({ ieee: "0xa1", name: "valve", modelId: "TRVZB" }, { a: 1 });
        const client = await mqtt.connectAsync(fake.url, { clientId: "fake-z2m-test" });
        cleanups.push(() => client.endAsync());
        const received: string[] = [];
        client.on("message", (topic, payload, packet) => {
          if (!packet.retain) received.push(`${topic} ${payload.toString()}`);
        });
        await client.subscribeAsync(["zigbee2mqtt/bridge/state", "zigbee2mqtt/valve"]);
        fake.setBridgeState("offline");
        fake.republish("0xa1");
        await vi.waitFor(() => {
          expect(received).toHaveLength(2);
        });
        expect(received[0]).toBe('zigbee2mqtt/bridge/state {"state":"offline"}');
        expect(received[1]?.startsWith("zigbee2mqtt/valve ")).toBe(true);
      });
    });
  });
});
