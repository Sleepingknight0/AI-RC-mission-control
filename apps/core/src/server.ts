import {
  timingSafeEqual,
} from "node:crypto";
import {
  createServer,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { dirname, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import { httpOrigin, webSocketOrigin } from "@aicl/config";
import {
  ClientEnvelopeSchema,
  ConnectorEnvelopeSchema,
  CoreToConnectorEnvelopeSchema,
  BrowserRuntimeConfigSchema,
  MAX_OUTPUT_BATCH_BYTES,
  INPUT_ATTACHMENT_CHUNK_BYTES,
  MAX_WEBSOCKET_MESSAGE_BYTES,
  ProviderFleetSnapshotSchema,
  ProviderAccountCapabilitySnapshotSchema,
  ProviderNativeSessionSnapshotSchema,
  ServerEnvelopeSchema,
  decodeJson,
  makeEnvelope,
  redactSensitiveText,
  utf8ByteLength,
  websocketCapability,
  type ClientEnvelope,
  type Approval,
  type ConnectorEnvelope,
  type CoreToConnectorEnvelope,
  type InputAttachment,
  type ProtocolError,
  type ProviderFleetSnapshot,
  type ProviderAccountCapabilitySnapshot,
  type ProviderNativeSessionSnapshot,
  type ProviderRecord,
  type Runtime,
  type ServerEnvelope,
  type SessionCapabilitiesSnapshot,
  type SessionSettings,
  type SessionSettingsSnapshot,
} from "@aicl/protocol";
import WebSocket, { WebSocketServer } from "ws";

import { classifyApprovalPolicy } from "./approval-policy.js";
import {
  CoreDatabase,
  InputAttachmentMutationError,
  type ConnectorIngestRejection,
  type ConnectorSource,
} from "./store.js";
import { BrowserTicketRegistry } from "./browser-tickets.js";
import { NativeSessionEvidenceStore } from "./native-session-evidence.js";
import { isReservedHttpPath, serveWebRequest } from "./static-host.js";

export const DEFAULT_CORE_DB_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../.data/aicl-core.db",
);
export const DEFAULT_WEB_DIST_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../web/dist",
);
const MAX_CONNECTOR_INGEST_DIAGNOSTICS = 64;

export interface CoreServerOptions {
  host?: string;
  port?: number;
  dbPath?: string;
  webDistPath?: string;
  connectorLossGraceMs?: number;
  artifactAccessToken?: string;
  browserToken?: string;
  legacyBrowserTokenEnabled?: boolean;
  browserTicketTtlMs?: number;
  browserTicketLimit?: number;
  connectorToken?: string;
  allowedBrowserOrigins?: readonly string[];
  approvalSweepMs?: number;
  browserMessagesPerSecond?: number;
  connectorMessagesPerSecond?: number;
  heartbeatIntervalMs?: number;
  beforeDurableBroadcast?: (event: ServerEnvelope) => void;
  onBroadcastError?: (error: unknown, event: ServerEnvelope) => void;
  onConnectorIngestRejected?: (rejection: ConnectorIngestRejection) => void;
}

export interface CoreServerHandle {
  host: string;
  port: number;
  browserUrl: string;
  connectorUrl: string;
  dbPath: string;
  browserToken: string;
  connectorToken: string;
  close(): Promise<void>;
}

interface ConnectorConnection {
  socket: WebSocket;
  connectorId: string;
  bootId: string;
  runtime: Runtime;
  activeProviderId: string | null;
  activeAccountId: string | null;
}

function validatedServerEnvelope(value: unknown): ServerEnvelope {
  return ServerEnvelopeSchema.parse(value);
}

export function validatedConnectorCommand(value: unknown): CoreToConnectorEnvelope {
  return CoreToConnectorEnvelopeSchema.parse(value);
}

type SessionProviderAuthority = ReturnType<
  CoreDatabase["sessionProviderAuthority"]
>;

