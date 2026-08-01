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
  let connector: WebSocket | undefined;

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

  const rejectCommand = (
    socket: WebSocket,
    input: { commandId: string; sessionId: string; code: string; message: string },
  ) => {
    send(
      socket,
      makeEnvelope("command.rejected", {
        commandId: input.commandId,
        sessionId: input.sessionId,
        error: protocolError(input.code, input.message, {
          commandId: input.commandId,
          sessionId: input.sessionId,
        }),
      }),
    );
  };

  const handleClient = (socket: WebSocket, message: ClientEnvelope) => {
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
          rejectCommand(socket, {
            commandId,
            sessionId,
            code: "CONNECTOR_OFFLINE",
            message: "No Connector is currently available.",
          });
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
          rejectCommand(socket, {
            commandId,
            sessionId,
            code: started.code,
            message: "This Session already has an active Turn.",
          });
          return;
        }

        send(
          socket,
          makeEnvelope("command.accepted", { commandId, sessionId, turnId }),
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
            }),
          ),
        );
      }
    }
  };

  const broadcastTerminalTurn = (
    message: ConnectorEnvelope,
    status: "completed" | "failed" | "outcome_unknown",
  ) => {
    if (
      message.type !== "connector.turn.completed" &&
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
        broadcast(null, makeEnvelope("runtime.status", message.payload));
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
      case "connector.turn.failed":
        broadcastTerminalTurn(message, "failed");
        return;
      case "connector.turn.outcome_unknown":
        broadcastTerminalTurn(message, "outcome_unknown");
    }
  };

  const attachBrowser = (socket: WebSocket) => {
    clients.set(socket, null);
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
        broadcast(
          null,
          makeEnvelope("runtime.status", {
            runtime: {
              runtimeId: "runtime-mock-1",
              generation: 1,
              status: "lost",
            },
          }),
        );
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
