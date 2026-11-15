import net from "node:net";
import mqttPacket from "mqtt-packet";
import type { Packet } from "mqtt-packet";

/** A packet the client sent, with the moment it arrived and the connection it arrived on. */
export type RecordedPacket = Readonly<{ at: number; connection: number; packet: Packet }>;

export type RawBroker = Readonly<{
  url: string;
  port: number;
  packets(): readonly RecordedPacket[];
  withholdAcks(on: boolean): void;
  withholdConnack(on: boolean): void;
  refuseLogin(on: boolean): void;
  /** Sends a DISCONNECT packet with the reason code, then closes. */
  disconnect(reasonCode: number): void;
  /** Closes the sockets without a word. */
  drop(): void;
  /** Sends a message to every connected client, whatever it subscribed to. */
  deliver(topic: string, payload: string, retain?: boolean): void;
  stop(): Promise<void>;
}>;

interface Connection {
  readonly id: number;
  readonly socket: net.Socket;
  version: number;
  connect: Packet | undefined;
}

/**
 * A scripted MQTT endpoint on a local TCP port. It speaks MQTT 5 and, for a client that asks for
 * it, enough of 3.1.1 to accept the connection. It records every packet it receives.
 */
export async function startRawBroker(
  options: Readonly<{ port?: number }> = {},
): Promise<RawBroker> {
  const recorded: RecordedPacket[] = [];
  const connections = new Set<Connection>();
  const waiting = new Set<Connection>();
  let held = false;
  let refused = false;
  let acksHeld = false;
  let nextId = 0;

  function send(connection: Connection, packet: Packet): void {
    if (connection.socket.destroyed) return;
    connection.socket.write(mqttPacket.generate(packet, { protocolVersion: connection.version }));
  }

  function answerConnect(connection: Connection): void {
    if (refused) {
      send(
        connection,
        connection.version === 5
          ? { cmd: "connack", reasonCode: 134, sessionPresent: false }
          : { cmd: "connack", returnCode: 4, sessionPresent: false },
      );
      connection.socket.end();
      return;
    }
    send(
      connection,
      connection.version === 5
        ? { cmd: "connack", reasonCode: 0, sessionPresent: false }
        : { cmd: "connack", returnCode: 0, sessionPresent: false },
    );
  }

  function handle(connection: Connection, packet: Packet): void {
    recorded.push({ at: Date.now(), connection: connection.id, packet });
    switch (packet.cmd) {
      case "connect":
        connection.version = packet.protocolVersion ?? 4;
        connection.connect = packet;
        if (held) waiting.add(connection);
        else answerConnect(connection);
        break;
      case "subscribe":
        send(connection, {
          cmd: "suback",
          messageId: packet.messageId ?? 0,
          granted: packet.subscriptions.map((subscription) => subscription.qos),
        });
        break;
      case "unsubscribe":
        send(connection, {
          cmd: "unsuback",
          messageId: packet.messageId ?? 0,
          granted: packet.unsubscriptions.map(() => 0),
        });
        break;
      case "publish":
        if (packet.qos === 1 && !acksHeld) {
          send(connection, { cmd: "puback", messageId: packet.messageId ?? 0 });
        }
        break;
      case "pingreq":
        send(connection, { cmd: "pingresp" });
        break;
      case "disconnect":
        connection.socket.end();
        break;
      default:
        break;
    }
  }

  const server = net.createServer((socket) => {
    const connection: Connection = {
      id: (nextId += 1),
      socket,
      version: 5,
      connect: undefined,
    };
    connections.add(connection);
    const parser = mqttPacket.parser();
    parser.on("packet", (packet) => {
      handle(connection, packet);
    });
    parser.on("error", () => {
      socket.destroy();
    });
    socket.on("data", (data) => {
      parser.parse(Buffer.from(data));
    });
    socket.on("error", () => {
      /* a reset by the client is not the broker's problem */
    });
    socket.on("close", () => {
      connections.delete(connection);
      waiting.delete(connection);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const port = (server.address() as net.AddressInfo).port;

  return {
    url: `mqtt://127.0.0.1:${String(port)}`,
    port,
    packets: () => [...recorded],
    withholdAcks(on) {
      acksHeld = on;
    },
    withholdConnack(on) {
      held = on;
      if (!on) {
        for (const connection of [...waiting]) {
          waiting.delete(connection);
          answerConnect(connection);
        }
      }
    },
    refuseLogin(on) {
      refused = on;
    },
    disconnect(reasonCode) {
      for (const connection of connections) {
        send(connection, { cmd: "disconnect", reasonCode });
        connection.socket.end();
      }
    },
    drop() {
      for (const connection of connections) connection.socket.destroy();
    },
    deliver(topic, payload, retain = false) {
      for (const connection of connections) {
        send(connection, {
          cmd: "publish",
          topic,
          payload: Buffer.from(payload),
          qos: 0,
          retain,
          dup: false,
        });
      }
    },
    async stop() {
      for (const connection of connections) connection.socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
