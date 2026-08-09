import {
  RemoteSessionRefSchema,
  type RemoteSessionRef,
} from "@aicl/protocol";

import type { NativeProjectionSelection } from "./native-projection.js";

export interface RemoteSessionSelectionPlan {
  aiclSessionId: string | null;
  nativeProjection: NativeProjectionSelection | null;
}

/**
 * Resolve the two independent read paths represented by one Mobile screen.
 * Mutation authority is intentionally absent: observation never derives from
 * or promotes `canControl`.
 */
export function remoteSessionSelectionPlan(
  reference: RemoteSessionRef,
): RemoteSessionSelectionPlan {
  return {
    aiclSessionId: reference.aiclSessionId,
    nativeProjection:
      reference.providerSessionId === null
        ? null
        : {
            providerId: reference.providerId,
            accountId: reference.accountId,
            providerSessionId: reference.providerSessionId,
          },
  };
}

export function remoteSessionRefFromSearch(
  search: string,
): RemoteSessionRef | null {
  const params = new URLSearchParams(search);
  const providerId = params.get("provider");
  const accountId = params.get("account");
  if (providerId === null || accountId === null) return null;
  const providerSessionId = nonEmpty(params.get("nativeSession"));
  const aiclSessionId = nonEmpty(params.get("session"));
  const parsed = RemoteSessionRefSchema.safeParse({
    providerId,
    accountId,
    providerSessionId,
    aiclSessionId,
  });
  return parsed.success ? parsed.data : null;
}

export function setRemoteSessionRefInUrl(
  url: URL,
  reference: RemoteSessionRef,
): void {
  const parsed = RemoteSessionRefSchema.parse(reference);
  url.searchParams.set("provider", parsed.providerId);
  url.searchParams.set("account", parsed.accountId);
  setNullable(url.searchParams, "session", parsed.aiclSessionId);
  setNullable(
    url.searchParams,
    "nativeSession",
    parsed.providerSessionId,
  );
}

function nonEmpty(value: string | null): string | null {
  return value === null || value.length === 0 ? null : value;
}

function setNullable(
  params: URLSearchParams,
  key: string,
  value: string | null,
): void {
  if (value === null) params.delete(key);
  else params.set(key, value);
}
