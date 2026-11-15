import mqtt from "mqtt";
import type { IClientOptions, MqttClient as JsClient } from "mqtt";
import type { Clock } from "./clock.ts";
import { HeatmasterError } from "./errors.ts";

export type MqttOptions = Readonly<{
  url: string;
  username: string | undefined;
  password: string | undefined;
  clientId: string | undefined;
}>;

export type MqttTuning = Readonly<{
  reconnectPeriodMs: number;
  connectTimeoutMs: number;
  authRetryMs: number;
}>;

export const DEFAULT_TUNING: MqttTuning = {
  reconnectPeriodMs: 1000,
  connectTimeoutMs: 10 * 1000,
  authRetryMs: 30 * 1000,
};

export const DEFAULT_CLIENT_ID = "heatmaster";
export const STATUS_TOPIC = "heatmaster/status";
export const STATUS_ONLINE = "online";
export const STATUS_OFFLINE = "offline";
/** MQTT 5 reason code "session taken over". */
export const TAKEOVER_REASON = 142;
export const TAKEOVER_DROPS = 3;
export const TAKEOVER_WINDOW_MS = 30 * 1000;
export const PUBLISH_TIMEOUT_MS = 5 * 1000;

export type MqttState = "connecting" | "connected" | "disconnected" | "ended";
export type MqttFault = "mqtt_unavailable" | "mqtt_auth_failed" | "another_instance";
export type MqttEvent =
  | Readonly<{ kind: "connected"; first: boolean }>
  | Readonly<{ kind: "disconnected" }>
  | Readonly<{ kind: "taken_over" }>;

export type MessageHandler = (topic: string, payload: Buffer, retained: boolean) => void;

export type MqttClient = Readonly<{
  /** Starts connecting. Resolves when a connection is established or two attempts have failed. */
  connect(): Promise<void>;
  state(): MqttState;
  fault(): MqttFault | undefined;
  /** The MQTT version of the established connection; undefined until one succeeded. */
  protocol(): 4 | 5 | undefined;
  /** An exact topic, or a topic in which whole levels are `+`. */
  subscribe(filter: string, handler: MessageHandler): () => void;
  publish(
    topic: string,
    payload: string,
    options: Readonly<{ qos: 0 | 1; retain: boolean }>,
  ): Promise<void>;
  onEvent(listener: (event: MqttEvent) => void): () => void;
  end(): Promise<void>;
}>;

// MQTT 3.1.1 CONNACK return codes 4 and 5, MQTT 5 reason codes 0x86 and 0x87.
const LOGIN_REFUSED: Readonly<Record<4 | 5, readonly number[]>> = { 4: [4, 5], 5: [134, 135] };

interface Attempt {
  /** The socket opened: the broker was reached. */
  reached: boolean;
  refusedLogin: boolean;
  timedOut: boolean;
  established: boolean;
  settled: boolean;
}

type Pending = Readonly<{ fail(): void }>;

function logError(message: string, error: unknown): void {
  console.error(JSON.stringify({ level: "error", msg: message, err: String(error) }));
}

function validateFilter(filter: string): void {
  const levels = filter.split("/");
  const valid =
    filter !== "" &&
    levels.every((level) => !level.includes("#") && (!level.includes("+") || level === "+"));
  if (!valid) throw new HeatmasterError("topic_invalid", { topic: filter });
}

function matches(filter: string, topic: string): boolean {
  if (filter === topic) return true;
  const wanted = filter.split("/");
  const actual = topic.split("/");
  return (
    wanted.length === actual.length &&
    wanted.every((level, i) => level === "+" || level === actual[i])
  );
}

