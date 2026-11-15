import { validateProfile } from "./base.ts";
import { SONOFF_TRV_ZBT } from "./sonoff-trv-zbt.ts";
import { SONOFF_TRVZB } from "./sonoff-trvzb.ts";
import type { Binding, Profile } from "./base.ts";
import type { ValveSpec } from "../settings.ts";

export const PROFILES: readonly Profile[] = [SONOFF_TRVZB, SONOFF_TRV_ZBT];

for (const profile of PROFILES) validateProfile(profile);

/** The spec and binding for a model on a transport; `undefined` when there is none. */
export function findProfile(
  modelId: string,
  transport: string,
): { spec: ValveSpec; binding: Binding } | undefined {
  for (const profile of PROFILES) {
    if (!profile.modelIds.includes(modelId)) continue;
    const spec = Object.hasOwn(profile.specs, transport) ? profile.specs[transport] : undefined;
    const binding = Object.hasOwn(profile.bindings, transport)
      ? profile.bindings[transport]
      : undefined;
    if (spec !== undefined && binding !== undefined) return { spec, binding };
  }
  return undefined;
}

export { validateProfile } from "./base.ts";
export type { Binding, Profile } from "./base.ts";
