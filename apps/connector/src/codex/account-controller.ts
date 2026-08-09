import {
  ProviderAccountCapabilitySnapshotSchema,
  ProviderNativeSessionPageSchema,
  type ProviderNativeSession,
  type ProviderNativeSessionPage,
  type ProviderNativeSessionSnapshot,
  type ProviderSessionProjectionSnapshot,
} from "@aicl/protocol";

import {
  readProviderAccountProfiles,
  type ProviderAccountProfile,
} from "../provider-inventory.js";
import {
  StaleNativeSessionCursorError,
  type ManagedProviderAccount,
  type NativeSessionPageInput,
  type NativeSessionProjectionInput,
  type ProviderAccountController,
} from "../provider.js";
import { CodexProvider } from "./adapter.js";
import {
  reconcileCodexNativeObservation,
  type CodexNativeObservationContinuity,
} from "./native-projection.js";

const CURSOR_TTL_MS = 5 * 60_000;
const MAX_CURSOR_STATES = 500;

interface CursorState {
  queryKey: string;
  sessions: ProviderNativeSession[];
  offset: number;
  truncated: boolean;
  notice: string | null;
  observedAt: string;
  expiresAt: number;
}

interface ClosableNativeSessionObserver {
  close(): Promise<void>;
}

export async function closeOwnedNativeSessionObservers<T extends ClosableNativeSessionObserver>(
  observers: Map<string, T>,
  matches: (key: string) => boolean,
  onClosed: (key: string) => void,
): Promise<void> {
  const entries = [...observers].filter(([key]) => matches(key));
  const results = await Promise.allSettled(
    entries.map(([, provider]) => provider.close()),
  );
  const failures: unknown[] = [];
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]!;
    const key = entries[index]![0];
    if (result.status === "rejected") {
      failures.push(result.reason);
      continue;
    }
    observers.delete(key);
    onClosed(key);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Native Session observer shutdown failed");
  }
}

export interface CodexAccountControllerOptions {
  cwd: string;
  allowedRoots: readonly string[];
  registryRoot?: string;
  timeoutMs?: number;
}

export class CodexAccountController implements ProviderAccountController {
  readonly #options: CodexAccountControllerOptions;
  readonly #profiles: Map<string, ProviderAccountProfile>;
  readonly #identityOwners = new Map<string, string>();
  readonly #pager = new OpaqueNativeSessionPager();
  readonly #observers = new Map<string, CodexProvider>();
  readonly #observationContinuity = new Map<
    string,
    CodexNativeObservationContinuity
  >();
  #nativeRevision = 0;

