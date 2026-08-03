import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ApprovalLease, SessionSettings } from "@aicl/protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  classifyApprovalPolicy,
  isContainedProjectPath,
} from "../src/approval-policy.js";
import type { ApprovalPolicyContext } from "../src/store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("approval policy classifier", () => {
  it("keeps review manual and fails Balanced closed without a verified non-process read", () => {
    expect(classifyApprovalPolicy(commandContext("review", "git status"), undefined))
      .toMatchObject({ decision: "pending", classifier: "review_requires_operator" });
    expect(classifyApprovalPolicy(commandContext("balanced", "git status"), undefined))
      .toMatchObject({ decision: "pending", classifier: "balanced_requires_operator" });
    expect(
      classifyApprovalPolicy(
        commandContext("balanced", "git status; Remove-Item secrets"),
        undefined,
      ),
    ).toMatchObject({ decision: "pending" });
    expect(classifyApprovalPolicy(commandContext("balanced", "pnpm test"), undefined))
      .toMatchObject({ decision: "pending" });
  });

  it("contains Workspace Auto writes and leaves deletes for an operator", () => {
    const project = temporaryProject();
    expect(
      classifyApprovalPolicy(fileContext("workspace_auto", project, [
        { path: "src/new.ts", kind: "add" },
        { path: "src/current.ts", kind: "update" },
      ]), undefined),
    ).toMatchObject({ decision: "approved_once", classifier: "workspace_bounded_write" });
    expect(
      classifyApprovalPolicy(fileContext("workspace_auto", project, [
        { path: "src/old.ts", kind: "delete" },
      ]), undefined),
    ).toMatchObject({ decision: "pending" });
    expect(
      classifyApprovalPolicy(fileContext("workspace_auto", project, [
        { path: join(project, "..", "escaped.ts"), kind: "add" },
      ]), undefined),
    ).toMatchObject({ decision: "pending" });
  });

  it("rejects a junction escape while allowing a missing descendant", () => {
    const project = temporaryProject();
    const outside = mkdtempSync(join(tmpdir(), "aicl-policy-outside-"));
    temporaryDirectories.push(outside);
    const junction = join(project, "linked-outside");
    symlinkSync(outside, junction, "junction");

    expect(isContainedProjectPath(project, "src/future/deep.ts")).toBe(true);
    expect(isContainedProjectPath(project, "linked-outside/escaped.ts")).toBe(false);
  });

  it("requires an exact current scoped lease for Full Auto", () => {
    const project = temporaryProject();
    const context = commandContext("full_auto_lease", "pnpm check", project);
    const lease = leaseFor(context);
    expect(classifyApprovalPolicy(context, undefined)).toMatchObject({
      decision: "pending",
      classifier: "lease_missing_or_invalid",
    });
    expect(classifyApprovalPolicy(context, lease)).toMatchObject({
      decision: "approved_once",
      classifier: "lease_project_command",
      lease,
    });
    expect(
      classifyApprovalPolicy(context, { ...lease, runtimeGeneration: 2 }),
    ).toMatchObject({ decision: "pending" });
    expect(
      classifyApprovalPolicy(context, { ...lease, expiresAt: "2020-01-01T00:00:00.000Z" }),
    ).toMatchObject({ decision: "pending" });
  });
});

function temporaryProject() {
  const project = mkdtempSync(join(tmpdir(), "aicl-policy-project-"));
  temporaryDirectories.push(project);
  mkdirSync(join(project, "src"));
  return project;
}

function settings(
  approvalPolicy: SessionSettings["approvalPolicy"],
  projectPath: string,
): SessionSettings {
  return {
    providerId: "codex",
    accountId: "profile-main",
    model: null,
    reasoningLevel: null,
    executionMode: "ask",
    approvalPolicy,
    sandboxPolicy: "workspace_write",
    networkPolicy: "denied",
    projectPath,
    branch: null,
  };
}

function commandContext(
  approvalPolicy: SessionSettings["approvalPolicy"],
  command: string,
  projectPath = "C:\\Projects\\example",
): ApprovalPolicyContext {
  return context(settings(approvalPolicy, projectPath), "command", command, []);
}

function fileContext(
  approvalPolicy: SessionSettings["approvalPolicy"],
  projectPath: string,
  files: ApprovalPolicyContext["files"],
): ApprovalPolicyContext {
  return context(settings(approvalPolicy, projectPath), "file_change", null, files);
}

function context(
  effectiveSettings: SessionSettings,
  actionType: "command" | "file_change",
  command: string | null,
  files: ApprovalPolicyContext["files"],
): ApprovalPolicyContext {
  return {
    approval: {
      approvalId: "approval-1",
      sessionId: "session-1",
      runtimeId: "runtime-1",
      runtimeGeneration: 1,
      turnId: "turn-1",
      actionType,
      state: "pending",
      revision: 0,
      expiresAt: "2099-01-01T00:00:00.000Z",
      payload: {
        summary: "Approval requested",
        command,
        cwd: effectiveSettings.projectPath,
        reason: null,
        activityId: actionType === "command" ? "activity-1" : null,
        fileChangeId: actionType === "file_change" ? "change-1" : null,
      },
      resolvedAt: null,
      resolvedByDeviceId: null,
    },
    providerCorrelationId: "provider-approval-1",
    submittingDeviceId: "device-1",
    settingsRevision: 3,
    settings: effectiveSettings,
    files,
  };
}

function leaseFor(context: ApprovalPolicyContext): ApprovalLease {
  return {
    leaseId: "lease-1",
    sessionId: context.approval.sessionId,
    providerId: context.settings.providerId,
    accountId: context.settings.accountId ?? "profile-main",
    projectPath: context.settings.projectPath ?? "C:\\Projects\\example",
    deviceId: "device-1",
    runtimeId: context.approval.runtimeId,
    runtimeGeneration: context.approval.runtimeGeneration,
    settingsRevision: context.settingsRevision,
    state: "active",
    revision: 0,
    issuedAt: "2026-08-03T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    revokedAt: null,
    revokeReason: null,
  };
}
