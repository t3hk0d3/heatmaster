/** Formatting only: a Snapshot or a ChangePlan becomes the JSON shapes of `wire.ts`. */

import { describeValue, findProfile, groupOf } from "@heatmaster/core";
import type {
  ChangePlan,
  Evidence,
  HaChange,
  HaChangeView,
  JoiningView,
  OriginalView,
  Pending,
  PendingView,
  PlanView,
  ProblemView,
  RoomView,
  SettingKey,
  StateView,
  Thermostat,
  ThermostatView,
  UnassignedValveView,
  UpgradeReport,
  UpgradeView,
  ValveStatus,
  ValveView,
  WindowSettings,
  WindowSettingsView,
  WriteView,
} from "@heatmaster/core";
import type { DeviceSnapshot, RoomSnapshot, Snapshot } from "./runtime.ts";

/** An object without the keys whose value is undefined: in the wire shapes a left-out key is unknown. */
function present<T extends object>(fields: { [K in keyof T]: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as T;
}

function byId<T>(id: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0);
}

function thermostatView(thermostat: Thermostat): ThermostatView {
  if (thermostat.kind === "schedule") return { kind: "schedule" };
  const { kind, rule, endsAt, origin, since } = thermostat;
  return present<ThermostatView>({
    kind,
    target: thermostat.kind === "override" ? thermostat.target : undefined,
    preset: thermostat.kind === "override" ? thermostat.preset : undefined,
    rule,
    endsAt,
    origin: present({ source: origin.source, valveId: origin.valveId }),
    since,
  });
}

function windowSettingsView(settings: WindowSettings): WindowSettingsView {
  return { ...settings, limitMs: settings.limitMs ?? null };
}

function roomView(room: RoomSnapshot, snapshot: Snapshot): RoomView {
  const status = room.status;
  const concerns = (problem: Snapshot["problems"][number]): boolean => {
    const { kind, id } = problem.subject;
    if (kind === "room") return id === room.roomId;
    if (kind === "valve") return room.valveIds.includes(id);
    if (kind === "sensor") return room.sensorIds.includes(id);
    return false;
  };
  return present<RoomView>({
    roomId: room.roomId,
    name: room.name,
    managed: room.managed,
    scheduleId: room.scheduleId,
    scheduleName: room.scheduleName,
    currentTemperature: status?.currentTemperature,
    target: status?.target,
    nextChangeAt: status?.nextChangeAt,
    nextTarget: status?.nextTarget,
    mode: status?.mode,
    heating: status?.heating,
    sync: status?.sync ?? "unverified",
    degraded: status?.degraded ?? false,
    hasProblem: snapshot.problems.some(concerns),
    valveIds: room.valveIds,
    thermostat: status?.thermostat === undefined ? undefined : thermostatView(status.thermostat),
    minTemp: status?.limits?.min,
    maxTemp: status?.limits?.max,
    overrideEnd: status?.overrideEnd,
    overrideDurationMs: status?.overrideDurationMs,
    window: status?.window,
    windowSettings: room.window === undefined ? undefined : windowSettingsView(room.window),
  });
}

function problemName(
  problem: Snapshot["problems"][number],
  snapshot: Snapshot,
  devices: ReadonlyMap<string, DeviceSnapshot>,
): string {
  const { kind, id } = problem.subject;
  switch (kind) {
    case "room":
      return snapshot.rooms.find((room) => room.roomId === id)?.name ?? id;
    case "valve":
      return devices.get(id)?.name ?? id;
    case "sensor":
      return snapshot.sensors.find((sensor) => sensor.sensorId === id)?.name ?? id;
    case "area":
      return (
        snapshot.rooms.find((room) => room.roomId === id)?.name ?? snapshot.areaNames[id] ?? id
      );
    case "label":
    case "system":
      return id;
  }
}

function haChangeView(change: HaChange): HaChangeView {
  return {
    revision: change.revision,
    at: change.at,
    items: change.items.map((item) =>
      present<HaChangeView["items"][number]>({
        kind: item.kind,
        areaId: item.areaId,
        entityId: item.entityId,
        scheduleId: item.scheduleId,
        rule: item.rule,
        setting: item.setting,
        value: item.value,
      }),
    ),
  };
}

function upgradeView(report: UpgradeReport): UpgradeView {
  return {
    fromVersion: report.fromVersion,
    droppedRooms: report.droppedRooms.map((room) => ({
      roomId: room.roomId,
      name: room.name,
      valveIds: room.valveIds,
      reason: room.reason,
    })),
  };
}

function pendingView(waiting: Pending, devices: ReadonlyMap<string, DeviceSnapshot>): PendingView {
  return {
    valveId: waiting.valveId,
    name: devices.get(waiting.valveId)?.name ?? waiting.valveId,
    roomId: waiting.roomId,
    reason: waiting.reason,
    unreadable: waiting.unreadable,
  };
}

