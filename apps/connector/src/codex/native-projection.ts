import { basename, isAbsolute, relative, resolve } from "node:path";

import { canonicalProjectRoot } from "@aicl/config";
import {
  MAX_PROVIDER_SESSION_PROJECTION_ITEMS,
  MAX_PROVIDER_SESSION_PROJECTION_TEXT_BYTES,
  ProviderSessionProjectionSnapshotSchema,
  redactSensitiveOutput,
  utf8ByteLength,
  type ProviderSessionProjectionItem,
  type ProviderSessionProjectionSnapshot,
  type ProviderSessionProjectionState,
} from "@aicl/protocol";
import { z } from "zod";

import type { CodexDiscoveryRpc } from "./discovery.js";

const MAX_RAW_TURNS = 500;
const MAX_RAW_ITEMS = 5_000;
const MAX_PROJECTION_ITEM_BYTES = 600 * 1024;
const OBSERVED_DELTA_LIVE_WINDOW_MS = 15_000;
const ANSI_ESCAPE_PATTERN = new RegExp(
  String.raw`\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))`,
  "gu",
);
const UNSAFE_CONTROL_PATTERN = new RegExp(
  String.raw`[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]`,
  "gu",
);

const RawThreadReadResponseSchema = z
  .object({
    thread: z
      .object({
        id: z.string().min(1).max(200),
        name: z.string().max(20_000).nullable().optional(),
        preview: z.string().max(100_000),
        cwd: z.string().min(1).max(4_096),
        updatedAt: z.number().int().nonnegative(),
        status: z
          .discriminatedUnion("type", [
            z.object({ type: z.literal("notLoaded") }).passthrough(),
            z.object({ type: z.literal("idle") }).passthrough(),
            z.object({ type: z.literal("systemError") }).passthrough(),
            z
              .object({
                type: z.literal("active"),
                activeFlags: z
                  .array(z.enum(["waitingOnApproval", "waitingOnUserInput"]))
                  .max(8),
              })
              .passthrough(),
          ]),
        turns: z
          .array(
            z
              .object({
                id: z.string().min(1).max(200),
                items: z.array(z.unknown()).max(MAX_RAW_ITEMS),
                itemsView: z.enum(["notLoaded", "summary", "full"]),
                status: z.enum([
                  "completed",
                  "interrupted",
                  "failed",
                  "inProgress",
                ]),
                error: z.unknown().nullable(),
                startedAt: z.number().int().nonnegative().nullable(),
                completedAt: z.number().int().nonnegative().nullable(),
                durationMs: z.number().int().nonnegative().nullable(),
              })
              .passthrough(),
          )
          .max(MAX_RAW_TURNS),
      })
      .passthrough(),
  })
  .passthrough();

const UserMessageSchema = z
  .object({
    type: z.literal("userMessage"),
    id: z.string().min(1).max(200),
    content: z
      .array(
        z
          .object({
            type: z.enum([
              "text",
              "image",
              "localImage",
              "audio",
              "localAudio",
              "skill",
              "mention",
            ]),
            text: z.string().optional(),
            name: z.string().optional(),
          })
          .passthrough(),
      )
      .max(256),
  })
  .passthrough();
const AgentMessageSchema = z
  .object({
    type: z.literal("agentMessage"),
    id: z.string().min(1).max(200),
    text: z.string(),
    phase: z.enum(["commentary", "final_answer"]).nullable(),
  })
  .passthrough();
const ReasoningSchema = z
  .object({
    type: z.literal("reasoning"),
    id: z.string().min(1).max(200),
    summary: z.array(z.string()).max(64),
  })
  .passthrough();
const PlanSchema = z
  .object({
    type: z.literal("plan"),
    id: z.string().min(1).max(200),
    text: z.string(),
  })
  .passthrough();
const CommandSchema = z
  .object({
    type: z.literal("commandExecution"),
    id: z.string().min(1).max(200),
    command: z.string(),
    cwd: z.string(),
    status: z.enum(["inProgress", "completed", "failed", "declined"]),
    commandActions: z
      .array(
        z
          .object({
            type: z.enum(["read", "listFiles", "search", "unknown"]),
          })
          .passthrough(),
      )
      .max(128),
    aggregatedOutput: z.string().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
  })
  .passthrough();
