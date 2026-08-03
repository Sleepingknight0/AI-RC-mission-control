import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import {
  ConnectorEnvelopeSchema,
  type ConnectorEnvelope,
  type CoreToConnectorEnvelope,
  type Runtime,
} from "@aicl/protocol";

export const CONNECTOR_SCHEMA_VERSION = 3;
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

export const DEFAULT_CONNECTOR_JOURNAL_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../.data/aicl-connector.db",
);

export interface ConnectorJournalOptions {
  path: string;
  migrationDirectory?: string;
  connectorId?: string;
  runtimeId?: string;
  runtimeGeneration?: number;
}

export type InboxDecision = "new" | "same" | "conflict";

interface MetadataRow {
  value: string;
}

interface InboxRow {
  payload_hash: string;
}

interface ReceiptRow {
  command_id: string;
  state: "received" | "dispatching" | "completed" | "outcome_unknown";
}

export class ConnectorJournal {
  readonly connectorId: string;
  readonly bootId: string;
  readonly runtimeId: string;
  readonly runtimeGeneration: number;
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(options: ConnectorJournalOptions) {
    if (options.path !== ":memory:") {
      mkdirSync(dirname(resolve(options.path)), { recursive: true });
    }
    this.#database = new DatabaseSync(options.path);
    this.#configure();
    this.#migrate(options.migrationDirectory ?? migrationsDirectory);
    this.connectorId =
      options.connectorId ?? this.#metadata("connector_id") ?? `connector-${crypto.randomUUID()}`;
    this.bootId = `boot-${crypto.randomUUID()}`;
    const priorGeneration = Number(this.#metadata("last_runtime_generation") ?? "0");
    this.runtimeGeneration =
      options.runtimeGeneration ?? Math.max(1, priorGeneration + 1);
    this.runtimeId = options.runtimeId ?? `runtime-${crypto.randomUUID()}`;
    this.#setMetadata("connector_id", this.connectorId);
    this.#setMetadata("current_boot_id", this.bootId);
    this.#setMetadata("last_runtime_generation", String(this.runtimeGeneration));
  }

  get schemaVersion() {
    const row = this.#database
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get() as { version: number };
    return row.version;
  }

  pragma(name: "journal_mode" | "foreign_keys" | "busy_timeout") {
    return this.#database.prepare(`PRAGMA ${name}`).get() as Record<
      string,
      SQLInputValue
    >;
  }

  recordCommand(
    command: Extract<
      CoreToConnectorEnvelope,
      {
        type:
          | "connector.turn.start"
          | "connector.turn.interrupt"
          | "connector.approval.resolve";
      }
    >,
  ): InboxDecision {
    const hash = envelopeHash(command);
    const prior = this.#database
      .prepare("SELECT payload_hash FROM inbox_commands WHERE command_id = ?")
      .get(command.payload.commandId) as InboxRow | undefined;
    if (prior !== undefined) return prior.payload_hash === hash ? "same" : "conflict";
    const now = new Date().toISOString();
    this.#database
      .prepare(
        `INSERT INTO inbox_commands (
           command_id, payload_hash, envelope_json, state, received_at, updated_at
         ) VALUES (?, ?, ?, 'received', ?, ?)`,
      )
      .run(
        command.payload.commandId,
        hash,
        JSON.stringify(command),
        now,
        now,
      );
    return "new";
  }

  markCommand(
    commandId: string,
    state: "dispatching" | "completed" | "outcome_unknown",
    result?: unknown,
  ) {
    this.#database
      .prepare(
        `UPDATE inbox_commands SET state = ?, result_json = ?, updated_at = ?
          WHERE command_id = ?`,
      )
      .run(
        state,
        result === undefined ? null : JSON.stringify(result),
        new Date().toISOString(),
        commandId,
      );
  }

  enqueue(envelope: ConnectorEnvelope, runtime: Runtime): ConnectorEnvelope {
    const sourceEventId = `source-${crypto.randomUUID()}`;
    const durable = ConnectorEnvelopeSchema.parse({
      ...envelope,
      connectorId: this.connectorId,
      bootId: this.bootId,
      sourceEventId,
      runtimeId: runtime.runtimeId,
      runtimeGeneration: runtime.generation,
    });
    this.#database
      .prepare(
        `INSERT INTO outbox_events (
           source_event_id, connector_id, runtime_id, runtime_generation,
           envelope_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sourceEventId,
        this.connectorId,
        runtime.runtimeId,
        runtime.generation,
        JSON.stringify(durable),
        new Date().toISOString(),
      );
    return durable;
  }

  pendingEvents() {
    return this.#database
      .prepare(
        `SELECT envelope_json FROM outbox_events
          WHERE acknowledged_at IS NULL ORDER BY journal_seq`,
      )
      .all()
      .map((row) =>
        ConnectorEnvelopeSchema.parse(
          JSON.parse((row as { envelope_json: string }).envelope_json),
        ),
      );
  }

  acknowledge(sourceEventId: string) {
    this.#database
      .prepare(
        `UPDATE outbox_events SET acknowledged_at = ?
          WHERE source_event_id = ? AND acknowledged_at IS NULL`,
      )
      .run(new Date().toISOString(), sourceEventId);
  }

  checkpoint(runtime: Runtime, providerSessionId?: string) {
    this.#database
      .prepare(
        `INSERT INTO runtime_checkpoints (
           runtime_id, connector_id, boot_id, generation, provider_session_id,
           state, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(runtime_id) DO UPDATE SET
           provider_session_id = COALESCE(excluded.provider_session_id, provider_session_id),
           state = excluded.state,
           updated_at = excluded.updated_at`,
      )
      .run(
        runtime.runtimeId,
        this.connectorId,
        this.bootId,
        runtime.generation,
        providerSessionId ?? null,
        runtime.status,
        new Date().toISOString(),
      );
  }

  unacknowledgedCount() {
    return (
      this.#database
        .prepare(
          "SELECT COUNT(*) AS count FROM outbox_events WHERE acknowledged_at IS NULL",
        )
        .get() as { count: number }
    ).count;
  }

  commandReceipts() {
    return (
      this.#database
        .prepare(
          `SELECT command_id, state FROM inbox_commands
            ORDER BY received_at DESC, command_id DESC LIMIT 1000`,
        )
        .all() as unknown as ReceiptRow[]
    ).map((row) => ({ commandId: row.command_id, state: row.state }));
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  #configure() {
    const version = (
      this.#database.prepare("SELECT sqlite_version() AS version").get() as {
        version: string;
      }
    ).version;
    if (compareVersions(version, "3.37.0") < 0) {
      throw new Error(`SQLite ${version} is too old; 3.37.0+ is required.`);
    }
    const json = this.#database
      .prepare("SELECT json_valid('{}') AS available")
      .get() as { available: number };
    if (json.available !== 1) throw new Error("SQLite JSON functions are required.");
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA busy_timeout = 5000");
    this.#database.exec("PRAGMA trusted_schema = OFF");
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA synchronous = FULL");
    this.#database.exec("PRAGMA wal_autocheckpoint = 1000");
  }

  #migrate(directory: string) {
    this.#database.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version INTEGER PRIMARY KEY,
         name TEXT NOT NULL,
         applied_at TEXT NOT NULL
       ) STRICT`,
    );
    if (!existsSync(directory)) throw new Error(`Migration directory missing: ${directory}`);
    const names = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();
    for (const name of names) {
      const version = Number.parseInt(name.split("_")[0] ?? "", 10);
      if (!Number.isSafeInteger(version)) throw new Error(`Invalid migration name: ${name}`);
      const applied = this.#database
        .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
        .get(version);
      if (applied !== undefined) continue;
      this.#database.exec("BEGIN IMMEDIATE");
      try {
        this.#database.exec(readFileSync(join(directory, name), "utf8"));
        this.#database
          .prepare(
            "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
          )
          .run(version, name, new Date().toISOString());
        this.#database.exec("COMMIT");
      } catch (error) {
        this.#database.exec("ROLLBACK");
        throw error;
      }
    }
    if (this.schemaVersion !== CONNECTOR_SCHEMA_VERSION) {
      throw new Error(
        `Connector database schema ${this.schemaVersion} does not match ${CONNECTOR_SCHEMA_VERSION}.`,
      );
    }
    this.#verifyMigrationChecksums(directory, names);
  }

  #verifyMigrationChecksums(directory: string, names: readonly string[]) {
    const columns = this.#database
      .prepare("PRAGMA table_info(schema_migrations)")
      .all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "checksum")) {
      throw new Error("Connector schema_migrations checksum column is missing.");
    }
    const missing: Array<{ version: number; checksum: string }> = [];
    for (const name of names) {
      const version = Number.parseInt(name.split("_")[0] ?? "", 10);
      const checksum = createHash("sha256")
        .update(readFileSync(join(directory, name)))
        .digest("hex");
      const applied = this.#database
        .prepare("SELECT name, checksum FROM schema_migrations WHERE version = ?")
        .get(version) as { name: string; checksum: string | null } | undefined;
      if (applied === undefined || applied.name !== name) {
        throw new Error(`Connector migration ledger mismatch at version ${version}.`);
      }
      if (applied.checksum === null) {
        missing.push({ version, checksum });
      } else if (applied.checksum !== checksum) {
        throw new Error(`Connector migration checksum mismatch: ${name}`);
      }
    }
    if (missing.length === 0) return;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const update = this.#database.prepare(
        "UPDATE schema_migrations SET checksum = ? WHERE version = ? AND checksum IS NULL",
      );
      for (const item of missing) update.run(item.checksum, item.version);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #metadata(key: string) {
    return (
      this.#database
        .prepare("SELECT value FROM journal_metadata WHERE key = ?")
        .get(key) as MetadataRow | undefined
    )?.value;
  }

  #setMetadata(key: string, value: string) {
    this.#database
      .prepare(
        `INSERT INTO journal_metadata (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }
}

function envelopeHash(envelope: CoreToConnectorEnvelope) {
  return createHash("sha256")
    .update(JSON.stringify({ type: envelope.type, payload: envelope.payload }))
    .digest("hex");
}

function compareVersions(left: string, right: string) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
