import {
  ConnectorEnvelopeSchema,
  ProviderFleetSnapshotSchema,
  makeEnvelope,
  type Approval,
  type ConnectorEnvelope,
  type ProviderCapabilityEvidence,
  type ProviderFleetSnapshot,
  type ProviderNativeSessionSnapshot,
  type ToolActivity,
} from "@aicl/protocol";
import { z } from "zod";

import {
  ProviderLostError,
  type ApprovalResolveCommand,
  type ConnectorEmit,
  type ConnectorProvider,
  type ProviderSessionPreparation,
  type SessionPrepareCommand,
  type TurnInterruptCommand,
  type TurnStartCommand,
  type PreparedInputAttachment,
} from "../provider.js";
import { OutputBatcher } from "../output-batcher.js";
import { canonicalProjectRoot } from "../project-root.js";
import {
  CodexRpcProcess,
  ProviderRpcTimeoutError,
} from "./rpc-process.js";
import {
  discoverCodexNativeSessions,
  probeCodexCapabilities,
  type CodexCapabilityProbe,
} from "./discovery.js";

const ThreadResponseSchema = z.object({
  thread: z.object({ id: z.string().min(1) }),
  model: z.string().min(1).max(128).optional(),
  reasoningEffort: z.string().min(1).max(64).nullable().optional(),
});
const TurnStartResponseSchema = z.object({
  turn: z.object({ id: z.string().min(1) }),
});
const AgentDeltaSchema = z.object({
  method: z.literal("item/agentMessage/delta"),
  params: z.object({
    threadId: z.string(),
    turnId: z.string(),
    itemId: z.string(),
    delta: z.string(),
  }),
});
const AgentItemCompletedSchema = z.object({
  method: z.literal("item/completed"),
  params: z.object({
    threadId: z.string(),
    turnId: z.string(),
    item: z.object({
      type: z.literal("agentMessage"),
      id: z.string(),
      text: z.string(),
    }),
  }),
});
const TurnCompletedSchema = z.object({
  method: z.literal("turn/completed"),
  params: z.object({
    threadId: z.string(),
    turn: z.object({
      id: z.string(),
      status: z.string(),
      error: z.unknown().nullable().optional(),
      items: z.array(z.unknown()).optional(),
    }),
  }),
});
const RequestIdSchema = z.union([z.string(), z.number().int()]);
const ActivityItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("commandExecution"),
    id: z.string(),
    command: z.string(),
    cwd: z.string(),
    status: z.enum(["inProgress", "completed", "failed", "declined"]),
    aggregatedOutput: z.string().nullable().optional(),
    exitCode: z.number().int().nullable().optional(),
    durationMs: z.number().int().nonnegative().nullable().optional(),
  }),
  z.object({
    type: z.literal("mcpToolCall"),
    id: z.string(),
    server: z.string(),
    tool: z.string(),
    status: z.enum(["inProgress", "completed", "failed"]),
    durationMs: z.number().int().nonnegative().nullable().optional(),
  }),
  z.object({
    type: z.literal("dynamicToolCall"),
    id: z.string(),
    namespace: z.string().nullable().optional(),
    tool: z.string(),
    status: z.enum(["inProgress", "completed", "failed"]),
    durationMs: z.number().int().nonnegative().nullable().optional(),
  }),
]);
const FileUpdateChangeSchema = z.object({
  path: z.string(),
  diff: z.string(),
  kind: z.object({
    type: z.enum(["add", "update", "delete"]),
  }),
});
const FileChangeItemSchema = z.object({
  type: z.literal("fileChange"),
  id: z.string(),
  status: z.enum(["inProgress", "completed", "failed", "declined"]),
  changes: z.array(FileUpdateChangeSchema),
});
const ItemLifecycleSchema = z.object({
  method: z.enum(["item/started", "item/completed"]),
  params: z.object({
    threadId: z.string(),
    turnId: z.string(),
    item: z.union([ActivityItemSchema, FileChangeItemSchema]),
  }),
});
const CommandOutputSchema = z.object({
  method: z.literal("item/commandExecution/outputDelta"),
  params: z.object({
    threadId: z.string(),
    turnId: z.string(),
    itemId: z.string(),
    delta: z.string(),
  }),
});
const TurnDiffSchema = z.object({
  method: z.literal("turn/diff/updated"),
  params: z.object({
    threadId: z.string(),
    turnId: z.string(),
    diff: z.string(),
  }),
});
const CommandApprovalRequestSchema = z.object({
  id: RequestIdSchema,
  method: z.literal("item/commandExecution/requestApproval"),
  params: z.object({
    threadId: z.string(),
    turnId: z.string(),
    itemId: z.string(),
    command: z.string().nullable().optional(),
    cwd: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
  }),
});
const FileApprovalRequestSchema = z.object({
  id: RequestIdSchema,
  method: z.literal("item/fileChange/requestApproval"),
  params: z.object({
    threadId: z.string(),
    turnId: z.string(),
    itemId: z.string(),
    reason: z.string().nullable().optional(),
  }),
});

