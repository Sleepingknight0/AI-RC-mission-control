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

const WEBSOCKET_CAPABILITY_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{16,200}$/u;

export function websocketCapability(
  audience: "browser" | "connector",
  token: string,
) {
  if (!WEBSOCKET_CAPABILITY_TOKEN_PATTERN.test(token)) {
    throw new Error("WebSocket capability token has an invalid format");
  }
  return `aicl.${audience}.${token}`;
}

export function websocketCapabilityToken(
  value: string,
  audience: "browser" | "connector",
): string | null {
  const prefix = `aicl.${audience}.`;
  if (!value.startsWith(prefix)) return null;
  const token = value.slice(prefix.length);
  return WEBSOCKET_CAPABILITY_TOKEN_PATTERN.test(token) ? token : null;
}

const id = z.string().min(1).max(200);
const timestamp = z.string().datetime({ offset: true });

export const BrowserRuntimeConfigSchema = z.object({
  webSocketPath: z.literal("/ws"),
  ticket: z.string().regex(WEBSOCKET_CAPABILITY_TOKEN_PATTERN),
  expiresAt: timestamp,
}).strict();
export type BrowserRuntimeConfig = z.infer<typeof BrowserRuntimeConfigSchema>;
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

export const MAX_PROVIDER_INVENTORY = 64;
export const MAX_PROVIDER_ACCOUNTS = 32;
export const MAX_PROVIDER_MODELS = 128;
export const MAX_PROVIDER_REASONING_OPTIONS = 16;
export const MAX_PROVIDER_USAGE_METERS = 8;
export const MAX_PROVIDER_NATIVE_SESSIONS = 500;

const providerSlug = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const displayText = (maxLength: number) =>
  z
    .string()
    .min(1)
    .max(maxLength)
    .refine((value) => !hasControlCharacter(value), {
      message: "display text may not contain control characters",
    });

export const ProviderCapabilityKeySchema = z.enum([
  "inventory",
  "installation_probe",
  "authentication_probe",
  "usage_collection",
  "remote_control",
  "list_sessions",
  "create_session",
  "resume_session",
  "list_models",
  "change_model",
  "reasoning_levels",
  "text_input",
  "file_input",
  "image_input",
  "approval_policies",
  "sandbox_policies",
  "network_policies",
]);
export const ProviderCapabilityStateSchema = z.enum([
  "supported",
  "unsupported",
  "unknown",
]);
export const ProviderCapabilityProvenanceSchema = z.enum([
  "terminal_registry",
  "adapter_manifest",
  "provider_probe",
]);
export const ProviderCapabilityEvidenceSchema = z
  .object({
    key: ProviderCapabilityKeySchema,
    state: ProviderCapabilityStateSchema,
    provenance: ProviderCapabilityProvenanceSchema,
    observedAt: timestamp,
    reason: displayText(200).nullable(),
  })
  .strict();

export const ProviderInstallationStateSchema = z.enum([
  "installed",
  "not_installed",
  "unknown",
  "error",
]);
export const ProviderAuthenticationStateSchema = z.enum([
  "authenticated",
  "not_authenticated",
  "unknown",
  "error",
]);
export const ProviderCompatibilityStateSchema = z.enum([
  "compatible",
  "incompatible",
  "unknown",
  "error",
]);
export const ProviderAdapterSupportSchema = z.enum([
  "inventory_only",
  "remote_control",
]);
export const ProviderFreshnessSchema = z.enum([
  "live",
  "local",
  "stale",
  "offline",
  "unavailable",
]);
export const ProviderUsageStateSchema = z.enum([
  "available",
  "unavailable",
  "not_supported",
  "not_authenticated",
  "stale",
  "error",
]);
export const ProviderModelsStateSchema = z.enum([
  "available",
  "unavailable",
  "not_supported",
  "stale",
  "error",
]);

export const ProviderAccountSchema = z
  .object({
    accountId: providerSlug,
    displayName: displayText(96),
    isDefault: z.boolean(),
    authentication: ProviderAuthenticationStateSchema,
    control: ProviderAdapterSupportSchema,
    observedAt: timestamp,
    notice: displayText(200).nullable(),
  })
  .strict();

export const ProviderReasoningOptionSchema = z
  .object({
    value: displayText(64),
    description: displayText(200),
  })
  .strict();
