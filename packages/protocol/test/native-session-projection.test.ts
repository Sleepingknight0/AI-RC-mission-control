import { describe, expect, it } from "vitest";

import {
  ClientEnvelopeSchema,
  ConnectorEnvelopeSchema,
  CoreToConnectorEnvelopeSchema,
  ProviderSessionProjectionSnapshotSchema,
  ServerEnvelopeSchema,
  makeEnvelope,
} from "../src/index.js";

const observedAt = "2026-08-09T06:00:00.000Z";

const snapshot = {
  projectionId: "projection-1",
  revision: 1,
  providerId: "codex",
  accountId: "not-bluewhalex",
  providerSessionId: "thread-1",
  providerRevision: "1786233234",
  providerCursor: null,
  observedAt,
  staleAt: "2026-08-09T06:00:05.000Z",
  freshness: "live" as const,
  availability: "available" as const,
  runtimeId: "runtime-1",
  runtimeGeneration: 4,
  title: "Native thread",
  projectLabel: "mission-control",
  state: "running_tests" as const,
  activeSince: "2026-08-09T05:59:50.000Z",
  truncated: false,
  notice: null,
  items: [
    {
      type: "operator_message" as const,
      providerTurnId: "turn-1",
      providerItemId: "user-1",
      order: 0,
      text: "Run the checks",
    },
    {
      type: "activity" as const,
      providerTurnId: "turn-1",
      providerItemId: "command-1",
      order: 1,
      activityType: "test" as const,
      status: "running" as const,
      title: "pnpm test",
      cwdLabel: "mission-control",
      durationMs: 8_000,
      combinedOutputPreview: "tests running",
      stdoutPreview: null,
      stderrPreview: null,
    },
    {
      type: "turn_state" as const,
      providerTurnId: "turn-1",
      providerItemId: "turn-1:state",
      order: 2,
      state: "running_tests" as const,
      startedAt: "2026-08-09T05:59:50.000Z",
      completedAt: null,
      failureCode: null,
    },
  ],
};

describe("provider-native Session projection protocol", () => {
  it("accepts a bounded normalized projection and exact relay envelopes", () => {
    expect(ProviderSessionProjectionSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(
      ClientEnvelopeSchema.parse(
        makeEnvelope("provider.session.projection.get", {
          requestId: "request-1",
          providerId: "codex",
          accountId: "not-bluewhalex",
          providerSessionId: "thread-1",
        }),
      ).type,
    ).toBe("provider.session.projection.get");
    expect(
      CoreToConnectorEnvelopeSchema.parse(
        makeEnvelope("connector.provider.session.projection.get", {
          requestId: "request-1",
          providerId: "codex",
          accountId: "not-bluewhalex",
          providerSessionId: "thread-1",
        }),
      ).type,
    ).toBe("connector.provider.session.projection.get");
    expect(
      ConnectorEnvelopeSchema.parse(
        makeEnvelope("connector.provider.session.projection.snapshot", {
          requestId: "request-1",
          snapshot,
        }),
      ).type,
    ).toBe("connector.provider.session.projection.snapshot");
    expect(
      ServerEnvelopeSchema.parse(
        makeEnvelope("provider.session.projection.snapshot", {
          requestId: "request-1",
          snapshot,
        }),
      ).type,
    ).toBe("provider.session.projection.snapshot");
  });

  it("rejects duplicate native identities, raw fields, and mismatched live state", () => {
    expect(() =>
      ProviderSessionProjectionSnapshotSchema.parse({
        ...snapshot,
        items: [snapshot.items[0], snapshot.items[0]],
      }),
    ).toThrow();
    expect(() =>
      ProviderSessionProjectionSnapshotSchema.parse({
        ...snapshot,
        rawProviderEvent: { method: "item/started" },
      }),
    ).toThrow();
    expect(() =>
      ProviderSessionProjectionSnapshotSchema.parse({
        ...snapshot,
        state: "completed",
        activeSince: "2026-08-09T05:59:50.000Z",
      }),
    ).toThrow();
  });

  it("requires unavailable projections to contain no fabricated history", () => {
    expect(
      ProviderSessionProjectionSnapshotSchema.parse({
        ...snapshot,
        providerRevision: null,
        freshness: "unavailable",
        availability: "unsupported",
        state: "unavailable",
        activeSince: null,
        title: null,
        projectLabel: null,
        items: [],
        notice: "Remote activity unavailable",
      }).availability,
    ).toBe("unsupported");

    expect(() =>
      ProviderSessionProjectionSnapshotSchema.parse({
        ...snapshot,
        freshness: "unavailable",
        availability: "unavailable",
        state: "idle",
      }),
    ).toThrow();
  });

  it("rejects a complete normalized projection larger than 600 KiB", () => {
    const oversized = {
      ...snapshot,
      items: Array.from({ length: 41 }, (_, index) => ({
        type: "assistant_progress" as const,
        providerTurnId: "turn-large",
        providerItemId: `progress-${index}`,
        order: index,
        progressType: "commentary" as const,
        status: "streaming" as const,
        text: "x".repeat(15_000),
      })),
    };
    expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBeGreaterThan(
      600 * 1024,
    );
    expect(() => ProviderSessionProjectionSnapshotSchema.parse(oversized)).toThrow(
      "600 KiB",
    );
  });
});
