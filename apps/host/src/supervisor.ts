import {
  fork,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { httpOrigin, loadAiclConfig } from "@aicl/config";
import { redactSensitiveText } from "@aicl/protocol";

import { BoundedLogLineWriter, RotatingJsonLog } from "./logging.js";
import {
  PRODUCTION_STATE_VERSION,
  productionRuntimePaths,
  writeProductionState,
} from "./runtime-files.js";

interface SupervisorOptions {
  repositoryRoot: string;
  configPath: string;
  buildRoot: string;
}

interface StopRequest {
  reason: string;
  failed: boolean;
}

const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const loaded = loadAiclConfig({
    repositoryRoot: options.repositoryRoot,
    configPath: options.configPath,
  });
  const config = loaded.config;
  const runtimePaths = productionRuntimePaths(loaded.configPath);
  mkdirSync(runtimePaths.runDirectory, { recursive: true });
  if (existsSync(runtimePaths.statePath)) {
    throw new Error("Production state already exists; run status or stop first");
  }
  rmSync(runtimePaths.stopRequestPath, { force: true });

  const supervisorLog = new RotatingJsonLog({
    directory: config.paths.logs,
    service: "aicl-host",
  });
  const coreLog = new RotatingJsonLog({
    directory: config.paths.logs,
    service: "aicl-core",
  });
  const connectorLog = new RotatingJsonLog({
    directory: config.paths.logs,
    service: "aicl-connector",
  });
  const coreEntry = resolve(options.buildRoot, "apps/core/src/main.mjs");
  const connectorEntry = resolve(
    options.buildRoot,
    "apps/connector/src/main.mjs",
  );
  const webDistPath = resolve(options.buildRoot, "apps/web/dist");
  const connectorToken = crypto.randomUUID().replaceAll("-", "");
  const childEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    AICL_CONFIG_PATH: loaded.configPath,
    AICL_REPOSITORY_ROOT: options.repositoryRoot,
    AICL_WEB_DIST_PATH: webDistPath,
    AICL_CONNECTOR_TOKEN: connectorToken,
  };
  delete childEnvironment.AICL_BROWSER_TOKEN;
  delete childEnvironment.VITE_AICL_BROWSER_TOKEN;
  delete childEnvironment.VITE_CORE_WS_URL;
  delete childEnvironment.AICL_CORE_CONNECTOR_URL;

  let core: ChildProcess | undefined;
  let connector: ChildProcess | undefined;
  let stopping = false;
  let resolveStop: ((request: StopRequest) => void) | undefined;
  const stopRequested = new Promise<StopRequest>((resolvePromise) => {
    resolveStop = resolvePromise;
  });
  const requestStop = (request: StopRequest) => {
    if (stopping) return;
    stopping = true;
    resolveStop?.(request);
  };
  const signalStop = () => requestStop({ reason: "host signal", failed: false });
  process.once("SIGINT", signalStop);
  process.once("SIGTERM", signalStop);

  const stopPoll = setInterval(() => {
    if (existsSync(runtimePaths.stopRequestPath)) {
      requestStop({ reason: "operator request", failed: false });
    }
  }, 250);
  stopPoll.unref();

  try {
    supervisorLog.write("info", "host.starting", "Starting compiled production services");
    core = startChild(coreEntry, childEnvironment, coreLog);
    watchUnexpectedExit("Core", core, requestStop);
    const coreUrl = httpOrigin(config.core.host, config.core.port);
    await waitForHealth(`${coreUrl}/health`, core, STARTUP_TIMEOUT_MS);

    connector = startChild(connectorEntry, childEnvironment, connectorLog);
    watchUnexpectedExit("Connector", connector, requestStop);
    const connectorHealthUrl = httpOrigin(
      "127.0.0.1",
      config.connector.healthPort,
    );
    await waitForHealth(
      `${connectorHealthUrl}/health`,
      connector,
      STARTUP_TIMEOUT_MS,
    );
    await waitForCoreConnector(`${coreUrl}/health`, core, STARTUP_TIMEOUT_MS);

    if (core.pid === undefined || connector.pid === undefined) {
      throw new Error("Production child process did not expose a PID");
    }
    writeProductionState(runtimePaths.statePath, {
      version: PRODUCTION_STATE_VERSION,
      status: "running",
      supervisorPid: process.pid,
      corePid: core.pid,
      connectorPid: connector.pid,
      startedAt: new Date().toISOString(),
      configPath: loaded.configPath,
      buildRoot: options.buildRoot,
      coreUrl,
      connectorHealthUrl,
    });
    supervisorLog.write("info", "host.ready", `Core ready at ${coreUrl}`);

    const stop = await stopRequested;
    supervisorLog.write("info", "host.stopping", stop.reason);
    await stopChild("Connector", connector, connectorLog);
    await stopChild("Core", core, coreLog);
    if (stop.failed) process.exitCode = 1;
  } finally {
    clearInterval(stopPoll);
    if (connector !== undefined) await stopChild("Connector", connector, connectorLog);
    if (core !== undefined) await stopChild("Core", core, coreLog);
    rmSync(runtimePaths.statePath, { force: true });
    rmSync(runtimePaths.stopRequestPath, { force: true });
    supervisorLog.write("info", "host.stopped", "Production services stopped");
  }
}

