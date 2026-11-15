import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

export type FakeEntityEntry = Readonly<{
  entity_id: string;
  device_id?: string | null;
  disabled_by?: string | null;
  name?: string | null;
  original_name?: string | null;
}>;

export type FakeDeviceEntry = Readonly<{
  id: string;
  identifiers: readonly (readonly [string, string])[];
  name?: string | null;
}>;

export type FakeAreaEntry = Readonly<{ area_id: string; name: string }>;

export type FakeHa = Readonly<{
  /** For `HaOptions`: the base address, without a path. */
  url: string;
  setConfig(config: Readonly<{ time_zone: string; language: string }>): void;
  /** Stores a full state object whose three times are `at`, and sends `state_changed`. */
  setState(
    entityId: string,
    state: string,
    attributes: Readonly<Record<string, unknown>>,
    at: number,
  ): void;
  /** Moves only `last_reported`; sends no event. */
  report(entityId: string, at: number): void;
  /** Takes `last_reported` out of the stored object; sends no event. */
  omitLastReported(entityId: string): void;
  removeState(entityId: string): void;
  setEntity(entry: FakeEntityEntry): void;
  setDevice(entry: FakeDeviceEntry): void;
  setArea(entry: FakeAreaEntry): void;
  /** The type of every message received after the handshake began, in order (`auth` included). */
  commands(): readonly string[];
  /** The method and path of every REST request, as "GET /api/states/x". */
  requests(): readonly string[];
  /** The `access_token` of every `auth` message. */
  tokens(): readonly string[];
  /** The path of every websocket upgrade request. */
  upgrades(): readonly string[];
  /**
   * The next command of that type gets an error result. "close" closes the socket instead of the
   * next answer (the library's own handshake commands excepted); "close:<type>" does so for the next
   * command of that type and also refuses new connections until `refuseConnections(false)`; "rest"
   * fails the next REST request.
   */
  failNext(type: string): void;
  dropConnections(): void;
  refuseConnections(on: boolean): void;
  setToken(token: string): void;
  /** The event type of every active subscription (an all-events one shows as ""). */
  subscriptions(): readonly string[];
  /**
   * While on, REST requests are recorded at once but answered only when it goes off, with the
   * state as it was when the request arrived.
   */
  holdRest(on: boolean): void;
  /** How many websocket connections are open now. */
  openSockets(): number;
  /** How many websocket connections passed the handshake so far. */
  accepted(): number;
  stop(): Promise<void>;
}>;

interface StateObject {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
  last_reported?: string;
  context: Record<string, unknown>;
}

interface Subscription {
  readonly socket: WebSocket;
  readonly id: number;
  readonly eventType: string | undefined;
}

const HA_VERSION = "2026.11.0";
const iso = (at: number): string => new Date(at).toISOString();