interface ActiveTurn {
  command: TurnStartCommand;
  emit: ConnectorEmit;
  providerSessionId: string;
  providerTurnId: string | null;
  streamSeq: number;
  contentByMessage: Map<string, string>;
  completedMessages: Set<string>;
  activityIds: Map<string, string>;
  completedActivityItems: Set<string>;
  fileChangeIds: Map<string, string>;
  completedFileChangeItems: Set<string>;
  turnDiff: string;
  outputBatcher: OutputBatcher;
  lost: boolean;
  resolve(): void;
  reject(error: Error): void;
  done: Promise<void>;
}

interface PendingApproval {
  requestId: string | number;
  approvalId: string;
  sessionId: string;
  turnId: string;
  runtimeId: string;
  runtimeGeneration: number;
}

export interface CodexProviderOptions {
  cwd: string;
  allowedRoots?: readonly string[];
  accountId?: string;
  codexHome?: string;
  command?: string;
  timeoutMs?: number;
  approvalTimeoutMs?: number;
}

export class CodexProvider implements ConnectorProvider {
  readonly #lostListeners = new Set<() => void>();
  readonly #options: CodexProviderOptions;
  #rpc: CodexRpcProcess | undefined;
  #starting: Promise<CodexRpcProcess> | undefined;
  #active: ActiveTurn | undefined;
  #preparing = false;
  #earlyNotifications: Array<Record<string, unknown>> = [];
  readonly #pendingApprovals = new Map<string, PendingApproval>();
  #closing = false;

  constructor(options: CodexProviderOptions) {
    this.#options = options;
  }

  onLost(listener: () => void) {
    this.#lostListeners.add(listener);
    return () => this.#lostListeners.delete(listener);
  }

