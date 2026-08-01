import {
  ConnectorEnvelopeSchema,
  makeEnvelope,
  type ConnectorEnvelope,
} from "@aicl/protocol";
import { z } from "zod";

import {
  ProviderLostError,
  type ConnectorEmit,
  type ConnectorProvider,
  type TurnInterruptCommand,
  type TurnStartCommand,
} from "../provider.js";
import { CodexRpcProcess } from "./rpc-process.js";

const ThreadResponseSchema = z.object({ thread: z.object({ id: z.string().min(1) }) });
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

interface ActiveTurn {
  command: TurnStartCommand;
  emit: ConnectorEmit;
  providerSessionId: string;
  providerTurnId: string | null;
  streamSeq: number;
  contentByMessage: Map<string, string>;
  completedMessages: Set<string>;
  lost: boolean;
  resolve(): void;
  reject(error: Error): void;
  done: Promise<void>;
}

export interface CodexProviderOptions {
  cwd: string;
  command?: string;
  timeoutMs?: number;
}

export class CodexProvider implements ConnectorProvider {
  readonly #lostListeners = new Set<() => void>();
  readonly #options: CodexProviderOptions;
  #rpc: CodexRpcProcess | undefined;
  #active: ActiveTurn | undefined;
  #earlyNotifications: Array<Record<string, unknown>> = [];
  #closing = false;

  constructor(options: CodexProviderOptions) {
    this.#options = options;
  }

  onLost(listener: () => void) {
    this.#lostListeners.add(listener);
    return () => this.#lostListeners.delete(listener);
  }

  async startTurn(command: TurnStartCommand, emit: ConnectorEmit) {
    if (this.#active !== undefined) {
      throw new Error("Codex provider already has an active Turn");
    }
    const rpc = await this.#ensureProcess();
    const providerSessionId = command.payload.providerSessionId
      ? ThreadResponseSchema.parse(
          await rpc.request("thread/resume", {
            threadId: command.payload.providerSessionId,
          }),
        ).thread.id
      : ThreadResponseSchema.parse(
          await rpc.request("thread/start", {
            cwd: this.#options.cwd,
            approvalPolicy: "never",
            sandbox: "read-only",
            personality: "none",
          }),
        ).thread.id;

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
    const active: ActiveTurn = {
      command,
      emit,
      providerSessionId,
      providerTurnId: null,
      streamSeq: 0,
      contentByMessage: new Map(),
      completedMessages: new Set(),
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
          input: [{ type: "text", text: command.payload.prompt }],
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
      if (this.#active === active) this.#active = undefined;
      if (active.lost) throw new ProviderLostError();
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

  async close() {
    this.#closing = true;
    await this.#rpc?.stop();
    this.#rpc = undefined;
  }

  async killForTest() {
    await this.#rpc?.killTree();
  }

  async #ensureProcess() {
    if (this.#rpc !== undefined) return this.#rpc;
    this.#closing = false;
    const rpc = new CodexRpcProcess({
      cwd: this.#options.cwd,
      ...(this.#options.command === undefined
        ? {}
        : { command: this.#options.command }),
      ...(this.#options.timeoutMs === undefined
        ? {}
        : { timeoutMs: this.#options.timeoutMs }),
    });
    rpc.onNotification((message) => this.#handleNotification(message));
    rpc.onProtocolFault((error) => this.#handleProtocolFault(error));
    rpc.onExit(() => this.#handleExit(rpc));
    await rpc.start();
    await rpc.initialize();
    this.#rpc = rpc;
    return rpc;
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
    active.resolve();
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