export const ProviderModelSchema = z
  .object({
    modelId: displayText(128),
    displayName: displayText(128),
    description: displayText(500),
    hidden: z.boolean(),
    isDefault: z.boolean(),
    inputModalities: z.array(z.enum(["text", "image"])).min(1).max(2),
    defaultReasoningEffort: displayText(64).nullable(),
    reasoningEfforts: z
      .array(ProviderReasoningOptionSchema)
      .max(MAX_PROVIDER_REASONING_OPTIONS),
  })
  .strict()
  .superRefine((model, context) => {
    addDuplicateIssue(
      model.reasoningEfforts.map((option) => option.value),
      "reasoning effort",
      context,
    );
    if (
      model.defaultReasoningEffort !== null &&
      !model.reasoningEfforts.some(
        (option) => option.value === model.defaultReasoningEffort,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "default reasoning effort must be advertised",
      });
    }
  });

export const ProviderUsageMeterSchema = z
  .object({
    meterId: providerSlug,
    displayName: displayText(64),
    state: ProviderUsageStateSchema,
    remainingPercent: z.number().min(0).max(100).nullable(),
    resetAt: timestamp.nullable(),
    detail: displayText(200).nullable(),
  })
  .strict()
  .superRefine((meter, context) => {
    if (
      meter.state !== "available" &&
      (meter.remainingPercent !== null || meter.resetAt !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "unavailable usage evidence may not contain measured values",
      });
    }
  });

export const ProviderRecordSchema = z
  .object({
    providerId: providerSlug,
    displayName: displayText(96),
    enabled: z.boolean(),
    installation: ProviderInstallationStateSchema,
    authentication: ProviderAuthenticationStateSchema,
    compatibility: ProviderCompatibilityStateSchema,
    adapterSupport: ProviderAdapterSupportSchema,
    version: displayText(64).nullable(),
    freshness: ProviderFreshnessSchema,
    observedAt: timestamp,
    notice: displayText(200).nullable(),
    capabilities: z
      .array(ProviderCapabilityEvidenceSchema)
      .max(ProviderCapabilityKeySchema.options.length),
    accounts: z.array(ProviderAccountSchema).max(MAX_PROVIDER_ACCOUNTS),
    accountCount: z.number().int().nonnegative(),
    models: z.array(ProviderModelSchema).max(MAX_PROVIDER_MODELS),
    modelsState: ProviderModelsStateSchema,
    usageState: ProviderUsageStateSchema,
    usageMeters: z.array(ProviderUsageMeterSchema).max(MAX_PROVIDER_USAGE_METERS),
  })
  .strict()
  .superRefine((provider, context) => {
    addDuplicateIssue(
      provider.capabilities.map((capability) => capability.key),
      "capability",
      context,
    );
    addDuplicateIssue(
      provider.accounts.map((account) => account.accountId),
      "account",
      context,
    );
    addDuplicateIssue(
      provider.models.map((model) => model.modelId),
      "model",
      context,
    );
    addDuplicateIssue(
      provider.usageMeters.map((meter) => meter.meterId),
      "usage meter",
      context,
    );
    if (provider.accountCount < provider.accounts.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "accountCount may not be smaller than accounts.length",
      });
    }
    if (
      provider.adapterSupport === "remote_control" &&
      !provider.capabilities.some(
        (capability) =>
          capability.key === "remote_control" &&
          capability.state === "supported",
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "remote-control adapter requires supported capability evidence",
      });
    }
    if (
      provider.usageState !== "available" &&
      provider.usageMeters.some(
        (meter) =>
          meter.remainingPercent !== null || meter.resetAt !== null,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "unavailable provider usage may not contain measured values",
      });
    }
  });

export const ProviderFleetSnapshotSchema = z
  .object({
    snapshotId: id,
    revision: z.number().int().positive(),
    source: z.enum(["terminal_registry", "connector_fallback", "unavailable"]),
    observedAt: timestamp,
    staleAt: timestamp,
    freshness: ProviderFreshnessSchema,
    degraded: z.boolean(),
    providers: z.array(ProviderRecordSchema).max(MAX_PROVIDER_INVENTORY),
    notice: displayText(200).nullable(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    addDuplicateIssue(
      snapshot.providers.map((provider) => provider.providerId),
      "provider",
      context,
    );
    if (Date.parse(snapshot.staleAt) <= Date.parse(snapshot.observedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "staleAt must be later than observedAt",
      });
    }
  });

