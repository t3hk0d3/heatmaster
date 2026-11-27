/** Home Assistant entities through MQTT discovery: room devices, a Heatmaster device, one button. */

import {
  END_RULES,
  MANUAL_CHANGES,
  PRESET_NAMES,
  WINDOW_ACTIONS,
  WINDOW_ENDS,
  WINDOW_LIMIT_CHOICES_MS,
  type EndRule,
  type ManualChange,
  type ProblemView,
  type RoomChoice,
  type RoomView,
  type StateView,
  type SyncState,
  type ThermostatCommand,
  type WindowAction,
  type WindowEnd,
} from "@heatmaster/core";
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
const ATTRIBUTE_KEYS = ["rule", "ends_at", "origin", "next_change_at", "next_target"] as const;

export type EntityTexts = Readonly<{
  temperature: string;
  problem: string;
  target: string;
  sync: string;
  problemCount: string;
  held: string;
  stopWriting: string;
  roomModel: string;
  thermostat: string;
  schedule: string;
  /** The name of the select that sets how an override ends. */
  overrideEnd: string;
  /** The select's options, one text per end rule. */
  overrideEndOptions: Readonly<Record<EndRule, string>>;
  /** The window entities' names. */
  window: string;
  windowEnabled: string;
  windowTemperature: string;
  windowAction: string;
  windowEnd: string;
  windowLimit: string;
  windowManualChange: string;
  /** The window selects' options: one text per value; the limit's are `WINDOW_LIMIT_CHOICES_MS` and then none. */
  windowActionOptions: Readonly<Record<WindowAction, string>>;
  windowEndOptions: Readonly<Record<WindowEnd, string>>;
  windowLimitOptions: readonly string[];
  windowManualChangeOptions: Readonly<Record<ManualChange, string>>;
}>;

export const ENTITY_TEXTS: Readonly<Record<"en" | "ru", EntityTexts>> = {
  en: {
    temperature: "Temperature",
    problem: "Problem",
    target: "Target temperature",
    sync: "Sync",
    problemCount: "Problems",
    held: "Writes held",
    stopWriting: "Stop writing",
    roomModel: "Room",
    thermostat: "Thermostat",
    schedule: "Schedule",
    overrideEnd: "Override ends",
    overrideEndOptions: {
      next_change: "Next schedule change",
      timer: "For a set time",
      manual: "Until cancelled",
    },
    window: "Window",
    windowEnabled: "Open-window mode",
    windowTemperature: "Detect by temperature drop",
    windowAction: "Window action",
    windowEnd: "Window end",
    windowLimit: "Window limit",
    windowManualChange: "Manual change during window",
    windowActionOptions: { frost_heat: "Frost heat", off: "Valves off" },
    windowEndOptions: { fixed: "After a set time", stopped_falling: "Stopped falling" },
    windowLimitOptions: ["30 min", "1 h", "2 h", "4 h", "8 h", "none"],
    windowManualChangeOptions: { resume_heating: "Resume heating", ignore: "Ignore" },
  },
  ru: {
    temperature: "Температура",
    problem: "Проблема",
    target: "Целевая температура",
    sync: "Синхронизация",
    problemCount: "Проблемы",
    held: "Запись остановлена",
    stopWriting: "Остановить запись",
    roomModel: "Комната",
    thermostat: "Термостат",
    schedule: "Расписание",
    overrideEnd: "Конец ручной настройки",
    overrideEndOptions: {
      next_change: "До смены по расписанию",
      timer: "На заданное время",
      manual: "До отмены",
    },
    window: "Окно",
    windowEnabled: "Режим открытого окна",
    windowTemperature: "Определять по падению температуры",
    windowAction: "Действие при открытом окне",
    windowEnd: "Конец режима окна",
    windowLimit: "Предел времени окна",
    windowManualChange: "Ручное изменение при открытом окне",
    windowActionOptions: { frost_heat: "Защита от мороза", off: "Клапаны выключены" },
    windowEndOptions: { fixed: "Через заданное время", stopped_falling: "Падение прекратилось" },
    windowLimitOptions: ["30 мин", "1 ч", "2 ч", "4 ч", "8 ч", "нет"],
    windowManualChangeOptions: { resume_heating: "Вернуть отопление", ignore: "Игнорировать" },
  },
};

export type DiscoveryOptions = Readonly<{ prefix: string; version: string }>;

export function roomStateTopic(roomId: string): string {
  return `heatmaster/rooms/${roomId}/state`;
}

