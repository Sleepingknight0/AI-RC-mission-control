import { describe, expect, it } from "vitest";

import {
  ARTIFACT_CHUNK_BYTES,
  BrowserRuntimeConfigSchema,
  ClientEnvelopeSchema,
  ConnectorEnvelopeSchema,
  MAX_ARTIFACT_BYTES,
  MAX_OUTPUT_BATCH_BYTES,
  MAX_WEBSOCKET_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  ServerEnvelopeSchema,
  decodeJson,
  makeEnvelope,
  redactSensitiveText,
  websocketCapabilityToken,
} from "../src/index.js";

describe("normalized protocol validation", () => {
  it("validates bounded browser runtime bootstrap data", () => {
    const runtimeConfig = {
      webSocketPath: "/ws",
      ticket: "runtime-ticket-1234567890",
      expiresAt: "2026-08-03T01:02:03.000Z",
    };

    expect(BrowserRuntimeConfigSchema.safeParse(runtimeConfig).success).toBe(true);
    expect(
      BrowserRuntimeConfigSchema.safeParse({ ...runtimeConfig, secret: "leak" }).success,
    ).toBe(false);
    expect(
      websocketCapabilityToken(
        "aicl.browser.runtime-ticket-1234567890",
        "browser",
      ),
    ).toBe("runtime-ticket-1234567890");
    expect(
      websocketCapabilityToken("aicl.connector.runtime-ticket-1234567890", "browser"),
    ).toBeNull();
  });

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

  it("applies semantic byte limits after UTF-8 decoding", () => {
    const oversizedUnicode = "ก".repeat(Math.ceil(MAX_OUTPUT_BATCH_BYTES / 3) + 1);
    const result = ConnectorEnvelopeSchema.safeParse(
      makeEnvelope("connector.command.output.batch", {
        sessionId: "session-1",
        turnId: "turn-1",
        activityId: "activity-1",
        streamSeq: 1,
        output: oversizedUnicode,
      }),
    );

    expect(result.success).toBe(false);
  });

  it("rejects unsafe media, oversized artifacts, and decoded oversized chunks", () => {
    const unsafe = ConnectorEnvelopeSchema.safeParse(
      makeEnvelope("connector.artifact.begin", {
        sessionId: "session-1",
        turnId: "turn-1",
        artifact: {
          artifactId: "artifact-1",
          mediaType: "text/html",
          byteLength: 1,
          sha256: "a".repeat(64),
          downloadPath: "/artifacts/artifact-1",
        },
        chunkCount: 1,
      }),
    );
    const oversized = ConnectorEnvelopeSchema.safeParse(
      makeEnvelope("connector.artifact.begin", {
        sessionId: "session-1",
        turnId: "turn-1",
        artifact: {
          artifactId: "artifact-2",
          mediaType: "text/x-diff",
          byteLength: MAX_ARTIFACT_BYTES + 1,
          sha256: "a".repeat(64),
          downloadPath: "/artifacts/artifact-2",
        },
        chunkCount: 1,
      }),
    );
    const oversizedChunk = ConnectorEnvelopeSchema.safeParse(
      makeEnvelope("connector.artifact.chunk", {
        sessionId: "session-1",
        turnId: "turn-1",
        artifactId: "artifact-1",
        chunkIndex: 0,
        contentBase64: Buffer.alloc(ARTIFACT_CHUNK_BYTES + 1).toString("base64"),
      }),
    );

    expect(unsafe.success).toBe(false);
    expect(oversized.success).toBe(false);
    expect(oversizedChunk.success).toBe(false);
  });

  it("redacts common credential forms from bounded diagnostics", () => {
    const diagnostic = redactSensitiveText(
      "Authorization: Bearer AICL_TEST_SECRET Cookie: sid=COOKIE_SECRET " +
        "api_key=KEY_SECRET https://user:PASS_SECRET@example.test " +
        "-----BEGIN PRIVATE KEY-----PRIVATE_SECRET-----END PRIVATE KEY-----",
    );

    expect(diagnostic).not.toMatch(
      /AICL_TEST_SECRET|COOKIE_SECRET|KEY_SECRET|PASS_SECRET|PRIVATE_SECRET/u,
    );
  });
});
