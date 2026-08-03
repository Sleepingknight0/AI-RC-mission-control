import { describe, expect, it } from "vitest";

import {
  ClientEnvelopeSchema,
  CoreToConnectorEnvelopeSchema,
  SessionSettingsSnapshotSchema,
  TurnSchema,
  makeEnvelope,
} from "../src/index.js";

const settings = {
  providerId: "codex",
  accountId: "default",
  model: "gpt-5.6",
  reasoningLevel: "high",
  executionMode: "ask" as const,
  approvalPolicy: "review" as const,
  sandboxPolicy: "workspace_write" as const,
  networkPolicy: "restricted" as const,
  projectPath: "C:\\Projects\\sample",
  branch: "main",
};

describe("Session settings protocol", () => {
  it("validates a complete revision-fenced replacement and snapshot", () => {
    const command = ClientEnvelopeSchema.parse(
      makeEnvelope("session.settings.update", {
        commandId: "settings-command-1",
        sessionId: "session-1",
        deviceId: "device-1",
        expectedRevision: 3,
        settings,
      }),
    );
    const snapshot = SessionSettingsSnapshotSchema.parse({
      sessionId: "session-1",
      revision: 4,
      mutable: true,
      settings,
    });

    expect(command.type).toBe("session.settings.update");
    expect(snapshot.revision).toBe(4);
  });

  it("carries an immutable effective snapshot on new Turns", () => {
    const turn = TurnSchema.parse({
      turnId: "turn-1",
      commandId: "command-1",
      status: "running",
      prompt: "Inspect the project",
      startedAt: "2026-08-03T05:00:00.000Z",
      completedAt: null,
      failureCode: null,
      providerTurnId: null,
      settingsRevision: 4,
      effectiveSettings: settings,
    });
    const dispatch = CoreToConnectorEnvelopeSchema.parse(
      makeEnvelope("connector.turn.start", {
        sessionId: "session-1",
        turnId: "turn-1",
        commandId: "command-1",
        prompt: "Inspect the project",
        providerSessionId: "thread-1",
        runtimeId: "runtime-1",
        runtimeGeneration: 1,
        settingsRevision: 4,
        effectiveSettings: settings,
      }),
    );

    expect(turn.effectiveSettings?.model).toBe("gpt-5.6");
    expect(dispatch.type).toBe("connector.turn.start");
  });

  it("rejects incomplete or control-character settings", () => {
    expect(
      ClientEnvelopeSchema.safeParse(
        makeEnvelope("session.settings.update", {
          commandId: "settings-command-2",
          sessionId: "session-1",
          deviceId: "device-1",
          expectedRevision: 0,
          settings: { ...settings, projectPath: "C:\\safe\u0000escape" },
        }),
      ).success,
    ).toBe(false);
    expect(
      ClientEnvelopeSchema.safeParse(
        makeEnvelope("session.settings.update", {
          commandId: "settings-command-3",
          sessionId: "session-1",
          deviceId: "device-1",
          expectedRevision: 0,
          settings: { providerId: "codex" },
        }),
      ).success,
    ).toBe(false);
  });
});
