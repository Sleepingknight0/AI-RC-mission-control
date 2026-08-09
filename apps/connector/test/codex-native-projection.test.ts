import { describe, expect, it, vi } from "vitest";

import {
  MAX_PROVIDER_SESSION_PROJECTION_BYTES,
  MAX_PROVIDER_SESSION_PROJECTION_ITEMS,
  MAX_PROVIDER_SESSION_PROJECTION_TEXT_BYTES,
  utf8ByteLength,
} from "@aicl/protocol";

import {
  readCodexNativeSessionProjection,
  reconcileCodexNativeObservation,
} from "../src/codex/native-projection.js";

const startedAt = 1_786_233_200;

function thread(overrides: Record<string, unknown> = {}) {
  return {
    id: "native-thread",
    sessionId: "native-thread",
    forkedFromId: null,
    parentThreadId: null,
    preview: "Investigate native projection",
    ephemeral: false,
    isPinned: false,
    modelProvider: "openai",
    createdAt: startedAt - 100,
    updatedAt: startedAt + 20,
    recencyAt: null,
    status: { type: "active", activeFlags: [] },
    path: "C:\\Users\\operator\\.codex\\sessions\\secret.jsonl",
    cwd: process.cwd(),
    cliVersion: "0.146.0",
    source: "cli",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: "Native\nthread",
    turns: [
      {
        id: "provider-turn",
        status: "inProgress",
        itemsView: "full",
        error: null,
        startedAt,
        completedAt: null,
        durationMs: null,
        items: [
          {
            type: "userMessage",
            id: "provider-user",
            clientId: null,
            content: [{ type: "text", text: "Run the checks", text_elements: [] }],
          },
          {
            type: "agentMessage",
            id: "provider-progress",
            text: "Checking the repository",
            phase: "commentary",
            memoryCitation: null,
          },
          {
            type: "reasoning",
            id: "provider-reasoning",
            summary: ["Finding the failing boundary"],
            content: ["private hidden chain of thought"],
          },
          {
            type: "commandExecution",
            id: "provider-command",
            pluginId: null,
            scriptPath: null,
            command: `pnpm test --filter api_key=TOP_SECRET ${process.cwd()}`,
            cwd: process.cwd(),
            processId: "sensitive-process-id",
            source: "agent",
            status: "inProgress",
            commandActions: [],
            aggregatedOutput:
              "access_token=TOP_SECRET C:\\Users\\operator\\private\\token.txt\n" +
              "bounded output\n".repeat(3_000),
            exitCode: null,
            durationMs: 8_000,
          },
          {
            type: "fileChange",
            id: "provider-file",
            changes: [
              {
                path: `${process.cwd()}\\src\\native.ts`,
                kind: { type: "update" },
                diff: "raw diff must not cross the boundary",
              },
            ],
            status: "inProgress",
          },
        ],
      },
    ],
    ...overrides,
  };
}

function options(revision = 1) {
  return {
    providerId: "codex" as const,
    accountId: "not-bluewhalex",
    providerSessionId: "native-thread",
    runtimeId: "runtime-1",
    runtimeGeneration: 3,
    revision,
    allowedRoots: [process.cwd()],
    now: () => new Date("2026-08-09T07:00:00.000Z"),
  };
}

