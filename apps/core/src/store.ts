import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import {
  ARTIFACT_CHUNK_BYTES,
  MAX_ARTIFACT_BYTES,
  MAX_INLINE_DIFF_BYTES,
  ApprovalSchema,
  ArtifactReferenceSchema,
  FileChangeSchema,
  ServerEnvelopeSchema,
  ToolActivitySchema,
  makeEnvelope,
  utf8ByteLength,
  type Approval,
  type ArtifactReference,
  type ClientEnvelope,
  type ConnectorEnvelope,
  type FileChange,
  type Runtime,
  type ServerEnvelope,
  type SessionSnapshot,
  type SessionSummary,
  type ToolActivity,
  type Turn,
} from "@aicl/protocol";

const CORE_SCHEMA_VERSION = 4;
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

type MutatingClientEnvelope = Extract<
  ClientEnvelope,
  { type: "turn.submit" | "turn.interrupt" | "approval.resolve" }
>;

export type ApprovalResolutionResult =
  | { kind: "same"; result: ServerEnvelope }
  | { kind: "conflict" }
  | {
      kind: "new";
      result: ServerEnvelope;
      durableEvent?: ServerEnvelope;
      dispatch?: {
        approval: Approval;
        providerCorrelationId: string;
        decision: "approved_once" | "declined";
      };
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

interface SessionSummaryRow {
  id: string;
  updated_at: string;
  last_event_seq: number;
  active_turn_id: string | null;
  last_turn_state: Turn["status"] | null;
  pending_approval_count: number;
  runtime_state: Runtime["status"] | null;
  cwd: string | null;
  turn_count: number;
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
  display_seq: number | null;
}

interface MessageRow {
  id: string;
  turn_id: string;
  content: string;
  completed: number;
  display_seq: number | null;
}

interface RuntimeRow {
  id: string;
  generation: number;
  state: Runtime["status"];
}

interface ActivityRow {
  id: string;
  turn_id: string;
  kind: ToolActivity["kind"];
  title: string;
  cwd: string | null;
  state: ToolActivity["status"];
  revision: number;
  exit_code: number | null;
  duration_ms: number | null;
  output_preview: string;
  display_seq: number | null;
}

interface FileChangeRow {
  id: string;
  turn_id: string;
  state: FileChange["status"];
  revision: number;
  files_json: string;
  additions: number;
  deletions: number;
  diff_json: string | null;
  display_seq: number | null;
}

interface ApprovalRow {
  id: string;
  session_id: string;
  runtime_id: string;
  runtime_generation: number;
  turn_id: string;
  provider_correlation_id: string;
  action_type: Approval["actionType"];
  state: Approval["state"];
  revision: number;
  payload_json: string;
  expires_at: string;
  resolved_by_device_id: string | null;
  resolved_at: string | null;
}

interface ArtifactRow {
  id: string;
  session_id: string;
  turn_id: string;
  media_type: string;
  byte_length: number;
  sha256: string;
  content: Uint8Array;
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
        activities: [],
        fileChanges: [],
        approvals: [],
      };
    }
    const turns = this.#database
      .prepare(
        `SELECT id, client_command_id, provider_turn_id, state, revision, prompt,
                started_at, completed_at, failure_code, display_seq
           FROM turns WHERE session_id = ? ORDER BY created_at, id`,
      )
      .all(sessionId) as unknown as TurnRow[];
    const messages = this.#database
      .prepare(
        `SELECT id, turn_id, content, completed, display_seq
           FROM assistant_messages WHERE session_id = ? ORDER BY created_at, id`,
      )
      .all(sessionId) as unknown as MessageRow[];
    const activities = this.#database
      .prepare(
        `SELECT id, turn_id, kind, title, cwd, state, revision, exit_code,
                duration_ms, output_preview, display_seq
           FROM tool_activities WHERE session_id = ? ORDER BY created_at, id`,
      )
      .all(sessionId) as unknown as ActivityRow[];
    const fileChanges = this.#database
      .prepare(
        `SELECT id, turn_id, state, revision, files_json, additions, deletions,
                diff_json, display_seq
           FROM file_changes WHERE session_id = ? ORDER BY created_at, id`,
      )
      .all(sessionId) as unknown as FileChangeRow[];
    const approvals = this.#database
      .prepare(
        `SELECT id, session_id, runtime_id, runtime_generation, turn_id,
                provider_correlation_id, action_type, state, revision,
                payload_json, expires_at, resolved_by_device_id, resolved_at
           FROM approval_requests WHERE session_id = ? ORDER BY created_at, id`,
      )
      .all(sessionId) as unknown as ApprovalRow[];
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
        eventSeq: turn.display_seq ?? 0,
      })),
      messages: messages.map((message) => ({
        messageId: message.id,
        turnId: message.turn_id,
        content: message.content,
        completed: message.completed === 1,
        eventSeq: message.display_seq ?? 0,
      })),
      activities: activities.map(activityFromRow),
      fileChanges: fileChanges.map(fileChangeFromRow),
      approvals: approvals.map(approvalFromRow),
    };
  }

  sessionSummaries(): SessionSummary[] {
    const rows = this.#database
      .prepare(
        `SELECT s.id, s.updated_at, s.last_event_seq,
                (SELECT t.id FROM turns t
                  WHERE t.session_id = s.id AND t.state = 'running'
                  ORDER BY t.created_at DESC, t.id DESC LIMIT 1) AS active_turn_id,
                (SELECT t.state FROM turns t
                  WHERE t.session_id = s.id
                  ORDER BY t.created_at DESC, t.id DESC LIMIT 1) AS last_turn_state,
                (SELECT COUNT(*) FROM approval_requests a
                  WHERE a.session_id = s.id AND a.state = 'pending') AS pending_approval_count,
                (SELECT r.state FROM runtimes r
                  WHERE r.session_id = s.id
                  ORDER BY r.updated_at DESC, r.generation DESC LIMIT 1) AS runtime_state,
                (SELECT a.cwd FROM tool_activities a
                  WHERE a.session_id = s.id AND a.cwd IS NOT NULL
                  ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS cwd,
                (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) AS turn_count
           FROM sessions s ORDER BY s.updated_at DESC, s.id`,
      )
      .all() as unknown as SessionSummaryRow[];

    return rows.map((row) => ({
      sessionId: row.id,
      state:
        row.pending_approval_count > 0
          ? "awaiting_approval"
          : row.active_turn_id !== null
            ? "running"
            : row.last_turn_state ?? "idle",
      runtimeStatus: row.runtime_state,
      activeTurnId: row.active_turn_id,
      pendingApprovalCount: row.pending_approval_count,
      lastTurnStatus: row.last_turn_state,
      lastActivityAt: row.updated_at,
      cwd: row.cwd,
      turnCount: row.turn_count,
      lastEventSeq: row.last_event_seq,
    }));
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
    message: MutatingClientEnvelope,
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
    runtimeBusyRejection?: ServerEnvelope;
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
        .prepare(
          `SELECT id, session_id FROM turns
            WHERE state = 'running' AND (
              session_id = ? OR (runtime_id = ? AND runtime_generation = ?)
            ) LIMIT 1`,
        )
        .get(
          input.message.payload.sessionId,
          input.runtime.runtimeId,
          input.runtime.generation,
        ) as { id: string; session_id: string } | undefined;
      if (active !== undefined) {
        const rejection =
          active.session_id === input.message.payload.sessionId
            ? input.activeRejection
            : (input.runtimeBusyRejection ?? input.activeRejection);
        this.#insertCommand(
          input.message,
          payloadHash,
          "rejected",
          rejection,
          now,
        );
        return { kind: "new", result: rejection };
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
      this.#database
        .prepare("UPDATE turns SET display_seq = ? WHERE id = ?")
        .run(durableEvent.payload.seq, input.turnId);
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
    message: MutatingClientEnvelope,
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
      const updated = this.#database
        .prepare(
          `UPDATE commands SET state = 'dispatched', dispatch_attempts = dispatch_attempts + 1
            WHERE command_id = ? AND state = 'committed'`,
        )
        .run(commandId);
      if (Number(updated.changes) !== 1) {
        throw new Error("Command was not in the committed state before dispatch");
      }
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
      const event = this.#appendVisibleEvent({
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
      this.#database
        .prepare("UPDATE assistant_messages SET display_seq = COALESCE(display_seq, ?) WHERE id = ?")
        .run(event.payload.seq, message.payload.messageId);
      return event;
    });
  }

  async recordActivity(
    message: Extract<
      ConnectorEnvelope,
      { type: "connector.activity.started" | "connector.activity.completed" }
    >,
    source: ConnectorSource,
  ) {
    return this.#ingestSource(source, () => {
      const { activity } = message.payload;
      if (
        !this.#matchesRuntimeEvent(
          message.payload.sessionId,
          activity.turnId,
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
          `INSERT INTO tool_activities (
             id, session_id, turn_id, kind, title, cwd, state, revision,
             exit_code, duration_ms, output_preview, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             state = excluded.state,
             revision = tool_activities.revision + 1,
             exit_code = excluded.exit_code,
             duration_ms = excluded.duration_ms,
             output_preview = excluded.output_preview,
             updated_at = excluded.updated_at`,
        )
        .run(
          activity.activityId,
          message.payload.sessionId,
          activity.turnId,
          activity.kind,
          activity.title,
          activity.cwd,
          activity.status,
          activity.revision,
          activity.exitCode,
          activity.durationMs,
          activity.outputPreview,
          now,
          now,
        );
      const stored = this.#activity(activity.activityId);
      const event = this.#appendVisibleEvent({
        sessionId: message.payload.sessionId,
        origin: "connector",
        runtime: runtimeFromSource(source),
        turnId: activity.turnId,
        source,
        type:
          message.type === "connector.activity.started"
            ? "activity.started"
            : "activity.completed",
        payload: (identity) => ({
          sessionId: message.payload.sessionId,
          activity: stored,
          ...identity,
        }),
        now,
      });
      this.#database
        .prepare("UPDATE tool_activities SET display_seq = COALESCE(display_seq, ?) WHERE id = ?")
        .run(event.payload.seq, activity.activityId);
      return event;
    });
  }

  async recordFileChange(
    message: Extract<
      ConnectorEnvelope,
      {
        type:
          | "connector.file.change.started"
          | "connector.file.change.completed";
      }
    >,
    source: ConnectorSource,
  ) {
    return this.#ingestSource(source, () => {
      const fileChange = message.payload.fileChange;
      if (
        !this.#matchesRuntimeEvent(
          message.payload.sessionId,
          fileChange.turnId,
          source.runtimeId,
          source.runtimeGeneration,
          ["running", "outcome_unknown"],
        )
      ) {
        return undefined;
      }
      const now = new Date().toISOString();
      let diff: FileChange["diff"] = null;
      if (message.type === "connector.file.change.completed") {
        if (message.payload.fileChange.inlineDiff !== null) {
          const content = message.payload.fileChange.inlineDiff;
          const byteLength = utf8ByteLength(content);
          if (byteLength > MAX_INLINE_DIFF_BYTES) {
            throw new Error("Inline diff exceeds the configured threshold");
          }
          diff = {
            kind: "inline",
            content,
            byteLength,
            sha256: createHash("sha256").update(content).digest("hex"),
          };
        } else if (message.payload.fileChange.artifact !== null) {
          this.#assertArtifact(message.payload.fileChange.artifact, {
            sessionId: message.payload.sessionId,
            turnId: fileChange.turnId,
          });
          diff = {
            kind: "artifact",
            artifact: message.payload.fileChange.artifact,
          };
        }
      }
      this.#database
        .prepare(
          `INSERT INTO file_changes (
             id, session_id, turn_id, state, revision, files_json, additions,
             deletions, diff_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             state = excluded.state,
             revision = file_changes.revision + 1,
             files_json = excluded.files_json,
             additions = excluded.additions,
             deletions = excluded.deletions,
             diff_json = excluded.diff_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          fileChange.fileChangeId,
          message.payload.sessionId,
          fileChange.turnId,
          fileChange.status,
          fileChange.revision,
          JSON.stringify(fileChange.files),
          fileChange.additions,
          fileChange.deletions,
          diff === null ? null : JSON.stringify(diff),
          now,
          now,
        );
      const stored = this.#fileChange(fileChange.fileChangeId);
      const event = this.#appendVisibleEvent({
        sessionId: message.payload.sessionId,
        origin: "connector",
        runtime: runtimeFromSource(source),
        turnId: fileChange.turnId,
        source,
        type:
          message.type === "connector.file.change.started"
            ? "file.change.started"
            : "file.change.completed",
        payload: (identity) => ({
          sessionId: message.payload.sessionId,
          fileChange: stored,
          ...identity,
        }),
        now,
      });
      this.#database
        .prepare("UPDATE file_changes SET display_seq = COALESCE(display_seq, ?) WHERE id = ?")
        .run(event.payload.seq, fileChange.fileChangeId);
      return event;
    });
  }

  async requestApproval(
    message: Extract<ConnectorEnvelope, { type: "connector.approval.requested" }>,
    source: ConnectorSource,
  ) {
    return this.#ingestSource(source, () => {
      const { approval, providerCorrelationId } = message.payload;
      if (
        approval.runtimeId !== source.runtimeId ||
        approval.runtimeGeneration !== source.runtimeGeneration ||
        !this.#matchesRuntimeEvent(
          approval.sessionId,
          approval.turnId,
          source.runtimeId,
          source.runtimeGeneration,
          ["running"],
        )
      ) {
        return undefined;
      }
      const now = new Date().toISOString();
      this.#database
        .prepare(
          `INSERT INTO approval_requests (
             id, session_id, runtime_id, runtime_generation, turn_id,
             provider_correlation_id, action_type, state, revision, payload_json,
             expires_at, resolved_by_device_id, resolved_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, NULL, NULL, ?, ?)`,
        )
        .run(
          approval.approvalId,
          approval.sessionId,
          approval.runtimeId,
          approval.runtimeGeneration,
          approval.turnId,
          providerCorrelationId,
          approval.actionType,
          JSON.stringify(approval.payload),
          approval.expiresAt,
          now,
          now,
        );
      const stored = this.#approval(approval.approvalId);
      return this.#appendVisibleEvent({
        sessionId: approval.sessionId,
        origin: "connector",
        runtime: runtimeFromSource(source),
        turnId: approval.turnId,
        source,
        type: "approval.requested",
        payload: (identity) => ({
          sessionId: approval.sessionId,
          approval: approvalFromRow(stored),
          ...identity,
        }),
        now,
      });
    });
  }

  async resolveApproval(input: {
    message: Extract<ClientEnvelope, { type: "approval.resolve" }>;
    accepted: ServerEnvelope;
    runtime: Runtime;
    rejection: (code: string, message: string) => ServerEnvelope;
  }): Promise<ApprovalResolutionResult> {
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
      const approval = this.#approvalOptional(input.message.payload.approvalId);
      const reject = (code: string, message: string, durableEvent?: ServerEnvelope) => {
        const result = input.rejection(code, message);
        this.#insertCommand(input.message, payloadHash, "rejected", result, now);
        return {
          kind: "new" as const,
          result,
          ...(durableEvent === undefined ? {} : { durableEvent }),
        };
      };
      if (
        approval === undefined ||
        approval.session_id !== input.message.payload.sessionId
      ) {
        return reject("APPROVAL_NOT_FOUND", "Approval was not found in this Session.");
      }
      if (approval.state !== "pending") {
        return reject("APPROVAL_NOT_PENDING", `Approval is already ${approval.state}.`);
      }
      if (approval.revision !== input.message.payload.expectedRevision) {
        return reject("STALE_CLIENT_STATE", "Approval revision no longer matches.");
      }
      if (approval.expires_at <= now) {
        this.#database
          .prepare(
            `UPDATE approval_requests SET state = 'expired', revision = revision + 1,
               resolved_at = ?, updated_at = ? WHERE id = ? AND state = 'pending'`,
          )
          .run(now, now, approval.id);
        const expired = approvalFromRow(this.#approval(approval.id));
        const event = this.#appendVisibleEvent({
          sessionId: approval.session_id,
          origin: "core",
          runtime: runtimeFromApproval(expired),
          turnId: approval.turn_id,
          type: "approval.expired",
          payload: (identity) => ({
            sessionId: approval.session_id,
            approval: expired,
            ...identity,
          }),
          now,
        });
        const result = input.rejection("APPROVAL_EXPIRED", "Approval has expired.");
        this.#insertCommand(input.message, payloadHash, "rejected", result, now);
        return {
          kind: "new",
          result,
          durableEvent: event,
          dispatch: {
            approval: expired,
            providerCorrelationId: approval.provider_correlation_id,
            decision: "declined",
          },
        };
      }
      const scopeIsCurrent = this.#database
        .prepare(
          `SELECT 1 AS ok
             FROM approval_requests a
             JOIN runtimes r ON r.id = a.runtime_id
               AND r.generation = a.runtime_generation
             JOIN turns t ON t.id = a.turn_id
            WHERE a.id = ? AND a.state = 'pending'
              AND r.state IN ('ready', 'busy')
              AND t.state = 'running'
              AND t.runtime_id = a.runtime_id
              AND t.runtime_generation = a.runtime_generation`,
        )
        .get(approval.id);
      if (
        scopeIsCurrent === undefined ||
        approval.runtime_id !== input.runtime.runtimeId ||
        approval.runtime_generation !== input.runtime.generation
      ) {
        const event = this.#invalidateApproval(approval, now);
        return reject(
          "APPROVAL_INVALIDATED",
          "Approval no longer belongs to the active runtime and Turn.",
          event,
        );
      }
      const updated = this.#database
        .prepare(
          `UPDATE approval_requests
              SET state = ?, revision = revision + 1,
                  resolved_by_device_id = ?, resolved_at = ?, updated_at = ?
            WHERE id = ? AND state = 'pending' AND revision = ?
              AND runtime_id = ? AND runtime_generation = ? AND turn_id = ?
              AND provider_correlation_id = ? AND expires_at > ?
              AND EXISTS (
                SELECT 1 FROM runtimes r
                 WHERE r.id = approval_requests.runtime_id
                   AND r.generation = approval_requests.runtime_generation
                   AND r.state IN ('ready', 'busy')
              )
              AND EXISTS (
                SELECT 1 FROM turns t
                 WHERE t.id = approval_requests.turn_id
                   AND t.state = 'running'
                   AND t.runtime_id = approval_requests.runtime_id
                   AND t.runtime_generation = approval_requests.runtime_generation
              )`,
        )
        .run(
          input.message.payload.decision,
          input.message.payload.deviceId,
          now,
          now,
          approval.id,
          input.message.payload.expectedRevision,
          approval.runtime_id,
          approval.runtime_generation,
          approval.turn_id,
          approval.provider_correlation_id,
          now,
        );
      if (Number(updated.changes) !== 1) {
        return reject("STALE_CLIENT_STATE", "Approval changed before resolution.");
      }
      this.#insertCommand(input.message, payloadHash, "committed", input.accepted, now);
      const resolved = approvalFromRow(this.#approval(approval.id));
      const durableEvent = this.#appendVisibleEvent({
        sessionId: approval.session_id,
        origin: "core",
        runtime: runtimeFromApproval(resolved),
        turnId: approval.turn_id,
        type: "approval.resolved",
        payload: (identity) => ({
          sessionId: approval.session_id,
          approval: resolved,
          ...identity,
        }),
        now,
      });
      return {
        kind: "new",
        result: input.accepted,
        durableEvent,
        dispatch: {
          approval: resolved,
          providerCorrelationId: approval.provider_correlation_id,
          decision: input.message.payload.decision,
        },
      };
    });
  }

  async recordInterruptResult(
    message: Extract<ConnectorEnvelope, { type: "connector.interrupt.result" }>,
    source: ConnectorSource,
  ) {
    return this.#ingestSource(source, () => {
      if (
        !this.#matchesRuntimeEvent(
          message.payload.sessionId,
          message.payload.turnId,
          source.runtimeId,
          source.runtimeGeneration,
          ["running", "interrupted"],
        )
      ) {
        return undefined;
      }
      const now = new Date().toISOString();
      return this.#appendVisibleEvent({
        sessionId: message.payload.sessionId,
        origin: "connector",
        runtime: runtimeFromSource(source),
        turnId: message.payload.turnId,
        source,
        type: "interrupt.result",
        payload: (identity) => ({ ...message.payload, ...identity }),
        now,
      });
    });
  }

  async expireApprovals(now = new Date().toISOString()) {
    return this.#write(() => {
      const pending = this.#database
        .prepare(
          `SELECT id, session_id, runtime_id, runtime_generation, turn_id,
                  provider_correlation_id, action_type, state, revision,
                  payload_json, expires_at, resolved_by_device_id, resolved_at
             FROM approval_requests
            WHERE state = 'pending' AND expires_at <= ?
            ORDER BY expires_at, id`,
        )
        .all(now) as unknown as ApprovalRow[];
      return pending.map((approval) => {
        this.#database
          .prepare(
            `UPDATE approval_requests SET state = 'expired', revision = revision + 1,
               resolved_at = ?, updated_at = ? WHERE id = ? AND state = 'pending'`,
          )
          .run(now, now, approval.id);
        const expired = approvalFromRow(this.#approval(approval.id));
        const event = this.#appendVisibleEvent({
          sessionId: approval.session_id,
          origin: "core",
          runtime: runtimeFromApproval(expired),
          turnId: approval.turn_id,
          type: "approval.expired",
          payload: (identity) => ({
            sessionId: approval.session_id,
            approval: expired,
            ...identity,
          }),
          now,
        });
        return {
          event,
          approval: expired,
          providerCorrelationId: approval.provider_correlation_id,
        };
      });
    });
  }

  async beginArtifact(
    message: Extract<ConnectorEnvelope, { type: "connector.artifact.begin" }>,
    source: ConnectorSource,
  ) {
    return this.#ingestSource(source, () => {
      const { artifact, chunkCount, sessionId, turnId } = message.payload;
      if (
        !this.#matchesRuntimeEvent(
          sessionId,
          turnId,
          source.runtimeId,
          source.runtimeGeneration,
          ["running", "outcome_unknown"],
        )
      ) {
        return false;
      }
      if (chunkCount !== Math.ceil(artifact.byteLength / ARTIFACT_CHUNK_BYTES)) {
        throw new Error("Artifact chunk count does not match its declared length");
      }
      const allocated = this.#database
        .prepare(
          `SELECT COALESCE(SUM(byte_length), 0) AS bytes FROM (
             SELECT byte_length FROM artifacts WHERE turn_id = ?
             UNION ALL
             SELECT byte_length FROM artifact_ingests WHERE turn_id = ?
           )`,
        )
        .get(turnId, turnId) as { bytes: number };
      if (allocated.bytes + artifact.byteLength > MAX_ARTIFACT_BYTES * 4) {
        throw new Error("Artifact quota for this Turn was exceeded");
      }
      this.#database
        .prepare(
          `INSERT INTO artifact_ingests (
             id, session_id, turn_id, media_type, byte_length, sha256,
             chunk_count, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
        )
        .run(
          artifact.artifactId,
          sessionId,
          turnId,
          artifact.mediaType,
          artifact.byteLength,
          artifact.sha256,
          chunkCount,
          new Date().toISOString(),
        );
      return true;
    });
  }

  async appendArtifactChunk(
    message: Extract<ConnectorEnvelope, { type: "connector.artifact.chunk" }>,
    source: ConnectorSource,
  ) {
    return this.#ingestSource(source, () => {
      const { artifactId, chunkIndex, contentBase64, sessionId, turnId } =
        message.payload;
      if (
        !this.#matchesRuntimeEvent(
          sessionId,
          turnId,
          source.runtimeId,
          source.runtimeGeneration,
          ["running", "outcome_unknown"],
        )
      ) {
        return false;
      }
      const ingest = this.#database
        .prepare(
          `SELECT session_id, turn_id, chunk_count, byte_length
             FROM artifact_ingests WHERE id = ?`,
        )
        .get(artifactId) as
        | {
            session_id: string;
            turn_id: string;
            chunk_count: number;
            byte_length: number;
          }
        | undefined;
      if (
        ingest === undefined ||
        ingest.session_id !== sessionId ||
        ingest.turn_id !== turnId ||
        chunkIndex >= ingest.chunk_count
      ) {
        throw new Error("Artifact chunk does not match an active ingest");
      }
      const content = decodeBase64(contentBase64);
      const expectedLength = Math.min(
        ARTIFACT_CHUNK_BYTES,
        ingest.byte_length - chunkIndex * ARTIFACT_CHUNK_BYTES,
      );
      if (content.byteLength !== expectedLength) {
        throw new Error("Artifact chunk length does not match its declaration");
      }
      this.#database
        .prepare(
          `INSERT INTO artifact_ingest_chunks (artifact_id, chunk_index, content)
           VALUES (?, ?, ?) ON CONFLICT(artifact_id, chunk_index) DO NOTHING`,
        )
        .run(artifactId, chunkIndex, content);
      return true;
    });
  }

  async completeArtifact(
    message: Extract<ConnectorEnvelope, { type: "connector.artifact.complete" }>,
    source: ConnectorSource,
  ) {
    return this.#ingestSource(source, () => {
      const { artifactId, sessionId, turnId } = message.payload;
      if (
        !this.#matchesRuntimeEvent(
          sessionId,
          turnId,
          source.runtimeId,
          source.runtimeGeneration,
          ["running", "outcome_unknown"],
        )
      ) {
        return false;
      }
      const ingest = this.#database
        .prepare(
          `SELECT id, session_id, turn_id, media_type, byte_length, sha256,
                  chunk_count
             FROM artifact_ingests WHERE id = ?`,
        )
        .get(artifactId) as
        | {
            id: string;
            session_id: string;
            turn_id: string;
            media_type: string;
            byte_length: number;
            sha256: string;
            chunk_count: number;
          }
        | undefined;
      if (
        ingest === undefined ||
        ingest.session_id !== sessionId ||
        ingest.turn_id !== turnId
      ) {
        throw new Error("Artifact completion does not match an active ingest");
      }
      const chunks = this.#database
        .prepare(
          `SELECT chunk_index, content FROM artifact_ingest_chunks
            WHERE artifact_id = ? ORDER BY chunk_index`,
        )
        .all(artifactId) as unknown as Array<{
        chunk_index: number;
        content: Uint8Array;
      }>;
      if (
        chunks.length !== ingest.chunk_count ||
        chunks.some((chunk, index) => chunk.chunk_index !== index)
      ) {
        throw new Error("Artifact is missing one or more chunks");
      }
      const content = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.content)));
      const sha256 = createHash("sha256").update(content).digest("hex");
      if (content.byteLength !== ingest.byte_length || sha256 !== ingest.sha256) {
        throw new Error("Artifact integrity check failed");
      }
      this.#database
        .prepare(
          `INSERT INTO artifacts (
             id, session_id, turn_id, media_type, byte_length, sha256, content,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
        )
        .run(
          artifactId,
          sessionId,
          turnId,
          ingest.media_type,
          content.byteLength,
          sha256,
          content,
          new Date().toISOString(),
        );
      this.#database.prepare("DELETE FROM artifact_ingests WHERE id = ?").run(artifactId);
      return true;
    });
  }

  artifact(artifactId: string) {
    const row = this.#database
      .prepare(
        `SELECT id, session_id, turn_id, media_type, byte_length, sha256, content
           FROM artifacts WHERE id = ?`,
      )
      .get(artifactId) as ArtifactRow | undefined;
    return row === undefined
      ? undefined
      : {
          artifactId: row.id,
          sessionId: row.session_id,
          turnId: row.turn_id,
          mediaType: row.media_type,
          byteLength: row.byte_length,
          sha256: row.sha256,
          content: Buffer.from(row.content),
        };
  }

  artifactMetadata(artifactId: string) {
    return this.#database
      .prepare(
        `SELECT id AS artifactId, session_id AS sessionId, turn_id AS turnId,
                media_type AS mediaType, byte_length AS byteLength, sha256
           FROM artifacts WHERE id = ?`,
      )
      .get(artifactId) as
      | {
          artifactId: string;
          sessionId: string;
          turnId: string;
          mediaType: string;
          byteLength: number;
          sha256: string;
        }
      | undefined;
  }

  artifactContent(artifactId: string, start: number, length: number) {
    const row = this.#database
      .prepare("SELECT substr(content, ?, ?) AS content FROM artifacts WHERE id = ?")
      .get(start + 1, length, artifactId) as { content: Uint8Array } | undefined;
    return row === undefined ? undefined : Buffer.from(row.content);
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
      const events = this.#invalidateApprovalsForTurn(
        message.payload.turnId,
        now,
      );
      const status = terminalStatus(message.type);
      events.push(
        ...this.#settleRunningWork(
          message.payload.sessionId,
          message.payload.turnId,
          status,
          runtimeFromSource(source),
          now,
        ),
      );
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
      events.push(
        this.#appendVisibleEvent({
          sessionId: message.payload.sessionId,
          origin: "connector",
          runtime: runtimeFromSource(source),
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
        }),
      );
      return events;
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

  async completeConnectorCommand(
    message: Extract<ConnectorEnvelope, { type: "connector.command.completed" }>,
    source: ConnectorSource,
  ) {
    return this.#ingestSource(source, () => {
      this.#database
        .prepare(
          `UPDATE commands SET state = 'terminal', terminal_at = ?
            WHERE command_id = ? AND session_id = ? AND state = 'dispatched'`,
        )
        .run(
          new Date().toISOString(),
          message.payload.commandId,
          message.payload.sessionId,
        );
      return [] as ServerEnvelope[];
    });
  }

  async failConnectorCommand(
    message: Extract<ConnectorEnvelope, { type: "connector.command.error" }>,
    source: ConnectorSource,
  ) {
    return this.#ingestSource(source, () => {
      const now = new Date().toISOString();
      const result = ServerEnvelopeSchema.parse(
        makeEnvelope("command.rejected", {
          commandId: message.payload.commandId,
          sessionId: message.payload.sessionId,
          error: {
            code: message.payload.code,
            message: message.payload.message,
            retryable: false,
            commandId: message.payload.commandId,
            sessionId: message.payload.sessionId,
          },
        }),
      );
      this.#database
        .prepare(
          `UPDATE commands SET state = 'outcome_unknown', result_json = ?, terminal_at = ?
            WHERE command_id = ? AND session_id = ?
              AND state IN ('committed', 'dispatched')`,
        )
        .run(
          JSON.stringify(result),
          now,
          message.payload.commandId,
          message.payload.sessionId,
        );
      const row = this.#database
        .prepare(
          `SELECT t.id AS turn_id, t.session_id, r.id AS runtime_id,
                  r.generation, t.client_command_id
             FROM turns t JOIN runtimes r ON r.id = t.runtime_id
            WHERE t.id = ? AND t.session_id = ? AND t.state = 'running'
              AND r.id = ? AND r.generation = ?`,
        )
        .get(
          message.payload.turnId,
          message.payload.sessionId,
          source.runtimeId,
          source.runtimeGeneration,
        ) as RuntimeTurnRow | undefined;
      return row === undefined ? [] : this.#markTurnsUnknown([row]);
    });
  }

  async reconcileRuntime(
    runtime: Runtime,
    connectorId: string,
    bootId: string,
    commandReceipts: readonly { commandId: string; state: string }[],
  ) {
    return this.#write(() => {
      const events = this.#markMismatchedRuntimesLost(runtime);
      const dispatchProvenCommands = new Set(
        commandReceipts
          .filter(
            (receipt) =>
              receipt.state === "dispatching" || receipt.state === "completed",
          )
          .map((receipt) => receipt.commandId),
      );
      const unverified = this.#database
        .prepare(
          `SELECT t.id AS turn_id, t.session_id, r.id AS runtime_id,
                  r.generation, t.client_command_id
             FROM turns t JOIN runtimes r ON r.id = t.runtime_id
            WHERE t.state = 'running' AND r.id = ? AND r.generation = ?
              AND (r.connector_id <> ? OR r.connector_boot_id <> ?)`,
        )
        .all(
          runtime.runtimeId,
          runtime.generation,
          connectorId,
          bootId,
        ) as unknown as RuntimeTurnRow[];
      const missingReceipts = this.#database
        .prepare(
          `SELECT t.id AS turn_id, t.session_id, r.id AS runtime_id,
                  r.generation, t.client_command_id
             FROM turns t JOIN runtimes r ON r.id = t.runtime_id
            WHERE t.state = 'running' AND r.id = ? AND r.generation = ?
              AND r.connector_id = ? AND r.connector_boot_id = ?`,
        )
        .all(
          runtime.runtimeId,
          runtime.generation,
          connectorId,
          bootId,
        ) as unknown as RuntimeTurnRow[];
      events.push(
        ...this.#markTurnsUnknown([
          ...unverified,
          ...missingReceipts.filter(
            (row) => !dispatchProvenCommands.has(row.client_command_id),
          ),
        ]),
      );
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

  #activity(activityId: string) {
    const row = this.#database
      .prepare(
        `SELECT id, turn_id, kind, title, cwd, state, revision, exit_code,
                duration_ms, output_preview, display_seq
           FROM tool_activities WHERE id = ?`,
      )
      .get(activityId) as ActivityRow | undefined;
    if (row === undefined) throw new Error(`Activity not found: ${activityId}`);
    return activityFromRow(row);
  }

  #fileChange(fileChangeId: string) {
    const row = this.#database
      .prepare(
        `SELECT id, turn_id, state, revision, files_json, additions, deletions,
                diff_json, display_seq FROM file_changes WHERE id = ?`,
      )
      .get(fileChangeId) as FileChangeRow | undefined;
    if (row === undefined) throw new Error(`File change not found: ${fileChangeId}`);
    return fileChangeFromRow(row);
  }

  #approvalOptional(approvalId: string) {
    return this.#database
      .prepare(
        `SELECT id, session_id, runtime_id, runtime_generation, turn_id,
                provider_correlation_id, action_type, state, revision,
                payload_json, expires_at, resolved_by_device_id, resolved_at
           FROM approval_requests WHERE id = ?`,
      )
      .get(approvalId) as ApprovalRow | undefined;
  }

  #approval(approvalId: string) {
    const row = this.#approvalOptional(approvalId);
    if (row === undefined) throw new Error(`Approval not found: ${approvalId}`);
    return row;
  }

  #invalidateApproval(approval: ApprovalRow, now: string) {
    this.#database
      .prepare(
        `UPDATE approval_requests SET state = 'invalidated', revision = revision + 1,
           resolved_at = ?, updated_at = ? WHERE id = ? AND state = 'pending'`,
      )
      .run(now, now, approval.id);
    const invalidated = approvalFromRow(this.#approval(approval.id));
    return this.#appendVisibleEvent({
      sessionId: approval.session_id,
      origin: "core",
      runtime: runtimeFromApproval(invalidated),
      turnId: approval.turn_id,
      type: "approval.invalidated",
      payload: (identity) => ({
        sessionId: approval.session_id,
        approval: invalidated,
        ...identity,
      }),
      now,
    });
  }

  #invalidateApprovalsForTurn(turnId: string, now: string): ServerEnvelope[] {
    const pending = this.#database
      .prepare(
        `SELECT id, session_id, runtime_id, runtime_generation, turn_id,
                provider_correlation_id, action_type, state, revision,
                payload_json, expires_at, resolved_by_device_id, resolved_at
           FROM approval_requests WHERE turn_id = ? AND state = 'pending'
           ORDER BY created_at, id`,
      )
      .all(turnId) as unknown as ApprovalRow[];
    return pending.map((approval) => this.#invalidateApproval(approval, now));
  }

  #assertArtifact(
    reference: ArtifactReference,
    scope: { sessionId: string; turnId: string },
  ) {
    const parsed = ArtifactReferenceSchema.parse(reference);
    const row = this.#database
      .prepare(
        `SELECT session_id, turn_id, media_type, byte_length, sha256
           FROM artifacts WHERE id = ?`,
      )
      .get(parsed.artifactId) as
      | {
          session_id: string;
          turn_id: string;
          media_type: string;
          byte_length: number;
          sha256: string;
        }
      | undefined;
    if (
      row === undefined ||
      row.session_id !== scope.sessionId ||
      row.turn_id !== scope.turnId ||
      row.media_type !== parsed.mediaType ||
      row.byte_length !== parsed.byteLength ||
      row.sha256 !== parsed.sha256
    ) {
      throw new Error("Artifact reference failed integrity or scope validation");
    }
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
    message: MutatingClientEnvelope,
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
        `SELECT t.id AS turn_id, t.session_id, r.id AS runtime_id, r.generation,
                t.client_command_id
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
      client_command_id: string;
    }>;
    return this.#markTurnsUnknown(rows);
  }

  #markTurnsUnknown(rows: RuntimeTurnRow[]): ServerEnvelope[] {
    const events: ServerEnvelope[] = [];
    const now = new Date().toISOString();
    for (const row of rows) {
      events.push(...this.#invalidateApprovalsForTurn(row.turn_id, now));
      const runtime: Runtime = {
        runtimeId: row.runtime_id,
        generation: row.generation,
        status: "lost",
      };
      events.push(
        ...this.#settleRunningWork(
          row.session_id,
          row.turn_id,
          "outcome_unknown",
          runtime,
          now,
        ),
      );
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
          runtime,
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

  #settleRunningWork(
    sessionId: string,
    turnId: string,
    status: ToolActivity["status"],
    runtime: Runtime,
    now: string,
  ): ServerEnvelope[] {
    const events: ServerEnvelope[] = [];
    const activityIds = this.#database
      .prepare(
        "SELECT id FROM tool_activities WHERE session_id = ? AND turn_id = ? AND state = 'running'",
      )
      .all(sessionId, turnId) as unknown as Array<{ id: string }>;
    for (const { id } of activityIds) {
      this.#database
        .prepare(
          `UPDATE tool_activities SET state = ?, revision = revision + 1, updated_at = ?
            WHERE id = ? AND state = 'running'`,
        )
        .run(status, now, id);
      const activity = this.#activity(id);
      events.push(
        this.#appendVisibleEvent({
          sessionId,
          origin: "core",
          runtime,
          turnId,
          type: "activity.completed",
          payload: (identity) => ({ sessionId, activity, ...identity }),
          now,
        }),
      );
    }

    const fileChangeIds = this.#database
      .prepare(
        "SELECT id FROM file_changes WHERE session_id = ? AND turn_id = ? AND state = 'running'",
      )
      .all(sessionId, turnId) as unknown as Array<{ id: string }>;
    for (const { id } of fileChangeIds) {
      this.#database
        .prepare(
          `UPDATE file_changes SET state = ?, revision = revision + 1, updated_at = ?
            WHERE id = ? AND state = 'running'`,
        )
        .run(status, now, id);
      const fileChange = this.#fileChange(id);
      events.push(
        this.#appendVisibleEvent({
          sessionId,
          origin: "core",
          runtime,
          turnId,
          type: "file.change.completed",
          payload: (identity) => ({ sessionId, fileChange, ...identity }),
          now,
        }),
      );
    }
    return events;
  }
}