export const ProviderNativeSessionSchema = z
  .object({
    providerId: providerSlug,
    accountId: providerSlug,
    providerSessionId: id.refine((value) => !hasControlCharacter(value), {
      message: "provider Session ID may not contain control characters",
    }),
    title: displayText(160),
    preview: displayText(500).nullable(),
    projectPath: z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => !hasControlCharacter(value), {
        message: "project path may not contain control characters",
      }),
    projectName: displayText(160),
    branch: displayText(512).nullable(),
    providerStatus: z.enum(["idle", "active", "not_loaded", "error"]),
    createdAt: timestamp,
    updatedAt: timestamp,
    pinned: z.boolean(),
    archived: z.boolean(),
    canResume: z.boolean(),
  })
  .strict();

export const ProviderNativeSessionSnapshotSchema = z
  .object({
    snapshotId: id,
    revision: z.number().int().positive(),
    providerId: providerSlug,
    accountId: providerSlug,
    observedAt: timestamp,
    staleAt: timestamp,
    freshness: ProviderFreshnessSchema,
    truncated: z.boolean(),
    sessions: z
      .array(ProviderNativeSessionSchema)
      .max(MAX_PROVIDER_NATIVE_SESSIONS),
    notice: displayText(200).nullable(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    addDuplicateIssue(
      snapshot.sessions.map((session) => session.providerSessionId),
      "provider-native Session",
      context,
    );
    if (Date.parse(snapshot.staleAt) <= Date.parse(snapshot.observedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "staleAt must be later than observedAt",
      });
    }
    if (
      snapshot.sessions.some(
        (session) =>
          session.providerId !== snapshot.providerId ||
          session.accountId !== snapshot.accountId,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "native Sessions must match snapshot provider and account",
      });
    }
  });

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

export const SessionSourceSchema = z.enum([
  "aicl",
  "provider_native",
  "imported",
]);
export const SessionProviderBindingStatusSchema = z.enum([
  "unbound",
  "pending",
  "ready",
  "failed",
  "outcome_unknown",
]);
export const ExecutionModeSchema = z.enum(["ask", "plan", "auto"]);
export const ApprovalPolicySchema = z.enum([
  "review",
  "balanced",
  "workspace_auto",
  "full_auto_lease",
]);
export const SandboxPolicySchema = z.enum(["read_only", "workspace_write"]);
export const NetworkPolicySchema = z.enum(["denied", "restricted"]);

export const SessionSettingsSchema = z
  .object({
    providerId: providerSlug,
    accountId: providerSlug.nullable(),
    model: displayText(128).nullable(),
    reasoningLevel: displayText(64).nullable(),
    executionMode: ExecutionModeSchema,
    approvalPolicy: ApprovalPolicySchema,
    sandboxPolicy: SandboxPolicySchema,
    networkPolicy: NetworkPolicySchema,
    projectPath: z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => !hasControlCharacter(value))
      .nullable(),
    branch: displayText(512).nullable(),
  })
  .strict();

export const SessionSettingsSnapshotSchema = z
  .object({
    sessionId: id,
    revision: z.number().int().nonnegative(),
    mutable: z.boolean(),
    settings: SessionSettingsSchema,
  })
  .strict();

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
  settingsRevision: z.number().int().nonnegative().optional(),
  effectiveSettings: SessionSettingsSchema.optional(),
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

export const SessionSummaryV2Schema = z
  .object({
    sessionId: id,
    title: displayText(160),
    providerId: providerSlug,
    accountId: providerSlug.nullable(),
    providerSessionId: id.nullable(),
    source: SessionSourceSchema,
    providerBindingStatus: SessionProviderBindingStatusSchema,
    projectPath: z.string().max(4_096).nullable(),
    projectName: displayText(160).nullable(),
    branch: displayText(512).nullable(),
    model: displayText(128).nullable(),
    reasoningLevel: displayText(64).nullable(),
    executionMode: ExecutionModeSchema,
    approvalPolicy: ApprovalPolicySchema,
    sandboxPolicy: SandboxPolicySchema,
    networkPolicy: NetworkPolicySchema,
    state: SessionOperationalStateSchema,
    runtimeStatus: RuntimeStatusSchema.nullable(),
    activeTurnId: id.nullable(),
    pendingApprovalCount: z.number().int().nonnegative(),
    turnCount: z.number().int().nonnegative(),
    unreadCount: z.number().int().nonnegative(),
    lastActivityAt: timestamp,
    lastEventSeq: z.number().int().nonnegative(),
    canResume: z.boolean(),
    canControl: z.boolean(),
    pinned: z.boolean(),
    archived: z.boolean(),
    revision: z.number().int().nonnegative(),
    settingsRevision: z.number().int().nonnegative(),
  })
  .strict();

