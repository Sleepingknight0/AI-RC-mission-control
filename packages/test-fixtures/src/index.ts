import type { Approval, FileChange, ToolActivity } from "@aicl/protocol";

export const WALKING_SKELETON_FIXTURE = {
  sessionId: "session-demo",
  prompt: "Verify the normalized event path.",
  response: "Mock response: Verify the normalized event path.",
} as const;

const approvalBase = {
  sessionId: "session-demo",
  runtimeId: "runtime-demo",
  runtimeGeneration: 2,
  turnId: "turn-demo",
  actionType: "command" as const,
  expiresAt: "2026-08-02T01:02:00.000Z",
  payload: {
    summary: "pnpm test",
    command: "pnpm test",
    cwd: "C:\\Projects\\aicl",
    reason: "Run the repository checks",
    activityId: "activity-demo",
    fileChangeId: null,
  },
};

const APPROVAL_STATES = [
  "pending",
  "approved_once",
  "declined",
  "expired",
  "invalidated",
] as const;

export const APPROVAL_STATE_FIXTURES = APPROVAL_STATES.map(
  (state, index) =>
    ({
      ...approvalBase,
      approvalId: `approval-fixture-${index}`,
      state,
      revision: state === "pending" ? 0 : 1,
      resolvedAt: state === "pending" ? null : "2026-08-02T01:01:00.000Z",
      resolvedByDeviceId: state === "pending" ? null : "device-demo",
    }) satisfies Approval,
);

export const COMMAND_ACTIVITY_FIXTURE = {
  activityId: "activity-demo",
  turnId: "turn-demo",
  kind: "command",
  title: "pnpm test",
  cwd: "C:\\Projects\\aicl",
  status: "completed",
  revision: 1,
  exitCode: 0,
  durationMs: 1240,
  outputPreview: "Tests passed",
} satisfies ToolActivity;

export const FILE_CHANGE_FIXTURE = {
  fileChangeId: "file-change-demo",
  turnId: "turn-demo",
  status: "completed",
  revision: 1,
  files: [{ path: "apps/core/src/server.ts", kind: "update" }],
  additions: 12,
  deletions: 3,
  diff: {
    kind: "inline",
    content: "@@ -1 +1 @@\n-old\n+new\n",
    byteLength: 22,
    sha256: "0".repeat(64),
  },
} satisfies FileChange;
