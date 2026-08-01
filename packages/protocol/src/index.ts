import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
export const MAX_WEBSOCKET_MESSAGE_BYTES = 1024 * 1024;
export const MAX_INLINE_ENVELOPE_BYTES = 768 * 1024;
export const MAX_PROMPT_BYTES = 256 * 1024;
export const MAX_OUTPUT_BATCH_BYTES = 256 * 1024;
export const MAX_INLINE_DIFF_BYTES = 512 * 1024;
export const ARTIFACT_CHUNK_BYTES = 128 * 1024;
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const MAX_ARTIFACT_CHUNKS = Math.ceil(
  MAX_ARTIFACT_BYTES / ARTIFACT_CHUNK_BYTES,
);
export const MAX_COMPLETED_MESSAGE_BYTES = 512 * 1024;
export const SAFE_ARTIFACT_MEDIA_TYPES = [
  "text/plain",
  "text/plain; charset=utf-8",
  "text/x-diff",
  "text/x-diff; charset=utf-8",
] as const;

export function websocketCapability(
  audience: "browser" | "connector",
  token: string,
) {
  if (!/^[A-Za-z0-9._~-]{16,200}$/u.test(token)) {
    throw new Error("WebSocket capability token has an invalid format");
  }
  return `aicl.${audience}.${token}`;
}

const id = z.string().min(1).max(200);
const timestamp = z.string().datetime({ offset: true });
const utf8String = (maxBytes: number) =>
  z.string().refine((value) => utf8ByteLength(value) <= maxBytes, {
    message: `UTF-8 content exceeds ${maxBytes} bytes`,
  });
const base64Chunk = z
  .string()
  .min(4)
  .max(Math.ceil(ARTIFACT_CHUNK_BYTES / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u)
  .refine((value) => decodedBase64Length(value) <= ARTIFACT_CHUNK_BYTES, {
    message: `Decoded artifact chunk exceeds ${ARTIFACT_CHUNK_BYTES} bytes`,
  });

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

const connectorEnvelope = <T extends string, S extends z.ZodTypeAny>(
  type: T,
  payload: S,
) =>
  envelope(type, payload).extend({
    connectorId: id.optional(),
    bootId: id.optional(),
    sourceEventId: id.optional(),
    runtimeId: id.optional(),
    runtimeGeneration: z.number().int().positive().optional(),
  });

const durableEventIdentity = {
  eventId: id,
  seq: z.number().int().positive(),
};

export const CommandReceiptSchema = z.object({
  commandId: id,
  state: z.enum(["received", "dispatching", "completed", "outcome_unknown"]),
});

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

export const RuntimeStatusSchema = z.enum([
  "offline",
  "ready",
  "busy",
  "lost",
  "incompatible",
]);

export const SessionOperationalStateSchema = z.enum([
  "idle",
  "running",
  "awaiting_approval",
  "completed",
  "interrupted",
  "failed",
  "outcome_unknown",
]);

export const ActivityStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "declined",
  "interrupted",
  "outcome_unknown",
]);