export const SessionCatalogFilterSchema = z
  .object({
    search: z.string().trim().max(200).nullable(),
    providerIds: z.array(providerSlug).max(16),
    accountIds: z.array(providerSlug).max(32),
    states: z.array(SessionOperationalStateSchema).max(
      SessionOperationalStateSchema.options.length,
    ),
    project: z.string().trim().max(4_096).nullable(),
    archived: z.enum(["exclude", "include", "only"]),
    pinned: z.boolean().nullable(),
  })
  .strict()
  .superRefine((filters, context) => {
    addDuplicateIssue(filters.providerIds, "provider filter", context);
    addDuplicateIssue(filters.accountIds, "account filter", context);
    addDuplicateIssue(filters.states, "state filter", context);
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
    "sessions.catalog.list",
    z
      .object({
        requestId: id,
        deviceId: id,
        pageSize: z.number().int().min(1).max(250),
        cursor: z.string().max(1_024).nullable(),
        filters: SessionCatalogFilterSchema,
      })
      .strict(),
  ),
  envelope("providers.refresh", z.object({}).strict()),
  envelope(
    "sessions.native.refresh",
    z
      .object({
        providerId: providerSlug,
        accountId: providerSlug,
      })
      .strict(),
  ),
  envelope(
    "session.create",
    z
      .object({
        commandId: id,
        sessionId: id,
        deviceId: id,
        title: displayText(160),
        providerId: providerSlug,
        accountId: providerSlug,
        projectPath: z
          .string()
          .min(1)
          .max(4_096)
          .refine((value) => !hasControlCharacter(value)),
        model: displayText(128).nullable(),
        reasoningLevel: displayText(64).nullable(),
      })
      .strict(),
  ),
  envelope(
    "session.resume",
    z
      .object({
        commandId: id,
        sessionId: id,
        deviceId: id,
        providerId: providerSlug,
        accountId: providerSlug,
        providerSessionId: id,
      })
      .strict(),
  ),
  envelope(
    "session.rename",
    z
      .object({
        commandId: id,
        sessionId: id,
        deviceId: id,
        expectedRevision: z.number().int().nonnegative(),
        title: displayText(160),
      })
      .strict(),
  ),
  envelope(
    "session.pin",
    z
      .object({
        commandId: id,
        sessionId: id,
        deviceId: id,
        expectedRevision: z.number().int().nonnegative(),
        pinned: z.boolean(),
      })
      .strict(),
  ),
  envelope(
    "session.archive",
    z
      .object({
        commandId: id,
        sessionId: id,
        deviceId: id,
        expectedRevision: z.number().int().nonnegative(),
        archived: z.boolean(),
      })
      .strict(),
  ),
  envelope(
    "session.read.mark",
    z
      .object({
        commandId: id,
        sessionId: id,
        deviceId: id,
        upToEventSeq: z.number().int().nonnegative(),
      })
      .strict(),
  ),
  envelope(
    "session.settings.get",
    z.object({ sessionId: id }).strict(),
  ),
  envelope(
    "session.settings.update",
    z
      .object({
        commandId: id,
        sessionId: id,
        deviceId: id,
        expectedRevision: z.number().int().nonnegative(),
        settings: SessionSettingsSchema,
      })
      .strict(),
  ),
  envelope(
    "turn.submit",
    z
      .object({
        commandId: id,
        sessionId: id,
        prompt: z.string().trim().min(1).max(20_000),
        settingsRevision: z.number().int().nonnegative().optional(),
      })
      .strict(),
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
  envelope(
    "sessions.catalog.snapshot",
    z
      .object({
        requestId: id,
        catalogRevision: z.number().int().positive(),
        generatedAt: timestamp,
        sessions: z.array(SessionSummaryV2Schema).max(250),
        nextCursor: z.string().max(1_024).nullable(),
        total: z.number().int().nonnegative(),
      })
      .strict(),
  ),
  envelope(
    "session.command.accepted",
    z
      .object({
        commandId: id,
        sessionId: id,
        revision: z.number().int().nonnegative(),
      })
      .strict(),
  ),
  envelope(
    "session.provider.status",
    z
      .object({
        commandId: id,
        sessionId: id,
        providerId: providerSlug,
        accountId: providerSlug,
        providerSessionId: id.nullable(),
        status: SessionProviderBindingStatusSchema.exclude(["unbound"]),
        failureCode: displayText(96).nullable(),
        runtimeId: id,
        runtimeGeneration: z.number().int().positive(),
        updatedAt: timestamp,
      })
      .strict(),
  ),
  envelope(
    "session.settings.snapshot",
    z.object({ snapshot: SessionSettingsSnapshotSchema }).strict(),
  ),
  envelope(
    "providers.snapshot",
    z.object({ snapshot: ProviderFleetSnapshotSchema }).strict(),
  ),
  envelope(
    "sessions.native.snapshot",
    z.object({ snapshot: ProviderNativeSessionSnapshotSchema }).strict(),
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
    "connector.session.create",
    z
      .object({
        commandId: id,
        sessionId: id,
        providerId: providerSlug,
        accountId: providerSlug,
        projectPath: z.string().min(1).max(4_096),
        model: displayText(128).nullable(),
        reasoningLevel: displayText(64).nullable(),
        runtimeId: id,
        runtimeGeneration: z.number().int().positive(),
      })
      .strict(),
  ),
  envelope(
    "connector.session.resume",
    z
      .object({
        commandId: id,
        sessionId: id,
        providerId: providerSlug,
        accountId: providerSlug,
        providerSessionId: id,
        projectPath: z.string().min(1).max(4_096),
        model: displayText(128).nullable(),
        reasoningLevel: displayText(64).nullable(),
        runtimeId: id,
        runtimeGeneration: z.number().int().positive(),
      })
      .strict(),
  ),
  envelope(
    "connector.turn.start",
    z
      .object({
        sessionId: id,
        turnId: id,
        commandId: id,
        prompt: z.string().min(1),
        providerSessionId: id.nullable(),
        runtimeId: id,
        runtimeGeneration: z.number().int().positive(),
        settingsRevision: z.number().int().nonnegative().optional(),
        effectiveSettings: SessionSettingsSchema.optional(),
      })
      .strict(),
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
  envelope("connector.providers.refresh", z.object({}).strict()),
  envelope(
    "connector.sessions.native.refresh",
    z
      .object({
        providerId: providerSlug,
        accountId: providerSlug,
      })
      .strict(),
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
    "connector.providers.snapshot",
    z.object({ snapshot: ProviderFleetSnapshotSchema }).strict(),
  ),
  connectorEnvelope(
    "connector.sessions.native.snapshot",
    z.object({ snapshot: ProviderNativeSessionSnapshotSchema }).strict(),
  ),
  connectorEnvelope(
    "connector.session.prepared",
    z
      .object({
        commandId: id,
        sessionId: id,
        providerId: providerSlug,
        accountId: providerSlug,
        providerSessionId: id,
        projectPath: z.string().min(1).max(4_096),
        model: displayText(128).nullable(),
        reasoningLevel: displayText(64).nullable(),
      })
      .strict(),
  ),
  connectorEnvelope(
    "connector.session.prepare.failed",
    z
      .object({
        commandId: id,
        sessionId: id,
        code: displayText(96),
      })
      .strict(),
  ),
  connectorEnvelope(
    "connector.session.prepare.outcome_unknown",
    z.object({ commandId: id, sessionId: id }).strict(),
  ),
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
export type ProviderCapabilityKey = z.infer<typeof ProviderCapabilityKeySchema>;
export type ProviderCapabilityEvidence = z.infer<
  typeof ProviderCapabilityEvidenceSchema
>;
export type ProviderAccount = z.infer<typeof ProviderAccountSchema>;
export type ProviderModel = z.infer<typeof ProviderModelSchema>;
export type ProviderRecord = z.infer<typeof ProviderRecordSchema>;
export type ProviderFleetSnapshot = z.infer<typeof ProviderFleetSnapshotSchema>;
export type ProviderNativeSession = z.infer<typeof ProviderNativeSessionSchema>;
export type ProviderNativeSessionSnapshot = z.infer<
  typeof ProviderNativeSessionSnapshotSchema
>;
export type Turn = z.infer<typeof TurnSchema>;
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;
export type Runtime = z.infer<typeof RuntimeSchema>;
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export type SessionSummaryV2 = z.infer<typeof SessionSummaryV2Schema>;
export type SessionCatalogFilter = z.infer<typeof SessionCatalogFilterSchema>;
export type SessionSettings = z.infer<typeof SessionSettingsSchema>;
export type SessionSettingsSnapshot = z.infer<
  typeof SessionSettingsSnapshotSchema
>;
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

function hasControlCharacter(value: string) {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function addDuplicateIssue(
  values: readonly string[],
  label: string,
  context: z.RefinementCtx,
) {
  if (new Set(values).size === values.length) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: `duplicate ${label} identity`,
  });
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
