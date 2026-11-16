/** Home Assistant entities through MQTT discovery: room devices, a Heatmaster device, one button. */

import type { ProblemView, RoomView, StateView, SyncState } from "@heatmaster/core";
import { consoleErrorLog, type ErrorLog } from "./errors.ts";
import { STATUS_OFFLINE, STATUS_ONLINE, STATUS_TOPIC, type MqttClient } from "./mqtt.ts";

export const DISCOVERY_NODE = "heatmaster";
export const HA_STATUS_TOPIC = "homeassistant/status";
export const SYSTEM_STATE_TOPIC = "heatmaster/system/state";
export const PROBLEMS_TOPIC = "heatmaster/system/problems";
export const PRESS_TOPIC = "heatmaster/system/stop_writing/press";
export const PRESS_PAYLOAD = "PRESS";
export const PROBLEM_ATTRIBUTE_LIMIT = 50;
export const SYNC_OPTIONS: readonly SyncState[] = [
  "in_sync",
  "pending",
  "not_holding",
  "unverified",
  "held",
  "frozen",
];

const SUPPORT_URL = "https://github.com/t3hk0d3/heatmaster";
const ROOM_PREFIX = "room_";

export type EntityTexts = Readonly<{
  target: string;
  sync: string;
  problemCount: string;
  held: string;
  stopWriting: string;
  roomModel: string;
}>;

export const ENTITY_TEXTS: Readonly<Record<"en" | "ru", EntityTexts>> = {
  en: {
    target: "Target temperature",
    sync: "Sync",
    problemCount: "Problems",
    held: "Writes held",
    stopWriting: "Stop writing",
    roomModel: "Room",
  },
  ru: {
    target: "Целевая температура",
    sync: "Синхронизация",
    problemCount: "Проблемы",
    held: "Запись остановлена",
    stopWriting: "Остановить запись",
    roomModel: "Комната",
  },
};

export type DiscoveryOptions = Readonly<{ prefix: string; version: string }>;

export function roomStateTopic(roomId: string): string {
  return `heatmaster/rooms/${roomId}/state`;
}

export function roomConfigTopic(prefix: string, roomId: string): string {
  return `${prefix}/device/${DISCOVERY_NODE}/${ROOM_PREFIX}${roomId}/config`;
}

export function systemConfigTopic(prefix: string): string {
  return `${prefix}/device/${DISCOVERY_NODE}/system/config`;
}

function origin(options: DiscoveryOptions): Record<string, string> {
  return { name: "Heatmaster", sw_version: options.version, support_url: SUPPORT_URL };
}

function template(key: string): string {
  return `{{ value_json.${key} }}`;
}

function roomConfig(room: RoomView, texts: EntityTexts, options: DiscoveryOptions): string {
  const stateTopic = roomStateTopic(room.roomId);
  const id = `heatmaster_room_${room.roomId}`;
  const device: Record<string, unknown> = {
    identifiers: [id],
    name: room.name,
    manufacturer: "Heatmaster",
    model: texts.roomModel,
    via_device: DISCOVERY_NODE,
  };
  if (room.areaName !== undefined) device.suggested_area = room.areaName;
  return JSON.stringify({
    device,
    origin: origin(options),
    availability_topic: STATUS_TOPIC,
    payload_available: STATUS_ONLINE,
    payload_not_available: STATUS_OFFLINE,
    components: {
      temperature: {
        platform: "sensor",
        unique_id: `${id}_temperature`,
        state_topic: stateTopic,
        device_class: "temperature",
        state_class: "measurement",
        unit_of_measurement: "°C",
        suggested_display_precision: 1,
        value_template: template("temperature"),
      },
      target: {
        platform: "sensor",
        unique_id: `${id}_target`,
        name: texts.target,
        state_topic: stateTopic,
        device_class: "temperature",
        state_class: "measurement",
        unit_of_measurement: "°C",
        value_template: template("target"),
      },
      problem: {
        platform: "binary_sensor",
        unique_id: `${id}_problem`,
        state_topic: stateTopic,
        device_class: "problem",
        entity_category: "diagnostic",
        value_template: template("problem"),
      },
      sync: {
        platform: "sensor",
        unique_id: `${id}_sync`,
        name: texts.sync,
        state_topic: stateTopic,
        device_class: "enum",
        options: SYNC_OPTIONS,
        entity_category: "diagnostic",
        value_template: template("sync"),
      },
    },
  });
}

