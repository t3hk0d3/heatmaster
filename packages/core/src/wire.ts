/**
 * The JSON that crosses the HTTP API. Types only: the server builds these shapes and the web page
 * imports them. A key that is left out means "unknown" or "none"; `null` appears only where stated.
 */

import type { UnplacedReason } from "./house.ts";
import type { PendingReason } from "./join.ts";
import type { ConfigState, DroppedRoomReason, HaChangeKind, Membership } from "./ledger.ts";
import type {
  AfterLimit,
  EndRule,
  ManualChange,
  PresetName,
  ValveDetection,
  WindowAction,
  WindowEnd,
  WindowTarget,
} from "./model.ts";
import type { Liveness } from "./observation.ts";
import type { Evidence, SettingKey, ValveMode } from "./settings.ts";
import type { ProblemKind, Severity, Subject, SyncState, WindowNote } from "./status.ts";

/** `message` is English, for logs and `curl`. The web page shows its own text for the `code`. */
export type ApiError = Readonly<{
  code: string;
  message: string;
  data: Readonly<Record<string, unknown>>;
}>;

/** Where a room change came from; `valveId` is left out unless `source` is `valve`. */
export type OriginView = Readonly<{ source: "valve" | "climate" | "api"; valveId?: string }>;

/**
 * A room's state: on its schedule, overridden at `target` (with its `preset`, if it was one) or
 * off. An override or off ends by `rule`, at `endsAt` (epoch milliseconds; left out: never);
 * `since` is when it was made.
 */
export type ThermostatView = Readonly<{
  kind: "schedule" | "override" | "off";
  target?: number;
  preset?: PresetName;
  rule?: EndRule;
  endsAt?: number;
  origin?: OriginView;
  since?: number;
}>;

/**
 * A room's active opening: `since` is epoch milliseconds, `openContacts` are contact refs
 * (`ha:<entity id>`), `holdsValves` says whether its valves are held at the window's action,
 * `notes` what the status adds while they are.
 */
export type WindowView = Readonly<{
  state: "open" | "suspended" | "limit_reached" | "dropped";
  triggers: readonly ("contact" | "temperature")[];
  openContacts: readonly string[];
  since: number;
  holdsValves: boolean;
  notes: readonly WindowNote[];
}>;

/** A room's merged window settings as JSON: durations in milliseconds, `limitMs` null for none. */
export type WindowSettingsView = Readonly<{
  enabled: boolean;
  action: WindowAction;
  target: WindowTarget;
  openDebounceMs: number;
  closeDebounceMs: number;
  contactUnavailableMs: number;
  temperature: Readonly<{
    enabled: boolean;
    dropC: number;
    withinMs: number;
    end: WindowEnd;
    fixedMs: number;
    stillMs: number;
    rejoinMs: number;
  }>;
  limitMs: number | null;
  afterLimit: AfterLimit;
  notify: boolean;
  manualChange: ManualChange;
  valveDetection: ValveDetection;
}>;

/**
 * A room of the membership the page shows: the live one, or the saved one while rooms are frozen or
 * there is no Home Assistant link. `managed` says whether Heatmaster acts on it; `scheduleId` and
 * `scheduleName` are its schedule, left out when the config has none.
 */
export type RoomView = Readonly<{
  roomId: string;
  name: string;
  managed: boolean;
  scheduleId?: string;
  scheduleName?: string;
  currentTemperature?: number;
  target?: number;
  /** Epoch milliseconds. */
  nextChangeAt?: number;
  nextTarget?: number;
  mode?: ValveMode;
  heating?: boolean;
  sync: SyncState;
  degraded: boolean;
  hasProblem: boolean;
  valveIds: readonly string[];
  /** Left out while the saved room states are unreadable, and while the room's state is unknown. */
  thermostat?: ThermostatView;
  /** The temperatures the room's targets are held in; left out when no valve has a spec. */
  minTemp?: number;
  maxTemp?: number;
  /** The room's end settings for a change that names none. */
  overrideEnd?: EndRule;
  overrideDurationMs?: number;
  /** Left out when the room has no active opening. */
  window?: WindowView;
  /** Left out while the room is not resolved from a readable config. */
  windowSettings?: WindowSettingsView;
}>;

/**
 * `stranded`: a managed valve that Home Assistant no longer has and whose transport, healthy and
 * with a device list, does not list it (`transportListed`); it may be forgotten.
 */
