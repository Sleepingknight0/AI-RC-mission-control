import { createHash } from "node:crypto";

import { startConnector } from "@aicl/connector";
import { MockProvider } from "@aicl/connector/mock-provider";
import type {
  ConnectorEmit,
  PreparedInputAttachment,
  TurnStartCommand,
} from "@aicl/connector/provider";
import {
  ServerEnvelopeSchema,
  makeEnvelope,
  websocketCapability,
  type ProviderFleetSnapshot,
  type ServerEnvelope,
} from "@aicl/protocol";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { startCoreServer } from "../src/server.js";

const handles: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(handles.splice(0).reverse().map((handle) => handle.close()));
});

describe("managed attachment WebSocket flow", () => {
  it("uploads, transfers, binds, and never auto-submits across reconnect", async () => {
    const core = await startCoreServer({ port: 0, dbPath: ":memory:" });
    handles.push(core);
    const provider = new CapturingProvider();
    const connector = startConnector({
      coreUrl: core.connectorUrl,
      connectorToken: core.connectorToken,
      provider,
      providerName: "codex",
      providerInventory: (revision) => fleet(revision),
    });
    handles.push(connector);
    await connector.ready;
    const browser = await openBrowser(core.browserUrl, core.browserToken);
    await waitFor(browser, "providers.snapshot");
    browser.socket.send(
      JSON.stringify(
        makeEnvelope("session.create", {
          commandId: "create-attachment-session",
          sessionId: "attachment-session",
          deviceId: "device-1",
          title: "Attachment Session",
          providerId: "codex",
          accountId: "default",
          projectPath: process.cwd(),
          model: "test-model",
          reasoningLevel: null,
        }),
      ),
    );
    await waitFor(browser, "session.provider.status");
    browser.socket.send(
      JSON.stringify(
        makeEnvelope("session.subscribe", { sessionId: "attachment-session", afterSeq: 0 }),
      ),
    );
    await waitFor(browser, "session.snapshot");

    const text = Buffer.from("managed text", "utf8");
    const textId = await upload(browser, "text-upload", "notes.txt", "text", "text/plain", text);
    const image = Buffer.from("89504e470d0a1a0a00000000", "hex");
    const imageId = await upload(
      browser,
      "image-upload",
      "diagram.png",
      "image",
      "image/png",
      image,
    );

    browser.socket.send(
      JSON.stringify(
        makeEnvelope("turn.submit", {
          commandId: "attachment-turn-command",
          sessionId: "attachment-session",
          deviceId: "device-1",
          prompt: "Use both attachments",
          settingsRevision: 0,
          attachmentIds: [textId, imageId],
        }),
      ),
    );
    await waitFor(browser, "turn.completed");
    expect(provider.attachments).toEqual([
      expect.objectContaining({ attachmentId: textId, kind: "text", text: "managed text" }),
      expect.objectContaining({ attachmentId: imageId, kind: "image" }),
    ]);

    browser.socket.close();
    const reconnected = await openBrowser(core.browserUrl, core.browserToken);
    reconnected.socket.send(
      JSON.stringify(
        makeEnvelope("attachments.list", {
          sessionId: "attachment-session",
          deviceId: "device-1",
        }),
      ),
    );
    const snapshot = await waitFor(reconnected, "attachments.snapshot");
    expect(snapshot.payload.attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attachmentId: textId, status: "referenced" }),
        expect.objectContaining({ attachmentId: imageId, status: "referenced" }),
      ]),
    );
    expect(provider.turns).toBe(1);
    reconnected.socket.close();
  });
});

class CapturingProvider extends MockProvider {
  attachments: readonly PreparedInputAttachment[] = [];
  turns = 0;

  override async startTurn(
    command: TurnStartCommand,
    emit: ConnectorEmit,
    attachments: readonly PreparedInputAttachment[] = [],
  ) {
    this.attachments = attachments;
    this.turns += 1;
    return super.startTurn(command, emit);
  }
}

