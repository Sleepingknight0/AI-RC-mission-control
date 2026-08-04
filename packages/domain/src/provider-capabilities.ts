import type {
  ProviderAccount,
  ProviderAccountCapabilitySnapshot,
  ProviderCapabilityKey,
  ProviderModel,
  ProviderRecord,
} from "@aicl/protocol";

export interface ProviderExecutionSelection {
  accountId: string;
  modelId: string;
  reasoningEffort: string | null;
  requiredInput: "text" | "image";
}

export type ProviderExecutionResult =
  | { ok: true; account: ProviderAccount; model: ProviderModel }
  | {
      ok: false;
      code:
        | "PROVIDER_DISABLED"
        | "PROVIDER_NOT_INSTALLED"
        | "PROVIDER_NOT_AUTHENTICATED"
        | "PROVIDER_INCOMPATIBLE"
        | "PROVIDER_STALE"
        | "REMOTE_CONTROL_UNSUPPORTED"
        | "ACCOUNT_UNAVAILABLE"
        | "MODEL_UNAVAILABLE"
        | "REASONING_UNSUPPORTED"
        | "INPUT_UNSUPPORTED";
      reason: string;
    };

export function capabilityDecision(
  provider: ProviderRecord,
  key: ProviderCapabilityKey,
): { state: "supported" | "unsupported" | "unknown"; reason: string | null } {
  const capability = provider.capabilities.find(
    (candidate) => candidate.key === key,
  );
  return capability === undefined
    ? { state: "unknown", reason: "Capability was not advertised" }
    : { state: capability.state, reason: capability.reason };
}

export function selectProviderExecution(
  provider: ProviderRecord,
  selection: ProviderExecutionSelection,
): ProviderExecutionResult {
  if (!provider.enabled) {
    return {
      ok: false,
      code: "PROVIDER_DISABLED",
      reason: "Provider is disabled",
    };
  }
  if (provider.installation !== "installed") {
    return {
      ok: false,
      code: "PROVIDER_NOT_INSTALLED",
      reason: "Provider installation is not available",
    };
  }
  if (provider.authentication !== "authenticated") {
    return {
      ok: false,
      code: "PROVIDER_NOT_AUTHENTICATED",
      reason: "Provider authentication is not available",
    };
  }
  if (provider.compatibility !== "compatible") {
    return {
      ok: false,
      code: "PROVIDER_INCOMPATIBLE",
      reason: "Provider compatibility has not been established",
    };
  }
  if (provider.freshness !== "live" && provider.freshness !== "local") {
    return {
      ok: false,
      code: "PROVIDER_STALE",
      reason: "Provider evidence is stale or unavailable",
    };
  }
  const remote = capabilityDecision(provider, "remote_control");
  if (
    provider.adapterSupport !== "remote_control" ||
    remote.state !== "supported"
  ) {
    return {
      ok: false,
      code: "REMOTE_CONTROL_UNSUPPORTED",
      reason: remote.reason ?? "Provider has no verified remote-control adapter",
    };
  }

  const account = provider.accounts.find(
    (candidate) => candidate.accountId === selection.accountId,
  );
  if (
    account === undefined ||
    account.authentication !== "authenticated" ||
    account.control !== "remote_control"
  ) {
    return {
      ok: false,
      code: "ACCOUNT_UNAVAILABLE",
      reason: "Selected account is not remotely controllable",
    };
  }

  const model = provider.models.find(
    (candidate) => candidate.modelId === selection.modelId,
  );
  if (provider.modelsState !== "available" || model === undefined) {
    return {
      ok: false,
      code: "MODEL_UNAVAILABLE",
      reason: "Selected model was not advertised by the provider",
    };
  }
  if (
    selection.reasoningEffort !== null &&
    !model.reasoningEfforts.some(
      (candidate) => candidate.value === selection.reasoningEffort,
    )
  ) {
    return {
      ok: false,
      code: "REASONING_UNSUPPORTED",
      reason: "Selected reasoning effort was not advertised for this model",
    };
  }
  if (!model.inputModalities.includes(selection.requiredInput)) {
    return {
      ok: false,
      code: "INPUT_UNSUPPORTED",
      reason: "Selected model does not advertise this input modality",
    };
  }
  return { ok: true, account, model };
}

export function selectProviderAccountExecution(
  provider: ProviderRecord,
  accountEvidence: ProviderAccountCapabilitySnapshot,
  selection: ProviderExecutionSelection,
): ProviderExecutionResult {
  if (
    accountEvidence.providerId !== provider.providerId ||
    accountEvidence.accountId !== selection.accountId
  ) {
    return {
      ok: false,
      code: "ACCOUNT_UNAVAILABLE",
      reason: "Account capability evidence does not match the selection",
    };
  }
  const account = provider.accounts.find(
    (candidate) => candidate.accountId === selection.accountId,
  );
  if (
    account === undefined ||
    accountEvidence.freshness !== "live" ||
    Date.parse(accountEvidence.staleAt) <= Date.now() ||
    !accountEvidence.active ||
    accountEvidence.authentication !== "authenticated" ||
    accountEvidence.control !== "remote_control" ||
    !accountEvidence.capabilities.some(
      (capability) =>
        capability.key === "remote_control" && capability.state === "supported",
    )
  ) {
    return {
      ok: false,
      code: "ACCOUNT_UNAVAILABLE",
      reason: "Selected account lacks fresh active remote-control evidence",
    };
  }
  const model = accountEvidence.models.find(
    (candidate) => candidate.modelId === selection.modelId,
  );
  if (accountEvidence.modelsState !== "available" || model === undefined) {
    return {
      ok: false,
      code: "MODEL_UNAVAILABLE",
      reason: "Selected model was not advertised for this account",
    };
  }
  if (
    selection.reasoningEffort !== null &&
    !model.reasoningEfforts.some(
      (candidate) => candidate.value === selection.reasoningEffort,
    )
  ) {
    return {
      ok: false,
      code: "REASONING_UNSUPPORTED",
      reason: "Selected reasoning effort was not advertised for this account model",
    };
  }
  if (!model.inputModalities.includes(selection.requiredInput)) {
    return {
      ok: false,
      code: "INPUT_UNSUPPORTED",
      reason: "Selected account model does not advertise this input modality",
    };
  }
  return { ok: true, account, model };
}
