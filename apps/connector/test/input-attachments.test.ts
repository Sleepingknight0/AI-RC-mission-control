import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

import {
  CoreToConnectorEnvelopeSchema,
  makeEnvelope,
  type ConnectorInputAttachmentReference,
} from "@aicl/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { InputAttachmentMaterializer } from "../src/input-attachments.js";

const materializers: InputAttachmentMaterializer[] = [];

afterEach(() => {
  for (const materializer of materializers.splice(0)) materializer.close();
});

describe("Connector input attachment materialization", () => {
  it("re-verifies text and materializes images under an owned temporary root", () => {
    const materializer = openMaterializer();
    const text = Buffer.from("review this context", "utf8");
    const textReference = reference("text-1", "text", "text/plain", text);
    transfer(materializer, "session-1", "turn-1", textReference, text);
    const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
    const imageReference = reference("image-1", "image", "image/png", png);
    transfer(materializer, "session-1", "turn-1", imageReference, png);

    const prepared = materializer.prepareForTurn("session-1", "turn-1", [
      textReference,
      imageReference,
    ]);
    expect(prepared[0]).toMatchObject({ kind: "text", text: "review this context" });
    expect(prepared[1]).toMatchObject({ kind: "image", mediaType: "image/png" });
    const image = prepared[1];
    if (image?.kind !== "image") throw new Error("Expected image");
    expect(existsSync(image.path)).toBe(true);

    materializer.releaseTurn("turn-1");
    expect(existsSync(image.path)).toBe(false);
  });

  it("rejects changed chunks, corrupt completion, and cross-Turn references", () => {
    const materializer = openMaterializer();
    const content = Buffer.from("hello", "utf8");
    const item = reference("text-2", "text", "text/plain", content);
    materializer.begin(begin("session-1", "turn-1", item));
    materializer.append(chunk("session-1", "turn-1", item.transferId, content));
    expect(() =>
      materializer.append(
        chunk("session-1", "turn-1", item.transferId, Buffer.from("jello")),
      ),
    ).toThrow(/Changed duplicate/u);
    materializer.complete(complete("session-1", "turn-1", item.transferId));
    expect(() => materializer.prepareForTurn("session-1", "turn-2", [item])).toThrow(
      /mismatched/u,
    );

    const corruptReference = {
      ...reference("text-3", "text", "text/plain", content),
      sha256: "f".repeat(64),
    };
    materializer.begin(begin("session-1", "turn-3", corruptReference));
    materializer.append(
      chunk("session-1", "turn-3", corruptReference.transferId, content),
    );
    expect(() =>
      materializer.complete(
        complete("session-1", "turn-3", corruptReference.transferId),
      ),
    ).toThrow(/integrity/u);
  });
});

function openMaterializer() {
  const value = new InputAttachmentMaterializer();
  materializers.push(value);
  return value;
}

function reference(
  attachmentId: string,
  kind: "text" | "image",
  mediaType: "text/plain" | "image/png",
  content: Buffer,
): ConnectorInputAttachmentReference {
  return {
    attachmentId,
    transferId: `transfer-${attachmentId}`,
    name: kind === "text" ? "notes.txt" : "diagram.png",
    kind,
    mediaType,
    byteLength: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function begin(
  sessionId: string,
  turnId: string,
  transfer: ConnectorInputAttachmentReference,
) {
  const message = CoreToConnectorEnvelopeSchema.parse(
    makeEnvelope("connector.attachment.begin", {
      sessionId,
      turnId,
      transfer,
      chunkCount: 1,
      runtimeId: "runtime-1",
      runtimeGeneration: 1,
    }),
  );
  if (message.type !== "connector.attachment.begin") throw new Error("begin");
  return message;
}

function chunk(sessionId: string, turnId: string, transferId: string, content: Buffer) {
  const message = CoreToConnectorEnvelopeSchema.parse(
    makeEnvelope("connector.attachment.chunk", {
      sessionId,
      turnId,
      transferId,
      chunkIndex: 0,
      contentBase64: content.toString("base64"),
      runtimeId: "runtime-1",
      runtimeGeneration: 1,
    }),
  );
  if (message.type !== "connector.attachment.chunk") throw new Error("chunk");
  return message;
}

function complete(sessionId: string, turnId: string, transferId: string) {
  const message = CoreToConnectorEnvelopeSchema.parse(
    makeEnvelope("connector.attachment.complete", {
      sessionId,
      turnId,
      transferId,
      runtimeId: "runtime-1",
      runtimeGeneration: 1,
    }),
  );
  if (message.type !== "connector.attachment.complete") throw new Error("complete");
  return message;
}

function transfer(
  materializer: InputAttachmentMaterializer,
  sessionId: string,
  turnId: string,
  item: ConnectorInputAttachmentReference,
  content: Buffer,
) {
  materializer.begin(begin(sessionId, turnId, item));
  materializer.append(chunk(sessionId, turnId, item.transferId, content));
  materializer.complete(complete(sessionId, turnId, item.transferId));
}
