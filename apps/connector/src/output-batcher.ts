import {
  MAX_INLINE_ENVELOPE_BYTES,
  MAX_OUTPUT_BATCH_BYTES,
  utf8ByteLength,
} from "@aicl/protocol";

const ENVELOPE_METADATA_HEADROOM_BYTES = 4 * 1024;

interface PendingOutput {
  text: string;
  streamSeq: number;
  timer: NodeJS.Timeout | undefined;
}

export interface OutputBatcherOptions {
  flushMs?: number;
  maxBytes?: number;
  emit(activityId: string, streamSeq: number, output: string): void;
}

/** Command output is ephemeral: validate, coalesce, then broadcast without DB rows. */
export class OutputBatcher {
  readonly #flushMs: number;
  readonly #maxBytes: number;
  readonly #maxEncodedBytes: number;
  readonly #emit: OutputBatcherOptions["emit"];
  readonly #pending = new Map<string, PendingOutput>();

  constructor(options: OutputBatcherOptions) {
    this.#flushMs = options.flushMs ?? 25;
    this.#maxBytes = options.maxBytes ?? MAX_OUTPUT_BATCH_BYTES;
    this.#maxEncodedBytes = MAX_INLINE_ENVELOPE_BYTES - ENVELOPE_METADATA_HEADROOM_BYTES;
    this.#emit = options.emit;
  }

  push(activityId: string, output: string) {
    for (const part of splitUtf8(output, this.#maxBytes, this.#maxEncodedBytes)) {
      const pending = this.#state(activityId);
      if (
        pending.text !== "" &&
        (utf8ByteLength(pending.text) + utf8ByteLength(part) > this.#maxBytes ||
          jsonContentByteLength(pending.text) + jsonContentByteLength(part) >
            this.#maxEncodedBytes)
      ) {
        this.flush(activityId);
      }
      const current = this.#state(activityId);
      current.text += part;
      if (utf8ByteLength(current.text) >= this.#maxBytes) {
        this.flush(activityId);
      } else if (current.timer === undefined) {
        current.timer = setTimeout(() => this.flush(activityId), this.#flushMs);
        current.timer.unref();
      }
    }
  }

  flush(activityId: string) {
    const pending = this.#pending.get(activityId);
    if (pending === undefined || pending.text === "") return;
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    const output = pending.text;
    pending.text = "";
    pending.timer = undefined;
    pending.streamSeq += 1;
    this.#emit(activityId, pending.streamSeq, output);
  }

  flushAll() {
    for (const activityId of this.#pending.keys()) this.flush(activityId);
  }

  #state(activityId: string) {
    let state = this.#pending.get(activityId);
    if (state === undefined) {
      state = { text: "", streamSeq: 0, timer: undefined };
      this.#pending.set(activityId, state);
    }
    return state;
  }
}

export function splitUtf8(
  value: string,
  maxBytes: number,
  maxEncodedBytes = Number.POSITIVE_INFINITY,
) {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    (!(Number.isSafeInteger(maxEncodedBytes) || maxEncodedBytes === Infinity)) ||
    maxEncodedBytes <= 0
  ) {
    throw new RangeError("byte limits must be positive integers");
  }
  const parts: string[] = [];
  let part = "";
  let bytes = 0;
  let encodedBytes = 0;
  for (const character of value) {
    const characterBytes = utf8ByteLength(character);
    const characterEncodedBytes = jsonContentByteLength(character);
    if (
      bytes > 0 &&
      (bytes + characterBytes > maxBytes ||
        encodedBytes + characterEncodedBytes > maxEncodedBytes)
    ) {
      parts.push(part);
      part = "";
      bytes = 0;
      encodedBytes = 0;
    }
    part += character;
    bytes += characterBytes;
    encodedBytes += characterEncodedBytes;
  }
  if (part !== "") parts.push(part);
  return parts;
}

function jsonContentByteLength(value: string) {
  return utf8ByteLength(JSON.stringify(value)) - 2;
}