export function createMqttClient(
  options: MqttOptions,
  clock: Clock,
  tuning: MqttTuning = DEFAULT_TUNING,
): MqttClient {
  let js: JsClient | undefined;
  let state: MqttState = "disconnected";
  let attempt: Attempt = freshAttempt();
  let established: 4 | 5 | undefined;
  let authRefused = false;
  let takenOver = false;
  let closing = false;
  let failedAttempts = 0;
  let connectPromise: Promise<void> | undefined;
  let endPromise: Promise<void> | undefined;
  let drops: number[] = [];
  const waiters: (() => void)[] = [];
  const filters = new Map<string, Set<MessageHandler>>();
  const listeners = new Set<(event: MqttEvent) => void>();
  const pending = new Set<Pending>();

  function freshAttempt(): Attempt {
    return {
      reached: false,
      refusedLogin: false,
      timedOut: false,
      established: false,
      settled: false,
    };
  }

  function emit(event: MqttEvent): void {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        logError("an MQTT event listener failed", error);
      }
    }
  }

  function releaseConnect(): void {
    for (const resolve of waiters.splice(0)) resolve();
  }

  function failPending(): void {
    for (const entry of [...pending]) entry.fail();
  }

  /** A failed attempt: counts toward resolving `connect`, and may change the protocol version. */
  function settleFailed(current: Attempt): void {
    if (current.settled || js === undefined) return;
    current.settled = true;
    authRefused = current.refusedLogin;
    if (
      established === undefined &&
      current.reached &&
      !current.refusedLogin &&
      !current.timedOut
    ) {
      js.options.protocolVersion = js.options.protocolVersion === 5 ? 4 : 5;
    }
    failedAttempts += 1;
    if (failedAttempts >= 2) releaseConnect();
  }

  function takeover(): void {
    if (takenOver) return;
    takenOver = true;
    state = "ended";
    failPending();
    js?.end(true);
    releaseConnect();
    emit({ kind: "taken_over" });
  }

  function onLoss(): void {
    state = "disconnected";
    failPending();
    emit({ kind: "disconnected" });
    drops.push(clock.monoMs());
    drops = drops.slice(-TAKEOVER_DROPS);
    const oldest = drops[0];
    const newest = drops[drops.length - 1];
    if (
      drops.length === TAKEOVER_DROPS &&
      oldest !== undefined &&
      newest !== undefined &&
      newest - oldest <= TAKEOVER_WINDOW_MS
    ) {
      takeover();
    }
  }

  function dispatch(topic: string, payload: Buffer, retained: boolean): void {
    for (const [filter, handlers] of [...filters]) {
      if (!matches(filter, topic)) continue;
      for (const handler of [...handlers]) {
        try {
          handler(topic, payload, retained);
        } catch (error) {
          logError(`an MQTT handler for ${filter} failed`, error);
        }
      }
    }
  }

  function brokerSubscribe(client: JsClient, filter: string): void {
    client.subscribe(filter, { qos: 0 }, (error) => {
      if (error) logError(`subscribing to ${filter} failed`, error);
    });
  }

  function publish(
    topic: string,
    payload: string,
    publishOptions: Readonly<{ qos: 0 | 1; retain: boolean }>,
  ): Promise<void> {
    const client = js;
    if (state !== "connected" || client === undefined) {
      return Promise.reject(new HeatmasterError("mqtt_not_connected"));
    }
    const connection: JsClient = client;
    return new Promise<void>((resolve, reject) => {
      let finished = false;
      const entry: Pending = {
        fail: () => {
          settle(new HeatmasterError("mqtt_timeout"), true);
        },
      };
      const cancelTimer = clock.after(PUBLISH_TIMEOUT_MS, entry.fail);
      function callback(error?: Error | null): void {
        // MQTT.js passes null, not undefined, when nothing went wrong.
        settle(error ? new HeatmasterError("mqtt_not_connected") : undefined, false);
      }
      function settle(error: HeatmasterError | undefined, removeFromStore: boolean): void {
        if (finished) return;
        finished = true;
        cancelTimer();
        pending.delete(entry);
        if (removeFromStore) {
          // The message id is not returned by `publish`; the outgoing store maps it to the callback.
          const found = Object.entries(connection.outgoing).find(
            ([, outgoing]) => outgoing.cb === callback,
          );
          if (found !== undefined) connection.removeOutgoingMessage(Number(found[0]));
        }
        if (error === undefined) resolve();
        else reject(error);
      }
      pending.add(entry);
      client.publish(
        topic,
        payload,
        { qos: publishOptions.qos, retain: publishOptions.retain },
        callback,
      );
    });
  }

  function onConnected(client: JsClient): void {
    if (closing || takenOver) return;
    attempt.established = true;
    attempt.settled = true;
    authRefused = false;
    const first = established === undefined;
    established = client.options.protocolVersion === 5 ? 5 : 4;
    state = "connected";
    for (const filter of filters.keys()) brokerSubscribe(client, filter);
    publish(STATUS_TOPIC, STATUS_ONLINE, { qos: 1, retain: true }).catch((error: unknown) => {
      logError("publishing the online status failed", error);
    });
    emit({ kind: "connected", first });
    releaseConnect();
  }

  function create(): JsClient {
    const clientOptions: IClientOptions = {
      clientId: options.clientId ?? DEFAULT_CLIENT_ID,
      clean: true,
      protocolVersion: 5,
      will: { topic: STATUS_TOPIC, payload: Buffer.from(STATUS_OFFLINE), qos: 1, retain: true },
      reconnectPeriod: tuning.reconnectPeriodMs,
      connectTimeout: tuning.connectTimeoutMs,
      reconnectOnConnackError: true,
      queueQoSZero: false,
      // Subscriptions are made again by this module after every connection.
      resubscribe: false,
      manualConnect: true,
    };
    if (options.username !== undefined) clientOptions.username = options.username;
    if (options.password !== undefined) clientOptions.password = options.password;
    const client = mqtt.connect(options.url, clientOptions);

    client.on("packetsend", (packet) => {
      if (packet.cmd !== "connect") return;
      // A CONNECT is written once per attempt, on the stream of that attempt.
      const current = freshAttempt();
      attempt = current;
      const reached = (): void => {
        current.reached = true;
      };
      client.stream.once("connect", reached);
      client.stream.once("secureConnect", reached);
    });
    client.on("reconnect", () => {
      client.options.reconnectPeriod = tuning.reconnectPeriodMs;
      if (!closing && !takenOver) state = "connecting";
    });
    client.on("connect", () => {
      onConnected(client);
    });
    client.on("error", (error) => {
      const code = (error as Error & { code?: unknown }).code;
      if (error.message === "connack timeout") {
        attempt.timedOut = true;
      } else if (typeof code === "number" && error.message.startsWith("Connection refused")) {
        attempt.reached = true;
        const version = client.options.protocolVersion === 5 ? 5 : 4;
        if (LOGIN_REFUSED[version].includes(code)) {
          attempt.refusedLogin = true;
          client.options.reconnectPeriod = tuning.authRetryMs;
        }
        settleFailed(attempt);
      }
    });
    client.on("disconnect", (packet) => {
      if (packet.reasonCode === TAKEOVER_REASON && !closing) takeover();
    });
    client.on("close", () => {
      if (closing || takenOver) return;
      if (attempt.established) {
        attempt.established = false;
        onLoss();
      } else {
        if (state !== "connected") state = "disconnected";
        settleFailed(attempt);
      }
    });
    client.on("message", (topic, payload, packet) => {
      dispatch(topic, payload, packet.retain);
    });
    return client;
  }

  async function doEnd(): Promise<void> {
    const client = js;
    if (client === undefined || takenOver) {
      closing = true;
      if (!takenOver) state = "ended";
      releaseConnect();
      return;
    }
    const graceful = state === "connected";
    if (graceful) {
      try {
        await publish(STATUS_TOPIC, STATUS_OFFLINE, { qos: 1, retain: true });
      } catch (error) {
        logError("publishing the offline status failed", error);
      }
    }
    closing = true;
    state = "ended";
    failPending();
    releaseConnect();
    await client.endAsync(!graceful);
  }

  return {
    connect() {
      if (connectPromise !== undefined) return connectPromise;
      state = "connecting";
      connectPromise = new Promise<void>((resolve) => waiters.push(resolve));
      js = create();
      js.connect();
      return connectPromise;
    },
    state: () => state,
    fault() {
      if (takenOver) return "another_instance";
      if (authRefused) return "mqtt_auth_failed";
      if (established === undefined) return "mqtt_unavailable";
      return undefined;
    },
    protocol: () => established,
    subscribe(filter, handler) {
      validateFilter(filter);
      const handlers = filters.get(filter) ?? new Set<MessageHandler>();
      const isNew = handlers.size === 0;
      handlers.add(handler);
      filters.set(filter, handlers);
      if (isNew && state === "connected" && js !== undefined) brokerSubscribe(js, filter);
      return () => {
        if (!handlers.delete(handler) || handlers.size > 0) return;
        filters.delete(filter);
        if (state === "connected" && js !== undefined) {
          js.unsubscribe(filter, (error) => {
            if (error) logError(`unsubscribing from ${filter} failed`, error);
          });
        }
      };
    },
    publish,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    end: () => (endPromise ??= doEnd()),
  };
}
