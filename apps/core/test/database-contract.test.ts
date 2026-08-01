import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  ClientEnvelopeSchema,
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
  it("applies migration v1 idempotently with required pragmas and indexes", async () => {
    const path = databasePath();
    const first = open(path);
    expect(first.schemaVersion).toBe(1);
    expect(Object.values(first.pragma("journal_mode"))).toContain("wal");
    expect(Object.values(first.pragma("foreign_keys"))).toContain(1);
    expect(Object.values(first.pragma("busy_timeout"))).toContain(5000);
    await first.close();
    openDatabases.splice(openDatabases.indexOf(first), 1);

    const second = open(path);
    expect(second.schemaVersion).toBe(1);
    await second.close();
    openDatabases.splice(openDatabases.indexOf(second), 1);

    const raw = new DatabaseSync(path, { readOnly: true });
    const indexes = raw
      .prepare(
        `SELECT name, sql FROM sqlite_master
          WHERE type = 'index' AND name IN (
            'uq_turn_one_executing_per_session',
            'uq_session_events_connector_source'
          ) ORDER BY name`,
      )
      .all() as unknown as Array<{ name: string; sql: string }>;
    expect(indexes.map((index) => index.name)).toEqual([
      "uq_session_events_connector_source",
      "uq_turn_one_executing_per_session",
    ]);
    expect(indexes[0]?.sql).toContain("source_event_id IS NOT NULL");
    expect(indexes[1]?.sql).toContain("WHERE state = 'running'");
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
