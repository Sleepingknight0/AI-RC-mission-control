import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { startConnector, type ConnectorHandle } from "@aicl/connector";
import { CodexProvider } from "@aicl/connector/codex";
import { probeInstalledCodex } from "@aicl/connector/compatibility";
import { readProviderFleet } from "@aicl/connector/provider-inventory";
import { loadAiclConfig } from "@aicl/config";
import {
  ServerEnvelopeSchema,
  makeEnvelope,
  websocketCapability,
  type Approval,
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
  it("streams, steers, interrupts, writes, and fails closed after ownership loss", async () => {
    const core: CoreServerHandle = await startCoreServer({
      port: 0,
      dbPath: ":memory:",
    });
    handles.push(core);
    const disposableParent = process.env.AICL_REAL_CODEX_PROJECT_PARENT;
    if (disposableParent === undefined) {
      throw new Error(
        "AICL_REAL_CODEX_PROJECT_PARENT must name an existing non-temporary disposable parent",
      );
    }
    const directory = temporaryDirectory(disposableParent);
    const journalPath = join(directory, "connector.db");
    const projectPath = join(directory, "project");
    mkdirSync(projectPath);
    const readmePath = join(projectPath, "README.md");
    const readmeContents = "# AICL remote fixture\n\nA disposable remote-control acceptance project.\n";
    writeFileSync(readmePath, readmeContents, "utf8");
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
    const accountCapabilities = await waitFor(
      browser,
      "provider.account.capabilities.snapshot",
      (message) =>
        message.payload.snapshot.providerId === "codex" &&
        message.payload.snapshot.accountId === account.accountId &&
        message.payload.snapshot.active &&
        message.payload.snapshot.authentication === "authenticated" &&
        message.payload.snapshot.control === "remote_control" &&
        message.payload.snapshot.freshness === "live",
    );
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
    expect(prepared.payload.providerSessionId).not.toBeNull();
    const providerSessionId = prepared.payload.providerSessionId!;

    send(
      browser,
      makeEnvelope("session.subscribe", {
        sessionId: "real-codex-session",
        afterSeq: 0,
      }),
    );
    await waitFor(browser, "session.snapshot");
    const initialSettings = await waitFor(
      browser,
      "session.settings.snapshot",
      (message) => message.payload.snapshot.sessionId === "real-codex-session",
    );

    send(
      browser,
      makeEnvelope("turn.submit", {
        commandId: "real-complete-1",
        sessionId: "real-codex-session",
        prompt: "Inspect README.md and summarize its contents.\nDo not modify files.",
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
    const readResult = await settleTurnWithApprovals(
      browser,
      accepted.payload.turnId,
      projectPath,
      "approved_once",
    );
    expect(readResult.terminal.type).toBe("turn.completed");
    expect(readResult.approvals.length).toBeGreaterThanOrEqual(1);
    const resolvedApproval = readResult.approvals[0]!;
    send(
      browser,
      makeEnvelope("approval.resolve", {
        commandId: "real-approval-stale-duplicate",
        sessionId: "real-codex-session",
        approvalId: resolvedApproval.approvalId,
        expectedRevision: resolvedApproval.revision,
        decision: "approved_once",
        deviceId: "real-codex-device-b",
      }),
    );
    await waitFor(browser, "command.rejected", (message) =>
      message.payload.commandId === "real-approval-stale-duplicate" &&
      message.payload.error.code === "APPROVAL_NOT_PENDING",
    );
    expect(completedTurnText(browser, accepted.payload.turnId)).toMatch(
      /disposable|remote-control|fixture/i,
    );
    expect(readFileSync(readmePath, "utf8")).toBe(readmeContents);
    expect(readdirSync(projectPath).sort()).toEqual(["README.md"]);

    const selectedModel =
      accountCapabilities.payload.snapshot.models.find(
        (model) => model.isDefault && !model.hidden,
      ) ??
      accountCapabilities.payload.snapshot.models.find((model) => !model.hidden);
    if (selectedModel === undefined) {
      throw new Error("The exact Codex account advertised no usable model");
    }
    const selectedReasoning =
      selectedModel.reasoningEfforts.find(
        (option) => option.value === selectedModel.defaultReasoningEffort,
      ) ??
      selectedModel.reasoningEfforts.find((option) =>
        ["low", "medium", "high", "xhigh"].includes(option.value),
      );
    if (selectedReasoning === undefined) {
      throw new Error("The selected Codex model advertised no supported reasoning effort");
    }
    const acceptedSettings = {
      ...initialSettings.payload.snapshot.settings,
      model: selectedModel.modelId,
      reasoningLevel: selectedReasoning.value,
      sandboxPolicy: "workspace_write" as const,
    };
    send(
      browser,
      makeEnvelope("session.settings.update", {
        commandId: "real-settings-update",
        sessionId: "real-codex-session",
        deviceId: "real-codex-device-a",
        expectedRevision: initialSettings.payload.snapshot.revision,
        settings: acceptedSettings,
      }),
    );
    const updatedSettings = await waitFor(
      browser,
      "session.settings.snapshot",
      (message) =>
        message.payload.snapshot.sessionId === "real-codex-session" &&
        message.payload.snapshot.revision === initialSettings.payload.snapshot.revision + 1,
    );
    expect(updatedSettings.payload.snapshot.settings).toMatchObject({
      model: selectedModel.modelId,
      reasoningLevel: selectedReasoning.value,
      sandboxPolicy: "workspace_write",
    });
    send(
      browser,
      makeEnvelope("session.settings.update", {
        commandId: "real-settings-stale",
        sessionId: "real-codex-session",
        deviceId: "real-codex-device-b",
        expectedRevision: initialSettings.payload.snapshot.revision,
        settings: initialSettings.payload.snapshot.settings,
      }),
    );
    await waitFor(browser, "command.rejected", (message) =>
      message.payload.commandId === "real-settings-stale" &&
      message.payload.error.code === "SESSION_SETTINGS_CONFLICT",
    );

    send(
      browser,
      makeEnvelope("turn.submit", {
        commandId: "real-write-turn",
        sessionId: "real-codex-session",
        prompt:
          "Create a file named remote-control-proof.txt containing exactly:\nAICL REMOTE CONTROL PASS",
      }),
    );
    const writeTurn = await waitFor(browser, "command.accepted", (message) =>
      message.payload.commandId === "real-write-turn",
    );
    const writeResult = await settleTurnWithApprovals(
      browser,
      writeTurn.payload.turnId,
      projectPath,
      "approved_once",
    );
    expect(writeResult.terminal.type).toBe("turn.completed");
    expect(
      readFileSync(join(projectPath, "remote-control-proof.txt"), "utf8").trim(),
    ).toBe("AICL REMOTE CONTROL PASS");
    expect(readdirSync(projectPath).sort()).toEqual([
      "README.md",
      "remote-control-proof.txt",
    ]);
    const fileChange = await waitFor(
      browser,
      "file.change.completed",
      (message) => message.payload.fileChange.turnId === writeTurn.payload.turnId,
    );
    expect(fileChange.payload.fileChange.files).toEqual([
      expect.objectContaining({ path: "remote-control-proof.txt", kind: "add" }),
    ]);
    expect(fileChange.payload.fileChange.diff).not.toBeNull();
    expect(
      browser.messages.some(
        (message) =>
          message.type === "activity.completed" &&
          [accepted.payload.turnId, writeTurn.payload.turnId].includes(
            message.payload.activity.turnId,
          ),
      ),
    ).toBe(true);

    const refreshedBrowser = await openBrowser(core.browserUrl, core.browserToken);
    send(
      refreshedBrowser,
      makeEnvelope("session.subscribe", {
        sessionId: "real-codex-session",
        afterSeq: 0,
      }),
    );
    const refreshedSnapshot = await waitFor(
      refreshedBrowser,
      "session.snapshot",
      (message) => message.payload.snapshot.sessionId === "real-codex-session",
    );
    expect(refreshedSnapshot.payload.snapshot.providerSessionId).toBe(
      providerSessionId,
    );
    const restoredTurns = refreshedSnapshot.payload.snapshot.turns;
    expect(new Set(restoredTurns.map((turn) => turn.turnId)).size).toBe(
      restoredTurns.length,
    );
    expect(
      restoredTurns.find((turn) => turn.turnId === writeTurn.payload.turnId),
    ).toMatchObject({
      settingsRevision: updatedSettings.payload.snapshot.revision,
      effectiveSettings: {
        model: selectedModel.modelId,
        reasoningLevel: selectedReasoning.value,
      },
    });
    refreshedBrowser.socket.close();

    send(
      browser,
      makeEnvelope("turn.submit", {
        commandId: "real-steer-turn",
        sessionId: "real-codex-session",
        prompt:
          "Do not use tools. Begin writing 200 numbered lines in the format NNN AICL_STEER_TEST.",
      }),
    );
    const steerTurn = await waitFor(browser, "command.accepted", (message) =>
      message.payload.commandId === "real-steer-turn",
    );
    await waitForTurnDelta(browser, steerTurn.payload.turnId);
    send(
      browser,
      makeEnvelope("turn.steer", {
        commandId: "real-steer-command",
        sessionId: "real-codex-session",
        turnId: steerTurn.payload.turnId,
        instruction: "Stop the numbered list and reply with exactly: AICL_STEERED",
      }),
    );
    await waitFor(browser, "command.accepted", (message) =>
      message.payload.commandId === "real-steer-command",
    );
    send(
      browser,
      makeEnvelope("turn.interrupt", {
        commandId: "real-steered-turn-interrupt",
        sessionId: "real-codex-session",
        turnId: steerTurn.payload.turnId,
      }),
    );
    await waitFor(browser, "turn.interrupted", (message) =>
      message.payload.turnId === steerTurn.payload.turnId,
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
    await waitFor(
      browser,
      "command.rejected",
      (message) =>
        message.payload.commandId === "real-runtime-resume" &&
        message.payload.error.code === "SESSION_NOT_CONTROLLABLE",
    );
    expect(
      browser.messages.filter(
        (message) =>
          message.type === "command.accepted" &&
          message.payload.commandId === "real-steer-turn",
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(browser.messages)).not.toMatch(
      /item\/agentMessage\/delta|providerPayload|rawEvent/,
    );
    browser.socket.close();
  }, 360_000);
});

interface BrowserHarness {
  socket: WebSocket;
  messages: ServerEnvelope[];
}

async function settleTurnWithApprovals(
  browser: BrowserHarness,
  turnId: string,
  projectPath: string,
  decision: "approved_once" | "declined",
  timeoutMs = 120_000,
) {
  const handled = new Set<string>();
  const approvals: Approval[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const requests = browser.messages.filter(
      (
        message,
      ): message is Extract<ServerEnvelope, { type: "approval.requested" }> =>
        message.type === "approval.requested" &&
        message.payload.approval.turnId === turnId,
    );
    for (const request of requests) {
      const approval = request.payload.approval;
      if (handled.has(approval.approvalId)) continue;
      if (
        approval.sessionId !== "real-codex-session" ||
        (approval.payload.cwd !== null &&
          !pathIsContained(projectPath, approval.payload.cwd))
      ) {
        throw new Error("Real Codex approval escaped its exact Session or project");
      }
      handled.add(approval.approvalId);
      approvals.push(approval);
      send(
        browser,
        makeEnvelope("approval.resolve", {
          commandId: `real-approval-${turnId}-${approvals.length}`,
          sessionId: "real-codex-session",
          approvalId: approval.approvalId,
          expectedRevision: approval.revision,
          decision,
          deviceId: "real-codex-device-a",
        }),
      );
      await waitFor(browser, "approval.resolved", (message) =>
        message.payload.approval.approvalId === approval.approvalId &&
        message.payload.approval.state === decision,
      );
    }
    const terminal = browser.messages.find(
      (message) =>
        (message.type === "turn.completed" ||
          message.type === "turn.failed" ||
          message.type === "turn.interrupted" ||
          message.type === "turn.outcome_unknown") &&
        message.payload.turnId === turnId,
    );
    if (terminal !== undefined) return { terminal, approvals };
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(
    `Timed out settling real Codex Turn; approvals=${approvals.length}`,
  );
}

function pathIsContained(rootPath: string, candidatePath: string) {
  const child = relative(resolve(rootPath), resolve(candidatePath));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function completedTurnText(browser: BrowserHarness, turnId: string) {
  return browser.messages
    .filter(
      (
        message,
      ): message is Extract<ServerEnvelope, { type: "assistant.message.completed" }> =>
        message.type === "assistant.message.completed" &&
        message.payload.turnId === turnId,
    )
    .map((message) => message.payload.content)
    .join("\n");
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

function temporaryDirectory(parentPath: string) {
  const parent = resolve(parentPath);
  if (!existsSync(parent)) {
    throw new Error("Real Codex disposable parent does not exist");
  }
  const directory = mkdtempSync(join(parent, "aicl-real-e2e-"));
  const child = relative(parent, directory);
  if (child === "" || child.startsWith("..") || isAbsolute(child)) {
    throw new Error("Real Codex disposable project escaped its declared parent");
  }
  temporaryDirectories.push(directory);
  return directory;
}
