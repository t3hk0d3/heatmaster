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
