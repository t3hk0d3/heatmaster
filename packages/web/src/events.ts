import type { EventMessage, StateView } from "@heatmaster/core";

export const RECONNECT_STEPS_MS: readonly number[] = [1000, 2000, 5000, 10_000];

export type ConnectionStatus = "connecting" | "live" | "lost";

/** The four handlers and `close()` of a browser `WebSocket`. */
export interface SocketLike {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

export type EventsDeps = Readonly<{
  open(url: string): SocketLike;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}>;

function isStateMessage(value: unknown): value is EventMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Readonly<Record<string, unknown>>;
  return message.type === "state" && typeof message.state === "object" && message.state !== null;
}

/**
 * Follows the server's event stream. After a close a new socket opens after the next step of
 * `RECONNECT_STEPS_MS`; the last step repeats and a socket that opens starts the steps again.
 * The server sends the whole state on connect, so nothing is fetched after a reconnect.
 */
export function connectEvents(
  url: string,
  handlers: Readonly<{
    onState(state: StateView): void;
    onStatus(status: ConnectionStatus): void;
  }>,
  deps: EventsDeps,
): Readonly<{ close(): void }> {
  let step = 0;
  let socket: SocketLike | undefined;
  let timer: unknown;
  let closed = false;

  function open(): void {
    timer = undefined;
    const current = deps.open(url);
    socket = current;
    current.onopen = () => {
      step = 0;
      handlers.onStatus("live");
    };
    current.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (isStateMessage(message)) handlers.onState(message.state);
    };
    current.onerror = () => {
      // A close follows every error.
    };
    current.onclose = () => {
      if (closed || socket !== current) return;
      handlers.onStatus("lost");
      const wait = RECONNECT_STEPS_MS[Math.min(step, RECONNECT_STEPS_MS.length - 1)] ?? 10_000;
      step += 1;
      timer = deps.setTimer(open, wait);
    };
  }

  handlers.onStatus("connecting");
  open();

  return {
    close() {
      closed = true;
      if (timer !== undefined) deps.clearTimer(timer);
      timer = undefined;
      socket?.close();
    },
  };
}