export function stateView(snapshot: Snapshot): StateView {
  const devices = new Map(snapshot.devices.map((device) => [device.deviceId, device]));
  const roomOf = new Map<string, string>();
  const statusOf = new Map<string, ValveStatus>();
  for (const room of snapshot.rooms) {
    for (const valveId of room.valveIds) roomOf.set(valveId, room.roomId);
    for (const valve of room.status?.valves ?? []) statusOf.set(valve.valveId, valve);
  }

  const stranded = new Set(snapshot.stranded);
  const valveIds = new Set<string>(Object.keys(snapshot.memberships));
  for (const device of snapshot.devices) if (device.supported) valveIds.add(device.deviceId);
  const valves = [...valveIds].sort().map((valveId) => {
    const device = devices.get(valveId);
    const status = statusOf.get(valveId);
    return present<ValveView>({
      valveId,
      name: device?.name ?? valveId,
      modelId: device?.modelId,
      supported: device?.supported ?? false,
      roomId: roomOf.get(valveId),
      membership: Object.hasOwn(snapshot.memberships, valveId)
        ? snapshot.memberships[valveId]
        : undefined,
      stranded: stranded.has(valveId) ? true : undefined,
      liveness: status?.liveness,
      mode: status?.mode,
      setpoint: status?.setpoint,
      target: status?.target,
      sync: status?.sync,
      battery: status?.battery,
    });
  });

  const unassigned = snapshot.unassigned.toSorted(byId((v) => v.valveId)).map((valve) =>
    present<UnassignedValveView>({
      valveId: valve.valveId,
      name: valve.name,
      observed: valve.observed,
      liveness: valve.liveness,
      values: valve.values,
      reason: valve.reason,
    }),
  );

  const problems = snapshot.problems.map((problem): ProblemView => ({
    kind: problem.kind,
    subject: problem.subject,
    severity: problem.severity,
    name: problemName(problem, snapshot, devices),
    data: problem.data,
  }));

  return present<StateView>({
    revision: snapshot.revision,
    configState: snapshot.configState,
    house: snapshot.house,
    frozenReason: snapshot.houseFrozenReason,
    ledgerReadable: snapshot.ledgerReadable,
    originalsCopyRecords: snapshot.originalsCopyRecords,
    held: snapshot.held,
    language: snapshot.language,
    links: snapshot.links,
    transportFaults: snapshot.transportFaults,
    rooms: snapshot.rooms.map((room) => roomView(room, snapshot)),
    unusedEntries: snapshot.unusedEntries,
    valves,
    unassigned,
    pending: snapshot.pending.map((waiting) => pendingView(waiting, devices)),
    problems,
    haChanges: snapshot.haChanges.map(haChangeView),
    upgrade: snapshot.upgrade === undefined ? undefined : upgradeView(snapshot.upgrade),
    schedules: snapshot.schedules,
  });
}

// ---- plans ---------------------------------------------------------------------------------------

function evidenceOf(device: DeviceSnapshot | undefined, setting: SettingKey): Evidence {
  if (device === undefined) return "none";
  const spec = findProfile(device.modelId, device.transport)?.spec;
  const group = groupOf(setting);
  return spec?.groups.find((candidate) => candidate.group === group)?.evidence ?? "none";
}

export function planView(plan: ChangePlan, applied: boolean, snapshot: Snapshot): PlanView {
  const devices = new Map(snapshot.devices.map((device) => [device.deviceId, device]));
  const nameOf = (valveId: string): string => devices.get(valveId)?.name ?? valveId;

  const joining = plan.joining.map((capture): JoiningView => {
    const device = devices.get(capture.valveId);
    const originals = (Object.keys(capture.originals) as SettingKey[]).map(
      (setting): OriginalView => ({
        setting,
        value: describeValue(setting, capture.originals[setting]),
        evidence: evidenceOf(device, setting),
      }),
    );
    return {
      valveId: capture.valveId,
      name: nameOf(capture.valveId),
      originals,
      unreadable: capture.unreadable,
    };
  });

  const writes = plan.writes.map((write): WriteView => {
    const settings = (Object.keys(write.values) as SettingKey[]).flatMap((setting) => {
      const to = write.values[setting];
      if (to === undefined) return [];
      const from = write.current[setting];
      return [
        from === undefined
          ? { setting, to: describeValue(setting, to) }
          : { setting, from: describeValue(setting, from), to: describeValue(setting, to) },
      ];
    });
    return { valveId: write.valveId, name: nameOf(write.valveId), settings };
  });

  return {
    applied,
    revision: plan.stored.revision,
    held: plan.stored.config.settings.holdWrites,
    joining,
    pending: plan.pending.map((waiting) => pendingView(waiting, devices)),
    writes,
  };
}
