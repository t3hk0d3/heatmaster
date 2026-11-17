import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startFakeHa, type FakeHa } from "../test/fake-ha.ts";
import { startFakeZ2m, type FakeZ2m, type Received } from "../test/fake-z2m.ts";
import { createManualClock, type ManualClock } from "../test/manual-clock.ts";
import { startRawBroker } from "../test/raw-broker.ts";
import { PRESS_TOPIC, roomConfigTopic, roomStateTopic, systemConfigTopic } from "./discovery.ts";
import { API_HOST, type Options } from "./options.ts";
import { systemClock } from "./clock.ts";
import { createMqttClient } from "./mqtt.ts";
import { start, type Running } from "./main.ts";
import type { DeviceSnapshot } from "./runtime.ts";
import { stateView } from "./views.ts";

const stopOrder: string[] = [];

vi.mock("./discovery.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./discovery.ts")>();
  return {
    ...original,
    createDiscovery: (...args: Parameters<typeof original.createDiscovery>) => {
      const discovery = original.createDiscovery(...args);
      return {
        ...discovery,
        stop: async () => {
          stopOrder.push("discovery");
          await discovery.stop();
        },
      };
    },
  };
});
vi.mock("./runtime.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./runtime.ts")>();
  return {
    ...original,
    createRuntime: (...args: Parameters<typeof original.createRuntime>) => {
      const runtime = original.createRuntime(...args);
      return {
        ...runtime,
        stop: async () => {
          stopOrder.push("runtime");
          await runtime.stop();
        },
      };
    },
  };
});
vi.mock("./mqtt.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./mqtt.ts")>();
  return {
    ...original,
    createMqttClient: (...args: Parameters<typeof original.createMqttClient>) => {
      const client = original.createMqttClient(...args);
      return {
        ...client,
        end: async () => {
          stopOrder.push("mqtt");
          await client.end();
        },
      };
    },
  };
});
vi.mock("./api.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./api.ts")>();
  return {
    ...original,
    buildApi: (...args: Parameters<typeof original.buildApi>) => {
      const app = original.buildApi(...args);
      app.addHook("onClose", () => {
        stopOrder.push("api");
      });
      return app;
    },
  };
});

const SERVER_DIR = path.resolve(import.meta.dirname, "..");
const MAIN = path.join(SERVER_DIR, "src/main.ts");
const VERSION = (
  JSON.parse(readFileSync(path.join(SERVER_DIR, "package.json"), "utf8")) as { version: string }
).version;

/** Options for in-process starts. Nothing connects to the broker yet. */
function optionsFor(port: number): Options {
  return {
    dataDir: temporaryFolder(),
    publicDir: temporaryFolder(),
    port,
    mqtt: {
      url: "mqtt://127.0.0.1:1",
      username: undefined,
      password: undefined,
      clientId: undefined,
    },
    z2m: { baseTopic: "zigbee2mqtt" },
    ha: undefined,
    discoveryPrefix: "homeassistant",
  };
}

/** Opens a listener of its own on a free port. */
async function listener(): Promise<{ port: number; close(): Promise<void> }> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, API_HOST, resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** Finds a free port the way the tests describe: open a listener, note the port, close it. */
async function freePort(): Promise<number> {
  const probe = await listener();
  await probe.close();
  return probe.port;
}

function accepts(port: number, host = API_HOST): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });
}

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function temporaryFolder(): string {
  const folder = mkdtempSync(path.join(os.tmpdir(), "heatmaster-main-"));
  folders.push(folder);
  return folder;
}

/** Starts the process with an MQTT address where nothing listens and temporary folders. */
async function runMain(
  port: number,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<{
  child: ChildProcess;
  lines: string[];
  exited: Promise<number | null>;
}> {
  const mqttPort = await freePort();
  const child = spawn(process.execPath, [MAIN], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      HEATMASTER_PORT: String(port),
      MQTT_URL: `mqtt://127.0.0.1:${String(mqttPort)}`,
      DATA_DIR: temporaryFolder(),
      PUBLIC_DIR: temporaryFolder(),
      // A dead local address: the process never reaches a real Home Assistant.
      HA_URL: `http://127.0.0.1:${String(await freePort())}`,
      HA_TOKEN: "test-token",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: string[] = [];
  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream }).on("line", (line) => lines.push(line));
  }
  const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
  return { child, lines, exited };
}

