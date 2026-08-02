import {
  BrowserRuntimeConfigSchema,
  type BrowserRuntimeConfig,
} from "@aicl/protocol";

export interface BrowserLocation {
  protocol: string;
  host: string;
}

export async function requestBrowserRuntimeConfig(
  coreHttpOrigin: string,
  signal?: AbortSignal,
): Promise<BrowserRuntimeConfig> {
  const response = await fetch(new URL("/runtime-config", `${coreHttpOrigin}/`), {
    method: "POST",
    headers: { accept: "application/json" },
    cache: "no-store",
    credentials: "same-origin",
    referrerPolicy: "no-referrer",
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    throw new Error(`Runtime authentication failed with status ${response.status}`);
  }
  const parsed = BrowserRuntimeConfigSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Core returned an invalid runtime authentication response");
  }
  if (Date.parse(parsed.data.expiresAt) <= Date.now()) {
    throw new Error("Core returned an expired runtime authentication ticket");
  }
  return parsed.data;
}

export function resolveCoreWebSocketUrl(
  override: string | undefined,
  location: BrowserLocation,
): string {
  if (override !== undefined && override.length > 0) return override;
  const webSocketProtocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${webSocketProtocol}//${location.host}/ws`;
}
