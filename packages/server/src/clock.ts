/** All server code takes its time and its timers from a Clock. */
export type Clock = Readonly<{
  /** The wall clock, in epoch milliseconds. */
  nowMs(): number;
  /** A monotonic reading in milliseconds; it never jumps when the wall clock is set. */
  monoMs(): number;
  /** Runs `run` once after `ms`. The returned function cancels it. */
  after(ms: number, run: () => void): () => void;
  /** Runs `run` every `ms`. The returned function cancels it. */
  every(ms: number, run: () => void): () => void;
}>;

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  monoMs: () => performance.now(),
  after(ms, run) {
    const timer = setTimeout(run, ms);
    return () => {
      clearTimeout(timer);
    };
  },
  every(ms, run) {
    const timer = setInterval(run, ms);
    return () => {
      clearInterval(timer);
    };
  },
};
