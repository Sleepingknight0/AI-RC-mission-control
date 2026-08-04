import { describe, expect, it } from "vitest";

import type {
  ProviderAccountCapabilitySnapshot,
  ProviderRecord,
} from "@aicl/protocol";

import {
  capabilityDecision,
  selectProviderAccountExecution,
  selectProviderExecution,
} from "../src/index.js";

const observedAt = "2026-08-03T03:40:00.000Z";
const provider: ProviderRecord = {
  providerId: "codex",
  displayName: "Codex",
  enabled: true,
  installation: "installed",
  authentication: "authenticated",
  compatibility: "compatible",
  adapterSupport: "remote_control",
  version: "0.146.0",
  freshness: "live",
  observedAt,
  notice: null,
  capabilities: [
    {
      key: "remote_control",
      state: "supported",
      provenance: "provider_probe",
      observedAt,
      reason: null,
    },
    {
      key: "image_input",
      state: "supported",
      provenance: "provider_probe",
      observedAt,
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
      observedAt,
      notice: null,
    },
  ],
  accountCount: 1,
  models: [
    {
      modelId: "gpt-test",
      displayName: "GPT Test",
      description: "Fixture",
      hidden: false,
      isDefault: true,
      inputModalities: ["text", "image"],
      defaultReasoningEffort: "medium",
      reasoningEfforts: [
        { value: "medium", description: "Medium" },
        { value: "high", description: "High" },
      ],
    },
  ],
  modelsState: "available",
  usageState: "not_supported",
  usageMeters: [],
};

describe("provider capability decisions", () => {
  it("returns explicit unknown evidence instead of assuming support", () => {
    expect(capabilityDecision(provider, "network_policies")).toEqual({
      state: "unknown",
      reason: "Capability was not advertised",
    });
  });

  it("selects only a controllable account/model/reasoning combination", () => {
    expect(
      selectProviderExecution(provider, {
        accountId: "default",
        modelId: "gpt-test",
        reasoningEffort: "high",
        requiredInput: "image",
      }),
    ).toEqual({
      ok: true,
      account: provider.accounts[0],
      model: provider.models[0],
    });
  });

  it("fails closed for stale providers and unsupported selections", () => {
    expect(
      selectProviderExecution(
        { ...provider, freshness: "stale" },
        {
          accountId: "default",
          modelId: "gpt-test",
          reasoningEffort: "high",
          requiredInput: "text",
        },
      ),
    ).toMatchObject({ ok: false, code: "PROVIDER_STALE" });
    expect(
      selectProviderExecution(provider, {
        accountId: "other",
        modelId: "gpt-test",
        reasoningEffort: "high",
        requiredInput: "text",
      }),
    ).toMatchObject({ ok: false, code: "ACCOUNT_UNAVAILABLE" });
    expect(
      selectProviderExecution(provider, {
        accountId: "default",
        modelId: "gpt-test",
        reasoningEffort: "ultra",
        requiredInput: "text",
      }),
    ).toMatchObject({ ok: false, code: "REASONING_UNSUPPORTED" });
  });

  it("never inherits provider models and withdraws stale account control", () => {
    const accountEvidence: ProviderAccountCapabilitySnapshot = {
      snapshotId: "exact-account-snapshot",
      revision: 1,
      providerId: "codex",
      accountId: "default",
      source: "provider_probe",
      observedAt,
      staleAt: "2099-08-03T03:45:00.000Z",
      freshness: "live",
      authentication: "authenticated",
      control: "remote_control",
      active: true,
      capabilities: provider.capabilities,
      models: [{
        ...provider.models[0]!,
        modelId: "account-only-model",
        displayName: "Account only",
      }],
      modelsState: "available",
      notice: null,
    };
    const providerOnlySelection = {
      accountId: "default",
      modelId: "gpt-test",
      reasoningEffort: "high",
      requiredInput: "text" as const,
    };
    expect(
      selectProviderAccountExecution(provider, accountEvidence, providerOnlySelection),
    ).toMatchObject({ ok: false, code: "MODEL_UNAVAILABLE" });
    expect(
      selectProviderAccountExecution(
        provider,
        { ...accountEvidence, freshness: "stale", control: "inventory_only" },
        { ...providerOnlySelection, modelId: "account-only-model" },
      ),
    ).toMatchObject({ ok: false, code: "ACCOUNT_UNAVAILABLE" });
  });
});
