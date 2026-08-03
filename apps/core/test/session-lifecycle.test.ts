import { startConnector } from "@aicl/connector";
import { MockProvider } from "@aicl/connector/mock-provider";
import { ProviderLostError } from "@aicl/connector/provider";
import {
  ServerEnvelopeSchema,
  makeEnvelope,
  websocketCapability,
  type ProviderFleetSnapshot,
  type ProviderCapabilityKey,
  type ProviderNativeSessionSnapshot,
  type ServerEnvelope,
} from "@aicl/protocol";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { startCoreServer } from "../src/server.js";

const handles: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(handles.splice(0).reverse().map((handle) => handle.close()));
});

class CountingProvider extends MockProvider {
  preparations = 0;

  override async prepareSession(
    ...args: Parameters<MockProvider["prepareSession"]>
  ) {
    this.preparations += 1;
    return super.prepareSession(...args);
  }
}

class LostPrepareProvider extends CountingProvider {
  override async prepareSession(
    ...args: Parameters<MockProvider["prepareSession"]>
  ): ReturnType<MockProvider["prepareSession"]> {
    void args;
    this.preparations += 1;
    throw new ProviderLostError("ambiguous provider preparation");
  }
}

class RacingPrepareProvider extends CountingProvider {
  #release: (() => void) | undefined;
  readonly #gate = new Promise<void>((resolve) => {
    this.#release = resolve;
  });

  override async prepareSession(
    ...args: Parameters<MockProvider["prepareSession"]>
  ) {
    this.preparations += 1;
    if (this.preparations === 2) this.#release?.();
    await this.#gate;
    return MockProvider.prototype.prepareSession.apply(this, args);
  }
}

