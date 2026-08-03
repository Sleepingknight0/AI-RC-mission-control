import { basename } from "node:path";

import { canonicalProjectRoot } from "@aicl/config";
import {
  MAX_PROVIDER_MODELS,
  MAX_PROVIDER_NATIVE_SESSIONS,
  ProviderNativeSessionSchema,
  ProviderNativeSessionSnapshotSchema,
  ProviderModelSchema,
  type ProviderModel,
  type ProviderNativeSession,
  type ProviderNativeSessionSnapshot,
} from "@aicl/protocol";
import { z } from "zod";

import { sanitizeProviderText } from "../provider-inventory.js";

export interface CodexDiscoveryRpc {
  request(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number; terminateOnTimeout?: boolean },
  ): Promise<unknown>;
}

export interface CodexDiscoveryOptions {
  providerId: "codex";
  accountId: string;
  allowedRoots: readonly string[];
  timeoutMs?: number;
  now?: () => Date;
}

export interface CodexCapabilityProbe {
  authenticated: boolean;
  models: ProviderModel[];
  modelsTruncated: boolean;
}

const AccountReadResponseSchema = z
  .object({
    account: z
      .discriminatedUnion("type", [
        z.object({ type: z.literal("apiKey") }).passthrough(),
        z
          .object({
            type: z.literal("chatgpt"),
            email: z.string().nullable(),
            planType: z.string(),
          })
          .passthrough(),
        z.object({ type: z.literal("amazonBedrock") }).passthrough(),
      ])
      .nullable(),
    requiresOpenaiAuth: z.boolean(),
  })
  .passthrough();

const RawReasoningOptionSchema = z
  .object({
    reasoningEffort: z.string().min(1).max(64),
    description: z.string().max(1_000),
  })
  .passthrough();
const RawModelSchema = z
  .object({
    id: z.string().min(1).max(128),
    displayName: z.string().min(1).max(1_000),
    description: z.string().max(4_000),
    hidden: z.boolean(),
    isDefault: z.boolean(),
    inputModalities: z
      .array(z.enum(["text", "image", "audio"]))
      .max(8)
      .optional(),
    defaultReasoningEffort: z.string().min(1).max(64).nullable(),
    supportedReasoningEfforts: z
      .array(RawReasoningOptionSchema)
      .max(64),
  })
  .passthrough();
const ModelListResponseSchema = z
  .object({
    data: z.array(RawModelSchema).max(MAX_PROVIDER_MODELS),
    nextCursor: z.string().max(1_024).nullable(),
  })
  .passthrough();

const RawThreadSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().max(4_000).nullable().optional(),
    preview: z.string().max(20_000),
    cwd: z.string().min(1).max(4_096),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    recencyAt: z.number().int().nonnegative().nullable().optional(),
    isPinned: z.boolean().optional(),
    gitInfo: z
      .object({ branch: z.string().max(4_096).nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    status: z
      .object({
        type: z.enum(["notLoaded", "idle", "systemError", "active"]),
      })
      .passthrough(),
  })
  .passthrough();
const ThreadListResponseSchema = z
  .object({
    data: z.array(RawThreadSchema).max(100),
    nextCursor: z.string().max(1_024).nullable(),
  })
  .passthrough();