async function logLine(lines: string[], text: string, exited: Promise<unknown>): Promise<string> {
  const state = { stopped: false };
  void exited.then(() => {
    state.stopped = true;
  });
  for (;;) {
    const found = lines.find((line) => line.includes(text));
    if (found !== undefined) return found;
    if (state.stopped) throw new Error(`the process ended before it logged ${text}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("server package", () => {
  describe("workspace link", () => {
    describe('When Node, started in packages/server, imports "@heatmaster/core"', () => {
      it("it loads packages/core/src/index.ts as it is, with no build step", () => {
        const result = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            'await import("@heatmaster/core"); console.log(import.meta.resolve("@heatmaster/core"));',
          ],
          { cwd: SERVER_DIR, encoding: "utf8" },
        );
        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toMatch(/\/packages\/core\/src\/index\.ts$/);
      });
    });
  });
});

describe("main", () => {
  describe("start", () => {
    describe("With a free port", () => {
      it("resolves, and GET /api/health on 127.0.0.1 at that port answers 200 with status ok and the server package's version", async () => {
        const fake = await startFakeZ2m();
        const port = await freePort();
        const dirs = { dataDir: temporaryFolder(), publicDir: temporaryFolder() };
        const running = await start(liveOptions(port, fake, undefined, dirs), systemClock, false);
        try {
          const response = await fetch(`http://127.0.0.1:${String(port)}/api/health`);
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ status: "ok", version: VERSION });
        } finally {
          await running.stop();
          await fake.stop();
        }
      });

      it("with no broker at the address, GET /api/health answers 503 with code mqtt_fault", async () => {
        const port = await freePort();
        const running = await start(optionsFor(port), systemClock, false);
        try {
          const response = await fetch(`http://127.0.0.1:${String(port)}/api/health`);
          expect(response.status).toBe(503);
          expect(await response.json()).toMatchObject({
            code: "mqtt_fault",
            data: { reason: "mqtt_unavailable" },
          });
        } finally {
          await running.stop();
        }
      });

      it("the server's address is 127.0.0.1", async () => {
        const port = await freePort();
        const running = await start(optionsFor(port), systemClock, false);
        try {
          expect(await accepts(port, "127.0.0.1")).toBe(true);
          // Another loopback address reaches only a listener that is not bound to 127.0.0.1 alone.
          expect(await accepts(port, "127.0.0.2")).toBe(false);
        } finally {
          await running.stop();
        }
      });
    });

    describe("With a port that is already in use", () => {
      it("rejects, and nothing is left listening", async () => {
        const taken = await listener();
        try {
          await expect(start(optionsFor(taken.port), systemClock, false)).rejects.toThrow();
        } finally {
          await taken.close();
        }
        expect(await accepts(taken.port)).toBe(false);
      });
    });
  });

  describe("stop", () => {
    describe("After start", () => {
      it("resolves, and the port no longer accepts connections", async () => {
        const port = await freePort();
        const running = await start(optionsFor(port), systemClock, false);
        await running.stop();
        expect(await accepts(port)).toBe(false);
      });
    });

    describe("Called a second time", () => {
      it("resolves and does nothing", async () => {
        const running = await start(optionsFor(await freePort()), systemClock, false);
        await running.stop();
        await expect(running.stop()).resolves.toBeUndefined();
      });
    });
  });

  describe("process (node packages/server/src/main.ts with HEATMASTER_PORT set to a free port)", () => {
    describe("On start", () => {
      it("writes one log line that holds the address it listens on", async () => {
        const port = await freePort();
        const { child, lines, exited } = await runMain(port);
        try {
          await logLine(lines, `127.0.0.1:${String(port)}`, exited);
          expect(lines.filter((line) => line.includes(`127.0.0.1:${String(port)}`))).toHaveLength(
            1,
          );
        } finally {
          child.kill("SIGTERM");
          await exited;
        }
      });
    });

    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      describe(`On ${signal}`, () => {
        it("ends with exit code 0", async () => {
          const port = await freePort();
          const { child, lines, exited } = await runMain(port);
          try {
            await logLine(lines, `127.0.0.1:${String(port)}`, exited);
            child.kill(signal);
            expect(await exited).toBe(0);
          } finally {
            child.kill("SIGKILL");
            await exited;
          }
        });
      });
    }

    describe("With HEATMASTER_PORT set to a port that is in use", () => {
      it("ends with exit code 1 after logging the error", async () => {
        const taken = await listener();
        try {
          const { lines, exited } = await runMain(taken.port);
          expect(await exited).toBe(1);
          expect(lines.join("\n")).toMatch(/EADDRINUSE/);
        } finally {
          await taken.close();
        }
      });
    });
  });
});

// ---- the runtime inside main ---------------------------------------------------------------------

const T = Date.UTC(2026, 10, 16, 9, 0, 0);
const WAIT = { timeout: 10 * 1000, interval: 5 };
const IEEE = "0xa1";
const VALVE = `z2m:${IEEE}`;
const SENSOR_ENTITY = "sensor.living";
const DAY_KEYS_Z2M = [
  "weekly_schedule_monday",
  "weekly_schedule_tuesday",
  "weekly_schedule_wednesday",
  "weekly_schedule_thursday",
  "weekly_schedule_friday",
  "weekly_schedule_saturday",
  "weekly_schedule_sunday",
];
const NO_CHANGE = {
  expectedRevision: undefined,
  overwriteUnreadable: false,
};

function weekOf(weekend: number): unknown[] {
  const day = (temperature: number): Record<string, number> => ({
    "00:00": 16,
    "07:00": temperature,
  });
  return [
    { days: "weekdays", temperature: day(20) },
    { days: "weekend", temperature: day(weekend) },
  ];
}

/** The house's config: the area living's entry holds the Home Assistant sensor. */
function houseConfig(weekend = 20): Record<string, unknown> {
  return {
    version: 3,
    settings: { hold_writes: false, timezone: "Europe/Amsterdam" },
    schedules: [{ id: "main", name: "Main", week: weekOf(weekend) }],
    default_schedule: "main",
    rooms: { living: { sensors: [{ ref: `ha:${SENSOR_ENTITY}` }] } },
  };
}

const VALVE_DEVICE = { id: "valve", identifiers: [["mqtt", `zigbee2mqtt_${IEEE}`]] } as const;

/** Home Assistant puts the valve's device in the area living. */
function placeValve(ha: FakeHa): void {
  ha.setArea({ area_id: "living", name: "Living" });
  ha.setDevice({ ...VALVE_DEVICE, area_id: "living" });
}

function seedHa(ha: FakeHa): void {
  placeValve(ha);
  ha.setDevice({ id: "d1", identifiers: [["mqtt", "zigbee2mqtt_0x5e"]] });
  ha.setEntity({ entity_id: SENSOR_ENTITY, device_id: "d1" });
  ha.setState(
    SENSOR_ENTITY,
    "19.6",
    { unit_of_measurement: "°C", device_class: "temperature", friendly_name: "Living" },
    T,
  );
}

const TRVZB_STATE = {
  temperature_sensor_select: "local_temperature",
  system_mode: "auto",
  occupied_heating_setpoint: 17,
  local_temperature: 19.3,
  battery: 90,
  ...Object.fromEntries(
    DAY_KEYS_Z2M.map((key) => [key, "00:00/17 00:00/17 00:00/17 00:00/17 00:00/17 00:00/17"]),
  ),
};

