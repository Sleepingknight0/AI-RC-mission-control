import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const tsxCli = resolve(repositoryRoot, "node_modules/tsx/dist/cli.mjs");

it(
  "starts Core and Connector from one persistent config without persisting overrides or capabilities",
  async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "aicl-m83-process-"));
    const profileHome = join(temporaryRoot, "profile");
    mkdirSync(join(profileHome, ".codex"), { recursive: true });
    const configPath = join(temporaryRoot, "config.json");
    const corePort = await freePort();
    const connectorPort = await freePort();
    const connectorToken = crypto.randomUUID().replaceAll("-", "");
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      AICL_CONFIG_PATH: configPath,
      AICL_CORE_HOST: "127.0.0.1",
      AICL_CORE_PORT: String(corePort),
      AICL_CONNECTOR_PORT: String(connectorPort),
      AICL_PROJECT_ROOTS: repositoryRoot,
      AICL_PROJECT_PATH: repositoryRoot,
      AICL_PROVIDER: "mock",
      AICL_CONNECTOR_TOKEN: connectorToken,
      HOME: profileHome,
      USERPROFILE: profileHome,
    };
    delete environment.AICL_BROWSER_ORIGINS;
    delete environment.AICL_CORE_CONNECTOR_URL;
    delete environment.AICL_CORE_DB_PATH;
    delete environment.AICL_CONNECTOR_DB_PATH;
    delete environment.CODEX_HOME;

    const core = startEntry("apps/core/src/main.ts", environment);
    const connector = startEntry("apps/connector/src/main.ts", environment);
    try {
      const coreHealth = await waitForJson<{
        component: string;
        status: string;
        connectorConnected: boolean;
      }>(`http://127.0.0.1:${corePort}/health`, (health) =>
        Boolean(health.connectorConnected),
      );
      await waitForJson(
        `http://127.0.0.1:${connectorPort}/health`,
        () => true,
      );
      const page = await fetch(`http://127.0.0.1:${corePort}/`, {
        headers: { accept: "text/html" },
      });
      const runtimeConfig = await fetch(
        `http://127.0.0.1:${corePort}/runtime-config`,
        {
          method: "POST",
          headers: { origin: `http://127.0.0.1:${corePort}` },
        },
      );

      expect(page.status).toBe(200);
      expect(runtimeConfig.status).toBe(200);
      expect(coreHealth).toMatchObject({ component: "core", status: "ready" });
      expect(existsSync(configPath)).toBe(true);
      const rawConfig = readFileSync(configPath, "utf8");
      expect(rawConfig).not.toContain(connectorToken);
      expect(rawConfig).not.toMatch(
        /api[_-]?key|access[_-]?token|connector[_-]?token|credential/iu,
      );
      const persisted = JSON.parse(rawConfig) as {
        version: number;
        core: { port: number; allowedBrowserOrigins: string[] };
        connector: { healthPort: number };
        paths: { coreDatabase: string; connectorDatabase: string };
      };
      expect(persisted.version).toBe(1);
      // Ports and origins came from the environment for this run; none of them
      // may leak into the operator's persisted configuration.
      expect(persisted.core.port).toBe(8787);
      expect(persisted.connector.healthPort).toBe(8788);
      expect(persisted.core.allowedBrowserOrigins).toEqual([
        "http://127.0.0.1:5173",
        "http://localhost:5173",
      ]);
      // The ticket POST above used the ephemeral Core origin, which is never in
      // the config file, proving the effective origin is derived at load time.
      expect(rawConfig).not.toContain(String(corePort));
      expect(persisted.paths.coreDatabase).not.toBe(
        persisted.paths.connectorDatabase,
      );
      expect(existsSync(persisted.paths.coreDatabase)).toBe(true);
      expect(existsSync(persisted.paths.connectorDatabase)).toBe(true);
    } finally {
      await Promise.all([stopProcess(connector), stopProcess(core)]);
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  },
  20_000,
);

function startEntry(relativePath: string, env: NodeJS.ProcessEnv) {
  const output: string[] = [];
  const child = spawn(process.execPath, [tsxCli, resolve(repositoryRoot, relativePath)], {
    cwd: repositoryRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  child.once("exit", (code) => {
    if (code !== null && code !== 0) output.push(`exit=${code}`);
  });
  return child;
}

async function waitForJson<T = unknown>(
  url: string,
  ready: (value: T) => boolean,
) {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const value = (await response.json()) as T;
        if (ready(value)) return value;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastError)}`);
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Unable to allocate a local test port");
  }
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error === undefined ? resolvePromise() : reject(error))),
  );
  return address.port;
}

async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolvePromise) =>
    child.once("exit", () => resolvePromise()),
  );
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolvePromise) =>
      setTimeout(() => resolvePromise(false), 2_000),
    ),
  ]);
  if (!stopped) {
    child.kill("SIGKILL");
    await exited;
  }
}
