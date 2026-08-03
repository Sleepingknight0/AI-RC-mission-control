import { resolve, sep } from "node:path";

import {
  CoreToConnectorEnvelopeSchema,
  MAX_OUTPUT_BATCH_BYTES,
  makeEnvelope,
  utf8ByteLength,
  type ConnectorEnvelope,
} from "@aicl/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { CodexProvider } from "../src/codex/adapter.js";
import {
  ProviderLostError,
  type ApprovalResolveCommand,
  type TurnInterruptCommand,
  type TurnStartCommand,
} from "../src/provider.js";

const providers: CodexProvider[] = [];
const fakeCommand = resolve("test/fake-codex-app-server.mjs");

afterEach(async () => {
  await Promise.allSettled(providers.splice(0).map((provider) => provider.close()));
});

function provider(timeoutMs?: number) {
  const value = new CodexProvider({
    cwd: process.cwd(),
    command: fakeCommand,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  providers.push(value);
  return value;
}

function startCommand(
  prompt: string,
  providerSessionId: string | null = null,
  executionMode?: "ask" | "plan" | "auto",
  projectPath: string | null = process.cwd(),
): TurnStartCommand {
  return CoreToConnectorEnvelopeSchema.parse(
    makeEnvelope("connector.turn.start", {
      sessionId: "session-1",
      turnId: `turn-${prompt}`,
      commandId: `command-${prompt}`,
      prompt,
      providerSessionId,
      runtimeId: "runtime-1",
      runtimeGeneration: 1,
      ...(executionMode === undefined
        ? {}
        : {
            settingsRevision: 3,
            effectiveSettings: {
              providerId: "codex",
              accountId: "default",
              model: "fake-codex-model",
              reasoningLevel: "high",
              executionMode,
              approvalPolicy: "review",
              sandboxPolicy: "workspace_write",
              networkPolicy: "restricted",
              projectPath,
              branch: "main",
            },
          }),
    }),
  ) as TurnStartCommand;
}

describe("Codex adapter normalization", () => {
  it("starts a Turn on a Session prepared in the current provider process", async () => {
    const adapter = provider();
    const prepared = CoreToConnectorEnvelopeSchema.parse(
      makeEnvelope("connector.session.create", {
        commandId: "prepare-command",
        sessionId: "session-1",
        providerId: "codex",
        accountId: "default",
        projectPath: process.cwd(),
        model: null,
        reasoningLevel: null,
        runtimeId: "runtime-1",
        runtimeGeneration: 1,
      }),
    );
    if (prepared.type !== "connector.session.create") throw new Error("type");
    const identity = await adapter.prepareSession(prepared);
    const events: ConnectorEnvelope[] = [];

    await adapter.startTurn(
      startCommand("hello", identity.providerSessionId),
      (event) => events.push(event),
    );

    expect(events.at(-1)?.type).toBe("connector.turn.completed");
  });

  it("maps the verified event subset without raw-provider leakage", async () => {
    const adapter = provider();
    const events: ConnectorEnvelope[] = [];
    await adapter.startTurn(startCommand("hello"), (event) => events.push(event));

    expect(events.map((event) => event.type)).toEqual([
      "connector.session.bound",
      "connector.turn.bound",
      "connector.turn.delta",
      "connector.turn.message.completed",
      "connector.turn.completed",
    ]);
    expect(JSON.stringify(events)).not.toMatch(
      /item\/agentMessage\/delta|providerPayload|rawEvent/,
    );
  });

  it("resumes provider identity in the existing new process", async () => {
    const adapter = provider();
    const events: ConnectorEnvelope[] = [];
    await adapter.startTurn(startCommand("resume", "fake-thread"), (event) =>
      events.push(event),
    );
    const binding = events.find(
      (event) => event.type === "connector.session.bound",
    );
    expect(binding?.payload.providerSessionId).toBe("fake-thread");
  });

  it("translates verified text and local-image attachments into Codex inputs", async () => {
    const adapter = provider();
    const events: ConnectorEnvelope[] = [];
    await adapter.startTurn(
      startCommand("attachments"),
      (event) => events.push(event),
      [
        {
          attachmentId: "attachment-text",
          name: "notes.txt",
          kind: "text",
          mediaType: "text/plain",
          text: "bounded context",
        },
        {
          attachmentId: "attachment-image",
          name: "diagram.png",
          kind: "image",
          mediaType: "image/png",
          path: resolve("test/input.png"),
        },
      ],
    );

    expect(events.at(-1)?.type).toBe("connector.turn.completed");
  });

  it("revalidates and forwards the immutable model and reasoning snapshot", async () => {
    const adapter = provider();
    const events: ConnectorEnvelope[] = [];
    await adapter.startTurn(startCommand("report-settings", "fake-thread", "plan"),
      (event) => events.push(event));
    const completed = events.find(
      (event) => event.type === "connector.turn.message.completed",
    );

    expect(completed?.payload.content).toContain(
      "plan-first",
    );
    expect(completed?.payload.content).toContain("fake-codex-model|high");
    expect(completed?.payload.content).toContain(
      "on-request|workspaceWrite|false",
    );
  });

  it("fails a workspace-write request closed when no canonical project is bound", async () => {
    const events: ConnectorEnvelope[] = [];
    await provider().startTurn(
      startCommand("report-settings", "fake-thread", "ask", null),
      (event) => events.push(event),
    );
    const completed = events.find(
      (event) => event.type === "connector.turn.message.completed",
    );

    expect(completed?.payload.content).toContain("on-request|readOnly|false");
  });

  it("normalizes an interrupt terminal state", async () => {
    const adapter = provider();
    const events: ConnectorEnvelope[] = [];
    const running = adapter.startTurn(startCommand("wait"), (event) =>
      events.push(event),
    );
    await waitUntil(() =>
      events.some((event) => event.type === "connector.turn.bound"),
    );
    await adapter.interrupt(
      CoreToConnectorEnvelopeSchema.parse(
        makeEnvelope("connector.turn.interrupt", {
          sessionId: "session-1",
          turnId: "turn-wait",
          commandId: "interrupt-1",
          providerSessionId: "fake-thread",
          providerTurnId: "fake-turn-command-wait",
        }),
      ) as TurnInterruptCommand,
    );
    await running;
    expect(events.at(-1)?.type).toBe("connector.turn.interrupted");
  });

  it("maps provider death to outcome_unknown without replay", async () => {
    const adapter = provider();
    const events: ConnectorEnvelope[] = [];
    let lost = 0;
    adapter.onLost(() => {
      lost += 1;
    });
    await expect(
      adapter.startTurn(startCommand("crash"), (event) => events.push(event)),
    ).rejects.toBeInstanceOf(ProviderLostError);

    expect(lost).toBe(1);
    expect(events.filter((event) => event.type === "connector.turn.bound")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("connector.turn.outcome_unknown");
  });

  it("treats a side-effecting RPC timeout as provider loss", async () => {
    const adapter = provider(500);
    const events: ConnectorEnvelope[] = [];

    await expect(
      adapter.startTurn(startCommand("timeout-start"), (event) => events.push(event)),
    ).rejects.toBeInstanceOf(ProviderLostError);
    await waitUntil(() =>
      events.some((event) => event.type === "connector.turn.outcome_unknown"),
    );
    expect(events.some((event) => event.type === "connector.turn.failed")).toBe(false);
  });

  it("fails closed when completed provider output exceeds the normalized limit", async () => {
    const adapter = provider();
    const events: ConnectorEnvelope[] = [];

    await expect(
      adapter.startTurn(startCommand("oversized-message"), (event) =>
        events.push(event),
      ),
    ).rejects.toBeInstanceOf(ProviderLostError);
    expect(events.at(-1)?.type).toBe("connector.turn.outcome_unknown");
    expect(events.some((event) => event.type === "connector.turn.completed")).toBe(
      false,
    );
  });

  it("normalizes command output and file changes without provider identifiers", async () => {
    const adapter = provider();
    const events: ConnectorEnvelope[] = [];
    await adapter.startTurn(startCommand("activity"), (event) => events.push(event));

    expect(events.map((event) => event.type)).toEqual([
      "connector.session.bound",
      "connector.turn.bound",
      "connector.activity.started",
      "connector.command.output.batch",
      "connector.activity.completed",
      "connector.file.change.started",
      "connector.file.change.completed",
      "connector.turn.delta",
      "connector.turn.message.completed",
      "connector.turn.completed",
    ]);
    const output = events.find(
      (event) => event.type === "connector.command.output.batch",
    );
    expect(output?.type).toBe("connector.command.output.batch");
    if (output?.type === "connector.command.output.batch") {
      expect(output.payload.output).toBe("tests passed");
      expect(utf8ByteLength(output.payload.output)).toBeLessThanOrEqual(
        MAX_OUTPUT_BATCH_BYTES,
      );
    }
    const serialized = JSON.stringify(events);
    expect(serialized).not.toMatch(/provider-command-item|provider-file-item/);
    expect(serialized).not.toMatch(/item\/commandExecution|item\/fileChange/);
    const completed = events.find(
      (event) => event.type === "connector.activity.completed",
    );
    expect(completed?.type).toBe("connector.activity.completed");
    if (completed?.type === "connector.activity.completed") {
      expect(completed.payload.activity).toMatchObject({
        command: "pnpm test",
        cwd: null,
        cwdLabel: ".",
        stdoutPreview: "tests passed",
        stdoutTruncated: false,
        stderrPreview: "",
        stderrTruncated: false,
        stderrAvailable: false,
        outputArtifact: null,
        runtimeId: "runtime-1",
        runtimeGeneration: 1,
      });
      expect(completed.payload.activity.startedAt).toMatch(/^\d{4}-/u);
      expect(completed.payload.activity.completedAt).toMatch(/^\d{4}-/u);
      expect(completed.payload.activity.providerCorrelationId).toMatch(
        /^activity-correlation-/u,
      );
    }
  });

  it("emits large terminal evidence as a redacted authenticated artifact", async () => {
    const adapter = provider();
    const events: ConnectorEnvelope[] = [];

    await adapter.startTurn(startCommand("large-terminal-output"), (event) =>
      events.push(event),
    );

    const completed = events.find(
      (event) => event.type === "connector.activity.completed",
    );
    expect(completed?.type).toBe("connector.activity.completed");
    if (completed?.type !== "connector.activity.completed") return;
    const artifact = completed.payload.activity.outputArtifact;
    expect(artifact).not.toBeNull();
    expect(completed.payload.activity.stdoutTruncated).toBe(true);
    expect(completed.payload.activity.command).toBe("print bounded output");
    expect(completed.payload.activity.stdoutPreview?.length ?? 0).toBeLessThanOrEqual(
      32 * 1024,
    );
    expect(completed.payload.activity.cwd).toBeNull();
    expect(JSON.stringify(completed)).not.toMatch(/BlueWhaleX|TERMINAL_SECRET/u);
    if (artifact === null || artifact === undefined) return;
    const chunks = events
      .filter(
        (event) =>
          event.type === "connector.artifact.chunk" &&
          event.payload.artifactId === artifact.artifactId,
      )
      .sort((left, right) => {
        if (
          left.type !== "connector.artifact.chunk" ||
          right.type !== "connector.artifact.chunk"
        ) return 0;
        return left.payload.chunkIndex - right.payload.chunkIndex;
      });
    const content = Buffer.concat(
      chunks.map((event) => {
        if (event.type !== "connector.artifact.chunk") return Buffer.alloc(0);
        return Buffer.from(event.payload.contentBase64, "base64");
      }),
    ).toString("utf8");
    expect(content).not.toMatch(/BlueWhaleX|TERMINAL_SECRET/u);
    expect(content).toContain("[REDACTED]");
    expect(content).toContain("[REDACTED_PATH]");
    expect(Buffer.byteLength(content, "utf8")).toBe(artifact.byteLength);
  });

  it("reconciles a terminal command item when item/completed is omitted", async () => {
    const adapter = provider();
    const events: ConnectorEnvelope[] = [];

    await adapter.startTurn(
      startCommand("terminal-item-reconciliation"),
      (event) => events.push(event),
    );

    const completed = events.filter(
      (event) => event.type === "connector.activity.completed",
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]?.type).toBe("connector.activity.completed");
    if (completed[0]?.type === "connector.activity.completed") {
      expect(completed[0].payload.activity).toMatchObject({
        status: "completed",
        exitCode: 0,
        durationMs: 14,
        outputPreview: "terminal output",
      });
    }
    const fileChanges = events.filter(
      (event) => event.type === "connector.file.change.completed",
    );
    expect(fileChanges).toHaveLength(1);
    expect(fileChanges[0]?.type).toBe("connector.file.change.completed");
    if (fileChanges[0]?.type === "connector.file.change.completed") {
      expect(fileChanges[0].payload.fileChange).toMatchObject({
        status: "completed",
        additions: 1,
        deletions: 0,
      });
      expect(fileChanges[0].payload.fileChange.inlineDiff).toContain(
        "+AICL_DIFF_OK",
      );
    }
    expect(events.at(-1)?.type).toBe("connector.turn.completed");
  });

  it("keeps Auto mode behind the same opaque approval boundary", async () => {
    const adapter = provider();
    const events: ConnectorEnvelope[] = [];
    const running = adapter.startTurn(
      startCommand("approval", "fake-thread", "auto", `${process.cwd()}${sep}`),
      (event) => events.push(event),
    );
    await waitUntil(() =>
      events.some((event) => event.type === "connector.approval.requested"),
    );
    const requested = events.find(
      (event) => event.type === "connector.approval.requested",
    );
    expect(requested?.type).toBe("connector.approval.requested");
    if (requested?.type !== "connector.approval.requested") return;
    expect(JSON.stringify(requested)).not.toContain("raw-provider-request-id");
    expect(requested.payload.approval.payload.cwd).toBe(resolve(process.cwd()));
    await adapter.resolveApproval(
      CoreToConnectorEnvelopeSchema.parse(
        makeEnvelope("connector.approval.resolve", {
          commandId: "approval-command",
          sessionId: requested.payload.sessionId,
          turnId: requested.payload.approval.turnId,
          approvalId: requested.payload.approval.approvalId,
          providerCorrelationId: requested.payload.providerCorrelationId,
          runtimeId: "runtime-1",
          runtimeGeneration: 1,
          decision: "approved_once",
        }),
      ) as ApprovalResolveCommand,
    );
    await running;
    const completed = events.find(
      (event) => event.type === "connector.activity.completed",
    );
    expect(completed?.type).toBe("connector.activity.completed");
    if (completed?.type === "connector.activity.completed") {
      expect(completed.payload.activity.status).toBe("completed");
      expect(completed.payload.activity.outputPreview).toBe("decision:accept");
    }
  });

  it("settles an active Turn when the provider closes", async () => {
    const adapter = provider();
    const events: ConnectorEnvelope[] = [];
    const running = adapter.startTurn(startCommand("wait"), (event) =>
      events.push(event),
    );
    await waitUntil(() =>
      events.some((event) => event.type === "connector.turn.bound"),
    );

    const rejection = expect(running).rejects.toBeInstanceOf(ProviderLostError);
    await adapter.close();
    await rejection;
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for adapter event");
}
