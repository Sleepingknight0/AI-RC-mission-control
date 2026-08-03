import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ClientEnvelopeSchema,
  ServerEnvelopeSchema,
  makeEnvelope,
  type ClientEnvelope,
  type ServerEnvelope,
} from "@aicl/protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  CoreDatabase,
} from "../src/store.js";

const databases: CoreDatabase[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Core managed input attachments", () => {
  it("uploads idempotent chunks, verifies content, and binds once to a Turn", async () => {
    const database = openDatabase();
    await database.ensureSession("session-1");
    const content = Buffer.from("strictly managed context", "utf8");
    const begin = beginCommand("begin-1", content);
    const allocated = await database.beginInputAttachment(begin, reject(begin));
    const attachmentId = acceptedAttachmentId(allocated);

    const chunk = chunkCommand(attachmentId, content);
    expect(await database.appendInputAttachmentChunk(chunk)).toEqual({
      receivedChunks: 1,
      chunkCount: 1,
    });
    expect(await database.appendInputAttachmentChunk(chunk)).toEqual({
      receivedChunks: 1,
      chunkCount: 1,
    });
    const changed = Buffer.from(content);
    changed[0] = changed[0] === 0x78 ? 0x79 : 0x78;
    await expect(
      database.appendInputAttachmentChunk(
        chunkCommand(attachmentId, changed),
      ),
    ).rejects.toMatchObject({
      code: "ATTACHMENT_CHUNK_CONFLICT",
    });

    const complete = completeCommand("complete-1", attachmentId);
    const completed = await database.completeInputAttachment(
      complete,
      reject(complete),
    );
    expect(
      completed.kind === "new" && completed.result.type === "attachment.command.accepted"
        ? completed.result.payload.attachment.status
        : null,
    ).toBe("ready");

    const turn = turnCommand("turn-command-1", [attachmentId]);
    const accepted = await database.acceptTurn({
      message: turn,
      turnId: "turn-1",
      runtime: { runtimeId: "runtime-1", generation: 1, status: "ready" },
      connectorId: "connector-1",
      bootId: "boot-1",
      activeRejection: rejection(turn, "TURN_ALREADY_ACTIVE"),
      attachmentRejection: reject(turn),
    });
    expect(accepted.kind === "new" && accepted.turnAttachments?.[0]).toMatchObject({
      attachment: {
        attachmentId,
        status: "referenced",
        referencedTurnId: "turn-1",
      },
      content,
    });
    expect(database.snapshot("session-1").turns[0]?.attachmentIds).toEqual([
      attachmentId,
    ]);
  });

  it("fails closed for incomplete, cross-device, spoofed, and expired uploads", async () => {
    const database = openDatabase();
    await database.ensureSession("session-1");
    const content = Buffer.from("hello", "utf8");
    const begin = beginCommand("begin-incomplete", content);
    const allocated = await database.beginInputAttachment(begin, reject(begin));
    const attachmentId = acceptedAttachmentId(allocated);

    const incomplete = completeCommand("complete-incomplete", attachmentId);
    const incompleteResult = await database.completeInputAttachment(
      incomplete,
      reject(incomplete),
    );
    expect(errorCode(incompleteResult)).toBe("ATTACHMENT_INCOMPLETE");

    await expect(
      database.appendInputAttachmentChunk({
        ...chunkCommand(attachmentId, content),
        payload: {
          ...chunkCommand(attachmentId, content).payload,
          deviceId: "hostile-device",
        },
      }),
    ).rejects.toMatchObject({ code: "ATTACHMENT_SCOPE_MISMATCH" });

    const pngClaim = Buffer.from("not a png", "utf8");
    const imageBegin = beginCommand("begin-image", pngClaim, {
      name: "spoof.png",
      kind: "image",
      mediaType: "image/png",
    });
    const imageAllocated = await database.beginInputAttachment(
      imageBegin,
      reject(imageBegin),
    );
    const imageId = acceptedAttachmentId(imageAllocated);
    await database.appendInputAttachmentChunk(chunkCommand(imageId, pngClaim));
    const imageComplete = completeCommand("complete-image", imageId);
    expect(
      errorCode(
        await database.completeInputAttachment(imageComplete, reject(imageComplete)),
      ),
    ).toBe("ATTACHMENT_MEDIA_MISMATCH");

    const expiringBegin = beginCommand("begin-expiring", content);
    const expiring = await database.beginInputAttachment(
      expiringBegin,
      reject(expiringBegin),
      new Date("2026-08-03T00:00:00.000Z"),
    );
    const expiringId = acceptedAttachmentId(expiring);
    expect(
      await database.sweepInputAttachments(new Date("2026-08-04T00:00:01.000Z")),
    ).toContain(expiringId);
    expect(database.inputAttachments("session-1", "device-1")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attachmentId: expiringId, status: "expired" }),
      ]),
    );

    const scopedBegin = beginCommand("begin-scoped", content);
    const scoped = await database.beginInputAttachment(
      scopedBegin,
      reject(scopedBegin),
    );
    const scopedId = acceptedAttachmentId(scoped);
    await database.appendInputAttachmentChunk(chunkCommand(scopedId, content));
    const scopedComplete = completeCommand("complete-scoped", scopedId);
    await database.completeInputAttachment(scopedComplete, reject(scopedComplete));
    await database.ensureSession("session-2");
    const crossSessionTurn = turnCommand(
      "turn-cross-session",
      [scopedId],
      "session-2",
    );
    const crossSessionResult = await database.acceptTurn({
      message: crossSessionTurn,
      turnId: "turn-cross-session",
      runtime: { runtimeId: "runtime-cross", generation: 1, status: "ready" },
      connectorId: "connector-cross",
      bootId: "boot-cross",
      activeRejection: rejection(crossSessionTurn, "TURN_ALREADY_ACTIVE"),
      attachmentRejection: reject(crossSessionTurn),
    });
    expect(errorCode(crossSessionResult)).toBe("ATTACHMENT_SCOPE_MISMATCH");
  });
});

