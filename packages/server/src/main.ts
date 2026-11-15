import Fastify, { type FastifyBaseLogger } from "fastify";
import pkg from "../package.json" with { type: "json" };
import { systemClock, type Clock } from "./clock.ts";
import { buildHaLink, type HaLog } from "./ha-link.ts";
import { createMqttClient } from "./mqtt.ts";
import { API_HOST, loadOptions, type Options } from "./options.ts";
import { createRuntime, type HeatmasterRuntime, type RuntimeLog } from "./runtime.ts";
import { createConfigStore, createLedgerStore } from "./stores.ts";
import { buildTransports } from "./z2m.ts";

export type Running = Readonly<{ runtime: HeatmasterRuntime; stop(): Promise<void> }>;

/** The runtime's and the Home Assistant link's log lines go through Fastify's logger. */
function runtimeLog(logger: FastifyBaseLogger): RuntimeLog & HaLog {
  return {
    info: (message, data) => {
      logger.info(data ?? {}, message);
    },
    warn: (message, data) => {
      logger.warn(data ?? {}, message);
    },
    error: (message, data) => {
      logger.error(data ?? {}, message);
    },
  };
}

/**
 * Starts the API, then the MQTT client, the transports, the Home Assistant link, the stores and
 * the runtime. `logger` false silences Fastify's logger (tests).
 */
export async function start(
  options: Options,
  clock: Clock = systemClock,
  logger = true,
): Promise<Running> {
  const app = Fastify({ logger });
  app.get("/api/health", () => ({ status: "ok", version: pkg.version }));
  try {
    await app.listen({ host: API_HOST, port: options.port });
  } catch (error) {
    await app.close();
    throw error;
  }
  const log = runtimeLog(app.log);
  // The MQTT client and the Zigbee2MQTT transport take no logger; they write to console.error.
  const mqtt = createMqttClient(options.mqtt, clock);
  const runtime = createRuntime({
    configStore: createConfigStore(options.dataDir, clock),
    ledgerStore: createLedgerStore(
      { dataDir: options.dataDir, publicDir: options.publicDir },
      clock,
      pkg.version,
    ),
    transports: buildTransports(mqtt, options.z2m),
    ha: buildHaLink(options.ha, clock, log),
    clock,
    processTimeZone: Temporal.Now.timeZoneId(),
    log,
  });
  const shutdown = async (): Promise<void> => {
    try {
      await runtime.stop();
    } finally {
      try {
        await mqtt.end();
      } finally {
        await app.close();
      }
    }
  };
  try {
    await mqtt.connect();
    await runtime.start();
  } catch (error) {
    await shutdown();
    throw error;
  }
  let stopping: Promise<void> | undefined;
  return {
    runtime,
    stop: () => (stopping ??= shutdown()),
  };
}

async function run(): Promise<void> {
  // Handlers come first, so a signal that arrives while the server is starting is not lost.
  let startup: Promise<Running>;
  try {
    startup = start(loadOptions(process.env));
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    startup.then(
      async (running) => {
        try {
          await running.stop();
        } catch (error) {
          console.error(error);
          process.exit(1);
        }
        // Exit, do not wait: the Home Assistant library's reconnect timer (up to 5 s) and its
        // connect time-out outlive the link's stop.
        process.exit(0);
      },
      () => {
        // The start failed. The `await startup` below was registered first, so it has already
        // logged the error by the time this runs.
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  // Registered before any signal can arrive, so a failed start is logged before the shutdown
  // handler above gets to exit.
  try {
    await startup;
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

if (import.meta.main) {
  void run();
}