function startChild(
  entry: string,
  env: NodeJS.ProcessEnv,
  log: RotatingJsonLog,
): ChildProcess {
  const child = fork(entry, [], {
    cwd: env.AICL_REPOSITORY_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    detached: process.platform !== "win32",
  });
  const stdout = new BoundedLogLineWriter(
    log,
    "info",
    "process.stdout",
  );
  const stderr = new BoundedLogLineWriter(
    log,
    "error",
    "process.stderr",
  );
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk.toString("utf8")));
  child.stdout?.on("end", () => stdout.end());
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  child.stderr?.on("end", () => stderr.end());
  return child;
}

function watchUnexpectedExit(
  name: string,
  child: ChildProcess,
  requestStop: (request: StopRequest) => void,
): void {
  child.once("exit", (code, signal) => {
    requestStop({
      reason: `${name} exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
      failed: true,
    });
  });
}

async function stopChild(
  name: string,
  child: ChildProcess,
  log: RotatingJsonLog,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<boolean>((resolvePromise) => {
    child.once("exit", () => resolvePromise(true));
  });
  if (child.connected) child.send({ type: "aicl.shutdown" });
  const graceful = await Promise.race([
    exited,
    delay(SHUTDOWN_TIMEOUT_MS).then(() => false),
  ]);
  if (graceful) return;
  log.write("warn", "process.force_stop", `${name} exceeded shutdown timeout`);
  if (child.pid !== undefined) terminateProcessTree(child.pid);
  await Promise.race([exited, delay(5_000)]);
}

function terminateProcessTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    process.kill(pid, "SIGKILL");
  }
}

async function waitForHealth(
  url: string,
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Process exited before ${url} became healthy`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for health endpoint: ${redactSensitiveText(lastError)}`);
}

async function waitForCoreConnector(
  url: string,
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Core exited before Connector reconciliation completed");
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        const health = (await response.json()) as { connectorConnected?: unknown };
        if (health.connectorConnected === true) return;
      }
    } catch {
      // The bounded startup loop reports one stable error on timeout.
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for Core/Connector reconciliation");
}

function parseArguments(args: string[]): SupervisorOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error("Invalid production supervisor arguments");
    }
    values.set(key, value);
  }
  return {
    repositoryRoot: required(values, "--repository-root"),
    configPath: required(values, "--config-path"),
    buildRoot: required(values, "--build-root"),
  };
}

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined || value === "") throw new Error(`Missing ${key}`);
  return resolve(value);
}

void main().catch((error: unknown) => {
  console.error(`AICL production supervisor failed: ${redactSensitiveText(error)}`);
  process.exitCode = 1;
});
