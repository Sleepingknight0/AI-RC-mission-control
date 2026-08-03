import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ClientEnvelopeSchema,
  ServerEnvelopeSchema,
  makeEnvelope,
  type ClientEnvelope,
  type Runtime,
  type ServerEnvelope,
  type SessionSettings,
} from "@aicl/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { CoreDatabase } from "../src/store.js";

const databases: CoreDatabase[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Full Auto approval leases", () => {
  it("creates, fences, expires, revokes on Core restart, and emergency-stops", async () => {
    const database = openDatabase();
    const runtime: Runtime = {
      runtimeId: "runtime-lease",
      generation: 1,
      status: "ready",
    };
    await prepareSession(database, runtime);
    const initial = database.sessionSettings("lease-session");
    if (initial === undefined) throw new Error("Expected settings");
    const update = settingsCommand({
      ...initial.settings,
      approvalPolicy: "full_auto_lease",
      networkPolicy: "denied",
    });
    const updated = await database.mutateSessionSettings(
      update,
      () => undefined,
      reject(update),
    );
    expect(updated.kind === "new" && updated.snapshot?.revision).toBe(1);

    const turn = ClientEnvelopeSchema.parse(
      makeEnvelope("turn.submit", {
        commandId: "lease-turn-command",
        sessionId: "lease-session",
        prompt: "Perform bounded work",
        deviceId: "device-one",
        settingsRevision: 1,
      }),
    );
    if (turn.type !== "turn.submit") throw new Error("Expected Turn command");
    await database.acceptTurn({
      message: turn,
      turnId: "lease-turn",
      runtime,
      connectorId: "connector-lease",
      bootId: "boot-lease",
      activeRejection: rejection(turn, "TURN_ALREADY_ACTIVE"),
    });

    const create = leaseCreate("lease-create-1", 0);
    const created = await database.createApprovalLease({
      message: create,
      coreBootId: "core-boot-a",
      rejection: reject(create),
      now: new Date("2026-08-03T05:00:00.000Z"),
    });
    expect(created.kind === "new" && created.snapshot).toMatchObject({
      revision: 1,
      leases: [expect.objectContaining({ state: "active", deviceId: "device-one" })],
    });
    const replay = await database.createApprovalLease({
      message: create,
      coreBootId: "core-boot-a",
      rejection: reject(create),
    });
    expect(replay.kind).toBe("same");

    const activeLease = database.approvalLeaseSnapshot("lease-session").leases[0];
    if (activeLease === undefined) throw new Error("Expected lease");
    const hostile = leaseRevoke(activeLease.leaseId, "device-two", 0);
    const hostileResult = await database.revokeApprovalLease({
      message: hostile,
      rejection: reject(hostile),
    });
    expect(
      hostileResult.kind === "new" &&
        hostileResult.result.type === "command.rejected" &&
        hostileResult.result.payload.error.code,
    ).toBe("LEASE_DEVICE_MISMATCH");

    const expired = await database.sweepApprovalLeases(
      new Date("2026-08-03T05:16:00.000Z"),
    );
    expect(expired[0]).toMatchObject({
      revision: 2,
      leases: [expect.objectContaining({ state: "expired", revokeReason: "expire" })],
    });

    const second = await database.createApprovalLease({
      message: leaseCreate("lease-create-2", 2),
      coreBootId: "core-boot-a",
      rejection: reject(leaseCreate("lease-create-2", 2)),
      now: new Date("2026-08-03T05:20:00.000Z"),
    });
    expect(second.kind === "new" && second.snapshot.revision).toBe(3);
    const restart = await database.revokeLeasesForCoreBoot("core-boot-b");
    expect(restart[0]).toMatchObject({
      revision: 4,
      leases: expect.arrayContaining([
        expect.objectContaining({ state: "revoked", revokeReason: "core_restart" }),
      ]),
    });

    const thirdCommand = leaseCreate("lease-create-3", 4);
    await database.createApprovalLease({
      message: thirdCommand,
      coreBootId: "core-boot-b",
      rejection: reject(thirdCommand),
      now: new Date("2026-08-03T05:25:00.000Z"),
    });
    const stop = emergencyStop();
    const stopped = await database.emergencyStop({
      message: stop,
      rejection: reject(stop),
      now: new Date("2026-08-03T05:26:00.000Z"),
    });
    expect(stopped.kind === "new" && stopped.snapshot).toMatchObject({
      revision: 6,
      leases: expect.arrayContaining([
        expect.objectContaining({ revokeReason: "emergency_stop" }),
      ]),
    });
  });

  it("revokes active authority when Session settings change", async () => {
    const database = openDatabase();
    const runtime: Runtime = {
      runtimeId: "runtime-lease",
      generation: 1,
      status: "ready",
    };
    await prepareSession(database, runtime);
    const initial = database.sessionSettings("lease-session");
    if (initial === undefined) throw new Error("Expected settings");
    const enabledSettings: SessionSettings = {
      ...initial.settings,
      approvalPolicy: "full_auto_lease",
      networkPolicy: "denied",
    };
    const enable = settingsCommand(enabledSettings);
    await database.mutateSessionSettings(enable, () => undefined, reject(enable));
    const create = leaseCreate("settings-lease-create", 0);
    await database.createApprovalLease({
      message: create,
      coreBootId: "core-boot-settings",
      rejection: reject(create),
    });

    const change = settingsCommand(
      { ...enabledSettings, branch: "release" },
      "change-lease-settings",
      1,
    );
    await database.mutateSessionSettings(change, () => undefined, reject(change));
    expect(database.approvalLeaseSnapshot("lease-session")).toMatchObject({
      revision: 2,
      leases: [expect.objectContaining({
        state: "revoked",
        revokeReason: "settings_change",
      })],
    });
  });
});

