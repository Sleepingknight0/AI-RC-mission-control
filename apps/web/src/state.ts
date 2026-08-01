import type {
  Approval,
  FileChange,
  Runtime,
  ServerEnvelope,
  SessionSnapshot,
  ToolActivity,
  Turn,
} from "@aicl/protocol";

export type ConnectionState =
  | "connecting"
  | "reconnecting"
  | "syncing"
  | "online"
  | "offline";

export type TimelineItem =
  | { id: string; kind: "operator"; turn: Turn }
  | {
      id: string;
      kind: "assistant";
      turn: Turn;
      content: string;
      completed: boolean;
    }
  | { id: string; kind: "activity"; activity: ToolActivity }
  | { id: string; kind: "file_change"; fileChange: FileChange };

export const TIMELINE_VIRTUALIZATION_THRESHOLD = 200;
export const TIMELINE_VIRTUAL_ROW_HEIGHT = 184;

export interface TimelineWindow {
  start: number;
  end: number;
  offsetTop: number;
  totalHeight: number;
}

export function virtualTimelineWindow(
  itemCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight = TIMELINE_VIRTUAL_ROW_HEIGHT,
  overscan = 6,
): TimelineWindow {
  if (itemCount <= 0) {
    return { start: 0, end: 0, offsetTop: 0, totalHeight: 0 };
  }
  const safeRowHeight = Math.max(1, rowHeight);
  const safeScrollTop = Math.max(0, scrollTop);
  const safeViewportHeight = Math.max(0, viewportHeight);
  const safeOverscan = Math.max(0, Math.floor(overscan));
  const start = Math.min(
    itemCount - 1,
    Math.max(0, Math.floor(safeScrollTop / safeRowHeight) - safeOverscan),
  );
  const end = Math.min(
    itemCount,
    Math.ceil((safeScrollTop + safeViewportHeight) / safeRowHeight) + safeOverscan,
  );
  return {
    start,
    end: Math.max(start + 1, end),
    offsetTop: start * safeRowHeight,
    totalHeight: itemCount * safeRowHeight,
  };
}

export function durableSeq(message: ServerEnvelope) {
  switch (message.type) {
    case "turn.started":
    case "assistant.message.completed":
    case "turn.completed":
    case "turn.interrupted":
    case "turn.failed":
    case "turn.outcome_unknown":
    case "activity.started":
    case "activity.completed":
    case "file.change.started":
    case "file.change.completed":
    case "approval.requested":
    case "approval.resolved":
    case "approval.expired":
    case "approval.invalidated":
    case "interrupt.result":
      return message.payload.seq;
    default:
      return null;
  }
}

function upsertById<T>(
  items: T[],
  incoming: T,
  idOf: (item: T) => string,
) {
  const id = idOf(incoming);
  return items.some((item) => idOf(item) === id)
    ? items.map((item) => (idOf(item) === id ? incoming : item))
    : [...items, incoming];
}

