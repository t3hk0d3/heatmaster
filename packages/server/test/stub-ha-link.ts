import type { HaSnapshot, SensorInfo } from "@heatmaster/core";
import type { HaEvent, HaHouse, HaLink, HaLinkState, HaSensor } from "../src/ha-link.ts";

export type StubHaLink = HaLink &
  Readonly<{
    /** Sets the state; `up` and `ready` follow from it unless `setReady` was called. */
    setState(state: HaLinkState): void;
    setReady(ready: boolean): void;
    setHouse(house: HaHouse | undefined): void;
    setSensor(entityId: string, sensor: HaSensor | undefined): void;
    setSensorInfo(entityId: string, info: SensorInfo): void;
    setEntityName(entityId: string, name: string): void;
    setAreaName(areaId: string, name: string): void;
    /** What `snapshot()` answers from now on. */
    setSnapshot(snapshot: HaSnapshot | undefined): void;
    /** How many times `snapshot()` was called. */
    snapshotReads(): number;
    emit(event: HaEvent): void;
    /** Every set given to `watch`, oldest first. */
    watched(): readonly ReadonlySet<string>[];
    /** The entity of every `sensorInfo` call, in order. */
    infoCalls(): readonly string[];
    /** The valve addresses of every `sensorInfo` call, in order. */
    infoAddresses(): readonly ReadonlySet<string>[];
    started(): boolean;
    stopped(): boolean;
  }>;

const UNKNOWN: SensorInfo = { exists: false, isTemperature: false, onValve: false };

export const EMPTY_HA_SNAPSHOT: HaSnapshot = {
  areas: new Map(),
  valveAreas: new Map(),
  entities: new Map(),
  labels: new Map(),
};

/**
 * A new stub is up and ready, with no house, no sensors, no names and an empty snapshot. Like a
 * link whose full load is done, its `start` sends `link_up` at once while it is up and ready.
 */
export function createStubHaLink(): StubHaLink {
  let state: HaLinkState = "up";
  let ready: boolean | undefined;
  let house: HaHouse | undefined;
  let snapshot: HaSnapshot | undefined = EMPTY_HA_SNAPSHOT;
  let snapshotReads = 0;
  let listener: ((event: HaEvent) => void) | undefined;
  const sensors = new Map<string, HaSensor>();
  const infos = new Map<string, SensorInfo>();
  const names = new Map<string, string>();
  const areas = new Map<string, string>();
  const watched: ReadonlySet<string>[] = [];
  const infoCalls: string[] = [];
  const infoAddresses: ReadonlySet<string>[] = [];
  let started = false;
  let stopped = false;

  return {
    start(next) {
      started = true;
      listener = next;
      if (state === "up" && (ready ?? true)) next({ kind: "link_up" });
    },
    stop() {
      stopped = true;
      listener = undefined;
      return Promise.resolve();
    },
    state: () => state,
    up: () => state === "up",
    ready: () => ready ?? state === "up",
    house: () => house,
    watch(entityIds) {
      watched.push(new Set(entityIds));
    },
    sensor: (entityId) => sensors.get(entityId),
    sensorInfo(entityId, valveAddresses) {
      infoCalls.push(entityId);
      infoAddresses.push(new Set(valveAddresses));
      return infos.get(entityId) ?? UNKNOWN;
    },
    entityName: (entityId) => names.get(entityId),
    areaName: (areaId) => areas.get(areaId),
    snapshot() {
      snapshotReads += 1;
      return snapshot;
    },
    // A fixed stand-in: every op done, nothing created under another id.
    writeLabels: (ops) => Promise.resolve({ done: [...ops], failed: [], created: new Map() }),
    setState(next) {
      state = next;
    },
    setReady(next) {
      ready = next;
    },
    setHouse(next) {
      house = next;
    },
    setSensor(entityId, sensor) {
      if (sensor === undefined) sensors.delete(entityId);
      else sensors.set(entityId, sensor);
    },
    setSensorInfo(entityId, info) {
      infos.set(entityId, info);
    },
    setEntityName(entityId, name) {
      names.set(entityId, name);
    },
    setAreaName(areaId, name) {
      areas.set(areaId, name);
    },
    setSnapshot(next) {
      snapshot = next;
    },
    snapshotReads: () => snapshotReads,
    emit(event) {
      listener?.(event);
    },
    watched: () => [...watched],
    infoCalls: () => [...infoCalls],
    infoAddresses: () => [...infoAddresses],
    started: () => started,
    stopped: () => stopped,
  };
}