  async prepareSession(
    command: SessionPrepareCommand,
  ): Promise<ProviderSessionPreparation> {
    if (this.#active !== undefined || this.#preparing) {
      throw new Error("Codex provider is busy");
    }
    if (
      command.payload.providerId !== "codex" ||
      command.payload.accountId !== (this.#options.accountId ?? "default")
    ) {
      throw new Error("Codex provider/account selection is not active");
    }
    const projectPath = canonicalProjectRoot(
      command.payload.projectPath,
      this.#options.allowedRoots ?? [this.#options.cwd],
    );
    this.#preparing = true;
    try {
      const rpc = await this.#ensureProcess();
      const probe = await probeCodexCapabilities(rpc, {
        timeoutMs: Math.min(this.#options.timeoutMs ?? 180_000, 2_500),
      });
      if (!probe.authenticated) throw new Error("Codex is not authenticated");
      const selectedModel =
        command.payload.model === null
          ? probe.models.find((model) => model.isDefault) ?? probe.models[0]
          : probe.models.find(
              (model) => model.modelId === command.payload.model,
            );
      if (command.payload.model !== null && selectedModel === undefined) {
        throw new Error("Selected Codex model is unavailable");
      }
      if (
        command.payload.reasoningLevel !== null &&
        (selectedModel === undefined ||
          !selectedModel.reasoningEfforts.some(
            (option) => option.value === command.payload.reasoningLevel,
          ))
      ) {
        throw new Error("Selected Codex reasoning level is unavailable");
      }
      const method =
        command.type === "connector.session.create"
          ? "thread/start"
          : "thread/resume";
      const response = ThreadResponseSchema.parse(
        await rpc.request(method, {
          ...(command.type === "connector.session.resume"
            ? { threadId: command.payload.providerSessionId }
            : {}),
          cwd: projectPath,
          approvalPolicy: "on-request",
          sandbox: "read-only",
          personality: "none",
          ...(command.payload.model === null
            ? {}
            : { model: command.payload.model }),
        }),
      );
      if (
        command.type === "connector.session.resume" &&
        response.thread.id !== command.payload.providerSessionId
      ) {
        throw new Error("Codex resumed a different Session identity");
      }
      return {
        providerSessionId: response.thread.id,
        projectPath,
        model: response.model ?? command.payload.model,
        reasoningLevel:
          response.reasoningEffort ?? command.payload.reasoningLevel,
      };
    } catch (error) {
      if (error instanceof ProviderRpcTimeoutError) throw new ProviderLostError();
      throw error;
    } finally {
      this.#preparing = false;
    }
  }

  async enrichProviderFleet(
    snapshot: ProviderFleetSnapshot,
    accountId: string,
  ): Promise<ProviderFleetSnapshot> {
    const providerIndex = snapshot.providers.findIndex(
      (provider) => provider.providerId === "codex",
    );
    if (providerIndex < 0) return snapshot;
    const provider = snapshot.providers[providerIndex]!;
    const accountIndex = provider.accounts.findIndex(
      (account) => account.accountId === accountId,
    );
    if (
      accountIndex < 0 ||
      provider.installation !== "installed" ||
      provider.compatibility !== "compatible"
    ) {
      return snapshot;
    }
    try {
      const probe = await probeCodexCapabilities(await this.#ensureProcess(), {
        timeoutMs: Math.min(this.#options.timeoutMs ?? 180_000, 2_500),
      });
      const observedAt = new Date().toISOString();
      const accounts = provider.accounts.map((account, index) =>
        index === accountIndex
          ? {
              ...account,
              authentication: probe.authenticated
                ? ("authenticated" as const)
                : ("not_authenticated" as const),
              control: probe.authenticated
                ? ("remote_control" as const)
                : ("inventory_only" as const),
              observedAt,
              notice: probe.authenticated
                ? null
                : "Codex app-server reports no authenticated account",
            }
          : account,
      );
      const capabilities = updateCodexCapabilities(
        provider.capabilities,
        observedAt,
        probe,
      );
      const providers = [...snapshot.providers];
      providers[providerIndex] = {
        ...provider,
        authentication: probe.authenticated
          ? "authenticated"
          : "not_authenticated",
        adapterSupport: probe.authenticated
          ? "remote_control"
          : "inventory_only",
        freshness: "live",
        observedAt,
        notice: probe.modelsTruncated
          ? "Codex model discovery reached its configured bound"
          : probe.authenticated
            ? null
            : "Codex app-server is not authenticated",
        capabilities,
        accounts,
        models: probe.models,
        modelsState: "available",
      };
      return ProviderFleetSnapshotSchema.parse({
        ...snapshot,
        providers,
        freshness: "live",
      });
    } catch {
      const providers = [...snapshot.providers];
      providers[providerIndex] = {
        ...provider,
        freshness: "local",
        models: [],
        modelsState: "error",
        notice: "Codex capability probe failed or timed out",
      };
      return ProviderFleetSnapshotSchema.parse({
        ...snapshot,
        degraded: true,
        providers,
        notice: "One provider capability probe failed or timed out",
      });
    }
  }

  async discoverNativeSessions(input: {
    accountId: string;
    allowedRoots: readonly string[];
    revision: number;
  }): Promise<ProviderNativeSessionSnapshot> {
    return discoverCodexNativeSessions(await this.#ensureProcess(), {
      providerId: "codex",
      accountId: input.accountId,
      allowedRoots: input.allowedRoots,
      revision: input.revision,
      timeoutMs: Math.min(this.#options.timeoutMs ?? 180_000, 2_500),
    });
  }

  async startTurn(
    command: TurnStartCommand,
    emit: ConnectorEmit,
    attachments: readonly PreparedInputAttachment[] = [],
  ) {
    if (this.#active !== undefined || this.#preparing) {
      throw new Error("Codex provider already has an active Turn");
    }
    const rpc = await this.#ensureProcess();
    const settings = command.payload.effectiveSettings;
    let effectiveProjectPath: string | undefined;
    if (settings !== undefined) {
      if (
        settings.providerId !== "codex" ||
        (settings.accountId !== null &&
          settings.accountId !== (this.#options.accountId ?? "default"))
      ) {
        throw new Error("Turn settings select an inactive Codex account");
      }
      effectiveProjectPath =
        settings.projectPath === null
          ? undefined
          : canonicalProjectRoot(
              settings.projectPath,
              this.#options.allowedRoots ?? [this.#options.cwd],
            );
      const probe = await probeCodexCapabilities(rpc, {
        timeoutMs: Math.min(this.#options.timeoutMs ?? 180_000, 2_500),
      });
      if (!probe.authenticated) throw new Error("Codex is not authenticated");
      const selectedModel =
        settings.model === null
          ? undefined
          : probe.models.find((model) => model.modelId === settings.model);
      if (settings.model !== null && selectedModel === undefined) {
        throw new Error("Effective Codex model is unavailable");
      }
      if (
        settings.reasoningLevel !== null &&
        (selectedModel === undefined ||
          !selectedModel.reasoningEfforts.some(
            (option) => option.value === settings.reasoningLevel,
          ))
      ) {
        throw new Error("Effective Codex reasoning level is unavailable");
      }
    }
    let providerSessionId: string;
    try {
      providerSessionId = command.payload.providerSessionId
        ? ThreadResponseSchema.parse(
            await rpc.request("thread/resume", {
              threadId: command.payload.providerSessionId,
            }),
          ).thread.id
        : ThreadResponseSchema.parse(
            await rpc.request("thread/start", {
              cwd: this.#options.cwd,
              approvalPolicy: "on-request",
              sandbox: "read-only",
              personality: "none",
            }),
          ).thread.id;
    } catch (error) {
      if (error instanceof ProviderRpcTimeoutError) throw new ProviderLostError();
      throw error;
    }

    emit(
      this.#envelope("connector.session.bound", {
        sessionId: command.payload.sessionId,
        providerSessionId,
      }),
    );

    let resolveDone: () => void = () => undefined;
    let rejectDone: (error: Error) => void = () => undefined;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    void done.catch(() => undefined);
    const outputBatcher = new OutputBatcher({
      emit: (activityId, streamSeq, output) => {
        const current = this.#active;
        if (current?.command.payload.turnId !== command.payload.turnId) return;
        current.emit(
          this.#envelope("connector.command.output.batch", {
            sessionId: current.command.payload.sessionId,
            turnId: current.command.payload.turnId,
            activityId,
            streamSeq,
            output,
          }),
        );
      },
    });
    const active: ActiveTurn = {
      command,
      emit,
      providerSessionId,
      providerTurnId: null,
      streamSeq: 0,
      contentByMessage: new Map(),
      completedMessages: new Set(),
      activityIds: new Map(),
      completedActivityItems: new Set(),
      fileChangeIds: new Map(),
      completedFileChangeItems: new Set(),
      turnDiff: "",
      outputBatcher,
      lost: false,
      resolve: resolveDone,
      reject: rejectDone,
      done,
    };
    this.#active = active;

    try {
      const response = TurnStartResponseSchema.parse(
        await rpc.request("turn/start", {
          threadId: providerSessionId,
          clientUserMessageId: command.payload.commandId,
          input: [
            ...(settings === undefined
              ? []
              : [
                  {
                    type: "text" as const,
                    text: executionModeInstruction(settings.executionMode),
                  },
                ]),
            ...attachments.map((attachment) =>
              attachment.kind === "text"
                ? {
                    type: "text" as const,
                    text:
                      `<aicl-input-attachment name=${JSON.stringify(attachment.name)} ` +
                      `media-type=${JSON.stringify(attachment.mediaType)}>\n` +
                      `${attachment.text}\n</aicl-input-attachment>`,
                  }
                : {
                    type: "localImage" as const,
                    path: attachment.path,
                  },
            ),
            { type: "text" as const, text: command.payload.prompt },
          ],
          ...(effectiveProjectPath === undefined
            ? {}
            : { cwd: effectiveProjectPath }),
          ...(settings?.model === null || settings?.model === undefined
            ? {}
            : { model: settings.model }),
          ...(settings?.reasoningLevel === null ||
          settings?.reasoningLevel === undefined
            ? {}
            : { effort: settings.reasoningLevel }),
          ...(settings === undefined
            ? {}
            : {
                approvalPolicy: "on-request",
                sandboxPolicy: codexSandboxPolicy(
                  settings.sandboxPolicy,
                  effectiveProjectPath,
                ),
              }),
        }),
      );
      active.providerTurnId = response.turn.id;
      emit(
        this.#envelope("connector.turn.bound", {
          sessionId: command.payload.sessionId,
          turnId: command.payload.turnId,
          providerTurnId: response.turn.id,
        }),
      );
      const early = this.#earlyNotifications;
      this.#earlyNotifications = [];
      for (const notification of early) this.#handleNotification(notification);
      await done;
    } catch (error) {
      if (error instanceof ProviderRpcTimeoutError && !active.lost) {
        this.#handleProtocolFault(error);
      }
      if (this.#active === active) this.#active = undefined;
      if (active.lost || error instanceof ProviderRpcTimeoutError) {
        throw new ProviderLostError();
      }
      throw error;
    }
  }

