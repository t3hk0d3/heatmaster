/**
 * The HTTP API: how the web page and a person with `curl` reach the runtime. It decides nothing.
 * A handler checks the shape of the request, calls one runtime method and turns the result into
 * JSON. Who may call is decided by Caddy; the server listens on the loopback address only.
 */

import websocket from "@fastify/websocket";
import { ChangeRefused, ConfigError } from "@heatmaster/core";
import type {
  ApiError,
  ApplyRequest,
  ConfigView,
  EventMessage,
  PlanView,
  StateView,
} from "@heatmaster/core";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AddressInfo } from "node:net";
import type { WebSocket } from "ws";
import { type Document, isScalar, parseDocument, stringify, visit } from "yaml";
import { HeatmasterError } from "./errors.ts";
import { API_HOST } from "./options.ts";
import type { ApplyOptions, HeatmasterRuntime, Snapshot } from "./runtime.ts";
import { planView, stateView } from "./views.ts";

/** A socket with more than this waiting to be sent is closed (code 1013). */
export const EVENTS_BUFFER_LIMIT = 1024 * 1024;

const CLOSE_GOING_AWAY = 1001;
const CLOSE_TRY_AGAIN_LATER = 1013;
/** A socket that has not answered a close by then is dropped. */
const CLOSE_GRACE_MS = 1000;
/** What a client may send us; nothing is read from it. */
const CLIENT_MESSAGE_LIMIT = 64 * 1024;

export type ApiRuntime = Pick<
  HeatmasterRuntime,
  | "snapshot"
  | "subscribe"
  | "apply"
  | "preview"
  | "exportConfig"
  | "resync"
  | "refreshValve"
  | "restoreValve"
  | "forgetValve"
  | "importOriginals"
  | "acceptOriginals"
  | "dismissUpgrade"
  | "setHold"
  | "diagnostics"
>;

export type ApiDeps = Readonly<{
  runtime: ApiRuntime;
  /** True once the whole start has run. */
  ready: () => boolean;
  /** The MQTT client's fault, for the health route. */
  mqttFault: () => string | undefined;
  /** The server package's version, for the health route. */
  version: string;
}>;

// ---- errors --------------------------------------------------------------------------------------

type Failure = Readonly<{ status: number; body: ApiError }>;

function failure(
  status: number,
  code: string,
  message: string,
  data: Readonly<Record<string, unknown>> = {},
): Failure {
  return { status, body: { code, message, data } };
}

type Issue = Readonly<{ path: string; message: string }>;

/** Ajv's faults as `{ path, message }`, the path written with dots: `rooms.0.name`. */
function validationIssues(validation: readonly unknown[]): Issue[] {
  return validation.map((entry) => {
    const fault = (entry ?? {}) as {
      instancePath?: unknown;
      message?: unknown;
      params?: { additionalProperty?: unknown; missingProperty?: unknown };
    };
    const base = typeof fault.instancePath === "string" ? fault.instancePath : "";
    const extra = fault.params?.additionalProperty ?? fault.params?.missingProperty;
    const full = typeof extra === "string" ? `${base}/${extra}` : base;
    return {
      path: full.replace(/^\//, "").replaceAll("/", "."),
      message: typeof fault.message === "string" ? fault.message : "is invalid",
    };
  });
}

function stringField(error: object, field: string): string | undefined {
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

/** Maps what a handler or Fastify threw; not what a handler found by itself. */
export function toApiError(error: unknown): Failure {
  if (error instanceof ConfigError) {
    return failure(400, "config_invalid", error.message, {
      issues: error.issues.map(({ path, code, message }) => ({ path, code, message })),
    });
  }
  if (error instanceof ChangeRefused || error instanceof HeatmasterError) {
    return failure(409, error.code, error.message, error.data);
  }
  if (error instanceof Error) {
    const validation = (error as { validation?: unknown }).validation;
    if (Array.isArray(validation)) {
      return failure(400, "body_invalid", "the request does not match its schema", {
        issues: validationIssues(validation),
      });
    }
    const code = stringField(error, "code");
    if (code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return failure(413, "body_too_large", "the request body is too large");
    }
    const parseFault =
      error instanceof SyntaxError && (error as { statusCode?: unknown }).statusCode === 400;
    if ((code?.startsWith("FST_ERR_CTP_") ?? false) || parseFault) {
      return failure(400, "body_invalid", "the request body cannot be used", {
        issues: [{ path: "", message: error.message }],
      });
    }
  }
  return failure(500, "internal", "internal error");
}

function send(reply: FastifyReply, result: Failure): FastifyReply {
  return reply.code(result.status).send(result.body);
}

// ---- schemas -------------------------------------------------------------------------------------

const NO_FIELDS = { type: "object", additionalProperties: false, properties: {} } as const;

const SCHEMAS = {
  apply: {
    type: "object",
    additionalProperties: false,
    properties: {
      config: { type: "object" },
      yaml: { type: "string" },
      expectedRevision: { type: "integer", minimum: 0 },
      overwriteUnreadable: { type: "boolean" },
    },
  },
  hold: {
    type: "object",
    additionalProperties: false,
    required: ["on"],
    properties: { on: { type: "boolean" } },
  },
  resync: {
    type: "object",
    additionalProperties: false,
    properties: { roomId: { type: "string" } },
  },
  importOriginals: {
    type: "object",
    additionalProperties: false,
    properties: { acceptEmpty: { type: "boolean" } },
  },
} as const;

const VALVE_PARAMS = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 1 } },
} as const;

