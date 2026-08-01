import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import {
  ServerEnvelopeSchema,
  makeEnvelope,
  type ClientEnvelope,
  type ConnectorEnvelope,
  type Runtime,
  type ServerEnvelope,
  type SessionSnapshot,
  type Turn,
} from "@aicl/protocol";

const CORE_SCHEMA_VERSION = 1;
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

type MutationResult =
  | { kind: "same"; result: ServerEnvelope }
  | { kind: "conflict" }
  | {
      kind: "new";
      result: ServerEnvelope;
      durableEvent?: ServerEnvelope;
    };

export interface ConnectorSource {
  connectorId: string;
  sourceEventId: string;
  runtimeId: string;
  runtimeGeneration: number;
}

export interface CoreDatabaseOptions {
  path: string;
  migrationDirectory?: string;
}

interface CommandRow {
  payload_hash: string;
  result_json: string;
}

interface SessionRow {
  id: string;
  provider_session_id: string | null;
  state_revision: number;
  last_event_seq: number;
}

interface TurnRow {
  id: string;
  client_command_id: string;
  provider_turn_id: string | null;
  state: Turn["status"];
  revision: number;
  prompt: string;
  started_at: string;
  completed_at: string | null;
  failure_code: string | null;
}

interface MessageRow {
  id: string;
  turn_id: string;
  content: string;
  completed: number;
}

interface RuntimeRow {
  id: string;
  generation: number;
  state: Runtime["status"];
}

export class CoreDatabase {
  readonly #database: DatabaseSync;
  #writerTail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: CoreDatabaseOptions) {
    if (options.path !== ":memory:") {
      mkdirSync(dirname(resolve(options.path)), { recursive: true });
    }
    this.#database = new DatabaseSync(options.path);
    this.#configure();
    this.#migrate(options.migrationDirectory ?? migrationsDirectory);
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

  async ensureSession(sessionId: string) {
    await this.#write(() => this.#ensureSession(sessionId));
  }

  snapshot(sessionId: string): SessionSnapshot {
    const session = this.#database
      .prepare(
        "SELECT id, provider_session_id, state_revision, last_event_seq FROM sessions WHERE id = ?",
      )
      .get(sessionId) as SessionRow | undefined;
    if (session === undefined) {
      return {
        sessionId,
        revision: 0,
        lastEventSeq: 0,
        activeTurnId: null,
        providerSessionId: null,
        turns: [],
        messages: [],
      };
    }
    const turns = this.#database
      .prepare(
        `SELECT id, client_command_id, provider_turn_id, state, revision, prompt,
                started_at, completed_at, failure_code
           FROM turns WHERE session_id = ? ORDER BY created_at, id`,
      )
      .all(sessionId) as unknown as TurnRow[];
    const messages = this.#database
      .prepare(
        `SELECT id, turn_id, content, completed
           FROM assistant_messages WHERE session_id = ? ORDER BY created_at, id`,
      )
      .all(sessionId) as unknown as MessageRow[];
    const active = turns.find((turn) => turn.state === "running");
    return {
      sessionId,
      revision: session.state_revision,
      lastEventSeq: session.last_event_seq,
      activeTurnId: active?.id ?? null,
      providerSessionId: session.provider_session_id,
      turns: turns.map((turn) => ({
        turnId: turn.id,
        commandId: turn.client_command_id,
        status: turn.state,
        prompt: turn.prompt,
        startedAt: turn.started_at,
        completedAt: turn.completed_at,
        failureCode: turn.failure_code,
        providerTurnId: turn.provider_turn_id,
      })),
      messages: messages.map((message) => ({
        messageId: message.id,
        turnId: message.turn_id,
        content: message.content,
        completed: message.completed === 1,
      })),
    };
  }

