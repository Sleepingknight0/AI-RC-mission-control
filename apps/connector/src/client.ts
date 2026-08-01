import { createServer, type Server } from "node:http";

import {
  ConnectorEnvelopeSchema,
  CoreToConnectorEnvelopeSchema,
  RuntimeSchema,
  decodeJson,
  makeEnvelope,
} from "@aicl/protocol";
import WebSocket from "ws";

import { MockProvider } from "./mock-provider.js";
import {
  ProviderLostError,
  type ConnectorProvider,
} from "./provider.js";

export interface ConnectorOptions {
  coreUrl: string;
  provider: ConnectorProvider;
  providerName: string;
  healthPort?: number;
  reconnectDelayMs?: number;
  runtimeId?: string;
  runtimeGeneration?: number;
  healthDetails?: Record<string, unknown>;
}

export interface MockConnectorOptions {
  coreUrl: string;
  healthPort?: number;
  providerDelayMs?: number;
  reconnectDelayMs?: number;
}

export interface ConnectorHandle {
  ready: Promise<void>;
  close(): Promise<void>;
}

export function startConnector(options: ConnectorOptions): ConnectorHandle {
  let stopped = false;
  let providerLost = false;
  let socket: WebSocket | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let healthServer: Server | undefined;
  let readyResolved = false;
  let resolveReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const runtimeId = options.runtimeId ?? `runtime-${crypto.randomUUID()}`;
  const generation = options.runtimeGeneration ?? Date.now();

  const runtime = (status: "ready" | "busy" | "lost") =>
    RuntimeSchema.parse({ runtimeId, generation, status });

  const send = (value: unknown) => {
    const envelope = ConnectorEnvelopeSchema.parse(value);
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(envelope));
    }
  };

  const unsubscribeLost = options.provider.onLost(() => {
    providerLost = true;
    send(makeEnvelope("connector.runtime.status", { runtime: runtime("lost") }));
  });

  const handleCommand = async (
    command: ReturnType<typeof CoreToConnectorEnvelopeSchema.parse>,
  ) => {
    if (command.type === "connector.turn.interrupt") {
      try {
        await options.provider.interrupt(command);
      } catch (error) {
        send(
          makeEnvelope("connector.command.error", {
            commandId: command.payload.commandId,
            sessionId: command.payload.sessionId,
            code: "INTERRUPT_FAILED",
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
          }),
        );
      }
      return;
    }

    providerLost = false;
    send(makeEnvelope("connector.runtime.status", { runtime: runtime("busy") }));
    try {
      await options.provider.startTurn(command, send);
      if (!providerLost) {
        send(makeEnvelope("connector.runtime.status", { runtime: runtime("ready") }));
      }
    } catch (error) {
      if (error instanceof ProviderLostError) return;
      send(
        makeEnvelope("connector.turn.failed", {
          sessionId: command.payload.sessionId,
          turnId: command.payload.turnId,
          failureCode: "PROVIDER_REJECTED",
        }),
      );
      send(makeEnvelope("connector.runtime.status", { runtime: runtime("ready") }));
    }
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
        void handleCommand(command);
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
    socket.on("error", () => socket?.close());
  };

  if (options.healthPort !== undefined) {
    healthServer = createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            component: "connector",
            provider: options.providerName,
            status: providerLost
              ? "lost"
              : socket?.readyState === WebSocket.OPEN
                ? "ready"
                : "offline",
            ...options.healthDetails,
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
      unsubscribeLost();
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      socket?.close();
      await options.provider.close();
      if (healthServer !== undefined) {
        await new Promise<void>((resolve, reject) => {
          healthServer?.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  };
}

export function startMockConnector(
  options: MockConnectorOptions,
): ConnectorHandle {
  return startConnector({
    coreUrl: options.coreUrl,
    provider: new MockProvider(options.providerDelayMs),
    providerName: "mock",
    runtimeId: "runtime-mock-1",
    runtimeGeneration: 1,
    ...(options.healthPort === undefined ? {} : { healthPort: options.healthPort }),
    ...(options.reconnectDelayMs === undefined
      ? {}
      : { reconnectDelayMs: options.reconnectDelayMs }),
  });
}
