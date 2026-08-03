import {
  ServerEnvelopeSchema,
  makeEnvelope,
  websocketCapability,
  type ServerEnvelope,
} from "@aicl/protocol";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { startCoreServer } from "../src/server.js";

const handles: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(handles.splice(0).reverse().map((handle) => handle.close()));
});

describe("Session Catalog browser protocol", () => {
  it("lists, renames, revision-fences, and archives without Connector authority", async () => {
    const core = await startCoreServer({ port: 0, dbPath: ":memory:" });
    handles.push(core);
    const browser = await openBrowser(core.browserUrl, core.browserToken);
    browser.socket.send(
      JSON.stringify(
        makeEnvelope("session.subscribe", { sessionId: "catalog-ws", afterSeq: 0 }),
      ),
    );
    await waitFor(browser, (message) => message.type === "session.snapshot");

    requestCatalog(browser, "catalog-first");
    const first = await waitFor(
      browser,
      (message) =>
        message.type === "sessions.catalog.snapshot" &&
        message.payload.requestId === "catalog-first",
    );
    if (first.type !== "sessions.catalog.snapshot") throw new Error("Expected catalog");
    expect(first.payload.sessions[0]).toMatchObject({
      sessionId: "catalog-ws",
      title: "Untitled Session",
      canControl: false,
      revision: 0,
    });

    browser.socket.send(
      JSON.stringify(
        makeEnvelope("session.rename", {
          commandId: "rename-ws",
          sessionId: "catalog-ws",
          deviceId: "device-ws",
          expectedRevision: 0,
          title: "Catalog contract",
        }),
      ),
    );
    await waitFor(
      browser,
      (message) =>
        message.type === "session.command.accepted" &&
        message.payload.commandId === "rename-ws",
    );
    browser.socket.send(
      JSON.stringify(
        makeEnvelope("session.pin", {
          commandId: "pin-stale-ws",
          sessionId: "catalog-ws",
          deviceId: "device-ws",
          expectedRevision: 0,
          pinned: true,
        }),
      ),
    );
    const stale = await waitFor(
      browser,
      (message) =>
        message.type === "command.rejected" &&
        message.payload.commandId === "pin-stale-ws",
    );
    if (stale.type !== "command.rejected") throw new Error("Expected rejection");
    expect(stale.payload.error.code).toBe("SESSION_REVISION_CONFLICT");

    browser.socket.send(
      JSON.stringify(
        makeEnvelope("session.archive", {
          commandId: "archive-ws",
          sessionId: "catalog-ws",
          deviceId: "device-ws",
          expectedRevision: 1,
          archived: true,
        }),
      ),
    );
    await waitFor(
      browser,
      (message) =>
        message.type === "session.command.accepted" &&
        message.payload.commandId === "archive-ws",
    );
    requestCatalog(browser, "catalog-empty");
    const empty = await waitFor(
      browser,
      (message) =>
        message.type === "sessions.catalog.snapshot" &&
        message.payload.requestId === "catalog-empty",
    );
    if (empty.type !== "sessions.catalog.snapshot") throw new Error("Expected catalog");
    expect(empty.payload.sessions).toEqual([]);
    browser.socket.close();
  });
});

function requestCatalog(browser: BrowserHarness, requestId: string) {
  browser.socket.send(
    JSON.stringify(
      makeEnvelope("sessions.catalog.list", {
        requestId,
        deviceId: "device-ws",
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
  throw new Error("Timed out waiting for Session Catalog message");
}