function liveOptions(
  port: number,
  fake: FakeZ2m,
  ha: FakeHa | undefined,
  dirs: Readonly<{ dataDir: string; publicDir: string }>,
): Options {
  return {
    ...dirs,
    port,
    mqtt: { url: fake.url, username: undefined, password: undefined, clientId: undefined },
    z2m: { baseTopic: "zigbee2mqtt" },
    ha: ha === undefined ? undefined : { url: ha.url, token: "test-token" },
    discoveryPrefix: "ha_test",
  };
}

const live: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of live.splice(0).reverse()) await close();
});

describe("main (runtime)", () => {
  describe("start", () => {
    describe("With a reachable broker and an online bridge", () => {
      it("resolves with a started runtime; its snapshot has links.z2m true once the bridge state has arrived", async () => {
        const fake = await startFakeZ2m();
        live.push(() => fake.stop());
        const dirs = { dataDir: temporaryFolder(), publicDir: temporaryFolder() };
        const running = await start(
          liveOptions(await freePort(), fake, undefined, dirs),
          createManualClock(T),
          false,
        );
        live.push(() => running.stop());
        await vi.waitFor(() => {
          expect(running.runtime.snapshot().links.z2m).toBe(true);
        }, WAIT);
        expect(running.runtime.snapshot().tickedAt).toBe(T);
      });

      it("GET /api/health still answers 200", async () => {
        const fake = await startFakeZ2m();
        live.push(() => fake.stop());
        const port = await freePort();
        const dirs = { dataDir: temporaryFolder(), publicDir: temporaryFolder() };
        const running = await start(
          liveOptions(port, fake, undefined, dirs),
          createManualClock(T),
          false,
        );
        live.push(() => running.stop());
        const response = await fetch(`http://127.0.0.1:${String(port)}/api/health`);
        expect(response.status).toBe(200);
      });
    });

    describe("While start has not resolved yet (the raw broker with withholdConnack on)", () => {
      it("GET /api/health answers 503 with code not_ready", async () => {
        const broker = await startRawBroker();
        live.push(() => broker.stop());
        broker.withholdConnack(true);
        const port = await freePort();
        const dirs = { dataDir: temporaryFolder(), publicDir: temporaryFolder() };
        const starting = start(
          {
            ...optionsFor(port),
            ...dirs,
            mqtt: {
              url: broker.url,
              username: undefined,
              password: undefined,
              clientId: undefined,
            },
          },
          createManualClock(T),
          false,
        );
        let answer: Response | undefined;
        try {
          await vi.waitFor(async () => {
            answer = await fetch(`http://127.0.0.1:${String(port)}/api/health`);
          }, WAIT);
          expect(answer?.status).toBe(503);
          expect(await answer?.json()).toMatchObject({ code: "not_ready" });
        } finally {
          // MQTT.js's connect timeout runs on real time, so start only resolves once it is let in.
          broker.withholdConnack(false);
        }
        const running = await starting;
        live.push(() => running.stop());
      });
    });

    describe("After it resolved", () => {
      it("GET /api/health answers 200 and GET /api/state answers the state of the runtime", async () => {
        const broker = await startRawBroker();
        live.push(() => broker.stop());
        const port = await freePort();
        const dirs = { dataDir: temporaryFolder(), publicDir: temporaryFolder() };
        const running = await start(
          {
            ...optionsFor(port),
            ...dirs,
            mqtt: {
              url: broker.url,
              username: undefined,
              password: undefined,
              clientId: undefined,
            },
          },
          createManualClock(T),
          false,
        );
        live.push(() => running.stop());
        const health = await fetch(`http://127.0.0.1:${String(port)}/api/health`);
        expect(health.status).toBe(200);
        const state = await fetch(`http://127.0.0.1:${String(port)}/api/state`);
        expect(state.status).toBe(200);
        expect(await state.json()).toEqual(
          JSON.parse(JSON.stringify(stateView(running.runtime.snapshot()))),
        );
      });

      it("POST /api/upgrade/dismiss and POST /api/valves/:id/accept-originals reach the runtime", async () => {
        const broker = await startRawBroker();
        live.push(() => broker.stop());
        const port = await freePort();
        const dirs = { dataDir: temporaryFolder(), publicDir: temporaryFolder() };
        const running = await start(
          {
            ...optionsFor(port),
            ...dirs,
            mqtt: {
              url: broker.url,
              username: undefined,
              password: undefined,
              clientId: undefined,
            },
          },
          createManualClock(T),
          false,
        );
        live.push(() => running.stop());
        const post = (route: string): Promise<Response> =>
          fetch(`http://127.0.0.1:${String(port)}${route}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          });
        expect((await post("/api/upgrade/dismiss")).status).toBe(204);
        const refused = await post("/api/valves/z2m:0xa1/accept-originals");
        expect(refused.status).toBe(409);
        expect(((await refused.json()) as { code: string }).code).toBe("valve_not_pending");
      });
    });

    describe("With no broker at the address", () => {
      it("resolves; the runtime's snapshot has transportFaults.z2m mqtt_unavailable and one tick has run", async () => {
        const running = await start(optionsFor(await freePort()), createManualClock(T), false);
        live.push(() => running.stop());
        const snapshot = running.runtime.snapshot();
        expect(snapshot.transportFaults.z2m).toBe("mqtt_unavailable");
        expect(snapshot.tickedAt).toBe(T);
      });
    });

    describe("With ha undefined in the options", () => {
      it("the runtime's snapshot has no ha entry in links", async () => {
        const running = await start(optionsFor(await freePort()), createManualClock(T), false);
        live.push(() => running.stop());
        expect(Object.hasOwn(running.runtime.snapshot().links, "ha")).toBe(false);
      });
    });

    describe("With ha set and the fake Home Assistant running", () => {
      it("the runtime's snapshot has links.ha true once the link is up", async () => {
        const fake = await startFakeZ2m();
        live.push(() => fake.stop());
        const ha = await startFakeHa();
        live.push(() => ha.stop());
        const dirs = { dataDir: temporaryFolder(), publicDir: temporaryFolder() };
        const running = await start(
          liveOptions(await freePort(), fake, ha, dirs),
          createManualClock(T),
          false,
        );
        live.push(() => running.stop());
        await vi.waitFor(() => {
          expect(running.runtime.snapshot().links.ha).toBe(true);
        }, WAIT);
        expect(JSON.stringify(running.runtime.diagnostics())).not.toContain("test-token");
      });
    });
  });

  describe("stop", () => {
    describe("Always", () => {
      it("every socket of /api/events is closed and the port no longer accepts connections", async () => {
        const fake = await startFakeZ2m();
        live.push(() => fake.stop());
        const port = await freePort();
        const dirs = { dataDir: temporaryFolder(), publicDir: temporaryFolder() };
        const running = await start(
          liveOptions(port, fake, undefined, dirs),
          createManualClock(T),
          false,
        );
        const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/api/events`);
        const opened = new Promise<void>((resolve, reject) => {
          socket.once("open", () => {
            resolve();
          });
          socket.once("error", reject);
        });
        const closed = new Promise<number>((resolve) => {
          socket.once("close", resolve);
        });
        await opened;
        await running.stop();
        expect(await closed).toBe(1001);
        expect(await accepts(port)).toBe(false);
      });

      it('"offline" is published on heatmaster/status, no timer remains and the port no longer accepts connections', async () => {
        const fake = await startFakeZ2m();
        live.push(() => fake.stop());
        const ha = await startFakeHa();
        live.push(() => ha.stop());
        const port = await freePort();
        const clock = createManualClock(T);
        const dirs = { dataDir: temporaryFolder(), publicDir: temporaryFolder() };
        const running = await start(liveOptions(port, fake, ha, dirs), clock, false);
        await vi.waitFor(() => {
          expect(fake.retained("heatmaster/status")).toBe("online");
          expect(running.runtime.snapshot().links.ha).toBe(true);
        }, WAIT);
        await running.stop();
        expect(fake.retained("heatmaster/status")).toBe("offline");
        expect(clock.pending()).toBe(0);
        expect(await accepts(port)).toBe(false);
      });
    });
  });

  /**
   * One story, told in order: each `it` continues from where the one before it stopped. The fake's
   * answers are held, the clock advanced and the answers then released, so that an answer is
   * later than its request. Fake device messages are never retained.
   */
  describe(
    "end to end (fake Zigbee2MQTT, real stores in a temporary directory, hold off, time advanced by the test)",
    { timeout: 30 * 1000 },
    () => {
      const world = {} as {
        fake: FakeZ2m;
        ha: FakeHa;
        clock: ManualClock;
        options: Options;
        running: Running;
        /** Index into the fake's received list where the current step began. */
        mark: number;
        /** The stored files, copied at points of the story, for the stored-documents check. */
        files: Record<string, unknown>[];
      };
      const dirs = { dataDir: "", publicDir: "" };

      beforeAll(async () => {
        dirs.dataDir = mkdtempSync(path.join(os.tmpdir(), "heatmaster-e2e-"));
        dirs.publicDir = mkdtempSync(path.join(os.tmpdir(), "heatmaster-e2e-"));
        world.fake = await startFakeZ2m();
        world.fake.addDevice({ ieee: IEEE, name: "living/valve", modelId: "TRVZB" }, TRVZB_STATE);
        world.ha = await startFakeHa();
        seedHa(world.ha);
        world.clock = createManualClock(T);
        world.options = liveOptions(await freePort(), world.fake, world.ha, dirs);
        world.files = [];
        world.running = await start(world.options, world.clock, false);
        await vi.waitFor(() => {
          expect(world.running.runtime.snapshot().links).toEqual({ z2m: true, ha: true });
        }, WAIT);
      });

      afterAll(async () => {
        await world.running.stop();
        await world.ha.stop();
        await world.fake.stop();
        rmSync(dirs.dataDir, { recursive: true, force: true });
        rmSync(dirs.publicDir, { recursive: true, force: true });
      });

      const received = (): readonly Received[] => world.fake.received(IEEE).slice(world.mark);
      const sets = (): Readonly<Record<string, unknown>>[] =>
        received()
          .filter((r) => r.kind === "set")
          .map((r) => r.payload as Readonly<Record<string, unknown>>);
      const daySets = (): Readonly<Record<string, unknown>>[] =>
        sets().filter((payload) => DAY_KEYS_Z2M.some((key) => Object.hasOwn(payload, key)));
      const gets = (): number => received().filter((r) => r.kind === "get").length;
      const begin = (): void => {
        world.mark = world.fake.received(IEEE).length;
      };

      /**
       * `settled()` also waits for an armed debounce. A message of the fake can arrive while it
       * waits and arm one; then the clock is moved a second at a time until its tick has run.
       */
      async function settle(): Promise<void> {
        let done = false;
        const settled = world.running.runtime.settled().then(() => {
          done = true;
        });
        let polls = 0;
        await vi.waitFor(async () => {
          polls += 1;
          if (!done && polls > 1) {
            await quiet();
            world.clock.advance(1000);
          }
          expect(done).toBe(true);
        }, WAIT);
        await settled;
      }

      /**
       * Resolves when no discovery publish is waiting for its PUBACK: the client times a publish
       * out on the manual clock, so the clock must not move meanwhile.
       */
      async function quiet(): Promise<void> {
        await world.running.discovery.sync(stateView(world.running.runtime.snapshot()));
      }

      /** Advances in steps of at most 30 s, letting the runtime settle after each. */
      async function advance(ms: number): Promise<void> {
        for (let left = ms; left > 0; left -= 30 * 1000) {
          await quiet();
          world.clock.advance(Math.min(left, 30 * 1000));
          await settle();
        }
      }

      /** Advances one second at a time until `check` passes. */
      async function advanceUntil(check: () => void): Promise<void> {
        await vi.waitFor(async () => {
          try {
            check();
          } catch (error) {
            await quiet();
            world.clock.advance(1000);
            await settle();
            throw error;
          }
        }, WAIT);
      }

      function copyFiles(): void {
        for (const name of ["config.json", "ledger.json"]) {
          world.files.push(
            JSON.parse(readFileSync(path.join(dirs.dataDir, name), "utf8")) as Record<
              string,
              unknown
            >,
          );
        }
      }

      /**
       * Moves the clock 2 s, releases the fake's held answers, waits until the runtime has the
       * last one, and holds answers again: every answer is later than its request.
       */
      async function answerLater(seen: () => void): Promise<void> {
        await advance(2000);
        world.fake.releaseAnswers();
        await vi.waitFor(seen, WAIT);
        // Held before the settling, which can publish a write: its answer must come later.
        world.fake.holdAnswers();
        await settle();
      }

      /** `answerLater` for an answer that makes the valve heard again. */
      async function answerHeard(): Promise<void> {
        const before = device()?.heardAt ?? 0;
        await answerLater(() => {
          expect(device()?.heardAt ?? 0).toBeGreaterThan(before);
        });
      }

      /** The valve's observed settings, in the describeValue form. */
      function values(): Record<string, unknown> {
        const devices = world.running.runtime.diagnostics().devices as Record<
          string,
          { values: Record<string, unknown> }
        >;
        return devices[VALVE]?.values ?? {};
      }

      function device(): DeviceSnapshot | undefined {
        return world.running.runtime.snapshot().devices.find((d) => d.deviceId === VALVE);
      }

      describe("With a room of one TRVZB that has sent one message and whose sensor source reads internal, and one ha: sensor that reports 19.6", () => {
        it("the temperature is pushed and the valve is asked to report, before any setting is written", async () => {
          // The runtime subscribes to the valve's topic once the device list has arrived; until then
          // a message is lost, so the same message (same last_seen) is published again until seen.
          world.fake.speak(IEEE);
          await vi.waitFor(() => {
            if (device()?.observed !== true) world.fake.republish(IEEE);
            expect(device()?.observed).toBe(true);
          }, WAIT);
          // From here on every answer of the fake is held until the test lets it go.
          world.fake.holdAnswers();
          begin();
          await vi.waitFor(() => {
            expect(world.running.runtime.snapshot().house).toBe("live");
          }, WAIT);
          const plan = await world.running.runtime.apply(houseConfig(), NO_CHANGE);
          expect(plan.joining.map((c) => c.valveId)).toEqual([VALVE]);
          copyFiles();
          await vi.waitFor(() => {
            expect(sets()).toEqual([{ external_temperature_input: 19.6 }]);
          }, WAIT);
          // The apply's direct ask counts for the valve's spacing: the tick right after it does
          // not ask again, a later one does.
          expect(gets()).toBe(1);
          await advanceUntil(() => {
            expect(gets()).toBe(2);
          });
          expect(received().map((r) => r.kind)).toEqual(["get", "set", "get"]);
        });

        // Timing adjusted to the core (ruling S8): the cached days differ from the wanted ones, so
        // the core publishes them at the first tick after the ask, without waiting for the answer.
        it("the seven days are published once, in one message, at the next tick (before the answer: the cached days differ)", async () => {
          await advanceUntil(() => {
            expect(daySets()).toHaveLength(1);
          });
          // The ask was the 30 s tick's (see above), so the days are the next tick's.
          expect(world.clock.nowMs() - T).toBeLessThanOrEqual(61 * 1000);
          expect(received().map((r) => r.kind)).toEqual(["get", "set", "get", "set"]);
          // The last held answer is the echo of the days.
          await answerLater(() => {
            expect(String(values().day_mon)).toContain("07:00/20");
          });
          await advance(60 * 1000);
          expect(daySets()).toHaveLength(1);
          expect(Object.keys(daySets()[0] ?? {}).sort()).toEqual([...DAY_KEYS_Z2M].sort());
        });

        it("after the room has been fresh for 10 min the sensor source is set to external", async () => {
          const sourceSets = (): unknown[] =>
            sets().filter((payload) => Object.hasOwn(payload, "temperature_sensor_select"));
          await advance(T + 9 * 60 * 1000 - world.clock.nowMs());
          expect(sourceSets()).toEqual([]);
          await advanceUntil(() => {
            expect(sourceSets()).toEqual([{ temperature_sensor_select: "remote_temperature" }]);
          });
          expect(world.clock.nowMs() - T).toBeGreaterThanOrEqual(10 * 60 * 1000);
          await answerLater(() => {
            expect(values().sensor_source).toBe("external");
          });
        });
      });

      describe("With the valve heard since that write and the schedule edited by a second apply", () => {
        it("only the changed days are published", async () => {
          await advance(5000);
          begin();
          await world.running.runtime.apply(houseConfig(22), NO_CHANGE);
          await advanceUntil(() => {
            expect(daySets()).toHaveLength(1);
          });
          expect(Object.keys(daySets()[0] ?? {}).sort()).toEqual([
            "weekly_schedule_saturday",
            "weekly_schedule_sunday",
          ]);
          await answerLater(() => {
            expect(String(values().day_sat)).toContain("07:00/22");
          });
        });
      });

      describe("With the server stopped and started again, the fake still running", () => {
        let restartedAt = 0;

        it("nothing is written to the valve before it has sent a message; it is asked to report", async () => {
          await advance(5000);
          // The room must not be fresh (ruling S8): its Home Assistant sensor sends nothing until the
          // days are published, so the link stays down and the sensor pending.
          world.ha.refuseConnections(true);
          await world.running.stop();
          // This story is about what the first start sequence sends. The budget a restart keeps
          // (pacing.json) is tested in runtime.test.ts; here the file is removed, as if the hours
          // the story skips had passed.
          rmSync(path.join(dirs.dataDir, "pacing.json"), { force: true });
          begin();
          restartedAt = world.clock.nowMs();
          world.running = await start(world.options, world.clock, false);
          await advanceUntil(() => {
            expect(gets()).toBe(1);
          });
          await advance(5000);
          expect(sets()).toEqual([]);
        });

        it("its answer is the first message since the start and does not count as heard, so it is asked again 2 min later", async () => {
          await answerLater(() => {
            expect(device()?.observed).toBe(true);
          });
          expect(device()?.heardAt).toBeUndefined();
          await advance(restartedAt + 90 * 1000 - world.clock.nowMs());
          expect(gets()).toBe(1);
          await advanceUntil(() => {
            expect(gets()).toBe(2);
          });
          expect(world.clock.nowMs() - restartedAt).toBeGreaterThanOrEqual(2 * 60 * 1000);
          expect(sets()).toEqual([]);
        });

        it("after the second answer the seven days are published once", async () => {
          await answerLater(() => {
            expect(device()?.heardAt).toBeDefined();
          });
          await advanceUntil(() => {
            expect(daySets()).toHaveLength(1);
          });
          await answerHeard();
          await advance(60 * 1000);
          expect(daySets()).toHaveLength(1);
          expect(Object.keys(daySets()[0] ?? {}).sort()).toEqual([...DAY_KEYS_Z2M].sort());
        });

        it("the sensor source is not published again while it reads external", async () => {
          await advance(5 * 60 * 1000);
          expect(values().sensor_source).toBe("external");
          expect(
            sets().filter((payload) => Object.hasOwn(payload, "temperature_sensor_select")),
          ).toEqual([]);
        });
      });

      describe("With the fake bridge restarted", () => {
        it("each managed valve is asked to report, and gets its seven days once, after it was heard", async () => {
          // An hour of quiet first, so the valve's write budget (one token per 30 min) has refilled.
          await advance(60 * 60 * 1000);
          begin();
          world.fake.restart();
          await advanceUntil(() => {
            expect(gets()).toBe(1);
          });
          expect(device()?.heardAt).toBeUndefined();
          expect(daySets()).toEqual([]);
          await answerLater(() => {
            expect(device()?.heardAt).toBeDefined();
          });
          await advanceUntil(() => {
            expect(daySets()).toHaveLength(1);
          });
          await answerHeard();
          await advance(60 * 1000);
          expect(daySets()).toHaveLength(1);
          expect(Object.keys(daySets()[0] ?? {}).sort()).toEqual([...DAY_KEYS_Z2M].sort());
          expect(received().findIndex((r) => r.kind === "get")).toBeLessThan(
            received().findIndex((r) => r.kind === "set"),
          );
        });
      });

      describe("With the valve removed from the room", () => {
        it("its original sensor source is published and no day is published", async () => {
          await advance(60 * 60 * 1000);
          begin();
          // The device leaves its area while Home Assistant is unreachable; once the link is back
          // its full load is taken at once and the valve is in no room.
          world.ha.setDevice({ ...VALVE_DEVICE, area_id: null });
          world.ha.refuseConnections(false);
          await advanceUntil(() => {
            expect(world.running.runtime.snapshot().memberships[VALVE]).toBe("releasing");
          });
          copyFiles();
          await advanceUntil(() => {
            expect(sets()).toContainEqual({ temperature_sensor_select: "local_temperature" });
          });
          await answerLater(() => {
            expect(values().sensor_source).toBe("internal");
          });
          expect(daySets()).toEqual([]);
        });

        it("once the valve was heard and 15 min have passed, ledger.json has no record for it and originals.json lists it as released", async () => {
          const ledgerRecords = (): object =>
            (
              JSON.parse(readFileSync(path.join(dirs.dataDir, "ledger.json"), "utf8")) as {
                data: { records: object };
              }
            ).data.records;
          await advance(14 * 60 * 1000);
          expect(Object.keys(ledgerRecords())).toEqual([VALVE]);
          const asked = gets();
          await advanceUntil(() => {
            expect(gets()).toBe(asked + 1);
          });
          await answerHeard();
          await advanceUntil(() => {
            expect(ledgerRecords()).toEqual({});
          });
          const copy = JSON.parse(
            readFileSync(path.join(dirs.publicDir, "originals.json"), "utf8"),
          ) as {
            data: { records: object; released: { valve_id: string; forgotten: boolean }[] };
          };
          expect(copy.data.records).toEqual({});
          expect(copy.data.released.map((r) => [r.valve_id, r.forgotten])).toEqual([
            [VALVE, false],
          ]);
          expect(daySets()).toEqual([]);
          copyFiles();
        });
      });

      describe("stored documents", () => {
        describe("After the end-to-end sequence above", () => {
          it("every field name in config.json and ledger.json is one Task 6's raw forms or Task 3's raw document names; every map key is a valve id or a setting key", () => {
            expect(world.files.length).toBeGreaterThanOrEqual(6);
            const problems = world.files.flatMap((file) => checkStored(file));
            expect(problems).toEqual([]);
          });
        });
      });
    },
  );
});

