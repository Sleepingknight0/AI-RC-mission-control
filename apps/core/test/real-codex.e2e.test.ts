import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { startConnector, type ConnectorHandle } from "@aicl/connector";
import { CodexProvider } from "@aicl/connector/codex";
import { probeInstalledCodex } from "@aicl/connector/compatibility";
import { readProviderFleet } from "@aicl/connector/provider-inventory";
import { loadAiclConfig } from "@aicl/config";
import {
  ServerEnvelopeSchema,
  makeEnvelope,
  websocketCapability,
  type ServerEnvelope,
} from "@aicl/protocol";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { startCoreServer, type CoreServerHandle } from "../src/server.js";

const enabled = process.env.AICL_REAL_CODEX === "1";
const handles: Array<{ close(): Promise<void> }> = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(handles.splice(0).reverse().map((handle) => handle.close()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.skipIf(!enabled)("real Codex browser vertical slice", () => {
  it("streams, interrupts, classifies death, and resumes without replay", async () => {
    const core: CoreServerHandle = await startCoreServer({
      port: 0,
      dbPath: ":memory:",
    });
    handles.push(core);
    const directory = temporaryDirectory();
    const journalPath = join(directory, "connector.db");
    const projectPath = resolve("../../spikes/fixture-project");
    const config = loadAiclConfig({ repositoryRoot: resolve("../..") }).config;
    const compatibility = probeInstalledCodex();
    if (!compatibility.compatible || compatibility.installedVersion === null) {
      throw new Error("Installed Codex compatibility gate did not pass");
    }
    const inventoryEvidence = {
      activeProviderId: "codex",
      knownVersions: { codex: compatibility.installedVersion },
      knownCompatibility: { codex: "compatible" as const },
    };
    const initialFleet = readProviderFleet({
      revision: 1,
      activeAccountId: config.provider.profile,
      ...inventoryEvidence,
    });
    const inventoryAccounts =
      initialFleet.providers.find((candidate) => candidate.providerId === "codex")
        ?.accounts ?? [];
    const accountId = config.provider.profile;
    if (!inventoryAccounts.some((candidate) => candidate.accountId === accountId)) {
      throw new Error("The exact configured Codex profile is absent from inventory");
    }
    const provider = new CodexProvider({
      cwd: projectPath,
      allowedRoots: [projectPath],
      accountId,
      codexHome: config.provider.codexHome,
    });
    let connector: ConnectorHandle = startConnector({
      coreUrl: core.connectorUrl,
      connectorToken: core.connectorToken,
      provider,
      providerName: "codex",
      journalPath,
      providerInventory: async (revision) =>
        provider.enrichProviderFleet(
          readProviderFleet({
            revision,
            activeAccountId: accountId,
            ...inventoryEvidence,
          }),
          accountId,
        ),
    });
    handles.push(connector);
    await connector.ready;
    const browser = await openBrowser(core.browserUrl, core.browserToken);
    const providers = await waitFor(browser, "providers.snapshot");
    const codex = providers.payload.snapshot.providers.find(
      (providerRecord) => providerRecord.providerId === "codex",
    );
    const account = codex?.accounts.find(
      (candidate) =>
        candidate.authentication === "authenticated" &&
        candidate.control === "remote_control",
    );
    if (account === undefined) throw new Error("No controllable Codex account");
    send(
      browser,
      makeEnvelope("session.create", {
        commandId: "real-codex-session-create",
        sessionId: "real-codex-session",
        deviceId: "real-codex-device",
        title: "Real Codex final gate",
        providerId: "codex",
        accountId: account.accountId,
        projectPath,
        model: null,
        reasoningLevel: null,
      }),
    );
    const prepared = await waitFor(
      browser,
      "session.provider.status",
      (message) => message.payload.commandId === "real-codex-session-create",
    );
    expect(prepared.payload.status).toBe("ready");

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
    await waitForTurnDelta(browser, accepted.payload.turnId);
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
    await waitForTurnDelta(browser, interruptTurn.payload.turnId);
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
    await waitForTurnDelta(browser, killTurn.payload.turnId);
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
        commandId: "real-lost-runtime-rejection",
        sessionId: "real-codex-session",
        prompt: "This prompt must not be accepted by the lost Runtime.",
      }),
    );
    await waitFor(browser, "command.rejected", (message) =>
      message.payload.commandId === "real-lost-runtime-rejection" &&
      message.payload.error.code === "RUNTIME_NOT_READY",
    );

    const firstGeneration = connector.identity.generation;
    await connector.close();
    handles.splice(handles.indexOf(connector), 1);
    const restartMessageIndex = browser.messages.length;
    const resumedProvider = new CodexProvider({
      cwd: projectPath,
      allowedRoots: [projectPath],
      accountId,
      codexHome: config.provider.codexHome,
    });
    connector = startConnector({
      coreUrl: core.connectorUrl,
      connectorToken: core.connectorToken,
      provider: resumedProvider,
      providerName: "codex",
      journalPath,
      providerInventory: async (revision) =>
        resumedProvider.enrichProviderFleet(
          readProviderFleet({
            revision,
            activeAccountId: accountId,
            ...inventoryEvidence,
          }),
          accountId,
        ),
    });
    handles.push(connector);
    await connector.ready;
    expect(connector.identity.generation).toBe(firstGeneration + 1);
    await waitFor(browser, "runtime.status", (message) =>
      message.payload.runtime.generation === connector.identity.generation &&
      message.payload.runtime.status === "ready",
    );
    const resumedAccount = await waitFor(
      browser,
      "provider.account.capabilities.snapshot",
      (message) =>
        message.payload.snapshot.providerId === "codex" &&
        message.payload.snapshot.accountId === accountId &&
        message.payload.snapshot.active &&
        message.payload.snapshot.authentication === "authenticated" &&
        message.payload.snapshot.control === "remote_control" &&
        message.payload.snapshot.freshness === "live" &&
        message.payload.snapshot.revision >= 2,
      90_000,
      restartMessageIndex,
    );
    send(
      browser,
      makeEnvelope("session.runtime.resume", {
        commandId: "real-runtime-resume",
        sessionId: "real-codex-session",
        deviceId: "real-codex-device",
        expectedAccountRevision: resumedAccount.payload.snapshot.revision,
        expectedRuntimeId: connector.identity.runtimeId,
        expectedRuntimeGeneration: connector.identity.generation,
      }),
    );
    await waitFor(browser, "session.command.accepted", (message) =>
      message.payload.commandId === "real-runtime-resume",
    );
    await waitFor(browser, "session.provider.status", (message) =>
      message.payload.commandId === "real-runtime-resume" &&
      message.payload.status === "ready" &&
      message.payload.runtimeId === connector.identity.runtimeId &&
      message.payload.runtimeGeneration === connector.identity.generation,
    );
    await waitFor(
      browser,
      "session.capabilities.snapshot",
      (message) =>
        message.payload.snapshot.sessionId === "real-codex-session" &&
        message.payload.snapshot.controlAuthority.canControl,
      90_000,
      restartMessageIndex,
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

async function waitForTurnDelta(
  browser: BrowserHarness,
  turnId: string,
  timeoutMs = 90_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const delta = browser.messages.find(
      (message) =>
        message.type === "assistant.message.delta" &&
        message.payload.turnId === turnId,
    );
    if (delta?.type === "assistant.message.delta") return delta;
    const terminal = browser.messages.find(
      (message) =>
        (message.type === "turn.completed" ||
          message.type === "turn.failed" ||
          message.type === "turn.outcome_unknown" ||
          message.type === "turn.interrupted") &&
        message.payload.turnId === turnId,
    );
    if (terminal !== undefined) {
      const failureCode =
        terminal.type === "turn.failed" ? `:${terminal.payload.failureCode}` : "";
      throw new Error(
        `Real Codex Turn ended before first delta: ${terminal.type}${failureCode}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for first delta for Turn ${turnId}`);
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
  afterIndex = 0,
): Promise<Extract<ServerEnvelope, { type: T }>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = browser.messages.slice(afterIndex).find(
      (message): message is Extract<ServerEnvelope, { type: T }> =>
        message.type === type &&
        predicate(message as Extract<ServerEnvelope, { type: T }>),
    );
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const breadcrumbs = browser.messages
    .slice(-24)
    .map((message) => {
      if (message.type === "command.rejected") {
        return `${message.type}:${message.payload.error.code}`;
      }
      if (message.type === "runtime.status") {
        return `${message.type}:${message.payload.runtime.status}`;
      }
      if (
        message.type === "turn.completed" ||
        message.type === "turn.interrupted" ||
        message.type === "turn.outcome_unknown"
      ) {
        return `${message.type}:${message.payload.turnId}`;
      }
      if (message.type === "turn.failed") {
        return `${message.type}:${message.payload.failureCode}:${message.payload.turnId}`;
      }
      return message.type;
    })
    .join(", ");
  throw new Error(
    `Timed out waiting for real Codex event ${type}; recent events: ${breadcrumbs}`,
  );
}

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "aicl-real-e2e-"));
  temporaryDirectories.push(directory);
  return directory;
}
