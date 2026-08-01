import WebSocket from "ws";

import { makeEnvelope, websocketCapability } from "@aicl/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { startCoreServer, type CoreServerHandle } from "../src/server.js";

const handles: CoreServerHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

describe("Core WebSocket trust boundaries", () => {
  it("rejects hostile Origins and missing per-launch capabilities", async () => {
    const core = await startCoreServer({
      port: 0,
      dbPath: ":memory:",
      browserToken: "browser-test-capability",
      connectorToken: "connector-test-capability",
      allowedBrowserOrigins: ["http://127.0.0.1:5173"],
    });
    handles.push(core);

    await expectRejected(
      core.browserUrl,
      websocketCapability("browser", core.browserToken),
      "https://evil.example",
    );
    await expectRejected(
      core.browserUrl,
      undefined,
      "http://127.0.0.1:5173",
    );
    await expectRejected(
      core.connectorUrl,
      websocketCapability("browser", core.browserToken),
    );

    const browser = await expectConnected(
      core.browserUrl,
      websocketCapability("browser", core.browserToken),
      "http://127.0.0.1:5173",
    );
    const connector = await expectConnected(
      core.connectorUrl,
      websocketCapability("connector", core.connectorToken),
    );
    browser.close();
    connector.close();
  });

  it("closes a browser that exceeds its per-second message budget", async () => {
    const core = await startCoreServer({
      port: 0,
      dbPath: ":memory:",
      browserMessagesPerSecond: 3,
    });
    handles.push(core);
    const browser = await expectConnected(
      core.browserUrl,
      websocketCapability("browser", core.browserToken),
      "http://127.0.0.1:5173",
    );
    const closed = new Promise<number>((resolve) => {
      browser.once("close", (code) => resolve(code));
    });

    for (let index = 0; index < 4; index += 1) {
      browser.send(JSON.stringify(makeEnvelope("sessions.list", {})));
    }

    await expect(closed).resolves.toBe(1008);
  });

  it("terminates a client that stops answering heartbeat pings", async () => {
    const core = await startCoreServer({
      port: 0,
      dbPath: ":memory:",
      heartbeatIntervalMs: 20,
    });
    handles.push(core);
    const browser = await expectConnected(
      core.browserUrl,
      websocketCapability("browser", core.browserToken),
      "http://127.0.0.1:5173",
    );
    browser.pong = (() => browser) as typeof browser.pong;

    const closed = new Promise<number>((resolve) => {
      browser.once("close", (code) => resolve(code));
    });

    await expect(closed).resolves.toBe(1006);
  });
});

function expectRejected(url: string, protocol?: string, origin?: string) {
  return new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, protocol, { origin });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("Expected WebSocket upgrade rejection"));
    }, 2_000);
    socket.once("open", () => {
      clearTimeout(timer);
      socket.close();
      reject(new Error("Unauthorized WebSocket connected"));
    });
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      expect([401, 403]).toContain(response.statusCode);
      resolve();
    });
    socket.once("error", () => undefined);
  });
}

function expectConnected(url: string, protocol: string, origin?: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, protocol, { origin });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}
