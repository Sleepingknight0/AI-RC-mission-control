import {
  ProviderSessionProjectionSnapshotSchema,
  makeEnvelope,
  type ProviderSessionProjectionSnapshot,
} from "@aicl/protocol";
import { describe, expect, it } from "vitest";

import {
  initialNativeProjectionState,
  nativeProjectionHeaderStatus,
  nativeProjectionRequestStarted,
  nativeProjectionSelectionFromStoredIds,
  nativeProjectionSignal,
  reduceNativeProjection,
} from "../src/mobile/native-projection.js";

const now = Date.parse("2026-08-09T08:00:00.000Z");

function projection(
  overrides: Partial<ProviderSessionProjectionSnapshot> = {},
): ProviderSessionProjectionSnapshot {
  return ProviderSessionProjectionSnapshotSchema.parse({
    projectionId: "projection-1",
    revision: 1,
    providerId: "codex",
    accountId: "one",
    providerSessionId: "thread-1",
    providerRevision: "1",
    providerCursor: null,
    observedAt: "2026-08-09T08:00:00.000Z",
    staleAt: "2026-08-09T08:00:05.000Z",
    freshness: "live",
    availability: "available",
    runtimeId: "runtime-1",
    runtimeGeneration: 1,
    title: "Native work",
    projectLabel: "mission-control",
    state: "thinking",
    activeSince: "2026-08-09T07:59:50.000Z",
    truncated: false,
    notice: null,
    items: [
      {
        type: "assistant_progress",
        providerTurnId: "turn-1",
        providerItemId: "progress-1",
        order: 0,
        progressType: "commentary",
        status: "streaming",
        text: "Inspecting the repository",
      },
    ],
    ...overrides,
  });
}

describe("provider-native projection Web state", () => {
  it("restores protocol-valid provider-native identities up to their exact bounds", () => {
    const providerId = `p${"a".repeat(95)}`;
    const accountId = `a${"b".repeat(95)}`;
    const providerSessionId = `thread:${"x".repeat(193)}`;

    expect(
      nativeProjectionSelectionFromStoredIds({
        providerId,
        accountId,
        providerSessionId,
      }),
    ).toEqual({ providerId, accountId, providerSessionId });
    expect(
      nativeProjectionSelectionFromStoredIds({
        providerId,
        accountId,
        providerSessionId: "thread\nunsafe",
      }),
    ).toBeNull();
  });

  it("accepts only the exact outstanding provider/account/Session response", () => {
    const selection = {
      providerId: "codex",
      accountId: "one",
      providerSessionId: "thread-1",
    };
    const loading = nativeProjectionRequestStarted(
      initialNativeProjectionState(),
      "request-1",
      selection,
    );
    const wrong = reduceNativeProjection(
      loading,
      makeEnvelope("provider.session.projection.snapshot", {
        requestId: "request-1",
        snapshot: projection({ accountId: "two" }),
      }),
      selection,
      now,
    );
    expect(wrong).toEqual(loading);

    const accepted = reduceNativeProjection(
      loading,
      makeEnvelope("provider.session.projection.snapshot", {
        requestId: "request-1",
        snapshot: projection(),
      }),
      selection,
      now,
    );
    expect(accepted.status).toBe("ready");
    expect(accepted.snapshot?.items).toHaveLength(1);
  });

  it("rebuilds from replacement snapshots without appending duplicates", () => {
    const selection = {
      providerId: "codex",
      accountId: "one",
      providerSessionId: "thread-1",
    };
    const first = reduceNativeProjection(
      nativeProjectionRequestStarted(initialNativeProjectionState(), "first", selection),
      makeEnvelope("provider.session.projection.snapshot", {
        requestId: "first",
        snapshot: projection(),
      }),
      selection,
      now,
    );
    const refreshedSnapshot = projection({
      projectionId: "projection-2",
      revision: 2,
      providerRevision: "2",
      state: "completed",
      activeSince: null,
      items: [
        ...projection().items.map((item) =>
          item.type === "assistant_progress"
            ? { ...item, status: "completed" as const }
            : item,
        ),
        {
          type: "assistant_message" as const,
          providerTurnId: "turn-1",
          providerItemId: "answer-1",
          order: 1,
          phase: "final_answer" as const,
          status: "completed" as const,
          text: "Done",
        },
      ],
    });
    const refreshed = reduceNativeProjection(
      nativeProjectionRequestStarted(first, "second", selection),
      makeEnvelope("provider.session.projection.snapshot", {
        requestId: "second",
        snapshot: refreshedSnapshot,
      }),
      selection,
      now,
    );

    expect(refreshed.snapshot?.items.map((item) => item.providerItemId)).toEqual([
      "progress-1",
      "answer-1",
    ]);
    expect(nativeProjectionHeaderStatus(refreshed.snapshot, now)).toMatchObject({
      label: "View only",
      activityLabel: "Completed",
    });
  });

  it("fails expired and unavailable provider evidence closed", () => {
    const selection = {
      providerId: "codex",
      accountId: "one",
      providerSessionId: "thread-1",
    };
    const stale = reduceNativeProjection(
      nativeProjectionRequestStarted(initialNativeProjectionState(), "stale", selection),
      makeEnvelope("provider.session.projection.snapshot", {
        requestId: "stale",
        snapshot: projection({
          observedAt: "2026-08-09T07:59:50.000Z",
          staleAt: "2026-08-09T07:59:59.000Z",
        }),
      }),
      selection,
      now,
    );
    expect(stale.status).toBe("unavailable");
    expect(stale.snapshot).toBeNull();
    expect(nativeProjectionHeaderStatus(null, now)).toMatchObject({
      label: "Remote activity unavailable",
      tone: "offline",
    });
  });

  it("maps active native states to truthful LIVE header labels", () => {
    expect(nativeProjectionHeaderStatus(projection(), now)).toMatchObject({
      label: "LIVE · Thinking",
      activityLabel: "00:10",
      tone: "working",
    });
    expect(
      nativeProjectionHeaderStatus(
        projection({ state: "running_tests" }),
        now,
      ),
    ).toMatchObject({ label: "LIVE · Running tests" });
  });

  it("signals an in-place rendered file-change update for Return to live", () => {
    const fileChange = {
      type: "file_change" as const,
      providerTurnId: "turn-1",
      providerItemId: "file-1",
      order: 0,
      status: "running" as const,
      files: [{ path: "src/a.ts", kind: "update" as const }],
    };
    const before = projection({ items: [fileChange] });
    const after = projection({
      items: [
        {
          ...fileChange,
          files: [
            ...fileChange.files,
            { path: "src/b.ts", kind: "add" as const },
          ],
        },
      ],
    });

    expect(nativeProjectionSignal(after)).not.toBe(nativeProjectionSignal(before));
  });

  it("does not signal an unread update for an unchanged polling observation", () => {
    const before = projection({
      projectionId: "projection-poll-1",
      revision: 41,
      providerRevision: null,
      observedAt: "2026-08-09T08:00:00.000Z",
      staleAt: "2026-08-09T08:00:05.000Z",
    });
    const after = projection({
      projectionId: "projection-poll-2",
      revision: 42,
      providerRevision: null,
      observedAt: "2026-08-09T08:00:01.500Z",
      staleAt: "2026-08-09T08:00:06.500Z",
    });

    expect(nativeProjectionSignal(after)).toBe(nativeProjectionSignal(before));
  });
});