/** Where Home Assistant sends a room's command: `what` is mode, temperature, preset, schedule, override_end or a `window_` field. */
export function roomCommandTopic(roomId: string, what: string): string {
  return `heatmaster/rooms/${roomId}/set/${what}`;
}

export const ROOM_COMMANDS_FILTER = "heatmaster/rooms/+/set/+";

export function roomConfigTopic(prefix: string, roomId: string): string {
  return `${prefix}/device/${DISCOVERY_NODE}/${ROOM_PREFIX}${roomId}/config`;
}

export function systemConfigTopic(prefix: string): string {
  return `${prefix}/device/${DISCOVERY_NODE}/system/config`;
}

function origin(options: DiscoveryOptions): Record<string, string> {
  return { name: "Heatmaster", sw_version: options.version, support_url: SUPPORT_URL };
}

/**
 * The suggested entity id: ASCII, from ids only, so a room's name never reaches it. Home Assistant
 * entity ids allow only a-z, 0-9 and `_`, so the `-` a room id may hold becomes `_`.
 */
function entityId(platform: string, roomId: string | undefined, key: string): string {
  return roomId === undefined
    ? `${platform}.${DISCOVERY_NODE}_${key}`
    : `${platform}.${DISCOVERY_NODE}_${roomId.replaceAll("-", "_")}_${key}`;
}

/** The climate's id carries no key: it is the room's one thermostat. */
function climateEntityId(roomId: string): string {
  return `climate.${DISCOVERY_NODE}_${roomId.replaceAll("-", "_")}`;
}

function template(key: string): string {
  return `{{ value_json.${key} }}`;
}

/** The climate's attributes: the keys of the room state that describe how its state ends. */
const ATTRIBUTES_TEMPLATE =
  "{{ {" +
  [
    ...ATTRIBUTE_KEYS.map((key) => `"${key}": value_json.${key}`),
    '"window": value_json.window_attr',
  ].join(", ") +
  "} | tojson }}";

/** A window switch: its state is the room payload's `field`, its command goes to the set topic. */
function windowSwitch(
  room: RoomView,
  id: string,
  field: string,
  name: string,
): Record<string, unknown> {
  return {
    platform: "switch",
    unique_id: `${id}_${field}`,
    name,
    default_entity_id: entityId("switch", room.roomId, field),
    state_topic: roomStateTopic(room.roomId),
    value_template: template(field),
    command_topic: roomCommandTopic(room.roomId, field),
    payload_on: "ON",
    payload_off: "OFF",
  };
}

function windowSelect(
  room: RoomView,
  id: string,
  field: string,
  name: string,
  options: readonly string[],
): Record<string, unknown> {
  return {
    platform: "select",
    unique_id: `${id}_${field}`,
    name,
    default_entity_id: entityId("select", room.roomId, field),
    options,
    state_topic: roomStateTopic(room.roomId),
    value_template: template(field),
    command_topic: roomCommandTopic(room.roomId, field),
  };
}