export type ValveView = Readonly<{
  valveId: string;
  name: string;
  modelId?: string;
  supported: boolean;
  roomId?: string;
  membership?: Membership;
  stranded?: boolean;
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
 * `reason` says why Home Assistant puts it in no room, when it does.
 */
export type UnassignedValveView = Readonly<{
  valveId: string;
  name: string;
  observed: boolean;
  liveness: Liveness;
  values: Readonly<Record<string, unknown>>;
  reason?: UnplacedReason;
}>;

export type HaChangeItemView = Readonly<{
  kind: HaChangeKind;
  areaId?: string;
  entityId?: string;
  scheduleId?: string;
  rule?: EndRule;
  setting?: string;
  value?: string;
}>;

/** A config revision made from label edits in Home Assistant; `at` is epoch milliseconds. */
export type HaChangeView = Readonly<{
  revision: number;
  at: number;
  items: readonly HaChangeItemView[];
}>;

export type DroppedRoomView = Readonly<{
  roomId: string;
  name: string;
  valveIds: readonly string[];
  reason: DroppedRoomReason;
}>;

/** The report of the conversion from a version 2 config. */
export type UpgradeView = Readonly<{ fromVersion: 2; droppedRooms: readonly DroppedRoomView[] }>;

export type ProblemView = Readonly<{
  kind: ProblemKind;
  subject: Subject;
  severity: Severity;
  name: string;
  data: Readonly<Record<string, string>>;
}>;

/**
 * `house`: `live` while rooms follow Home Assistant, `frozen` while they are frozen on the saved
 * membership (`frozenReason` says why), `unlinked` without a Home Assistant link. `unusedEntries`
 * lists the config's room entries of areas that are no room; `haChanges` is oldest first.
 */
export type StateView = Readonly<{
  revision: number;
  configState: ConfigState;
  house: "live" | "frozen" | "unlinked";
  frozenReason?: "not_loaded" | "link_down";
  ledgerReadable: boolean;
  originalsCopyRecords: number;
  held: boolean;
  language: "en" | "ru";
  links: Readonly<Record<string, boolean>>;
  transportFaults: Readonly<Record<string, string>>;
  rooms: readonly RoomView[];
  unusedEntries: readonly string[];
  valves: readonly ValveView[];
  unassigned: readonly UnassignedValveView[];
  /** The valves that wait to join their room, as the last tick found them. */
  pending: readonly PendingView[];
  problems: readonly ProblemView[];
  haChanges: readonly HaChangeView[];
  upgrade?: UpgradeView;
  /** The config's schedules in config order; empty while the config is unreadable. */
  schedules: readonly Readonly<{ id: string; name: string }>[];
}>;

/** How a change ends; `durationMs` (milliseconds) belongs to the `timer` rule. */
export type EndRequest = Readonly<{ rule: EndRule; durationMs?: number }>;

/** Body of `POST /api/rooms/:id/override`: exactly one of `target` and `preset`. */
export type OverrideRequest = Readonly<{
  target?: number;
  preset?: PresetName;
  end?: EndRequest;
}>;

/** Body of `POST /api/rooms/:id/off`. */
export type OffRequest = Readonly<{ end?: EndRequest }>;

/** `value` is the `describeValue` form, or `null` when the setting could not be read. */
export type OriginalView = Readonly<{ setting: SettingKey; value: unknown; evidence: Evidence }>;

export type JoiningView = Readonly<{
  valveId: string;
  name: string;
  originals: readonly OriginalView[];
  unreadable: readonly SettingKey[];
}>;

/** A valve that waits to join its room; `unreadable` is filled for `originals_unreadable` only. */
export type PendingView = Readonly<{
  valveId: string;
  name: string;
  roomId: string;
  reason: PendingReason;
  unreadable: readonly SettingKey[];
}>;

/** `from` is left out when the current value is unknown. */
export type WriteView = Readonly<{
  valveId: string;
  name: string;
  settings: readonly Readonly<{ setting: SettingKey; from?: unknown; to: unknown }>[];
}>;

/**
 * `revision` is the revision this change gets (preview) or got (apply); `held` says whether writes
 * are held after this change. `joining` and `pending` are what the next tick joins and keeps
 * waiting once the change is saved.
 */
export type PlanView = Readonly<{
  applied: boolean;
  revision: number;
  held: boolean;
  joining: readonly JoiningView[];
  pending: readonly PendingView[];
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
  overwriteUnreadable?: boolean;
}>;

export type EventMessage = Readonly<{ type: "state"; state: StateView }>;
