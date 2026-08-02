import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

export function canonicalProjectRoot(
  requestedPath: string,
  allowedRoots: readonly string[],
) {
  if (allowedRoots.length === 0) {
    throw new Error("At least one project root must be allowed");
  }
  const project = canonicalExistingDirectory(requestedPath, "default project");
  const allowed = allowedRoots.map((root) =>
    canonicalExistingDirectory(root, "allowed project root"),
  );
  if (!allowed.some((root) => contains(root, project))) {
    throw new Error("Project path is outside the configured allowlist");
  }
  return project;
}

export function canonicalExistingDirectory(path: string, label: string) {
  assertAbsoluteLocalPath(path, label);
  const canonical = realpathSync.native(resolve(path));
  if (!statSync(canonical).isDirectory()) {
    throw new Error(`${label} must resolve to a directory`);
  }
  return canonical;
}

export function canonicalWritableDirectory(path: string, label: string) {
  assertAbsoluteLocalPath(path, label);
  mkdirSync(path, { recursive: true });
  return canonicalExistingDirectory(path, label);
}

export function canonicalFilePath(path: string, label: string) {
  assertAbsoluteLocalPath(path, label);
  const parent = canonicalWritableDirectory(dirname(path), `${label} parent`);
  const candidate = join(parent, basename(path));
  if (!existsSync(candidate)) return candidate;
  if (lstatSync(candidate).isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link or junction`);
  }
  const canonical = realpathSync.native(candidate);
  if (!statSync(canonical).isFile()) {
    throw new Error(`${label} must resolve to a file`);
  }
  return canonical;
}

export function assertAbsoluteLocalPath(path: string, label: string) {
  if (!isAbsolute(path) || isWindowsNetworkOrDevicePath(path)) {
    throw new Error(`${label} must be an absolute local path`);
  }
}

export function samePath(left: string, right: string) {
  return normalizeCase(resolve(left)) === normalizeCase(resolve(right));
}

function contains(root: string, candidate: string) {
  const suffix = relative(normalizeCase(root), normalizeCase(candidate));
  return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
}

function normalizeCase(path: string) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function isWindowsNetworkOrDevicePath(path: string) {
  return process.platform === "win32" && /^(?:\\\\|\/\/)/u.test(path);
}
