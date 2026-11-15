import Fastify from "fastify";
import pkg from "../package.json" with { type: "json" };
import { API_HOST, loadOptions, type Options } from "./options.ts";

export type Running = Readonly<{ stop(): Promise<void> }>;

export async function start(options: Options, logger = true): Promise<Running> {
  const app = Fastify({ logger });
  app.get("/api/health", () => ({ status: "ok", version: pkg.version }));
  try {
    await app.listen({ host: API_HOST, port: options.port });
  } catch (error) {
    await app.close();
    throw error;
  }
  let stopping: Promise<void> | undefined;
  return {
    stop: () => (stopping ??= app.close()),
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
    startup
      .then((running) => running.stop())
      .then(
        () => {
          process.exit(0);
        },
        () => {
          // A failed start is reported (and ends the process with 1) below.
          process.exit(1);
        },
      );
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
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
