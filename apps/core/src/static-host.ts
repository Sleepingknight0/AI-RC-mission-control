import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const RESERVED_PREFIXES = [
  "/health",
  "/runtime-config",
  "/ws",
  "/connector",
  "/artifacts",
];

export function isReservedHttpPath(pathname: string): boolean {
  return RESERVED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export async function serveWebRequest(
  request: IncomingMessage,
  response: ServerResponse,
  webDistPath: string,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }

  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  const relativePath = safeRelativePath(requestUrl.pathname);
  if (relativePath === undefined) {
    response.writeHead(404).end();
    return;
  }

  const requestedFile = relativePath === "" ? "index.html" : relativePath;
  const directPath = resolveWithin(webDistPath, requestedFile);
  if (directPath !== undefined && (await isFile(directPath))) {
    serveFile(request, response, directPath, requestUrl.pathname.startsWith("/assets/"));
    return;
  }

  const acceptsHtml = request.headers.accept?.includes("text/html") === true;
  if (acceptsHtml) {
    const indexPath = resolveWithin(webDistPath, "index.html");
    if (indexPath !== undefined && (await isFile(indexPath))) {
      serveFile(request, response, indexPath, false);
      return;
    }
  }

  response.writeHead(404).end();
}

function safeRelativePath(pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return undefined;
  const relativePath = decoded.replace(/^\/+/, "");
  if (relativePath.split("/").some((segment) => segment === "..")) return undefined;
  return relativePath;
}

function resolveWithin(rootPath: string, relativePath: string): string | undefined {
  const resolvedRoot = resolve(rootPath);
  const resolvedPath = resolve(resolvedRoot, relativePath);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    return undefined;
  }
  return resolvedPath;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return false;
    }
    throw error;
  }
}

function serveFile(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  immutable: boolean,
): void {
  void stat(path).then(
    (metadata) => {
      response.writeHead(200, {
        "cache-control": immutable
          ? "public, max-age=31536000, immutable"
          : "no-cache",
        "content-length": String(metadata.size),
        "content-type": CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
        "x-content-type-options": "nosniff",
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      const stream = createReadStream(path);
      stream.once("error", (error) => response.destroy(error));
      stream.pipe(response);
    },
    (error: unknown) => {
      if (!response.headersSent) response.writeHead(500).end();
      else response.destroy(error instanceof Error ? error : undefined);
    },
  );
}
