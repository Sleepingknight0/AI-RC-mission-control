import { describe, expect, it } from "vitest";

import { RemoteSessionRefSchema } from "../src/index.js";

describe("RemoteSessionRef", () => {
  it("accepts AICL-only, provider-only, and explicitly bound identities", () => {
    const base = {
      providerId: "codex",
      accountId: "not-bluewhalex",
    };

    expect(RemoteSessionRefSchema.safeParse({
      ...base,
      providerSessionId: null,
      aiclSessionId: "session-aicl",
    }).success).toBe(true);
    expect(RemoteSessionRefSchema.safeParse({
      ...base,
      providerSessionId: "thread-native",
      aiclSessionId: null,
    }).success).toBe(true);
    expect(RemoteSessionRefSchema.safeParse({
      ...base,
      providerSessionId: "thread-native",
      aiclSessionId: "session-aicl",
    }).success).toBe(true);
  });

  it("rejects identity-free, extra-field, and control-character references", () => {
    const base = {
      providerId: "codex",
      accountId: "not-bluewhalex",
      providerSessionId: null,
      aiclSessionId: null,
    };

    expect(RemoteSessionRefSchema.safeParse(base).success).toBe(false);
    expect(RemoteSessionRefSchema.safeParse({
      ...base,
      aiclSessionId: "session-aicl",
      accountEmail: "must-not-cross-the-boundary",
    }).success).toBe(false);
    expect(RemoteSessionRefSchema.safeParse({
      ...base,
      providerSessionId: "thread\nunsafe",
    }).success).toBe(false);
  });
});
