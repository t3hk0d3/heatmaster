/** A value this far below a half counts as the half, in °C (see the styleguide, Rounding). */
const HALF_TOLERANCE_C = 0.000000001;

/** Rounds half up to a multiple of `step`; a value within 1e-9 below a half counts as the half. */
export function roundHalfUp(value: number, step: number): number {
  const steps = Math.floor((value + HALF_TOLERANCE_C) / step + 0.5);
  return Math.round(steps * step * 1_000_000) / 1_000_000 + 0;
}