export async function startFakeHa(options: Readonly<{ token?: string }> = {}): Promise<FakeHa> {
  let token = options.token ?? "test-token";
  let config = { time_zone: "Europe/Amsterdam", language: "en" };
  const states = new Map<string, StateObject>();
  const entities = new Map<string, FakeEntityEntry>();
  const devices = new Map<string, FakeDeviceEntry>();
  const areas = new Map<string, FakeAreaEntry>();
  const subscriptions: Subscription[] = [];
  const received: string[] = [];
  const requested: string[] = [];
  const tokens: string[] = [];
  const upgraded: string[] = [];
  const failures = new Set<string>();
  const held: (() => void)[] = [];
  let holding = false;
  const sockets = new Set<WebSocket>();
  let refusing = false;
  let acceptedCount = 0;

  const server = http.createServer((request, response) => {
    const method = request.method ?? "GET";
    const path = request.url ?? "/";
    requested.push(`${method} ${path}`);
    const fail = (status: number): void => {
      response.writeHead(status).end();
    };
    if (failures.delete("rest")) {
      fail(500);
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      fail(401);
      return;
    }
    const prefix = "/api/states/";
    if (method !== "GET" || !path.startsWith(prefix)) {
      fail(404);
      return;
    }
    const state = states.get(decodeURIComponent(path.slice(prefix.length)));
    if (state === undefined) {
      fail(404);
      return;
    }
    const body = JSON.stringify(state);
    const answer = (): void => {
      response.writeHead(200, { "content-type": "application/json" }).end(body);
    };
    if (holding) held.push(answer);
    else answer();
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    upgraded.push(request.url ?? "");
    if (refusing || request.url !== "/api/websocket") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  function send(socket: WebSocket, message: unknown): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }

  function result(socket: WebSocket, id: number, value: unknown): void {
    send(socket, { id, type: "result", success: true, result: value });
  }

  function emit(eventType: string, data: Readonly<Record<string, unknown>>): void {
    for (const sub of subscriptions) {
      if (sub.eventType !== undefined && sub.eventType !== eventType) continue;
      send(sub.socket, {
        id: sub.id,
        type: "event",
        event: { event_type: eventType, data, origin: "LOCAL", time_fired: iso(0), context: {} },
      });
    }
  }

  function answer(socket: WebSocket, message: Readonly<Record<string, unknown>>): void {
    const type = String(message.type);
    const id = Number(message.id);
    if (type === "supported_features") {
      result(socket, id, null);
      return;
    }
    if (type === "ping") {
      send(socket, { id, type: "pong" });
      return;
    }
    if (type === "get_config") {
      result(socket, id, { ...config });
      return;
    }
    if (type === "get_states") {
      result(socket, id, [...states.values()]);
      return;
    }
    if (type === "config/entity_registry/list") {
      result(socket, id, [...entities.values()]);
      return;
    }
    if (type === "config/device_registry/list") {
      result(socket, id, [...devices.values()]);
      return;
    }
    if (type === "config/area_registry/list") {
      result(socket, id, [...areas.values()]);
      return;
    }
    if (type === "subscribe_events") {
      const eventType = typeof message.event_type === "string" ? message.event_type : undefined;
      subscriptions.push({ socket, id, eventType });
      result(socket, id, null);
      return;
    }
    if (type === "unsubscribe_events") {
      const index = subscriptions.findIndex(
        (s) => s.socket === socket && s.id === message.subscription,
      );
      if (index >= 0) subscriptions.splice(index, 1);
      result(socket, id, null);
      return;
    }
    send(socket, {
      id,
      type: "result",
      success: false,
      error: { code: "unknown_command", message: `Unknown command ${type}` },
    });
  }

  wss.on("connection", (socket) => {
    sockets.add(socket);
    let authenticated = false;
    send(socket, { type: "auth_required", ha_version: HA_VERSION });
    socket.on("close", () => {
      sockets.delete(socket);
      for (let i = subscriptions.length - 1; i >= 0; i -= 1) {
        if (subscriptions[i]?.socket === socket) subscriptions.splice(i, 1);
      }
    });
    socket.on("message", (data) => {
      const message = JSON.parse((data as Buffer).toString("utf8")) as Readonly<
        Record<string, unknown>
      >;
      const type = String(message.type);
      received.push(type);
      if (!authenticated) {
        if (type !== "auth") return;
        tokens.push(String(message.access_token));
        if (message.access_token === token) {
          authenticated = true;
          acceptedCount += 1;
          send(socket, { type: "auth_ok", ha_version: HA_VERSION });
        } else {
          send(socket, { type: "auth_invalid", message: "Invalid access token or password" });
          socket.close();
        }
        return;
      }
      const handshake = type === "supported_features" || type.endsWith("_events");
      if (failures.delete(`close:${type}`)) {
        // A drop that leaves Home Assistant unreachable until `refuseConnections(false)`.
        refusing = true;
        socket.terminate();
        return;
      }
      if (!handshake && failures.delete("close")) {
        socket.terminate();
        return;
      }
      if (failures.delete(type)) {
        send(socket, {
          id: message.id,
          type: "result",
          success: false,
          error: { code: "unknown_error", message: "scripted failure" },
        });
        return;
      }
      answer(socket, message);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    setConfig(next) {
      config = { ...next };
      emit("core_config_updated", {});
    },
    setState(entityId, state, attributes, at) {
      const old = states.get(entityId) ?? null;
      const next: StateObject = {
        entity_id: entityId,
        state,
        attributes: { ...attributes },
        last_changed: iso(at),
        last_updated: iso(at),
        last_reported: iso(at),
        context: {},
      };
      states.set(entityId, next);
      emit("state_changed", { entity_id: entityId, old_state: old, new_state: next });
    },
    report(entityId, at) {
      const state = states.get(entityId);
      if (state !== undefined) state.last_reported = iso(at);
    },
    omitLastReported(entityId) {
      const state = states.get(entityId);
      if (state !== undefined) delete state.last_reported;
    },
    removeState(entityId) {
      const old = states.get(entityId) ?? null;
      states.delete(entityId);
      emit("state_changed", { entity_id: entityId, old_state: old, new_state: null });
    },
    setEntity(entry) {
      entities.set(entry.entity_id, entry);
      emit("entity_registry_updated", { action: "update", entity_id: entry.entity_id });
    },
    setDevice(entry) {
      devices.set(entry.id, entry);
      emit("device_registry_updated", { action: "update", device_id: entry.id });
    },
    setArea(entry) {
      areas.set(entry.area_id, entry);
      emit("area_registry_updated", { action: "update", area_id: entry.area_id });
    },
    commands: () => received,
    requests: () => requested,
    tokens: () => tokens,
    upgrades: () => upgraded,
    failNext(type) {
      failures.add(type);
    },
    dropConnections() {
      for (const socket of sockets) socket.terminate();
    },
    refuseConnections(on) {
      refusing = on;
    },
    setToken(next) {
      token = next;
    },
    subscriptions: () => subscriptions.map((sub) => sub.eventType ?? ""),
    holdRest(on) {
      holding = on;
      if (on) return;
      for (const answer of held.splice(0)) answer();
    },
    openSockets: () => sockets.size,
    accepted: () => acceptedCount,
    async stop() {
      for (const socket of sockets) socket.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
