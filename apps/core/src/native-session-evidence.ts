import type {
  ProviderNativeSession,
  ProviderNativeSessionArchiveFilter,
  ProviderNativeSessionPage,
} from "@aicl/protocol";

const NATIVE_SESSION_EVIDENCE_TTL_MS = 5 * 60_000;

export interface NativeSessionPageRequest {
  providerId: string;
  accountId: string;
  cursor: string | null;
  search: string | null;
  archived: ProviderNativeSessionArchiveFilter;
}

export interface ConnectorRuntimeIdentity {
  bootId: string;
  runtimeId: string;
  runtimeGeneration: number;
}

interface NativeSessionEvidence {
  queryKey: string;
  observedAt: string;
  receivedAt: number;
  identity: ConnectorRuntimeIdentity;
  freshness: ProviderNativeSessionPage["freshness"];
  rows: Map<string, ProviderNativeSession>;
}

export class NativeSessionEvidenceStore {
  readonly #pairs = new Map<string, NativeSessionEvidence>();

  record(
    request: NativeSessionPageRequest,
    page: ProviderNativeSessionPage,
    identity: ConnectorRuntimeIdentity,
    receivedAt = Date.now(),
  ): void {
    const pairKey = this.#pairKey(request.providerId, request.accountId);
    const queryKey = JSON.stringify({
      providerId: request.providerId,
      accountId: request.accountId,
      search: request.search,
      archived: request.archived,
    });
    const startsGeneration = request.cursor === null || page.cursorReset;
    if (startsGeneration) {
      const rows = new Map<string, ProviderNativeSession>();
      if (page.freshness === "live") {
        for (const session of page.sessions) rows.set(session.providerSessionId, session);
      }
      this.#pairs.set(pairKey, {
        queryKey,
        observedAt: page.observedAt,
        receivedAt,
        identity: { ...identity },
        freshness: page.freshness,
        rows,
      });
      return;
    }

    const retained = this.#pairs.get(pairKey);
    if (
      retained === undefined ||
      retained.queryKey !== queryKey ||
      retained.observedAt !== page.observedAt ||
      retained.freshness !== "live" ||
      page.freshness !== "live" ||
      !this.#sameIdentity(retained.identity, identity)
    ) {
      return;
    }
    for (const session of page.sessions) {
      retained.rows.set(session.providerSessionId, session);
    }
  }

  resumable(
    providerId: string,
    accountId: string,
    providerSessionId: string,
    identity: ConnectorRuntimeIdentity,
    now = Date.now(),
  ): ProviderNativeSession | null {
    const evidence = this.#pairs.get(this.#pairKey(providerId, accountId));
    if (
      evidence === undefined ||
      evidence.freshness !== "live" ||
      !this.#sameIdentity(evidence.identity, identity) ||
      evidence.receivedAt + NATIVE_SESSION_EVIDENCE_TTL_MS <= now ||
      Date.parse(evidence.observedAt) + NATIVE_SESSION_EVIDENCE_TTL_MS <= now
    ) {
      return null;
    }
    const row = evidence.rows.get(providerSessionId);
    return row?.canResume === true ? row : null;
  }

  #pairKey(providerId: string, accountId: string): string {
    return `${providerId}\u0000${accountId}`;
  }

  #sameIdentity(
    left: ConnectorRuntimeIdentity,
    right: ConnectorRuntimeIdentity,
  ): boolean {
    return (
      left.bootId === right.bootId &&
      left.runtimeId === right.runtimeId &&
      left.runtimeGeneration === right.runtimeGeneration
    );
  }
}
