import { describe, expect, it } from "vitest";

import {
  MAX_PROVIDER_ACCOUNTS,
  MAX_PROVIDER_INVENTORY,
  MAX_PROVIDER_MODELS,
  ClientEnvelopeSchema,
  ConnectorEnvelopeSchema,
  CoreToConnectorEnvelopeSchema,
  ProviderFleetSnapshotSchema,
  ProviderRecordSchema,
  ServerEnvelopeSchema,
  makeEnvelope,
} from "../src/index.js";

const observedAt = "2026-08-03T03:40:00.000Z";

const provider = {
  providerId: "codex",
  displayName: "OpenAI Codex",
  enabled: true,
  installation: "installed" as const,
  authentication: "authenticated" as const,
  compatibility: "compatible" as const,
  adapterSupport: "remote_control" as const,
  version: "0.146.0",
  freshness: "live" as const,
  observedAt,
  notice: null,
  capabilities: [
    {
      key: "remote_control" as const,
      state: "supported" as const,
      provenance: "provider_probe" as const,
      observedAt,
      reason: null,
    },
    {
      key: "usage_collection" as const,
      state: "unknown" as const,
      provenance: "terminal_registry" as const,
      observedAt,
      reason: "Collector not executed",
    },
  ],
  accounts: [
    {
      accountId: "bwcx-bluewhalex",
      displayName: "BWCX BLUEWHALEX",
      isDefault: true,
      authentication: "authenticated" as const,
      control: "remote_control" as const,
      observedAt,
      notice: null,
    },
  ],
  accountCount: 1,
  models: [
    {
      modelId: "gpt-5.6-sol",
      displayName: "GPT-5.6 SOL",
      description: "Measured provider model",
      hidden: false,
      isDefault: true,
      inputModalities: ["text", "image"] as const,
      defaultReasoningEffort: "medium",
      reasoningEfforts: [
        { value: "medium", description: "Balanced" },
        { value: "high", description: "More reasoning" },
      ],
    },
  ],
  modelsState: "available" as const,
  usageState: "unavailable" as const,
  usageMeters: [],
};

describe("provider capability protocol", () => {
  it("accepts a truthful measured provider snapshot", () => {
    const snapshot = ProviderFleetSnapshotSchema.parse({
      snapshotId: "fleet-1",
      revision: 1,
      source: "terminal_registry",
      observedAt,
      staleAt: "2026-08-03T03:45:00.000Z",
      freshness: "live",
      degraded: false,
      providers: [provider],
      notice: null,
    });

    expect(snapshot.providers[0]?.models[0]?.inputModalities).toEqual([
      "text",
      "image",
    ]);
  });

  it("keeps unknown capability evidence distinct from unsupported", () => {
    const parsed = ProviderRecordSchema.parse(provider);
    expect(parsed.capabilities[1]?.state).toBe("unknown");
    expect(parsed.usageMeters).toEqual([]);
  });

  it("rejects raw paths, secrets, unknown fields, and control characters", () => {
    for (const candidate of [
      { ...provider, profilePath: "C:\\Users\\operator\\.codex" },
      { ...provider, apiKey: "secret" },
      { ...provider, displayName: "Codex\u001b[31m" },
    ]) {
      expect(() => ProviderRecordSchema.parse(candidate)).toThrow();
    }
  });

  it("bounds provider accounts and models", () => {
    expect(() =>
      ProviderRecordSchema.parse({
        ...provider,
        accounts: Array.from(
          { length: MAX_PROVIDER_ACCOUNTS + 1 },
          (_, index) => ({
            ...provider.accounts[0],
            accountId: `account-${index}`,
          }),
        ),
      }),
    ).toThrow();
    expect(() =>
      ProviderRecordSchema.parse({
        ...provider,
        models: Array.from({ length: MAX_PROVIDER_MODELS + 1 }, (_, index) => ({
          ...provider.models[0],
          modelId: `model-${index}`,
        })),
      }),
    ).toThrow();
  });

  it("supports a 15-provider fleet and rejects oversized inventories", () => {
    const providers = Array.from({ length: 15 }, (_, index) => ({
      ...provider,
      providerId: `provider-${index}`,
      displayName: `Provider ${index}`,
      adapterSupport: "inventory_only" as const,
      capabilities: [
        {
          key: "inventory" as const,
          state: "supported" as const,
          provenance: "terminal_registry" as const,
          observedAt,
          reason: null,
        },
      ],
      accounts: [],
      accountCount: 0,
      models: [],
      modelsState: "unavailable" as const,
    }));
    const snapshot = {
      snapshotId: "fleet-scale",
      revision: 1,
      source: "terminal_registry" as const,
      observedAt,
      staleAt: "2026-08-03T03:45:00.000Z",
      freshness: "live" as const,
      degraded: false,
      providers,
      notice: null,
    };

    expect(ProviderFleetSnapshotSchema.parse(snapshot).providers).toHaveLength(15);
    expect(() =>
      ProviderFleetSnapshotSchema.parse({
        ...snapshot,
        providers: Array.from(
          { length: MAX_PROVIDER_INVENTORY + 1 },
          (_, index) => ({
            ...providers[0],
            providerId: `oversized-${index}`,
            displayName: `Oversized ${index}`,
          }),
        ),
      }),
    ).toThrow();
  });

  it("rejects fabricated usage values without available evidence", () => {
    expect(() =>
      ProviderRecordSchema.parse({
        ...provider,
        usageState: "unavailable",
        usageMeters: [
          {
            meterId: "rolling",
            displayName: "Rolling",
            state: "unavailable",
            remainingPercent: 0,
            resetAt: null,
            detail: null,
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects duplicate capability, account, and model identities", () => {
    expect(() =>
      ProviderRecordSchema.parse({
        ...provider,
        capabilities: [provider.capabilities[0], provider.capabilities[0]],
      }),
    ).toThrow();
    expect(() =>
      ProviderRecordSchema.parse({
        ...provider,
        accounts: [provider.accounts[0], provider.accounts[0]],
        accountCount: 2,
      }),
    ).toThrow();
    expect(() =>
      ProviderRecordSchema.parse({
        ...provider,
        models: [provider.models[0], provider.models[0]],
      }),
    ).toThrow();
  });

  it("validates refresh and snapshot envelopes at every relay boundary", () => {
    const snapshot = ProviderFleetSnapshotSchema.parse({
      snapshotId: "fleet-1",
      revision: 1,
      source: "terminal_registry",
      observedAt,
      staleAt: "2026-08-03T03:45:00.000Z",
      freshness: "live",
      degraded: false,
      providers: [provider],
      notice: null,
    });

    expect(
      ClientEnvelopeSchema.parse(makeEnvelope("providers.refresh", {})).type,
    ).toBe("providers.refresh");
    expect(
      CoreToConnectorEnvelopeSchema.parse(
        makeEnvelope("connector.providers.refresh", {}),
      ).type,
    ).toBe("connector.providers.refresh");
    expect(
      ConnectorEnvelopeSchema.parse(
        makeEnvelope("connector.providers.snapshot", { snapshot }),
      ).type,
    ).toBe("connector.providers.snapshot");
    expect(
      ServerEnvelopeSchema.parse(
        makeEnvelope("providers.snapshot", { snapshot }),
      ).type,
    ).toBe("providers.snapshot");
  });
});
