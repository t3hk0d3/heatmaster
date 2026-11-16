import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ChangeRefused, ConfigError, EMPTY_CONFIG } from "@heatmaster/core";
import type { ApiError, ChangePlan, EventMessage, PlanView, StateView } from "@heatmaster/core";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { parse } from "yaml";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startFakeZ2m, type FakeZ2m } from "../test/fake-z2m.ts";
import { createManualClock } from "../test/manual-clock.ts";
import {
  EVENTS_BUFFER_LIMIT,
  buildApi,
  startApi,
  toApiError,
  type ApiDeps,
  type ApiRuntime,
} from "./api.ts";
import { HeatmasterError } from "./errors.ts";
import { createMqttClient } from "./mqtt.ts";
import { API_HOST } from "./options.ts";
import { createRuntime, type DeviceSnapshot, type Snapshot } from "./runtime.ts";
import { createConfigStore, createLedgerStore, createPacingStore } from "./stores.ts";
import { stateView } from "./views.ts";
import { buildTransports } from "./z2m.ts";

// ---- stubs ---------------------------------------------------------------------------------------

const VALVE = "z2m:0x00124b0012345678";

function snapshotOf(over: Partial<Snapshot> = {}): Snapshot {
  return {
    revision: 2,
    configState: "ok",
    ledgerReadable: true,
    originalsCopyRecords: 0,
    held: false,
    language: "en",
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

function planOf(revision = 3): ChangePlan {
  return {
    stored: {
      config: { ...EMPTY_CONFIG, settings: { ...EMPTY_CONFIG.settings, holdWrites: true } },
      revision,
      releasing: new Map(),
    },
    ledger: undefined,
    effects: [],
    joining: [],
    rejoining: [],
    leaving: [],
    writes: [],
  };
}

const DOCUMENT = { version: 2, settings: { timezone: "Europe/Amsterdam" }, rooms: [] };

type Stub = Readonly<{
  runtime: ApiRuntime;
  calls: () => string[];
  snapshot: ReturnType<typeof vi.fn<ApiRuntime["snapshot"]>>;
  subscribe: ReturnType<typeof vi.fn<ApiRuntime["subscribe"]>>;
  unsubscribe: ReturnType<typeof vi.fn<() => void>>;
  listeners: ((snapshot: Snapshot) => void)[];
  apply: ReturnType<typeof vi.fn<ApiRuntime["apply"]>>;
  preview: ReturnType<typeof vi.fn<ApiRuntime["preview"]>>;
  exportConfig: ReturnType<typeof vi.fn<ApiRuntime["exportConfig"]>>;
  resync: ReturnType<typeof vi.fn<ApiRuntime["resync"]>>;
  refreshValve: ReturnType<typeof vi.fn<ApiRuntime["refreshValve"]>>;
  restoreValve: ReturnType<typeof vi.fn<ApiRuntime["restoreValve"]>>;
  forgetValve: ReturnType<typeof vi.fn<ApiRuntime["forgetValve"]>>;
  importOriginals: ReturnType<typeof vi.fn<ApiRuntime["importOriginals"]>>;
  setHold: ReturnType<typeof vi.fn<ApiRuntime["setHold"]>>;
  diagnostics: ReturnType<typeof vi.fn<ApiRuntime["diagnostics"]>>;
}>;

function stub(): Stub {
  const listeners: ((snapshot: Snapshot) => void)[] = [];
  const unsubscribe = vi.fn<() => void>();
  const snapshot = vi.fn<ApiRuntime["snapshot"]>(() => snapshotOf());
  const subscribe = vi.fn<ApiRuntime["subscribe"]>((listener) => {
    listeners.push(listener);
    return unsubscribe;
  });
  const apply = vi.fn<ApiRuntime["apply"]>(() => Promise.resolve(planOf()));
  const preview = vi.fn<ApiRuntime["preview"]>(() => Promise.resolve(planOf()));
  const exportConfig = vi.fn<ApiRuntime["exportConfig"]>(() => ({
    revision: 2,
    config: DOCUMENT,
  }));
  const resync = vi.fn<ApiRuntime["resync"]>(() => Promise.resolve());
  const refreshValve = vi.fn<ApiRuntime["refreshValve"]>(() => Promise.resolve());
  const restoreValve = vi.fn<ApiRuntime["restoreValve"]>(() => Promise.resolve());
  const forgetValve = vi.fn<ApiRuntime["forgetValve"]>(() => Promise.resolve());
  const importOriginals = vi.fn<ApiRuntime["importOriginals"]>(() => Promise.resolve());
  const setHold = vi.fn<ApiRuntime["setHold"]>(() => Promise.resolve());
  const diagnostics = vi.fn<ApiRuntime["diagnostics"]>(() => ({ devices: { a: 1 } }));
  const all = {
    snapshot,
    subscribe,
    apply,
    preview,
    exportConfig,
    resync,
    refreshValve,
    restoreValve,
    forgetValve,
    importOriginals,
    setHold,
    diagnostics,
  };
  return {
    runtime: all,
    calls: () =>
      Object.entries(all)
        .filter(([, mock]) => mock.mock.calls.length > 0)
        .map(([name]) => name),
    unsubscribe,
    listeners,
    ...all,
  };
}

const apps: FastifyInstance[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const app of apps.splice(0)) await app.close();
});

type Rig = Readonly<{
  app: FastifyInstance;
  stub: Stub;
  deps: { ready: boolean; fault: string | undefined };
}>;

async function rig(
  over: { ready?: boolean; fault?: string | undefined; stub?: Stub } = {},
): Promise<Rig> {
  const stubbed = over.stub ?? stub();
  const state = { ready: over.ready ?? true, fault: over.fault };
  const deps: ApiDeps = {
    runtime: stubbed.runtime,
    ready: () => state.ready,
    mqttFault: () => state.fault,
    version: "9.9.9",
  };
  const app = buildApi(deps);
  apps.push(app);
  await app.ready();
  return { app, stub: stubbed, deps: state };
}

async function post(app: FastifyInstance, url: string, body: unknown, headers = {}) {
  const response = await app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", ...headers },
    payload: typeof body === "string" ? body : JSON.stringify(body),
  });
  return response;
}

function errorOf(response: { json(): unknown }): ApiError {
  return response.json() as ApiError;
}

function rawText(data: unknown): string {
  return Buffer.isBuffer(data) ? data.toString("utf8") : "";
}

interface Seen {
  socket: WebSocket;
  messages: EventMessage[];
  closed: () => number | undefined;
}

