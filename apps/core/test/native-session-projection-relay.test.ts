import { startConnector } from "@aicl/connector";
import { MockProvider } from "@aicl/connector/mock-provider";
import type {
  ConnectorEmit,
  ManagedProviderAccount,
  NativeSessionProjectionInput,
  ProviderAccountController,
  TurnStartCommand,
} from "@aicl/connector/provider";
import {
  ServerEnvelopeSchema,
  makeEnvelope,
  websocketCapability,
  type ProviderFleetSnapshot,
  type ProviderSessionProjectionSnapshot,
  type ServerEnvelope,
} from "@aicl/protocol";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { startCoreServer } from "../src/server.js";

const handles: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(handles.splice(0).reverse().map((handle) => handle.close()));
});

describe("provider-native projection relay", () => {
  it("fences and relays an exact account Session without dispatching a Turn", async () => {
    const controller = new ProjectionController();
    const core = await startCoreServer({ port: 0, dbPath: ":memory:" });
    handles.push(core);
    const provider = new CountingProvider();
    const connector = startConnector({
      coreUrl: core.connectorUrl,
      connectorToken: core.connectorToken,
      provider,
      providerName: "mock",
      providerInventory: fleet,
      providerAccountController: controller,
    });
    handles.push(connector);
    await connector.ready;
    const browser = await openBrowser(core.browserUrl, core.browserToken);
    const inventory = await waitForInventory(browser);
    expect(inventory.payload.snapshot.providers[0]).toMatchObject({
      providerId: "codex",
      enabled: true,
      accounts: expect.arrayContaining([expect.objectContaining({ accountId: "blue" })]),
    });
    await waitForType(browser, "runtime.status");

    requestProjection(browser, "request-blue", "blue", "same-thread");
    const result = await waitForProjection(browser, "request-blue");

    expect(controller.inputs).toHaveLength(1);
    expect(result.payload.snapshot.notice).toBeNull();
    expect(result.payload.snapshot).toMatchObject({
      providerId: "codex",
      accountId: "blue",
      providerSessionId: "same-thread",
      availability: "available",
      state: "working",
    });
    expect(controller.inputs[0]).toMatchObject({
      providerId: "codex",
      accountId: "blue",
      providerSessionId: "same-thread",
    });
    expect(provider.turnStarts).toBe(0);
    browser.socket.close();
  });

  it("does not collide when two accounts expose the same provider Session ID", async () => {
    const controller = new ProjectionController();
    const core = await startCoreServer({ port: 0, dbPath: ":memory:" });
    handles.push(core);
    const connector = startConnector({
      coreUrl: core.connectorUrl,
      connectorToken: core.connectorToken,
      provider: new MockProvider(),
      providerName: "mock",
      providerInventory: fleet,
      providerAccountController: controller,
    });
    handles.push(connector);
    await connector.ready;
    const browser = await openBrowser(core.browserUrl, core.browserToken);
    await waitForInventory(browser);
    await waitForType(browser, "runtime.status");

    requestProjection(browser, "request-blue", "blue", "same-thread");
    requestProjection(browser, "request-green", "green", "same-thread");
    const blue = await waitForProjection(browser, "request-blue");
    const green = await waitForProjection(browser, "request-green");

    expect(blue.payload.snapshot.accountId).toBe("blue");
    expect(green.payload.snapshot.accountId).toBe("green");
    expect(blue.payload.snapshot.items[0]).not.toEqual(
      green.payload.snapshot.items[0],
    );
    browser.socket.close();
  });

  it("reports provider loss as unavailable instead of fabricating idle", async () => {
    const core = await startCoreServer({ port: 0, dbPath: ":memory:" });
    handles.push(core);
    const connector = startConnector({
      coreUrl: core.connectorUrl,
      connectorToken: core.connectorToken,
      provider: new MockProvider(),
      providerName: "mock",
      providerInventory: fleet,
      providerAccountController: new ProjectionController(),
    });
    handles.push(connector);
    await connector.ready;
    const browser = await openBrowser(core.browserUrl, core.browserToken);
    await connector.close();
    handles.splice(handles.indexOf(connector), 1);

    requestProjection(browser, "request-offline", "blue", "same-thread");
    const result = await waitForProjection(browser, "request-offline");

    expect(result.payload.snapshot).toMatchObject({
      freshness: "unavailable",
      availability: "unavailable",
      state: "unavailable",
      items: [],
      notice: "Remote activity unavailable",
    });
    browser.socket.close();
  });

  it("fails stale provider evidence closed at the Core fence", async () => {
    const controller = new ProjectionController();
    controller.stale = true;
    const core = await startCoreServer({ port: 0, dbPath: ":memory:" });
    handles.push(core);
    const connector = startConnector({
      coreUrl: core.connectorUrl,
      connectorToken: core.connectorToken,
      provider: new MockProvider(),
      providerName: "mock",
      providerInventory: fleet,
      providerAccountController: controller,
    });
    handles.push(connector);
    await connector.ready;
    const browser = await openBrowser(core.browserUrl, core.browserToken);
    await waitForInventory(browser);
    await waitForType(browser, "runtime.status");

    requestProjection(browser, "request-stale", "blue", "same-thread");
    const result = await waitForProjection(browser, "request-stale");

    expect(result.payload.snapshot).toMatchObject({
      availability: "unavailable",
      freshness: "unavailable",
      state: "unavailable",
      items: [],
      notice: "Provider history unavailable",
    });
    browser.socket.close();
  });

  it("reports unsupported providers without pretending they are idle", async () => {
    const core = await startCoreServer({ port: 0, dbPath: ":memory:" });
    handles.push(core);
    const connector = startConnector({
      coreUrl: core.connectorUrl,
      connectorToken: core.connectorToken,
      provider: new MockProvider(),
      providerName: "mock",
      providerInventory: fleetWithUnsupported,
      providerAccountController: new ProjectionController(),
    });
    handles.push(connector);
    await connector.ready;
    const browser = await openBrowser(core.browserUrl, core.browserToken);
    await waitForInventory(browser);
    await waitForType(browser, "runtime.status");

    requestProjection(browser, "request-unsupported", "only", "claude-thread", "claude");
    const result = await waitForProjection(browser, "request-unsupported");

    expect(result.payload.snapshot).toMatchObject({
      providerId: "claude",
      accountId: "only",
      availability: "unsupported",
      state: "unavailable",
      items: [],
      notice: "Remote activity unavailable",
    });
    browser.socket.close();
  });
});

