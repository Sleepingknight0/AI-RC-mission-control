import { resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  createBackupSet,
  migrateConfiguredDatabases,
  restoreBackupSet,
  verifyBackupSet,
} from "./maintenance.js";

async function main() {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      "repository-root": { type: "string" },
      "config-path": { type: "string" },
      "migration-root": { type: "string" },
      "backup-path": { type: "string" },
      "retention-count": { type: "string" },
    },
  });
  const command = parsed.positionals[0];
  const repositoryRoot = resolve(parsed.values["repository-root"] ?? process.cwd());
  const common = {
    repositoryRoot,
    ...(parsed.values["config-path"] === undefined
      ? {}
      : { configPath: resolve(parsed.values["config-path"]) }),
    ...(parsed.values["migration-root"] === undefined
      ? {}
      : { migrationRoot: resolve(parsed.values["migration-root"]) }),
  };
  if (command === "backup") {
    const retentionCount = parsed.values["retention-count"];
    const result = await createBackupSet({
      ...common,
      ...(retentionCount === undefined
        ? {}
        : { retentionCount: parseRetentionCount(retentionCount) }),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "verify") {
    const backupPath = required(parsed.values["backup-path"], "--backup-path");
    const manifest = await verifyBackupSet({
      ...common,
      backupPath: resolve(backupPath),
    });
    console.log(JSON.stringify({ status: "verified", manifest }, null, 2));
    return;
  }
  if (command === "restore") {
    const backupPath = required(parsed.values["backup-path"], "--backup-path");
    const result = await restoreBackupSet({
      ...common,
      backupPath: resolve(backupPath),
    });
    console.log(JSON.stringify({ status: "restored", ...result }, null, 2));
    return;
  }
  if (command === "migrate") {
    const result = await migrateConfiguredDatabases(common);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  throw new Error("Maintenance command must be backup, verify, restore, or migrate.");
}

function required(value: string | undefined, name: string) {
  if (value === undefined || value.trim() === "") throw new Error(`Missing ${name}.`);
  return value;
}

function parseRetentionCount(value: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Retention count must be an integer.");
  return parsed;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Maintenance command failed.");
  process.exitCode = 1;
});
