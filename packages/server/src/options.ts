/** The one place that reads the environment. */

export const API_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3000;

export type Options = Readonly<{ port: number }>;

function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  const port = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`HEATMASTER_PORT must be a whole number from 1 to 65535, got "${value}"`);
  }
  return port;
}

export function loadOptions(env: Readonly<Record<string, string | undefined>>): Options {
  return { port: parsePort(env.HEATMASTER_PORT) };
}
