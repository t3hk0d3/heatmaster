/** Formatting only: a Snapshot or a ChangePlan becomes the JSON shapes of `wire.ts`. */

import { describeValue, findProfile, groupOf } from "@heatmaster/core";
import type {
  ChangePlan,
  Evidence,
  JoiningView,
  OriginalView,
  PlanView,
  ProblemView,
  RoomView,
  SettingKey,
  StateView,
  UnassignedValveView,
  ValveRefView,
  ValveStatus,
  ValveView,
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
    areaName: room.areaName,
    currentTemperature: status?.currentTemperature,
    target: status?.target,
    nextChangeAt: status?.nextChangeAt,
    nextTarget: status?.nextTarget,
    mode: status?.mode,
    heating: status?.heating,
    sync: status?.sync ?? "unverified",
    degraded: status?.degraded ?? false,
    diverged: status?.diverged ?? false,
    hasProblem: snapshot.problems.some(concerns),
    valveIds: room.valveIds,
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
    case "system":
      return id;
  }
}

export function stateView(snapshot: Snapshot): StateView {
  const devices = new Map(snapshot.devices.map((device) => [device.deviceId, device]));
  const roomOf = new Map<string, string>();
  const statusOf = new Map<string, ValveStatus>();
  for (const room of snapshot.rooms) {
    for (const valveId of room.valveIds) roomOf.set(valveId, room.roomId);
    for (const valve of room.status?.valves ?? []) statusOf.set(valve.valveId, valve);
  }

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
      liveness: status?.liveness,
      mode: status?.mode,
      setpoint: status?.setpoint,
      target: status?.target,
      sync: status?.sync,
      battery: status?.battery,
    });
  });

  const unassigned = snapshot.unassigned
    .toSorted(byId((v) => v.valveId))
    .map((valve): UnassignedValveView => ({
      valveId: valve.valveId,
      name: valve.name,
      observed: valve.observed,
      liveness: valve.liveness,
      values: valve.values,
    }));

  const problems = snapshot.problems.map((problem): ProblemView => ({
    kind: problem.kind,
    subject: problem.subject,
    severity: problem.severity,
    name: problemName(problem, snapshot, devices),
    data: problem.data,
  }));

  return {
    revision: snapshot.revision,
    configState: snapshot.configState,
    ledgerReadable: snapshot.ledgerReadable,
    originalsCopyRecords: snapshot.originalsCopyRecords,
    held: snapshot.held,
    language: snapshot.language,
    links: snapshot.links,
    transportFaults: snapshot.transportFaults,
    rooms: snapshot.rooms.map((room) => roomView(room, snapshot)),
    valves,
    unassigned,
    problems,
  };
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
  const refs = (ids: readonly string[]): ValveRefView[] =>
    ids.map((valveId) => ({ valveId, name: nameOf(valveId) }));

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
    rejoining: refs(plan.rejoining),
    leaving: refs(plan.leaving),
    writes,
  };
}