  replay(sessionId: string, afterSeq: number, upperBoundSeq: number) {
    return this.#database
      .prepare(
        `SELECT envelope_json FROM session_events
          WHERE session_id = ? AND seq > ? AND seq <= ? AND envelope_json IS NOT NULL
          ORDER BY seq`,
      )
      .all(sessionId, afterSeq, upperBoundSeq)
      .map((row) =>
        ServerEnvelopeSchema.parse(
          JSON.parse((row as { envelope_json: string }).envelope_json),
        ),
      );
  }

  latestRuntime(): Runtime | undefined {
    const row = this.#database
      .prepare(
        `SELECT id, generation, state FROM runtimes
          ORDER BY updated_at DESC, generation DESC LIMIT 1`,
      )
      .get() as RuntimeRow | undefined;
    return row === undefined
      ? undefined
      : { runtimeId: row.id, generation: row.generation, status: row.state };
  }

  activeSnapshots() {
    const sessions = this.#database
      .prepare("SELECT DISTINCT session_id FROM turns WHERE state = 'running'")
      .all() as unknown as Array<{ session_id: string }>;
    return sessions.map((row) => this.snapshot(row.session_id));
  }

  acceptsRuntimeEvent(
    sessionId: string,
    turnId: string,
    runtimeId: string,
    runtimeGeneration: number,
  ) {
    return this.#matchesRuntimeEvent(
      sessionId,
      turnId,
      runtimeId,
      runtimeGeneration,
      ["running"],
    );
  }

  acceptsSessionRuntime(
    sessionId: string,
    runtimeId: string,
    runtimeGeneration: number,
  ) {
    return (
      this.#database
        .prepare(
          `SELECT 1 AS ok FROM turns
            WHERE session_id = ? AND state = 'running'
              AND runtime_id = ? AND runtime_generation = ?`,
        )
        .get(sessionId, runtimeId, runtimeGeneration) !== undefined
    );
  }

  priorCommand(
    message: Extract<ClientEnvelope, { type: "turn.submit" | "turn.interrupt" }>,
  ): Exclude<MutationResult, { kind: "new" }> | undefined {
    const prior = this.#command(message.payload.commandId);
    if (prior === undefined) return undefined;
    return prior.payload_hash === commandHash(message)
      ? { kind: "same", result: parseServer(prior.result_json) }
      : { kind: "conflict" };
  }

  async acceptTurn(input: {
    message: Extract<ClientEnvelope, { type: "turn.submit" }>;
    turnId: string;
    runtime: Runtime;
    connectorId: string;
    bootId: string;
    activeRejection: ServerEnvelope;
  }): Promise<MutationResult> {
    return this.#write(() => {
      const payloadHash = commandHash(input.message);
      const prior = this.#command(input.message.payload.commandId);
      if (prior !== undefined) {
        return prior.payload_hash === payloadHash
          ? { kind: "same", result: parseServer(prior.result_json) }
          : { kind: "conflict" };
      }
      const now = new Date().toISOString();
      this.#ensureSession(input.message.payload.sessionId, now);
      const active = this.#database
        .prepare("SELECT id FROM turns WHERE session_id = ? AND state = 'running'")
        .get(input.message.payload.sessionId);
      if (active !== undefined) {
        this.#insertCommand(
          input.message,
          payloadHash,
          "rejected",
          input.activeRejection,
          now,
        );
        return { kind: "new", result: input.activeRejection };
      }

      this.#attachRuntime(
        input.message.payload.sessionId,
        input.runtime,
        input.connectorId,
        input.bootId,
        now,
      );
      const accepted = parseServer(
        JSON.stringify(
          makeEnvelope("command.accepted", {
            commandId: input.message.payload.commandId,
            sessionId: input.message.payload.sessionId,
            turnId: input.turnId,
          }),
        ),
      );
      this.#insertCommand(input.message, payloadHash, "committed", accepted, now);
      this.#database
        .prepare(
          `INSERT INTO turns (
             id, session_id, runtime_id, runtime_generation, client_command_id,
             state, prompt, started_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
        )
        .run(
          input.turnId,
          input.message.payload.sessionId,
          input.runtime.runtimeId,
          input.runtime.generation,
          input.message.payload.commandId,
          input.message.payload.prompt,
          now,
          now,
          now,
        );
      const durableEvent = this.#appendVisibleEvent({
        sessionId: input.message.payload.sessionId,
        origin: "core",
        runtime: input.runtime,
        turnId: input.turnId,
        type: "turn.started",
        payload: (identity) => ({
          sessionId: input.message.payload.sessionId,
          turn: this.snapshot(input.message.payload.sessionId).turns.at(-1)!,
          ...identity,
        }),
        now,
      });
      return { kind: "new", result: accepted, durableEvent };
    });
  }

  async acceptInterrupt(input: {
    message: Extract<ClientEnvelope, { type: "turn.interrupt" }>;
    accepted: ServerEnvelope;
  }): Promise<MutationResult> {
    return this.#write(() => {
      const payloadHash = commandHash(input.message);
      const prior = this.#command(input.message.payload.commandId);
      if (prior !== undefined) {
        return prior.payload_hash === payloadHash
          ? { kind: "same", result: parseServer(prior.result_json) }
          : { kind: "conflict" };
      }
      const now = new Date().toISOString();
      this.#ensureSession(input.message.payload.sessionId, now);
      this.#insertCommand(input.message, payloadHash, "committed", input.accepted, now);
      return { kind: "new", result: input.accepted };
    });
  }

  async recordRejectedCommand(
    message: Extract<ClientEnvelope, { type: "turn.submit" | "turn.interrupt" }>,
    result: ServerEnvelope,
  ): Promise<MutationResult> {
    return this.#write(() => {
      const payloadHash = commandHash(message);
      const prior = this.#command(message.payload.commandId);
      if (prior !== undefined) {
        return prior.payload_hash === payloadHash
          ? { kind: "same", result: parseServer(prior.result_json) }
          : { kind: "conflict" };
      }
      const now = new Date().toISOString();
      this.#ensureSession(message.payload.sessionId, now);
      this.#insertCommand(message, payloadHash, "rejected", result, now);
      return { kind: "new", result };
    });
  }

  async markDispatched(commandId: string) {
    await this.#write(() => {
      this.#database
        .prepare(
          `UPDATE commands SET state = 'dispatched', dispatch_attempts = dispatch_attempts + 1
            WHERE command_id = ? AND state = 'committed'`,
        )
        .run(commandId);
    });
  }

  async bindProviderSession(
    sessionId: string,
    providerSessionId: string,
    source: ConnectorSource,
  ) {
    return this.#ingestSource(source, () => {
      if (
        !this.acceptsSessionRuntime(
          sessionId,
          source.runtimeId,
          source.runtimeGeneration,
        )
      ) {
        return undefined;
      }
      const now = new Date().toISOString();
      this.#database
        .prepare(
          `UPDATE sessions SET provider_session_id = ?, state_revision = state_revision + 1,
             updated_at = ? WHERE id = ? AND provider_session_id IS NOT ?`,
        )
        .run(providerSessionId, now, sessionId, providerSessionId);
      this.#appendInternalEvent(
        sessionId,
        "session.provider_bound",
        { providerSessionId },
        source,
        null,
        now,
      );
      return undefined;
    });
  }

  async bindProviderTurn(
    sessionId: string,
    turnId: string,
    providerTurnId: string,
    source: ConnectorSource,
  ) {
    return this.#ingestSource(source, () => {
      if (!this.acceptsRuntimeEvent(sessionId, turnId, source.runtimeId, source.runtimeGeneration)) {
        return undefined;
      }
      const now = new Date().toISOString();
      this.#database
        .prepare(
          `UPDATE turns SET provider_turn_id = ?, revision = revision + 1, updated_at = ?
            WHERE id = ? AND session_id = ? AND state = 'running'`,
        )
        .run(providerTurnId, now, turnId, sessionId);
      this.#appendInternalEvent(
        sessionId,
        "turn.provider_bound",
        { providerTurnId },
        source,
        turnId,
        now,
      );
      return undefined;
    });
  }

  async completeMessage(
    message: Extract<ConnectorEnvelope, { type: "connector.turn.message.completed" }>,
    source: ConnectorSource,
  ) {
    return this.#ingestSource(source, () => {
      if (
        !this.#matchesRuntimeEvent(
          message.payload.sessionId,
          message.payload.turnId,
          source.runtimeId,
          source.runtimeGeneration,
          ["running", "outcome_unknown"],
        )
      ) {
        return undefined;
      }
      const now = new Date().toISOString();
      this.#database
        .prepare(
          `INSERT INTO assistant_messages (
             id, session_id, turn_id, content, completed, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             content = excluded.content, completed = 1, updated_at = excluded.updated_at`,
        )
        .run(
          message.payload.messageId,
          message.payload.sessionId,
          message.payload.turnId,
          message.payload.content,
          now,
          now,
        );
      return this.#appendVisibleEvent({
        sessionId: message.payload.sessionId,
        origin: "connector",
        runtime: {
          runtimeId: source.runtimeId,
          generation: source.runtimeGeneration,
          status: "busy",
        },
        turnId: message.payload.turnId,
        source,
        type: "assistant.message.completed",
        payload: (identity) => ({ ...message.payload, ...identity }),
        now,
      });
    });
  }

  async finishTurn(
    message: Extract<
      ConnectorEnvelope,
      {
        type:
          | "connector.turn.completed"
          | "connector.turn.interrupted"
          | "connector.turn.failed"
          | "connector.turn.outcome_unknown";
      }
    >,
    source: ConnectorSource,
  ) {
    return this.#ingestSource(source, () => {
      if (
        !this.#matchesRuntimeEvent(
          message.payload.sessionId,
          message.payload.turnId,
          source.runtimeId,
          source.runtimeGeneration,
          ["running", "outcome_unknown"],
        )
      ) {
        return undefined;
      }
      const now = new Date().toISOString();
      const status = terminalStatus(message.type);
      const failureCode =
        message.type === "connector.turn.failed"
          ? message.payload.failureCode
          : null;
      this.#database
        .prepare(
          `UPDATE turns SET state = ?, revision = revision + 1, completed_at = ?,
             failure_code = ?, updated_at = ?
            WHERE id = ? AND session_id = ? AND state IN ('running', 'outcome_unknown')`,
        )
        .run(
          status,
          now,
          failureCode,
          now,
          message.payload.turnId,
          message.payload.sessionId,
        );
      this.#database
        .prepare(
          `UPDATE commands SET state = 'terminal', terminal_at = ?
            WHERE command_id = (SELECT client_command_id FROM turns WHERE id = ?)`,
        )
        .run(now, message.payload.turnId);
      const serverType = terminalServerType(status);
      return this.#appendVisibleEvent({
        sessionId: message.payload.sessionId,
        origin: "connector",
        runtime: {
          runtimeId: source.runtimeId,
          generation: source.runtimeGeneration,
          status: "busy",
        },
        turnId: message.payload.turnId,
        source,
        type: serverType,
        payload: (identity) => ({
          sessionId: message.payload.sessionId,
          turnId: message.payload.turnId,
          ...(failureCode === null ? {} : { failureCode }),
          ...identity,
        }),
        now,
      });
    });
  }

  async updateRuntime(
    runtime: Runtime,
    source: ConnectorSource,
  ) {
    return this.#ingestSource(source, () => {
      const now = new Date().toISOString();
      const updated = this.#database
        .prepare(
          `UPDATE runtimes SET state = ?, revision = revision + 1, updated_at = ?
            WHERE id = ? AND generation = ? AND state <> 'lost'`,
        )
        .run(runtime.status, now, runtime.runtimeId, runtime.generation);
      if (Number(updated.changes) === 0) return undefined;
      const sessions = this.#database
        .prepare(
          "SELECT session_id FROM runtimes WHERE id = ? AND generation = ?",
        )
        .all(runtime.runtimeId, runtime.generation) as unknown as Array<{
        session_id: string;
      }>;
      for (const { session_id: sessionId } of sessions) {
        this.#appendInternalEvent(
          sessionId,
          "runtime.status",
          runtime,
          source,
          null,
          now,
        );
      }
      return undefined;
    });
  }

  async recordConnectorNotice(source: ConnectorSource) {
    return this.#ingestSource(source, () => true);
  }

  async reconcileRuntime(runtime: Runtime) {
    return this.#write(() => {
      const events = this.#markMismatchedRuntimesLost(runtime);
      this.#database
        .prepare(
          `UPDATE runtimes SET state = ?, revision = revision + 1, updated_at = ?
            WHERE id = ? AND generation = ?`,
        )
        .run(
          runtime.status,
          new Date().toISOString(),
          runtime.runtimeId,
          runtime.generation,
        );
      return events;
    });
  }

  async markRuntimeLost(runtime: Runtime) {
    return this.#write(() => this.#markMismatchedRuntimesLost(undefined, runtime));
  }

  async close() {
    if (this.#closed) return;
    await this.#writerTail;
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
    for (const name of readdirSync(directory).filter((file) => file.endsWith(".sql")).sort()) {
      const version = Number.parseInt(name.split("_")[0] ?? "", 10);
      if (!Number.isSafeInteger(version)) throw new Error(`Invalid migration name: ${name}`);
      const applied = this.#database
        .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
        .get(version);
      if (applied !== undefined) continue;
      this.#transaction(() => {
        this.#database.exec(readFileSync(join(directory, name), "utf8"));
        this.#database
          .prepare(
            "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
          )
          .run(version, name, new Date().toISOString());
      });
    }
    if (this.schemaVersion !== CORE_SCHEMA_VERSION) {
      throw new Error(
        `Core database schema ${this.schemaVersion} does not match ${CORE_SCHEMA_VERSION}.`,
      );
    }
  }

  #write<T>(operation: () => T): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("Core database is closed"));
    const result = this.#writerTail.then(() => this.#transaction(operation));
    this.#writerTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #ensureSession(sessionId: string, now = new Date().toISOString()) {
    this.#database
      .prepare(
        `INSERT INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(sessionId, now, now);
  }

  #command(commandId: string) {
    return this.#database
      .prepare("SELECT payload_hash, result_json FROM commands WHERE command_id = ?")
      .get(commandId) as CommandRow | undefined;
  }

  #matchesRuntimeEvent(
    sessionId: string,
    turnId: string,
    runtimeId: string,
    runtimeGeneration: number,
    states: Turn["status"][],
  ) {
    const placeholders = states.map(() => "?").join(", ");
    return (
      this.#database
        .prepare(
          `SELECT 1 AS ok FROM turns
            WHERE id = ? AND session_id = ? AND state IN (${placeholders})
              AND runtime_id = ? AND runtime_generation = ?`,
        )
        .get(
          turnId,
          sessionId,
          ...states,
          runtimeId,
          runtimeGeneration,
        ) !== undefined
    );
  }

  #insertCommand(
    message: Extract<ClientEnvelope, { type: "turn.submit" | "turn.interrupt" }>,
    payloadHash: string,
    state: string,
    result: ServerEnvelope,
    now: string,
  ) {
    this.#database
      .prepare(
        `INSERT INTO commands (
           command_id, session_id, command_type, state, payload_json, payload_hash,
           result_json, received_at, committed_at, terminal_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.payload.commandId,
        message.payload.sessionId,
        message.type,
        state,
        JSON.stringify(message.payload),
        payloadHash,
        JSON.stringify(result),
        now,
        now,
        state === "rejected" ? now : null,
      );
  }

  #attachRuntime(
    sessionId: string,
    runtime: Runtime,
    connectorId: string,
    bootId: string,
    now: string,
  ) {
    this.#database
      .prepare(
        `UPDATE runtimes SET state = 'lost', revision = revision + 1, updated_at = ?
          WHERE session_id = ? AND state IN ('ready', 'busy')
            AND (id <> ? OR generation <> ?)`,
      )
      .run(now, sessionId, runtime.runtimeId, runtime.generation);
    this.#database
      .prepare(
        `INSERT INTO runtimes (
           id, session_id, connector_id, connector_boot_id, generation, state,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           connector_id = excluded.connector_id,
           connector_boot_id = excluded.connector_boot_id,
           state = excluded.state,
           updated_at = excluded.updated_at`,
      )
      .run(
        runtime.runtimeId,
        sessionId,
        connectorId,
        bootId,
        runtime.generation,
        runtime.status,
        now,
        now,
      );
  }

  #appendVisibleEvent<T extends ServerEnvelope["type"]>(input: {
    sessionId: string;
    origin: "core" | "connector";
    runtime: Runtime | null;
    turnId: string | null;
    source?: ConnectorSource;
    type: T;
    payload: (
      identity: { eventId: string; seq: number },
    ) => Extract<ServerEnvelope, { type: T }>["payload"];
    now: string;
  }): Extract<ServerEnvelope, { type: T }> {
    const eventId = `event-${crypto.randomUUID()}`;
    const seq = this.#allocateSeq(input.sessionId, input.now);
    const envelope = ServerEnvelopeSchema.parse(
      makeEnvelope(input.type, input.payload({ eventId, seq })),
    ) as Extract<ServerEnvelope, { type: T }>;
    this.#insertEvent({
      eventId,
      sessionId: input.sessionId,
      seq,
      origin: input.origin,
      runtime: input.runtime,
      turnId: input.turnId,
      ...(input.source === undefined ? {} : { source: input.source }),
      eventType: input.type,
      payload: envelope.payload,
      envelope,
      now: input.now,
    });
    return envelope;
  }

  #appendInternalEvent(
    sessionId: string,
    eventType: string,
    payload: unknown,
    source: ConnectorSource,
    turnId: string | null,
    now: string,
  ) {
    const eventId = `event-${crypto.randomUUID()}`;
    const seq = this.#allocateSeq(sessionId, now);
    this.#insertEvent({
      eventId,
      sessionId,
      seq,
      origin: "connector",
      runtime: {
        runtimeId: source.runtimeId,
        generation: source.runtimeGeneration,
        status: "busy",
      },
      turnId,
      source,
      eventType,
      payload,
      envelope: null,
      now,
    });
  }

  #allocateSeq(sessionId: string, now: string) {
    const row = this.#database
      .prepare(
        `UPDATE sessions SET last_event_seq = last_event_seq + 1, updated_at = ?
          WHERE id = ? RETURNING last_event_seq`,
      )
      .get(now, sessionId) as { last_event_seq: number } | undefined;
    if (row === undefined) throw new Error(`Session not found: ${sessionId}`);
    return row.last_event_seq;
  }

  #insertEvent(input: {
    eventId: string;
    sessionId: string;
    seq: number;
    origin: "core" | "connector";
    runtime: Runtime | null;
    turnId: string | null;
    source?: ConnectorSource;
    eventType: string;
    payload: unknown;
    envelope: ServerEnvelope | null;
    now: string;
  }) {
    this.#database
      .prepare(
        `INSERT INTO session_events (
           event_id, session_id, seq, origin, runtime_id, runtime_generation,
           turn_id, source_connector_id, source_event_id, event_type,
           payload_json, envelope_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.eventId,
        input.sessionId,
        input.seq,
        input.origin,
        input.runtime?.runtimeId ?? null,
        input.runtime?.generation ?? null,
        input.turnId,
        input.source?.connectorId ?? null,
        input.source?.sourceEventId ?? null,
        input.eventType,
        JSON.stringify(input.payload),
        input.envelope === null ? null : JSON.stringify(input.envelope),
        input.now,
      );
  }

  #ingestSource<T>(source: ConnectorSource, operation: () => T): Promise<T | undefined> {
    return this.#write(() => {
      const claimed = this.#database
        .prepare(
          `INSERT OR IGNORE INTO connector_receipts (
             connector_id, source_event_id, received_at
           ) VALUES (?, ?, ?)`,
        )
        .run(source.connectorId, source.sourceEventId, new Date().toISOString());
      if (Number(claimed.changes) === 0) return undefined;
      return operation();
    });
  }

  #markMismatchedRuntimesLost(
    current?: Runtime,
    exact?: Runtime,
  ): ServerEnvelope[] {
    const rows = this.#database
      .prepare(
        `SELECT t.id AS turn_id, t.session_id, r.id AS runtime_id, r.generation
           FROM turns t JOIN runtimes r ON r.id = t.runtime_id
          WHERE t.state = 'running'
            AND (? IS NULL OR (r.id = ? AND r.generation = ?))
            AND (? IS NULL OR (r.id <> ? OR r.generation <> ?))`,
      )
      .all(
        exact?.runtimeId ?? null,
        exact?.runtimeId ?? null,
        exact?.generation ?? null,
        current?.runtimeId ?? null,
        current?.runtimeId ?? null,
        current?.generation ?? null,
      ) as unknown as Array<{
      turn_id: string;
      session_id: string;
      runtime_id: string;
      generation: number;
    }>;
    const events: ServerEnvelope[] = [];
    const now = new Date().toISOString();
    for (const row of rows) {
      this.#database
        .prepare(
          `UPDATE turns SET state = 'outcome_unknown', revision = revision + 1,
             completed_at = ?, updated_at = ? WHERE id = ? AND state = 'running'`,
        )
        .run(now, now, row.turn_id);
      this.#database
        .prepare(
          `UPDATE commands SET state = 'outcome_unknown', terminal_at = ?
            WHERE command_id = (
              SELECT client_command_id FROM turns WHERE id = ?
            )`,
        )
        .run(now, row.turn_id);
      this.#database
        .prepare(
          `UPDATE runtimes SET state = 'lost', revision = revision + 1, updated_at = ?
            WHERE id = ? AND generation = ?`,
        )
        .run(now, row.runtime_id, row.generation);
      events.push(
        this.#appendVisibleEvent({
          sessionId: row.session_id,
          origin: "core",
          runtime: {
            runtimeId: row.runtime_id,
            generation: row.generation,
            status: "lost",
          },
          turnId: row.turn_id,
          type: "turn.outcome_unknown",
          payload: (identity) => ({
            sessionId: row.session_id,
            turnId: row.turn_id,
            ...identity,
          }),
          now,
        }),
      );
    }
    return events;
  }
}

export function commandHash(message: ClientEnvelope) {
  return createHash("sha256")
    .update(JSON.stringify({ type: message.type, payload: message.payload }))
    .digest("hex");
}

function parseServer(json: string) {
  return ServerEnvelopeSchema.parse(JSON.parse(json));
}

function terminalStatus(type: ConnectorEnvelope["type"]): Turn["status"] {
  if (type === "connector.turn.completed") return "completed";
  if (type === "connector.turn.interrupted") return "interrupted";
  if (type === "connector.turn.failed") return "failed";
  return "outcome_unknown";
}

function terminalServerType(status: Turn["status"]) {
  if (status === "completed") return "turn.completed" as const;
  if (status === "interrupted") return "turn.interrupted" as const;
  if (status === "failed") return "turn.failed" as const;
  return "turn.outcome_unknown" as const;
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