export async function probeCodexCapabilities(
  rpc: CodexDiscoveryRpc,
  options: Pick<CodexDiscoveryOptions, "timeoutMs"> = {},
): Promise<CodexCapabilityProbe> {
  const timeoutMs = options.timeoutMs ?? 2_500;
  const account = AccountReadResponseSchema.parse(
    await rpc.request("account/read", { refreshToken: false }, {
      timeoutMs,
      terminateOnTimeout: false,
    }),
  );
  const models: ProviderModel[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let modelsTruncated = false;
  do {
    const page = ModelListResponseSchema.parse(
      await rpc.request(
        "model/list",
        { cursor, includeHidden: true, limit: 100 },
        { timeoutMs, terminateOnTimeout: false },
      ),
    );
    for (const raw of page.data) {
      if (seen.has(raw.id)) continue;
      seen.add(raw.id);
      if (models.length >= MAX_PROVIDER_MODELS) {
        modelsTruncated = true;
        break;
      }
      const model = normalizeModel(raw);
      if (model !== null) models.push(model);
    }
    cursor = page.nextCursor;
    if (models.length >= MAX_PROVIDER_MODELS && cursor !== null) {
      modelsTruncated = true;
      break;
    }
  } while (cursor !== null);

  return {
    // `requiresOpenaiAuth` describes the configured authentication mode. A
    // non-null account is the installed app-server's current login evidence.
    authenticated: account.account !== null,
    models,
    modelsTruncated,
  };
}

export async function discoverCodexNativeSessions(
  rpc: CodexDiscoveryRpc,
  options: CodexDiscoveryOptions & { revision: number },
): Promise<ProviderNativeSessionSnapshot> {
  const now = (options.now ?? (() => new Date()))();
  const timeoutMs = options.timeoutMs ?? 2_500;
  const deadline = Date.now() + timeoutMs;
  const sessions: ProviderNativeSession[] = [];
  const seen = new Set<string>();
  let malformed = 0;
  let truncated = false;

  for (const archived of [false, true]) {
    let cursor: string | null = null;
    do {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const page = ThreadListResponseSchema.parse(
        await rpc.request(
          "thread/list",
          {
            archived,
            cursor,
            limit: Math.min(100, MAX_PROVIDER_NATIVE_SESSIONS - sessions.length),
            sortKey: "updated_at",
            sortDirection: "desc",
            useStateDbOnly: true,
          },
          { timeoutMs: remaining, terminateOnTimeout: false },
        ),
      );
      for (const raw of page.data) {
        if (seen.has(raw.id)) continue;
        seen.add(raw.id);
        if (sessions.length >= MAX_PROVIDER_NATIVE_SESSIONS) {
          truncated = true;
          break;
        }
        const session = normalizeThread(raw, archived, options);
        if (session === null) malformed += 1;
        else sessions.push(session);
      }
      cursor = page.nextCursor;
      if (sessions.length >= MAX_PROVIDER_NATIVE_SESSIONS && cursor !== null) {
        truncated = true;
        break;
      }
    } while (cursor !== null);
    if (truncated) break;
  }

  sessions.sort(
    (left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
      left.providerSessionId.localeCompare(right.providerSessionId),
  );
  const observedAt = now.toISOString();
  return ProviderNativeSessionSnapshotSchema.parse({
    snapshotId: `native-${crypto.randomUUID()}`,
    revision: options.revision,
    providerId: options.providerId,
    accountId: options.accountId,
    observedAt,
    staleAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
    freshness: "live",
    truncated,
    sessions,
    notice:
      malformed > 0
        ? `${malformed} malformed or unauthorized Codex Sessions were omitted`
        : truncated
          ? "Codex Session discovery reached its configured bound"
          : null,
  });
}

function normalizeModel(raw: z.infer<typeof RawModelSchema>): ProviderModel | null {
  const reasoningEfforts = raw.supportedReasoningEfforts
    .slice(0, 16)
    .map((option) => ({
      value: sanitizeProviderText(option.reasoningEffort, 64),
      description: sanitizeProviderText(option.description, 200),
    }))
    .filter(
      (option): option is { value: string; description: string } =>
        option.value !== null && option.description !== null,
    );
  const defaultReasoningEffort = reasoningEfforts.some(
    (option) => option.value === raw.defaultReasoningEffort,
  )
    ? raw.defaultReasoningEffort
    : null;
  const displayName = sanitizeProviderText(raw.displayName, 128);
  const description = sanitizeProviderText(raw.description, 500);
  if (displayName === null || description === null) return null;
  const advertised = raw.inputModalities ?? ["text"];
  const inputModalities = [
    ...new Set(advertised.filter((value) => value === "text" || value === "image")),
  ];
  if (!inputModalities.includes("text")) inputModalities.unshift("text");
  const result = ProviderModelSchema.safeParse({
    modelId: raw.id,
    displayName,
    description,
    hidden: raw.hidden,
    isDefault: raw.isDefault,
    inputModalities,
    defaultReasoningEffort,
    reasoningEfforts,
  });
  return result.success ? result.data : null;
}

function normalizeThread(
  raw: z.infer<typeof RawThreadSchema>,
  archived: boolean,
  options: CodexDiscoveryOptions,
): ProviderNativeSession | null {
  try {
    const projectPath = canonicalProjectRoot(raw.cwd, options.allowedRoots);
    const title =
      sanitizeProviderText(raw.name ?? null, 160) ??
      sanitizeProviderText(raw.preview, 160) ??
      "Codex Session";
    const preview = sanitizeProviderText(raw.preview, 500);
    const branch = sanitizeProviderText(raw.gitInfo?.branch ?? null, 512);
    const createdAt = unixSeconds(raw.createdAt);
    const updatedAt = unixSeconds(raw.recencyAt ?? raw.updatedAt);
    return ProviderNativeSessionSchema.parse({
      providerId: options.providerId,
      accountId: options.accountId,
      providerSessionId: raw.id,
      title,
      preview,
      projectPath,
      projectName: sanitizeProviderText(basename(projectPath), 160) ?? "Project",
      branch,
      providerStatus:
        raw.status.type === "notLoaded"
          ? "not_loaded"
          : raw.status.type === "systemError"
            ? "error"
            : raw.status.type,
      createdAt,
      updatedAt,
      pinned: raw.isPinned ?? false,
      archived,
      canResume: raw.status.type !== "systemError",
    });
  } catch {
    return null;
  }
}

function unixSeconds(value: number) {
  const timestamp = new Date(value * 1_000);
  if (Number.isNaN(timestamp.getTime())) throw new Error("Invalid timestamp");
  return timestamp.toISOString();
}