interface RuntimeTurnRow {
  turn_id: string;
  session_id: string;
  runtime_id: string;
  generation: number;
  client_command_id: string;
}

function activityFromRow(row: ActivityRow) {
  return ToolActivitySchema.parse({
    activityId: row.id,
    turnId: row.turn_id,
    kind: row.kind,
    title: row.title,
    cwd: row.cwd,
    status: row.state,
    revision: row.revision,
    exitCode: row.exit_code,
    durationMs: row.duration_ms,
    outputPreview: row.output_preview,
    eventSeq: row.display_seq ?? 0,
  });
}

function fileChangeFromRow(row: FileChangeRow) {
  return FileChangeSchema.parse({
    fileChangeId: row.id,
    turnId: row.turn_id,
    status: row.state,
    revision: row.revision,
    files: JSON.parse(row.files_json),
    additions: row.additions,
    deletions: row.deletions,
    diff: row.diff_json === null ? null : JSON.parse(row.diff_json),
    eventSeq: row.display_seq ?? 0,
  });
}

function approvalFromRow(row: ApprovalRow) {
  return ApprovalSchema.parse({
    approvalId: row.id,
    sessionId: row.session_id,
    runtimeId: row.runtime_id,
    runtimeGeneration: row.runtime_generation,
    turnId: row.turn_id,
    actionType: row.action_type,
    state: row.state,
    revision: row.revision,
    expiresAt: row.expires_at,
    payload: JSON.parse(row.payload_json),
    resolvedAt: row.resolved_at,
    resolvedByDeviceId: row.resolved_by_device_id,
  });
}

function runtimeFromSource(source: ConnectorSource): Runtime {
  return {
    runtimeId: source.runtimeId,
    generation: source.runtimeGeneration,
    status: "busy",
  };
}

function runtimeFromApproval(approval: Approval): Runtime {
  return {
    runtimeId: approval.runtimeId,
    generation: approval.runtimeGeneration,
    status: "busy",
  };
}

function decodeBase64(value: string) {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new Error("Artifact chunk is not canonical base64");
  }
  return Buffer.from(value, "base64");
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