export function updateSnapshot(
  current: SessionSnapshot | null,
  message: ServerEnvelope,
): SessionSnapshot | null {
  if (message.type === "session.snapshot") return message.payload.snapshot;
  if (current === null) return null;
  const seq = durableSeq(message);
  if (seq !== null && seq <= current.lastEventSeq) return current;

  switch (message.type) {
    case "turn.started":
      return {
        ...current,
        activeTurnId: message.payload.turn.turnId,
        lastEventSeq: message.payload.seq,
        turns: upsertById(
          current.turns,
          message.payload.turn,
          (turn) => turn.turnId,
        ),
      };
    case "assistant.message.delta": {
      const existing = current.messages.find(
        (candidate) => candidate.messageId === message.payload.messageId,
      );
      return {
        ...current,
        messages: existing
          ? current.messages.map((candidate) =>
              candidate.messageId === message.payload.messageId
                ? { ...candidate, content: candidate.content + message.payload.text }
                : candidate,
            )
          : [
              ...current.messages,
              {
                messageId: message.payload.messageId,
                turnId: message.payload.turnId,
                content: message.payload.text,
                completed: false,
              },
            ],
      };
    }
    case "assistant.message.completed":
      return {
        ...current,
        lastEventSeq: message.payload.seq,
        messages: upsertById(
          current.messages,
          {
            messageId: message.payload.messageId,
            turnId: message.payload.turnId,
            content: message.payload.content,
            completed: true,
          },
          (item) => item.messageId,
        ),
      };
    case "activity.started":
    case "activity.completed":
      return {
        ...current,
        lastEventSeq: message.payload.seq,
        activities: upsertById(
          current.activities,
          message.payload.activity,
          (item) => item.activityId,
        ),
      };
    case "command.output.batch":
      return {
        ...current,
        activities: current.activities.map((activity) =>
          activity.activityId === message.payload.activityId
            ? {
                ...activity,
                outputPreview: `${activity.outputPreview}${message.payload.output}`.slice(
                  -32 * 1024,
                ),
              }
            : activity,
        ),
      };
    case "file.change.started":
    case "file.change.completed":
      return {
        ...current,
        lastEventSeq: message.payload.seq,
        fileChanges: upsertById(
          current.fileChanges,
          message.payload.fileChange,
          (item) => item.fileChangeId,
        ),
      };
    case "approval.requested":
    case "approval.resolved":
    case "approval.expired":
    case "approval.invalidated":
      return {
        ...current,
        lastEventSeq: message.payload.seq,
        approvals: upsertById(
          current.approvals,
          message.payload.approval,
          (item: Approval) => item.approvalId,
        ),
      };
    case "interrupt.result":
      return { ...current, lastEventSeq: message.payload.seq };
    case "turn.completed":
    case "turn.interrupted":
    case "turn.outcome_unknown":
      return {
        ...current,
        activeTurnId: null,
        lastEventSeq: message.payload.seq,
        turns: current.turns.map((turn) =>
          turn.turnId === message.payload.turnId
            ? {
                ...turn,
                status:
                  message.type === "turn.completed"
                    ? "completed"
                    : message.type === "turn.interrupted"
                      ? "interrupted"
                      : "outcome_unknown",
                completedAt: message.sentAt,
              }
            : turn,
        ),
      };
    case "turn.failed":
      return {
        ...current,
        activeTurnId: null,
        lastEventSeq: message.payload.seq,
        turns: current.turns.map((turn) =>
          turn.turnId === message.payload.turnId
            ? {
                ...turn,
                status: "failed",
                failureCode: message.payload.failureCode,
                completedAt: message.sentAt,
              }
            : turn,
        ),
      };
    default:
      return current;
  }
}

export function buildTimeline(snapshot: SessionSnapshot | null): TimelineItem[] {
  if (snapshot === null) return [];
  const messagesByTurn = new Map<string, SessionSnapshot["messages"]>();
  const activitiesByTurn = new Map<string, SessionSnapshot["activities"]>();
  const fileChangesByTurn = new Map<string, SessionSnapshot["fileChanges"]>();
  for (const message of snapshot.messages) {
    const messages = messagesByTurn.get(message.turnId) ?? [];
    messages.push(message);
    messagesByTurn.set(message.turnId, messages);
  }
  for (const activity of snapshot.activities) {
    const activities = activitiesByTurn.get(activity.turnId) ?? [];
    activities.push(activity);
    activitiesByTurn.set(activity.turnId, activities);
  }
  for (const fileChange of snapshot.fileChanges) {
    const fileChanges = fileChangesByTurn.get(fileChange.turnId) ?? [];
    fileChanges.push(fileChange);
    fileChangesByTurn.set(fileChange.turnId, fileChanges);
  }
  const items: TimelineItem[] = [];
  for (const turn of snapshot.turns) {
    items.push({ id: `turn:${turn.turnId}:operator`, kind: "operator", turn });
    for (const message of messagesByTurn.get(turn.turnId) ?? []) {
      items.push({
        id: `message:${message.messageId}`,
        kind: "assistant",
        turn,
        content: message.content,
        completed: message.completed,
      });
    }
    for (const activity of activitiesByTurn.get(turn.turnId) ?? []) {
      items.push({ id: `activity:${activity.activityId}`, kind: "activity", activity });
    }
    for (const fileChange of fileChangesByTurn.get(turn.turnId) ?? []) {
      items.push({
        id: `file-change:${fileChange.fileChangeId}`,
        kind: "file_change",
        fileChange,
      });
    }
  }
  return items;
}

export function turnAvailability(
  connection: ConnectionState,
  runtime: Runtime | null,
  snapshot: SessionSnapshot | null,
) {
  if (connection !== "online") {
    return { canSubmit: false, reason: "Wait for Core synchronization." };
  }
  if (runtime === null || runtime.status === "offline") {
    return { canSubmit: false, reason: "Connector runtime is unavailable." };
  }
  if (runtime.status === "lost") {
    return { canSubmit: false, reason: "Runtime ownership was lost. Review recovery state." };
  }
  if (runtime.status === "incompatible") {
    return { canSubmit: false, reason: "Installed provider schema is incompatible." };
  }
  if (snapshot?.activeTurnId != null) {
    return { canSubmit: false, reason: "This Session already has a running Turn." };
  }
  return { canSubmit: true, reason: "Ready for a new Turn." };
}

export function latestTurn(snapshot: SessionSnapshot | null) {
  return snapshot?.turns.at(-1) ?? null;
}
