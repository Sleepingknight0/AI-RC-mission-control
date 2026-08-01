import { resolve } from "node:path";

import { startConnector, type ConnectorHandle } from "@aicl/connector";
import { CodexProvider } from "@aicl/connector/codex";
import {
  ServerEnvelopeSchema,
  makeEnvelope,
  type ServerEnvelope,
} from "@aicl/protocol";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { startCoreServer, type CoreServerHandle } from "../src/server.js";

const enabled = process.env.AICL_REAL_CODEX === "1";
const handles: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(handles.splice(0).reverse().map((handle) => handle.close()));
});

describe.skipIf(!enabled)("real Codex browser vertical slice", () => {
  it("streams, interrupts, classifies death, and resumes without replay", async () => {
    const core: CoreServerHandle = await startCoreServer({ port: 0 });
    handles.push(core);
    const provider = new CodexProvider({
      cwd: resolve("../../spikes/fixture-project"),
    });
    const connector: ConnectorHandle = startConnector({
      coreUrl: core.connectorUrl,
      provider,
      providerName: "codex",
    });
    handles.push(connector);
    await connector.ready;
    const browser = await openBrowser(core.browserUrl);

    send(
      browser,
      makeEnvelope("session.subscribe", {
        sessionId: "real-codex-session",
        afterSeq: 0,
      }),
    );
    await waitFor(browser, "session.snapshot");

    send(
      browser,
      makeEnvelope("turn.submit", {
        commandId: "real-complete-1",
        sessionId: "real-codex-session",
        prompt: "Do not use tools. Reply with exactly: AICL_REAL_OK",
      }),
    );
    const accepted = await waitFor(browser, "command.accepted", (message) =>
      message.payload.commandId === "real-complete-1",
    );
    send(
      browser,
      makeEnvelope("turn.submit", {
        commandId: "real-concurrent-1",
        sessionId: "real-codex-session",
        prompt: "This prompt must be rejected and never dispatched.",
      }),
    );
    await waitFor(browser, "command.rejected", (message) =>
      message.payload.error.code === "TURN_ALREADY_ACTIVE",
    );
    await waitFor(browser, "assistant.message.delta", (message) =>
      message.payload.turnId === accepted.payload.turnId,
    );
    const completedMessage = await waitFor(
      browser,
      "assistant.message.completed",
      (message) => message.payload.turnId === accepted.payload.turnId,
    );
    expect(completedMessage.payload.content).toContain("AICL_REAL_OK");
    await waitFor(browser, "turn.completed", (message) =>
      message.payload.turnId === accepted.payload.turnId,
    );

    send(
      browser,
      makeEnvelope("turn.submit", {
        commandId: "real-interrupt-turn",
        sessionId: "real-codex-session",
        prompt:
          "Do not use tools. Write 400 numbered lines in the format NNN AICL_INTERRUPT_TEST.",
      }),
    );
    const interruptTurn = await waitFor(
      browser,
      "command.accepted",
      (message) => message.payload.commandId === "real-interrupt-turn",
    );
    await waitFor(browser, "assistant.message.delta", (message) =>
      message.payload.turnId === interruptTurn.payload.turnId,
    );
    send(
      browser,
      makeEnvelope("turn.interrupt", {
        commandId: "real-interrupt-command",
        sessionId: "real-codex-session",
        turnId: interruptTurn.payload.turnId,
      }),
    );
    await waitFor(browser, "turn.interrupted", (message) =>
      message.payload.turnId === interruptTurn.payload.turnId,
    );

    send(
      browser,
      makeEnvelope("turn.submit", {
        commandId: "real-kill-turn",
        sessionId: "real-codex-session",
        prompt:
          "Do not use tools. Write 600 numbered lines in the format NNN AICL_KILL_TEST.",
      }),
    );
    const killTurn = await waitFor(browser, "command.accepted", (message) =>
      message.payload.commandId === "real-kill-turn",
    );
    await waitFor(browser, "assistant.message.delta", (message) =>
      message.payload.turnId === killTurn.payload.turnId,
    );
    await provider.killForTest();
    await waitFor(browser, "turn.outcome_unknown", (message) =>
      message.payload.turnId === killTurn.payload.turnId,
    );
    await waitFor(browser, "runtime.status", (message) =>
      message.payload.runtime.status === "lost",
    );

    send(
      browser,
      makeEnvelope("turn.submit", {
        commandId: "real-resume-turn",
        sessionId: "real-codex-session",
        prompt: "Do not use tools. Reply with exactly: AICL_RESUMED",
      }),
    );
    const resumed = await waitFor(browser, "command.accepted", (message) =>
      message.payload.commandId === "real-resume-turn",
    );
    const resumedMessage = await waitFor(
      browser,
      "assistant.message.completed",
      (message) => message.payload.turnId === resumed.payload.turnId,
    );
    expect(resumedMessage.payload.content).toContain("AICL_RESUMED");
    expect(
      browser.messages.filter(
        (message) =>
          message.type === "command.accepted" &&
          message.payload.commandId === "real-kill-turn",
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(browser.messages)).not.toMatch(
      /item\/agentMessage\/delta|providerPayload|rawEvent/,
    );
    browser.socket.close();
  }, 240_000);
});

interface BrowserHarness {
  socket: WebSocket;
  messages: ServerEnvelope[];
}

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

function send(browser: BrowserHarness, value: unknown) {
  browser.socket.send(JSON.stringify(value));
}

async function waitFor<T extends ServerEnvelope["type"]>(
  browser: BrowserHarness,
  type: T,
  predicate: (
    message: Extract<ServerEnvelope, { type: T }>,
  ) => boolean = () => true,
  timeoutMs = 90_000,
): Promise<Extract<ServerEnvelope, { type: T }>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = browser.messages.find(
      (message): message is Extract<ServerEnvelope, { type: T }> =>
        message.type === type &&
        predicate(message as Extract<ServerEnvelope, { type: T }>),
    );
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for real Codex event");
}
