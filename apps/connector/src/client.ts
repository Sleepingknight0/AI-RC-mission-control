import { createServer, type Server } from "node:http";

import {
  ConnectorEnvelopeSchema,
  CoreToConnectorEnvelopeSchema,
  RuntimeSchema,
  decodeJson,
  makeEnvelope,
  type ConnectorEnvelope,
  type CoreToConnectorEnvelope,
} from "@aicl/protocol";
import WebSocket from "ws";

import { ConnectorJournal } from "./journal.js";
import { MockProvider } from "./mock-provider.js";
import { ProviderLostError, type ConnectorProvider } from "./provider.js";

export interface ConnectorOptions {
  coreUrl: string;
  provider: ConnectorProvider;
  providerName: string;
  healthPort?: number;
  reconnectDelayMs?: number;
  runtimeId?: string;
  runtimeGeneration?: number;
  journalPath?: string;
  connectorId?: string;
  healthDetails?: Record<string, unknown>;
}

export interface MockConnectorOptions {
  coreUrl: string;
  healthPort?: number;
  providerDelayMs?: number;
  reconnectDelayMs?: number;
  journalPath?: string;
}

export interface ConnectorHandle {
  ready: Promise<void>;
  identity: {
    connectorId: string;
    bootId: string;
    runtimeId: string;
    generation: number;
  };
  close(): Promise<void>;
}

export function startConnector(options: ConnectorOptions): ConnectorHandle {
  const journal = new ConnectorJournal({
    path: options.journalPath ?? ":memory:",
    ...(options.connectorId === undefined ? {} : { connectorId: options.connectorId }),
    ...(options.runtimeId === undefined ? {} : { runtimeId: options.runtimeId }),
    ...(options.runtimeGeneration === undefined
      ? {}
      : { runtimeGeneration: options.runtimeGeneration }),
  });
  let stopped = false;
  let providerLost = false;
  let runtimeStatus: "ready" | "busy" | "lost" = "ready";
  let socket: WebSocket | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let healthServer: Server | undefined;
  let readyResolved = false;
  let resolveReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const runtime = (status: "ready" | "busy" | "lost") =>
    RuntimeSchema.parse({
      runtimeId: journal.runtimeId,
      generation: journal.runtimeGeneration,
      status,
    });

  const sendRaw = (envelope: ConnectorEnvelope) => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(envelope));
    }
  };

  const decorateEphemeral = (envelope: ConnectorEnvelope) =>
    ConnectorEnvelopeSchema.parse({
      ...envelope,
      connectorId: journal.connectorId,
      bootId: journal.bootId,
      runtimeId: journal.runtimeId,
      runtimeGeneration: journal.runtimeGeneration,
    });

  const emit = (envelope: ConnectorEnvelope) => {
    if (envelope.type === "connector.turn.delta") {
      sendRaw(decorateEphemeral(envelope));
      return;
    }
    if (envelope.type === "connector.hello") {
      sendRaw(envelope);
      return;
    }
    const status =
      envelope.type === "connector.runtime.status"
        ? envelope.payload.runtime
        : runtime(providerLost ? "lost" : "busy");
    if (envelope.type === "connector.session.bound") {
      journal.checkpoint(status, envelope.payload.providerSessionId);
    }
    sendRaw(journal.enqueue(envelope, status));
  };

  const emitRuntime = (status: "ready" | "busy" | "lost") => {
    runtimeStatus = status;
    const next = runtime(status);
    journal.checkpoint(next);
    emit(makeEnvelope("connector.runtime.status", { runtime: next }));
  };

  const unsubscribeLost = options.provider.onLost(() => {
    providerLost = true;
    emitRuntime("lost");
  });

  const handleCommand = async (
    command: CoreToConnectorEnvelope,
  ) => {
    if (command.type === "connector.journal.ack") {
      journal.acknowledge(command.payload.sourceEventId);
      return;
    }
    const decision = journal.recordCommand(command);
    if (decision === "same") return;
    if (decision === "conflict") {
      emit(
        makeEnvelope("connector.command.error", {
          commandId: command.payload.commandId,
          sessionId: command.payload.sessionId,
          code: "IDEMPOTENCY_KEY_REUSE",
          message: "Connector commandId was reused with a different payload.",
          retryable: false,
        }),
      );
      return;
    }
    journal.markCommand(command.payload.commandId, "dispatching");

    if (command.type === "connector.turn.interrupt") {
      try {
        await options.provider.interrupt(command);
        journal.markCommand(command.payload.commandId, "completed");
      } catch (error) {
        journal.markCommand(command.payload.commandId, "outcome_unknown");
        emit(
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
    emitRuntime("busy");
    try {
      await options.provider.startTurn(command, emit);
      journal.markCommand(command.payload.commandId, "completed");
      if (!providerLost) emitRuntime("ready");
    } catch (error) {
      if (error instanceof ProviderLostError) {
        journal.markCommand(command.payload.commandId, "outcome_unknown");
        return;
      }
      journal.markCommand(command.payload.commandId, "completed", {
        failureCode: "PROVIDER_REJECTED",
      });
      emit(
        makeEnvelope("connector.turn.failed", {
          sessionId: command.payload.sessionId,
          turnId: command.payload.turnId,
          failureCode: "PROVIDER_REJECTED",
        }),
      );
      emitRuntime("ready");
    }
  };

  const connect = () => {
    if (stopped) return;
    socket = new WebSocket(options.coreUrl);
    socket.on("open", () => {
      const readyRuntime = runtime(providerLost ? "lost" : runtimeStatus);
      sendRaw(
        ConnectorEnvelopeSchema.parse(
          makeEnvelope("connector.hello", {
            connectorId: journal.connectorId,
            bootId: journal.bootId,
            runtime: readyRuntime,
          }),
        ),
      );
      for (const event of journal.pendingEvents()) sendRaw(event);
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
        reconnectTimer = setTimeout(connect, options.reconnectDelayMs ?? 250);
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
            connectorId: journal.connectorId,
            bootId: journal.bootId,
            runtimeGeneration: journal.runtimeGeneration,
            journalBacklog: journal.unacknowledgedCount(),
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
    identity: {
      connectorId: journal.connectorId,
      bootId: journal.bootId,
      runtimeId: journal.runtimeId,
      generation: journal.runtimeGeneration,
    },
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
      journal.close();
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
    journalPath: options.journalPath ?? ":memory:",
    ...(options.healthPort === undefined ? {} : { healthPort: options.healthPort }),
    ...(options.reconnectDelayMs === undefined
      ? {}
      : { reconnectDelayMs: options.reconnectDelayMs }),
  });
}
