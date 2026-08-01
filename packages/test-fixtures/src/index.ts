import type {
  Approval,
  FileChange,
  Runtime,
  SessionSnapshot,
  SessionSummary,
  ToolActivity,
} from "@aicl/protocol";

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

const MISSION_TURN = {
  turnId: "turn-demo",
  commandId: "command-demo",
  status: "running" as const,
  prompt: "Inspect the durable event path and report any invariant violations.",
  startedAt: "2026-08-02T01:00:00.000Z",
  completedAt: null,
  failureCode: null,
  providerTurnId: "provider-turn-demo",
};

export const MISSION_CONTROL_RUNNING_SNAPSHOT = {
  sessionId: "session-demo",
  revision: 1,
  lastEventSeq: 8,
  activeTurnId: MISSION_TURN.turnId,
  providerSessionId: "provider-session-demo",
  turns: [MISSION_TURN],
  messages: [
    {
      messageId: "message-demo",
      turnId: MISSION_TURN.turnId,
      content: "Tracing the normalized path…",
      completed: false,
    },
  ],
  activities: [{ ...COMMAND_ACTIVITY_FIXTURE, status: "running", revision: 0 }],
  fileChanges: [FILE_CHANGE_FIXTURE],
  approvals: [APPROVAL_STATE_FIXTURES[0]!],
} satisfies SessionSnapshot;

export const MISSION_CONTROL_OUTCOME_UNKNOWN_SNAPSHOT = {
  ...MISSION_CONTROL_RUNNING_SNAPSHOT,
  lastEventSeq: 11,
  activeTurnId: null,
  turns: [
    {
      ...MISSION_TURN,
      status: "outcome_unknown",
      completedAt: "2026-08-02T01:03:00.000Z",
    },
  ],
  messages: [],
  approvals: [APPROVAL_STATE_FIXTURES[4]!],
} satisfies SessionSnapshot;

export const MISSION_CONTROL_SESSION_CATALOG = [
  {
    sessionId: "session-demo",
    state: "awaiting_approval",
    runtimeStatus: "busy",
    activeTurnId: MISSION_TURN.turnId,
    pendingApprovalCount: 1,
    lastTurnStatus: "running",
    lastActivityAt: "2026-08-02T01:02:00.000Z",
    cwd: "C:\\Projects\\aicl",
    turnCount: 1,
    lastEventSeq: 8,
  },
  {
    sessionId: "session-recovery-demo",
    state: "outcome_unknown",
    runtimeStatus: "lost",
    activeTurnId: null,
    pendingApprovalCount: 0,
    lastTurnStatus: "outcome_unknown",
    lastActivityAt: "2026-08-02T00:58:00.000Z",
    cwd: null,
    turnCount: 2,
    lastEventSeq: 11,
  },
] satisfies SessionSummary[];

export const MISSION_CONTROL_RUNTIME_FIXTURES = {
  ready: {
    runtimeId: "runtime-demo",
    generation: 2,
    status: "ready",
  } satisfies Runtime,
  lost: {
    runtimeId: "runtime-recovery-demo",
    generation: 4,
    status: "lost",
  } satisfies Runtime,
};
