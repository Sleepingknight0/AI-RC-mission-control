import type {
  ProviderFleetSnapshot,
  ProviderRecord,
  SessionCapabilitiesSnapshot,
  SessionSummaryV2,
} from "@aicl/protocol";
import { makeEnvelope } from "@aicl/protocol";
import { describe, expect, it } from "vitest";

import {
  activeLease,
  attachmentKindForMediaType,
  basenameOnly,
  capabilitySupported,
  catalogRequestStarted,
  controllableProviders,
  countAttachmentSlots,
  defaultCatalogFilters,
  initialAttachmentState,
  initialCatalogState,
  initialFleetState,
  initialLeaseState,
  initialNativeState,
  initialSessionCapabilitiesState,
  initialSettingsState,
  isMaintenanceProtocolError,
  maintenanceOperatorMessage,
  mergeCatalogPage,
  parseInputAttachmentMediaType,
  reduceAttachments,
  reduceCatalog,
  reduceFleet,
  reduceLease,
  reduceNative,
  reduceSessionCapabilities,
  reduceSettings,
  remainingAttachmentSlots,
  sessionCanControl,
  sessionSupportRow,
  takePendingUploadByCommand,
  type PendingUploadBytes,
} from "../src/m9/state.js";

const baseProvider = (overrides: Partial<ProviderRecord> = {}): ProviderRecord => ({
  providerId: "codex",
  displayName: "Codex",
  enabled: true,
  installation: "installed",
  authentication: "authenticated",
  compatibility: "compatible",
  adapterSupport: "remote_control",
  version: "0.146.0",
  freshness: "live",
  observedAt: "2026-08-03T00:00:00.000Z",
  notice: null,
  capabilities: [
    {
      key: "remote_control",
      state: "supported",
      provenance: "adapter_manifest",
      observedAt: "2026-08-03T00:00:00.000Z",
      reason: null,
    },
    {
      key: "create_session",
      state: "supported",
      provenance: "adapter_manifest",
      observedAt: "2026-08-03T00:00:00.000Z",
      reason: null,
    },
  ],
  accounts: [
    {
      accountId: "default",
      displayName: "Default",
      isDefault: true,
      authentication: "authenticated",
      control: "remote_control",
      observedAt: "2026-08-03T00:00:00.000Z",
      notice: null,
    },
  ],
  accountCount: 1,
  models: [],
  modelsState: "unavailable",
  usageState: "not_supported",
  usageMeters: [],
  ...overrides,
});

const fleet = (providers: ProviderRecord[]): ProviderFleetSnapshot => ({
  snapshotId: "snap-1",
  revision: 1,
  source: "terminal_registry",
  observedAt: "2026-08-03T00:00:00.000Z",
  staleAt: "2026-08-03T00:05:00.000Z",
  freshness: "live",
  degraded: false,
  providers,
  notice: null,
});

const seed = (id: string, title = id, canControl = true): SessionSummaryV2 => ({
  sessionId: id,
  title,
  providerId: "codex",
  accountId: "default",
  providerSessionId: null,
  source: "aicl",
  providerBindingStatus: "ready",
  projectPath: "C:\\proj",
  projectName: "proj",
  branch: null,
  model: null,
  reasoningLevel: null,
  executionMode: "ask",
  approvalPolicy: "review",
  sandboxPolicy: "read_only",
  networkPolicy: "denied",
  state: "idle",
  runtimeStatus: "ready",
  activeTurnId: null,
  pendingApprovalCount: 0,
  turnCount: 0,
  unreadCount: 0,
  lastActivityAt: "2026-08-03T00:00:00.000Z",
  lastEventSeq: 0,
  canResume: false,
  canControl,
  pinned: false,
  archived: false,
  revision: 1,
  settingsRevision: 1,
});

const support = (
  state: "supported" | "unsupported" | "unknown" = "supported",
  reason: string | null = null,
) => ({ state, reason });