export const ToolActivitySchema = z.object({
  activityId: id,
  turnId: id,
  kind: z.enum(["command", "tool"]),
  title: z.string().min(1).max(20_000),
  cwd: z.string().max(4_096).nullable(),
  status: ActivityStatusSchema,
  revision: z.number().int().nonnegative(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  outputPreview: z.string().max(32 * 1024),
  eventSeq: z.number().int().nonnegative().optional(),
});

export const ArtifactReferenceSchema = z.object({
  artifactId: id,
  mediaType: z.enum(SAFE_ARTIFACT_MEDIA_TYPES),
  byteLength: z.number().int().positive().max(MAX_ARTIFACT_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  downloadPath: z.string().regex(/^\/artifacts\/[A-Za-z0-9-]+$/),
  expiresAt: timestamp.optional(),
});

export const DiffReferenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("inline"),
    content: utf8String(MAX_INLINE_DIFF_BYTES),
    byteLength: z.number().int().nonnegative().max(MAX_INLINE_DIFF_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({
    kind: z.literal("artifact"),
    artifact: ArtifactReferenceSchema,
  }),
]);

export const FileChangeSchema = z.object({
  fileChangeId: id,
  turnId: id,
  status: ActivityStatusSchema,
  revision: z.number().int().nonnegative(),
  files: z.array(
    z.object({
      path: z.string().min(1).max(4_096),
      kind: z.enum(["add", "update", "delete"]),
    }),
  ),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  diff: DiffReferenceSchema.nullable(),
  eventSeq: z.number().int().nonnegative().optional(),
});

export const ApprovalStateSchema = z.enum([
  "pending",
  "approved_once",
  "declined",
  "expired",
  "invalidated",
]);

export const ApprovalPayloadSchema = z.object({
  summary: z.string().min(1).max(20_000),
  command: z.string().max(20_000).nullable(),
  cwd: z.string().max(4_096).nullable(),
  reason: z.string().max(20_000).nullable(),
  activityId: id.nullable(),
  fileChangeId: id.nullable(),
});

export const ApprovalSchema = z.object({
  approvalId: id,
  sessionId: id,
  runtimeId: id,
  runtimeGeneration: z.number().int().positive(),
  turnId: id,
  actionType: z.enum(["command", "file_change"]),
  state: ApprovalStateSchema,
  revision: z.number().int().nonnegative(),
  expiresAt: timestamp,
  payload: ApprovalPayloadSchema,
  resolvedAt: timestamp.nullable(),
  resolvedByDeviceId: id.nullable(),
});

export const TurnSchema = z.object({
  turnId: id,
  commandId: id,
  status: TurnStatusSchema,
  prompt: z.string(),
  startedAt: timestamp,
  completedAt: timestamp.nullable(),
  failureCode: z.string().nullable(),
  providerTurnId: id.nullable(),
  eventSeq: z.number().int().nonnegative().optional(),
});

export const AssistantMessageSchema = z.object({
  messageId: id,
  turnId: id,
  content: z.string(),
  completed: z.boolean(),
  eventSeq: z.number().int().nonnegative().optional(),
});

export const RuntimeSchema = z.object({
  runtimeId: id,
  generation: z.number().int().positive(),
  status: RuntimeStatusSchema,
});

export const SessionSummarySchema = z.object({
  sessionId: id,
  state: SessionOperationalStateSchema,
  runtimeStatus: RuntimeStatusSchema.nullable(),
  activeTurnId: id.nullable(),
  pendingApprovalCount: z.number().int().nonnegative(),
  lastTurnStatus: TurnStatusSchema.nullable(),
  lastActivityAt: timestamp,
  cwd: z.string().max(4_096).nullable(),
  turnCount: z.number().int().nonnegative(),
  lastEventSeq: z.number().int().nonnegative(),
});

export const SessionSnapshotSchema = z.object({
  sessionId: id,
  revision: z.number().int().nonnegative(),
  lastEventSeq: z.number().int().nonnegative(),
  activeTurnId: id.nullable(),
  providerSessionId: id.nullable(),
  turns: z.array(TurnSchema),
  messages: z.array(AssistantMessageSchema),
  activities: z.array(ToolActivitySchema),
  fileChanges: z.array(FileChangeSchema),
  approvals: z.array(ApprovalSchema),
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
  envelope("sessions.list", z.object({}).strict()),
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
  envelope(
    "approval.resolve",
    z.object({
      commandId: id,
      sessionId: id,
      approvalId: id,
      expectedRevision: z.number().int().nonnegative(),
      decision: z.enum(["approved_once", "declined"]),
      deviceId: id,
    }),
  ),
]);

export const ServerEnvelopeSchema = z.discriminatedUnion("type", [
  envelope(
    "server.hello",
    z.object({ artifactAccessToken: id }),
  ),
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
  envelope(
    "sessions.snapshot",
    z.object({ sessions: z.array(SessionSummarySchema) }),
  ),
  envelope("runtime.status", z.object({ runtime: RuntimeSchema })),
  envelope(
    "turn.started",
    z.object({ sessionId: id, turn: TurnSchema, ...durableEventIdentity }),
  ),
  envelope(
    "turn.completed",
    z.object({ sessionId: id, turnId: id, ...durableEventIdentity }),
  ),
  envelope(
    "turn.interrupted",
    z.object({ sessionId: id, turnId: id, ...durableEventIdentity }),
  ),
  envelope(
    "turn.failed",
    z.object({
      sessionId: id,
      turnId: id,
      failureCode: z.string().min(1),
      ...durableEventIdentity,
    }),
  ),
  envelope(
    "turn.outcome_unknown",
    z.object({ sessionId: id, turnId: id, ...durableEventIdentity }),
  ),
  envelope(
    "assistant.message.delta",
    z.object({
      sessionId: id,
      turnId: id,
      messageId: id,
      streamSeq: z.number().int().positive(),
      text: utf8String(MAX_OUTPUT_BATCH_BYTES),
    }),
  ),
  envelope(
    "assistant.message.completed",
    z.object({
      sessionId: id,
      turnId: id,
      messageId: id,
      content: utf8String(MAX_COMPLETED_MESSAGE_BYTES),
      ...durableEventIdentity,
    }),
  ),
  envelope(
    "activity.started",
    z.object({ sessionId: id, activity: ToolActivitySchema, ...durableEventIdentity }),
  ),
  envelope(
    "activity.completed",
    z.object({ sessionId: id, activity: ToolActivitySchema, ...durableEventIdentity }),
  ),
  envelope(
    "command.output.batch",
    z.object({
      sessionId: id,
      turnId: id,
      activityId: id,
      streamSeq: z.number().int().positive(),
      output: utf8String(MAX_OUTPUT_BATCH_BYTES),
    }),
  ),
  envelope(
    "file.change.started",
    z.object({ sessionId: id, fileChange: FileChangeSchema, ...durableEventIdentity }),
  ),
  envelope(
    "file.change.completed",
    z.object({ sessionId: id, fileChange: FileChangeSchema, ...durableEventIdentity }),
  ),
  envelope(
    "approval.requested",
    z.object({ sessionId: id, approval: ApprovalSchema, ...durableEventIdentity }),
  ),
  envelope(
    "approval.resolved",
    z.object({ sessionId: id, approval: ApprovalSchema, ...durableEventIdentity }),
  ),
  envelope(
    "approval.expired",
    z.object({ sessionId: id, approval: ApprovalSchema, ...durableEventIdentity }),
  ),
  envelope(
    "approval.invalidated",
    z.object({ sessionId: id, approval: ApprovalSchema, ...durableEventIdentity }),
  ),
  envelope(
    "interrupt.result",
    z.object({
      commandId: id,
      sessionId: id,
      turnId: id,
      status: z.literal("accepted"),
      ...durableEventIdentity,
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
      runtimeId: id,
      runtimeGeneration: z.number().int().positive(),
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
  envelope(
    "connector.approval.resolve",
    z.object({
      commandId: id,
      sessionId: id,
      turnId: id,
      approvalId: id,
      providerCorrelationId: id,
      runtimeId: id,
      runtimeGeneration: z.number().int().positive(),
      decision: z.enum(["approved_once", "declined"]),
    }),
  ),
  envelope(
    "connector.journal.ack",
    z.object({ sourceEventId: id }),
  ),
]);

export const ConnectorEnvelopeSchema = z.discriminatedUnion("type", [
  connectorEnvelope(
    "connector.hello",
    z.object({
      connectorId: id,
      bootId: id,
      runtime: RuntimeSchema,
      commandReceipts: z.array(CommandReceiptSchema).max(1_000),
    }),
  ),
  connectorEnvelope("connector.runtime.status", z.object({ runtime: RuntimeSchema })),
  connectorEnvelope(
    "connector.command.error",
    z.object({
      commandId: id,
      sessionId: id,
      turnId: id,
      code: z.string().min(1),
      message: z.string().min(1),
      retryable: z.boolean(),
    }),
  ),
  connectorEnvelope(
    "connector.command.completed",
    z.object({ commandId: id, sessionId: id, turnId: id }),
  ),
  connectorEnvelope(
    "connector.session.bound",
    z.object({ sessionId: id, providerSessionId: id }),
  ),
  connectorEnvelope(
    "connector.turn.bound",
    z.object({ sessionId: id, turnId: id, providerTurnId: id }),
  ),
  connectorEnvelope(
    "connector.turn.delta",
    z.object({
      sessionId: id,
      turnId: id,
      messageId: id,
      streamSeq: z.number().int().positive(),
      text: utf8String(MAX_OUTPUT_BATCH_BYTES),
    }),
  ),
  connectorEnvelope(
    "connector.activity.started",
    z.object({ sessionId: id, activity: ToolActivitySchema }),
  ),
  connectorEnvelope(
    "connector.activity.completed",
    z.object({ sessionId: id, activity: ToolActivitySchema }),
  ),
  connectorEnvelope(
    "connector.command.output.batch",
    z.object({
      sessionId: id,
      turnId: id,
      activityId: id,
      streamSeq: z.number().int().positive(),
      output: utf8String(MAX_OUTPUT_BATCH_BYTES),
    }),
  ),
  connectorEnvelope(
    "connector.file.change.started",
    z.object({ sessionId: id, fileChange: FileChangeSchema }),
  ),
  connectorEnvelope(
    "connector.file.change.completed",
    z.object({
      sessionId: id,
      fileChange: FileChangeSchema.omit({ diff: true }).extend({
        inlineDiff: z.string().nullable(),
        artifact: ArtifactReferenceSchema.nullable(),
      }),
    }),
  ),
  connectorEnvelope(
    "connector.approval.requested",
    z.object({
      sessionId: id,
      approval: ApprovalSchema,
      providerCorrelationId: id,
    }),
  ),
  connectorEnvelope(
    "connector.interrupt.result",
    z.object({
      commandId: id,
      sessionId: id,
      turnId: id,
      status: z.literal("accepted"),
    }),
  ),
  connectorEnvelope(
    "connector.artifact.begin",
    z.object({
      sessionId: id,
      turnId: id,
      artifact: ArtifactReferenceSchema,
      chunkCount: z.number().int().positive().max(MAX_ARTIFACT_CHUNKS),
    }),
  ),
  connectorEnvelope(
    "connector.artifact.chunk",
    z.object({
      sessionId: id,
      turnId: id,
      artifactId: id,
      chunkIndex: z.number().int().nonnegative(),
      contentBase64: base64Chunk,
    }),
  ),
  connectorEnvelope(
    "connector.artifact.complete",
    z.object({ sessionId: id, turnId: id, artifactId: id }),
  ),
  connectorEnvelope(
    "connector.turn.message.completed",
    z.object({
      sessionId: id,
      turnId: id,
      messageId: id,
      content: utf8String(MAX_COMPLETED_MESSAGE_BYTES),
    }),
  ),
  connectorEnvelope(
    "connector.turn.completed",
    z.object({ sessionId: id, turnId: id }),
  ),
  connectorEnvelope(
    "connector.turn.interrupted",
    z.object({ sessionId: id, turnId: id }),
  ),
  connectorEnvelope(
    "connector.turn.failed",
    z.object({ sessionId: id, turnId: id, failureCode: z.string().min(1) }),
  ),
  connectorEnvelope(
    "connector.turn.outcome_unknown",
    z.object({ sessionId: id, turnId: id }),
  ),
]);

export type ProtocolError = z.infer<typeof ProtocolErrorSchema>;
export type Turn = z.infer<typeof TurnSchema>;
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;
export type Runtime = z.infer<typeof RuntimeSchema>;
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export type ToolActivity = z.infer<typeof ToolActivitySchema>;
export type FileChange = z.infer<typeof FileChangeSchema>;
export type Approval = z.infer<typeof ApprovalSchema>;
export type ArtifactReference = z.infer<typeof ArtifactReferenceSchema>;
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

export function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

export function redactSensitiveText(value: unknown) {
  return String(value)
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/(cookie\s*:\s*)[^\r\n]+/giu, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[=:]\s*)[^\s,;]+/giu,
      "$1[REDACTED]",
    )
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gu,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED]@")
    .slice(0, 4_096);
}

function decodedBase64Length(value: string) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

export function decodeJson(
  value: unknown,
  maxBytes = MAX_WEBSOCKET_MESSAGE_BYTES,
): unknown {
  if (typeof value !== "string") {
    throw new TypeError("WebSocket message must be UTF-8 JSON text");
  }
  if (utf8ByteLength(value) > maxBytes) {
    throw new RangeError(`WebSocket message exceeds ${maxBytes} bytes`);
  }

  return JSON.parse(value) as unknown;
}
