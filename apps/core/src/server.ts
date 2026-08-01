import { createServer, type Server as HttpServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ClientEnvelopeSchema,
  ConnectorEnvelopeSchema,
  ServerEnvelopeSchema,
  decodeJson,
  makeEnvelope,
  type ClientEnvelope,
  type ConnectorEnvelope,
  type ProtocolError,
  type Runtime,
  type ServerEnvelope,
} from "@aicl/protocol";
import WebSocket, { WebSocketServer } from "ws";

import { CoreDatabase, type ConnectorSource } from "./store.js";

export const DEFAULT_CORE_DB_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../.data/aicl-core.db",
);

export interface CoreServerOptions {
  host?: string;
  port?: number;
  dbPath?: string;
  connectorLossGraceMs?: number;
  beforeDurableBroadcast?: (event: ServerEnvelope) => void;
  onBroadcastError?: (error: unknown, event: ServerEnvelope) => void;
}

export interface CoreServerHandle {
  host: string;
  port: number;
  browserUrl: string;
  connectorUrl: string;
  dbPath: string;
  close(): Promise<void>;
}

interface ConnectorConnection {
  socket: WebSocket;
  connectorId: string;
  bootId: string;
  runtime: Runtime;
}

function validatedServerEnvelope(value: unknown): ServerEnvelope {
  return ServerEnvelopeSchema.parse(value);
}

function protocolError(
  code: string,
  message: string,
  input: { commandId?: string; sessionId?: string; retryable?: boolean } = {},
): ProtocolError {
  return {
    code,
    message,
    retryable: input.retryable ?? false,
    ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
  };
}

