import type { ProviderNativeSessionPage } from "@aicl/protocol";

export interface PendingActivationFence {
  epoch: number;
  activationCommandId: string | null;
}

export interface ActivationResponseIdentity {
  commandId: string;
  providerId: string;
  accountId: string;
}

export function activationResponseMatches(
  pending: PendingActivationFence | null,
  response: ActivationResponseIdentity,
  current: {
    epoch: number;
    providerId: string | null;
    accountId: string | null;
  },
): boolean {
  return (
    pending !== null &&
    pending.activationCommandId !== null &&
    pending.activationCommandId === response.commandId &&
    pending.epoch === current.epoch &&
    response.providerId === current.providerId &&
    response.accountId === current.accountId
  );
}

export interface PendingNativeResumeRefresh {
  epoch: number;
  requestId: string;
  providerId: string;
  accountId: string;
  providerSessionId: string;
  search: string;
}

export type NativeResumeRefreshDecision =
  | { kind: "ignore" }
  | { kind: "resume" }
  | { kind: "continue"; cursor: string }
  | { kind: "unavailable" };

export function nativeResumeRefreshDecision(
  pending: PendingNativeResumeRefresh | null,
  requestId: string,
  page: ProviderNativeSessionPage,
  epoch: number,
): NativeResumeRefreshDecision {
  if (
    pending === null ||
    pending.epoch !== epoch ||
    pending.requestId !== requestId ||
    pending.providerId !== page.providerId ||
    pending.accountId !== page.accountId
  ) {
    return { kind: "ignore" };
  }
  const target = page.sessions.find(
    (session) => session.providerSessionId === pending.providerSessionId,
  );
  if (page.freshness === "live" && target?.canResume === true) {
    return { kind: "resume" };
  }
  if (page.freshness === "live" && page.nextCursor !== null) {
    return { kind: "continue", cursor: page.nextCursor };
  }
  return { kind: "unavailable" };
}
