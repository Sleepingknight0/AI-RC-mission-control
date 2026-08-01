import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startConnector } from "@aicl/connector";
import type {
  ConnectorEmit,
  ConnectorProvider,
  TurnStartCommand,
} from "@aicl/connector/provider";
import {
  ConnectorEnvelopeSchema,
  ServerEnvelopeSchema,
  makeEnvelope,
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
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(handles.splice(0).reverse().map((handle) => handle.close()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("durability and reconnect", () => {
  it("survives a Core restart during an active Turn and replays final state once", async () => {
    const directory = temporaryDirectory();
    const corePath = join(directory, "core.db");
    const journalPath = join(directory, "connector.db");
    const firstCore = await startCoreServer({ port: 0, dbPath: corePath });
    handles.push(firstCore);
    const provider = new HeldProvider();
    const connector = startConnector({
      coreUrl: firstCore.connectorUrl,
      provider,
      providerName: "held",
      journalPath,
      reconnectDelayMs: 20,
    });
    handles.push(connector);
    await connector.ready;

    const firstTab = await openBrowser(firstCore.browserUrl, "durable-session", 0);
    const secondTab = await openBrowser(firstCore.browserUrl, "durable-session", 0);
    const command = makeEnvelope("turn.submit", {
      commandId: "durable-command",
      sessionId: "durable-session",
      prompt: "survive reconnect",
    });
    send(firstTab, command);
    send(secondTab, command);
    const started = await waitFor(firstTab, "turn.started");
    await waitFor(firstTab, "assistant.message.delta");
    await waitUntil(() =>
      secondTab.messages.some(
        (message) =>
          message.type === "command.accepted" &&
          message.payload.commandId === "durable-command",
      ),
    );
    expect(provider.startCalls).toBe(1);
    firstTab.socket.close();
    secondTab.socket.close();

    const port = firstCore.port;
    await firstCore.close();
    handles.splice(handles.indexOf(firstCore), 1);
    const secondCore = await startCoreServer({ port, dbPath: corePath });
    handles.push(secondCore);

    const refreshed = await openBrowser(
      secondCore.browserUrl,
      "durable-session",
      started.payload.seq,
    );
    const activeSnapshot = await waitFor(refreshed, "session.snapshot");
    expect(activeSnapshot.payload.snapshot.activeTurnId).toBe(
      started.payload.turn.turnId,
    );
    expect(activeSnapshot.payload.snapshot.messages).toEqual([]);

    provider.release();
    const completedMessage = await waitFor(
      refreshed,
      "assistant.message.completed",
    );
    expect(completedMessage.payload.content).toBe(
      "Authoritative response: survive reconnect",
    );
    await waitFor(refreshed, "turn.completed");
    refreshed.socket.close();

    const replayed = await openBrowser(
      secondCore.browserUrl,
      "durable-session",
      started.payload.seq,
    );
    await waitForReplayEnd(replayed);
    const visibleReplay = replayed.messages.filter(
      (message) =>
        (message.type === "assistant.message.completed" ||
          message.type === "turn.completed") &&
        message.payload.seq > started.payload.seq,
    );
    expect(visibleReplay.map((message) => message.type)).toEqual([
      "assistant.message.completed",
      "turn.completed",
    ]);
    expect(
      new Set(
        visibleReplay.map((message) =>
          "eventId" in message.payload ? message.payload.eventId : null,
        ),
      ).size,
    ).toBe(2);
    const finalSnapshot = replayed.messages.find(
      (message) => message.type === "session.snapshot",
    );
    expect(finalSnapshot?.type).toBe("session.snapshot");
    if (finalSnapshot?.type === "session.snapshot") {
      expect(finalSnapshot.payload.snapshot.activeTurnId).toBeNull();
      expect(finalSnapshot.payload.snapshot.turns).toHaveLength(1);
      expect(finalSnapshot.payload.snapshot.messages[0]?.content).toBe(
        "Authoritative response: survive reconnect",
      );
    }
    expect(provider.startCalls).toBe(1);
    replayed.socket.close();
  });

  it("replays an event committed when its live broadcast failed", async () => {
    let failed = false;
    const broadcastErrors: unknown[] = [];
    const core = await startCoreServer({
      port: 0,
      dbPath: ":memory:",
      beforeDurableBroadcast(event) {
        if (!failed && event.type === "turn.started") {
          failed = true;
          throw new Error("injected broadcast failure");
        }
      },
      onBroadcastError(error) {
        broadcastErrors.push(error);
      },
    });
    handles.push(core);
    const provider = new HeldProvider();
    const connector = startConnector({
      coreUrl: core.connectorUrl,
      provider,
      providerName: "held",
      journalPath: ":memory:",
    });
    handles.push(connector);
    await connector.ready;
    const first = await openBrowser(core.browserUrl, "boundary-session", 0);
    send(
      first,
      makeEnvelope("turn.submit", {
        commandId: "boundary-command",
        sessionId: "boundary-session",
        prompt: "commit first",
      }),
    );
    await waitFor(first, "command.accepted");
    await provider.deltaReady;
    expect(first.messages.some((message) => message.type === "turn.started")).toBe(
      false,
    );
    expect(broadcastErrors).toHaveLength(1);
    first.socket.close();

    const second = await openBrowser(core.browserUrl, "boundary-session", 0);
    await waitForReplayEnd(second);
    expect(second.messages.some((message) => message.type === "turn.started")).toBe(
      true,
    );
    second.socket.close();
  });

  it("changes runtime generation on Connector restart and never redispatches", async () => {
    const directory = temporaryDirectory();
    const core = await startCoreServer({
      port: 0,
      dbPath: join(directory, "core.db"),
      connectorLossGraceMs: 500,
    });
    handles.push(core);
    const firstProvider = new HeldProvider();
    const firstConnector = startConnector({
      coreUrl: core.connectorUrl,
      provider: firstProvider,
      providerName: "held",
      journalPath: join(directory, "connector.db"),
      reconnectDelayMs: 20,
    });
    handles.push(firstConnector);
    await firstConnector.ready;
    const browser = await openBrowser(core.browserUrl, "restart-session", 0);
    send(
      browser,
      makeEnvelope("turn.submit", {
        commandId: "restart-command",
        sessionId: "restart-session",
        prompt: "do not replay",
      }),
    );
    await waitFor(browser, "assistant.message.delta");
    expect(firstProvider.startCalls).toBe(1);

    await firstConnector.close();
    handles.splice(handles.indexOf(firstConnector), 1);
    const secondProvider = new HeldProvider();
    const secondConnector = startConnector({
      coreUrl: core.connectorUrl,
      provider: secondProvider,
      providerName: "held",
      journalPath: join(directory, "connector.db"),
      reconnectDelayMs: 20,
    });
    handles.push(secondConnector);
    await secondConnector.ready;

    await waitFor(browser, "turn.outcome_unknown");
    expect(secondConnector.identity.connectorId).toBe(
      firstConnector.identity.connectorId,
    );
    expect(secondConnector.identity.bootId).not.toBe(firstConnector.identity.bootId);
    expect(secondConnector.identity.generation).toBe(
      firstConnector.identity.generation + 1,
    );
    expect(secondProvider.startCalls).toBe(0);
    browser.socket.close();
  });
});

class HeldProvider implements ConnectorProvider {
  startCalls = 0;
  #release: () => void = () => undefined;
  readonly #releasePromise = new Promise<void>((resolve) => {
    this.#release = resolve;
  });
  #deltaReady: () => void = () => undefined;
  readonly deltaReady = new Promise<void>((resolve) => {
    this.#deltaReady = resolve;
  });

  onLost() {
    return () => undefined;
  }

  async startTurn(command: TurnStartCommand, emit: ConnectorEmit) {
    this.startCalls += 1;
    const providerSessionId =
      command.payload.providerSessionId ?? `held-thread-${command.payload.sessionId}`;
    const providerTurnId = `held-provider-${command.payload.turnId}`;
    const messageId = `held-message-${command.payload.turnId}`;
    emitNormalized(
      emit,
      makeEnvelope("connector.session.bound", {
        sessionId: command.payload.sessionId,
        providerSessionId,
      }),
    );
    emitNormalized(
      emit,
      makeEnvelope("connector.turn.bound", {
        sessionId: command.payload.sessionId,
        turnId: command.payload.turnId,
        providerTurnId,
      }),
    );
    emitNormalized(
      emit,
      makeEnvelope("connector.turn.delta", {
        sessionId: command.payload.sessionId,
        turnId: command.payload.turnId,
        messageId,
        streamSeq: 1,
        text: "ephemeral partial",
      }),
    );
    this.#deltaReady();
    await this.#releasePromise;
    const content = `Authoritative response: ${command.payload.prompt}`;
    emitNormalized(
      emit,
      makeEnvelope("connector.turn.message.completed", {
        sessionId: command.payload.sessionId,
        turnId: command.payload.turnId,
        messageId,
        content,
      }),
    );
    emitNormalized(
      emit,
      makeEnvelope("connector.turn.completed", {
        sessionId: command.payload.sessionId,
        turnId: command.payload.turnId,
      }),
    );
  }

  async interrupt() {}

  async close() {}

  release() {
    this.#release();
  }
}

function emitNormalized(emit: ConnectorEmit, value: unknown) {
  emit(ConnectorEnvelopeSchema.parse(value));
}

async function openBrowser(
  url: string,
  sessionId: string,
  afterSeq: number,
): Promise<BrowserHarness> {
  const socket = new WebSocket(url);
  const messages: ServerEnvelope[] = [];
  socket.on("message", (data) => {
    messages.push(ServerEnvelopeSchema.parse(JSON.parse(data.toString())));
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const browser = { socket, messages };
  send(
    browser,
    makeEnvelope("session.subscribe", { sessionId, afterSeq }),
  );
  await waitFor(browser, "session.snapshot");
  return browser;
}

function send(browser: BrowserHarness, value: unknown) {
  browser.socket.send(JSON.stringify(value));
}

async function waitFor<T extends ServerEnvelope["type"]>(
  browser: BrowserHarness,
  type: T,
  timeoutMs = 5_000,
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

async function waitForReplayEnd(browser: BrowserHarness) {
  await waitUntil(() =>
    browser.messages.some(
      (message) =>
        message.type === "replay.boundary" && message.payload.phase === "end",
    ),
  );
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "aicl-reconnect-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
