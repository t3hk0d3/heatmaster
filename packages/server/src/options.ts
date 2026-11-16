/** The one place that reads the environment. */

import path from "node:path";

import type { HaOptions } from "./ha-link.ts";
import type { MqttOptions } from "./mqtt.ts";
import { DEFAULT_BASE_TOPIC, type Z2mOptions } from "./z2m.ts";

export const API_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3000;
export const DEFAULT_DATA_DIR = "/data";
export const DEFAULT_PUBLIC_DIR = "/config";
export const DEFAULT_DISCOVERY_PREFIX = "homeassistant";

export type Options = Readonly<{
  port: number;
  mqtt: MqttOptions;
  z2m: Z2mOptions;
  /** Undefined means "no Home Assistant link". */
  ha: HaOptions;
  /** The folder of the config and ledger files. */
  dataDir: string;
  /** The public config folder that holds the readable copy of the originals. */
  publicDir: string;
  /** The MQTT discovery prefix of Home Assistant. */
  discoveryPrefix: string;
}>;

export type OptionsIssue = Readonly<{ variable: string; code: string; message: string }>;

/** Every fault of the environment at once. No message holds the value of a secret. */
export class OptionsError extends Error {
  readonly issues: readonly OptionsIssue[];

  constructor(issues: readonly OptionsIssue[]) {
    super(issues.map((issue) => issue.message).join("; "));
    this.name = "OptionsError";
    this.issues = issues;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

/** A variable that is set to an empty text counts as not set. */
function read(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

function parseUrl(text: string, schemes: readonly string[]): URL | undefined {
  try {
    const url = new URL(text);
    return schemes.includes(url.protocol) && url.hostname !== "" ? url : undefined;
  } catch {
    return undefined;
  }
}

const MAX_TOPIC_LENGTH = 128;

function topicValid(topic: string): boolean {
  return (
    topic.length >= 1 &&
    topic.length <= MAX_TOPIC_LENGTH &&
    !/[+# ]|\p{Cc}/u.test(topic) &&
    !topic.startsWith("/") &&
    !topic.endsWith("/")
  );
}

const RESERVED_TOPIC = "heatmaster";

export function loadOptions(env: Env): Options {
  const issues: OptionsIssue[] = [];
  const add = (variable: string, code: string, message: string): void => {
    issues.push({ variable, code, message });
  };

  const mqttUrl = read(env, "MQTT_URL");
  if (mqttUrl === undefined) {
    add("MQTT_URL", "missing", "MQTT_URL is required, for example mqtt://broker:1883");
  } else {
    // The protocol-version fallback needs a tcp or tls stream (Task 15), so ws and wss are out.
    const parsed = parseUrl(mqttUrl, ["mqtt:", "mqtts:"]);
    if (parsed === undefined) {
      add(
        "MQTT_URL",
        "url_invalid",
        "MQTT_URL must be a URL that starts with mqtt:// or mqtts:// and names a host",
      );
    } else if (parsed.username !== "" || parsed.password !== "") {
      add(
        "MQTT_URL",
        "credentials_in_url",
        "MQTT_URL must not hold a user or a password; use MQTT_USERNAME and MQTT_PASSWORD",
      );
    }
  }
  const username = read(env, "MQTT_USERNAME");
  const password = read(env, "MQTT_PASSWORD");
  if (password !== undefined && username === undefined) {
    add(
      "MQTT_PASSWORD",
      "password_without_username",
      "MQTT_PASSWORD needs MQTT_USERNAME to be set too",
    );
  }

  const haUrl = read(env, "HA_URL");
  const haToken = read(env, "HA_TOKEN");
  let ha: HaOptions;
  if (haUrl === undefined && haToken !== undefined) {
    add("HA_URL", "pair_incomplete", "HA_URL is required when HA_TOKEN is set");
  } else if (haToken === undefined && haUrl !== undefined) {
    add("HA_TOKEN", "pair_incomplete", "HA_TOKEN is required when HA_URL is set");
  } else if (haUrl !== undefined && haToken !== undefined) {
    if (parseUrl(haUrl, ["http:", "https:"]) === undefined) {
      add("HA_URL", "url_invalid", "HA_URL must be a URL that starts with http:// or https://");
    } else {
      ha = { url: haUrl, token: haToken };
    }
  }

  const dataDir = read(env, "DATA_DIR") ?? DEFAULT_DATA_DIR;
  const publicDir = read(env, "PUBLIC_DIR") ?? DEFAULT_PUBLIC_DIR;
  const dataAbsolute = path.isAbsolute(dataDir);
  const publicAbsolute = path.isAbsolute(publicDir);
  if (!dataAbsolute) {
    add("DATA_DIR", "path_not_absolute", "DATA_DIR must be an absolute path");
  }
  if (!publicAbsolute) {
    add("PUBLIC_DIR", "path_not_absolute", "PUBLIC_DIR must be an absolute path");
  }
  if (dataAbsolute && publicAbsolute && path.resolve(dataDir) === path.resolve(publicDir)) {
    add("PUBLIC_DIR", "same_directory", "PUBLIC_DIR must not be the same folder as DATA_DIR");
  }

  const baseTopic = read(env, "Z2M_BASE_TOPIC") ?? DEFAULT_BASE_TOPIC;
  const discoveryPrefix = read(env, "DISCOVERY_PREFIX") ?? DEFAULT_DISCOVERY_PREFIX;
  const baseValid = topicValid(baseTopic);
  const prefixValid = topicValid(discoveryPrefix);
  if (!baseValid) {
    add("Z2M_BASE_TOPIC", "topic_invalid", "Z2M_BASE_TOPIC is not a usable MQTT topic");
  }
  if (!prefixValid) {
    add("DISCOVERY_PREFIX", "topic_invalid", "DISCOVERY_PREFIX is not a usable MQTT topic");
  }
  if (baseValid && baseTopic === RESERVED_TOPIC) {
    add("Z2M_BASE_TOPIC", "topic_conflict", `Z2M_BASE_TOPIC must not be "${RESERVED_TOPIC}"`);
  }
  if (prefixValid && discoveryPrefix === RESERVED_TOPIC) {
    add("DISCOVERY_PREFIX", "topic_conflict", `DISCOVERY_PREFIX must not be "${RESERVED_TOPIC}"`);
  }
  if (baseValid && prefixValid && baseTopic === discoveryPrefix) {
    add("DISCOVERY_PREFIX", "topic_conflict", "DISCOVERY_PREFIX must differ from Z2M_BASE_TOPIC");
  }

  const portText = read(env, "HEATMASTER_PORT");
  let port = DEFAULT_PORT;
  if (portText !== undefined) {
    const value = /^\d+$/.test(portText) ? Number(portText) : Number.NaN;
    if (Number.isInteger(value) && value >= 1 && value <= 65535) {
      port = value;
    } else {
      add(
        "HEATMASTER_PORT",
        "port_invalid",
        "HEATMASTER_PORT must be a whole number from 1 to 65535",
      );
    }
  }

  if (issues.length > 0 || mqttUrl === undefined) throw new OptionsError(issues);
  return {
    port,
    mqtt: {
      url: mqttUrl,
      username,
      password,
      // There is no variable for it: every instance must use the same client id.
      clientId: undefined,
    },
    z2m: { baseTopic },
    ha,
    dataDir,
    publicDir,
    discoveryPrefix,
  };
}

const MASK = "***";

/** The options for the start-up log line: the password and the token are masked. */
export function redactOptions(options: Options): Readonly<Record<string, unknown>> {
  return {
    port: options.port,
    mqtt: {
      url: options.mqtt.url,
      ...(options.mqtt.username === undefined ? {} : { username: options.mqtt.username }),
      ...(options.mqtt.password === undefined ? {} : { password: MASK }),
    },
    z2m: options.z2m,
    ...(options.ha === undefined ? {} : { ha: { url: options.ha.url, token: MASK } }),
    dataDir: options.dataDir,
    publicDir: options.publicDir,
    discoveryPrefix: options.discoveryPrefix,
  };
}
