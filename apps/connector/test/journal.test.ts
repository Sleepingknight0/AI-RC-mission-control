import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CoreToConnectorEnvelopeSchema,
  makeEnvelope,
  type Runtime,
} from "@aicl/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConnectorJournal } from "../src/journal.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Connector SQLite journal", () => {
  it("persists inbox dedupe and unacknowledged outbox across a new boot", () => {
    const path = journalPath();
    const first = new ConnectorJournal({ path });
    const runtime: Runtime = {
      runtimeId: first.runtimeId,
      generation: first.runtimeGeneration,
      status: "busy",
    };
    const command = CoreToConnectorEnvelopeSchema.parse(
      makeEnvelope("connector.turn.start", {
        sessionId: "journal-session",
        turnId: "journal-turn",
        commandId: "journal-command",
        prompt: "only once",
        providerSessionId: null,
        runtimeId: first.runtimeId,
        runtimeGeneration: first.runtimeGeneration,
      }),
    );
    if (command.type !== "connector.turn.start") {
      throw new Error("Expected connector.turn.start");
    }
    expect(first.recordCommand(command)).toBe("new");
    expect(first.recordCommand(command)).toBe("same");
    const durable = first.enqueue(
      makeEnvelope("connector.turn.completed", {
        sessionId: "journal-session",
        turnId: "journal-turn",
      }),
      runtime,
    );
    expect(durable.sourceEventId).toBeTruthy();
    const firstIdentity = {
      connectorId: first.connectorId,
      bootId: first.bootId,
      generation: first.runtimeGeneration,
    };
    first.close();

    const second = new ConnectorJournal({ path });
    expect(second.schemaVersion).toBe(2);
    expect(Object.values(second.pragma("journal_mode"))).toContain("wal");
    expect(Object.values(second.pragma("foreign_keys"))).toContain(1);
    expect(second.connectorId).toBe(firstIdentity.connectorId);
    expect(second.bootId).not.toBe(firstIdentity.bootId);
    expect(second.runtimeGeneration).toBe(firstIdentity.generation + 1);
    expect(second.recordCommand(command)).toBe("same");
    expect(second.pendingEvents()).toEqual([durable]);
    second.acknowledge(durable.sourceEventId!);
    expect(second.unacknowledgedCount()).toBe(0);
    second.close();
  });

  it("rejects a reused Connector command ID with changed payload", () => {
    const journal = new ConnectorJournal({ path: journalPath() });
    const first = CoreToConnectorEnvelopeSchema.parse(
      makeEnvelope("connector.turn.start", {
        sessionId: "journal-session",
        turnId: "journal-turn",
        commandId: "journal-command",
        prompt: "first",
        providerSessionId: null,
        runtimeId: journal.runtimeId,
        runtimeGeneration: journal.runtimeGeneration,
      }),
    );
    const changed = CoreToConnectorEnvelopeSchema.parse(
      makeEnvelope("connector.turn.start", {
        sessionId: "journal-session",
        turnId: "journal-turn",
        commandId: "journal-command",
        prompt: "changed",
        providerSessionId: null,
        runtimeId: journal.runtimeId,
        runtimeGeneration: journal.runtimeGeneration,
      }),
    );
    if (first.type !== "connector.turn.start" || changed.type !== "connector.turn.start") {
      throw new Error("Expected connector.turn.start");
    }
    expect(journal.recordCommand(first)).toBe("new");
    expect(journal.recordCommand(changed)).toBe("conflict");
    journal.close();
  });

  it("replays events in exact insertion order when timestamps collide", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T00:00:00.000Z"));
    const journal = new ConnectorJournal({ path: journalPath() });
    const runtime: Runtime = {
      runtimeId: journal.runtimeId,
      generation: journal.runtimeGeneration,
      status: "busy",
    };
    const inserted = Array.from({ length: 12 }, (_, index) =>
      journal.enqueue(
        makeEnvelope("connector.turn.delta", {
          sessionId: "fifo-session",
          turnId: "fifo-turn",
          messageId: "fifo-message",
          streamSeq: index + 1,
          text: String(index),
        }),
        runtime,
      ),
    );

    expect(journal.pendingEvents()).toEqual(inserted);
    journal.close();
  });
});

function journalPath() {
  const directory = mkdtempSync(join(tmpdir(), "aicl-journal-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "connector.db");
}
