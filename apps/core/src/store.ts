import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import {
  ARTIFACT_CHUNK_BYTES,
  INPUT_ATTACHMENT_CHUNK_BYTES,
  MAX_INPUT_ATTACHMENTS_PER_TURN,
  MAX_ARTIFACT_BYTES,
  MAX_INLINE_DIFF_BYTES,
  ApprovalSchema,
  ApprovalLeaseSchema,
  ApprovalLeaseSnapshotSchema,
  ArtifactReferenceSchema,
  InputAttachmentSchema,
  FileChangeSchema,
  SessionSettingsSchema,
  SessionSettingsSnapshotSchema,
  ServerEnvelopeSchema,
  ToolActivitySchema,
  makeEnvelope,
  utf8ByteLength,
  type Approval,
  type ApprovalLease,
  type ApprovalLeaseSnapshot,
  type ArtifactReference,
  type InputAttachment,
  type ClientEnvelope,
  type ConnectorEnvelope,
  type FileChange,
  type Runtime,
  type ServerEnvelope,
  type SessionSnapshot,
  type SessionCatalogFilter,
  type SessionSummary,
  type SessionSummaryV2,
  type SessionSettings,
  type SessionSettingsSnapshot,
  type ToolActivity,
  type Turn,
} from "@aicl/protocol";

export const CORE_SCHEMA_VERSION = 13;
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
      turnSettings?: {
        revision: number;
        settings: SessionSettings;
      };
      turnAttachments?: StoredTurnAttachment[];
    };

type MutatingClientEnvelope = Extract<
  ClientEnvelope,
  {
    type:
      | "turn.submit"
      | "turn.interrupt"
      | "approval.resolve"
      | "session.rename"
      | "session.pin"
      | "session.archive"
      | "session.read.mark"
      | "session.create"
      | "session.resume"
      | "session.settings.update"
      | "approval.lease.create"
      | "approval.lease.revoke"
      | "approval.emergency_stop"
      | "attachment.upload.begin"
      | "attachment.upload.complete"
      | "attachment.delete";
  }
>;

type SessionMetadataCommand = Extract<
  ClientEnvelope,
  { type: "session.rename" | "session.pin" | "session.archive" }
>;

type SessionPreparationCommand = Extract<
  ClientEnvelope,
  { type: "session.create" | "session.resume" }
>;

export type SessionPreparationResult =
  | { kind: "same"; result: ServerEnvelope }
  | { kind: "conflict" }
  | {
      kind: "new";
      result: ServerEnvelope;
      dispatch?: {
        projectPath: string;
        model: string | null;
        reasoningLevel: string | null;
        providerSessionId: string | null;
      };
    };

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

export type ConnectorIngestRejectionCode =
  | "CONNECTOR_RUNTIME_MISMATCH"
  | "CONNECTOR_ACTIVITY_INVALID"
  | "CONNECTOR_FILE_CHANGE_INVALID"
  | "CONNECTOR_APPROVAL_ID_CONFLICT"
  | "CONNECTOR_INTERRUPT_RESULT_INVALID"
  | "CONNECTOR_TURN_TERMINAL_INVALID"
  | "CONNECTOR_ARTIFACT_DECLARATION_INVALID"
  | "CONNECTOR_ARTIFACT_CHUNK_INVALID"
  | "CONNECTOR_ARTIFACT_INTEGRITY_INVALID";

export interface ConnectorIngestRejection {
  code: ConnectorIngestRejectionCode;
  envelopeType: ConnectorEnvelope["type"];
  connectorId: string;
  sourceEventId: string;
}

export interface CoreDatabaseOptions {
  path: string;
  migrationDirectory?: string;
  onConnectorIngestRejected?: (rejection: ConnectorIngestRejection) => void;
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

interface SessionCatalogRow {
  id: string;
  title: string;
  source: "aicl" | "imported";
  binding_state: SessionSummaryV2["providerBindingStatus"] | null;
  provider_session_id: string | null;
  session_revision: number;
  pinned: number;
  archived: number;
  updated_at: string;
  last_event_seq: number;
  provider_id: string;
  account_id: string | null;
  model: string | null;
  reasoning_level: string | null;
  execution_mode: SessionSummaryV2["executionMode"];
  approval_policy: SessionSummaryV2["approvalPolicy"];
  sandbox_policy: SessionSummaryV2["sandboxPolicy"];
  network_policy: SessionSummaryV2["networkPolicy"];
  project_path: string | null;
  branch: string | null;
  settings_revision: number;
  active_turn_id: string | null;
  last_turn_state: Turn["status"] | null;
  pending_approval_count: number;
  runtime_state: Runtime["status"] | null;
  turn_count: number;
  unread_count: number;
  operational_state: SessionSummaryV2["state"];
}

interface SessionCatalogCursor {
  version: 1;
  catalogRevision: number;
  lastActivityAt: string;
  sessionId: string;
}

export interface SessionCatalogQuery {
  requestId: string;
  deviceId: string;
  pageSize: number;
  cursor: string | null;
  filters: SessionCatalogFilter;
}

export type SessionCatalogResult =
  | {
      ok: true;
      requestId: string;
      catalogRevision: number;
      generatedAt: string;
      sessions: SessionSummaryV2[];
      nextCursor: string | null;
      total: number;
    }
  | {
      ok: false;
      code: "SESSION_CATALOG_CURSOR_INVALID" | "SESSION_CATALOG_CURSOR_STALE";
    };

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
  settings_revision: number | null;
  settings_snapshot_json: string | null;
}

interface SessionSettingsRow {
  session_id: string;
  revision: number;
  provider_id: string;
  account_id: string | null;
  model: string | null;
  reasoning_level: string | null;
  execution_mode: SessionSettings["executionMode"];
  approval_policy: SessionSettings["approvalPolicy"];
  sandbox_policy: SessionSettings["sandboxPolicy"];
  network_policy: SessionSettings["networkPolicy"];
  project_path: string | null;
  branch: string | null;
  active_turn_count?: number;
}

interface ApprovalLeaseRow {
  lease_id: string;
  session_id: string;
  provider_id: string;
  account_id: string;
  project_path: string;
  device_id: string;
  runtime_id: string;
  runtime_generation: number;
  settings_revision: number;
  state: ApprovalLease["state"];
  revision: number;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
}

export interface ApprovalPolicyContext {
  approval: Approval;
  providerCorrelationId: string;
  submittingDeviceId: string | null;
  settingsRevision: number;
  settings: SessionSettings;
  files: Array<{ path: string; kind: "add" | "update" | "delete" }>;
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

interface PendingBindingRow {
  session_id: string;
  command_id: string;
  provider_id: string;
  account_id: string;
  provider_session_id: string | null;
  runtime_id: string;
  runtime_generation: number;
  connector_id: string;
  connector_boot_id: string;
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
  command_text: string | null;
  cwd_label: string | null;
  provider_started_at: string | null;
  provider_completed_at: string | null;
  stdout_preview: string;
  stderr_preview: string;
  stdout_truncated: number;
  stderr_truncated: number;
  stderr_available: number;
  output_artifact_json: string | null;
  runtime_id: string | null;
  runtime_generation: number | null;
  provider_correlation_id: string | null;
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

interface InputAttachmentRow {
  attachment_id: string;
  session_id: string;
  owner_device_id: string;
  name: string;
  kind: InputAttachment["kind"];
  media_type: InputAttachment["mediaType"];
  byte_length: number;
  sha256: string;
  chunk_count: number;
  state: InputAttachment["status"];
  content: Uint8Array | null;
  referenced_turn_id: string | null;
  created_at: string;
  expires_at: string;
}

export interface StoredTurnAttachment {
  attachment: InputAttachment;
  content: Buffer;
}

export interface SessionProviderAuthority {
  providerId: string;
  accountId: string;
  state: "pending" | "ready" | "failed" | "outcome_unknown";
}

export class InputAttachmentMutationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InputAttachmentMutationError";
  }
}

export class CoreDatabase {
  readonly #database: DatabaseSync;
  readonly #onConnectorIngestRejected:
    | ((rejection: ConnectorIngestRejection) => void)
    | undefined;
  #writerTail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: CoreDatabaseOptions) {
    if (options.path !== ":memory:") {
      mkdirSync(dirname(resolve(options.path)), { recursive: true });
    }
    this.#database = new DatabaseSync(options.path);
    this.#onConnectorIngestRejected = options.onConnectorIngestRejected;
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
                started_at, completed_at, failure_code, display_seq,
                settings_revision, settings_snapshot_json
           FROM turns WHERE session_id = ? ORDER BY created_at, id`,
      )
      .all(sessionId) as unknown as TurnRow[];
    const turnAttachmentRows = this.#database
      .prepare(
        `SELECT tia.turn_id, tia.attachment_id
           FROM turn_input_attachments tia
           JOIN turns t ON t.id = tia.turn_id
          WHERE t.session_id = ? ORDER BY tia.turn_id, tia.ordinal`,
      )
      .all(sessionId) as unknown as Array<{
      turn_id: string;
      attachment_id: string;
    }>;
    const attachmentIdsByTurn = new Map<string, string[]>();
    for (const row of turnAttachmentRows) {
      const list = attachmentIdsByTurn.get(row.turn_id) ?? [];
      list.push(row.attachment_id);
      attachmentIdsByTurn.set(row.turn_id, list);
    }
    const messages = this.#database
      .prepare(
        `SELECT id, turn_id, content, completed, display_seq
           FROM assistant_messages WHERE session_id = ? ORDER BY created_at, id`,
      )
      .all(sessionId) as unknown as MessageRow[];
    const activities = this.#database
      .prepare(
        `SELECT id, turn_id, kind, title, cwd, state, revision, exit_code,
                duration_ms, output_preview, command_text, cwd_label,
                provider_started_at, provider_completed_at, stdout_preview,
                stderr_preview, stdout_truncated, stderr_truncated,
                stderr_available, output_artifact_json, runtime_id,
                runtime_generation, provider_correlation_id, display_seq
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
        attachmentIds: attachmentIdsByTurn.get(turn.id) ?? [],
        ...(turn.settings_revision === null || turn.settings_snapshot_json === null
          ? {}
          : {
              settingsRevision: turn.settings_revision,
              effectiveSettings: SessionSettingsSchema.parse(
                JSON.parse(turn.settings_snapshot_json),
              ),
            }),
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

  hasSession(sessionId: string) {
    return this.#database
      .prepare("SELECT 1 AS present FROM sessions WHERE id = ?")
      .get(sessionId) !== undefined;
  }

  sessionSettings(sessionId: string): SessionSettingsSnapshot | undefined {
    const row = this.#database
      .prepare(
        `SELECT settings.session_id, settings.revision, settings.provider_id,
                settings.account_id, settings.model, settings.reasoning_level,
                settings.execution_mode, settings.approval_policy,
                settings.sandbox_policy, settings.network_policy,
                settings.project_path, settings.branch,
                (SELECT COUNT(*) FROM turns
                  WHERE session_id = settings.session_id AND state = 'running')
                  AS active_turn_count
           FROM session_settings settings WHERE settings.session_id = ?`,
      )
      .get(sessionId) as SessionSettingsRow | undefined;
    return row === undefined ? undefined : sessionSettingsSnapshot(row);
  }

