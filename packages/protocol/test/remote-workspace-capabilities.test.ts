import { describe, expect, it } from "vitest";

import { RemoteWorkspaceCapabilitiesSchema } from "../src/index.js";

const supported = {
  supported: true,
  freshness: "live",
  source: "provider_probe",
  reason: null,
} as const;
const unsupported = {
  supported: false,
  freshness: "live",
  source: "adapter_manifest",
  reason: "The installed adapter does not implement this capability.",
} as const;

describe("remote workspace capabilities", () => {
  it("requires independent evidence for every remote workspace capability", () => {
    const parsed = RemoteWorkspaceCapabilitiesSchema.parse({
      canDiscoverSessions: supported,
      canReadHistory: supported,
      canObserveLive: supported,
      canResume: unsupported,
      canSubmit: unsupported,
      canSteer: unsupported,
      canInterrupt: unsupported,
      canApprove: unsupported,
      canChangeModel: unsupported,
      canChangeReasoning: unsupported,
      canChangeExecutionMode: unsupported,
      canAttach: unsupported,
      canReadDiffs: supported,
      canReadTerminalEvidence: supported,
    });

    expect(parsed.canReadHistory.supported).toBe(true);
    expect(parsed.canSubmit.supported).toBe(false);
  });

  it("rejects a false capability without a bounded authoritative reason", () => {
    expect(() => RemoteWorkspaceCapabilitiesSchema.parse({
      canDiscoverSessions: supported,
      canReadHistory: supported,
      canObserveLive: supported,
      canResume: { ...unsupported, reason: null },
      canSubmit: unsupported,
      canSteer: unsupported,
      canInterrupt: unsupported,
      canApprove: unsupported,
      canChangeModel: unsupported,
      canChangeReasoning: unsupported,
      canChangeExecutionMode: unsupported,
      canAttach: unsupported,
      canReadDiffs: supported,
      canReadTerminalEvidence: supported,
    })).toThrow();
  });
});
