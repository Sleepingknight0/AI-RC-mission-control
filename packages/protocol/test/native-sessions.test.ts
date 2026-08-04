import { describe, expect, it } from "vitest";

import {
  ClientEnvelopeSchema,
  ConnectorEnvelopeSchema,
  ProviderNativeSessionPageSchema,
  ProviderNativeSessionSnapshotSchema,
  ServerEnvelopeSchema,
  makeEnvelope,
} from "../src/index.js";

const snapshot = {
  snapshotId: "native-1",
  revision: 1,
  providerId: "codex",
  accountId: "default",
  observedAt: "2026-08-03T05:00:00.000Z",
  staleAt: "2026-08-03T05:05:00.000Z",
  freshness: "live" as const,
  truncated: false,
  sessions: [
    {
      providerId: "codex",
      accountId: "default",
      providerSessionId: "thread-1",
      title: "Native work",
      preview: "Inspect the repository",
      projectPath: "C:\\Projects\\work",
      projectName: "work",
      branch: "main",
      providerStatus: "idle" as const,
      createdAt: "2026-08-03T04:00:00.000Z",
      updatedAt: "2026-08-03T04:30:00.000Z",
      pinned: false,
      archived: false,
      canResume: true,
    },
  ],
  notice: null,
};

describe("provider-native Session protocol", () => {
  it("validates refresh and both relay envelopes", () => {
    expect(
      ClientEnvelopeSchema.parse(
        makeEnvelope("sessions.native.refresh", {
          providerId: "codex",
          accountId: "default",
        }),
      ).type,
    ).toBe("sessions.native.refresh");
    expect(
      ConnectorEnvelopeSchema.parse(
        makeEnvelope("connector.sessions.native.snapshot", { snapshot }),
      ).type,
    ).toBe("connector.sessions.native.snapshot");
    expect(
      ServerEnvelopeSchema.parse(
        makeEnvelope("sessions.native.snapshot", { snapshot }),
      ).type,
    ).toBe("sessions.native.snapshot");
  });

  it("rejects duplicate identities, controls, cross-account rows, and bad expiry", () => {
    expect(() =>
      ProviderNativeSessionSnapshotSchema.parse({
        ...snapshot,
        sessions: [snapshot.sessions[0], snapshot.sessions[0]],
      }),
    ).toThrow();
    expect(() =>
      ProviderNativeSessionSnapshotSchema.parse({
        ...snapshot,
        sessions: [{ ...snapshot.sessions[0], title: "bad\u001b[31m" }],
      }),
    ).toThrow();
    expect(() =>
      ProviderNativeSessionSnapshotSchema.parse({
        ...snapshot,
        sessions: [{ ...snapshot.sessions[0], accountId: "other" }],
      }),
    ).toThrow();
    expect(() =>
      ProviderNativeSessionSnapshotSchema.parse({
        ...snapshot,
        staleAt: snapshot.observedAt,
      }),
    ).toThrow();
  });

  it("validates Session preparation commands and normalized binding status", () => {
    expect(
      ClientEnvelopeSchema.parse(
        makeEnvelope("session.create", {
          commandId: "create-1",
          sessionId: "session-1",
          deviceId: "device-1",
          title: "New work",
          providerId: "codex",
          accountId: "default",
          projectPath: "C:\\Projects\\work",
          model: null,
          reasoningLevel: null,
        }),
      ).type,
    ).toBe("session.create");
    expect(
      ServerEnvelopeSchema.parse(
        makeEnvelope("session.provider.status", {
          commandId: "create-1",
          sessionId: "session-1",
          providerId: "codex",
          accountId: "default",
          providerSessionId: "thread-1",
          status: "ready",
          failureCode: null,
          runtimeId: "runtime-1",
          runtimeGeneration: 1,
          updatedAt: "2026-08-03T05:00:00.000Z",
        }),
      ).type,
    ).toBe("session.provider.status");
  });

  it("validates truthful bounded pages and rejects duplicate or foreign rows", () => {
    const page = {
      providerId: "codex",
      accountId: "default",
      observedAt: snapshot.observedAt,
      freshness: "live" as const,
      sessions: snapshot.sessions,
      nextCursor: "native-cursor-opaque-value",
      hasMore: true,
      truncated: true,
      cursorReset: false,
      notice: "Discovery reached its bound",
    };
    expect(ProviderNativeSessionPageSchema.parse(page)).toMatchObject({
      hasMore: true,
      truncated: true,
    });
    expect(() => ProviderNativeSessionPageSchema.parse({
      ...page,
      nextCursor: null,
    })).toThrow();
    expect(() => ProviderNativeSessionPageSchema.parse({
      ...page,
      sessions: [snapshot.sessions[0], snapshot.sessions[0]],
    })).toThrow();
    expect(() => ProviderNativeSessionPageSchema.parse({
      ...page,
      sessions: [{ ...snapshot.sessions[0], accountId: "other" }],
    })).toThrow();
  });
});
