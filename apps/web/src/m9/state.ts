import type {
  ApprovalLeaseSnapshot,
  InputAttachment,
  ProviderCapabilityKey,
  ProviderFleetSnapshot,
  ProviderNativeSessionSnapshot,
  ProviderRecord,
  ServerEnvelope,
  SessionCatalogFilter,
  SessionSettingsSnapshot,
  SessionSummaryV2,
} from "@aicl/protocol";

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
  return { status: "loading", snapshot: null, error: null };
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

export function reduceFleet(
  current: FleetState,
  message: ServerEnvelope,
): FleetState {
  if (message.type === "providers.snapshot") {
    return {
      status: message.payload.snapshot.freshness === "stale" ? "stale" : "ready",
      snapshot: message.payload.snapshot,
      error: null,
    };
  }
  if (message.type === "command.rejected" && message.payload.error.code.startsWith("PROVIDER_")) {
    return {
      ...current,
      status: current.snapshot ? "stale" : "error",
      error: `${message.payload.error.code}: ${message.payload.error.message}`,
    };
  }
  return current;
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
      error: null,
    };
  }
  if (
    message.type === "command.rejected" &&
    (message.payload.error.code.startsWith("SESSION_CATALOG_") ||
      message.payload.error.code.startsWith("SESSION_"))
  ) {
    const code = message.payload.error.code;
    if (
      code === "SESSION_CATALOG_CURSOR_INVALID" ||
      code === "SESSION_CATALOG_CURSOR_STALE"
    ) {
      return {
        ...current,
        nextCursor: null,
        pendingAppend: false,
        error: `${code}: ${message.payload.error.message}`,
        status: current.sessions.length > 0 ? "stale" : "error",
      };
    }
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
    return {
      ...current,
      sessions: current.sessions.map((session) =>
        session.sessionId === message.payload.sessionId
          ? {
              ...session,
              providerBindingStatus: message.payload.status,
              providerSessionId: message.payload.providerSessionId,
              canControl:
                message.payload.status === "ready" ? session.canControl : false,
            }
          : session,
      ),
    };
  }
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
    filters: filters ?? current.filters,
    error: append ? current.error : null,
  };
}

export function reduceNative(
  current: NativeState,
  message: ServerEnvelope,
): NativeState {
  if (message.type === "sessions.native.snapshot") {
    return {
      status: message.payload.snapshot.freshness === "stale" ? "stale" : "ready",
      snapshot: message.payload.snapshot,
      error: null,
    };
  }
  return current;
}

export function reduceSettings(
  current: SettingsUiState,
  message: ServerEnvelope,
): SettingsUiState {
  if (message.type === "session.settings.snapshot") {
    return {
      status: "ready",
      snapshot: message.payload.snapshot,
      conflict: null,
      error: null,
    };
  }
  if (
    message.type === "command.rejected" &&
    message.payload.error.code === "SESSION_SETTINGS_CONFLICT"
  ) {
    const details = message.payload.error.details as
      | { snapshot?: SessionSettingsSnapshot }
      | undefined;
    return {
      status: "error",
      snapshot: details?.snapshot ?? current.snapshot,
      conflict: details?.snapshot ?? current.snapshot,
      error: `${message.payload.error.code}: ${message.payload.error.message}`,
    };
  }
  if (
    message.type === "command.rejected" &&
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

export function reduceLease(
  current: LeaseUiState,
  message: ServerEnvelope,
): LeaseUiState {
  if (message.type === "approval.lease.snapshot") {
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
      error: attachment.status === "rejected" ? "Attachment rejected" : null,
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
    message.payload.error.code.startsWith("ATTACHMENT_")
  ) {
    return {
      ...current,
      error: `${message.payload.error.code}: ${message.payload.error.message}`,
    };
  }
  return current;
}

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
  if (provider.freshness === "stale" || provider.freshness === "offline") {
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
    return capabilitySupported(provider, "remote_control").ok;
  });
}

export function activeLease(snapshot: ApprovalLeaseSnapshot | null) {
  if (!snapshot) return null;
  return (
    snapshot.leases.find((lease) => lease.state === "active") ?? null
  );
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
  mediaType: string,
): "text" | "image" | "document" | "archive" {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType === "text/plain" || mediaType === "text/markdown") return "text";
  if (mediaType === "application/pdf") return "document";
  return "archive";
}
