import { startConnector } from "@aicl/connector";
import { MockProvider } from "@aicl/connector/mock-provider";
import type {
  ManagedProviderAccount,
  ProviderAccountController,
} from "@aicl/connector/provider";
import {
  ClientEnvelopeSchema,
  ConnectorEnvelopeSchema,
  ProviderAccountCapabilitySnapshotSchema,
  ServerEnvelopeSchema,
  makeEnvelope,
  websocketCapability,
  type ClientEnvelope,
  type ProviderFleetSnapshot,
  type Runtime,
  type ServerEnvelope,
} from "@aicl/protocol";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { CoreDatabase, type ConnectorSource } from "../src/store.js";
import { startCoreServer } from "../src/server.js";
import { controlledAccountCapabilities, controlledProviderFleet } from "./controlled-session-fixture.js";

const databases: CoreDatabase[] = [];
const handles: Array<{ close(): Promise<void> }> = [];
const runtimeOne: Runtime = {
  runtimeId: "runtime-account-one",
  generation: 1,
  status: "ready",
};

afterEach(async () => {
  await Promise.allSettled(handles.splice(0).reverse().map((handle) => handle.close()));
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("provider account activation authority", () => {
  it("durably accepts, terminally replays, conflicts, and marks lost outcomes unknown", async () => {
    const database = openDatabase();
    const activate = activation("activate-blue", "blue", runtimeOne);
    const accepted = await database.acceptProviderAccountActivation({
      message: activate,
      runtime: runtimeOne,
      rejection: activationRejection(activate),
    });
    expect(accepted.kind).toBe("new");
    if (accepted.kind !== "new" || accepted.dispatch === undefined) {
      throw new Error("Expected activation dispatch");
    }
    const nextRuntime: Runtime = {
      runtimeId: accepted.dispatch.nextRuntimeId,
      generation: accepted.dispatch.nextRuntimeGeneration,
      status: "ready",
    };
    const terminal = ConnectorEnvelopeSchema.parse({
      ...makeEnvelope("connector.provider.account.activated", {
        commandId: activate.payload.commandId,
        providerId: activate.payload.providerId,
        accountId: activate.payload.accountId,
        revision: 8,
        runtime: nextRuntime,
      }),
      connectorId: "connector-account",
      bootId: "boot-account",
      sourceEventId: "source-account-accepted",
      runtimeId: nextRuntime.runtimeId,
      runtimeGeneration: nextRuntime.generation,
    });
    if (terminal.type !== "connector.provider.account.activated") {
      throw new Error("Expected activation terminal");
    }
    const result = await database.recordProviderAccountActivation(
      terminal,
      source(nextRuntime, "source-account-accepted"),
    );
    expect(result).toMatchObject({
      type: "provider.account.activation.accepted",
      payload: { commandId: "activate-blue", accountId: "blue", runtime: nextRuntime },
    });

    const replay = await database.acceptProviderAccountActivation({
      message: activate,
      runtime: runtimeOne,
      rejection: activationRejection(activate),
    });
    expect(replay).toMatchObject({
      kind: "same",
      result: { type: "provider.account.activation.accepted" },
    });
    const changed = ClientEnvelopeSchema.parse({
      ...activate,
      payload: { ...activate.payload, accountId: "green" },
    });
    if (changed.type !== "provider.account.activate") {
      throw new Error("Expected changed activation");
    }
    await expect(database.acceptProviderAccountActivation({
      message: changed,
      runtime: runtimeOne,
      rejection: activationRejection(changed),
    })).resolves.toEqual({ kind: "conflict" });

    const pending = activation("activate-green", "green", nextRuntime);
    const pendingResult = await database.acceptProviderAccountActivation({
      message: pending,
      runtime: nextRuntime,
      rejection: activationRejection(pending),
    });
    expect(pendingResult).toMatchObject({ kind: "new", dispatch: {} });
    const unknown = await database.markPendingProviderAccountActivationsOutcomeUnknown();
    expect(unknown).toEqual([
      expect.objectContaining({
        type: "provider.account.activation.rejected",
        payload: expect.objectContaining({
          commandId: "activate-green",
          error: expect.objectContaining({ code: "OUTCOME_UNKNOWN" }),
        }),
      }),
    ]);
    const unknownReplay = await database.acceptProviderAccountActivation({
      message: pending,
      runtime: nextRuntime,
      rejection: activationRejection(pending),
    });
    expect(unknownReplay).toMatchObject({
      kind: "same",
      result: {
        type: "provider.account.activation.rejected",
        payload: { error: { code: "OUTCOME_UNKNOWN" } },
      },
    });
  });

  it("rejects activation while a Turn, approval, or Full Auto lease owns authority", async () => {
    const runningDatabase = openDatabase();
    await prepareReadySession(runningDatabase, "running-session", runtimeOne);
    await startTurn(runningDatabase, "running-session", "running-turn", runtimeOne);
    await expectBlocked(
      runningDatabase,
      activation("activate-during-turn", "green", runtimeOne),
      "Turn is running",
    );

    const approvalDatabase = openDatabase();
    await prepareReadySession(approvalDatabase, "approval-session", runtimeOne);
    await startTurn(approvalDatabase, "approval-session", "approval-turn", runtimeOne);
    await requestApproval(
      approvalDatabase,
      "approval-session",
      "approval-turn",
      runtimeOne,
    );
    await expectBlocked(
      approvalDatabase,
      activation("activate-during-approval", "green", runtimeOne),
      "pending approvals",
    );

    const leaseDatabase = openDatabase();
    await prepareReadySession(leaseDatabase, "lease-session", runtimeOne);
    await createLease(leaseDatabase, "lease-session", runtimeOne);
    await expectBlocked(
      leaseDatabase,
      activation("activate-during-lease", "green", runtimeOne),
      "approval leases",
    );
  });

  it("withdraws the old account's browser authority immediately after a switch", async () => {
    const core = await startCoreServer({ port: 0, dbPath: ":memory:" });
    handles.push(core);
    const controller = new TestAccountController(["blue", "green"]);
    const connector = startConnector({
      coreUrl: core.connectorUrl,
      connectorToken: core.connectorToken,
      provider: new MockProvider(),
      providerName: "account-switch-test",
      providerAccountController: controller,
      providerInventory: twoAccountFleet,
    });
    handles.push(connector);
    await connector.ready;
    const browser = await openBrowser(core.browserUrl, core.browserToken);
    await waitFor(browser, (message) => message.type === "providers.snapshot");
    const initialRuntime = await waitFor(
      browser,
      (message) => message.type === "runtime.status",
    );
    if (initialRuntime.type !== "runtime.status") throw new Error("Runtime status");

    for (const accountId of ["blue", "green"] as const) {
      browser.socket.send(JSON.stringify(makeEnvelope(
        "provider.account.capabilities.refresh",
        { providerId: "codex", accountId },
      )));
    }
    const blueInactive = await waitFor(
      browser,
      (message) =>
        message.type === "provider.account.capabilities.snapshot" &&
        message.payload.snapshot.accountId === "blue",
    );
    const greenInactive = await waitFor(
      browser,
      (message) =>
        message.type === "provider.account.capabilities.snapshot" &&
        message.payload.snapshot.accountId === "green",
    );
    if (
      blueInactive.type !== "provider.account.capabilities.snapshot" ||
      greenInactive.type !== "provider.account.capabilities.snapshot"
    ) {
      throw new Error("Account capability snapshots");
    }
    const blueAccepted = await activateThroughBrowser(
      browser,
      "activate-browser-blue",
      blueInactive.payload.snapshot.revision,
      "blue",
      initialRuntime.payload.runtime,
    );
    const blueActive = await waitFor(
      browser,
      (message) =>
        message.type === "provider.account.capabilities.snapshot" &&
        message.payload.snapshot.accountId === "blue" &&
        message.payload.snapshot.active,
    );
    expect(blueActive.type).toBe("provider.account.capabilities.snapshot");

    const switchStart = browser.messages.length;
    await activateThroughBrowser(
      browser,
      "activate-browser-green",
      greenInactive.payload.snapshot.revision,
      "green",
      blueAccepted.payload.runtime,
    );
    const demoted = await waitFor(
      browser,
      (message, index) =>
        index >= switchStart &&
        message.type === "provider.account.capabilities.snapshot" &&
        message.payload.snapshot.accountId === "blue" &&
        !message.payload.snapshot.active,
    );
    if (demoted.type !== "provider.account.capabilities.snapshot") {
      throw new Error("Demoted account snapshot");
    }
    expect(demoted.payload.snapshot).toMatchObject({
      accountId: "blue",
      active: false,
      control: "inventory_only",
    });
    browser.socket.close();
  });
});

describe("managed Session Runtime resume", () => {
  it("fences account revision/runtime and rebinds the same Session and provider identity", async () => {
    const database = openDatabase();
    await prepareReadySession(database, "managed-session", runtimeOne);
    const before = database.snapshot("managed-session");
    const authority = database.sessionProviderAuthority("managed-session");
    expect(authority).toMatchObject({
      providerId: "codex",
      accountId: "blue",
      providerSessionId: "native-managed-session",
      state: "ready",
      runtimeId: runtimeOne.runtimeId,
      runtimeGeneration: runtimeOne.generation,
      revision: 1,
    });
    const runtimeTwo: Runtime = {
      runtimeId: "runtime-account-two",
      generation: 2,
      status: "ready",
    };

    const staleBinding = runtimeResume(
      "resume-stale-binding",
      "managed-session",
      runtimeTwo,
      7,
    );
    const bindingRejected = await database.acceptSessionRuntimeResume({
      message: staleBinding,
      runtime: runtimeTwo,
      connectorId: "connector-account",
      bootId: "boot-account-two",
      expectedBindingRevision: 2,
      rejection: commandRejection(staleBinding),
    });
    expect(bindingRejected).toMatchObject({
      kind: "new",
      result: {
        type: "command.rejected",
        payload: { error: { code: "SESSION_BINDING_REVISION_CONFLICT" } },
      },
    });

    const staleRuntime = runtimeResume(
      "resume-stale-runtime",
      "managed-session",
      runtimeOne,
      1,
    );
    const runtimeRejected = await database.acceptSessionRuntimeResume({
      message: staleRuntime,
      runtime: runtimeTwo,
      connectorId: "connector-account",
      bootId: "boot-account-two",
      expectedBindingRevision: 1,
      rejection: commandRejection(staleRuntime),
    });
    expect(runtimeRejected).toMatchObject({
      kind: "new",
      result: {
        type: "command.rejected",
        payload: { error: { code: "STALE_RUNTIME_GENERATION" } },
      },
    });

    const resume = runtimeResume(
      "resume-managed-runtime",
      "managed-session",
      runtimeTwo,
      1,
    );
    const resumed = await database.acceptSessionRuntimeResume({
      message: resume,
      runtime: runtimeTwo,
      connectorId: "connector-account",
      bootId: "boot-account-two",
      expectedBindingRevision: 1,
      rejection: commandRejection(resume),
    });
    expect(resumed).toMatchObject({
      kind: "new",
      dispatch: { providerSessionId: "native-managed-session" },
    });
    expect(database.sessionProviderAuthority("managed-session")).toMatchObject({
      providerId: "codex",
      accountId: "blue",
      providerSessionId: "native-managed-session",
      state: "pending",
      runtimeId: runtimeTwo.runtimeId,
      runtimeGeneration: runtimeTwo.generation,
      revision: 2,
    });
    const after = database.snapshot("managed-session");
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.lastEventSeq).toBe(before.lastEventSeq);
    expect(after.turns).toEqual(before.turns);
    expect(after.messages).toEqual(before.messages);
    expect(after.activities).toEqual(before.activities);
    expect(database.sessionSummaries().map((session) => session.sessionId)).toEqual([
      "managed-session",
    ]);
  });
});

function openDatabase() {
  const database = new CoreDatabase({ path: ":memory:" });
  databases.push(database);
  return database;
}

function activation(commandId: string, accountId: string, runtime: Runtime) {
  const message = ClientEnvelopeSchema.parse(
    makeEnvelope("provider.account.activate", {
      commandId,
      deviceId: "device-account",
      providerId: "codex",
      accountId,
      expectedRevision: 7,
      expectedRuntimeId: runtime.runtimeId,
      expectedRuntimeGeneration: runtime.generation,
    }),
  );
  if (message.type !== "provider.account.activate") {
    throw new Error("Expected provider account activation");
  }
  return message;
}

function activationRejection(
  message: Extract<ClientEnvelope, { type: "provider.account.activate" }>,
) {
  return (code: string, detail: string): ServerEnvelope =>
    ServerEnvelopeSchema.parse(
      makeEnvelope("provider.account.activation.rejected", {
        commandId: message.payload.commandId,
        providerId: message.payload.providerId,
        accountId: message.payload.accountId,
        error: { code, message: detail, retryable: false, detail: null },
      }),
    );
}

async function expectBlocked(
  database: CoreDatabase,
  message: Extract<ClientEnvelope, { type: "provider.account.activate" }>,
  detail: string,
) {
  const result = await database.acceptProviderAccountActivation({
    message,
    runtime: runtimeOne,
    rejection: activationRejection(message),
  });
  expect(result).toMatchObject({
    kind: "new",
    result: {
      type: "provider.account.activation.rejected",
      payload: { error: { code: "ACCOUNT_ACTIVATION_BLOCKED" } },
    },
  });
  if (result.kind !== "new" || result.result === undefined) {
    throw new Error("Expected blocked activation");
  }
  expect(result.result.payload).toMatchObject({
    error: { message: expect.stringContaining(detail) },
  });
}

async function prepareReadySession(
  database: CoreDatabase,
  sessionId: string,
  runtime: Runtime,
) {
  const commandId = `prepare-${sessionId}`;
  const message = ClientEnvelopeSchema.parse(
    makeEnvelope("session.create", {
      commandId,
      sessionId,
      deviceId: "device-account",
      title: sessionId,
      providerId: "codex",
      accountId: "blue",
      projectPath: process.cwd(),
      model: null,
      reasoningLevel: null,
    }),
  );
  if (message.type !== "session.create") throw new Error("Expected Session create");
  await database.acceptSessionPreparation({
    message,
    runtime,
    connectorId: "connector-account",
    bootId: "boot-account",
    selection: {
      title: sessionId,
      source: "aicl",
      projectPath: process.cwd(),
      model: null,
      reasoningLevel: null,
      providerSessionId: null,
    },
    rejection: commandRejection(message),
  });
  await database.markDispatched(commandId);
  const prepared = ConnectorEnvelopeSchema.parse(
    makeEnvelope("connector.session.prepared", {
      commandId,
      sessionId,
      providerId: "codex",
      accountId: "blue",
      providerSessionId: `native-${sessionId}`,
      projectPath: process.cwd(),
      model: null,
      reasoningLevel: null,
    }),
  );
  if (prepared.type !== "connector.session.prepared") {
    throw new Error("Expected prepared Session");
  }
  await database.recordSessionPreparation(
    prepared,
    source(runtime, `source-prepare-${sessionId}`),
  );
}

async function startTurn(
  database: CoreDatabase,
  sessionId: string,
  turnId: string,
  runtime: Runtime,
) {
  const message = ClientEnvelopeSchema.parse(
    makeEnvelope("turn.submit", {
      commandId: `start-${turnId}`,
      sessionId,
      prompt: "bounded work",
      deviceId: "device-account",
      settingsRevision: 0,
    }),
  );
  if (message.type !== "turn.submit") throw new Error("Expected Turn submit");
  await database.acceptTurn({
    message,
    turnId,
    runtime,
    connectorId: "connector-account",
    bootId: "boot-account",
    activeRejection: commandRejection(message)(
      "TURN_ALREADY_ACTIVE",
      "A Turn is already active.",
    ),
  });
}

async function requestApproval(
  database: CoreDatabase,
  sessionId: string,
  turnId: string,
  runtime: Runtime,
) {
  const approval = ConnectorEnvelopeSchema.parse(
    makeEnvelope("connector.approval.requested", {
      sessionId,
      approval: {
        approvalId: `approval-${sessionId}`,
        sessionId,
        runtimeId: runtime.runtimeId,
        runtimeGeneration: runtime.generation,
        turnId,
        actionType: "command",
        state: "pending",
        revision: 0,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        payload: {
          summary: "Review command",
          command: "pnpm test",
          cwd: process.cwd(),
          reason: "test account activation fence",
          activityId: null,
          fileChangeId: null,
        },
        resolvedAt: null,
        resolvedByDeviceId: null,
      },
      providerCorrelationId: `correlation-${sessionId}`,
    }),
  );
  if (approval.type !== "connector.approval.requested") {
    throw new Error("Expected approval request");
  }
  await database.requestApproval(
    approval,
    source(runtime, `source-approval-${sessionId}`),
  );
}

async function createLease(
  database: CoreDatabase,
  sessionId: string,
  runtime: Runtime,
) {
  const settings = database.sessionSettings(sessionId);
  if (settings === undefined) throw new Error("Expected Session settings");
  const update = ClientEnvelopeSchema.parse(
    makeEnvelope("session.settings.update", {
      commandId: `settings-${sessionId}`,
      sessionId,
      deviceId: "device-account",
      expectedRevision: 0,
      settings: {
        ...settings.settings,
        approvalPolicy: "full_auto_lease",
        networkPolicy: "denied",
      },
    }),
  );
  if (update.type !== "session.settings.update") {
    throw new Error("Expected settings update");
  }
  await database.mutateSessionSettings(
    update,
    () => undefined,
    commandRejection(update),
  );
  const lease = ClientEnvelopeSchema.parse(
    makeEnvelope("approval.lease.create", {
      commandId: `lease-${sessionId}`,
      sessionId,
      deviceId: "device-account",
      expectedSettingsRevision: 1,
      expectedLeaseRevision: 0,
      providerId: "codex",
      accountId: "blue",
      projectPath: process.cwd(),
      runtimeId: runtime.runtimeId,
      runtimeGeneration: runtime.generation,
      durationMinutes: 15,
    }),
  );
  if (lease.type !== "approval.lease.create") throw new Error("Expected lease");
  await database.createApprovalLease({
    message: lease,
    coreBootId: "core-boot-account",
    rejection: commandRejection(lease),
  });
}

function runtimeResume(
  commandId: string,
  sessionId: string,
  runtime: Runtime,
  expectedAccountRevision: number,
) {
  const message = ClientEnvelopeSchema.parse(
    makeEnvelope("session.runtime.resume", {
      commandId,
      sessionId,
      deviceId: "device-account",
      expectedAccountRevision,
      expectedRuntimeId: runtime.runtimeId,
      expectedRuntimeGeneration: runtime.generation,
    }),
  );
  if (message.type !== "session.runtime.resume") {
    throw new Error("Expected Runtime resume");
  }
  return message;
}

function commandRejection(
  message: Extract<ClientEnvelope, { payload: { commandId: string; sessionId: string } }>,
) {
  return (code: string, detail: string): ServerEnvelope =>
    ServerEnvelopeSchema.parse(
      makeEnvelope("command.rejected", {
        commandId: message.payload.commandId,
        sessionId: message.payload.sessionId,
        error: { code, message: detail, retryable: false, detail: null },
      }),
    );
}

function source(
  runtime: Runtime,
  sourceEventId: string,
): ConnectorSource {
  return {
    connectorId: "connector-account",
    sourceEventId,
    runtimeId: runtime.runtimeId,
    runtimeGeneration: runtime.generation,
  };
}

interface BrowserHarness {
  socket: WebSocket;
  messages: ServerEnvelope[];
}

class TestAccountController implements ProviderAccountController {
  readonly #accounts: Set<string>;

  constructor(accountIds: readonly string[]) {
    this.#accounts = new Set(accountIds);
  }

  open(providerId: string, accountId: string): ManagedProviderAccount | null {
    if (providerId !== "codex" || !this.#accounts.has(accountId)) return null;
    return {
      providerId,
      accountId,
      provider: new MockProvider(),
      capabilities: async (revision, active) =>
        ProviderAccountCapabilitySnapshotSchema.parse({
          ...controlledAccountCapabilities(revision, providerId, accountId),
          active,
          control: active ? "remote_control" : "inventory_only",
        }),
      identityFingerprint: async () => `fingerprint-${accountId}`,
    };
  }

  rememberIdentity(): void {
    return undefined;
  }

  async nativeSessionPage(): Promise<never> {
    throw new Error("Native Session discovery is not used by this test");
  }
}

function twoAccountFleet(revision: number): ProviderFleetSnapshot {
  const fleet = controlledProviderFleet(revision, "codex", "blue");
  const provider = fleet.providers[0]!;
  const blue = provider.accounts[0]!;
  return {
    ...fleet,
    providers: [{
      ...provider,
      adapterSupport: "inventory_only",
      accounts: [
        { ...blue, control: "inventory_only" },
        {
          ...blue,
          accountId: "green",
          displayName: "Green account",
          isDefault: false,
          control: "inventory_only",
        },
      ],
      accountCount: 2,
    }],
  };
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
  predicate: (message: ServerEnvelope, index: number) => boolean,
  timeoutMs = 3_000,
): Promise<ServerEnvelope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const index = browser.messages.findIndex(predicate);
    if (index >= 0) return browser.messages[index]!;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for browser message: ${JSON.stringify(
    browser.messages.map((message) =>
      message.type === "provider.account.capabilities.snapshot"
        ? {
            type: message.type,
            accountId: message.payload.snapshot.accountId,
            revision: message.payload.snapshot.revision,
            active: message.payload.snapshot.active,
            control: message.payload.snapshot.control,
          }
        : { type: message.type },
    ),
  )}`);
}

async function activateThroughBrowser(
  browser: BrowserHarness,
  commandId: string,
  expectedRevision: number,
  accountId: string,
  runtime: Runtime,
) {
  const start = browser.messages.length;
  browser.socket.send(JSON.stringify(makeEnvelope("provider.account.activate", {
    commandId,
    deviceId: "device-browser",
    providerId: "codex",
    accountId,
    expectedRevision,
    expectedRuntimeId: runtime.runtimeId,
    expectedRuntimeGeneration: runtime.generation,
  })));
  const result = await waitFor(
    browser,
    (message, index) =>
      index >= start &&
      message.type === "provider.account.activation.accepted" &&
      message.payload.commandId === commandId,
  );
  if (result.type !== "provider.account.activation.accepted") {
    throw new Error("Expected accepted account activation");
  }
  return result;
}