const FileChangeSchema = z
  .object({
    type: z.literal("fileChange"),
    id: z.string().min(1).max(200),
    status: z.enum(["inProgress", "completed", "failed", "declined"]),
    changes: z
      .array(
        z
          .object({
            path: z.string().min(1).max(4_096),
            kind: z
              .object({ type: z.enum(["add", "update", "delete"]) })
              .passthrough(),
          })
          .passthrough(),
      )
      .max(1_000),
  })
  .passthrough();
const ToolSchema = z
  .object({
    type: z.enum(["mcpToolCall", "dynamicToolCall"]),
    id: z.string().min(1).max(200),
    server: z.string().optional(),
    namespace: z.string().nullable().optional(),
    tool: z.string(),
    status: z.enum(["inProgress", "completed", "failed"]),
    durationMs: z.number().int().nonnegative().nullable(),
  })
  .passthrough();
const SimpleActivitySchema = z
  .object({
    type: z.enum([
      "collabAgentToolCall",
      "subAgentActivity",
      "webSearch",
      "imageView",
      "sleep",
      "imageGeneration",
    ]),
    id: z.string().min(1).max(200),
    status: z.string().optional(),
    tool: z.string().optional(),
    kind: z.string().optional(),
  })
  .passthrough();

type RawThread = z.infer<typeof RawThreadReadResponseSchema>["thread"];
type RawTurn = RawThread["turns"][number];
type WithoutOrder<T> = T extends unknown ? Omit<T, "order"> : never;
type ProjectionItemInput = WithoutOrder<ProviderSessionProjectionItem>;
type ProjectionActivityType = Extract<
  ProviderSessionProjectionItem,
  { type: "activity" }
>["activityType"];

export interface CodexNativeProjectionOptions {
  providerId: "codex";
  accountId: string;
  providerSessionId: string;
  runtimeId: string;
  runtimeGeneration: number;
  revision: number;
  allowedRoots: readonly string[];
  timeoutMs?: number;
  now?: () => Date;
}

export interface CodexNativeObservationContinuity {
  itemSignatures: ReadonlyMap<string, string>;
  inferredState: ProviderSessionProjectionState | null;
  activeSince: string | null;
  lastChangedAt: number | null;
}

export async function readCodexNativeSessionProjection(
  rpc: CodexDiscoveryRpc,
  options: CodexNativeProjectionOptions,
): Promise<ProviderSessionProjectionSnapshot> {
  const response = RawThreadReadResponseSchema.parse(
    await rpc.request(
      "thread/read",
      { threadId: options.providerSessionId, includeTurns: true },
      {
        timeoutMs: options.timeoutMs ?? 2_500,
        terminateOnTimeout: false,
      },
    ),
  );
  if (response.thread.id !== options.providerSessionId) {
    throw new Error("Codex returned a different Session identity");
  }

  const projectPath = canonicalProjectRoot(
    response.thread.cwd,
    options.allowedRoots,
  );
  const now = (options.now ?? (() => new Date()))();
  const observedAt = now.toISOString();
  const normalized = normalizeTurns(response.thread, projectPath);
  const state = projectionState(response.thread, normalized.latestActivityType);
  const activeTurn = [...response.thread.turns]
    .reverse()
    .find((turn) => turn.status === "inProgress");
  const activeSince = isActiveState(state)
    ? unixSecondsOrNull(activeTurn?.startedAt ?? null)
    : null;
  const title =
    sanitizeDisplay(response.thread.name, 160) ??
    sanitizeDisplay(response.thread.preview, 160) ??
    "Codex Session";
  const projectLabel = sanitizeDisplay(basename(projectPath), 160) ?? "Project";
  const bounded = boundItems(normalized.items);

  return ProviderSessionProjectionSnapshotSchema.parse({
    projectionId: `projection-${crypto.randomUUID()}`,
    revision: options.revision,
    providerId: options.providerId,
    accountId: options.accountId,
    providerSessionId: options.providerSessionId,
    providerRevision: String(response.thread.updatedAt),
    providerCursor: null,
    observedAt,
    staleAt: new Date(now.getTime() + 5_000).toISOString(),
    freshness: "live",
    availability: "available",
    runtimeId: options.runtimeId,
    runtimeGeneration: options.runtimeGeneration,
    title,
    projectLabel,
    state,
    activeSince,
    truncated:
      normalized.truncated || bounded.length < normalized.items.length,
    notice:
      normalized.truncated || bounded.length < normalized.items.length
        ? "Older provider history was omitted to stay within observation bounds"
        : null,
    items: bounded,
  });
}

