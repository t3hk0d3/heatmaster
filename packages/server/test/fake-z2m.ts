import net from "node:net";
import { Aedes } from "aedes";

export type FakeDevice = Readonly<{
  ieee: string;
  name: string;
  modelId: string;
  type?: string;
  exposes?: readonly unknown[];
}>;

export type Received = Readonly<{
  kind: "set" | "get";
  payload: unknown;
  qos: number;
  retain: boolean;
}>;

export type FakeZ2m = Readonly<{
  url: string;
  addDevice(device: FakeDevice, state: Readonly<Record<string, unknown>>): void;
  renameDevice(ieee: string, name: string): void;
  removeDevice(ieee: string): void;
  speak(ieee: string, changes?: Readonly<Record<string, unknown>>): void;
  republish(ieee: string): void;
  onSet(ieee: string, key: string, rule: "ack" | "echo" | "drop"): void;
  onGet(ieee: string, rule: "answer" | "drop"): void;
  holdAnswers(): void;
  releaseAnswers(): void;
  restart(): void;
  setBridgeState(state: "online" | "offline", asText?: boolean): void;
  setInfo(info: Readonly<{ version?: string; lastSeen?: string }>): void;
  announce(ieee: string, type?: string): void;
  received(ieee: string): readonly Received[];
  retained(topic: string): string | undefined;
  /** Publishes any message, as some other client would. */
  inject(topic: string, payload: string, retain?: boolean): void;
  dropClients(): void;
  /** While on, every new connection is closed at once, before any packet is answered. */
  refuseConnections(on: boolean): void;
  /** The number of TCP connections the broker has accepted so far. */
  attempts(): number;
  stop(): Promise<void>;
}>;

interface Device {
  ieee: string;
  name: string;
  modelId: string;
  type: string;
  exposes: readonly unknown[];
  cache: Record<string, unknown>;
  lastSeenMs: number;
  received: Received[];
}

const COORDINATOR = {
  ieee_address: "0x0000000000000001",
  friendly_name: "Coordinator",
  type: "Coordinator",
  model_id: null,
  manufacturer: null,
  software_build_id: null,
  supported: true,
  disabled: false,
};

const FIRST_SEEN_MS = Date.UTC(2026, 0, 1);

function formatLastSeen(format: string, ms: number): string | number | undefined {
  switch (format) {
    case "disable":
      return undefined;
    case "epoch":
      return ms;
    case "ISO_8601_local":
      return `${new Date(ms).toISOString().slice(0, 19)}+00:00`;
    default:
      return new Date(ms).toISOString();
  }
}

