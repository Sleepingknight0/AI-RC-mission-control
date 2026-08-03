import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ClientEnvelopeSchema,
  ServerEnvelopeSchema,
  makeEnvelope,
  type ClientEnvelope,
  type ServerEnvelope,
  type SessionSettings,
} from "@aicl/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { CoreDatabase } from "../src/store.js";

const databases: CoreDatabase[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("Session settings", () => {
  it("uses compare-and-set updates and returns the authoritative conflict snapshot", async () => {
    const database = openDatabase();
    await database.ensureSession("settings-session");
    const initial = database.sessionSettings("settings-session");
    if (initial === undefined) throw new Error("Expected initial settings");
    const first = settingsCommand("settings-session", "settings-a", 0, {
      ...initial.settings,
      branch: "main",
    });
    const competing = settingsCommand("settings-session", "settings-b", 0, {
      ...initial.settings,
      branch: "release",
    });

    const [firstResult, competingResult] = await Promise.all([
      database.mutateSessionSettings(first, allow, reject(first)),
      database.mutateSessionSettings(competing, allow, reject(competing)),
    ]);
    expect(firstResult.kind).toBe("new");
    expect(competingResult.kind).toBe("new");
    if (firstResult.kind !== "new" || competingResult.kind !== "new") return;
    expect(firstResult.result.type).toBe("session.command.accepted");
    expect(competingResult.result.type).toBe("command.rejected");
    if (competingResult.result.type !== "command.rejected") return;
    expect(competingResult.result.payload.error.code).toBe(
      "SESSION_SETTINGS_CONFLICT",
    );
    expect(competingResult.snapshot).toMatchObject({
      revision: 1,
      settings: { branch: "main" },
    });

    const replay = await database.mutateSessionSettings(
      first,
      allow,
      reject(first),
    );
    expect(replay.kind).toBe("same");
  });

  it("stores immutable effective settings and rejects updates during a Turn", async () => {
    const database = openDatabase();
    await database.ensureSession("turn-settings-session");
    const initial = database.sessionSettings("turn-settings-session");
    if (initial === undefined) throw new Error("Expected initial settings");
    const updated = settingsCommand("turn-settings-session", "settings-model", 0, {
      ...initial.settings,
      model: "verified-model",
      reasoningLevel: "high",
    });
    await database.mutateSessionSettings(updated, allow, reject(updated));

    const turn = ClientEnvelopeSchema.parse(
      makeEnvelope("turn.submit", {
        commandId: "turn-with-settings",
        sessionId: "turn-settings-session",
        prompt: "Use the effective settings",
        settingsRevision: 1,
      }),
    );
    if (turn.type !== "turn.submit") throw new Error("Expected Turn command");
    const accepted = await database.acceptTurn({
      message: turn,
      turnId: "turn-settings-1",
      runtime: { runtimeId: "runtime-settings", generation: 1, status: "ready" },
      connectorId: "connector-settings",
      bootId: "boot-settings",
      activeRejection: rejection(turn, "TURN_ALREADY_ACTIVE"),
      settingsConflictRejection: rejection(turn, "SESSION_SETTINGS_CONFLICT"),
    });
    expect(accepted.kind === "new" && accepted.turnSettings).toMatchObject({
      revision: 1,
      settings: { model: "verified-model", reasoningLevel: "high" },
    });
    expect(database.snapshot("turn-settings-session").turns[0]).toMatchObject({
      settingsRevision: 1,
      effectiveSettings: { model: "verified-model", reasoningLevel: "high" },
    });
    expect(database.sessionSettings("turn-settings-session")?.mutable).toBe(false);

    const busy = settingsCommand("turn-settings-session", "settings-during-turn", 1, {
      ...updated.payload.settings,
      branch: "blocked",
    });
    const busyResult = await database.mutateSessionSettings(
      busy,
      allow,
      reject(busy),
    );
    expect(
      busyResult.kind === "new" &&
        busyResult.result.type === "command.rejected" &&
        busyResult.result.payload.error.code,
    ).toBe("SESSION_BUSY");
  });

  it("rejects a stale Turn settings revision before creating a Turn", async () => {
    const database = openDatabase();
    await database.ensureSession("stale-turn-session");
    const turn = ClientEnvelopeSchema.parse(
      makeEnvelope("turn.submit", {
        commandId: "stale-turn-command",
        sessionId: "stale-turn-session",
        prompt: "Do not dispatch",
        settingsRevision: 7,
      }),
    );
    if (turn.type !== "turn.submit") throw new Error("Expected Turn command");
    const result = await database.acceptTurn({
      message: turn,
      turnId: "stale-turn",
      runtime: { runtimeId: "runtime-stale", generation: 1, status: "ready" },
      connectorId: "connector-stale",
      bootId: "boot-stale",
      activeRejection: rejection(turn, "TURN_ALREADY_ACTIVE"),
      settingsConflictRejection: rejection(turn, "SESSION_SETTINGS_CONFLICT"),
    });

    expect(
      result.kind === "new" &&
        result.result.type === "command.rejected" &&
        result.result.payload.error.code,
    ).toBe("SESSION_SETTINGS_CONFLICT");
    expect(database.snapshot("stale-turn-session").turns).toEqual([]);
  });
});

function settingsCommand(
  sessionId: string,
  commandId: string,
  expectedRevision: number,
  settings: SessionSettings,
) {
  const message = ClientEnvelopeSchema.parse(
    makeEnvelope("session.settings.update", {
      commandId,
      sessionId,
      deviceId: commandId.endsWith("b") ? "device-b" : "device-a",
      expectedRevision,
      settings,
    }),
  );
  if (message.type !== "session.settings.update") {
    throw new Error("Expected settings update");
  }
  return message;
}

function allow() {
  return undefined;
}

function reject(
  message: Extract<
    ClientEnvelope,
    { payload: { commandId: string; sessionId: string } }
  >,
) {
  return (code: string, detail: string): ServerEnvelope =>
    rejection(message, code, detail);
}

function rejection(
  message: Extract<
    ClientEnvelope,
    { payload: { commandId: string; sessionId: string } }
  >,
  code: string,
  detail = code,
) {
  return ServerEnvelopeSchema.parse(
    makeEnvelope("command.rejected", {
      commandId: message.payload.commandId,
      sessionId: message.payload.sessionId,
      error: { code, message: detail, retryable: false },
    }),
  );
}

function openDatabase() {
  const root = mkdtempSync(join(tmpdir(), "aicl-settings-"));
  roots.push(root);
  const database = new CoreDatabase({ path: join(root, "core.db") });
  databases.push(database);
  return database;
}
