import type {
  ProviderFleetSnapshot,
  ProviderRecord,
  SessionSummaryV2,
} from "@aicl/protocol";
import { makeEnvelope } from "@aicl/protocol";
import { describe, expect, it } from "vitest";

import {
  activeLease,
  attachmentKindForMediaType,
  basenameOnly,
  capabilitySupported,
  controllableProviders,
  defaultCatalogFilters,
  initialCatalogState,
  initialFleetState,
  reduceCatalog,
  reduceFleet,
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

describe("m9 state helpers", () => {
  it("accepts providers.snapshot as authoritative fleet state", () => {
    const next = reduceFleet(
      initialFleetState(),
      makeEnvelope("providers.snapshot", { snapshot: fleet([baseProvider()]) }),
    );
    expect(next.status).toBe("ready");
    expect(next.snapshot?.providers).toHaveLength(1);
  });

  it("marks inventory-only providers as non-controllable", () => {
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
  });

  it("discards catalog cursor on stale cursor rejection", () => {
    const seed: SessionSummaryV2 = {
      sessionId: "session-1",
      title: "Demo",
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
      sandboxPolicy: "workspace_write",
      networkPolicy: "restricted",
      state: "idle",
      runtimeStatus: "ready",
      activeTurnId: null,
      pendingApprovalCount: 0,
      turnCount: 0,
      unreadCount: 0,
      lastActivityAt: "2026-08-03T00:00:00.000Z",
      lastEventSeq: 0,
      canResume: false,
      canControl: true,
      pinned: false,
      archived: false,
      revision: 1,
      settingsRevision: 1,
    };
    const loaded = reduceCatalog(initialCatalogState(), makeEnvelope("sessions.catalog.snapshot", {
      requestId: "req-1",
      catalogRevision: 3,
      generatedAt: "2026-08-03T00:00:00.000Z",
      sessions: [seed],
      nextCursor: "cursor-1",
      total: 1,
    }));
    expect(loaded.nextCursor).toBe("cursor-1");
    const rejected = reduceCatalog(
      loaded,
      makeEnvelope("command.rejected", {
        commandId: "cmd-1",
        sessionId: "session-1",
        error: {
          code: "SESSION_CATALOG_CURSOR_STALE",
          message: "cursor stale",
          retryable: false,
        },
      }),
    );
    expect(rejected.nextCursor).toBeNull();
    expect(rejected.sessions).toHaveLength(1);
  });

  it("keeps default catalog filters fail-closed for archive", () => {
    expect(defaultCatalogFilters().archived).toBe("exclude");
  });

  it("derives attachment kind and basename safely", () => {
    expect(basenameOnly("C:\\\\tmp\\\\note.md")).toBe("note.md");
    expect(attachmentKindForMediaType("image/png")).toBe("image");
    expect(attachmentKindForMediaType("text/markdown")).toBe("text");
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
});
