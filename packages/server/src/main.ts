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
  let running: Running;
  try {
    running = await start(loadOptions(process.env));
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    running.stop().then(
      () => {
        process.exit(0);
      },
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (import.meta.main) {
  void run();
}