function roomConfig(
  room: RoomView,
  schedules: StateView["schedules"],
  texts: EntityTexts,
  options: DiscoveryOptions,
): string {
  const stateTopic = roomStateTopic(room.roomId);
  const id = `heatmaster_room_${room.roomId}`;
  return JSON.stringify({
    device: {
      identifiers: [id],
      name: room.name,
      manufacturer: "Heatmaster",
      model: texts.roomModel,
      via_device: DISCOVERY_NODE,
      // The room is the Home Assistant area of the same name.
      suggested_area: room.name,
    },
    origin: origin(options),
    availability_topic: STATUS_TOPIC,
    payload_available: STATUS_ONLINE,
    payload_not_available: STATUS_OFFLINE,
    components: {
      temperature: {
        platform: "sensor",
        unique_id: `${id}_temperature`,
        name: texts.temperature,
        default_entity_id: entityId("sensor", room.roomId, "temperature"),
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
        default_entity_id: entityId("sensor", room.roomId, "target"),
        state_topic: stateTopic,
        device_class: "temperature",
        state_class: "measurement",
        unit_of_measurement: "°C",
        value_template: template("target"),
      },
      problem: {
        platform: "binary_sensor",
        unique_id: `${id}_problem`,
        name: texts.problem,
        default_entity_id: entityId("binary_sensor", room.roomId, "problem"),
        state_topic: stateTopic,
        device_class: "problem",
        entity_category: "diagnostic",
        value_template: template("problem"),
      },
      sync: {
        platform: "sensor",
        unique_id: `${id}_sync`,
        name: texts.sync,
        default_entity_id: entityId("sensor", room.roomId, "sync"),
        state_topic: stateTopic,
        device_class: "enum",
        options: SYNC_OPTIONS,
        entity_category: "diagnostic",
        value_template: template("sync"),
      },
      climate: {
        platform: "climate",
        unique_id: `${id}_climate`,
        name: texts.thermostat,
        default_entity_id: climateEntityId(room.roomId),
        modes: ["auto", "heat", "off"],
        preset_modes: PRESET_NAMES,
        min_temp: room.minTemp,
        max_temp: room.maxTemp,
        temp_step: 0.5,
        temperature_unit: "C",
        mode_state_topic: stateTopic,
        mode_state_template: template("mode"),
        mode_command_topic: roomCommandTopic(room.roomId, "mode"),
        temperature_state_topic: stateTopic,
        temperature_state_template: template("target"),
        temperature_command_topic: roomCommandTopic(room.roomId, "temperature"),
        current_temperature_topic: stateTopic,
        current_temperature_template: template("temperature"),
        preset_mode_state_topic: stateTopic,
        preset_mode_value_template: template("preset"),
        preset_mode_command_topic: roomCommandTopic(room.roomId, "preset"),
        action_topic: stateTopic,
        action_template: template("action"),
        json_attributes_topic: stateTopic,
        json_attributes_template: ATTRIBUTES_TEMPLATE,
      },
      schedule: {
        platform: "select",
        unique_id: `${id}_schedule`,
        name: texts.schedule,
        default_entity_id: entityId("select", room.roomId, "schedule"),
        options: schedules.map((schedule) => schedule.name),
        state_topic: stateTopic,
        value_template: template("schedule"),
        command_topic: roomCommandTopic(room.roomId, "schedule"),
      },
      override_end: {
        platform: "select",
        unique_id: `${id}_override_end`,
        name: texts.overrideEnd,
        default_entity_id: entityId("select", room.roomId, "override_end"),
        options: END_RULES.map((rule) => texts.overrideEndOptions[rule]),
        state_topic: stateTopic,
        value_template: template("override_end"),
        command_topic: roomCommandTopic(room.roomId, "override_end"),
      },
      window: {
        platform: "binary_sensor",
        unique_id: `${id}_window`,
        name: texts.window,
        default_entity_id: entityId("binary_sensor", room.roomId, "window"),
        state_topic: stateTopic,
        device_class: "window",
        value_template: template("window"),
      },
      window_enabled: windowSwitch(room, id, "window_enabled", texts.windowEnabled),
      window_temperature: windowSwitch(room, id, "window_temperature", texts.windowTemperature),
      window_action: windowSelect(
        room,
        id,
        "window_action",
        texts.windowAction,
        WINDOW_ACTIONS.map((action) => texts.windowActionOptions[action]),
      ),
      window_end: windowSelect(
        room,
        id,
        "window_end",
        texts.windowEnd,
        WINDOW_ENDS.map((end) => texts.windowEndOptions[end]),
      ),
      window_limit: windowSelect(
        room,
        id,
        "window_limit",
        texts.windowLimit,
        texts.windowLimitOptions,
      ),
      window_manual_change: windowSelect(
        room,
        id,
        "window_manual_change",
        texts.windowManualChange,
        MANUAL_CHANGES.map((change) => texts.windowManualChangeOptions[change]),
      ),
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
        name: texts.problem,
        default_entity_id: entityId("binary_sensor", undefined, "problem"),
        state_topic: SYSTEM_STATE_TOPIC,
        device_class: "problem",
        value_template: template("problem"),
      },
      problem_count: {
        platform: "sensor",
        unique_id: "heatmaster_problem_count",
        name: texts.problemCount,
        default_entity_id: entityId("sensor", undefined, "problem_count"),
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
        default_entity_id: entityId("binary_sensor", undefined, "held"),
        state_topic: SYSTEM_STATE_TOPIC,
        value_template: template("held"),
      },
      stop_writing: {
        platform: "button",
        unique_id: "heatmaster_stop_writing",
        name: texts.stopWriting,
        default_entity_id: entityId("button", undefined, "stop_writing"),
        command_topic: PRESS_TOPIC,
        payload_press: PRESS_PAYLOAD,
      },
    },
  });
}

/** The rooms Heatmaster manages: only they have a device. */
function managedRooms(state: StateView): readonly RoomView[] {
  return state.rooms.filter((room) => room.managed);
}

