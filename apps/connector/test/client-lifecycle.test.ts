import { createServer } from "node:http";

import { makeEnvelope } from "@aicl/protocol";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startConnector } from "../src/client.js";
import { MockProvider } from "../src/mock-provider.js";

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
});

describe("Connector lifecycle", () => {
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
