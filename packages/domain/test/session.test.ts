import { describe, expect, it } from "vitest";

import { beginTurn, createSession } from "../src/index.js";

describe("session turn guard", () => {
  it("rejects a second active turn without creating a queued turn", () => {
    const first = beginTurn(createSession("session-1"), {
      turnId: "turn-1",
      commandId: "command-1",
      prompt: "first",
      startedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = beginTurn(first.state, {
      turnId: "turn-2",
      commandId: "command-2",
      prompt: "second",
      startedAt: "2026-08-01T00:00:01.000Z",
    });

    expect(second).toEqual({ ok: false, code: "TURN_ALREADY_ACTIVE" });
    expect(first.state.turns).toHaveLength(1);
    expect(first.state.turns[0]?.providerTurnId).toBeNull();
  });
});
