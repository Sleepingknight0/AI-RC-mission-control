import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import { loadAiclConfig, type AiclConfig } from "@aicl/config";
import { CONNECTOR_SCHEMA_VERSION } from "@aicl/connector/journal";
import { CORE_SCHEMA_VERSION } from "@aicl/core/store";
import { z } from "zod";

import { assertTcpPortAvailable } from "./port-availability.js";

const BACKUP_VERSION = 1;
const DEFAULT_RETENTION_COUNT = 14;

const DatabaseComponentSchema = z.enum(["core", "connector"]);
const DatabaseManifestSchema = z
  .object({
    component: DatabaseComponentSchema,
    fileName: z.enum(["aicl-core.db", "aicl-connector.db"]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    bytes: z.number().int().nonnegative(),
    schemaVersion: z.number().int().nonnegative(),
    sqliteVersion: z.string().min(1),
    sqliteSourceId: z.string().min(1),
    integrity: z.literal("ok"),
  })
  .strict();

const BackupManifestSchema = z
  .object({
    version: z.literal(BACKUP_VERSION),
    backupId: z.string().regex(/^aicl-backup-[A-Za-z0-9-]+$/u),
    reason: z.enum(["manual", "pre-migration"]),
    createdAt: z.string().datetime(),
    verifiedAt: z.string().datetime(),
    encryptionPolicy: z.literal("host-volume-or-external"),
    config: z
      .object({
        fileName: z.literal("config.json"),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        bytes: z.number().int().nonnegative(),
      })
      .strict(),
    databases: z.array(DatabaseManifestSchema).min(1),
  })
  .strict();

export type BackupManifest = z.infer<typeof BackupManifestSchema>;
type DatabaseComponent = z.infer<typeof DatabaseComponentSchema>;
type DatabaseManifest = z.infer<typeof DatabaseManifestSchema>;

export interface MaintenanceOptions {
  repositoryRoot: string;
  configPath?: string;
  migrationRoot?: string;
}

export interface BackupOptions extends MaintenanceOptions {
  reason?: "manual" | "pre-migration";
  retentionCount?: number;
  now?: Date;
  allowMissingCore?: boolean;
}

export interface BackupResult {
  backupPath: string;
  manifest: BackupManifest;
  pruned: string[];
}

export interface MigrationResult {
  coreSchemaVersion: number;
  connectorSchemaVersion: number;
  backupPath?: string;
  migrated: boolean;
}

interface VerifiedDatabase {
  schemaVersion: number;
  sqliteVersion: string;
  sqliteSourceId: string;
}

interface LoadedMaintenanceContext {
  config: AiclConfig;
  configPath: string;
  applicationRoot: string;
}

export async function createBackupSet(
  options: BackupOptions,
): Promise<BackupResult> {
  const context = loadContext(options);
  return createBackupForContext(context, options);
}

export async function verifyBackupSet(
  options: MaintenanceOptions & { backupPath: string },
): Promise<BackupManifest> {
  const context = loadContext(options);
  const backupPath = containedBackupDirectory(
    context.config.paths.backups,
    options.backupPath,
  );
  const manifestPath = join(backupPath, "manifest.json");
  let manifest: BackupManifest;
  try {
    manifest = BackupManifestSchema.parse(
      JSON.parse(readFileSync(manifestPath, "utf8")) as unknown,
    );
  } catch {
    throw new Error("Backup manifest is missing, invalid, or unsupported.");
  }
  if (manifest.backupId !== basename(backupPath)) {
    throw new Error("Backup manifest identity does not match its directory.");
  }
  const configPath = join(backupPath, manifest.config.fileName);
  await assertFileMetadata(
    configPath,
    manifest.config.sha256,
    manifest.config.bytes,
    "backup config",
  );
  const components = new Set<DatabaseComponent>();
  for (const database of manifest.databases) {
    if (components.has(database.component)) {
      throw new Error(`Backup manifest repeats the ${database.component} database.`);
    }
    components.add(database.component);
    if (database.fileName !== databaseFileName(database.component)) {
      throw new Error(
        `${database.component} backup filename does not match its component.`,
      );
    }
    const path = join(backupPath, database.fileName);
    await assertFileMetadata(path, database.sha256, database.bytes, database.component);
    const verified = verifyDatabase(path, database.component, true);
    if (
      verified.schemaVersion !== database.schemaVersion ||
      verified.sqliteVersion !== database.sqliteVersion ||
      verified.sqliteSourceId !== database.sqliteSourceId
    ) {
      throw new Error(`${database.component} backup metadata does not match its database.`);
    }
  }
  return manifest;
}

export async function restoreBackupSet(
  options: MaintenanceOptions & { backupPath: string },
): Promise<{ backupId: string; recoveryPath: string }> {
  const context = loadContext(options);
  await assertMaintenanceStopped(context);
  const backupPath = containedBackupDirectory(
    context.config.paths.backups,
    options.backupPath,
  );
  const manifest = await verifyBackupSet(options);
  const core = manifest.databases.find((item) => item.component === "core");
  if (core === undefined) throw new Error("Backup does not contain the authoritative Core database.");

  const timestamp = new Date().toISOString().replace(/[^0-9]/gu, "");
  const recoveryPath = join(
    context.config.paths.backups,
    `recovery-before-restore-${timestamp}-${randomUUID().slice(0, 8)}`,
  );
  mkdirSync(recoveryPath, { recursive: false, mode: 0o700 });
  const switched: Array<{ target: string; preserved: Array<[string, string]> }> = [];
  const staged = new Map<DatabaseComponent, string>();
  try {
    for (const database of manifest.databases) {
      const target = databasePath(context.config, database.component);
      const stage = `${target}.${process.pid}.${randomUUID()}.restore`;
      await backupDatabase(join(backupPath, database.fileName), stage);
      verifyDatabase(stage, database.component, true);
      staged.set(database.component, stage);
    }

    for (const database of manifest.databases) {
      const target = databasePath(context.config, database.component);
      const stage = staged.get(database.component);
      if (stage === undefined) throw new Error("Restore staging set is incomplete.");
      const preserved: Array<[string, string]> = [];
      for (const suffix of ["", "-wal", "-shm"] as const) {
        const current = `${target}${suffix}`;
        if (!existsSync(current)) continue;
        const preservedPath = join(
          recoveryPath,
          `${database.component}${suffix === "" ? ".db" : suffix}`,
        );
        renameSync(current, preservedPath);
        preserved.push([current, preservedPath]);
      }
      switched.push({ target, preserved });
      renameSync(stage, target);
    }

    for (const database of manifest.databases) {
      verifyDatabase(databasePath(context.config, database.component), database.component, true);
    }
    writeFileSync(
      join(recoveryPath, "restore.json"),
      `${JSON.stringify(
        {
          version: 1,
          restoredAt: new Date().toISOString(),
          backupId: manifest.backupId,
          configRestored: false,
        },
        null,
        2,
      )}\n`,
      { flag: "wx", mode: 0o600 },
    );
    return { backupId: manifest.backupId, recoveryPath };
  } catch (error) {
    for (const item of switched.reverse()) {
      removeDatabaseFiles(item.target);
      for (const [target, preserved] of item.preserved.reverse()) {
        if (existsSync(preserved)) renameSync(preserved, target);
      }
    }
    throw error;
  } finally {
    for (const stage of staged.values()) rmSync(stage, { force: true });
  }
}

export async function migrateConfiguredDatabases(
  options: MaintenanceOptions & { requireStopped?: boolean },
): Promise<MigrationResult> {
  const context = loadContext(options);
  if (options.requireStopped !== false) await assertMaintenanceStopped(context);
  const migrationRoot = options.migrationRoot ?? options.repositoryRoot;
  const coreMigrations = join(migrationRoot, "apps", "core", "migrations");
  const connectorMigrations = join(migrationRoot, "apps", "connector", "migrations");
  const coreBefore = inspectSchemaVersion(context.config.paths.coreDatabase);
  const connectorBefore = inspectSchemaVersion(context.config.paths.connectorDatabase);
  assertSupportedVersion("Core", coreBefore, CORE_SCHEMA_VERSION);
  assertSupportedVersion("Connector", connectorBefore, CONNECTOR_SCHEMA_VERSION);
  const existingUpgrade =
    (existsSync(context.config.paths.coreDatabase) && coreBefore < CORE_SCHEMA_VERSION) ||
    (existsSync(context.config.paths.connectorDatabase) &&
      connectorBefore < CONNECTOR_SCHEMA_VERSION);
  let migrationBackup: BackupResult | undefined;
  if (existingUpgrade) {
    migrationBackup = await createBackupForContext(context, {
      ...options,
      reason: "pre-migration",
      allowMissingCore: true,
    });
  }
  applyMigrations(
    context.config.paths.coreDatabase,
    coreMigrations,
    "core",
    CORE_SCHEMA_VERSION,
  );
  applyMigrations(
    context.config.paths.connectorDatabase,
    connectorMigrations,
    "connector",
    CONNECTOR_SCHEMA_VERSION,
  );
  verifyDatabase(context.config.paths.coreDatabase, "core", true);
  verifyDatabase(context.config.paths.connectorDatabase, "connector", true);
  return {
    coreSchemaVersion: CORE_SCHEMA_VERSION,
    connectorSchemaVersion: CONNECTOR_SCHEMA_VERSION,
    ...(migrationBackup === undefined
      ? {}
      : { backupPath: migrationBackup.backupPath }),
    migrated:
      coreBefore !== CORE_SCHEMA_VERSION ||
      connectorBefore !== CONNECTOR_SCHEMA_VERSION,
  };
}

async function createBackupForContext(
  context: LoadedMaintenanceContext,
  options: BackupOptions,
): Promise<BackupResult> {
  const retentionCount = options.retentionCount ?? DEFAULT_RETENTION_COUNT;
  if (!Number.isSafeInteger(retentionCount) || retentionCount < 1 || retentionCount > 365) {
    throw new Error("Backup retention count must be between 1 and 365.");
  }
  if (!existsSync(context.config.paths.coreDatabase) && options.allowMissingCore !== true) {
    throw new Error("Core database does not exist; run migrations before manual backup.");
  }
  const createdAt = (options.now ?? new Date()).toISOString();
  const backupId = `aicl-backup-${createdAt.replace(/[^0-9]/gu, "")}-${randomUUID().slice(0, 8)}`;
  const backupRoot = context.config.paths.backups;
  const temporaryPath = join(backupRoot, `.${backupId}.${process.pid}.tmp`);
  const finalPath = join(backupRoot, backupId);
  mkdirSync(temporaryPath, { recursive: false, mode: 0o700 });
  try {
    const configTarget = join(temporaryPath, "config.json");
    copyFileSync(context.configPath, configTarget);
    const databases: DatabaseManifest[] = [];
    for (const component of ["core", "connector"] as const) {
      const source = databasePath(context.config, component);
      if (!existsSync(source)) continue;
      const fileName = databaseFileName(component);
      const target = join(temporaryPath, fileName);
      await backupDatabase(source, target);
      const verified = verifyDatabase(target, component, true);
      databases.push({
        component,
        fileName,
        sha256: await sha256File(target),
        bytes: statSync(target).size,
        schemaVersion: verified.schemaVersion,
        sqliteVersion: verified.sqliteVersion,
        sqliteSourceId: verified.sqliteSourceId,
        integrity: "ok",
      });
    }
    if (databases.length === 0) throw new Error("No SQLite database exists to back up.");
    const manifest = BackupManifestSchema.parse({
      version: BACKUP_VERSION,
      backupId,
      reason: options.reason ?? "manual",
      createdAt,
      verifiedAt: new Date().toISOString(),
      encryptionPolicy: "host-volume-or-external",
      config: {
        fileName: "config.json",
        sha256: await sha256File(configTarget),
        bytes: statSync(configTarget).size,
      },
      databases,
    });
    writeFileSync(
      join(temporaryPath, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    renameSync(temporaryPath, finalPath);
    const pruned = pruneBackupSets(backupRoot, retentionCount);
    return { backupPath: finalPath, manifest, pruned };
  } catch (error) {
    rmSync(temporaryPath, { recursive: true, force: true });
    throw error;
  }
}

async function backupDatabase(sourcePath: string, targetPath: string) {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(source, targetPath, { rate: 128 });
  } finally {
    source.close();
  }
}

function verifyDatabase(
  path: string,
  component: DatabaseComponent,
  fullIntegrity: boolean,
): VerifiedDatabase {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const integrityRows = database
      .prepare(fullIntegrity ? "PRAGMA integrity_check" : "PRAGMA quick_check")
      .all() as unknown as Array<Record<string, unknown>>;
    if (
      integrityRows.length !== 1 ||
      String(Object.values(integrityRows[0] ?? {})[0]).toLowerCase() !== "ok"
    ) {
      throw new Error(`${component} database integrity check failed.`);
    }
    const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length !== 0) {
      throw new Error(`${component} database foreign-key check failed.`);
    }
    const schemaVersion = schemaVersionFromDatabase(database);
    if (component === "core") verifyCoreInvariants(database, schemaVersion);
    else verifyConnectorInvariants(database, schemaVersion);
    const sqlite = database
      .prepare("SELECT sqlite_version() AS version, sqlite_source_id() AS sourceId")
      .get() as { version: string; sourceId: string };
    return {
      schemaVersion,
      sqliteVersion: sqlite.version,
      sqliteSourceId: sqlite.sourceId,
    };
  } finally {
    database.close();
  }
}