async function upload(
  browser: BrowserHarness,
  prefix: string,
  name: string,
  kind: "text" | "image",
  mediaType: "text/plain" | "image/png",
  content: Buffer,
) {
  browser.socket.send(
    JSON.stringify(
      makeEnvelope("attachment.upload.begin", {
        commandId: `${prefix}-begin`,
        sessionId: "attachment-session",
        deviceId: "device-1",
        name,
        kind,
        mediaType,
        byteLength: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
        chunkCount: 1,
      }),
    ),
  );
  const accepted = await waitForCommand(browser, `${prefix}-begin`);
  if (accepted.type !== "attachment.command.accepted") throw new Error("upload rejected");
  const attachmentId = accepted.payload.attachment.attachmentId;
  browser.socket.send(
    JSON.stringify(
      makeEnvelope("attachment.upload.chunk", {
        sessionId: "attachment-session",
        deviceId: "device-1",
        attachmentId,
        chunkIndex: 0,
        contentBase64: content.toString("base64"),
      }),
    ),
  );
  await waitUntil(() =>
    browser.messages.some(
      (message) =>
        message.type === "attachment.upload.progress" &&
        message.payload.attachmentId === attachmentId,
    ),
  );
  browser.socket.send(
    JSON.stringify(
      makeEnvelope("attachment.upload.complete", {
        commandId: `${prefix}-complete`,
        sessionId: "attachment-session",
        deviceId: "device-1",
        attachmentId,
      }),
    ),
  );
  await waitForCommand(browser, `${prefix}-complete`);
  return attachmentId;
}

function fleet(revision: number): ProviderFleetSnapshot {
  const observedAt = new Date().toISOString();
  return {
    snapshotId: `fleet-${revision}`,
    revision,
    source: "terminal_registry",
    observedAt,
    staleAt: new Date(Date.now() + 60_000).toISOString(),
    freshness: "local",
    degraded: false,
    notice: null,
    providers: [
      {
        providerId: "codex",
        displayName: "Codex",
        enabled: true,
        installation: "installed",
        authentication: "authenticated",
        compatibility: "compatible",
        adapterSupport: "remote_control",
        version: "test",
        freshness: "local",
        observedAt,
        notice: null,
        capabilities: [
          "text_input",
          "image_input",
          "remote_control",
          "create_session",
          "execution_modes",
          "approval_policies",
          "sandbox_policies",
        ].map((key) => ({
          key: key as
            | "text_input"
            | "image_input"
            | "remote_control"
            | "create_session"
            | "execution_modes"
            | "approval_policies"
            | "sandbox_policies",
          state: "supported" as const,
          provenance: "provider_probe" as const,
          observedAt,
          reason: null,
        })),
        accounts: [
          {
            accountId: "default",
            displayName: "Default",
            isDefault: true,
            authentication: "authenticated",
            control: "remote_control",
            observedAt,
            notice: null,
          },
        ],
        accountCount: 1,
        models: [
          {
            modelId: "test-model",
            displayName: "Test model",
            description: "Test",
            hidden: false,
            isDefault: true,
            inputModalities: ["text", "image"],
            defaultReasoningEffort: null,
            reasoningEfforts: [],
          },
        ],
        modelsState: "available",
        usageState: "unavailable",
        usageMeters: [],
      },
    ],
  };
}

interface BrowserHarness {
  socket: WebSocket;
  messages: ServerEnvelope[];
}

async function openBrowser(url: string, token: string): Promise<BrowserHarness> {
  const socket = new WebSocket(url, websocketCapability("browser", token), {
    origin: "http://127.0.0.1:5173",
  });
  const messages: ServerEnvelope[] = [];
  socket.on("message", (data) =>
    messages.push(ServerEnvelopeSchema.parse(JSON.parse(data.toString()))),
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, messages };
}

async function waitFor<T extends ServerEnvelope["type"]>(
  harness: BrowserHarness,
  type: T,
): Promise<Extract<ServerEnvelope, { type: T }>> {
  await waitUntil(() => harness.messages.some((message) => message.type === type));
  return harness.messages.find(
    (message): message is Extract<ServerEnvelope, { type: T }> => message.type === type,
  )!;
}

async function waitForCommand(harness: BrowserHarness, commandId: string) {
  await waitUntil(() =>
    harness.messages.some(
      (message) =>
        (message.type === "attachment.command.accepted" ||
          message.type === "command.rejected") &&
        message.payload.commandId === commandId,
    ),
  );
  return harness.messages.find(
    (message) =>
      (message.type === "attachment.command.accepted" ||
        message.type === "command.rejected") &&
      message.payload.commandId === commandId,
  )!;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for message");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
