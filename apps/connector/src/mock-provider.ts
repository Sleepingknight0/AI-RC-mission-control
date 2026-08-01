import {
  ConnectorEnvelopeSchema,
  makeEnvelope,
  type ConnectorEnvelope,
} from "@aicl/protocol";

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
