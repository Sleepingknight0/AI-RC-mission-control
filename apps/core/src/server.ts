import {
  createServer,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ClientEnvelopeSchema,
  ConnectorEnvelopeSchema,
  MAX_OUTPUT_BATCH_BYTES,
  MAX_WEBSOCKET_MESSAGE_BYTES,
  ServerEnvelopeSchema,
  decodeJson,
  makeEnvelope,
  utf8ByteLength,
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
  artifactAccessToken?: string;
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
  const artifactAccessToken =
    options.artifactAccessToken ?? `artifact-token-${crypto.randomUUID()}`;
  const clients = new Map<WebSocket, string | null>();
  let connector: WebSocket | undefined;
  let connectorConnection: ConnectorConnection | undefined;
  let connectorLossTimer: NodeJS.Timeout | undefined;
  let lastRuntime: Runtime | undefined = store.latestRuntime();
  let closing = false;

  const httpServer: HttpServer = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
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
    const artifactMatch = /^\/artifacts\/([A-Za-z0-9-]+)$/.exec(
      requestUrl.pathname,
    );
    if (artifactMatch !== null) {
      applyArtifactCors(request.headers.origin, response);
      if (request.method === "OPTIONS") {
        response.writeHead(204).end();
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { allow: "GET, HEAD, OPTIONS" }).end();
        return;
      }
      if (request.headers.authorization !== `Bearer ${artifactAccessToken}`) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "AUTH_REQUIRED" }));
        return;
      }
      const artifact = store.artifact(artifactMatch[1]!);
      if (artifact === undefined) {
        response.writeHead(404).end();
        return;
      }
      const range = parseByteRange(request.headers.range, artifact.byteLength);
      if (range === "invalid") {
        response.writeHead(416, {
          "content-range": `bytes */${artifact.byteLength}`,
        });
        response.end();
        return;
      }
      const start = range?.start ?? 0;
      const end = range?.end ?? artifact.byteLength - 1;
      const body = artifact.content.subarray(start, end + 1);
      response.writeHead(range === null ? 200 : 206, {
        "accept-ranges": "bytes",
        "content-type": artifact.mediaType,
        "content-length": String(body.byteLength),
        etag: `"sha256-${artifact.sha256}"`,
        ...(range === null
          ? {}
          : { "content-range": `bytes ${start}-${end}/${artifact.byteLength}` }),
      });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }
    response.writeHead(404).end();
  });
  const socketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES,
  });

  const send = (socket: WebSocket, value: unknown) => {
    const envelope = validatedServerEnvelope(value);
    if (socket.readyState === WebSocket.OPEN) {
      const json = JSON.stringify(envelope);
      if (utf8ByteLength(json) > MAX_WEBSOCKET_MESSAGE_BYTES) {
        throw new Error("Server envelope exceeds the WebSocket message limit");
      }
      socket.send(json);
    }
  };

  const sendConnector = (socket: WebSocket, value: unknown) => {
    if (socket.readyState === WebSocket.OPEN) {
      const json = JSON.stringify(value);
      if (utf8ByteLength(json) > MAX_WEBSOCKET_MESSAGE_BYTES) {
        throw new Error("Connector envelope exceeds the WebSocket message limit");
      }
      socket.send(json);
    }
  };

  const broadcast = (sessionId: string | null, value: unknown) => {
    const envelope = validatedServerEnvelope(value);
    const json = JSON.stringify(envelope);
    if (utf8ByteLength(json) > MAX_WEBSOCKET_MESSAGE_BYTES) {
      throw new Error("Broadcast envelope exceeds the WebSocket message limit");
    }
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
      broadcast(
        null,
        makeEnvelope("sessions.snapshot", { sessions: store.sessionSummaries() }),
      );
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
    message: Extract<
      ClientEnvelope,
      { type: "turn.submit" | "turn.interrupt" | "approval.resolve" }
    >,
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
    message: Extract<
      ClientEnvelope,
      { type: "turn.submit" | "turn.interrupt" | "approval.resolve" }
    >,
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
      case "sessions.list":
        send(
          socket,
          makeEnvelope("sessions.snapshot", { sessions: store.sessionSummaries() }),
        );
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
        send(
          socket,
          makeEnvelope("sessions.snapshot", { sessions: store.sessionSummaries() }),
        );
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
            runtimeId: connection.runtime.runtimeId,
            runtimeGeneration: connection.runtime.generation,
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
        return;
      }
      case "approval.resolve": {
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
        const approval = store
          .snapshot(message.payload.sessionId)
          .approvals.find(
            (candidate) => candidate.approvalId === message.payload.approvalId,
          );
        if (approval === undefined) {
          const missing = await store.recordRejectedCommand(
            message,
            rejection({
              commandId: message.payload.commandId,
              sessionId: message.payload.sessionId,
              code: "APPROVAL_NOT_FOUND",
              message: "Approval was not found in this Session.",
            }),
          );
          if (missing.kind === "conflict") sendConflict(socket, message);
          else send(socket, missing.result);
          return;
        }
        const accepted = validatedServerEnvelope(
          makeEnvelope("command.accepted", {
            commandId: message.payload.commandId,
            sessionId: message.payload.sessionId,
            turnId: approval.turnId,
          }),
        );
        const result = await store.resolveApproval({
          message,
          accepted,
          runtime: connection.runtime,
          rejection: (code, detail) =>
            rejection({
              commandId: message.payload.commandId,
              sessionId: message.payload.sessionId,
              code,
              message: detail,
            }),
        });
        if (result.kind === "conflict") {
          sendConflict(socket, message);
          return;
        }
        send(socket, result.result);
        if (result.kind !== "new") return;
        if (result.durableEvent !== undefined) {
          broadcastDurable(result.durableEvent);
        }
        if (result.dispatch === undefined) return;
        await store.markDispatched(message.payload.commandId);
        sendConnector(
          connection.socket,
          makeEnvelope("connector.approval.resolve", {
            commandId: message.payload.commandId,
            sessionId: message.payload.sessionId,
            turnId: result.dispatch.approval.turnId,
            approvalId: result.dispatch.approval.approvalId,
            providerCorrelationId: result.dispatch.providerCorrelationId,
            runtimeId: result.dispatch.approval.runtimeId,
            runtimeGeneration: result.dispatch.approval.runtimeGeneration,
            decision: result.dispatch.decision,
          }),
        );
        return;
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
      broadcast(
        null,
        makeEnvelope("sessions.snapshot", { sessions: store.sessionSummaries() }),
      );
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

    if (message.type === "connector.command.output.batch") {
      if (
        utf8ByteLength(message.payload.output) <= MAX_OUTPUT_BATCH_BYTES &&
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
          makeEnvelope("command.output.batch", message.payload),
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

    const durableEvents: ServerEnvelope[] = [];
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
          broadcast(
            null,
            makeEnvelope("sessions.snapshot", { sessions: store.sessionSummaries() }),
          );
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
        {
          const event = await store.completeMessage(message, source);
          if (event !== undefined) durableEvents.push(event);
        }
        break;
      case "connector.activity.started":
      case "connector.activity.completed":
        {
          const event = await store.recordActivity(message, source);
          if (event !== undefined) durableEvents.push(event);
        }
        break;
      case "connector.file.change.started":
      case "connector.file.change.completed":
        {
          const event = await store.recordFileChange(message, source);
          if (event !== undefined) durableEvents.push(event);
        }
        break;
      case "connector.approval.requested":
        {
          const event = await store.requestApproval(message, source);
          if (event !== undefined) durableEvents.push(event);
        }
        break;
      case "connector.interrupt.result":
        {
          const event = await store.recordInterruptResult(message, source);
          if (event !== undefined) durableEvents.push(event);
        }
        break;
      case "connector.artifact.begin":
        await store.beginArtifact(message, source);
        break;
      case "connector.artifact.chunk":
        await store.appendArtifactChunk(message, source);
        break;
      case "connector.artifact.complete":
        await store.completeArtifact(message, source);
        break;
      case "connector.turn.completed":
      case "connector.turn.interrupted":
      case "connector.turn.failed":
      case "connector.turn.outcome_unknown":
        {
          const events = await store.finishTurn(message, source);
          if (events !== undefined) durableEvents.push(...events);
        }
        break;
    }
    acknowledge(socket, source.sourceEventId);
    for (const event of durableEvents) broadcastDurable(event);
  };

  const attachBrowser = (socket: WebSocket) => {
    clients.set(socket, null);
    send(
      socket,
      makeEnvelope("server.hello", { artifactAccessToken }),
    );
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
    event.type === "assistant.message.completed" ||
    event.type === "activity.started" ||
    event.type === "activity.completed" ||
    event.type === "file.change.started" ||
    event.type === "file.change.completed" ||
    event.type === "approval.requested" ||
    event.type === "approval.resolved" ||
    event.type === "approval.expired" ||
    event.type === "approval.invalidated" ||
    event.type === "interrupt.result"
  ) {
    return event.payload.sessionId;
  }
  return null;
}

function applyArtifactCors(
  origin: string | undefined,
  response: ServerResponse,
) {
  if (
    origin !== undefined &&
    /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(origin)
  ) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "Origin");
    response.setHeader("access-control-allow-headers", "Authorization, Range");
    response.setHeader("access-control-allow-methods", "GET, HEAD, OPTIONS");
  }
}

function parseByteRange(
  header: string | undefined,
  byteLength: number,
): { start: number; end: number } | null | "invalid" {
  if (header === undefined) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(header);
  if (match === null || byteLength === 0) return "invalid";
  const start = Number(match[1]);
  const requestedEnd = match[2] === "" ? byteLength - 1 : Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= byteLength ||
    requestedEnd < start
  ) {
    return "invalid";
  }
  return { start, end: Math.min(requestedEnd, byteLength - 1) };
}