/** Connects a socket. The listeners are attached at creation, so the first message is not missed. */
async function connect(app: FastifyInstance): Promise<Seen> {
  const messages: EventMessage[] = [];
  let code: number | undefined;
  const socket = await app.injectWS("/api/events", undefined, {
    onInit(ws) {
      ws.on("message", (data) => {
        messages.push(JSON.parse(rawText(data)) as EventMessage);
      });
      ws.on("close", (closeCode) => {
        code = closeCode;
      });
    },
  });
  sockets.push(socket);
  return { socket, messages, closed: () => code };
}

// ---- the tests -----------------------------------------------------------------------------------

describe("api", () => {
  describe("startApi", () => {
    describe("Always", () => {
      it("the server's address is 127.0.0.1, family IPv4", async () => {
        const { app } = await rig();
        await startApi(app, 0);
        expect(app.server.address()).toMatchObject({ address: "127.0.0.1", family: "IPv4" });
      });

      it("the returned port is the one it listens on", async () => {
        const { app } = await rig();
        const port = await startApi(app, 0);
        expect(port).toBeGreaterThan(0);
        expect((app.server.address() as net.AddressInfo).port).toBe(port);
        const response = await fetch(`http://127.0.0.1:${String(port)}/api/state`);
        expect(response.status).toBe(200);
      });

      const other = Object.values(os.networkInterfaces())
        .flat()
        .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
      it.skipIf(other === undefined)(
        "a connection to another address of this machine on that port is refused",
        async () => {
          const { app } = await rig();
          const port = await startApi(app, 0);
          const connected = await new Promise<boolean>((resolve) => {
            const socket = net.connect({ port, host: other });
            socket.once("connect", () => {
              socket.destroy();
              resolve(true);
            });
            socket.once("error", () => {
              resolve(false);
            });
          });
          expect(connected).toBe(false);
        },
      );
    });

    describe("With a port that is already in use", () => {
      it("the promise rejects and nothing is left listening", async () => {
        const taken = net.createServer();
        await new Promise<void>((resolve) => taken.listen(0, API_HOST, resolve));
        const { port } = taken.address() as net.AddressInfo;
        try {
          const { app } = await rig();
          await expect(startApi(app, port)).rejects.toThrow();
          expect(app.server.listening).toBe(false);
        } finally {
          await new Promise<void>((resolve) =>
            taken.close(() => {
              resolve();
            }),
          );
        }
      });
    });
  });

  describe("every route", () => {
    describe("While deps.ready() is false", () => {
      it("GET /api/state, POST /api/config and the socket upgrade answer 503 with code not_ready", async () => {
        const { app } = await rig({ ready: false });
        const state = await app.inject({ method: "GET", url: "/api/state" });
        const config = await post(app, "/api/config", { config: DOCUMENT });
        const upgrade = await app.inject({
          method: "GET",
          url: "/api/events",
          headers: { connection: "upgrade", upgrade: "websocket" },
        });
        for (const response of [state, config, upgrade]) {
          expect(response.statusCode).toBe(503);
          expect(errorOf(response)).toMatchObject({ code: "not_ready", data: {} });
        }
      });

      it("a real socket upgrade is refused with 503", async () => {
        const { app } = await rig({ ready: false });
        await expect(app.injectWS("/api/events")).rejects.toThrow(/503/);
      });

      it("no runtime method is called", async () => {
        const { app, stub: runtime } = await rig({ ready: false });
        await app.inject({ method: "GET", url: "/api/state" });
        await post(app, "/api/config", { config: DOCUMENT });
        await app.inject({ method: "GET", url: "/api/health" });
        expect(runtime.calls()).toEqual([]);
      });
    });

    describe("Always", () => {
      it("the answer carries Cache-Control: no-store", async () => {
        const { app } = await rig();
        const answers = [
          await app.inject({ method: "GET", url: "/api/state" }),
          await app.inject({ method: "GET", url: "/api/nothing" }),
          await post(app, "/api/hold", { on: "yes" }),
          await post(app, "/api/hold", { on: true }),
        ];
        for (const answer of answers) expect(answer.headers["cache-control"]).toBe("no-store");
      });
    });

    describe("With a path that has no route", () => {
      it("answers 404 with code not_found", async () => {
        const { app } = await rig();
        const response = await app.inject({ method: "GET", url: "/api/nothing" });
        expect(response.statusCode).toBe(404);
        expect(errorOf(response)).toMatchObject({ code: "not_found", data: {} });
      });
    });

    describe("With a POST whose content type is text/plain", () => {
      it("answers 400 with code body_invalid and calls no runtime method", async () => {
        const { app, stub: runtime } = await rig();
        const response = await post(app, "/api/hold", '{"on":true}', {
          "content-type": "text/plain",
        });
        expect(response.statusCode).toBe(400);
        expect(errorOf(response).code).toBe("body_invalid");
        expect(runtime.calls()).toEqual([]);
      });
    });

    describe("With a POST body that is not JSON", () => {
      it("answers 400 with code body_invalid", async () => {
        const { app } = await rig();
        const response = await post(app, "/api/hold", "{not json");
        expect(response.statusCode).toBe(400);
        expect(errorOf(response).code).toBe("body_invalid");
      });
    });

    describe("With a POST body holding an unknown field or a field of the wrong type", () => {
      it("answers 400 with code body_invalid and data.issues names the field", async () => {
        const { app, stub: runtime } = await rig();
        const unknown = await post(app, "/api/hold", { on: true, extra: 1 });
        const wrong = await post(app, "/api/hold", { on: "yes" });
        expect(unknown.statusCode).toBe(400);
        expect(errorOf(unknown).code).toBe("body_invalid");
        expect(errorOf(unknown).data.issues).toContainEqual(
          expect.objectContaining({ path: "extra" }),
        );
        expect(errorOf(wrong).data.issues).toContainEqual(expect.objectContaining({ path: "on" }));
        expect(runtime.calls()).toEqual([]);
      });
    });

    describe("With a runtime method that throws an error without a code", () => {
      it("answers 500 with code internal", async () => {
        const { app, stub: runtime } = await rig();
        runtime.setHold.mockRejectedValue(new Error("disk /secret/path exploded"));
        const response = await post(app, "/api/hold", { on: true });
        expect(response.statusCode).toBe(500);
        expect(errorOf(response)).toMatchObject({ code: "internal", data: {} });
      });

      it("the body holds neither the error's text nor a stack", async () => {
        const { app, stub: runtime } = await rig();
        runtime.setHold.mockRejectedValue(new Error("disk /secret/path exploded"));
        const response = await post(app, "/api/hold", { on: true });
        expect(response.body).not.toContain("secret");
        expect(response.body).not.toContain("exploded");
        expect(response.body).not.toContain(" at ");
      });
    });

    describe('With a runtime method that throws a Node error with code "ENOENT"', () => {
      it("answers 500 with code internal", async () => {
        const { app, stub: runtime } = await rig();
        runtime.setHold.mockRejectedValue(
          Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }),
        );
        const response = await post(app, "/api/hold", { on: true });
        expect(response.statusCode).toBe(500);
        expect(errorOf(response).code).toBe("internal");
      });
    });

    describe("With a body over Fastify's 1 MiB limit", () => {
      it("answers 413 with code body_too_large", async () => {
        const { app } = await rig();
        const response = await post(app, "/api/config", { yaml: "x".repeat(1024 * 1024 + 1) });
        expect(response.statusCode).toBe(413);
        expect(errorOf(response).code).toBe("body_too_large");
      });
    });

    describe("With a path whose percent-encoding is bad", () => {
      it("answers 400 with code body_invalid and no-store, and calls no runtime method", async () => {
        const { app, stub: runtime } = await rig();
        const response = await post(app, "/api/valves/%E0/refresh", {});
        expect(response.statusCode).toBe(400);
        expect(errorOf(response).code).toBe("body_invalid");
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(runtime.calls()).toEqual([]);
      });
    });

    describe("With a path parameter over 200 characters", () => {
      it("answers 404 with code not_found and no-store, and calls no runtime method", async () => {
        const { app, stub: runtime } = await rig();
        const response = await post(app, `/api/valves/${"a".repeat(250)}/refresh`, {});
        expect(response.statusCode).toBe(404);
        expect(errorOf(response)).toMatchObject({ code: "not_found", data: {} });
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(runtime.calls()).toEqual([]);
      });
    });

    describe("With an empty valve id", () => {
      it("answers 400 with code body_invalid and calls no runtime method", async () => {
        const { app, stub: runtime } = await rig();
        const response = await post(app, "/api/valves//refresh", {});
        expect(response.statusCode).toBe(400);
        expect(errorOf(response).code).toBe("body_invalid");
        expect(runtime.calls()).toEqual([]);
      });
    });

    describe("With a POST that has no body at all", () => {
      it("answers 400 with code body_invalid", async () => {
        const { app, stub: runtime } = await rig();
        const response = await app.inject({ method: "POST", url: "/api/hold" });
        expect(response.statusCode).toBe(400);
        expect(errorOf(response).code).toBe("body_invalid");
        expect(runtime.calls()).toEqual([]);
      });
    });
  });

  describe("GET /api/health", () => {
    describe("While ready", () => {
      it("answers 200 with status ok and the version", async () => {
        const { app } = await rig();
        const response = await app.inject({ method: "GET", url: "/api/health" });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ status: "ok", version: "9.9.9" });
      });
    });

    describe("While not ready", () => {
      it("answers 503 with code not_ready", async () => {
        const { app } = await rig({ ready: false });
        const response = await app.inject({ method: "GET", url: "/api/health" });
        expect(response.statusCode).toBe(503);
        expect(errorOf(response).code).toBe("not_ready");
      });
    });

    describe('While ready and mqttFault returns "another_instance"', () => {
      it('answers 503 with code mqtt_fault and data.reason "another_instance"', async () => {
        const { app } = await rig({ fault: "another_instance" });
        const response = await app.inject({ method: "GET", url: "/api/health" });
        expect(response.statusCode).toBe(503);
        expect(errorOf(response)).toMatchObject({
          code: "mqtt_fault",
          data: { reason: "another_instance" },
        });
      });

      it("GET /api/state still answers 200", async () => {
        const { app } = await rig({ fault: "another_instance" });
        expect((await app.inject({ method: "GET", url: "/api/state" })).statusCode).toBe(200);
      });
    });

    describe("While ready and mqttFault returns undefined", () => {
      it("answers 200", async () => {
        const { app } = await rig({ fault: undefined });
        expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
      });
    });
  });

  describe("GET /api/state", () => {
    describe("Always", () => {
      it("answers stateView of the runtime's snapshot", async () => {
        const { app, stub: runtime } = await rig();
        const snapshot = snapshotOf({
          devices: [
            {
              deviceId: VALVE,
              transport: "z2m",
              name: "hall",
              modelId: "TRVZB",
              manufacturer: undefined,
              firmware: undefined,
              supported: true,
              membership: undefined,
              liveness: "unknown",
              observed: false,
              heardAt: undefined,
            } satisfies DeviceSnapshot,
          ],
        });
        runtime.snapshot.mockReturnValue(snapshot);
        const response = await app.inject({ method: "GET", url: "/api/state" });
        expect(response.json<StateView>()).toEqual(JSON.parse(JSON.stringify(stateView(snapshot))));
      });
    });
  });

  describe("GET /api/config", () => {
    describe("With a stored config", () => {
      const config = {
        version: 2,
        settings: { timezone: "Europe/Amsterdam", hold_writes: false },
        rooms: [{ id: "living", name: "Living", valves: [{ id: VALVE }] }],
      };

      it("answers the revision, the document and its YAML text", async () => {
        const { app, stub: runtime } = await rig();
        runtime.exportConfig.mockReturnValue({ revision: 5, config });
        const body = (await app.inject({ method: "GET", url: "/api/config" })).json<{
          revision: number;
          config: unknown;
          yaml: string;
        }>();
        expect(body.revision).toBe(5);
        expect(body.config).toEqual(config);
        expect(typeof body.yaml).toBe("string");
      });

      it("parsing the YAML text gives the document", async () => {
        const { app, stub: runtime } = await rig();
        runtime.exportConfig.mockReturnValue({ revision: 5, config });
        const body = (await app.inject({ method: "GET", url: "/api/config" })).json<{
          yaml: string;
        }>();
        expect(parse(body.yaml, { version: "1.2", schema: "core" })).toEqual(config);
      });

      it("no key named releasing appears anywhere in the answer", async () => {
        const { app, stub: runtime } = await rig();
        // A runtime that leaked its stored shape would carry `releasing` next to the document.
        runtime.exportConfig.mockReturnValue({ revision: 5, config, releasing: {} } as never);
        const response = await app.inject({ method: "GET", url: "/api/config" });
        expect(response.body).not.toContain("releasing");
      });
    });

    describe("With set point times in the document", () => {
      it('the times read back from the YAML text are still text such as "06:30"', async () => {
        const { app, stub: runtime } = await rig();
        const config = {
          schedules: [{ week: [{ days: ["mon"], temperature: { "06:30": 20 } }] }],
        };
        runtime.exportConfig.mockReturnValue({ revision: 1, config });
        const body = (await app.inject({ method: "GET", url: "/api/config" })).json<{
          yaml: string;
        }>();
        const back = parse(body.yaml, { version: "1.2", schema: "core" }) as typeof config;
        expect(Object.keys(back.schedules[0]?.week[0]?.temperature ?? {})).toEqual(["06:30"]);
      });
    });

    describe("With a 21:00 set point and a room named off", () => {
      const config = {
        rooms: [{ id: "off", name: "off" }],
        schedules: [{ week: [{ days: ["mon"], temperature: { "21:00": 20 } }] }],
      };

      it("the YAML text quotes both, and reads back equal under YAML 1.1 and 1.2 core", async () => {
        const { app, stub: runtime } = await rig();
        runtime.exportConfig.mockReturnValue({ revision: 1, config });
        const body = (await app.inject({ method: "GET", url: "/api/config" })).json<{
          yaml: string;
        }>();
        expect(body.yaml).toContain('"21:00"');
        expect(body.yaml).toContain('"off"');
        expect(parse(body.yaml, { version: "1.1" })).toEqual(config);
        expect(parse(body.yaml, { version: "1.2", schema: "core" })).toEqual(config);
      });
    });

    describe("With exportConfig refusing with config_unreadable", () => {
      it("answers 409 with code config_unreadable", async () => {
        const { app, stub: runtime } = await rig();
        runtime.exportConfig.mockImplementation(() => {
          throw new HeatmasterError("config_unreadable");
        });
        const response = await app.inject({ method: "GET", url: "/api/config" });
        expect(response.statusCode).toBe(409);
        expect(errorOf(response).code).toBe("config_unreadable");
      });
    });
  });

  describe("POST /api/config/preview", () => {
    describe("With a valid document under config", () => {
      it("preview is called once with that document, and apply is not called", async () => {
        const { app, stub: runtime } = await rig();
        await post(app, "/api/config/preview", { config: DOCUMENT });
        expect(runtime.preview).toHaveBeenCalledTimes(1);
        expect(runtime.preview.mock.calls[0]?.[0]).toEqual(DOCUMENT);
        expect(runtime.apply).not.toHaveBeenCalled();
      });

      it("answers planView with applied false", async () => {
        const { app } = await rig();
        const response = await post(app, "/api/config/preview", { config: DOCUMENT });
        expect(response.statusCode).toBe(200);
        expect(response.json<PlanView>()).toMatchObject({
          applied: false,
          revision: 3,
          held: true,
        });
      });
    });

    describe("With the same document as YAML text", () => {
      it("preview receives an equal document", async () => {
        const { app, stub: runtime } = await rig();
        const yaml = "version: 2\nsettings:\n  timezone: Europe/Amsterdam\nrooms: []\n";
        await post(app, "/api/config/preview", { yaml });
        expect(runtime.preview.mock.calls[0]?.[0]).toEqual(DOCUMENT);
      });
    });

    describe("With YAML holding 06:30 and off without quotes", () => {
      it('preview receives the texts "06:30" and "off"', async () => {
        const { app, stub: runtime } = await rig();
        await post(app, "/api/config/preview", { yaml: "time: 06:30\nmode: off\nflag: on\n" });
        expect(runtime.preview.mock.calls[0]?.[0]).toEqual({
          time: "06:30",
          mode: "off",
          flag: "on",
        });
      });
    });
  });

  describe("POST /api/config/preview with unquoted times", () => {
    describe("With YAML text holding an unquoted 07:00 key", () => {
      it('preview receives the set point at "07:00"', async () => {
        const { app, stub: runtime } = await rig();
        const yaml = [
          "schedules:",
          "  - week:",
          "      - days: [mon]",
          "        temperature:",
          "          00:00: 17",
          "          07:00: 21",
          "",
        ].join("\n");
        const response = await post(app, "/api/config/preview", { yaml });
        expect(response.statusCode).toBe(200);
        expect(runtime.preview.mock.calls[0]?.[0]).toEqual({
          schedules: [{ week: [{ days: ["mon"], temperature: { "00:00": 17, "07:00": 21 } }] }],
        });
      });
    });
  });

  describe("POST /api/config/preview with a repeated key", () => {
    const yamlWith = (first: string, second: string): string =>
      [
        "schedules:",
        "  - week:",
        "      - days: [mon]",
        "        temperature:",
        '          "00:00": 17',
        `          ${first}: 21`,
        `          ${second}: 22`,
        "",
      ].join("\n");

    describe.each([
      ["a quoted time", '"07:00"', '"07:00"', "07:00"],
      ["an unquoted time", "07:00", "07:00", "07:00"],
      ["a key with a space", "foo bar", "foo bar", "foo bar"],
      ["a double-quoted key with an escaped quote", '"a\\"b"', '"a\\"b"', 'a"b'],
      ["a single-quoted key with a doubled quote", "'it''s'", "'it''s'", "it's"],
    ])("With %s twice in one block", (_name, first, second, key) => {
      it("answers 400 yaml_invalid naming that key and does not preview", async () => {
        const { app, stub: runtime } = await rig();
        const response = await post(app, "/api/config/preview", { yaml: yamlWith(first, second) });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({
          code: "yaml_invalid",
          message: `the YAML text repeats the key ${JSON.stringify(key)}`,
          data: { key },
        });
        expect(runtime.preview).not.toHaveBeenCalled();
      });
    });
  });

  describe("POST /api/config", () => {
    describe("With a valid document", () => {
      it("apply is called once with that document, and preview is not called", async () => {
        const { app, stub: runtime } = await rig();
        await post(app, "/api/config", { config: DOCUMENT });
        expect(runtime.apply).toHaveBeenCalledTimes(1);
        expect(runtime.apply.mock.calls[0]?.[0]).toEqual(DOCUMENT);
        expect(runtime.preview).not.toHaveBeenCalled();
      });

      it("answers planView with applied true and the new revision", async () => {
        const { app, stub: runtime } = await rig();
        runtime.apply.mockResolvedValue(planOf(7));
        const response = await post(app, "/api/config", { config: DOCUMENT });
        expect(response.statusCode).toBe(200);
        expect(response.json<PlanView>()).toMatchObject({ applied: true, revision: 7 });
      });
    });

    describe("With no option fields", () => {
      it("apply receives expectedRevision undefined, an empty accept list and overwriteUnreadable false", async () => {
        const { app, stub: runtime } = await rig();
        await post(app, "/api/config", { config: DOCUMENT });
        expect(runtime.apply.mock.calls[0]?.[1]).toEqual({
          expectedRevision: undefined,
          acceptUnknownOriginals: [],
          overwriteUnreadable: false,
        });
      });
    });

    describe("With expectedRevision 4, acceptUnknownOriginals of two ids and overwriteUnreadable true", () => {
      it("apply receives 4, a list of the two ids, and true", async () => {
        const { app, stub: runtime } = await rig();
        await post(app, "/api/config", {
          config: DOCUMENT,
          expectedRevision: 4,
          acceptUnknownOriginals: ["z2m:0xa1", "z2m:0xb2"],
          overwriteUnreadable: true,
        });
        expect(runtime.apply.mock.calls[0]?.[1]).toEqual({
          expectedRevision: 4,
          acceptUnknownOriginals: ["z2m:0xa1", "z2m:0xb2"],
          overwriteUnreadable: true,
        });
      });
    });

    describe("With both config and yaml, or with neither", () => {
      it("answers 400 with code config_or_yaml and apply is not called", async () => {
        const { app, stub: runtime } = await rig();
        const both = await post(app, "/api/config", { config: DOCUMENT, yaml: "a: 1" });
        const neither = await post(app, "/api/config", {});
        for (const response of [both, neither]) {
          expect(response.statusCode).toBe(400);
          expect(errorOf(response)).toMatchObject({ code: "config_or_yaml", data: {} });
        }
        expect(runtime.apply).not.toHaveBeenCalled();
      });
    });

    describe("With YAML that does not parse", () => {
      it("answers 400 with code yaml_invalid and the line, and apply is not called", async () => {
        const { app, stub: runtime } = await rig();
        const response = await post(app, "/api/config", { yaml: "a: 1\nb: [1, 2\nc: 3\n" });
        expect(response.statusCode).toBe(400);
        const error = errorOf(response);
        expect(error.code).toBe("yaml_invalid");
        expect(error.data.line).toEqual(expect.any(Number));
        expect(runtime.apply).not.toHaveBeenCalled();
      });
    });

    describe("With YAML whose top level is a list or a number", () => {
      it("answers 400 with code yaml_invalid", async () => {
        const { app } = await rig();
        for (const yaml of ["- a\n- b\n", "42\n", ""]) {
          const response = await post(app, "/api/config", { yaml });
          expect(response.statusCode, yaml).toBe(400);
          expect(errorOf(response).code, yaml).toBe("yaml_invalid");
        }
      });
    });

    describe("With apply throwing ConfigError with three issues", () => {
      const issues = [
        { path: "rooms.0.name", code: "required", message: "a" },
        { path: "rooms.1.id", code: "duplicate", message: "b" },
        { path: "settings", code: "unknown_key", message: "c" },
      ];

      it("answers 400 with code config_invalid", async () => {
        const { app, stub: runtime } = await rig();
        runtime.apply.mockRejectedValue(new ConfigError(issues));
        const response = await post(app, "/api/config", { config: DOCUMENT });
        expect(response.statusCode).toBe(400);
        expect(errorOf(response).code).toBe("config_invalid");
      });

      it("data.issues holds all three, each with path, code and message", async () => {
        const { app, stub: runtime } = await rig();
        runtime.apply.mockRejectedValue(new ConfigError(issues));
        const response = await post(app, "/api/config", { config: DOCUMENT });
        expect(errorOf(response).data.issues).toEqual(issues);
      });
    });

    describe('With apply throwing ChangeRefused("revision_conflict")', () => {
      it("answers 409 with code revision_conflict and the refusal's data", async () => {
        const { app, stub: runtime } = await rig();
        runtime.apply.mockRejectedValue(
          new ChangeRefused("revision_conflict", { expected: "1", actual: "2" }),
        );
        const response = await post(app, "/api/config", { config: DOCUMENT });
        expect(response.statusCode).toBe(409);
        expect(errorOf(response)).toMatchObject({
          code: "revision_conflict",
          data: { expected: "1", actual: "2" },
        });
      });
    });

    describe('With apply throwing ChangeRefused("originals_unreadable") naming a valve', () => {
      it("answers 409 with that code and data.valveId", async () => {
        const { app, stub: runtime } = await rig();
        runtime.apply.mockRejectedValue(
          new ChangeRefused("originals_unreadable", { valveId: VALVE }),
        );
        const response = await post(app, "/api/config", { config: DOCUMENT });
        expect(response.statusCode).toBe(409);
        expect(errorOf(response)).toMatchObject({
          code: "originals_unreadable",
          data: { valveId: VALVE },
        });
      });
    });

    describe("With apply throwing the Task 11b refusals", () => {
      it("a sensor_ref_invalid and a key_unknown issue pass through unchanged", async () => {
        const { app, stub: runtime } = await rig();
        const issues = [
          {
            path: "rooms.0.sensors.0.ref",
            code: "sensor_ref_invalid",
            message: "z2m: refs are gone",
          },
          { path: "rooms.0.sensors.0.key", code: "key_unknown", message: "no key" },
        ];
        runtime.apply.mockRejectedValue(new ConfigError(issues));
        const response = await post(app, "/api/config", { config: DOCUMENT });
        expect(errorOf(response).data.issues).toEqual(issues);
      });
    });
  });

  describe("POST /api/hold", () => {
    describe("With { on: true }", () => {
      it("setHold(true) is called once and the answer is 204", async () => {
        const { app, stub: runtime } = await rig();
        const response = await post(app, "/api/hold", { on: true });
        expect(response.statusCode).toBe(204);
        expect(runtime.setHold.mock.calls).toEqual([[true]]);
      });
    });

    describe("With { on: false }", () => {
      it("setHold(false) is called once", async () => {
        const { app, stub: runtime } = await rig();
        await post(app, "/api/hold", { on: false });
        expect(runtime.setHold.mock.calls).toEqual([[false]]);
      });
    });

    describe('With {} or { on: "yes" }', () => {
      it("answers 400 with code body_invalid and setHold is not called", async () => {
        const { app, stub: runtime } = await rig();
        for (const body of [{}, { on: "yes" }]) {
          const response = await post(app, "/api/hold", body);
          expect(response.statusCode).toBe(400);
          expect(errorOf(response).code).toBe("body_invalid");
        }
        expect(runtime.setHold).not.toHaveBeenCalled();
      });
    });
  });

  describe("POST /api/resync", () => {
    describe("With {}", () => {
      it("resync(undefined) is called and the answer is 204", async () => {
        const { app, stub: runtime } = await rig();
        const response = await post(app, "/api/resync", {});
        expect(response.statusCode).toBe(204);
        expect(runtime.resync.mock.calls).toEqual([[undefined]]);
      });
    });

    describe('With { roomId: "living_room" }', () => {
      it('resync("living_room") is called', async () => {
        const { app, stub: runtime } = await rig();
        await post(app, "/api/resync", { roomId: "living_room" });
        expect(runtime.resync.mock.calls).toEqual([["living_room"]]);
      });
    });

    describe("With the runtime refusing with code room_unknown", () => {
      it("answers 409 with code room_unknown", async () => {
        const { app, stub: runtime } = await rig();
        runtime.resync.mockRejectedValue(new HeatmasterError("room_unknown", { roomId: "x" }));
        const response = await post(app, "/api/resync", { roomId: "x" });
        expect(response.statusCode).toBe(409);
        expect(errorOf(response)).toMatchObject({ code: "room_unknown", data: { roomId: "x" } });
      });
    });
  });

  describe("POST /api/valves/:id/refresh, /restore, /forget", () => {
    const actions = [
      ["refresh", "refreshValve"],
      ["restore", "restoreValve"],
      ["forget", "forgetValve"],
    ] as const;

    describe("With the id z2m:0x00124b0012345678, the colon written as it is or as %3A", () => {
      for (const [action, method] of actions) {
        for (const written of [VALVE, VALVE.replace(":", "%3A")]) {
          it(`${action}: ${method} is called once with the id, and the answer is 204 (${written})`, async () => {
            const { app, stub: runtime } = await rig();
            const response = await post(app, `/api/valves/${written}/${action}`, {});
            expect(response.statusCode).toBe(204);
            expect(runtime[method].mock.calls).toEqual([[VALVE]]);
          });
        }
      }
    });

    describe("With the runtime refusing with valve_not_orphan", () => {
      it("answers 409 with code valve_not_orphan", async () => {
        const { app, stub: runtime } = await rig();
        runtime.forgetValve.mockRejectedValue(
          new ChangeRefused("valve_not_orphan", { valveId: VALVE }),
        );
        const response = await post(app, `/api/valves/${VALVE}/forget`, {});
        expect(response.statusCode).toBe(409);
        expect(errorOf(response).code).toBe("valve_not_orphan");
      });
    });

    describe("With a body other than an object", () => {
      it("answers 400 with code body_invalid", async () => {
        const { app, stub: runtime } = await rig();
        for (const [action] of actions) {
          for (const body of ["[]", "7", '{"x":1}']) {
            const response = await post(app, `/api/valves/${VALVE}/${action}`, body);
            expect(response.statusCode, `${action} ${body}`).toBe(400);
            expect(errorOf(response).code).toBe("body_invalid");
          }
        }
        expect(runtime.calls()).toEqual([]);
      });
    });
  });

  describe("POST /api/originals/import", () => {
    describe("With {}", () => {
      it("importOriginals(false) is called", async () => {
        const { app, stub: runtime } = await rig();
        const response = await post(app, "/api/originals/import", {});
        expect(response.statusCode).toBe(204);
        expect(runtime.importOriginals.mock.calls).toEqual([[false]]);
      });
    });

    describe("With { acceptEmpty: true }", () => {
      it("importOriginals(true) is called", async () => {
        const { app, stub: runtime } = await rig();
        await post(app, "/api/originals/import", { acceptEmpty: true });
        expect(runtime.importOriginals.mock.calls).toEqual([[true]]);
      });
    });

    describe("With the runtime refusing with code no_originals_copy", () => {
      it("answers 409 with code no_originals_copy", async () => {
        const { app, stub: runtime } = await rig();
        runtime.importOriginals.mockRejectedValue(new HeatmasterError("no_originals_copy"));
        const response = await post(app, "/api/originals/import", {});
        expect(response.statusCode).toBe(409);
        expect(errorOf(response).code).toBe("no_originals_copy");
      });
    });
  });

  describe("GET /api/diagnostics", () => {
    describe("Always", () => {
      it("answers what diagnostics() returns, as JSON", async () => {
        const { app, stub: runtime } = await rig();
        runtime.diagnostics.mockReturnValue({ links: { z2m: true }, n: 3 });
        const response = await app.inject({ method: "GET", url: "/api/diagnostics" });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ links: { z2m: true }, n: 3 });
      });
    });
  });

  describe("GET /api/events", () => {
    describe("On connect", () => {
      it("the first message is { type: state, state } with stateView of the snapshot", async () => {
        const { app, stub: runtime } = await rig();
        const snapshot = snapshotOf({ revision: 11 });
        runtime.snapshot.mockReturnValue(snapshot);
        const seen = await connect(app);
        await vi.waitFor(() => {
          expect(seen.messages).toHaveLength(1);
        });
        expect(seen.messages[0]).toEqual({
          type: "state",
          state: JSON.parse(JSON.stringify(stateView(snapshot))) as StateView,
        });
      });
    });

    describe("When the runtime's listener is called", () => {
      it("every open socket receives one state message", async () => {
        const { app, stub: runtime } = await rig();
        const first = await connect(app);
        const second = await connect(app);
        await vi.waitFor(() => {
          expect(first.messages).toHaveLength(1);
          expect(second.messages).toHaveLength(1);
        });
        runtime.listeners[0]?.(snapshotOf({ revision: 12 }));
        await vi.waitFor(() => {
          expect(first.messages).toHaveLength(2);
          expect(second.messages).toHaveLength(2);
        });
        expect(first.messages[1]?.state.revision).toBe(12);
        expect(second.messages[1]?.state.revision).toBe(12);
      });

      it("the state is built once, not once per socket", async () => {
        const { app, stub: runtime } = await rig();
        const first = await connect(app);
        const second = await connect(app);
        await vi.waitFor(() => {
          expect(first.messages).toHaveLength(1);
          expect(second.messages).toHaveLength(1);
        });
        let reads = 0;
        const counted = snapshotOf();
        Object.defineProperty(counted, "revision", {
          get() {
            reads += 1;
            return 1;
          },
        });
        runtime.listeners[0]?.(counted);
        await vi.waitFor(() => {
          expect(second.messages).toHaveLength(2);
        });
        expect(reads).toBe(1);
      });

      it("the runtime is subscribed once, however many sockets are open", async () => {
        const { app, stub: runtime } = await rig();
        await connect(app);
        await connect(app);
        expect(runtime.subscribe).toHaveBeenCalledTimes(1);
      });
    });

    describe("With two sockets, one of them closed", () => {
      it("the open one still receives messages", async () => {
        const { app, stub: runtime } = await rig();
        const closing = await connect(app);
        const staying = await connect(app);
        closing.socket.terminate();
        await vi.waitFor(() => {
          expect(app.websocketServer.clients.size).toBe(1);
        });
        runtime.listeners[0]?.(snapshotOf({ revision: 13 }));
        await vi.waitFor(() => {
          expect(staying.messages.at(-1)?.state.revision).toBe(13);
        });
      });

      it("the closed one is forgotten", async () => {
        const { app, stub: runtime } = await rig();
        const only = await connect(app);
        only.socket.terminate();
        await vi.waitFor(() => {
          expect(runtime.unsubscribe).toHaveBeenCalledTimes(1);
        });
        expect(app.websocketServer.clients.size).toBe(0);
      });
    });

    describe("With a socket that has more than EVENTS_BUFFER_LIMIT waiting", () => {
      it("it is closed with code 1013 and the others still receive messages", async () => {
        const { app, stub: runtime } = await rig();
        const slow = await connect(app);
        const fast = await connect(app);
        await vi.waitFor(() => {
          expect(app.websocketServer.clients.size).toBe(2);
          expect(fast.messages).toHaveLength(1);
        });
        const [victim] = [...app.websocketServer.clients];
        Object.defineProperty(victim, "bufferedAmount", { value: EVENTS_BUFFER_LIMIT + 1 });
        runtime.listeners[0]?.(snapshotOf({ revision: 14 }));
        await vi.waitFor(() => {
          expect(fast.messages.at(-1)?.state.revision).toBe(14);
          expect([slow.closed()].filter((code) => code === 1013)).toHaveLength(1);
        });
      });
    });

    describe("With a message sent by the client", () => {
      it("nothing happens", async () => {
        const { app, stub: runtime } = await rig();
        const seen = await connect(app);
        await vi.waitFor(() => {
          expect(seen.messages).toHaveLength(1);
        });
        const before = runtime.calls();
        seen.socket.send('{"type":"hello"}');
        runtime.listeners[0]?.(snapshotOf({ revision: 15 }));
        await vi.waitFor(() => {
          expect(seen.messages).toHaveLength(2);
        });
        expect(seen.closed()).toBeUndefined();
        expect(runtime.calls()).toEqual(before);
      });
    });

    describe("When the API is closed", () => {
      it("every socket is closed with code 1001", async () => {
        const { app } = await rig();
        const first = await connect(app);
        const second = await connect(app);
        await app.close();
        await vi.waitFor(() => {
          expect(first.closed()).toBe(1001);
          expect(second.closed()).toBe(1001);
        });
      });

      it("the runtime's listener is removed", async () => {
        const { app, stub: runtime } = await rig();
        await connect(app);
        await app.close();
        expect(runtime.unsubscribe).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe("handlers", () => {
    describe("For every route in the table", () => {
      const rows: readonly (readonly [string, string, unknown, string])[] = [
        ["GET", "/api/state", undefined, "snapshot"],
        ["GET", "/api/config", undefined, "exportConfig"],
        ["POST", "/api/config/preview", { config: DOCUMENT }, "preview"],
        ["POST", "/api/config", { config: DOCUMENT }, "apply"],
        ["POST", "/api/hold", { on: true }, "setHold"],
        ["POST", "/api/resync", {}, "resync"],
        ["POST", `/api/valves/${VALVE}/refresh`, {}, "refreshValve"],
        ["POST", `/api/valves/${VALVE}/restore`, {}, "restoreValve"],
        ["POST", `/api/valves/${VALVE}/forget`, {}, "forgetValve"],
        ["POST", "/api/originals/import", {}, "importOriginals"],
        ["GET", "/api/diagnostics", undefined, "diagnostics"],
        ["GET", "/api/health", undefined, ""],
      ];

      for (const [method, url, body, expected] of rows) {
        it(`${method} ${url.replace(VALVE, ":id")} calls ${expected === "" ? "no runtime method" : expected}`, async () => {
          const { app, stub: runtime } = await rig();
          const response =
            method === "GET"
              ? await app.inject({ method: "GET", url })
              : await post(app, url, body);
          expect(response.statusCode).toBeLessThan(300);
          const called = runtime.calls().filter((name) => name !== "snapshot");
          expect(called).toEqual(expected === "" || expected === "snapshot" ? [] : [expected]);
        });
      }
    });
  });

  describe("toApiError", () => {
    describe("For each row of the error table", () => {
      it("returns that status, code and data", () => {
        const issues = [{ path: "a", code: "c", message: "m" }];
        expect(toApiError(new ConfigError(issues))).toMatchObject({
          status: 400,
          body: { code: "config_invalid", data: { issues } },
        });
        expect(toApiError(new ChangeRefused("valve_managed", { valveId: "v" }))).toMatchObject({
          status: 409,
          body: { code: "valve_managed", data: { valveId: "v" } },
        });
        expect(toApiError(new HeatmasterError("store_locked", { file: "f" }))).toMatchObject({
          status: 409,
          body: { code: "store_locked", data: { file: "f" } },
        });
        expect(
          toApiError(Object.assign(new Error("too big"), { code: "FST_ERR_CTP_BODY_TOO_LARGE" })),
        ).toMatchObject({ status: 413, body: { code: "body_too_large", data: {} } });
        expect(
          toApiError(
            Object.assign(new Error("x"), {
              validation: [{ instancePath: "/on", message: "must be boolean" }],
            }),
          ),
        ).toMatchObject({
          status: 400,
          body: {
            code: "body_invalid",
            data: { issues: [{ path: "on", message: "must be boolean" }] },
          },
        });
        expect(
          toApiError(Object.assign(new Error("media"), { code: "FST_ERR_CTP_INVALID_MEDIA_TYPE" })),
        ).toMatchObject({ status: 400, body: { code: "body_invalid" } });
        expect(toApiError(new Error("boom"))).toMatchObject({
          status: 500,
          body: { code: "internal", data: {} },
        });
      });
    });

    describe('With an error that is none of the three classes, whatever its code field holds ("room_unknown", "Bad Code", 42)', () => {
      it("returns 500 with code internal", () => {
        for (const code of ["room_unknown", "Bad Code", 42]) {
          const result = toApiError(Object.assign(new Error("x"), { code }));
          expect(result.status).toBe(500);
          expect(result.body.code).toBe("internal");
        }
        expect(toApiError("a string").status).toBe(500);
        expect(toApiError(undefined).body.code).toBe("internal");
      });
    });

    describe("With a HeatmasterError built without data", () => {
      it("data is {}", () => {
        expect(toApiError(new HeatmasterError("room_unknown")).body.data).toEqual({});
      });
    });
  });

  describe("end to end (the real runtime, on fake-z2m)", () => {
    const world = {} as { app: FastifyInstance; fake: FakeZ2m };
    const folders: string[] = [];
    const stops: (() => Promise<void>)[] = [];

    const IEEE = "0xa1";
    const TRVZB_STATE = {
      temperature_sensor_select: "local_temperature",
      system_mode: "auto",
      occupied_heating_setpoint: 17,
      local_temperature: 19.3,
      battery: 90,
    };

    const document = {
      version: 2,
      settings: { hold_writes: true, timezone: "Europe/Amsterdam" },
      schedules: [
        {
          id: "main",
          name: "Main",
          week: [{ days: "all", temperature: { "00:00": 16, "07:00": 20 } }],
        },
      ],
      rooms: [
        {
          id: "living",
          name: "Living",
          schedule_id: "main",
          valves: [{ id: `z2m:${IEEE}` }],
          sensors: [],
        },
      ],
    };

    const state = async (): Promise<StateView> =>
      (await world.app.inject({ method: "GET", url: "/api/state" })).json<StateView>();

    beforeAll(async () => {
      const fake = await startFakeZ2m();
      stops.push(() => fake.stop());
      fake.addDevice({ ieee: IEEE, name: "living/valve", modelId: "TRVZB" }, TRVZB_STATE);
      const dataDir = mkdtempSync(path.join(os.tmpdir(), "heatmaster-api-"));
      const publicDir = mkdtempSync(path.join(os.tmpdir(), "heatmaster-api-"));
      folders.push(dataDir, publicDir);
      const clock = createManualClock(Date.UTC(2026, 10, 16, 9, 0, 0));
      const mqtt = createMqttClient(
        { url: fake.url, username: undefined, password: undefined, clientId: undefined },
        clock,
      );
      const runtime = createRuntime({
        configStore: createConfigStore(dataDir, clock),
        ledgerStore: createLedgerStore({ dataDir, publicDir }, clock, "test"),
        pacingStore: createPacingStore(dataDir),
        transports: buildTransports(mqtt, { baseTopic: "zigbee2mqtt" }),
        ha: undefined,
        clock,
        processTimeZone: "Europe/Amsterdam",
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      });
      const app = buildApi({
        runtime,
        ready: () => true,
        mqttFault: () => mqtt.fault(),
        version: "t",
      });
      await app.ready();
      stops.push(() => app.close());
      await mqtt.connect();
      await runtime.start();
      stops.push(async () => {
        await runtime.stop();
        await mqtt.end();
      });
      world.app = app;
      world.fake = fake;
      fake.speak(IEEE);
      await vi.waitFor(
        async () => {
          const current = await state();
          if (!current.unassigned.some((valve) => valve.observed)) fake.republish(IEEE);
          expect(current.unassigned.some((valve) => valve.observed)).toBe(true);
        },
        { timeout: 10 * 1000, interval: 5 },
      );
    });

    afterAll(async () => {
      for (const stop of stops.splice(0).reverse()) await stop();
      for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
    });

    describe("With one TRVZB on the fake bridge that has reported", () => {
      it("GET /api/state lists it with supported true and no roomId", async () => {
        const valve = (await state()).valves.find((v) => v.valveId === `z2m:${IEEE}`);
        expect(valve).toMatchObject({ supported: true, name: "living/valve" });
        expect(Object.hasOwn(valve ?? {}, "roomId")).toBe(false);
      });

      it("POST /api/config/preview with a room for it answers one joining valve and its planned writes", async () => {
        const response = await post(world.app, "/api/config/preview", { config: document });
        expect(response.statusCode).toBe(200);
        const planned = response.json<PlanView>();
        expect(planned.applied).toBe(false);
        expect(planned.joining.map((j) => j.valveId)).toEqual([`z2m:${IEEE}`]);
        expect(planned.writes.length).toBeGreaterThan(0);
      });

      it("POST /api/config/preview with a version 1 document is refused with the version issue", async () => {
        const response = await post(world.app, "/api/config/preview", {
          config: { ...document, version: 1 },
        });
        expect(response.statusCode).toBe(400);
        const error = errorOf(response);
        expect(error.code).toBe("config_invalid");
        expect(error.data.issues).toEqual([
          expect.objectContaining({ code: "version_unsupported", path: "version" }),
        ]);
      });

      it("POST /api/config with the same body answers applied true and revision 1", async () => {
        const response = await post(world.app, "/api/config", { config: document });
        expect(response.statusCode).toBe(200);
        expect(response.json<PlanView>()).toMatchObject({ applied: true, revision: 1 });
      });

      it("GET /api/state then shows the room and the valve as managed", async () => {
        const after = await state();
        expect(after.rooms.map((room) => room.roomId)).toEqual(["living"]);
        expect(after.valves.find((v) => v.valveId === `z2m:${IEEE}`)).toMatchObject({
          roomId: "living",
          membership: "managed",
        });
      });

      it("GET /api/config returns the applied document, and no key named releasing", async () => {
        const response = await world.app.inject({ method: "GET", url: "/api/config" });
        const exported = response.json<{ revision: number; config: Record<string, unknown> }>();
        expect(exported.revision).toBe(1);
        expect(exported.config).toMatchObject({
          settings: { timezone: "Europe/Amsterdam" },
          rooms: [{ id: "living", name: "Living", valves: [{ id: `z2m:${IEEE}` }] }],
          schedules: [{ id: "main", name: "Main", week: document.schedules[0]?.week }],
        });
        expect(response.body).not.toContain("releasing");
      });

      it("GET /api/config shows the week as blocks of days under version 2 in the YAML text", async () => {
        const response = await world.app.inject({ method: "GET", url: "/api/config" });
        const { yaml } = response.json<{ yaml: string }>();
        expect(yaml).toContain("version: 2");
        expect(yaml).toContain("days: all");
        expect(yaml).toContain('"07:00": 20');
        expect(yaml).not.toContain("default_week");
      });
    });
  });
});
