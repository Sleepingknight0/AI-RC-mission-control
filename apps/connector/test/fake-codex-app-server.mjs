/* global process, setTimeout, setInterval, clearInterval */

import { createInterface } from "node:readline";

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let active;

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined && active?.approvalRequestId === message.id) {
    const decision = message.result?.decision;
    send({
      method: "item/completed",
      params: {
        threadId: active.threadId,
        turnId: active.turnId,
        completedAtMs: Date.now(),
        item: {
          type: "commandExecution",
          id: "provider-command-item",
          command: "pnpm test",
          commandActions: [],
          cwd: process.cwd(),
          status: decision === "accept" ? "completed" : "declined",
          aggregatedOutput: `decision:${decision}`,
          exitCode: decision === "accept" ? 0 : null,
          durationMs: 10,
        },
      },
    });
    finishTurn(`Approval ${decision}`);
    return;
  }
  switch (message.method) {
    case "initialize":
      send({ id: message.id, result: { userAgent: "fake-codex/0.146.0" } });
      break;
    case "initialized":
      break;
    case "thread/start":
      send({ id: message.id, result: { thread: { id: "fake-thread" } } });
      break;
    case "thread/resume":
      send({
        id: message.id,
        result: { thread: { id: message.params.threadId } },
      });
      break;
    case "account/read":
      send({
        id: message.id,
        result: {
          account: {
            type: "chatgpt",
            email: "must-not-reach-browser@example.invalid",
            planType: "plus",
          },
          requiresOpenaiAuth: false,
        },
      });
      break;
    case "model/list":
      send({
        id: message.id,
        result: {
          data: [
            {
              id: "fake-codex-model",
              model: "fake-codex-model",
              displayName: "Fake Codex Model",
              description: "Deterministic model for connector tests",
              hidden: false,
              isDefault: true,
              inputModalities: ["text", "image"],
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: [
                { reasoningEffort: "medium", description: "Balanced" },
                { reasoningEffort: "high", description: "More reasoning" },
              ],
            },
          ],
          nextCursor: null,
        },
      });
      break;
    case "thread/list": {
      const archived = message.params.archived === true;
      send({
        id: message.id,
        result: {
          data: [
            {
              id: archived ? "fake-native-archived" : "fake-native-active",
              sessionId: archived ? "fake-native-archived" : "fake-native-active",
              name: archived ? "Archived native work" : "Active native work",
              preview: "Native session preview",
              cwd: process.cwd(),
              createdAt: 1_700_000_000,
              updatedAt: archived ? 1_700_000_100 : 1_700_000_200,
              recencyAt: null,
              cliVersion: "0.146.0",
              ephemeral: false,
              isPinned: !archived,
              gitInfo: { branch: "main", originUrl: null, sha: null },
              modelProvider: "openai",
              source: "cli",
              status: { type: "idle" },
              turns: [],
            },
          ],
          nextCursor: null,
          backwardsCursor: null,
        },
      });
      break;
    }
    case "turn/start": {
      const text = String(message.params.input.at(-1).text);
      const turnId = `fake-turn-${message.params.clientUserMessageId}`;
      active = { threadId: message.params.threadId, turnId, text, timer: undefined };
      if (text === "timeout-start") return;
      send({ id: message.id, result: { turn: { id: turnId } } });
      if (text === "crash") {
        setTimeout(() => {
          send({
            method: "item/agentMessage/delta",
            params: {
              threadId: active.threadId,
              turnId,
              itemId: "fake-message",
              delta: "partial",
            },
          });
          setTimeout(() => process.exit(17), 10);
        }, 10);
      } else if (text === "wait") {
        active.timer = setInterval(() => {
          send({
            method: "item/agentMessage/delta",
            params: {
              threadId: active.threadId,
              turnId,
              itemId: "fake-message",
              delta: ".",
            },
          });
        }, 15);
      } else if (text === "activity") {
        setTimeout(() => {
          send({
            method: "item/started",
            params: {
              threadId: active.threadId,
              turnId,
              startedAtMs: Date.now(),
              item: {
                type: "commandExecution",
                id: "provider-command-item",
                command: "pnpm test",
                commandActions: [],
                cwd: process.cwd(),
                status: "inProgress",
                aggregatedOutput: null,
                exitCode: null,
                durationMs: null,
              },
            },
          });
          send({
            method: "item/commandExecution/outputDelta",
            params: {
              threadId: active.threadId,
              turnId,
              itemId: "provider-command-item",
              delta: "tests ",
            },
          });
          send({
            method: "item/commandExecution/outputDelta",
            params: {
              threadId: active.threadId,
              turnId,
              itemId: "provider-command-item",
              delta: "passed",
            },
          });
          send({
            method: "item/completed",
            params: {
              threadId: active.threadId,
              turnId,
              completedAtMs: Date.now(),
              item: {
                type: "commandExecution",
                id: "provider-command-item",
                command: "pnpm test",
                commandActions: [],
                cwd: process.cwd(),
                status: "completed",
                aggregatedOutput: "tests passed",
                exitCode: 0,
                durationMs: 12,
              },
            },
          });
          const diff = "--- a/demo.txt\n+++ b/demo.txt\n@@ -0,0 +1 @@\n+hello\n";
          send({
            method: "item/started",
            params: {
              threadId: active.threadId,
              turnId,
              startedAtMs: Date.now(),
              item: {
                type: "fileChange",
                id: "provider-file-item",
                status: "inProgress",
                changes: [{ path: "demo.txt", kind: { type: "add" }, diff }],
              },
            },
          });
          send({
            method: "item/completed",
            params: {
              threadId: active.threadId,
              turnId,
              completedAtMs: Date.now(),
              item: {
                type: "fileChange",
                id: "provider-file-item",
                status: "completed",
                changes: [{ path: "demo.txt", kind: { type: "add" }, diff }],
              },
            },
          });
          finishTurn("Activity complete");
        }, 15);
      } else if (text === "terminal-item-reconciliation") {
        setTimeout(() => {
          const command = {
            type: "commandExecution",
            id: "provider-terminal-command-item",
            command: "pnpm test",
            commandActions: [],
            cwd: process.cwd(),
            status: "completed",
            aggregatedOutput: "terminal output",
            exitCode: 0,
            durationMs: 14,
          };
          const fileChange = {
            type: "fileChange",
            id: "provider-terminal-file-item",
            status: "completed",
            changes: [
              {
                path: "proof.txt",
                kind: { type: "add" },
                diff: "AICL_DIFF_OK\n",
              },
            ],
          };
          send({
            method: "item/started",
            params: {
              threadId: active.threadId,
              turnId,
              startedAtMs: Date.now(),
              item: {
                ...command,
                status: "inProgress",
                aggregatedOutput: null,
                exitCode: null,
                durationMs: null,
              },
            },
          });
          send({
            method: "item/started",
            params: {
              threadId: active.threadId,
              turnId,
              startedAtMs: Date.now(),
              item: { ...fileChange, status: "inProgress" },
            },
          });
          send({
            method: "turn/completed",
            params: {
              threadId: active.threadId,
              turn: {
                id: turnId,
                status: "completed",
                items: [command, fileChange],
              },
            },
          });
          active = undefined;
        }, 15);
      } else if (text === "approval") {
        setTimeout(() => {
          send({
            method: "item/started",
            params: {
              threadId: active.threadId,
              turnId,
              startedAtMs: Date.now(),
              item: {
                type: "commandExecution",
                id: "provider-command-item",
                command: "pnpm test",
                commandActions: [],
                cwd: process.cwd(),
                status: "inProgress",
                aggregatedOutput: null,
                exitCode: null,
                durationMs: null,
              },
            },
          });
          active.approvalRequestId = "raw-provider-request-id";
          send({
            id: active.approvalRequestId,
            method: "item/commandExecution/requestApproval",
            params: {
              threadId: active.threadId,
              turnId,
              itemId: "provider-command-item",
              startedAtMs: Date.now(),
              command: "pnpm test",
              commandActions: [],
              cwd: process.cwd(),
              reason: "test approval",
            },
          });
        }, 15);
      } else if (text === "oversized-message") {
        setTimeout(() => {
          send({
            method: "item/completed",
            params: {
              threadId: active.threadId,
              turnId,
              completedAtMs: Date.now(),
              item: {
                type: "agentMessage",
                id: "oversized-message",
                text: "x".repeat(600 * 1024),
              },
            },
          });
        }, 15);
      } else {
        setTimeout(() => {
          const answer =
            text === "report-settings"
              ? `Real-shaped response: ${message.params.input[0].text}|${message.params.model}|${message.params.effort}`
              : `Real-shaped response: ${text}`;
          send({
            method: "item/agentMessage/delta",
            params: {
              threadId: active.threadId,
              turnId,
              itemId: "fake-message",
              delta: answer,
            },
          });
          send({
            method: "item/completed",
            params: {
              threadId: active.threadId,
              turnId,
              completedAtMs: Date.now(),
              item: { type: "agentMessage", id: "fake-message", text: answer },
            },
          });
          send({
            method: "turn/completed",
            params: {
              threadId: active.threadId,
              turn: { id: turnId, status: "completed", items: [] },
            },
          });
          active = undefined;
        }, 15);
      }
      break;
    }
    case "turn/interrupt":
      if (active?.timer) clearInterval(active.timer);
      send({ id: message.id, result: {} });
      send({
        method: "turn/completed",
        params: {
          threadId: message.params.threadId,
          turn: { id: message.params.turnId, status: "interrupted", items: [] },
        },
      });
      active = undefined;
      break;
    default:
      if ("id" in message) {
        send({ id: message.id, error: { code: -32601, message: "not implemented" } });
      }
  }
});

function finishTurn(answer) {
  const current = active;
  send({
    method: "item/agentMessage/delta",
    params: {
      threadId: current.threadId,
      turnId: current.turnId,
      itemId: "fake-message",
      delta: answer,
    },
  });
  send({
    method: "item/completed",
    params: {
      threadId: current.threadId,
      turnId: current.turnId,
      completedAtMs: Date.now(),
      item: { type: "agentMessage", id: "fake-message", text: answer },
    },
  });
  send({
    method: "turn/completed",
    params: {
      threadId: current.threadId,
      turn: { id: current.turnId, status: "completed", items: [] },
    },
  });
  active = undefined;
}
