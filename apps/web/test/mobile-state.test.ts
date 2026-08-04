import type {
  ProviderAccountCapabilitySnapshot,
  ProviderFleetSnapshot,
  ProviderModel,
  ProviderNativeSession,
  ProviderNativeSessionPage,
  ProviderRecord,
  SessionSummaryV2,
} from "@aicl/protocol";
import { makeEnvelope } from "@aicl/protocol";
import { describe, expect, it } from "vitest";

import {
  initialNativeState,
  nativeRequestStarted,
  reduceNative,
} from "../src/m9/state.js";
import {
  accountHasCurrentControl,
  accountSelectionForProvider,
  accountScopedCatalogFilters,
  canActivateAccount,
  currentAccountStatus,
  groupAccountsByProvider,
  recentSessionsByPeriod,
  sessionBelongsToProviderAccount,
  sessionsForProviderAccount,
  supportedModelsForAccount,
  supportedReasoningForModel,
} from "../src/mobile/state.js";
import {
  activationResponseMatches,
  nativeResumeRefreshDecision,
} from "../src/mobile/activation.js";

const observedAt = "2026-08-04T10:00:00.000Z";

const account = (accountId: string, displayName: string, isDefault = false) => ({
  accountId,
  displayName,
  isDefault,
  authentication: "authenticated" as const,
  control: "inventory_only" as const,
  observedAt,
  notice: null,
});

const provider = (overrides: Partial<ProviderRecord> = {}): ProviderRecord => ({
  providerId: "codex",
  displayName: "Codex",
  enabled: true,
  installation: "installed",
  authentication: "authenticated",
  compatibility: "compatible",
  adapterSupport: "remote_control",
  version: "0.146.0",
  freshness: "local",
  observedAt,
  notice: null,
  capabilities: [],
  accounts: [account("blue-1", "Blue One"), account("blue-2", "Blue Two"), account("blue-3", "Blue Three")],
  accountCount: 3,
  models: [],
  modelsState: "unavailable",
  usageState: "not_supported",
  usageMeters: [],
  ...overrides,
});

const fleet = (providers = [provider()]): ProviderFleetSnapshot => ({
  snapshotId: "fleet-1",
  revision: 1,
  source: "terminal_registry",
  observedAt,
  staleAt: "2026-08-04T10:05:00.000Z",
  freshness: "local",
  degraded: false,
  providers,
  notice: null,
});

const catalogSession = (
  sessionId: string,
  accountId: string,
  providerSessionId: string | null,
  lastActivityAt = observedAt,
): SessionSummaryV2 => ({
  sessionId,
  title: sessionId,
  providerId: "codex",
  accountId,
  providerSessionId,
  source: "aicl",
  providerBindingStatus: "ready",
  projectPath: "C:\\workspace",
  projectName: "workspace",
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
  lastActivityAt,
  lastEventSeq: 0,
  canResume: true,
  canControl: true,
  pinned: false,
  archived: false,
  revision: 1,
  settingsRevision: 1,
});

const nativeSession = (
  providerSessionId: string,
  accountId: string,
  title = providerSessionId,
): ProviderNativeSession => ({
  providerId: "codex",
  accountId,
  providerSessionId,
  title,
  preview: null,
  projectPath: "C:\\workspace",
  projectName: "workspace",
  branch: null,
  providerStatus: "idle",
  createdAt: observedAt,
  updatedAt: observedAt,
  pinned: false,
  archived: false,
  canResume: true,
});

const model = (modelId: string, reasoning: string[]): ProviderModel => ({
  modelId,
  displayName: modelId,
  description: `${modelId} model`,
  hidden: false,
  isDefault: true,
  inputModalities: ["text"],
  defaultReasoningEffort: reasoning[0] ?? null,
  reasoningEfforts: reasoning.map((value) => ({ value, description: value })),
});

const accountCapabilities = (
  accountId: string,
  overrides: Partial<ProviderAccountCapabilitySnapshot> = {},
): ProviderAccountCapabilitySnapshot => ({
  snapshotId: `account-cap-${accountId}`,
  revision: 1,
  providerId: "codex",
  accountId,
  source: "provider_probe",
  observedAt,
  staleAt: "2026-08-04T10:05:00.000Z",
  freshness: "live",
  authentication: "authenticated",
  control: "inventory_only",
  active: false,
  capabilities: [],
  models: [model("gpt-a", ["low", "high"])],
  modelsState: "available",
  notice: "Activate this account before remote control",
  ...overrides,
});

