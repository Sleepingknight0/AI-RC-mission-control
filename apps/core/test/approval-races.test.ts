import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startConnector } from "@aicl/connector";
import type {
  ApprovalResolveCommand,
  ConnectorEmit,
  ConnectorProvider,
  TurnStartCommand,
} from "@aicl/connector/provider";
import {
  ConnectorEnvelopeSchema,
  ServerEnvelopeSchema,
  makeEnvelope,
  websocketCapability,
  type Approval,
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

describe("approval compare-and-set", () => {
  it("allows only one of two tabs to approve and deduplicates its command ID", async () => {
    const setup = await approvalSetup();
    const secondTab = await openBrowser(
      setup.core.browserUrl,
      setup.core.browserToken,
      "approval-session",
    );
    const approval = await requestApproval(setup.firstTab, "turn-command");
    const firstResolution = approvalCommand(approval, "approval-command-a");
    const competingResolution = approvalCommand(approval, "approval-command-b");
    send(setup.firstTab, firstResolution);
    send(secondTab, competingResolution);

    const first = await waitForCommand(setup.firstTab, "approval-command-a");
    const second = await waitForCommand(secondTab, "approval-command-b");
    expect([first.type, second.type].sort()).toEqual([
      "command.accepted",
      "command.rejected",
    ]);
    const rejected = first.type === "command.rejected" ? first : second;
    if (rejected.type !== "command.rejected") throw new Error("Expected rejection");
    expect(rejected.payload.error.code).toBe("APPROVAL_NOT_PENDING");
    await waitUntil(() => setup.provider.resolveCalls.length === 1);
    expect(setup.provider.resolveCalls[0]?.payload.decision).toBe("approved_once");

    const duplicateStart = secondTab.messages.length;
    send(secondTab, firstResolution);
    const duplicate = await waitForCommand(
      secondTab,
      "approval-command-a",
      duplicateStart,
    );
    expect(duplicate.type).toBe("command.accepted");
    expect(setup.provider.resolveCalls).toHaveLength(1);
    secondTab.socket.close();
  });

  it("expires a late approval and sends only a safe decline to the provider", async () => {
    const setup = await approvalSetup(Date.now() + 40);
    const approval = await requestApproval(setup.firstTab, "expiring-turn");
    await new Promise((resolve) => setTimeout(resolve, 60));
    send(setup.firstTab, approvalCommand(approval, "expired-command"));

    const result = await waitForCommand(setup.firstTab, "expired-command");
    expect(result.type).toBe("command.rejected");
    if (result.type === "command.rejected") {
      expect(result.payload.error.code).toBe("APPROVAL_EXPIRED");
    }
    await waitFor(setup.firstTab, "approval.expired");
    await waitUntil(() => setup.provider.resolveCalls.length === 1);
    expect(setup.provider.resolveCalls[0]?.payload.decision).toBe("declined");
  });

  it("expires pending authority without requiring a browser action", async () => {
    const setup = await approvalSetup(Date.now() + 40);
    await requestApproval(setup.firstTab, "passive-expiry-turn");

    await waitFor(setup.firstTab, "approval.expired");
    await waitUntil(() => setup.provider.resolveCalls.length === 1);
    expect(setup.provider.resolveCalls[0]?.payload.decision).toBe("declined");
  });

  it("invalidates a pending approval on provider death", async () => {
    const setup = await approvalSetup();
    const approval = await requestApproval(setup.firstTab, "lost-turn");
    setup.provider.lose();
    await waitFor(setup.firstTab, "approval.invalidated");
    await waitFor(setup.firstTab, "turn.outcome_unknown");

    send(setup.firstTab, approvalCommand(approval, "late-after-loss"));
    const result = await waitForCommand(setup.firstTab, "late-after-loss");
    expect(result.type).toBe("command.rejected");
    expect(setup.provider.resolveCalls).toHaveLength(0);
  });

  it("rejects an old approval after Connector runtime generation changes", async () => {
    const directory = temporaryDirectory();
    const core = await startCoreServer({
      port: 0,
      dbPath: join(directory, "core.db"),
      connectorLossGraceMs: 500,
    });
    handles.push(core);
    const firstProvider = new ApprovalProvider();
    const journalPath = join(directory, "connector.db");
    const firstConnector = startConnector({
      coreUrl: core.connectorUrl,
      connectorToken: core.connectorToken,
      provider: firstProvider,
      providerName: "approval-test",
      journalPath,
      reconnectDelayMs: 20,
    });
    handles.push(firstConnector);
    await firstConnector.ready;
    const browser = await openBrowser(
      core.browserUrl,
      core.browserToken,
      "generation-session",
    );
    const approval = await requestApproval(browser, "generation-turn");

    await firstConnector.close();
    handles.splice(handles.indexOf(firstConnector), 1);
    const secondProvider = new ApprovalProvider();
    const secondConnector = startConnector({
      coreUrl: core.connectorUrl,
      connectorToken: core.connectorToken,
      provider: secondProvider,
      providerName: "approval-test",
      journalPath,
      reconnectDelayMs: 20,
    });
    handles.push(secondConnector);
    await secondConnector.ready;
    await waitFor(browser, "approval.invalidated");
    expect(secondConnector.identity.generation).toBe(
      firstConnector.identity.generation + 1,
    );

    send(browser, approvalCommand(approval, "stale-generation-command"));
    const result = await waitForCommand(browser, "stale-generation-command");
    expect(result.type).toBe("command.rejected");
    expect(secondProvider.resolveCalls).toHaveLength(0);
    browser.socket.close();
  });

  it("records interrupt acknowledgement while a command activity is executing", async () => {
    const core = await startCoreServer({ port: 0, dbPath: ":memory:" });
    handles.push(core);
    const provider = new InterruptingProvider();
    const connector = startConnector({
      coreUrl: core.connectorUrl,
      connectorToken: core.connectorToken,
      provider,
      providerName: "interrupt-test",
      journalPath: ":memory:",
    });
    handles.push(connector);
    await connector.ready;
    const browser = await openBrowser(
      core.browserUrl,
      core.browserToken,
      "interrupt-session",
    );
    send(
      browser,
      makeEnvelope("turn.submit", {
        commandId: "interrupt-turn-command",
        sessionId: "interrupt-session",
        prompt: "run held command",
      }),
    );
    const started = await waitFor(browser, "activity.started");
    send(
      browser,
      makeEnvelope("turn.interrupt", {
        commandId: "interrupt-command",
        sessionId: "interrupt-session",
        turnId: started.payload.activity.turnId,
      }),
    );

    expect((await waitForCommand(browser, "interrupt-command")).type).toBe(
      "command.accepted",
    );
    expect((await waitFor(browser, "interrupt.result")).payload.status).toBe(
      "accepted",
    );
    const completed = await waitFor(browser, "activity.completed");
    expect(completed.payload.activity.status).toBe("interrupted");
    await waitFor(browser, "turn.interrupted");
    expect(provider.interruptCalls).toBe(1);
    browser.socket.close();
  });

  it("persists an uncertain provider command failure without leaking its error", async () => {
    const core = await startCoreServer({ port: 0, dbPath: ":memory:" });
    handles.push(core);
    const provider = new SecretInterruptProvider();
    const connector = startConnector({
      coreUrl: core.connectorUrl,
      connectorToken: core.connectorToken,
      provider,
      providerName: "secret-interrupt-test",
      journalPath: ":memory:",
    });
    handles.push(connector);
    await connector.ready;
    const browser = await openBrowser(
      core.browserUrl,
      core.browserToken,
      "secret-interrupt-session",
    );
    send(
      browser,
      makeEnvelope("turn.submit", {
        commandId: "secret-turn-command",
        sessionId: "secret-interrupt-session",
        prompt: "run held command",
      }),
    );
    const activity = await waitFor(browser, "activity.started");
    const interrupt = makeEnvelope("turn.interrupt", {
      commandId: "secret-interrupt-command",
      sessionId: "secret-interrupt-session",
      turnId: activity.payload.activity.turnId,
    });
    send(browser, interrupt);
    await waitFor(browser, "turn.outcome_unknown");
    const retryStart = browser.messages.length;
    send(browser, interrupt);
    const durableResult = await waitForCommand(
      browser,
      "secret-interrupt-command",
      retryStart,
    );

    expect(durableResult.type).toBe("command.rejected");
    expect(JSON.stringify(browser.messages)).not.toContain("AICL_TEST_SECRET");
    browser.socket.close();
  });
});

class ApprovalProvider implements ConnectorProvider {
  readonly resolveCalls: ApprovalResolveCommand[] = [];
  readonly #lostListeners = new Set<() => void>();
  #active:
    | { command: TurnStartCommand; emit: ConnectorEmit; finish(): void }
    | undefined;
  readonly #expiresAt: number | undefined;

  constructor(expiresAt?: number) {
    this.#expiresAt = expiresAt;
  }

  onLost(listener: () => void) {
    this.#lostListeners.add(listener);
    return () => this.#lostListeners.delete(listener);
  }

  async startTurn(command: TurnStartCommand, emit: ConnectorEmit) {
    emitNormalized(
      emit,
      makeEnvelope("connector.session.bound", {
        sessionId: command.payload.sessionId,
        providerSessionId: `provider-${command.payload.sessionId}`,
      }),
    );
    emitNormalized(
      emit,
      makeEnvelope("connector.turn.bound", {
        sessionId: command.payload.sessionId,
        turnId: command.payload.turnId,
        providerTurnId: `provider-${command.payload.turnId}`,
      }),
    );
    const activityId = `activity-${command.payload.turnId}`;
    emitNormalized(
      emit,
      makeEnvelope("connector.activity.started", {
        sessionId: command.payload.sessionId,
        activity: activity(activityId, command.payload.turnId, "running"),
      }),
    );
    const approval: Approval = {
      approvalId: `approval-${command.payload.turnId}`,
      sessionId: command.payload.sessionId,
      runtimeId: command.payload.runtimeId,
      runtimeGeneration: command.payload.runtimeGeneration,
      turnId: command.payload.turnId,
      actionType: "command",
      state: "pending",
      revision: 0,
      expiresAt: new Date(this.#expiresAt ?? Date.now() + 60_000).toISOString(),
      payload: {
        summary: "pnpm test",
        command: "pnpm test",
        cwd: process.cwd(),
        reason: "test approval",
        activityId,
        fileChangeId: null,
      },
      resolvedAt: null,
      resolvedByDeviceId: null,
    };
    emitNormalized(
      emit,
      makeEnvelope("connector.approval.requested", {
        sessionId: command.payload.sessionId,
        approval,
        providerCorrelationId: `correlation-${command.payload.turnId}`,
      }),
    );
    await new Promise<void>((resolve) => {
      this.#active = { command, emit, finish: resolve };
    });
  }

  async resolveApproval(command: ApprovalResolveCommand) {
    this.resolveCalls.push(command);
    const active = this.#active;
    if (active === undefined) throw new Error("No pending provider approval");
    emitNormalized(
      active.emit,
      makeEnvelope("connector.activity.completed", {
        sessionId: active.command.payload.sessionId,
        activity: activity(
          `activity-${active.command.payload.turnId}`,
          active.command.payload.turnId,
          command.payload.decision === "approved_once" ? "completed" : "declined",
        ),
      }),
    );
    emitNormalized(
      active.emit,
      makeEnvelope("connector.turn.completed", {
        sessionId: active.command.payload.sessionId,
        turnId: active.command.payload.turnId,
      }),
    );
    this.#active = undefined;
    active.finish();
  }

  async interrupt() {}

  lose() {
    const active = this.#active;
    if (active === undefined) return;
    emitNormalized(
      active.emit,
      makeEnvelope("connector.turn.outcome_unknown", {
        sessionId: active.command.payload.sessionId,
        turnId: active.command.payload.turnId,
      }),
    );
    this.#active = undefined;
    active.finish();
    for (const listener of this.#lostListeners) listener();
  }

  async close() {
    const active = this.#active;
    this.#active = undefined;
    active?.finish();
  }
}

class InterruptingProvider implements ConnectorProvider {
  interruptCalls = 0;
  #active:
    | { command: TurnStartCommand; emit: ConnectorEmit; finish(): void }
    | undefined;

  onLost() {
    return () => undefined;
  }

  async startTurn(command: TurnStartCommand, emit: ConnectorEmit) {
    emitNormalized(
      emit,
      makeEnvelope("connector.session.bound", {
        sessionId: command.payload.sessionId,
        providerSessionId: "interrupt-provider-session",
      }),
    );
    emitNormalized(
      emit,
      makeEnvelope("connector.turn.bound", {
        sessionId: command.payload.sessionId,
        turnId: command.payload.turnId,
        providerTurnId: "interrupt-provider-turn",
      }),
    );
    emitNormalized(
      emit,
      makeEnvelope("connector.activity.started", {
        sessionId: command.payload.sessionId,
        activity: activity("interrupt-activity", command.payload.turnId, "running"),
      }),
    );
    await new Promise<void>((resolve) => {
      this.#active = { command, emit, finish: resolve };
    });
  }

  async interrupt() {
    this.interruptCalls += 1;
    const active = this.#active;
    if (active === undefined) throw new Error("No command activity is running");
    emitNormalized(
      active.emit,
      makeEnvelope("connector.activity.completed", {
        sessionId: active.command.payload.sessionId,
        activity: {
          ...activity("interrupt-activity", active.command.payload.turnId, "completed"),
          status: "interrupted",
        },
      }),
    );
    emitNormalized(
      active.emit,
      makeEnvelope("connector.turn.interrupted", {
        sessionId: active.command.payload.sessionId,
        turnId: active.command.payload.turnId,
      }),
    );
    this.#active = undefined;
    active.finish();
  }

  async resolveApproval() {}

  async close() {
    const active = this.#active;
    this.#active = undefined;
    active?.finish();
  }
}

class SecretInterruptProvider extends InterruptingProvider {
  override async interrupt() {
    throw new Error("Authorization: Bearer AICL_TEST_SECRET");
  }
}

function activity(
  activityId: string,
  turnId: string,
  status: "running" | "completed" | "declined",
) {
  return {
    activityId,
    turnId,
    kind: "command" as const,
    title: "pnpm test",
    cwd: process.cwd(),
    status,
    revision: status === "running" ? 0 : 1,
    exitCode: status === "completed" ? 0 : null,
    durationMs: status === "running" ? null : 10,
    outputPreview: "",
  };
}

async function approvalSetup(expiresAt?: number) {
  const core = await startCoreServer({ port: 0, dbPath: ":memory:" });
  handles.push(core);
  const provider = new ApprovalProvider(expiresAt);
  const connector = startConnector({
    coreUrl: core.connectorUrl,
    connectorToken: core.connectorToken,
    provider,
    providerName: "approval-test",
    journalPath: ":memory:",
  });
  handles.push(connector);
  await connector.ready;
  const firstTab = await openBrowser(
    core.browserUrl,
    core.browserToken,
    "approval-session",
  );
  return { core, provider, connector, firstTab };
}

async function requestApproval(browser: BrowserHarness, commandId: string) {
  send(
    browser,
    makeEnvelope("turn.submit", {
      commandId,
      sessionId:
        browser.messages.find((message) => message.type === "session.snapshot")
          ?.payload.snapshot.sessionId ?? "approval-session",
      prompt: "request approval",
    }),
  );
  const requested = await waitFor(browser, "approval.requested");
  return requested.payload.approval;
}

function approvalCommand(approval: Approval, commandId: string) {
  return makeEnvelope("approval.resolve", {
    commandId,
    sessionId: approval.sessionId,
    approvalId: approval.approvalId,
    expectedRevision: approval.revision,
    decision: "approved_once" as const,
    deviceId: "browser-test",
  });
}

async function openBrowser(
  url: string,
  token: string,
  sessionId: string,
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
  send(browser, makeEnvelope("session.subscribe", { sessionId, afterSeq: 0 }));
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
) {
  await waitUntil(() => browser.messages.some((message) => message.type === type), timeoutMs);
  return browser.messages.find(
    (message): message is Extract<ServerEnvelope, { type: T }> =>
      message.type === type,
  )!;
}

async function waitForCommand(
  browser: BrowserHarness,
  commandId: string,
  afterIndex = 0,
) {
  await waitUntil(() =>
    browser.messages.slice(afterIndex).some(
      (message) =>
        (message.type === "command.accepted" ||
          message.type === "command.rejected") &&
        message.payload.commandId === commandId,
    ),
  );
  return browser.messages.slice(afterIndex).find(
    (
      message,
    ): message is Extract<
      ServerEnvelope,
      { type: "command.accepted" | "command.rejected" }
    > =>
      (message.type === "command.accepted" ||
        message.type === "command.rejected") &&
      message.payload.commandId === commandId,
  )!;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

function emitNormalized(emit: ConnectorEmit, value: unknown) {
  emit(ConnectorEnvelopeSchema.parse(value));
}

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "aicl-approval-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
