import { describe, expect, it } from "vitest";

import {
  ClientEnvelopeSchema,
  CoreToConnectorEnvelopeSchema,
  INPUT_ATTACHMENT_CHUNK_BYTES,
  InputAttachmentSchema,
  MAX_INPUT_ATTACHMENT_BYTES,
  makeEnvelope,
} from "../src/index.js";

describe("managed input attachment protocol", () => {
  it("accepts bounded opaque upload and Connector transfer envelopes", () => {
    const begin = ClientEnvelopeSchema.parse(
      makeEnvelope("attachment.upload.begin", {
        commandId: "upload-command-1",
        sessionId: "session-1",
        deviceId: "device-1",
        name: "diagram.png",
        kind: "image",
        mediaType: "image/png",
        byteLength: 8,
        sha256: "a".repeat(64),
        chunkCount: 1,
      }),
    );
    const transfer = CoreToConnectorEnvelopeSchema.parse(
      makeEnvelope("connector.attachment.begin", {
        sessionId: "session-1",
        turnId: "turn-1",
        transfer: {
          attachmentId: "attachment-1",
          transferId: "transfer-1",
          name: "diagram.png",
          kind: "image",
          mediaType: "image/png",
          byteLength: 8,
          sha256: "a".repeat(64),
        },
        chunkCount: 1,
        runtimeId: "runtime-1",
        runtimeGeneration: 1,
      }),
    );

    expect(begin.type).toBe("attachment.upload.begin");
    expect(transfer.type).toBe("connector.attachment.begin");
  });

  it("rejects paths, duplicate Turn references, and oversized chunks", () => {
    const base = {
      commandId: "upload-command-2",
      sessionId: "session-1",
      deviceId: "device-1",
      name: "safe.txt",
      kind: "text" as const,
      mediaType: "text/plain" as const,
      byteLength: 4,
      sha256: "b".repeat(64),
      chunkCount: 1,
    };
    expect(
      ClientEnvelopeSchema.safeParse(
        makeEnvelope("attachment.upload.begin", { ...base, name: "../secret.txt" }),
      ).success,
    ).toBe(false);
    expect(
      ClientEnvelopeSchema.safeParse(
        makeEnvelope("turn.submit", {
          commandId: "turn-command",
          sessionId: "session-1",
          prompt: "inspect",
          attachmentIds: ["attachment-1", "attachment-1"],
        }),
      ).success,
    ).toBe(false);
    expect(
      ClientEnvelopeSchema.safeParse(
        makeEnvelope("attachment.upload.chunk", {
          sessionId: "session-1",
          deviceId: "device-1",
          attachmentId: "attachment-1",
          chunkIndex: 0,
          contentBase64: Buffer.alloc(INPUT_ATTACHMENT_CHUNK_BYTES + 1).toString("base64"),
        }),
      ).success,
    ).toBe(false);
  });

  it("does not expose a filesystem path in browser metadata", () => {
    const parsed = InputAttachmentSchema.parse({
      attachmentId: "attachment-1",
      sessionId: "session-1",
      ownerDeviceId: "device-1",
      name: "notes.txt",
      kind: "text",
      mediaType: "text/plain",
      byteLength: Math.min(10, MAX_INPUT_ATTACHMENT_BYTES),
      sha256: "c".repeat(64),
      status: "ready",
      previewAvailable: true,
      createdAt: "2026-08-03T05:00:00.000Z",
      expiresAt: "2026-08-04T05:00:00.000Z",
      referencedTurnId: null,
    });

    expect(parsed).not.toHaveProperty("path");
    expect(parsed).not.toHaveProperty("content");
  });
});
