import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket as WsWebSocket } from "ws";
import type { LabelOp } from "@heatmaster/core";
import { LABEL_WRITES, startFakeHa, type FakeHa } from "../test/fake-ha.ts";
import { createManualClock, type ManualClock } from "../test/manual-clock.ts";
import {
  HA_LABEL_TIMEOUT_MS,
  HA_POLL_MS,
  HA_RETRY_MS,
  buildHaLink,
  createHaLink,
  type HaEvent,
  type HaLink,
  type LabelWriteResult,
} from "./ha-link.ts";

// Below vitest's own 5 s test timeout, so a failed wait shows as an assertion, not a time-out.
const WAIT = { timeout: 4000, interval: 5 };
const SLOW = 20000;
const T = Date.UTC(2026, 10, 15, 12, 0, 0);
const C = { unit_of_measurement: "°C", device_class: "temperature", friendly_name: "Bathroom" };
const TEMP = "sensor.temp";
const HUM = "sensor.hum";
const BAT = "sensor.bat";
const LOAD_COMMANDS = [
  "get_config",
  "config/entity_registry/list",
  "config/device_registry/list",
  "config/area_registry/list",
  "config/label_registry/list",
  "get_states",
];

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function until(check: () => void): Promise<void> {
  return vi.waitFor(check, WAIT);
}

/** One device with a temperature, a humidity and a battery entity. */
function seed(ha: FakeHa): void {
  ha.setDevice({ id: "d1", identifiers: [["mqtt", "zigbee2mqtt_0xaaa"]] });
  for (const id of [TEMP, HUM, BAT]) ha.setEntity({ entity_id: id, device_id: "d1" });
  ha.setState(TEMP, "19.6", C, T);
  ha.setState(HUM, "55", { device_class: "humidity", unit_of_measurement: "%" }, T - 10_000);
  ha.setState(BAT, "90", { device_class: "battery", unit_of_measurement: "%" }, T - 20_000);
}

type World = Readonly<{
  ha: FakeHa;
  clock: ManualClock;
  link: HaLink;
  events: HaEvent[];
  warnings: string[];
  kinds(): string[];
  /** The `changed` events that were not caused by `sync`. */
  changedCount(): number;
  /** Moves the probe sensor and waits for its `changed`: everything sent before it has arrived. */
  sync(): Promise<void>;
}>;

async function world(
  options: Readonly<{
    seed?: (ha: FakeHa) => void;
    watch?: readonly string[];
    probe?: boolean;
    start?: boolean;
    token?: string;
  }> = {},
): Promise<World> {
  const ha = await startFakeHa(options.token === undefined ? {} : { token: options.token });
  cleanups.push(() => ha.stop());
  (options.seed ?? seed)(ha);
  const clock = createManualClock(T);
  const warnings: string[] = [];
  const link = createHaLink({ url: ha.url, token: "test-token" }, clock, {
    warn: (message) => warnings.push(message),
  });
  cleanups.push(() => link.stop());
  const events: HaEvent[] = [];
  let syncs = 0;
  const probe = options.probe === true;
  const watch = [...(options.watch ?? [TEMP]), ...(probe ? ["sensor.probe"] : [])];
  link.watch(new Set(watch));
  if (options.start !== false) {
    link.start((event) => events.push(event));
    await until(() => {
      expect(link.state()).toBe("up");
    });
  }
  const count = (): number => events.filter((event) => event.kind === "changed").length;
  return {
    ha,
    clock,
    link,
    events,
    warnings,
    kinds: () => events.map((event) => event.kind),
    changedCount: () => count() - syncs,
    async sync() {
      syncs += 1;
      ha.setState("sensor.probe", String(syncs), C, T + syncs);
      await until(() => {
        expect(link.sensor("sensor.probe")?.celsius).toBe(syncs);
      });
    },
  };
}

function startOn(w: World): void {
  w.link.start((event) => w.events.push(event));
}

const celsiusOf = (w: World, id = TEMP): number | undefined => w.link.sensor(id)?.celsius;

