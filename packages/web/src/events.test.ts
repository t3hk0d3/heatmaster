import type { StateView } from "@heatmaster/core";
import { describe, expect, it } from "vitest";
import { RECONNECT_STEPS_MS, connectEvents } from "./events.ts";
import type { ConnectionStatus, EventsDeps, SocketLike } from "./events.ts";
import { stateView } from "../test/builders.ts";

class FakeSocket implements SocketLike {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.(new Event("open"));
  }
  say(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
  drop(): void {
    this.onclose?.({} as CloseEvent);
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const timers = new Map<number, Readonly<{ run: () => void; ms: number }>>();
  const waits: number[] = [];
  let next = 1;
  const deps: EventsDeps = {
    open: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    setTimer: (run, ms) => {
      const handle = next++;
      timers.set(handle, { run, ms });
      waits.push(ms);
      return handle;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  };
  const statuses: ConnectionStatus[] = [];
  const states: StateView[] = [];
  const events = connectEvents(
    "ws://x/api/events",
    { onState: (s) => states.push(s), onStatus: (s) => statuses.push(s) },
    deps,
  );
  const fireTimers = (): void => {
    for (const [handle, timer] of [...timers]) {
      timers.delete(handle);
      timer.run();
    }
  };
  return { sockets, timers, waits, statuses, states, events, fireTimers };
}

describe("events", () => {
  describe("connectEvents", () => {
    describe("At once", () => {
      it('opens the socket and reports "connecting"', () => {
        const { sockets, statuses } = setup();
        expect(sockets).toHaveLength(1);
        expect(statuses).toEqual(["connecting"]);
      });
    });

    describe("When the socket opens", () => {
      it('reports "live"', () => {
        const { sockets, statuses } = setup();
        sockets[0]?.open();
        expect(statuses.at(-1)).toBe("live");
      });
    });

    describe("With a state message", () => {
      it("calls onState with its state", () => {
        const { sockets, states } = setup();
        const state = stateView({ revision: 9 });
        sockets[0]?.say(JSON.stringify({ type: "state", state }));
        expect(states).toEqual([state]);
      });
    });

    describe("With a message that is not JSON, or JSON of another type", () => {
      it("calls nothing and does not throw", () => {
        const { sockets, states, statuses } = setup();
        const before = statuses.length;
        sockets[0]?.say("{nope");
        sockets[0]?.say(JSON.stringify({ type: "other", state: {} }));
        sockets[0]?.say(JSON.stringify(null));
        sockets[0]?.say(new ArrayBuffer(2));
        expect(states).toEqual([]);
        expect(statuses).toHaveLength(before);
      });
    });

    describe("When the socket closes", () => {
      it('reports "lost"', () => {
        const { sockets, statuses } = setup();
        sockets[0]?.open();
        sockets[0]?.drop();
        expect(statuses.at(-1)).toBe("lost");
      });

      it("opens a new socket after 1 s", () => {
        const { sockets, waits, fireTimers } = setup();
        sockets[0]?.drop();
        expect(waits).toEqual([1000]);
        expect(sockets).toHaveLength(1);
        fireTimers();
        expect(sockets).toHaveLength(2);
      });
    });

    describe("With the socket closing again and again without opening", () => {
      it("the waits are 1 s, 2 s, 5 s, 10 s, 10 s", () => {
        const { sockets, waits, fireTimers } = setup();
        for (let i = 0; i < 5; i += 1) {
          sockets.at(-1)?.drop();
          fireTimers();
        }
        expect(waits).toEqual([1000, 2000, 5000, 10_000, 10_000]);
        expect(RECONNECT_STEPS_MS).toEqual([1000, 2000, 5000, 10_000]);
      });
    });

    describe("When a socket opens after three failures", () => {
      it("the next wait is 1 s again", () => {
        const { sockets, waits, fireTimers } = setup();
        for (let i = 0; i < 3; i += 1) {
          sockets.at(-1)?.drop();
          fireTimers();
        }
        sockets.at(-1)?.open();
        sockets.at(-1)?.drop();
        expect(waits.at(-1)).toBe(1000);
      });
    });

    describe("close", () => {
      it("closes the socket and leaves no timer", () => {
        const { sockets, timers, events } = setup();
        sockets[0]?.drop();
        expect(timers.size).toBe(1);
        events.close();
        expect(timers.size).toBe(0);
        const open = setup();
        open.events.close();
        expect(open.sockets[0]?.closed).toBe(true);
      });

      it("no further socket is opened", () => {
        const { sockets, events, fireTimers } = setup();
        events.close();
        sockets[0]?.drop();
        fireTimers();
        expect(sockets).toHaveLength(1);
      });
    });
  });
});
