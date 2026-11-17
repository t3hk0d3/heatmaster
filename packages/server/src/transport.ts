/** What every transport (Zigbee2MQTT now, others later) looks like to the rest of the server. */

export type DeviceInfo = Readonly<{
  /** `<transport>:<address>`. */
  deviceId: string;
  transport: string;
  address: string;
  modelId: string;
  manufacturer: string | undefined;
  firmware: string | undefined;
  name: string;
}>;

export type RawEvent =
  | Readonly<{
      kind: "message";
      deviceId: string;
      payload: Readonly<Record<string, unknown>>;
      lifeToken: string | undefined;
    }>
  | Readonly<{ kind: "rejoined"; deviceId: string }>
  | Readonly<{ kind: "bridge_restarted" }>
  | Readonly<{ kind: "link_up" }>
  | Readonly<{ kind: "link_down" }>
  | Readonly<{ kind: "devices_changed" }>;

export type Transport = Readonly<{
  key: string;
  /** Why the transport cannot be used, or undefined. */
  fault(): string | undefined;
  linkUp(): boolean;
  /** Keyed by `deviceId`. */
  devices(): ReadonlyMap<string, DeviceInfo>;
  /**
   * Whether the transport has delivered its device list at least once since the start. Until then
   * `devices()` is empty for want of a list, not because the devices are gone.
   */
  hasDeviceList(): boolean;
  start(listener: (event: RawEvent) => void): Promise<void>;
  /** The devices to deliver messages for; replaces the previous set. */
  follow(deviceIds: ReadonlySet<string>): void;
  /** A write. */
  publish(deviceId: string, payload: Readonly<Record<string, unknown>>): Promise<void>;
  /** A request to report. */
  read(deviceId: string, payload: Readonly<Record<string, unknown>>): Promise<void>;
  stop(): Promise<void>;
}>;
