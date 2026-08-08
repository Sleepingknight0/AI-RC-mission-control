import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ConnectorEnvelopeSchema,
  ServerEnvelopeSchema,
  makeEnvelope,
  type ClientEnvelope,
  type ServerEnvelope,
} from "@aicl/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { CoreDatabase, type ConnectorSource } from "../src/store.js";

const databases: CoreDatabase[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("provider enablement command audit", () => {
  it("durably replays identical commands and rejects duplicate payload changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicl-provider-enablement-"));
    roots.push(root);
    const path = join(root, "core.db");
    const first = new CoreDatabase({ path });
    databases.push(first);
    const command = enablementCommand("enable-claude", false, true);

    const accepted = await first.acceptProviderEnablement({
      message: command,
      rejection: enablementRejection(command),
    });
    expect(accepted).toMatchObject({ kind: "new", dispatch: true });
    expect(await first.acceptProviderEnablement({
      message: command,
      rejection: enablementRejection(command),
    })).toEqual({ kind: "pending" });
    expect((await first.acceptProviderEnablement({
      message: { ...command, payload: { ...command.payload, providerId: "grok" } },
      rejection: enablementRejection(command),
    })).kind).toBe("conflict");

    const connectorTerminal = ConnectorEnvelopeSchema.parse({
      ...makeEnvelope("connector.provider.enablement.changed", {
        commandId: command.payload.commandId,
        providerId: command.payload.providerId,
        enabled: true,
      }),
      connectorId: "connector-one",
      bootId: "boot-one",
      sourceEventId: "source-enablement-one",
      runtimeId: "runtime-one",
      runtimeGeneration: 1,
    });
    if (connectorTerminal.type !== "connector.provider.enablement.changed") {
      throw new Error("Expected provider enablement terminal");
    }
    const terminal = await first.recordProviderEnablement(
      connectorTerminal,
      source("source-enablement-one"),
    );
    expect(terminal).toMatchObject({
      type: "provider.enablement.changed",
      payload: { providerId: "claude", enabled: true },
    });
    expect(await first.acceptProviderEnablement({
      message: command,
      rejection: enablementRejection(command),
    })).toMatchObject({ kind: "same", result: terminal });

    await first.close();
    databases.splice(databases.indexOf(first), 1);
    const reopened = new CoreDatabase({ path });
    databases.push(reopened);
    expect(await reopened.acceptProviderEnablement({
      message: command,
      rejection: enablementRejection(command),
    })).toMatchObject({ kind: "same", result: terminal });
  });

  it("audits rejected CAS and lost-Connector outcomes without changing Sessions", async () => {
    const database = new CoreDatabase({ path: ":memory:" });
    databases.push(database);
    const stale = enablementCommand("stale-enable", false, true);
    const rejected = await database.acceptProviderEnablement({
      message: stale,
      preconditionError: {
        code: "PROVIDER_ENABLEMENT_CONFLICT",
        detail: "Refresh inventory",
      },
      rejection: enablementRejection(stale),
    });
    expect(rejected).toMatchObject({
      kind: "new",
      result: {
        type: "provider.enablement.rejected",
        payload: { error: { code: "PROVIDER_ENABLEMENT_CONFLICT" } },
      },
    });

    const pending = enablementCommand("lost-enable", false, true);
    expect(await database.acceptProviderEnablement({
      message: pending,
      rejection: enablementRejection(pending),
    })).toMatchObject({ kind: "new", dispatch: true });
    const outcomes = await database.markPendingProviderEnablementsOutcomeUnknown();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      type: "provider.enablement.rejected",
      payload: { error: { code: "OUTCOME_UNKNOWN" } },
    });
    expect(database.sessionSummaries()).toEqual([]);
  });
});

function enablementCommand(
  commandId: string,
  expectedEnabled: boolean,
  enabled: boolean,
) {
  const command = makeEnvelope("provider.enablement.set", {
    commandId,
    deviceId: "device-one",
    providerId: "claude",
    expectedEnabled,
    enabled,
  });
  if (command.type !== "provider.enablement.set") {
    throw new Error("Expected provider enablement command");
  }
  return command;
}

function enablementRejection(
  message: Extract<ClientEnvelope, { type: "provider.enablement.set" }>,
) {
  return (code: string, detail: string): ServerEnvelope =>
    ServerEnvelopeSchema.parse(makeEnvelope("provider.enablement.rejected", {
      commandId: message.payload.commandId,
      providerId: message.payload.providerId,
      error: { code, message: detail, retryable: false, detail: null },
    }));
}

function source(sourceEventId: string): ConnectorSource {
  return {
    connectorId: "connector-one",
    sourceEventId,
    runtimeId: "runtime-one",
    runtimeGeneration: 1,
  };
}
