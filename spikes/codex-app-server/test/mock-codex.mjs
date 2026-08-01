#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const statePath = resolve(process.env.MOCK_CODEX_STATE ?? join(process.cwd(), ".mock-codex-state.json"));

if (args.includes("--version")) {
  console.log("codex-cli 0.0.0-mock");
  process.exit(0);
}

if (args[0] === "app-server" && args[1] === "generate-json-schema") {
  const outIndex = args.indexOf("--out");
  const out = resolve(args[outIndex + 1]);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "ClientRequest.json"), JSON.stringify({
    methods: ["initialize", "thread/start", "turn/start", "thread/read", "thread/resume"],
  }, null, 2));
  writeFileSync(join(out, "ServerNotification.json"), JSON.stringify({
    methods: ["turn/completed", "item/agentMessage/delta"],
  }, null, 2));
  process.exit(0);
}

if (!(args[0] === "app-server" && args.includes("--stdio"))) {
  console.error(`Unsupported mock invocation: ${args.join(" ")}`);
  process.exit(2);
}

let initialized = false;
let nextThread = 1;
let nextTurn = 1;
const timers = new Set();
const state = loadState();

function loadState() {
  if (!existsSync(statePath)) return { threads: {} };
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function saveState() {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function schedule(fn, ms) {
  const timer = setTimeout(() => {
    timers.delete(timer);
    fn();
  }, ms);
  timers.add(timer);
}

function startTurn(threadId, turnId) {
  const thread = state.threads[threadId];
  const turn = thread.turns.find((item) => item.id === turnId);
  send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress" } } });
  send({
    method: "item/started",
    params: { threadId, turnId, item: { id: `item_${turnId}`, type: "agentMessage", status: "inProgress" } },
  });

  let index = 0;
  const chunks = Array.from({ length: 80 }, (_, i) => `${String(i + 1).padStart(3, "0")} | mock AICL streaming payload\n`);

  const emit = () => {
    if (index >= chunks.length) {
      turn.status = "completed";
      turn.items = [{ id: `item_${turnId}`, type: "agentMessage", text: chunks.join("") }];
      saveState();
      send({
        method: "item/completed",
        params: { threadId, turnId, item: { id: `item_${turnId}`, type: "agentMessage", text: chunks.join(""), status: "completed" } },
      });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: turn.items } } });
      return;
    }

    const delta = chunks[index];
    turn.partialText = `${turn.partialText ?? ""}${delta}`;
    saveState();
    send({
      method: "item/agentMessage/delta",
      params: { threadId, turnId, itemId: `item_${turnId}`, delta },
    });
    index += 1;
    schedule(emit, 12);
  };

  schedule(emit, 20);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const message = JSON.parse(line);
  const { id, method, params } = message;

  if (method === "initialize") {
    initialized = true;
    send({ id, result: { userAgent: "mock", codexHome: dirname(statePath), platformFamily: "mock", platformOs: process.platform } });
    return;
  }
  if (method === "initialized") return;
  if (!initialized) {
    send({ id, error: { code: -32600, message: "Not initialized" } });
    return;
  }

  if (method === "thread/start") {
    const threadId = `thr_mock_${Date.now()}_${nextThread++}`;
    state.threads[threadId] = { id: threadId, cwd: params?.cwd ?? process.cwd(), turns: [] };
    saveState();
    send({ id, result: { thread: { ...state.threads[threadId], status: { type: "idle" } } } });
    send({ method: "thread/started", params: { thread: { ...state.threads[threadId], status: { type: "idle" } } } });
    return;
  }

  if (method === "turn/start") {
    const thread = state.threads[params.threadId];
    if (!thread) {
      send({ id, error: { code: -32600, message: "Thread not found" } });
      return;
    }
    const turnId = `turn_mock_${Date.now()}_${nextTurn++}`;
    const turn = { id: turnId, status: "inProgress", items: [] };
    thread.turns.push(turn);
    saveState();
    send({ id, result: { turn } });
    startTurn(params.threadId, turnId);
    return;
  }

  if (method === "thread/read" || method === "thread/resume") {
    const thread = state.threads[params.threadId];
    if (!thread) {
      send({ id, error: { code: -32600, message: "Thread not found" } });
      return;
    }
    send({ id, result: { thread: { ...thread, status: { type: "idle" } } } });
    return;
  }

  send({ id, error: { code: -32601, message: `Unknown method: ${method}` } });
});

process.on("SIGTERM", () => process.exit(143));
process.on("SIGINT", () => process.exit(130));
