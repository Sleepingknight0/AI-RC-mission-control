import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";

import {
  ConnectorEnvelopeSchema,
  CoreToConnectorEnvelopeSchema,
  ARTIFACT_CHUNK_BYTES,
  MAX_INLINE_DIFF_BYTES,
  MAX_INLINE_ENVELOPE_BYTES,
  MAX_WEBSOCKET_MESSAGE_BYTES,
  ProviderAccountCapabilitySnapshotSchema,
  RuntimeSchema,
  decodeJson,
  makeEnvelope,
  utf8ByteLength,
  websocketCapability,
  type ConnectorEnvelope,
  type CoreToConnectorEnvelope,
  type ProviderAccountCapabilitySnapshot,
  type ProviderFleetSnapshot,
  type ProviderRecord,
  type ProviderNativeSessionSnapshot,
  type Runtime,
} from "@aicl/protocol";
import WebSocket from "ws";

import { ConnectorJournal } from "./journal.js";
import { InputAttachmentMaterializer } from "./input-attachments.js";
import { MockProvider } from "./mock-provider.js";
import {
  ProviderLostError,
  nativeSessionPageWithRecovery,
  type ConnectorProvider,
} from "./provider.js";
import type {
  ManagedProviderAccount,
  ProviderAccountController,
} from "./provider.js";

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
    active?: { providerId: string; accountId: string } | null,
  ) => ProviderFleetSnapshot | Promise<ProviderFleetSnapshot>;
  providerInventoryTimeoutMs?: number;
  providerNativeSessions?: (
    revision: number,
  ) => ProviderNativeSessionSnapshot | Promise<ProviderNativeSessionSnapshot>;
  providerNativeSessionIdentity?: { providerId: string; accountId: string };
  providerNativeSessionTimeoutMs?: number;
  providerAccountController?: ProviderAccountController;
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
  const inputAttachments = new InputAttachmentMaterializer();
  let activeAccount: ManagedProviderAccount | null =
    journal.activeProviderId !== undefined &&
    journal.activeAccountId !== undefined &&
    options.providerAccountController !== undefined
      ? options.providerAccountController.open(
          journal.activeProviderId,
          journal.activeAccountId,
        )
      : null;
  let provider = activeAccount?.provider ?? options.provider;
  let legacyActiveIdentity: { providerId: string; accountId: string } | null = null;
  let preloadedInventory: ProviderFleetSnapshot | undefined;
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
  let accountCapabilityRevision = 0;
  const accountCapabilities = new Map<
    string,
    ProviderAccountCapabilitySnapshot
  >();
  const activeIdentity = () =>
    activeAccount === null
      ? legacyActiveIdentity
      : {
          providerId: activeAccount.providerId,
          accountId: activeAccount.accountId,
        };
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
      envelope.type === "connector.sessions.native.snapshot" ||
      envelope.type === "connector.provider.account.capabilities.snapshot" ||
      envelope.type === "connector.sessions.native.page"
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

  let unsubscribeLost: () => void = () => undefined;
  const subscribeProviderLoss = () => {
    unsubscribeLost();
    unsubscribeLost = provider.onLost(() => {
      providerLost = true;
      emitRuntime("lost");
    });
  };
  subscribeProviderLoss();

  const initializeLegacyAccountEvidence = async () => {
    if (
      options.providerAccountController !== undefined ||
      options.providerInventory === undefined
    ) {
      return;
    }
    let timeout: NodeJS.Timeout | undefined;
    try {
      const revision = ++inventoryRevision;
      const snapshot = await Promise.race([
        Promise.resolve().then(() => options.providerInventory?.(revision, null)),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Provider inventory bootstrap timed out")),
            options.providerInventoryTimeoutMs ?? 2_500,
          );
        }),
      ]);
      if (snapshot === undefined) return;
      preloadedInventory = snapshot;
      const candidates = snapshot.providers.flatMap((providerRecord) =>
        providerRecord.accounts
          .filter(
            (account) =>
              providerRecord.enabled &&
              providerRecord.installation === "installed" &&
              providerRecord.compatibility === "compatible" &&
              providerRecord.adapterSupport === "remote_control" &&
              account.authentication === "authenticated" &&
              account.control === "remote_control",
          )
          .map((account) => ({ providerRecord, account })),
      );
      if (candidates.length !== 1) return;
      const candidate = candidates[0]!;
      legacyActiveIdentity = {
        providerId: candidate.providerRecord.providerId,
        accountId: candidate.account.accountId,
      };
      const capable = provider as ConnectorProvider & {
        accountCapabilities?: (input: {
          revision: number;
          active: boolean;
        }) => Promise<ProviderAccountCapabilitySnapshot>;
      };
      const capabilityRevision = ++accountCapabilityRevision;
      const exact =
        capable.accountCapabilities === undefined
          ? legacyAccountSnapshot(
              candidate.providerRecord,
              candidate.account.accountId,
              capabilityRevision,
            )
          : await capable.accountCapabilities({
              revision: capabilityRevision,
              active: true,
            });
      accountCapabilities.set(
        accountKey(exact.providerId, exact.accountId),
        ProviderAccountCapabilitySnapshotSchema.parse(exact),
      );
    } catch {
      preloadedInventory = undefined;
      legacyActiveIdentity = null;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  };

  const refreshProviderInventory = () => {
    if (options.providerInventory === undefined) return Promise.resolve();
    if (inventoryRefreshInFlight !== undefined) return inventoryRefreshInFlight;
    const revision = preloadedInventory?.revision ?? ++inventoryRevision;
    // Schedule the body in a microtask so even a preloaded, fully synchronous
    // refresh cannot clear the in-flight slot before this assignment completes.
    inventoryRefreshInFlight = Promise.resolve().then(async () => {
      const timeoutMs = options.providerInventoryTimeoutMs ?? 2_500;
      let timeout: NodeJS.Timeout | undefined;
      try {
        const snapshot = preloadedInventory ?? await Promise.race([
          Promise.resolve().then(() =>
            options.providerInventory?.(revision, activeIdentity()),
          ),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Provider inventory refresh timed out")),
              timeoutMs,
            );
          }),
        ]);
        if (snapshot === undefined || stopped) return;
        preloadedInventory = undefined;
        emit(
          makeEnvelope("connector.providers.snapshot", {
            snapshot: {
              ...snapshot,
              revision,
            },
          }),
        );
        const identity = legacyActiveIdentity;
        if (identity !== null) {
          const providerRecord = snapshot.providers.find(
            (candidate) => candidate.providerId === identity.providerId,
          );
          const accountRecord = providerRecord?.accounts.find(
            (candidate) => candidate.accountId === identity.accountId,
          );
          const capable = provider as ConnectorProvider & {
            accountCapabilities?: (input: {
              revision: number;
              active: boolean;
            }) => Promise<ProviderAccountCapabilitySnapshot>;
          };
          const capabilityRevision = ++accountCapabilityRevision;
          const exact =
            providerRecord !== undefined && accountRecord !== undefined
              ? capable.accountCapabilities === undefined
                ? legacyAccountSnapshot(
                    providerRecord,
                    identity.accountId,
                    capabilityRevision,
                  )
                : await capable.accountCapabilities({
                    revision: capabilityRevision,
                    active: true,
                  })
              : unavailableAccountSnapshot(identity, capabilityRevision);
          accountCapabilities.set(
            accountKey(identity.providerId, identity.accountId),
            exact,
          );
          emit(
            makeEnvelope("connector.provider.account.capabilities.snapshot", {
              snapshot: exact,
            }),
          );
        }
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
    });
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

  const accountKey = (providerId: string, accountId: string) =>
    `${providerId}\u0000${accountId}`;

  const refreshAccountCapabilities = async (
    providerId: string,
    accountId: string,
  ) => {
    const controller = options.providerAccountController;
    if (controller === undefined) return;
    const isActive =
      activeAccount?.providerId === providerId &&
      activeAccount.accountId === accountId;
    const account = isActive
      ? activeAccount
      : controller.open(providerId, accountId);
    if (account === null) return;
    try {
      const revision = ++accountCapabilityRevision;
      const snapshot = await account.capabilities(revision, isActive);
      controller.rememberIdentity(
        providerId,
        accountId,
        await account.identityFingerprint(),
      );
      accountCapabilities.set(accountKey(providerId, accountId), snapshot);
      emit(
        makeEnvelope("connector.provider.account.capabilities.snapshot", {
          snapshot,
        }),
      );
    } finally {
      if (!isActive) await account.provider.close();
    }
  };

  const listNativeSessions = async (
    command: Extract<
      CoreToConnectorEnvelope,
      { type: "connector.sessions.native.list" }
    >,
  ) => {
    const controller = options.providerAccountController;
    if (controller === undefined) return;
    const { providerId, accountId } = command.payload;
    const isActive =
      activeAccount?.providerId === providerId &&
      activeAccount.accountId === accountId;
    const account = isActive
      ? activeAccount
      : controller.open(providerId, accountId);
    if (account === null) {
      const observedAt = new Date().toISOString();
      emit(
        makeEnvelope("connector.sessions.native.page", {
          requestId: command.payload.requestId,
          page: {
            providerId,
            accountId,
            observedAt,
            freshness: "unavailable" as const,
            sessions: [],
            nextCursor: null,
            hasMore: false,
            truncated: false,
            cursorReset: false,
            notice: "Provider account is unavailable",
          },
        }),
      );
      return;
    }
    try {
      const page = await nativeSessionPageWithRecovery(
        controller,
        account,
        command.payload,
      );
      emit(
        makeEnvelope("connector.sessions.native.page", {
          requestId: command.payload.requestId,
          page,
        }),
      );
    } catch {
      const observedAt = new Date().toISOString();
      emit(
        makeEnvelope("connector.sessions.native.page", {
          requestId: command.payload.requestId,
          page: {
            providerId,
            accountId,
            observedAt,
            freshness: "unavailable" as const,
            sessions: [],
            nextCursor: null,
            hasMore: false,
            truncated: false,
            cursorReset: false,
            notice:
              "Provider Session discovery failed or timed out",
          },
        }),
      );
    } finally {
      if (!isActive) await account.provider.close();
    }
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
    if (command.type === "connector.provider.account.capabilities.refresh") {
      await refreshAccountCapabilities(
        command.payload.providerId,
        command.payload.accountId,
      );
      return;
    }
    if (command.type === "connector.sessions.native.list") {
      await listNativeSessions(command);
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
    if (
      command.type === "connector.attachment.begin" ||
      command.type === "connector.attachment.chunk" ||
      command.type === "connector.attachment.complete"
    ) {
      if (
        command.payload.runtimeId !== journal.runtimeId ||
        command.payload.runtimeGeneration !== journal.runtimeGeneration
      ) {
        return;
      }
      if (command.type === "connector.attachment.begin") inputAttachments.begin(command);
      else if (command.type === "connector.attachment.chunk") {
        inputAttachments.append(command);
      } else inputAttachments.complete(command);
      return;
    }
    const decision = journal.recordCommand(command);
    if (decision === "same") return;
    if (decision === "conflict") {
      if (command.type === "connector.provider.account.activate") {
        emit(
          makeEnvelope("connector.provider.account.activation.rejected", {
            commandId: command.payload.commandId,
            providerId: command.payload.providerId,
            accountId: command.payload.accountId,
            code: "IDEMPOTENCY_KEY_REUSE",
          }),
        );
        return;
      }
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

    if (command.type === "connector.provider.account.activate") {
      const controller = options.providerAccountController;
      const currentSnapshot = accountCapabilities.get(
        accountKey(command.payload.providerId, command.payload.accountId),
      );
      const reject = (code: string) => {
        journal.markCommand(command.payload.commandId, "completed", {
          failureCode: code,
        });
        emit(
          makeEnvelope("connector.provider.account.activation.rejected", {
            commandId: command.payload.commandId,
            providerId: command.payload.providerId,
            accountId: command.payload.accountId,
            code,
          }),
        );
      };
      if (
        controller === undefined ||
        command.payload.expectedRuntimeId !== journal.runtimeId ||
        command.payload.expectedRuntimeGeneration !== journal.runtimeGeneration
      ) {
        reject("STALE_RUNTIME_GENERATION");
        return;
      }
      if (
        currentSnapshot === undefined ||
        currentSnapshot.revision !== command.payload.expectedRevision
      ) {
        reject("ACCOUNT_REVISION_CONFLICT");
        return;
      }
      if (runtimeStatus !== "ready") {
        reject("ACCOUNT_ACTIVATION_BLOCKED");
        return;
      }
      if (
        activeAccount?.providerId === command.payload.providerId &&
        activeAccount.accountId === command.payload.accountId
      ) {
        journal.markCommand(command.payload.commandId, "completed");
        emit(
          makeEnvelope("connector.provider.account.activated", {
            commandId: command.payload.commandId,
            providerId: command.payload.providerId,
            accountId: command.payload.accountId,
            revision: currentSnapshot.revision,
            runtime: runtime("ready"),
          }),
        );
        return;
      }
      const candidate = controller.open(
        command.payload.providerId,
        command.payload.accountId,
      );
      if (candidate === null) {
        reject("PROVIDER_ACCOUNT_UNAVAILABLE");
        return;
      }
      let snapshot: ProviderAccountCapabilitySnapshot;
      try {
        const revision = ++accountCapabilityRevision;
        snapshot = await candidate.capabilities(revision, true);
        controller.rememberIdentity(
          candidate.providerId,
          candidate.accountId,
          await candidate.identityFingerprint(),
        );
        if (
          snapshot.authentication !== "authenticated" ||
          snapshot.control !== "remote_control" ||
          snapshot.freshness !== "live"
        ) {
          await candidate.provider.close();
          reject("PROVIDER_ACCOUNT_NOT_CONTROLLABLE");
          return;
        }
      } catch (error) {
        await candidate.provider.close();
        reject(
          error instanceof Error &&
              error.message === "DUPLICATE_ACCOUNT_IDENTITY"
            ? "DUPLICATE_ACCOUNT_IDENTITY"
            : "PROVIDER_ACCOUNT_ACTIVATION_FAILED",
        );
        return;
      }
      try {
        journal.rotateRuntime({
          expectedRuntimeId: command.payload.expectedRuntimeId,
          expectedRuntimeGeneration: command.payload.expectedRuntimeGeneration,
          nextRuntimeId: command.payload.nextRuntimeId,
          nextRuntimeGeneration: command.payload.nextRuntimeGeneration,
          providerId: candidate.providerId,
          accountId: candidate.accountId,
        });
      } catch {
        await candidate.provider.close();
        reject("STALE_RUNTIME_GENERATION");
        return;
      }
      const priorIdentity = activeIdentity();
      const priorProvider = provider;
      activeAccount = candidate;
      provider = candidate.provider;
      providerLost = false;
      runtimeStatus = "ready";
      subscribeProviderLoss();
      accountCapabilities.set(
        accountKey(candidate.providerId, candidate.accountId),
        snapshot,
      );
      journal.markCommand(command.payload.commandId, "completed");
      emit(
        makeEnvelope("connector.provider.account.activated", {
          commandId: command.payload.commandId,
          providerId: candidate.providerId,
          accountId: candidate.accountId,
          revision: snapshot.revision,
          runtime: runtime("ready"),
        }),
      );
      emit(
        makeEnvelope("connector.provider.account.capabilities.snapshot", {
          snapshot,
        }),
      );
      if (
        priorIdentity !== null &&
        (priorIdentity.providerId !== candidate.providerId ||
          priorIdentity.accountId !== candidate.accountId)
      ) {
        const priorKey = accountKey(
          priorIdentity.providerId,
          priorIdentity.accountId,
        );
        const priorSnapshot = accountCapabilities.get(priorKey);
        if (priorSnapshot !== undefined) {
          const observedAt = new Date().toISOString();
          const inactiveSnapshot = ProviderAccountCapabilitySnapshotSchema.parse({
            ...priorSnapshot,
            snapshotId: `account-${crypto.randomUUID()}`,
            revision: ++accountCapabilityRevision,
            observedAt,
            staleAt: new Date(Date.now() + 60_000).toISOString(),
            control: "inventory_only",
            active: false,
            notice: "Another provider account is active",
          });
          accountCapabilities.set(priorKey, inactiveSnapshot);
          emit(
            makeEnvelope("connector.provider.account.capabilities.snapshot", {
              snapshot: inactiveSnapshot,
            }),
          );
        }
      }
      void priorProvider.close().catch((error: unknown) =>
        console.error("Previous provider close failed after activation", error),
      );
      await refreshProviderInventory();
      return;
    }

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
        if (provider.prepareSession === undefined) {
          throw new Error("Provider does not implement Session preparation");
        }
        const prepared = await provider.prepareSession(command);
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
      inputAttachments.releaseTurn(command.payload.turnId);
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
        await provider.interrupt(command);
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
        await provider.resolveApproval(command);
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
      const prepared = inputAttachments.prepareForTurn(
        command.payload.sessionId,
        command.payload.turnId,
        command.payload.attachments ?? [],
      );
      await provider.startTurn(command, emit, prepared);
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
    } finally {
      inputAttachments.releaseTurn(command.payload.turnId);
    }
  };

  const connect = () => {
    if (stopped) return;
    socket = new WebSocket(
      options.coreUrl,
      websocketCapability("connector", options.connectorToken),
    );
    socket.on("open", () => {
      const identity = activeIdentity();
      const readyRuntime = runtime(providerLost ? "lost" : runtimeStatus);
      sendRaw(
        ConnectorEnvelopeSchema.parse(
          makeEnvelope("connector.hello", {
            connectorId: journal.connectorId,
            bootId: journal.bootId,
            runtime: readyRuntime,
            activeProviderId: identity?.providerId ?? null,
            activeAccountId: identity?.accountId ?? null,
            commandReceipts: journal.commandReceipts(),
          }),
        ),
      );
      for (const event of journal.pendingEvents()) sendRaw(event);
      void refreshProviderInventory();
      void refreshNativeSessions();
      for (const snapshot of accountCapabilities.values()) {
        emit(
          makeEnvelope("connector.provider.account.capabilities.snapshot", {
            snapshot,
          }),
        );
      }
      if (activeAccount !== null) {
        void refreshAccountCapabilities(
          activeAccount.providerId,
          activeAccount.accountId,
        );
      }
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
            activeProviderId: activeIdentity()?.providerId ?? null,
            activeAccountId: activeIdentity()?.accountId ?? null,
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

  void initializeLegacyAccountEvidence().finally(connect);

  return {
    ready,
    identity: {
      get connectorId() {
        return journal.connectorId;
      },
      get bootId() {
        return journal.bootId;
      },
      get runtimeId() {
        return journal.runtimeId;
      },
      get generation() {
        return journal.runtimeGeneration;
      },
    },
    close() {
      closePromise ??= (async () => {
        stopped = true;
        unsubscribeLost();
        if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
        socket?.close();
        await provider.close();
        await Promise.allSettled([...inFlightCommands]);
        inputAttachments.close();
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

function legacyAccountSnapshot(
  provider: ProviderRecord,
  accountId: string,
  revision: number,
): ProviderAccountCapabilitySnapshot {
  const account = provider.accounts.find(
    (candidate) => candidate.accountId === accountId,
  );
  if (account === undefined) throw new Error("Provider account disappeared");
  const observedAt = new Date().toISOString();
  const models =
    provider.models.length > 0
      ? provider.models
      : [
          {
            modelId: "test-default",
            displayName: "Test default",
            description: "Normalized test-provider default model",
            hidden: false,
            isDefault: true,
            inputModalities: ["text" as const],
            defaultReasoningEffort: null,
            reasoningEfforts: [],
          },
        ];
  return ProviderAccountCapabilitySnapshotSchema.parse({
    snapshotId: `account-capability-${crypto.randomUUID()}`,
    revision,
    providerId: provider.providerId,
    accountId,
    source: "provider_probe",
    observedAt,
    staleAt: new Date(Date.now() + 60_000).toISOString(),
    freshness: "live",
    authentication: account.authentication,
    control:
      account.authentication === "authenticated" &&
      account.control === "remote_control"
        ? "remote_control"
        : "inventory_only",
    active: true,
    capabilities: provider.capabilities,
    models,
    modelsState: "available",
    notice: "Migrated from one exact legacy Connector account",
  });
}

function unavailableAccountSnapshot(
  identity: { providerId: string; accountId: string },
  revision: number,
): ProviderAccountCapabilitySnapshot {
  const observedAt = new Date().toISOString();
  return ProviderAccountCapabilitySnapshotSchema.parse({
    snapshotId: `account-capability-${crypto.randomUUID()}`,
    revision,
    providerId: identity.providerId,
    accountId: identity.accountId,
    source: "unavailable",
    observedAt,
    staleAt: new Date(Date.now() + 60_000).toISOString(),
    freshness: "unavailable",
    authentication: "unknown",
    control: "inventory_only",
    active: true,
    capabilities: [],
    models: [],
    modelsState: "unavailable",
    notice: "The exact legacy Connector account is unavailable",
  });
}
