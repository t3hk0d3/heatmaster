import type { ApiError, ApplyRequest, ConfigView, PlanView, StateView } from "@heatmaster/core";

export type Result<T> =
  Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; status: number; error: ApiError }>;

/** The path up to and including its last `/`, then `api/`. */
export function apiBase(pathname: string): string {
  return `${pathname.slice(0, pathname.lastIndexOf("/") + 1)}api/`;
}

/** The same base on `ws:` or `wss:`, then `events`. */
export function eventsUrl(pageUrl: string): string {
  const url = new URL(pageUrl);
  const scheme = url.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${url.host}${apiBase(url.pathname)}events`;
}

export type ApiClient = Readonly<{
  state(): Promise<Result<StateView>>;
  config(): Promise<Result<ConfigView>>;
  preview(request: ApplyRequest): Promise<Result<PlanView>>;
  apply(request: ApplyRequest): Promise<Result<PlanView>>;
  hold(on: boolean): Promise<Result<void>>;
  refresh(valveId: string): Promise<Result<void>>;
  restore(valveId: string): Promise<Result<void>>;
  forget(valveId: string): Promise<Result<void>>;
  importOriginals(acceptEmpty: boolean): Promise<Result<void>>;
  /** Joins a valve whose originals cannot be read, taking them as unknown. */
  acceptOriginals(valveId: string): Promise<Result<void>>;
  /** Hides the report of the conversion from an older configuration. */
  dismissUpgrade(): Promise<Result<void>>;
}>;

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isApiError(value: unknown): value is ApiError {
  return (
    isObject(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    isObject(value.data)
  );
}

/** An answer that is not an ApiError (Caddy's or ingress's own page) is `http_<status>`. */
function failure(status: number, error: ApiError): Result<never> {
  return { ok: false, status, error };
}

function foreignFailure(status: number): Result<never> {
  return failure(status, { code: `http_${String(status)}`, message: "", data: {} });
}

export function createClient(base: string, fetchFn: typeof fetch): ApiClient {
  async function call<T>(method: "GET" | "POST", path: string, body?: object): Promise<Result<T>> {
    let response: Response;
    let text: string;
    try {
      response = await fetchFn(`${base}${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      });
      text = await response.text();
    } catch {
      return failure(0, { code: "network", message: "", data: {} });
    }
    let parsed: unknown;
    try {
      parsed = text === "" ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (response.ok) {
      if (response.status === 204) return { ok: true, value: undefined as T };
      if (parsed === undefined) return foreignFailure(response.status);
      return { ok: true, value: parsed as T };
    }
    return isApiError(parsed) ? failure(response.status, parsed) : foreignFailure(response.status);
  }

  const valvePath = (valveId: string, action: string): string =>
    `valves/${encodeURIComponent(valveId)}/${action}`;

  return {
    state: () => call<StateView>("GET", "state"),
    config: () => call<ConfigView>("GET", "config"),
    preview: (request) => call<PlanView>("POST", "config/preview", request),
    apply: (request) => call<PlanView>("POST", "config", request),
    hold: (on) => call<undefined>("POST", "hold", { on }),
    refresh: (valveId) => call<undefined>("POST", valvePath(valveId, "refresh"), {}),
    restore: (valveId) => call<undefined>("POST", valvePath(valveId, "restore"), {}),
    forget: (valveId) => call<undefined>("POST", valvePath(valveId, "forget"), {}),
    importOriginals: (acceptEmpty) => call<undefined>("POST", "originals/import", { acceptEmpty }),
    acceptOriginals: (valveId) =>
      call<undefined>("POST", valvePath(valveId, "accept-originals"), {}),
    dismissUpgrade: () => call<undefined>("POST", "upgrade/dismiss", {}),
  };
}