describe("ha-link", () => {
  describe("buildHaLink", () => {
    describe("With options undefined", () => {
      it("returns undefined", () => {
        expect(buildHaLink(undefined, createManualClock(T))).toBeUndefined();
      });
    });

    describe("With a url and a token", () => {
      it("returns a link in state connecting", () => {
        const link = buildHaLink({ url: "http://127.0.0.1:1", token: "t" }, createManualClock(T));
        expect(link?.state()).toBe("connecting");
        expect(link?.up()).toBe(false);
      });

      it("nothing is sent before start", async () => {
        const ha = await startFakeHa();
        cleanups.push(() => ha.stop());
        const clock = createManualClock(T);
        buildHaLink({ url: ha.url, token: "test-token" }, clock);
        clock.advance(HA_POLL_MS);
        await Promise.resolve();
        expect(ha.upgrades()).toEqual([]);
        expect(ha.requests()).toEqual([]);
        expect(clock.pending()).toBe(0);
      });
    });
  });

  describe("start", () => {
    describe("With a reachable Home Assistant and a good token", () => {
      it("state becomes up and one link_up is sent", async () => {
        const w = await world();
        expect(w.link.up()).toBe(true);
        expect(w.kinds()).toEqual(["link_up"]);
      });

      it("the connection was made to <url>/api/websocket and the token was sent in the auth message", async () => {
        const w = await world();
        expect(w.ha.upgrades()).toEqual(["/api/websocket"]);
        expect(w.ha.tokens()).toEqual(["test-token"]);
      });

      it("no WebSocket polyfill is installed: the global one of Node is used", async () => {
        const w = await world();
        expect(w.link.up()).toBe(true);
        expect(typeof globalThis.WebSocket).toBe("function");
        expect(globalThis.WebSocket).not.toBe(WsWebSocket);
      });
    });

    describe("With Home Assistant unreachable", () => {
      it("state stays connecting", async () => {
        const w = await world({ start: false });
        w.ha.refuseConnections(true);
        startOn(w);
        await until(() => {
          expect(w.ha.upgrades()).toHaveLength(1);
          expect(w.clock.pending()).toBe(1);
        });
        expect(w.link.state()).toBe("connecting");
      });

      it("a new attempt is made each time HA_RETRY_MS passes", async () => {
        const w = await world({ start: false });
        w.ha.refuseConnections(true);
        startOn(w);
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          await until(() => {
            expect(w.ha.upgrades()).toHaveLength(attempt);
            expect(w.clock.pending()).toBe(1);
          });
          w.clock.advance(HA_RETRY_MS - 1);
          expect(w.ha.upgrades()).toHaveLength(attempt);
          w.clock.advance(1);
        }
        await until(() => {
          expect(w.ha.upgrades()).toHaveLength(4);
        });
      });
    });

    describe("When Home Assistant becomes reachable after three failed attempts", () => {
      it("state becomes up", async () => {
        const w = await world({ start: false });
        w.ha.refuseConnections(true);
        startOn(w);
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          await until(() => {
            expect(w.ha.upgrades()).toHaveLength(attempt);
            expect(w.clock.pending()).toBe(1);
          });
          if (attempt === 3) w.ha.refuseConnections(false);
          w.clock.advance(HA_RETRY_MS);
        }
        await until(() => {
          expect(w.link.state()).toBe("up");
        });
      });
    });

    describe("With a wrong token", () => {
      it("state is auth_invalid", async () => {
        const w = await world({ start: false, token: "other-token" });
        startOn(w);
        await until(() => {
          expect(w.link.state()).toBe("auth_invalid");
        });
      });

      it("no further attempt is made when 10 min pass", async () => {
        const w = await world({ start: false, token: "other-token" });
        startOn(w);
        await until(() => {
          expect(w.link.state()).toBe("auth_invalid");
        });
        w.clock.advance(10 * 60 * 1000);
        expect(w.clock.pending()).toBe(0);
        expect(w.ha.tokens()).toHaveLength(1);
        expect(w.ha.upgrades()).toHaveLength(1);
      });
    });
  });

  describe("reconnect", () => {
    describe("When the connection drops", () => {
      it("state is down and link_down is sent", async () => {
        const w = await world();
        w.ha.refuseConnections(true);
        w.ha.dropConnections();
        await until(() => {
          expect(w.link.state()).toBe("down");
        });
        expect(w.kinds()).toEqual(["link_up", "link_down"]);
      });
    });

    describe("When Home Assistant is back", () => {
      it("the config, the registries and the states are loaded again, then state is up and link_up is sent", async () => {
        const w = await world();
        w.ha.dropConnections();
        await until(() => {
          expect(w.kinds()).toEqual(["link_up", "link_down", "link_up"]);
        });
        const loads = w.ha.commands().filter((type) => LOAD_COMMANDS.includes(type));
        expect(loads).toEqual([...LOAD_COMMANDS, ...LOAD_COMMANDS]);
        expect(w.link.state()).toBe("up");
      });

      it("a state change of a watched sensor is delivered again", async () => {
        const w = await world();
        w.ha.dropConnections();
        await until(() => {
          expect(w.kinds()).toEqual(["link_up", "link_down", "link_up"]);
        });
        w.ha.setState(TEMP, "21.5", C, T + 1000);
        await until(() => {
          expect(celsiusOf(w)).toBe(21.5);
        });
        expect(w.changedCount()).toBe(1);
      });
    });

    describe("When the connection drops while the subscriptions are being made", () => {
      it(
        "every event type is subscribed once after the reload",
        async () => {
          const w = await world({ start: false });
          w.ha.failNext("close:subscribe_events");
          startOn(w);
          await until(() => {
            expect(w.ha.accepted()).toBe(1);
            expect(w.ha.openSockets()).toBe(0);
          });
          w.ha.refuseConnections(false);
          await until(() => {
            expect(w.link.state()).toBe("up");
          });
          expect([...w.ha.subscriptions()].sort()).toEqual([
            "area_registry_updated",
            "core_config_updated",
            "device_registry_updated",
            "entity_registry_updated",
            "label_registry_updated",
            "state_changed",
          ]);
        },
        SLOW,
      );
    });

    describe("When the token is refused on the reconnect", () => {
      it("state is auth_invalid", async () => {
        const w = await world();
        w.ha.setToken("changed");
        w.ha.dropConnections();
        await until(() => {
          expect(w.link.state()).toBe("auth_invalid");
        });
      });
    });

    describe("When the connection drops while the registries are being loaded", () => {
      it(
        "state is not up and no link_up is sent",
        async () => {
          const w = await world();
          w.ha.failNext("close:config/entity_registry/list");
          w.ha.dropConnections();
          await until(() => {
            expect(w.ha.commands().filter((type) => type === "get_config")).toHaveLength(2);
            expect(w.ha.openSockets()).toBe(0);
          });
          expect(w.link.state()).toBe("down");
          expect(w.kinds()).toEqual(["link_up", "link_down"]);
        },
        SLOW,
      );

      it(
        "after the next ready the loading runs again, then state is up and one link_up is sent",
        async () => {
          const w = await world();
          w.ha.failNext("close:config/entity_registry/list");
          w.ha.dropConnections();
          await until(() => {
            expect(w.ha.openSockets()).toBe(0);
            expect(w.ha.commands().filter((type) => type === "get_config")).toHaveLength(2);
          });
          w.ha.refuseConnections(false);
          await until(() => {
            expect(w.link.state()).toBe("up");
          });
          expect(w.kinds()).toEqual(["link_up", "link_down", "link_up"]);
          expect(w.ha.commands().filter((type) => type === "get_states")).toHaveLength(2);
        },
        SLOW,
      );
    });

    describe("When a loading command gets an error result", () => {
      /** Drops the link, changes the zone while it is away and makes the next get_states fail. */
      async function failedLoad(): Promise<World> {
        const w = await world();
        w.ha.refuseConnections(true);
        w.ha.dropConnections();
        await until(() => {
          expect(w.link.state()).toBe("down");
        });
        w.ha.setConfig({ time_zone: "Asia/Tokyo", language: "ja" });
        w.ha.failNext("get_states");
        w.ha.refuseConnections(false);
        await until(() => {
          expect(w.clock.pending()).toBe(1);
          expect(w.ha.commands().filter((type) => type === "get_states")).toHaveLength(2);
        });
        return w;
      }

      it(
        "state is not up, no link_up is sent, and what was known before is kept",
        async () => {
          const w = await failedLoad();
          expect(w.link.state()).toBe("down");
          expect(w.kinds()).toEqual(["link_up", "link_down"]);
          expect(w.link.house()).toEqual({ timeZone: "Europe/Amsterdam", language: "en" });
        },
        SLOW,
      );

      it(
        "the loading runs again HA_RETRY_MS later, then state is up and one link_up is sent",
        async () => {
          const w = await failedLoad();
          w.clock.advance(HA_RETRY_MS);
          await until(() => {
            expect(w.link.state()).toBe("up");
          });
          expect(w.kinds()).toEqual(["link_up", "link_down", "link_up"]);
          expect(w.link.house()?.timeZone).toBe("Asia/Tokyo");
        },
        SLOW,
      );
    });
  });

  describe("house", () => {
    describe('With get_config answering time_zone "Europe/Amsterdam" and language "ru"', () => {
      it('returns { timeZone: "Europe/Amsterdam", language: "ru" }', async () => {
        const w = await world({ start: false });
        w.ha.setConfig({ time_zone: "Europe/Amsterdam", language: "ru" });
        startOn(w);
        await until(() => {
          expect(w.link.up()).toBe(true);
        });
        expect(w.link.house()).toEqual({ timeZone: "Europe/Amsterdam", language: "ru" });
      });
    });

    describe("Before the first connection", () => {
      it("returns undefined", async () => {
        const w = await world({ start: false });
        expect(w.link.house()).toBeUndefined();
      });
    });

    describe("While the link is down after it was up", () => {
      it("returns the last known value", async () => {
        const w = await world();
        w.ha.refuseConnections(true);
        w.ha.dropConnections();
        await until(() => {
          expect(w.link.state()).toBe("down");
        });
        expect(w.link.house()).toEqual({ timeZone: "Europe/Amsterdam", language: "en" });
      });
    });

    describe("When the time zone changes in Home Assistant", () => {
      it("house holds the new zone and changed is sent", async () => {
        const w = await world();
        w.ha.setConfig({ time_zone: "Europe/Berlin", language: "en" });
        await until(() => {
          expect(w.link.house()?.timeZone).toBe("Europe/Berlin");
        });
        expect(w.kinds()).toEqual(["link_up", "changed"]);
      });
    });
  });

  describe("ready", () => {
    describe("Before the first loading has finished", () => {
      it("returns false", async () => {
        const w = await world({ start: false });
        expect(w.link.ready()).toBe(false);
        w.ha.failNext("get_states");
        startOn(w);
        await until(() => {
          expect(w.clock.pending()).toBe(1);
        });
        expect(w.link.ready()).toBe(false);
        expect(w.link.state()).toBe("connecting");
        expect(w.kinds()).toEqual([]);
        w.clock.advance(HA_RETRY_MS);
        await until(() => {
          expect(w.link.state()).toBe("up");
        });
        expect(w.kinds()).toEqual(["link_up"]);
      });
    });

    describe("After it", () => {
      it("returns true, also while the link is down", async () => {
        const w = await world();
        expect(w.link.ready()).toBe(true);
        w.ha.refuseConnections(true);
        w.ha.dropConnections();
        await until(() => {
          expect(w.link.state()).toBe("down");
        });
        expect(w.link.ready()).toBe(true);
      });
    });
  });

  describe("watch and sensor", () => {
    async function withState(
      state: string,
      attributes: Readonly<Record<string, unknown>> = C,
    ): Promise<World> {
      return world({
        seed: (ha) => {
          seed(ha);
          ha.setState(TEMP, state, attributes, T);
        },
      });
    }

    describe('With a watched sensor whose state is "19.6" in °C', () => {
      it("celsius is 19.6", async () => {
        expect(celsiusOf(await withState("19.6"))).toBe(19.6);
      });
    });

    describe('With a state "67.1" in °F', () => {
      it("celsius is 19.5, within 0.001", async () => {
        const w = await withState("67.1", { unit_of_measurement: "°F" });
        expect(celsiusOf(w)).toBeCloseTo(19.5, 3);
      });
    });

    describe('With a state "293.15" in K', () => {
      it("celsius is 20.0, within 0.001", async () => {
        const w = await withState("293.15", { unit_of_measurement: "K" });
        expect(celsiusOf(w)).toBeCloseTo(20, 3);
      });
    });

    describe('With a first state "unavailable", "unknown" or "abc"', () => {
      it("celsius is undefined", async () => {
        for (const state of ["unavailable", "unknown", "abc"]) {
          const w = await withState(state);
          expect(w.link.sensor(TEMP), state).toBeDefined();
          expect(celsiusOf(w), state).toBeUndefined();
        }
      });
    });

    describe("With a missing unit, or a unit that is not a temperature unit", () => {
      it("celsius is undefined", async () => {
        expect(celsiusOf(await withState("19.6", {}))).toBeUndefined();
        expect(celsiusOf(await withState("19.6", { unit_of_measurement: "%" }))).toBeUndefined();
      });
    });

    describe("With 19.6 reported at time T and then the state unavailable", () => {
      it("celsius is 19.6 and lastReportedAt is T", async () => {
        const w = await world({ probe: true });
        w.ha.setState(TEMP, "unavailable", C, T + 5000);
        await w.sync();
        expect(celsiusOf(w)).toBe(19.6);
        expect(w.link.sensor(TEMP)?.lastReportedAt).toBe(T);
      });

      describe("With that sensor then reporting 19.8 at time U", () => {
        it("celsius is 19.8 and lastReportedAt is U", async () => {
          const w = await world({ probe: true });
          w.ha.setState(TEMP, "unavailable", C, T + 5000);
          w.ha.setState(TEMP, "19.8", C, T + 9000);
          await w.sync();
          expect(celsiusOf(w)).toBe(19.8);
          expect(w.link.sensor(TEMP)?.lastReportedAt).toBe(T + 9000);
        });
      });
    });

    describe("With a watched entity that has no state", () => {
      it("sensor returns undefined", async () => {
        const w = await world({ watch: [TEMP, "sensor.ghost"] });
        expect(w.link.sensor("sensor.ghost")).toBeUndefined();
      });
    });

    describe("With an entity that is not watched", () => {
      it("sensor returns undefined", async () => {
        const w = await world();
        expect(w.link.sensor(HUM)).toBeUndefined();
      });
    });

    describe("With a state_changed event for a watched sensor", () => {
      it("celsius and lastReportedAt take the new state's values", async () => {
        const w = await world({ probe: true });
        w.ha.setState(TEMP, "20.4", C, T + 7000);
        await w.sync();
        expect(w.link.sensor(TEMP)).toEqual({
          celsius: 20.4,
          lastReportedAt: T + 7000,
          observable: true,
        });
      });

      it("changed is sent", async () => {
        const w = await world({ probe: true });
        w.ha.setState(TEMP, "20.4", C, T + 7000);
        await w.sync();
        expect(w.changedCount()).toBe(1);
      });
    });

    describe("With a state_changed event for an entity that is not watched", () => {
      it("nothing is sent", async () => {
        const w = await world({ probe: true });
        w.ha.setState("sensor.other", "5", C, T + 100);
        await w.sync();
        expect(w.changedCount()).toBe(0);
      });
    });

    describe("With watch called with one more entity while the link is up", () => {
      async function watchedMore(): Promise<World> {
        const w = await world({
          seed: (ha) => {
            seed(ha);
            ha.setDevice({ id: "d2", identifiers: [["mqtt", "zigbee2mqtt_0xbbb"]] });
            ha.setEntity({ entity_id: "sensor.two", device_id: "d2" });
            ha.setState("sensor.two", "17.25", C, T);
          },
        });
        w.link.watch(new Set([TEMP, "sensor.two"]));
        await until(() => {
          expect(w.ha.requests()).toEqual(["GET /api/states/sensor.two"]);
        });
        return w;
      }

      it("that entity's state is asked for once over REST and sensor returns its value", async () => {
        const w = await watchedMore();
        expect(celsiusOf(w, "sensor.two")).toBe(17.25);
        expect(w.ha.requests()).toEqual(["GET /api/states/sensor.two"]);
      });

      it("get_states is not sent again", async () => {
        const w = await watchedMore();
        expect(w.ha.commands().filter((type) => type === "get_states")).toHaveLength(1);
      });
    });

    describe("With watch called without an entity it held before", () => {
      it("sensor returns undefined for that entity", async () => {
        const w = await world({ watch: [TEMP, HUM] });
        expect(w.link.sensor(HUM)).toBeDefined();
        w.link.watch(new Set([TEMP]));
        expect(w.link.sensor(HUM)).toBeUndefined();
      });
    });
  });

  describe("last_reported", () => {
    const DEVICE_REQUESTS = [TEMP, HUM, BAT].map((id) => `GET /api/states/${id}`);

    /**
     * Runs polls until `requests` requests in all were received. A poll that starts while the
     * one before it is still being processed is skipped, so the clock is moved again.
     */
    async function poll(w: World, requests: number): Promise<void> {
      await until(() => {
        if (w.ha.requests().length < requests) w.clock.advance(HA_POLL_MS);
        expect(w.ha.requests()).toHaveLength(requests);
      });
    }

    describe("With a watched sensor that reports the same value again", () => {
      it("lastReportedAt is unchanged before the next poll", async () => {
        const w = await world();
        w.ha.report(TEMP, T + 60_000);
        expect(w.link.sensor(TEMP)?.lastReportedAt).toBe(T);
        expect(w.ha.requests()).toEqual([]);
      });

      it("after HA_POLL_MS it holds the new time and changed is sent", async () => {
        const w = await world();
        w.ha.report(TEMP, T + 60_000);
        await poll(w, 3);
        await until(() => {
          expect(w.link.sensor(TEMP)?.lastReportedAt).toBe(T + 60_000);
        });
        expect(w.changedCount()).toBe(1);
      });
    });

    describe("With a state_changed event that arrives while a poll is in flight", () => {
      it("the older state in the poll's answer does not replace it", async () => {
        const w = await world();
        w.ha.holdRest(true);
        await poll(w, 3);
        w.ha.setState(TEMP, "21", C, T + 5000);
        await until(() => {
          expect(celsiusOf(w)).toBe(21);
        });
        w.ha.holdRest(false);
        // A second poll starts only after the first one has been processed; its answers are held,
        // so only the first poll's old answers can have changed anything by then.
        w.ha.holdRest(true);
        await poll(w, 6);
        expect(celsiusOf(w)).toBe(21);
        expect(w.link.sensor(TEMP)?.lastReportedAt).toBe(T + 5000);
        w.ha.holdRest(false);
      });
    });

    describe("With nothing different at a poll", () => {
      it("changed is not sent", async () => {
        const w = await world();
        await poll(w, 3);
        // A second poll starts only once the first has been processed.
        await poll(w, 6);
        expect(w.changedCount()).toBe(0);
      });
    });

    describe("With a watched sensor whose own entity reports nothing new while its humidity entity, on the same device, reports at time U", () => {
      async function humidityReports(): Promise<World> {
        const w = await world();
        w.ha.report(HUM, T + 90_000);
        await poll(w, 3);
        await until(() => {
          expect(w.link.sensor(TEMP)?.lastReportedAt).toBe(T + 90_000);
        });
        return w;
      }

      it("after the next poll lastReportedAt is U and changed is sent", async () => {
        const w = await humidityReports();
        expect(w.changedCount()).toBe(1);
      });

      it("celsius is unchanged", async () => {
        const w = await humidityReports();
        expect(celsiusOf(w)).toBe(19.6);
      });
    });

    describe("With a watched sensor whose device has a battery entity that reported last", () => {
      it("lastReportedAt is the battery entity's last_reported", async () => {
        const w = await world({
          seed: (ha) => {
            seed(ha);
            ha.setState(
              BAT,
              "88",
              { device_class: "battery", unit_of_measurement: "%" },
              T + 30_000,
            );
          },
        });
        expect(w.link.sensor(TEMP)?.lastReportedAt).toBe(T + 30_000);
      });
    });

    describe("With a device entity that is disabled, has no state or is unavailable", () => {
      it("it does not count towards lastReportedAt", async () => {
        const w = await world({
          seed: (ha) => {
            seed(ha);
            ha.setEntity({ entity_id: "sensor.off", device_id: "d1", disabled_by: "user" });
            ha.setState("sensor.off", "1", {}, T + 50_000);
            ha.setEntity({ entity_id: "sensor.empty", device_id: "d1" });
            ha.setEntity({ entity_id: "sensor.gone", device_id: "d1" });
            ha.setState("sensor.gone", "unavailable", {}, T + 60_000);
          },
        });
        expect(w.link.sensor(TEMP)?.lastReportedAt).toBe(T);
      });
    });

    describe("With two watched sensors on different devices, each device with three entities", () => {
      function twoDevices(ha: FakeHa): void {
        seed(ha);
        ha.setDevice({ id: "d2", identifiers: [["mqtt", "zigbee2mqtt_0xbbb"]] });
        for (const id of ["sensor.t2", "sensor.h2", "sensor.b2"]) {
          ha.setEntity({ entity_id: id, device_id: "d2" });
          ha.setState(id, "10", C, T - 5000);
        }
      }

      it("each poll sends one GET /api/states/<entity id> per entity of those devices, with the token as bearer", async () => {
        const w = await world({ seed: twoDevices, watch: [TEMP, "sensor.t2"] });
        w.ha.report("sensor.h2", T + 70_000);
        await poll(w, 6);
        const ids = [TEMP, HUM, BAT, "sensor.t2", "sensor.h2", "sensor.b2"];
        expect([...w.ha.requests()].sort()).toEqual(
          ids.map((id) => `GET /api/states/${id}`).sort(),
        );
        // The fake answers 401 to a wrong bearer token, so a value that arrived proves the token.
        await until(() => {
          expect(w.link.sensor("sensor.t2")?.lastReportedAt).toBe(T + 70_000);
        });
      });

      it("no poll sends get_states", async () => {
        const w = await world({ seed: twoDevices, watch: [TEMP, "sensor.t2"] });
        await poll(w, 6);
        await poll(w, 12);
        expect(w.ha.commands().filter((type) => type === "get_states")).toHaveLength(1);
      });
    });

    describe("With two watched sensors on one device", () => {
      it("each entity of the device is asked once per poll", async () => {
        const w = await world({ watch: [TEMP, HUM] });
        await poll(w, 3);
        expect([...w.ha.requests()].sort()).toEqual([...DEVICE_REQUESTS].sort());
      });
    });

    describe("With nothing watched", () => {
      it("no poll is sent", async () => {
        const w = await world({ watch: [] });
        w.clock.advance(HA_POLL_MS * 2);
        // A request of our own, after the polls would have started, shows what the server saw.
        await fetch(`${w.ha.url}/api/states/${TEMP}`, {
          headers: { Authorization: "Bearer test-token" },
        });
        expect(w.ha.requests()).toEqual([`GET /api/states/${TEMP}`]);
      });
    });

    describe("With a poll at which the entity's state is unavailable", () => {
      it("celsius and lastReportedAt keep the values of the last numeric state", async () => {
        const w = await world();
        w.ha.setState(TEMP, "unavailable", C, T + 40_000);
        await poll(w, 3);
        await poll(w, 6);
        expect(celsiusOf(w)).toBe(19.6);
        expect(w.link.sensor(TEMP)?.lastReportedAt).toBe(T);
      });
    });

    describe("When a poll's request for one entity of the device fails", () => {
      it("the sensor keeps its values, no event is sent, and the next poll runs", async () => {
        const w = await world({
          seed: (ha) => {
            ha.setState(TEMP, "19.6", C, T);
          },
        });
        w.ha.report(TEMP, T + 80_000);
        w.ha.failNext("rest");
        await poll(w, 1);
        await poll(w, 2);
        await until(() => {
          expect(w.link.sensor(TEMP)?.lastReportedAt).toBe(T + 80_000);
        });
        expect(w.changedCount()).toBe(1);
      });
    });

    describe("While the link is down", () => {
      it("no poll is sent", async () => {
        const w = await world();
        w.ha.refuseConnections(true);
        w.ha.dropConnections();
        await until(() => {
          expect(w.link.state()).toBe("down");
        });
        w.clock.advance(HA_POLL_MS * 3);
        expect(w.ha.requests()).toEqual([]);
        expect(w.clock.pending()).toBe(0);
      });
    });

    describe("With a state object that has no last_reported", () => {
      it("lastReportedAt is its last_updated", async () => {
        const w = await world({
          seed: (ha) => {
            seed(ha);
            ha.omitLastReported(TEMP);
          },
        });
        expect(w.link.sensor(TEMP)?.lastReportedAt).toBe(T);
      });
    });
  });

  describe("observable", () => {
    describe("With an entity that belongs to a device", () => {
      it("observable is true", async () => {
        const w = await world();
        expect(w.link.sensor(TEMP)?.observable).toBe(true);
      });
    });

    describe("With an entity that has no device", () => {
      const noDevice = (ha: FakeHa): void => {
        ha.setEntity({ entity_id: TEMP });
        ha.setState(TEMP, "19.6", C, T);
      };

      it("observable is false and lastReportedAt is the entity's own last_reported", async () => {
        const w = await world({ seed: noDevice });
        expect(w.link.sensor(TEMP)).toEqual({
          celsius: 19.6,
          lastReportedAt: T,
          observable: false,
        });
      });

      it("it is used, with a warning", async () => {
        const w = await world({ seed: noDevice });
        expect(celsiusOf(w)).toBe(19.6);
        expect(w.warnings).toHaveLength(1);
      });
    });

    describe("With an entity that has a state and no registry entry", () => {
      it("observable is false", async () => {
        const w = await world({
          seed: (ha) => {
            ha.setState(TEMP, "19.6", C, T);
          },
        });
        expect(w.link.sensor(TEMP)?.observable).toBe(false);
      });
    });
  });

  describe("sensorInfo", () => {
    const none = new Set<string>();
    const info = (w: World, id: string, addresses: ReadonlySet<string> = none) =>
      w.link.sensorInfo(id, addresses);

    describe("With sensor.x of device class temperature", () => {
      it("returns { exists: true, isTemperature: true, onValve: false }", async () => {
        const w = await world();
        expect(info(w, TEMP)).toEqual({ exists: true, isTemperature: true, onValve: false });
      });
    });

    describe("With a sensor of device class humidity", () => {
      it("isTemperature is false", async () => {
        const w = await world();
        expect(info(w, HUM).isTemperature).toBe(false);
      });
    });

    describe("With number.x of device class temperature", () => {
      it("isTemperature is false", async () => {
        const w = await world({
          seed: (ha) => {
            ha.setState("number.x", "20", C, T);
          },
        });
        expect(info(w, "number.x")).toEqual({ exists: true, isTemperature: false, onValve: false });
      });
    });

    describe("With an entity Home Assistant does not know", () => {
      it("returns { exists: false, isTemperature: false, onValve: false }", async () => {
        const w = await world();
        expect(info(w, "sensor.nothing")).toEqual({
          exists: false,
          isTemperature: false,
          onValve: false,
        });
      });
    });

    describe("With a registry entry and no state", () => {
      it("exists is true and isTemperature is false", async () => {
        const w = await world({
          seed: (ha) => {
            ha.setEntity({ entity_id: "sensor.quiet" });
          },
        });
        expect(info(w, "sensor.quiet")).toEqual({
          exists: true,
          isTemperature: false,
          onValve: false,
        });
      });
    });

    describe('With an entity on a device with identifier ("mqtt", "zigbee2mqtt_<address>"), the address in valveAddresses', () => {
      const onValve = (ha: FakeHa): void => {
        ha.setDevice({ id: "dv", identifiers: [["mqtt", "zigbee2mqtt_0x00124b0001"]] });
        ha.setEntity({ entity_id: "sensor.valve_temp", device_id: "dv" });
        ha.setState("sensor.valve_temp", "20", C, T);
      };

      it("onValve is true", async () => {
        const w = await world({ seed: onValve });
        expect(info(w, "sensor.valve_temp", new Set(["0x00124b0001"])).onValve).toBe(true);
      });

      describe("With the same entity and the address not in valveAddresses", () => {
        it("onValve is false", async () => {
          const w = await world({ seed: onValve });
          expect(info(w, "sensor.valve_temp", new Set(["0x00124b0002"])).onValve).toBe(false);
        });
      });
    });

    describe("Before ready", () => {
      it("all three are false", async () => {
        const w = await world({ start: false });
        expect(info(w, TEMP)).toEqual({ exists: false, isTemperature: false, onValve: false });
      });
    });
  });

  describe("contactInfo", () => {
    describe("With a binary_sensor Home Assistant has a state for", () => {
      it("returns { exists: true, isBinary: true }", async () => {
        const w = await world({
          seed: (ha) => {
            ha.setState("binary_sensor.window", "off", {}, T);
          },
        });
        expect(w.link.contactInfo("binary_sensor.window")).toEqual({
          exists: true,
          isBinary: true,
        });
      });
    });

    describe("With a binary_sensor that has a registry entry and no state", () => {
      it("exists is true", async () => {
        const w = await world({
          seed: (ha) => {
            ha.setEntity({ entity_id: "binary_sensor.quiet" });
          },
        });
        expect(w.link.contactInfo("binary_sensor.quiet").exists).toBe(true);
      });
    });

    describe("With an entity that is not a binary_sensor", () => {
      it("isBinary is false", async () => {
        const w = await world();
        expect(w.link.contactInfo(TEMP)).toEqual({ exists: true, isBinary: false });
      });
    });

    describe("With an entity Home Assistant does not know", () => {
      it("returns { exists: false, isBinary: true } for a binary_sensor id", async () => {
        const w = await world();
        expect(w.link.contactInfo("binary_sensor.nothing")).toEqual({
          exists: false,
          isBinary: true,
        });
      });
    });

    describe("Before ready", () => {
      it("both are false", async () => {
        const w = await world({ start: false });
        expect(w.link.contactInfo("binary_sensor.window")).toEqual({
          exists: false,
          isBinary: false,
        });
      });
    });
  });

  describe("names", () => {
    describe("With a sensor whose state has a friendly_name", () => {
      it("entityName returns it", async () => {
        const w = await world();
        expect(w.link.entityName(TEMP)).toBe("Bathroom");
      });
    });

    describe("With an entity that has a registry entry with a name and no state", () => {
      it("entityName returns the registry's name", async () => {
        const w = await world({
          seed: (ha) => {
            ha.setEntity({ entity_id: "sensor.named", name: "Hallway", original_name: "Original" });
            ha.setEntity({ entity_id: "sensor.orig", original_name: "Original" });
          },
        });
        expect(w.link.entityName("sensor.named")).toBe("Hallway");
        expect(w.link.entityName("sensor.orig")).toBe("Original");
      });
    });

    describe("With an area id of the area registry", () => {
      it("areaName returns the area's name", async () => {
        const w = await world({
          seed: (ha) => {
            ha.setArea({ area_id: "bath", name: "Bathroom" });
          },
        });
        expect(w.link.areaName("bath")).toBe("Bathroom");
      });
    });

    describe("With an unknown id", () => {
      it("both return undefined", async () => {
        const w = await world();
        expect(w.link.entityName("sensor.unknown")).toBeUndefined();
        expect(w.link.areaName("nowhere")).toBeUndefined();
      });
    });

    describe("When an area is renamed", () => {
      it("areaName returns the new name and changed is sent", async () => {
        const w = await world({
          seed: (ha) => {
            seed(ha);
            ha.setArea({ area_id: "bath", name: "Bathroom" });
          },
        });
        w.ha.setArea({ area_id: "bath", name: "Spa" });
        await until(() => {
          expect(w.link.areaName("bath")).toBe("Spa");
        });
        expect(w.kinds()).toEqual(["link_up", "registries_changed"]);
      });
    });
  });

  describe("snapshot", () => {
    const VALVE = "z2m:0x00124b0000000001";
    const withValve = (area: string | null, extra?: (ha: FakeHa) => void) => (ha: FakeHa) => {
      seed(ha);
      ha.setArea({ area_id: "office", name: "Office", labels: ["heatmaster_ignore"] });
      ha.setArea({ area_id: "kitchen", name: "Kitchen" });
      ha.setDevice({
        id: "dv",
        identifiers: [["mqtt", "zigbee2mqtt_0x00124b0000000001"]],
        area_id: area,
      });
      extra?.(ha);
    };

    describe("Before the first loading has finished", () => {
      it("returns undefined", async () => {
        const w = await world({ start: false });
        expect(w.link.snapshot()).toBeUndefined();
      });
    });

    describe('With an area "office" named "Office" carrying heatmaster_ignore', () => {
      it("areas holds office with that name and label", async () => {
        const w = await world({ seed: withValve("office") });
        expect(w.link.snapshot()?.areas.get("office")).toEqual({
          name: "Office",
          labels: ["heatmaster_ignore"],
        });
      });
    });

    describe('With a device with identifier ("mqtt", "zigbee2mqtt_0x00124b0000000001") in area office', () => {
      it("valveAreas maps z2m:0x00124b0000000001 to office", async () => {
        const w = await world({ seed: withValve("office") });
        expect(w.link.snapshot()?.valveAreas.get(VALVE)).toBe("office");
      });
    });

    describe("With that device without an area", () => {
      it("valveAreas maps it to null", async () => {
        const w = await world({ seed: withValve(null) });
        expect(w.link.snapshot()?.valveAreas.get(VALVE)).toBeNull();
      });
    });

    describe("With a device without a Zigbee2MQTT identifier", () => {
      it("valveAreas has no entry for it", async () => {
        const w = await world({
          seed: withValve("office", (ha) => {
            ha.setDevice({ id: "other", identifiers: [["hue", "abc"]], area_id: "office" });
          }),
        });
        expect([...(w.link.snapshot()?.valveAreas.keys() ?? [])].sort()).toEqual([
          VALVE,
          "z2m:0xaaa",
        ]);
      });
    });

    describe("With an entity whose own area is kitchen, on a device in office", () => {
      it("its areaId is kitchen", async () => {
        const w = await world({
          seed: withValve("office", (ha) => {
            ha.setEntity({ entity_id: "sensor.a", device_id: "dv", area_id: "kitchen" });
          }),
        });
        expect(w.link.snapshot()?.entities.get("sensor.a")?.areaId).toBe("kitchen");
      });
    });

    describe("With an entity without an area, on a device in office", () => {
      it("its areaId is office", async () => {
        const w = await world({
          seed: withValve("office", (ha) => {
            ha.setEntity({ entity_id: "sensor.a", device_id: "dv", area_id: null });
          }),
        });
        expect(w.link.snapshot()?.entities.get("sensor.a")?.areaId).toBe("office");
      });
    });

    describe("With an entity without an area and without a device", () => {
      it("its areaId is undefined", async () => {
        const w = await world({
          seed: withValve("office", (ha) => {
            ha.setEntity({ entity_id: "sensor.a" });
          }),
        });
        const entity = w.link.snapshot()?.entities.get("sensor.a");
        expect(entity).toBeDefined();
        expect(entity?.areaId).toBeUndefined();
      });
    });

    describe("With an entity labelled heatmaster_temp_sensor", () => {
      it("its labels hold heatmaster_temp_sensor", async () => {
        const w = await world({
          seed: withValve("office", (ha) => {
            ha.setEntity({ entity_id: "sensor.a", labels: ["heatmaster_temp_sensor"] });
          }),
        });
        expect(w.link.snapshot()?.entities.get("sensor.a")?.labels).toEqual([
          "heatmaster_temp_sensor",
        ]);
      });
    });

    describe('With the label heatmaster_schedule_day named "Heatmaster: Day"', () => {
      it('labels maps heatmaster_schedule_day to "Heatmaster: Day"', async () => {
        const w = await world({
          seed: withValve("office", (ha) => {
            ha.setLabel({ label_id: "heatmaster_schedule_day", name: "Heatmaster: Day" });
          }),
        });
        expect(w.link.snapshot()?.labels.get("heatmaster_schedule_day")).toBe("Heatmaster: Day");
      });
    });

    describe("While the link is down after a load", () => {
      it("returns the last loaded snapshot", async () => {
        const w = await world({ seed: withValve("office") });
        const before = w.link.snapshot();
        w.ha.refuseConnections(true);
        w.ha.dropConnections();
        await until(() => {
          expect(w.link.state()).toBe("down");
        });
        expect(w.link.snapshot()).toBe(before);
      });
    });
  });

  describe("loading", () => {
    describe("On every connection", () => {
      it("config/label_registry/list is sent after the area registry list and before get_states", async () => {
        const w = await world();
        const order = w.ha.commands().filter((type) => LOAD_COMMANDS.includes(type));
        const at = (type: string): number => order.indexOf(type);
        expect(at("config/label_registry/list")).toBeGreaterThan(at("config/area_registry/list"));
        expect(at("config/label_registry/list")).toBeLessThan(at("get_states"));
      });

      it("label_registry_updated is subscribed", async () => {
        const w = await world();
        expect(w.ha.subscriptions()).toContain("label_registry_updated");
      });
    });
  });

  describe("registry events", () => {
    const place = (ha: FakeHa): void => {
      seed(ha);
      ha.setArea({ area_id: "office", name: "Office" });
      ha.setArea({ area_id: "kitchen", name: "Kitchen" });
      ha.setDevice({
        id: "dv",
        identifiers: [["mqtt", "zigbee2mqtt_0x00124b0000000001"]],
        area_id: "office",
      });
    };

    describe("When a device moves to another area", () => {
      async function moved(): Promise<World> {
        const w = await world({ seed: place, probe: true });
        w.ha.setDevice({
          id: "dv",
          identifiers: [["mqtt", "zigbee2mqtt_0x00124b0000000001"]],
          area_id: "kitchen",
        });
        await until(() => {
          expect(w.link.snapshot()?.valveAreas.get("z2m:0x00124b0000000001")).toBe("kitchen");
        });
        await w.sync();
        return w;
      }

      it("snapshot shows the new area", async () => {
        const w = await moved();
        expect(w.link.snapshot()?.valveAreas.get("z2m:0x00124b0000000001")).toBe("kitchen");
      });

      it("registries_changed is sent once", async () => {
        const w = await moved();
        expect(w.kinds().filter((kind) => kind === "registries_changed")).toHaveLength(1);
      });

      it("changed is not sent", async () => {
        const w = await moved();
        expect(w.changedCount()).toBe(0);
      });
    });

    describe("When a label is created", () => {
      it("the label registry is reloaded and registries_changed is sent", async () => {
        const w = await world({ seed: place });
        w.ha.setLabel({ label_id: "heatmaster_schedule_day", name: "Heatmaster: Day" });
        await until(() => {
          expect(w.link.snapshot()?.labels.get("heatmaster_schedule_day")).toBe("Heatmaster: Day");
        });
        expect(
          w.ha.commands().filter((type) => type === "config/label_registry/list"),
        ).toHaveLength(2);
        expect(w.kinds()).toEqual(["link_up", "registries_changed"]);
      });
    });

    describe("When an entity registry update changes nothing the link keeps", () => {
      it("no event is sent", async () => {
        const w = await world({ seed: place, probe: true });
        w.ha.setEntity({ entity_id: HUM, device_id: "d1" });
        await until(() => {
          expect(
            w.ha.commands().filter((type) => type === "config/entity_registry/list"),
          ).toHaveLength(2);
        });
        await w.sync();
        expect(w.kinds()).toEqual(["link_up", "changed"]);
        expect(w.changedCount()).toBe(0);
      });
    });

    describe("When an entity registry update changes only data snapshot does not hold", () => {
      async function renamed(): Promise<World> {
        const w = await world({ seed: place });
        w.ha.setEntity({ entity_id: HUM, device_id: "d1", name: "Humidity" });
        await until(() => {
          expect(w.link.entityName(HUM)).toBe("Humidity");
        });
        return w;
      }

      it("changed is sent", async () => {
        const w = await renamed();
        expect(w.kinds()).toContain("changed");
      });

      it("registries_changed is not sent", async () => {
        const w = await renamed();
        expect(w.kinds()).not.toContain("registries_changed");
      });
    });

    describe("When a registry reload fails", () => {
      it("snapshot keeps the previous value and no event is sent", async () => {
        const w = await world({ seed: place });
        const before = w.link.snapshot();
        w.ha.failNext("config/device_registry/list");
        w.ha.setDevice({
          id: "dv",
          identifiers: [["mqtt", "zigbee2mqtt_0x00124b0000000001"]],
          area_id: "kitchen",
        });
        await until(() => {
          expect(w.warnings).toContain("a registry reload failed");
        });
        expect(w.link.snapshot()).toBe(before);
        expect(w.kinds()).toEqual(["link_up"]);
      });

      it("it is asked again after HA_RETRY_MS: snapshot shows the move and registries_changed is sent", async () => {
        const w = await world({ seed: place });
        w.ha.failNext("config/device_registry/list");
        w.ha.setDevice({
          id: "dv",
          identifiers: [["mqtt", "zigbee2mqtt_0x00124b0000000001"]],
          area_id: "kitchen",
        });
        await until(() => {
          expect(w.warnings).toContain("a registry reload failed");
        });
        // An unrelated change of another registry does not bring it.
        w.ha.setArea({ area_id: "attic", name: "Attic" });
        await until(() => {
          expect(w.link.snapshot()?.areas.has("attic")).toBe(true);
        });
        expect(w.link.snapshot()?.valveAreas.get("z2m:0x00124b0000000001")).toBe("office");
        w.clock.advance(HA_RETRY_MS);
        await until(() => {
          expect(w.link.snapshot()?.valveAreas.get("z2m:0x00124b0000000001")).toBe("kitchen");
        });
        expect(w.kinds().filter((kind) => kind === "registries_changed")).toHaveLength(2);
      });

      it("only one retry is asked for, however many reloads of it failed meanwhile", async () => {
        const w = await world({ seed: place, probe: true });
        const lists = (): number =>
          w.ha.commands().filter((type) => type === "config/device_registry/list").length;
        const before = lists();
        w.ha.failNext("config/device_registry/list");
        w.ha.setDevice({ id: "d2", identifiers: [["mqtt", "zigbee2mqtt_0x02"]] });
        await until(() => {
          expect(w.warnings.filter((m) => m === "a registry reload failed")).toHaveLength(1);
        });
        w.ha.failNext("config/device_registry/list");
        w.ha.setDevice({ id: "d3", identifiers: [["mqtt", "zigbee2mqtt_0x03"]] });
        await until(() => {
          expect(w.warnings.filter((m) => m === "a registry reload failed")).toHaveLength(2);
        });
        w.clock.advance(HA_RETRY_MS);
        await until(() => {
          expect(lists()).toBe(before + 3);
        });
        await w.sync();
        expect(lists()).toBe(before + 3);
      });
    });

    describe("When a registry reload gets no answer within HA_LABEL_TIMEOUT_MS", () => {
      it("it is asked again HA_RETRY_MS later and the change arrives", async () => {
        const w = await world({ seed: place });
        w.ha.failNext("stall:config/device_registry/list");
        w.ha.setDevice({
          id: "dv",
          identifiers: [["mqtt", "zigbee2mqtt_0x00124b0000000001"]],
          area_id: "kitchen",
        });
        await until(() => {
          expect(
            w.ha.commands().filter((type) => type === "config/device_registry/list"),
          ).toHaveLength(2);
        });
        w.clock.advance(HA_LABEL_TIMEOUT_MS);
        await until(() => {
          expect(w.warnings).toContain("a registry reload failed");
        });
        expect(w.link.snapshot()?.valveAreas.get("z2m:0x00124b0000000001")).toBe("office");
        w.clock.advance(HA_RETRY_MS);
        await until(() => {
          expect(w.link.snapshot()?.valveAreas.get("z2m:0x00124b0000000001")).toBe("kitchen");
        });
      });
    });

    describe("When the link drops while a retry waits", () => {
      it("the retry is not sent; the next loading brings the change", async () => {
        const w = await world({ seed: place, probe: true });
        w.ha.failNext("config/device_registry/list");
        w.ha.setDevice({
          id: "dv",
          identifiers: [["mqtt", "zigbee2mqtt_0x00124b0000000001"]],
          area_id: "kitchen",
        });
        await until(() => {
          expect(w.warnings).toContain("a registry reload failed");
        });
        w.ha.dropConnections();
        await until(() => {
          expect(w.kinds().filter((kind) => kind === "link_up")).toHaveLength(2);
        });
        expect(w.link.snapshot()?.valveAreas.get("z2m:0x00124b0000000001")).toBe("kitchen");
        const lists = w.ha.commands().filter((t) => t === "config/device_registry/list").length;
        w.clock.advance(HA_RETRY_MS);
        await w.sync();
        expect(w.ha.commands().filter((t) => t === "config/device_registry/list")).toHaveLength(
          lists,
        );
      });
    });
  });

  describe("writeLabels", () => {
    const DAY = "heatmaster_schedule_day";
    const NIGHT = "heatmaster_schedule_night";
    const EVE = "heatmaster_schedule_eve";
    const SENSOR_LABEL = "heatmaster_temp_sensor";
    const create = (name: string): LabelOp => ({ kind: "createLabel", name });
    const rename = (labelId: string, name: string): LabelOp => ({
      kind: "renameLabel",
      labelId,
      name,
    });
    const remove = (labelId: string): LabelOp => ({ kind: "deleteLabel", labelId });
    const labelArea = (areaId: string, add: string[], removed: string[] = []): LabelOp => ({
      kind: "labelArea",
      areaId,
      add,
      remove: removed,
    });
    const labelEntity = (entityId: string, add: string[], removed: string[] = []): LabelOp => ({
      kind: "labelEntity",
      entityId,
      add,
      remove: removed,
    });

    /** Areas office (day, kids) and kitchen, the labels day, night and kids, sensor.a (kids). */
    const labelled = (ha: FakeHa): void => {
      seed(ha);
      ha.setLabel({ label_id: DAY, name: "Heatmaster: Day" });
      ha.setLabel({ label_id: NIGHT, name: "Heatmaster: Night" });
      ha.setLabel({ label_id: "kids", name: "Kids" });
      ha.setArea({ area_id: "office", name: "Office", labels: [DAY, "kids"] });
      ha.setArea({ area_id: "kitchen", name: "Kitchen", labels: [] });
      ha.setEntity({ entity_id: "sensor.a", labels: ["kids"] });
    };

    /** The label writes Home Assistant received while `ops` were written, and the result. */
    async function written(
      w: World,
      ops: readonly LabelOp[],
    ): Promise<{ result: LabelWriteResult; writes: readonly Readonly<Record<string, unknown>>[] }> {
      const from = w.ha.writes().length;
      const result = await w.link.writeLabels(ops);
      return { result, writes: w.ha.writes().slice(from) };
    }

    describe('With createLabel "heatmaster_schedule_day"', () => {
      const bare = (ha: FakeHa): void => {
        seed(ha);
      };

      it("config/label_registry/create is sent with that name", async () => {
        const w = await world({ seed: bare });
        const { writes } = await written(w, [create(DAY)]);
        expect(writes).toEqual([{ type: "config/label_registry/create", name: DAY }]);
      });

      it("created maps the name to heatmaster_schedule_day", async () => {
        const w = await world({ seed: bare });
        const { result } = await written(w, [create(DAY)]);
        expect(result.created).toEqual(new Map([[DAY, DAY]]));
        expect(result.done).toEqual([create(DAY)]);
      });
    });

    describe("With a create whose id Home Assistant suffixes", () => {
      // The link's copy is stale: day already exists in Home Assistant, so the create gets day_2.
      const ops = [create(DAY), rename(DAY, "Heatmaster: Day"), labelArea("kitchen", [DAY])];

      it("created maps the name to heatmaster_schedule_day_2", async () => {
        const w = await world({ seed: labelled });
        const { result } = await written(w, ops);
        expect(result.created).toEqual(new Map([[DAY, `${DAY}_2`]]));
      });

      it("the create is in failed with label_clash", async () => {
        const w = await world({ seed: labelled });
        const { result } = await written(w, ops);
        expect(result.failed).toContainEqual({ op: create(DAY), error: "label_clash" });
        expect(result.done).not.toContainEqual(create(DAY));
      });

      it("the follow-up rename and area label are not sent and are in failed with label_clash", async () => {
        const w = await world({ seed: labelled });
        const { result, writes } = await written(w, ops);
        expect(writes).toEqual([{ type: "config/label_registry/create", name: DAY }]);
        expect(result.failed).toEqual(ops.map((op) => ({ op, error: "label_clash" })));
        expect(result.done).toEqual([]);
        expect(w.ha.writes().some((sent) => JSON.stringify(sent).includes(`${DAY}_2`))).toBe(false);
      });
    });

    describe("With renameLabel", () => {
      it("config/label_registry/update is sent with label_id and name", async () => {
        const w = await world({ seed: labelled });
        const { writes, result } = await written(w, [rename(DAY, "Heatmaster: Workday")]);
        expect(writes).toEqual([
          { type: "config/label_registry/update", label_id: DAY, name: "Heatmaster: Workday" },
        ]);
        expect(result.done).toHaveLength(1);
      });
    });

    describe("With deleteLabel", () => {
      it("config/label_registry/delete is sent with label_id", async () => {
        const w = await world({ seed: labelled });
        const { writes, result } = await written(w, [remove(NIGHT)]);
        expect(writes).toEqual([{ type: "config/label_registry/delete", label_id: NIGHT }]);
        expect(result.done).toHaveLength(1);
      });
    });

    describe("With labelArea adding night and removing day on an area that also wears kids", () => {
      it("config/area_registry/update is sent with labels [heatmaster_schedule_night, kids]", async () => {
        const w = await world({ seed: labelled });
        const { writes } = await written(w, [labelArea("office", [NIGHT], [DAY])]);
        expect(writes).toEqual([
          { type: "config/area_registry/update", area_id: "office", labels: [NIGHT, "kids"] },
        ]);
      });
    });

    describe("With labelEntity adding heatmaster_temp_sensor", () => {
      it("config/entity_registry/update is sent with the entity's labels plus heatmaster_temp_sensor", async () => {
        const w = await world({ seed: labelled });
        const { writes } = await written(w, [labelEntity("sensor.a", [SENSOR_LABEL])]);
        expect(writes).toEqual([
          {
            type: "config/entity_registry/update",
            entity_id: "sensor.a",
            labels: [SENSOR_LABEL, "kids"],
          },
        ]);
      });
    });

    describe('When the user added "guests" to the area after the op was planned', () => {
      it("the area's labels sent still hold guests", async () => {
        const w = await world({ seed: labelled });
        // The link has not heard of guests yet when the write is asked for.
        w.ha.setArea({ area_id: "office", name: "Office", labels: [DAY, "kids", "guests"] });
        const { writes } = await written(w, [labelArea("office", [NIGHT], [DAY])]);
        expect(writes).toEqual([
          {
            type: "config/area_registry/update",
            area_id: "office",
            labels: ["guests", NIGHT, "kids"],
          },
        ]);
      });
    });

    describe("With labelArea on an area Home Assistant does not have", () => {
      it("it is in failed with not_found and nothing is sent", async () => {
        const w = await world({ seed: labelled });
        const op = labelArea("attic", [NIGHT]);
        const { result, writes } = await written(w, [op]);
        expect(result.failed).toEqual([{ op, error: "not_found" }]);
        expect(writes).toEqual([]);
      });
    });

    describe("With a labelEntity op failing, among independent ops", () => {
      it("it is in failed with Home Assistant's code and the other ops are done", async () => {
        const w = await world({ seed: labelled });
        const failing = labelEntity("sensor.a", [SENSOR_LABEL]);
        const before = rename(DAY, "Heatmaster: Workday");
        const after = labelArea("kitchen", [DAY]);
        w.ha.failNext("config/entity_registry/update");
        const { result } = await written(w, [before, failing, after]);
        expect(result.failed).toEqual([{ op: failing, error: "unknown_error" }]);
        expect(result.done).toEqual([before, after]);
      });
    });

    describe("With a command that never answers", () => {
      it("after HA_LABEL_TIMEOUT_MS that op is in failed with timeout", async () => {
        const w = await world({ seed: labelled, probe: true });
        const stalled = rename(DAY, "Heatmaster: Workday");
        const next = labelArea("kitchen", [DAY]);
        w.ha.stallNext();
        let result: LabelWriteResult | undefined;
        void w.link.writeLabels([stalled, next]).then((value) => {
          result = value;
        });
        await until(() => {
          expect(w.ha.writes()).toHaveLength(1);
        });
        w.clock.advance(HA_LABEL_TIMEOUT_MS - 1);
        await w.sync();
        expect(result).toBeUndefined();
        w.clock.advance(1);
        await until(() => {
          expect(result).toBeDefined();
        });
        expect(result?.failed).toEqual([{ op: stalled, error: "timeout" }]);
        expect(result?.done).toEqual([next]);
      });

      it("unanswered lists it, and settled is true: the last reload answered after it", async () => {
        const w = await world({ seed: labelled, probe: true });
        const stalled = rename(DAY, "Heatmaster: Workday");
        w.ha.stallNext();
        let result: LabelWriteResult | undefined;
        void w.link.writeLabels([stalled, labelArea("kitchen", [DAY])]).then((value) => {
          result = value;
        });
        await until(() => {
          expect(w.ha.writes()).toHaveLength(1);
        });
        w.clock.advance(HA_LABEL_TIMEOUT_MS);
        await until(() => {
          expect(result).toBeDefined();
        });
        expect(result?.unanswered).toEqual([stalled]);
        expect(result?.settled).toBe(true);
      });
    });

    describe("With an unauthorized answer", () => {
      it("every op is in failed with unauthorized", async () => {
        const w = await world({ seed: labelled });
        const ops = [
          create(EVE),
          rename(DAY, "Heatmaster: Workday"),
          remove(NIGHT),
          labelArea("kitchen", [DAY]),
          labelEntity("sensor.a", [SENSOR_LABEL]),
        ];
        w.ha.answerUnauthorized(true);
        const { result, writes } = await written(w, ops);
        expect(result.failed).toEqual(ops.map((op) => ({ op, error: "unauthorized" })));
        expect(result.done).toEqual([]);
        expect(writes).toHaveLength(ops.length);
      });
    });

    describe("While the link is down", () => {
      it("every op fails with link_down and nothing is sent", async () => {
        const w = await world({ seed: labelled });
        w.ha.refuseConnections(true);
        w.ha.dropConnections();
        await until(() => {
          expect(w.link.state()).toBe("down");
        });
        const before = w.ha.commands().length;
        const ops = [rename(DAY, "Heatmaster: Workday"), labelArea("kitchen", [DAY])];
        const result = await w.link.writeLabels(ops);
        expect(result.failed).toEqual(ops.map((op) => ({ op, error: "link_down" })));
        expect(result.done).toEqual([]);
        expect(w.ha.commands()).toHaveLength(before);
      });
    });

    describe("When the reload before the ops fails", () => {
      it("every op fails with its code and nothing is sent", async () => {
        const w = await world({ seed: labelled });
        const ops = [rename(DAY, "Heatmaster: Workday"), labelArea("kitchen", [DAY])];
        w.ha.failNext("config/area_registry/list");
        const { result, writes } = await written(w, ops);
        expect(result.failed).toEqual(ops.map((op) => ({ op, error: "unknown_error" })));
        expect(writes).toEqual([]);
      });

      it("unanswered is empty: an op never sent is never in it", async () => {
        const w = await world({ seed: labelled });
        w.ha.failNext("config/area_registry/list");
        const { result } = await written(w, [rename(DAY, "Heatmaster: Workday")]);
        expect(result.unanswered).toEqual([]);
      });
    });

    describe("When the reload after the ops fails", () => {
      it("the registries are reloaded again and snapshot then shows the done op", async () => {
        const w = await world({ seed: labelled });
        w.ha.failNext("config/label_registry/list");
        const result = await w.link.writeLabels([rename(DAY, "Heatmaster: Workday")]);
        expect(result.done).toHaveLength(1);
        await until(() => {
          expect(w.link.snapshot()?.labels.get(DAY)).toBe("Heatmaster: Workday");
        });
      });

      it("settled is false, and loads rises once a later reload answered", async () => {
        const w = await world({ seed: labelled });
        w.ha.failNext("config/label_registry/list");
        const result = await w.link.writeLabels([rename(DAY, "Heatmaster: Workday")]);
        const atResult = w.link.loads();
        expect(result.settled).toBe(false);
        expect(w.link.snapshot()?.labels.get(DAY)).not.toBe("Heatmaster: Workday");
        await until(() => {
          expect(w.link.snapshot()?.labels.get(DAY)).toBe("Heatmaster: Workday");
        });
        expect(w.link.loads()).toBeGreaterThan(atResult);
      });
    });

    describe("When the reload after the ops fails twice", () => {
      it("the registries are asked again HA_RETRY_MS later and snapshot shows the done op", async () => {
        const w = await world({ seed: labelled });
        w.ha.failNext("config/label_registry/list");
        const result = await w.link.writeLabels([rename(DAY, "Heatmaster: Workday")]);
        expect(result.settled).toBe(false);
        // The batch's own re-reload of the labels fails too.
        w.ha.failNext("config/label_registry/list");
        await until(() => {
          expect(w.warnings.filter((m) => m === "a registry reload failed")).toHaveLength(2);
        });
        expect(w.link.snapshot()?.labels.get(DAY)).toBe("Heatmaster: Day");
        w.clock.advance(HA_RETRY_MS);
        await until(() => {
          expect(w.link.snapshot()?.labels.get(DAY)).toBe("Heatmaster: Workday");
        });
      });
    });

    describe("With a user's label change coalesced with the answer of the batch's last label reload", () => {
      it("the label registry is reloaded again and snapshot shows the user's change", async () => {
        const w = await world({ seed: labelled, probe: true });
        w.ha.coalesceNext("config/label_registry/list", () => {
          w.ha.setLabel({ label_id: "guests", name: "Guests" });
        });
        const result = await w.link.writeLabels([rename(DAY, "Heatmaster: Workday")]);
        expect(result.settled).toBe(true);
        await until(() => {
          expect(w.link.snapshot()?.labels.get("guests")).toBe("Guests");
        });
      });
    });

    describe("With a user's area change coalesced with the answer of the batch's last area reload", () => {
      it("the area registry is reloaded again and snapshot shows the user's change", async () => {
        const w = await world({ seed: labelled, probe: true });
        let areaLists = 0;
        const hook = (): void => {
          // The batch's first area list is its reload before the ops; the second is its last.
          areaLists += 1;
          if (areaLists === 1) {
            w.ha.coalesceNext("config/area_registry/list", hook);
            return;
          }
          w.ha.setArea({
            area_id: "office",
            name: "Office",
            labels: [DAY, "kids", "heatmaster_ignore"],
          });
        };
        w.ha.coalesceNext("config/area_registry/list", hook);
        await w.link.writeLabels([rename(DAY, "Heatmaster: Workday")]);
        await until(() => {
          expect(w.link.snapshot()?.areas.get("office")?.labels).toContain("heatmaster_ignore");
        });
      });
    });

    describe("With a deleteLabel before a labelArea for an area that wears the deleted label", () => {
      it("the area update does not send the deleted label back", async () => {
        const w = await world({ seed: labelled });
        const { result, writes } = await written(w, [remove(DAY), labelArea("office", [NIGHT])]);
        expect(result.failed).toEqual([]);
        expect(writes[1]).toEqual({
          type: "config/area_registry/update",
          area_id: "office",
          labels: [NIGHT, "kids"],
        });
      });
    });

    describe("With the link dropping while an op of the batch is in flight", () => {
      const ops = (): LabelOp[] => [
        rename(DAY, "Heatmaster: Workday"),
        labelArea("kitchen", [DAY]),
        labelEntity("sensor.a", [SENSOR_LABEL]),
      ];
      async function dropped(): Promise<{
        w: World;
        result: LabelWriteResult;
        writes: readonly Readonly<Record<string, unknown>>[];
      }> {
        const w = await world({ seed: labelled });
        w.ha.failNext("close:config/area_registry/update");
        const { result, writes } = await written(w, ops());
        return { w, result, writes };
      }

      it("the op in flight fails with link_down and is unanswered", async () => {
        const { result } = await dropped();
        const [, inFlight] = ops();
        expect(result.failed).toContainEqual({ op: inFlight, error: "link_down" });
        expect(result.unanswered).toEqual([inFlight]);
      });

      it("the ops after it fail with link_down unsent", async () => {
        const { result, writes } = await dropped();
        const [, , after] = ops();
        expect(result.failed).toContainEqual({ op: after, error: "link_down" });
        expect(writes.map((write) => write.type)).toEqual([
          "config/label_registry/update",
          "config/area_registry/update",
        ]);
      });

      it("no last reload is sent and settled is false", async () => {
        const { w, result } = await dropped();
        expect(result.settled).toBe(false);
        const sent = w.ha.commands();
        const last = sent.lastIndexOf("config/area_registry/update");
        expect(sent.slice(last + 1)).not.toContain("config/label_registry/list");
      });
    });

    describe("With a device registry event arriving during the batch", () => {
      it("its reload is not folded into the batch: it runs after it and snapshot shows the move", async () => {
        const w = await world({
          seed: (ha) => {
            labelled(ha);
            ha.setDevice({
              id: "dv",
              identifiers: [["mqtt", "zigbee2mqtt_0x00124b0000000001"]],
              area_id: "office",
            });
          },
        });
        w.ha.coalesceNext("config/label_registry/update", () => {
          w.ha.setDevice({
            id: "dv",
            identifiers: [["mqtt", "zigbee2mqtt_0x00124b0000000001"]],
            area_id: "kitchen",
          });
        });
        const from = w.ha.commands().length;
        const result = await w.link.writeLabels([rename(DAY, "Heatmaster: Workday")]);
        expect(result.settled).toBe(true);
        await until(() => {
          expect(w.link.snapshot()?.valveAreas.get("z2m:0x00124b0000000001")).toBe("kitchen");
        });
        const sent = w.ha.commands().slice(from);
        expect(sent.indexOf("config/device_registry/list")).toBeGreaterThan(
          sent.lastIndexOf("config/label_registry/list"),
        );
      });
    });

    describe("After it resolves", () => {
      it("snapshot shows every done op", async () => {
        const w = await world({ seed: labelled });
        const result = await w.link.writeLabels([
          create(EVE),
          rename(EVE, "Heatmaster: Eve"),
          labelArea("kitchen", [EVE]),
          labelArea("office", [NIGHT], [DAY]),
          labelEntity("sensor.a", [SENSOR_LABEL]),
          remove(DAY),
        ]);
        expect(result.failed).toEqual([]);
        expect(result.settled).toBe(true);
        const snapshot = w.link.snapshot();
        expect(snapshot?.labels.get(EVE)).toBe("Heatmaster: Eve");
        expect(snapshot?.labels.has(DAY)).toBe(false);
        expect(snapshot?.areas.get("kitchen")?.labels).toEqual([EVE]);
        expect(snapshot?.areas.get("office")?.labels).toEqual([NIGHT, "kids"]);
        expect(snapshot?.entities.get("sensor.a")?.labels).toEqual([SENSOR_LABEL, "kids"]);
      });
    });

    describe("With a registry event arriving during the batch", () => {
      const LISTS = [
        "config/label_registry/list",
        "config/area_registry/list",
        "config/entity_registry/list",
        "config/device_registry/list",
      ];

      /** The registry lists sent before, between and after the batch's label writes. */
      async function phases(): Promise<Readonly<Record<"before" | "between" | "after", string[]>>> {
        const w = await world({ seed: labelled, probe: true });
        const from = w.ha.commands().length;
        // Every write's echo is a registry event that arrives while the batch runs.
        const result = await w.link.writeLabels([
          create(EVE),
          rename(EVE, "Heatmaster: Eve"),
          labelArea("kitchen", [EVE]),
          labelEntity("sensor.a", [SENSOR_LABEL]),
          remove(NIGHT),
        ]);
        expect(result.failed).toEqual([]);
        await w.sync();
        const sent = w.ha.commands().slice(from);
        const first = sent.findIndex((type) => LABEL_WRITES.includes(type));
        const last = sent.findLastIndex((type) => LABEL_WRITES.includes(type));
        const lists = (part: string[]): string[] =>
          part.filter((type) => LISTS.includes(type)).sort();
        return {
          before: lists(sent.slice(0, first)),
          between: lists(sent.slice(first, last + 1)),
          after: lists(sent.slice(last + 1)),
        };
      }

      it("the area and entity registries are reloaded once before the first op", async () => {
        expect((await phases()).before).toEqual([
          "config/area_registry/list",
          "config/entity_registry/list",
        ]);
      });

      it("no registry is reloaded between ops", async () => {
        expect((await phases()).between).toEqual([]);
      });

      it("each of the label, area and entity registries is reloaded once after the ops", async () => {
        expect((await phases()).after).toEqual([
          "config/area_registry/list",
          "config/entity_registry/list",
          "config/label_registry/list",
        ]);
      });
    });
  });

  describe("commands", () => {
    describe("After a start, a reconnect, a poll and a registry update", () => {
      async function busy(): Promise<World> {
        const w = await world();
        w.ha.dropConnections();
        await until(() => {
          expect(w.kinds()).toEqual(["link_up", "link_down", "link_up"]);
        });
        w.clock.advance(HA_POLL_MS);
        await until(() => {
          expect(w.ha.requests()).toHaveLength(3);
        });
        w.ha.setArea({ area_id: "a", name: "A" });
        await until(() => {
          expect(w.link.areaName("a")).toBe("A");
        });
        w.ha.setLabel({ label_id: "l", name: "L" });
        await until(() => {
          expect(w.link.snapshot()?.labels.get("l")).toBe("L");
        });
        return w;
      }

      it("Home Assistant received no command type outside the list above", async () => {
        const w = await busy();
        const allowed = new Set([
          "auth",
          "supported_features",
          "ping",
          "unsubscribe_events",
          "subscribe_events",
          "get_config",
          "get_states",
          "config/entity_registry/list",
          "config/device_registry/list",
          "config/area_registry/list",
          "config/label_registry/list",
        ]);
        expect(w.ha.commands().filter((type) => !allowed.has(type))).toEqual([]);
      });

      it("call_service was never sent", async () => {
        const w = await busy();
        expect(w.ha.commands()).not.toContain("call_service");
      });

      it("every REST request was a GET of the state of an entity of a watched sensor's device", async () => {
        const w = await busy();
        expect(w.ha.requests().length).toBeGreaterThan(0);
        for (const request of w.ha.requests()) {
          expect(DEVICE_PATHS).toContain(request);
        }
      });
    });

    describe("After writes, a reconnect and registry updates", () => {
      const READS = new Set([
        "auth",
        "supported_features",
        "ping",
        "unsubscribe_events",
        "subscribe_events",
        "get_config",
        "get_states",
        "config/entity_registry/list",
        "config/device_registry/list",
        "config/area_registry/list",
        "config/label_registry/list",
      ]);

      async function written(): Promise<World> {
        const w = await world({
          seed: (ha) => {
            seed(ha);
            ha.setArea({ area_id: "office", name: "Office", labels: [] });
            ha.setLabel({ label_id: "heatmaster_schedule_old", name: "Heatmaster: Old" });
          },
        });
        const result = await w.link.writeLabels([
          { kind: "createLabel", name: "heatmaster_schedule_day" },
          { kind: "renameLabel", labelId: "heatmaster_schedule_day", name: "Heatmaster: Day" },
          { kind: "labelArea", areaId: "office", add: ["heatmaster_schedule_day"], remove: [] },
          { kind: "labelEntity", entityId: TEMP, add: ["heatmaster_temp_sensor"], remove: [] },
          { kind: "deleteLabel", labelId: "heatmaster_schedule_old" },
        ]);
        expect(result.failed).toEqual([]);
        w.ha.dropConnections();
        await until(() => {
          expect(w.kinds().filter((kind) => kind === "link_up")).toHaveLength(2);
        });
        w.ha.setArea({ area_id: "a", name: "A" });
        w.ha.setLabel({ label_id: "l", name: "L" });
        await until(() => {
          expect(w.link.areaName("a")).toBe("A");
          expect(w.link.snapshot()?.labels.get("l")).toBe("L");
        });
        return w;
      }

      it("the only writes sent were the five label commands", async () => {
        const w = await written();
        const writes = w.ha.commands().filter((type) => !READS.has(type));
        expect([...new Set(writes)].sort()).toEqual([...LABEL_WRITES].sort());
      });

      it("call_service was never sent", async () => {
        const w = await written();
        expect(w.ha.commands()).not.toContain("call_service");
      });
    });
  });

  describe("stop", () => {
    describe("Always", () => {
      it("the socket is closed", async () => {
        const w = await world();
        expect(w.ha.openSockets()).toBe(1);
        await w.link.stop();
        await until(() => {
          expect(w.ha.openSockets()).toBe(0);
        });
      });

      it("no retry timer and no poll timer remains", async () => {
        const w = await world();
        expect(w.clock.pending()).toBe(1);
        await w.link.stop();
        expect(w.clock.pending()).toBe(0);

        const retrying = await world({ start: false });
        retrying.ha.refuseConnections(true);
        startOn(retrying);
        await until(() => {
          expect(retrying.clock.pending()).toBe(1);
        });
        await retrying.link.stop();
        expect(retrying.clock.pending()).toBe(0);
      });

      it("no event is sent afterwards", async () => {
        const w = await world();
        // A second link on the same server shows when the server has delivered the changes.
        const witness = createHaLink({ url: w.ha.url, token: "test-token" }, createManualClock(T), {
          warn: () => undefined,
        });
        cleanups.push(() => witness.stop());
        witness.watch(new Set([TEMP]));
        witness.start(() => undefined);
        await until(() => {
          expect(witness.up()).toBe(true);
        });
        await w.link.stop();
        const before = w.events.length;
        w.ha.setConfig({ time_zone: "Europe/Berlin", language: "en" });
        w.ha.setState(TEMP, "25", C, T + 1000);
        await until(() => {
          expect(witness.sensor(TEMP)?.celsius).toBe(25);
          expect(witness.house()?.timeZone).toBe("Europe/Berlin");
        });
        expect(w.events).toHaveLength(before);
      });

      it("no poll request is sent afterwards", async () => {
        const w = await world();
        await w.link.stop();
        w.clock.advance(HA_POLL_MS * 2);
        // A request of our own, after the polls would have started, shows what the server saw.
        await fetch(`${w.ha.url}/api/states/${TEMP}`, {
          headers: { Authorization: "Bearer test-token" },
        });
        expect(w.ha.requests()).toEqual([`GET /api/states/${TEMP}`]);
      });

      it("state is not up and up() is false", async () => {
        const w = await world();
        await w.link.stop();
        expect(w.link.state()).not.toBe("up");
        expect(w.link.up()).toBe(false);
      });
    });
  });
});

const DEVICE_PATHS = [TEMP, HUM, BAT].map((id) => `GET /api/states/${id}`);