export async function startCoreServer(
  options: CoreServerOptions = {},
): Promise<CoreServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const dbPath = options.dbPath ?? process.env.AICL_CORE_DB_PATH ?? DEFAULT_CORE_DB_PATH;
  const store = new CoreDatabase({ path: dbPath });
  const clients = new Map<WebSocket, string | null>();
  let connector: WebSocket | undefined;
  let connectorConnection: ConnectorConnection | undefined;
  let connectorLossTimer: NodeJS.Timeout | undefined;
  let lastRuntime: Runtime | undefined = store.latestRuntime();
  let closing = false;

  const httpServer: HttpServer = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          component: "core",
          status: "ready",
          connectorConnected:
            connectorConnection?.socket.readyState === WebSocket.OPEN,
          databaseSchemaVersion: store.schemaVersion,
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  const socketServer = new WebSocketServer({ noServer: true });

  const send = (socket: WebSocket, value: unknown) => {
    const envelope = validatedServerEnvelope(value);
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(envelope));
    }
  };

  const sendConnector = (socket: WebSocket, value: unknown) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
  };

  const broadcast = (sessionId: string | null, value: unknown) => {
    const envelope = validatedServerEnvelope(value);
    const json = JSON.stringify(envelope);
    for (const [client, subscribedSession] of clients) {
      if (
        client.readyState === WebSocket.OPEN &&
        (sessionId === null || subscribedSession === sessionId)
      ) {
        client.send(json);
      }
    }
  };

  // Durable envelopes arrive here only after the writer transaction commits.
  // Ephemeral deltas deliberately bypass this hook and never create token rows.
  const broadcastDurable = (event: ServerEnvelope) => {
    try {
      options.beforeDurableBroadcast?.(event);
      const sessionId = sessionIdOf(event);
      broadcast(sessionId, event);
    } catch (error) {
      options.onBroadcastError?.(error, event);
      if (options.onBroadcastError === undefined) {
        console.error("Durable event committed but broadcast failed", error);
      }
    }
  };

  const rejection = (input: {
    commandId: string;
    sessionId: string;
    code: string;
    message: string;
  }) =>
    validatedServerEnvelope(
      makeEnvelope("command.rejected", {
        commandId: input.commandId,
        sessionId: input.sessionId,
        error: protocolError(input.code, input.message, {
          commandId: input.commandId,
          sessionId: input.sessionId,
        }),
      }),
    );

  const sendConflict = (
    socket: WebSocket,
    message: Extract<ClientEnvelope, { type: "turn.submit" | "turn.interrupt" }>,
  ) => {
    send(
      socket,
      rejection({
        commandId: message.payload.commandId,
        sessionId: message.payload.sessionId,
        code: "IDEMPOTENCY_KEY_REUSE",
        message: "This commandId was already used with a different command.",
      }),
    );
  };

  const recordOfflineRejection = async (
    socket: WebSocket,
    message: Extract<ClientEnvelope, { type: "turn.submit" | "turn.interrupt" }>,
  ) => {
    const result = await store.recordRejectedCommand(
      message,
      rejection({
        commandId: message.payload.commandId,
        sessionId: message.payload.sessionId,
        code: "CONNECTOR_OFFLINE",
        message: "No Connector is currently available.",
      }),
    );
    if (result.kind === "conflict") sendConflict(socket, message);
    else send(socket, result.result);
  };

  const handleClient = async (socket: WebSocket, message: ClientEnvelope) => {
    switch (message.type) {
      case "client.hello":
        return;
      case "session.subscribe": {
        const { sessionId, afterSeq } = message.payload;
        await store.ensureSession(sessionId);
        const snapshot = store.snapshot(sessionId);
        const upperBoundSeq = snapshot.lastEventSeq;
        const replay = store.replay(sessionId, afterSeq, upperBoundSeq);
        send(
          socket,
          makeEnvelope("replay.boundary", {
            sessionId,
            phase: "begin",
            afterSeq,
            upperBoundSeq,
          }),
        );
        for (const event of replay) send(socket, event);
        send(socket, makeEnvelope("session.snapshot", { snapshot }));
        send(
          socket,
          makeEnvelope("replay.boundary", {
            sessionId,
            phase: "end",
            afterSeq,
            upperBoundSeq,
          }),
        );
        clients.set(socket, sessionId);
        return;
      }
      case "turn.submit": {
        const prior = store.priorCommand(message);
        if (prior?.kind === "same") {
          send(socket, prior.result);
          return;
        }
        if (prior?.kind === "conflict") {
          sendConflict(socket, message);
          return;
        }
        const connection = connectorConnection;
        if (connection?.socket.readyState !== WebSocket.OPEN) {
          await recordOfflineRejection(socket, message);
          return;
        }
        const turnId = `turn-${crypto.randomUUID()}`;
        const result = await store.acceptTurn({
          message,
          turnId,
          runtime: connection.runtime,
          connectorId: connection.connectorId,
          bootId: connection.bootId,
          activeRejection: rejection({
            commandId: message.payload.commandId,
            sessionId: message.payload.sessionId,
            code: "TURN_ALREADY_ACTIVE",
            message: "This Session already has an active Turn.",
          }),
        });
        if (result.kind === "conflict") {
          sendConflict(socket, message);
          return;
        }
        send(socket, result.result);
        if (result.kind !== "new" || result.result.type !== "command.accepted") return;
        if (result.durableEvent !== undefined) broadcastDurable(result.durableEvent);
        await store.markDispatched(message.payload.commandId);
        sendConnector(
          connection.socket,
          makeEnvelope("connector.turn.start", {
            sessionId: message.payload.sessionId,
            turnId,
            commandId: message.payload.commandId,
            prompt: message.payload.prompt,
            providerSessionId: store.snapshot(message.payload.sessionId).providerSessionId,
          }),
        );
        return;
      }
      case "turn.interrupt": {
        const prior = store.priorCommand(message);
        if (prior?.kind === "same") {
          send(socket, prior.result);
          return;
        }
        if (prior?.kind === "conflict") {
          sendConflict(socket, message);
          return;
        }
        const connection = connectorConnection;
        if (connection?.socket.readyState !== WebSocket.OPEN) {
          await recordOfflineRejection(socket, message);
          return;
        }
        const snapshot = store.snapshot(message.payload.sessionId);
        const turn = snapshot.turns.find(
          (candidate) => candidate.turnId === message.payload.turnId,
        );
        if (
          snapshot.activeTurnId !== message.payload.turnId ||
          snapshot.providerSessionId === null ||
          turn?.providerTurnId == null
        ) {
          const invalid = await store.recordRejectedCommand(
            message,
            rejection({
              commandId: message.payload.commandId,
              sessionId: message.payload.sessionId,
              code: "TURN_NOT_ACCEPTING_INPUT",
              message: "The Turn is not bound to an active provider runtime.",
            }),
          );
          if (invalid.kind === "conflict") sendConflict(socket, message);
          else send(socket, invalid.result);
          return;
        }
        const accepted = validatedServerEnvelope(
          makeEnvelope("command.accepted", {
            commandId: message.payload.commandId,
            sessionId: message.payload.sessionId,
            turnId: message.payload.turnId,
          }),
        );
        const result = await store.acceptInterrupt({ message, accepted });
        if (result.kind === "conflict") {
          sendConflict(socket, message);
          return;
        }
        send(socket, result.result);
        if (result.kind !== "new" || result.result.type !== "command.accepted") return;
        await store.markDispatched(message.payload.commandId);
        sendConnector(
          connection.socket,
          makeEnvelope("connector.turn.interrupt", {
            commandId: message.payload.commandId,
            sessionId: message.payload.sessionId,
            turnId: message.payload.turnId,
            providerSessionId: snapshot.providerSessionId,
            providerTurnId: turn.providerTurnId,
          }),
        );
      }
    }
  };

  const acknowledge = (socket: WebSocket, sourceEventId: string) => {
    sendConnector(
      socket,
      makeEnvelope("connector.journal.ack", { sourceEventId }),
    );
  };

  const handleConnector = async (
    socket: WebSocket,
    message: ConnectorEnvelope,
  ) => {
    if (message.type === "connector.hello") {
      if (connectorLossTimer !== undefined) {
        clearTimeout(connectorLossTimer);
        connectorLossTimer = undefined;
      }
      connectorConnection = {
        socket,
        connectorId: message.payload.connectorId,
        bootId: message.payload.bootId,
        runtime: message.payload.runtime,
      };
      lastRuntime = message.payload.runtime;
      const recovered = await store.reconcileRuntime(message.payload.runtime);
      for (const event of recovered) broadcastDurable(event);
      broadcast(null, makeEnvelope("runtime.status", { runtime: lastRuntime }));
      return;
    }

    if (message.type === "connector.turn.delta") {
      if (
        connectorConnection?.connectorId === message.connectorId &&
        message.runtimeId !== undefined &&
        message.runtimeGeneration !== undefined &&
        store.acceptsRuntimeEvent(
          message.payload.sessionId,
          message.payload.turnId,
          message.runtimeId,
          message.runtimeGeneration,
        )
      ) {
        broadcast(
          message.payload.sessionId,
          makeEnvelope("assistant.message.delta", message.payload),
        );
      }
      return;
    }

    const source = sourceOf(message);
    if (
      source === undefined ||
      connectorConnection?.connectorId !== source.connectorId
    ) {
      return;
    }

    let durableEvent: ServerEnvelope | undefined;
    switch (message.type) {
      case "connector.runtime.status":
        await store.updateRuntime(message.payload.runtime, source);
        if (
          connectorConnection.runtime.runtimeId === message.payload.runtime.runtimeId &&
          connectorConnection.runtime.generation === message.payload.runtime.generation
        ) {
          connectorConnection.runtime = message.payload.runtime;
          lastRuntime = message.payload.runtime;
          broadcast(null, makeEnvelope("runtime.status", message.payload));
        }
        break;
      case "connector.command.error": {
        const isNew = await store.recordConnectorNotice(source);
        if (isNew) {
          broadcast(
            message.payload.sessionId,
            makeEnvelope("protocol.error", {
              error: protocolError(message.payload.code, message.payload.message, {
                commandId: message.payload.commandId,
                sessionId: message.payload.sessionId,
                retryable: message.payload.retryable,
              }),
            }),
          );
        }
        break;
      }
      case "connector.session.bound":
        await store.bindProviderSession(
          message.payload.sessionId,
          message.payload.providerSessionId,
          source,
        );
        break;
      case "connector.turn.bound":
        await store.bindProviderTurn(
          message.payload.sessionId,
          message.payload.turnId,
          message.payload.providerTurnId,
          source,
        );
        break;
      case "connector.turn.message.completed":
        durableEvent = await store.completeMessage(message, source);
        break;
      case "connector.turn.completed":
      case "connector.turn.interrupted":
      case "connector.turn.failed":
      case "connector.turn.outcome_unknown":
        durableEvent = await store.finishTurn(message, source);
        break;
    }
    acknowledge(socket, source.sourceEventId);
    if (durableEvent !== undefined) broadcastDurable(durableEvent);
  };

  const attachBrowser = (socket: WebSocket) => {
    clients.set(socket, null);
    if (lastRuntime !== undefined) {
      send(socket, makeEnvelope("runtime.status", { runtime: lastRuntime }));
    }
    socket.on("message", (data) => {
      const parsed = ClientEnvelopeSchema.safeParse(parseSocketData(data.toString()));
      if (!parsed.success) {
        send(
          socket,
          makeEnvelope("protocol.error", {
            error: protocolError("MESSAGE_INVALID", "Invalid client envelope."),
          }),
        );
        return;
      }
      void handleClient(socket, parsed.data).catch((error) => {
        console.error("Core client command failed", error);
        send(
          socket,
          makeEnvelope("protocol.error", {
            error: protocolError("CORE_STORAGE_FAILURE", "Core mutation failed."),
          }),
        );
      });
    });
    socket.on("close", () => clients.delete(socket));
  };

  const scheduleConnectorLoss = (connection: ConnectorConnection) => {
    if (closing) return;
    connectorLossTimer = setTimeout(() => {
      void store.markRuntimeLost(connection.runtime).then((events) => {
        for (const event of events) broadcastDurable(event);
        lastRuntime = { ...connection.runtime, status: "lost" };
        broadcast(null, makeEnvelope("runtime.status", { runtime: lastRuntime }));
      });
    }, options.connectorLossGraceMs ?? 750);
  };

  const attachConnector = (socket: WebSocket) => {
    if (connector?.readyState === WebSocket.OPEN) connector.close(1012);
    connector = socket;
    socket.on("message", (data) => {
      const parsed = ConnectorEnvelopeSchema.safeParse(parseSocketData(data.toString()));
      if (!parsed.success) {
        console.error("Core rejected an invalid Connector envelope", parsed.error);
        return;
      }
      void handleConnector(socket, parsed.data).catch((error) => {
        console.error("Core Connector ingest failed", error);
      });
    });
    socket.on("close", () => {
      if (connector !== socket) return;
      connector = undefined;
      const lost = connectorConnection;
      connectorConnection = undefined;
      if (lost !== undefined) scheduleConnectorLoss(lost);
    });
  };

  httpServer.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== "/ws" && path !== "/connector") {
      socket.destroy();
      return;
    }
    socketServer.handleUpgrade(request, socket, head, (webSocket) => {
      if (path === "/connector") attachConnector(webSocket);
      else attachBrowser(webSocket);
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port ?? 8787, host, () => resolveListen());
  });
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("Core failed to bind a TCP port");
  }

  return {
    host,
    port: address.port,
    browserUrl: `ws://${host}:${address.port}/ws`,
    connectorUrl: `ws://${host}:${address.port}/connector`,
    dbPath,
    async close() {
      closing = true;
      if (connectorLossTimer !== undefined) clearTimeout(connectorLossTimer);
      for (const client of clients.keys()) client.close();
      connector?.close();
      socketServer.close();
      await new Promise<void>((resolveClose, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolveClose()));
      });
      await store.close();
    },
  };
}

function parseSocketData(value: string) {
  try {
    return decodeJson(value);
  } catch {
    return null;
  }
}

function sourceOf(message: ConnectorEnvelope): ConnectorSource | undefined {
  if (
    message.connectorId === undefined ||
    message.sourceEventId === undefined ||
    message.runtimeId === undefined ||
    message.runtimeGeneration === undefined
  ) {
    return undefined;
  }
  return {
    connectorId: message.connectorId,
    sourceEventId: message.sourceEventId,
    runtimeId: message.runtimeId,
    runtimeGeneration: message.runtimeGeneration,
  };
}

function sessionIdOf(event: ServerEnvelope) {
  if (
    event.type === "turn.started" ||
    event.type === "turn.completed" ||
    event.type === "turn.interrupted" ||
    event.type === "turn.failed" ||
    event.type === "turn.outcome_unknown" ||
    event.type === "assistant.message.completed"
  ) {
    return event.payload.sessionId;
  }
  return null;
}
