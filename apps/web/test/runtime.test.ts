import { afterEach, describe, expect, it, vi } from "vitest";

import {
  requestBrowserRuntimeConfig,
  resolveCoreWebSocketUrl,
} from "../src/runtime.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Core WebSocket URL", () => {
  it("derives ws/wss from the page origin", () => {
    expect(
      resolveCoreWebSocketUrl(undefined, {
        protocol: "http:",
        host: "127.0.0.1:8787",
      }),
    ).toBe("ws://127.0.0.1:8787/ws");
    expect(
      resolveCoreWebSocketUrl(undefined, {
        protocol: "https:",
        host: "mission.tailnet.ts.net",
      }),
    ).toBe("wss://mission.tailnet.ts.net/ws");
  });

  it("preserves an explicit development/test override", () => {
    expect(
      resolveCoreWebSocketUrl("ws://127.0.0.1:8787/ws", {
        protocol: "http:",
        host: "127.0.0.1:5173",
      }),
    ).toBe("ws://127.0.0.1:8787/ws");
  });

  it("requests and validates a fresh runtime ticket without caching", async () => {
    const runtimeConfig = {
      webSocketPath: "/ws" as const,
      ticket: "runtime-ticket-1234567890",
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(runtimeConfig), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      requestBrowserRuntimeConfig("http://127.0.0.1:8787"),
    ).resolves.toEqual(runtimeConfig);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:8787/runtime-config"),
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        referrerPolicy: "no-referrer",
      }),
    );
  });

  it("rejects malformed or already-expired runtime tickets", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ticket: "missing-fields" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            webSocketPath: "/ws",
            ticket: "runtime-ticket-1234567890",
            expiresAt: new Date(Date.now() - 1_000).toISOString(),
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      requestBrowserRuntimeConfig("http://127.0.0.1:8787"),
    ).rejects.toThrow("invalid runtime authentication response");
    await expect(
      requestBrowserRuntimeConfig("http://127.0.0.1:8787"),
    ).rejects.toThrow("expired runtime authentication ticket");
  });
});
