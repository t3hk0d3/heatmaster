import { HeatmasterError } from "../src/errors.ts";
import type { DeviceInfo, RawEvent, Transport } from "../src/transport.ts";

export type StubSend = Readonly<{
  kind: "publish" | "read";
  deviceId: string;
  payload: unknown;
}>;

export type StubTransport = Transport &
  Readonly<{
    /** Replaces the listed devices, counts as a delivered device list and sends `devices_changed`. */
    setDevices(devices: readonly DeviceInfo[]): void;
    /** Sets what `hasDeviceList` reports; false also empties the list. Sends nothing. */
    setHasDeviceList(has: boolean): void;
    emit(event: RawEvent): void;
    setFault(fault: string | undefined): void;
    /** Sets the link and sends `link_up` or `link_down`. */
    setLink(up: boolean): void;
    followed(): ReadonlySet<string>;
    /** Every set given to `follow`, oldest first. */
    followCalls(): readonly ReadonlySet<string>[];
    /** Every send that went out (failed ones are not listed). */
    sent(): readonly StubSend[];
    /** The next `count` sends reject with a HeatmasterError of `code` (default mqtt_timeout). */
    failNext(count: number, code?: string): void;
    /** Sends (to `deviceId` only, when given) wait until the returned function is called. */
    holdSends(deviceId?: string): () => void;
    /** Every call of a send, also failed or held ones, in call order. */
    attempts(): readonly StubSend[];
    started(): boolean;
    stopped(): boolean;
  }>;

export function createStubTransport(key: string): StubTransport {
  let devices = new Map<string, DeviceInfo>();
  let hasDeviceList = false;
  let fault: string | undefined;
  let link = true;
  let listener: ((event: RawEvent) => void) | undefined;
  let followed: ReadonlySet<string> = new Set();
  const followCalls: ReadonlySet<string>[] = [];
  const sent: StubSend[] = [];
  const attempts: StubSend[] = [];
  const failures: string[] = [];
  // Keyed by device id; "" holds every device.
  const gates = new Map<string, Promise<void>>();
  let started = false;
  let stopped = false;

  async function send(
    kind: "publish" | "read",
    deviceId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const entry: StubSend = { kind, deviceId, payload };
    attempts.push(entry);
    const failure = failures.shift();
    const gate = gates.get("") ?? gates.get(deviceId);
    if (gate !== undefined) await gate;
    if (failure !== undefined) throw new HeatmasterError(failure);
    if (!devices.has(deviceId)) throw new HeatmasterError("device_unknown", { deviceId });
    sent.push(entry);
  }

  return {
    key,
    fault: () => fault,
    linkUp: () => link,
    devices: () => devices,
    hasDeviceList: () => hasDeviceList,
    start(next) {
      listener = next;
      started = true;
      return Promise.resolve();
    },
    follow(deviceIds) {
      followed = new Set(deviceIds);
      followCalls.push(followed);
    },
    publish: (deviceId, payload) => send("publish", deviceId, payload),
    read: (deviceId, payload) => send("read", deviceId, payload),
    stop() {
      stopped = true;
      listener = undefined;
      return Promise.resolve();
    },
    setDevices(list) {
      devices = new Map(list.map((device) => [device.deviceId, device]));
      hasDeviceList = true;
      listener?.({ kind: "devices_changed" });
    },
    setHasDeviceList(has) {
      hasDeviceList = has;
      if (!has) devices = new Map();
    },
    emit(event) {
      listener?.(event);
    },
    setFault(next) {
      fault = next;
    },
    setLink(up) {
      link = up;
      listener?.({ kind: up ? "link_up" : "link_down" });
    },
    followed: () => followed,
    followCalls: () => [...followCalls],
    sent: () => [...sent],
    failNext(count, code = "mqtt_timeout") {
      for (let i = 0; i < count; i += 1) failures.push(code);
    },
    holdSends(deviceId = "") {
      let release: () => void = () => undefined;
      gates.set(
        deviceId,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return () => {
        gates.delete(deviceId);
        release();
      };
    },
    attempts: () => [...attempts],
    started: () => started,
    stopped: () => stopped,
  };
}