/**
 * Topic → JSON text: the system device first, then the managed rooms in order (only when the
 * config is ok). A room's ids come from its room id, the Home Assistant area id; its name is the
 * area's name.
 */
export function configMessages(
  state: StateView,
  options: DiscoveryOptions,
): ReadonlyMap<string, string> {
  const texts = ENTITY_TEXTS[state.language];
  const messages = new Map<string, string>();
  messages.set(systemConfigTopic(options.prefix), systemConfig(texts, options));
  if (state.configState !== "ok") return messages;
  for (const room of managedRooms(state)) {
    messages.set(
      roomConfigTopic(options.prefix, room.roomId),
      roomConfig(room, state.schedules, texts, options),
    );
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

const MODES = { schedule: "auto", override: "heat", off: "off" } as const;

function isoOrNull(at: number | undefined): string | null {
  return at === undefined ? null : new Date(at).toISOString();
}

/** Who made the room's state, in words: a valve is named, as the valve list names it. */
function originText(room: RoomView, state: StateView): string | null {
  const origin = room.thermostat?.origin;
  if (origin === undefined) return null;
  if (origin.source !== "valve") return origin.source;
  const valve = state.valves.find((candidate) => candidate.valveId === origin.valveId);
  return `valve ${valve?.name ?? origin.valveId ?? ""}`.trimEnd();
}

/** The part of a room's state message that belongs to its thermostat (R14). */
function thermostatPayload(room: RoomView, state: StateView): Record<string, unknown> {
  const thermostat = room.thermostat;
  const texts = ENTITY_TEXTS[state.language];
  return {
    mode: thermostat === undefined ? null : MODES[thermostat.kind],
    preset: thermostat?.preset ?? "none",
    action:
      thermostat?.kind === "off" || room.window?.holdsValves === true
        ? "off"
        : room.heating === true
          ? "heating"
          : "idle",
    rule: thermostat?.rule ?? null,
    ends_at: isoOrNull(thermostat?.endsAt),
    origin: originText(room, state),
    next_change_at: isoOrNull(room.nextChangeAt),
    next_target: room.nextTarget ?? null,
    schedule: room.scheduleName ?? null,
    override_end:
      room.overrideEnd === undefined ? null : texts.overrideEndOptions[room.overrideEnd],
    ...windowPayload(room, texts),
  };
}

/** The room's limit as an option text; a limit off the list (set in the editor) has none (W10). */
function limitText(limitMs: number | null, texts: EntityTexts): string | null {
  if (limitMs === null) return texts.windowLimitOptions[WINDOW_LIMIT_CHOICES_MS.length] ?? null;
  const index = WINDOW_LIMIT_CHOICES_MS.indexOf(limitMs);
  return index < 0 ? null : (texts.windowLimitOptions[index] ?? null);
}

/** The part of a room's state message that belongs to its window entities. */
function windowPayload(room: RoomView, texts: EntityTexts): Record<string, unknown> {
  const settings = room.windowSettings;
  const opening = room.window;
  return {
    window: onOff(opening?.holdsValves === true),
    window_state: opening?.state ?? null,
    // The climate's `window` attribute: a dropped opening still holds the valves, so it reads open.
    window_attr:
      opening === undefined ? null : opening.state === "dropped" ? "open" : opening.state,
    window_triggers: opening?.triggers ?? [],
    window_since: isoOrNull(opening?.since),
    window_enabled: settings === undefined ? null : onOff(settings.enabled),
    window_temperature: settings === undefined ? null : onOff(settings.temperature.enabled),
    window_action: settings === undefined ? null : texts.windowActionOptions[settings.action],
    window_end: settings === undefined ? null : texts.windowEndOptions[settings.temperature.end],
    window_limit: settings === undefined ? null : limitText(settings.limitMs, texts),
    window_manual_change:
      settings === undefined ? null : texts.windowManualChangeOptions[settings.manualChange],
  };
}

/** Topic → JSON text: the managed rooms in order, then the system state, then the problems. */
export function stateMessages(state: StateView): ReadonlyMap<string, string> {
  const messages = new Map<string, string>();
  for (const room of managedRooms(state)) {
    messages.set(
      roomStateTopic(room.roomId),
      JSON.stringify({
        temperature: room.currentTemperature ?? null,
        target: room.thermostat?.kind === "off" ? null : (room.target ?? null),
        problem: onOff(room.degraded || room.hasProblem),
        sync: room.sync,
        ...thermostatPayload(room, state),
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
  roomCommand(roomId: string, command: ThermostatCommand): Promise<unknown>;
  roomChoice(roomId: string, choice: RoomChoice): Promise<unknown>;
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
  const warn = (message: string, data: Readonly<Record<string, unknown>>): void => {
    log.warn(message, data);
  };
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
    const present = new Set(managedRooms(state).map((room) => room.roomId));
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
          if (state !== undefined && !isStopped()) {
            // A throw while building the messages must not reject the loop: nobody awaits a
            // resend, and an unhandled rejection would end the process.
            try {
              await pass(state);
            } catch (error) {
              logError("discovery messages could not be built", error);
            }
          }
        } while (wanted());
      } finally {
        running = undefined;
      }
    })();
    running = loop;
    return loop;
  }

  /** What a room command asks of the thermostat, or undefined when it asks nothing usable. */
  function parseCommand(
    state: StateView,
    what: string,
    text: string,
  ): ThermostatCommand | RoomChoice | undefined {
    switch (what) {
      case "mode":
        if (text === "auto") return { kind: "resume" };
        if (text === "heat") return { kind: "heat" };
        return text === "off" ? { kind: "off", end: undefined } : undefined;
      case "temperature": {
        const celsius = Number(text);
        return text.trim() !== "" && Number.isFinite(celsius)
          ? { kind: "set_target", celsius, end: undefined }
          : undefined;
      }
      case "preset": {
        const preset = PRESET_NAMES.find((name) => name === text);
        return preset === undefined ? undefined : { kind: "set_preset", preset, end: undefined };
      }
      case "schedule": {
        const schedule = state.schedules.find((candidate) => candidate.name === text);
        return schedule === undefined ? undefined : { kind: "schedule", scheduleId: schedule.id };
      }
      case "override_end": {
        const options = ENTITY_TEXTS[state.language].overrideEndOptions;
        const rule = END_RULES.find((candidate) => options[candidate] === text);
        return rule === undefined ? undefined : { kind: "override_end", rule };
      }
      case "window_enabled":
      case "window_temperature": {
        if (text !== "ON" && text !== "OFF") return undefined;
        return { kind: what, on: text === "ON" };
      }
      case "window_action": {
        const options = ENTITY_TEXTS[state.language].windowActionOptions;
        const action = WINDOW_ACTIONS.find((candidate) => options[candidate] === text);
        return action === undefined ? undefined : { kind: "window_action", action };
      }
      case "window_end": {
        const options = ENTITY_TEXTS[state.language].windowEndOptions;
        const end = WINDOW_ENDS.find((candidate) => options[candidate] === text);
        return end === undefined ? undefined : { kind: "window_end", end };
      }
      case "window_limit": {
        const options = ENTITY_TEXTS[state.language].windowLimitOptions;
        const index = options.indexOf(text);
        if (index < 0) return undefined;
        return { kind: "window_limit", limitMs: WINDOW_LIMIT_CHOICES_MS[index] };
      }
      case "window_manual_change": {
        const options = ENTITY_TEXTS[state.language].windowManualChangeOptions;
        const manualChange = MANUAL_CHANGES.find((candidate) => options[candidate] === text);
        return manualChange === undefined
          ? undefined
          : { kind: "window_manual_change", manualChange };
      }
      default:
        return undefined;
    }
  }

  function isRoomChoice(command: ThermostatCommand | RoomChoice): command is RoomChoice {
    return (
      command.kind === "schedule" ||
      command.kind === "override_end" ||
      command.kind.startsWith("window_")
    );
  }

  function onRoomCommand(topic: string, payload: Buffer, retained: boolean): void {
    if (retained) return;
    const parts = topic.split("/");
    const roomId = parts[2];
    const what = parts[4];
    const text = payload.toString("utf8");
    if (parts.length !== 5 || roomId === undefined || what === undefined) return;
    // `none` is what Home Assistant sends to leave a preset; an override is left by auto instead.
    if (what === "preset" && text === "none") return;
    const state = latest;
    const known = state?.rooms.some((room) => room.managed && room.roomId === roomId) === true;
    const command = state === undefined || !known ? undefined : parseCommand(state, what, text);
    if (command === undefined) {
      warn("a room command was not understood", { topic, payload: text });
      return;
    }
    void (async () => {
      try {
        if (isRoomChoice(command)) {
          await deps.roomChoice(roomId, command);
        } else {
          await deps.roomCommand(roomId, command);
        }
      } catch (error) {
        warn("a room command was refused", { topic, payload: text, err: String(error) });
      }
    })();
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
        mqtt.subscribe(ROOM_COMMANDS_FILTER, onRoomCommand),
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