describe("Session create and resume", () => {
  it("durably prepares, binds, deduplicates, and imports verified native Sessions", async () => {
    const core = await startCoreServer({ port: 0, dbPath: ":memory:" });
    handles.push(core);
    const provider = new CountingProvider();
    const connector = startConnector({
      coreUrl: core.connectorUrl,
      connectorToken: core.connectorToken,
      provider,
      providerName: "mock",
      providerInventory: (revision) => fleet(revision),
      providerNativeSessionIdentity: { providerId: "codex", accountId: "blue" },
      providerNativeSessions: (revision) => nativeSessions(revision),
    });
    handles.push(connector);
    await connector.ready;
    const browser = await openBrowser(core.browserUrl, core.browserToken);
    await waitFor(browser, (message) => message.type === "providers.snapshot");
    await waitFor(browser, (message) => message.type === "sessions.native.snapshot");

    browser.socket.send(
      JSON.stringify(
        makeEnvelope("turn.submit", {
          commandId: "unknown-turn",
          sessionId: "never-created",
          prompt: "must not create a Session",
        }),
      ),
    );
    const unknown = await waitFor(
      browser,
      (message) =>
        message.type === "command.rejected" &&
        message.payload.commandId === "unknown-turn",
    );
    if (unknown.type !== "command.rejected") throw new Error("rejection");
    expect(unknown.payload.error.code).toBe("SESSION_NOT_FOUND");

    for (const [commandId, providerId, accountId, model, code] of [
      ["invalid-provider", "missing", "blue", null, "PROVIDER_CAPABILITY_UNAVAILABLE"],
      ["inventory-provider", "grok", "grok-default", null, "PROVIDER_CAPABILITY_UNAVAILABLE"],
      ["invalid-account", "codex", "missing", null, "PROVIDER_CAPABILITY_UNAVAILABLE"],
      ["invalid-model", "codex", "blue", "not-advertised", "PROVIDER_MODEL_UNAVAILABLE"],
    ] as const) {
      browser.socket.send(
        JSON.stringify(
          makeEnvelope("session.create", {
            commandId,
            sessionId: `session-${commandId}`,
            deviceId: "device-one",
            title: commandId,
            providerId,
            accountId,
            projectPath: process.cwd(),
            model,
            reasoningLevel: null,
          }),
        ),
      );
      const rejected = await waitFor(
        browser,
        (message) =>
          message.type === "command.rejected" &&
          message.payload.commandId === commandId,
      );
      if (rejected.type !== "command.rejected") throw new Error("rejection");
      expect(rejected.payload.error.code).toBe(code);
    }

    const create = makeEnvelope("session.create", {
      commandId: "create-command",
      sessionId: "created-session",
      deviceId: "device-one",
      title: "Created Session",
      providerId: "codex",
      accountId: "blue",
      projectPath: process.cwd(),
      model: null,
      reasoningLevel: null,
    });
    browser.socket.send(JSON.stringify(create));
    await waitFor(
      browser,
      (message) =>
        message.type === "session.command.accepted" &&
        message.payload.commandId === "create-command",
    );
    const created = await waitFor(
      browser,
      (message) =>
        message.type === "session.provider.status" &&
        message.payload.commandId === "create-command",
    );
    expect(created.type).toBe("session.provider.status");
    if (created.type !== "session.provider.status") throw new Error("status");
    expect(created.payload).toMatchObject({
      status: "ready",
      providerSessionId: "mock-thread-created-session",
    });

    browser.socket.send(
      JSON.stringify(
        makeEnvelope("session.subscribe", {
          sessionId: "created-session",
          afterSeq: 0,
        }),
      ),
    );
    const capabilities = await waitFor(
      browser,
      (message) => message.type === "session.capabilities.snapshot",
    );
    if (capabilities.type !== "session.capabilities.snapshot") {
      throw new Error("capabilities");
    }
    expect(capabilities.payload.snapshot).toMatchObject({
      sessionId: "created-session",
      freshness: "live",
      provider: { providerId: "codex", state: "supported" },
      account: { accountId: "blue", state: "supported" },
      model: { modelId: null, state: "supported" },
      controlAuthority: { canControl: true, bindingStatus: "ready" },
      executionModes: [
        { mode: "ask", state: "supported" },
        { mode: "plan", state: "supported" },
        { mode: "auto", state: "supported" },
      ],
      attachments: [
        { kind: "text", state: "supported" },
        { kind: "image", state: "unknown" },
      ],
      fullAutoLease: { state: "unsupported" },
    });

    browser.socket.send(
      JSON.stringify(
        makeEnvelope("turn.submit", {
          commandId: "created-turn",
          sessionId: "created-session",
          prompt: "validated first Turn",
          settingsRevision: 0,
        }),
      ),
    );
    await waitFor(
      browser,
      (message) =>
        message.type === "sessions.snapshot" &&
        message.payload.sessions.some(
          (session) =>
            session.sessionId === "created-session" && session.state === "completed",
        ),
    );

    browser.socket.send(JSON.stringify(create));
    await waitUntil(
      () =>
        browser.messages.filter(
          (message) =>
            message.type === "session.command.accepted" &&
            message.payload.commandId === "create-command",
        ).length === 2,
    );
    expect(provider.preparations).toBe(1);

    browser.socket.send(
      JSON.stringify(
        makeEnvelope("session.resume", {
          commandId: "resume-command",
          sessionId: "imported-session",
          deviceId: "device-one",
          providerId: "codex",
          accountId: "blue",
          providerSessionId: "native-thread",
        }),
      ),
    );
    const resumed = await waitFor(
      browser,
      (message) =>
        message.type === "session.provider.status" &&
        message.payload.commandId === "resume-command",
    );
    if (resumed.type !== "session.provider.status") throw new Error("status");
    expect(resumed.payload).toMatchObject({
      status: "ready",
      providerSessionId: "native-thread",
    });

    requestCatalog(browser);
    const catalog = await waitFor(
      browser,
      (message) => message.type === "sessions.catalog.snapshot",
    );
    if (catalog.type !== "sessions.catalog.snapshot") throw new Error("catalog");
    expect(catalog.payload.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "created-session",
          source: "aicl",
          providerBindingStatus: "ready",
          canControl: true,
        }),
        expect.objectContaining({
          sessionId: "imported-session",
          source: "imported",
          providerSessionId: "native-thread",
          providerBindingStatus: "ready",
          canResume: true,
        }),
      ]),
    );

    browser.socket.send(
      JSON.stringify(
        makeEnvelope("session.resume", {
          commandId: "duplicate-import",
          sessionId: "must-not-exist",
          deviceId: "device-one",
          providerId: "codex",
          accountId: "blue",
          providerSessionId: "native-thread",
        }),
      ),
    );
    const duplicate = await waitFor(
      browser,
      (message) =>
        message.type === "command.rejected" &&
        message.payload.commandId === "duplicate-import",
    );
    if (duplicate.type !== "command.rejected") throw new Error("rejection");
    expect(duplicate.payload.error.code).toBe(
      "PROVIDER_SESSION_ALREADY_IMPORTED",
    );
    browser.socket.close();
  });

  it("settles an ambiguous provider preparation as outcome_unknown without replay", async () => {
    const core = await startCoreServer({ port: 0, dbPath: ":memory:" });
    handles.push(core);
    const provider = new LostPrepareProvider();
    const connector = startConnector({
      coreUrl: core.connectorUrl,
      connectorToken: core.connectorToken,
      provider,
      providerName: "mock",
      providerInventory: (revision) => fleet(revision),
    });
    handles.push(connector);
    await connector.ready;
    const browser = await openBrowser(core.browserUrl, core.browserToken);
    await waitFor(browser, (message) => message.type === "providers.snapshot");
    const command = makeEnvelope("session.create", {
      commandId: "ambiguous-create",
      sessionId: "ambiguous-session",
      deviceId: "device-one",
      title: "Ambiguous create",
      providerId: "codex",
      accountId: "blue",
      projectPath: process.cwd(),
      model: null,
      reasoningLevel: null,
    });
    browser.socket.send(JSON.stringify(command));
    const status = await waitFor(
      browser,
      (message) =>
        message.type === "session.provider.status" &&
        message.payload.commandId === "ambiguous-create",
    );
    if (status.type !== "session.provider.status") throw new Error("status");
    expect(status.payload.status).toBe("outcome_unknown");
    browser.socket.send(JSON.stringify(command));
    await waitUntil(
      () =>
        browser.messages.filter(
          (message) =>
            message.type === "session.command.accepted" &&
            message.payload.commandId === "ambiguous-create",
        ).length === 2,
    );
    expect(provider.preparations).toBe(1);
    browser.socket.close();
  });

  it("settles a concurrent import collision without stranding either command", async () => {
    const core = await startCoreServer({ port: 0, dbPath: ":memory:" });
    handles.push(core);
    const provider = new RacingPrepareProvider();
    const connector = startConnector({
      coreUrl: core.connectorUrl,
      connectorToken: core.connectorToken,
      provider,
      providerName: "mock",
      providerInventory: (revision) => fleet(revision),
      providerNativeSessionIdentity: { providerId: "codex", accountId: "blue" },
      providerNativeSessions: (revision) => nativeSessions(revision),
    });
    handles.push(connector);
    await connector.ready;
    const browser = await openBrowser(core.browserUrl, core.browserToken);
    await waitFor(browser, (message) => message.type === "providers.snapshot");
    await waitFor(browser, (message) => message.type === "sessions.native.snapshot");

    for (const suffix of ["a", "b"] as const) {
      browser.socket.send(
        JSON.stringify(
          makeEnvelope("session.resume", {
            commandId: `race-resume-${suffix}`,
            sessionId: `race-session-${suffix}`,
            deviceId: "device-one",
            providerId: "codex",
            accountId: "blue",
            providerSessionId: "native-thread",
          }),
        ),
      );
    }
    await waitUntil(
      () =>
        browser.messages.filter(
          (message) =>
            message.type === "session.provider.status" &&
            message.payload.commandId.startsWith("race-resume-"),
        ).length === 2,
    );
    const outcomes = browser.messages
      .filter(
        (message): message is Extract<
          ServerEnvelope,
          { type: "session.provider.status" }
        > =>
          message.type === "session.provider.status" &&
          message.payload.commandId.startsWith("race-resume-"),
      )
      .map((message) => ({
        status: message.payload.status,
        failureCode: message.payload.failureCode,
      }));
    expect(outcomes).toEqual(
      expect.arrayContaining([
        { status: "ready", failureCode: null },
        {
          status: "failed",
          failureCode: "PROVIDER_SESSION_ALREADY_IMPORTED",
        },
      ]),
    );
    browser.socket.close();
  });
});