function openDatabase() {
  const root = mkdtempSync(join(tmpdir(), "aicl-leases-"));
  roots.push(root);
  const database = new CoreDatabase({ path: join(root, "core.db") });
  databases.push(database);
  return database;
}

async function prepareSession(database: CoreDatabase, runtime: Runtime) {
  const message = ClientEnvelopeSchema.parse(
    makeEnvelope("session.create", {
      commandId: "prepare-lease-session",
      sessionId: "lease-session",
      deviceId: "device-one",
      title: "Lease Session",
      providerId: "codex",
      accountId: "profile-main",
      projectPath: process.cwd(),
      model: null,
      reasoningLevel: null,
    }),
  );
  if (message.type !== "session.create") throw new Error("Expected create");
  await database.acceptSessionPreparation({
    message,
    runtime,
    connectorId: "connector-lease",
    bootId: "boot-lease",
    selection: {
      title: "Lease Session",
      source: "aicl",
      projectPath: process.cwd(),
      model: null,
      reasoningLevel: null,
      providerSessionId: null,
    },
    rejection: reject(message),
  });
}

function settingsCommand(
  settings: SessionSettings,
  commandId = "enable-full-auto",
  expectedRevision = 0,
) {
  const message = ClientEnvelopeSchema.parse(
    makeEnvelope("session.settings.update", {
      commandId,
      sessionId: "lease-session",
      deviceId: "device-one",
      expectedRevision,
      settings,
    }),
  );
  if (message.type !== "session.settings.update") throw new Error("settings");
  return message;
}

function leaseCreate(commandId: string, expectedLeaseRevision: number) {
  const message = ClientEnvelopeSchema.parse(
    makeEnvelope("approval.lease.create", {
      commandId,
      sessionId: "lease-session",
      deviceId: "device-one",
      expectedSettingsRevision: 1,
      expectedLeaseRevision,
      providerId: "codex",
      accountId: "profile-main",
      projectPath: process.cwd(),
      runtimeId: "runtime-lease",
      runtimeGeneration: 1,
      durationMinutes: 15,
    }),
  );
  if (message.type !== "approval.lease.create") throw new Error("lease create");
  return message;
}

function leaseRevoke(leaseId: string, deviceId: string, expectedLeaseRevision: number) {
  const message = ClientEnvelopeSchema.parse(
    makeEnvelope("approval.lease.revoke", {
      commandId: "hostile-revoke",
      sessionId: "lease-session",
      deviceId,
      leaseId,
      expectedLeaseRevision,
    }),
  );
  if (message.type !== "approval.lease.revoke") throw new Error("lease revoke");
  return message;
}

function emergencyStop() {
  const message = ClientEnvelopeSchema.parse(
    makeEnvelope("approval.emergency_stop", {
      commandId: "emergency-stop",
      sessionId: "lease-session",
      deviceId: "device-one",
    }),
  );
  if (message.type !== "approval.emergency_stop") throw new Error("stop");
  return message;
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
