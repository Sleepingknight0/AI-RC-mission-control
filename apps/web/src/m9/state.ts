import {
  InputAttachmentMediaTypeSchema,
  SessionSettingsSnapshotSchema,
  type SessionSettingsSnapshot,
} from "@aicl/protocol";
import type {
  ApprovalLeaseSnapshot,
  InputAttachment,
  ProviderCapabilityKey,
  ProviderAccountCapabilitySnapshot,
  ProviderFleetSnapshot,
  ProviderNativeSession,
  ProviderNativeSessionPage,
  ProviderNativeSessionSnapshot,
  ProviderRecord,
  ServerEnvelope,
  SessionCapabilitiesSnapshot,
  SessionCatalogFilter,
  SessionSettings,
  SessionSummaryV2,
} from "@aicl/protocol";

type ExecutionMode = SessionSettings["executionMode"];
type ApprovalPolicy = SessionSettings["approvalPolicy"];
type InputAttachmentMediaType =
  (typeof InputAttachmentMediaTypeSchema)["_output"];

export type ResourceFreshness =
  | "loading"
  | "ready"
  | "stale"
  | "unavailable"
  | "error";

export interface CatalogState {
  status: ResourceFreshness;
  revision: number | null;
  sessions: SessionSummaryV2[];
  nextCursor: string | null;
  total: number;
  filters: SessionCatalogFilter;
  requestId: string | null;
  /** True while a cursor page request is in flight — snapshot should append. */
  pendingAppend: boolean;
  /**
   * Set when Core rejects a catalog cursor. App must request a fresh first page
   * and clear this flag after the request starts.
   */
  needsFreshPage: boolean;
  notice: string | null;
  error: string | null;
}

export interface FleetState {
  status: ResourceFreshness;
  snapshot: ProviderFleetSnapshot | null;
  error: string | null;
}

export interface NativeState {
  status: ResourceFreshness;
  snapshot: ProviderNativeSessionSnapshot | null;
  page: ProviderNativeSessionPage | null;
  sessions: ProviderNativeSession[];
  requestId: string | null;
  pendingAppend: boolean;
  needsFreshPage: boolean;
  error: string | null;
}

export interface AccountCapabilitiesUiState {
  status: ResourceFreshness;
  snapshots: Record<string, ProviderAccountCapabilitySnapshot>;
  error: string | null;
}

export interface SettingsUiState {
  status: ResourceFreshness;
  snapshot: SessionSettingsSnapshot | null;
  conflict: SessionSettingsSnapshot | null;
  error: string | null;
}

export interface LeaseUiState {
  status: ResourceFreshness;
  snapshot: ApprovalLeaseSnapshot | null;
  error: string | null;
}

export interface AttachmentUiState {
  status: ResourceFreshness;
  attachments: InputAttachment[];
  uploadProgress: Record<string, { received: number; total: number }>;
  error: string | null;
}

/** Authoritative selected-Session capability projection from Core. */
export interface SessionCapabilitiesUiState {
  status: ResourceFreshness;
  snapshot: SessionCapabilitiesSnapshot | null;
  error: string | null;
}

export interface PendingUploadBytes {
  bytes: Uint8Array;
  chunkCount: number;
  sessionId: string;
}

export function defaultCatalogFilters(): SessionCatalogFilter {
  return {
    search: null,
    providerIds: [],
    accountIds: [],
    states: [],
    project: null,
    archived: "exclude",
    pinned: null,
  };
}

export function initialCatalogState(): CatalogState {
  return {
    status: "loading",
    revision: null,
    sessions: [],
    nextCursor: null,
    total: 0,
    filters: defaultCatalogFilters(),
    requestId: null,
    pendingAppend: false,
    needsFreshPage: false,
    notice: null,
    error: null,
  };
}

/** Merge a cursor page into the existing list without duplicates. */
export function mergeCatalogPage(
  existing: SessionSummaryV2[],
  incoming: SessionSummaryV2[],
): SessionSummaryV2[] {
  if (existing.length === 0) return incoming;
  const seen = new Set(existing.map((session) => session.sessionId));
  const appended = incoming.filter((session) => !seen.has(session.sessionId));
  return appended.length === 0 ? existing : [...existing, ...appended];
}

export function initialFleetState(): FleetState {
  return { status: "loading", snapshot: null, error: null };
}

