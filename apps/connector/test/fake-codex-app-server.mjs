/* global process, setTimeout, setInterval, clearInterval */

import { createInterface } from "node:readline";

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let active;

lines.on("line", (line) => {
  const message = JSON.parse(line);
  switch (message.method) {
    case "initialize":
      send({ id: message.id, result: { userAgent: "fake-codex/0.146.0" } });
      break;
    case "initialized":
      break;
    case "thread/start":
    case "thread/resume":
      send({ id: message.id, result: { thread: { id: "fake-thread" } } });
      break;
    case "turn/start": {
      const text = String(message.params.input[0].text);
      const turnId = `fake-turn-${message.params.clientUserMessageId}`;
      active = { threadId: message.params.threadId, turnId, text, timer: undefined };
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
      } else {
        setTimeout(() => {
          const answer = `Real-shaped response: ${text}`;
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