/**
 * A second Codex app-server reports an externally owned thread as `notLoaded`,
 * but `thread/read` still returns its advancing normalized items. Treat only a
 * measured item delta as short-lived activity evidence. Never infer idle and
 * never synthesize an item or command.
 */
export function reconcileCodexNativeObservation(
  snapshot: ProviderSessionProjectionSnapshot,
  previous: CodexNativeObservationContinuity | null,
  now = Date.now(),
): {
  snapshot: ProviderSessionProjectionSnapshot;
  continuity: CodexNativeObservationContinuity;
} {
  const itemSignatures = new Map(
    snapshot.items.map((item) => [providerItemKey(item), providerItemSignature(item)]),
  );
  if (isActiveState(snapshot.state)) {
    return {
      snapshot,
      continuity: {
        itemSignatures,
        inferredState: snapshot.state,
        activeSince: snapshot.activeSince,
        lastChangedAt: now,
      },
    };
  }

  const latestChanged = previous === null
    ? null
    : [...snapshot.items]
        .reverse()
        .find(
          (item) =>
            previous.itemSignatures.get(providerItemKey(item)) !==
            providerItemSignature(item),
        ) ?? null;
  const inferredFromDelta = latestChanged === null
    ? null
    : inferredStateForChangedItem(latestChanged);
  const terminalDelta = latestChanged !== null && isTerminalChangedItem(latestChanged);
  const keepPrior =
    inferredFromDelta === null &&
    !terminalDelta &&
    previous?.inferredState !== null &&
    previous?.inferredState !== undefined &&
    previous.lastChangedAt !== null &&
    now - previous.lastChangedAt <= OBSERVED_DELTA_LIVE_WINDOW_MS;
  const inferredState = inferredFromDelta ?? (keepPrior ? previous.inferredState : null);
  const activeSince = inferredFromDelta !== null
    ? previous?.activeSince ?? null
    : keepPrior
      ? previous.activeSince
      : null;
  const lastChangedAt = inferredFromDelta !== null
    ? now
    : keepPrior
      ? previous.lastChangedAt
      : null;
  const reconciled = inferredState === null
    ? snapshot
    : ProviderSessionProjectionSnapshotSchema.parse({
        ...snapshot,
        state: inferredState,
        activeSince,
      });
  return {
    snapshot: reconciled,
    continuity: {
      itemSignatures,
      inferredState,
      activeSince,
      lastChangedAt,
    },
  };
}