// ---- stored-document field check (preflight ruling S4) ---------------------------------------------

const VALVE_ID = /^[a-z][a-z0-9]*:[0-9a-z_.:-]{1,64}$/;
const SETTING_KEYS_RAW = [
  "day_mon",
  "day_tue",
  "day_wed",
  "day_thu",
  "day_fri",
  "day_sat",
  "day_sun",
  "active_group",
  "sensor_source",
];
const TIME_KEY = /^\d\d:\d\d$/;

type Shape =
  | Readonly<{ fields: Readonly<Record<string, Shape>> }>
  | Readonly<{ mapOf: Shape; keys: (key: string) => boolean }>
  | Readonly<{ listOf: Shape }>
  | "leaf";

const RECORD_FIELDS: Readonly<Record<string, Shape>> = {
  profile: "leaf",
  adopted_at: "leaf",
  originals: { mapOf: "leaf", keys: (key) => SETTING_KEYS_RAW.includes(key) },
};
const PRESETS: Shape = { fields: { comfort: "leaf", eco: "leaf", frost: "leaf", boost: "leaf" } };
const WEEK_BLOCK: Shape = {
  fields: { days: "leaf", temperature: { mapOf: "leaf", keys: (key) => TIME_KEY.test(key) } },
};
const AREA_ID = /^[a-z0-9_]{1,64}$/;
const CONFIG_DOCUMENT: Shape = {
  fields: {
    version: "leaf",
    default_schedule: "leaf",
    settings: {
      fields: {
        external_write_interval_min: "leaf",
        sensor_stale_min: "leaf",
        hold_writes: "leaf",
        timezone: "leaf",
        language: "leaf",
      },
    },
    presets: PRESETS,
    schedules: {
      listOf: {
        fields: {
          id: "leaf",
          name: "leaf",
          week: { listOf: WEEK_BLOCK },
        },
      },
    },
    rooms: {
      mapOf: {
        fields: {
          schedule: "leaf",
          sensors: { listOf: { fields: { ref: "leaf", weight: "leaf" } } },
          presets: PRESETS,
        },
      },
      keys: (key) => AREA_ID.test(key),
    },
  },
};
const CONFIG_FILE: Shape = {
  fields: {
    version: "leaf",
    data: {
      fields: {
        revision: "leaf",
        releasing: { mapOf: "leaf", keys: (key) => VALVE_ID.test(key) },
        config: CONFIG_DOCUMENT,
        membership: {
          fields: {
            rooms: {
              mapOf: { fields: { name: "leaf", valves: { listOf: "leaf" } } },
              keys: (key) => AREA_ID.test(key),
            },
            ignored: { listOf: "leaf" },
          },
        },
        sensor_import: { listOf: "leaf" },
        ha_changes: {
          listOf: {
            fields: {
              revision: "leaf",
              at: "leaf",
              items: {
                listOf: {
                  fields: { kind: "leaf", area_id: "leaf", entity_id: "leaf", schedule_id: "leaf" },
                },
              },
            },
          },
        },
        upgrade: {
          fields: {
            from_version: "leaf",
            dropped_rooms: {
              listOf: {
                fields: {
                  room_id: "leaf",
                  name: "leaf",
                  valves: { listOf: "leaf" },
                  reason: "leaf",
                },
              },
            },
          },
        },
      },
    },
  },
};
const LEDGER_FILE: Shape = {
  fields: {
    version: "leaf",
    data: {
      fields: {
        records: { mapOf: { fields: RECORD_FIELDS }, keys: (key) => VALVE_ID.test(key) },
        released: {
          listOf: {
            fields: { valve_id: "leaf", ...RECORD_FIELDS, ended_at: "leaf", forgotten: "leaf" },
          },
        },
      },
    },
  },
};

