import type {
  ProviderAccount,
  ProviderAccountCapabilitySnapshot,
  ProviderFleetSnapshot,
  ProviderModel,
  ProviderNativeSession,
  ProviderRecord,
  SessionCapabilitiesSnapshot,
  SessionCatalogFilter,
  SessionSettingsSnapshot,
  SessionSummaryV2,
} from "@aicl/protocol";

export type AccountKey = `${string}\u0000${string}`;

export interface ProviderAccountGroup {
  provider: ProviderRecord;
  accounts: ProviderAccount[];
}

export interface MobileSessionRow {
  key: string;
  kind: "catalog" | "native";
  providerId: string;
  accountId: string;
  sessionId: string | null;
  providerSessionId: string | null;
  title: string;
  projectName: string | null;
  lastActivityAt: string;
  pinned: boolean;
  archived: boolean;
  state: string;
  runtimeStatus: string | null;
  pendingApprovalCount: number;
  canControl: boolean;
  canResume: boolean;
  bindingStatus: string;
  catalog: SessionSummaryV2 | null;
  native: ProviderNativeSession | null;
}

export type SessionPeriod = "Pinned" | "Today" | "Yesterday" | "This week" | "Older";

export interface SessionPeriodGroup {
  period: SessionPeriod;
  sessions: MobileSessionRow[];
}

export interface AccountStatus {
  label: string;
  state:
    | "ready"
    | "inventory_only"
    | "authentication_required"
    | "stale"
    | "unavailable";
  canControl: boolean;
  active: boolean;
  reason: string | null;
}

export function accountEvidenceIsCurrent(
  evidence: ProviderAccountCapabilitySnapshot | null,
  now = Date.now(),
): boolean {
  if (evidence === null || evidence.freshness !== "live") return false;
  const staleAt = Date.parse(evidence.staleAt);
  return Number.isFinite(staleAt) && staleAt > now;
}

export function providerAccountKey(providerId: string, accountId: string): AccountKey {
  return `${providerId}\u0000${accountId}`;
}

export function accountScopedCatalogFilters(
  providerId: string,
  accountId: string,
  search: string,
): SessionCatalogFilter {
  return {
    search: search.trim() === "" ? null : search.trim(),
    providerIds: [providerId],
    accountIds: [accountId],
    states: [],
    project: null,
    archived: "exclude",
    pinned: null,
  };
}

export function groupAccountsByProvider(
  fleet: ProviderFleetSnapshot | null,
): ProviderAccountGroup[] {
  if (fleet === null) return [];
  return fleet.providers
    .filter((provider) => provider.enabled || provider.accounts.length > 0)
    .map((provider) => ({ provider, accounts: provider.accounts }))
    .sort((left, right) => left.provider.displayName.localeCompare(right.provider.displayName));
}

function catalogRow(session: SessionSummaryV2): MobileSessionRow | null {
  if (session.accountId === null) return null;
  return {
    key: `${providerAccountKey(session.providerId, session.accountId)}:catalog:${session.sessionId}`,
    kind: "catalog",
    providerId: session.providerId,
    accountId: session.accountId,
    sessionId: session.sessionId,
    providerSessionId: session.providerSessionId,
    title: session.title,
    projectName: session.projectName,
    lastActivityAt: session.lastActivityAt,
    pinned: session.pinned,
    archived: session.archived,
    state: session.state,
    runtimeStatus: session.runtimeStatus,
    pendingApprovalCount: session.pendingApprovalCount,
    canControl: session.canControl,
    canResume: session.canResume,
    bindingStatus: session.providerBindingStatus,
    catalog: session,
    native: null,
  };
}

function nativeRow(session: ProviderNativeSession): MobileSessionRow {
  return {
    key: `${providerAccountKey(session.providerId, session.accountId)}:native:${session.providerSessionId}`,
    kind: "native",
    providerId: session.providerId,
    accountId: session.accountId,
    sessionId: null,
    providerSessionId: session.providerSessionId,
    title: session.title,
    projectName: session.projectName,
    lastActivityAt: session.updatedAt,
    pinned: session.pinned,
    archived: session.archived,
    state: session.providerStatus,
    runtimeStatus: null,
    pendingApprovalCount: 0,
    canControl: false,
    canResume: session.canResume,
    bindingStatus: "native",
    catalog: null,
    native: session,
  };
}

/**
 * Merge only inside one exact provider/account boundary. A managed Catalog row
 * wins over its discovered native counterpart; equal provider Session IDs in
 * another account remain independent.
 */
export function sessionsForProviderAccount(
  catalog: readonly SessionSummaryV2[],
  native: readonly ProviderNativeSession[],
  providerId: string | null,
  accountId: string | null,
): MobileSessionRow[] {
  if (providerId === null || accountId === null) return [];
  const pair = providerAccountKey(providerId, accountId);
  const byNativeId = new Map<string, MobileSessionRow>();
  const managedOnly: MobileSessionRow[] = [];

  for (const session of catalog) {
    if (
      session.providerId !== providerId ||
      session.accountId !== accountId
    ) {
      continue;
    }
    const row = catalogRow(session);
    if (row === null) continue;
    if (session.providerSessionId === null) managedOnly.push(row);
    else byNativeId.set(`${pair}\u0000${session.providerSessionId}`, row);
  }

  for (const session of native) {
    if (session.providerId !== providerId || session.accountId !== accountId) continue;
    const key = `${pair}\u0000${session.providerSessionId}`;
    if (!byNativeId.has(key)) byNativeId.set(key, nativeRow(session));
  }

  return [...managedOnly, ...byNativeId.values()].sort((left, right) => {
    const time = Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt);
    return time !== 0 ? time : left.key.localeCompare(right.key);
  });
}

