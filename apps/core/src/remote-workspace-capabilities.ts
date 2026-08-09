import type {
  ProviderCapabilityEvidence,
  RemoteWorkspaceCapabilities,
  RemoteWorkspaceCapabilityEvidence,
} from "@aicl/protocol";

export interface CapabilityGate {
  allowed: boolean;
  reason: string | null;
}

export interface RemoteWorkspaceCapabilityInput {
  freshness: RemoteWorkspaceCapabilityEvidence["freshness"];
  observation: CapabilityGate;
  mutation: CapabilityGate;
  evidence: readonly ProviderCapabilityEvidence[];
}

/**
 * Project independent provider features through independent authority gates.
 * Observation is never inferred from mutation authority and no mutation is
 * inferred from another supported mutation.
 */
export function projectRemoteWorkspaceCapabilities(
  input: RemoteWorkspaceCapabilityInput,
): RemoteWorkspaceCapabilities {
  const observe = (...keys: ProviderCapabilityEvidence["key"][]) =>
    projectCapability(input, input.observation, keys);
  const mutate = (...keys: ProviderCapabilityEvidence["key"][]) =>
    projectCapability(input, input.mutation, keys);
  return {
    canDiscoverSessions: observe("list_sessions"),
    canReadHistory: observe("read_history"),
    canObserveLive: observe("observe_live"),
    canResume: mutate("resume_session"),
    canSubmit: mutate("submit_turn"),
    canSteer: mutate("steer_turn"),
    canInterrupt: mutate("interrupt_turn"),
    canApprove: mutate("resolve_approval"),
    canChangeModel: mutate("change_model"),
    canChangeReasoning: mutate("reasoning_levels"),
    canChangeExecutionMode: mutate("execution_modes"),
    canAttach: mutate("text_input", "file_input", "image_input"),
    canReadDiffs: observe("read_diffs"),
    canReadTerminalEvidence: observe("read_terminal_evidence"),
  };
}

function projectCapability(
  input: RemoteWorkspaceCapabilityInput,
  gate: CapabilityGate,
  keys: readonly ProviderCapabilityEvidence["key"][],
): RemoteWorkspaceCapabilityEvidence {
  if (input.freshness !== "live" && input.freshness !== "local") {
    return unsupported(
      input.freshness,
      "provider_probe",
      `Provider capability evidence is ${input.freshness}.`,
    );
  }
  if (!gate.allowed) {
    return unsupported(
      input.freshness,
      "session_authority",
      gate.reason ?? "Current Session authority does not allow this capability.",
    );
  }
  const candidates = keys.flatMap((key) =>
    input.evidence.filter((item) => item.key === key),
  );
  const supportedEvidence = candidates.find(
    (item) => item.state === "supported",
  );
  if (supportedEvidence !== undefined) {
    return {
      supported: true,
      freshness: input.freshness,
      source: sourceFor(supportedEvidence),
      reason: null,
    };
  }
  const negative = candidates[0];
  return unsupported(
    input.freshness,
    negative === undefined ? "adapter_manifest" : sourceFor(negative),
    negative?.reason ??
      `Provider did not advertise ${keys.join(" or ")} support.`,
  );
}

function sourceFor(
  evidence: ProviderCapabilityEvidence,
): RemoteWorkspaceCapabilityEvidence["source"] {
  return evidence.provenance === "provider_probe"
    ? "provider_probe"
    : "adapter_manifest";
}

function unsupported(
  freshness: RemoteWorkspaceCapabilityEvidence["freshness"],
  source: RemoteWorkspaceCapabilityEvidence["source"],
  reason: string,
): RemoteWorkspaceCapabilityEvidence {
  return { supported: false, freshness, source, reason };
}
