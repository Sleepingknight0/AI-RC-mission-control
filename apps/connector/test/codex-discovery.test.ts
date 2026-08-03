import { resolve } from "node:path";

import {
  ProviderCapabilityKeySchema,
  ProviderFleetSnapshotSchema,
} from "@aicl/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { CodexProvider } from "../src/codex/adapter.js";

const providers: CodexProvider[] = [];
const fakeCommand = resolve("test/fake-codex-app-server.mjs");

afterEach(async () => {
  await Promise.allSettled(providers.splice(0).map((provider) => provider.close()));
});

function adapter() {
  const provider = new CodexProvider({
    cwd: process.cwd(),
    command: fakeCommand,
  });
  providers.push(provider);
  return provider;
}

function fleet() {
  const observedAt = "2026-08-03T04:00:00.000Z";
  return ProviderFleetSnapshotSchema.parse({
    snapshotId: "fleet-test",
    revision: 1,
    source: "terminal_registry",
    observedAt,
    staleAt: "2026-08-03T04:05:00.000Z",
    freshness: "local",
    degraded: false,
    notice: null,
    providers: [
      {
        providerId: "codex",
        displayName: "Codex",
        enabled: true,
        installation: "installed",
        authentication: "unknown",
        compatibility: "compatible",
        adapterSupport: "inventory_only",
        version: "0.146.0",
        freshness: "local",
        observedAt,
        notice: null,
        capabilities: ProviderCapabilityKeySchema.options.map((key) => ({
          key,
          state: "unknown",
          provenance: "adapter_manifest",
          observedAt,
          reason: null,
        })),
        accounts: [
          {
            accountId: "default",
            displayName: "Default",
            isDefault: true,
            authentication: "unknown",
            control: "inventory_only",
            observedAt,
            notice: null,
          },
        ],
        accountCount: 1,
        models: [],
        modelsState: "unavailable",
        usageState: "not_supported",
        usageMeters: [],
      },
    ],
  });
}

describe("Codex discovery", () => {
  it("probes account and models without exposing account identity", async () => {
    const snapshot = await adapter().enrichProviderFleet(fleet(), "default");
    const codex = snapshot.providers[0];

    expect(codex?.authentication).toBe("authenticated");
    expect(codex?.adapterSupport).toBe("remote_control");
    expect(codex?.accounts[0]?.control).toBe("remote_control");
    expect(codex?.models).toMatchObject([
      {
        modelId: "fake-codex-model",
        inputModalities: ["text", "image"],
        defaultReasoningEffort: "medium",
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("example.invalid");
  });

  it("discovers active and archived native Sessions within allowed roots", async () => {
    const snapshot = await adapter().discoverNativeSessions({
      accountId: "default",
      allowedRoots: [process.cwd()],
      revision: 3,
    });

    expect(snapshot.revision).toBe(3);
    expect(snapshot.sessions.map((session) => session.providerSessionId)).toEqual([
      "fake-native-active",
      "fake-native-archived",
    ]);
    expect(snapshot.sessions[0]).toMatchObject({
      title: "Active native work",
      projectPath: process.cwd(),
      branch: "main",
      archived: false,
      canResume: true,
    });
    expect(JSON.stringify(snapshot)).not.toContain("rollout");
  });
});