function startOfLocalDay(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

export function recentSessionsByPeriod(
  sessions: readonly MobileSessionRow[],
  now = new Date(),
): SessionPeriodGroup[] {
  const start = startOfLocalDay(now);
  const ordered: SessionPeriod[] = ["Pinned", "Today", "Yesterday", "This week", "Older"];
  const groups = new Map<SessionPeriod, MobileSessionRow[]>(ordered.map((period) => [period, []]));

  for (const session of sessions) {
    let period: SessionPeriod;
    if (session.pinned) period = "Pinned";
    else {
      const activityDay = startOfLocalDay(new Date(session.lastActivityAt));
      const daysAgo = Math.floor((start - activityDay) / 86_400_000);
      period = daysAgo <= 0 ? "Today" : daysAgo === 1 ? "Yesterday" : daysAgo <= 7 ? "This week" : "Older";
    }
    groups.get(period)?.push(session);
  }

  return ordered.flatMap((period) => {
    const rows = groups.get(period) ?? [];
    return rows.length === 0 ? [] : [{ period, sessions: rows }];
  });
}

export function currentAccountStatus(
  providerId: string | null,
  account: ProviderAccount | null,
  evidence: ProviderAccountCapabilitySnapshot | null,
  now = Date.now(),
): AccountStatus {
  if (
    providerId === null ||
    account === null ||
    evidence === null ||
    evidence.providerId !== providerId ||
    evidence.accountId !== account.accountId
  ) {
    return {
      label: "Account unavailable",
      state: "unavailable",
      canControl: false,
      active: false,
      reason: "Authoritative provider/account inventory is unavailable",
    };
  }
  if (!accountEvidenceIsCurrent(evidence, now)) {
    const expired = evidence.freshness === "live";
    return {
      label: expired ? "Evidence expired" : `Evidence ${evidence.freshness}`,
      state: "stale",
      canControl: false,
      active: evidence.active,
      reason: expired
        ? "Account capability evidence has expired"
        : `Account evidence is ${evidence.freshness}`,
    };
  }
  if (evidence.authentication !== "authenticated") {
    return {
      label: "Authentication required",
      state: "authentication_required",
      canControl: false,
      active: evidence.active,
      reason: `Account authentication is ${evidence.authentication}`,
    };
  }
  if (!evidence.active || evidence.control !== "remote_control") {
    return {
      label: evidence.active ? "Inventory only" : "Ready to activate",
      state: "inventory_only",
      canControl: false,
      active: evidence.active,
      reason: evidence.active
        ? "Remote control is unavailable for this account"
        : "This account is not the active provider Runtime",
    };
  }
  return { label: "Ready", state: "ready", canControl: true, active: true, reason: null };
}

export function currentSessionAuthority(input: {
  session: SessionSummaryV2 | null;
  capabilities: SessionCapabilitiesSnapshot | null;
  settings: SessionSettingsSnapshot | null;
  accountStatus: AccountStatus;
}): { canControl: boolean; reason: string | null } {
  if (!input.accountStatus.canControl) {
    return { canControl: false, reason: input.accountStatus.reason };
  }
  if (input.session === null || input.capabilities === null || input.settings === null) {
    return { canControl: false, reason: "Session authority is incomplete" };
  }
  if (
    input.session.providerId !== input.settings.settings.providerId ||
    input.session.accountId !== input.settings.settings.accountId ||
    input.capabilities.provider.providerId !== input.session.providerId ||
    input.capabilities.account.accountId !== input.session.accountId
  ) {
    return { canControl: false, reason: "Session authority belongs to another account" };
  }
  if (input.capabilities.settingsRevision !== input.settings.revision) {
    return { canControl: false, reason: "Session capability revision is stale" };
  }
  if (!input.session.canControl || !input.capabilities.controlAuthority.canControl) {
    return {
      canControl: false,
      reason: input.capabilities.controlAuthority.reason ?? "Session is view only",
    };
  }
  return { canControl: true, reason: null };
}

export function supportedModelsForAccount(
  evidence: ProviderAccountCapabilitySnapshot | null,
  providerId: string | null,
  accountId: string | null,
  now = Date.now(),
): ProviderModel[] {
  if (
    evidence === null ||
    providerId === null ||
    accountId === null ||
    evidence.providerId !== providerId ||
    evidence.accountId !== accountId ||
    evidence.modelsState !== "available" ||
    !accountEvidenceIsCurrent(evidence, now)
  ) {
    return [];
  }
  return evidence.models.filter((model) => !model.hidden);
}

export function supportedReasoningForModel(
  models: readonly ProviderModel[],
  modelId: string | null,
) {
  if (modelId === null) return [];
  return models.find((model) => model.modelId === modelId)?.reasoningEfforts ?? [];
}
