import { createServer } from "node:http";

import {
  ConnectorEnvelopeSchema,
  makeEnvelope,
  type ConnectorEnvelope,
  type ProviderFleetSnapshot,
} from "@aicl/protocol";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runConnectorCleanupStages, startConnector } from "../src/client.js";
import { MockProvider } from "../src/mock-provider.js";
import type { ProviderAccountController } from "../src/provider.js";

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
});

describe("Connector lifecycle", () => {
  it("runs every cleanup stage before surfacing observer shutdown failure", async () => {
    const completed: string[] = [];

    await expect(runConnectorCleanupStages([
      async () => {
        completed.push("provider");
      },
      async () => {
        completed.push("observers");
        throw new Error("observer close failed");
      },
      () => {
        completed.push("attachments");
      },
      async () => {
        completed.push("health");
      },
      () => {
        completed.push("journal");
      },
    ])).rejects.toThrow("Connector cleanup failed");

    expect(completed).toEqual([
      "provider",
      "observers",
      "attachments",
      "health",
      "journal",
    ]);
  });

  it("closes native observers before committing a provider disable", async () => {
    const httpServer = createServer();
    const webSocketServer = new WebSocketServer({ server: httpServer });
    let peer: WebSocket | undefined;
    const messages: ConnectorEnvelope[] = [];
    webSocketServer.on("connection", (socket) => {
      peer = socket;
      socket.on("message", (data) => {
        messages.push(ConnectorEnvelopeSchema.parse(JSON.parse(String(data))));
      });
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    servers.push({
      async close() {
        for (const client of webSocketServer.clients) client.terminate();
        await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
        await new Promise<void>((resolve, reject) => {
          httpServer.close((error) => (error ? reject(error) : resolve()));
        });
      },
    });
    const address = httpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("Test WebSocket server did not bind to a TCP port");
    }
    const closeProvider = vi.fn(async () => Promise.reject(new Error("close failed")));
    const setProviderEnabled = vi.fn(async () => undefined);
    const controller: ProviderAccountController = {
      open: () => null,
      rememberIdentity: () => undefined,
      async nativeSessionPage() {
        throw new Error("not used");
      },
      closeProvider,
    };
    const connector = startConnector({
      coreUrl: `ws://127.0.0.1:${address.port}`,
      connectorToken: "connector-test-capability",
      provider: new MockProvider(),
      providerName: "lifecycle-test",
      providerInventory: (revision) => fleet(revision),
      setProviderEnabled,
      providerAccountController: controller,
      journalPath: ":memory:",
    });
    servers.push(connector);
    await connector.ready;
    await vi.waitFor(() =>
      expect(messages.some((message) => message.type === "connector.providers.snapshot"))
        .toBe(true),
    );

    peer?.send(JSON.stringify(makeEnvelope("connector.provider.enablement.set", {
      commandId: "disable-codex",
      providerId: "codex",
      expectedEnabled: true,
      enabled: false,
    })));
    await vi.waitFor(() =>
      expect(messages.some(
        (message) =>
          message.type === "connector.provider.enablement.rejected" &&
          message.payload.commandId === "disable-codex",
      )).toBe(true),
    );

    expect(closeProvider).toHaveBeenCalledExactlyOnceWith("codex");
    expect(setProviderEnabled).not.toHaveBeenCalled();
  });

  it("closes once and ignores Core messages after shutdown begins", async () => {
    const httpServer = createServer();
    const webSocketServer = new WebSocketServer({ server: httpServer });
    let peer: WebSocket | undefined;
    webSocketServer.on("connection", (socket) => {
      peer = socket;
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    servers.push({
      async close() {
        for (const client of webSocketServer.clients) client.terminate();
        await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
        await new Promise<void>((resolve, reject) => {
          httpServer.close((error) => (error ? reject(error) : resolve()));
        });
      },
    });

    const address = httpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("Test WebSocket server did not bind to a TCP port");
    }
    const provider = new CountingProvider();
    const connector = startConnector({
      coreUrl: `ws://127.0.0.1:${address.port}`,
      connectorToken: "connector-test-capability",
      provider,
      providerName: "lifecycle-test",
      journalPath: ":memory:",
    });
    await connector.ready;
    await vi.waitFor(() => expect(peer).toBeDefined());

    const firstClose = connector.close();
    peer?.send(
      JSON.stringify(
        makeEnvelope("connector.journal.ack", {
          sourceEventId: "late-ack-after-shutdown",
        }),
      ),
    );
    const secondClose = connector.close();
    await Promise.all([firstClose, secondClose]);

    expect(provider.closeCalls).toBe(1);
  });
});

class CountingProvider extends MockProvider {
  closeCalls = 0;

  override async close() {
    this.closeCalls += 1;
    await super.close();
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
    providers: [{
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
      capabilities: [],
      accounts: [],
      accountCount: 0,
      models: [],
      modelsState: "not_supported",
      usageState: "not_supported",
      usageMeters: [],
    }],
  };
}
