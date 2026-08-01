import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

const id = z.string().min(1).max(200);
const timestamp = z.string().datetime({ offset: true });

const envelope = <T extends string, S extends z.ZodTypeAny>(
  type: T,
  payload: S,
) =>
  z.object({
    protocol: z.literal("aicl"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    messageId: id,
    sentAt: timestamp,
    type: z.literal(type),
    payload,
  }).strict();

export const ProtocolErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  commandId: id.optional(),
  sessionId: id.optional(),
  details: z.record(z.unknown()).optional(),
});

export const TurnStatusSchema = z.enum([
  "running",
  "interrupted",
  "completed",
  "failed",
  "outcome_unknown",
]);

export const TurnSchema = z.object({
  turnId: id,
  commandId: id,
  status: TurnStatusSchema,
  prompt: z.string(),
  startedAt: timestamp,
  completedAt: timestamp.nullable(),
  failureCode: z.string().nullable(),
  providerTurnId: id.nullable(),
});

export const AssistantMessageSchema = z.object({
  messageId: id,
  turnId: id,
  content: z.string(),
  completed: z.boolean(),
});

export const RuntimeSchema = z.object({
  runtimeId: id,
  generation: z.number().int().positive(),
  status: z.enum(["offline", "ready", "busy", "lost", "incompatible"]),
});

export const SessionSnapshotSchema = z.object({
  sessionId: id,
  revision: z.number().int().nonnegative(),
  lastEventSeq: z.number().int().nonnegative(),
  activeTurnId: id.nullable(),
  providerSessionId: id.nullable(),
  turns: z.array(TurnSchema),
  messages: z.array(AssistantMessageSchema),
});

export const ClientEnvelopeSchema = z.discriminatedUnion("type", [
  envelope(
    "client.hello",
    z.object({
      clientName: z.string().min(1),
      supportedProtocolVersions: z.array(z.literal(PROTOCOL_VERSION)).min(1),
    }),
  ),
  envelope(
    "session.subscribe",
    z.object({
      sessionId: id,
      afterSeq: z.number().int().nonnegative(),
    }),
  ),
  envelope(
    "turn.submit",
    z.object({
      commandId: id,
      sessionId: id,
      prompt: z.string().trim().min(1).max(20_000),
    }),
  ),
  envelope(
    "turn.interrupt",
    z.object({
      commandId: id,
      sessionId: id,
      turnId: id,
    }),
  ),
]);

export const ServerEnvelopeSchema = z.discriminatedUnion("type", [
  envelope(
    "command.accepted",
    z.object({ commandId: id, sessionId: id, turnId: id }),
  ),
  envelope(
    "command.rejected",
    z.object({
      commandId: id,
      sessionId: id,
      error: ProtocolErrorSchema,
    }),
  ),
  envelope(
    "session.snapshot",
    z.object({ snapshot: SessionSnapshotSchema }),
  ),
  envelope("runtime.status", z.object({ runtime: RuntimeSchema })),
  envelope(
    "turn.started",
    z.object({ sessionId: id, turn: TurnSchema, seq: z.number().int().positive() }),
  ),
  envelope(
    "turn.completed",
    z.object({ sessionId: id, turnId: id, seq: z.number().int().positive() }),
  ),
  envelope(
    "turn.interrupted",
    z.object({ sessionId: id, turnId: id, seq: z.number().int().positive() }),
  ),
  envelope(
    "turn.failed",
    z.object({
      sessionId: id,
      turnId: id,
      failureCode: z.string().min(1),
      seq: z.number().int().positive(),
    }),
  ),
  envelope(
    "turn.outcome_unknown",
    z.object({ sessionId: id, turnId: id, seq: z.number().int().positive() }),
  ),
  envelope(
    "assistant.message.delta",
    z.object({
      sessionId: id,
      turnId: id,
      messageId: id,
      streamSeq: z.number().int().positive(),
      text: z.string(),
    }),
  ),
  envelope(
    "assistant.message.completed",
    z.object({
      sessionId: id,
      turnId: id,
      messageId: id,
      content: z.string(),
      seq: z.number().int().positive(),
    }),
  ),
  envelope(
    "replay.boundary",
    z.object({
      sessionId: id,
      phase: z.enum(["begin", "end"]),
      afterSeq: z.number().int().nonnegative(),
      upperBoundSeq: z.number().int().nonnegative(),
    }),
  ),
  envelope("protocol.error", z.object({ error: ProtocolErrorSchema })),
]);

export const CoreToConnectorEnvelopeSchema = z.discriminatedUnion("type", [
  envelope(
    "connector.turn.start",
    z.object({
      sessionId: id,
      turnId: id,
      commandId: id,
      prompt: z.string().min(1),
      providerSessionId: id.nullable(),
    }),
  ),
  envelope(
    "connector.turn.interrupt",
    z.object({
      sessionId: id,
      turnId: id,
      commandId: id,
      providerSessionId: id,
      providerTurnId: id,
    }),
  ),
]);

export const ConnectorEnvelopeSchema = z.discriminatedUnion("type", [
  envelope("connector.hello", z.object({ runtime: RuntimeSchema })),
  envelope("connector.runtime.status", z.object({ runtime: RuntimeSchema })),
  envelope(
    "connector.command.error",
    z.object({
      commandId: id,
      sessionId: id,
      code: z.string().min(1),
      message: z.string().min(1),
      retryable: z.boolean(),
    }),
  ),
  envelope(
    "connector.session.bound",
    z.object({ sessionId: id, providerSessionId: id }),
  ),
  envelope(
    "connector.turn.bound",
    z.object({ sessionId: id, turnId: id, providerTurnId: id }),
  ),
  envelope(
    "connector.turn.delta",
    z.object({
      sessionId: id,
      turnId: id,
      messageId: id,
      streamSeq: z.number().int().positive(),
      text: z.string(),
    }),
  ),
  envelope(
    "connector.turn.message.completed",
    z.object({
      sessionId: id,
      turnId: id,
      messageId: id,
      content: z.string(),
    }),
  ),
  envelope(
    "connector.turn.completed",
    z.object({ sessionId: id, turnId: id }),
  ),
  envelope(
    "connector.turn.interrupted",
    z.object({ sessionId: id, turnId: id }),
  ),
  envelope(
    "connector.turn.failed",
    z.object({ sessionId: id, turnId: id, failureCode: z.string().min(1) }),
  ),
  envelope(
    "connector.turn.outcome_unknown",
    z.object({ sessionId: id, turnId: id }),
  ),
]);

export type ProtocolError = z.infer<typeof ProtocolErrorSchema>;
export type Turn = z.infer<typeof TurnSchema>;
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;
export type Runtime = z.infer<typeof RuntimeSchema>;
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;
export type ClientEnvelope = z.infer<typeof ClientEnvelopeSchema>;
export type ServerEnvelope = z.infer<typeof ServerEnvelopeSchema>;
export type CoreToConnectorEnvelope = z.infer<typeof CoreToConnectorEnvelopeSchema>;
export type ConnectorEnvelope = z.infer<typeof ConnectorEnvelopeSchema>;

export function makeEnvelope<T extends string, P>(type: T, payload: P) {
  return {
    protocol: "aicl" as const,
    protocolVersion: PROTOCOL_VERSION,
    messageId: crypto.randomUUID(),
    sentAt: new Date().toISOString(),
    type,
    payload,
  };
}

export function decodeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    throw new TypeError("WebSocket message must be UTF-8 JSON text");
  }

  return JSON.parse(value) as unknown;
}