export function initialNativeState(): NativeState {
  return {
    status: "loading",
    snapshot: null,
    page: null,
    sessions: [],
    requestId: null,
    pendingAppend: false,
    needsFreshPage: false,
    error: null,
  };
}

export function initialAccountCapabilitiesState(): AccountCapabilitiesUiState {
  return { status: "loading", snapshots: {}, error: null };
}

export function initialSettingsState(): SettingsUiState {
  return { status: "loading", snapshot: null, conflict: null, error: null };
}

export function initialLeaseState(): LeaseUiState {
  return { status: "loading", snapshot: null, error: null };
}

export function initialAttachmentState(): AttachmentUiState {
  return {
    status: "loading",
    attachments: [],
    uploadProgress: {},
    error: null,
  };
}

export function initialSessionCapabilitiesState(): SessionCapabilitiesUiState {
  return { status: "loading", snapshot: null, error: null };
}

export function reduceFleet(
  current: FleetState,
  message: ServerEnvelope,
): FleetState {
  if (message.type === "providers.snapshot") {
    return {
      status: resourceStatus(message.payload.snapshot.freshness),
      snapshot: message.payload.snapshot,
      error: null,
    };
  }
  if (
    message.type === "protocol.error" &&
    message.payload.error.code === "PROVIDER_INVENTORY_UNAVAILABLE"
  ) {
    return {
      ...current,
      status: current.snapshot ? "stale" : "error",
      error: `${message.payload.error.code}: ${message.payload.error.message}`,
    };
  }
  return current;
}

function resourceStatus(freshness: ProviderFleetSnapshot["freshness"]): ResourceFreshness {
  if (freshness === "live" || freshness === "local") return "ready";
  if (freshness === "unavailable") return "unavailable";
  return "stale";
}

function isCatalogCursorError(code: string): boolean {
  return (
    code === "SESSION_CATALOG_CURSOR_INVALID" ||
    code === "SESSION_CATALOG_CURSOR_STALE"
  );
}

export function reduceCatalog(
  current: CatalogState,
  message: ServerEnvelope,
): CatalogState {
  if (message.type === "sessions.catalog.snapshot") {
    // Ignore late responses for superseded list requests.
    if (
      current.requestId !== null &&
      message.payload.requestId !== current.requestId
    ) {
      return current;
    }
    const append = current.pendingAppend;
    return {
      ...current,
      status: "ready",
      revision: message.payload.catalogRevision,
      sessions: append
        ? mergeCatalogPage(current.sessions, message.payload.sessions)
        : message.payload.sessions,
      nextCursor: message.payload.nextCursor,
      total: message.payload.total,
      requestId: message.payload.requestId,
      pendingAppend: false,
      needsFreshPage: false,
      notice: append ? current.notice : null,
      error: null,
    };
  }

  const errorCode =
    message.type === "protocol.error"
      ? message.payload.error.code
      : message.type === "command.rejected"
        ? message.payload.error.code
        : null;
  const errorMessage =
    message.type === "protocol.error"
      ? message.payload.error.message
      : message.type === "command.rejected"
        ? message.payload.error.message
        : null;

  if (errorCode !== null && isCatalogCursorError(errorCode)) {
    return {
      ...current,
      nextCursor: null,
      pendingAppend: false,
      needsFreshPage: true,
      notice:
        "Catalog refreshed because authority or visible catalog state changed. Requesting a fresh first page.",
      error: `${errorCode}: ${errorMessage}`,
      status: current.sessions.length > 0 ? "stale" : "error",
    };
  }

  if (message.type === "session.command.accepted") {
    return {
      ...current,
      sessions: current.sessions.map((session) =>
        session.sessionId === message.payload.sessionId
          ? { ...session, revision: message.payload.revision }
          : session,
      ),
    };
  }

  if (message.type === "session.provider.status") {
    const bindingChanged = current.sessions.some(
      (session) =>
        session.sessionId === message.payload.sessionId &&
        session.providerBindingStatus !== message.payload.status,
    );
    return {
      ...current,
      sessions: current.sessions.map((session) =>
        session.sessionId === message.payload.sessionId
          ? {
              ...session,
              providerBindingStatus: message.payload.status,
              providerSessionId: message.payload.providerSessionId,
              // Never invent control from binding alone — catalog/capabilities are authoritative.
              canControl:
                message.payload.status === "ready" ? session.canControl : false,
            }
          : session,
      ),
      nextCursor: bindingChanged ? null : current.nextCursor,
      pendingAppend: bindingChanged ? false : current.pendingAppend,
      needsFreshPage: bindingChanged || current.needsFreshPage,
    };
  }

  // Timeline / durable events must not invalidate valid catalog pagination.
  return current;
}

