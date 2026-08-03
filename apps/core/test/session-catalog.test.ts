import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ClientEnvelopeSchema,
  ServerEnvelopeSchema,
  makeEnvelope,
  type ClientEnvelope,
  type ServerEnvelope,
} from "@aicl/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { CoreDatabase } from "../src/store.js";

const databases: CoreDatabase[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("Session Catalog V2", () => {
  it("uses revision-fenced metadata mutations, literal search, and archive filters", async () => {
    const database = openDatabase();
    await database.ensureSession("catalog-session");
    const renamed = metadataCommand("session.rename", {
      commandId: "rename-1",
      sessionId: "catalog-session",
      deviceId: "device-a",
      expectedRevision: 0,
      title: "100% safe auth flow",
    });
    const first = await database.mutateSessionMetadata(renamed, reject(renamed));
    expect(first.kind === "new" && first.result.type).toBe("session.command.accepted");
    const replay = await database.mutateSessionMetadata(renamed, reject(renamed));
    expect(replay.kind).toBe("same");

    const changedCommandId = metadataCommand("session.rename", {
      ...renamed.payload,
      title: "reused identity",
    });
    expect(
      (await database.mutateSessionMetadata(changedCommandId, reject(changedCommandId))).kind,
    ).toBe("conflict");

    const stale = metadataCommand("session.pin", {
      commandId: "pin-stale",
      sessionId: "catalog-session",
      deviceId: "device-a",
      expectedRevision: 0,
      pinned: true,
    });
    const staleResult = await database.mutateSessionMetadata(stale, reject(stale));
    expect(
      staleResult.kind === "new" &&
        staleResult.result.type === "command.rejected" &&
        staleResult.result.payload.error.code,
    ).toBe("SESSION_REVISION_CONFLICT");

    const pin = metadataCommand("session.pin", {
      ...stale.payload,
      commandId: "pin-1",
      expectedRevision: 1,
    });
    await database.mutateSessionMetadata(pin, reject(pin));
    const archive = metadataCommand("session.archive", {
      commandId: "archive-1",
      sessionId: "catalog-session",
      deviceId: "device-a",
      expectedRevision: 2,
      archived: true,
    });
    await database.mutateSessionMetadata(archive, reject(archive));

    expect(catalog(database, { search: "%" }).sessions).toEqual([]);
    const archived = catalog(database, { search: "%", archived: "only" });
    expect(archived.sessions).toHaveLength(1);
    expect(archived.sessions[0]).toMatchObject({
      title: "100% safe auth flow",
      pinned: true,
      archived: true,
      revision: 3,
      source: "aicl",
      providerBindingStatus: "unbound",
      providerId: "codex",
      canControl: false,
    });
  });

  it("tracks unread state per device and derives the first human title from a prompt", async () => {
    const database = openDatabase();
    const turn = ClientEnvelopeSchema.parse(
      makeEnvelope("turn.submit", {
        commandId: "turn-title-command",
        sessionId: "turn-title-session",
        prompt: "  Fix   the authentication reconnect path  ",
      }),
    );
    if (turn.type !== "turn.submit") throw new Error("Expected Turn command");
    await database.acceptTurn({
      message: turn,
      turnId: "turn-title",
      runtime: { runtimeId: "runtime-title", generation: 1, status: "ready" },
      connectorId: "connector-title",
      bootId: "boot-title",
      activeRejection: ServerEnvelopeSchema.parse(
        makeEnvelope("command.rejected", {
          commandId: turn.payload.commandId,
          sessionId: turn.payload.sessionId,
          error: { code: "TURN_ALREADY_ACTIVE", message: "active", retryable: false },
        }),
      ),
    });

    const before = catalog(database);
    expect(before.sessions[0]).toMatchObject({
      title: "Fix the authentication reconnect path",
      unreadCount: 1,
      lastEventSeq: 1,
      state: "running",
    });
    const read = ClientEnvelopeSchema.parse(
      makeEnvelope("session.read.mark", {
        commandId: "read-1",
        sessionId: "turn-title-session",
        deviceId: "device-a",
        upToEventSeq: 1,
      }),
    );
    if (read.type !== "session.read.mark") throw new Error("Expected read command");
    await database.markSessionRead(read, reject(read));
    expect(catalog(database).sessions[0]?.unreadCount).toBe(0);
    expect(catalog(database, {}, "device-b").sessions[0]?.unreadCount).toBe(1);

    const beyond = ClientEnvelopeSchema.parse(
      makeEnvelope("session.read.mark", {
        commandId: "read-beyond",
        sessionId: "turn-title-session",
        deviceId: "device-a",
        upToEventSeq: 2,
      }),
    );
    if (beyond.type !== "session.read.mark") throw new Error("Expected read command");
    const result = await database.markSessionRead(beyond, reject(beyond));
    expect(
      result.kind === "new" &&
        result.result.type === "command.rejected" &&
        result.result.payload.error.code,
    ).toBe("SESSION_READ_CURSOR_INVALID");
  });

  it("paginates deterministically and rejects a cursor after catalog mutation", async () => {
    const database = openDatabase();
    for (let index = 0; index < 260; index += 1) {
      await database.ensureSession(`bulk-${String(index).padStart(4, "0")}`);
    }
    const first = catalog(database, {}, "device-a", 100);
    expect(first.sessions).toHaveLength(100);
    expect(first.total).toBe(260);
    expect(first.nextCursor).not.toBeNull();
    const second = database.sessionCatalog(
      catalogQuery({}, "device-a", 100, first.nextCursor),
      () => true,
    );
    expect(second.ok && second.sessions).toHaveLength(100);
    if (!second.ok) throw new Error("Expected second catalog page");
    expect(
      new Set([...first.sessions, ...second.sessions].map((session) => session.sessionId)).size,
    ).toBe(200);

    const target = first.sessions[0]!;
    const rename = metadataCommand("session.rename", {
      commandId: "cursor-invalidating-rename",
      sessionId: target.sessionId,
      deviceId: "device-a",
      expectedRevision: target.revision,
      title: "Changed while paging",
    });
    await database.mutateSessionMetadata(rename, reject(rename));
    expect(
      database.sessionCatalog(
        catalogQuery({}, "device-a", 100, first.nextCursor),
        () => true,
      ),
    ).toEqual({ ok: false, code: "SESSION_CATALOG_CURSOR_STALE" });
  });
});

function openDatabase() {
  const root = join(mkdtempSync(join(tmpdir(), "aicl-catalog-")));
  roots.push(root);
  const database = new CoreDatabase({ path: join(root, "core.db") });
  databases.push(database);
  return database;
}

function metadataCommand<T extends "session.rename" | "session.pin" | "session.archive">(
  type: T,
  payload: Extract<ClientEnvelope, { type: T }>["payload"],
) {
  const parsed = ClientEnvelopeSchema.parse(makeEnvelope(type, payload));
  if (parsed.type !== type) throw new Error(`Expected ${type}`);
  return parsed as Extract<ClientEnvelope, { type: T }>;
}

function reject(message: Extract<ClientEnvelope, { payload: { commandId: string; sessionId: string } }>) {
  return (code: string, detail: string): ServerEnvelope =>
    ServerEnvelopeSchema.parse(
      makeEnvelope("command.rejected", {
        commandId: message.payload.commandId,
        sessionId: message.payload.sessionId,
        error: { code, message: detail, retryable: false },
      }),
    );
}

function catalog(
  database: CoreDatabase,
  overrides: Partial<Parameters<typeof catalogQuery>[0]> = {},
  deviceId = "device-a",
  pageSize = 100,
) {
  const result = database.sessionCatalog(
    catalogQuery(overrides, deviceId, pageSize, null),
    () => true,
  );
  if (!result.ok) throw new Error(result.code);
  return result;
}

function catalogQuery(
  overrides: Partial<{
    search: string | null;
    archived: "exclude" | "include" | "only";
  }> = {},
  deviceId = "device-a",
  pageSize = 100,
  cursor: string | null = null,
) {
  return {
    requestId: `request-${crypto.randomUUID()}`,
    deviceId,
    pageSize,
    cursor,
    filters: {
      search: overrides.search ?? null,
      providerIds: [],
      accountIds: [],
      states: [],
      project: null,
      archived: overrides.archived ?? "exclude",
      pinned: null,
    },
  };
}
