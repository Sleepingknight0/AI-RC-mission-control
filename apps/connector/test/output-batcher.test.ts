import {
  MAX_INLINE_ENVELOPE_BYTES,
  MAX_OUTPUT_BATCH_BYTES,
  makeEnvelope,
  utf8ByteLength,
} from "@aicl/protocol";
import { describe, expect, it } from "vitest";

import { OutputBatcher, splitUtf8 } from "../src/output-batcher.js";

describe("command output batching", () => {
  it("coalesces output and preserves UTF-8 order within the hard batch limit", () => {
    const batches: Array<{ seq: number; output: string }> = [];
    const batcher = new OutputBatcher({
      flushMs: 60_000,
      emit: (_activityId, seq, output) => batches.push({ seq, output }),
    });
    const output = `${"ก".repeat(100_000)}${"x".repeat(300_000)}`;
    batcher.push("activity-1", output);
    batcher.flushAll();

    expect(batches.map((batch) => batch.seq)).toEqual(
      batches.map((_, index) => index + 1),
    );
    expect(batches.map((batch) => batch.output).join("")).toBe(output);
    expect(
      batches.every(
        (batch) => utf8ByteLength(batch.output) <= MAX_OUTPUT_BATCH_BYTES,
      ),
    ).toBe(true);
  });

  it("splits only at Unicode code-point boundaries", () => {
    expect(splitUtf8("กขค", 6)).toEqual(["กข", "ค"]);
  });

  it("accounts for JSON escaping before an output envelope reaches its ceiling", () => {
    const batches: string[] = [];
    const batcher = new OutputBatcher({
      flushMs: 60_000,
      emit: (_activityId, _seq, output) => batches.push(output),
    });
    const output = "\u0000".repeat(MAX_OUTPUT_BATCH_BYTES);

    batcher.push("activity-escape", output);
    batcher.flushAll();

    expect(batches.join("")).toBe(output);
    expect(batches.length).toBeGreaterThan(1);
    expect(
      batches.every((batch, index) =>
        utf8ByteLength(
          JSON.stringify(
            makeEnvelope("command.output.batch", {
              sessionId: "session-1",
              turnId: "turn-1",
              activityId: "activity-escape",
              streamSeq: index + 1,
              output: batch,
            }),
          ),
        ) <= MAX_INLINE_ENVELOPE_BYTES,
      ),
    ).toBe(true);
  });
});