describe("Codex provider-native Session projection", () => {
  it("reads the exact thread with history and normalizes active activity", async () => {
    const request = vi.fn(async () => ({ thread: thread() }));
    const snapshot = await readCodexNativeSessionProjection(
      { request },
      options(),
    );

    expect(request).toHaveBeenCalledExactlyOnceWith(
      "thread/read",
      { threadId: "native-thread", includeTurns: true },
      { timeoutMs: 2_500, terminateOnTimeout: false },
    );
    expect(snapshot).toMatchObject({
      providerId: "codex",
      accountId: "not-bluewhalex",
      providerSessionId: "native-thread",
      providerRevision: String(startedAt + 20),
      availability: "available",
      freshness: "live",
      runtimeId: "runtime-1",
      runtimeGeneration: 3,
      title: "Native thread",
      projectLabel: expect.any(String),
      state: "editing",
      activeSince: new Date(startedAt * 1_000).toISOString(),
    });
    expect(snapshot.items.map((item) => item.type)).toEqual([
      "operator_message",
      "assistant_progress",
      "assistant_progress",
      "activity",
      "file_change",
      "turn_state",
    ]);
    expect(snapshot.items.find((item) => item.type === "activity")).toMatchObject({
      activityType: "test",
      status: "running",
      cwdLabel: expect.any(String),
      durationMs: 8_000,
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("TOP_SECRET");
    expect(serialized).not.toContain("operator\\private");
    expect(serialized).not.toContain("sensitive-process-id");
    expect(serialized).not.toContain("raw diff");
    expect(serialized).not.toContain("private hidden chain of thought");
    const activity = snapshot.items.find((item) => item.type === "activity");
    expect(
      activity?.type === "activity" && activity.combinedOutputPreview !== null
        ? utf8ByteLength(activity.combinedOutputPreview)
        : 0,
    ).toBeLessThanOrEqual(MAX_PROVIDER_SESSION_PROJECTION_TEXT_BYTES);
  });

  it("fails closed for environment, credential, ticket, and secret-header command data", async () => {
    const sensitive = thread();
    const command = sensitive.turns[0]!.items.find(
      (item: { type: string }) => item.type === "commandExecution",
    ) as { command: string; aggregatedOutput: string };
    command.command =
      "$env:AICL_CONNECTOR_TOKEN='runtime-secret'; " +
      "Get-Content $env:USERPROFILE\\.codex\\auth.json";
    command.aggregatedOutput =
      "Author\u001b[31mization: Basic provider-credential\u001b[0m\n" +
      '{"refresh_token":"refresh-secret","ticket":"runtime-ticket"}\n' +
      "DEPLOY_KEY=opaque-environment-value\n" +
      "X-Api-Key: header-secret";

    const snapshot = await readCodexNativeSessionProjection(
      { request: async () => ({ thread: sensitive }) },
      options(7),
    );
    const serialized = JSON.stringify(snapshot);

    for (const forbidden of [
      "AICL_CONNECTOR_TOKEN",
      "runtime-secret",
      "USERPROFILE",
      "auth.json",
      "provider-credential",
      "refresh-secret",
      "runtime-ticket",
      "DEPLOY_KEY",
      "opaque-environment-value",
      "header-secret",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(snapshot.items.find((item) => item.type === "activity")).toMatchObject({
      title: "Sensitive provider command",
      combinedOutputPreview: null,
    });
  });

  it.each([
    ["cmd /c echo %AICL_CONNECTOR_TOKEN%", "runtime-secret"],
    ["sh -c echo $AICL_CONNECTOR_TOKEN", "second-runtime-secret"],
    ["Get-Content auth.json", "opaque-provider-credential"],
  ])("suppresses sensitive command form %s", async (commandText, output) => {
    const sensitive = thread();
    const command = sensitive.turns[0]!.items.find(
      (item: { type: string }) => item.type === "commandExecution",
    ) as { command: string; aggregatedOutput: string };
    command.command = commandText;
    command.aggregatedOutput = output;

    const snapshot = await readCodexNativeSessionProjection(
      { request: async () => ({ thread: sensitive }) },
      options(10),
    );

    expect(snapshot.items.find((item) => item.type === "activity")).toMatchObject({
      title: "Sensitive provider command",
      combinedOutputPreview: null,
    });
    expect(JSON.stringify(snapshot)).not.toContain(output);
  });

  it.each([
    ["node -p process.env.AICL_CONNECTOR_TOKEN", "standalone-environment-secret"],
    ["provider-cli --ticket runtime-ticket-secret", "completed"],
    ["provider-cli --api-key credential-secret", "completed"],
    ["deploy_key=opaque-value node app.js", "completed"],
  ])("suppresses programmatic or option-based sensitive command %s", async (
    commandText,
    output,
  ) => {
    const sensitive = thread();
    const command = sensitive.turns[0]!.items.find(
      (item: { type: string }) => item.type === "commandExecution",
    ) as { command: string; aggregatedOutput: string };
    command.command = commandText;
    command.aggregatedOutput = output;

    const snapshot = await readCodexNativeSessionProjection(
      { request: async () => ({ thread: sensitive }) },
      options(11),
    );

    expect(snapshot.items.find((item) => item.type === "activity")).toMatchObject({
      title: "Sensitive provider command",
      combinedOutputPreview: null,
    });
    expect(JSON.stringify(snapshot)).not.toMatch(
      /AICL_CONNECTOR_TOKEN|standalone-environment-secret|runtime-ticket-secret|credential-secret|deploy_key|opaque-value/u,
    );
  });

  it("keeps unstructured provider command output Connector-side", async () => {
    const value = thread();
    const command = value.turns[0]!.items.find(
      (item: { type: string }) => item.type === "commandExecution",
    ) as { command: string; aggregatedOutput: string };
    command.command = "Write-Output public-build-state";
    command.aggregatedOutput = "public build output";

    const snapshot = await readCodexNativeSessionProjection(
      { request: async () => ({ thread: value }) },
      options(12),
    );

    expect(snapshot.items.find((item) => item.type === "activity")).toMatchObject({
      title: "Write-Output public-build-state",
      combinedOutputPreview: null,
    });
  });

  it("preserves benign shell-variable discussion in native conversation history", async () => {
    const value = thread({
      status: { type: "idle" },
      turns: [{
        id: "variable-discussion",
        status: "completed",
        itemsView: "full",
        error: null,
        startedAt,
        completedAt: startedAt + 1,
        durationMs: 1_000,
        items: [
          {
            type: "userMessage",
            id: "variable-user",
            clientId: null,
            content: [{
              type: "text",
              text: "Explain the local $value variable",
              text_elements: [],
            }],
          },
          {
            type: "agentMessage",
            id: "variable-answer",
            text: "Use $value to store the local result.",
            phase: "final_answer",
            memoryCitation: null,
          },
        ],
      }],
    });

    const snapshot = await readCodexNativeSessionProjection(
      { request: async () => ({ thread: value }) },
      options(13),
    );

    expect(snapshot.items).toContainEqual(expect.objectContaining({
      type: "operator_message",
      text: "Explain the local $value variable",
    }));
    expect(snapshot.items).toContainEqual(expect.objectContaining({
      type: "assistant_message",
      text: "Use $value to store the local result.",
    }));
  });

  it("suppresses a bounded output preview when sensitive data appears after ANSI removal", async () => {
    const sensitiveOutput = thread();
    const command = sensitiveOutput.turns[0]!.items.find(
      (item: { type: string }) => item.type === "commandExecution",
    ) as { command: string; aggregatedOutput: string };
    command.command = "Write-Output provider-state";
    command.aggregatedOutput =
      "Author\u001b[31mization: Basic provider-credential\u001b[0m\n" +
      '{"refresh_token":"refresh-secret","ticket":"runtime-ticket"}\n' +
      "DEPLOY_KEY=opaque-environment-value";

    const snapshot = await readCodexNativeSessionProjection(
      { request: async () => ({ thread: sensitiveOutput }) },
      options(8),
    );
    const activity = snapshot.items.find((item) => item.type === "activity");

    expect(activity).toMatchObject({
      title: "Write-Output provider-state",
      combinedOutputPreview: null,
    });
    expect(JSON.stringify(snapshot)).not.toMatch(
      /provider-credential|refresh-secret|runtime-ticket|DEPLOY_KEY|opaque-environment-value/u,
    );
  });

  it("distinguishes final answers and terminal turn state", async () => {
    const completed = thread({
      status: { type: "notLoaded" },
      turns: [
        {
          id: "turn-completed",
          status: "completed",
          itemsView: "full",
          error: null,
          startedAt,
          completedAt: startedAt + 12,
          durationMs: 12_000,
          items: [
            {
              type: "userMessage",
              id: "user-completed",
              clientId: null,
              content: [{ type: "text", text: "Finish", text_elements: [] }],
            },
            {
              type: "agentMessage",
              id: "answer-completed",
              text: "All checks passed",
              phase: "final_answer",
              memoryCitation: null,
            },
          ],
        },
      ],
    });
    const snapshot = await readCodexNativeSessionProjection(
      { request: async () => ({ thread: completed }) },
      options(2),
    );

    expect(snapshot.state).toBe("view_only");
    expect(snapshot.activeSince).toBeNull();
    expect(snapshot.items).toContainEqual(
      expect.objectContaining({
        type: "assistant_message",
        phase: "final_answer",
        status: "completed",
        text: "All checks passed",
      }),
    );
    expect(snapshot.items.at(-1)).toMatchObject({
      type: "turn_state",
      state: "completed",
      completedAt: new Date((startedAt + 12) * 1_000).toISOString(),
    });
  });

  it("deduplicates stable provider item identities and truncates oldest history", async () => {
    const repeated = Array.from(
      { length: MAX_PROVIDER_SESSION_PROJECTION_ITEMS + 20 },
      (_, index) => ({
        type: "agentMessage",
        id: index === 1 ? "message-0" : `message-${index}`,
        text: `message ${index}`,
        phase: "commentary",
        memoryCitation: null,
      }),
    );
    const value = thread({
      turns: [
        {
          id: "large-turn",
          status: "completed",
          itemsView: "full",
          error: null,
          startedAt,
          completedAt: startedAt + 1,
          durationMs: 1_000,
          items: repeated,
        },
      ],
      status: { type: "idle" },
    });

    const snapshot = await readCodexNativeSessionProjection(
      { request: async () => ({ thread: value }) },
      options(3),
    );

    expect(snapshot.items).toHaveLength(MAX_PROVIDER_SESSION_PROJECTION_ITEMS);
    expect(snapshot.truncated).toBe(true);
    expect(
      new Set(
        snapshot.items.map(
          (item) => `${item.providerTurnId}\u0000${item.providerItemId}`,
        ),
    ).size,
    ).toBe(snapshot.items.length);
  });

  it("bounds the complete normalized snapshot, including metadata and separators", async () => {
    const value = thread({
      turns: [
        {
          id: "large-byte-turn",
          status: "completed",
          itemsView: "full",
          error: null,
          startedAt,
          completedAt: startedAt + 1,
          durationMs: 1_000,
          items: Array.from({ length: 250 }, (_, index) => ({
            type: "agentMessage",
            id: `large-message-${index}`,
            text: `${index}:`.padEnd(2_293, "x"),
            phase: "commentary",
            memoryCitation: null,
          })),
        },
      ],
      status: { type: "idle" },
    });

    const snapshot = await readCodexNativeSessionProjection(
      { request: async () => ({ thread: value }) },
      options(9),
    );

    expect(utf8ByteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(
      MAX_PROVIDER_SESSION_PROJECTION_BYTES,
    );
    expect(snapshot.truncated).toBe(true);
  });

  it("fails exact account/session mismatches instead of falling back", async () => {
    await expect(
      readCodexNativeSessionProjection(
        { request: async () => ({ thread: thread({ id: "another-thread" }) }) },
        options(),
      ),
    ).rejects.toThrow("different Session identity");
  });

  it("uses only measured cross-process item deltas as short-lived live evidence", async () => {
    const baseThread = thread({
      status: { type: "notLoaded" },
      turns: [
        {
          id: "external-turn",
          status: "interrupted",
          itemsView: "full",
          error: null,
          startedAt,
          completedAt: null,
          durationMs: null,
          items: [{
            type: "userMessage",
            id: "external-user",
            clientId: null,
            content: [{ type: "text", text: "Observe me", text_elements: [] }],
          }],
        },
      ],
    });
    const baseline = await readCodexNativeSessionProjection(
      { request: async () => ({ thread: baseThread }) },
      options(4),
    );
    const first = reconcileCodexNativeObservation(baseline, null, nowMs());
    expect(first.snapshot.state).toBe("view_only");

    const changing = structuredClone(baseThread);
    (changing.turns as Array<{ items: unknown[] }>)[0]!.items.push({
      type: "fileChange",
      id: "external-change",
      changes: [{ path: "src/live.ts", kind: { type: "update" } }],
      status: "completed",
    });
    const changedSnapshot = await readCodexNativeSessionProjection(
      { request: async () => ({ thread: changing }) },
      options(5),
    );
    const changed = reconcileCodexNativeObservation(
      changedSnapshot,
      first.continuity,
      nowMs() + 1_500,
    );
    expect(changed.snapshot.state).toBe("editing");
    expect(changed.snapshot.activeSince).toBeNull();
    expect(changed.snapshot.items.filter((item) => item.type === "file_change")).toHaveLength(1);

    const unchanged = reconcileCodexNativeObservation(
      changedSnapshot,
      changed.continuity,
      nowMs() + 3_000,
    );
    expect(unchanged.snapshot.state).toBe("editing");

    (changing.turns as Array<{ items: unknown[] }>)[0]!.items.push({
      type: "agentMessage",
      id: "external-final",
      text: "Finished",
      phase: "final_answer",
      memoryCitation: null,
    });
    const finalSnapshot = await readCodexNativeSessionProjection(
      { request: async () => ({ thread: changing }) },
      options(6),
    );
    const terminal = reconcileCodexNativeObservation(
      finalSnapshot,
      unchanged.continuity,
      nowMs() + 4_000,
    );
    expect(terminal.snapshot.state).toBe("view_only");
    expect(terminal.snapshot.activeSince).toBeNull();

    const expired = reconcileCodexNativeObservation(
      changedSnapshot,
      changed.continuity,
      nowMs() + 17_000,
    );
    expect(expired.snapshot.state).toBe("view_only");
    expect(expired.snapshot.activeSince).toBeNull();
  });
});

function nowMs() {
  return Date.parse("2026-08-09T07:00:00.000Z");
}
