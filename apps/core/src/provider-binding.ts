import type { RemoteSessionBindingState } from "@aicl/protocol";

const SAFE_RETRY_CODES = new Set([
  "PROJECT_UNAVAILABLE",
  "AUTHENTICATION_REQUIRED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_DISABLED",
  "STALE_RUNTIME_GENERATION",
]);

const REASONS: Readonly<Record<string, string>> = {
  PROJECT_UNAVAILABLE:
    "Project is unavailable or outside the configured workspace.",
  AUTHENTICATION_REQUIRED:
    "Authentication is required for the exact bound provider account.",
  PROVIDER_UNAVAILABLE: "Provider is currently unavailable.",
  PROVIDER_DISABLED: "Provider is disabled.",
  PROVIDER_MODEL_UNAVAILABLE:
    "The selected model or reasoning level is unavailable.",
  STALE_RUNTIME_GENERATION:
    "The Connector Runtime changed before binding completed.",
  PROVIDER_BINDING_MISMATCH:
    "Provider returned a different Session identity.",
  PROVIDER_SESSION_ALREADY_IMPORTED:
    "The provider Session is already bound to another AICL Session.",
  IDEMPOTENCY_KEY_REUSE:
    "The binding command identity was reused with different content.",
  PROVIDER_SESSION_REJECTED: "Provider rejected Session creation.",
};

export interface ProviderBindingFailurePresentation {
  code: string;
  reason: string;
  canRetry: boolean;
}

export function providerBindingFailure(
  code: string | null | undefined,
): ProviderBindingFailurePresentation | null {
  if (code === null || code === undefined) return null;
  const normalized = Object.hasOwn(REASONS, code)
    ? code
    : "PROVIDER_SESSION_REJECTED";
  return {
    code: normalized,
    reason: REASONS[normalized]!,
    canRetry: SAFE_RETRY_CODES.has(normalized),
  };
}

export function remoteBindingState(input: {
  status: "pending" | "ready" | "failed" | "outcome_unknown" | undefined;
  runtimeMatches: boolean;
}): RemoteSessionBindingState {
  if (input.status === undefined) return "unbound";
  if (input.status === "pending") return "binding";
  if (input.status === "failed") return "failed";
  if (input.status === "outcome_unknown" || !input.runtimeMatches) return "stale";
  return "ready";
}
