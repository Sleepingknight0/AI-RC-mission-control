import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalProjectRoot } from "../src/project-root.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("project root containment", () => {
  it("accepts a real directory under an allowed canonical root", () => {
    const root = temporaryDirectory("aicl-allowed-");
    const project = join(root, "project");
    mkdirSync(project);

    expect(canonicalProjectRoot(project, [root]).toLowerCase()).toBe(
      realpathSync.native(project).toLowerCase(),
    );
  });

  it("rejects paths outside the allowlist and directory-link escapes", () => {
    const root = temporaryDirectory("aicl-allowed-");
    const outside = temporaryDirectory("aicl-outside-");
    expect(() => canonicalProjectRoot(outside, [root])).toThrow(
      "outside the configured allowlist",
    );

    const linked = join(root, "linked-outside");
    symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
    expect(() => canonicalProjectRoot(linked, [root])).toThrow(
      "outside the configured allowlist",
    );
  });
});

function temporaryDirectory(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
