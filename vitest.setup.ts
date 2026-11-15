import fc from "fast-check";
import { expect } from "vitest";

export type FastCheckProfile = Readonly<{ numRuns: number; seed: number | undefined }>;

const CI_SEED = 20261114;

/** The fast-check settings for a profile name: "dev" (the default) or "ci". */
export function fastCheckProfile(name: string | undefined): FastCheckProfile {
  switch (name) {
    case undefined:
    case "dev":
      return { numRuns: 200, seed: undefined };
    case "ci":
      return { numRuns: 50, seed: CI_SEED };
    default:
      throw new Error(`unknown FC_PROFILE: ${name}`);
  }
}

const profile = fastCheckProfile(process.env.FC_PROFILE);
fc.configureGlobal(
  profile.seed === undefined
    ? { numRuns: profile.numRuns }
    : { numRuns: profile.numRuns, seed: profile.seed },
);

// Temporal values have no own properties, so without this `toEqual` calls any two of them equal.
function sameTemporal(a: unknown, b: unknown): boolean | undefined {
  if (a instanceof Temporal.PlainTime && b instanceof Temporal.PlainTime) return a.equals(b);
  if (a instanceof Temporal.PlainDate && b instanceof Temporal.PlainDate) return a.equals(b);
  if (a instanceof Temporal.PlainDateTime && b instanceof Temporal.PlainDateTime) {
    return a.equals(b);
  }
  if (a instanceof Temporal.ZonedDateTime && b instanceof Temporal.ZonedDateTime) {
    return a.equals(b);
  }
  if (a instanceof Temporal.Instant && b instanceof Temporal.Instant) return a.equals(b);
  if (a instanceof Temporal.Duration && b instanceof Temporal.Duration) {
    try {
      return Temporal.Duration.compare(a, b) === 0;
    } catch {
      // Years, months and weeks cannot be compared without a reference date.
      return a.toString() === b.toString();
    }
  }
  return undefined;
}

expect.addEqualityTesters([sameTemporal]);
