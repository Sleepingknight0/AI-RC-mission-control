import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  it("applies schema v10 idempotently with checksummed migrations and required indexes", async () => {
    const path = databasePath();
    const first = open(path);
    expect(first.schemaVersion).toBe(10);
    expect(Object.values(first.pragma("journal_mode"))).toContain("wal");
    expect(Object.values(first.pragma("foreign_keys"))).toContain(1);
    expect(Object.values(first.pragma("busy_timeout"))).toContain(5000);
    await first.close();
    openDatabases.splice(openDatabases.indexOf(first), 1);

    const second = open(path);
    expect(second.schemaVersion).toBe(10);
    await second.close();
    openDatabases.splice(openDatabases.indexOf(second), 1);

    const raw = new DatabaseSync(path);
    const migrations = raw
      .prepare("SELECT checksum FROM schema_migrations ORDER BY version")
      .all() as unknown as Array<{ checksum: string | null }>;
    expect(migrations).toHaveLength(10);
    expect(migrations.every((migration) => /^[a-f0-9]{64}$/u.test(migration.checksum ?? ""))).toBe(true);
    const indexes = raw
      .prepare(
        `SELECT name, sql FROM sqlite_master
          WHERE type = 'index' AND name IN (
            'uq_turn_one_executing_per_session',
            'uq_turn_one_executing_per_runtime',
            'uq_session_events_connector_source'
          ) ORDER BY name`,
      )
      .all() as unknown as Array<{ name: string; sql: string }>;
    expect(indexes.map((index) => index.name)).toEqual([
      "uq_session_events_connector_source",
      "uq_turn_one_executing_per_runtime",
      "uq_turn_one_executing_per_session",
    ]);
    expect(indexes[0]?.sql).toContain("source_event_id IS NOT NULL");
    expect(indexes[1]?.sql).toContain("runtime_id, runtime_generation");
    expect(indexes[2]?.sql).toContain("WHERE state = 'running'");

    const now = new Date().toISOString();
    raw.prepare(
      "INSERT INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)",
    ).run("guard-session", now, now);
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
    ).rejects.toThrow("chunk count does not match");
    await database.beginArtifact(begin, source("artifact-begin"));
    await database.appendArtifactChunk(chunk, source("artifact-chunk"));
    await expect(
      database.completeArtifact(complete, source("artifact-complete")),
    ).rejects.toThrow("Artifact integrity check failed");
    expect(database.artifact(artifact.artifactId)).toBeUndefined();

    for (let index = 0; index < 3; index += 1) {
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
    ).rejects.toThrow("Artifact quota");
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