class ProjectionController implements ProviderAccountController {
  inputs: NativeSessionProjectionInput[] = [];
  stale = false;

  open(): ManagedProviderAccount | null {
    return null;
  }

  rememberIdentity() {}

  async nativeSessionPage(): Promise<never> {
    throw new Error("Not used");
  }

  async nativeSessionProjection(
    input: NativeSessionProjectionInput,
  ): Promise<ProviderSessionProjectionSnapshot> {
    this.inputs.push(input);
    const observed = this.stale ? Date.now() - 10_000 : Date.now();
    const observedAt = new Date(observed).toISOString();
    return {
      projectionId: `projection-${input.accountId}`,
      revision: input.revision,
      providerId: input.providerId,
      accountId: input.accountId,
      providerSessionId: input.providerSessionId,
      providerRevision: "provider-revision-1",
      providerCursor: null,
      observedAt,
      staleAt: new Date(observed + 5_000).toISOString(),
      freshness: "live",
      availability: "available",
      runtimeId: input.runtimeId,
      runtimeGeneration: input.runtimeGeneration,
      title: `Thread ${input.accountId}`,
      projectLabel: "mission-control",
      state: "working",
      activeSince: observedAt,
      truncated: false,
      notice: null,
      items: [
        {
          type: "assistant_progress",
          providerTurnId: "turn-1",
          providerItemId: `progress-${input.accountId}`,
          order: 0,
          progressType: "commentary",
          status: "streaming",
          text: `Working in ${input.accountId}`,
        },
      ],
    };
  }
}

class CountingProvider extends MockProvider {
  turnStarts = 0;

  override async startTurn(command: TurnStartCommand, emit: ConnectorEmit) {
    this.turnStarts += 1;
    return super.startTurn(command, emit);
  }
}

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
        adapterSupport: "inventory_only",
        version: "0.146.0",
        freshness: "local",
        observedAt,
        notice: null,
        capabilities: [
          {
            key: "list_sessions",
            state: "supported",
            provenance: "provider_probe",
            observedAt,
            reason: null,
          },
        ],
        accounts: ["blue", "green"].map((accountId, index) => ({
          accountId,
          displayName: accountId,
          isDefault: index === 0,
          authentication: "authenticated" as const,
          control: "inventory_only" as const,
          observedAt,
          notice: null,
        })),
        accountCount: 2,
        models: [],
        modelsState: "unavailable",
        usageState: "unavailable",
        usageMeters: [],
      },
    ],
  };
}

function fleetWithUnsupported(revision: number): ProviderFleetSnapshot {
  const snapshot = fleet(revision);
  const observedAt = snapshot.observedAt;
  return {
    ...snapshot,
    providers: [
      ...snapshot.providers,
      {
        providerId: "claude",
        displayName: "Claude Code",
        enabled: true,
        installation: "installed",
        authentication: "authenticated",
        compatibility: "compatible",
        adapterSupport: "inventory_only",
        version: "1.0.0",
        freshness: "local",
        observedAt,
        notice: null,
        capabilities: [],
        accounts: [{
          accountId: "only",
          displayName: "Only",
          isDefault: true,
          authentication: "authenticated",
          control: "inventory_only",
          observedAt,
          notice: null,
        }],
        accountCount: 1,
        models: [],
        modelsState: "unavailable",
        usageState: "unavailable",
        usageMeters: [],
      },
    ],
  };
}

interface BrowserHarness {
  socket: WebSocket;
  messages: ServerEnvelope[];
}

function requestProjection(
  browser: BrowserHarness,
  requestId: string,
  accountId: string,
  providerSessionId: string,
  providerId = "codex",
) {
  browser.socket.send(
    JSON.stringify(
      makeEnvelope("provider.session.projection.get", {
        requestId,
        providerId,
        accountId,
        providerSessionId,
      }),
    ),
  );
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

async function waitForProjection(browser: BrowserHarness, requestId: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const message = browser.messages.find(
      (candidate): candidate is Extract<
        ServerEnvelope,
        { type: "provider.session.projection.snapshot" }
      > =>
        candidate.type === "provider.session.projection.snapshot" &&
        candidate.payload.requestId === requestId,
    );
    if (message !== undefined) return message;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${requestId}`);
}

async function waitForType<T extends ServerEnvelope["type"]>(
  browser: BrowserHarness,
  type: T,
): Promise<Extract<ServerEnvelope, { type: T }>> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const message = browser.messages.find(
      (candidate): candidate is Extract<ServerEnvelope, { type: T }> =>
        candidate.type === type,
    );
    if (message !== undefined) return message;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${type}`);
}

async function waitForInventory(browser: BrowserHarness) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const message = browser.messages.find(
      (candidate): candidate is Extract<
        ServerEnvelope,
        { type: "providers.snapshot" }
      > =>
        candidate.type === "providers.snapshot" &&
        candidate.payload.snapshot.providers.some(
          (provider) => provider.providerId === "codex" && provider.enabled,
        ),
    );
    if (message !== undefined) return message;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for Codex inventory");
}
