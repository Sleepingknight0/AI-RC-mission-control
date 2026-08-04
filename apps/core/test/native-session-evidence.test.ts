import type {
  ProviderNativeSession,
  ProviderNativeSessionPage,
} from "@aicl/protocol";
import { describe, expect, it } from "vitest";

import { NativeSessionEvidenceStore } from "../src/native-session-evidence.js";

const identity = {
  bootId: "boot-one",
  runtimeId: "runtime-one",
  runtimeGeneration: 1,
};

const request = (cursor: string | null = null, search: string | null = null) => ({
  providerId: "codex",
  accountId: "blue",
  cursor,
  search,
  archived: "exclude" as const,
});

const row = (providerSessionId: string, canResume = true): ProviderNativeSession => ({
  providerId: "codex",
  accountId: "blue",
  providerSessionId,
  title: providerSessionId,
  preview: null,
  projectPath: "C:\\workspace",
  projectName: "workspace",
  branch: null,
  providerStatus: "idle",
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:00:00.000Z",
  pinned: false,
  archived: false,
  canResume,
});

const page = (
  sessions: ProviderNativeSession[],
  overrides: Partial<ProviderNativeSessionPage> = {},
): ProviderNativeSessionPage => ({
  providerId: "codex",
  accountId: "blue",
  observedAt: "2026-08-04T00:00:00.000Z",
  freshness: "live",
  sessions,
  nextCursor: null,
  hasMore: false,
  truncated: false,
  cursorReset: false,
  notice: null,
  ...overrides,
});

describe("native Session resume evidence", () => {
  it("replaces pair authority on fresh, empty, and cursor-reset generations", () => {
    const store = new NativeSessionEvidenceStore();
    const now = Date.parse("2026-08-04T00:01:00.000Z");
    store.record(request(), page([row("native-one")]), identity, now);
    expect(store.resumable("codex", "blue", "native-one", identity, now)).not.toBeNull();

    store.record(request(), page([]), identity, now + 1);
    expect(store.resumable("codex", "blue", "native-one", identity, now + 1)).toBeNull();

    store.record(request(), page([row("native-two")]), identity, now + 2);
    store.record(
      request("opaque-cursor-at-least-16", "different-query"),
      page([row("native-three")], { cursorReset: true }),
      identity,
      now + 3,
    );
    expect(store.resumable("codex", "blue", "native-two", identity, now + 3)).toBeNull();
    expect(store.resumable("codex", "blue", "native-three", identity, now + 3)).not.toBeNull();
  });

  it("rejects non-resumable, expired, and prior-runtime rows", () => {
    const store = new NativeSessionEvidenceStore();
    const now = Date.parse("2026-08-04T00:01:00.000Z");
    store.record(request(), page([row("blocked", false), row("fresh")]), identity, now);
    expect(store.resumable("codex", "blue", "blocked", identity, now)).toBeNull();
    expect(store.resumable("codex", "blue", "fresh", {
      ...identity,
      runtimeGeneration: 2,
    }, now)).toBeNull();
    expect(store.resumable("codex", "blue", "fresh", identity, now + 5 * 60_000)).toBeNull();
  });
});
