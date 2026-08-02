import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BoundedLogLineWriter, RotatingJsonLog } from "../src/logging.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("RotatingJsonLog", () => {
  it("redacts secrets before writing structured operational output", () => {
    const directory = temporaryDirectory();
    const log = new RotatingJsonLog({ directory, service: "test" });

    log.write("error", "process.output", "api_key=secret-value");

    const record = JSON.parse(readFileSync(join(directory, "test.log"), "utf8")) as {
      service: string;
      message: string;
    };
    expect(record.service).toBe("test");
    expect(record.message).toContain("[REDACTED]");
    expect(record.message).not.toContain("secret-value");
  });

  it("keeps only the configured number of bounded log generations", () => {
    const directory = temporaryDirectory();
    const log = new RotatingJsonLog({
      directory,
      service: "bounded",
      maxBytes: 180,
      retainedFiles: 3,
    });

    for (let index = 0; index < 30; index += 1) {
      log.write("info", "rotation.test", `record-${index}-${"x".repeat(60)}`);
    }

    const files = readdirSync(directory).filter((name) => name.startsWith("bounded.log"));
    expect(files.length).toBeLessThanOrEqual(3);
    expect(files).toContain("bounded.log");
  });

  it("buffers split lines before redaction and drops oversized output", () => {
    const directory = temporaryDirectory();
    const log = new RotatingJsonLog({ directory, service: "stream" });
    const writer = new BoundedLogLineWriter(log, "error", "stderr", 32);

    writer.push("api_");
    writer.push("key=secret-value\n");
    writer.push("x".repeat(80));
    writer.push("\n");
    writer.end();

    const output = readFileSync(join(directory, "stream.log"), "utf8");
    expect(output).toContain("[REDACTED]");
    expect(output).toContain("[output line exceeded limit]");
    expect(output).not.toContain("secret-value");
    expect(output).not.toContain("x".repeat(40));
  });
});

function temporaryDirectory() {
  const root = mkdtempSync(join(tmpdir(), "aicl-log-test-"));
  const directory = join(root, "logs");
  mkdirSync(directory);
  temporaryDirectories.push(root);
  return directory;
}