/** Mark a catalog list request as replace (first page) or append (cursor page). */
export function catalogRequestStarted(
  current: CatalogState,
  requestId: string,
  append: boolean,
  filters?: SessionCatalogFilter,
): CatalogState {
  return {
    ...current,
    status: append
      ? current.sessions.length > 0
        ? current.status
        : "loading"
      : current.sessions.length > 0
        ? "stale"
        : "loading",
    requestId,
    pendingAppend: append,
    needsFreshPage: false,
    filters: filters ?? current.filters,
    error: append ? current.error : null,
    notice: append ? current.notice : null,
  };
}

export function reduceNative(
  current: NativeState,
  message: ServerEnvelope,
  selectedProviderId: string | null,
  selectedAccountId: string | null,
): NativeState {
  if (message.type === "sessions.native.page") {
    const { page, requestId } = message.payload;
    if (
      selectedProviderId === null ||
      selectedAccountId === null ||
      page.providerId !== selectedProviderId ||
      page.accountId !== selectedAccountId ||
      (current.requestId !== null && current.requestId !== requestId)
    ) {
      return current;
    }
    const sessions = current.pendingAppend && !page.cursorReset
      ? mergeNativeSessions(current.sessions, page.sessions)
      : page.sessions;
    return {
      status: resourceStatus(page.freshness),
      snapshot: null,
      page,
      sessions,
      requestId,
      pendingAppend: false,
      needsFreshPage: false,
      error: null,
    };
  }
  if (message.type === "sessions.native.snapshot") {
    if (
      selectedProviderId === null ||
      selectedAccountId === null ||
      message.payload.snapshot.providerId !== selectedProviderId ||
      message.payload.snapshot.accountId !== selectedAccountId
    ) {
      return current;
    }
    return {
      status: resourceStatus(message.payload.snapshot.freshness),
      snapshot: message.payload.snapshot,
      page: null,
      sessions: message.payload.snapshot.sessions,
      requestId: null,
      pendingAppend: false,
      needsFreshPage: false,
      error: null,
    };
  }
  return current;
}

export function mergeNativeSessions(
  current: readonly ProviderNativeSession[],
  incoming: readonly ProviderNativeSession[],
): ProviderNativeSession[] {
  const byId = new Map(current.map((session) => [session.providerSessionId, session]));
  for (const session of incoming) byId.set(session.providerSessionId, session);
  return [...byId.values()];
}

export function nativeRequestStarted(
  current: NativeState,
  requestId: string,
  append: boolean,
): NativeState {
  return {
    ...current,
    status: append && current.sessions.length > 0 ? current.status : "loading",
    requestId,
    pendingAppend: append,
    needsFreshPage: false,
    error: append ? current.error : null,
  };
}

function accountCapabilityKey(providerId: string, accountId: string) {
  return `${providerId}\u0000${accountId}`;
}

export function reduceAccountCapabilities(
  current: AccountCapabilitiesUiState,
  message: ServerEnvelope,
): AccountCapabilitiesUiState {
  if (message.type !== "provider.account.capabilities.snapshot") return current;
  const snapshot = message.payload.snapshot;
  const key = accountCapabilityKey(snapshot.providerId, snapshot.accountId);
  const existing = current.snapshots[key];
  if (existing !== undefined && existing.revision > snapshot.revision) return current;
  return {
    status: resourceStatus(snapshot.freshness),
    snapshots: { ...current.snapshots, [key]: snapshot },
    error: null,
  };
}

export function accountCapabilitiesFor(
  current: AccountCapabilitiesUiState,
  providerId: string | null,
  accountId: string | null,
): ProviderAccountCapabilitySnapshot | null {
  if (providerId === null || accountId === null) return null;
  return current.snapshots[accountCapabilityKey(providerId, accountId)] ?? null;
}

