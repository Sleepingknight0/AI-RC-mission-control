import { spawnSync } from "node:child_process";

import { z } from "zod";

const MAX_CLAUDE_CLI_OUTPUT_BYTES = 600 * 1024;

const ClaudeAuthStatusSchema = z.object({
  loggedIn: z.boolean(),
});

const ClaudeAgentSchema = z.object({
  pid: z.number().int().nonnegative(),
  cwd: z.string().min(1).max(4_096),
  kind: z.string().min(1).max(64),
  startedAt: z.number().int().nonnegative(),
  sessionId: z.string().uuid(),
  name: z.string().max(160),
  status: z.string().min(1).max(64),
});

export type ClaudeAgent = z.infer<typeof ClaudeAgentSchema>;

export interface ClaudeCliInvocation {
  args: readonly string[];
  cwd: string;
  profilePath: string;
  timeoutMs: number;
  command?: string;
}

export interface ClaudeCliResult {
  ok: boolean;
  stdout: string;
}

export type ClaudeCliRunner = (
  invocation: ClaudeCliInvocation,
) => ClaudeCliResult;

export function runClaudeCli(
  invocation: ClaudeCliInvocation,
): ClaudeCliResult {
  const result = spawnSync(
    invocation.command ?? "claude",
    [...invocation.args],
    {
      cwd: invocation.cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: invocation.profilePath,
        NO_COLOR: "1",
      },
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      timeout: invocation.timeoutMs,
      maxBuffer: MAX_CLAUDE_CLI_OUTPUT_BYTES,
    },
  );
  return {
    ok: result.error === undefined && result.status === 0,
    stdout:
      typeof result.stdout === "string"
        ? result.stdout.slice(0, MAX_CLAUDE_CLI_OUTPUT_BYTES)
        : "",
  };
}

export function readClaudeAuthentication(input: {
  runner?: ClaudeCliRunner;
  cwd: string;
  profilePath: string;
  timeoutMs?: number;
  command?: string;
}): { available: boolean; authenticated: boolean } {
  const result = (input.runner ?? runClaudeCli)({
    args: ["auth", "status", "--json"],
    cwd: input.cwd,
    profilePath: input.profilePath,
    timeoutMs: input.timeoutMs ?? 3_000,
    ...(input.command === undefined ? {} : { command: input.command }),
  });
  if (!result.ok) return { available: false, authenticated: false };
  try {
    const parsed = ClaudeAuthStatusSchema.parse(JSON.parse(result.stdout));
    return { available: true, authenticated: parsed.loggedIn };
  } catch {
    return { available: false, authenticated: false };
  }
}

export function readClaudeAgents(input: {
  runner?: ClaudeCliRunner;
  cwd: string;
  profilePath: string;
  timeoutMs?: number;
  command?: string;
}): { available: boolean; agents: ClaudeAgent[] } {
  const result = (input.runner ?? runClaudeCli)({
    args: ["agents", "--json", "--all"],
    cwd: input.cwd,
    profilePath: input.profilePath,
    timeoutMs: input.timeoutMs ?? 3_000,
    ...(input.command === undefined ? {} : { command: input.command }),
  });
  if (!result.ok) return { available: false, agents: [] };
  try {
    const raw = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(raw)) return { available: false, agents: [] };
    const agents: ClaudeAgent[] = [];
    for (const candidate of raw.slice(0, 1_000)) {
      const parsed = ClaudeAgentSchema.safeParse(candidate);
      if (parsed.success) agents.push(parsed.data);
    }
    return { available: true, agents };
  } catch {
    return { available: false, agents: [] };
  }
}

export function readClaudeVersion(input: {
  runner?: ClaudeCliRunner;
  cwd: string;
  profilePath: string;
  timeoutMs?: number;
  command?: string;
}): string | null {
  const result = (input.runner ?? runClaudeCli)({
    args: ["--version"],
    cwd: input.cwd,
    profilePath: input.profilePath,
    timeoutMs: input.timeoutMs ?? 3_000,
    ...(input.command === undefined ? {} : { command: input.command }),
  });
  if (!result.ok) return null;
  const match = /^(\d+\.\d+\.\d+)(?:\s|$)/u.exec(result.stdout.trim());
  return match?.[1] ?? null;
}
