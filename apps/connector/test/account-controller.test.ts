import {
  ProviderNativeSessionSnapshotSchema,
  type ProviderNativeSession,
} from "@aicl/protocol";
import { describe, expect, it } from "vitest";

import { OpaqueNativeSessionPager } from "../src/codex/account-controller.js";
import {
  StaleNativeSessionCursorError,
  UnavailableProvider,
  nativeSessionPageWithRecovery,
  type ManagedProviderAccount,
  type NativeSessionPageInput,
  type ProviderAccountController,
} from "../src/provider.js";

const observedAt = "2026-08-04T00:00:00.000Z";

describe("account-scoped native Session pagination", () => {
  it("uses opaque one-time query-bound cursors and preserves truncation truth", async () => {
    const pager = new OpaqueNativeSessionPager();
    const sessions = Array.from({ length: 5 }, (_, index) =>
      nativeSession(`native-${index + 1}`),
    );
    const discover = async () => ProviderNativeSessionSnapshotSchema.parse({
      snapshotId: "native-snapshot",
      revision: 1,
      providerId: "codex",
      accountId: "blue",
      observedAt,
      staleAt: "2026-08-04T00:05:00.000Z",
      freshness: "live",
      truncated: true,
      notice: null,
      sessions,
    });
    const first = await pager.page(input(), discover);
    expect(first.sessions.map((session) => session.providerSessionId)).toEqual([
      "native-1",
      "native-2",
    ]);
    expect(first).toMatchObject({ hasMore: true, truncated: true });
    expect(first.nextCursor).toMatch(/^native-cursor-/);
    expect(first.notice).toContain("configured bound");
    expect(first.nextCursor).not.toContain("native-2");

    const second = await pager.page(
      { ...input(), cursor: first.nextCursor },
      async () => {
        throw new Error("cursor pages must not rediscover");
      },
    );
    expect(second.sessions.map((session) => session.providerSessionId)).toEqual([
      "native-3",
      "native-4",
    ]);
    expect(new Set([...first.sessions, ...second.sessions].map(
      (session) => session.providerSessionId,
    )).size).toBe(4);

    await expect(pager.page(
      { ...input(), cursor: second.nextCursor, search: "different-query" },
      discover,
    )).rejects.toBeInstanceOf(StaleNativeSessionCursorError);
    await expect(pager.page(
      { ...input(), cursor: second.nextCursor },
      discover,
    )).rejects.toBeInstanceOf(StaleNativeSessionCursorError);
  });

  it("recovers a stale cursor with a fresh first page and marks the reset", async () => {
    const calls: Array<string | null> = [];
    const account = managedAccount();
    const controller: ProviderAccountController = {
      open: () => account,
      rememberIdentity: () => undefined,
      async nativeSessionPage(_account, pageInput) {
        calls.push(pageInput.cursor);
        if (pageInput.cursor !== null) throw new StaleNativeSessionCursorError();
        return {
          providerId: "codex",
          accountId: "blue",
          observedAt,
          freshness: "live",
          sessions: [nativeSession("fresh-native")],
          nextCursor: null,
          hasMore: false,
          truncated: false,
          cursorReset: false,
          notice: null,
        };
      },
    };

    const page = await nativeSessionPageWithRecovery(controller, account, {
      ...input(),
      cursor: "native-cursor-stale-value",
    });
    expect(calls).toEqual(["native-cursor-stale-value", null]);
    expect(page.cursorReset).toBe(true);
    expect(page.sessions[0]?.providerSessionId).toBe("fresh-native");
  });
});

function input(): NativeSessionPageInput {
  return {
    providerId: "codex",
    accountId: "blue",
    pageSize: 2,
    cursor: null,
    search: null,
    archived: "exclude",
  };
}

function nativeSession(providerSessionId: string): ProviderNativeSession {
  return {
    providerId: "codex",
    accountId: "blue",
    providerSessionId,
    title: providerSessionId,
    preview: null,
    projectPath: process.cwd(),
    projectName: "project",
    branch: null,
    providerStatus: "idle",
    createdAt: observedAt,
    updatedAt: observedAt,
    pinned: false,
    archived: false,
    canResume: true,
  };
}

function managedAccount(): ManagedProviderAccount {
  return {
    providerId: "codex",
    accountId: "blue",
    provider: new UnavailableProvider(),
    capabilities: async () => {
      throw new Error("not used");
    },
    identityFingerprint: async () => null,
  };
}
