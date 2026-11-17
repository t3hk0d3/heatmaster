import type {
  ApiError,
  ConfigView,
  PlanView,
  ProblemView,
  RoomView,
  StateView,
  ValveView,
} from "@heatmaster/core";
import type { Result } from "../src/api.ts";

export function stateView(over: Partial<StateView> = {}): StateView {
  return {
    revision: 3,
    configState: "ok",
    house: "live",
    ledgerReadable: true,
    originalsCopyRecords: 0,
    held: false,
    language: "en",
    links: { z2m: true },
    transportFaults: {},
    rooms: [],
    unusedEntries: [],
    valves: [],
    unassigned: [],
    problems: [],
    haChanges: [],
    ...over,
  };
}

export function roomView(over: Partial<RoomView> = {}): RoomView {
  return {
    roomId: "living",
    name: "Living room",
    managed: true,
    sync: "in_sync",
    degraded: false,
    diverged: false,
    hasProblem: false,
    valveIds: [],
    ...over,
  };
}

export function valveView(over: Partial<ValveView> = {}): ValveView {
  return { valveId: "z2m:0x00124b0012345678", name: "Hall valve", supported: true, ...over };
}

export function problemView(over: Partial<ProblemView> = {}): ProblemView {
  return {
    kind: "valve_silent",
    subject: { kind: "valve", id: "z2m:0x00124b0012345678" },
    severity: "error",
    name: "Hall",
    data: {},
    ...over,
  };
}

export function planView(over: Partial<PlanView> = {}): PlanView {
  return {
    applied: false,
    revision: 4,
    held: false,
    joining: [],
    pending: [],
    writes: [],
    ...over,
  };
}

export function configView(over: Partial<ConfigView> = {}): ConfigView {
  return { revision: 3, config: {}, yaml: "version: 1\n", ...over };
}

export function apiError(code: string, data: Readonly<Record<string, unknown>> = {}): ApiError {
  return { code, message: `server says ${code}`, data };
}

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail(code: string, data: Readonly<Record<string, unknown>> = {}): Result<never> {
  return { ok: false, status: 409, error: apiError(code, data) };
}
