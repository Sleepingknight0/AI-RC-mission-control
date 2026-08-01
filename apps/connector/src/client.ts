import { createServer, type Server } from "node:http";

import {
  CoreToConnectorEnvelopeSchema,
  RuntimeSchema,
  decodeJson,
  makeEnvelope,
} from "@aicl/protocol";
import WebSocket from "ws";

import { normalizeMockEvent, runMockProvider } from "./mock-provider.js";

export interface MockConnectorOptions {
  coreUrl: string;
  healthPort?: number;
  providerDelayMs?: number;
  reconnectDelayMs?: number;
}

export interface MockConnectorHandle {
  ready: Promise<void>;
  close(): Promise<void>;
}

const runtimeId = "runtime-mock-1";

export function startMockConnector(
  options: MockConnectorOptions,
): MockConnectorHandle {
  let stopped = false;
  let socket: WebSocket | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let healthServer: Server | undefined;
  let readyResolved = false;
  let resolveReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const runtime = (status: "ready" | "busy") =>
    RuntimeSchema.parse({ runtimeId, generation: 1, status });

  const send = (value: unknown) => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(value));
    }
  };

  const runTurn = async (
    command: ReturnType<typeof CoreToConnectorEnvelopeSchema.parse>,
  ) => {
    send(makeEnvelope("connector.runtime.status", { runtime: runtime("busy") }));
    const messageId = `message-${command.payload.turnId}`;
    for await (const rawEvent of runMockProvider(
      command.payload.prompt,
      options.providerDelayMs,
    )) {
      send(
        normalizeMockEvent(rawEvent, {
          sessionId: command.payload.sessionId,
          turnId: command.payload.turnId,
          messageId,
        }),
      );
    }
    send(makeEnvelope("connector.runtime.status", { runtime: runtime("ready") }));
  };

  const connect = () => {
    if (stopped) return;
    socket = new WebSocket(options.coreUrl);
    socket.on("open", () => {
      send(makeEnvelope("connector.hello", { runtime: runtime("ready") }));
      if (!readyResolved) {
        readyResolved = true;
        resolveReady();
      }
    });
    socket.on("message", (data) => {
      try {
        const command = CoreToConnectorEnvelopeSchema.parse(
          decodeJson(data.toString()),
        );
        void runTurn(command);
      } catch (error) {
        console.error("Connector rejected an invalid Core envelope", error);
      }
    });
    socket.on("close", () => {
      if (!stopped) {
        reconnectTimer = setTimeout(
          connect,
          options.reconnectDelayMs ?? 250,
        );
      }
    });
    socket.on("error", () => {
      socket?.close();
    });
  };

  if (options.healthPort !== undefined) {
    healthServer = createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            component: "connector",
            status: socket?.readyState === WebSocket.OPEN ? "ready" : "offline",
          }),
        );
        return;
      }
      response.writeHead(404).end();
    });
    healthServer.listen(options.healthPort, "127.0.0.1");
  }

  connect();

  return {
    ready,
    async close() {
      stopped = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      socket?.close();
      if (healthServer !== undefined) {
        await new Promise<void>((resolve, reject) => {
          healthServer?.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  };
}
