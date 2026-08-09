import type { ProviderCapabilityEvidence } from "@aicl/protocol";
import { describe, expect, it } from "vitest";

import { projectRemoteWorkspaceCapabilities } from "../src/remote-workspace-capabilities.js";

const observedAt = "2026-08-10T00:00:00.000Z";
const evidence = (
  key: ProviderCapabilityEvidence["key"],
  state: ProviderCapabilityEvidence["state"] = "supported",
): ProviderCapabilityEvidence => ({
  key,
  state,
  provenance: "provider_probe",
  observedAt,
  reason: state === "supported" ? null : `${key} unavailable`,
});

describe("remote workspace capability projection", () => {
  it("keeps read-only native observation when mutation authority is absent", () => {
    const projected = projectRemoteWorkspaceCapabilities({
      freshness: "live",
      observation: { allowed: true, reason: null },
      mutation: {
        allowed: false,
        reason: "Catalog marks this Session as non-controllable.",
      },
      evidence: [
        evidence("list_sessions"),
        evidence("read_history"),
        evidence("observe_live"),
        evidence("submit_turn"),
      ],
    });

    expect(projected.canDiscoverSessions.supported).toBe(true);
    expect(projected.canReadHistory.supported).toBe(true);
    expect(projected.canObserveLive.supported).toBe(true);
    expect(projected.canSubmit).toMatchObject({
      supported: false,
      source: "session_authority",
      reason: "Catalog marks this Session as non-controllable.",
    });
  });

  it("never promotes one supported mutation into another", () => {
    const projected = projectRemoteWorkspaceCapabilities({
      freshness: "live",
      observation: { allowed: true, reason: null },
      mutation: { allowed: true, reason: null },
      evidence: [
        evidence("resume_session"),
        evidence("steer_turn", "unsupported"),
      ],
    });

    expect(projected.canResume.supported).toBe(true);
    expect(projected.canSteer.supported).toBe(false);
    expect(projected.canSubmit.supported).toBe(false);
  });

  it("fails every capability closed when evidence is stale", () => {
    const projected = projectRemoteWorkspaceCapabilities({
      freshness: "stale",
      observation: { allowed: true, reason: null },
      mutation: { allowed: true, reason: null },
      evidence: [evidence("read_history"), evidence("submit_turn")],
    });

    expect(projected.canReadHistory).toMatchObject({
      supported: false,
      freshness: "stale",
    });
    expect(projected.canSubmit.supported).toBe(false);
  });
});
