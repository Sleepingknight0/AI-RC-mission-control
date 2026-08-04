import { resolve } from "node:path";

import {
  CoreToConnectorEnvelopeSchema,
  MAX_PROVIDER_NATIVE_SESSIONS,
  ProviderCapabilityKeySchema,
  ProviderFleetSnapshotSchema,
  makeEnvelope,
} from "@aicl/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { CodexProvider } from "../src/codex/adapter.js";
import {
  discoverCodexNativeSessions,
  probeCodexCapabilities,
} from "../src/codex/discovery.js";

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
  it("treats nullish accounts as logged out and rejects malformed accounts", async () => {
    const request = (account: unknown) => ({
      async request(method: string) {
        if (method === "account/read") return account;
        if (method === "model/list") return { data: [], nextCursor: null };
        throw new Error(`Unexpected provider method: ${method}`);
      },
    });

    await expect(
      probeCodexCapabilities(request({ account: null, requiresOpenaiAuth: true })),
    ).resolves.toMatchObject({ authenticated: false });
    await expect(
      probeCodexCapabilities(request({ requiresOpenaiAuth: true })),
    ).resolves.toMatchObject({ authenticated: false });
    await expect(
      probeCodexCapabilities(
        request({
          account: { type: "unknown" },
          requiresOpenaiAuth: true,
        }),
      ),
    ).rejects.toThrow();
  });

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

  it("removes optimistic control authority when the live probe fails", async () => {
    const snapshot = fleet();
    const codex = snapshot.providers[0]!;
    const optimistic = ProviderFleetSnapshotSchema.parse({
      ...snapshot,
      providers: [
        {
          ...codex,
          authentication: "authenticated",
          adapterSupport: "remote_control",
          capabilities: codex.capabilities.map((capability) =>
            capability.key === "remote_control"
              ? { ...capability, state: "supported" }
              : capability,
          ),
          accounts: codex.accounts.map((account) => ({
            ...account,
            authentication: "authenticated",
            control: "remote_control",
          })),
        },
      ],
    });
    const unavailable = new CodexProvider({
      cwd: process.cwd(),
      command: resolve("test/does-not-exist-codex.mjs"),
      timeoutMs: 100,
    });
    providers.push(unavailable);

    const result = await unavailable.enrichProviderFleet(optimistic, "default");
    expect(result.degraded).toBe(true);
    expect(result.providers[0]).toMatchObject({
      authentication: "unknown",
      adapterSupport: "inventory_only",
      freshness: "local",
      accounts: [
        {
          accountId: "default",
          authentication: "unknown",
          control: "inventory_only",
        },
      ],
    });
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

  it("does not offer a provider-native Session that is already active", async () => {
    const snapshot = await discoverCodexNativeSessions(
      {
        async request(method) {
          if (method !== "thread/list") throw new Error("Unexpected method");
          return {
            data: [
              {
                id: "native-active",
                name: "Externally active",
                preview: "busy",
                cwd: process.cwd(),
                createdAt: 1_700_000_000,
                updatedAt: 1_700_000_100,
                status: { type: "active" },
              },
            ],
            nextCursor: null,
          };
        },
      },
      {
        providerId: "codex",
        accountId: "default",
        allowedRoots: [process.cwd()],
        revision: 1,
      },
    );

    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]).toMatchObject({
      providerStatus: "active",
      canResume: false,
    });
  });

  it("marks include-archive discovery truncated instead of issuing a zero-limit page", async () => {
    const archivedCalls: boolean[] = [];
    const snapshot = await discoverCodexNativeSessions(
      {
        async request(method, params) {
          if (method !== "thread/list") throw new Error("Unexpected method");
          const input = params as { archived: boolean; cursor: string | null };
          archivedCalls.push(input.archived);
          const page = input.cursor === null ? 0 : Number(input.cursor);
          return {
            data: Array.from({ length: 100 }, (_, index) => {
              const ordinal = page * 100 + index;
              return {
                id: `native-${ordinal}`,
                name: `Native ${ordinal}`,
                preview: "bounded discovery",
                cwd: process.cwd(),
                createdAt: 1_700_000_000 + ordinal,
                updatedAt: 1_700_000_000 + ordinal,
                status: { type: "idle" },
              };
            }),
            nextCursor: page < 4 ? String(page + 1) : null,
          };
        },
      },
      {
        providerId: "codex",
        accountId: "default",
        allowedRoots: [process.cwd()],
        revision: 1,
        archived: "include",
      },
    );

    expect(snapshot.sessions).toHaveLength(MAX_PROVIDER_NATIVE_SESSIONS);
    expect(snapshot.truncated).toBe(true);
    expect(archivedCalls).toEqual([false, false, false, false, false]);
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
