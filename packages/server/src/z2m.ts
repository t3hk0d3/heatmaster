import { HeatmasterError } from "./errors.ts";
import type { MqttClient } from "./mqtt.ts";
import type { DeviceInfo, RawEvent, Transport } from "./transport.ts";

export type Z2mOptions = Readonly<{ baseTopic: string | undefined }>;

export const DEFAULT_BASE_TOPIC = "zigbee2mqtt";
/** The major version of Zigbee2MQTT recorded in docs/device-notes.md. */
export const SUPPORTED_Z2M_MAJOR = 2;

const LAST_SEEN_ON: readonly string[] = ["ISO_8601", "ISO_8601_local", "epoch"];

type Bridge = "unknown" | "online" | "offline";
type BridgeInfo = Readonly<{ version: unknown; lastSeen: unknown }>;

function parseJson(payload: Buffer): unknown {
  try {
    return JSON.parse(payload.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function bridgeState(payload: Buffer): "online" | "offline" | undefined {
  const raw = payload.toString("utf8").trim();
  const parsed = parseJson(payload);
  const value = isRecord(parsed) ? parsed.state : typeof parsed === "string" ? parsed : raw;
  return value === "online" || value === "offline" ? value : undefined;
}

function majorOf(version: unknown): number | undefined {
  if (typeof version !== "string") return undefined;
  const match = /^(\d+)(?:\.|$)/.exec(version);
  return match === null ? undefined : Number(match[1]);
}

function parseDevices(payload: Buffer): ReadonlyMap<string, DeviceInfo> | undefined {
  const parsed = parseJson(payload);
  if (!Array.isArray(parsed)) return undefined;
  const devices = new Map<string, DeviceInfo>();
  for (const entry of parsed as unknown[]) {
    if (!isRecord(entry) || entry.type === "Coordinator") continue;
    const address = text(entry.ieee_address);
    const name = text(entry.friendly_name);
    if (address === undefined || name === undefined) continue;
    const deviceId = `z2m:${address}`;
    devices.set(deviceId, {
      deviceId,
      transport: "z2m",
      address,
      modelId: typeof entry.model_id === "string" ? entry.model_id : "",
      manufacturer: text(entry.manufacturer),
      firmware: text(entry.software_build_id),
      name,
    });
  }
  return devices;
}

function sameDevices(
  a: ReadonlyMap<string, DeviceInfo>,
  b: ReadonlyMap<string, DeviceInfo>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [id, info] of a) {
    const other = b.get(id);
    if (other === undefined || JSON.stringify(info) !== JSON.stringify(other)) return false;
  }
  return true;
}

function lifeTokenOf(payload: Readonly<Record<string, unknown>>): string | undefined {
  const lastSeen = payload.last_seen;
  if (typeof lastSeen === "string") return lastSeen;
  if (typeof lastSeen === "number") return String(lastSeen);
  return undefined;
}

export function createZ2mTransport(mqtt: MqttClient, options: Z2mOptions): Transport {
  const base = options.baseTopic ?? DEFAULT_BASE_TOPIC;
  let listener: ((event: RawEvent) => void) | undefined;
  let removers: (() => void)[] = [];
  let devices: ReadonlyMap<string, DeviceInfo> = new Map();
  // Kept across link losses: the last list stays the best knowledge, and the transport's fault
  // covers a broker that is down.
  let hasDeviceList = false;
  let followed: ReadonlySet<string> = new Set();
  const deviceTopics = new Map<string, () => void>();
  let info: BridgeInfo | undefined;
  let mqttUp = false;
  let bridge: Bridge = "unknown";
  let outage = false;

  const linkUp = (): boolean => mqttUp && bridge === "online";

  function send(event: RawEvent): void {
    listener?.(event);
  }

  /** Subscribes to the exact topic of each followed, listed device and drops the rest. */
  function syncDeviceTopics(): void {
    const wanted = new Map<string, string>();
    for (const id of followed) {
      const device = devices.get(id);
      if (device !== undefined) wanted.set(`${base}/${device.name}`, id);
    }
    for (const [topic, remove] of [...deviceTopics]) {
      if (wanted.has(topic)) continue;
      remove();
      deviceTopics.delete(topic);
    }
    for (const [topic, deviceId] of wanted) {
      if (deviceTopics.has(topic)) continue;
      try {
        deviceTopics.set(
          topic,
          mqtt.subscribe(topic, (_topic, payload) => {
            onDeviceMessage(deviceId, payload);
          }),
        );
      } catch (error) {
        // A friendly name that is not a valid topic cannot be followed.
        if (!(error instanceof HeatmasterError) || error.code !== "topic_invalid") throw error;
      }
    }
  }

  function onDeviceMessage(deviceId: string, payload: Buffer): void {
    const parsed = parseJson(payload);
    if (!isRecord(parsed)) return;
    send({ kind: "message", deviceId, payload: parsed, lifeToken: lifeTokenOf(parsed) });
  }

  function onBridgeState(payload: Buffer): void {
    const next = bridgeState(payload);
    if (next === undefined) return;
    const wasUp = linkUp();
    bridge = next;
    if (next === "offline") {
      outage = true;
      if (wasUp) send({ kind: "link_down" });
      return;
    }
    if (!wasUp && linkUp()) send({ kind: "link_up" });
    if (outage) send({ kind: "bridge_restarted" });
    outage = false;
  }

  function onBridgeInfo(payload: Buffer): void {
    const parsed = parseJson(payload);
    if (!isRecord(parsed)) return;
    const config = isRecord(parsed.config) ? parsed.config : undefined;
    const advanced =
      config !== undefined && isRecord(config.advanced) ? config.advanced : undefined;
    info = { version: parsed.version, lastSeen: advanced?.last_seen };
  }

  function onBridgeDevices(payload: Buffer): void {
    const next = parseDevices(payload);
    if (next === undefined) return;
    // The first list is news even when it is empty: the devices are now known.
    const changed = !hasDeviceList || !sameDevices(devices, next);
    devices = next;
    hasDeviceList = true;
    syncDeviceTopics();
    if (changed) send({ kind: "devices_changed" });
  }

  function onBridgeEvent(payload: Buffer): void {
    const parsed = parseJson(payload);
    if (!isRecord(parsed) || parsed.type !== "device_announce" || !isRecord(parsed.data)) return;
    const address = text(parsed.data.ieee_address);
    if (address === undefined) return;
    const deviceId = `z2m:${address}`;
    if (devices.has(deviceId)) send({ kind: "rejoined", deviceId });
  }

  function connectionLost(): void {
    const wasUp = linkUp();
    mqttUp = false;
    bridge = "unknown";
    outage = true;
    if (wasUp) send({ kind: "link_down" });
  }

  function addressed(deviceId: string): DeviceInfo {
    const device = devices.get(deviceId);
    if (device === undefined) throw new HeatmasterError("device_unknown", { deviceId });
    return device;
  }

  async function send_(
    suffix: "set" | "get",
    deviceId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const device = addressed(deviceId);
    await mqtt.publish(`${base}/${device.name}/${suffix}`, JSON.stringify(payload), {
      qos: 1,
      retain: false,
    });
  }

  return {
    key: "z2m",
    fault() {
      const fromMqtt = mqtt.fault();
      if (fromMqtt !== undefined) return fromMqtt;
      if (info === undefined) return "bridge_unknown";
      if (majorOf(info.version) !== SUPPORTED_Z2M_MAJOR) return "version_unsupported";
      // Zigbee2MQTT's own default is "disable" and bridge/info always carries the setting, so
      // only a known enabled format proves the option is on.
      if (!LAST_SEEN_ON.includes(info.lastSeen as string)) return "last_seen_disabled";
      return undefined;
    },
    linkUp,
    devices: () => devices,
    hasDeviceList: () => hasDeviceList,
    start(next) {
      listener = next;
      mqttUp = mqtt.state() === "connected";
      bridge = "unknown";
      outage = false;
      removers = [
        mqtt.onEvent((event) => {
          if (event.kind === "connected") mqttUp = true;
          else connectionLost();
        }),
        mqtt.subscribe(`${base}/bridge/state`, (_topic, payload) => {
          onBridgeState(payload);
        }),
        mqtt.subscribe(`${base}/bridge/info`, (_topic, payload) => {
          onBridgeInfo(payload);
        }),
        mqtt.subscribe(`${base}/bridge/devices`, (_topic, payload) => {
          onBridgeDevices(payload);
        }),
        mqtt.subscribe(`${base}/bridge/event`, (_topic, payload) => {
          onBridgeEvent(payload);
        }),
      ];
      return Promise.resolve();
    },
    follow(deviceIds) {
      followed = new Set(deviceIds);
      syncDeviceTopics();
    },
    publish: (deviceId, payload) => send_("set", deviceId, payload),
    read: (deviceId, payload) => send_("get", deviceId, payload),
    stop() {
      listener = undefined;
      for (const remove of removers) remove();
      removers = [];
      for (const remove of deviceTopics.values()) remove();
      deviceTopics.clear();
      return Promise.resolve();
    },
  };
}

export function buildTransports(
  mqtt: MqttClient,
  z2m: Z2mOptions,
): Readonly<Record<string, Transport>> {
  return { z2m: createZ2mTransport(mqtt, z2m) };
}
