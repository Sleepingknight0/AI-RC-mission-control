import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  ARTIFACT_CHUNK_BYTES,
  ClientEnvelopeSchema,
  ConnectorEnvelopeSchema,
  MAX_ARTIFACT_BYTES,
  ServerEnvelopeSchema,
  makeEnvelope,
  type Runtime,
} from "@aicl/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { CoreDatabase } from "../src/store.js";

const temporaryDirectories: string[] = [];
const openDatabases: CoreDatabase[] = [];

afterEach(async () => {
  await Promise.all(openDatabases.splice(0).map((database) => database.close()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Core SQLite contract", () => {
  it("applies schema v12 idempotently with checksummed migrations and required indexes", async () => {
    const path = databasePath();
    const first = open(path);
    expect(first.schemaVersion).toBe(12);
    expect(Object.values(first.pragma("journal_mode"))).toContain("wal");
    expect(Object.values(first.pragma("foreign_keys"))).toContain(1);
    expect(Object.values(first.pragma("busy_timeout"))).toContain(5000);
    await first.close();
    openDatabases.splice(openDatabases.indexOf(first), 1);

    const second = open(path);
    expect(second.schemaVersion).toBe(12);
    await second.close();
    openDatabases.splice(openDatabases.indexOf(second), 1);

    const raw = new DatabaseSync(path);
    const migrations = raw
      .prepare("SELECT checksum FROM schema_migrations ORDER BY version")
      .all() as unknown as Array<{ checksum: string | null }>;
    expect(migrations).toHaveLength(12);
    expect(migrations.every((migration) => /^[a-f0-9]{64}$/u.test(migration.checksum ?? ""))).toBe(true);
    const indexes = raw
      .prepare(
        `SELECT name, sql FROM sqlite_master
          WHERE type = 'index' AND name IN (
            'uq_turn_one_executing_per_session',
            'uq_turn_one_executing_per_runtime',
            'uq_session_events_connector_source',
            'ix_tool_activities_turn_started',
            'ix_turns_session_created',
            'ix_approval_requests_session_state'
          ) ORDER BY name`,
      )
      .all() as unknown as Array<{ name: string; sql: string }>;
    expect(indexes.map((index) => index.name)).toEqual([
      "ix_approval_requests_session_state",
      "ix_tool_activities_turn_started",
      "ix_turns_session_created",
      "uq_session_events_connector_source",
      "uq_turn_one_executing_per_runtime",
      "uq_turn_one_executing_per_session",
    ]);
    expect(indexes[0]?.sql).toContain("session_id, state");
    expect(indexes[1]?.sql).toContain("provider_started_at");
    expect(indexes[2]?.sql).toContain("session_id, created_at DESC");
    expect(indexes[3]?.sql).toContain("source_event_id IS NOT NULL");
    expect(indexes[4]?.sql).toContain("runtime_id, runtime_generation");
    expect(indexes[5]?.sql).toContain("WHERE state = 'running'");

    const now = new Date().toISOString();
    raw.prepare(
      "INSERT INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)",
    ).run("guard-session", now, now);
    expect(
      raw
        .prepare(
          "SELECT sandbox_policy, network_policy FROM session_settings WHERE session_id = ?",
        )
        .get("guard-session"),
    ).toEqual({ sandbox_policy: "read_only", network_policy: "denied" });
    expect(() =>
      raw
        .prepare(
          `INSERT INTO commands (
             command_id, session_id, command_type, state, payload_json,
             payload_hash, result_json, received_at, committed_at
           ) VALUES (?, ?, ?, ?, '{}', ?, '{}', ?, ?)`,
        )
        .run(
          "invalid-command",
          "guard-session",
          "shell.exec",
          "invented",
          "hash",
          now,
          now,
        ),
    ).toThrow("invalid command type or initial state");
    raw.close();
  });

  it("migrates legacy and ambiguous Session settings to fail-closed defaults", () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'Untitled Session',
        source TEXT NOT NULL DEFAULT 'aicl', pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0, session_revision INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE session_settings (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id), revision INTEGER NOT NULL DEFAULT 0,
        provider_id TEXT NOT NULL DEFAULT 'codex', account_id TEXT, model TEXT,
        reasoning_level TEXT, execution_mode TEXT NOT NULL DEFAULT 'ask',
        approval_policy TEXT NOT NULL DEFAULT 'review',
        sandbox_policy TEXT NOT NULL DEFAULT 'workspace_write',
        network_policy TEXT NOT NULL DEFAULT 'restricted', project_path TEXT,
        branch TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE session_provider_bindings (
        session_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, account_id TEXT NOT NULL,
        provider_session_id TEXT, state TEXT NOT NULL
      ) STRICT;
      CREATE TABLE session_catalog_state (
        singleton INTEGER PRIMARY KEY, revision INTEGER NOT NULL
      ) STRICT;
      INSERT INTO session_catalog_state VALUES (1, 1);
      CREATE TABLE turns (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, state TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE approval_requests (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, state TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TRIGGER session_settings_after_session_insert AFTER INSERT ON sessions BEGIN
        INSERT INTO session_settings (session_id, created_at, updated_at)
        VALUES (NEW.id, NEW.created_at, NEW.updated_at);
      END;
      CREATE TRIGGER session_catalog_after_insert AFTER INSERT ON sessions BEGIN
        UPDATE session_catalog_state SET revision = revision + 1 WHERE singleton = 1;
      END;
      CREATE TRIGGER session_catalog_after_update AFTER UPDATE ON sessions BEGIN
        UPDATE session_catalog_state SET revision = revision + 1 WHERE singleton = 1;
      END;
      CREATE TRIGGER session_catalog_after_delete AFTER DELETE ON sessions BEGIN
        UPDATE session_catalog_state SET revision = revision + 1 WHERE singleton = 1;
      END;
      CREATE TRIGGER session_catalog_after_settings_update AFTER UPDATE ON session_settings BEGIN
        UPDATE session_catalog_state SET revision = revision + 1 WHERE singleton = 1;
      END;
      INSERT INTO sessions (id, created_at, updated_at) VALUES
        ('legacy', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('ready', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      UPDATE session_settings SET project_path = 'C:\\workspace' WHERE session_id = 'ready';
      INSERT INTO session_provider_bindings VALUES
        ('ready', 'codex', 'default', 'native-ready', 'ready');
    `);

    raw.exec(
      readFileSync(
        resolve("migrations/012_audit_fail_closed_sessions.sql"),
        "utf8",
      ),
    );
    expect(
      raw
        .prepare(
          "SELECT session_id, sandbox_policy, network_policy FROM session_settings ORDER BY session_id",
        )
        .all(),
    ).toEqual([
      { session_id: "legacy", sandbox_policy: "read_only", network_policy: "denied" },
      { session_id: "ready", sandbox_policy: "workspace_write", network_policy: "denied" },
    ]);
    raw.prepare(
      "INSERT INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)",
    ).run("new-session", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    expect(
      raw
        .prepare(
          "SELECT sandbox_policy, network_policy FROM session_settings WHERE session_id = 'new-session'",
        )
        .get(),
    ).toEqual({ sandbox_policy: "read_only", network_policy: "denied" });
    raw.close();
  });

  it("serializes duplicate races and keeps revision independent from event seq", async () => {
    const database = open(databasePath());
    const message = ClientEnvelopeSchema.parse(
      makeEnvelope("turn.submit", {
        commandId: "race-command",
        sessionId: "race-session",
        prompt: "dispatch once",
      }),
    );
    if (message.type !== "turn.submit") throw new Error("Expected turn.submit");
    await database.ensureSession(message.payload.sessionId);
    const activeRejection = ServerEnvelopeSchema.parse(
      makeEnvelope("command.rejected", {
        commandId: message.payload.commandId,
        sessionId: message.payload.sessionId,
        error: {
          code: "TURN_ALREADY_ACTIVE",
          message: "active",
          retryable: false,
        },
      }),
    );
    const runtime: Runtime = {
      runtimeId: "runtime-race",
      generation: 1,
      status: "ready",
    };
    const decisions = await Promise.all([
      database.acceptTurn({
        message,
        turnId: "turn-race-a",
        runtime,
        connectorId: "connector-race",
        bootId: "boot-race",
        activeRejection,
      }),
      database.acceptTurn({
        message,
        turnId: "turn-race-b",
        runtime,
        connectorId: "connector-race",
        bootId: "boot-race",
        activeRejection,
      }),
    ]);

    expect(decisions.filter((decision) => decision.kind === "new")).toHaveLength(1);
    expect(decisions.filter((decision) => decision.kind === "same")).toHaveLength(1);
    expect(
      decisions.map((decision) =>
        decision.kind === "conflict" ? null : decision.result.payload,
      ),
    ).toEqual([
      expect.objectContaining({ turnId: "turn-race-a" }),
      expect.objectContaining({ turnId: "turn-race-a" }),
    ]);

    const snapshot = database.snapshot("race-session");
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.revision).toBe(0);
    expect(snapshot.lastEventSeq).toBe(1);
    const replay = database.replay("race-session", 0, 1);
    expect(replay).toHaveLength(1);
    expect(replay[0]?.type).toBe("turn.started");
    expect(replay[0]?.payload).toMatchObject({ seq: 1 });

    const changed = ClientEnvelopeSchema.parse(
      makeEnvelope("turn.submit", {
        commandId: "race-command",
        sessionId: "race-session",
        prompt: "different payload",
      }),
    );
    if (changed.type !== "turn.submit") throw new Error("Expected turn.submit");
    expect(database.priorCommand(changed)?.kind).toBe("conflict");
  });

  it("rejects artifact assembly when byte length or SHA-256 does not match", async () => {
    const database = open(databasePath());
    const runtime: Runtime = {
      runtimeId: "runtime-artifact",
      generation: 1,
      status: "ready",
    };
    const turn = ClientEnvelopeSchema.parse(
      makeEnvelope("turn.submit", {
        commandId: "artifact-turn-command",
        sessionId: "artifact-session",
        prompt: "produce artifact",
      }),
    );
    if (turn.type !== "turn.submit") throw new Error("Expected turn.submit");
    await database.ensureSession(turn.payload.sessionId);
    await database.acceptTurn({
      message: turn,
      turnId: "artifact-turn",
      runtime,
      connectorId: "artifact-connector",
      bootId: "artifact-boot",
      activeRejection: ServerEnvelopeSchema.parse(
        makeEnvelope("command.rejected", {
          commandId: turn.payload.commandId,
          sessionId: turn.payload.sessionId,
          error: { code: "TURN_ALREADY_ACTIVE", message: "active", retryable: false },
        }),
      ),
    });
    const artifact = {
      artifactId: "artifact-corrupt",
      mediaType: "text/x-diff",
      byteLength: 7,
      sha256: "0".repeat(64),
      downloadPath: "/artifacts/artifact-corrupt",
    };
    const source = (sourceEventId: string) => ({
      connectorId: "artifact-connector",
      sourceEventId,
      runtimeId: runtime.runtimeId,
      runtimeGeneration: runtime.generation,
    });
    const begin = ConnectorEnvelopeSchema.parse(
      makeEnvelope("connector.artifact.begin", {
        sessionId: "artifact-session",
        turnId: "artifact-turn",
        artifact,
        chunkCount: 1,
      }),
    );
    const chunk = ConnectorEnvelopeSchema.parse(
      makeEnvelope("connector.artifact.chunk", {
        sessionId: "artifact-session",
        turnId: "artifact-turn",
        artifactId: artifact.artifactId,
        chunkIndex: 0,
        contentBase64: Buffer.from("content").toString("base64"),
      }),
    );
    const complete = ConnectorEnvelopeSchema.parse(
      makeEnvelope("connector.artifact.complete", {
        sessionId: "artifact-session",
        turnId: "artifact-turn",
        artifactId: artifact.artifactId,
      }),
    );
    if (
      begin.type !== "connector.artifact.begin" ||
      chunk.type !== "connector.artifact.chunk" ||
      complete.type !== "connector.artifact.complete"
    ) {
      throw new Error("Expected artifact envelopes");
    }
    const wrongChunkCount = ConnectorEnvelopeSchema.parse(
      makeEnvelope("connector.artifact.begin", {
        sessionId: "artifact-session",
        turnId: "artifact-turn",
        artifact: { ...artifact, artifactId: "artifact-wrong-chunks" },
        chunkCount: 2,
      }),
    );
    if (wrongChunkCount.type !== "connector.artifact.begin") {
      throw new Error("Expected artifact begin envelope");
    }
    await expect(
      database.beginArtifact(
        wrongChunkCount,
        source("artifact-wrong-chunks-begin"),
      ),
    ).resolves.toBe(false);
    await expect(
      database.beginArtifact(
        wrongChunkCount,
        source("artifact-wrong-chunks-begin"),
      ),
    ).resolves.toBeUndefined();
    await database.beginArtifact(begin, source("artifact-begin"));
    await database.appendArtifactChunk(chunk, source("artifact-chunk"));
    await expect(
      database.completeArtifact(complete, source("artifact-complete")),
    ).resolves.toBe(false);
    await expect(
      database.completeArtifact(complete, source("artifact-complete")),
    ).resolves.toBeUndefined();
    expect(database.artifact(artifact.artifactId)).toBeUndefined();

    for (let index = 0; index < 4; index += 1) {
      const declaration = ConnectorEnvelopeSchema.parse(
        makeEnvelope("connector.artifact.begin", {
          sessionId: "artifact-session",
          turnId: "artifact-turn",
          artifact: {
            artifactId: `artifact-quota-${index}`,
            mediaType: "text/x-diff",
            byteLength: MAX_ARTIFACT_BYTES,
            sha256: "a".repeat(64),
            downloadPath: `/artifacts/artifact-quota-${index}`,
          },
          chunkCount: MAX_ARTIFACT_BYTES / ARTIFACT_CHUNK_BYTES,
        }),
      );
      if (declaration.type !== "connector.artifact.begin") {
        throw new Error("Expected artifact begin envelope");
      }
      await database.beginArtifact(declaration, source(`quota-${index}`));
    }
    const overQuota = ConnectorEnvelopeSchema.parse(
      makeEnvelope("connector.artifact.begin", {
        sessionId: "artifact-session",
        turnId: "artifact-turn",
        artifact: {
          artifactId: "artifact-over-quota",
          mediaType: "text/x-diff",
          byteLength: MAX_ARTIFACT_BYTES,
          sha256: "b".repeat(64),
          downloadPath: "/artifacts/artifact-over-quota",
        },
        chunkCount: MAX_ARTIFACT_BYTES / ARTIFACT_CHUNK_BYTES,
      }),
    );
    if (overQuota.type !== "connector.artifact.begin") {
      throw new Error("Expected artifact begin envelope");
    }
    await expect(
      database.beginArtifact(overQuota, source("quota-overflow")),
    ).resolves.toBe(false);
  });

  it("persists normalized terminal metadata without private cwd or forged Runtime identity", async () => {
    const database = open(databasePath());
    const runtime: Runtime = {
      runtimeId: "runtime-terminal",
      generation: 2,
      status: "ready",
    };
    const turn = ClientEnvelopeSchema.parse(
      makeEnvelope("turn.submit", {
        commandId: "terminal-turn-command",
        sessionId: "terminal-session",
        prompt: "produce bounded terminal evidence",
      }),
    );
    if (turn.type !== "turn.submit") throw new Error("Expected turn.submit");
    await database.ensureSession(turn.payload.sessionId);
    await database.acceptTurn({
      message: turn,
      turnId: "terminal-turn",
      runtime,
      connectorId: "terminal-connector",
      bootId: "terminal-boot",
      activeRejection: ServerEnvelopeSchema.parse(
        makeEnvelope("command.rejected", {
          commandId: turn.payload.commandId,
          sessionId: turn.payload.sessionId,
          error: { code: "TURN_ALREADY_ACTIVE", message: "active", retryable: false },
        }),
      ),
    });
    const source = (sourceEventId: string) => ({
      connectorId: "terminal-connector",
      sourceEventId,
      runtimeId: runtime.runtimeId,
      runtimeGeneration: runtime.generation,
    });
    const content = Buffer.from("redacted bounded terminal evidence", "utf8");
    const artifact = {
      artifactId: "artifact-terminal",
      mediaType: "text/plain; charset=utf-8" as const,
      byteLength: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
      downloadPath: "/artifacts/artifact-terminal",
    };
    const begin = ConnectorEnvelopeSchema.parse(
      makeEnvelope("connector.artifact.begin", {
        sessionId: "terminal-session",
        turnId: "terminal-turn",
        artifact,
        chunkCount: 1,
      }),
    );
    const chunk = ConnectorEnvelopeSchema.parse(
      makeEnvelope("connector.artifact.chunk", {
        sessionId: "terminal-session",
        turnId: "terminal-turn",
        artifactId: artifact.artifactId,
        chunkIndex: 0,
        contentBase64: content.toString("base64"),
      }),
    );
    const complete = ConnectorEnvelopeSchema.parse(
      makeEnvelope("connector.artifact.complete", {
        sessionId: "terminal-session",
        turnId: "terminal-turn",
        artifactId: artifact.artifactId,
      }),
    );
    if (
      begin.type !== "connector.artifact.begin" ||
      chunk.type !== "connector.artifact.chunk" ||
      complete.type !== "connector.artifact.complete"
    ) throw new Error("Expected artifact envelopes");
    await database.beginArtifact(begin, source("terminal-artifact-begin"));
    await database.appendArtifactChunk(chunk, source("terminal-artifact-chunk"));
    await database.completeArtifact(complete, source("terminal-artifact-complete"));

    const startedAt = "2026-08-03T01:02:03.000Z";
    const completedAt = "2026-08-03T01:02:03.025Z";
    const normalized = {
      activityId: "activity-terminal",
      turnId: "terminal-turn",
      kind: "command" as const,
      title: "pnpm test",
      cwd: "C:\\Users\\operator\\private",
      status: "completed" as const,
      revision: 1,
      exitCode: 0,
      durationMs: 25,
      outputPreview: "bounded terminal evidence",
      command: "pnpm test",
      cwdLabel: ".",
      startedAt,
      completedAt,
      stdoutPreview: "bounded terminal evidence",
      stderrPreview: "",
      stdoutTruncated: true,
      stderrTruncated: false,
      stderrAvailable: false,
      outputArtifact: artifact,
      runtimeId: runtime.runtimeId,
      runtimeGeneration: runtime.generation,
      providerCorrelationId: "activity-correlation-terminal",
    };
    const message = ConnectorEnvelopeSchema.parse(
      makeEnvelope("connector.activity.completed", {
        sessionId: "terminal-session",
        activity: normalized,
      }),
    );
    if (message.type !== "connector.activity.completed") {
      throw new Error("Expected activity envelope");
    }
    await database.recordActivity(message, source("terminal-activity-complete"));
    const activity = database.snapshot("terminal-session").activities[0];
    expect(activity).toMatchObject({
      cwd: null,
      cwdLabel: ".",
      command: "pnpm test",
      startedAt,
      completedAt,
      runtimeId: runtime.runtimeId,
      runtimeGeneration: runtime.generation,
      outputArtifact: artifact,
    });
    expect(JSON.stringify(activity)).not.toContain("C:\\Users\\operator");

    const forged = ConnectorEnvelopeSchema.parse(
      makeEnvelope("connector.activity.completed", {
        sessionId: "terminal-session",
        activity: { ...normalized, runtimeGeneration: runtime.generation + 1 },
      }),
    );
    if (forged.type !== "connector.activity.completed") {
      throw new Error("Expected forged activity envelope");
    }
    await expect(
      database.recordActivity(forged, source("terminal-activity-forged")),
    ).resolves.toBeUndefined();
    await expect(
      database.recordActivity(forged, source("terminal-activity-forged")),
    ).resolves.toBeUndefined();
  });
});

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "aicl-core-db-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "core.db");
}

function open(path: string) {
  const database = new CoreDatabase({ path });
  openDatabases.push(database);
  return database;
}
