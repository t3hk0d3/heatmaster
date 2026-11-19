import type { Decoded } from "../observation.ts";
import type { SettingValues, ValveSpec } from "../settings.ts";

/**
 * How one transport shows and accepts one valve model's settings. Pure functions; nothing here
 * waits, sequences or talks to a transport.
 *
 * - `decode` never throws. A key that is present but cannot be understood maps to `null`; a key
 *   that is not in the payload is left out.
 * - `encode` is one transport message that writes those settings.
 * - `encodeRefresh` asks the valve to report the settings of the spec's readable groups; it is
 *   `undefined` when the spec has none.
 */
export type Binding = Readonly<{
  decode: (payload: Readonly<Record<string, unknown>>) => Decoded;
  encode: (values: SettingValues) => Record<string, unknown>;
  encodeSetpoint: (celsius: number) => Record<string, unknown>;
  encodeTemperature: (celsius: number) => Record<string, unknown>;
  encodeRefresh: () => Record<string, unknown> | undefined;
}>;

/** Both mappings are keyed by transport key. Every spec's `profile` holds its profile's `key`. */
export type Profile = Readonly<{
  key: string;
  modelIds: readonly string[];
  specs: Readonly<Record<string, ValveSpec>>;
  bindings: Readonly<Record<string, Binding>>;
}>;

/**
 * Throws an `Error` when a profile contradicts itself: a spec whose `profile` is not the key, a
 * spec without a binding, `schedule` not first, an `active_group` group without a schedule group
 * to choose, or a frost range whose minimum is above its maximum.
 */
export function validateProfile(profile: Profile): void {
  for (const [transport, spec] of Object.entries(profile.specs)) {
    const where = `${profile.key}/${transport}`;
    if (spec.profile !== profile.key) throw new Error(`${where}: spec.profile is not the key`);
    if (!Object.hasOwn(profile.bindings, transport)) throw new Error(`${where}: no binding`);
    const groups = spec.groups.map((g) => g.group);
    if (new Set(groups).size !== groups.length) throw new Error(`${where}: a group is repeated`);
    const schedule = groups.indexOf("schedule");
    const active = groups.indexOf("active_group");
    if (active !== -1 && schedule === -1) throw new Error(`${where}: active_group needs schedule`);
    if (active !== -1 && schedule > active)
      throw new Error(`${where}: schedule must come before active_group`);
    if (active !== -1 && spec.scheduleGroup === undefined)
      throw new Error(`${where}: active_group needs a schedule group`);
    if (groups.includes("sensor_source") && !spec.externalSensor)
      throw new Error(`${where}: sensor_source needs an external sensor`);
    if (spec.frostMinTemp > spec.frostMaxTemp)
      throw new Error(`${where}: frostMinTemp is above frostMaxTemp`);
  }
}
