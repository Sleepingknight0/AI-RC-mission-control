import { startConnector } from "@aicl/connector";
import { MockProvider } from "@aicl/connector/mock-provider";
import {
  ServerEnvelopeSchema,
  makeEnvelope,
  websocketCapability,
  type ProviderFleetSnapshot,
  type ProviderNativeSessionSnapshot,
  type ServerEnvelope,
} from "@aicl/protocol";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { startCoreServer } from "../src/server.js";

interface BrowserHarness {
  socket: WebSocket;
  messages: ServerEnvelope[];
}

const handles: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(handles.splice(0).reverse().map((handle) => handle.close()));
});

describe("provider inventory relay", () => {
  it("bootstraps and refreshes an authoritative snapshot without durable history", async () => {
    const core = await startCoreServer({ port: 0, dbPath: ":memory:" });
    handles.push(core);
    const connector = startConnector({
      coreUrl: core.connectorUrl,
      connectorToken: core.connectorToken,
      provider: new MockProvider(),
      providerName: "mock",
      providerInventory: (revision) => fleet(revision),
    });
    handles.push(connector);
    await connector.ready;

    const first = await openBrowser(core.browserUrl, core.browserToken);
    const initial = await waitFor(first, "providers.snapshot");
    expect(initial.payload.snapshot.providers[0]?.providerId).toBe("codex");
    expect(initial.payload.snapshot.providers[0]?.accounts).toHaveLength(2);

    first.socket.send(JSON.stringify(makeEnvelope("providers.refresh", {})));
    await waitUntil(
      () =>
        first.messages.filter((message) => message.type === "providers.snapshot")
          .length >= 3,
    );
    const revisions = first.messages
      .filter(
        (message): message is Extract<
          ServerEnvelope,
          { type: "providers.snapshot" }
        > => message.type === "providers.snapshot",
      )
      .map((message) => message.payload.snapshot.revision);
    expect(Math.max(...revisions)).toBeGreaterThan(1);

    first.socket.close();
    const reconnected = await openBrowser(core.browserUrl, core.browserToken);
    expect((await waitFor(reconnected, "providers.snapshot")).payload.snapshot.revision)
      .toBe(Math.max(...revisions));

    await connector.close();
    handles.splice(handles.indexOf(connector), 1);
    await waitUntil(() =>
      reconnected.messages.some(
        (message) =>
          message.type === "providers.snapshot" &&
          message.payload.snapshot.freshness === "stale",
      ),
    );
    reconnected.socket.close();
  });

  it("isolates inventory timeout from Turn control", async () => {
    const core = await startCoreServer({ port: 0, dbPath: ":memory:" });
    handles.push(core);
    const connector = startConnector({
      coreUrl: core.connectorUrl,
      connectorToken: core.connectorToken,
      provider: new MockProvider(10),
      providerName: "mock",
      providerInventory: () => new Promise<ProviderFleetSnapshot>(() => undefined),
      providerInventoryTimeoutMs: 25,
    });
    handles.push(connector);
    await connector.ready;

    const browser = await openBrowser(core.browserUrl, core.browserToken);
    browser.socket.send(
      JSON.stringify(
        makeEnvelope("session.subscribe", {
          sessionId: "inventory-timeout-session",
          afterSeq: 0,
        }),
      ),
    );
    await waitFor(browser, "session.snapshot");
    browser.socket.send(
      JSON.stringify(
        makeEnvelope("turn.submit", {
          commandId: "inventory-timeout-command",
          sessionId: "inventory-timeout-session",
          prompt: "inventory must not block this Turn",
        }),
      ),
    );

    await waitFor(browser, "turn.completed");
    const unavailable = await waitFor(browser, "providers.snapshot");
    expect(unavailable.payload.snapshot.source).toBe("unavailable");
    expect(unavailable.payload.snapshot.providers).toEqual([]);
    browser.socket.close();
  });

  it("relays, refreshes, reconnects, and stales native Session snapshots", async () => {
    const core = await startCoreServer({ port: 0, dbPath: ":memory:" });
    handles.push(core);
    let refreshes = 0;
    const connector = startConnector({
      coreUrl: core.connectorUrl,
      connectorToken: core.connectorToken,
      provider: new MockProvider(),
      providerName: "mock",
      providerInventory: (revision) => fleet(revision),
      providerNativeSessionIdentity: { providerId: "codex", accountId: "blue" },
      providerNativeSessions: (revision) => {
        refreshes += 1;
        return nativeSessions(revision);
      },
    });
    handles.push(connector);
    await connector.ready;

    const browser = await openBrowser(core.browserUrl, core.browserToken);
    const initial = await waitFor(browser, "sessions.native.snapshot");
    expect(initial.payload.snapshot.sessions[0]?.providerSessionId).toBe(
      "thread-native-1",
    );
    const before = refreshes;
    browser.socket.send(
      JSON.stringify(
        makeEnvelope("sessions.native.refresh", {
          providerId: "codex",
          accountId: "blue",
        }),
      ),
    );
    await waitUntil(() => refreshes > before);

    browser.socket.send(
      JSON.stringify(
        makeEnvelope("sessions.native.refresh", {
          providerId: "codex",
          accountId: "green",
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(refreshes).toBe(before + 1);

    browser.socket.close();
    const reconnected = await openBrowser(core.browserUrl, core.browserToken);
    expect(
      (await waitFor(reconnected, "sessions.native.snapshot")).payload.snapshot
        .sessions,
    ).toHaveLength(1);

    await connector.close();
    handles.splice(handles.indexOf(connector), 1);
    await waitUntil(() =>
      reconnected.messages.some(
        (message) =>
          message.type === "sessions.native.snapshot" &&
          message.payload.snapshot.freshness === "stale",
      ),
    );
    reconnected.socket.close();
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
    freshness: "local",
    degraded: false,
    notice: null,
    providers: [
      {
        providerId: "codex",
        displayName: "OpenAI Codex",
        enabled: true,
        installation: "installed",
        authentication: "authenticated",
        compatibility: "compatible",
        adapterSupport: "remote_control",
        version: "0.146.0",
        freshness: "local",
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
            key: "list_sessions",
            state: "supported",
            provenance: "provider_probe",
            observedAt,
            reason: null,
          },
        ],
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
          {
            accountId: "green",
            displayName: "Green",
            isDefault: false,
            authentication: "authenticated",
            control: "inventory_only",
            observedAt,
            notice: null,
          },
        ],
        accountCount: 2,
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
        providerSessionId: "thread-native-1",
        title: "Native Session",
        preview: null,
        projectPath: process.cwd(),
        projectName: "project",
        branch: null,
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

async function waitFor<T extends ServerEnvelope["type"]>(
  browser: BrowserHarness,
  type: T,
  timeoutMs = 3_000,
): Promise<Extract<ServerEnvelope, { type: T }>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = browser.messages.find(
      (message): message is Extract<ServerEnvelope, { type: T }> =>
        message.type === type,
    );
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${type}`);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for inventory state");
}