function verifyCoreInvariants(database: DatabaseSync, schemaVersion: number) {
  if (schemaVersion === 0 || !tableExists(database, "sessions")) return;
  const brokenSequence = database
    .prepare(
      `SELECT s.id
         FROM sessions s
         LEFT JOIN (
           SELECT session_id, COUNT(*) AS event_count, MAX(seq) AS max_seq
             FROM session_events GROUP BY session_id
         ) e ON e.session_id = s.id
        WHERE s.last_event_seq <> COALESCE(e.max_seq, 0)
           OR COALESCE(e.event_count, 0) <> COALESCE(e.max_seq, 0)
        LIMIT 1`,
    )
    .get();
  if (brokenSequence !== undefined) {
    throw new Error("Core durable event sequence invariant failed.");
  }
  const duplicateTurn = database
    .prepare(
      `SELECT session_id FROM turns WHERE state = 'running'
        GROUP BY session_id HAVING COUNT(*) > 1 LIMIT 1`,
    )
    .get();
  if (duplicateTurn !== undefined) {
    throw new Error("Core one-running-Turn invariant failed.");
  }
  const duplicateRuntime = database
    .prepare(
      `SELECT session_id FROM runtimes WHERE state IN ('ready', 'busy')
        GROUP BY session_id HAVING COUNT(*) > 1 LIMIT 1`,
    )
    .get();
  if (duplicateRuntime !== undefined) {
    throw new Error("Core one-active-Runtime invariant failed.");
  }
}

