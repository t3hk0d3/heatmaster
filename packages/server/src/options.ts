/** The one place that reads the environment. */

import type { MqttOptions } from "./mqtt.ts";
import { DEFAULT_BASE_TOPIC, type Z2mOptions } from "./z2m.ts";

export const API_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3000;

export type Options = Readonly<{ port: number; mqtt: MqttOptions; z2m: Z2mOptions }>;

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

export function loadOptions(env: Readonly<Record<string, string | undefined>>): Options {
  const url = read(env, "MQTT_URL");
  if (url === undefined) throw new Error("MQTT_URL is required, for example mqtt://broker:1883");
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
  };
}
