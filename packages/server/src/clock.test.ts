import { describe, expect, it, vi } from "vitest";
import { createManualClock } from "../test/manual-clock.ts";
import { systemClock } from "./clock.ts";

function later(ms: number): Promise<void> {
  return new Promise((resolve) => {
    systemClock.after(ms, resolve);
  });
}

describe("clock", () => {
  describe("systemClock", () => {
    describe("nowMs", () => {
      it("is within one second of the system's time", () => {
        expect(Math.abs(systemClock.nowMs() - Date.now())).toBeLessThan(1000);
      });
    });

    describe("monoMs", () => {
      it("never goes down between two calls", () => {
        let previous = systemClock.monoMs();
        for (let i = 0; i < 1000; i += 1) {
          const current = systemClock.monoMs();
          expect(current).toBeGreaterThanOrEqual(previous);
          previous = current;
        }
      });
    });

    describe("after", () => {
      it("runs the callback once, no sooner than the given time", async () => {
        const run = vi.fn();
        const started = systemClock.monoMs();
        systemClock.after(20, run);
        await later(60);
        expect(run).toHaveBeenCalledTimes(1);
        // Timers may fire a millisecond early against a finer clock.
        expect(systemClock.monoMs() - started).toBeGreaterThanOrEqual(19);
      });

      it("the returned function cancels it: the callback never runs", async () => {
        const run = vi.fn();
        const cancel = systemClock.after(10, run);
        cancel();
        await later(40);
        expect(run).not.toHaveBeenCalled();
      });
    });

    describe("every", () => {
      it("runs the callback again and again until the returned function is called", async () => {
        const run = vi.fn();
        const cancel = systemClock.every(5, run);
        await vi.waitFor(() => {
          expect(run.mock.calls.length).toBeGreaterThanOrEqual(3);
        });
        cancel();
        const calls = run.mock.calls.length;
        await later(40);
        expect(run).toHaveBeenCalledTimes(calls);
      });
    });
  });

  describe("ManualClock", () => {
    describe("advance", () => {
      it("moves nowMs and monoMs by the same amount and runs the due callbacks in time order", () => {
        const clock = createManualClock(1_000_000);
        const order: string[] = [];
        clock.after(300, () => order.push(`c@${String(clock.monoMs())}`));
        clock.after(100, () => order.push(`a@${String(clock.monoMs())}`));
        clock.every(150, () => order.push(`e@${String(clock.monoMs())}`));
        clock.after(900, () => order.push("never"));
        const mono = clock.monoMs();
        clock.advance(400);
        expect(order).toEqual(["a@100", "e@150", "c@300", "e@300"]);
        expect(clock.monoMs() - mono).toBe(400);
        expect(clock.nowMs()).toBe(1_000_400);
      });
    });

    describe("jump", () => {
      it("moves nowMs alone and runs no callback", () => {
        const clock = createManualClock(5000);
        const run = vi.fn();
        clock.after(10, run);
        const mono = clock.monoMs();
        clock.jump(-2000);
        expect(clock.nowMs()).toBe(3000);
        expect(clock.monoMs()).toBe(mono);
        clock.jump(10_000);
        expect(clock.nowMs()).toBe(13_000);
        expect(run).not.toHaveBeenCalled();
      });
    });

    describe("pending", () => {
      it("counts the timers that were not cancelled", () => {
        const clock = createManualClock(0);
        const cancelOne = clock.after(10, () => undefined);
        clock.after(20, () => undefined);
        const cancelEvery = clock.every(5, () => undefined);
        expect(clock.pending()).toBe(3);
        cancelOne();
        cancelEvery();
        expect(clock.pending()).toBe(1);
        clock.advance(20);
        expect(clock.pending()).toBe(0);
      });
    });
  });
});