function systemConfig(texts: EntityTexts, options: DiscoveryOptions): string {
  return JSON.stringify({
    device: {
      identifiers: [DISCOVERY_NODE],
      name: "Heatmaster",
      manufacturer: "Heatmaster",
      model: "Heatmaster",
      sw_version: options.version,
    },
    origin: origin(options),
    availability_topic: STATUS_TOPIC,
    payload_available: STATUS_ONLINE,
    payload_not_available: STATUS_OFFLINE,
    components: {
      problem: {
        platform: "binary_sensor",
        unique_id: "heatmaster_problem",
        state_topic: SYSTEM_STATE_TOPIC,
        device_class: "problem",
        value_template: template("problem"),
      },
      problem_count: {
        platform: "sensor",
        unique_id: "heatmaster_problem_count",
        name: texts.problemCount,
        state_topic: SYSTEM_STATE_TOPIC,
        state_class: "measurement",
        entity_category: "diagnostic",
        value_template: template("problem_count"),
        json_attributes_topic: PROBLEMS_TOPIC,
      },
      held: {
        platform: "binary_sensor",
        unique_id: "heatmaster_held",
        name: texts.held,
        state_topic: SYSTEM_STATE_TOPIC,
        value_template: template("held"),
      },
      stop_writing: {
        platform: "button",
        unique_id: "heatmaster_stop_writing",
        name: texts.stopWriting,
        command_topic: PRESS_TOPIC,
        payload_press: PRESS_PAYLOAD,
      },
    },
  });
}

/** Topic → JSON text: the system device first, then the rooms in order (only when the config is ok). */
export function configMessages(
  state: StateView,
  options: DiscoveryOptions,
): ReadonlyMap<string, string> {
  const texts = ENTITY_TEXTS[state.language];
  const messages = new Map<string, string>();
  messages.set(systemConfigTopic(options.prefix), systemConfig(texts, options));
  if (state.configState !== "ok") return messages;
  for (const room of state.rooms) {
    messages.set(roomConfigTopic(options.prefix, room.roomId), roomConfig(room, texts, options));
  }
  return messages;
}

function onOff(on: boolean): "ON" | "OFF" {
  return on ? "ON" : "OFF";
}

function problemEntry(problem: ProblemView): ProblemView {
  return {
    kind: problem.kind,
    subject: problem.subject,
    name: problem.name,
    severity: problem.severity,
    data: problem.data,
  };
}

/** Topic → JSON text: the rooms in order, then the system state, then the problems. */
export function stateMessages(state: StateView): ReadonlyMap<string, string> {
  const messages = new Map<string, string>();
  for (const room of state.rooms) {
    messages.set(
      roomStateTopic(room.roomId),
      JSON.stringify({
        temperature: room.currentTemperature ?? null,
        target: room.target ?? null,
        problem: onOff(room.degraded || room.hasProblem),
        sync: room.sync,
      }),
    );
  }
  messages.set(
    SYSTEM_STATE_TOPIC,
    JSON.stringify({
      problem: onOff(state.problems.length > 0),
      problem_count: state.problems.length,
      held: onOff(state.held),
    }),
  );
  messages.set(
    PROBLEMS_TOPIC,
    JSON.stringify({
      problems: state.problems.slice(0, PROBLEM_ATTRIBUTE_LIMIT).map(problemEntry),
      more: Math.max(0, state.problems.length - PROBLEM_ATTRIBUTE_LIMIT),
    }),
  );
  return messages;
}

export type DiscoveryMqtt = Pick<MqttClient, "state" | "publish" | "subscribe" | "onEvent">;

export type DiscoveryDeps = Readonly<{
  mqtt: DiscoveryMqtt;
  stopWriting: () => Promise<unknown>;
  options: DiscoveryOptions;
  /** Defaults to one JSON line on stderr. */
  log: ErrorLog | undefined;
}>;

export type Discovery = Readonly<{
  start(): Promise<void>;
  sync(state: StateView): Promise<void>;
  stop(): Promise<void>;
}>;

const PUBLISH = { qos: 1, retain: true } as const;

