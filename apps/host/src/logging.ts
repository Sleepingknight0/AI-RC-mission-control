import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import { redactSensitiveText } from "@aicl/protocol";

export type OperationalLogLevel = "info" | "warn" | "error";

export interface RotatingJsonLogOptions {
  directory: string;
  service: string;
  maxBytes?: number;
  retainedFiles?: number;
}

export class RotatingJsonLog {
  readonly #path: string;
  readonly #service: string;
  readonly #maxBytes: number;
  readonly #retainedFiles: number;

  constructor(options: RotatingJsonLogOptions) {
    this.#maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.#retainedFiles = options.retainedFiles ?? 5;
    if (this.#maxBytes < 1 || this.#retainedFiles < 1) {
      throw new Error("Log bounds must be positive");
    }
    mkdirSync(options.directory, { recursive: true });
    this.#path = join(options.directory, `${options.service}.log`);
    this.#service = options.service;
  }

  write(level: OperationalLogLevel, event: string, message: unknown): void {
    const line = `${JSON.stringify({
      ts: new Date().toISOString(),
      level,
      service: this.#service,
      event,
      message: redactSensitiveText(message),
    })}\n`;
    this.#rotateIfNeeded(Buffer.byteLength(line));
    appendFileSync(this.#path, line, { encoding: "utf8", mode: 0o600 });
  }

  #rotateIfNeeded(incomingBytes: number): void {
    if (
      !existsSync(this.#path) ||
      statSync(this.#path).size + incomingBytes <= this.#maxBytes
    ) {
      return;
    }
    if (this.#retainedFiles === 1) {
      rmSync(this.#path, { force: true });
      return;
    }
    for (let index = this.#retainedFiles - 1; index >= 1; index -= 1) {
      const source = index === 1 ? this.#path : `${this.#path}.${index - 1}`;
      const destination = `${this.#path}.${index}`;
      if (!existsSync(source)) continue;
      rmSync(destination, { force: true });
      renameSync(source, destination);
    }
  }
}

export class BoundedLogLineWriter {
  readonly #log: RotatingJsonLog;
  readonly #level: OperationalLogLevel;
  readonly #event: string;
  readonly #maxBufferedBytes: number;
  #buffer = "";
  #discarding = false;

  constructor(
    log: RotatingJsonLog,
    level: OperationalLogLevel,
    event: string,
    maxBufferedBytes = 64 * 1024,
  ) {
    this.#log = log;
    this.#level = level;
    this.#event = event;
    this.#maxBufferedBytes = maxBufferedBytes;
  }

  push(chunk: string): void {
    for (const fragment of chunk.split(/(\r?\n)/u)) {
      if (/^\r?\n$/u.test(fragment)) {
        this.#finishLine();
        continue;
      }
      if (this.#discarding || fragment === "") continue;
      this.#buffer += fragment;
      if (Buffer.byteLength(this.#buffer) > this.#maxBufferedBytes) {
        this.#buffer = "";
        this.#discarding = true;
      }
    }
  }

  end(): void {
    if (this.#discarding) {
      this.#log.write("warn", this.#event, "[output line exceeded limit]");
    } else if (this.#buffer !== "") {
      this.#log.write(this.#level, this.#event, this.#buffer);
    }
    this.#buffer = "";
    this.#discarding = false;
  }

  #finishLine(): void {
    if (this.#discarding) {
      this.#log.write("warn", this.#event, "[output line exceeded limit]");
    } else if (this.#buffer !== "") {
      this.#log.write(this.#level, this.#event, this.#buffer);
    }
    this.#buffer = "";
    this.#discarding = false;
  }
}