  constructor(options: CodexAccountControllerOptions) {
    this.#options = options;
    this.#profiles = new Map(
      readProviderAccountProfiles(
        options.registryRoot === undefined
          ? { enabledOnly: true }
          : { registryRoot: options.registryRoot, enabledOnly: true },
      )
        .filter((profile) => profile.providerId === "codex")
        .map((profile) => [this.#key(profile.providerId, profile.accountId), profile]),
    );
  }

  open(providerId: string, accountId: string): ManagedProviderAccount | null {
    const profile = this.#profiles.get(this.#key(providerId, accountId));
    if (profile === undefined || providerId !== "codex") return null;
    const provider = new CodexProvider({
      cwd: this.#options.cwd,
      allowedRoots: this.#options.allowedRoots,
      accountId,
      codexHome: profile.profilePath,
      ...(this.#options.timeoutMs === undefined
        ? {}
        : { timeoutMs: this.#options.timeoutMs }),
    });
    return {
      providerId,
      accountId,
      provider,
      capabilities: async (revision, active) =>
        ProviderAccountCapabilitySnapshotSchema.parse(
          await provider.accountCapabilities({ revision, active }),
        ),
      identityFingerprint: () => provider.accountIdentityFingerprint(),
    };
  }

  rememberIdentity(
    providerId: string,
    accountId: string,
    fingerprint: string | null,
  ) {
    if (fingerprint === null) return;
    const owner = this.#identityOwners.get(fingerprint);
    const identity = this.#key(providerId, accountId);
    if (owner !== undefined && owner !== identity) {
      throw new Error("DUPLICATE_ACCOUNT_IDENTITY");
    }
    this.#identityOwners.set(fingerprint, identity);
  }

  async nativeSessionPage(
    account: ManagedProviderAccount,
    input: NativeSessionPageInput,
  ): Promise<ProviderNativeSessionPage> {
    const provider = account.provider;
    if (!(provider instanceof CodexProvider)) {
      throw new Error("Provider does not support native Session discovery");
    }
    return this.#pager.page(input, () =>
      provider.discoverNativeSessions({
        accountId: input.accountId,
        allowedRoots: this.#options.allowedRoots,
        revision: ++this.#nativeRevision,
        search: input.search,
        archived: input.archived,
      }),
    );
  }

  async nativeSessionProjection(
    input: NativeSessionProjectionInput,
  ): Promise<ProviderSessionProjectionSnapshot> {
    if (input.providerId !== "codex") {
      throw new Error("Provider does not support native Session observation");
    }
    const profile = this.#profiles.get(this.#key(input.providerId, input.accountId));
    if (profile === undefined) {
      throw new Error("Provider account is unavailable");
    }
    const key = this.#key(input.providerId, input.accountId);
    let provider = this.#observers.get(key);
    if (provider === undefined) {
      provider = new CodexProvider({
        cwd: this.#options.cwd,
        allowedRoots: this.#options.allowedRoots,
        accountId: input.accountId,
        codexHome: profile.profilePath,
        ...(this.#options.timeoutMs === undefined
          ? {}
          : { timeoutMs: this.#options.timeoutMs }),
      });
      this.#observers.set(key, provider);
    }
    try {
      const snapshot = await provider.readNativeSessionProjection(input);
      const observationKey = `${key}\u0000${input.providerSessionId}`;
      const reconciled = reconcileCodexNativeObservation(
        snapshot,
        this.#observationContinuity.get(observationKey) ?? null,
      );
      this.#observationContinuity.set(observationKey, reconciled.continuity);
      return reconciled.snapshot;
    } catch (error) {
      try {
        await provider.close();
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "Native Session observation failed and observer shutdown failed",
        );
      }
      this.#observers.delete(key);
      this.#deleteObservationContinuity(key);
      throw error;
    }
  }

  async close(): Promise<void> {
    await closeOwnedNativeSessionObservers(
      this.#observers,
      () => true,
      (key) => this.#deleteObservationContinuity(key),
    );
  }

  async closeProvider(providerId: string): Promise<void> {
    const prefix = `${providerId}\u0000`;
    await closeOwnedNativeSessionObservers(
      this.#observers,
      (key) => key.startsWith(prefix),
      (key) => this.#deleteObservationContinuity(key),
    );
  }

  #deleteObservationContinuity(accountKey: string) {
    const prefix = `${accountKey}\u0000`;
    for (const key of this.#observationContinuity.keys()) {
      if (key.startsWith(prefix)) this.#observationContinuity.delete(key);
    }
  }

  #key(providerId: string, accountId: string) {
    return `${providerId}\u0000${accountId}`;
  }
}

export class OpaqueNativeSessionPager {
  readonly #cursors = new Map<string, CursorState>();

  async page(
    input: NativeSessionPageInput,
    discover: () => Promise<ProviderNativeSessionSnapshot>,
  ): Promise<ProviderNativeSessionPage> {
    const queryKey = JSON.stringify({
      providerId: input.providerId,
      accountId: input.accountId,
      search: input.search,
      archived: input.archived,
    });
    this.#pruneCursors();
    let state: CursorState;
    if (input.cursor === null) {
      const snapshot = await discover();
      state = {
        queryKey,
        sessions: snapshot.sessions,
        offset: 0,
        truncated: snapshot.truncated,
        notice: snapshot.notice,
        observedAt: snapshot.observedAt,
        expiresAt: Date.now() + CURSOR_TTL_MS,
      };
    } else {
      const stored = this.#cursors.get(input.cursor);
      this.#cursors.delete(input.cursor);
      if (
        stored === undefined ||
        stored.expiresAt <= Date.now() ||
        stored.queryKey !== queryKey
      ) {
        throw new StaleNativeSessionCursorError();
      }
      state = stored;
    }

    const sessions = state.sessions.slice(
      state.offset,
      state.offset + input.pageSize,
    );
    state.offset += sessions.length;
    state.expiresAt = Date.now() + CURSOR_TTL_MS;
    const hasMore = state.offset < state.sessions.length;
    const nextCursor = hasMore ? `native-cursor-${crypto.randomUUID()}` : null;
    if (nextCursor !== null) {
      if (this.#cursors.size >= MAX_CURSOR_STATES) {
        const oldest = this.#cursors.keys().next().value as string | undefined;
        if (oldest !== undefined) this.#cursors.delete(oldest);
      }
      this.#cursors.set(nextCursor, state);
    }
    return ProviderNativeSessionPageSchema.parse({
      providerId: input.providerId,
      accountId: input.accountId,
      observedAt: state.observedAt,
      freshness: "live",
      sessions,
      nextCursor,
      hasMore,
      truncated: state.truncated,
      cursorReset: false,
      notice:
        state.truncated && state.notice === null
          ? "Provider Session discovery reached its configured bound"
          : state.notice,
    });
  }

  #pruneCursors() {
    const now = Date.now();
    for (const [cursor, state] of this.#cursors) {
      if (state.expiresAt <= now) this.#cursors.delete(cursor);
    }
  }
}