export function createDiscovery(deps: DiscoveryDeps): Discovery {
  const { mqtt, options } = deps;
  const log = deps.log ?? consoleErrorLog;
  const logError = (message: string, error: unknown): void => {
    log.error(message, { err: String(error) });
  };
  /** The text last published to each topic. */
  const published = new Map<string, string>();
  /** Room config topics this process published to, or that the broker holds from earlier runs. */
  const knownRooms = new Set<string>();
  const unsubscribes: (() => void)[] = [];
  let latest: StateView | undefined;
  let running: Promise<void> | undefined;
  const flags: { again: boolean; stopped: boolean } = { again: false, stopped: false };

  // A function, so a check made after an await is not narrowed by an earlier one.
  const newest = (): StateView | undefined => latest;
  const isStopped = (): boolean => flags.stopped;

  function roomIdOf(topic: string): string | undefined {
    const head = `${options.prefix}/device/${DISCOVERY_NODE}/${ROOM_PREFIX}`;
    if (!topic.startsWith(head) || !topic.endsWith("/config")) return undefined;
    const id = topic.slice(head.length, -"/config".length);
    return id === "" || id.includes("/") ? undefined : id;
  }

  async function publish(topic: string, text: string): Promise<void> {
    if (flags.stopped) return;
    if (published.get(topic) === text) return;
    try {
      await mqtt.publish(topic, text, PUBLISH);
      published.set(topic, text);
    } catch (error) {
      published.delete(topic);
      logError("a discovery message was not published", error);
    }
  }

  async function pass(state: StateView): Promise<void> {
    if (mqtt.state() !== "connected") return;
    const ok = state.configState === "ok";
    for (const [topic, text] of configMessages(state, options)) {
      await publish(topic, text);
      if (roomIdOf(topic) !== undefined && published.get(topic) === text) knownRooms.add(topic);
    }
    for (const [topic, text] of stateMessages(state)) {
      if (!ok && topic.startsWith("heatmaster/rooms/")) continue;
      await publish(topic, text);
    }
    if (!ok) return;
    const present = new Set(state.rooms.map((room) => room.roomId));
    for (const topic of [...knownRooms]) {
      const id = roomIdOf(topic);
      if (id === undefined || present.has(id)) continue;
      const stateTopic = roomStateTopic(id);
      // Sent whether or not `published` holds the text: a removal is a plain empty message.
      published.delete(topic);
      published.delete(stateTopic);
      await publish(topic, "");
      await publish(stateTopic, "");
      if (published.get(topic) === "") {
        knownRooms.delete(topic);
        published.delete(topic);
        published.delete(stateTopic);
      }
    }
  }

  function sync(state: StateView): Promise<void> {
    latest = state;
    if (flags.stopped) return Promise.resolve();
    if (running !== undefined) {
      flags.again = true;
      return running;
    }
    const wanted = (): boolean => flags.again && !isStopped();
    const loop = (async (): Promise<void> => {
      try {
        do {
          flags.again = false;
          const state = newest();
          if (state !== undefined && !isStopped()) await pass(state);
        } while (wanted());
      } finally {
        running = undefined;
      }
    })();
    running = loop;
    return loop;
  }

  function resend(): void {
    published.clear();
    if (latest !== undefined) void sync(latest);
  }

  return {
    start() {
      unsubscribes.push(
        mqtt.subscribe(HA_STATUS_TOPIC, (_topic, payload) => {
          if (payload.toString("utf8") === "online") resend();
        }),
        mqtt.subscribe(PRESS_TOPIC, (_topic, payload, retained) => {
          if (retained || payload.toString("utf8") !== PRESS_PAYLOAD) return;
          deps.stopWriting().catch((error: unknown) => {
            logError("the stop-writing button failed", error);
          });
        }),
        mqtt.subscribe(
          `${options.prefix}/device/${DISCOVERY_NODE}/+/config`,
          (topic, payload, retained) => {
            if (roomIdOf(topic) === undefined) return;
            if (payload.length === 0) knownRooms.delete(topic);
            else if (retained) knownRooms.add(topic);
          },
        ),
        mqtt.onEvent((event) => {
          if (event.kind === "connected") resend();
        }),
      );
      return Promise.resolve();
    },
    sync,
    async stop() {
      flags.stopped = true;
      for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
      await running;
    },
  };
}
