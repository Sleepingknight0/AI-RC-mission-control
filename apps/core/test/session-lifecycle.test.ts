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
        capabilities: ["remote_control", "list_sessions", "create_session", "resume_session"].map(
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
  throw new Error("Timed out waiting for Session lifecycle message");
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for Session lifecycle state");
}
