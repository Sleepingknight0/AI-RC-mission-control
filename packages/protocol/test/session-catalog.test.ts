import { describe, expect, it } from "vitest";

import {
  ClientEnvelopeSchema,
  ServerEnvelopeSchema,
  makeEnvelope,
} from "../src/index.js";

const filters = {
  search: null,
  providerIds: [],
  accountIds: [],
  states: [],
  project: null,
  archived: "exclude" as const,
  pinned: null,
};

describe("Session Catalog protocol", () => {
  it("accepts bounded queries and strict metadata mutations", () => {
    expect(
      ClientEnvelopeSchema.parse(
        makeEnvelope("sessions.catalog.list", {
          requestId: "catalog-1",
          deviceId: "device-1",
          pageSize: 100,
          cursor: null,
          filters,
        }),
      ).type,
    ).toBe("sessions.catalog.list");
    expect(
      ClientEnvelopeSchema.parse(
        makeEnvelope("session.rename", {
          commandId: "rename-1",
          sessionId: "session-1",
          deviceId: "device-1",
          expectedRevision: 2,
          title: "Human title",
        }),
      ).type,
    ).toBe("session.rename");
  });

  it("rejects oversized pages, duplicate filters, control text, and unknown fields", () => {
    for (const payload of [
      { requestId: "a", deviceId: "d", pageSize: 251, cursor: null, filters },
      {
        requestId: "a",
        deviceId: "d",
        pageSize: 100,
        cursor: null,
        filters: { ...filters, providerIds: ["codex", "codex"] },
      },
      {
        requestId: "a",
        deviceId: "d",
        pageSize: 100,
        cursor: null,
        filters,
        rawPath: "C:\\Users\\operator",
      },
    ]) {
      expect(() =>
        ClientEnvelopeSchema.parse(makeEnvelope("sessions.catalog.list", payload)),
      ).toThrow();
    }
    expect(() =>
      ClientEnvelopeSchema.parse(
        makeEnvelope("session.rename", {
          commandId: "rename-control",
          sessionId: "session-1",
          deviceId: "device-1",
          expectedRevision: 0,
          title: "unsafe\u001b[31m",
        }),
      ),
    ).toThrow();
  });

  it("validates a complete catalog snapshot", () => {
    const message = ServerEnvelopeSchema.parse(
      makeEnvelope("sessions.catalog.snapshot", {
        requestId: "catalog-1",
        catalogRevision: 3,
        generatedAt: "2026-08-03T05:00:00.000Z",
        nextCursor: null,
        total: 1,
        sessions: [
          {
            sessionId: "session-1",
            title: "Human title",
            providerId: "codex",
            accountId: null,
            providerSessionId: null,
            source: "aicl",
            providerBindingStatus: "unbound",
            projectPath: null,
            projectName: null,
            branch: null,
            model: null,
            reasoningLevel: null,
            executionMode: "ask",
            approvalPolicy: "review",
            sandboxPolicy: "workspace_write",
            networkPolicy: "restricted",
            state: "idle",
            runtimeStatus: null,
            activeTurnId: null,
            pendingApprovalCount: 0,
            turnCount: 0,
            unreadCount: 0,
            lastActivityAt: "2026-08-03T05:00:00.000Z",
            lastEventSeq: 0,
            canResume: false,
            canControl: false,
            pinned: false,
            archived: false,
            revision: 0,
            settingsRevision: 0,
          },
        ],
      }),
    );
    expect(message.type).toBe("sessions.catalog.snapshot");
  });
});
