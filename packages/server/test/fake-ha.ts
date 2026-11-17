import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

export type FakeEntityEntry = Readonly<{
  entity_id: string;
  device_id?: string | null;
  disabled_by?: string | null;
  name?: string | null;
  original_name?: string | null;
  area_id?: string | null;
  labels?: readonly string[];
}>;

export type FakeDeviceEntry = Readonly<{
  id: string;
  identifiers: readonly (readonly [string, string])[];
  name?: string | null;
  area_id?: string | null;
  labels?: readonly string[];
}>;

export type FakeAreaEntry = Readonly<{
  area_id: string;
  name: string;
  labels?: readonly string[];
}>;

export type FakeLabelEntry = Readonly<{ label_id: string; name: string }>;

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
  /** Stores a label and sends `label_registry_updated`. */
  setLabel(entry: FakeLabelEntry): void;
  /** Removes a label and sends `label_registry_updated`. */
  removeLabel(labelId: string): void;
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
  /**
   * Every label write received (the five `LABEL_WRITES` commands), in order, as sent without its
   * `id`.
   */
  writes(): readonly Readonly<Record<string, unknown>>[];
  /** While on, every label write fails with `unauthorized`, as for a user who is not an admin. */
  answerUnauthorized(on: boolean): void;
  /** The next label write is received and never answered. */
  stallNext(): void;
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

/** The registry writes Home Assistant answers here, as its websocket API does. */
export const LABEL_WRITES: readonly string[] = [
  "config/label_registry/create",
  "config/label_registry/update",
  "config/label_registry/delete",
  "config/area_registry/update",
  "config/entity_registry/update",
];

/** Home Assistant's `slugify` for the names used in tests: lower case, `_` between words. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Home Assistant's `normalize_name`: case folded, without spaces. */
function normalizeName(name: string): string {
  return name.toLowerCase().replaceAll(" ", "");
}

type Answer = Readonly<{ result: unknown }> | Readonly<{ code: string; message: string }>;
const iso = (at: number): string => new Date(at).toISOString();

export async function startFakeHa(options: Readonly<{ token?: string }> = {}): Promise<FakeHa> {
  let token = options.token ?? "test-token";
  let config = { time_zone: "Europe/Amsterdam", language: "en" };
  const states = new Map<string, StateObject>();
  const entities = new Map<string, FakeEntityEntry>();
  const devices = new Map<string, FakeDeviceEntry>();
  const areas = new Map<string, FakeAreaEntry>();
  const labels = new Map<string, FakeLabelEntry>();
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
  const written: Readonly<Record<string, unknown>>[] = [];
  let unauthorized = false;
  let stalling = false;

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

  function labelTaken(name: string, except: string | undefined): boolean {
    const wanted = normalizeName(name);
    for (const label of labels.values()) {
      if (label.label_id !== except && normalizeName(label.name) === wanted) return true;
    }
    return false;
  }

  /** Changes the registry and sends its `…_registry_updated` events, as Home Assistant does. */
  function write(message: Readonly<Record<string, unknown>>): Answer {
    const type = String(message.type);
    const name = typeof message.name === "string" ? message.name : undefined;
    const newLabels = Array.isArray(message.labels) ? (message.labels as string[]) : undefined;
    switch (type) {
      case "config/label_registry/create": {
        if (name === undefined) return { code: "invalid_format", message: "name required" };
        if (labelTaken(name, undefined)) {
          return { code: "invalid_info", message: `The name ${name} is already in use` };
        }
        const base = slugify(name);
        let labelId = base;
        for (let tries = 2; labels.has(labelId); tries += 1) labelId = `${base}_${String(tries)}`;
        const entry = { label_id: labelId, name };
        labels.set(labelId, entry);
        emit("label_registry_updated", { action: "create", label_id: labelId });
        return { result: { ...entry } };
      }
      case "config/label_registry/update": {
        const labelId = String(message.label_id);
        const old = labels.get(labelId);
        if (old === undefined) return { code: "unknown_error", message: "Unknown error" };
        if (name === undefined || name === old.name) return { result: { ...old } };
        if (labelTaken(name, labelId)) {
          return { code: "invalid_info", message: `The name ${name} is already in use` };
        }
        const entry = { label_id: labelId, name };
        labels.set(labelId, entry);
        emit("label_registry_updated", { action: "update", label_id: labelId });
        return { result: { ...entry } };
      }
      case "config/label_registry/delete": {
        const labelId = String(message.label_id);
        if (!labels.delete(labelId)) {
          return { code: "invalid_info", message: "Label ID doesn't exist" };
        }
        emit("label_registry_updated", { action: "remove", label_id: labelId });
        // Home Assistant's area and entity registries drop a removed label from their entries.
        for (const area of areas.values()) {
          if (!(area.labels ?? []).includes(labelId)) continue;
          areas.set(area.area_id, {
            ...area,
            labels: (area.labels ?? []).filter((l) => l !== labelId),
          });
          emit("area_registry_updated", { action: "update", area_id: area.area_id });
        }
        for (const entity of entities.values()) {
          if (!(entity.labels ?? []).includes(labelId)) continue;
          entities.set(entity.entity_id, {
            ...entity,
            labels: (entity.labels ?? []).filter((l) => l !== labelId),
          });
          emit("entity_registry_updated", { action: "update", entity_id: entity.entity_id });
        }
        return { result: null };
      }
      case "config/area_registry/update": {
        const areaId = String(message.area_id);
        const old = areas.get(areaId);
        if (old === undefined) return { code: "unknown_error", message: "Unknown error" };
        const entry = newLabels === undefined ? old : { ...old, labels: [...newLabels] };
        areas.set(areaId, entry);
        emit("area_registry_updated", { action: "update", area_id: areaId });
        return { result: { ...entry } };
      }
      default: {
        const entityId = String(message.entity_id);
        const old = entities.get(entityId);
        if (old === undefined) return { code: "not_found", message: "Entity not found" };
        const entry = newLabels === undefined ? old : { ...old, labels: [...newLabels] };
        entities.set(entityId, entry);
        emit("entity_registry_updated", { action: "update", entity_id: entityId });
        return { result: { entity_entry: { ...entry } } };
      }
    }
  }

  function answer(socket: WebSocket, message: Readonly<Record<string, unknown>>): void {
    const type = String(message.type);
    const id = Number(message.id);
    if (LABEL_WRITES.includes(type)) {
      if (stalling) {
        stalling = false;
        return;
      }
      const outcome: Answer = unauthorized
        ? { code: "unauthorized", message: "Unauthorized" }
        : write(message);
      if ("result" in outcome) result(socket, id, outcome.result);
      else send(socket, { id, type: "result", success: false, error: { ...outcome } });
      return;
    }
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
    if (type === "config/label_registry/list") {
      result(socket, id, [...labels.values()]);
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
      if (LABEL_WRITES.includes(type)) {
        written.push(Object.fromEntries(Object.entries(message).filter(([key]) => key !== "id")));
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
    setLabel(entry) {
      labels.set(entry.label_id, entry);
      emit("label_registry_updated", { action: "update", label_id: entry.label_id });
    },
    removeLabel(labelId) {
      labels.delete(labelId);
      emit("label_registry_updated", { action: "remove", label_id: labelId });
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
    writes: () => written,
    answerUnauthorized(on) {
      unauthorized = on;
    },
    stallNext() {
      stalling = true;
    },
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