function openDatabase() {
  const root = mkdtempSync(join(tmpdir(), "aicl-input-attachment-test-"));
  roots.push(root);
  const database = new CoreDatabase({ path: join(root, "core.db") });
  databases.push(database);
  return database;
}

function beginCommand(
  commandId: string,
  content: Buffer,
  overrides: Partial<{
    name: string;
    kind: "text" | "image";
    mediaType: "text/plain" | "image/png";
  }> = {},
) {
  const message = ClientEnvelopeSchema.parse(
    makeEnvelope("attachment.upload.begin", {
      commandId,
      sessionId: "session-1",
      deviceId: "device-1",
      name: overrides.name ?? "notes.txt",
      kind: overrides.kind ?? "text",
      mediaType: overrides.mediaType ?? "text/plain",
      byteLength: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
      chunkCount: 1,
    }),
  );
  if (message.type !== "attachment.upload.begin") throw new Error("Expected begin");
  return message;
}

function chunkCommand(attachmentId: string, content: Buffer) {
  const message = ClientEnvelopeSchema.parse(
    makeEnvelope("attachment.upload.chunk", {
      sessionId: "session-1",
      deviceId: "device-1",
      attachmentId,
      chunkIndex: 0,
      contentBase64: content.toString("base64"),
    }),
  );
  if (message.type !== "attachment.upload.chunk") throw new Error("Expected chunk");
  return message;
}

function completeCommand(commandId: string, attachmentId: string) {
  const message = ClientEnvelopeSchema.parse(
    makeEnvelope("attachment.upload.complete", {
      commandId,
      sessionId: "session-1",
      deviceId: "device-1",
      attachmentId,
    }),
  );
  if (message.type !== "attachment.upload.complete") throw new Error("Expected complete");
  return message;
}

function turnCommand(
  commandId: string,
  attachmentIds: string[],
  sessionId = "session-1",
) {
  const message = ClientEnvelopeSchema.parse(
    makeEnvelope("turn.submit", {
      commandId,
      sessionId,
      deviceId: "device-1",
      prompt: "Use the attachment",
      settingsRevision: 0,
      attachmentIds,
    }),
  );
  if (message.type !== "turn.submit") throw new Error("Expected Turn");
  return message;
}

function acceptedAttachmentId(result: Awaited<ReturnType<CoreDatabase["beginInputAttachment"]>>) {
  if (result.kind !== "new" || result.result.type !== "attachment.command.accepted") {
    throw new Error("Expected attachment acceptance");
  }
  return result.result.payload.attachment.attachmentId;
}

function errorCode(result: { kind: string; result?: ServerEnvelope }) {
  return result.result?.type === "command.rejected"
    ? result.result.payload.error.code
    : null;
}

function reject(message: Extract<ClientEnvelope, { payload: { commandId: string } }>) {
  return (code: string, detail: string) => rejection(message, code, detail);
}

function rejection(
  message: Extract<ClientEnvelope, { payload: { commandId: string } }>,
  code: string,
  detail = code,
): ServerEnvelope {
  return ServerEnvelopeSchema.parse(
    makeEnvelope("command.rejected", {
      commandId: message.payload.commandId,
      sessionId: message.payload.sessionId,
      error: {
        code,
        message: detail,
        retryable: false,
        commandId: message.payload.commandId,
        sessionId: message.payload.sessionId,
      },
    }),
  );
}
