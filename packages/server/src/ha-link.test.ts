import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket as WsWebSocket } from "ws";
import { startFakeHa, type FakeHa } from "../test/fake-ha.ts";
import { createManualClock, type ManualClock } from "../test/manual-clock.ts";
import {
  HA_POLL_MS,
  HA_RETRY_MS,
  buildHaLink,
  createHaLink,
  type HaEvent,
  type HaLink,
} from "./ha-link.ts";

const WAIT = { timeout: 8000, interval: 5 };
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
        w.clock.advance(HA_POLL_MS);
        // Watching afterwards asks for one device only: the poll above asked for nothing.
        w.link.watch(new Set([TEMP]));
        await until(() => {
          expect(w.ha.requests()).toHaveLength(3);
        });
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
        expect(w.kinds()).toEqual(["link_up", "changed"]);
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
        await w.link.stop();
        const before = w.events.length;
        w.ha.setState(TEMP, "25", C, T + 1000);
        w.ha.setConfig({ time_zone: "Europe/Berlin", language: "en" });
        w.clock.advance(HA_POLL_MS * 2);
        // Another websocket client shows the server did receive those changes while we were quiet.
        expect(w.events).toHaveLength(before);
        expect(w.ha.requests()).toEqual([]);
      });
    });
  });
});

const DEVICE_PATHS = [TEMP, HUM, BAT].map((id) => `GET /api/states/${id}`);
