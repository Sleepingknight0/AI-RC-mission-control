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
