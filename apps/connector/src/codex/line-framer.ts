export class LineTooLongError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Provider line exceeded ${maxBytes} bytes`);
    this.name = "LineTooLongError";
  }
}

export class BoundedLineFramer {
  #buffer = Buffer.alloc(0);

  constructor(readonly maxBytes = 8 * 1024 * 1024) {}

  push(chunk: Buffer): string[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const lines: string[] = [];
    let newline = this.#buffer.indexOf(0x0a);

    while (newline >= 0) {
      if (newline > this.maxBytes) throw new LineTooLongError(this.maxBytes);
      const line = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      const end = line.at(-1) === 0x0d ? line.length - 1 : line.length;
      lines.push(line.subarray(0, end).toString("utf8"));
      newline = this.#buffer.indexOf(0x0a);
    }

    if (this.#buffer.length > this.maxBytes) {
      throw new LineTooLongError(this.maxBytes);
    }
    return lines;
  }

  finish(): string[] {
    if (this.#buffer.length === 0) return [];
    if (this.#buffer.length > this.maxBytes) {
      throw new LineTooLongError(this.maxBytes);
    }
    const finalLine = this.#buffer.toString("utf8");
    this.#buffer = Buffer.alloc(0);
    return [finalLine];
  }
}

export type JsonLineResult =
  | { ok: true; value: unknown }
  | { ok: false; error: Error; line: string };

export function parseJsonLine(line: string): JsonLineResult {
  try {
    return { ok: true, value: JSON.parse(line) as unknown };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
      line,
    };
  }
}
