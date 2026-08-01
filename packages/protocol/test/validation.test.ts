import { describe, expect, it } from "vitest";

import {
  ClientEnvelopeSchema,
  MAX_WEBSOCKET_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  ServerEnvelopeSchema,
  decodeJson,
  makeEnvelope,
} from "../src/index.js";

describe("normalized protocol validation", () => {
  it("accepts a supported client hello", () => {
    const result = ClientEnvelopeSchema.safeParse(
      makeEnvelope("client.hello", {
        clientName: "protocol-test",
        supportedProtocolVersions: [PROTOCOL_VERSION],
      }),
    );

    expect(result.success).toBe(true);
  });

  it("validates the normalized Session catalog without provider fields", () => {
    expect(ClientEnvelopeSchema.safeParse(makeEnvelope("sessions.list", {})).success).toBe(
      true,
    );
    expect(
      ServerEnvelopeSchema.safeParse(
        makeEnvelope("sessions.snapshot", {
          sessions: [
            {
              sessionId: "session-1",
              state: "awaiting_approval",
              runtimeStatus: "busy",
              activeTurnId: "turn-1",
              pendingApprovalCount: 1,
              lastTurnStatus: "running",
              lastActivityAt: "2026-08-02T01:02:00.000Z",
              cwd: "C:\\Projects\\aicl",
              turnCount: 2,
              lastEventSeq: 9,
            },
          ],
        }),
      ).success,
    ).toBe(true);
  });

  it("rejects raw provider fields in a frontend envelope", () => {
    const result = ServerEnvelopeSchema.safeParse({
      ...makeEnvelope("assistant.message.delta", {
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "message-1",
        streamSeq: 1,
        text: "hello",
      }),
      providerMethod: "raw/message/delta",
    });

    expect(result.success).toBe(false);
  });

  it("rejects raw provider correlation fields in an approval envelope", () => {
    const result = ServerEnvelopeSchema.safeParse({
      ...makeEnvelope("approval.requested", {
        sessionId: "session-1",
        eventId: "event-1",
        seq: 1,
        approval: {
          approvalId: "approval-1",
          sessionId: "session-1",
          runtimeId: "runtime-1",
          runtimeGeneration: 1,
          turnId: "turn-1",
          actionType: "command",
          state: "pending",
          revision: 0,
          expiresAt: "2026-08-02T01:02:00.000Z",
          payload: {
            summary: "Run tests",
            command: "pnpm test",
            cwd: null,
            reason: null,
            activityId: null,
            fileChangeId: null,
          },
          resolvedAt: null,
          resolvedByDeviceId: null,
        },
      }),
      providerRequestId: 42,
    });

    expect(result.success).toBe(false);
  });

  it("rejects WebSocket messages above the transport ceiling", () => {
    const oversized = "x".repeat(MAX_WEBSOCKET_MESSAGE_BYTES + 1);

    expect(() => decodeJson(oversized)).toThrow(RangeError);
  });

  it("rejects unsupported envelope versions", () => {
    const result = ClientEnvelopeSchema.safeParse({
      ...makeEnvelope("client.hello", {
        clientName: "protocol-test",
        supportedProtocolVersions: [PROTOCOL_VERSION],
      }),
      protocolVersion: 2,
    });

    expect(result.success).toBe(false);
  });
});