function verifyConnectorInvariants(database: DatabaseSync, schemaVersion: number) {
  if (schemaVersion < 2 || !tableExists(database, "outbox_events")) return;
  const duplicateSequence = database
    .prepare(
      `SELECT journal_seq FROM outbox_events
        GROUP BY journal_seq HAVING COUNT(*) > 1 LIMIT 1`,
    )
    .get();
  if (duplicateSequence !== undefined) {
    throw new Error("Connector journal sequence invariant failed.");
  }
}

function applyMigrations(
  path: string,
  directory: string,
  component: DatabaseComponent,
  targetVersion: number,
) {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(directory)) throw new Error(`${component} migration directory is missing.`);
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("PRAGMA trusted_schema = OFF");
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = FULL");
    database.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version INTEGER PRIMARY KEY,
         name TEXT NOT NULL,
         applied_at TEXT NOT NULL
       ) STRICT`,
    );
    const migrations = readMigrations(directory);
    for (const migration of migrations) {
      const prior = database
        .prepare("SELECT name FROM schema_migrations WHERE version = ?")
        .get(migration.version) as { name: string } | undefined;
      if (prior !== undefined) {
        if (prior.name !== migration.name) {
          throw new Error(`${component} migration ledger mismatch at version ${migration.version}.`);
        }
        continue;
      }
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(migration.sql);
        database
          .prepare(
            "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
          )
          .run(migration.version, migration.name, new Date().toISOString());
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
    const version = schemaVersionFromDatabase(database);
    if (version !== targetVersion) {
      throw new Error(`${component} schema ${version} does not match ${targetVersion}.`);
    }
    verifyAndFillMigrationChecksums(database, component, migrations);
  } finally {
    database.close();
  }
}

function readMigrations(directory: string) {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => {
      const version = Number.parseInt(name.split("_")[0] ?? "", 10);
      if (!Number.isSafeInteger(version)) throw new Error(`Invalid migration name: ${name}`);
      const sql = readFileSync(join(directory, name), "utf8");
      return {
        version,
        name,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    });
}

function verifyAndFillMigrationChecksums(
  database: DatabaseSync,
  component: DatabaseComponent,
  migrations: ReturnType<typeof readMigrations>,
) {
  const columns = database
    .prepare("PRAGMA table_info(schema_migrations)")
    .all() as unknown as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "checksum")) {
    throw new Error(`${component} migration checksum column is missing.`);
  }
  const missing: Array<{ version: number; checksum: string }> = [];
  for (const migration of migrations) {
    const row = database
      .prepare("SELECT name, checksum FROM schema_migrations WHERE version = ?")
      .get(migration.version) as { name: string; checksum: string | null } | undefined;
    if (row === undefined || row.name !== migration.name) {
      throw new Error(`${component} migration ledger mismatch at version ${migration.version}.`);
    }
    if (row.checksum === null) missing.push(migration);
    else if (row.checksum !== migration.checksum) {
      throw new Error(`${component} migration checksum mismatch: ${migration.name}`);
    }
  }
  if (missing.length === 0) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    const update = database.prepare(
      "UPDATE schema_migrations SET checksum = ? WHERE version = ? AND checksum IS NULL",
    );
    for (const migration of missing) update.run(migration.checksum, migration.version);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function inspectSchemaVersion(path: string) {
  if (!existsSync(path)) return 0;
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return schemaVersionFromDatabase(database);
  } finally {
    database.close();
  }
}

function schemaVersionFromDatabase(database: DatabaseSync) {
  if (!tableExists(database, "schema_migrations")) return 0;
  return (
    database
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get() as { version: number }
  ).version;
}

function tableExists(database: DatabaseSync, name: string) {
  return (
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

function assertSupportedVersion(label: string, current: number, supported: number) {
  if (current > supported) {
    throw new Error(`${label} database schema ${current} is newer than supported ${supported}.`);
  }
}

function loadContext(options: MaintenanceOptions): LoadedMaintenanceContext {
  return loadAiclConfig({
    repositoryRoot: options.repositoryRoot,
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
  });
}

async function assertMaintenanceStopped(context: LoadedMaintenanceContext) {
  const statePath = join(context.applicationRoot, "run", "production-state.json");
  if (existsSync(statePath)) {
    throw new Error("AICL production must be stopped before migration or restore.");
  }
  await assertTcpPortAvailable(context.config.core.host, context.config.core.port, "Core");
  await assertTcpPortAvailable(
    "127.0.0.1",
    context.config.connector.healthPort,
    "Connector",
  );
}

function databasePath(config: AiclConfig, component: DatabaseComponent) {
  return component === "core"
    ? config.paths.coreDatabase
    : config.paths.connectorDatabase;
}

function databaseFileName(component: DatabaseComponent) {
  return component === "core" ? "aicl-core.db" : "aicl-connector.db";
}

function containedBackupDirectory(backupRoot: string, requestedPath: string) {
  if (!existsSync(requestedPath) || !statSync(requestedPath).isDirectory()) {
    throw new Error("Backup path does not exist or is not a directory.");
  }
  if (lstatSync(requestedPath).isSymbolicLink()) {
    throw new Error("Backup path must not be a symbolic link or junction.");
  }
  const root = realpathSync.native(backupRoot);
  const candidate = realpathSync.native(resolve(requestedPath));
  const suffix = relative(normalizeCase(root), normalizeCase(candidate));
  if (suffix.startsWith("..") || isAbsolute(suffix)) {
    throw new Error("Backup path is outside the configured backup directory.");
  }
  return candidate;
}

function normalizeCase(path: string) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function pruneBackupSets(backupRoot: string, retentionCount: number) {
  const candidates = readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("aicl-backup-"))
    .map((entry) => join(backupRoot, entry.name))
    .filter((path) => isOwnedBackupSet(path))
    .sort((left, right) => right.localeCompare(left));
  const pruned: string[] = [];
  for (const path of candidates.slice(retentionCount)) {
    const contained = containedBackupDirectory(backupRoot, path);
    rmSync(contained, { recursive: true, force: true });
    pruned.push(basename(contained));
  }
  return pruned;
}

function isOwnedBackupSet(path: string) {
  try {
    if (lstatSync(path).isSymbolicLink()) return false;
    const manifest = BackupManifestSchema.parse(
      JSON.parse(readFileSync(join(path, "manifest.json"), "utf8")) as unknown,
    );
    return manifest.backupId === basename(path);
  } catch {
    return false;
  }
}

function removeDatabaseFiles(path: string) {
  for (const suffix of ["", "-wal", "-shm"] as const) {
    rmSync(`${path}${suffix}`, { force: true });
  }
}

async function assertFileMetadata(
  path: string,
  expectedHash: string,
  expectedBytes: number,
  label: string,
) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} file is missing.`);
  }
  if (statSync(path).size !== expectedBytes || (await sha256File(path)) !== expectedHash) {
    throw new Error(`${label} hash or size does not match the manifest.`);
  }
}

async function sha256File(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
