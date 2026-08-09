import { describe, expect, it } from "vitest";

import {
  remoteSessionRefFromSearch,
  remoteSessionSelectionPlan,
  setRemoteSessionRefInUrl,
} from "../src/mobile/remote-session.js";

describe("M10.3 Remote Session identity", () => {
  const bound = {
    providerId: "codex",
    accountId: "not-bluewhalex",
    providerSessionId: "019fe3af-c0d6-7340-b25a-9d11a45022a2",
    aiclSessionId: "import-019fe3af-c0d6-7340-b25a-9d11a45022a2",
  } as const;

  it("restores the exact bound Catalog/native identity from a deep link", () => {
    const url = new URL("https://mission-control.invalid/");
    setRemoteSessionRefInUrl(url, bound);

    expect(url.searchParams.get("provider")).toBe("codex");
    expect(url.searchParams.get("account")).toBe("not-bluewhalex");
    expect(url.searchParams.get("session")).toBe(bound.aiclSessionId);
    expect(url.searchParams.get("nativeSession")).toBe(
      bound.providerSessionId,
    );
    expect(remoteSessionRefFromSearch(url.search)).toEqual(bound);
  });

  it("subscribes to AICL state and reads native history for one bound screen", () => {
    expect(remoteSessionSelectionPlan(bound)).toEqual({
      aiclSessionId: bound.aiclSessionId,
      nativeProjection: {
        providerId: "codex",
        accountId: "not-bluewhalex",
        providerSessionId: bound.providerSessionId,
      },
    });
  });

  it("keeps AICL-only and provider-only Sessions truthful", () => {
    expect(
      remoteSessionSelectionPlan({
        ...bound,
        providerSessionId: null,
      }),
    ).toEqual({
      aiclSessionId: bound.aiclSessionId,
      nativeProjection: null,
    });
    expect(
      remoteSessionSelectionPlan({
        ...bound,
        aiclSessionId: null,
      }),
    ).toEqual({
      aiclSessionId: null,
      nativeProjection: {
        providerId: "codex",
        accountId: "not-bluewhalex",
        providerSessionId: bound.providerSessionId,
      },
    });
  });

  it("rejects partial or cross-account-ambiguous deep links", () => {
    expect(
      remoteSessionRefFromSearch(
        "?provider=codex&session=import-thread&nativeSession=thread",
      ),
    ).toBeNull();
    expect(
      remoteSessionRefFromSearch(
        "?provider=codex&account=other&session=&nativeSession=thread%0Aunsafe",
      ),
    ).toBeNull();
  });
});