function normalizeTurns(thread: RawThread, projectPath: string) {
  const items: ProviderSessionProjectionItem[] = [];
  const seen = new Set<string>();
  let order = 0;
  let latestActivityType: ProjectionActivityType | null = null;
  let truncated = false;

  const add = (item: ProjectionItemInput) => {
    const key = `${item.providerTurnId}\u0000${item.providerItemId}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ ...item, order } as ProviderSessionProjectionItem);
    order += 1;
  };

  for (const turn of thread.turns) {
    if (turn.itemsView !== "full") truncated = true;
    for (const rawItem of turn.items) {
      const user = UserMessageSchema.safeParse(rawItem);
      if (user.success) {
        const text = normalizeUserContent(user.data.content);
        if (text !== null) {
          add({
            type: "operator_message",
            providerTurnId: turn.id,
            providerItemId: user.data.id,
            text,
          });
        }
        continue;
      }

      const agent = AgentMessageSchema.safeParse(rawItem);
      if (agent.success) {
        const text = sanitizeProjectionText(agent.data.text);
        if (text === null) continue;
        if (agent.data.phase === "commentary") {
          add({
            type: "assistant_progress",
            providerTurnId: turn.id,
            providerItemId: agent.data.id,
            progressType: "commentary",
            status: turn.status === "inProgress" ? "streaming" : "completed",
            text,
          });
        } else {
          add({
            type: "assistant_message",
            providerTurnId: turn.id,
            providerItemId: agent.data.id,
            phase:
              agent.data.phase === "final_answer" ? "final_answer" : "unknown",
            status: turn.status === "inProgress" ? "streaming" : "completed",
            text,
          });
        }
        continue;
      }

      const reasoning = ReasoningSchema.safeParse(rawItem);
      if (reasoning.success) {
        for (const [index, summary] of reasoning.data.summary.entries()) {
          const text = sanitizeProjectionText(summary);
          if (text === null) continue;
          add({
            type: "assistant_progress",
            providerTurnId: turn.id,
            providerItemId: `${reasoning.data.id}:summary:${index}`,
            progressType: "reasoning",
            status: turn.status === "inProgress" ? "streaming" : "completed",
            text,
          });
        }
        continue;
      }

      const plan = PlanSchema.safeParse(rawItem);
      if (plan.success) {
        const text = sanitizeProjectionText(plan.data.text);
        if (text !== null) {
          add({
            type: "assistant_progress",
            providerTurnId: turn.id,
            providerItemId: plan.data.id,
            progressType: "plan",
            status: turn.status === "inProgress" ? "streaming" : "completed",
            text,
          });
        }
        continue;
      }

      const command = CommandSchema.safeParse(rawItem);
      if (command.success) {
        const activityType = classifyCommand(
          command.data.command,
          command.data.commandActions,
        );
        if (command.data.status === "inProgress") latestActivityType = activityType;
        add({
          type: "activity",
          providerTurnId: turn.id,
          providerItemId: command.data.id,
          activityType,
          status: normalizeActivityStatus(command.data.status),
          title:
            sanitizeDisplay(command.data.command, 1_000) ?? "Provider command",
          cwdLabel: sanitizeDisplay(basename(projectPath), 160),
          durationMs: command.data.durationMs,
          combinedOutputPreview: sanitizeProjectionText(
            command.data.aggregatedOutput,
          ),
          stdoutPreview: null,
          stderrPreview: null,
        });
        continue;
      }

      const fileChange = FileChangeSchema.safeParse(rawItem);
      if (fileChange.success) {
        if (fileChange.data.status === "inProgress") latestActivityType = "edit";
        add({
          type: "file_change",
          providerTurnId: turn.id,
          providerItemId: fileChange.data.id,
          status: normalizeActivityStatus(fileChange.data.status),
          files: fileChange.data.changes.slice(0, 100).map((change) => ({
            path: safeRelativeLabel(projectPath, change.path),
            kind: change.kind.type,
          })),
        });
        if (fileChange.data.changes.length > 100) truncated = true;
        continue;
      }

      const tool = ToolSchema.safeParse(rawItem);
      if (tool.success) {
        if (tool.data.status === "inProgress") latestActivityType = "tool";
        const namespace = tool.data.server ?? tool.data.namespace;
        const title = [namespace, tool.data.tool].filter(Boolean).join(" / ");
        add({
          type: "activity",
          providerTurnId: turn.id,
          providerItemId: tool.data.id,
          activityType: "tool",
          status: normalizeActivityStatus(tool.data.status),
          title: sanitizeDisplay(title, 1_000) ?? "Provider tool",
          cwdLabel: sanitizeDisplay(basename(projectPath), 160),
          durationMs: tool.data.durationMs,
          combinedOutputPreview: null,
          stdoutPreview: null,
          stderrPreview: null,
        });
        continue;
      }

      const simple = SimpleActivitySchema.safeParse(rawItem);
      if (simple.success) {
        const activityType =
          simple.data.type === "webSearch"
            ? "web_search"
            : simple.data.type === "collabAgentToolCall" ||
                simple.data.type === "subAgentActivity"
              ? "subagent"
              : simple.data.type === "sleep"
                ? "waiting"
                : "tool";
        const status =
          simple.data.status === "failed"
            ? "failed"
            : simple.data.status === "completed"
              ? "completed"
              : turn.status === "inProgress"
                ? "running"
                : "completed";
        if (status === "running") latestActivityType = activityType;
        add({
          type: "activity",
          providerTurnId: turn.id,
          providerItemId: simple.data.id,
          activityType,
          status,
          title:
            sanitizeDisplay(
              simple.data.tool ?? simple.data.kind ?? activityTitle(simple.data.type),
              1_000,
            ) ?? "Provider activity",
          cwdLabel: sanitizeDisplay(basename(projectPath), 160),
          durationMs: null,
          combinedOutputPreview: null,
          stdoutPreview: null,
          stderrPreview: null,
        });
      }
    }

    add({
      type: "turn_state",
      providerTurnId: turn.id,
      providerItemId: `${turn.id}:state`,
      state: turnProjectionState(turn, thread.status),
      startedAt: unixSecondsOrNull(turn.startedAt),
      completedAt: unixSecondsOrNull(turn.completedAt),
      failureCode: turn.status === "failed" ? providerFailureCode(turn.error) : null,
    });
  }

  return { items, latestActivityType, truncated };
}

function projectionState(
  thread: RawThread,
  latestActivityType: ProjectionActivityType | null,
): ProviderSessionProjectionState {
  const activeTurn = [...thread.turns]
    .reverse()
    .find((turn) => turn.status === "inProgress");
  if (activeTurn !== undefined) {
    if (
      thread.status.type === "active" &&
      thread.status.activeFlags.includes("waitingOnApproval")
    ) {
      return "waiting_for_approval";
    }
    if (
      thread.status.type === "active" &&
      thread.status.activeFlags.includes("waitingOnUserInput")
    ) {
      return "waiting_for_input";
    }
    if (latestActivityType === "test") return "running_tests";
    if (latestActivityType === "read_file") return "reading_file";
    if (latestActivityType === "search" || latestActivityType === "web_search") {
      return "searching";
    }
    if (latestActivityType === "edit") return "editing";
    if (latestActivityType === "command") return "running_command";
    const last = activeTurn.items.at(-1);
    if (
      ReasoningSchema.safeParse(last).success ||
      (AgentMessageSchema.safeParse(last).success &&
        AgentMessageSchema.parse(last).phase === "commentary")
    ) {
      return "thinking";
    }
    return "working";
  }
  if (thread.status.type === "active") return "working";
  if (thread.status.type === "idle") return "idle";
  if (thread.status.type === "systemError") return "failed";
  return "view_only";
}

function turnProjectionState(
  turn: RawTurn,
  threadStatus: RawThread["status"],
): Exclude<ProviderSessionProjectionState, "unavailable"> {
  if (turn.status === "completed") return "completed";
  if (turn.status === "failed") return "failed";
  if (turn.status === "interrupted") return "interrupted";
  if (
    threadStatus.type === "active" &&
    threadStatus.activeFlags.includes("waitingOnApproval")
  ) {
    return "waiting_for_approval";
  }
  if (
    threadStatus.type === "active" &&
    threadStatus.activeFlags.includes("waitingOnUserInput")
  ) {
    return "waiting_for_input";
  }
  return "working";
}

function classifyCommand(
  command: string,
  actions: Array<{ type: "read" | "listFiles" | "search" | "unknown" }>,
) {
  if (actions.some((action) => action.type === "read")) return "read_file" as const;
  if (actions.some((action) => action.type === "search")) return "search" as const;
  if (
    /(?:^|\s)(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:vitest|jest|pytest|cargo\s+test|go\s+test|dotnet\s+test|ctest)\b/iu.test(
      command,
    )
  ) {
    return "test" as const;
  }
  if (/\b(?:apply_patch|write-file|set-content)\b/iu.test(command)) {
    return "edit" as const;
  }
  return "command" as const;
}

function normalizeActivityStatus(
  status: "inProgress" | "completed" | "failed" | "declined",
) {
  return status === "inProgress" ? ("running" as const) : status;
}

function normalizeUserContent(content: z.infer<typeof UserMessageSchema>["content"]) {
  const parts = content.flatMap((item) => {
    if (item.type === "text") return item.text ?? "";
    if (item.type === "image" || item.type === "localImage") return "[Image input]";
    if (item.type === "audio" || item.type === "localAudio") return "[Audio input]";
    if (item.type === "skill") {
      return `[Skill: ${sanitizeDisplay(item.name, 96) ?? "attached"}]`;
    }
    if (item.type === "mention") {
      return `[Mention: ${sanitizeDisplay(item.name, 96) ?? "attached"}]`;
    }
    return [];
  });
  return sanitizeProjectionText(parts.join("\n"));
}

function sanitizeProjectionText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const sanitized = redactSensitiveOutput(
    String(value),
    MAX_PROVIDER_SESSION_PROJECTION_TEXT_BYTES,
  )
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(/\b[A-Za-z]:[\\/][^\s"'`<>|]*/gu, "[PATH]")
    .replace(/(^|\s)\/(?:[^\s"'`/]+\/)*[^\s"'`]*/gu, "$1[PATH]")
    .replace(
      /(?:^|[\\/])(?:auth\.json|credentials?(?:\.json)?|\.env(?:\.[A-Za-z0-9._-]+)?)(?=$|[\s"'`])/giu,
      "[SENSITIVE_FILE]",
    )
    .replace(UNSAFE_CONTROL_PATTERN, "")
    .trim();
  return sanitized.length === 0 ? null : sanitized;
}

function sanitizeDisplay(value: unknown, maxCharacters: number): string | null {
  const sanitized = sanitizeProjectionText(value);
  if (sanitized === null) return null;
  const display = sanitized.replace(/\s+/gu, " ").trim();
  return display.length === 0 ? null : display.slice(0, maxCharacters);
}

function safeRelativeLabel(projectPath: string, rawPath: string): string {
  const absolute = isAbsolute(rawPath) ? resolve(rawPath) : resolve(projectPath, rawPath);
  const candidate = relative(projectPath, absolute);
  const label =
    candidate !== "" &&
    !candidate.startsWith("..") &&
    !isAbsolute(candidate)
      ? candidate
      : basename(absolute);
  return sanitizeDisplay(label.replaceAll("\\", "/"), 512) ?? "changed-file";
}

function boundItems(items: ProviderSessionProjectionItem[]) {
  const bounded: ProviderSessionProjectionItem[] = [];
  let bytes = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    const itemBytes = utf8ByteLength(JSON.stringify(item));
    if (
      bounded.length >= MAX_PROVIDER_SESSION_PROJECTION_ITEMS ||
      bytes + itemBytes > MAX_PROJECTION_ITEM_BYTES
    ) {
      continue;
    }
    bounded.push(item);
    bytes += itemBytes;
  }
  return bounded.reverse();
}

function providerFailureCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const candidate = error as { code?: unknown; message?: unknown };
  return sanitizeDisplay(candidate.code ?? candidate.message, 96);
}

function unixSecondsOrNull(value: number | null): string | null {
  if (value === null) return null;
  const timestamp = new Date(value * 1_000);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function isActiveState(state: ProviderSessionProjectionState) {
  return [
    "thinking",
    "working",
    "running_command",
    "reading_file",
    "searching",
    "editing",
    "running_tests",
    "waiting_for_approval",
    "waiting_for_input",
  ].includes(state);
}

function activityTitle(type: z.infer<typeof SimpleActivitySchema>["type"]) {
  if (type === "webSearch") return "Web search";
  if (type === "imageView") return "View image";
  if (type === "sleep") return "Waiting";
  if (type === "imageGeneration") return "Generate image";
  return "Sub-agent activity";
}

function providerItemKey(item: ProviderSessionProjectionItem) {
  return `${item.providerTurnId}\u0000${item.providerItemId}`;
}

function providerItemSignature(item: ProviderSessionProjectionItem) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(item).filter(([key]) => key !== "order"),
    ),
  );
}

function inferredStateForChangedItem(
  item: ProviderSessionProjectionItem,
): ProviderSessionProjectionState | null {
  if (item.type === "assistant_progress") return "thinking";
  if (item.type === "operator_message") return "working";
  if (item.type === "file_change") return "editing";
  if (item.type === "activity") {
    if (item.activityType === "test") return "running_tests";
    if (item.activityType === "read_file") return "reading_file";
    if (item.activityType === "search" || item.activityType === "web_search") {
      return "searching";
    }
    if (item.activityType === "edit") return "editing";
    if (item.activityType === "command") return "running_command";
    if (item.activityType === "waiting") return "working";
    return "working";
  }
  return null;
}

function isTerminalChangedItem(item: ProviderSessionProjectionItem) {
  return (
    (item.type === "assistant_message" &&
      item.phase === "final_answer" &&
      item.status === "completed") ||
    (item.type === "turn_state" &&
      ["completed", "failed", "interrupted"].includes(item.state))
  );
}
