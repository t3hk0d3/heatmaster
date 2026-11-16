import type { FastifyBaseLogger } from "fastify";
import pkg from "../package.json" with { type: "json" };
import { buildApi, startApi, type ApiRuntime } from "./api.ts";
import { systemClock, type Clock } from "./clock.ts";
import { buildHaLink, type HaLog } from "./ha-link.ts";
import { createDiscovery, type Discovery } from "./discovery.ts";
import { createMqttClient, DEFAULT_TUNING, type MqttClient } from "./mqtt.ts";
import { loadOptions, type Options } from "./options.ts";
import { createRuntime, type HeatmasterRuntime, type RuntimeLog } from "./runtime.ts";
import { createConfigStore, createLedgerStore } from "./stores.ts";
import { stateView } from "./views.ts";
import { buildTransports } from "./z2m.ts";

export type Running = Readonly<{
  runtime: HeatmasterRuntime;
  discovery: Discovery;
  stop(): Promise<void>;
}>;

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

/** The API's view of a runtime that does not exist yet: every call goes to it once it does. */
function lateRuntime(current: () => HeatmasterRuntime): ApiRuntime {
  return {
    snapshot: () => current().snapshot(),
    subscribe: (listener) => current().subscribe(listener),
    apply: (raw, options) => current().apply(raw, options),
    preview: (raw, options) => current().preview(raw, options),
    exportConfig: () => current().exportConfig(),
    resync: (roomId) => current().resync(roomId),
    refreshValve: (valveId) => current().refreshValve(valveId),
    restoreValve: (valveId) => current().restoreValve(valveId),
    forgetValve: (valveId) => current().forgetValve(valveId),
    importOriginals: (acceptEmpty) => current().importOriginals(acceptEmpty),
    setHold: (on) => current().setHold(on),
    diagnostics: () => current().diagnostics(),
  };
}

/**
 * Starts the API, with `ready` false, then the MQTT client, the transports, the Home Assistant
 * link, the stores and the runtime; `ready` turns true when all of that has started. `logger`
 * false silences Fastify's logger (tests).
 */
export async function start(
  options: Options,
  clock: Clock = systemClock,
  logger = true,
): Promise<Running> {
  let ready = false;
  // Set once the API listens: the API is built before the things it will talk to.
  const late: { mqtt?: MqttClient; runtime?: HeatmasterRuntime } = {};
  let unsubscribe: (() => void) | undefined;
  const app = buildApi(
    {
      runtime: lateRuntime(() => {
        if (late.runtime === undefined) throw new Error("the runtime has not been built yet");
        return late.runtime;
      }),
      ready: () => ready,
      mqttFault: () => late.mqtt?.fault(),
      version: pkg.version,
    },
    logger,
  );
  await startApi(app, options.port);
  const log = runtimeLog(app.log);
  const mqtt = createMqttClient(options.mqtt, clock, DEFAULT_TUNING, log);
  late.mqtt = mqtt;
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
  late.runtime = runtime;
  const discovery = createDiscovery({
    mqtt,
    stopWriting: () => runtime.setHold(true),
    options: { prefix: options.discoveryPrefix, version: pkg.version },
    log,
  });
  const shutdown = async (): Promise<void> => {
    ready = false;
    unsubscribe?.();
    try {
      await discovery.stop();
    } finally {
      await stopRest();
    }
  };
  const stopRest = async (): Promise<void> => {
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
    // The runtime's first tick has run already, so the first state is given by hand.
    await discovery.start();
    unsubscribe = runtime.subscribe((snapshot) => {
      void discovery.sync(stateView(snapshot));
    });
    await discovery.sync(stateView(runtime.snapshot()));
    ready = true;
  } catch (error) {
    await shutdown();
    throw error;
  }
  let stopping: Promise<void> | undefined;
  return {
    runtime,
    discovery,
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