// ---- requests ------------------------------------------------------------------------------------

type ParsedConfig =
  | Readonly<{ ok: true; config: Readonly<Record<string, unknown>> }>
  | Readonly<{ ok: false; failure: Failure }>;

function yamlFailure(
  data: Readonly<Record<string, unknown>> = {},
  message = "the YAML text cannot be used as a config",
): ParsedConfig {
  return { ok: false, failure: failure(400, "yaml_invalid", message, data) };
}

/** The text of the key node that starts at `offset`, read from the parsed document. */
function duplicateKeyName(document: Document, offset: number): string | undefined {
  let name: string | undefined;
  visit(document, {
    Pair(_, pair) {
      const key = pair.key;
      if (isScalar(key) && key.range?.[0] === offset) {
        name = String(key.value);
        return visit.BREAK;
      }
      return undefined;
    },
  });
  return name;
}

/** The document of an apply request: `config` as it is, or `yaml` read with the YAML 1.2 core schema. */
function configOf(body: ApplyRequest): ParsedConfig {
  if ((body.config === undefined) === (body.yaml === undefined)) {
    return {
      ok: false,
      failure: failure(400, "config_or_yaml", "give exactly one of config and yaml"),
    };
  }
  if (body.config !== undefined) return { ok: true, config: body.config };
  const document = parseDocument(body.yaml ?? "", { version: "1.2", schema: "core" });
  const first = document.errors[0];
  if (first !== undefined) {
    const position = first.linePos?.[0];
    const where = position === undefined ? {} : { line: position.line, column: position.col };
    if (first.code === "DUPLICATE_KEY") {
      const key = duplicateKeyName(document, first.pos[0]);
      if (key === undefined) return yamlFailure(where, "the YAML text repeats a key in one block");
      return yamlFailure({ ...where, key }, `the YAML text repeats the key ${JSON.stringify(key)}`);
    }
    return yamlFailure(where);
  }
  let value: unknown;
  try {
    value = document.toJS();
  } catch {
    return yamlFailure();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return yamlFailure();
  return { ok: true, config: value as Record<string, unknown> };
}

function optionsOf(body: ApplyRequest): ApplyOptions {
  return {
    expectedRevision: body.expectedRevision,
    overwriteUnreadable: body.overwriteUnreadable ?? false,
  };
}

// ---- the API -------------------------------------------------------------------------------------

/** Every route registered; not listening yet. `logger` false silences Fastify's logger (tests). */
export function buildApi(deps: ApiDeps, logger = false): FastifyInstance {
  const { runtime } = deps;
  const app = Fastify({
    logger,
    routerOptions: { maxParamLength: 200 },
    // URL faults Fastify finds before any hook runs are answered here, in the API's own shape.
    frameworkErrors: (error, _request, reply) => {
      void reply.header("cache-control", "no-store");
      void send(
        reply,
        error.code === "FST_ERR_BAD_URL"
          ? failure(400, "body_invalid", "the URL cannot be used", {
              issues: [{ path: "", message: error.message }],
            })
          : failure(404, "not_found", "there is no such route"),
      );
    },
    // Unknown fields are refused, not removed; nothing is converted to another type.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
  });

  const sockets = new Set<WebSocket>();
  let unsubscribe: (() => void) | undefined;

  function release(socket: WebSocket): void {
    sockets.delete(socket);
    if (sockets.size === 0 && unsubscribe !== undefined) {
      unsubscribe();
      unsubscribe = undefined;
    }
  }

  function closeSocket(socket: WebSocket, code: number): void {
    release(socket);
    socket.close(code);
    // A peer that never answers the close would hold the shutdown.
    setTimeout(() => {
      socket.terminate();
    }, CLOSE_GRACE_MS).unref();
  }

  function message(snapshot: Snapshot): string {
    return JSON.stringify({ type: "state", state: stateView(snapshot) } satisfies EventMessage);
  }

  /** The state is built once and sent to every open socket. */
  function broadcast(snapshot: Snapshot): void {
    if (sockets.size === 0) return;
    const text = message(snapshot);
    for (const socket of [...sockets]) {
      if (socket.bufferedAmount > EVENTS_BUFFER_LIMIT) {
        closeSocket(socket, CLOSE_TRY_AGAIN_LATER);
        continue;
      }
      socket.send(text);
    }
  }

  app.addHook("onRequest", (_request, reply, done) => {
    if (deps.ready()) {
      done();
      return;
    }
    // Answering from a callback hook: the reply is sent and `done` is not called.
    send(reply, failure(503, "not_ready", "Heatmaster is still starting"));
  });

  app.addHook("onSend", (_request, reply, payload, done) => {
    void reply.header("cache-control", "no-store");
    done(null, payload);
  });

  app.setErrorHandler((error, request, reply) => {
    const result = toApiError(error);
    if (result.status === 500) request.log.error({ err: error }, "a request failed");
    void send(reply, result);
  });

  app.setNotFoundHandler((_request, reply) => {
    void send(reply, failure(404, "not_found", "there is no such route"));
  });

  void app.register(websocket, {
    options: { maxPayload: CLIENT_MESSAGE_LIMIT },
    preClose(done) {
      for (const socket of [...sockets]) closeSocket(socket, CLOSE_GOING_AWAY);
      done();
    },
  });

  void app.register((routes, _options, registered) => {
    const noContent = (reply: FastifyReply): FastifyReply => reply.code(204).send();

    routes.get("/api/health", (_request, reply) => {
      const fault = deps.mqttFault();
      if (fault !== undefined) {
        return send(
          reply,
          failure(503, "mqtt_fault", "the MQTT client cannot reach a valve", { reason: fault }),
        );
      }
      return reply.send({ status: "ok", version: deps.version });
    });

    routes.get("/api/state", (): StateView => stateView(runtime.snapshot()));

    routes.get("/api/events", { websocket: true }, (socket) => {
      sockets.add(socket);
      unsubscribe ??= runtime.subscribe(broadcast);
      socket.on("close", () => {
        release(socket);
      });
      socket.on("error", (error) => {
        routes.log.warn({ err: error }, "an events socket failed");
        release(socket);
        socket.terminate();
      });
      // Messages from the client are ignored.
      socket.on("message", () => undefined);
      socket.send(message(runtime.snapshot()));
    });

    routes.get("/api/config", (): ConfigView => {
      const { revision, config } = runtime.exportConfig();
      return { revision, config, yaml: stringify(config, { version: "1.1" }) };
    });

    for (const applied of [false, true]) {
      routes.post<{ Body: ApplyRequest }>(
        applied ? "/api/config" : "/api/config/preview",
        { schema: { body: SCHEMAS.apply } },
        async (request, reply): Promise<PlanView | FastifyReply> => {
          const parsed = configOf(request.body);
          if (!parsed.ok) return send(reply, parsed.failure);
          const options = optionsOf(request.body);
          const plan = applied
            ? await runtime.apply(parsed.config, options)
            : await runtime.preview(parsed.config, options);
          return planView(plan, applied, runtime.snapshot());
        },
      );
    }

    routes.post<{ Body: { on: boolean } }>(
      "/api/hold",
      { schema: { body: SCHEMAS.hold } },
      async (request, reply) => {
        await runtime.setHold(request.body.on);
        return noContent(reply);
      },
    );

    routes.post<{ Body: { roomId?: string } }>(
      "/api/resync",
      { schema: { body: SCHEMAS.resync } },
      async (request, reply) => {
        await runtime.resync(request.body.roomId);
        return noContent(reply);
      },
    );

    const valveActions = {
      refresh: (id: string) => runtime.refreshValve(id),
      restore: (id: string) => runtime.restoreValve(id),
      forget: (id: string) => runtime.forgetValve(id),
      "accept-originals": (id: string) => runtime.acceptOriginals(id),
    };
    for (const [action, run] of Object.entries(valveActions)) {
      routes.post<{ Params: { id: string } }>(
        `/api/valves/:id/${action}`,
        { schema: { body: NO_FIELDS, params: VALVE_PARAMS } },
        async (request, reply) => {
          await run(request.params.id);
          return noContent(reply);
        },
      );
    }

    routes.post<{ Body: { acceptEmpty?: boolean } }>(
      "/api/originals/import",
      { schema: { body: SCHEMAS.importOriginals } },
      async (request, reply) => {
        await runtime.importOriginals(request.body.acceptEmpty ?? false);
        return noContent(reply);
      },
    );

    routes.post(
      "/api/upgrade/dismiss",
      { schema: { body: NO_FIELDS } },
      async (_request, reply) => {
        await runtime.dismissUpgrade();
        return noContent(reply);
      },
    );

    routes.get("/api/diagnostics", () => runtime.diagnostics());

    registered();
  });

  app.addHook("onClose", (_instance, done) => {
    for (const socket of [...sockets]) closeSocket(socket, CLOSE_GOING_AWAY);
    unsubscribe?.();
    unsubscribe = undefined;
    done();
  });

  return app;
}

/** Listens on the loopback address and returns the port it got; port 0 asks for a free one. */
export async function startApi(app: FastifyInstance, port: number): Promise<number> {
  try {
    await app.listen({ host: API_HOST, port });
  } catch (error) {
    await app.close();
    throw error;
  }
  return (app.server.address() as AddressInfo).port;
}