export async function startFakeZ2m(
  options: Readonly<{ baseTopic?: string; version?: string; lastSeen?: string }> = {},
): Promise<FakeZ2m> {
  const base = options.baseTopic ?? "zigbee2mqtt";
  let version = options.version ?? "2.14.3";
  let lastSeenFormat = options.lastSeen ?? "ISO_8601";
  const devices = new Map<string, Device>();
  const retained = new Map<string, string>();
  const rules = new Map<string, "ack" | "echo" | "drop">();
  const getRules = new Map<string, "answer" | "drop">();
  const held: (() => void)[] = [];
  let holding = false;

  const aedes = await Aedes.createBroker({ heartbeatInterval: 3_600_000 });
  const sockets = new Set<net.Socket>();
  let refusing = false;
  let accepted = 0;
  const server = net.createServer((socket) => {
    accepted += 1;
    if (refusing) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    aedes.handle(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;

  // Aedes stores a retained message before it delivers it. A plain message published right after
  // one was seen to get through while the retained ones before it never reached the client. Each
  // publish waits for the one before it, as the messages of one Zigbee2MQTT process arrive in order.
  let publishing: Promise<void> = Promise.resolve();

  function put(topic: string, payload: string, retain: boolean): void {
    if (retain) {
      if (payload === "") retained.delete(topic);
      else retained.set(topic, payload);
    }
    publishing = publishing.then(
      () =>
        new Promise<void>((resolve) => {
          aedes.publish({ cmd: "publish", qos: 0, dup: false, topic, payload, retain }, () => {
            // An in-process publish does not fail.
            resolve();
          });
        }),
    );
  }

  function publishInfo(): void {
    put(
      `${base}/bridge/info`,
      JSON.stringify({
        version,
        config: { advanced: { last_seen: lastSeenFormat, output: "json" } },
      }),
      true,
    );
  }

  function publishDevices(): void {
    const list = [...devices.values()].map((device) => ({
      ieee_address: device.ieee,
      friendly_name: device.name,
      type: device.type,
      model_id: device.modelId,
      manufacturer: "SONOFF",
      software_build_id: "1.0.0",
      supported: true,
      disabled: false,
      definition: { exposes: device.exposes },
    }));
    put(`${base}/bridge/devices`, JSON.stringify([COORDINATOR, ...list]), true);
  }

  function publishCache(device: Device): void {
    const lastSeen = formatLastSeen(lastSeenFormat, device.lastSeenMs);
    const message =
      lastSeen === undefined ? device.cache : { ...device.cache, last_seen: lastSeen };
    put(`${base}/${device.name}`, JSON.stringify(message), false);
  }

  function speak(device: Device, changes: Readonly<Record<string, unknown>> = {}): void {
    Object.assign(device.cache, changes);
    device.lastSeenMs += 1000;
    publishCache(device);
  }

  function answer(run: () => void): void {
    if (holding) held.push(run);
    else run();
  }

  function deviceOf(ieee: string): Device {
    const device = devices.get(ieee);
    if (device === undefined) throw new Error(`the fake has no device ${ieee}`);
    return device;
  }

  function onClientMessage(topic: string, payload: Buffer, qos: number, retain: boolean): void {
    if (!topic.startsWith(`${base}/`)) return;
    const rest = topic.slice(base.length + 1);
    const kind = rest.endsWith("/set") ? "set" : rest.endsWith("/get") ? "get" : undefined;
    if (kind === undefined) return;
    const name = rest.slice(0, -kind.length - 1);
    const device = [...devices.values()].find((candidate) => candidate.name === name);
    if (device === undefined) return;
    let body: unknown;
    try {
      body = JSON.parse(payload.toString("utf8"));
    } catch {
      body = payload.toString("utf8");
    }
    device.received.push({ kind, payload: body, qos, retain });
    if (kind === "get") {
      if (getRules.get(device.ieee) === "drop") return;
      answer(() => {
        speak(device);
      });
      return;
    }
    if (typeof body !== "object" || body === null) return;
    const changes: Record<string, unknown> = {};
    const echoes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      const rule = rules.get(`${device.ieee}:${key}`) ?? "ack";
      if (rule === "ack") changes[key] = value;
      else if (rule === "echo") echoes[key] = value;
    }
    if (Object.keys(changes).length === 0 && Object.keys(echoes).length === 0) return;
    answer(() => {
      if (Object.keys(changes).length > 0) {
        Object.assign(device.cache, echoes);
        speak(device, changes);
      } else {
        Object.assign(device.cache, echoes);
        publishCache(device);
      }
    });
  }

  aedes.on("publish", (packet, client) => {
    if (client === null) return;
    if (packet.retain) {
      const text = packet.payload.toString();
      if (text === "") retained.delete(packet.topic);
      else retained.set(packet.topic, text);
    }
    onClientMessage(packet.topic, Buffer.from(packet.payload), packet.qos, packet.retain);
  });

  put(`${base}/bridge/state`, JSON.stringify({ state: "online" }), true);
  publishInfo();
  publishDevices();

  return {
    url: `mqtt://127.0.0.1:${String(port)}`,
    addDevice(device, state) {
      devices.set(device.ieee, {
        ieee: device.ieee,
        name: device.name,
        modelId: device.modelId,
        type: device.type ?? "EndDevice",
        exposes: device.exposes ?? [],
        cache: { ...state },
        lastSeenMs: FIRST_SEEN_MS,
        received: [],
      });
      publishDevices();
    },
    renameDevice(ieee, name) {
      deviceOf(ieee).name = name;
      publishDevices();
    },
    removeDevice(ieee) {
      devices.delete(ieee);
      publishDevices();
    },
    speak(ieee, changes) {
      speak(deviceOf(ieee), changes);
    },
    republish(ieee) {
      publishCache(deviceOf(ieee));
    },
    onSet(ieee, key, rule) {
      rules.set(`${ieee}:${key}`, rule);
    },
    onGet(ieee, rule) {
      getRules.set(ieee, rule);
    },
    holdAnswers() {
      holding = true;
    },
    releaseAnswers() {
      holding = false;
      for (const run of held.splice(0)) run();
    },
    restart() {
      put(`${base}/bridge/state`, JSON.stringify({ state: "offline" }), true);
      put(`${base}/bridge/state`, JSON.stringify({ state: "online" }), true);
      publishInfo();
      publishDevices();
      for (const device of devices.values()) publishCache(device);
    },
    setBridgeState(state, asText = false) {
      put(`${base}/bridge/state`, asText ? state : JSON.stringify({ state }), true);
    },
    setInfo(info) {
      if (info.version !== undefined) version = info.version;
      if (info.lastSeen !== undefined) lastSeenFormat = info.lastSeen;
      publishInfo();
    },
    announce(ieee, type = "device_announce") {
      const device = deviceOf(ieee);
      put(
        `${base}/bridge/event`,
        JSON.stringify({ type, data: { friendly_name: device.name, ieee_address: ieee } }),
        false,
      );
    },
    received: (ieee) => [...deviceOf(ieee).received],
    retained: (topic) => retained.get(topic),
    inject(topic, payload, retain = false) {
      put(topic, payload, retain);
    },
    dropClients() {
      for (const socket of sockets) socket.destroy();
    },
    refuseConnections(on) {
      refusing = on;
    },
    attempts: () => accepted,
    async stop() {
      for (const socket of sockets) socket.destroy();
      if (server.listening) {
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        });
      }
      await new Promise<void>((resolve) => {
        aedes.close(() => {
          resolve();
        });
      });
    },
  };
}
