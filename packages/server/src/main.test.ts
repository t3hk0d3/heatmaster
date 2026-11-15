import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { describe, expect, it } from "vitest";
import { API_HOST } from "./options.ts";
import { start } from "./main.ts";

const SERVER_DIR = path.resolve(import.meta.dirname, "..");
const MAIN = path.join(SERVER_DIR, "src/main.ts");
const VERSION = (
  JSON.parse(readFileSync(path.join(SERVER_DIR, "package.json"), "utf8")) as { version: string }
).version;

/** Opens a listener of its own on a free port. */
async function listener(): Promise<{ port: number; close(): Promise<void> }> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, API_HOST, resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** Finds a free port the way the tests describe: open a listener, note the port, close it. */
async function freePort(): Promise<number> {
  const probe = await listener();
  await probe.close();
  return probe.port;
}

function accepts(port: number, host = API_HOST): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });
}

function runMain(port: number): {
  child: ChildProcess;
  lines: string[];
  exited: Promise<number | null>;
} {
  const child = spawn(process.execPath, [MAIN], {
    cwd: SERVER_DIR,
    env: { ...process.env, HEATMASTER_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: string[] = [];
  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream }).on("line", (line) => lines.push(line));
  }
  const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
  return { child, lines, exited };
}

async function logLine(lines: string[], text: string, exited: Promise<unknown>): Promise<string> {
  const state = { stopped: false };
  void exited.then(() => {
    state.stopped = true;
  });
  for (;;) {
    const found = lines.find((line) => line.includes(text));
    if (found !== undefined) return found;
    if (state.stopped) throw new Error(`the process ended before it logged ${text}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("server package", () => {
  describe("workspace link", () => {
    describe('When Node, started in packages/server, imports "@heatmaster/core"', () => {
      it("it loads packages/core/src/index.ts as it is, with no build step", () => {
        const result = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            'await import("@heatmaster/core"); console.log(import.meta.resolve("@heatmaster/core"));',
          ],
          { cwd: SERVER_DIR, encoding: "utf8" },
        );
        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toMatch(/\/packages\/core\/src\/index\.ts$/);
      });
    });
  });
});

describe("main", () => {
  describe("start", () => {
    describe("With a free port", () => {
      it("resolves, and GET /api/health on 127.0.0.1 at that port answers 200 with status ok and the server package's version", async () => {
        const port = await freePort();
        const running = await start({ port }, false);
        try {
          const response = await fetch(`http://127.0.0.1:${String(port)}/api/health`);
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ status: "ok", version: VERSION });
        } finally {
          await running.stop();
        }
      });

      it("the server's address is 127.0.0.1", async () => {
        const port = await freePort();
        const running = await start({ port }, false);
        try {
          expect(await accepts(port, "127.0.0.1")).toBe(true);
          // Another loopback address reaches only a listener that is not bound to 127.0.0.1 alone.
          expect(await accepts(port, "127.0.0.2")).toBe(false);
        } finally {
          await running.stop();
        }
      });
    });

    describe("With a port that is already in use", () => {
      it("rejects, and nothing is left listening", async () => {
        const taken = await listener();
        try {
          await expect(start({ port: taken.port }, false)).rejects.toThrow();
        } finally {
          await taken.close();
        }
        expect(await accepts(taken.port)).toBe(false);
      });
    });
  });

  describe("stop", () => {
    describe("After start", () => {
      it("resolves, and the port no longer accepts connections", async () => {
        const port = await freePort();
        const running = await start({ port }, false);
        await running.stop();
        expect(await accepts(port)).toBe(false);
      });
    });

    describe("Called a second time", () => {
      it("resolves and does nothing", async () => {
        const running = await start({ port: await freePort() }, false);
        await running.stop();
        await expect(running.stop()).resolves.toBeUndefined();
      });
    });
  });

  describe("process (node packages/server/src/main.ts with HEATMASTER_PORT set to a free port)", () => {
    describe("On start", () => {
      it("writes one log line that holds the address it listens on", async () => {
        const port = await freePort();
        const { child, lines, exited } = runMain(port);
        try {
          await logLine(lines, `127.0.0.1:${String(port)}`, exited);
          expect(lines.filter((line) => line.includes(`127.0.0.1:${String(port)}`))).toHaveLength(
            1,
          );
        } finally {
          child.kill("SIGTERM");
          await exited;
        }
      });
    });

    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      describe(`On ${signal}`, () => {
        it("ends with exit code 0", async () => {
          const port = await freePort();
          const { child, lines, exited } = runMain(port);
          try {
            await logLine(lines, `127.0.0.1:${String(port)}`, exited);
            child.kill(signal);
            expect(await exited).toBe(0);
          } finally {
            child.kill("SIGKILL");
          }
        });
      });
    }

    describe("With HEATMASTER_PORT set to a port that is in use", () => {
      it("ends with exit code 1 after logging the error", async () => {
        const taken = await listener();
        try {
          const { lines, exited } = runMain(taken.port);
          expect(await exited).toBe(1);
          expect(lines.join("\n")).toMatch(/EADDRINUSE/);
        } finally {
          await taken.close();
        }
      });
    });
  });
});