  async interrupt(command: TurnInterruptCommand) {
    const active = this.#active;
    const rpc = this.#rpc;
    if (
      active === undefined ||
      rpc === undefined ||
      active.command.payload.turnId !== command.payload.turnId ||
      active.providerTurnId !== command.payload.providerTurnId
    ) {
      throw new Error("Codex provider has no matching active Turn");
    }
    await rpc.request("turn/interrupt", {
      threadId: command.payload.providerSessionId,
      turnId: command.payload.providerTurnId,
    });
  }

  async resolveApproval(command: ApprovalResolveCommand) {
    const pending = this.#pendingApprovals.get(
      command.payload.providerCorrelationId,
    );
    const rpc = this.#rpc;
    if (
      pending === undefined ||
      rpc === undefined ||
      pending.approvalId !== command.payload.approvalId ||
      pending.sessionId !== command.payload.sessionId ||
      pending.turnId !== command.payload.turnId ||
      pending.runtimeId !== command.payload.runtimeId ||
      pending.runtimeGeneration !== command.payload.runtimeGeneration
    ) {
      throw new Error("Codex provider has no matching pending approval");
    }
    this.#pendingApprovals.delete(command.payload.providerCorrelationId);
    rpc.respond(pending.requestId, {
      decision: command.payload.decision === "approved_once" ? "accept" : "decline",
    });
  }

  async close() {
    this.#closing = true;
    const active = this.#active;
    if (active !== undefined) {
      active.lost = true;
      active.outputBatcher.flushAll();
      this.#clearPendingApprovals(active);
      this.#active = undefined;
      active.reject(new ProviderLostError("Codex provider closed"));
    }
    const starting = this.#starting;
    if (starting !== undefined) await starting.catch(() => undefined);
    await this.#rpc?.stop();
    this.#rpc = undefined;
  }

  async killForTest() {
    await this.#rpc?.killTree();
  }

  async #ensureProcess() {
    if (this.#rpc !== undefined) return this.#rpc;
    if (this.#starting !== undefined) return this.#starting;
    this.#closing = false;
    const starting = (async () => {
      const rpc = new CodexRpcProcess({
        cwd: this.#options.cwd,
        ...(this.#options.codexHome === undefined
          ? {}
          : { codexHome: this.#options.codexHome }),
        ...(this.#options.command === undefined
          ? {}
          : { command: this.#options.command }),
        ...(this.#options.timeoutMs === undefined
          ? {}
          : { timeoutMs: this.#options.timeoutMs }),
      });
      rpc.onNotification((message) => this.#handleNotification(message));
      rpc.onServerRequest((message) => this.#handleServerRequest(message, rpc));
      rpc.onProtocolFault((error) => this.#handleProtocolFault(error));
      rpc.onExit(() => this.#handleExit(rpc));
      try {
        await rpc.start();
        await rpc.initialize();
        this.#rpc = rpc;
        return rpc;
      } catch (error) {
        await rpc.stop().catch(() => undefined);
        throw error;
      }
    })();
    this.#starting = starting;
    try {
      return await starting;
    } finally {
      if (this.#starting === starting) this.#starting = undefined;
    }
  }

  #handleNotification(message: Record<string, unknown>) {
    const active = this.#active;
    if (active === undefined) return;
    if (active.providerTurnId === null) {
      this.#earlyNotifications.push(message);
      return;
    }

    if (message.method === "item/agentMessage/delta") {
      const parsed = AgentDeltaSchema.safeParse(message);
      if (!parsed.success) return this.#handleProtocolFault(parsed.error);
      if (!this.#matches(active, parsed.data.params)) return;
      active.streamSeq += 1;
      const previous = active.contentByMessage.get(parsed.data.params.itemId) ?? "";
      active.contentByMessage.set(
        parsed.data.params.itemId,
        previous + parsed.data.params.delta,
      );
      active.emit(
        this.#envelope("connector.turn.delta", {
          sessionId: active.command.payload.sessionId,
          turnId: active.command.payload.turnId,
          messageId: parsed.data.params.itemId,
          streamSeq: active.streamSeq,
          text: parsed.data.params.delta,
        }),
      );
      return;
    }

    if (message.method === "item/commandExecution/outputDelta") {
      const parsed = CommandOutputSchema.safeParse(message);
      if (!parsed.success) return this.#handleProtocolFault(parsed.error);
      if (!this.#matches(active, parsed.data.params)) return;
      const activityId = this.#activityId(active, parsed.data.params.itemId);
      active.outputBatcher.push(activityId, parsed.data.params.delta);
      return;
    }

    if (message.method === "turn/diff/updated") {
      const parsed = TurnDiffSchema.safeParse(message);
      if (!parsed.success) return this.#handleProtocolFault(parsed.error);
      if (!this.#matches(active, parsed.data.params)) return;
      active.turnDiff = parsed.data.params.diff;
      return;
    }

    if (message.method === "item/started" || message.method === "item/completed") {
      const parsed = ItemLifecycleSchema.safeParse(message);
      if (parsed.success && this.#matches(active, parsed.data.params)) {
        if (parsed.data.params.item.type === "fileChange") {
          this.#emitFileChange(active, parsed.data.method, parsed.data.params.item);
        } else {
          this.#emitActivity(active, parsed.data.method, parsed.data.params.item);
        }
        return;
      }
    }

    if (message.method === "item/completed") {
      const parsed = AgentItemCompletedSchema.safeParse(message);
      if (!parsed.success) return;
      if (!this.#matches(active, parsed.data.params)) return;
      this.#emitCompletedMessage(
        active,
        parsed.data.params.item.id,
        parsed.data.params.item.text,
      );
      return;
    }

    if (message.method === "turn/completed") {
      const parsed = TurnCompletedSchema.safeParse(message);
      if (!parsed.success) return this.#handleProtocolFault(parsed.error);
      if (!this.#matches(active, {
        threadId: parsed.data.params.threadId,
        turnId: parsed.data.params.turn.id,
      })) return;
      this.#completeFromTerminal(active, parsed.data.params.turn);
    }
  }

  #completeFromTerminal(
    active: ActiveTurn,
    turn: z.infer<typeof TurnCompletedSchema>["params"]["turn"],
  ) {
    active.outputBatcher.flushAll();
    const terminalItemStatus = activityTerminalStatus(turn.status);
    for (const item of turn.items ?? []) {
      const activity = ActivityItemSchema.safeParse(item);
      if (activity.success) {
        this.#emitActivity(
          active,
          "item/completed",
          activity.data,
          activity.data.status === "inProgress" ? terminalItemStatus : undefined,
        );
        continue;
      }
      const fileChange = FileChangeItemSchema.safeParse(item);
      if (fileChange.success) {
        this.#emitFileChange(
          active,
          "item/completed",
          fileChange.data,
          fileChange.data.status === "inProgress" ? terminalItemStatus : undefined,
        );
      }
    }
    const finalItem = turn.items
      ?.map((item) =>
        z
          .object({ type: z.literal("agentMessage"), id: z.string(), text: z.string() })
          .safeParse(item),
      )
      .find((item) => item.success);
    if (finalItem?.success) {
      this.#emitCompletedMessage(active, finalItem.data.id, finalItem.data.text);
    } else {
      for (const [messageId, content] of active.contentByMessage) {
        this.#emitCompletedMessage(active, messageId, content);
      }
    }

    const base = {
      sessionId: active.command.payload.sessionId,
      turnId: active.command.payload.turnId,
    };
    if (turn.status === "completed") {
      active.emit(this.#envelope("connector.turn.completed", base));
    } else if (["interrupted", "cancelled", "canceled"].includes(turn.status)) {
      active.emit(this.#envelope("connector.turn.interrupted", base));
    } else if (turn.status === "failed") {
      active.emit(
        this.#envelope("connector.turn.failed", {
          ...base,
          failureCode: "PROVIDER_REJECTED",
        }),
      );
    } else {
      active.emit(this.#envelope("connector.turn.outcome_unknown", base));
    }
    if (this.#active === active) this.#active = undefined;
    this.#clearPendingApprovals(active);
    active.resolve();
  }

  #emitActivity(
    active: ActiveTurn,
    method: "item/started" | "item/completed",
    item: z.infer<typeof ActivityItemSchema>,
    statusOverride?: ToolActivity["status"],
  ) {
    if (
      method === "item/completed" &&
      active.completedActivityItems.has(item.id)
    ) {
      return;
    }
    if (method === "item/completed") active.completedActivityItems.add(item.id);
    const activityId = this.#activityId(active, item.id);
    if (method === "item/completed") active.outputBatcher.flush(activityId);
    const isCommand = item.type === "commandExecution";
    const status =
      statusOverride ??
      (method === "item/started" ? "running" : activityStatus(item.status));
    const activity: ToolActivity = {
      activityId,
      turnId: active.command.payload.turnId,
      kind: isCommand ? "command" : "tool",
      title: isCommand
        ? item.command
        : item.type === "mcpToolCall"
          ? `${item.server}/${item.tool}`
          : `${item.namespace ?? "dynamic"}/${item.tool}`,
      cwd: isCommand ? item.cwd : null,
      status,
      revision: method === "item/started" ? 0 : 1,
      exitCode: isCommand ? (item.exitCode ?? null) : null,
      durationMs: item.durationMs ?? null,
      outputPreview:
        isCommand && method === "item/completed"
          ? (item.aggregatedOutput ?? "").slice(-(32 * 1024))
          : "",
    };
    active.emit(
      this.#envelope(
        method === "item/started"
          ? "connector.activity.started"
          : "connector.activity.completed",
        { sessionId: active.command.payload.sessionId, activity },
      ),
    );
  }

  #emitFileChange(
    active: ActiveTurn,
    method: "item/started" | "item/completed",
    item: z.infer<typeof FileChangeItemSchema>,
    statusOverride?: ToolActivity["status"],
  ) {
    if (
      method === "item/completed" &&
      active.completedFileChangeItems.has(item.id)
    ) {
      return;
    }
    if (method === "item/completed") active.completedFileChangeItems.add(item.id);
    const fileChangeId = this.#fileChangeId(active, item.id);
    const diff = normalizeFileChangeDiff(item.changes, active.turnDiff);
    const counts = countDiffLines(diff);
    const common = {
      fileChangeId,
      turnId: active.command.payload.turnId,
      status:
        statusOverride ??
        (method === "item/started" ? ("running" as const) : activityStatus(item.status)),
      revision: method === "item/started" ? 0 : 1,
      files: item.changes.map((change) => ({
        path: change.path,
        kind: change.kind.type,
      })),
      additions: counts.additions,
      deletions: counts.deletions,
    };
    if (method === "item/started") {
      active.emit(
        this.#envelope("connector.file.change.started", {
          sessionId: active.command.payload.sessionId,
          fileChange: { ...common, diff: null },
        }),
      );
      return;
    }
    active.emit(
      this.#envelope("connector.file.change.completed", {
        sessionId: active.command.payload.sessionId,
        fileChange: { ...common, inlineDiff: diff, artifact: null },
      }),
    );
  }

  #activityId(active: ActiveTurn, providerItemId: string) {
    let activityId = active.activityIds.get(providerItemId);
    if (activityId === undefined) {
      activityId = `activity-${crypto.randomUUID()}`;
      active.activityIds.set(providerItemId, activityId);
    }
    return activityId;
  }

  #fileChangeId(active: ActiveTurn, providerItemId: string) {
    let fileChangeId = active.fileChangeIds.get(providerItemId);
    if (fileChangeId === undefined) {
      fileChangeId = `file-change-${crypto.randomUUID()}`;
      active.fileChangeIds.set(providerItemId, fileChangeId);
    }
    return fileChangeId;
  }

  #emitCompletedMessage(active: ActiveTurn, messageId: string, content: string) {
    if (active.completedMessages.has(messageId)) return;
    active.completedMessages.add(messageId);
    active.emit(
      this.#envelope("connector.turn.message.completed", {
        sessionId: active.command.payload.sessionId,
        turnId: active.command.payload.turnId,
        messageId,
        content,
      }),
    );
  }

  #matches(
    active: ActiveTurn,
    value: { threadId: string; turnId: string },
  ) {
    return (
      value.threadId === active.providerSessionId &&
      value.turnId === active.providerTurnId
    );
  }

  #handleServerRequest(
    message: Record<string, unknown>,
    rpc: CodexRpcProcess,
  ) {
    if (
      message.method !== "item/commandExecution/requestApproval" &&
      message.method !== "item/fileChange/requestApproval"
    ) {
      return false;
    }
    const active = this.#active;
    const parsed =
      message.method === "item/commandExecution/requestApproval"
        ? CommandApprovalRequestSchema.parse(message)
        : FileApprovalRequestSchema.parse(message);
    if (
      active === undefined ||
      active.providerTurnId === null ||
      !this.#matches(active, parsed.params)
    ) {
      rpc.respond(parsed.id, { decision: "decline" });
      return true;
    }
    const approvalId = `approval-${crypto.randomUUID()}`;
    const providerCorrelationId = `approval-correlation-${crypto.randomUUID()}`;
    const isCommand = parsed.method === "item/commandExecution/requestApproval";
    const activityId = isCommand
      ? this.#activityId(active, parsed.params.itemId)
      : null;
    const fileChangeId = isCommand
      ? null
      : this.#fileChangeId(active, parsed.params.itemId);
    const command = isCommand ? (parsed.params.command ?? null) : null;
    const reason = parsed.params.reason ?? null;
    if (isCommand && parsed.params.cwd !== null && parsed.params.cwd !== undefined) {
      try {
        const projectPath =
          active.command.payload.effectiveSettings?.projectPath ?? this.#options.cwd;
        canonicalProjectRoot(parsed.params.cwd, [projectPath]);
      } catch {
        rpc.respond(parsed.id, { decision: "decline" });
        return true;
      }
    }
    const approval: Approval = {
      approvalId,
      sessionId: active.command.payload.sessionId,
      runtimeId: active.command.payload.runtimeId,
      runtimeGeneration: active.command.payload.runtimeGeneration,
      turnId: active.command.payload.turnId,
      actionType: isCommand ? "command" : "file_change",
      state: "pending",
      revision: 0,
      expiresAt: new Date(
        Date.now() + (this.#options.approvalTimeoutMs ?? 120_000),
      ).toISOString(),
      payload: {
        summary: isCommand
          ? command ?? "Command execution requires approval"
          : "File changes require approval",
        command,
        cwd: isCommand ? (parsed.params.cwd ?? null) : null,
        reason,
        activityId,
        fileChangeId,
      },
      resolvedAt: null,
      resolvedByDeviceId: null,
    };
    this.#pendingApprovals.set(providerCorrelationId, {
      requestId: parsed.id,
      approvalId,
      sessionId: approval.sessionId,
      turnId: approval.turnId,
      runtimeId: approval.runtimeId,
      runtimeGeneration: approval.runtimeGeneration,
    });
    active.emit(
      this.#envelope("connector.approval.requested", {
        sessionId: approval.sessionId,
        approval,
        providerCorrelationId,
      }),
    );
    return true;
  }

  #clearPendingApprovals(active: ActiveTurn) {
    for (const [correlationId, pending] of this.#pendingApprovals) {
      if (
        pending.sessionId === active.command.payload.sessionId &&
        pending.turnId === active.command.payload.turnId
      ) {
        this.#pendingApprovals.delete(correlationId);
      }
    }
  }

  #handleProtocolFault(error: unknown) {
    const active = this.#active;
    if (active !== undefined) {
      active.emit(
        this.#envelope("connector.turn.outcome_unknown", {
          sessionId: active.command.payload.sessionId,
          turnId: active.command.payload.turnId,
        }),
      );
      active.lost = true;
      active.outputBatcher.flushAll();
      this.#clearPendingApprovals(active);
      if (this.#active === active) this.#active = undefined;
      active.reject(
        new ProviderLostError(
          `Codex protocol fault: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
    void this.#rpc?.killTree();
  }

  #handleExit(rpc: CodexRpcProcess) {
    if (this.#rpc === rpc) this.#rpc = undefined;
    if (this.#closing) return;
    const active = this.#active;
    if (active !== undefined) {
      active.emit(
        this.#envelope("connector.turn.outcome_unknown", {
          sessionId: active.command.payload.sessionId,
          turnId: active.command.payload.turnId,
        }),
      );
      active.lost = true;
      active.outputBatcher.flushAll();
      this.#clearPendingApprovals(active);
      if (this.#active === active) this.#active = undefined;
      active.reject(new ProviderLostError());
    }
    for (const listener of this.#lostListeners) listener();
  }

  #envelope<T extends ConnectorEnvelope["type"]>(
    type: T,
    payload: Extract<ConnectorEnvelope, { type: T }>["payload"],
  ): Extract<ConnectorEnvelope, { type: T }> {
    return ConnectorEnvelopeSchema.parse(makeEnvelope(type, payload)) as Extract<
      ConnectorEnvelope,
      { type: T }
    >;
  }
}

function activityStatus(
  status: "inProgress" | "completed" | "failed" | "declined",
): ToolActivity["status"] {
  if (status === "inProgress") return "running";
  return status;
}

function updateCodexCapabilities(
  current: readonly ProviderCapabilityEvidence[],
  observedAt: string,
  probe: CodexCapabilityProbe,
): ProviderCapabilityEvidence[] {
  const updates = new Map<
    ProviderCapabilityEvidence["key"],
    ProviderCapabilityEvidence
  >();
  const evidence = (
    key: ProviderCapabilityEvidence["key"],
    state: ProviderCapabilityEvidence["state"],
    reason: string | null = null,
  ) =>
    updates.set(key, {
      key,
      state,
      provenance: "provider_probe",
      observedAt,
      reason,
    });
  const controlled = probe.authenticated;
  for (const key of [
    "remote_control",
    "list_sessions",
    "create_session",
    "resume_session",
    "text_input",
    "execution_modes",
    "approval_policies",
    "sandbox_policies",
  ] as const) {
    evidence(
      key,
      controlled ? "supported" : "unsupported",
      controlled ? null : "Codex app-server is not authenticated",
    );
  }
  evidence("list_models", "supported");
  evidence(
    "change_model",
    probe.models.length > 0 ? "supported" : "unsupported",
    probe.models.length > 0 ? null : "No provider models were advertised",
  );
  evidence(
    "reasoning_levels",
    probe.models.some((model) => model.reasoningEfforts.length > 0)
      ? "supported"
      : "unsupported",
    probe.models.some((model) => model.reasoningEfforts.length > 0)
      ? null
      : "No reasoning options were advertised",
  );
  evidence(
    "image_input",
    probe.models.some((model) => model.inputModalities.includes("image"))
      ? "supported"
      : "unsupported",
    probe.models.some((model) => model.inputModalities.includes("image"))
      ? null
      : "No advertised model accepts images",
  );
  evidence(
    "file_input",
    "unsupported",
    "Managed file translation is not implemented yet",
  );
  evidence(
    "network_policies",
    "unknown",
    "Network policy translation has not been verified",
  );
  return current.map((capability) => updates.get(capability.key) ?? capability);
}

function executionModeInstruction(mode: "ask" | "plan" | "auto") {
  switch (mode) {
    case "ask":
      return "[AICL execution: ask] Work interactively in one bounded Turn. Pause at every required approval boundary.";
    case "plan":
      return "[AICL execution: plan-first] Produce and validate a plan before side effects. Planning does not grant approval authority.";
    case "auto":
      return "[AICL execution: bounded-auto] Continue through multiple bounded steps in this Turn, but stop at approval, sandbox, network, or project boundaries.";
  }
}

function codexSandboxPolicy(
  policy: "read_only" | "workspace_write",
  projectPath: string | undefined,
) {
  if (policy === "read_only") {
    return { type: "readOnly" as const, networkAccess: false };
  }
  return {
    type: "workspaceWrite" as const,
    networkAccess: false,
    writableRoots: projectPath === undefined ? [] : [projectPath],
    excludeSlashTmp: true,
    excludeTmpdirEnvVar: true,
  };
}

function activityTerminalStatus(status: string): ToolActivity["status"] {
  if (status === "completed") return "completed";
  if (["interrupted", "cancelled", "canceled"].includes(status)) {
    return "interrupted";
  }
  if (status === "failed") return "failed";
  return "outcome_unknown";
}

function countDiffLines(diff: string) {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

function normalizeFileChangeDiff(
  changes: Array<z.infer<typeof FileUpdateChangeSchema>>,
  turnDiff: string,
) {
  if (looksLikeUnifiedDiff(turnDiff)) return turnDiff;
  return changes
    .map((change) => {
      if (looksLikeUnifiedDiff(change.diff)) return change.diff;
      if (change.kind.type === "update") return change.diff;
      const lines = change.diff.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
      const count = Math.max(lines.length, 1);
      const path = change.path.replace(/\\/g, "/");
      if (change.kind.type === "add") {
        return [
          "--- /dev/null",
          `+++ b/${path}`,
          `@@ -0,0 +1,${count} @@`,
          ...lines.map((line) => `+${line}`),
        ].join("\n");
      }
      return [
        `--- a/${path}`,
        "+++ /dev/null",
        `@@ -1,${count} +0,0 @@`,
        ...lines.map((line) => `-${line}`),
      ].join("\n");
    })
    .join("\n");
}

function looksLikeUnifiedDiff(value: string) {
  return /(^|\n)(--- |\+\+\+ |@@ )/.test(value);
}
