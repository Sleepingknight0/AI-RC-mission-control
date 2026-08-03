import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { CoreDatabase } from "@aicl/core/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  createBackupSet,
  migrateConfiguredDatabases,
  restoreBackupSet,
  verifyBackupSet,
} from "../src/maintenance.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("M8.6 SQLite maintenance", () => {
  it("creates and verifies a coherent online backup, then rejects corruption", async () => {
    const fixture = await createFixture();
    await migrateConfiguredDatabases({ ...fixture, requireStopped: false });
    const core = new CoreDatabase({ path: join(fixture.root, "data", "aicl-core.db") });
    await core.ensureSession("before-backup");

    const result = await createBackupSet(fixture);
    await core.ensureSession("after-backup");
    await core.close();

    const verified = await verifyBackupSet({ ...fixture, backupPath: result.backupPath });
    expect(verified.databases.map((database) => database.component).sort()).toEqual([
      "connector",
      "core",
    ]);
    const backupCore = new DatabaseSync(join(result.backupPath, "aicl-core.db"), {
      readOnly: true,
    });
    expect(
      backupCore.prepare("SELECT COUNT(*) AS count FROM sessions WHERE id = ?").get(
        "before-backup",
      ),
    ).toEqual({ count: 1 });
    expect(
      backupCore.prepare("SELECT COUNT(*) AS count FROM sessions WHERE id = ?").get(
        "after-backup",
      ),
    ).toEqual({ count: 0 });
    backupCore.close();

    appendFileSync(join(result.backupPath, "aicl-core.db"), "corrupt");
    await expect(
      verifyBackupSet({ ...fixture, backupPath: result.backupPath }),
    ).rejects.toThrow("hash or size");
  });

  it("restores through staging and preserves the replaced databases", async () => {
    const fixture = await createFixture();
    await migrateConfiguredDatabases({ ...fixture, requireStopped: false });
    const corePath = join(fixture.root, "data", "aicl-core.db");
    const core = new CoreDatabase({ path: corePath });
    await core.ensureSession("kept");
    await core.close();
    const backup = await createBackupSet(fixture);

    const changed = new CoreDatabase({ path: corePath });
    await changed.ensureSession("removed-by-restore");
    await changed.close();
    const restored = await restoreBackupSet({
      ...fixture,
      backupPath: backup.backupPath,
    });

    const database = new DatabaseSync(corePath, { readOnly: true });
    expect(
      database.prepare("SELECT id FROM sessions ORDER BY id").all(),
    ).toEqual([{ id: "kept" }]);
    database.close();
    expect(existsSync(join(restored.recoveryPath, "core.db"))).toBe(true);
    expect(existsSync(join(restored.recoveryPath, "restore.json"))).toBe(true);
  });

  it("backs up before upgrading prior schemas and is idempotent on repetition", async () => {
    const fixture = await createFixture();
    createPriorDatabase(
      join(fixture.root, "data", "aicl-core.db"),
      join(repositoryRoot, "apps", "core", "migrations"),
      4,
    );
    createPriorDatabase(
      join(fixture.root, "data", "aicl-connector.db"),
      join(repositoryRoot, "apps", "connector", "migrations"),
      2,
    );

    const first = await migrateConfiguredDatabases({ ...fixture, requireStopped: false });
    expect(first).toMatchObject({
      coreSchemaVersion: 5,
      connectorSchemaVersion: 3,
      migrated: true,
    });
    expect(first.backupPath).toBeTruthy();
    expect(readdirSync(join(fixture.root, "backups"))).toContain(
      first.backupPath === undefined ? "missing" : first.backupPath.split(/[\\/]/u).at(-1),
    );

    const second = await migrateConfiguredDatabases({ ...fixture, requireStopped: false });
    expect(second).toEqual({
      coreSchemaVersion: 5,
      connectorSchemaVersion: 3,
      migrated: false,
    });
    const core = new DatabaseSync(join(fixture.root, "data", "aicl-core.db"), {
      readOnly: true,
    });
    expect(
      core.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE checksum IS NULL").get(),
    ).toEqual({ count: 0 });
    core.close();
  });

  it("keeps only the configured number of managed backup sets", async () => {
    const fixture = await createFixture();
    await migrateConfiguredDatabases({ ...fixture, requireStopped: false });
    const unmanaged = join(
      fixture.root,
      "backups",
      "aicl-backup-00000000000000000-unmanaged",
    );
    mkdirSync(unmanaged);
    writeFileSync(join(unmanaged, "manifest.json"), "not an AICL manifest\n");
    for (const day of [1, 2, 3]) {
      await createBackupSet({
        ...fixture,
        retentionCount: 2,
        now: new Date(Date.UTC(2026, 7, day)),
      });
    }
    const backups = readdirSync(join(fixture.root, "backups")).filter((name) =>
      name.startsWith("aicl-backup-"),
    );
    expect(backups).toHaveLength(3);
    expect(backups.filter((name) => !name.endsWith("-unmanaged"))).toHaveLength(2);
    expect(backups.some((name) => name.includes("20260801000000000"))).toBe(false);
    expect(existsSync(unmanaged)).toBe(true);
  });

  it("rejects a manifest that assigns a database to the wrong fixed filename", async () => {
    const fixture = await createFixture();
    await migrateConfiguredDatabases({ ...fixture, requireStopped: false });
    const backup = await createBackupSet(fixture);
    const manifestPath = join(backup.backupPath, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      databases: Array<{ component: string; fileName: string }>;
    };
    const connector = manifest.databases.find(
      (database) => database.component === "connector",
    );
    if (connector === undefined) throw new Error("Connector backup is missing.");
    connector.fileName = "aicl-core.db";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(
      verifyBackupSet({ ...fixture, backupPath: backup.backupPath }),
    ).rejects.toThrow("filename does not match");
  });
});

async function createFixture() {
  const root = join(tmpdir(), `aicl-m86-${crypto.randomUUID()}`);
  temporaryDirectories.push(root);
  mkdirSync(root, { recursive: true });
  const corePort = await freePort();
  const connectorPort = await freePort();
  const configPath = join(root, "config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        version: 1,
        core: {
          host: "127.0.0.1",
          port: corePort,
          allowedBrowserOrigins: [`http://127.0.0.1:${corePort}`],
        },
        connector: { healthPort: connectorPort },
        provider: {
          name: "mock",
          profile: "test",
          codexHome: process.env.CODEX_HOME ?? join(homedir(), ".codex"),
        },
        workspace: {
          allowedRoots: [repositoryRoot],
          defaultProject: repositoryRoot,
        },
        paths: {
          coreDatabase: join(root, "data", "aicl-core.db"),
          connectorDatabase: join(root, "data", "aicl-connector.db"),
          logs: join(root, "logs"),
          backups: join(root, "backups"),
        },
      },
      null,
      2,
    )}\n`,
  );
  return { root, repositoryRoot, configPath };
}

function createPriorDatabase(path: string, migrations: string, version: number) {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec(
    `CREATE TABLE schema_migrations (
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at TEXT NOT NULL
     ) STRICT`,
  );
  for (const name of readdirSync(migrations).filter((item) => item.endsWith(".sql")).sort()) {
    const migrationVersion = Number.parseInt(name.split("_")[0] ?? "", 10);
    if (migrationVersion > version) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(readFileSync(join(migrations, name), "utf8"));
      database
        .prepare(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        )
        .run(migrationVersion, name, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      database.close();
      throw error;
    }
  }
  database.close();
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test port listener did not expose a TCP address.");
  }
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) =>
      error === undefined ? resolvePromise() : reject(error),
    );
  });
  return address.port;
}
