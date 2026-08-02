import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { websocketCapability } from "@aicl/protocol";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { startCoreServer, type CoreServerHandle } from "../src/server.js";

const handles: CoreServerHandle[] = [];
const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("same-origin production host", () => {
  it("serves the built Web app, assets, and SPA fallback", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "aicl-production-host-"));
    temporaryPaths.push(fixtureRoot);
    const webDistPath = join(fixtureRoot, "dist");
    await mkdir(join(webDistPath, "assets"), { recursive: true });
    await writeFile(
      join(webDistPath, "index.html"),
      '<!doctype html><div id="root">production-shell</div>',
    );
    await writeFile(join(webDistPath, "assets", "app-test.js"), "export const ok = true;");
    await writeFile(join(fixtureRoot, "secret.txt"), "must-not-be-served");

    const core = await startCoreServer({
      port: 0,
      dbPath: ":memory:",
      webDistPath,
    });
    handles.push(core);
    const baseUrl = core.browserUrl.replace(/^ws:/, "http:").replace(/\/ws$/, "");

    const root = await fetch(`${baseUrl}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/html");
    expect(await root.text()).toContain("production-shell");

    const fallback = await fetch(`${baseUrl}/sessions/daily-use`, {
      headers: { accept: "text/html" },
    });
    expect(fallback.status).toBe(200);
    expect(await fallback.text()).toContain("production-shell");

    const asset = await fetch(`${baseUrl}/assets/app-test.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/javascript");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(await asset.text()).toBe("export const ok = true;");

    const head = await fetch(`${baseUrl}/assets/app-test.js`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("23");
    expect(await head.text()).toBe("");

    const missingAsset = await fetch(`${baseUrl}/assets/missing.js`);
    expect(missingAsset.status).toBe(404);

    const traversal = await fetch(`${baseUrl}/assets/%2e%2e%2fsecret.txt`);
    expect(traversal.status).toBe(404);
    expect(await traversal.text()).not.toContain("must-not-be-served");
  });

  it("keeps protocol routes reserved and accepts the exact same Origin", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "aicl-production-routes-"));
    temporaryPaths.push(fixtureRoot);
    await writeFile(join(fixtureRoot, "index.html"), "production-shell");
    const core = await startCoreServer({
      port: 0,
      dbPath: ":memory:",
      webDistPath: fixtureRoot,
    });
    handles.push(core);
    const baseUrl = core.browserUrl.replace(/^ws:/, "http:").replace(/\/ws$/, "");

    expect((await fetch(`${baseUrl}/health`)).headers.get("content-type")).toContain(
      "application/json",
    );
    expect((await fetch(`${baseUrl}/ws`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/connector`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/artifacts/missing`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/runtime-config`)).status).toBe(405);

    const socket = new WebSocket(
      core.browserUrl,
      websocketCapability("browser", core.browserToken),
      { origin: baseUrl },
    );
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.close();
  });
});