export function reduceSettings(
  current: SettingsUiState,
  message: ServerEnvelope,
  selectedSessionId: string,
): SettingsUiState {
  if (message.type === "session.settings.snapshot") {
    if (message.payload.snapshot.sessionId !== selectedSessionId) return current;
    return {
      status: "ready",
      snapshot: message.payload.snapshot,
      conflict: null,
      error: null,
    };
  }
  if (
    message.type === "command.rejected" &&
    message.payload.error.code === "SESSION_SETTINGS_CONFLICT" &&
    message.payload.sessionId === selectedSessionId
  ) {
    const parsed = SessionSettingsSnapshotSchema.safeParse(
      message.payload.error.details?.snapshot,
    );
    const conflict =
      parsed.success && parsed.data.sessionId === selectedSessionId
        ? parsed.data
        : null;
    return {
      status: "error",
      snapshot: conflict ?? current.snapshot,
      conflict,
      error: `${message.payload.error.code}: ${message.payload.error.message}`,
    };
  }
  if (
    message.type === "command.rejected" &&
    message.payload.sessionId === selectedSessionId &&
    (message.payload.error.code.startsWith("SESSION_SETTING") ||
      message.payload.error.code === "SESSION_BUSY")
  ) {
    return {
      ...current,
      error: `${message.payload.error.code}: ${message.payload.error.message}`,
    };
  }
  return current;
}

export function reduceSessionCapabilities(
  current: SessionCapabilitiesUiState,
  message: ServerEnvelope,
  selectedSessionId: string,
): SessionCapabilitiesUiState {
  if (message.type === "session.capabilities.snapshot") {
    if (message.payload.snapshot.sessionId !== selectedSessionId) {
      return current;
    }
    const freshness = message.payload.snapshot.freshness;
    const status: ResourceFreshness =
      freshness === "stale" || freshness === "offline"
        ? "stale"
        : freshness === "unavailable"
          ? "unavailable"
          : "ready";
    return {
      status,
      snapshot: message.payload.snapshot,
      error: null,
    };
  }
  return current;
}

export function reduceLease(
  current: LeaseUiState,
  message: ServerEnvelope,
  selectedSessionId: string,
): LeaseUiState {
  if (message.type === "approval.lease.snapshot") {
    if (message.payload.snapshot.sessionId !== selectedSessionId) return current;
    return {
      status: "ready",
      snapshot: message.payload.snapshot,
      error: null,
    };
  }
  return current;
}

export function reduceAttachments(
  current: AttachmentUiState,
  message: ServerEnvelope,
  selectedSessionId: string,
): AttachmentUiState {
  if (
    message.type === "attachments.snapshot" &&
    message.payload.sessionId === selectedSessionId
  ) {
    return {
      status: "ready",
      attachments: message.payload.attachments,
      uploadProgress: {},
      error: null,
    };
  }
  if (
    message.type === "attachment.command.accepted" &&
    message.payload.sessionId === selectedSessionId
  ) {
    const attachment = message.payload.attachment;
    const exists = current.attachments.some(
      (item) => item.attachmentId === attachment.attachmentId,
    );
    return {
      ...current,
      status: "ready",
      attachments: exists
        ? current.attachments.map((item) =>
            item.attachmentId === attachment.attachmentId ? attachment : item,
          )
        : [...current.attachments, attachment],
      error: attachment.status === "rejected" ? "Attachment rejected by Core" : null,
    };
  }
  if (
    message.type === "attachment.upload.progress" &&
    message.payload.sessionId === selectedSessionId
  ) {
    return {
      ...current,
      uploadProgress: {
        ...current.uploadProgress,
        [message.payload.attachmentId]: {
          received: message.payload.receivedChunks,
          total: message.payload.chunkCount,
        },
      },
    };
  }
  if (
    message.type === "command.rejected" &&
    message.payload.sessionId === selectedSessionId &&
    message.payload.error.code.startsWith("ATTACHMENT_")
  ) {
    return {
      ...current,
      error: `${message.payload.error.code}: ${message.payload.error.message}`,
    };
  }
  return current;
}

/** Fleet helpers — inventory / create only; not selected-Session control. */
export function capabilityOf(
  provider: ProviderRecord | null | undefined,
  key: ProviderCapabilityKey,
) {
  return provider?.capabilities.find((item) => item.key === key) ?? null;
}