export function projectSessionCapabilities(
  settingsSnapshot: SessionSettingsSnapshot,
  authority: SessionProviderAuthority,
  fleet: ProviderFleetSnapshot | undefined,
  accountEvidence?: ProviderAccountCapabilitySnapshot,
  currentRuntime?: Runtime,
): SessionCapabilitiesSnapshot {
  const { settings } = settingsSnapshot;
  const provider = fleet?.providers.find(
    (candidate) => candidate.providerId === settings.providerId,
  );
  const account = provider?.accounts.find(
    (candidate) => candidate.accountId === settings.accountId,
  );
  const accountModels = accountEvidence?.models ?? [];
  const accountModelsState = accountEvidence?.modelsState ?? "unavailable";
  const model =
    settings.model === null
      ? accountModels.find((candidate) => candidate.isDefault) ?? accountModels[0]
      : accountModels.find((candidate) => candidate.modelId === settings.model);
  const providerFreshness =
    fleet === undefined
      ? "unavailable"
      : provider !== undefined &&
          ["stale", "offline", "unavailable"].includes(provider.freshness)
        ? provider.freshness
        : fleet.freshness;
  const freshness = accountEvidence?.freshness ?? "unavailable";
  const fresh = ["live", "local"].includes(providerFreshness);
  const providerState =
    provider === undefined || !fresh
      ? "unknown"
      : provider.adapterSupport !== "remote_control"
        ? "unsupported"
        : provider.authentication === "authenticated"
          ? "supported"
          : provider.authentication === "not_authenticated"
            ? "unsupported"
            : "unknown";
  const providerReason =
    provider === undefined
      ? "Provider inventory is unavailable."
      : !fresh
        ? "Provider capability evidence is stale or unavailable."
        : provider.adapterSupport !== "remote_control"
          ? "Provider is inventory-only."
          : provider.authentication !== "authenticated"
            ? "Provider authentication is not currently verified."
            : null;
  const accountState =
    settings.accountId === null
      ? "unsupported"
      : providerState === "unknown"
        ? "unknown"
        : account === undefined ||
            accountEvidence === undefined ||
            accountEvidence.freshness !== "live" ||
            Date.parse(accountEvidence.staleAt) <= Date.now() ||
            !accountEvidence.active ||
            accountEvidence.authentication !== "authenticated" ||
            accountEvidence.control !== "remote_control"
          ? "unsupported"
          : account.authentication === "authenticated"
            ? "supported"
            : "unknown";
  const accountReason =
    settings.accountId === null
      ? "Session has no bound provider account."
      : providerState === "unknown"
        ? providerReason
        : account === undefined
          ? "Bound provider account is absent from current inventory."
          : account.authentication !== "authenticated"
            ? "Bound provider account is not currently authenticated."
            : accountEvidence === undefined
              ? "Bound provider account capability evidence is unavailable."
              : !accountEvidence.active
                ? "Bound provider account is not the active Connector account."
                : accountEvidence.freshness !== "live" ||
                    Date.parse(accountEvidence.staleAt) <= Date.now()
                  ? "Bound provider account capability evidence is stale."
                  : accountEvidence.control !== "remote_control"
                    ? "Bound provider account is inventory-only."
              : null;
  const modelSupported =
    accountState === "supported" &&
    accountModelsState === "available" &&
    model !== undefined;
  const modelState =
    modelSupported
      ? "supported"
      : accountState === "unknown" || accountModelsState !== "available"
        ? "unknown"
        : "unsupported";
  const modelReason = modelSupported
    ? null
    : providerState === "unknown"
      ? providerReason
      : accountModelsState !== "available"
        ? "Provider model evidence is unavailable."
        : "Selected model is not advertised by the provider.";
  const controlError = validateTurnControlAuthority(
    settings,
    authority,
    fleet,
    accountEvidence,
    currentRuntime,
  );
  const canControl = controlError === undefined;
  const featureSupport = (
    key: ProviderRecord["capabilities"][number]["key"],
    unavailableReason: string,
  ) => {
    if (!canControl) {
      return {
        state: freshness === "stale" || freshness === "unavailable"
          ? ("unknown" as const)
          : ("unsupported" as const),
        reason: controlError?.message ?? unavailableReason,
      };
    }
    const evidence = accountEvidence?.capabilities.find(
      (capability) => capability.key === key,
    );
    return evidence?.state === "supported"
      ? { state: "supported" as const, reason: null }
      : {
          state: evidence?.state ?? ("unknown" as const),
          reason: evidence?.reason ?? unavailableReason,
        };
  };
  const executionSupport = featureSupport(
    "execution_modes",
    "Execution modes are not supported by this provider.",
  );
  const textSupport = featureSupport(
    "text_input",
    "Text attachments are not supported by this provider.",
  );
  const imageCapability = featureSupport(
    "image_input",
    "Image attachments are not supported by this provider.",
  );
  const imageSupported =
    imageCapability.state === "supported" &&
    model !== undefined &&
    model.inputModalities.includes("image");
  const approvalSupport = featureSupport(
    "approval_policies",
    "Approval policies are not supported by this provider.",
  );
  const scopedLease =
    approvalSupport.state === "supported" &&
    settings.approvalPolicy === "full_auto_lease" &&
    settings.sandboxPolicy === "workspace_write" &&
    settings.projectPath !== null &&
    settings.accountId !== null;

  return {
    sessionId: settingsSnapshot.sessionId,
    settingsRevision: settingsSnapshot.revision,
    observedAt: accountEvidence?.observedAt ?? new Date().toISOString(),
    freshness,
    provider: {
      providerId: settings.providerId,
      state: providerState,
      reason: providerReason,
    },
    account: {
      accountId: settings.accountId,
      state: accountState,
      reason: accountReason,
    },
    model: {
      modelId: settings.model,
      state: modelState,
      reason: modelReason,
    },
    controlAuthority: {
      canControl,
      bindingStatus: authority?.state ?? "unbound",
      reason: controlError?.message ?? null,
    },
    executionModes: ["ask", "plan", "auto"].map((mode) => ({
      mode: mode as "ask" | "plan" | "auto",
      ...executionSupport,
    })),
    attachments: [
      { kind: "text", ...textSupport },
      {
        kind: "image",
        state: imageSupported
          ? "supported"
          : imageCapability.state === "supported"
            ? "unsupported"
            : imageCapability.state,
        reason: imageSupported
          ? null
          : imageCapability.reason ??
            "Selected model does not advertise image input.",
      },
    ],
    approvalPolicies: [
      "review",
      "balanced",
      "workspace_auto",
      "full_auto_lease",
    ].map((policy) => ({
      policy: policy as
        | "review"
        | "balanced"
        | "workspace_auto"
        | "full_auto_lease",
      ...approvalSupport,
    })),
    fullAutoLease: scopedLease
      ? { state: "supported", reason: null }
      : {
          state:
            approvalSupport.state === "unknown" ? "unknown" : "unsupported",
          reason:
            approvalSupport.reason ??
            "A lease requires Full Auto policy and an explicit writable project scope.",
        },
  };
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
  const webDistPath =
    options.webDistPath ?? process.env.AICL_WEB_DIST_PATH ?? DEFAULT_WEB_DIST_PATH;
  let connectorIngestDiagnostics = 0;
  const store = new CoreDatabase({
    path: dbPath,
    onConnectorIngestRejected: (rejection) => {
      connectorIngestDiagnostics += 1;
      if (connectorIngestDiagnostics <= MAX_CONNECTOR_INGEST_DIAGNOSTICS) {
        if (options.onConnectorIngestRejected !== undefined) {
          options.onConnectorIngestRejected(rejection);
        } else {
          console.error(
            "Core dropped invalid Connector evidence:",
            JSON.stringify(rejection),
          );
        }
      } else if (
        connectorIngestDiagnostics === MAX_CONNECTOR_INGEST_DIAGNOSTICS + 1
      ) {
        console.error("Core Connector ingest diagnostic limit reached");
      }
    },
  });
  const coreBootId = `core-${crypto.randomUUID()}`;
  await store.revokeLeasesForCoreBoot(coreBootId);
  const artifactAccessToken =
    options.artifactAccessToken ?? `artifact-token-${crypto.randomUUID()}`;
  const browserToken = options.browserToken ?? crypto.randomUUID();
  const legacyBrowserTokenEnabled = options.legacyBrowserTokenEnabled ?? true;
  const connectorToken = options.connectorToken ?? crypto.randomUUID();
  const browserTickets = new BrowserTicketRegistry(
    options.browserTicketTtlMs ?? 30_000,
    options.browserTicketLimit ?? 128,
  );
  const allowedBrowserOrigins = new Set(
    options.allowedBrowserOrigins ?? [
      "http://127.0.0.1:5173",
      "http://localhost:5173",
    ],
  );
  const clients = new Map<WebSocket, string | null>();
  let connector: WebSocket | undefined;
  let connectorConnection: ConnectorConnection | undefined;
  let connectorLossTimer: NodeJS.Timeout | undefined;
  let lastRuntime: Runtime | undefined = store.latestRuntime();
  let providerFleetSnapshot: ProviderFleetSnapshot | undefined;
  let providerSnapshotBootId: string | undefined;
  const providerAccountSnapshots = new Map<
    string,
    { snapshot: ProviderAccountCapabilitySnapshot; bootId: string }
  >();
  const nativeSessionSnapshots = new Map<
    string,
    { snapshot: ProviderNativeSessionSnapshot; bootId: string }
  >();
  const nativeSessionEvidence = new NativeSessionEvidenceStore();
  const pendingNativeSessionRequests = new Map<
    string,
    {
      socket: WebSocket;
      providerId: string;
      accountId: string;
      cursor: string | null;
      search: string | null;
      archived: "exclude" | "include" | "only";
    }
  >();
  let closing = false;
  const rateWindows = new WeakMap<
    WebSocket,
    { startedAt: number; count: number }
  >();
  const protocolViolations = new WeakMap<WebSocket, number>();
  const liveSockets = new Map<WebSocket, boolean>();
  const pendingExpiryDispatches: Array<{
    approval: Approval;
    providerCorrelationId: string;
  }> = [];

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
    if (requestUrl.pathname === "/runtime-config") {
      const origin = request.headers.origin;
      const originAllowed = isAllowedOrigin(origin, allowedBrowserOrigins);
      if (originAllowed && origin !== undefined) {
        applyRuntimeConfigCors(origin, response);
      }
      if (request.method === "OPTIONS") {
        response.writeHead(originAllowed ? 204 : 403).end();
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405, { allow: "POST, OPTIONS" }).end();
        return;
      }
      if (!originAllowed || origin === undefined) {
        response.writeHead(403, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "ORIGIN_NOT_ALLOWED" }));
        return;
      }
      if (hasRequestBody(request.headers["content-length"], request.headers["transfer-encoding"])) {
        response.writeHead(413, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "PAYLOAD_NOT_ALLOWED" }));
        return;
      }
      const runtimeConfig = browserTickets.issue(origin);
      if (runtimeConfig === undefined) {
        response.writeHead(503, {
          "cache-control": "no-store",
          "content-type": "application/json",
          "retry-after": "1",
        });
        response.end(JSON.stringify({ error: "TICKET_CAPACITY_REACHED" }));
        return;
      }
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "application/json",
        pragma: "no-cache",
        "x-content-type-options": "nosniff",
      });
      response.end(JSON.stringify(BrowserRuntimeConfigSchema.parse(runtimeConfig)));
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
      const artifact = store.artifactMetadata(artifactMatch[1]!);
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
      const body = store.artifactContent(artifact.artifactId, start, end - start + 1);
      if (body === undefined) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(range === null ? 200 : 206, {
        "accept-ranges": "bytes",
        "content-type": artifact.mediaType,
        "content-disposition": `attachment; filename="${artifact.artifactId}.diff"`,
        "content-length": String(body.byteLength),
        "x-content-type-options": "nosniff",
        etag: `"sha256-${artifact.sha256}"`,
        ...(range === null
          ? {}
          : { "content-range": `bytes ${start}-${end}/${artifact.byteLength}` }),
      });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }
    if (isReservedHttpPath(requestUrl.pathname)) {
      response.writeHead(404).end();
      return;
    }
    void serveWebRequest(request, response, webDistPath).catch((error: unknown) => {
      console.error(
        "Core static host failed:",
        redactSensitiveText(error instanceof Error ? error.message : error),
      );
      if (!response.headersSent) response.writeHead(500).end();
      else response.destroy(error instanceof Error ? error : undefined);
    });
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
    const envelope = validatedConnectorCommand(value);
    if (socket.readyState === WebSocket.OPEN) {
      const json = JSON.stringify(envelope);
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

  const publishLeaseSnapshot = (
    sessionId: string,
    snapshot: ReturnType<CoreDatabase["approvalLeaseSnapshot"]>,
    requester?: WebSocket,
  ) => {
    const envelope = makeEnvelope("approval.lease.snapshot", { snapshot });
    broadcast(sessionId, envelope);
    if (requester !== undefined && clients.get(requester) !== sessionId) {
      send(requester, envelope);
    }
  };

  const publishSettingsSnapshot = (
    sessionId: string,
    snapshot: SessionSettingsSnapshot,
    requester?: WebSocket,
  ) => {
    const envelope = makeEnvelope("session.settings.snapshot", { snapshot });
    broadcast(sessionId, envelope);
    if (requester !== undefined && clients.get(requester) !== sessionId) {
      send(requester, envelope);
    }
  };

  const publishSessionCapabilities = (
    sessionId: string,
    requester?: WebSocket,
  ) => {
    const settings = store.sessionSettings(sessionId);
    if (settings === undefined) return;
    const snapshot = projectSessionCapabilities(
      settings,
      store.sessionProviderAuthority(sessionId),
      providerFleetSnapshot,
      settings.settings.accountId === null
        ? undefined
        : providerAccountSnapshots.get(
            nativeSnapshotKey(
              settings.settings.providerId,
              settings.settings.accountId,
            ),
          )?.snapshot,
      connectorConnection?.runtime,
    );
    const envelope = makeEnvelope("session.capabilities.snapshot", { snapshot });
    broadcast(sessionId, envelope);
    if (requester !== undefined && clients.get(requester) !== sessionId) {
      send(requester, envelope);
    }
  };

  const refreshSelectedCapabilities = () => {
    const selected = new Set(
      [...clients.values()].filter(
        (sessionId): sessionId is string => sessionId !== null,
      ),
    );
    for (const sessionId of selected) publishSessionCapabilities(sessionId);
  };

  const markProviderFleetStale = () => {
    if (providerFleetSnapshot !== undefined) {
      providerFleetSnapshot = ProviderFleetSnapshotSchema.parse({
        ...providerFleetSnapshot,
        freshness: "stale",
        degraded: true,
        providers: providerFleetSnapshot.providers.map((provider) => ({
          ...provider,
          freshness: "stale",
        })),
        notice: "Connector offline; provider inventory may be stale",
      });
      broadcast(
        null,
        makeEnvelope("providers.snapshot", { snapshot: providerFleetSnapshot }),
      );
    }
    for (const [key, retained] of nativeSessionSnapshots) {
      const snapshot = ProviderNativeSessionSnapshotSchema.parse({
        ...retained.snapshot,
        freshness: "stale",
        notice: "Connector offline; provider Sessions may be stale",
      });
      nativeSessionSnapshots.set(key, { ...retained, snapshot });
      broadcast(null, makeEnvelope("sessions.native.snapshot", { snapshot }));
    }
    for (const [key, retained] of providerAccountSnapshots) {
      const snapshot = ProviderAccountCapabilitySnapshotSchema.parse({
        ...retained.snapshot,
        freshness: "stale",
        control: "inventory_only",
        active: false,
        notice: "Connector offline; account capability evidence is stale",
      });
      providerAccountSnapshots.set(key, { ...retained, snapshot });
      broadcast(
        null,
        makeEnvelope("provider.account.capabilities.snapshot", { snapshot }),
      );
    }
    refreshSelectedCapabilities();
  };

  const canControlSession = (sessionId: string) => {
    const settings = store.sessionSettings(sessionId);
    return validateTurnControlAuthority(
      settings?.settings,
      store.sessionProviderAuthority(sessionId),
      providerFleetSnapshot,
      settings?.settings.accountId === null ||
      settings?.settings.accountId === undefined
        ? undefined
        : providerAccountSnapshots.get(
            nativeSnapshotKey(
              settings.settings.providerId,
              settings.settings.accountId,
            ),
          )?.snapshot,
      connectorConnection?.runtime,
    ) === undefined;
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
      if (event.type === "session.provider.status") {
        publishSessionCapabilities(event.payload.sessionId);
      }
    } catch (error) {
      options.onBroadcastError?.(error, event);
      if (options.onBroadcastError === undefined) {
        console.error(
          "Durable event committed but broadcast failed:",
          redactSensitiveText(error instanceof Error ? error.message : error),
        );
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
      {
        type:
          | "turn.submit"
          | "turn.interrupt"
          | "approval.resolve"
          | "session.rename"
          | "session.pin"
          | "session.archive"
          | "session.read.mark"
          | "session.create"
          | "session.resume"
          | "session.runtime.resume"
          | "session.settings.update"
          | "approval.lease.create"
          | "approval.lease.revoke"
          | "approval.emergency_stop"
          | "attachment.upload.begin"
          | "attachment.upload.complete"
          | "attachment.delete";
      }
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

  const interruptActiveTurn = async (sessionId: string) => {
    const connection = connectorConnection;
    if (connection?.socket.readyState !== WebSocket.OPEN) return;
    const snapshot = store.snapshot(sessionId);
    const turn = snapshot.turns.find(
      (candidate) => candidate.turnId === snapshot.activeTurnId,
    );
    if (
      turn === undefined ||
      snapshot.providerSessionId === null ||
      turn.providerTurnId === null
    ) {
      return;
    }
    const commandId = `emergency-interrupt-${crypto.randomUUID()}`;
    const message = ClientEnvelopeSchema.parse(
      makeEnvelope("turn.interrupt", {
        commandId,
        sessionId,
        turnId: turn.turnId,
      }),
    );
    if (message.type !== "turn.interrupt") return;
    const accepted = validatedServerEnvelope(
      makeEnvelope("command.accepted", {
        commandId,
        sessionId,
        turnId: turn.turnId,
      }),
    );
    const result = await store.acceptInterrupt({ message, accepted });
    if (result.kind !== "new" || result.result.type !== "command.accepted") return;
    await store.markDispatched(commandId);
    sendConnector(
      connection.socket,
      makeEnvelope("connector.turn.interrupt", {
        commandId,
        sessionId,
        turnId: turn.turnId,
        providerSessionId: snapshot.providerSessionId,
        providerTurnId: turn.providerTurnId,
      }),
    );
  };

  const applyApprovalPolicy = async (
    connection: ConnectorConnection,
    approvalId: string,
  ): Promise<ServerEnvelope[]> => {
    const context = store.approvalPolicyContext(approvalId);
    if (context === undefined) return [];
    const lease = store.matchingApprovalLease(context, coreBootId);
    const decision = classifyApprovalPolicy(context, lease);
    await store.recordApprovalPolicyDecision({
      context,
      policy: context.settings.approvalPolicy,
      decision: decision.decision,
      classifier: decision.classifier,
      ...(decision.lease === undefined ? {} : { lease: decision.lease }),
    });
    if (decision.decision !== "approved_once") return [];

    const commandId = `policy-${context.approval.approvalId}-${context.approval.revision}`;
    const message = ClientEnvelopeSchema.parse(
      makeEnvelope("approval.resolve", {
        commandId,
        sessionId: context.approval.sessionId,
        approvalId: context.approval.approvalId,
        expectedRevision: context.approval.revision,
        decision: "approved_once",
        deviceId: decision.lease?.deviceId ?? "core-policy",
      }),
    );
    if (message.type !== "approval.resolve") return [];
    const accepted = validatedServerEnvelope(
      makeEnvelope("command.accepted", {
        commandId,
        sessionId: context.approval.sessionId,
        turnId: context.approval.turnId,
      }),
    );
    const result = await store.resolveApproval({
      message,
      accepted,
      runtime: connection.runtime,
      rejection: (code, detail) =>
        rejection({
          commandId,
          sessionId: context.approval.sessionId,
          code,
          message: detail,
        }),
    });
    if (result.kind !== "new" || result.dispatch === undefined) return [];
    await store.markDispatched(commandId);
    sendConnector(
      connection.socket,
      makeEnvelope("connector.approval.resolve", {
        commandId,
        sessionId: context.approval.sessionId,
        turnId: result.dispatch.approval.turnId,
        approvalId: result.dispatch.approval.approvalId,
        providerCorrelationId: result.dispatch.providerCorrelationId,
        runtimeId: result.dispatch.approval.runtimeId,
        runtimeGeneration: result.dispatch.approval.runtimeGeneration,
        decision: result.dispatch.decision,
      }),
    );
    return result.durableEvent === undefined ? [] : [result.durableEvent];
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
      case "sessions.catalog.list": {
        const result = store.sessionCatalog(message.payload, canControlSession);
        if (!result.ok) {
          send(
            socket,
            makeEnvelope("protocol.error", {
              error: protocolError(
                result.code,
                result.code === "SESSION_CATALOG_CURSOR_STALE"
                  ? "Session catalog changed; request a fresh first page."
                  : "Session catalog cursor is invalid.",
                { retryable: result.code === "SESSION_CATALOG_CURSOR_STALE" },
              ),
            }),
          );
          return;
        }
        send(
          socket,
          makeEnvelope("sessions.catalog.snapshot", {
            requestId: result.requestId,
            catalogRevision: result.catalogRevision,
            generatedAt: result.generatedAt,
            sessions: result.sessions,
            nextCursor: result.nextCursor,
            total: result.total,
          }),
        );
        return;
      }
      case "providers.refresh": {
        if (providerFleetSnapshot !== undefined) {
          send(
            socket,
            makeEnvelope("providers.snapshot", {
              snapshot: providerFleetSnapshot,
            }),
          );
        }
        const connection = connectorConnection;
        if (connection?.socket.readyState === WebSocket.OPEN) {
          sendConnector(
            connection.socket,
            makeEnvelope("connector.providers.refresh", {}),
          );
        } else if (providerFleetSnapshot === undefined) {
          send(
            socket,
            makeEnvelope("protocol.error", {
              error: protocolError(
                "PROVIDER_INVENTORY_UNAVAILABLE",
                "Provider inventory is unavailable while the Connector is offline.",
                { retryable: true },
              ),
            }),
          );
        }
        return;
      }
      case "provider.account.capabilities.refresh": {
        const key = nativeSnapshotKey(
          message.payload.providerId,
          message.payload.accountId,
        );
        const retained = providerAccountSnapshots.get(key);
        if (retained !== undefined) {
          send(
            socket,
            makeEnvelope("provider.account.capabilities.snapshot", {
              snapshot: retained.snapshot,
            }),
          );
        }
        const provider = providerFleetSnapshot?.providers.find(
          (candidate) => candidate.providerId === message.payload.providerId,
        );
        const account = provider?.accounts.find(
          (candidate) => candidate.accountId === message.payload.accountId,
        );
        const connection = connectorConnection;
        if (
          connection?.socket.readyState !== WebSocket.OPEN ||
          provider === undefined ||
          account === undefined
        ) {
          if (retained === undefined) {
            send(
              socket,
              makeEnvelope("protocol.error", {
                error: protocolError(
                  "PROVIDER_ACCOUNT_UNAVAILABLE",
                  "Provider account capability evidence is unavailable.",
                  { retryable: connection?.socket.readyState !== WebSocket.OPEN },
                ),
              }),
            );
          }
          return;
        }
        sendConnector(
          connection.socket,
          makeEnvelope(
            "connector.provider.account.capabilities.refresh",
            message.payload,
          ),
        );
        return;
      }
      case "provider.account.activate": {
        const key = nativeSnapshotKey(
          message.payload.providerId,
          message.payload.accountId,
        );
        const accountSnapshot = providerAccountSnapshots.get(key)?.snapshot;
        const provider = providerFleetSnapshot?.providers.find(
          (candidate) => candidate.providerId === message.payload.providerId,
        );
        const account = provider?.accounts.find(
          (candidate) => candidate.accountId === message.payload.accountId,
        );
        const connection = connectorConnection;
        const activationRejection = (code: string, detail: string) =>
          validatedServerEnvelope(
            makeEnvelope("provider.account.activation.rejected", {
              commandId: message.payload.commandId,
              providerId: message.payload.providerId,
              accountId: message.payload.accountId,
              error: protocolError(code, detail, {
                commandId: message.payload.commandId,
              }),
            }),
          );
        const preconditionError =
          connection?.socket.readyState !== WebSocket.OPEN ||
          connection.runtime.status !== "ready"
            ? {
                code: "CONNECTOR_OFFLINE",
                detail: "Connector Runtime is not ready for account activation.",
              }
            :
          provider === undefined ||
          !provider.enabled ||
          provider.installation !== "installed" ||
          provider.compatibility !== "compatible" ||
          account === undefined ||
          accountSnapshot === undefined ||
          accountSnapshot.revision !== message.payload.expectedRevision ||
          accountSnapshot.freshness !== "live" ||
          Date.parse(accountSnapshot.staleAt) <= Date.now() ||
          accountSnapshot.authentication !== "authenticated"
              ? {
                  code: "PROVIDER_ACCOUNT_UNAVAILABLE",
                  detail: "Refresh the exact provider account before activation.",
                }
              : undefined;
        const result = await store.acceptProviderAccountActivation({
          message,
          runtime:
            connection?.runtime ?? {
              runtimeId: message.payload.expectedRuntimeId,
              generation: message.payload.expectedRuntimeGeneration,
              status: "lost",
            },
          sameActiveAccount:
            connection?.activeProviderId === message.payload.providerId &&
            connection.activeAccountId === message.payload.accountId,
          ...(preconditionError === undefined ? {} : { preconditionError }),
          rejection: activationRejection,
        });
        if (result.kind === "conflict") {
          send(
            socket,
            activationRejection(
              "IDEMPOTENCY_KEY_REUSE",
              "The command ID was already used with a different payload.",
            ),
          );
          return;
        }
        if (result.kind === "same") {
          send(socket, result.result);
          return;
        }
        if (result.kind === "pending") return;
        if (result.result !== undefined) {
          send(socket, result.result);
          return;
        }
        if (result.dispatch === undefined) return;
        if (connection === undefined) return;
        sendConnector(
          connection.socket,
          makeEnvelope("connector.provider.account.activate", {
            commandId: message.payload.commandId,
            providerId: message.payload.providerId,
            accountId: message.payload.accountId,
            expectedRevision: message.payload.expectedRevision,
            expectedRuntimeId: message.payload.expectedRuntimeId,
            expectedRuntimeGeneration:
              message.payload.expectedRuntimeGeneration,
            nextRuntimeId: result.dispatch.nextRuntimeId,
            nextRuntimeGeneration: result.dispatch.nextRuntimeGeneration,
          }),
        );
        return;
      }
      case "sessions.native.list": {
        const provider = providerFleetSnapshot?.providers.find(
          (candidate) => candidate.providerId === message.payload.providerId,
        );
        const account = provider?.accounts.find(
          (candidate) => candidate.accountId === message.payload.accountId,
        );
        const connection = connectorConnection;
        if (
          connection?.socket.readyState !== WebSocket.OPEN ||
          provider === undefined ||
          account === undefined
        ) {
          send(
            socket,
            makeEnvelope("protocol.error", {
              error: protocolError(
                "NATIVE_SESSION_DISCOVERY_UNAVAILABLE",
                "Provider Session discovery is unavailable for this account.",
                { retryable: connection?.socket.readyState !== WebSocket.OPEN },
              ),
            }),
          );
          return;
        }
        pendingNativeSessionRequests.set(message.payload.requestId, {
          socket,
          providerId: message.payload.providerId,
          accountId: message.payload.accountId,
          cursor: message.payload.cursor,
          search: message.payload.search,
          archived: message.payload.archived,
        });
        sendConnector(
          connection.socket,
          makeEnvelope("connector.sessions.native.list", message.payload),
        );
        return;
      }
      case "sessions.native.refresh": {
        const key = nativeSnapshotKey(
          message.payload.providerId,
          message.payload.accountId,
        );
        const retained = nativeSessionSnapshots.get(key);
        if (retained !== undefined) {
          send(
            socket,
            makeEnvelope("sessions.native.snapshot", {
              snapshot: retained.snapshot,
            }),
          );
        }
        const provider = providerFleetSnapshot?.providers.find(
          (candidate) => candidate.providerId === message.payload.providerId,
        );
        const account = provider?.accounts.find(
          (candidate) => candidate.accountId === message.payload.accountId,
        );
        const canList = provider?.capabilities.some(
          (capability) =>
            capability.key === "list_sessions" &&
            capability.state === "supported",
        );
        const connection = connectorConnection;
        if (
          connection?.socket.readyState !== WebSocket.OPEN ||
          provider === undefined ||
          account === undefined ||
          account.control !== "remote_control" ||
          !canList
        ) {
          if (retained === undefined) {
            send(
              socket,
              makeEnvelope("protocol.error", {
                error: protocolError(
                  "NATIVE_SESSION_DISCOVERY_UNAVAILABLE",
                  "Provider Session discovery is unavailable for this account.",
                  { retryable: connection?.socket.readyState !== WebSocket.OPEN },
                ),
              }),
            );
          }
          return;
        }
        sendConnector(
          connection.socket,
          makeEnvelope("connector.sessions.native.refresh", message.payload),
        );
        return;
      }
      case "session.create":
      case "session.resume": {
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
        if (
          connection?.socket.readyState !== WebSocket.OPEN ||
          connection.runtime.status !== "ready"
        ) {
          send(
            socket,
            rejection({
              commandId: message.payload.commandId,
              sessionId: message.payload.sessionId,
              code: "RUNTIME_NOT_READY",
              message: "Connector runtime is not ready to prepare a Session.",
            }),
          );
          return;
        }
        const provider = providerFleetSnapshot?.providers.find(
          (candidate) => candidate.providerId === message.payload.providerId,
        );
        const account = provider?.accounts.find(
          (candidate) => candidate.accountId === message.payload.accountId,
        );
        const accountEvidence = providerAccountSnapshots.get(
          nativeSnapshotKey(
            message.payload.providerId,
            message.payload.accountId,
          ),
        )?.snapshot;
        const capabilityKey =
          message.type === "session.create" ? "create_session" : "resume_session";
        if (
          provider === undefined ||
          !["live", "local"].includes(provider.freshness) ||
          account === undefined ||
          accountEvidence === undefined ||
          accountEvidence.freshness !== "live" ||
          Date.parse(accountEvidence.staleAt) <= Date.now() ||
          !accountEvidence.active ||
          accountEvidence.authentication !== "authenticated" ||
          accountEvidence.control !== "remote_control" ||
          accountEvidence.providerId !== message.payload.providerId ||
          accountEvidence.accountId !== message.payload.accountId ||
          connection.activeProviderId !== message.payload.providerId ||
          connection.activeAccountId !== message.payload.accountId ||
          !accountEvidence.capabilities.some(
            (candidate) =>
              candidate.key === capabilityKey &&
              candidate.state === "supported",
          )
        ) {
          send(
            socket,
            rejection({
              commandId: message.payload.commandId,
              sessionId: message.payload.sessionId,
              code: "PROVIDER_CAPABILITY_UNAVAILABLE",
              message: "Selected provider/account cannot perform this operation.",
            }),
          );
          return;
        }

        let selection: {
          title: string;
          source: "aicl" | "imported";
          projectPath: string;
          model: string | null;
          reasoningLevel: string | null;
          providerSessionId: string | null;
        };
        if (message.type === "session.create") {
          if (
            !validProviderAccountModel(
              accountEvidence,
              message.payload.model,
              message.payload.reasoningLevel,
            )
          ) {
            send(
              socket,
              rejection({
                commandId: message.payload.commandId,
                sessionId: message.payload.sessionId,
                code: "PROVIDER_MODEL_UNAVAILABLE",
                message: "Selected model or reasoning level is unavailable.",
              }),
            );
            return;
          }
          selection = {
            title: message.payload.title,
            source: "aicl",
            projectPath: message.payload.projectPath,
            model: message.payload.model,
            reasoningLevel: message.payload.reasoningLevel,
            providerSessionId: null,
          };
        } else {
          const nativeKey = nativeSnapshotKey(
            message.payload.providerId,
            message.payload.accountId,
          );
          const runtimeIdentity = {
            bootId: connection.bootId,
            runtimeId: connection.runtime.runtimeId,
            runtimeGeneration: connection.runtime.generation,
          };
          const discoveredPageRow = nativeSessionEvidence.resumable(
            message.payload.providerId,
            message.payload.accountId,
            message.payload.providerSessionId,
            runtimeIdentity,
          );
          const legacyRetained = nativeSessionSnapshots.get(nativeKey);
          const legacyNative = legacyRetained?.snapshot;
          const legacyIsCurrent =
            legacyRetained?.bootId === connection.bootId &&
            legacyNative?.freshness === "live" &&
            Date.parse(legacyNative.staleAt) > Date.now();
          const discoveredLegacyRow = legacyIsCurrent
            ? legacyNative.sessions.find(
                (candidate) =>
                  candidate.providerSessionId === message.payload.providerSessionId &&
                  candidate.canResume,
              ) ?? null
            : null;
          const discovered = discoveredPageRow ?? discoveredLegacyRow;
          if (discovered === null) {
            send(
              socket,
              rejection({
                commandId: message.payload.commandId,
                sessionId: message.payload.sessionId,
                code: "PROVIDER_SESSION_UNAVAILABLE",
                message: "The selected native Session is not currently resumable.",
              }),
            );
            return;
          }
          if (
            store.boundSessionId(
              message.payload.providerId,
              message.payload.accountId,
              message.payload.providerSessionId,
            ) !== undefined
          ) {
            send(
              socket,
              rejection({
                commandId: message.payload.commandId,
                sessionId: message.payload.sessionId,
                code: "PROVIDER_SESSION_ALREADY_IMPORTED",
                message: "The native Session is already bound to an AICL Session.",
              }),
            );
            return;
          }
          selection = {
            title: discovered.title,
            source: "imported",
            projectPath: discovered.projectPath,
            model: null,
            reasoningLevel: null,
            providerSessionId: discovered.providerSessionId,
          };
        }
        const result = await store.acceptSessionPreparation({
          message,
          runtime: connection.runtime,
          connectorId: connection.connectorId,
          bootId: connection.bootId,
          selection,
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
        if (result.kind !== "new" || result.dispatch === undefined) return;
        await store.markDispatched(message.payload.commandId);
        sendConnector(
          connection.socket,
          message.type === "session.create"
            ? makeEnvelope("connector.session.create", {
                commandId: message.payload.commandId,
                sessionId: message.payload.sessionId,
                providerId: message.payload.providerId,
                accountId: message.payload.accountId,
                projectPath: result.dispatch.projectPath,
                model: result.dispatch.model,
                reasoningLevel: result.dispatch.reasoningLevel,
                runtimeId: connection.runtime.runtimeId,
                runtimeGeneration: connection.runtime.generation,
              })
            : makeEnvelope("connector.session.resume", {
                commandId: message.payload.commandId,
                sessionId: message.payload.sessionId,
                providerId: message.payload.providerId,
                accountId: message.payload.accountId,
                providerSessionId: result.dispatch.providerSessionId!,
                projectPath: result.dispatch.projectPath,
                model: result.dispatch.model,
                reasoningLevel: result.dispatch.reasoningLevel,
                runtimeId: connection.runtime.runtimeId,
                runtimeGeneration: connection.runtime.generation,
              }),
        );
        return;
      }
      case "session.runtime.resume": {
        const connection = connectorConnection;
        const authority = store.sessionProviderAuthority(
          message.payload.sessionId,
        );
        const accountEvidence =
          authority === undefined
            ? undefined
            : providerAccountSnapshots.get(
                nativeSnapshotKey(authority.providerId, authority.accountId),
              )?.snapshot;
        const preconditionError =
          connection?.socket.readyState !== WebSocket.OPEN ||
          connection.runtime.status !== "ready"
            ? {
                code: "RUNTIME_NOT_READY",
                detail: "Connector Runtime is not ready for Session resume.",
              }
            :
          authority === undefined ||
          authority.providerSessionId === null ||
          accountEvidence === undefined ||
          accountEvidence.revision !== message.payload.expectedAccountRevision ||
          accountEvidence.freshness !== "live" ||
          Date.parse(accountEvidence.staleAt) <= Date.now() ||
          !accountEvidence.active ||
          accountEvidence.control !== "remote_control" ||
          accountEvidence.authentication !== "authenticated" ||
          connection.activeProviderId !== authority.providerId ||
          connection.activeAccountId !== authority.accountId ||
          !accountEvidence.capabilities.some(
            (capability) =>
              capability.key === "resume_session" &&
              capability.state === "supported",
          )
              ? {
                  code: "SESSION_NOT_CONTROLLABLE",
                  detail:
                    "The stored provider binding is not resumable by the active account.",
                }
              : undefined;
        const result = await store.acceptSessionRuntimeResume({
          message,
          runtime:
            connection?.runtime ?? {
              runtimeId: message.payload.expectedRuntimeId,
              generation: message.payload.expectedRuntimeGeneration,
              status: "lost",
            },
          connectorId: connection?.connectorId ?? "connector-unavailable",
          bootId: connection?.bootId ?? "boot-unavailable",
          expectedBindingRevision: authority?.revision ?? -1,
          ...(preconditionError === undefined ? {} : { preconditionError }),
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
        if (result.kind !== "new" || result.dispatch === undefined) return;
        if (
          connection === undefined ||
          authority === undefined ||
          authority.providerSessionId === null
        ) {
          return;
        }
        await store.markDispatched(message.payload.commandId);
        sendConnector(
          connection.socket,
          makeEnvelope("connector.session.resume", {
            commandId: message.payload.commandId,
            sessionId: message.payload.sessionId,
            providerId: authority.providerId,
            accountId: authority.accountId,
            providerSessionId: authority.providerSessionId,
            projectPath: result.dispatch.projectPath,
            model: result.dispatch.model,
            reasoningLevel: result.dispatch.reasoningLevel,
            runtimeId: connection.runtime.runtimeId,
            runtimeGeneration: connection.runtime.generation,
          }),
        );
        return;
      }
      case "session.rename":
      case "session.pin":
      case "session.archive": {
        if (!store.hasSession(message.payload.sessionId)) {
          send(
            socket,
            rejection({
              commandId: message.payload.commandId,
              sessionId: message.payload.sessionId,
              code: "SESSION_NOT_FOUND",
              message: "Session does not exist.",
            }),
          );
          return;
        }
        const result = await store.mutateSessionMetadata(
          message,
          (code, detail) =>
            rejection({
              commandId: message.payload.commandId,
              sessionId: message.payload.sessionId,
              code,
              message: detail,
            }),
        );
        if (result.kind === "conflict") sendConflict(socket, message);
        else send(socket, result.result);
        return;
      }
      case "session.read.mark": {
        if (!store.hasSession(message.payload.sessionId)) {
          send(
            socket,
            rejection({
              commandId: message.payload.commandId,
              sessionId: message.payload.sessionId,
              code: "SESSION_NOT_FOUND",
              message: "Session does not exist.",
            }),
          );
          return;
        }
        const result = await store.markSessionRead(
          message,
          (code, detail) =>
            rejection({
              commandId: message.payload.commandId,
              sessionId: message.payload.sessionId,
              code,
              message: detail,
            }),
        );
        if (result.kind === "conflict") sendConflict(socket, message);
        else send(socket, result.result);
        return;
      }
      case "session.settings.get": {
        const snapshot = store.sessionSettings(message.payload.sessionId);
        if (snapshot === undefined) {
          send(
            socket,
            makeEnvelope("protocol.error", {
              error: protocolError(
                "SESSION_NOT_FOUND",
                "Session settings do not exist.",
                { sessionId: message.payload.sessionId },
              ),
            }),
          );
        } else {
          send(socket, makeEnvelope("session.settings.snapshot", { snapshot }));
        }
        return;
      }
      case "session.settings.update": {
        if (!store.hasSession(message.payload.sessionId)) {
          send(
            socket,
            rejection({
              commandId: message.payload.commandId,
              sessionId: message.payload.sessionId,
              code: "SESSION_NOT_FOUND",
              message: "Session does not exist.",
            }),
          );
          return;
        }
        const result = await store.mutateSessionSettings(
          message,
          (requested, current) =>
            validateSessionSettingsSelection(
              requested,
              current,
              providerFleetSnapshot,
              requested.accountId === null
                ? undefined
                : providerAccountSnapshots.get(
                    nativeSnapshotKey(
                      requested.providerId,
                      requested.accountId,
                    ),
                  )?.snapshot,
              connectorConnection?.runtime,
              store.sessionProviderAuthority(message.payload.sessionId),
            ),
          (code, detail) =>
            rejection({
              commandId: message.payload.commandId,
              sessionId: message.payload.sessionId,
              code,
              message: detail,
            }),
        );
        if (result.kind === "conflict") {
          sendConflict(socket, message);
          return;
        }
        send(socket, result.result);
        if (result.snapshot !== undefined) {
          publishSettingsSnapshot(
            message.payload.sessionId,
            result.snapshot,
            socket,
          );
          publishLeaseSnapshot(
            message.payload.sessionId,
            store.approvalLeaseSnapshot(message.payload.sessionId),
            socket,
          );
          publishSessionCapabilities(message.payload.sessionId, socket);
        }
        return;
      }
      case "approval.lease.create": {
        const result = await store.createApprovalLease({
          message,
          coreBootId,
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
        publishLeaseSnapshot(
          message.payload.sessionId,
          result.snapshot,
          socket,
        );
        return;
      }
      case "approval.lease.revoke": {
        const result = await store.revokeApprovalLease({
          message,
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
        publishLeaseSnapshot(
          message.payload.sessionId,
          result.snapshot,
          socket,
        );
        return;
      }
      case "approval.emergency_stop": {
        const result = await store.emergencyStop({
          message,
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
        if (result.snapshot !== undefined) {
          publishLeaseSnapshot(
            message.payload.sessionId,
            result.snapshot,
            socket,
          );
        }
        if (result.activeTurnId !== undefined && result.activeTurnId !== null) {
          await interruptActiveTurn(message.payload.sessionId);
        }
        return;
      }
      case "session.unsubscribe": {
        if (clients.get(socket) === message.payload.sessionId) {
          clients.set(socket, null);
        }
        return;
      }
      case "session.subscribe": {
        const { sessionId, afterSeq } = message.payload;
        if (!store.hasSession(sessionId)) {
          send(
            socket,
            makeEnvelope("protocol.error", {
              error: protocolError(
                "SESSION_NOT_FOUND",
                "Session must be created before it can be selected.",
                { sessionId },
              ),
            }),
          );
          return;
        }
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
        const settings = store.sessionSettings(sessionId);
        if (settings !== undefined) {
          send(socket, makeEnvelope("session.settings.snapshot", { snapshot: settings }));
          publishSessionCapabilities(sessionId, socket);
        }
        send(
          socket,
          makeEnvelope("approval.lease.snapshot", {
            snapshot: store.approvalLeaseSnapshot(sessionId),
          }),
        );
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
      case "attachments.list": {
        send(
          socket,
          makeEnvelope("attachments.snapshot", {
            sessionId: message.payload.sessionId,
            attachments: store.inputAttachments(
              message.payload.sessionId,
              message.payload.deviceId,
            ),
          }),
        );
        return;
      }
      case "attachment.upload.begin": {
        const result = await store.beginInputAttachment(
          message,
          (code, detail) =>
            rejection({
              commandId: message.payload.commandId,
              sessionId: message.payload.sessionId,
              code,
              message: detail,
            }),
        );
        if (result.kind === "conflict") sendConflict(socket, message);
        else send(socket, result.result);
        return;
      }
      case "attachment.upload.chunk": {
        try {
          const progress = await store.appendInputAttachmentChunk(message);
          send(
            socket,
            makeEnvelope("attachment.upload.progress", {
              sessionId: message.payload.sessionId,
              attachmentId: message.payload.attachmentId,
              ...progress,
            }),
          );
        } catch (error) {
          if (!(error instanceof InputAttachmentMutationError)) throw error;
          send(
            socket,
            makeEnvelope("protocol.error", {
              error: protocolError(error.code, error.message, {
                sessionId: message.payload.sessionId,
              }),
            }),
          );
        }
        return;
      }
      case "attachment.upload.complete": {
        const result = await store.completeInputAttachment(
          message,
          (code, detail) =>
            rejection({
              commandId: message.payload.commandId,
              sessionId: message.payload.sessionId,
              code,
              message: detail,
            }),
        );
        if (result.kind === "conflict") sendConflict(socket, message);
        else send(socket, result.result);
        return;
      }
      case "attachment.delete": {
        const result = await store.deleteInputAttachment(
          message,
          (code, detail) =>
            rejection({
              commandId: message.payload.commandId,
              sessionId: message.payload.sessionId,
              code,
              message: detail,
            }),
        );
        if (result.kind === "conflict") sendConflict(socket, message);
        else send(socket, result.result);
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
        if (!store.hasSession(message.payload.sessionId)) {
          send(
            socket,
            rejection({
              commandId: message.payload.commandId,
              sessionId: message.payload.sessionId,
              code: "SESSION_NOT_FOUND",
              message: "Session must be created before a Turn can be submitted.",
            }),
          );
          return;
        }
        const settings = store.sessionSettings(message.payload.sessionId);
        const authority = store.sessionProviderAuthority(message.payload.sessionId);
        const connection = connectorConnection;
        if (connection?.socket.readyState !== WebSocket.OPEN) {
          await recordOfflineRejection(socket, message);
          return;
        }
        const accountEvidence =
          settings?.settings.accountId === null ||
          settings?.settings.accountId === undefined
            ? undefined
            : providerAccountSnapshots.get(
                nativeSnapshotKey(
                  settings.settings.providerId,
                  settings.settings.accountId,
                ),
              )?.snapshot;
        const controlError = validateTurnControlAuthority(
          settings?.settings,
          authority,
          providerFleetSnapshot,
          accountEvidence,
          connection.runtime,
        );
        if (controlError !== undefined) {
          const denied = await store.recordRejectedCommand(
            message,
            rejection({
              commandId: message.payload.commandId,
              sessionId: message.payload.sessionId,
              code: controlError.code,
              message: controlError.message,
            }),
          );
          if (denied.kind === "conflict") sendConflict(socket, message);
          else send(socket, denied.result);
          return;
        }
        if (
          connection.runtime.status !== "ready" &&
          connection.runtime.status !== "busy"
        ) {
          const unavailable = await store.recordRejectedCommand(
            message,
            rejection({
              commandId: message.payload.commandId,
              sessionId: message.payload.sessionId,
              code: "RUNTIME_NOT_READY",
              message: "Connector runtime is not ready for a new Turn.",
            }),
          );
          if (unavailable.kind === "conflict") sendConflict(socket, message);
          else send(socket, unavailable.result);
          return;
        }
        const turnId = `turn-${crypto.randomUUID()}`;
        const attachmentIds = message.payload.attachmentIds ?? [];
        const candidateAttachments = store.inputAttachmentsById(
          message.payload.sessionId,
          attachmentIds,
        );
        if (
          candidateAttachments.length === attachmentIds.length &&
          !supportsTurnAttachments(
            candidateAttachments,
            settings?.settings,
            accountEvidence,
          )
        ) {
          const unsupported = await store.recordRejectedCommand(
            message,
            rejection({
              commandId: message.payload.commandId,
              sessionId: message.payload.sessionId,
              code: "ATTACHMENT_CAPABILITY_UNAVAILABLE",
              message: "Selected provider/model does not support these attachments.",
            }),
          );
          if (unsupported.kind === "conflict") sendConflict(socket, message);
          else send(socket, unsupported.result);
          return;
        }
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
          runtimeBusyRejection: rejection({
            commandId: message.payload.commandId,
            sessionId: message.payload.sessionId,
            code: "RUNTIME_BUSY",
            message: "The Connector runtime is already executing another Turn.",
          }),
          settingsConflictRejection: rejection({
            commandId: message.payload.commandId,
            sessionId: message.payload.sessionId,
            code: "SESSION_SETTINGS_CONFLICT",
            message: "Turn settings changed; refresh before submitting.",
          }),
          sessionNotFoundRejection: rejection({
            commandId: message.payload.commandId,
            sessionId: message.payload.sessionId,
            code: "SESSION_NOT_FOUND",
            message: "Session must be created before a Turn can be submitted.",
          }),
          attachmentRejection: (code, detail) =>
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
        if (result.kind !== "new" || result.result.type !== "command.accepted") return;
        if (result.durableEvent !== undefined) broadcastDurable(result.durableEvent);
        await store.markDispatched(message.payload.commandId);
        const connectorAttachments = (result.turnAttachments ?? []).map(
          ({ attachment, content }) => {
            const transferId = `transfer-${crypto.randomUUID()}`;
            const transfer = {
              attachmentId: attachment.attachmentId,
              transferId,
              name: attachment.name,
              kind: attachment.kind as "text" | "image",
              mediaType: attachment.mediaType,
              byteLength: attachment.byteLength,
              sha256: attachment.sha256,
            };
            const chunkCount = Math.ceil(
              content.byteLength / INPUT_ATTACHMENT_CHUNK_BYTES,
            );
            sendConnector(
              connection.socket,
              makeEnvelope("connector.attachment.begin", {
                sessionId: message.payload.sessionId,
                turnId,
                transfer,
                chunkCount,
                runtimeId: connection.runtime.runtimeId,
                runtimeGeneration: connection.runtime.generation,
              }),
            );
            for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
              const start = chunkIndex * INPUT_ATTACHMENT_CHUNK_BYTES;
              sendConnector(
                connection.socket,
                makeEnvelope("connector.attachment.chunk", {
                  sessionId: message.payload.sessionId,
                  turnId,
                  transferId,
                  chunkIndex,
                  contentBase64: content
                    .subarray(start, start + INPUT_ATTACHMENT_CHUNK_BYTES)
                    .toString("base64"),
                  runtimeId: connection.runtime.runtimeId,
                  runtimeGeneration: connection.runtime.generation,
                }),
              );
            }
            sendConnector(
              connection.socket,
              makeEnvelope("connector.attachment.complete", {
                sessionId: message.payload.sessionId,
                turnId,
                transferId,
                runtimeId: connection.runtime.runtimeId,
                runtimeGeneration: connection.runtime.generation,
              }),
            );
            return transfer;
          },
        );
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
            settingsRevision: result.turnSettings?.revision,
            effectiveSettings: result.turnSettings?.settings,
            attachments: connectorAttachments,
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
        if (result.result.type === "command.accepted") {
          await store.markDispatched(message.payload.commandId);
        }
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
      const previousRuntime = lastRuntime;
      if (connectorLossTimer !== undefined) {
        clearTimeout(connectorLossTimer);
        connectorLossTimer = undefined;
      }
      connectorConnection = {
        socket,
        connectorId: message.payload.connectorId,
        bootId: message.payload.bootId,
        runtime: message.payload.runtime,
        activeProviderId: message.payload.activeProviderId ?? null,
        activeAccountId: message.payload.activeAccountId ?? null,
      };
      if (
        providerFleetSnapshot !== undefined &&
        providerSnapshotBootId !== message.payload.bootId
      ) {
        markProviderFleetStale();
      }
      lastRuntime = message.payload.runtime;
      if (
        previousRuntime !== undefined &&
        (previousRuntime.runtimeId !== message.payload.runtime.runtimeId ||
          previousRuntime.generation !== message.payload.runtime.generation)
      ) {
        const revoked = await store.revokeLeasesForRuntime(previousRuntime);
        for (const snapshot of revoked) {
          publishLeaseSnapshot(snapshot.sessionId, snapshot);
        }
      }
      const recovered = await store.reconcileRuntime(
        message.payload.runtime,
        message.payload.connectorId,
        message.payload.bootId,
        message.payload.commandReceipts,
      );
      for (const event of recovered) broadcastDurable(event);
      broadcast(null, makeEnvelope("runtime.status", { runtime: lastRuntime }));
      broadcast(
        null,
        makeEnvelope("sessions.snapshot", { sessions: store.sessionSummaries() }),
      );
      for (const dispatch of pendingExpiryDispatches.splice(0)) {
        sendConnector(
          socket,
          makeEnvelope("connector.approval.resolve", {
            commandId: `expiry-${dispatch.approval.approvalId}-${dispatch.approval.revision}`,
            sessionId: dispatch.approval.sessionId,
            turnId: dispatch.approval.turnId,
            approvalId: dispatch.approval.approvalId,
            providerCorrelationId: dispatch.providerCorrelationId,
            runtimeId: dispatch.approval.runtimeId,
            runtimeGeneration: dispatch.approval.runtimeGeneration,
            decision: "declined",
          }),
        );
      }
      return;
    }

    if (message.type === "connector.providers.snapshot") {
      if (
        connectorConnection?.socket !== socket ||
        connectorConnection.connectorId !== message.connectorId ||
        connectorConnection.bootId !== message.bootId ||
        connectorConnection.runtime.runtimeId !== message.runtimeId ||
        connectorConnection.runtime.generation !== message.runtimeGeneration
      ) {
        return;
      }
      if (
        providerSnapshotBootId === message.bootId &&
        providerFleetSnapshot !== undefined &&
        message.payload.snapshot.revision <= providerFleetSnapshot.revision
      ) {
        return;
      }
      providerFleetSnapshot = message.payload.snapshot;
      providerSnapshotBootId = message.bootId;
      broadcast(
        null,
        makeEnvelope("providers.snapshot", { snapshot: providerFleetSnapshot }),
      );
      refreshSelectedCapabilities();
      return;
    }

    if (message.type === "connector.sessions.native.snapshot") {
      if (
        connectorConnection?.socket !== socket ||
        connectorConnection.connectorId !== message.connectorId ||
        connectorConnection.bootId !== message.bootId ||
        connectorConnection.runtime.runtimeId !== message.runtimeId ||
        connectorConnection.runtime.generation !== message.runtimeGeneration
      ) {
        return;
      }
      const key = nativeSnapshotKey(
        message.payload.snapshot.providerId,
        message.payload.snapshot.accountId,
      );
      const retained = nativeSessionSnapshots.get(key);
      if (
        retained?.bootId === message.bootId &&
        message.payload.snapshot.revision <= retained.snapshot.revision
      ) {
        return;
      }
      nativeSessionSnapshots.set(key, {
        snapshot: message.payload.snapshot,
        bootId: message.bootId,
      });
      broadcast(
        null,
        makeEnvelope("sessions.native.snapshot", {
          snapshot: message.payload.snapshot,
        }),
      );
      return;
    }

    if (message.type === "connector.provider.account.capabilities.snapshot") {
      if (
        connectorConnection?.socket !== socket ||
        connectorConnection.connectorId !== message.connectorId ||
        connectorConnection.bootId !== message.bootId ||
        connectorConnection.runtime.runtimeId !== message.runtimeId ||
        connectorConnection.runtime.generation !== message.runtimeGeneration
      ) {
        return;
      }
      const snapshot = message.payload.snapshot;
      if (
        snapshot.active !==
          (connectorConnection.activeProviderId === snapshot.providerId &&
            connectorConnection.activeAccountId === snapshot.accountId) ||
        (snapshot.control === "remote_control" && !snapshot.active)
      ) {
        return;
      }
      const key = nativeSnapshotKey(snapshot.providerId, snapshot.accountId);
      const retained = providerAccountSnapshots.get(key);
      if (
        retained?.bootId === message.bootId &&
        snapshot.revision <= retained.snapshot.revision
      ) {
        return;
      }
      providerAccountSnapshots.set(key, {
        snapshot,
        bootId: message.bootId!,
      });
      broadcast(
        null,
        makeEnvelope("provider.account.capabilities.snapshot", { snapshot }),
      );
      refreshSelectedCapabilities();
      return;
    }

    if (message.type === "connector.sessions.native.page") {
      const request = pendingNativeSessionRequests.get(message.payload.requestId);
      pendingNativeSessionRequests.delete(message.payload.requestId);
      if (
        request === undefined ||
        request.providerId !== message.payload.page.providerId ||
        request.accountId !== message.payload.page.accountId ||
        connectorConnection?.socket !== socket ||
        connectorConnection.connectorId !== message.connectorId ||
        connectorConnection.bootId !== message.bootId ||
        connectorConnection.runtime.runtimeId !== message.runtimeId ||
        connectorConnection.runtime.generation !== message.runtimeGeneration
      ) {
        return;
      }
      nativeSessionEvidence.record(
        request,
        message.payload.page,
        {
          bootId: connectorConnection.bootId,
          runtimeId: connectorConnection.runtime.runtimeId,
          runtimeGeneration: connectorConnection.runtime.generation,
        },
      );
      if (request.socket.readyState === WebSocket.OPEN) {
        send(
          request.socket,
          makeEnvelope("sessions.native.page", {
            requestId: message.payload.requestId,
            page: message.payload.page,
          }),
        );
      }
      return;
    }

    if (message.type === "connector.turn.delta") {
      if (
        connectorConnection?.socket === socket &&
        connectorConnection.connectorId === message.connectorId &&
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
        connectorConnection?.socket === socket &&
        connectorConnection.connectorId === message.connectorId &&
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
      connectorConnection?.socket !== socket ||
      connectorConnection.connectorId !== source.connectorId
    ) {
      return;
    }

    if (
      message.type === "connector.provider.account.activated" ||
      message.type === "connector.provider.account.activation.rejected"
    ) {
      const result = await store.recordProviderAccountActivation(message, source);
      if (
        result !== undefined &&
        message.type === "connector.provider.account.activated" &&
        connectorConnection?.socket === socket
      ) {
        for (const [key, retained] of providerAccountSnapshots) {
          if (
            retained.snapshot.active &&
            (retained.snapshot.providerId !== message.payload.providerId ||
              retained.snapshot.accountId !== message.payload.accountId)
          ) {
            const inactive = ProviderAccountCapabilitySnapshotSchema.parse({
              ...retained.snapshot,
              control: "inventory_only",
              active: false,
              notice: "Another provider account is active",
            });
            providerAccountSnapshots.set(key, {
              ...retained,
              snapshot: inactive,
            });
            broadcast(
              null,
              makeEnvelope("provider.account.capabilities.snapshot", {
                snapshot: inactive,
              }),
            );
          }
        }
        connectorConnection.runtime = message.payload.runtime;
        connectorConnection.activeProviderId = message.payload.providerId;
        connectorConnection.activeAccountId = message.payload.accountId;
        lastRuntime = message.payload.runtime;
        broadcast(
          null,
          makeEnvelope("runtime.status", { runtime: message.payload.runtime }),
        );
      }
      acknowledge(socket, source.sourceEventId);
      if (result !== undefined) broadcast(null, result);
      refreshSelectedCapabilities();
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
        const safeMessage = {
          ...message,
          payload: {
            ...message.payload,
            message: publicConnectorError(message.payload.code),
            retryable: false,
          },
        } as typeof message;
        const events = await store.failConnectorCommand(safeMessage, source);
        if (events !== undefined) durableEvents.push(...events);
        break;
      }
      case "connector.command.completed": {
        const events = await store.completeConnectorCommand(message, source);
        if (events !== undefined) durableEvents.push(...events);
        break;
      }
      case "connector.session.prepared":
      case "connector.session.prepare.failed":
      case "connector.session.prepare.outcome_unknown": {
        const event = await store.recordSessionPreparation(message, source);
        if (event !== undefined) durableEvents.push(event);
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
          if (event !== undefined) {
            durableEvents.push(event);
            const activeConnection = connectorConnection;
            if (activeConnection?.socket === socket) {
              durableEvents.push(
                ...(await applyApprovalPolicy(
                  activeConnection,
                  message.payload.approval.approvalId,
                )),
              );
            }
          }
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
    liveSockets.set(socket, true);
    socket.on("pong", () => liveSockets.set(socket, true));
    send(
      socket,
      makeEnvelope("server.hello", { artifactAccessToken }),
    );
    if (lastRuntime !== undefined) {
      send(socket, makeEnvelope("runtime.status", { runtime: lastRuntime }));
    }
    if (providerFleetSnapshot !== undefined) {
      send(
        socket,
        makeEnvelope("providers.snapshot", { snapshot: providerFleetSnapshot }),
      );
    }
    for (const retained of providerAccountSnapshots.values()) {
      send(
        socket,
        makeEnvelope("provider.account.capabilities.snapshot", {
          snapshot: retained.snapshot,
        }),
      );
    }
    for (const retained of nativeSessionSnapshots.values()) {
      send(
        socket,
        makeEnvelope("sessions.native.snapshot", {
          snapshot: retained.snapshot,
        }),
      );
    }
    socket.on("message", (data) => {
      if (!withinRate(socket, options.browserMessagesPerSecond ?? 100, rateWindows)) {
        socket.close(1008, "Browser message rate exceeded");
        return;
      }
      const parsed = ClientEnvelopeSchema.safeParse(parseSocketData(data.toString()));
      if (!parsed.success) {
        send(
          socket,
          makeEnvelope("protocol.error", {
            error: protocolError("MESSAGE_INVALID", "Invalid client envelope."),
          }),
        );
        const violations = (protocolViolations.get(socket) ?? 0) + 1;
        protocolViolations.set(socket, violations);
        if (violations >= 3) {
          socket.close(1008, "Protocol violation budget exceeded");
        }
        return;
      }
      void handleClient(socket, parsed.data).catch((error) => {
        console.error(
          "Core client command failed:",
          redactSensitiveText(error instanceof Error ? error.message : error),
        );
        send(
          socket,
          makeEnvelope("protocol.error", {
            error: protocolError("CORE_STORAGE_FAILURE", "Core mutation failed."),
          }),
        );
      });
    });
    socket.on("close", () => {
      clients.delete(socket);
      liveSockets.delete(socket);
      for (const [requestId, request] of pendingNativeSessionRequests) {
        if (request.socket === socket) pendingNativeSessionRequests.delete(requestId);
      }
    });
  };

  const scheduleConnectorLoss = (connection: ConnectorConnection) => {
    if (closing) return;
    connectorLossTimer = setTimeout(() => {
      void (async () => {
        const revoked = await store.revokeLeasesForRuntime(connection.runtime);
        for (const snapshot of revoked) {
          publishLeaseSnapshot(snapshot.sessionId, snapshot);
        }
        const events = await store.markRuntimeLost(connection.runtime);
        for (const event of events) broadcastDurable(event);
        const activations =
          await store.markPendingProviderAccountActivationsOutcomeUnknown();
        for (const result of activations) broadcast(null, result);
        lastRuntime = { ...connection.runtime, status: "lost" };
        broadcast(null, makeEnvelope("runtime.status", { runtime: lastRuntime }));
      })();
    }, options.connectorLossGraceMs ?? 750);
  };

  if (lastRuntime !== undefined && store.activeSnapshots().length > 0) {
    connectorLossTimer = setTimeout(() => {
      const runtime = lastRuntime;
      if (runtime === undefined || connectorConnection !== undefined) return;
      void (async () => {
        const revoked = await store.revokeLeasesForRuntime(runtime);
        for (const snapshot of revoked) {
          publishLeaseSnapshot(snapshot.sessionId, snapshot);
        }
        const events = await store.markRuntimeLost(runtime);
        for (const event of events) broadcastDurable(event);
        lastRuntime = { ...runtime, status: "lost" };
        broadcast(null, makeEnvelope("runtime.status", { runtime: lastRuntime }));
      })();
    }, options.connectorLossGraceMs ?? 750);
  }

  const sweepApprovals = async () => {
    await store.sweepInputAttachments();
    const leaseSnapshots = await store.sweepApprovalLeases();
    for (const snapshot of leaseSnapshots) {
      publishLeaseSnapshot(snapshot.sessionId, snapshot);
    }
    const expired = await store.expireApprovals();
    for (const item of expired) {
      broadcastDurable(item.event);
      if (connectorConnection?.socket.readyState === WebSocket.OPEN) {
        sendConnector(
          connectorConnection.socket,
          makeEnvelope("connector.approval.resolve", {
            commandId: `expiry-${item.approval.approvalId}-${item.approval.revision}`,
            sessionId: item.approval.sessionId,
            turnId: item.approval.turnId,
            approvalId: item.approval.approvalId,
            providerCorrelationId: item.providerCorrelationId,
            runtimeId: item.approval.runtimeId,
            runtimeGeneration: item.approval.runtimeGeneration,
            decision: "declined",
          }),
        );
      } else {
        pendingExpiryDispatches.push(item);
      }
    }
  };
  await sweepApprovals();
  const approvalTimer = setInterval(
    () => void sweepApprovals().catch(() => undefined),
    options.approvalSweepMs ?? 250,
  );
  const heartbeatTimer = setInterval(() => {
    for (const [socket, alive] of liveSockets) {
      if (!alive) {
        socket.terminate();
        liveSockets.delete(socket);
        continue;
      }
      liveSockets.set(socket, false);
      socket.ping();
    }
  }, options.heartbeatIntervalMs ?? 30_000);

  const attachConnector = (socket: WebSocket) => {
    if (connector?.readyState === WebSocket.OPEN) connector.close(1012);
    connector = socket;
    let ingestTail: Promise<void> = Promise.resolve();
    liveSockets.set(socket, true);
    socket.on("pong", () => liveSockets.set(socket, true));
    socket.on("message", (data) => {
      if (!withinRate(
        socket,
        options.connectorMessagesPerSecond ?? 1_000,
        rateWindows,
      )) {
        socket.close(1008, "Connector message rate exceeded");
        return;
      }
      const parsed = ConnectorEnvelopeSchema.safeParse(parseSocketData(data.toString()));
      if (!parsed.success) {
        console.error("Core rejected an invalid Connector envelope");
        const violations = (protocolViolations.get(socket) ?? 0) + 1;
        protocolViolations.set(socket, violations);
        if (violations >= 3) {
          socket.close(1008, "Protocol violation budget exceeded");
        }
        return;
      }
      // WebSocket preserves frame order, so preserve that order across async
      // database ingestion too. Runtime-rotation evidence must be committed
      // before capability messages fenced by the new Runtime are evaluated.
      ingestTail = ingestTail
        .then(() => handleConnector(socket, parsed.data))
        .catch((error) => {
          console.error(
            "Core Connector ingest failed:",
            redactSensitiveText(error instanceof Error ? error.message : error),
          );
        });
    });
    socket.on("close", () => {
      liveSockets.delete(socket);
      if (connector !== socket) return;
      connector = undefined;
      const lost = connectorConnection;
      connectorConnection = undefined;
      if (closing) return;
      markProviderFleetStale();
      if (lost !== undefined) scheduleConnectorLoss(lost);
    });
  };

  httpServer.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== "/ws" && path !== "/connector") {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    if (path === "/connector") {
      const expectedProtocol = websocketCapability("connector", connectorToken);
      if (!hasCapability(request.headers["sec-websocket-protocol"], expectedProtocol)) {
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }
    } else {
      const origin = request.headers.origin;
      if (!isAllowedOrigin(origin, allowedBrowserOrigins) || origin === undefined) {
        rejectUpgrade(socket, 403, "Forbidden");
        return;
      }
      const header = request.headers["sec-websocket-protocol"];
      const legacyAccepted =
        legacyBrowserTokenEnabled &&
        hasCapability(header, websocketCapability("browser", browserToken));
      if (!legacyAccepted && !browserTickets.consume(header, origin)) {
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }
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
  // IPv6 literals must be bracketed to match the Origin header a browser sends.
  allowedBrowserOrigins.add(httpOrigin(host, address.port));
  if (host === "127.0.0.1") {
    allowedBrowserOrigins.add(`http://localhost:${address.port}`);
  }

  return {
    host,
    port: address.port,
    browserUrl: `${webSocketOrigin(host, address.port)}/ws`,
    connectorUrl: `${webSocketOrigin(host, address.port)}/connector`,
    dbPath,
    browserToken,
    connectorToken,
    async close() {
      closing = true;
      clearInterval(approvalTimer);
      clearInterval(heartbeatTimer);
      if (connectorLossTimer !== undefined) clearTimeout(connectorLossTimer);
      for (const client of clients.keys()) client.close();
      connector?.close();
      browserTickets.clear();
      socketServer.close();
      await new Promise<void>((resolveClose, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolveClose()));
      });
      await store.close();
    },
  };
}

function supportsTurnAttachments(
  attachments: readonly InputAttachment[],
  settings: SessionSettings | undefined,
  accountEvidence: ProviderAccountCapabilitySnapshot | undefined,
) {
  if (attachments.length === 0) return true;
  if (
    settings === undefined ||
    settings.accountId === null ||
    accountEvidence === undefined ||
    accountEvidence.providerId !== settings.providerId ||
    accountEvidence.accountId !== settings.accountId ||
    !accountEvidence.active ||
    accountEvidence.freshness !== "live" ||
    Date.parse(accountEvidence.staleAt) <= Date.now() ||
    accountEvidence.authentication !== "authenticated" ||
    accountEvidence.control !== "remote_control"
  ) {
    return false;
  }
  const hasCapability = (key: "text_input" | "image_input") =>
    accountEvidence.capabilities.some(
      (capability) => capability.key === key && capability.state === "supported",
    );
  const selectedModel =
    accountEvidence.models.find((model) => model.modelId === settings.model) ??
    accountEvidence.models.find((model) => model.isDefault);
  return attachments.every((attachment) => {
    if (attachment.kind === "text") return hasCapability("text_input");
    if (attachment.kind === "image") {
      return (
        hasCapability("image_input") &&
        selectedModel?.inputModalities.includes("image") === true
      );
    }
    return false;
  });
}

function hasCapability(header: string | undefined, expected: string) {
  if (header === undefined) return false;
  return header
    .split(",")
    .map((value) => value.trim())
    .some((value) => constantTimeEqual(value, expected));
}

function withinRate(
  socket: WebSocket,
  limit: number,
  windows: WeakMap<WebSocket, { startedAt: number; count: number }>,
) {
  const now = Date.now();
  let window = windows.get(socket);
  if (window === undefined || now - window.startedAt >= 1_000) {
    window = { startedAt: now, count: 0 };
    windows.set(socket, window);
  }
  window.count += 1;
  return window.count <= limit;
}

function publicConnectorError(code: string) {
  const messages: Record<string, string> = {
    IDEMPOTENCY_KEY_REUSE: "Connector command identity was reused.",
    STALE_RUNTIME_GENERATION: "Command belongs to an inactive runtime generation.",
    INTERRUPT_FAILED: "Provider interrupt delivery could not be confirmed.",
    APPROVAL_DELIVERY_FAILED: "Provider approval delivery could not be confirmed.",
  };
  return messages[code] ?? "Connector command failed.";
}

function nativeSnapshotKey(providerId: string, accountId: string) {
  return `${providerId}\u0000${accountId}`;
}

function validProviderAccountModel(
  account: ProviderAccountCapabilitySnapshot,
  modelId: string | null,
  reasoningLevel: string | null,
) {
  if (account.modelsState !== "available") return false;
  const model =
    modelId === null
      ? account.models.find((candidate) => candidate.isDefault) ??
        account.models[0]
      : account.models.find((candidate) => candidate.modelId === modelId);
  return (
    model !== undefined &&
    (reasoningLevel === null ||
      model.reasoningEfforts.some((option) => option.value === reasoningLevel))
  );
}

function validateSessionSettingsSelection(
  requested: SessionSettings,
  current: SessionSettings,
  snapshot: ProviderFleetSnapshot | undefined,
  accountEvidence: ProviderAccountCapabilitySnapshot | undefined,
  currentRuntime: Runtime | undefined,
  authority: ReturnType<CoreDatabase["sessionProviderAuthority"]>,
): { code: string; message: string } | undefined {
  if (
    snapshot === undefined ||
    !["live", "local"].includes(snapshot.freshness)
  ) {
    return {
      code: "PROVIDER_CAPABILITIES_UNAVAILABLE",
      message: "Current provider capabilities are unavailable.",
    };
  }
  const provider = snapshot.providers.find(
    (candidate) => candidate.providerId === requested.providerId,
  );
  const account = provider?.accounts.find((candidate) =>
    candidate.accountId === requested.accountId,
  );
  if (
    provider === undefined ||
    provider.freshness === "stale" ||
    requested.accountId === null ||
    account === undefined ||
    accountEvidence === undefined ||
    accountEvidence.providerId !== requested.providerId ||
    accountEvidence.accountId !== requested.accountId ||
    accountEvidence.freshness !== "live" ||
    Date.parse(accountEvidence.staleAt) <= Date.now() ||
    !accountEvidence.active ||
    accountEvidence.authentication !== "authenticated" ||
    accountEvidence.control !== "remote_control" ||
    currentRuntime === undefined ||
    authority === undefined ||
    authority.state !== "ready" ||
    authority.providerId !== requested.providerId ||
    authority.accountId !== requested.accountId ||
    authority.runtimeId !== currentRuntime.runtimeId ||
    authority.runtimeGeneration !== currentRuntime.generation
  ) {
    return {
      code: "PROVIDER_ACCOUNT_UNAVAILABLE",
      message: "The selected provider account is not currently controllable.",
    };
  }
  if (
    !validProviderAccountModel(
      accountEvidence,
      requested.model,
      requested.reasoningLevel,
    )
  ) {
    return {
      code: "PROVIDER_MODEL_UNAVAILABLE",
      message: "Selected model or reasoning level is unavailable.",
    };
  }
  if (
    requested.executionMode !== current.executionMode &&
    !accountEvidence.capabilities.some(
      (capability) =>
        capability.key === "execution_modes" &&
        capability.state === "supported",
    )
  ) {
    return {
      code: "EXECUTION_MODE_UNAVAILABLE",
      message: "This execution mode is not enabled by the current adapter.",
    };
  }
  if (
    requested.approvalPolicy !== current.approvalPolicy &&
    !accountEvidence.capabilities.some(
      (capability) =>
        capability.key === "approval_policies" &&
        capability.state === "supported",
    )
  ) {
    return {
      code: "APPROVAL_POLICY_UNAVAILABLE",
      message: "The provider adapter does not support normalized approval policies.",
    };
  }
  if (
    requested.sandboxPolicy !== current.sandboxPolicy &&
    !accountEvidence.capabilities.some(
      (capability) =>
        capability.key === "sandbox_policies" &&
        capability.state === "supported",
    )
  ) {
    return {
      code: "SANDBOX_POLICY_UNAVAILABLE",
      message: "The provider adapter does not support normalized sandbox policies.",
    };
  }
  if (
    requested.networkPolicy !== current.networkPolicy &&
    requested.networkPolicy !== "denied" &&
    !accountEvidence.capabilities.some(
      (capability) =>
        capability.key === "network_policies" &&
        capability.state === "supported",
    )
  ) {
    return {
      code: "NETWORK_POLICY_UNAVAILABLE",
      message: "The provider adapter has not verified the requested network policy.",
    };
  }
  if (
    ["workspace_auto", "full_auto_lease"].includes(requested.approvalPolicy) &&
    (requested.accountId === null ||
      requested.projectPath === null ||
      requested.sandboxPolicy !== "workspace_write")
  ) {
    return {
      code: "APPROVAL_POLICY_SCOPE_INVALID",
      message: "Workspace policies require an account, project, and workspace sandbox.",
    };
  }
  return undefined;
}

function validateTurnControlAuthority(
  settings: SessionSettings | undefined,
  authority: ReturnType<CoreDatabase["sessionProviderAuthority"]>,
  snapshot: ProviderFleetSnapshot | undefined,
  accountEvidence: ProviderAccountCapabilitySnapshot | undefined,
  currentRuntime: Runtime | undefined,
): { code: string; message: string } | undefined {
  if (
    settings === undefined ||
    authority === undefined ||
    authority.state !== "ready" ||
    settings.accountId === null ||
    settings.projectPath === null ||
    authority.providerId !== settings.providerId ||
    authority.accountId !== settings.accountId ||
    authority.providerSessionId === null ||
    currentRuntime === undefined ||
    authority.runtimeId !== currentRuntime.runtimeId ||
    authority.runtimeGeneration !== currentRuntime.generation
  ) {
    return {
      code: "SESSION_NOT_CONTROLLABLE",
      message: "Session has no ready, validated provider binding.",
    };
  }
  if (
    snapshot === undefined ||
    !["live", "local"].includes(snapshot.freshness)
  ) {
    return {
      code: "PROVIDER_CAPABILITIES_UNAVAILABLE",
      message: "Fresh provider capability evidence is required before a Turn.",
    };
  }
  const provider = snapshot.providers.find(
    (candidate) => candidate.providerId === settings.providerId,
  );
  const account = provider?.accounts.find(
    (candidate) => candidate.accountId === settings.accountId,
  );
  const requiredCapabilities = [
    "remote_control",
    "text_input",
    "execution_modes",
    "approval_policies",
    "sandbox_policies",
  ] as const;
  if (
    provider === undefined ||
    provider.freshness === "stale" ||
    account === undefined ||
    accountEvidence === undefined ||
    accountEvidence.providerId !== settings.providerId ||
    accountEvidence.accountId !== settings.accountId ||
    accountEvidence.freshness !== "live" ||
    Date.parse(accountEvidence.staleAt) <= Date.now() ||
    !accountEvidence.active ||
    accountEvidence.authentication !== "authenticated" ||
    accountEvidence.control !== "remote_control" ||
    requiredCapabilities.some(
      (key) =>
        !accountEvidence.capabilities.some(
          (capability) => capability.key === key && capability.state === "supported",
        ),
    )
  ) {
    return {
      code: "PROVIDER_CAPABILITY_UNAVAILABLE",
      message: "Selected provider/account is not currently controllable.",
    };
  }
  if (
    !validProviderAccountModel(
      accountEvidence,
      settings.model,
      settings.reasoningLevel,
    )
  ) {
    return {
      code: "PROVIDER_MODEL_UNAVAILABLE",
      message: "Selected model or reasoning level is unavailable.",
    };
  }
  if (
    settings.networkPolicy !== "denied" &&
    !accountEvidence.capabilities.some(
      (capability) =>
        capability.key === "network_policies" && capability.state === "supported",
    )
  ) {
    return {
      code: "NETWORK_POLICY_UNAVAILABLE",
      message: "The requested network policy is not supported.",
    };
  }
  return undefined;
}

function constantTimeEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function isAllowedOrigin(origin: string | undefined, allowed: ReadonlySet<string>) {
  return origin !== undefined && allowed.has(origin);
}

function hasRequestBody(
  contentLength: string | undefined,
  transferEncoding: string | undefined,
): boolean {
  if (transferEncoding !== undefined) return true;
  if (contentLength === undefined) return false;
  return contentLength !== "0";
}

function rejectUpgrade(
  socket: Duplex,
  status: 401 | 403 | 404,
  reason: string,
) {
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
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

function applyRuntimeConfigCors(origin: string, response: ServerResponse) {
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("access-control-allow-methods", "POST, OPTIONS");
  response.setHeader("cache-control", "no-store");
  response.setHeader("vary", "Origin");
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
