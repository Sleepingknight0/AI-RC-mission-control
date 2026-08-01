import { resolve } from "node:path";

import {
  CoreToConnectorEnvelopeSchema,
  makeEnvelope,
  type ConnectorEnvelope,
} from "@aicl/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { CodexProvider } from "../src/codex/adapter.js";
import {
  ProviderLostError,
  type TurnInterruptCommand,
  type TurnStartCommand,
} from "../src/provider.js";

const providers: CodexProvider[] = [];
const fakeCommand = resolve("test/fake-codex-app-server.mjs");

afterEach(async () => {
  await Promise.allSettled(providers.splice(0).map((provider) => provider.close()));
});

function provider() {
  const value = new CodexProvider({ cwd: process.cwd(), command: fakeCommand });
  providers.push(value);
  return value;
}

function startCommand(
  prompt: string,
  providerSessionId: string | null = null,
): TurnStartCommand {
  return CoreToConnectorEnvelopeSchema.parse(
    makeEnvelope("connector.turn.start", {
      sessionId: "session-1",
      turnId: `turn-${prompt}`,
      commandId: `command-${prompt}`,
      prompt,
      providerSessionId,
    }),
  ) as TurnStartCommand;
}

describe("Codex adapter normalization", () => {
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
});

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for adapter event");
}
