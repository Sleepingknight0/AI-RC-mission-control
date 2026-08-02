import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { websocketCapability } from "@aicl/protocol";

import { startCoreServer, type CoreServerHandle } from "../src/server.js";

interface RuntimeConfig {
  webSocketPath: "/ws";
  ticket: string;
  expiresAt: string;
}

const handles: CoreServerHandle[] = [];

afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map((handle) => handle.close()));
});

describe("runtime browser authentication", () => {
  it("issues a one-time same-origin ticket and disables the legacy token", async () => {
    const core = await startCoreServer({
      port: 0,
      dbPath: ":memory:",
      legacyBrowserTokenEnabled: false,
    });
    handles.push(core);
    const origin = coreOrigin(core);

    const issued = await issueTicket(core, origin);
    expect(issued.response.status).toBe(200);
    expect(issued.response.headers.get("cache-control")).toBe("no-store");
    expect(issued.response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(issued.config.webSocketPath).toBe("/ws");
    expect(issued.config.ticket).toMatch(/^[A-Za-z0-9._~-]{16,200}$/u);
    expect(Date.parse(issued.config.expiresAt)).toBeGreaterThan(Date.now());

    await expectUpgradeRejected(
      core.browserUrl,
      websocketCapability("browser", core.browserToken),
      origin,
      401,
    );
    const socket = await connectBrowser(core, issued.config.ticket, origin);
    socket.close();
    await expectUpgradeRejected(
      core.browserUrl,
      websocketCapability("browser", issued.config.ticket),
      origin,
      401,
    );
  });

  it("rejects hostile Origins without consuming the valid ticket", async () => {
    const core = await startCoreServer({
      port: 0,
      dbPath: ":memory:",
      legacyBrowserTokenEnabled: false,
    });
    handles.push(core);
    const origin = coreOrigin(core);

    const hostileIssue = await fetch(`${origin}/runtime-config`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(hostileIssue.status).toBe(403);
    const payloadAttempt = await fetch(`${origin}/runtime-config`, {
      method: "POST",
      headers: { origin },
      body: "unexpected",
    });
    expect(payloadAttempt.status).toBe(413);

    const { config } = await issueTicket(core, origin);
    await expectUpgradeRejected(
      core.browserUrl,
      websocketCapability("browser", config.ticket),
      "https://evil.example",
      403,
    );
    const socket = await connectBrowser(core, config.ticket, origin);
    socket.close();
  });

  it("expires tickets and bounds outstanding allocations", async () => {
    const core = await startCoreServer({
      port: 0,
      dbPath: ":memory:",
      legacyBrowserTokenEnabled: false,
      browserTicketTtlMs: 20,
      browserTicketLimit: 1,
    });
    handles.push(core);
    const origin = coreOrigin(core);

    const first = await issueTicket(core, origin);
    const refused = await fetch(`${origin}/runtime-config`, {
      method: "POST",
      headers: { origin },
    });
    expect(refused.status).toBe(503);

    await new Promise((resolve) => setTimeout(resolve, 40));
    await expectUpgradeRejected(
      core.browserUrl,
      websocketCapability("browser", first.config.ticket),
      origin,
      401,
    );
    expect((await issueTicket(core, origin)).response.status).toBe(200);
  });

  it("invalidates every issued ticket when Core restarts", async () => {
    const firstCore = await startCoreServer({
      port: 0,
      dbPath: ":memory:",
      legacyBrowserTokenEnabled: false,
    });
    handles.push(firstCore);
    const origin = coreOrigin(firstCore);
    const { config } = await issueTicket(firstCore, origin);
    const port = firstCore.port;
    await firstCore.close();
    handles.splice(handles.indexOf(firstCore), 1);

    const restartedCore = await startCoreServer({
      port,
      dbPath: ":memory:",
      legacyBrowserTokenEnabled: false,
    });
    handles.push(restartedCore);
    await expectUpgradeRejected(
      restartedCore.browserUrl,
      websocketCapability("browser", config.ticket),
      origin,
      401,
    );

    const fresh = await issueTicket(restartedCore, origin);
    const socket = await connectBrowser(restartedCore, fresh.config.ticket, origin);
    socket.close();
  });
});

function coreOrigin(core: CoreServerHandle): string {
  return core.browserUrl.replace(/^ws:/u, "http:").replace(/\/ws$/u, "");
}

async function issueTicket(core: CoreServerHandle, origin: string) {
  const response = await fetch(`${coreOrigin(core)}/runtime-config`, {
    method: "POST",
    headers: { origin },
  });
  const config = (await response.json()) as RuntimeConfig;
  return { response, config };
}

function connectBrowser(core: CoreServerHandle, ticket: string, origin: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(
      core.browserUrl,
      websocketCapability("browser", ticket),
      { origin },
    );
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function expectUpgradeRejected(
  url: string,
  protocol: string,
  origin: string,
  expectedStatus: 401 | 403,
) {
  return new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, protocol, { origin });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("Expected WebSocket upgrade rejection"));
    }, 2_000);
    socket.once("open", () => {
      clearTimeout(timer);
      socket.close();
      reject(new Error("Rejected WebSocket connected"));
    });
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      expect(response.statusCode).toBe(expectedStatus);
      resolve();
    });
    socket.once("error", () => undefined);
  });
}