describe("M10 mobile provider/account/session selectors", () => {
  it("correlates activation results to the exact pending command", () => {
    const current = { epoch: 8, providerId: "codex", accountId: "blue-2" };
    const pending = { epoch: 8, activationCommandId: "activation-new" };
    expect(activationResponseMatches(pending, {
      commandId: "activation-old",
      providerId: "codex",
      accountId: "blue-2",
    }, current)).toBe(false);
    expect(activationResponseMatches(pending, {
      commandId: "activation-new",
      providerId: "codex",
      accountId: "blue-2",
    }, current)).toBe(true);
    expect(activationResponseMatches(null, {
      commandId: "activation-new",
      providerId: "codex",
      accountId: "blue-2",
    }, current)).toBe(false);
  });

  it("refreshes and paginates native resume evidence after activation", () => {
    const pending = {
      epoch: 8,
      requestId: "native-request-1",
      providerId: "codex",
      accountId: "blue-2",
      providerSessionId: "native-target",
      search: "",
    };
    const page = (sessions: ProviderNativeSession[], nextCursor: string | null): ProviderNativeSessionPage => ({
      providerId: "codex",
      accountId: "blue-2",
      observedAt,
      freshness: "live",
      sessions,
      nextCursor,
      hasMore: nextCursor !== null,
      truncated: false,
      cursorReset: false,
      notice: null,
    });
    expect(nativeResumeRefreshDecision(
      pending,
      "stale-request",
      page([], null),
      8,
    )).toEqual({ kind: "ignore" });
    expect(nativeResumeRefreshDecision(
      pending,
      "native-request-1",
      page([], "opaque-native-cursor"),
      8,
    )).toEqual({ kind: "continue", cursor: "opaque-native-cursor" });
    expect(nativeResumeRefreshDecision(
      pending,
      "native-request-1",
      page([nativeSession("native-target", "blue-2")], null),
      8,
    )).toEqual({ kind: "resume" });
    expect(nativeResumeRefreshDecision(
      pending,
      "native-request-1",
      { ...page([nativeSession("native-target", "blue-2")], null), freshness: "unavailable" },
      8,
    )).toEqual({ kind: "unavailable" });
  });
  it("groups three Codex accounts independently from authoritative inventory", () => {
    const groups = groupAccountsByProvider(fleet());
    expect(groups).toHaveLength(1);
    expect(groups[0]?.accounts.map((item) => item.accountId)).toEqual([
      "blue-1",
      "blue-2",
      "blue-3",
    ]);
  });

  it("never falls back from a restored account during partial inventory", () => {
    const partial = provider({ accounts: [account("blue-3", "Blue Three", true)] });
    expect(accountSelectionForProvider(partial, "blue-1")).toBe("blue-1");
    expect(accountSelectionForProvider(partial, null)).toBe("blue-3");
    expect(accountSelectionForProvider(null, "blue-1")).toBe("blue-1");
  });

  it("never leaks Sessions across account IDs", () => {
    const catalog = [
      catalogSession("managed-a", "blue-1", "native-shared"),
      catalogSession("managed-b", "blue-2", "native-shared"),
    ];
    const native = [
      nativeSession("native-shared", "blue-1"),
      nativeSession("native-shared", "blue-2"),
      nativeSession("native-only", "blue-2"),
    ];
    expect(sessionsForProviderAccount(catalog, native, "codex", "blue-1").map((row) => row.sessionId)).toEqual(["managed-a"]);
    expect(sessionsForProviderAccount(catalog, native, "codex", "blue-2").map((row) => row.sessionId)).toEqual(["managed-b", null]);
  });

  it("rejects restored or deep-linked Sessions outside the selected account", () => {
    const catalog = [
      catalogSession("managed-a", "blue-1", null),
      catalogSession("managed-b", "blue-2", null),
    ];
    expect(sessionBelongsToProviderAccount(catalog, "managed-a", "codex", "blue-1")).toBe(true);
    expect(sessionBelongsToProviderAccount(catalog, "managed-a", "codex", "blue-2")).toBe(false);
    expect(sessionBelongsToProviderAccount(catalog, "managed-a", null, null)).toBe(false);
  });

  it("deduplicates a bound native row only inside the same provider/account", () => {
    const rows = sessionsForProviderAccount(
      [catalogSession("managed", "blue-1", "native-1")],
      [nativeSession("native-1", "blue-1", "Native title")],
      "codex",
      "blue-1",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "catalog", sessionId: "managed" });
  });

  it("derives display periods without creating durable Session state", () => {
    const rows = sessionsForProviderAccount(
      [
        { ...catalogSession("today", "blue-1", null, "2026-08-04T08:00:00.000Z"), pinned: true },
        catalogSession("yesterday", "blue-1", null, "2026-08-03T08:00:00.000Z"),
        catalogSession("week", "blue-1", null, "2026-07-30T08:00:00.000Z"),
      ],
      [],
      "codex",
      "blue-1",
    );
    expect(recentSessionsByPeriod(rows, new Date("2026-08-04T12:00:00.000Z")).map((group) => group.period)).toEqual([
      "Pinned",
      "Yesterday",
      "This week",
    ]);
  });

  it("uses exact live account evidence and never promotes fleet-local control", () => {
    const inventory = provider().accounts[0] ?? null;
    const unavailable = currentAccountStatus("codex", inventory, null);
    expect(unavailable.canControl).toBe(false);
    const inactive = currentAccountStatus("codex", inventory, accountCapabilities("blue-1"));
    expect(inactive).toMatchObject({ canControl: false, active: false, label: "Ready to activate" });
    const active = currentAccountStatus(
      "codex",
      inventory,
      accountCapabilities("blue-1", { active: true, control: "remote_control" }),
    );
    expect(active).toMatchObject({ canControl: true, active: true });
    expect(currentAccountStatus("other", inventory, accountCapabilities("blue-1")).canControl).toBe(false);
  });

  it("switches account-specific models and never invents xhigh", () => {
    const first = accountCapabilities("blue-1", { models: [model("gpt-a", ["low", "high"])] });
    const second = accountCapabilities("blue-2", { models: [model("gpt-b", ["medium"])] });
    const firstModels = supportedModelsForAccount(first, "codex", "blue-1");
    expect(firstModels.map((item) => item.modelId)).toEqual(["gpt-a"]);
    expect(supportedReasoningForModel(firstModels, "gpt-a").map((item) => item.value)).toEqual(["low", "high"]);
    expect(supportedModelsForAccount(first, "codex", "blue-2")).toEqual([]);
    expect(supportedModelsForAccount(second, "codex", "blue-2").map((item) => item.modelId)).toEqual(["gpt-b"]);
  });

  it("withdraws control when exact account evidence becomes stale", () => {
    const inventory = provider().accounts[0] ?? null;
    const status = currentAccountStatus(
      "codex",
      inventory,
      accountCapabilities("blue-1", {
        freshness: "stale",
        active: true,
        control: "inventory_only",
      }),
    );
    expect(status).toMatchObject({ canControl: false, state: "stale", active: true });
  });

  it("withdraws control and models when live evidence passes staleAt", () => {
    const inventory = provider().accounts[0] ?? null;
    const evidence = accountCapabilities("blue-1", {
      active: true,
      control: "remote_control",
    });
    const afterExpiry = Date.parse("2026-08-04T10:06:00.000Z");
    expect(currentAccountStatus("codex", inventory, evidence, afterExpiry)).toMatchObject({
      canControl: false,
      label: "Evidence expired",
      state: "stale",
    });
    expect(supportedModelsForAccount(evidence, "codex", "blue-1", afterExpiry)).toEqual([]);
    expect(accountHasCurrentControl(evidence, afterExpiry)).toBe(false);
  });

  it("allows exact first-boot account activation without provider aggregate control", () => {
    const inactiveProvider = provider({ adapterSupport: "inventory_only" });
    const evidence = accountCapabilities("blue-1", {
      active: false,
      control: "inventory_only",
    });
    expect(canActivateAccount(inactiveProvider, evidence, Date.parse(observedAt))).toBe(true);
    expect(canActivateAccount(inactiveProvider, {
      ...evidence,
      staleAt: "2026-08-04T09:59:59.000Z",
    }, Date.parse(observedAt))).toBe(false);
    expect(canActivateAccount({ ...inactiveProvider, compatibility: "unknown" }, evidence, Date.parse(observedAt))).toBe(false);
  });

  it("returns honest empty states for empty provider, account, and Session inputs", () => {
    expect(groupAccountsByProvider(null)).toEqual([]);
    expect(groupAccountsByProvider(fleet([]))).toEqual([]);
    expect(sessionsForProviderAccount([], [], null, null)).toEqual([]);
    expect(recentSessionsByPeriod([], new Date(observedAt))).toEqual([]);
  });

  it("keeps hundreds of Sessions stable and bounded by exact account", () => {
    const many = Array.from({ length: 350 }, (_, index) =>
      catalogSession(
        `session-${String(index).padStart(3, "0")}`,
        index % 2 === 0 ? "blue-1" : "blue-2",
        null,
        new Date(Date.parse(observedAt) - index * 1_000).toISOString(),
      ),
    );
    const rows = sessionsForProviderAccount(many, [], "codex", "blue-1");
    expect(rows).toHaveLength(175);
    expect(new Set(rows.map((row) => row.key)).size).toBe(175);
    expect(rows[0]?.sessionId).toBe("session-000");
  });

  it("builds account-scoped server search filters", () => {
    expect(accountScopedCatalogFilters("codex", "blue-2", "  mission  ")).toMatchObject({
      search: "mission",
      providerIds: ["codex"],
      accountIds: ["blue-2"],
      archived: "exclude",
    });
    expect(
      accountScopedCatalogFilters("codex", "blue-2", "", "managed-b"),
    ).toMatchObject({
      search: null,
      sessionIds: ["managed-b"],
      providerIds: ["codex"],
      accountIds: ["blue-2"],
    });
  });

  it("keeps duplicate provider Session IDs distinct across account keys", () => {
    const first = sessionsForProviderAccount([], [nativeSession("same-id", "blue-1")], "codex", "blue-1")[0];
    const second = sessionsForProviderAccount([], [nativeSession("same-id", "blue-2")], "codex", "blue-2")[0];
    expect(first?.key).not.toBe(second?.key);
  });
});

