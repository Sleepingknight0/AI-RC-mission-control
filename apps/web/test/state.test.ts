import { makeEnvelope, type SessionSnapshot } from "@aicl/protocol";
import { describe, expect, it } from "vitest";

import {
  buildTimeline,
  turnAvailability,
  updateSnapshot,
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
});