export function capabilitySupported(
  provider: ProviderRecord | null | undefined,
  key: ProviderCapabilityKey,
): { ok: boolean; reason: string | null } {
  if (!provider) {
    return { ok: false, reason: "Provider inventory unavailable" };
  }
  if (provider.freshness !== "live" && provider.freshness !== "local") {
    return {
      ok: false,
      reason: `Provider evidence is ${provider.freshness}`,
    };
  }
  if (provider.adapterSupport === "inventory_only" && key === "remote_control") {
    return {
      ok: false,
      reason: "Inventory-only provider cannot be controlled remotely",
    };
  }
  const evidence = capabilityOf(provider, key);
  if (!evidence) {
    return { ok: false, reason: `No evidence for ${key}` };
  }
  if (evidence.state !== "supported") {
    return {
      ok: false,
      reason: evidence.reason ?? `${key} is ${evidence.state}`,
    };
  }
  return { ok: true, reason: null };
}

export function controllableProviders(fleet: ProviderFleetSnapshot | null) {
  if (!fleet) return [];
  return fleet.providers.filter((provider) => {
    if (!provider.enabled) return false;
    if (provider.installation !== "installed") return false;
    if (provider.adapterSupport !== "remote_control") return false;
    if (provider.freshness !== "live" && provider.freshness !== "local") {
      return false;
    }
    return capabilitySupported(provider, "remote_control").ok;
  });
}

export function sessionSupportRow(
  snapshot: SessionCapabilitiesSnapshot | null | undefined,
  kind:
    | { type: "execution"; mode: ExecutionMode }
    | { type: "attachment"; kind: "text" | "image" }
    | { type: "approval"; policy: ApprovalPolicy }
    | { type: "lease" }
    | { type: "model" }
    | { type: "provider" }
    | { type: "account" }
    | { type: "sandbox" }
    | { type: "network" }
    | { type: "control" },
): { ok: boolean; reason: string | null } {
  if (!snapshot) {
    return { ok: false, reason: "Session capability projection unavailable" };
  }
  if (
    snapshot.freshness === "stale" ||
    snapshot.freshness === "offline" ||
    snapshot.freshness === "unavailable"
  ) {
    return {
      ok: false,
      reason:
        snapshot.controlAuthority.reason ??
        `Session capability evidence is ${snapshot.freshness}`,
    };
  }

  const row =
    kind.type === "execution"
      ? snapshot.executionModes.find((item) => item.mode === kind.mode)
      : kind.type === "attachment"
        ? snapshot.attachments.find((item) => item.kind === kind.kind)
        : kind.type === "approval"
          ? snapshot.approvalPolicies.find((item) => item.policy === kind.policy)
          : kind.type === "lease"
            ? snapshot.fullAutoLease
            : kind.type === "model"
              ? snapshot.model
              : kind.type === "provider"
                ? snapshot.provider
              : kind.type === "account"
                ? snapshot.account
                : null;

  if (kind.type === "control") {
    if (!snapshot.controlAuthority.canControl) {
      return {
        ok: false,
        reason:
          snapshot.controlAuthority.reason ??
          `Session not controllable (${snapshot.controlAuthority.bindingStatus})`,
      };
    }
    return { ok: true, reason: null };
  }

  if (!row) {
    return { ok: false, reason: "Capability row missing from projection" };
  }
  if (row.state !== "supported") {
    return {
      ok: false,
      reason: row.reason ?? `${kind.type} is ${row.state}`,
    };
  }
  return { ok: true, reason: null };
}

/**
 * Authoritative control decision for the selected Session.
 * Catalog canControl and Session capability projection must both allow;
 * never elevate from fleet-level remote_control alone.
 */
export function sessionCanControl(input: {
  catalogEntry: SessionSummaryV2 | null;
  capabilities: SessionCapabilitiesSnapshot | null;
  settingsRevision: number | null;
  fleetStale?: boolean;
}): { ok: boolean; reason: string | null } {
  const { catalogEntry, capabilities, settingsRevision, fleetStale = false } = input;

  if (fleetStale) {
    return {
      ok: false,
      reason: "Provider inventory is stale; control authority withdrawn",
    };
  }

  if (!catalogEntry) {
    return {
      ok: false,
      reason: "Authoritative Catalog entry unavailable",
    };
  }
  if (!capabilities) {
    return {
      ok: false,
      reason: "Session capability projection unavailable",
    };
  }
  if (capabilities.sessionId !== catalogEntry.sessionId) {
    return {
      ok: false,
      reason: "Session capability projection belongs to another Session",
    };
  }
  if (
    settingsRevision === null ||
    capabilities.settingsRevision !== settingsRevision
  ) {
    return {
      ok: false,
      reason: "Session capability projection does not match current settings",
    };
  }

  const control = sessionSupportRow(capabilities, { type: "control" });
  if (!control.ok) return control;

  // Catalog is computed with the same exact validator as Turn submit.
  if (!catalogEntry.canControl) {
    return {
      ok: false,
      reason:
        capabilities.controlAuthority.reason ??
        "Catalog marks this Session as non-controllable",
    };
  }

  if (
    catalogEntry.providerBindingStatus === "pending" ||
      catalogEntry.providerBindingStatus === "failed" ||
      catalogEntry.providerBindingStatus === "outcome_unknown" ||
      catalogEntry.providerBindingStatus === "unbound"
  ) {
    return {
      ok: false,
      reason: `Provider binding is ${catalogEntry.providerBindingStatus}`,
    };
  }

  return { ok: true, reason: null };
}