/** Every place where the value has a key the shape does not name. */
function mismatches(value: unknown, shape: Shape, at: string): string[] {
  if (shape === "leaf" || typeof value !== "object" || value === null) return [];
  if ("listOf" in shape) {
    return Array.isArray(value)
      ? (value as unknown[]).flatMap((item, i) =>
          mismatches(item, shape.listOf, `${at}[${String(i)}]`),
        )
      : [`${at}: not a list`];
  }
  const entries = Object.entries(value);
  if ("mapOf" in shape) {
    return entries.flatMap(([key, item]) =>
      shape.keys(key) ? mismatches(item, shape.mapOf, `${at}.${key}`) : [`${at}: map key ${key}`],
    );
  }
  return entries.flatMap(([key, item]) => {
    const inner = shape.fields[key];
    return inner === undefined ? [`${at}: field ${key}`] : mismatches(item, inner, `${at}.${key}`);
  });
}

function checkStored(file: Record<string, unknown>): string[] {
  const data = file.data as Record<string, unknown> | undefined;
  return data !== undefined && Object.hasOwn(data, "records")
    ? mismatches(file, LEDGER_FILE, "ledger.json")
    : mismatches(file, CONFIG_FILE, "config.json");
}

// ---- Home Assistant entities ---------------------------------------------------------------------

