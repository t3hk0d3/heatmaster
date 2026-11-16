/** Every failure the server raises by itself. Callers and tests look at `code` and `data`. */
export class HeatmasterError extends Error {
  readonly code: string;
  readonly data: Readonly<Record<string, string>>;

  constructor(code: string, data: Readonly<Record<string, string>> = {}) {
    super(code);
    this.name = "HeatmasterError";
    this.code = code;
    this.data = data;
  }
}

/** Where a module reports a fault it cannot throw; `main` passes Fastify's logger. */
export type ErrorLog = Readonly<{
  error(message: string, data?: Readonly<Record<string, unknown>>): void;
}>;

/** The log of a module that is used on its own (tests): one JSON line on stderr. */
export const consoleErrorLog: ErrorLog = {
  error(message, data) {
    console.error(JSON.stringify({ level: "error", msg: message, ...data }));
  },
};
