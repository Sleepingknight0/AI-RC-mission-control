import type { ProviderSessionProjectionItem, Turn } from "@aicl/protocol";
import { describe, expect, it } from "vitest";

import type { TimelineItem } from "../src/state.js";
import { buildUnifiedTimeline } from "../src/mobile/unified-timeline.js";

const turn = (turnId: string, providerTurnId: string | null): Turn => ({
  turnId,
  commandId: `command-${turnId}`,
  status: "completed",
  prompt: "Inspect README.md",
  startedAt: "2026-08-10T00:00:00.000Z",
  completedAt: "2026-08-10T00:00:01.000Z",
  failureCode: null,
  providerTurnId,
});

const nativeMessage = (
  providerTurnId: string,
  providerItemId: string,
  order: number,
  text = "Provider history",
): ProviderSessionProjectionItem => ({
  type: "assistant_message",
  providerTurnId,
  providerItemId,
  order,
  phase: "final_answer",
  status: "completed",
  text,
});

describe("M10.3 unified remote timeline", () => {
  it("uses native history when the bound AICL Session has no durable Turns", () => {
    const native = [nativeMessage("provider-turn-1", "answer-1", 0)];
    expect(buildUnifiedTimeline([], native)).toEqual([
      {
        source: "provider_native",
        key: "provider:provider-turn-1:answer-1",
        item: native[0],
      },
    ]);
  });

  it("prefers AICL provenance only for a stable provider Turn correlation", () => {
    const correlatedTurn = turn("aicl-turn-1", "provider-turn-1");
    const aicl: TimelineItem[] = [
      {
        id: "turn:aicl-turn-1:operator",
        kind: "operator",
        turn: correlatedTurn,
      },
    ];
    const oldNative = nativeMessage("provider-turn-old", "answer-old", 0);
    const duplicatedNative = nativeMessage("provider-turn-1", "answer-1", 1);

    expect(buildUnifiedTimeline(aicl, [duplicatedNative, oldNative])).toEqual([
      {
        source: "provider_native",
        key: "provider:provider-turn-old:answer-old",
        item: oldNative,
      },
      {
        source: "aicl",
        key: "aicl:turn:aicl-turn-1:operator",
        item: aicl[0],
      },
    ]);
  });

  it("never deduplicates equal message text without correlation evidence", () => {
    const aiclTurn = turn("aicl-turn-1", "provider-turn-1");
    const aicl: TimelineItem[] = [
      {
        id: "message:aicl-answer",
        kind: "assistant",
        turn: aiclTurn,
        content: "Same text",
        completed: true,
      },
    ];
    const native = nativeMessage(
      "different-provider-turn",
      "native-answer",
      0,
      "Same text",
    );

    expect(buildUnifiedTimeline(aicl, [native]).map((entry) => entry.source))
      .toEqual(["provider_native", "aicl"]);
  });
});
