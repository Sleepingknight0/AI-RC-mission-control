import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { httpOrigin, loadAiclConfig } from "@aicl/config";
import { probeInstalledCodex } from "@aicl/connector/compatibility";
import { redactSensitiveText } from "@aicl/protocol";

import { diagnoseTailscale } from "./tailscale-diagnostics.js";

interface Check {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

async function main(): Promise<void> {
  const values = parseArguments(process.argv.slice(2));
  const repositoryRoot = required(values, "--repository-root");
  const configPath = required(values, "--config-path");
  const buildRoot = required(values, "--build-root");
  const checks: Check[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "node",
    status: major >= 24 ? "pass" : "fail",
    detail: process.version,
  });
  for (const [name, path] of [
    ["core build", resolve(buildRoot, "apps/core/src/main.mjs")],
    ["connector build", resolve(buildRoot, "apps/connector/src/main.mjs")],
    ["web build", resolve(buildRoot, "apps/web/dist/index.html")],
  ] as const) {
    checks.push({
      name,
      status: existsSync(path) ? "pass" : "fail",
      detail: existsSync(path) ? "present" : "missing; run pnpm build",
    });
  }

  let loaded: ReturnType<typeof loadAiclConfig>;
  try {
    loaded = loadAiclConfig({ repositoryRoot, configPath });
    checks.push({ name: "config", status: "pass", detail: "schema version 1" });
  } catch (error) {
    checks.push({
      name: "config",
      status: "fail",
      detail: redactSensitiveText(error),
    });
    printResult(checks);
    return;
  }

  const config = loaded.config;
  checks.push(databaseCheck("Core database", config.paths.coreDatabase));
  checks.push(databaseCheck("Connector database", config.paths.connectorDatabase));
  if (config.provider.name === "codex") {
    try {
      const compatibility = probeInstalledCodex("codex", repositoryRoot);
      checks.push({
        name: "Codex compatibility",
        status: compatibility.compatible ? "pass" : "fail",
        detail: compatibility.compatible
          ? `accepted ${compatibility.installedVersion ?? "unknown"}`
          : (compatibility.reason ?? "incompatible"),
      });
    } catch (error) {
      checks.push({
        name: "Codex compatibility",
        status: "fail",
        detail: redactSensitiveText(error),
      });
    }
  } else {
    checks.push({ name: "Codex compatibility", status: "warn", detail: "mock provider" });
  }

  const coreUrl = httpOrigin(config.core.host, config.core.port);
  checks.push(await healthCheck("Core health", `${coreUrl}/health`));
  checks.push(
    await healthCheck(
      "Connector health",
      `${httpOrigin("127.0.0.1", config.connector.healthPort)}/health`,
    ),
  );
  checks.push(
    ...diagnoseTailscale({
      coreHost: config.core.host,
      corePort: config.core.port,
      allowedBrowserOrigins: config.core.allowedBrowserOrigins,
    }),
  );
  printResult(checks);
}

function databaseCheck(name: string, path: string): Check {
  if (!existsSync(path)) return { name, status: "warn", detail: "not created yet" };
  try {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const row = database.prepare("PRAGMA quick_check").get() as
        | { quick_check?: unknown }
        | undefined;
      const result = String(row?.quick_check ?? "unknown");
      return {
        name,
        status: result === "ok" ? "pass" : "fail",
        detail: result,
      };
    } finally {
      database.close();
    }
  } catch (error) {
    return { name, status: "fail", detail: redactSensitiveText(error) };
  }
}

async function healthCheck(name: string, url: string): Promise<Check> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    return {
      name,
      status: response.ok ? "pass" : "warn",
      detail: response.ok ? "online" : `HTTP ${response.status}`,
    };
  } catch {
    return { name, status: "warn", detail: "offline" };
  }
}

function printResult(checks: Check[]): void {
  const failed = checks.some((check) => check.status === "fail");
  console.log(JSON.stringify({ status: failed ? "failed" : "ready", checks }, null, 2));
  if (failed) process.exitCode = 1;
}

function parseArguments(args: string[]): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error("Invalid doctor arguments");
    }
    values.set(key, value);
  }
  return values;
}

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined || value === "") throw new Error(`Missing ${key}`);
  return resolve(value);
}

void main().catch((error: unknown) => {
  console.error(`AICL doctor failed: ${redactSensitiveText(error)}`);
  process.exitCode = 1;
});
