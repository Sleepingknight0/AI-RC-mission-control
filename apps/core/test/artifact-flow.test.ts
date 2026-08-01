import { createHash } from "node:crypto";

import { startConnector } from "@aicl/connector";
import type {
  ConnectorEmit,
  ConnectorProvider,
  TurnStartCommand,
} from "@aicl/connector/provider";
import {
  ConnectorEnvelopeSchema,
  MAX_INLINE_DIFF_BYTES,
  MAX_INLINE_ENVELOPE_BYTES,
  MAX_WEBSOCKET_MESSAGE_BYTES,
  ServerEnvelopeSchema,
  makeEnvelope,
  utf8ByteLength,
  type ServerEnvelope,
} from "@aicl/protocol";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { startCoreServer } from "../src/server.js";

interface BrowserHarness {
  socket: WebSocket;
  messages: ServerEnvelope[];
}

const handles: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(handles.splice(0).reverse().map((handle) => handle.close()));
});

describe("artifact-backed diff flow", () => {
  it("keeps small diffs inline and serves large diffs with auth, hash, and ranges", async () => {
    const artifactAccessToken = "artifact-test-token";
    const core = await startCoreServer({
      port: 0,
      dbPath: ":memory:",
      artifactAccessToken,
    });
    handles.push(core);
    const provider = new DiffProvider();
    const connector = startConnector({
      coreUrl: core.connectorUrl,
      provider,
      providerName: "diff-test",
      journalPath: ":memory:",
    });
    handles.push(connector);
    await connector.ready;
    const browser = await openBrowser(core.browserUrl, "diff-session");

    submit(browser, "small-diff", "small");
    const small = await waitForFileChange(browser, 0);
    expect(small.payload.fileChange.diff?.kind).toBe("inline");
    if (small.payload.fileChange.diff?.kind === "inline") {
      expect(small.payload.fileChange.diff.byteLength).toBeLessThanOrEqual(
        MAX_INLINE_DIFF_BYTES,
      );
    }
    await waitUntil(
      () => browser.messages.filter((message) => message.type === "turn.completed").length === 1,
    );

    submit(browser, "escaped-diff", "escaped");
    const escaped = await waitForFileChange(browser, 1, 10_000);
    expect(escaped.payload.fileChange.diff?.kind).toBe("artifact");
    expect(utf8ByteLength(JSON.stringify(escaped))).toBeLessThanOrEqual(
      MAX_INLINE_ENVELOPE_BYTES,
    );
    await waitUntil(
      () => browser.messages.filter((message) => message.type === "turn.completed").length === 2,
    );

    submit(browser, "large-diff", "large");
    const large = await waitForFileChange(browser, 2, 10_000);
    expect(large.payload.fileChange.diff?.kind).toBe("artifact");
    expect(utf8ByteLength(JSON.stringify(large))).toBeLessThan(
      MAX_WEBSOCKET_MESSAGE_BYTES,
    );
    if (large.payload.fileChange.diff?.kind !== "artifact") {
      throw new Error("Expected artifact-backed diff");
    }
    const reference = large.payload.fileChange.diff.artifact;
    const baseUrl = `http://${core.host}:${core.port}`;

    const unauthorized = await fetch(`${baseUrl}${reference.downloadPath}`);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${baseUrl}${reference.downloadPath}`, {
      headers: { authorization: `Bearer ${artifactAccessToken}` },
    });
    expect(authorized.status).toBe(200);
    const content = Buffer.from(await authorized.arrayBuffer());
    expect(content.byteLength).toBe(reference.byteLength);
    expect(createHash("sha256").update(content).digest("hex")).toBe(
      reference.sha256,
    );

    const ranged = await fetch(`${baseUrl}${reference.downloadPath}`, {
      headers: {
        authorization: `Bearer ${artifactAccessToken}`,
        range: "bytes=0-31",
      },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe(
      `bytes 0-31/${reference.byteLength}`,
    );
    expect((await ranged.arrayBuffer()).byteLength).toBe(32);

    const traversal = await fetch(
      `${baseUrl}/artifacts/%2e%2e/not-an-artifact`,
      { headers: { authorization: `Bearer ${artifactAccessToken}` } },
    );
    expect(traversal.status).toBe(404);
    expect(reference.downloadPath).not.toMatch(/[\\:]|\.\./);
    browser.socket.close();
  });
});

class DiffProvider implements ConnectorProvider {
  onLost() {
    return () => undefined;
  }

  async startTurn(command: TurnStartCommand, emit: ConnectorEmit) {
    emitNormalized(
      emit,
      makeEnvelope("connector.session.bound", {
        sessionId: command.payload.sessionId,
        providerSessionId: `provider-${command.payload.sessionId}`,
      }),
    );
    emitNormalized(
      emit,
      makeEnvelope("connector.turn.bound", {
        sessionId: command.payload.sessionId,
        turnId: command.payload.turnId,
        providerTurnId: `provider-${command.payload.turnId}`,
      }),
    );
    const large = command.payload.prompt === "large";
    const escaped = command.payload.prompt === "escaped";
    const diff = large
      ? `--- a/large.txt\n+++ b/large.txt\n${"+large diff line\n".repeat(40_000)}`
      : escaped
        ? `--- a/escaped.txt\n+++ b/escaped.txt\n+${"\\".repeat(400_000)}\n`
        : "--- a/small.txt\n+++ b/small.txt\n@@ -0,0 +1 @@\n+small\n";
    const fileChangeId = `file-change-${command.payload.turnId}`;
    const files = [
      {
        path: large ? "large.txt" : escaped ? "escaped.txt" : "small.txt",
        kind: "add" as const,
      },
    ];
    emitNormalized(
      emit,
      makeEnvelope("connector.file.change.started", {
        sessionId: command.payload.sessionId,
        fileChange: {
          fileChangeId,
          turnId: command.payload.turnId,
          status: "running",
          revision: 0,
          files,
          additions: 0,
          deletions: 0,
          diff: null,
        },
      }),
    );
    emitNormalized(
      emit,
      makeEnvelope("connector.file.change.completed", {
        sessionId: command.payload.sessionId,
        fileChange: {
          fileChangeId,
          turnId: command.payload.turnId,
          status: "completed",
          revision: 1,
          files,
          additions: large ? 40_000 : 1,
          deletions: 0,
          inlineDiff: diff,
          artifact: null,
        },
      }),
    );
    emitNormalized(
      emit,
      makeEnvelope("connector.turn.completed", {
        sessionId: command.payload.sessionId,
        turnId: command.payload.turnId,
      }),
    );
  }

  async interrupt() {}

  async resolveApproval() {}

  async close() {}
}

function submit(browser: BrowserHarness, commandId: string, prompt: string) {
  browser.socket.send(
    JSON.stringify(
      makeEnvelope("turn.submit", {
        commandId,
        sessionId: "diff-session",
        prompt,
      }),
    ),
  );
}

async function openBrowser(url: string, sessionId: string): Promise<BrowserHarness> {
  const socket = new WebSocket(url);
  const messages: ServerEnvelope[] = [];
  socket.on("message", (data) => {
    messages.push(ServerEnvelopeSchema.parse(JSON.parse(data.toString())));
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const browser = { socket, messages };
  socket.send(
    JSON.stringify(makeEnvelope("session.subscribe", { sessionId, afterSeq: 0 })),
  );
  await waitUntil(() =>
    messages.some((message) => message.type === "session.snapshot"),
  );
  return browser;
}

async function waitForFileChange(
  browser: BrowserHarness,
  index: number,
  timeoutMs = 5_000,
) {
  await waitUntil(
    () =>
      browser.messages.filter((message) => message.type === "file.change.completed")
        .length > index,
    timeoutMs,
  );
  return browser.messages.filter(
    (
      message,
    ): message is Extract<ServerEnvelope, { type: "file.change.completed" }> =>
      message.type === "file.change.completed",
  )[index]!;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

function emitNormalized(emit: ConnectorEmit, value: unknown) {
  emit(ConnectorEnvelopeSchema.parse(value));
}
