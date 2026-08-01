import { startMockConnector } from "@aicl/connector";
import { ServerEnvelopeSchema, makeEnvelope, type ServerEnvelope } from "@aicl/protocol";
import { WALKING_SKELETON_FIXTURE } from "@aicl/test-fixtures";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { startCoreServer, type CoreServerHandle } from "../src/server.js";

interface BrowserHarness {
  socket: WebSocket;
  messages: ServerEnvelope[];
}

const openHandles: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(openHandles.splice(0).map((handle) => handle.close()));
});

async function openBrowser(url: string): Promise<BrowserHarness> {
  const socket = new WebSocket(url);
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

async function waitForMessage<T extends ServerEnvelope["type"]>(
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

function send(browser: BrowserHarness, value: unknown) {
  browser.socket.send(JSON.stringify(value));
}

describe("mock Connector to Core to browser flow", () => {
  it("streams normalized output, rejects concurrency, and restores a snapshot", async () => {
    const core: CoreServerHandle = await startCoreServer({ port: 0 });
    openHandles.push(core);
    const connector = startMockConnector({
      coreUrl: core.connectorUrl,
      providerDelayMs: 30,
    });
    openHandles.push(connector);
    await connector.ready;

    const first = await openBrowser(core.browserUrl);
    send(
      first,
      makeEnvelope("session.subscribe", {
        sessionId: WALKING_SKELETON_FIXTURE.sessionId,
        afterSeq: 0,
      }),
    );
    await waitForMessage(first, "session.snapshot");

    send(
      first,
      makeEnvelope("turn.submit", {
        commandId: "command-first",
        sessionId: WALKING_SKELETON_FIXTURE.sessionId,
        prompt: WALKING_SKELETON_FIXTURE.prompt,
      }),
    );
    await waitForMessage(first, "command.accepted");
    send(
      first,
      makeEnvelope("turn.submit", {
        commandId: "command-second",
        sessionId: WALKING_SKELETON_FIXTURE.sessionId,
        prompt: "must not queue",
      }),
    );

    const rejected = await waitForMessage(first, "command.rejected");
    expect(rejected.payload.error.code).toBe("TURN_ALREADY_ACTIVE");
    expect((await waitForMessage(first, "assistant.message.delta")).payload.text).not.toBe("");
    await waitForMessage(first, "turn.completed");
    expect(JSON.stringify(first.messages)).not.toMatch(
      /providerMethod|providerPayload|rawEvent/,
    );

    first.socket.close();
    const refreshed = await openBrowser(core.browserUrl);
    send(
      refreshed,
      makeEnvelope("session.subscribe", {
        sessionId: WALKING_SKELETON_FIXTURE.sessionId,
        afterSeq: 0,
      }),
    );
    const snapshot = await waitForMessage(refreshed, "session.snapshot");
    expect(snapshot.payload.snapshot.activeTurnId).toBeNull();
    expect(snapshot.payload.snapshot.messages[0]?.content).toBe(
      WALKING_SKELETON_FIXTURE.response,
    );
    expect(snapshot.payload.snapshot.turns).toHaveLength(1);

    refreshed.socket.close();
  });
});
