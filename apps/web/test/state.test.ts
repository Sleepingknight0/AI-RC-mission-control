import { makeEnvelope, type SessionSnapshot } from "@aicl/protocol";
import { describe, expect, it } from "vitest";

import {
  TIMELINE_VIRTUAL_ROW_HEIGHT,
  buildTimeline,
  approvalForRejectedCommand,
  trackApprovalCommand,
  turnAvailability,
  updateSnapshot,
  virtualTimelineWindow,
} from "../src/state.js";

const snapshot: SessionSnapshot = {
  sessionId: "session-ui-test",
  revision: 0,
  lastEventSeq: 1,
  activeTurnId: "turn-1",
  providerSessionId: null,
  turns: [
    {
      turnId: "turn-1",
      commandId: "command-1",
      status: "running",
      prompt: "Inspect the repository",
      startedAt: "2026-08-02T01:00:00.000Z",
      completedAt: null,
      failureCode: null,
      providerTurnId: null,
    },
  ],
  messages: [],
  activities: [],
  fileChanges: [],
  approvals: [],
};

describe("mission-control render state", () => {
  it("coalesces deltas under a stable message identity", () => {
    const first = updateSnapshot(
      snapshot,
      makeEnvelope("assistant.message.delta", {
        sessionId: snapshot.sessionId,
        turnId: "turn-1",
        messageId: "message-1",
        streamSeq: 1,
        text: "hello ",
      }),
    );
    const second = updateSnapshot(
      first,
      makeEnvelope("assistant.message.delta", {
        sessionId: snapshot.sessionId,
        turnId: "turn-1",
        messageId: "message-1",
        streamSeq: 2,
        text: "world",
      }),
    );

    expect(second?.messages).toEqual([
      {
        messageId: "message-1",
        turnId: "turn-1",
        content: "hello world",
        completed: false,
      },
    ]);
    expect(buildTimeline(second).map((item) => item.id)).toEqual([
      "turn:turn-1:operator",
      "message:message-1",
    ]);
  });

  it("ignores replayed durable events that are already projected", () => {
    const replayed = updateSnapshot(
      snapshot,
      makeEnvelope("turn.completed", {
        sessionId: snapshot.sessionId,
        turnId: "turn-1",
        eventId: "event-1",
        seq: 1,
      }),
    );

    expect(replayed).toBe(snapshot);
  });

  it("blocks submission until sync completes and after runtime loss", () => {
    expect(turnAvailability("syncing", null, snapshot).canSubmit).toBe(false);
    expect(
      turnAvailability(
        "online",
        { runtimeId: "runtime-1", generation: 1, status: "lost" },
        { ...snapshot, activeTurnId: null },
      ),
    ).toEqual({
      canSubmit: false,
      reason: "Runtime ownership was lost. Review recovery state.",
    });
  });

  it("windows a 100,000-item timeline to a bounded render set", () => {
    const window = virtualTimelineWindow(
      100_000,
      9_200_000,
      844,
    );

    expect(window.totalHeight).toBe(100_000 * TIMELINE_VIRTUAL_ROW_HEIGHT);
    expect(window.start).toBeGreaterThan(0);
    expect(window.end).toBeLessThan(100_000);
    expect(window.end - window.start).toBeLessThanOrEqual(18);
    expect(window.offsetTop).toBe(window.start * TIMELINE_VIRTUAL_ROW_HEIGHT);
  });

  it("orders reconstructed cross-type items by durable display sequence", () => {
    const ordered = buildTimeline({
      ...snapshot,
      turns: [{ ...snapshot.turns[0]!, eventSeq: 1 }],
      messages: [
        {
          messageId: "message-later",
          turnId: "turn-1",
          content: "later",
          completed: true,
          eventSeq: 4,
        },
      ],
      activities: [
        {
          activityId: "activity-earlier",
          turnId: "turn-1",
          kind: "command",
          title: "earlier",
          cwd: null,
          status: "completed",
          revision: 1,
          exitCode: 0,
          durationMs: 1,
          outputPreview: "",
          eventSeq: 2,
        },
      ],
      fileChanges: [
        {
          fileChangeId: "change-middle",
          turnId: "turn-1",
          status: "completed",
          revision: 1,
          files: [],
          additions: 0,
          deletions: 0,
          diff: null,
          eventSeq: 3,
        },
      ],
    });

    expect(ordered.map((item) => item.id)).toEqual([
      "turn:turn-1:operator",
      "activity:activity-earlier",
      "file-change:change-middle",
      "message:message-later",
    ]);
  });

  it("releases an approval by the rejected command identity", () => {
    const commands = new Map<string, { approvalId: string; commandId: string }>();
    trackApprovalCommand(
      commands,
      "approval-1:approved_once",
      "approval-1",
      "command-1",
    );

    expect(approvalForRejectedCommand(commands, "command-1")).toBe("approval-1");
  });

  it("keeps 100,000-item timeline construction linear and stable", () => {
    const turns = Array.from({ length: 50_000 }, (_, index) => ({
      turnId: `turn-${index}`,
      commandId: `command-${index}`,
      status: "completed" as const,
      prompt: `Prompt ${index}`,
      startedAt: "2026-08-02T01:00:00.000Z",
      completedAt: "2026-08-02T01:00:01.000Z",
      failureCode: null,
      providerTurnId: null,
    }));
    const messages = turns.map((turn, index) => ({
      messageId: `message-${index}`,
      turnId: turn.turnId,
      content: `Response ${index}`,
      completed: true,
    }));

    const items = buildTimeline({
      ...snapshot,
      activeTurnId: null,
      turns,
      messages,
    });

    expect(items).toHaveLength(100_000);
    expect(items.slice(0, 4).map((item) => item.id)).toEqual([
      "turn:turn-0:operator",
      "message:message-0",
      "turn:turn-1:operator",
      "message:message-1",
    ]);
    expect(items.at(-1)?.id).toBe("message:message-49999");
  });
});
