/**
 * The JSON that crosses the HTTP API. Types only: the server builds these shapes and the web page
 * imports them. A key that is left out means "unknown" or "none"; `null` appears only where stated.
 */

import type { ConfigState, Membership } from "./ledger.ts";
import type { Liveness } from "./observation.ts";
import type { Evidence, SettingKey, ValveMode } from "./settings.ts";
import type { ProblemKind, Severity, Subject, SyncState } from "./status.ts";

/** `message` is English, for logs and `curl`. The web page shows its own text for the `code`. */
export type ApiError = Readonly<{
  code: string;
  message: string;
  data: Readonly<Record<string, unknown>>;
}>;

export type RoomView = Readonly<{
  roomId: string;
  name: string;
  areaName?: string;
  currentTemperature?: number;
  target?: number;
  /** Epoch milliseconds. */
  nextChangeAt?: number;
  nextTarget?: number;
  mode?: ValveMode;
  heating?: boolean;
  sync: SyncState;
  degraded: boolean;
  diverged: boolean;
  hasProblem: boolean;
  valveIds: readonly string[];
}>;

export type ValveView = Readonly<{
  valveId: string;
  name: string;
  modelId?: string;
  supported: boolean;
  roomId?: string;
  membership?: Membership;
  liveness?: Liveness;
  mode?: ValveMode;
  setpoint?: number;
  target?: number;
  sync?: SyncState;
  battery?: number;
}>;

/**
 * A followed valve that is in no room and not releasing: whether it has reported since the start,
 * and what it showed. `values` is keyed by setting key and holds the `describeValue` forms.
 */
export type UnassignedValveView = Readonly<{
  valveId: string;
  name: string;
  observed: boolean;
  liveness: Liveness;
  values: Readonly<Record<string, unknown>>;
}>;

export type ProblemView = Readonly<{
  kind: ProblemKind;
  subject: Subject;
  severity: Severity;
  name: string;
  data: Readonly<Record<string, string>>;
}>;

export type StateView = Readonly<{
  revision: number;
  configState: ConfigState;
  ledgerReadable: boolean;
  originalsCopyRecords: number;
  held: boolean;
  language: "en" | "ru";
  links: Readonly<Record<string, boolean>>;
  transportFaults: Readonly<Record<string, string>>;
  rooms: readonly RoomView[];
  valves: readonly ValveView[];
  unassigned: readonly UnassignedValveView[];
  problems: readonly ProblemView[];
}>;

/** `value` is the `describeValue` form, or `null` when the setting could not be read. */
export type OriginalView = Readonly<{ setting: SettingKey; value: unknown; evidence: Evidence }>;

export type JoiningView = Readonly<{
  valveId: string;
  name: string;
  originals: readonly OriginalView[];
  unreadable: readonly SettingKey[];
}>;

export type ValveRefView = Readonly<{ valveId: string; name: string }>;

/** `from` is left out when the current value is unknown. */
export type WriteView = Readonly<{
  valveId: string;
  name: string;
  settings: readonly Readonly<{ setting: SettingKey; from?: unknown; to: unknown }>[];
}>;

/**
 * `revision` is the revision this change gets (preview) or got (apply); `held` says whether writes
 * are held after this change.
 */
export type PlanView = Readonly<{
  applied: boolean;
  revision: number;
  held: boolean;
  joining: readonly JoiningView[];
  rejoining: readonly ValveRefView[];
  leaving: readonly ValveRefView[];
  writes: readonly WriteView[];
}>;

/** `yaml` is the same document as YAML text. */
export type ConfigView = Readonly<{
  revision: number;
  config: Readonly<Record<string, unknown>>;
  yaml: string;
}>;

/** Exactly one of `config` and `yaml`. */
export type ApplyRequest = Readonly<{
  config?: Readonly<Record<string, unknown>>;
  yaml?: string;
  expectedRevision?: number;
  acceptUnknownOriginals?: readonly string[];
  overwriteUnreadable?: boolean;
}>;

export type EventMessage = Readonly<{ type: "state"; state: StateView }>;
