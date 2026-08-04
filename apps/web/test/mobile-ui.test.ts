import { readFileSync } from "node:fs";

import type {
  ProviderAccountCapabilitySnapshot,
  ProviderFleetSnapshot,
  SessionCapabilitiesSnapshot,
  SessionSettingsSnapshot,
} from "@aicl/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AccountSessionDrawer } from "../src/mobile/AccountSessionDrawer.js";
import { MobileComposer } from "../src/mobile/MobileComposer.js";
import { MobileHeader } from "../src/mobile/MobileHeader.js";
import { ModelModeSheet } from "../src/mobile/ModelModeSheet.js";
import { supportedModelsForAccount } from "../src/mobile/state.js";

const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const overlaySource = readFileSync(new URL("../src/mobile/MobileOverlay.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const createFormSource = readFileSync(new URL("../src/mobile/MobileCreateSessionForm.tsx", import.meta.url), "utf8");
const observedAt = "2026-08-04T10:00:00.000Z";

const fleet: ProviderFleetSnapshot = {
  snapshotId: "fleet-1",
  revision: 1,
  source: "terminal_registry",
  observedAt,
  staleAt: "2026-08-04T10:05:00.000Z",
  freshness: "local",
  degraded: false,
  notice: null,
  providers: [{
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
    accounts: ["one", "two", "three"].map((accountId, index) => ({
      accountId,
      displayName: `Account ${index + 1}`,
      isDefault: index === 0,
      authentication: "authenticated" as const,
      control: "inventory_only" as const,
      observedAt,
      notice: null,
    })),
    accountCount: 3,
    models: [],
    modelsState: "unavailable",
    usageState: "not_supported",
    usageMeters: [],
  }],
};

const accountCapabilities: ProviderAccountCapabilitySnapshot = {
  snapshotId: "account-cap-1",
  revision: 1,
  providerId: "codex",
  accountId: "one",
  source: "provider_probe",
  observedAt,
  staleAt: "2026-08-04T10:05:00.000Z",
  freshness: "live",
  authentication: "authenticated",
  control: "remote_control",
  active: true,
  capabilities: [{
    key: "remote_control",
    state: "supported",
    provenance: "provider_probe",
    observedAt,
    reason: null,
  }],
  models: [{
    modelId: "gpt-mobile",
    displayName: "GPT Mobile",
    description: "Account-specific model",
    hidden: false,
    isDefault: true,
    inputModalities: ["text"],
    defaultReasoningEffort: "high",
    reasoningEfforts: [{ value: "high", description: "High reasoning" }],
  }],
  modelsState: "available",
  notice: null,
};

const settings: SessionSettingsSnapshot = {
  sessionId: "session-1",
  revision: 3,
  mutable: true,
  settings: {
    providerId: "codex",
    accountId: "one",
    model: "gpt-mobile",
    reasoningLevel: "high",
    executionMode: "ask",
    approvalPolicy: "review",
    sandboxPolicy: "read_only",
    networkPolicy: "denied",
    projectPath: "C:\\workspace",
    branch: null,
  },
};

const support = (state: "supported" | "unsupported", reason: string | null = null) => ({ state, reason });
const capabilities: SessionCapabilitiesSnapshot = {
  sessionId: "session-1",
  settingsRevision: 3,
  observedAt,
  freshness: "live",
  provider: { providerId: "codex", ...support("supported") },
  account: { accountId: "one", ...support("supported") },
  model: { modelId: "gpt-mobile", ...support("supported") },
  controlAuthority: { canControl: true, bindingStatus: "ready", reason: null },
  executionModes: [
    { mode: "ask", ...support("supported") },
    { mode: "plan", ...support("supported") },
    { mode: "auto", ...support("unsupported", "Auto not reported") },
  ],
  attachments: [
    { kind: "text", ...support("supported") },
    { kind: "image", ...support("unsupported", "Image unsupported") },
  ],
  approvalPolicies: [
    { policy: "review", ...support("supported") },
    { policy: "balanced", ...support("supported") },
    { policy: "workspace_auto", ...support("unsupported", "Workspace auto unavailable") },
    { policy: "full_auto_lease", ...support("unsupported", "Lease unavailable") },
  ],
  fullAutoLease: support("unsupported", "Lease unavailable"),
};

describe("M10 mobile visible contracts", () => {
  it("exposes deterministic accessible header controls", () => {
    const html = renderToStaticMarkup(createElement(MobileHeader, {
      providerLabel: "Codex",
      accountLabel: "Account 1",
      sessionTitle: "Mission Control",
      statusLabel: "Connected",
      statusTone: "ready",
      activityLabel: "Ready",
      onOpenDrawer: () => undefined,
      onOpenStatus: () => undefined,
    }));
    expect(html).toContain('data-testid="mobile-drawer-trigger"');
    expect(html).toContain('aria-label="Open accounts and Sessions"');
    expect(html).toContain('data-testid="mobile-status-trigger"');
    expect(html).not.toContain("credential");
  });

  it("renders three independent account rows and account-scoped search in the drawer", () => {
    const html = renderToStaticMarkup(createElement(AccountSessionDrawer, {
      open: true,
      fleet,
      selectedProviderId: "codex",
      selectedAccountId: "one",
      accountLabel: "Account 1",
      sessions: [],
      selectedSessionId: "session-1",
      search: "",
      loading: false,
      hasMore: true,
      truncated: false,
      now: Date.parse(observedAt),
      onClose: () => undefined,
      onSelectAccount: () => undefined,
      onSearchChange: () => undefined,
      onSelectSession: () => undefined,
      onResumeNative: () => undefined,
      onOpenActions: () => undefined,
      onLoadMore: () => undefined,
      onOpenStatus: () => undefined,
      approvalDestinationAvailable: false,
      attachmentDestinationAvailable: false,
      settingsDestinationAvailable: true,
      onOpenApprovals: () => undefined,
      onOpenAttachments: () => undefined,
      onOpenSettings: () => undefined,
    }));
    expect(html.match(/data-testid="mobile-account-codex-/g)).toHaveLength(3);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('data-testid="mobile-session-search"');
    expect(html).toContain('data-testid="mobile-session-load-more"');
    expect(html).toContain("Approvals");
    expect(html).toContain("Attachments");
    expect(html).toContain("Settings");
    expect(html).not.toContain("More options for Account");
  });

  it("shows only account-advertised model and reasoning choices", () => {
    const models = supportedModelsForAccount(accountCapabilities, "codex", "one");
    const html = renderToStaticMarkup(createElement(ModelModeSheet, {
      open: true,
      models,
      settings,
      capabilities,
      evidenceNotice: null,
      onClose: () => undefined,
      onUpdate: () => undefined,
    }));
    expect(html).toContain('data-testid="mobile-model-mode-sheet"');
    expect(html).toContain("GPT Mobile");
    expect(html).toContain("High reasoning");
    expect(html).not.toMatch(/xhigh/i);
    expect(html).toMatch(/disabled=""[^>]*title="Auto not reported"|title="Auto not reported"[^>]*disabled=""/);
  });

  it("composer exposes only implemented attachment and send controls", () => {
    const html = renderToStaticMarkup(createElement(MobileComposer, {
      value: "draft",
      modelLabel: "GPT Mobile",
      modeLabel: "Ask",
      busy: false,
      canSubmit: true,
      disabledReason: "Ready",
      canAttachText: true,
      canAttachImage: false,
      attachmentChips: null,
      onChange: () => undefined,
      onSubmit: () => undefined,
      onAbort: () => undefined,
      onOpenModelMode: () => undefined,
      onPickFiles: () => undefined,
    }));
    expect(html).toContain('data-testid="mobile-composer"');
    expect(html).toContain('data-testid="mobile-model-mode-trigger"');
    expect(html).toContain('data-testid="mobile-send"');
    expect(html).not.toMatch(/microphone|camera|skill/i);
  });

  it("keeps mobile at below 768px with safe areas, 100dvh and 44px targets", () => {
    expect(styles).toMatch(/@media \(max-width: 767px\)/);
    expect(styles).toMatch(/\.mobile-chat-shell\s*\{[^}]*height:\s*100dvh/s);
    expect(styles).toMatch(/\.mobile-composer\s*\{[^}]*safe-area-inset-bottom/s);
    expect(styles).toMatch(/\.mobile-chat-shell button,[\s\S]*min-height:\s*44px/);
    expect(styles).not.toMatch(/\.mobile-return-live\s*\{[^}]*min-height:\s*(?:3[0-9]|[0-9])px/s);
    expect(overlaySource).toContain('event.key === "Escape"');
    expect(overlaySource).toContain("returnTarget?.focus");
    expect(overlaySource).toContain('event.key !== "Tab"');
    expect(overlaySource).toContain("onCloseRef.current()");
    expect(overlaySource).toContain("}, [open])");
    expect(overlaySource).not.toContain("[onClose, open]");
  });

  it("pins the composer with flex layout and drops forced uppercase on mobile controls", () => {
    expect(styles).toMatch(/\.mobile-chat-main\s*\{[^}]*display:\s*flex/s);
    expect(styles).toMatch(/\.mobile-chat-main\s*\{[^}]*flex-direction:\s*column/s);
    expect(styles).toMatch(/\.mobile-chat-timeline\s*\{[^}]*flex:\s*1 1 auto/s);
    expect(styles).toMatch(/\.mobile-composer\s*\{[^}]*flex:\s*0 0 auto/s);
    expect(styles).not.toMatch(/\.mobile-chat-main\s*\{[^}]*grid-template-rows:\s*auto auto auto minmax/s);
    expect(styles).toMatch(/\.mobile-chat-shell button\s*\{[^}]*text-transform:\s*none/s);
  });

  it("applies restrained aerospace visual tokens without neon excess", () => {
    expect(styles).toMatch(/--mobile-ice:/);
    expect(styles).toMatch(/--mobile-void:/);
    expect(styles).toMatch(/mobile-header-rail/);
    expect(styles).toMatch(/mobile-flight-link/);
    expect(styles).toMatch(/mobile-link-pulse/);
    expect(styles).toMatch(/prefers-reduced-motion: reduce/);
    expect(styles).not.toMatch(/neon|rainbow|#ff00ff/i);
  });

  it("surfaces shared model-sheet blockers once instead of on every choice", () => {
    const html = renderToStaticMarkup(createElement(ModelModeSheet, {
      open: true,
      models: accountCapabilities.models,
      settings: { ...settings, mutable: false },
      capabilities,
      evidenceNotice: null,
      onClose: () => undefined,
      onUpdate: () => undefined,
    }));
    expect(html).toContain("Settings are not mutable");
    expect(html).toContain("Account-specific model");
    expect(html.match(/Settings are not mutable/g)?.length).toBe(3);
    expect(html).not.toMatch(/title="Settings are not mutable"/);
  });

  it("hides the native file control from the accessibility tree", () => {
    const html = renderToStaticMarkup(createElement(MobileComposer, {
      value: "",
      modelLabel: "GPT Mobile",
      modeLabel: "Ask",
      busy: false,
      canSubmit: false,
      disabledReason: "Ready",
      canAttachText: true,
      canAttachImage: false,
      attachmentChips: null,
      onChange: () => undefined,
      onSubmit: () => undefined,
      onAbort: () => undefined,
      onOpenModelMode: () => undefined,
      onPickFiles: () => undefined,
    }));
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('type="file"');
  });

  it("requests native inventory for the exact selected account without provider-level gating", () => {
    expect(appSource).toContain("requestNativeSessions(");
    expect(appSource).not.toContain('const remote = capabilitySupported(selectedProvider, "list_sessions")');
  });

  it("withdraws the prior Session subscription when an account is selected", () => {
    expect(appSource).toContain('makeEnvelope("session.unsubscribe"');
    expect(appSource).toContain('selectedSessionRef.current = ""');
    expect(appSource).toContain("No Session is subscribed");
  });

  it("defers mobile Session subscription until exact account ownership is verified", () => {
    expect(appSource).toContain("deferInitialMobileSession");
    expect(appSource).toContain("sessionBelongsToProviderAccount(");
    expect(appSource).toContain('url.searchParams.delete("session")');
  });

  it("uses an HTML pattern valid under the browser regex v flag", () => {
    expect(createFormSource).toContain('pattern="[A-Za-z0-9._\\-]{1,100}"');
    expect(createFormSource).not.toContain('pattern="[A-Za-z0-9._-]{1,100}"');
  });
});