describe("M10 native account pagination reducer", () => {
  it("appends exact-account pages without duplicates and ignores late request IDs", () => {
    const firstPending = nativeRequestStarted(initialNativeState(), "request-first", false);
    const first = reduceNative(firstPending, makeEnvelope("sessions.native.page", {
      requestId: "request-first",
      page: {
        providerId: "codex",
        accountId: "blue-1",
        observedAt,
        freshness: "live" as const,
        sessions: [nativeSession("native-1", "blue-1")],
        nextCursor: "cursor-000000001",
        hasMore: true,
        truncated: false,
        cursorReset: false,
        notice: null,
      },
    }), "codex", "blue-1");
    const appendPending = nativeRequestStarted(first, "request-second", true);
    const appended = reduceNative(appendPending, makeEnvelope("sessions.native.page", {
      requestId: "request-second",
      page: {
        ...first.page!,
        sessions: [nativeSession("native-1", "blue-1"), nativeSession("native-2", "blue-1")],
        nextCursor: null,
        hasMore: false,
      },
    }), "codex", "blue-1");
    expect(appended.sessions.map((item) => item.providerSessionId)).toEqual(["native-1", "native-2"]);
    const late = reduceNative(appended, makeEnvelope("sessions.native.page", {
      requestId: "request-old",
      page: { ...appended.page!, sessions: [nativeSession("late", "blue-1")] },
    }), "codex", "blue-1");
    expect(late.sessions).toEqual(appended.sessions);
  });

  it("replaces accumulated rows when Core reports a cursor reset", () => {
    const seeded = {
      ...initialNativeState(),
      status: "ready" as const,
      sessions: [nativeSession("old", "blue-1")],
    };
    const pending = nativeRequestStarted(seeded, "request-reset", true);
    const reset = reduceNative(pending, makeEnvelope("sessions.native.page", {
      requestId: "request-reset",
      page: {
        providerId: "codex",
        accountId: "blue-1",
        observedAt,
        freshness: "live" as const,
        sessions: [nativeSession("fresh", "blue-1")],
        nextCursor: null,
        hasMore: false,
        truncated: false,
        cursorReset: true,
        notice: "Session inventory changed; showing a fresh first page.",
      },
    }), "codex", "blue-1");
    expect(reset.sessions.map((item) => item.providerSessionId)).toEqual(["fresh"]);
    expect(reset.page?.cursorReset).toBe(true);
  });
});
