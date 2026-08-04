import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ClientEnvelopeSchema,
  ConnectorEnvelopeSchema,
  ServerEnvelopeSchema,
  makeEnvelope,
  type ClientEnvelope,
  type Runtime,
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
    await database.ensureSession("turn-title-session");
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
    const runtime = { runtimeId: "runtime-paging", generation: 1, status: "ready" as const };
    const activeTurn = ClientEnvelopeSchema.parse(
      makeEnvelope("turn.submit", {
        commandId: "paging-active-turn",
        sessionId: "bulk-0259",
        prompt: "keep the catalog active",
      }),
    );
    if (activeTurn.type !== "turn.submit") throw new Error("Expected Turn");
    await database.acceptTurn({
      message: activeTurn,
      turnId: "turn-paging",
      runtime,
      connectorId: "connector-paging",
      bootId: "boot-paging",
      activeRejection: reject(activeTurn)("TURN_ALREADY_ACTIVE", "active"),
    });
    const first = catalog(database, {}, "device-a", 100);
    expect(first.sessions).toHaveLength(100);
    expect(first.total).toBe(260);
    expect(first.nextCursor).not.toBeNull();
    const activity = ConnectorEnvelopeSchema.parse(
      makeEnvelope("connector.activity.started", {
        sessionId: "bulk-0259",
        activity: {
          activityId: "activity-paging",
          turnId: "turn-paging",
          kind: "command",
          title: "pnpm test",
          cwd: null,
          status: "running",
          revision: 0,
          exitCode: null,
          durationMs: null,
          outputPreview: "",
        },
      }),
    );
    if (activity.type !== "connector.activity.started") throw new Error("activity");
    await database.recordActivity(activity, {
      connectorId: "connector-paging",
      sourceEventId: "source-paging-activity",
      runtimeId: runtime.runtimeId,
      runtimeGeneration: runtime.generation,
    });
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

  it("bounds and orders a realistic 1,000-Session catalog within the performance budget", async () => {
    const database = openDatabase();
    for (let index = 0; index < 1_000; index += 1) {
      const sessionId = `scale-${String(index).padStart(4, "0")}`;
      await database.ensureSession(sessionId);
      if (index % 10 !== 0) continue;
      const runtime: Runtime = {
        runtimeId: `runtime-${sessionId}`,
        generation: 1,
        status: "ready",
      };
      const turnId = `turn-${sessionId}`;
      const command = ClientEnvelopeSchema.parse(
        makeEnvelope("turn.submit", {
          commandId: `command-${sessionId}`,
          sessionId,
          prompt: `historical prompt ${index}`,
        }),
      );
      if (command.type !== "turn.submit") throw new Error("turn.submit");
      await database.acceptTurn({
        message: command,
        turnId,
        runtime,
        connectorId: "connector-scale",
        bootId: "boot-scale",
        activeRejection: ServerEnvelopeSchema.parse(
          makeEnvelope("command.rejected", {
            commandId: command.payload.commandId,
            sessionId,
            error: {
              code: "TURN_ALREADY_ACTIVE",
              message: "active",
              retryable: false,
            },
          }),
        ),
      });
      await database.markDispatched(command.payload.commandId);
      const source = {
        connectorId: "connector-scale",
        sourceEventId: `source-${sessionId}`,
        runtimeId: runtime.runtimeId,
        runtimeGeneration: runtime.generation,
      };
      if (index % 100 === 0) {
        const requested = ConnectorEnvelopeSchema.parse(
          makeEnvelope("connector.approval.requested", {
            sessionId,
            approval: {
              approvalId: `approval-${sessionId}`,
              sessionId,
              runtimeId: runtime.runtimeId,
              runtimeGeneration: runtime.generation,
              turnId,
              actionType: "command",
              state: "pending",
              revision: 0,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              payload: {
                summary: "bounded performance fixture",
                command: "pnpm check",
                cwd: process.cwd(),
                reason: "performance fixture",
                activityId: null,
                fileChangeId: null,
              },
              resolvedAt: null,
              resolvedByDeviceId: null,
            },
            providerCorrelationId: `correlation-${sessionId}`,
          }),
        );
        if (requested.type !== "connector.approval.requested") {
          throw new Error("approval");
        }
        await database.requestApproval(requested, source);
      } else {
        const completed = ConnectorEnvelopeSchema.parse(
          makeEnvelope("connector.turn.completed", { sessionId, turnId }),
        );
        if (completed.type !== "connector.turn.completed") {
          throw new Error("completed");
        }
        await database.finishTurn(completed, source);
      }
    }
    const heapBefore = process.memoryUsage().heapUsed;
    const startedAt = performance.now();
    const first = catalog(database, {}, "scale-device", 250);
    const elapsedMs = performance.now() - startedAt;
    const heapGrowthBytes = process.memoryUsage().heapUsed - heapBefore;

    expect(first).toMatchObject({ total: 1_000 });
    expect(first.sessions).toHaveLength(250);
    expect(first.nextCursor).not.toBeNull();
    expect(new Set(first.sessions.map((session) => session.sessionId)).size).toBe(250);
    const history = catalog(
      database,
      { search: "scale-0900" },
      "scale-device",
      10,
    );
    expect(history.sessions[0]).toMatchObject({
      sessionId: "scale-0900",
      turnCount: 1,
      pendingApprovalCount: 1,
    });
    const exact = catalog(
      database,
      { search: "scale", sessionIds: ["scale-0999"] },
      "scale-device",
      10,
    );
    expect(exact).toMatchObject({ total: 1, nextCursor: null });
    expect(exact.sessions.map((session) => session.sessionId)).toEqual([
      "scale-0999",
    ]);
    expect(elapsedMs).toBeLessThan(2_000);
    expect(heapGrowthBytes).toBeLessThan(256 * 1024 * 1024);
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
    sessionIds: string[];
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
      sessionIds: overrides.sessionIds ?? [],
      providerIds: [],
      accountIds: [],
      states: [],
      project: null,
      archived: overrides.archived ?? "exclude",
      pinned: null,
    },
  };
}
