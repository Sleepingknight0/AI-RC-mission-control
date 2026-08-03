import { resolve } from "node:path";

import {
  CoreToConnectorEnvelopeSchema,
  ProviderCapabilityKeySchema,
  ProviderFleetSnapshotSchema,
  makeEnvelope,
} from "@aicl/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { CodexProvider } from "../src/codex/adapter.js";
import { probeCodexCapabilities } from "../src/codex/discovery.js";

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
  it("treats a present account as authenticated when OpenAI auth is required", async () => {
    const probe = await probeCodexCapabilities({
      async request(method) {
        if (method === "account/read") {
          return {
            account: {
              type: "chatgpt",
              email: null,
              planType: "plus",
            },
            requiresOpenaiAuth: true,
          };
        }
        if (method === "model/list") {
          return { data: [], nextCursor: null };
        }
        throw new Error(`Unexpected provider method: ${method}`);
      },
    });

    expect(probe.authenticated).toBe(true);
  });

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

  it("creates and resumes explicit provider Sessions with verified selections", async () => {
    const provider = adapter();
    const createCommand = CoreToConnectorEnvelopeSchema.parse(
        makeEnvelope("connector.session.create", {
          commandId: "create-1",
          sessionId: "session-create",
          providerId: "codex",
          accountId: "default",
          projectPath: process.cwd(),
          model: "fake-codex-model",
          reasoningLevel: "high",
          runtimeId: "runtime-1",
          runtimeGeneration: 1,
        }),
      );
    if (createCommand.type !== "connector.session.create") throw new Error("type");
    const created = await provider.prepareSession(createCommand);
    expect(created).toMatchObject({
      providerSessionId: "fake-thread",
      projectPath: process.cwd(),
      model: "fake-codex-model",
      reasoningLevel: "high",
    });

    const resumeCommand = CoreToConnectorEnvelopeSchema.parse(
        makeEnvelope("connector.session.resume", {
          commandId: "resume-1",
          sessionId: "session-resume",
          providerId: "codex",
          accountId: "default",
          providerSessionId: "native-thread",
          projectPath: process.cwd(),
          model: null,
          reasoningLevel: null,
          runtimeId: "runtime-1",
          runtimeGeneration: 1,
        }),
      );
    if (resumeCommand.type !== "connector.session.resume") throw new Error("type");
    const resumed = await provider.prepareSession(resumeCommand);
    expect(resumed.providerSessionId).toBe("native-thread");
  });
});
