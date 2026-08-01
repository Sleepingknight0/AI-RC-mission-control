import { createServer, type Server as HttpServer } from "node:http";

import { type SessionState } from "@aicl/domain";
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

import { InMemorySessionStore } from "./store.js";

export interface CoreServerOptions {
  host?: string;
  port?: number;
}

export interface CoreServerHandle {
  host: string;
  port: number;
  browserUrl: string;
  connectorUrl: string;
  close(): Promise<void>;
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
  const store = new InMemorySessionStore();
  const clients = new Map<WebSocket, string | null>();
  const commandLedger = new Map<
    string,
    { signature: string; result: ServerEnvelope }
  >();
  let connector: WebSocket | undefined;
  let lastRuntime: Runtime | undefined;

  const httpServer: HttpServer = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          component: "core",
          status: "ready",
          connectorConnected: connector?.readyState === WebSocket.OPEN,
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

  const rejection = (
    input: { commandId: string; sessionId: string; code: string; message: string },
  ) =>
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

  const commandSignature = (message: ClientEnvelope) =>
    JSON.stringify({ type: message.type, payload: message.payload });

  const replayCommand = (socket: WebSocket, message: ClientEnvelope) => {
    if (
      message.type !== "turn.submit" &&
      message.type !== "turn.interrupt"
    ) {
      return false;
    }
    const { commandId, sessionId } = message.payload;
    const previous = commandLedger.get(commandId);
    if (previous === undefined) return false;
    if (previous.signature === commandSignature(message)) {
      send(socket, previous.result);
    } else {
      send(
        socket,
        rejection({
          commandId,
          sessionId,
          code: "IDEMPOTENCY_KEY_REUSE",
          message: "This commandId was already used with a different command.",
        }),
      );
    }
    return true;
  };

  const recordCommand = (
    socket: WebSocket,
    message: ClientEnvelope,
    result: ServerEnvelope,
  ) => {
    if (
      message.type === "turn.submit" ||
      message.type === "turn.interrupt"
    ) {
      commandLedger.set(message.payload.commandId, {
        signature: commandSignature(message),
        result,
      });
    }
    send(socket, result);
  };

  const handleClient = (socket: WebSocket, message: ClientEnvelope) => {
    if (replayCommand(socket, message)) return;
    switch (message.type) {
      case "client.hello":
        return;
      case "session.subscribe": {
        const { sessionId, afterSeq } = message.payload;
        clients.set(socket, sessionId);
        const snapshot = store.snapshot(sessionId);
        send(
          socket,
          makeEnvelope("replay.boundary", {
            sessionId,
            phase: "begin",
            afterSeq,
            upperBoundSeq: snapshot.lastEventSeq,
          }),
        );
        send(socket, makeEnvelope("session.snapshot", { snapshot }));
        send(
          socket,
          makeEnvelope("replay.boundary", {
            sessionId,
            phase: "end",
            afterSeq,
            upperBoundSeq: snapshot.lastEventSeq,
          }),
        );
        return;
      }
      case "turn.submit": {
        const { commandId, sessionId, prompt } = message.payload;
        if (connector?.readyState !== WebSocket.OPEN) {
          recordCommand(
            socket,
            message,
            rejection({
              commandId,
              sessionId,
              code: "CONNECTOR_OFFLINE",
              message: "No Connector is currently available.",
            }),
          );
          return;
        }

        const turnId = `turn-${crypto.randomUUID()}`;
        const started = store.beginTurn(sessionId, {
          turnId,
          commandId,
          prompt,
          startedAt: new Date().toISOString(),
        });
        if (!started.ok) {
          recordCommand(
            socket,
            message,
            rejection({
              commandId,
              sessionId,
              code: started.code,
              message: "This Session already has an active Turn.",
            }),
          );
          return;
        }

        recordCommand(
          socket,
          message,
          validatedServerEnvelope(
            makeEnvelope("command.accepted", { commandId, sessionId, turnId }),
          ),
        );
        broadcast(
          sessionId,
          makeEnvelope("turn.started", {
            sessionId,
            turn: started.turn,
            seq: started.state.lastEventSeq,
          }),
        );
        connector.send(
          JSON.stringify(
            makeEnvelope("connector.turn.start", {
              sessionId,
              turnId,
              commandId,
              prompt,
              providerSessionId: store.snapshot(sessionId).providerSessionId,
            }),
          ),
        );
        return;
      }
      case "turn.interrupt": {
        const { commandId, sessionId, turnId } = message.payload;
        if (connector?.readyState !== WebSocket.OPEN) {
          recordCommand(
            socket,
            message,
            rejection({
              commandId,
              sessionId,
              code: "CONNECTOR_OFFLINE",
              message: "No Connector is currently available.",
            }),
          );
          return;
        }
        const snapshot = store.snapshot(sessionId);
        const turn = snapshot.turns.find((candidate) => candidate.turnId === turnId);
        if (
          snapshot.activeTurnId !== turnId ||
          snapshot.providerSessionId === null ||
          turn?.providerTurnId == null
        ) {
          recordCommand(
            socket,
            message,
            rejection({
              commandId,
              sessionId,
              code: "TURN_NOT_ACCEPTING_INPUT",
              message: "The Turn is not bound to an active provider runtime.",
            }),
          );
          return;
        }
        recordCommand(
          socket,
          message,
          validatedServerEnvelope(
            makeEnvelope("command.accepted", { commandId, sessionId, turnId }),
          ),
        );
        connector.send(
          JSON.stringify(
            makeEnvelope("connector.turn.interrupt", {
              commandId,
              sessionId,
              turnId,
              providerSessionId: snapshot.providerSessionId,
              providerTurnId: turn.providerTurnId,
            }),
          ),
        );
      }
    }
  };