describe("main (discovery)", () => {
  /** Starts with the valve in the area living and applies a config of that one room. */
  async function applied(holdWrites: boolean) {
    const fake = await startFakeZ2m();
    live.push(() => fake.stop());
    const ha = await startFakeHa();
    live.push(() => ha.stop());
    placeValve(ha);
    const dirs = { dataDir: temporaryFolder(), publicDir: temporaryFolder() };
    const options = liveOptions(await freePort(), fake, ha, dirs);
    const clock = createManualClock(T);
    fake.addDevice({ ieee: IEEE, name: "living/valve", modelId: "TRVZB" }, TRVZB_STATE);
    const first = await start(options, clock, false);
    const observed = (): boolean =>
      first.runtime.snapshot().devices.find((d) => d.deviceId === VALVE)?.observed === true;
    await vi.waitFor(() => {
      if (!observed()) fake.republish(IEEE);
      expect(observed()).toBe(true);
      expect(first.runtime.snapshot().house).toBe("live");
    }, WAIT);
    const config = houseConfig();
    config.settings = { hold_writes: holdWrites, timezone: "Europe/Amsterdam" };
    config.rooms = { living: {} };
    await first.runtime.apply(config, NO_CHANGE);
    return { fake, ha, options, clock, first };
  }

  /**
   * Stores a config of one room, stops, and starts again on the same folders. The tick after the
   * apply saved the membership, so the start freezes the rooms on it until the link has loaded.
   */
  async function restarted(holdWrites: boolean) {
    const { fake, options, clock, first } = await applied(holdWrites);
    await first.stop();
    const running = await start(options, clock, false);
    live.push(() => running.stop());
    return { fake, running };
  }

  describe("start (on the fake Zigbee2MQTT's broker)", () => {
    describe("With a stored config of one room", () => {
      it("the broker holds the retained config of the system device and of the room, under the prefix from the options", async () => {
        const { fake } = await restarted(false);
        await vi.waitFor(() => {
          expect(fake.retained(systemConfigTopic("ha_test"))).toBeDefined();
          expect(fake.retained(roomConfigTopic("ha_test", "living"))).toBeDefined();
        }, WAIT);
      });
    });

    describe("With a stored config of one room whose hold is off, and PRESS published on the press topic by another client", () => {
      it("the runtime's snapshot has held true", async () => {
        const { fake, running } = await restarted(false);
        expect(running.runtime.snapshot().held).toBe(false);
        fake.inject(PRESS_TOPIC, "PRESS");
        await vi.waitFor(() => {
          expect(running.runtime.snapshot().held).toBe(true);
        }, WAIT);
      });

      it("the stored config's revision is one higher", async () => {
        const { fake, running } = await restarted(false);
        const before = running.runtime.snapshot().revision;
        fake.inject(PRESS_TOPIC, "PRESS");
        await vi.waitFor(() => {
          expect(running.runtime.snapshot().revision).toBe(before + 1);
        }, WAIT);
      });
    });

    describe("With the Home Assistant link dropped mid-run", () => {
      it("the rooms stay as Home Assistant last reported them and the room's device stays published", async () => {
        const { fake, ha, first } = await applied(true);
        live.push(() => first.stop());
        await vi.waitFor(() => {
          expect(fake.retained(roomConfigTopic("ha_test", "living"))).toBeTruthy();
        }, WAIT);
        ha.refuseConnections(true);
        ha.dropConnections();
        await vi.waitFor(() => {
          expect(first.runtime.snapshot().houseFrozenReason).toBe("link_down");
        }, WAIT);
        const snapshot = first.runtime.snapshot();
        expect(snapshot.rooms.map((room) => [room.roomId, room.managed])).toEqual([
          ["living", true],
        ]);
        await first.discovery.sync(stateView(snapshot));
        expect(fake.retained(roomConfigTopic("ha_test", "living"))).toBeTruthy();
      });
    });

    describe("With a stored config of one room, right after start has resolved", () => {
      it("the broker holds the room's retained state message, without waiting for the next tick", async () => {
        const { fake } = await restarted(false);
        expect(fake.retained(roomStateTopic("living"))).toBeDefined();
      });
    });
  });

  describe("stop", () => {
    describe("Always", () => {
      it("the publisher publishes nothing afterwards", async () => {
        const { fake, running } = await restarted(false);
        const watcher = createMqttClient(
          { url: fake.url, username: undefined, password: undefined, clientId: "watcher" },
          systemClock,
        );
        await watcher.connect();
        live.push(() => watcher.end());
        const seen: string[] = [];
        const note = (topic: string, _payload: Buffer, retained: boolean): void => {
          // A retained message that the broker replays at subscription is not a new publish.
          if (!retained) seen.push(topic);
        };
        watcher.subscribe("heatmaster/system/+", note);
        watcher.subscribe("heatmaster/rooms/+/state", note);
        watcher.subscribe("ha_test/device/heatmaster/+/config", note);
        watcher.subscribe("sentinel", note);
        await running.stop();
        await running.discovery.sync(stateView(running.runtime.snapshot()));
        await watcher.publish("sentinel", "x", { qos: 1, retain: false });
        await vi.waitFor(() => {
          expect(seen).toContain("sentinel");
        }, WAIT);
        expect(seen.filter((topic) => topic !== "sentinel")).toEqual([]);
      });
    });
  });
});

