import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  INPUT_ATTACHMENT_CHUNK_BYTES,
  MAX_INPUT_ATTACHMENT_BYTES,
  type ConnectorInputAttachmentReference,
  type CoreToConnectorEnvelope,
} from "@aicl/protocol";

import type { PreparedInputAttachment } from "./provider.js";

type Begin = Extract<
  CoreToConnectorEnvelope,
  { type: "connector.attachment.begin" }
>;
type Chunk = Extract<
  CoreToConnectorEnvelope,
  { type: "connector.attachment.chunk" }
>;
type Complete = Extract<
  CoreToConnectorEnvelope,
  { type: "connector.attachment.complete" }
>;

interface Transfer {
  sessionId: string;
  turnId: string;
  runtimeId: string;
  runtimeGeneration: number;
  reference: ConnectorInputAttachmentReference;
  chunkCount: number;
  chunks: Map<number, Buffer>;
  complete: boolean;
}

export class InputAttachmentMaterializer {
  readonly #root: string;
  readonly #transfers = new Map<string, Transfer>();
  readonly #turnDirectories = new Map<string, string>();
  #allocatedBytes = 0;

  constructor() {
    this.#root = realpathSync(
      mkdtempSync(join(tmpdir(), "aicl-connector-input-")),
    );
  }

  begin(message: Begin) {
    const { transfer, chunkCount } = message.payload;
    if (chunkCount !== Math.ceil(transfer.byteLength / INPUT_ATTACHMENT_CHUNK_BYTES)) {
      throw new Error("Attachment transfer chunk count is invalid");
    }
    const prior = this.#transfers.get(transfer.transferId);
    if (prior !== undefined) {
      if (
        prior.sessionId !== message.payload.sessionId ||
        prior.turnId !== message.payload.turnId ||
        JSON.stringify(prior.reference) !== JSON.stringify(transfer) ||
        prior.chunkCount !== chunkCount
      ) {
        throw new Error("Attachment transfer ID was reused with different metadata");
      }
      return;
    }
    if (this.#allocatedBytes + transfer.byteLength > MAX_INPUT_ATTACHMENT_BYTES * 8) {
      throw new Error("Connector attachment allocation limit exceeded");
    }
    this.#allocatedBytes += transfer.byteLength;
    this.#transfers.set(transfer.transferId, {
      sessionId: message.payload.sessionId,
      turnId: message.payload.turnId,
      runtimeId: message.payload.runtimeId,
      runtimeGeneration: message.payload.runtimeGeneration,
      reference: transfer,
      chunkCount,
      chunks: new Map(),
      complete: false,
    });
  }

  append(message: Chunk) {
    const transfer = this.#scopedTransfer(message.payload.transferId, message.payload);
    if (transfer.complete || message.payload.chunkIndex >= transfer.chunkCount) {
      throw new Error("Attachment transfer is not accepting this chunk");
    }
    const content = decodeCanonicalBase64(message.payload.contentBase64);
    const expectedLength = Math.min(
      INPUT_ATTACHMENT_CHUNK_BYTES,
      transfer.reference.byteLength -
        message.payload.chunkIndex * INPUT_ATTACHMENT_CHUNK_BYTES,
    );
    if (content.byteLength !== expectedLength) {
      throw new Error("Attachment transfer chunk length is invalid");
    }
    const prior = transfer.chunks.get(message.payload.chunkIndex);
    if (prior !== undefined && !prior.equals(content)) {
      throw new Error("Changed duplicate attachment transfer chunk was rejected");
    }
    transfer.chunks.set(message.payload.chunkIndex, content);
  }

  complete(message: Complete) {
    const transfer = this.#scopedTransfer(message.payload.transferId, message.payload);
    const content = contentFor(transfer);
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (
      content.byteLength !== transfer.reference.byteLength ||
      sha256 !== transfer.reference.sha256
    ) {
      throw new Error("Attachment transfer integrity verification failed");
    }
    transfer.complete = true;
  }

  prepareForTurn(
    sessionId: string,
    turnId: string,
    references: readonly ConnectorInputAttachmentReference[],
  ): PreparedInputAttachment[] {
    const prepared: PreparedInputAttachment[] = [];
    for (const reference of references) {
      const transfer = this.#transfers.get(reference.transferId);
      if (
        transfer === undefined ||
        !transfer.complete ||
        transfer.sessionId !== sessionId ||
        transfer.turnId !== turnId ||
        JSON.stringify(transfer.reference) !== JSON.stringify(reference)
      ) {
        throw new Error("Turn references an incomplete or mismatched attachment transfer");
      }
      const content = contentFor(transfer);
      if (reference.kind === "text") {
        prepared.push({
          attachmentId: reference.attachmentId,
          name: reference.name,
          kind: "text",
          mediaType: reference.mediaType as "text/plain" | "text/markdown",
          text: new TextDecoder("utf-8", { fatal: true }).decode(content),
        });
        continue;
      }
      const turnDirectory = this.#turnDirectory(turnId);
      const path = resolve(
        turnDirectory,
        `${reference.attachmentId}${extensionFor(reference.mediaType)}`,
      );
      assertContained(turnDirectory, path);
      writeFileSync(path, content, { flag: "wx", mode: 0o600 });
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
        throw new Error("Materialized attachment is not a regular file");
      }
      prepared.push({
        attachmentId: reference.attachmentId,
        name: reference.name,
        kind: "image",
        mediaType: reference.mediaType as
          | "image/png"
          | "image/jpeg"
          | "image/gif"
          | "image/webp",
        path,
      });
    }
    return prepared;
  }

  releaseTurn(turnId: string) {
    for (const [transferId, transfer] of this.#transfers) {
      if (transfer.turnId !== turnId) continue;
      this.#allocatedBytes -= transfer.reference.byteLength;
      this.#transfers.delete(transferId);
    }
    const directory = this.#turnDirectories.get(turnId);
    if (directory !== undefined) {
      assertContained(this.#root, directory);
      rmSync(directory, { recursive: true, force: true });
      this.#turnDirectories.delete(turnId);
    }
  }

  close() {
    const root = realpathSync(this.#root);
    if (root !== this.#root || !root.includes("aicl-connector-input-")) {
      throw new Error("Refusing to remove an unrecognized attachment root");
    }
    rmSync(root, { recursive: true, force: true });
    this.#transfers.clear();
    this.#turnDirectories.clear();
    this.#allocatedBytes = 0;
  }

  #scopedTransfer(
    transferId: string,
    scope: {
      sessionId: string;
      turnId: string;
      runtimeId: string;
      runtimeGeneration: number;
    },
  ) {
    const transfer = this.#transfers.get(transferId);
    if (
      transfer === undefined ||
      transfer.sessionId !== scope.sessionId ||
      transfer.turnId !== scope.turnId ||
      transfer.runtimeId !== scope.runtimeId ||
      transfer.runtimeGeneration !== scope.runtimeGeneration
    ) {
      throw new Error("Attachment transfer scope mismatch");
    }
    return transfer;
  }

  #turnDirectory(turnId: string) {
    const prior = this.#turnDirectories.get(turnId);
    if (prior !== undefined) return prior;
    const safeId = createHash("sha256").update(turnId).digest("hex");
    const path = resolve(this.#root, safeId);
    assertContained(this.#root, path);
    mkdirSync(path, { recursive: false, mode: 0o700 });
    const canonical = realpathSync(path);
    assertContained(this.#root, canonical);
    this.#turnDirectories.set(turnId, canonical);
    return canonical;
  }
}

function contentFor(transfer: Transfer) {
  if (
    transfer.chunks.size !== transfer.chunkCount ||
    [...transfer.chunks.keys()].some((index) => index < 0 || index >= transfer.chunkCount)
  ) {
    throw new Error("Attachment transfer is missing chunks");
  }
  return Buffer.concat(
    Array.from({ length: transfer.chunkCount }, (_, index) => {
      const chunk = transfer.chunks.get(index);
      if (chunk === undefined) throw new Error("Attachment transfer is missing a chunk");
      return chunk;
    }),
  );
}

function decodeCanonicalBase64(value: string) {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    throw new Error("Attachment transfer chunk is not canonical base64");
  }
  return Buffer.from(value, "base64");
}

function assertContained(root: string, candidate: string) {
  const relation = relative(root, candidate);
  if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) return;
  throw new Error("Attachment path escaped its managed root");
}

function extensionFor(mediaType: string) {
  if (mediaType === "image/png") return ".png";
  if (mediaType === "image/jpeg") return ".jpg";
  if (mediaType === "image/gif") return ".gif";
  if (mediaType === "image/webp") return ".webp";
  throw new Error("Unsupported materialized image media type");
}
