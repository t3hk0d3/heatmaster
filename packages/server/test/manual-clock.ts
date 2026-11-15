import type { Clock } from "../src/clock.ts";

export type ManualClock = Clock &
  Readonly<{
    /** Moves `nowMs` and `monoMs` together and runs every due callback in time order. */
    advance(ms: number): void;
    /** Moves `nowMs` alone, forward or back, and runs nothing: the wall clock was set. */
    jump(ms: number): void;
    /** The number of timers that were not cancelled. */
    pending(): number;
  }>;

interface Timer {
  due: number;
  readonly period: number | undefined;
  readonly run: () => void;
  readonly seq: number;
}

export function createManualClock(startMs: number): ManualClock {
  let mono = 0;
  let offset = startMs;
  let seq = 0;
  const timers = new Set<Timer>();

  function schedule(ms: number, period: number | undefined, run: () => void): () => void {
    const timer: Timer = { due: mono + Math.max(0, ms), period, run, seq: (seq += 1) };
    timers.add(timer);
    return () => {
      timers.delete(timer);
    };
  }

  function next(limit: number): Timer | undefined {
    let best: Timer | undefined;
    for (const timer of timers) {
      if (timer.due > limit) continue;
      if (
        best === undefined ||
        timer.due < best.due ||
        (timer.due === best.due && timer.seq < best.seq)
      ) {
        best = timer;
      }
    }
    return best;
  }

  return {
    nowMs: () => offset + mono,
    monoMs: () => mono,
    after: (ms, run) => schedule(ms, undefined, run),
    every: (ms, run) => schedule(ms, Math.max(1, ms), run),
    advance(ms) {
      const target = mono + ms;
      for (let timer = next(target); timer !== undefined; timer = next(target)) {
        mono = Math.max(mono, timer.due);
        if (timer.period === undefined) timers.delete(timer);
        else timer.due += timer.period;
        timer.run();
      }
      mono = target;
    },
    jump(ms) {
      offset += ms;
    },
    pending: () => timers.size,
  };
}