describe("main (task 22)", () => {
  describe("process (node packages/server/src/main.ts)", () => {
    /** The process with an environment that holds exactly `env`, so nothing leaks in. */
    function runBare(env: Record<string, string>): {
      lines: string[];
      exited: Promise<number | null>;
    } {
      const child = spawn(process.execPath, [MAIN], {
        cwd: SERVER_DIR,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const lines: string[] = [];
      for (const stream of [child.stdout, child.stderr]) {
        readline.createInterface({ input: stream }).on("line", (line) => lines.push(line));
      }
      return { lines, exited: new Promise((resolve) => child.once("close", resolve)) };
    }

    describe("With MQTT_URL not set", () => {
      it("prints one line that names MQTT_URL and ends with exit code 78", async () => {
        const { lines, exited } = runBare({});
        expect(await exited).toBe(78);
        expect(lines.filter((line) => line.includes("MQTT_URL"))).toHaveLength(1);
      });
    });

    describe("With two faulty variables", () => {
      it("prints one line for each", async () => {
        const { lines, exited } = runBare({ MQTT_URL: "http://x", HEATMASTER_PORT: "0" });
        expect(await exited).toBe(78);
        expect(lines.filter((line) => line.includes("MQTT_URL"))).toHaveLength(1);
        expect(lines.filter((line) => line.includes("HEATMASTER_PORT"))).toHaveLength(1);
      });
    });

    describe("With a password and a token set", () => {
      it("the start-up log line holds *** in their places and neither value", async () => {
        const port = await freePort();
        const { child, lines, exited } = await runMain(port, {
          MQTT_USERNAME: "someone",
          MQTT_PASSWORD: "pw-very-secret",
          HA_TOKEN: "token-very-secret",
        });
        try {
          const line = await logLine(lines, "***", exited);
          expect(line).toContain("someone");
          await logLine(lines, `127.0.0.1:${String(port)}`, exited);
          expect(lines.join("\n")).not.toMatch(/pw-very-secret|token-very-secret/);
        } finally {
          child.kill("SIGTERM");
          await exited;
        }
      });
    });
  });

  describe("stop", () => {
    describe("Always", () => {
      it("the discovery publisher is stopped first, then the runtime, then the MQTT client, then the API", async () => {
        stopOrder.length = 0;
        const running = await start(optionsFor(await freePort()), systemClock, false);
        await running.stop();
        expect(stopOrder).toEqual(["discovery", "runtime", "mqtt", "api"]);
      });
    });
  });
});
