/** The one place that reads the environment. */

import type { HaOptions } from "./ha-link.ts";
import type { MqttOptions } from "./mqtt.ts";
import { DEFAULT_BASE_TOPIC, type Z2mOptions } from "./z2m.ts";

export const API_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3000;
export const DEFAULT_DATA_DIR = "/data";
export const DEFAULT_PUBLIC_DIR = "/config";

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
}>;

/** A variable that is set to an empty text counts as not set. */
function read(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  const port = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`HEATMASTER_PORT must be a whole number from 1 to 65535, got "${value}"`);
  }
  return port;
}

function parseHa(env: Readonly<Record<string, string | undefined>>): HaOptions {
  const url = read(env, "HA_URL");
  const token = read(env, "HA_TOKEN");
  if (url === undefined && token === undefined) return undefined;
  if (url === undefined) throw new Error("HA_URL is required when HA_TOKEN is set");
  if (token === undefined) throw new Error("HA_TOKEN is required when HA_URL is set");
  return { url, token };
}

export function loadOptions(env: Readonly<Record<string, string | undefined>>): Options {
  const url = read(env, "MQTT_URL");
  if (url === undefined) throw new Error("MQTT_URL is required, for example mqtt://broker:1883");
  if (!/^mqtts?:\/\//.test(url)) {
    // The protocol-version fallback needs a tcp or tls stream (Task 15), so ws and wss are out.
    throw new Error(`MQTT_URL must start with mqtt:// or mqtts://, got "${url}"`);
  }
  return {
    port: parsePort(read(env, "HEATMASTER_PORT")),
    mqtt: {
      url,
      username: read(env, "MQTT_USERNAME"),
      password: read(env, "MQTT_PASSWORD"),
      // There is no variable for it: every instance must use the same client id.
      clientId: undefined,
    },
    z2m: { baseTopic: read(env, "Z2M_BASE_TOPIC") ?? DEFAULT_BASE_TOPIC },
    ha: parseHa(env),
    dataDir: read(env, "DATA_DIR") ?? DEFAULT_DATA_DIR,
    publicDir: read(env, "PUBLIC_DIR") ?? DEFAULT_PUBLIC_DIR,
  };
}
