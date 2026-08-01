import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export function canonicalProjectRoot(
  requestedPath: string,
  allowedRoots: readonly string[],
) {
  if (allowedRoots.length === 0) {
    throw new Error("At least one project root must be allowed");
  }
  rejectUnsupportedWindowsPath(requestedPath);
  const project = canonicalDirectory(requestedPath);
  const allowed = allowedRoots.map((root) => {
    rejectUnsupportedWindowsPath(root);
    return canonicalDirectory(root);
  });
  if (!allowed.some((root) => contains(root, project))) {
    throw new Error("Project path is outside the configured allowlist");
  }
  return project;
}

function canonicalDirectory(path: string) {
  const canonical = realpathSync.native(resolve(path));
  if (!statSync(canonical).isDirectory()) {
    throw new Error("Project path must resolve to a directory");
  }
  return canonical;
}

function contains(root: string, candidate: string) {
  const normalizedRoot = normalizeCase(root);
  const normalizedCandidate = normalizeCase(candidate);
  const suffix = relative(normalizedRoot, normalizedCandidate);
  return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
}

function normalizeCase(path: string) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function rejectUnsupportedWindowsPath(path: string) {
  if (
    process.platform === "win32" &&
    (path.startsWith("\\\\") || path.startsWith("//"))
  ) {
    throw new Error("UNC and Windows device paths are not allowed project roots");
  }
}
