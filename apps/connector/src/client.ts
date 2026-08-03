import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";

import {
  ConnectorEnvelopeSchema,
  CoreToConnectorEnvelopeSchema,
  ARTIFACT_CHUNK_BYTES,
  MAX_INLINE_DIFF_BYTES,
  MAX_INLINE_ENVELOPE_BYTES,
  MAX_WEBSOCKET_MESSAGE_BYTES,
  RuntimeSchema,
  decodeJson,
  makeEnvelope,
  utf8ByteLength,
  websocketCapability,
  type ConnectorEnvelope,
  type CoreToConnectorEnvelope,
  type ProviderFleetSnapshot,
  type ProviderNativeSessionSnapshot,
  type Runtime,
} from "@aicl/protocol";
import WebSocket from "ws";

import { ConnectorJournal } from "./journal.js";
import { MockProvider } from "./mock-provider.js";
import { ProviderLostError, type ConnectorProvider } from "./provider.js";

export interface ConnectorOptions {
  coreUrl: string;
  connectorToken: string;
  provider: ConnectorProvider;
  providerName: string;
  healthPort?: number;
  reconnectDelayMs?: number;
  runtimeId?: string;
  runtimeGeneration?: number;
  journalPath?: string;
  connectorId?: string;
  healthDetails?: Record<string, unknown>;
  providerInventory?: (
    revision: number,
  ) => ProviderFleetSnapshot | Promise<ProviderFleetSnapshot>;
  providerInventoryTimeoutMs?: number;
  providerNativeSessions?: (
    revision: number,
  ) => ProviderNativeSessionSnapshot | Promise<ProviderNativeSessionSnapshot>;
  providerNativeSessionIdentity?: { providerId: string; accountId: string };
  providerNativeSessionTimeoutMs?: number;
}

export interface MockConnectorOptions {
  coreUrl: string;
  connectorToken: string;
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
  const inFlightCommands = new Set<Promise<void>>();
  let inventoryRevision = 0;
  let inventoryRefreshInFlight: Promise<void> | undefined;
  let nativeSessionRevision = 0;
  let nativeSessionRefreshInFlight: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
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
      const json = JSON.stringify(envelope);
      if (utf8ByteLength(json) > MAX_WEBSOCKET_MESSAGE_BYTES) {
        throw new Error("Connector envelope exceeds the WebSocket message limit");
      }
      socket.send(json);
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

  const enqueueDurable = (envelope: ConnectorEnvelope, status: Runtime) => {
    sendRaw(journal.enqueue(envelope, status));
  };

