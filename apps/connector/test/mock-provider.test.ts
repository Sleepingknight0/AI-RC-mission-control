import { describe, expect, it } from "vitest";

import { normalizeMockEvent } from "../src/mock-provider.js";

describe("mock provider adapter", () => {
  it("terminates raw provider fields at the adapter boundary", () => {
    const normalized = normalizeMockEvent(
      {
        providerMethod: "mock/message/delta",
        providerPayload: { text: "hello", index: 1 },
      },
      { sessionId: "session-1", turnId: "turn-1", messageId: "message-1" },
    );
    const json = JSON.stringify(normalized);

    expect(json).not.toContain("providerMethod");
    expect(json).not.toContain("providerPayload");
    expect(normalized.type).toBe("connector.turn.delta");
  });
});