export function activeLease(snapshot: ApprovalLeaseSnapshot | null) {
  if (!snapshot) return null;
  return snapshot.leases.find((lease) => lease.state === "active") ?? null;
}

export function leaseRemainingMs(
  snapshot: ApprovalLeaseSnapshot | null,
  nowMs: number,
) {
  const lease = activeLease(snapshot);
  if (!lease) return null;
  return Math.max(0, Date.parse(lease.expiresAt) - nowMs);
}

export function basenameOnly(fileName: string) {
  const normalized = fileName.replaceAll("\\", "/");
  const base = normalized.split("/").pop() ?? fileName;
  return base === "." || base === ".." ? "" : base;
}

export function attachmentKindForMediaType(
  mediaType: InputAttachmentMediaType,
): "text" | "image" | "document" | "archive" {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType === "text/plain" || mediaType === "text/markdown") return "text";
  if (mediaType === "application/pdf") return "document";
  return "archive";
}

export function parseInputAttachmentMediaType(
  mediaType: string,
): InputAttachmentMediaType | null {
  const parsed = InputAttachmentMediaTypeSchema.safeParse(mediaType);
  return parsed.success ? parsed.data : null;
}

/**
 * Count attachment slots consumed toward the per-Turn limit without
 * double-counting selected-ready IDs that are already in the attachment list.
 * In-flight begin commands (not yet accepted) also consume slots.
 */
export function countAttachmentSlots(
  attachments: InputAttachment[],
  selectedAttachmentIds: string[],
  inFlightBeginCount: number,
): number {
  const consumingIds = new Set(
    attachments
      .filter((item) => item.status === "uploading")
      .map((item) => item.attachmentId),
  );
  const selected = new Set(selectedAttachmentIds);
  for (const attachment of attachments) {
    if (selected.has(attachment.attachmentId) && attachment.status === "ready") {
      consumingIds.add(attachment.attachmentId);
    }
  }
  return consumingIds.size + Math.max(0, inFlightBeginCount);
}

export function remainingAttachmentSlots(
  attachments: InputAttachment[],
  selectedAttachmentIds: string[],
  inFlightBeginCount: number,
  maxPerTurn: number,
): number {
  return Math.max(
    0,
    maxPerTurn -
      countAttachmentSlots(attachments, selectedAttachmentIds, inFlightBeginCount),
  );
}

/** Extract pending upload bytes by commandId (authoritative correlation). */
export function takePendingUploadByCommand(
  pending: Map<string, PendingUploadBytes>,
  commandId: string,
  sessionId: string,
): PendingUploadBytes | null {
  const value = pending.get(commandId);
  if (!value) return null;
  if (value.sessionId !== sessionId) return null;
  pending.delete(commandId);
  return value;
}

/** Detect database / migration maintenance from Core protocol notices. */
export function isMaintenanceProtocolError(code: string): boolean {
  return (
    code.startsWith("MIGRATION_") ||
    code.startsWith("DATABASE_") ||
    code.startsWith("CORE_SCHEMA_") ||
    code.startsWith("CONNECTOR_SCHEMA_")
  );
}

export function maintenanceOperatorMessage(code: string, detail: string): string {
  return [
    "Application database requires maintenance.",
    "Automated Session control is unavailable until maintenance completes.",
    "Do not delete or overwrite the database.",
    "Use the documented backup / verify / migrate or restore workflow.",
    `Diagnostic: ${code}${detail ? ` — ${detail}` : ""}`,
  ].join(" ");
}

export const FILTER_DEBOUNCE_MS = 250;