  const broadcastTerminalTurn = (
    message: ConnectorEnvelope,
    status: "interrupted" | "completed" | "failed" | "outcome_unknown",
  ) => {
    if (
      message.type !== "connector.turn.completed" &&
      message.type !== "connector.turn.interrupted" &&
      message.type !== "connector.turn.failed" &&
      message.type !== "connector.turn.outcome_unknown"
    ) {
      return;
    }
    const { sessionId, turnId } = message.payload;
    const failureCode =
      message.type === "connector.turn.failed"
        ? message.payload.failureCode
        : undefined;
    const input = {
      turnId,
      status,
      completedAt: new Date().toISOString(),
      ...(failureCode === undefined ? {} : { failureCode }),
    };
    const state: SessionState = store.finishTurn(sessionId, input);
    if (status === "completed") {
      broadcast(
        sessionId,
        makeEnvelope("turn.completed", {
          sessionId,
          turnId,
          seq: state.lastEventSeq,
        }),
      );
    } else if (status === "interrupted") {
      broadcast(
        sessionId,
        makeEnvelope("turn.interrupted", {
          sessionId,
          turnId,
          seq: state.lastEventSeq,
        }),
      );
    } else if (status === "failed") {
      broadcast(
        sessionId,
        makeEnvelope("turn.failed", {
          sessionId,
          turnId,
          failureCode: failureCode ?? "PROVIDER_REJECTED",
          seq: state.lastEventSeq,
        }),
      );
    } else {
      broadcast(
        sessionId,
        makeEnvelope("turn.outcome_unknown", {
          sessionId,
          turnId,
          seq: state.lastEventSeq,
        }),
      );
    }
  };

  const handleConnector = (message: ConnectorEnvelope) => {
    switch (message.type) {
      case "connector.hello":
      case "connector.runtime.status":
        lastRuntime = message.payload.runtime;
        broadcast(null, makeEnvelope("runtime.status", message.payload));
        return;
      case "connector.command.error":
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
        return;
      case "connector.session.bound":
        store.bindProviderSession(
          message.payload.sessionId,
          message.payload.providerSessionId,
        );
        return;
      case "connector.turn.bound":
        store.bindProviderTurn(
          message.payload.sessionId,
          message.payload.turnId,
          message.payload.providerTurnId,
        );
        return;
      case "connector.turn.delta": {
        store.appendDelta(message.payload.sessionId, message.payload);
        broadcast(
          message.payload.sessionId,
          makeEnvelope("assistant.message.delta", message.payload),
        );
        return;
      }
      case "connector.turn.message.completed": {
        const state = store.completeMessage(
          message.payload.sessionId,
          message.payload,
        );
        broadcast(
          message.payload.sessionId,
          makeEnvelope("assistant.message.completed", {
            ...message.payload,
            seq: state.lastEventSeq,
          }),
        );
        return;
      }
      case "connector.turn.completed":
        broadcastTerminalTurn(message, "completed");
        return;
      case "connector.turn.interrupted":
        broadcastTerminalTurn(message, "interrupted");
        return;
      case "connector.turn.failed":
        broadcastTerminalTurn(message, "failed");
        return;
      case "connector.turn.outcome_unknown":
        broadcastTerminalTurn(message, "outcome_unknown");
    }
  };

  const attachBrowser = (socket: WebSocket) => {
    clients.set(socket, null);
    if (lastRuntime !== undefined) {
      send(socket, makeEnvelope("runtime.status", { runtime: lastRuntime }));
    }
    socket.on("message", (data) => {
      const parsed = ClientEnvelopeSchema.safeParse(
        (() => {
          try {
            return decodeJson(data.toString());
          } catch {
            return null;
          }
        })(),
      );
      if (!parsed.success) {
        send(
          socket,
          makeEnvelope("protocol.error", {
            error: protocolError("MESSAGE_INVALID", "Invalid client envelope."),
          }),
        );
        return;
      }
      handleClient(socket, parsed.data);
    });
    socket.on("close", () => clients.delete(socket));
  };

  const attachConnector = (socket: WebSocket) => {
    if (connector?.readyState === WebSocket.OPEN) connector.close(1012);
    connector = socket;
    socket.on("message", (data) => {
      const parsed = ConnectorEnvelopeSchema.safeParse(
        (() => {
          try {
            return decodeJson(data.toString());
          } catch {
            return null;
          }
        })(),
      );
      if (parsed.success) handleConnector(parsed.data);
    });
    socket.on("close", () => {
      if (connector === socket) {
        connector = undefined;
        for (const snapshot of store.activeSnapshots()) {
          const turnId = snapshot.activeTurnId;
          if (turnId === null) continue;
          const state = store.finishTurn(snapshot.sessionId, {
            turnId,
            status: "outcome_unknown",
            completedAt: new Date().toISOString(),
          });
          broadcast(
            snapshot.sessionId,
            makeEnvelope("turn.outcome_unknown", {
              sessionId: snapshot.sessionId,
              turnId,
              seq: state.lastEventSeq,
            }),
          );
        }
        lastRuntime = {
          runtimeId: lastRuntime?.runtimeId ?? "runtime-unknown",
          generation: lastRuntime?.generation ?? 1,
          status: "lost",
        };
        broadcast(null, makeEnvelope("runtime.status", { runtime: lastRuntime }));
      }
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

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port ?? 8787, host, () => resolve());
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
    async close() {
      for (const client of clients.keys()) client.close();
      connector?.close();
      socketServer.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