const caps = (
  overrides: Partial<SessionCapabilitiesSnapshot> = {},
): SessionCapabilitiesSnapshot => ({
  sessionId: "session-1",
  settingsRevision: 3,
  observedAt: "2026-08-03T00:00:00.000Z",
  freshness: "live",
  provider: { ...support(), providerId: "codex" },
  account: { ...support(), accountId: "default" },
  model: { ...support(), modelId: "gpt-5" },
  controlAuthority: {
    canControl: true,
    bindingStatus: "ready",
    reason: null,
  },
  executionModes: [
    { mode: "ask", ...support() },
    { mode: "plan", ...support() },
    { mode: "auto", ...support("unsupported", "auto not advertised") },
  ],
  attachments: [
    { kind: "text", ...support() },
    { kind: "image", ...support("unsupported", "image input unavailable") },
  ],
  approvalPolicies: [
    { policy: "review", ...support() },
    { policy: "balanced", ...support() },
    { policy: "workspace_auto", ...support() },
    {
      policy: "full_auto_lease",
      ...support("unsupported", "lease unavailable"),
    },
  ],
  fullAutoLease: support("unsupported", "lease unavailable"),
  ...overrides,
});

describe("m9 state helpers", () => {
  it("accepts providers.snapshot as authoritative fleet state", () => {
    const next = reduceFleet(
      initialFleetState(),
      makeEnvelope("providers.snapshot", { snapshot: fleet([baseProvider()]) }),
    );
    expect(next.status).toBe("ready");
    expect(next.snapshot?.providers).toHaveLength(1);
  });

  it("marks inventory-only and stale providers as non-controllable", () => {
    const inventoryOnly = baseProvider({
      providerId: "claude",
      displayName: "Claude",
      adapterSupport: "inventory_only",
      capabilities: [
        {
          key: "inventory",
          state: "supported",
          provenance: "terminal_registry",
          observedAt: "2026-08-03T00:00:00.000Z",
          reason: null,
        },
      ],
    });
    expect(controllableProviders(fleet([inventoryOnly]))).toEqual([]);
    expect(capabilitySupported(inventoryOnly, "remote_control").ok).toBe(false);

    const stale = baseProvider({ freshness: "stale" });
    expect(controllableProviders(fleet([stale]))).toEqual([]);
    expect(capabilitySupported(stale, "remote_control").ok).toBe(false);
  });

  it("reduces session.capabilities.snapshot and fail-closes on stale/unknown", () => {
    const ready = reduceSessionCapabilities(
      initialSessionCapabilitiesState(),
      makeEnvelope("session.capabilities.snapshot", { snapshot: caps() }),
      "session-1",
    );
    expect(ready.status).toBe("ready");
    expect(sessionSupportRow(ready.snapshot, { type: "control" }).ok).toBe(true);
    expect(
      sessionSupportRow(ready.snapshot, { type: "execution", mode: "auto" }).ok,
    ).toBe(false);
    expect(
      sessionSupportRow(ready.snapshot, { type: "attachment", kind: "image" }).reason,
    ).toMatch(/image/i);
    expect(sessionSupportRow(ready.snapshot, { type: "sandbox" }).ok).toBe(false);
    expect(sessionSupportRow(ready.snapshot, { type: "network" }).ok).toBe(false);

    const stale = reduceSessionCapabilities(
      ready,
      makeEnvelope("session.capabilities.snapshot", {
        snapshot: caps({
          freshness: "stale",
          controlAuthority: {
            canControl: false,
            bindingStatus: "ready",
            reason: "Provider inventory is stale",
          },
        }),
      }),
      "session-1",
    );
    expect(stale.status).toBe("stale");
    expect(sessionSupportRow(stale.snapshot, { type: "control" }).ok).toBe(false);

    const ignored = reduceSessionCapabilities(
      ready,
      makeEnvelope("session.capabilities.snapshot", {
        snapshot: caps({ sessionId: "other" }),
      }),
      "session-1",
    );
    expect(ignored.snapshot?.sessionId).toBe("session-1");
  });

  it("lets Session capability denial override fleet remote_control support", () => {
    const entry = seed("session-1", "Demo", false);
    const denied = caps({
      controlAuthority: {
        canControl: false,
        bindingStatus: "ready",
        reason: "Selected model removed from inventory",
      },
    });
    const decision = sessionCanControl({
      catalogEntry: entry,
      capabilities: denied,
      settingsRevision: 3,
      fleetStale: false,
    });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/model/i);

    const fleetOkButStale = sessionCanControl({
      catalogEntry: seed("session-1", "Demo", true),
      capabilities: caps(),
      settingsRevision: 3,
      fleetStale: true,
    });
    expect(fleetOkButStale.ok).toBe(false);

    expect(
      sessionCanControl({
        catalogEntry: seed("session-1", "Demo", true),
        capabilities: null,
        settingsRevision: 3,
      }).ok,
    ).toBe(false);
    expect(
      sessionCanControl({
        catalogEntry: null,
        capabilities: caps(),
        settingsRevision: 3,
      }).ok,
    ).toBe(false);
  });

  it("treats unavailable provider evidence as non-controllable", () => {
    const unavailable = baseProvider({ freshness: "unavailable" });
    expect(capabilitySupported(unavailable, "remote_control").ok).toBe(false);
    expect(controllableProviders(fleet([unavailable]))).toEqual([]);
    expect(
      reduceFleet(
        initialFleetState(),
        makeEnvelope("providers.snapshot", {
          snapshot: {
            ...fleet([unavailable]),
            freshness: "unavailable" as const,
          },
        }),
      ).status,
    ).toBe("unavailable");
  });

  it("uses exact Catalog canControl and binding status", () => {
    const unbound = sessionCanControl({
      catalogEntry: {
        ...seed("session-1"),
        canControl: false,
        providerBindingStatus: "unbound",
      },
      capabilities: null,
      settingsRevision: 1,
    });
    expect(unbound.ok).toBe(false);

    const pending = sessionCanControl({
      catalogEntry: {
        ...seed("session-1", "Demo", true),
        providerBindingStatus: "pending",
      },
      capabilities: caps(),
      settingsRevision: 3,
    });
    expect(pending.ok).toBe(false);
    expect(pending.reason).toMatch(/pending/);

    expect(
      sessionCanControl({
        catalogEntry: seed("session-1", "Demo", true),
        capabilities: caps({ sessionId: "other" }),
        settingsRevision: 3,
      }).ok,
    ).toBe(false);
    expect(
      sessionCanControl({
        catalogEntry: seed("session-1", "Demo", true),
        capabilities: caps(),
        settingsRevision: 99,
      }).ok,
    ).toBe(false);
  });

  it("recovers catalog cursor with fresh-page flag and ignores late requestIds", () => {
    const first = reduceCatalog(
      catalogRequestStarted(initialCatalogState(), "req-a", false),
      makeEnvelope("sessions.catalog.snapshot", {
        requestId: "req-a",
        catalogRevision: 1,
        generatedAt: "2026-08-03T00:00:00.000Z",
        sessions: [seed("s1")],
        nextCursor: "c1",
        total: 2,
      }),
    );
    expect(first.nextCursor).toBe("c1");

    const pending = catalogRequestStarted(first, "req-b", true);
    const staleCursor = reduceCatalog(
      pending,
      makeEnvelope("protocol.error", {
        error: {
          code: "SESSION_CATALOG_CURSOR_STALE",
          message: "Session catalog changed; request a fresh first page.",
          retryable: true,
        },
      }),
    );
    expect(staleCursor.nextCursor).toBeNull();
    expect(staleCursor.needsFreshPage).toBe(true);
    expect(staleCursor.pendingAppend).toBe(false);
    expect(staleCursor.notice).toMatch(/fresh first page/i);
    // Existing page rows retained until fresh replace arrives.
    expect(staleCursor.sessions).toHaveLength(1);

    const recovered = reduceCatalog(
      catalogRequestStarted(staleCursor, "req-c", false),
      makeEnvelope("sessions.catalog.snapshot", {
        requestId: "req-c",
        catalogRevision: 2,
        generatedAt: "2026-08-03T00:00:02.000Z",
        sessions: [seed("s1"), seed("s2")],
        nextCursor: null,
        total: 2,
      }),
    );
    expect(recovered.needsFreshPage).toBe(false);
    expect(recovered.sessions).toHaveLength(2);

    const late = reduceCatalog(
      catalogRequestStarted(recovered, "req-d", false),
      makeEnvelope("sessions.catalog.snapshot", {
        requestId: "req-old",
        catalogRevision: 1,
        generatedAt: "2026-08-03T00:00:01.000Z",
        sessions: [seed("stale")],
        nextCursor: null,
        total: 1,
      }),
    );
    expect(late.sessions.map((s) => s.sessionId)).toEqual(["s1", "s2"]);
  });

  it("does not invalidate pagination from ordinary timeline activity envelopes", () => {
    const loaded = reduceCatalog(
      catalogRequestStarted(initialCatalogState(), "req-1", false),
      makeEnvelope("sessions.catalog.snapshot", {
        requestId: "req-1",
        catalogRevision: 5,
        generatedAt: "2026-08-03T00:00:00.000Z",
        sessions: [seed("s1")],
        nextCursor: "cursor-next",
        total: 10,
      }),
    );
    // Ordinary non-catalog envelopes must not mutate catalog pagination.
    const afterActivity = reduceCatalog(
      loaded,
      makeEnvelope("runtime.status", {
        runtime: {
          runtimeId: "rt-1",
          generation: 1,
          status: "ready" as const,
        },
      }),
    );
    expect(afterActivity.nextCursor).toBe("cursor-next");
    expect(afterActivity.needsFreshPage).toBe(false);
    expect(afterActivity.revision).toBe(5);
  });

  it("requests an authoritative first Catalog page when provider binding becomes ready", () => {
    const loaded = reduceCatalog(
      catalogRequestStarted(initialCatalogState(), "req-binding", false),
      makeEnvelope("sessions.catalog.snapshot", {
        requestId: "req-binding",
        catalogRevision: 5,
        generatedAt: "2026-08-03T00:00:00.000Z",
        sessions: [
          {
            ...seed("session-1", "New Session", false),
            providerBindingStatus: "pending" as const,
          },
        ],
        nextCursor: "cursor-next",
        total: 2,
      }),
    );

    const bindingReady = reduceCatalog(
      loaded,
      makeEnvelope("session.provider.status", {
        commandId: "create-session-1",
        sessionId: "session-1",
        providerId: "codex",
        accountId: "default",
        providerSessionId: "provider-session-1",
        status: "ready" as const,
        failureCode: null,
        runtimeId: "runtime-1",
        runtimeGeneration: 1,
        updatedAt: "2026-08-03T00:00:01.000Z",
      }),
    );

    expect(bindingReady.sessions[0]).toMatchObject({
      providerBindingStatus: "ready",
      canControl: false,
    });
    expect(bindingReady.nextCursor).toBeNull();
    expect(bindingReady.needsFreshPage).toBe(true);
  });

  it("rejects late native, settings, lease, and attachment errors for another selection", () => {
    const native = makeEnvelope("sessions.native.snapshot", {
      snapshot: {
        snapshotId: "native-1",
        revision: 1,
        providerId: "codex",
        accountId: "account-a",
        observedAt: "2026-08-03T00:00:00.000Z",
        staleAt: "2026-08-03T00:01:00.000Z",
        freshness: "live" as const,
        truncated: false,
        sessions: [],
        notice: null,
      },
    });
    expect(
      reduceNative(initialNativeState(), native, "codex", "account-b").snapshot,
    ).toBeNull();
    expect(
      reduceNative(initialNativeState(), native, "codex", "account-a").snapshot
        ?.accountId,
    ).toBe("account-a");
    const staleNative = makeEnvelope("sessions.native.snapshot", {
      snapshot: { ...native.payload.snapshot, freshness: "stale" as const },
    });
    expect(
      reduceNative(
        initialNativeState(),
        staleNative,
        "codex",
        "account-a",
      ).status,
    ).toBe("stale");

    const settings = makeEnvelope("session.settings.snapshot", {
      snapshot: {
        sessionId: "session-a",
        revision: 1,
        mutable: true,
        settings: {
          providerId: "codex",
          accountId: "account-a",
          model: null,
          reasoningLevel: null,
          executionMode: "ask" as const,
          approvalPolicy: "review" as const,
          sandboxPolicy: "read_only" as const,
          networkPolicy: "denied" as const,
          projectPath: "C:\\project",
          branch: null,
        },
      },
    });
    expect(
      reduceSettings(initialSettingsState(), settings, "session-b").snapshot,
    ).toBeNull();
    expect(
      reduceSettings(initialSettingsState(), settings, "session-a").snapshot
        ?.sessionId,
    ).toBe("session-a");

    const lease = makeEnvelope("approval.lease.snapshot", {
      snapshot: {
        sessionId: "session-a",
        revision: 0,
        serverTime: "2026-08-03T00:00:00.000Z",
        leases: [],
      },
    });
    expect(reduceLease(initialLeaseState(), lease, "session-b").snapshot).toBeNull();
    expect(
      reduceLease(initialLeaseState(), lease, "session-a").snapshot?.sessionId,
    ).toBe("session-a");

    const attachmentError = makeEnvelope("command.rejected", {
      commandId: "attachment-command",
      sessionId: "session-a",
      error: {
        code: "ATTACHMENT_INVALID",
        message: "invalid",
        retryable: false,
      },
    });
    expect(
      reduceAttachments(initialAttachmentState(), attachmentError, "session-b").error,
    ).toBeNull();
  });

  it("parses settings conflict snapshots before using them", () => {
    const malformed = makeEnvelope("command.rejected", {
      commandId: "settings-command",
      sessionId: "session-1",
      error: {
        code: "SESSION_SETTINGS_CONFLICT",
        message: "conflict",
        retryable: false,
        details: { snapshot: { sessionId: "session-1", revision: "bad" } },
      },
    });
    const next = reduceSettings(initialSettingsState(), malformed, "session-1");
    expect(next.snapshot).toBeNull();
    expect(next.conflict).toBeNull();
    expect(next.error).toMatch(/SESSION_SETTINGS_CONFLICT/);
  });

  it("appends cursor pages without duplicate Session IDs", () => {
    expect(
      mergeCatalogPage([seed("a")], [seed("a"), seed("b")]).map((s) => s.sessionId),
    ).toEqual(["a", "b"]);
  });

  it("correlates pending uploads by commandId, not name/size", () => {
    const pending = new Map<string, PendingUploadBytes>();
    const bytesA = new Uint8Array([1, 2, 3]);
    const bytesB = new Uint8Array([1, 2, 3]);
    pending.set("cmd-a", { bytes: bytesA, chunkCount: 1, sessionId: "s1" });
    pending.set("cmd-b", { bytes: bytesB, chunkCount: 1, sessionId: "s1" });

    const taken = takePendingUploadByCommand(pending, "cmd-b", "s1");
    expect(taken?.bytes).toBe(bytesB);
    expect(pending.has("cmd-b")).toBe(false);
    expect(pending.has("cmd-a")).toBe(true);
    expect(takePendingUploadByCommand(pending, "cmd-a", "other")).toBeNull();
    expect(pending.has("cmd-a")).toBe(true);
  });

  it("counts attachment slots without double-counting ready/selected states", () => {
    const attachments = [
      {
        attachmentId: "1",
        sessionId: "s",
        ownerDeviceId: "d",
        name: "a.txt",
        kind: "text" as const,
        mediaType: "text/plain" as const,
        byteLength: 3,
        sha256: "a".repeat(64),
        status: "ready" as const,
        previewAvailable: false,
        createdAt: "2026-08-03T00:00:00.000Z",
        expiresAt: "2026-08-04T00:00:00.000Z",
        referencedTurnId: null,
      },
      {
        attachmentId: "2",
        sessionId: "s",
        ownerDeviceId: "d",
        name: "b.txt",
        kind: "text" as const,
        mediaType: "text/plain" as const,
        byteLength: 3,
        sha256: "b".repeat(64),
        status: "uploading" as const,
        previewAvailable: false,
        createdAt: "2026-08-03T00:00:00.000Z",
        expiresAt: "2026-08-04T00:00:00.000Z",
        referencedTurnId: null,
      },
      {
        attachmentId: "3",
        sessionId: "s",
        ownerDeviceId: "d",
        name: "c.txt",
        kind: "text" as const,
        mediaType: "text/plain" as const,
        byteLength: 3,
        sha256: "c".repeat(64),
        status: "rejected" as const,
        previewAvailable: false,
        createdAt: "2026-08-03T00:00:00.000Z",
        expiresAt: "2026-08-04T00:00:00.000Z",
        referencedTurnId: null,
      },
      {
        attachmentId: "4",
        sessionId: "s",
        ownerDeviceId: "d",
        name: "d.txt",
        kind: "text" as const,
        mediaType: "text/plain" as const,
        byteLength: 3,
        sha256: "d".repeat(64),
        status: "deleted" as const,
        previewAvailable: false,
        createdAt: "2026-08-03T00:00:00.000Z",
        expiresAt: "2026-08-04T00:00:00.000Z",
        referencedTurnId: null,
      },
    ];
    // ready + uploading + 1 in-flight begin = 3; rejected/deleted excluded
    expect(countAttachmentSlots(attachments, ["1"], 1)).toBe(3);
    expect(countAttachmentSlots(attachments, [], 1)).toBe(2);
    expect(remainingAttachmentSlots(attachments, ["1"], 1, 8)).toBe(5);
    expect(remainingAttachmentSlots(attachments, ["1"], 6, 8)).toBe(0);
  });

  it("derives attachment kind and basename safely", () => {
    expect(basenameOnly("C:\\\\tmp\\\\note.md")).toBe("note.md");
    expect(parseInputAttachmentMediaType("image/svg+xml")).toBeNull();
    const image = parseInputAttachmentMediaType("image/png");
    const text = parseInputAttachmentMediaType("text/markdown");
    expect(image && attachmentKindForMediaType(image)).toBe("image");
    expect(text && attachmentKindForMediaType(text)).toBe("text");
  });

  it("finds only active leases", () => {
    expect(
      activeLease({
        sessionId: "s1",
        revision: 1,
        serverTime: "2026-08-03T00:00:00.000Z",
        leases: [
          {
            leaseId: "l1",
            sessionId: "s1",
            providerId: "codex",
            accountId: "default",
            projectPath: "C:\\\\proj",
            deviceId: "d1",
            runtimeId: "r1",
            runtimeGeneration: 1,
            settingsRevision: 1,
            state: "expired",
            revision: 1,
            issuedAt: "2026-08-03T00:00:00.000Z",
            expiresAt: "2026-08-03T00:15:00.000Z",
            revokedAt: null,
            revokeReason: null,
          },
        ],
      }),
    ).toBeNull();
  });

  it("keeps default catalog filters fail-closed for archive", () => {
    expect(defaultCatalogFilters().archived).toBe("exclude");
  });

  it("exposes operator-facing maintenance diagnostic without path invention", () => {
    expect(isMaintenanceProtocolError("MIGRATION_CHECKSUM_MISMATCH")).toBe(true);
    expect(isMaintenanceProtocolError("SESSION_BUSY")).toBe(false);
    expect(isMaintenanceProtocolError("PROVIDER_INVENTORY_UNAVAILABLE")).toBe(false);
    expect(isMaintenanceProtocolError("PROVIDER_SCHEMA_INCOMPATIBLE")).toBe(false);
    expect(isMaintenanceProtocolError("CORE_UNAVAILABLE")).toBe(false);
    const message = maintenanceOperatorMessage(
      "MIGRATION_CHECKSUM_MISMATCH",
      "source migration failed",
    );
    expect(message).toMatch(/requires maintenance/i);
    expect(message).toMatch(/Do not delete or overwrite/i);
    expect(message).toMatch(/backup/i);
  });
});
