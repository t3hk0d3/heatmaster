import type { SensorInfo } from "@heatmaster/core";
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

/** A new stub is up and ready, with no house, no sensors and no names. */
export function createStubHaLink(): StubHaLink {
  let state: HaLinkState = "up";
  let ready: boolean | undefined;
  let house: HaHouse | undefined;
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
    snapshot: () => undefined,
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
