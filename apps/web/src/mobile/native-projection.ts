import type {
  ProviderSessionProjectionSnapshot,
  ProviderSessionProjectionState,
  ServerEnvelope,
} from "@aicl/protocol";

export interface NativeProjectionSelection {
  providerId: string;
  accountId: string;
  providerSessionId: string;
}

export interface NativeProjectionUiState {
  status: "idle" | "loading" | "ready" | "unavailable";
  requestId: string | null;
  selection: NativeProjectionSelection | null;
  snapshot: ProviderSessionProjectionSnapshot | null;
  notice: string | null;
}

export interface NativeProjectionHeaderStatus {
  label: string;
  activityLabel: string;
  tone: "ready" | "working" | "warning" | "offline";
}

const PROVIDER_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u;

export function nativeProjectionSelectionFromStoredIds(input: {
  providerId: string | null;
  accountId: string | null;
  providerSessionId: string | null;
}): NativeProjectionSelection | null {
  const { providerId, accountId, providerSessionId } = input;
  if (
    providerId === null ||
    accountId === null ||
    providerSessionId === null ||
    !PROVIDER_SLUG_PATTERN.test(providerId) ||
    !PROVIDER_SLUG_PATTERN.test(accountId) ||
    providerSessionId.length === 0 ||
    providerSessionId.length > 200 ||
    hasControlCharacter(providerSessionId)
  ) {
    return null;
  }
  return { providerId, accountId, providerSessionId };
}

function hasControlCharacter(value: string) {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

export function initialNativeProjectionState(): NativeProjectionUiState {
  return {
    status: "idle",
    requestId: null,
    selection: null,
    snapshot: null,
    notice: null,
  };
}

export function nativeProjectionRequestStarted(
  current: NativeProjectionUiState,
  requestId: string,
  selection: NativeProjectionSelection,
): NativeProjectionUiState {
  const sameSelection = matchesSelection(current.selection, selection);
  return {
    status: "loading",
    requestId,
    selection,
    snapshot: sameSelection ? current.snapshot : null,
    notice: null,
  };
}

export function reduceNativeProjection(
  current: NativeProjectionUiState,
  message: ServerEnvelope,
  selected: NativeProjectionSelection | null,
  now = Date.now(),
): NativeProjectionUiState {
  if (
    message.type !== "provider.session.projection.snapshot" ||
    selected === null ||
    current.requestId !== message.payload.requestId ||
    !matchesSelection(current.selection, selected) ||
    !matchesSelection(message.payload.snapshot, selected)
  ) {
    return current;
  }
  const snapshot = message.payload.snapshot;
  if (
    snapshot.availability !== "available" ||
    snapshot.freshness !== "live" ||
    !Number.isFinite(Date.parse(snapshot.staleAt)) ||
    Date.parse(snapshot.staleAt) <= now
  ) {
    return {
      status: "unavailable",
      requestId: null,
      selection: selected,
      snapshot: null,
      notice: snapshot.notice ?? "Provider history unavailable",
    };
  }
  return {
    status: "ready",
    requestId: null,
    selection: selected,
    snapshot,
    notice: snapshot.notice,
  };
}

export function nativeProjectionHeaderStatus(
  snapshot: ProviderSessionProjectionSnapshot | null,
  now = Date.now(),
): NativeProjectionHeaderStatus {
  if (
    snapshot === null ||
    snapshot.availability !== "available" ||
    snapshot.freshness !== "live" ||
    Date.parse(snapshot.staleAt) <= now
  ) {
    return {
      label: "Remote activity unavailable",
      activityLabel: "Unavailable",
      tone: "offline",
    };
  }
  const activeLabel = activeStateLabel(snapshot.state);
  if (activeLabel !== null) {
    return {
      label: `LIVE · ${activeLabel}`,
      activityLabel:
        snapshot.activeSince === null
          ? activeLabel
          : elapsedLabel(snapshot.activeSince, now),
      tone:
        snapshot.state === "waiting_for_approval" ||
        snapshot.state === "waiting_for_input"
          ? "warning"
          : "working",
    };
  }
  if (snapshot.state === "idle") {
    return {
      label: "Connected · Idle",
      activityLabel: "Idle",
      tone: "ready",
    };
  }
  return {
    label: "View only",
    activityLabel:
      snapshot.state === "completed"
        ? "Completed"
        : snapshot.state === "failed"
          ? "Failed"
          : snapshot.state === "interrupted"
            ? "Interrupted"
            : "Provider history",
    tone:
      snapshot.state === "failed" || snapshot.state === "interrupted"
        ? "warning"
        : "ready",
  };
}

export function nativeProjectionIsActive(
  state: ProviderSessionProjectionState | undefined,
) {
  return state !== undefined && activeStateLabel(state) !== null;
}

export function nativeProjectionSignal(
  snapshot: ProviderSessionProjectionSnapshot | null,
) {
  if (snapshot === null) return "native:none";
  return `native:${snapshot.providerId}:${snapshot.accountId}:${snapshot.providerSessionId}:${snapshot.state}:${snapshot.items
    .map((item) => `${item.providerItemId}:${projectionItemDigest(item)}`)
    .join(",")}`;
}

function projectionItemDigest(item: ProviderSessionProjectionSnapshot["items"][number]) {
  const serialized = JSON.stringify(item);
  let hash = 2_166_136_261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${serialized.length}:${(hash >>> 0).toString(16)}`;
}

function activeStateLabel(state: ProviderSessionProjectionState): string | null {
  const labels: Partial<Record<ProviderSessionProjectionState, string>> = {
    thinking: "Thinking",
    working: "Running",
    running_command: "Running command",
    reading_file: "Reading file",
    searching: "Searching",
    editing: "Editing",
    running_tests: "Running tests",
    waiting_for_approval: "Waiting for approval",
    waiting_for_input: "Waiting for input",
  };
  return labels[state] ?? null;
}

function elapsedLabel(startedAt: string, now: number) {
  const elapsedSeconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1_000));
  const hours = Math.floor(elapsedSeconds / 3_600);
  const minutes = Math.floor((elapsedSeconds % 3_600) / 60);
  const seconds = elapsedSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function matchesSelection(
  value: NativeProjectionSelection | null,
  selected: NativeProjectionSelection,
) {
  return (
    value !== null &&
    value.providerId === selected.providerId &&
    value.accountId === selected.accountId &&
    value.providerSessionId === selected.providerSessionId
  );
}