function fleet(revision: number): ProviderFleetSnapshot {
  const observedAt = new Date().toISOString();
  return {
    snapshotId: `fleet-${revision}`,
    revision,
    source: "terminal_registry",
    observedAt,
    staleAt: new Date(Date.now() + 60_000).toISOString(),
    freshness: "live",
    degraded: false,
    notice: null,
    providers: [
      {
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
          "remote_control",
          "list_sessions",
          "create_session",
          "resume_session",
          "text_input",
          "execution_modes",
          "approval_policies",
          "sandbox_policies",
        ].map(
          (key) => ({
            key: key as ProviderCapabilityKey,
            state: "supported" as const,
            provenance: "provider_probe" as const,
            observedAt,
            reason: null,
          }),
        ),
        accounts: [
          {
            accountId: "blue",
            displayName: "Blue",
            isDefault: true,
            authentication: "authenticated",
            control: "remote_control",
            observedAt,
            notice: null,
          },
        ],
        accountCount: 1,
        models: [],
        modelsState: "available",
        usageState: "not_supported",
        usageMeters: [],
      },
      {
        providerId: "grok",
        displayName: "Grok",
        enabled: true,
        installation: "installed",
        authentication: "unknown",
        compatibility: "unknown",
        adapterSupport: "inventory_only",
        version: null,
        freshness: "local",
        observedAt,
        notice: "Inventory only",
        capabilities: [],
        accounts: [
          {
            accountId: "grok-default",
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
        usageState: "unavailable",
        usageMeters: [],
      },
    ],
  };
}

function nativeSessions(revision: number): ProviderNativeSessionSnapshot {
  const observedAt = new Date().toISOString();
  return {
    snapshotId: `native-${revision}`,
    revision,
    providerId: "codex",
    accountId: "blue",
    observedAt,
    staleAt: new Date(Date.now() + 60_000).toISOString(),
    freshness: "live",
    truncated: false,
    notice: null,
    sessions: [
      {
        providerId: "codex",
        accountId: "blue",
        providerSessionId: "native-thread",
        title: "Native title",
        preview: "Native preview",
        projectPath: process.cwd(),
        projectName: "project",
        branch: "main",
        providerStatus: "idle",
        createdAt: observedAt,
        updatedAt: observedAt,
        pinned: false,
        archived: false,
        canResume: true,
      },
    ],
  };
}

function requestCatalog(browser: BrowserHarness) {
  browser.socket.send(
    JSON.stringify(
      makeEnvelope("sessions.catalog.list", {
        requestId: "catalog-after-bind",
        deviceId: "device-one",
        pageSize: 100,
        cursor: null,
        filters: {
          search: null,
          providerIds: [],
          accountIds: [],
          states: [],
          project: null,
          archived: "exclude",
          pinned: null,
        },
      }),
    ),
  );
}

interface BrowserHarness {
  socket: WebSocket;
  messages: ServerEnvelope[];
}

async function openBrowser(url: string, token: string): Promise<BrowserHarness> {
  const socket = new WebSocket(url, websocketCapability("browser", token), {
    origin: "http://127.0.0.1:5173",
  });
  const messages: ServerEnvelope[] = [];
  socket.on("message", (data) => {
    messages.push(ServerEnvelopeSchema.parse(JSON.parse(data.toString())));
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, messages };
}

async function waitFor(
  browser: BrowserHarness,
  predicate: (message: ServerEnvelope) => boolean,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = browser.messages.find(predicate);
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for Session lifecycle message: ${JSON.stringify(browser.messages.slice(-12))}`,
  );
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for Session lifecycle state");
}
