import type { Thermostat, ThermostatSeen, ThermostatWanted } from "./thermostat.ts";

/**
 * What the core knows of a valve's week when it asks an adapter (R23). `inForce` is the value its
 * confirmed week has in force a little ahead of now (R18); `weekValues` are every temperature of
 * the week the valve runs; `pointValues` are every temperature in force near the report's time.
 * Each is undefined when no such week applies. Temperatures are clamped and rounded as setpoints.
 */
export type AdapterContext = Readonly<{
  inForce: number | undefined;
  weekValues: ReadonlySet<number> | undefined;
  pointValues: ReadonlySet<number> | undefined;
}>;

/**
 * Every difference between valve models in the `thermostat` group (R24).
 * - `wanted`: what the valve is sent for the room's state; the target is not clamped (the core
 *   clamps it).
 * - `matches`: the valve shows the expected state, so a write is confirmed and no write is needed.
 * - `explains`: what the valve shows is Heatmaster's own doing; it holds whenever `matches` does.
 */
export type ThermostatAdapter = Readonly<{
  wanted: (thermostat: Thermostat, ctx: AdapterContext) => ThermostatWanted;
  matches: (expected: ThermostatWanted, seen: ThermostatSeen, ctx: AdapterContext) => boolean;
  explains: (expected: ThermostatWanted, seen: ThermostatSeen, ctx: AdapterContext) => boolean;
}>;

/**
 * What every model is sent outside the schedule: `heat` at an override's target, `off` when the
 * room is off (R1); `onSchedule` while the room follows its schedule.
 */
export function wantedFor(thermostat: Thermostat, onSchedule: ThermostatWanted): ThermostatWanted {
  switch (thermostat.kind) {
    case "schedule":
      return onSchedule;
    case "override":
      return { mode: "heat", setpoint: thermostat.target, scheduled: false };
    case "off":
      return { mode: "off", setpoint: undefined, scheduled: false };
  }
}

/**
 * The rules every model shares: false when the valve shows no mode or another mode; in `heat`
 * whether the setpoints are equal; true in `off`; undefined in `auto`, which the model decides.
 */
export function commonMatch(expected: ThermostatWanted, seen: ThermostatSeen): boolean | undefined {
  if (seen.mode === undefined || seen.mode !== expected.mode) return false;
  switch (expected.mode) {
    case "heat":
      return seen.setpoint === expected.setpoint;
    case "off":
      return true;
    case "auto":
      return undefined;
  }
}