  const emitFileChange = (
    envelope: Extract<
      ConnectorEnvelope,
      { type: "connector.file.change.completed" }
    >,
    status: Runtime,
  ) => {
    const inlineDiff = envelope.payload.fileChange.inlineDiff;
    if (
      inlineDiff === null ||
      (Buffer.byteLength(inlineDiff, "utf8") <= MAX_INLINE_DIFF_BYTES &&
        utf8ByteLength(JSON.stringify(envelope)) <=
          MAX_INLINE_ENVELOPE_BYTES - 4 * 1024)
    ) {
      enqueueDurable(envelope, status);
      return;
    }
    const content = Buffer.from(inlineDiff, "utf8");
    const artifactId = `artifact-${crypto.randomUUID()}`;
    const artifact = {
      artifactId,
      mediaType: "text/x-diff; charset=utf-8" as const,
      byteLength: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
      downloadPath: `/artifacts/${artifactId}`,
    };
    const chunkCount = Math.ceil(content.byteLength / ARTIFACT_CHUNK_BYTES);
    enqueueDurable(
      makeEnvelope("connector.artifact.begin", {
        sessionId: envelope.payload.sessionId,
        turnId: envelope.payload.fileChange.turnId,
        artifact,
        chunkCount,
      }),
      status,
    );
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const start = chunkIndex * ARTIFACT_CHUNK_BYTES;
      enqueueDurable(
        makeEnvelope("connector.artifact.chunk", {
          sessionId: envelope.payload.sessionId,
          turnId: envelope.payload.fileChange.turnId,
          artifactId,
          chunkIndex,
          contentBase64: content
            .subarray(start, start + ARTIFACT_CHUNK_BYTES)
            .toString("base64"),
        }),
        status,
      );
    }
    enqueueDurable(
      makeEnvelope("connector.artifact.complete", {
        sessionId: envelope.payload.sessionId,
        turnId: envelope.payload.fileChange.turnId,
        artifactId,
      }),
      status,
    );
    enqueueDurable(
      makeEnvelope("connector.file.change.completed", {
        sessionId: envelope.payload.sessionId,
        fileChange: {
          ...envelope.payload.fileChange,
          inlineDiff: null,
          artifact,
        },
      }),
      status,
    );
  };

  const emit = (envelope: ConnectorEnvelope) => {
    if (
      envelope.type === "connector.turn.delta" ||
      envelope.type === "connector.command.output.batch" ||
      envelope.type === "connector.providers.snapshot" ||
      envelope.type === "connector.sessions.native.snapshot"
    ) {
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
    if (envelope.type === "connector.file.change.completed") {
      emitFileChange(envelope, status);
      return;
    }
    enqueueDurable(envelope, status);
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

  const refreshProviderInventory = () => {
    if (options.providerInventory === undefined) return Promise.resolve();
    if (inventoryRefreshInFlight !== undefined) return inventoryRefreshInFlight;
    const revision = ++inventoryRevision;
    inventoryRefreshInFlight = (async () => {
      const timeoutMs = options.providerInventoryTimeoutMs ?? 2_500;
      let timeout: NodeJS.Timeout | undefined;
      try {
        const snapshot = await Promise.race([
          Promise.resolve().then(() => options.providerInventory?.(revision)),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Provider inventory refresh timed out")),
              timeoutMs,
            );
          }),
        ]);
        if (snapshot === undefined || stopped) return;
        emit(
          makeEnvelope("connector.providers.snapshot", {
            snapshot: {
              ...snapshot,
              revision,
            },
          }),
        );
      } catch {
        if (stopped) return;
        const observedAt = new Date().toISOString();
        emit(
          makeEnvelope("connector.providers.snapshot", {
            snapshot: {
              snapshotId: `fleet-${crypto.randomUUID()}`,
              revision,
              source: "unavailable" as const,
              observedAt,
              staleAt: new Date(Date.now() + 60_000).toISOString(),
              freshness: "unavailable" as const,
              degraded: true,
              providers: [],
              notice: "Provider inventory refresh failed or timed out",
            },
          }),
        );
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        inventoryRefreshInFlight = undefined;
      }
    })();
    return inventoryRefreshInFlight;
  };

  const refreshNativeSessions = () => {
    if (options.providerNativeSessions === undefined) return Promise.resolve();
    if (nativeSessionRefreshInFlight !== undefined) {
      return nativeSessionRefreshInFlight;
    }
    const revision = ++nativeSessionRevision;
    nativeSessionRefreshInFlight = (async () => {
      const timeoutMs = options.providerNativeSessionTimeoutMs ?? 3_000;
      let timeout: NodeJS.Timeout | undefined;
      try {
        const snapshot = await Promise.race([
          Promise.resolve().then(() => options.providerNativeSessions?.(revision)),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Provider Session refresh timed out")),
              timeoutMs,
            );
          }),
        ]);
        if (snapshot === undefined || stopped) return;
        emit(
          makeEnvelope("connector.sessions.native.snapshot", {
            snapshot: { ...snapshot, revision },
          }),
        );
      } catch {
        if (stopped || options.providerNativeSessionIdentity === undefined) return;
        const observedAt = new Date().toISOString();
        emit(
          makeEnvelope("connector.sessions.native.snapshot", {
            snapshot: {
              snapshotId: `native-${crypto.randomUUID()}`,
              revision,
              providerId: options.providerNativeSessionIdentity.providerId,
              accountId: options.providerNativeSessionIdentity.accountId,
              observedAt,
              staleAt: new Date(Date.now() + 60_000).toISOString(),
              freshness: "unavailable" as const,
              truncated: false,
              sessions: [],
              notice: "Provider Session discovery failed or timed out",
            },
          }),
        );
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        nativeSessionRefreshInFlight = undefined;
      }
    })();
    return nativeSessionRefreshInFlight;
  };

  const handleCommand = async (
    command: CoreToConnectorEnvelope,
  ) => {
    if (command.type === "connector.journal.ack") {
      journal.acknowledge(command.payload.sourceEventId);
      return;
    }
    if (command.type === "connector.providers.refresh") {
      await refreshProviderInventory();
      return;
    }
    if (command.type === "connector.sessions.native.refresh") {
      if (
        options.providerNativeSessionIdentity?.providerId !==
          command.payload.providerId ||
        options.providerNativeSessionIdentity.accountId !== command.payload.accountId
      ) {
        return;
      }
      await refreshNativeSessions();
      return;
    }
    const decision = journal.recordCommand(command);
    if (decision === "same") return;
    if (decision === "conflict") {
      if (
        command.type === "connector.session.create" ||
        command.type === "connector.session.resume"
      ) {
        emit(
          makeEnvelope("connector.session.prepare.failed", {
            commandId: command.payload.commandId,
            sessionId: command.payload.sessionId,
            code: "IDEMPOTENCY_KEY_REUSE",
          }),
        );
      } else {
        emit(
          makeEnvelope("connector.command.error", {
            commandId: command.payload.commandId,
            sessionId: command.payload.sessionId,
            turnId: command.payload.turnId,
            code: "IDEMPOTENCY_KEY_REUSE",
            message: "Connector commandId was reused with a different payload.",
            retryable: false,
          }),
        );
      }
      return;
    }
    journal.markCommand(command.payload.commandId, "dispatching");

    if (
      command.type === "connector.session.create" ||
      command.type === "connector.session.resume"
    ) {
      if (
        command.payload.runtimeId !== journal.runtimeId ||
        command.payload.runtimeGeneration !== journal.runtimeGeneration
      ) {
        journal.markCommand(command.payload.commandId, "completed", {
          failureCode: "STALE_RUNTIME_GENERATION",
        });
        emit(
          makeEnvelope("connector.session.prepare.failed", {
            commandId: command.payload.commandId,
            sessionId: command.payload.sessionId,
            code: "STALE_RUNTIME_GENERATION",
          }),
        );
        return;
      }
      if (providerLost) {
        journal.markCommand(command.payload.commandId, "completed", {
          failureCode: "PROVIDER_UNAVAILABLE",
        });
        emit(
          makeEnvelope("connector.session.prepare.failed", {
            commandId: command.payload.commandId,
            sessionId: command.payload.sessionId,
            code: "PROVIDER_UNAVAILABLE",
          }),
        );
        return;
      }
      emitRuntime("busy");
      try {
        if (options.provider.prepareSession === undefined) {
          throw new Error("Provider does not implement Session preparation");
        }
        const prepared = await options.provider.prepareSession(command);
        journal.markCommand(command.payload.commandId, "completed");
        emit(
          makeEnvelope("connector.session.prepared", {
            commandId: command.payload.commandId,
            sessionId: command.payload.sessionId,
            providerId: command.payload.providerId,
            accountId: command.payload.accountId,
            ...prepared,
          }),
        );
        if (!providerLost) emitRuntime("ready");
      } catch (error) {
        if (error instanceof ProviderLostError) {
          journal.markCommand(command.payload.commandId, "outcome_unknown");
          emit(
            makeEnvelope("connector.session.prepare.outcome_unknown", {
              commandId: command.payload.commandId,
              sessionId: command.payload.sessionId,
            }),
          );
          return;
        }
        journal.markCommand(command.payload.commandId, "completed", {
          failureCode: "PROVIDER_SESSION_REJECTED",
        });
        emit(
          makeEnvelope("connector.session.prepare.failed", {
            commandId: command.payload.commandId,
            sessionId: command.payload.sessionId,
            code: "PROVIDER_SESSION_REJECTED",
          }),
        );
        emitRuntime("ready");
      }
      return;
    }

    if (command.type === "connector.turn.start" && providerLost) {
      journal.markCommand(command.payload.commandId, "outcome_unknown");
      emit(
        makeEnvelope("connector.turn.outcome_unknown", {
          sessionId: command.payload.sessionId,
          turnId: command.payload.turnId,
        }),
      );
      return;
    }

    if (command.type === "connector.turn.interrupt") {
      try {
        await options.provider.interrupt(command);
        journal.markCommand(command.payload.commandId, "completed");
        emit(
          makeEnvelope("connector.interrupt.result", {
            commandId: command.payload.commandId,
            sessionId: command.payload.sessionId,
            turnId: command.payload.turnId,
            status: "accepted" as const,
          }),
        );
      } catch {
        journal.markCommand(command.payload.commandId, "outcome_unknown");
        emit(
          makeEnvelope("connector.command.error", {
            commandId: command.payload.commandId,
            sessionId: command.payload.sessionId,
            turnId: command.payload.turnId,
            code: "INTERRUPT_FAILED",
            message: "Provider interrupt delivery could not be confirmed.",
            retryable: false,
          }),
        );
      }
      return;
    }

    if (command.type === "connector.approval.resolve") {
      if (
        command.payload.runtimeId !== journal.runtimeId ||
        command.payload.runtimeGeneration !== journal.runtimeGeneration
      ) {
        journal.markCommand(command.payload.commandId, "completed", {
          failureCode: "STALE_RUNTIME_GENERATION",
        });
        emit(
          makeEnvelope("connector.command.error", {
            commandId: command.payload.commandId,
            sessionId: command.payload.sessionId,
            turnId: command.payload.turnId,
            code: "STALE_RUNTIME_GENERATION",
            message: "Approval belongs to a different runtime generation.",
            retryable: false,
          }),
        );
        return;
      }
      try {
        await options.provider.resolveApproval(command);
        journal.markCommand(command.payload.commandId, "completed");
        emit(
          makeEnvelope("connector.command.completed", {
            commandId: command.payload.commandId,
            sessionId: command.payload.sessionId,
            turnId: command.payload.turnId,
          }),
        );
      } catch {
        journal.markCommand(command.payload.commandId, "outcome_unknown");
        emit(
          makeEnvelope("connector.command.error", {
            commandId: command.payload.commandId,
            sessionId: command.payload.sessionId,
            turnId: command.payload.turnId,
            code: "APPROVAL_DELIVERY_FAILED",
            message: "Provider approval delivery could not be confirmed.",
            retryable: false,
          }),
        );
      }
      return;
    }

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
    socket = new WebSocket(
      options.coreUrl,
      websocketCapability("connector", options.connectorToken),
    );
    socket.on("open", () => {
      const readyRuntime = runtime(providerLost ? "lost" : runtimeStatus);
      sendRaw(
        ConnectorEnvelopeSchema.parse(
          makeEnvelope("connector.hello", {
            connectorId: journal.connectorId,
            bootId: journal.bootId,
            runtime: readyRuntime,
            commandReceipts: journal.commandReceipts(),
          }),
        ),
      );
      for (const event of journal.pendingEvents()) sendRaw(event);
      void refreshProviderInventory();
      void refreshNativeSessions();
      if (!readyResolved) {
        readyResolved = true;
        resolveReady();
      }
    });
    socket.on("message", (data) => {
      if (stopped) return;
      try {
        const command = CoreToConnectorEnvelopeSchema.parse(
          decodeJson(data.toString()),
        );
        const inFlight = handleCommand(command);
        inFlightCommands.add(inFlight);
        void inFlight
          .catch((error) => console.error("Connector command failed", error))
          .finally(() => inFlightCommands.delete(inFlight));
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
    close() {
      closePromise ??= (async () => {
        stopped = true;
        unsubscribeLost();
        if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
        socket?.close();
        await options.provider.close();
        await Promise.allSettled([...inFlightCommands]);
        if (healthServer !== undefined) {
          await new Promise<void>((resolve, reject) => {
            healthServer?.close((error) => (error ? reject(error) : resolve()));
          });
        }
        journal.close();
      })();
      return closePromise;
    },
  };
}

export function startMockConnector(
  options: MockConnectorOptions,
): ConnectorHandle {
  return startConnector({
    coreUrl: options.coreUrl,
    connectorToken: options.connectorToken,
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