  async mutateSessionSettings(
    message: Extract<ClientEnvelope, { type: "session.settings.update" }>,
    validate: (
      requested: SessionSettings,
      current: SessionSettings,
    ) => { code: string; message: string } | undefined,
    rejection: (code: string, detail: string) => ServerEnvelope,
  ) {
    return this.#write(() => {
      const payloadHash = commandHash(message);
      const prior = this.#command(message.payload.commandId);
      if (prior !== undefined) {
        return prior.payload_hash === payloadHash
          ? {
              kind: "same" as const,
              result: parseServer(prior.result_json),
              snapshot: this.sessionSettings(message.payload.sessionId),
            }
          : { kind: "conflict" as const };
      }
      const row = this.#database
        .prepare(
          `SELECT settings.session_id, settings.revision, settings.provider_id,
                  settings.account_id, settings.model, settings.reasoning_level,
                  settings.execution_mode, settings.approval_policy,
                  settings.sandbox_policy, settings.network_policy,
                  settings.project_path, settings.branch,
                  (SELECT COUNT(*) FROM turns
                    WHERE session_id = settings.session_id AND state = 'running')
                    AS active_turn_count
             FROM session_settings settings WHERE settings.session_id = ?`,
        )
        .get(message.payload.sessionId) as SessionSettingsRow | undefined;
      if (row === undefined) throw new Error("Session settings target disappeared");
      const now = new Date().toISOString();
      const current = sessionSettingsSnapshot(row);
      if (row.revision !== message.payload.expectedRevision) {
        const result = rejection(
          "SESSION_SETTINGS_CONFLICT",
          "Session settings changed; refresh before retrying.",
        );
        this.#insertCommand(message, payloadHash, "rejected", result, now);
        return { kind: "new" as const, result, snapshot: current };
      }
      if ((row.active_turn_count ?? 0) > 0) {
        const result = rejection(
          "SESSION_BUSY",
          "Execution settings cannot change during an active Turn.",
        );
        this.#insertCommand(message, payloadHash, "rejected", result, now);
        return { kind: "new" as const, result, snapshot: current };
      }
      const requested = message.payload.settings;
      if (
        requested.providerId !== current.settings.providerId ||
        requested.accountId !== current.settings.accountId ||
        requested.projectPath !== current.settings.projectPath
      ) {
        const result = rejection(
          "SESSION_SETTING_IMMUTABLE",
          "Provider, account, and project are fixed by the provider Session binding.",
        );
        this.#insertCommand(message, payloadHash, "rejected", result, now);
        return { kind: "new" as const, result, snapshot: current };
      }
      const invalid = validate(requested, current.settings);
      if (invalid !== undefined) {
        const result = rejection(invalid.code, invalid.message);
        this.#insertCommand(message, payloadHash, "rejected", result, now);
        return { kind: "new" as const, result, snapshot: current };
      }
      const changed = JSON.stringify(current.settings) !== JSON.stringify(requested);
      const revision = row.revision + (changed ? 1 : 0);
      if (changed) {
        const updated = this.#database
          .prepare(
            `UPDATE session_settings SET provider_id = ?, account_id = ?,
               model = ?, reasoning_level = ?, execution_mode = ?,
               approval_policy = ?, sandbox_policy = ?, network_policy = ?,
               project_path = ?, branch = ?, revision = revision + 1,
               updated_at = ? WHERE session_id = ? AND revision = ?`,
          )
          .run(
            requested.providerId,
            requested.accountId,
            requested.model,
            requested.reasoningLevel,
            requested.executionMode,
            requested.approvalPolicy,
            requested.sandboxPolicy,
            requested.networkPolicy,
            requested.projectPath,
            requested.branch,
            now,
            message.payload.sessionId,
            message.payload.expectedRevision,
          );
        if (Number(updated.changes) !== 1) {
          throw new Error("Session settings CAS lost inside serialized writer");
        }
        this.#database
          .prepare(
            `INSERT INTO session_settings_audit (
               audit_id, session_id, device_id, prior_revision, new_revision,
               old_value_json, new_value_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            `audit-${crypto.randomUUID()}`,
            message.payload.sessionId,
            message.payload.deviceId,
            row.revision,
            revision,
            JSON.stringify(current.settings),
            JSON.stringify(requested),
            now,
          );
        for (const lease of this.#activeApprovalLeases(message.payload.sessionId)) {
          this.#revokeLeaseRow(
            lease,
            "settings_change",
            message.payload.deviceId,
            now,
          );
        }
      }
      const result = parseServer(
        JSON.stringify(
          makeEnvelope("session.command.accepted", {
            commandId: message.payload.commandId,
            sessionId: message.payload.sessionId,
            revision,
          }),
        ),
      );
      this.#insertCommand(message, payloadHash, "terminal", result, now);
      return {
        kind: "new" as const,
        result,
        snapshot: SessionSettingsSnapshotSchema.parse({
          sessionId: message.payload.sessionId,
          revision,
          mutable: true,
          settings: requested,
        }),
      };
    });
  }

  approvalLeaseSnapshot(sessionId: string): ApprovalLeaseSnapshot {
    const state = this.#database
      .prepare("SELECT revision FROM approval_lease_state WHERE session_id = ?")
      .get(sessionId) as { revision: number } | undefined;
    const rows = this.#database
      .prepare(
        `SELECT lease_id, session_id, provider_id, account_id, project_path,
                device_id, runtime_id, runtime_generation, settings_revision,
                state, revision, issued_at, expires_at, revoked_at, revoke_reason
           FROM approval_leases WHERE session_id = ?
           ORDER BY issued_at DESC, lease_id DESC LIMIT 32`,
      )
      .all(sessionId) as unknown as ApprovalLeaseRow[];
    return ApprovalLeaseSnapshotSchema.parse({
      sessionId,
      revision: state?.revision ?? 0,
      serverTime: new Date().toISOString(),
      leases: rows.map(approvalLeaseFromRow),
    });
  }

  async createApprovalLease(input: {
    message: Extract<ClientEnvelope, { type: "approval.lease.create" }>;
    coreBootId: string;
    rejection: (code: string, detail: string) => ServerEnvelope;
    now?: Date;
  }) {
    return this.#write(() => {
      const { message } = input;
      const payloadHash = commandHash(message);
      const prior = this.#command(message.payload.commandId);
      if (prior !== undefined) {
        return prior.payload_hash === payloadHash
          ? {
              kind: "same" as const,
              result: parseServer(prior.result_json),
              snapshot: this.approvalLeaseSnapshot(message.payload.sessionId),
            }
          : { kind: "conflict" as const };
      }
      const now = (input.now ?? new Date()).toISOString();
      const reject = (code: string, detail: string) => {
        const result = input.rejection(code, detail);
        this.#insertCommand(message, payloadHash, "rejected", result, now);
        return {
          kind: "new" as const,
          result,
          snapshot: this.approvalLeaseSnapshot(message.payload.sessionId),
        };
      };
      const settings = this.sessionSettings(message.payload.sessionId);
      if (settings === undefined) {
        return reject("SESSION_NOT_FOUND", "Session does not exist.");
      }
      if (
        settings.revision !== message.payload.expectedSettingsRevision ||
        settings.settings.approvalPolicy !== "full_auto_lease"
      ) {
        return reject(
          "LEASE_SETTINGS_CONFLICT",
          "Full Auto policy and the current settings revision are required.",
        );
      }
      if (
        settings.settings.providerId !== message.payload.providerId ||
        settings.settings.accountId !== message.payload.accountId ||
        settings.settings.projectPath !== message.payload.projectPath
      ) {
        return reject("LEASE_SCOPE_MISMATCH", "Lease scope does not match Session settings.");
      }
      const runtime = this.#database
        .prepare(
          `SELECT id, generation FROM runtimes WHERE session_id = ?
            AND id = ? AND generation = ? AND state IN ('ready', 'busy')`,
        )
        .get(
          message.payload.sessionId,
          message.payload.runtimeId,
          message.payload.runtimeGeneration,
        );
      if (runtime === undefined) {
        return reject("LEASE_RUNTIME_MISMATCH", "Lease Runtime is not current.");
      }
      const leaseRevision = this.#leaseStateRevision(message.payload.sessionId, now);
      if (leaseRevision !== message.payload.expectedLeaseRevision) {
        return reject("LEASE_REVISION_CONFLICT", "Lease state changed; refresh first.");
      }
      if (
        this.#database
          .prepare(
            "SELECT 1 FROM approval_leases WHERE session_id = ? AND state = 'active'",
          )
          .get(message.payload.sessionId) !== undefined
      ) {
        return reject("LEASE_ALREADY_ACTIVE", "This Session already has an active lease.");
      }
      const nextRevision = leaseRevision + 1;
      const leaseId = `lease-${crypto.randomUUID()}`;
      const expiresAt = new Date(
        Date.parse(now) + message.payload.durationMinutes * 60_000,
      ).toISOString();
      const result = parseServer(
        JSON.stringify(
          makeEnvelope("session.command.accepted", {
            commandId: message.payload.commandId,
            sessionId: message.payload.sessionId,
            revision: nextRevision,
          }),
        ),
      );
      this.#insertCommand(message, payloadHash, "terminal", result, now);
      this.#database
        .prepare(
          `INSERT INTO approval_leases (
             lease_id, session_id, create_command_id, provider_id, account_id,
             project_path, device_id, runtime_id, runtime_generation,
             settings_revision, core_boot_id, state, revision, issued_at, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)`,
        )
        .run(
          leaseId,
          message.payload.sessionId,
          message.payload.commandId,
          message.payload.providerId,
          message.payload.accountId,
          message.payload.projectPath,
          message.payload.deviceId,
          message.payload.runtimeId,
          message.payload.runtimeGeneration,
          message.payload.expectedSettingsRevision,
          input.coreBootId,
          now,
          expiresAt,
        );
      this.#database
        .prepare(
          "UPDATE approval_lease_state SET revision = ?, updated_at = ? WHERE session_id = ?",
        )
        .run(nextRevision, now, message.payload.sessionId);
      this.#insertLeaseAudit(
        leaseId,
        message.payload.sessionId,
        "create",
        message.payload.deviceId,
        { durationMinutes: message.payload.durationMinutes },
        now,
      );
      return {
        kind: "new" as const,
        result,
        snapshot: this.approvalLeaseSnapshot(message.payload.sessionId),
      };
    });
  }

  async revokeApprovalLease(input: {
    message: Extract<ClientEnvelope, { type: "approval.lease.revoke" }>;
    rejection: (code: string, detail: string) => ServerEnvelope;
    now?: Date;
  }) {
    return this.#write(() => {
      const { message } = input;
      const payloadHash = commandHash(message);
      const prior = this.#command(message.payload.commandId);
      if (prior !== undefined) {
        return prior.payload_hash === payloadHash
          ? {
              kind: "same" as const,
              result: parseServer(prior.result_json),
              snapshot: this.approvalLeaseSnapshot(message.payload.sessionId),
            }
          : { kind: "conflict" as const };
      }
      const now = (input.now ?? new Date()).toISOString();
      const row = this.#approvalLeaseOptional(message.payload.leaseId);
      const reject = (code: string, detail: string) => {
        const result = input.rejection(code, detail);
        this.#insertCommand(message, payloadHash, "rejected", result, now);
        return {
          kind: "new" as const,
          result,
          snapshot: this.approvalLeaseSnapshot(message.payload.sessionId),
        };
      };
      if (row === undefined || row.session_id !== message.payload.sessionId) {
        return reject("LEASE_NOT_FOUND", "Lease was not found in this Session.");
      }
      if (row.device_id !== message.payload.deviceId) {
        return reject("LEASE_DEVICE_MISMATCH", "Lease belongs to another device.");
      }
      if (
        row.state !== "active" ||
        row.revision !== message.payload.expectedLeaseRevision
      ) {
        return reject("LEASE_REVISION_CONFLICT", "Lease is no longer active at this revision.");
      }
      this.#revokeLeaseRow(row, "revoke", message.payload.deviceId, now);
      const revision = this.#leaseStateRevision(message.payload.sessionId, now);
      const result = parseServer(
        JSON.stringify(
          makeEnvelope("session.command.accepted", {
            commandId: message.payload.commandId,
            sessionId: message.payload.sessionId,
            revision,
          }),
        ),
      );
      this.#insertCommand(message, payloadHash, "terminal", result, now);
      return {
        kind: "new" as const,
        result,
        snapshot: this.approvalLeaseSnapshot(message.payload.sessionId),
      };
    });
  }

  async emergencyStop(input: {
    message: Extract<ClientEnvelope, { type: "approval.emergency_stop" }>;
    rejection: (code: string, detail: string) => ServerEnvelope;
    now?: Date;
  }) {
    return this.#write(() => {
      const { message } = input;
      const payloadHash = commandHash(message);
      const prior = this.#command(message.payload.commandId);
      if (prior !== undefined) {
        return prior.payload_hash === payloadHash
          ? {
              kind: "same" as const,
              result: parseServer(prior.result_json),
              snapshot: this.approvalLeaseSnapshot(message.payload.sessionId),
              activeTurnId: this.snapshot(message.payload.sessionId).activeTurnId,
            }
          : { kind: "conflict" as const };
      }
      const now = (input.now ?? new Date()).toISOString();
      if (!this.hasSession(message.payload.sessionId)) {
        const result = input.rejection("SESSION_NOT_FOUND", "Session does not exist.");
        this.#insertCommand(message, payloadHash, "rejected", result, now);
        return { kind: "new" as const, result };
      }
      const rows = this.#activeApprovalLeases(message.payload.sessionId);
      for (const row of rows) {
        this.#revokeLeaseRow(row, "emergency_stop", message.payload.deviceId, now);
      }
      const revision = this.#leaseStateRevision(message.payload.sessionId, now);
      const result = parseServer(
        JSON.stringify(
          makeEnvelope("session.command.accepted", {
            commandId: message.payload.commandId,
            sessionId: message.payload.sessionId,
            revision,
          }),
        ),
      );
      this.#insertCommand(message, payloadHash, "terminal", result, now);
      return {
        kind: "new" as const,
        result,
        snapshot: this.approvalLeaseSnapshot(message.payload.sessionId),
        activeTurnId: this.snapshot(message.payload.sessionId).activeTurnId,
      };
    });
  }

  async revokeLeasesForCoreBoot(coreBootId: string) {
    return this.#write(() => {
      const now = new Date().toISOString();
      const rows = this.#database
        .prepare(
          `SELECT lease_id, session_id, provider_id, account_id, project_path,
                  device_id, runtime_id, runtime_generation, settings_revision,
                  state, revision, issued_at, expires_at, revoked_at, revoke_reason
             FROM approval_leases WHERE state = 'active' AND core_boot_id <> ?`,
        )
        .all(coreBootId) as unknown as ApprovalLeaseRow[];
      for (const row of rows) {
        this.#revokeLeaseRow(row, "core_restart", "core", now);
      }
      return [...new Set(rows.map((row) => row.session_id))].map((sessionId) =>
        this.approvalLeaseSnapshot(sessionId),
      );
    });
  }

  async revokeLeasesForRuntime(runtime: Runtime) {
    return this.#write(() => {
      const now = new Date().toISOString();
      const rows = this.#database
        .prepare(
          `SELECT lease_id, session_id, provider_id, account_id, project_path,
                  device_id, runtime_id, runtime_generation, settings_revision,
                  state, revision, issued_at, expires_at, revoked_at, revoke_reason
             FROM approval_leases WHERE state = 'active'
               AND runtime_id = ? AND runtime_generation = ?`,
        )
        .all(runtime.runtimeId, runtime.generation) as unknown as ApprovalLeaseRow[];
      for (const row of rows) {
        this.#revokeLeaseRow(row, "runtime_change", "core", now);
      }
      return [...new Set(rows.map((row) => row.session_id))].map((sessionId) =>
        this.approvalLeaseSnapshot(sessionId),
      );
    });
  }

  async sweepApprovalLeases(now = new Date()) {
    return this.#write(() => {
      const timestamp = now.toISOString();
      const rows = this.#database
        .prepare(
          `SELECT lease_id, session_id, provider_id, account_id, project_path,
                  device_id, runtime_id, runtime_generation, settings_revision,
                  state, revision, issued_at, expires_at, revoked_at, revoke_reason
             FROM approval_leases WHERE state = 'active' AND expires_at <= ?`,
        )
        .all(timestamp) as unknown as ApprovalLeaseRow[];
      for (const row of rows) {
        this.#revokeLeaseRow(row, "expire", "core", timestamp, "expired");
      }
      return [...new Set(rows.map((row) => row.session_id))].map((sessionId) =>
        this.approvalLeaseSnapshot(sessionId),
      );
    });
  }

  sessionCatalog(
    query: SessionCatalogQuery,
    canControlSession: (sessionId: string) => boolean,
  ): SessionCatalogResult {
    const catalogRevision = this.#catalogRevision();
    const cursor = decodeCatalogCursor(query.cursor);
    if (query.cursor !== null && cursor === null) {
      return { ok: false, code: "SESSION_CATALOG_CURSOR_INVALID" };
    }
    if (cursor !== null && cursor.catalogRevision !== catalogRevision) {
      return { ok: false, code: "SESSION_CATALOG_CURSOR_STALE" };
    }

    const filterClauses: string[] = [];
    const filterValues: SQLInputValue[] = [];
    const filters = query.filters;
    if (filters.archived === "exclude") filterClauses.push("catalog.archived = 0");
    if (filters.archived === "only") filterClauses.push("catalog.archived = 1");
    if (filters.pinned !== null) {
      filterClauses.push("catalog.pinned = ?");
      filterValues.push(filters.pinned ? 1 : 0);
    }
    addInFilter(filterClauses, filterValues, "catalog.provider_id", filters.providerIds);
    addInFilter(filterClauses, filterValues, "catalog.account_id", filters.accountIds);
    addInFilter(filterClauses, filterValues, "catalog.operational_state", filters.states);
    if (filters.project !== null && filters.project.length > 0) {
      filterClauses.push(
        "LOWER(COALESCE(catalog.project_path, '')) LIKE ? ESCAPE '\\'",
      );
      filterValues.push(`%${escapeLike(filters.project.toLowerCase())}%`);
    }
    if (filters.search !== null && filters.search.length > 0) {
      const search = `%${escapeLike(filters.search.toLowerCase())}%`;
      filterClauses.push(
        `(LOWER(catalog.title) LIKE ? ESCAPE '\\'
          OR LOWER(catalog.id) LIKE ? ESCAPE '\\'
          OR LOWER(catalog.provider_id) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(catalog.account_id, '')) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(catalog.provider_session_id, '')) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(catalog.project_path, '')) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(catalog.branch, '')) LIKE ? ESCAPE '\\')`,
      );
      filterValues.push(search, search, search, search, search, search, search);
    }
    const filterSql = filterClauses.length === 0
      ? ""
      : `WHERE ${filterClauses.join(" AND ")}`;
    const catalogSql = `WITH catalog AS (
      SELECT s.id, s.title, s.source, s.provider_session_id,
             s.session_revision, s.pinned, s.archived, s.updated_at,
             s.last_event_seq, settings.provider_id, settings.account_id,
             settings.model, settings.reasoning_level, settings.execution_mode,
             settings.approval_policy, settings.sandbox_policy,
             settings.network_policy, settings.project_path, settings.branch,
             settings.revision AS settings_revision,
             binding.state AS binding_state,
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
             (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) AS turn_count,
             MAX(0, s.last_event_seq - COALESCE(read_cursor.last_read_seq, 0))
               AS unread_count,
             CASE
               WHEN EXISTS (
                 SELECT 1 FROM approval_requests a
                  WHERE a.session_id = s.id AND a.state = 'pending'
               ) THEN 'awaiting_approval'
               WHEN EXISTS (
                 SELECT 1 FROM turns t
                  WHERE t.session_id = s.id AND t.state = 'running'
               ) THEN 'running'
               ELSE COALESCE((
                 SELECT t.state FROM turns t WHERE t.session_id = s.id
                  ORDER BY t.created_at DESC, t.id DESC LIMIT 1
               ), 'idle')
             END AS operational_state
        FROM sessions s
        JOIN session_settings settings ON settings.session_id = s.id
        LEFT JOIN session_provider_bindings binding ON binding.session_id = s.id
        LEFT JOIN session_read_cursors read_cursor
          ON read_cursor.session_id = s.id AND read_cursor.device_id = ?
    )`;
    const count = this.#database
      .prepare(`${catalogSql} SELECT COUNT(*) AS total FROM catalog ${filterSql}`)
      .get(query.deviceId, ...filterValues) as { total: number };
    const pageClauses = [...filterClauses];
    const pageValues: SQLInputValue[] = [...filterValues];
    if (cursor !== null) {
      pageClauses.push(
        "(catalog.updated_at < ? OR (catalog.updated_at = ? AND catalog.id > ?))",
      );
      pageValues.push(cursor.lastActivityAt, cursor.lastActivityAt, cursor.sessionId);
    }
    const pageSql = pageClauses.length === 0
      ? ""
      : `WHERE ${pageClauses.join(" AND ")}`;
    const rows = this.#database
      .prepare(
        `${catalogSql}
         SELECT * FROM catalog ${pageSql}
         ORDER BY catalog.updated_at DESC, catalog.id ASC LIMIT ?`,
      )
      .all(query.deviceId, ...pageValues, query.pageSize + 1) as unknown as SessionCatalogRow[];
    const hasMore = rows.length > query.pageSize;
    const page = rows.slice(0, query.pageSize);
    const sessions = page.map((row) =>
      sessionCatalogEntry(row, canControlSession(row.id)),
    );
    const last = hasMore ? page.at(-1) : undefined;
    return {
      ok: true,
      requestId: query.requestId,
      catalogRevision,
      generatedAt: new Date().toISOString(),
      sessions,
      nextCursor:
        last === undefined
          ? null
          : encodeCatalogCursor({
              version: 1,
              catalogRevision,
              lastActivityAt: last.updated_at,
              sessionId: last.id,
            }),
      total: count.total,
    };
  }

  boundSessionId(
    providerId: string,
    accountId: string,
    providerSessionId: string,
  ) {
    return (
      this.#database
        .prepare(
          `SELECT session_id FROM session_provider_bindings
            WHERE provider_id = ? AND account_id = ? AND provider_session_id = ?
              AND state = 'ready'`,
        )
        .get(providerId, accountId, providerSessionId) as
        | { session_id: string }
        | undefined
    )?.session_id;
  }

  sessionProviderAuthority(sessionId: string): SessionProviderAuthority | undefined {
    const row = this.#database
      .prepare(
        `SELECT provider_id, account_id, state
           FROM session_provider_bindings WHERE session_id = ?`,
      )
      .get(sessionId) as
      | {
          provider_id: string;
          account_id: string;
          state: SessionProviderAuthority["state"];
        }
      | undefined;
    return row === undefined
      ? undefined
      : {
          providerId: row.provider_id,
          accountId: row.account_id,
          state: row.state,
        };
  }

  async acceptSessionPreparation(input: {
    message: SessionPreparationCommand;
    runtime: Runtime;
    connectorId: string;
    bootId: string;
    selection: {
      title: string;
      source: "aicl" | "imported";
      projectPath: string;
      model: string | null;
      reasoningLevel: string | null;
      providerSessionId: string | null;
    };
    rejection: (code: string, detail: string) => ServerEnvelope;
  }): Promise<SessionPreparationResult> {
    return this.#write(() => {
      const payloadHash = commandHash(input.message);
      const prior = this.#command(input.message.payload.commandId);
      if (prior !== undefined) {
        return prior.payload_hash === payloadHash
          ? { kind: "same", result: parseServer(prior.result_json) }
          : { kind: "conflict" };
      }
      const now = new Date().toISOString();
      if (this.hasSession(input.message.payload.sessionId)) {
        const result = input.rejection(
          "SESSION_ID_EXISTS",
          "The requested AICL Session ID already exists.",
        );
        this.#insertCommand(input.message, payloadHash, "rejected", result, now);
        return { kind: "new", result };
      }
      this.#database
        .prepare(
          `INSERT INTO sessions (
             id, title, source, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.message.payload.sessionId,
          input.selection.title,
          input.selection.source,
          now,
          now,
        );
      this.#database
        .prepare(
          `UPDATE session_settings SET provider_id = ?, account_id = ?,
             model = ?, reasoning_level = ?, project_path = ?, updated_at = ?
           WHERE session_id = ?`,
        )
        .run(
          input.message.payload.providerId,
          input.message.payload.accountId,
          input.selection.model,
          input.selection.reasoningLevel,
          input.selection.projectPath,
          now,
          input.message.payload.sessionId,
        );
      this.#attachRuntime(
        input.message.payload.sessionId,
        input.runtime,
        input.connectorId,
        input.bootId,
        now,
      );
      const result = parseServer(
        JSON.stringify(
          makeEnvelope("session.command.accepted", {
            commandId: input.message.payload.commandId,
            sessionId: input.message.payload.sessionId,
            revision: 0,
          }),
        ),
      );
      this.#insertCommand(input.message, payloadHash, "committed", result, now);
      this.#database
        .prepare(
          `INSERT INTO session_provider_bindings (
             session_id, command_id, provider_id, account_id,
             requested_provider_session_id, state, runtime_id,
             runtime_generation, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
        )
        .run(
          input.message.payload.sessionId,
          input.message.payload.commandId,
          input.message.payload.providerId,
          input.message.payload.accountId,
          input.selection.providerSessionId,
          input.runtime.runtimeId,
          input.runtime.generation,
          now,
          now,
        );
      return {
        kind: "new",
        result,
        dispatch: {
          projectPath: input.selection.projectPath,
          model: input.selection.model,
          reasoningLevel: input.selection.reasoningLevel,
          providerSessionId: input.selection.providerSessionId,
        },
      };
    });
  }

  async recordSessionPreparation(
    message: Extract<
      ConnectorEnvelope,
      {
        type:
          | "connector.session.prepared"
          | "connector.session.prepare.failed"
          | "connector.session.prepare.outcome_unknown";
      }
    >,
    source: ConnectorSource,
  ) {
    return this.#ingestSource(source, () => {
      const binding = this.#database
        .prepare(
          `SELECT command_id, provider_id, account_id,
                  requested_provider_session_id, state
             FROM session_provider_bindings
            WHERE session_id = ? AND command_id = ? AND runtime_id = ?
              AND runtime_generation = ?`,
        )
        .get(
          message.payload.sessionId,
          message.payload.commandId,
          source.runtimeId,
          source.runtimeGeneration,
        ) as
        | {
            command_id: string;
            provider_id: string;
            account_id: string;
            requested_provider_session_id: string | null;
            state: string;
          }
        | undefined;
      if (binding === undefined || binding.state !== "pending") return undefined;
      const now = new Date().toISOString();
      let status: "ready" | "failed" | "outcome_unknown";
      let providerSessionId: string | null = null;
      let failureCode: string | null = null;
      if (message.type === "connector.session.prepared") {
        if (
          message.payload.providerId !== binding.provider_id ||
          message.payload.accountId !== binding.account_id ||
          (binding.requested_provider_session_id !== null &&
            message.payload.providerSessionId !==
              binding.requested_provider_session_id)
        ) {
          status = "failed";
          failureCode = "PROVIDER_BINDING_MISMATCH";
        } else if (
          this.boundSessionId(
            message.payload.providerId,
            message.payload.accountId,
            message.payload.providerSessionId,
          ) !== undefined
        ) {
          status = "failed";
          failureCode = "PROVIDER_SESSION_ALREADY_IMPORTED";
        } else {
          status = "ready";
          providerSessionId = message.payload.providerSessionId;
          this.#database
            .prepare(
              `UPDATE sessions SET provider_session_id = ?,
                 state_revision = state_revision + 1, updated_at = ? WHERE id = ?`,
            )
            .run(providerSessionId, now, message.payload.sessionId);
          this.#database
            .prepare(
              `UPDATE session_settings SET project_path = ?, model = ?,
                 reasoning_level = ?, updated_at = ? WHERE session_id = ?`,
            )
            .run(
              message.payload.projectPath,
              message.payload.model,
              message.payload.reasoningLevel,
              now,
              message.payload.sessionId,
            );
        }
      } else if (message.type === "connector.session.prepare.failed") {
        status = "failed";
        failureCode = message.payload.code;
      } else {
        status = "outcome_unknown";
      }
      this.#database
        .prepare(
          `UPDATE session_provider_bindings SET state = ?, provider_session_id = ?,
             failure_code = ?, updated_at = ?
           WHERE session_id = ? AND command_id = ? AND state = 'pending'`,
        )
        .run(
          status,
          providerSessionId,
          failureCode,
          now,
          message.payload.sessionId,
          message.payload.commandId,
        );
      this.#database
        .prepare(
          `UPDATE commands SET state = ?, terminal_at = ?
            WHERE command_id = ? AND state IN ('committed', 'dispatched')`,
        )
        .run(
          status === "outcome_unknown" ? "outcome_unknown" : "terminal",
          now,
          message.payload.commandId,
        );
      return parseServer(
        JSON.stringify(
          makeEnvelope("session.provider.status", {
            commandId: message.payload.commandId,
            sessionId: message.payload.sessionId,
            providerId: binding.provider_id,
            accountId: binding.account_id,
            providerSessionId,
            status,
            failureCode,
            runtimeId: source.runtimeId,
            runtimeGeneration: source.runtimeGeneration,
            updatedAt: now,
          }),
        ),
      );
    });
  }

  async mutateSessionMetadata(
    message: SessionMetadataCommand,
    rejection: (code: string, detail: string) => ServerEnvelope,
  ): Promise<MutationResult> {
    return this.#write(() => {
      const payloadHash = commandHash(message);
      const prior = this.#command(message.payload.commandId);
      if (prior !== undefined) {
        return prior.payload_hash === payloadHash
          ? { kind: "same", result: parseServer(prior.result_json) }
          : { kind: "conflict" };
      }
      const row = this.#database
        .prepare(
          "SELECT title, pinned, archived, session_revision FROM sessions WHERE id = ?",
        )
        .get(message.payload.sessionId) as
        | { title: string; pinned: number; archived: number; session_revision: number }
        | undefined;
      if (row === undefined) throw new Error("Session metadata target disappeared");
      const now = new Date().toISOString();
      if (row.session_revision !== message.payload.expectedRevision) {
        const result = rejection(
          "SESSION_REVISION_CONFLICT",
          "Session metadata changed; refresh the catalog before retrying.",
        );
        this.#insertCommand(message, payloadHash, "rejected", result, now);
        return { kind: "new", result };
      }
      if (
        message.type === "session.archive" &&
        message.payload.archived &&
        this.#database
          .prepare("SELECT 1 FROM turns WHERE session_id = ? AND state = 'running'")
          .get(message.payload.sessionId) !== undefined
      ) {
        const result = rejection(
          "SESSION_BUSY",
          "A Session with an active Turn cannot be archived.",
        );
        this.#insertCommand(message, payloadHash, "rejected", result, now);
        return { kind: "new", result };
      }

      const mutation = sessionMetadataMutation(message, row);
      if (mutation.changed) {
        this.#database
          .prepare(
            `UPDATE sessions SET ${mutation.column} = ?,
               session_revision = session_revision + 1, updated_at = ?
             WHERE id = ? AND session_revision = ?`,
          )
          .run(
            mutation.databaseValue,
            now,
            message.payload.sessionId,
            message.payload.expectedRevision,
          );
        this.#database
          .prepare(
            `INSERT INTO session_catalog_audit (
               audit_id, session_id, action, device_id, old_value_json,
               new_value_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            `audit-${crypto.randomUUID()}`,
            message.payload.sessionId,
            mutation.action,
            message.payload.deviceId,
            JSON.stringify(mutation.oldValue),
            JSON.stringify(mutation.newValue),
            now,
          );
      }
      const revision = row.session_revision + (mutation.changed ? 1 : 0);
      const result = parseServer(
        JSON.stringify(
          makeEnvelope("session.command.accepted", {
            commandId: message.payload.commandId,
            sessionId: message.payload.sessionId,
            revision,
          }),
        ),
      );
      this.#insertCommand(message, payloadHash, "terminal", result, now);
      return { kind: "new", result };
    });
  }

  async markSessionRead(
    message: Extract<ClientEnvelope, { type: "session.read.mark" }>,
    rejection: (code: string, detail: string) => ServerEnvelope,
  ): Promise<MutationResult> {
    return this.#write(() => {
      const payloadHash = commandHash(message);
      const prior = this.#command(message.payload.commandId);
      if (prior !== undefined) {
        return prior.payload_hash === payloadHash
          ? { kind: "same", result: parseServer(prior.result_json) }
          : { kind: "conflict" };
      }
      const session = this.#database
        .prepare("SELECT last_event_seq, session_revision FROM sessions WHERE id = ?")
        .get(message.payload.sessionId) as
        | { last_event_seq: number; session_revision: number }
        | undefined;
      if (session === undefined) throw new Error("Session read target disappeared");
      const now = new Date().toISOString();
      if (message.payload.upToEventSeq > session.last_event_seq) {
        const result = rejection(
          "SESSION_READ_CURSOR_INVALID",
          "Read cursor cannot advance beyond the durable Session sequence.",
        );
        this.#insertCommand(message, payloadHash, "rejected", result, now);
        return { kind: "new", result };
      }
      const priorCursor = this.#database
        .prepare(
          "SELECT last_read_seq FROM session_read_cursors WHERE session_id = ? AND device_id = ?",
        )
        .get(message.payload.sessionId, message.payload.deviceId) as
        | { last_read_seq: number }
        | undefined;
      const next = Math.max(priorCursor?.last_read_seq ?? 0, message.payload.upToEventSeq);
      this.#database
        .prepare(
          `INSERT INTO session_read_cursors (
             session_id, device_id, last_read_seq, updated_at
           ) VALUES (?, ?, ?, ?)
           ON CONFLICT(session_id, device_id) DO UPDATE SET
             last_read_seq = MAX(last_read_seq, excluded.last_read_seq),
             updated_at = excluded.updated_at`,
        )
        .run(message.payload.sessionId, message.payload.deviceId, next, now);
      if (next !== (priorCursor?.last_read_seq ?? 0)) {
        this.#database
          .prepare(
            `INSERT INTO session_catalog_audit (
               audit_id, session_id, action, device_id, old_value_json,
               new_value_json, created_at
             ) VALUES (?, ?, 'mark_read', ?, ?, ?, ?)`,
          )
          .run(
            `audit-${crypto.randomUUID()}`,
            message.payload.sessionId,
            message.payload.deviceId,
            JSON.stringify({ lastReadSeq: priorCursor?.last_read_seq ?? 0 }),
            JSON.stringify({ lastReadSeq: next }),
            now,
          );
      }
      const result = parseServer(
        JSON.stringify(
          makeEnvelope("session.command.accepted", {
            commandId: message.payload.commandId,
            sessionId: message.payload.sessionId,
            revision: session.session_revision,
          }),
        ),
      );
      this.#insertCommand(message, payloadHash, "terminal", result, now);
      return { kind: "new", result };
    });
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

  inputAttachments(sessionId: string, deviceId: string) {
    return (this.#database
      .prepare(
        `SELECT attachment_id, session_id, owner_device_id, name, kind,
                media_type, byte_length, sha256, chunk_count, state, content,
                referenced_turn_id, created_at, expires_at
           FROM input_attachments
          WHERE session_id = ? AND owner_device_id = ? AND state <> 'deleted'
          ORDER BY created_at, attachment_id LIMIT 256`,
      )
      .all(sessionId, deviceId) as unknown as InputAttachmentRow[]).map(
      inputAttachmentFromRow,
    );
  }

  inputAttachmentsById(sessionId: string, attachmentIds: readonly string[]) {
    if (attachmentIds.length === 0) return [];
    const placeholders = attachmentIds.map(() => "?").join(", ");
    const rows = this.#database
      .prepare(
        `SELECT attachment_id, session_id, owner_device_id, name, kind,
                media_type, byte_length, sha256, chunk_count, state, content,
                referenced_turn_id, created_at, expires_at
           FROM input_attachments
          WHERE session_id = ? AND attachment_id IN (${placeholders})`,
      )
      .all(sessionId, ...attachmentIds) as unknown as InputAttachmentRow[];
    const byId = new Map(rows.map((row) => [row.attachment_id, row]));
    return attachmentIds.flatMap((attachmentId) => {
      const row = byId.get(attachmentId);
      return row === undefined ? [] : [inputAttachmentFromRow(row)];
    });
  }

  async beginInputAttachment(
    message: Extract<ClientEnvelope, { type: "attachment.upload.begin" }>,
    rejection: (code: string, detail: string) => ServerEnvelope,
    now = new Date(),
  ): Promise<MutationResult> {
    return this.#write(() => {
      const payloadHash = commandHash(message);
      const prior = this.#command(message.payload.commandId);
      if (prior !== undefined) {
        return prior.payload_hash === payloadHash
          ? { kind: "same", result: parseServer(prior.result_json) }
          : { kind: "conflict" };
      }
      const nowIso = now.toISOString();
      if (!this.hasSession(message.payload.sessionId)) {
        const result = rejection("SESSION_NOT_FOUND", "Attachment Session does not exist.");
        this.#insertCommand(message, payloadHash, "rejected", result, nowIso);
        return { kind: "new", result };
      }
      if (
        message.payload.chunkCount !==
        Math.ceil(message.payload.byteLength / INPUT_ATTACHMENT_CHUNK_BYTES)
      ) {
        const result = rejection(
          "ATTACHMENT_CHUNK_COUNT_INVALID",
          "Attachment chunk count does not match the declared length.",
        );
        this.#insertCommand(message, payloadHash, "rejected", result, nowIso);
        return { kind: "new", result };
      }
      const active = this.#database
        .prepare(
          `SELECT COALESCE(SUM(byte_length), 0) AS bytes
             FROM input_attachments
            WHERE session_id = ? AND state IN ('uploading', 'ready')
              AND expires_at > ?`,
        )
        .get(message.payload.sessionId, nowIso) as { bytes: number };
      if (active.bytes + message.payload.byteLength > 32 * 1024 * 1024) {
        const result = rejection(
          "ATTACHMENT_SESSION_QUOTA_EXCEEDED",
          "Active attachment allocation exceeds the per-Session limit.",
        );
        this.#insertCommand(message, payloadHash, "rejected", result, nowIso);
        return { kind: "new", result };
      }
      const attachmentId = `attachment-${crypto.randomUUID()}`;
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString();
      const attachment = InputAttachmentSchema.parse({
        attachmentId,
        sessionId: message.payload.sessionId,
        ownerDeviceId: message.payload.deviceId,
        name: message.payload.name,
        kind: message.payload.kind,
        mediaType: message.payload.mediaType,
        byteLength: message.payload.byteLength,
        sha256: message.payload.sha256,
        status: "uploading",
        previewAvailable: false,
        createdAt: nowIso,
        expiresAt,
        referencedTurnId: null,
      });
      const result = parseServer(
        JSON.stringify(
          makeEnvelope("attachment.command.accepted", {
            commandId: message.payload.commandId,
            sessionId: message.payload.sessionId,
            attachment,
          }),
        ),
      );
      this.#insertCommand(message, payloadHash, "terminal", result, nowIso);
      this.#database
        .prepare(
          `INSERT INTO input_attachments (
             attachment_id, session_id, owner_device_id, begin_command_id,
             name, kind, media_type, byte_length, sha256, chunk_count, state,
             content, referenced_turn_id, created_at, updated_at, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', NULL, NULL, ?, ?, ?)`,
        )
        .run(
          attachmentId,
          message.payload.sessionId,
          message.payload.deviceId,
          message.payload.commandId,
          message.payload.name,
          message.payload.kind,
          message.payload.mediaType,
          message.payload.byteLength,
          message.payload.sha256,
          message.payload.chunkCount,
          nowIso,
          nowIso,
          expiresAt,
        );
      return { kind: "new", result };
    });
  }

  async appendInputAttachmentChunk(
    message: Extract<ClientEnvelope, { type: "attachment.upload.chunk" }>,
    now = new Date(),
  ) {
    return this.#write(() => {
      const row = this.#inputAttachmentOptional(message.payload.attachmentId);
      if (
        row === undefined ||
        row.session_id !== message.payload.sessionId ||
        row.owner_device_id !== message.payload.deviceId
      ) {
        throw new InputAttachmentMutationError(
          "ATTACHMENT_SCOPE_MISMATCH",
          "Attachment upload does not belong to this Session and device.",
        );
      }
      if (row.state !== "uploading" || row.expires_at <= now.toISOString()) {
        throw new InputAttachmentMutationError(
          "ATTACHMENT_NOT_UPLOADABLE",
          "Attachment is no longer accepting chunks.",
        );
      }
      if (message.payload.chunkIndex >= row.chunk_count) {
        throw new InputAttachmentMutationError(
          "ATTACHMENT_CHUNK_INDEX_INVALID",
          "Attachment chunk index is outside the declared range.",
        );
      }
      const content = decodeBase64(message.payload.contentBase64);
      const expectedLength = Math.min(
        INPUT_ATTACHMENT_CHUNK_BYTES,
        row.byte_length - message.payload.chunkIndex * INPUT_ATTACHMENT_CHUNK_BYTES,
      );
      if (content.byteLength !== expectedLength) {
        throw new InputAttachmentMutationError(
          "ATTACHMENT_CHUNK_LENGTH_INVALID",
          "Attachment chunk length does not match its declared position.",
        );
      }
      const chunkSha256 = createHash("sha256").update(content).digest("hex");
      const prior = this.#database
        .prepare(
          `SELECT content, sha256 FROM input_attachment_chunks
            WHERE attachment_id = ? AND chunk_index = ?`,
        )
        .get(row.attachment_id, message.payload.chunkIndex) as
        | { content: Uint8Array; sha256: string }
        | undefined;
      if (prior !== undefined) {
        if (
          prior.sha256 !== chunkSha256 ||
          !Buffer.from(prior.content).equals(content)
        ) {
          throw new InputAttachmentMutationError(
            "ATTACHMENT_CHUNK_CONFLICT",
            "A changed duplicate attachment chunk was rejected.",
          );
        }
      } else {
        this.#database
          .prepare(
            `INSERT INTO input_attachment_chunks (
               attachment_id, chunk_index, content, sha256
             ) VALUES (?, ?, ?, ?)`,
          )
          .run(row.attachment_id, message.payload.chunkIndex, content, chunkSha256);
        this.#database
          .prepare("UPDATE input_attachments SET updated_at = ? WHERE attachment_id = ?")
          .run(now.toISOString(), row.attachment_id);
      }
      const count = this.#database
        .prepare(
          "SELECT COUNT(*) AS count FROM input_attachment_chunks WHERE attachment_id = ?",
        )
        .get(row.attachment_id) as { count: number };
      return { receivedChunks: count.count, chunkCount: row.chunk_count };
    });
  }

  async completeInputAttachment(
    message: Extract<ClientEnvelope, { type: "attachment.upload.complete" }>,
    rejection: (code: string, detail: string) => ServerEnvelope,
    now = new Date(),
  ): Promise<MutationResult> {
    return this.#write(() => {
      const payloadHash = commandHash(message);
      const prior = this.#command(message.payload.commandId);
      if (prior !== undefined) {
        return prior.payload_hash === payloadHash
          ? { kind: "same", result: parseServer(prior.result_json) }
          : { kind: "conflict" };
      }
      const nowIso = now.toISOString();
      const row = this.#inputAttachmentOptional(message.payload.attachmentId);
      const reject = (code: string, detail: string) => {
        const result = rejection(code, detail);
        this.#insertCommand(message, payloadHash, "rejected", result, nowIso);
        return { kind: "new" as const, result };
      };
      if (
        row === undefined ||
        row.session_id !== message.payload.sessionId ||
        row.owner_device_id !== message.payload.deviceId
      ) {
        return reject(
          "ATTACHMENT_SCOPE_MISMATCH",
          "Attachment completion does not belong to this Session and device.",
        );
      }
      if (row.state !== "uploading" || row.expires_at <= nowIso) {
        return reject("ATTACHMENT_NOT_UPLOADABLE", "Attachment is not uploadable.");
      }
      const chunks = this.#database
        .prepare(
          `SELECT chunk_index, content FROM input_attachment_chunks
            WHERE attachment_id = ? ORDER BY chunk_index`,
        )
        .all(row.attachment_id) as unknown as Array<{
        chunk_index: number;
        content: Uint8Array;
      }>;
      if (
        chunks.length !== row.chunk_count ||
        chunks.some((chunk, index) => chunk.chunk_index !== index)
      ) {
        return reject(
          "ATTACHMENT_INCOMPLETE",
          "Attachment is missing one or more chunks.",
        );
      }
      const content = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.content)));
      const sha256 = createHash("sha256").update(content).digest("hex");
      const contentError = validateInputAttachmentContent(row, content, sha256);
      if (contentError !== undefined) {
        this.#database
          .prepare(
            `UPDATE input_attachments SET state = 'rejected', content = NULL,
               updated_at = ? WHERE attachment_id = ? AND state = 'uploading'`,
          )
          .run(nowIso, row.attachment_id);
        this.#database
          .prepare("DELETE FROM input_attachment_chunks WHERE attachment_id = ?")
          .run(row.attachment_id);
        return reject(contentError.code, contentError.message);
      }
      this.#database
        .prepare(
          `UPDATE input_attachments SET state = 'ready', content = ?, updated_at = ?
            WHERE attachment_id = ? AND state = 'uploading'`,
        )
        .run(content, nowIso, row.attachment_id);
      this.#database
        .prepare("DELETE FROM input_attachment_chunks WHERE attachment_id = ?")
        .run(row.attachment_id);
      const attachment = inputAttachmentFromRow(this.#inputAttachment(row.attachment_id));
      const result = parseServer(
        JSON.stringify(
          makeEnvelope("attachment.command.accepted", {
            commandId: message.payload.commandId,
            sessionId: message.payload.sessionId,
            attachment,
          }),
        ),
      );
      this.#insertCommand(message, payloadHash, "terminal", result, nowIso);
      return { kind: "new", result };
    });
  }

  async deleteInputAttachment(
    message: Extract<ClientEnvelope, { type: "attachment.delete" }>,
    rejection: (code: string, detail: string) => ServerEnvelope,
    now = new Date(),
  ): Promise<MutationResult> {
    return this.#write(() => {
      const payloadHash = commandHash(message);
      const prior = this.#command(message.payload.commandId);
      if (prior !== undefined) {
        return prior.payload_hash === payloadHash
          ? { kind: "same", result: parseServer(prior.result_json) }
          : { kind: "conflict" };
      }
      const nowIso = now.toISOString();
      const row = this.#inputAttachmentOptional(message.payload.attachmentId);
      if (
        row === undefined ||
        row.session_id !== message.payload.sessionId ||
        row.owner_device_id !== message.payload.deviceId ||
        row.state === "referenced"
      ) {
        const result = rejection(
          "ATTACHMENT_DELETE_REJECTED",
          "Attachment cannot be deleted from this Session and device.",
        );
        this.#insertCommand(message, payloadHash, "rejected", result, nowIso);
        return { kind: "new", result };
      }
      this.#database
        .prepare(
          `UPDATE input_attachments SET state = 'deleted', content = NULL,
             updated_at = ? WHERE attachment_id = ?`,
        )
        .run(nowIso, row.attachment_id);
      this.#database
        .prepare("DELETE FROM input_attachment_chunks WHERE attachment_id = ?")
        .run(row.attachment_id);
      const attachment = inputAttachmentFromRow(this.#inputAttachment(row.attachment_id));
      const result = parseServer(
        JSON.stringify(
          makeEnvelope("attachment.command.accepted", {
            commandId: message.payload.commandId,
            sessionId: message.payload.sessionId,
            attachment,
          }),
        ),
      );
      this.#insertCommand(message, payloadHash, "terminal", result, nowIso);
      return { kind: "new", result };
    });
  }

  async sweepInputAttachments(now = new Date()) {
    return this.#write(() => {
      const nowIso = now.toISOString();
      const rows = this.#database
        .prepare(
          `SELECT attachment_id, session_id, owner_device_id, name, kind,
                  media_type, byte_length, sha256, chunk_count, state, content,
                  referenced_turn_id, created_at, expires_at
             FROM input_attachments
            WHERE state IN ('uploading', 'ready') AND expires_at <= ?`,
        )
        .all(nowIso) as unknown as InputAttachmentRow[];
      for (const row of rows) {
        this.#database
          .prepare(
            `UPDATE input_attachments SET state = 'expired', content = NULL,
               updated_at = ? WHERE attachment_id = ?`,
          )
          .run(nowIso, row.attachment_id);
        this.#database
          .prepare("DELETE FROM input_attachment_chunks WHERE attachment_id = ?")
          .run(row.attachment_id);
      }
      return rows.map((row) => row.attachment_id);
    });
  }

  async acceptTurn(input: {
    message: Extract<ClientEnvelope, { type: "turn.submit" }>;
    turnId: string;
    runtime: Runtime;
    connectorId: string;
    bootId: string;
    activeRejection: ServerEnvelope;
    runtimeBusyRejection?: ServerEnvelope;
    settingsConflictRejection?: ServerEnvelope;
    sessionNotFoundRejection?: ServerEnvelope;
    attachmentRejection?: (code: string, detail: string) => ServerEnvelope;
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
      if (!this.hasSession(input.message.payload.sessionId)) {
        return {
          kind: "new",
          result: input.sessionNotFoundRejection ?? input.activeRejection,
        };
      }
      const settings = this.sessionSettings(input.message.payload.sessionId);
      if (settings === undefined) throw new Error("Session settings disappeared");
      if (
        input.message.payload.settingsRevision !== undefined &&
        input.message.payload.settingsRevision !== settings.revision
      ) {
        const rejection =
          input.settingsConflictRejection ?? input.activeRejection;
        this.#insertCommand(
          input.message,
          payloadHash,
          "rejected",
          rejection,
          now,
        );
        return { kind: "new", result: rejection };
      }
      this.#titleSessionFromFirstPrompt(
        input.message.payload.sessionId,
        input.message.payload.prompt,
        now,
      );
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

      const requestedAttachmentIds = input.message.payload.attachmentIds ?? [];
      let turnAttachments: StoredTurnAttachment[] = [];
      if (requestedAttachmentIds.length > 0) {
        const rejectAttachment = (code: string, detail: string) => {
          const result = input.attachmentRejection?.(code, detail) ?? input.activeRejection;
          this.#insertCommand(input.message, payloadHash, "rejected", result, now);
          return { kind: "new" as const, result };
        };
        if (input.message.payload.deviceId === undefined) {
          return rejectAttachment(
            "ATTACHMENT_DEVICE_REQUIRED",
            "A device identity is required when submitting attachments.",
          );
        }
        if (requestedAttachmentIds.length > MAX_INPUT_ATTACHMENTS_PER_TURN) {
          return rejectAttachment(
            "ATTACHMENT_COUNT_EXCEEDED",
            "Turn attachment count exceeds the supported limit.",
          );
        }
        const rows = requestedAttachmentIds.map((attachmentId) =>
          this.#inputAttachmentOptional(attachmentId),
        );
        if (
          rows.some(
            (row) =>
              row === undefined ||
              row.session_id !== input.message.payload.sessionId ||
              row.owner_device_id !== input.message.payload.deviceId,
          )
        ) {
          return rejectAttachment(
            "ATTACHMENT_SCOPE_MISMATCH",
            "One or more attachments do not belong to this Session and device.",
          );
        }
        if (rows.some((row) => row?.state !== "ready" || row.expires_at <= now)) {
          return rejectAttachment(
            "ATTACHMENT_NOT_READY",
            "One or more attachments are incomplete, expired, or already used.",
          );
        }
        turnAttachments = (rows as InputAttachmentRow[]).map((row) => ({
          attachment: inputAttachmentFromRow(row),
          content: Buffer.from(row.content!),
        }));
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
             state, prompt, started_at, created_at, updated_at,
             settings_revision, settings_snapshot_json, submitting_device_id
           ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)`,
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
          settings.revision,
          JSON.stringify(settings.settings),
          input.message.payload.deviceId ?? null,
        );
      for (const [ordinal, attachment] of turnAttachments.entries()) {
        this.#database
          .prepare(
            `UPDATE input_attachments SET state = 'referenced', referenced_turn_id = ?,
               updated_at = ? WHERE attachment_id = ? AND state = 'ready'`,
          )
          .run(input.turnId, now, attachment.attachment.attachmentId);
        this.#database
          .prepare(
            `INSERT INTO turn_input_attachments (turn_id, attachment_id, ordinal)
             VALUES (?, ?, ?)`,
          )
          .run(input.turnId, attachment.attachment.attachmentId, ordinal);
        attachment.attachment = {
          ...attachment.attachment,
          status: "referenced",
          referencedTurnId: input.turnId,
        };
      }
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
      return {
        kind: "new",
        result: accepted,
        durableEvent,
        turnSettings: { revision: settings.revision, settings: settings.settings },
        turnAttachments,
      };
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
        this.#rejectConnectorIngest(
          source,
          "connector.session.bound",
          "CONNECTOR_RUNTIME_MISMATCH",
        );
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
        this.#rejectConnectorIngest(
          source,
          "connector.turn.bound",
          "CONNECTOR_RUNTIME_MISMATCH",
        );
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
        this.#rejectConnectorIngest(
          source,
          message.type,
          "CONNECTOR_RUNTIME_MISMATCH",
        );
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
        (activity.runtimeId !== undefined && activity.runtimeId !== source.runtimeId) ||
        (activity.runtimeGeneration !== undefined &&
          activity.runtimeGeneration !== source.runtimeGeneration)
      ) {
        this.#rejectConnectorIngest(
          source,
          message.type,
          "CONNECTOR_RUNTIME_MISMATCH",
        );
        return undefined;
      }
      if (
        !this.#matchesRuntimeEvent(
          message.payload.sessionId,
          activity.turnId,
          source.runtimeId,
          source.runtimeGeneration,
          ["running", "outcome_unknown"],
        )
      ) {
        this.#rejectConnectorIngest(
          source,
          message.type,
          "CONNECTOR_RUNTIME_MISMATCH",
        );
        return undefined;
      }
      if (activity.outputArtifact !== undefined && activity.outputArtifact !== null) {
        if (
          !this.#artifactMatches(activity.outputArtifact, {
            sessionId: message.payload.sessionId,
            turnId: activity.turnId,
          })
        ) {
          this.#rejectConnectorIngest(
            source,
            message.type,
            "CONNECTOR_ACTIVITY_INVALID",
          );
          return undefined;
        }
      }
      const now = new Date().toISOString();
      this.#database
        .prepare(
          `INSERT INTO tool_activities (
             id, session_id, turn_id, kind, title, cwd, state, revision,
             exit_code, duration_ms, output_preview, created_at, updated_at,
             command_text, cwd_label, provider_started_at, provider_completed_at,
             stdout_preview, stderr_preview, stdout_truncated, stderr_truncated,
             stderr_available, output_artifact_json, runtime_id,
             runtime_generation, provider_correlation_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             state = excluded.state,
             revision = tool_activities.revision + 1,
             exit_code = excluded.exit_code,
             duration_ms = excluded.duration_ms,
             output_preview = excluded.output_preview,
             command_text = COALESCE(excluded.command_text, tool_activities.command_text),
             cwd_label = COALESCE(excluded.cwd_label, tool_activities.cwd_label),
             provider_started_at = COALESCE(
               tool_activities.provider_started_at, excluded.provider_started_at
             ),
             provider_completed_at = excluded.provider_completed_at,
             stdout_preview = excluded.stdout_preview,
             stderr_preview = excluded.stderr_preview,
             stdout_truncated = excluded.stdout_truncated,
             stderr_truncated = excluded.stderr_truncated,
             stderr_available = excluded.stderr_available,
             output_artifact_json = COALESCE(
               excluded.output_artifact_json, tool_activities.output_artifact_json
             ),
             runtime_id = excluded.runtime_id,
             runtime_generation = excluded.runtime_generation,
             provider_correlation_id = COALESCE(
               tool_activities.provider_correlation_id,
               excluded.provider_correlation_id
             ),
             updated_at = excluded.updated_at`,
        )
        .run(
          activity.activityId,
          message.payload.sessionId,
          activity.turnId,
          activity.kind,
          activity.title,
          null,
          activity.status,
          activity.revision,
          activity.exitCode,
          activity.durationMs,
          activity.outputPreview,
          now,
          now,
          activity.command ?? null,
          activity.cwdLabel ?? null,
          activity.startedAt ?? now,
          activity.completedAt ?? null,
          activity.stdoutPreview ?? activity.outputPreview,
          activity.stderrPreview ?? "",
          activity.stdoutTruncated ? 1 : 0,
          activity.stderrTruncated ? 1 : 0,
          activity.stderrAvailable ? 1 : 0,
          activity.outputArtifact === undefined || activity.outputArtifact === null
            ? null
            : JSON.stringify(activity.outputArtifact),
          source.runtimeId,
          source.runtimeGeneration,
          activity.providerCorrelationId ?? null,
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
        this.#rejectConnectorIngest(
          source,
          message.type,
          "CONNECTOR_RUNTIME_MISMATCH",
        );
        return undefined;
      }
      const now = new Date().toISOString();
      let diff: FileChange["diff"] = null;
      if (message.type === "connector.file.change.completed") {
        if (message.payload.fileChange.inlineDiff !== null) {
          const content = message.payload.fileChange.inlineDiff;
          const byteLength = utf8ByteLength(content);
          if (byteLength > MAX_INLINE_DIFF_BYTES) {
            this.#rejectConnectorIngest(
              source,
              message.type,
              "CONNECTOR_FILE_CHANGE_INVALID",
            );
            return undefined;
          }
          diff = {
            kind: "inline",
            content,
            byteLength,
            sha256: createHash("sha256").update(content).digest("hex"),
          };
        } else if (message.payload.fileChange.artifact !== null) {
          if (
            !this.#artifactMatches(message.payload.fileChange.artifact, {
              sessionId: message.payload.sessionId,
              turnId: fileChange.turnId,
            })
          ) {
            this.#rejectConnectorIngest(
              source,
              message.type,
              "CONNECTOR_FILE_CHANGE_INVALID",
            );
            return undefined;
          }
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
        this.#rejectConnectorIngest(
          source,
          message.type,
          "CONNECTOR_RUNTIME_MISMATCH",
        );
        return undefined;
      }
      const existingApproval = this.#database
        .prepare("SELECT 1 AS present FROM approval_requests WHERE id = ?")
        .get(approval.approvalId) as { present: number } | undefined;
      if (existingApproval !== undefined) {
        this.#rejectConnectorIngest(
          source,
          message.type,
          "CONNECTOR_APPROVAL_ID_CONFLICT",
        );
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

  approvalPolicyContext(approvalId: string): ApprovalPolicyContext | undefined {
    const approvalRow = this.#approvalOptional(approvalId);
    if (approvalRow === undefined) return undefined;
    const turn = this.#database
      .prepare(
        `SELECT settings_revision, settings_snapshot_json, submitting_device_id
           FROM turns
          WHERE id = ? AND session_id = ?`,
      )
      .get(approvalRow.turn_id, approvalRow.session_id) as
      | {
          settings_revision: number | null;
          settings_snapshot_json: string | null;
          submitting_device_id: string | null;
        }
      | undefined;
    if (
      turn?.settings_revision === null ||
      turn?.settings_revision === undefined ||
      turn.settings_snapshot_json === null
    ) {
      return undefined;
    }
    const currentSettings = this.sessionSettings(approvalRow.session_id);
    if (
      currentSettings === undefined ||
      currentSettings.revision !== turn.settings_revision
    ) {
      return undefined;
    }
    const approval = approvalFromRow(approvalRow);
    let files: ApprovalPolicyContext["files"] = [];
    if (approval.payload.fileChangeId !== null) {
      const change = this.#database
        .prepare("SELECT files_json FROM file_changes WHERE id = ? AND session_id = ?")
        .get(approval.payload.fileChangeId, approval.sessionId) as
        | { files_json: string }
        | undefined;
      if (change !== undefined) {
        files = FileChangeSchema.shape.files.parse(JSON.parse(change.files_json));
      }
    }
    return {
      approval,
      providerCorrelationId: approvalRow.provider_correlation_id,
      submittingDeviceId: turn.submitting_device_id,
      settingsRevision: turn.settings_revision,
      settings: SessionSettingsSchema.parse(JSON.parse(turn.settings_snapshot_json)),
      files,
    };
  }

  matchingApprovalLease(
    context: ApprovalPolicyContext,
    coreBootId: string,
    now = new Date().toISOString(),
  ): ApprovalLease | undefined {
    const settings = context.settings;
    if (
      settings.approvalPolicy !== "full_auto_lease" ||
      settings.accountId === null ||
      settings.projectPath === null
    ) {
      return undefined;
    }
    const row = this.#database
      .prepare(
        `SELECT lease_id, session_id, provider_id, account_id, project_path,
                device_id, runtime_id, runtime_generation, settings_revision,
                state, revision, issued_at, expires_at, revoked_at, revoke_reason
           FROM approval_leases WHERE session_id = ? AND state = 'active'
             AND provider_id = ? AND account_id = ? AND project_path = ?
             AND runtime_id = ? AND runtime_generation = ?
             AND settings_revision = ? AND core_boot_id = ? AND expires_at > ?`,
      )
      .get(
        context.approval.sessionId,
        settings.providerId,
        settings.accountId,
        settings.projectPath,
        context.approval.runtimeId,
        context.approval.runtimeGeneration,
        context.settingsRevision,
        coreBootId,
        now,
      ) as ApprovalLeaseRow | undefined;
    return row === undefined || context.submittingDeviceId !== row.device_id
      ? undefined
      : approvalLeaseFromRow(row);
  }

  async recordApprovalPolicyDecision(input: {
    context: ApprovalPolicyContext;
    policy: SessionSettings["approvalPolicy"];
    decision: "pending" | "approved_once";
    classifier: string;
    lease?: ApprovalLease;
    now?: Date;
  }) {
    await this.#write(() => {
      const now = (input.now ?? new Date()).toISOString();
      this.#database
        .prepare(
          `INSERT INTO approval_policy_audit (
             audit_id, session_id, approval_id, lease_id, policy, decision,
             classifier, settings_revision, runtime_id, runtime_generation,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `audit-${crypto.randomUUID()}`,
          input.context.approval.sessionId,
          input.context.approval.approvalId,
          input.lease?.leaseId ?? null,
          input.policy,
          input.decision,
          input.classifier,
          input.context.settingsRevision,
          input.context.approval.runtimeId,
          input.context.approval.runtimeGeneration,
          now,
        );
      if (input.lease !== undefined && input.decision === "approved_once") {
        this.#insertLeaseAudit(
          input.lease.leaseId,
          input.lease.sessionId,
          "use",
          input.lease.deviceId,
          { approvalId: input.context.approval.approvalId },
          now,
        );
      }
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
        this.#rejectConnectorIngest(
          source,
          message.type,
          "CONNECTOR_INTERRUPT_RESULT_INVALID",
        );
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
        this.#rejectConnectorIngest(
          source,
          message.type,
          "CONNECTOR_ARTIFACT_DECLARATION_INVALID",
        );
        return false;
      }
      if (chunkCount !== Math.ceil(artifact.byteLength / ARTIFACT_CHUNK_BYTES)) {
        this.#rejectConnectorIngest(
          source,
          message.type,
          "CONNECTOR_ARTIFACT_DECLARATION_INVALID",
        );
        return false;
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
        this.#rejectConnectorIngest(
          source,
          message.type,
          "CONNECTOR_ARTIFACT_DECLARATION_INVALID",
        );
        return false;
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
        this.#rejectConnectorIngest(
          source,
          message.type,
          "CONNECTOR_ARTIFACT_CHUNK_INVALID",
        );
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
        this.#rejectConnectorIngest(
          source,
          message.type,
          "CONNECTOR_ARTIFACT_CHUNK_INVALID",
        );
        return false;
      }
      const content = decodeBase64(contentBase64);
      const expectedLength = Math.min(
        ARTIFACT_CHUNK_BYTES,
        ingest.byte_length - chunkIndex * ARTIFACT_CHUNK_BYTES,
      );
      if (content.byteLength !== expectedLength) {
        this.#database
          .prepare("DELETE FROM artifact_ingests WHERE id = ?")
          .run(artifactId);
        this.#rejectConnectorIngest(
          source,
          message.type,
          "CONNECTOR_ARTIFACT_CHUNK_INVALID",
        );
        return false;
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
        this.#rejectConnectorIngest(
          source,
          message.type,
          "CONNECTOR_ARTIFACT_INTEGRITY_INVALID",
        );
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
        return false;
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
        this.#database
          .prepare("DELETE FROM artifact_ingests WHERE id = ?")
          .run(artifactId);
        this.#rejectConnectorIngest(
          source,
          message.type,
          "CONNECTOR_ARTIFACT_INTEGRITY_INVALID",
        );
        return false;
      }
      const content = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.content)));
      const sha256 = createHash("sha256").update(content).digest("hex");
      if (content.byteLength !== ingest.byte_length || sha256 !== ingest.sha256) {
        this.#database
          .prepare("DELETE FROM artifact_ingests WHERE id = ?")
          .run(artifactId);
        this.#rejectConnectorIngest(
          source,
          message.type,
          "CONNECTOR_ARTIFACT_INTEGRITY_INVALID",
        );
        return false;
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
        this.#rejectConnectorIngest(
          source,
          message.type,
          "CONNECTOR_TURN_TERMINAL_INVALID",
        );
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
      const pendingBindings = this.#database
        .prepare(
          `SELECT b.session_id, b.command_id, b.provider_id, b.account_id,
                  b.provider_session_id, b.runtime_id, b.runtime_generation,
                  r.connector_id, r.connector_boot_id
             FROM session_provider_bindings b
             JOIN runtimes r ON r.id = b.runtime_id
              AND r.generation = b.runtime_generation
            WHERE b.state = 'pending'`,
        )
        .all() as unknown as PendingBindingRow[];
      events.push(
        ...this.#markBindingsUnknown(
          pendingBindings.filter(
            (row) =>
              row.runtime_id !== runtime.runtimeId ||
              row.runtime_generation !== runtime.generation ||
              row.connector_id !== connectorId ||
              row.connector_boot_id !== bootId ||
              !dispatchProvenCommands.has(row.command_id),
          ),
        ),
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
    return this.#write(() => {
      const events = this.#markMismatchedRuntimesLost(undefined, runtime);
      const bindings = this.#database
        .prepare(
          `SELECT b.session_id, b.command_id, b.provider_id, b.account_id,
                  b.provider_session_id, b.runtime_id, b.runtime_generation,
                  r.connector_id, r.connector_boot_id
             FROM session_provider_bindings b
             JOIN runtimes r ON r.id = b.runtime_id
              AND r.generation = b.runtime_generation
            WHERE b.state = 'pending' AND b.runtime_id = ?
              AND b.runtime_generation = ?`,
        )
        .all(runtime.runtimeId, runtime.generation) as unknown as PendingBindingRow[];
      events.push(...this.#markBindingsUnknown(bindings));
      return events;
    });
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
    const names = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();
    for (const name of names) {
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
    this.#verifyMigrationChecksums(directory, names);
  }

  #verifyMigrationChecksums(directory: string, names: readonly string[]) {
    const columns = this.#database
      .prepare("PRAGMA table_info(schema_migrations)")
      .all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "checksum")) {
      throw new Error("Core schema_migrations checksum column is missing.");
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
        throw new Error(`Core migration ledger mismatch at version ${version}.`);
      }
      if (applied.checksum === null) {
        missing.push({ version, checksum });
      } else if (applied.checksum !== checksum) {
        throw new Error(`Core migration checksum mismatch: ${name}`);
      }
    }
    if (missing.length === 0) return;
    this.#transaction(() => {
      const update = this.#database.prepare(
        "UPDATE schema_migrations SET checksum = ? WHERE version = ? AND checksum IS NULL",
      );
      for (const item of missing) update.run(item.checksum, item.version);
    });
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

  #catalogRevision() {
    const row = this.#database
      .prepare("SELECT revision FROM session_catalog_state WHERE singleton = 1")
      .get() as { revision: number };
    return row.revision;
  }

  #titleSessionFromFirstPrompt(sessionId: string, prompt: string, now: string) {
    const title = sanitizeCatalogText(prompt.replace(/\s+/gu, " "), 160);
    if (title === null) return;
    this.#database
      .prepare(
        `UPDATE sessions SET title = ?, session_revision = session_revision + 1,
           updated_at = ?
         WHERE id = ? AND title = 'Untitled Session'
           AND NOT EXISTS (SELECT 1 FROM turns WHERE session_id = ?)`,
      )
      .run(title, now, sessionId, sessionId);
  }

  #command(commandId: string) {
    return this.#database
      .prepare("SELECT payload_hash, result_json FROM commands WHERE command_id = ?")
      .get(commandId) as CommandRow | undefined;
  }

  #inputAttachmentOptional(attachmentId: string) {
    return this.#database
      .prepare(
        `SELECT attachment_id, session_id, owner_device_id, name, kind,
                media_type, byte_length, sha256, chunk_count, state, content,
                referenced_turn_id, created_at, expires_at
           FROM input_attachments WHERE attachment_id = ?`,
      )
      .get(attachmentId) as InputAttachmentRow | undefined;
  }

  #inputAttachment(attachmentId: string) {
    const row = this.#inputAttachmentOptional(attachmentId);
    if (row === undefined) throw new Error(`Input attachment not found: ${attachmentId}`);
    return row;
  }

  #activity(activityId: string) {
    const row = this.#database
      .prepare(
        `SELECT id, turn_id, kind, title, cwd, state, revision, exit_code,
                duration_ms, output_preview, command_text, cwd_label,
                provider_started_at, provider_completed_at, stdout_preview,
                stderr_preview, stdout_truncated, stderr_truncated,
                stderr_available, output_artifact_json, runtime_id,
                runtime_generation, provider_correlation_id, display_seq
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

  #leaseStateRevision(sessionId: string, now: string) {
    this.#database
      .prepare(
        `INSERT INTO approval_lease_state (session_id, revision, updated_at)
         VALUES (?, 0, ?) ON CONFLICT(session_id) DO NOTHING`,
      )
      .run(sessionId, now);
    const row = this.#database
      .prepare("SELECT revision FROM approval_lease_state WHERE session_id = ?")
      .get(sessionId) as { revision: number };
    return row.revision;
  }

  #approvalLeaseOptional(leaseId: string) {
    return this.#database
      .prepare(
        `SELECT lease_id, session_id, provider_id, account_id, project_path,
                device_id, runtime_id, runtime_generation, settings_revision,
                state, revision, issued_at, expires_at, revoked_at, revoke_reason
           FROM approval_leases WHERE lease_id = ?`,
      )
      .get(leaseId) as ApprovalLeaseRow | undefined;
  }

  #activeApprovalLeases(sessionId: string) {
    return this.#database
      .prepare(
        `SELECT lease_id, session_id, provider_id, account_id, project_path,
                device_id, runtime_id, runtime_generation, settings_revision,
                state, revision, issued_at, expires_at, revoked_at, revoke_reason
           FROM approval_leases WHERE session_id = ? AND state = 'active'
           ORDER BY issued_at, lease_id`,
      )
      .all(sessionId) as unknown as ApprovalLeaseRow[];
  }

  #revokeLeaseRow(
    row: ApprovalLeaseRow,
    action:
      | "revoke"
      | "expire"
      | "emergency_stop"
      | "runtime_change"
      | "settings_change"
      | "core_restart",
    deviceId: string,
    now: string,
    terminalState: "revoked" | "expired" = "revoked",
  ) {
    const updated = this.#database
      .prepare(
        `UPDATE approval_leases SET state = ?, revision = revision + 1,
           revoked_at = ?, revoke_reason = ?
         WHERE lease_id = ? AND state = 'active' AND revision = ?`,
      )
      .run(terminalState, now, action, row.lease_id, row.revision);
    if (Number(updated.changes) !== 1) return false;
    this.#leaseStateRevision(row.session_id, now);
    this.#database
      .prepare(
        `UPDATE approval_lease_state SET revision = revision + 1, updated_at = ?
         WHERE session_id = ?`,
      )
      .run(now, row.session_id);
    this.#insertLeaseAudit(
      row.lease_id,
      row.session_id,
      action,
      deviceId,
      { priorRevision: row.revision },
      now,
    );
    return true;
  }

  #insertLeaseAudit(
    leaseId: string,
    sessionId: string,
    action:
      | "create"
      | "use"
      | "revoke"
      | "expire"
      | "emergency_stop"
      | "runtime_change"
      | "settings_change"
      | "core_restart",
    deviceId: string,
    detail: Record<string, unknown>,
    now: string,
  ) {
    this.#database
      .prepare(
        `INSERT INTO approval_lease_audit (
           audit_id, lease_id, session_id, action, device_id, detail_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `audit-${crypto.randomUUID()}`,
        leaseId,
        sessionId,
        action,
        deviceId,
        JSON.stringify(detail),
        now,
      );
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

  #artifactMatches(
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
    return !(
      row === undefined ||
      row.session_id !== scope.sessionId ||
      row.turn_id !== scope.turnId ||
      row.media_type !== parsed.mediaType ||
      row.byte_length !== parsed.byteLength ||
      row.sha256 !== parsed.sha256
    );
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
        state === "rejected" || state === "terminal" ? now : null,
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
    const seq = this.#allocateSeq(input.sessionId);
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
    const seq = this.#allocateSeq(sessionId);
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

  #allocateSeq(sessionId: string) {
    const row = this.#database
      .prepare(
        `UPDATE sessions SET last_event_seq = last_event_seq + 1
          WHERE id = ? RETURNING last_event_seq`,
      )
      .get(sessionId) as { last_event_seq: number } | undefined;
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

  #rejectConnectorIngest(
    source: ConnectorSource,
    envelopeType: ConnectorEnvelope["type"],
    code: ConnectorIngestRejectionCode,
  ) {
    try {
      this.#onConnectorIngestRejected?.({
        code,
        envelopeType,
        connectorId: source.connectorId,
        sourceEventId: source.sourceEventId,
      });
    } catch {
      // Diagnostics are non-authoritative and must never roll back a consumed
      // poison receipt. The server callback itself emits only bounded output.
      console.error("Core Connector ingest diagnostic callback failed");
    }
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

  #markBindingsUnknown(rows: PendingBindingRow[]): ServerEnvelope[] {
    const events: ServerEnvelope[] = [];
    const now = new Date().toISOString();
    for (const row of rows) {
      const updated = this.#database
        .prepare(
          `UPDATE session_provider_bindings SET state = 'outcome_unknown',
             failure_code = NULL, updated_at = ?
           WHERE session_id = ? AND command_id = ? AND state = 'pending'`,
        )
        .run(now, row.session_id, row.command_id);
      if (Number(updated.changes) !== 1) continue;
      this.#database
        .prepare(
          `UPDATE commands SET state = 'outcome_unknown', terminal_at = ?
            WHERE command_id = ? AND state IN ('committed', 'dispatched')`,
        )
        .run(now, row.command_id);
      events.push(
        parseServer(
          JSON.stringify(
            makeEnvelope("session.provider.status", {
              commandId: row.command_id,
              sessionId: row.session_id,
              providerId: row.provider_id,
              accountId: row.account_id,
              providerSessionId: row.provider_session_id,
              status: "outcome_unknown",
              failureCode: null,
              runtimeId: row.runtime_id,
              runtimeGeneration: row.runtime_generation,
              updatedAt: now,
            }),
          ),
        ),
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

function inputAttachmentFromRow(row: InputAttachmentRow): InputAttachment {
  return InputAttachmentSchema.parse({
    attachmentId: row.attachment_id,
    sessionId: row.session_id,
    ownerDeviceId: row.owner_device_id,
    name: row.name,
    kind: row.kind,
    mediaType: row.media_type,
    byteLength: row.byte_length,
    sha256: row.sha256,
    status: row.state,
    previewAvailable:
      row.state === "ready" && (row.kind === "text" || row.kind === "image"),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    referencedTurnId: row.referenced_turn_id,
  });
}

function validateInputAttachmentContent(
  row: InputAttachmentRow,
  content: Buffer,
  sha256: string,
): { code: string; message: string } | undefined {
  if (content.byteLength !== row.byte_length || sha256 !== row.sha256) {
    return {
      code: "ATTACHMENT_INTEGRITY_MISMATCH",
      message: "Attachment length or SHA-256 does not match its declaration.",
    };
  }
  if (row.kind === "text") {
    if (!new Set(["text/plain", "text/markdown"]).has(row.media_type)) {
      return {
        code: "ATTACHMENT_MEDIA_MISMATCH",
        message: "Text attachment media type does not match its kind.",
      };
    }
    if (content.byteLength > 1024 * 1024 || content.includes(0)) {
      return {
        code: "ATTACHMENT_TEXT_INVALID",
        message: "Text attachments must be at most 1 MiB and contain no NUL bytes.",
      };
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      return {
        code: "ATTACHMENT_TEXT_INVALID",
        message: "Text attachment is not valid UTF-8.",
      };
    }
    return undefined;
  }
  if (row.kind === "image") {
    if (!imageMagicMatches(row.media_type, content)) {
      return {
        code: "ATTACHMENT_MEDIA_MISMATCH",
        message: "Image magic bytes do not match the declared media type.",
      };
    }
    return undefined;
  }
  return {
    code: "ATTACHMENT_KIND_UNSUPPORTED",
    message: "This attachment kind is stored but not supported by the Codex adapter.",
  };
}

function imageMagicMatches(mediaType: string, content: Buffer) {
  if (mediaType === "image/png") {
    return content.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  }
  if (mediaType === "image/jpeg") {
    return content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
  }
  if (mediaType === "image/gif") {
    const signature = content.subarray(0, 6).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  }
  if (mediaType === "image/webp") {
    return (
      content.subarray(0, 4).toString("ascii") === "RIFF" &&
      content.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  return false;
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
    command: row.command_text,
    cwdLabel: row.cwd_label,
    startedAt: row.provider_started_at ?? undefined,
    completedAt: row.provider_completed_at,
    stdoutPreview: row.stdout_preview,
    stderrPreview: row.stderr_preview,
    stdoutTruncated: row.stdout_truncated === 1,
    stderrTruncated: row.stderr_truncated === 1,
    stderrAvailable: row.stderr_available === 1,
    outputArtifact:
      row.output_artifact_json === null
        ? null
        : ArtifactReferenceSchema.parse(JSON.parse(row.output_artifact_json)),
    runtimeId: row.runtime_id ?? undefined,
    runtimeGeneration: row.runtime_generation ?? undefined,
    providerCorrelationId: row.provider_correlation_id ?? undefined,
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

function approvalLeaseFromRow(row: ApprovalLeaseRow): ApprovalLease {
  return ApprovalLeaseSchema.parse({
    leaseId: row.lease_id,
    sessionId: row.session_id,
    providerId: row.provider_id,
    accountId: row.account_id,
    projectPath: row.project_path,
    deviceId: row.device_id,
    runtimeId: row.runtime_id,
    runtimeGeneration: row.runtime_generation,
    settingsRevision: row.settings_revision,
    state: row.state,
    revision: row.revision,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokeReason: row.revoke_reason,
  });
}

function sessionSettingsSnapshot(row: SessionSettingsRow): SessionSettingsSnapshot {
  return SessionSettingsSnapshotSchema.parse({
    sessionId: row.session_id,
    revision: row.revision,
    mutable: (row.active_turn_count ?? 0) === 0,
    settings: {
      providerId: row.provider_id,
      accountId: row.account_id,
      model: row.model,
      reasoningLevel: row.reasoning_level,
      executionMode: row.execution_mode,
      approvalPolicy: row.approval_policy,
      sandboxPolicy: row.sandbox_policy,
      networkPolicy: row.network_policy,
      projectPath: row.project_path,
      branch: row.branch,
    },
  });
}

function sessionCatalogEntry(
  row: SessionCatalogRow,
  providerControlAvailable: boolean,
): SessionSummaryV2 {
  const projectPath = sanitizeCatalogText(row.project_path, 4_096);
  const projectName = projectPath === null
    ? null
    : (sanitizeCatalogText(basename(projectPath), 160) ?? "Project");
  const providerId = normalizeCatalogSlug(row.provider_id) ?? "unknown";
  const accountId = normalizeCatalogSlug(row.account_id);
  const archived = row.archived === 1;
  const canControl = !archived && providerControlAvailable;
  const providerBindingStatus = row.binding_state ?? "unbound";
  const bindingAllowsControl = providerBindingStatus === "ready";
  return {
    sessionId: row.id,
    title: sanitizeCatalogText(row.title, 160) ?? "Untitled Session",
    providerId,
    accountId,
    providerSessionId: row.provider_session_id,
    source: row.source,
    providerBindingStatus,
    projectPath,
    projectName,
    branch: sanitizeCatalogText(row.branch, 512),
    model: sanitizeCatalogText(row.model, 128),
    reasoningLevel: sanitizeCatalogText(row.reasoning_level, 64),
    executionMode: row.execution_mode,
    approvalPolicy: row.approval_policy,
    sandboxPolicy: row.sandbox_policy,
    networkPolicy: row.network_policy,
    state: row.operational_state,
    runtimeStatus: row.runtime_state,
    activeTurnId: row.active_turn_id,
    pendingApprovalCount: row.pending_approval_count,
    turnCount: row.turn_count,
    unreadCount: row.unread_count,
    lastActivityAt: row.updated_at,
    lastEventSeq: row.last_event_seq,
    canResume:
      canControl &&
      providerBindingStatus === "ready" &&
      row.provider_session_id !== null,
    canControl: canControl && bindingAllowsControl,
    pinned: row.pinned === 1,
    archived,
    revision: row.session_revision,
    settingsRevision: row.settings_revision,
  };
}

function sessionMetadataMutation(
  message: SessionMetadataCommand,
  row: { title: string; pinned: number; archived: number },
) {
  switch (message.type) {
    case "session.rename":
      return {
        action: "rename" as const,
        column: "title" as const,
        databaseValue: message.payload.title,
        oldValue: { title: row.title },
        newValue: { title: message.payload.title },
        changed: row.title !== message.payload.title,
      };
    case "session.pin":
      return {
        action: "pin" as const,
        column: "pinned" as const,
        databaseValue: message.payload.pinned ? 1 : 0,
        oldValue: { pinned: row.pinned === 1 },
        newValue: { pinned: message.payload.pinned },
        changed: (row.pinned === 1) !== message.payload.pinned,
      };
    case "session.archive":
      return {
        action: message.payload.archived ? ("archive" as const) : ("unarchive" as const),
        column: "archived" as const,
        databaseValue: message.payload.archived ? 1 : 0,
        oldValue: { archived: row.archived === 1 },
        newValue: { archived: message.payload.archived },
        changed: (row.archived === 1) !== message.payload.archived,
      };
  }
}

function addInFilter(
  clauses: string[],
  values: SQLInputValue[],
  column: string,
  selected: readonly string[],
) {
  if (selected.length === 0) return;
  clauses.push(`${column} IN (${selected.map(() => "?").join(", ")})`);
  values.push(...selected);
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

function encodeCatalogCursor(cursor: SessionCatalogCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCatalogCursor(value: string | null): SessionCatalogCursor | null {
  if (value === null || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Object.keys(parsed).sort().join(",") !==
        "catalogRevision,lastActivityAt,sessionId,version"
    ) {
      return null;
    }
    const cursor = parsed as Record<string, unknown>;
    if (
      cursor.version !== 1 ||
      !Number.isSafeInteger(cursor.catalogRevision) ||
      Number(cursor.catalogRevision) <= 0 ||
      typeof cursor.lastActivityAt !== "string" ||
      Number.isNaN(Date.parse(cursor.lastActivityAt)) ||
      typeof cursor.sessionId !== "string" ||
      cursor.sessionId.length < 1 ||
      cursor.sessionId.length > 200
    ) {
      return null;
    }
    return cursor as unknown as SessionCatalogCursor;
  } catch {
    return null;
  }
}

function sanitizeCatalogText(value: string | null, maxLength: number) {
  if (value === null) return null;
  let clean = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
    clean += character;
  }
  clean = clean.trim();
  if (clean.length === 0) return null;
  return clean.slice(0, maxLength);
}

function normalizeCatalogSlug(value: string | null) {
  if (value === null) return null;
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]/gu, "-");
  const trimmed = normalized.replace(/^-+/u, "").slice(0, 96);
  return /^[a-z0-9]/u.test(trimmed) ? trimmed : null;
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
