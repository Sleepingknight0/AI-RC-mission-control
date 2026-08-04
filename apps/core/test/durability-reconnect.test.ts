import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startConnector } from "@aicl/connector";
import type {
  ConnectorEmit,
  ConnectorProvider,
  ProviderSessionPreparation,
  SessionPrepareCommand,
  TurnStartCommand,
} from "@aicl/connector/provider";
import { ProviderLostError } from "@aicl/connector/provider";
import {
  ConnectorEnvelopeSchema,
  CoreToConnectorEnvelopeSchema,
  ServerEnvelopeSchema,
  makeEnvelope,
  websocketCapability,
  type CoreToConnectorEnvelope,
  type Runtime,
  type ServerEnvelope,
} from "@aicl/protocol";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { startCoreServer } from "../src/server.js";
import {
  controlledAccountCapabilities,
  controlledProviderFleet,
  createControlledSession,
} from "./controlled-session-fixture.js";

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
  it("expires startup ownership without a Connector and never replays the prompt", async () => {
    const directory = temporaryDirectory();
    const corePath = join(directory, "core.db");
    const firstCore = await startCoreServer({ port: 0, dbPath: corePath });
    handles.push(firstCore);
    const firstConnector = await openRawConnector(firstCore, {
      connectorId: "startup-lease-connector",
      bootId: "startup-lease-boot",
      runtime: {
        runtimeId: "startup-lease-runtime",
        generation: 1,
        status: "ready",
      },
      commandReceipts: [],
    });
    const firstBrowser = await openBrowser(
      firstCore.browserUrl,
      firstCore.browserToken,
      "startup-lease-session",
      0,
      true,
    );
    send(
      firstBrowser,
      makeEnvelope("turn.submit", {
        commandId: "startup-lease-command",
        sessionId: "startup-lease-session",
        prompt: "must not replay after restart",
      }),
    );
    await waitFor(firstBrowser, "turn.started");
    firstBrowser.socket.close();

    const port = firstCore.port;
    const browserToken = firstCore.browserToken;
    const connectorToken = firstCore.connectorToken;
    await firstCore.close();
    handles.splice(handles.indexOf(firstCore), 1);
    firstConnector.terminate();

    const secondCore = await startCoreServer({
      port,
      dbPath: corePath,
      browserToken,
      connectorToken,
      connectorLossGraceMs: 30,
    });
    handles.push(secondCore);
    const refreshed = await openBrowser(
      secondCore.browserUrl,
      secondCore.browserToken,
      "startup-lease-session",
      0,
    );

    await waitFor(refreshed, "turn.outcome_unknown");
    expect(
      refreshed.messages.some(
        (message) => message.type === "turn.started" && message.payload.seq > 1,
      ),
    ).toBe(false);
    refreshed.socket.close();
  });

  it("marks a committed dispatch unknown without a dispatch-proving receipt", async () => {
    const directory = temporaryDirectory();
    const corePath = join(directory, "core.db");
    const firstCore = await startCoreServer({ port: 0, dbPath: corePath });
    handles.push(firstCore);
    const identity = {
      connectorId: "receipt-gap-connector",
      bootId: "receipt-gap-boot",
      runtime: {
        runtimeId: "receipt-gap-runtime",
        generation: 1,
        status: "ready" as const,
      },
      commandReceipts: [],
    };
    const firstConnector = await openRawConnector(firstCore, identity);
    const browser = await openBrowser(
      firstCore.browserUrl,
      firstCore.browserToken,
      "receipt-gap-session",
      0,
      true,
    );
    send(
      browser,
      makeEnvelope("turn.submit", {
        commandId: "receipt-gap-command",
        sessionId: "receipt-gap-session",
        prompt: "simulate crash after Core commit",
      }),
    );
    await waitFor(browser, "turn.started");
    browser.socket.close();

    const port = firstCore.port;
    const browserToken = firstCore.browserToken;
    const connectorToken = firstCore.connectorToken;
    await firstCore.close();
    handles.splice(handles.indexOf(firstCore), 1);
    firstConnector.terminate();

    const secondCore = await startCoreServer({
      port,
      dbPath: corePath,
      browserToken,
      connectorToken,
      connectorLossGraceMs: 2_000,
    });
    handles.push(secondCore);
    const refreshed = await openBrowser(
      secondCore.browserUrl,
      secondCore.browserToken,
      "receipt-gap-session",
      0,
    );
    const secondConnector = await openRawConnector(secondCore, {
      ...identity,
      commandReceipts: [
        { commandId: "receipt-gap-command", state: "received" },
      ],
    });

    await waitFor(refreshed, "turn.outcome_unknown");
    expect(
      secondConnectorMessages(secondConnector).some(
        (message) => message.type === "connector.turn.start",
      ),
    ).toBe(false);
    refreshed.socket.close();
    secondConnector.close();
  });

  it("survives a Core restart during an active Turn and replays final state once", async () => {
    const directory = temporaryDirectory();
    const corePath = join(directory, "core.db");
    const journalPath = join(directory, "connector.db");
    const firstCore = await startCoreServer({ port: 0, dbPath: corePath });
    handles.push(firstCore);
    const provider = new HeldProvider();
    const connector = startConnector({
      coreUrl: firstCore.connectorUrl,
      connectorToken: firstCore.connectorToken,
      provider,
      providerName: "held",
      journalPath,
      reconnectDelayMs: 20,
      providerInventory: (revision) => controlledProviderFleet(revision),
    });
    handles.push(connector);
    await connector.ready;

    const firstTab = await openBrowser(
      firstCore.browserUrl,
      firstCore.browserToken,
      "durable-session",
      0,
      true,
    );
    const secondTab = await openBrowser(
      firstCore.browserUrl,
      firstCore.browserToken,
      "durable-session",
      0,
    );
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
    const secondCore = await startCoreServer({
      port,
      dbPath: corePath,
      browserToken: firstCore.browserToken,
      connectorToken: firstCore.connectorToken,
    });
    handles.push(secondCore);

    const refreshed = await openBrowser(
      secondCore.browserUrl,
      secondCore.browserToken,
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
      secondCore.browserToken,
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
      connectorToken: core.connectorToken,
      provider,
      providerName: "held",
      journalPath: ":memory:",
      providerInventory: (revision) => controlledProviderFleet(revision),
    });
    handles.push(connector);
    await connector.ready;
    const first = await openBrowser(
      core.browserUrl,
      core.browserToken,
      "boundary-session",
      0,
      true,
    );
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

    const second = await openBrowser(
      core.browserUrl,
      core.browserToken,
      "boundary-session",
      0,
    );
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
      connectorToken: core.connectorToken,
      provider: firstProvider,
      providerName: "held",
      journalPath: join(directory, "connector.db"),
      reconnectDelayMs: 20,
      providerInventory: (revision) => controlledProviderFleet(revision),
    });
    handles.push(firstConnector);
    await firstConnector.ready;
    const browser = await openBrowser(
      core.browserUrl,
      core.browserToken,
      "restart-session",
      0,
      true,
    );
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
      connectorToken: core.connectorToken,
      provider: secondProvider,
      providerName: "held",
      journalPath: join(directory, "connector.db"),
      reconnectDelayMs: 20,
      providerInventory: (revision) => controlledProviderFleet(revision),
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
  #closed = false;
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

  async prepareSession(
    command: SessionPrepareCommand,
  ): Promise<ProviderSessionPreparation> {
    return {
      providerSessionId: `held-thread-${command.payload.sessionId}`,
      projectPath: command.payload.projectPath,
      model: command.payload.model,
      reasoningLevel: command.payload.reasoningLevel,
    };
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
    if (this.#closed) throw new ProviderLostError("Held provider closed");
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

  async resolveApproval() {}

  async close() {
    this.#closed = true;
    this.#release();
  }

  release() {
    this.#release();
  }
}

function emitNormalized(emit: ConnectorEmit, value: unknown) {
  emit(ConnectorEnvelopeSchema.parse(value));
}

async function openBrowser(
  url: string,
  token: string,
  sessionId: string,
  afterSeq: number,
  create = false,
): Promise<BrowserHarness> {
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
  const browser = { socket, messages };
  if (create) await createControlledSession(browser, sessionId);
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

const rawConnectorMessages = new WeakMap<WebSocket, CoreToConnectorEnvelope[]>();

async function openRawConnector(
  core: Awaited<ReturnType<typeof startCoreServer>>,
  identity: {
    connectorId: string;
    bootId: string;
    runtime: Runtime;
    commandReceipts: readonly {
      commandId: string;
      state: "received" | "dispatching" | "completed" | "outcome_unknown";
    }[];
  },
) {
  const socket = new WebSocket(
    core.connectorUrl,
    websocketCapability("connector", core.connectorToken),
  );
  const messages: CoreToConnectorEnvelope[] = [];
  rawConnectorMessages.set(socket, messages);
  socket.on("message", (data) => {
    const message = CoreToConnectorEnvelopeSchema.parse(JSON.parse(data.toString()));
    messages.push(message);
    if (message.type === "connector.session.create") {
      socket.send(
        JSON.stringify(
          ConnectorEnvelopeSchema.parse({
            ...makeEnvelope("connector.session.prepared", {
              commandId: message.payload.commandId,
              sessionId: message.payload.sessionId,
              providerId: message.payload.providerId,
              accountId: message.payload.accountId,
              providerSessionId: `raw-${message.payload.sessionId}`,
              projectPath: message.payload.projectPath,
              model: message.payload.model,
              reasoningLevel: message.payload.reasoningLevel,
            }),
            connectorId: identity.connectorId,
            bootId: identity.bootId,
            sourceEventId: `prepared-${message.payload.commandId}`,
            runtimeId: identity.runtime.runtimeId,
            runtimeGeneration: identity.runtime.generation,
          }),
        ),
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify(
      makeEnvelope("connector.hello", {
        ...identity,
        activeProviderId: "test-provider",
        activeAccountId: "default",
      }),
    ),
  );
  socket.send(
    JSON.stringify(
      ConnectorEnvelopeSchema.parse({
        ...makeEnvelope("connector.providers.snapshot", {
          snapshot: controlledProviderFleet(1),
        }),
        connectorId: identity.connectorId,
        bootId: identity.bootId,
        sourceEventId: `providers-${identity.bootId}`,
        runtimeId: identity.runtime.runtimeId,
        runtimeGeneration: identity.runtime.generation,
      }),
    ),
  );
  socket.send(
    JSON.stringify(
      ConnectorEnvelopeSchema.parse({
        ...makeEnvelope("connector.provider.account.capabilities.snapshot", {
          snapshot: controlledAccountCapabilities(1),
        }),
        connectorId: identity.connectorId,
        bootId: identity.bootId,
        runtimeId: identity.runtime.runtimeId,
        runtimeGeneration: identity.runtime.generation,
      }),
    ),
  );
  return socket;
}

function secondConnectorMessages(socket: WebSocket) {
  return rawConnectorMessages.get(socket) ?? [];
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
