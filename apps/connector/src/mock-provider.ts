import {
  ConnectorEnvelopeSchema,
  makeEnvelope,
  type ConnectorEnvelope,
} from "@aicl/protocol";

import type {
  ConnectorEmit,
  ConnectorProvider,
  SessionPrepareCommand,
  TurnInterruptCommand,
  TurnStartCommand,
} from "./provider.js";

export type RawMockProviderEvent =
  | {
      providerMethod: "mock/message/delta";
      providerPayload: { text: string; index: number };
    }
  | {
      providerMethod: "mock/message/completed";
      providerPayload: { content: string };
    }
  | {
      providerMethod: "mock/turn/completed";
      providerPayload: { outcome: "completed" };
    };

export interface MockTurnContext {
  sessionId: string;
  turnId: string;
  messageId: string;
}

export async function* runMockProvider(
  prompt: string,
  delayMs = 20,
): AsyncGenerator<RawMockProviderEvent> {
  const content = `Mock response: ${prompt}`;
  const chunks = content.match(/.{1,8}/g) ?? [content];

  for (const [index, text] of chunks.entries()) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    yield {
      providerMethod: "mock/message/delta",
      providerPayload: { text, index: index + 1 },
    };
  }

  yield {
    providerMethod: "mock/message/completed",
    providerPayload: { content },
  };
  yield {
    providerMethod: "mock/turn/completed",
    providerPayload: { outcome: "completed" },
  };
}

export function normalizeMockEvent(
  event: RawMockProviderEvent,
  context: MockTurnContext,
): ConnectorEnvelope {
  switch (event.providerMethod) {
    case "mock/message/delta":
      return ConnectorEnvelopeSchema.parse(
        makeEnvelope("connector.turn.delta", {
          ...context,
          streamSeq: event.providerPayload.index,
          text: event.providerPayload.text,
        }),
      );
    case "mock/message/completed":
      return ConnectorEnvelopeSchema.parse(
        makeEnvelope("connector.turn.message.completed", {
          ...context,
          content: event.providerPayload.content,
        }),
      );
    case "mock/turn/completed":
      return ConnectorEnvelopeSchema.parse(
        makeEnvelope("connector.turn.completed", {
          sessionId: context.sessionId,
          turnId: context.turnId,
        }),
      );
  }
}

export class MockProvider implements ConnectorProvider {
  #active: { command: TurnStartCommand; interrupted: boolean } | undefined;

  constructor(private readonly delayMs = 20) {}

  onLost() {
    return () => undefined;
  }

  async prepareSession(command: SessionPrepareCommand) {
    return {
      providerSessionId:
        command.type === "connector.session.resume"
          ? command.payload.providerSessionId
          : `mock-thread-${command.payload.sessionId}`,
      projectPath: command.payload.projectPath,
      model: command.payload.model,
      reasoningLevel: command.payload.reasoningLevel,
    };
  }

  async startTurn(command: TurnStartCommand, emit: ConnectorEmit) {
    const providerSessionId =
      command.payload.providerSessionId ?? `mock-thread-${command.payload.sessionId}`;
    const providerTurnId = `mock-turn-${command.payload.turnId}`;
    const active = { command, interrupted: false };
    this.#active = active;
    emit(
      ConnectorEnvelopeSchema.parse(
        makeEnvelope("connector.session.bound", {
          sessionId: command.payload.sessionId,
          providerSessionId,
        }),
      ),
    );
    emit(
      ConnectorEnvelopeSchema.parse(
        makeEnvelope("connector.turn.bound", {
          sessionId: command.payload.sessionId,
          turnId: command.payload.turnId,
          providerTurnId,
        }),
      ),
    );

    const context = {
      sessionId: command.payload.sessionId,
      turnId: command.payload.turnId,
      messageId: `message-${command.payload.turnId}`,
    };
    for await (const rawEvent of runMockProvider(
      command.payload.prompt,
      this.delayMs,
    )) {
      if (active.interrupted) break;
      emit(normalizeMockEvent(rawEvent, context));
    }
    if (active.interrupted) {
      emit(
        ConnectorEnvelopeSchema.parse(
          makeEnvelope("connector.turn.interrupted", {
            sessionId: command.payload.sessionId,
            turnId: command.payload.turnId,
          }),
        ),
      );
    }
    if (this.#active === active) this.#active = undefined;
  }

  async interrupt(command: TurnInterruptCommand) {
    if (this.#active?.command.payload.turnId !== command.payload.turnId) {
      throw new Error("Mock provider has no matching active Turn");
    }
    this.#active.interrupted = true;
  }

  async resolveApproval() {}

  async close() {
    if (this.#active !== undefined) this.#active.interrupted = true;
  }
}
