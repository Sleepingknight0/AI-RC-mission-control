import { describe, expect, it } from "vitest";

import {
  ClientEnvelopeSchema,
  PROTOCOL_VERSION,
  ServerEnvelopeSchema,
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
