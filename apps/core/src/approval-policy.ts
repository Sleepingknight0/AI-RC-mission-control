import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { ApprovalLease, SessionSettings } from "@aicl/protocol";

import type { ApprovalPolicyContext } from "./store.js";

export interface ApprovalPolicyDecision {
  decision: "pending" | "approved_once";
  classifier: string;
  lease?: ApprovalLease;
}

const LEASE_PROJECT_COMMANDS = new Set([
  "pnpm build",
  "pnpm check",
  "pnpm lint",
  "pnpm test",
  "pnpm typecheck",
]);

export function classifyApprovalPolicy(
  context: ApprovalPolicyContext,
  lease: ApprovalLease | undefined,
  now = new Date(),
): ApprovalPolicyDecision {
  const policy = context.settings.approvalPolicy;
  if (policy === "review") return pending("review_requires_operator");

  if (policy === "full_auto_lease") {
    if (!validLease(context, lease, now)) return pending("lease_missing_or_invalid");
    if (isSafeWorkspaceChange(context, true)) {
      return approved("lease_workspace_change", lease);
    }
    if (isLeaseProjectCommand(context)) {
      return approved("lease_project_command", lease);
    }
    return pending("lease_scope_requires_operator");
  }

  if (policy === "balanced") return pending("balanced_requires_operator");
  if (isSafeWorkspaceChange(context, false)) {
    return approved("workspace_bounded_write");
  }
  return pending("workspace_requires_operator");
}

function isLeaseProjectCommand(context: ApprovalPolicyContext) {
  if (context.approval.actionType !== "command") return false;
  const command = normalizeCommand(context.approval.payload.command);
  return command !== null && LEASE_PROJECT_COMMANDS.has(command);
}

function isSafeWorkspaceChange(
  context: ApprovalPolicyContext,
  allowDelete: boolean,
) {
  if (
    context.approval.actionType !== "file_change" ||
    context.approval.payload.fileChangeId === null ||
    context.files.length === 0 ||
    context.files.length > 20 ||
    context.settings.projectPath === null
  ) {
    return false;
  }
  return context.files.every(
    (file) =>
      (allowDelete || file.kind !== "delete") &&
      isContainedProjectPath(context.settings.projectPath as string, file.path),
  );
}

export function isContainedProjectPath(projectPath: string, candidatePath: string) {
  if (candidatePath.trim().length === 0 || candidatePath.includes("\0")) return false;
  try {
    const project = realpathSync.native(projectPath);
    const candidate = isAbsolute(candidatePath)
      ? resolve(candidatePath)
      : resolve(project, candidatePath);
    if (!contains(project, candidate)) return false;

    const existingAncestor = nearestExistingAncestor(candidate);
    if (existingAncestor === null) return false;
    const canonicalAncestor = realpathSync.native(existingAncestor);
    if (!contains(project, canonicalAncestor)) return false;

    if (existsSync(candidate)) {
      return contains(project, realpathSync.native(candidate));
    }
    return true;
  } catch {
    return false;
  }
}

function nearestExistingAncestor(path: string): string | null {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

function contains(root: string, candidate: string) {
  const result = relative(root, candidate);
  return result === "" || (!result.startsWith("..") && !isAbsolute(result));
}

function normalizeCommand(command: string | null) {
  if (command === null || /[;&|><`\r\n]/u.test(command)) return null;
  return command.trim().replace(/\s+/gu, " ").toLowerCase();
}

function validLease(
  context: ApprovalPolicyContext,
  lease: ApprovalLease | undefined,
  now: Date,
): lease is ApprovalLease {
  const settings: SessionSettings = context.settings;
  return (
    lease !== undefined &&
    lease.state === "active" &&
    lease.sessionId === context.approval.sessionId &&
    lease.providerId === settings.providerId &&
    lease.accountId === settings.accountId &&
    lease.projectPath === settings.projectPath &&
    lease.deviceId === context.submittingDeviceId &&
    lease.runtimeId === context.approval.runtimeId &&
    lease.runtimeGeneration === context.approval.runtimeGeneration &&
    lease.settingsRevision === context.settingsRevision &&
    Date.parse(lease.expiresAt) > now.getTime()
  );
}

function pending(classifier: string): ApprovalPolicyDecision {
  return { decision: "pending", classifier };
}

function approved(
  classifier: string,
  lease?: ApprovalLease,
): ApprovalPolicyDecision {
  return {
    decision: "approved_once",
    classifier,
    ...(lease === undefined ? {} : { lease }),
  };
}
