#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";

const TOOL_VERSION = "0.2.0";
const DEFAULT_TIMEOUT_MS = 180_000;
const REQUIRED_METHODS = [
  "initialize",
  "thread/start",
  "turn/start",
  "turn/completed",
  "item/agentMessage/delta",
  "thread/read",
  "thread/resume",
];

/** Quote one Windows cmd.exe argument (handles spaces and embedded quotes). */
function quoteForWindowsShell(value) {
  const s = String(value);
  if (s.length === 0) return '""';
  if (!/[\s"&<>|^%!()]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * On Windows, `spawn(..., { shell: true })` concatenates args without quoting.
 * Paths under "Program Files" then break. Prefer shell:false for real .exe paths;
 * when shell is required, pass a single properly quoted command line.
 */
function needsWindowsShell(command) {
  if (process.platform !== "win32") return false;
  try {
    if (existsSync(command) && [".exe", ".com"].includes(extname(command).toLowerCase())) {
      return false;
    }
  } catch {
    // fall through
  }
  return true;
}

function spawnProcess(command, args, options = {}) {
  const useShell = needsWindowsShell(command);
  if (useShell) {
    const line = [command, ...args].map(quoteForWindowsShell).join(" ");
    return spawn(line, {
      ...options,
      shell: true,
    });
  }
  return spawn(command, args, {
    ...options,
    shell: false,
  });
}

function spawnProcessSync(command, args, options = {}) {
  const useShell = needsWindowsShell(command);
  if (useShell) {
    const line = [command, ...args].map(quoteForWindowsShell).join(" ");
    return spawnSync(line, {
      ...options,
      shell: true,
    });
  }
  return spawnSync(command, args, {
    ...options,
    shell: false,
  });
}

class RpcError extends Error {
  constructor(method, error) {
    super(`${method}: ${error?.message ?? "JSON-RPC error"}`);
    this.name = "RpcError";
    this.method = method;
    this.rpc = error;
  }
}

class JsonlRpcClient {
  constructor({ command, commandArgs = [], cwd, env, generation, trace, timeoutMs }) {
    this.command = command;
    this.commandArgs = commandArgs;
    this.cwd = cwd;
    this.env = env;
    this.generation = generation;
    this.trace = trace;
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.records = [];
    this.listeners = new Set();
    this.exitPromise = null;
  }

  async start() {
    const startedAt = performance.now();
    const appServerArgs = [...this.commandArgs, "app-server", "--stdio"];
    const child = spawnProcess(this.command, appServerArgs, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    this.child = child;

    this.trace.write({
      generation: this.generation,
      direction: "lifecycle",
      kind: "spawn",
      tMonoMs: startedAt,
      wallTime: new Date().toISOString(),
      pid: child.pid ?? null,
      command: this.command,
      args: appServerArgs,
    });

    this.exitPromise = new Promise((resolveExit) => {
      child.once("exit", (code, signal) => {
        const error = new Error(
          `codex app-server exited (code=${String(code)}, signal=${String(signal)})`,
        );
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pending.clear();
        this.trace.write({
          generation: this.generation,
          direction: "lifecycle",
          kind: "exit",
          tMonoMs: performance.now(),
          wallTime: new Date().toISOString(),
          code,
          signal,
        });
        resolveExit({ code, signal });
      });
    });

    child.once("error", (error) => {
      this.trace.write({
        generation: this.generation,
        direction: "lifecycle",
        kind: "spawn_error",
        tMonoMs: performance.now(),
        wallTime: new Date().toISOString(),
        error: serializeError(error),
      });
    });

    const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
    stdout.on("line", (line) => this.#onStdoutLine(line));

    const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
    stderr.on("line", (line) => {
      this.trace.write({
        generation: this.generation,
        direction: "stderr",
        tMonoMs: performance.now(),
        wallTime: new Date().toISOString(),
        bytes: Buffer.byteLength(`${line}\n`),
        raw: line,
      });
    });

    await new Promise((resolveStart, rejectStart) => {
      const timer = setTimeout(() => resolveStart(), 100);
      child.once("spawn", () => {
        clearTimeout(timer);
        resolveStart();
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        rejectStart(error);
      });
    });
  }

  async initialize() {
    const result = await this.request("initialize", {
      clientInfo: {
        name: "aicl_protocol_spike",
        title: "AICL Codex Protocol Spike",
        version: TOOL_VERSION,
      },
    });
    this.notify("initialized");
    return result;
  }

  request(method, params = undefined, timeoutMs = this.timeoutMs) {
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new Error("app-server stdin is not writable"));
    }

    const id = this.nextId++;
    const message = params === undefined ? { method, id } : { method, id, params };

    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);

      this.pending.set(id, {
        method,
        timer,
        resolve: resolveRequest,
        reject: rejectRequest,
      });
      this.#send(message);
    });
  }

  notify(method, params = undefined) {
    const message = params === undefined ? { method } : { method, params };
    this.#send(message);
  }

  respond(id, result) {
    this.#send({ id, result });
  }

  respondError(id, code, message, data = undefined) {
    const error = data === undefined ? { code, message } : { code, message, data };
    this.#send({ id, error });
  }

  onRecord(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async waitFor(predicate, { since = 0, timeoutMs = this.timeoutMs } = {}) {
    for (let i = since; i < this.records.length; i += 1) {
      const record = this.records[i];
      if (predicate(record)) return record;
    }

    return new Promise((resolveWait, rejectWait) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        rejectWait(new Error(`notification wait timed out after ${timeoutMs} ms`));
      }, timeoutMs);

      const listener = (record) => {
        if (record.index < since || !predicate(record)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolveWait(record);
      };
      this.listeners.add(listener);
    });
  }

  async killTree(reason = "requested") {
    const pid = this.child?.pid;
    if (!pid) return;

    this.trace.write({
      generation: this.generation,
      direction: "lifecycle",
      kind: "kill_requested",
      reason,
      tMonoMs: performance.now(),
      wallTime: new Date().toISOString(),
      pid,
    });

    if (process.platform === "win32") {
      spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        this.child.kill("SIGKILL");
      }
    }

    await Promise.race([
      this.exitPromise,
      sleep(5_000),
    ]);
  }

  async stop() {
    if (!this.child || this.child.exitCode !== null) return;
    try {
      this.child.stdin.end();
    } catch {
      // Ignore shutdown races.
    }
    await Promise.race([this.exitPromise, sleep(750)]);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      await this.killTree("graceful_stop_timeout");
    }
  }

  #send(message) {
    const line = `${JSON.stringify(message)}\n`;
    this.trace.write({
      generation: this.generation,
      direction: "tx",
      tMonoMs: performance.now(),
      wallTime: new Date().toISOString(),
      bytes: Buffer.byteLength(line),
      message,
    });
    this.child.stdin.write(line);
  }

  #onStdoutLine(line) {
    const tMonoMs = performance.now();
    const bytes = Buffer.byteLength(`${line}\n`);
    let message;

    try {
      message = JSON.parse(line);
    } catch (error) {
      this.trace.write({
        generation: this.generation,
        direction: "rx_parse_error",
        tMonoMs,
        wallTime: new Date().toISOString(),
        bytes,
        raw: line,
        error: serializeError(error),
      });
      return;
    }

    const record = {
      index: this.records.length,
      generation: this.generation,
      tMonoMs,
      wallTime: new Date().toISOString(),
      bytes,
      message,
    };
    this.records.push(record);
    this.trace.write({
      generation: this.generation,
      direction: "rx",
      tMonoMs,
      wallTime: record.wallTime,
      bytes,
      message,
    });

    if (message && Object.hasOwn(message, "id") && !message.method) {
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new RpcError(pending.method, message.error));
        else pending.resolve(message.result);
      }
    } else if (message?.method && Object.hasOwn(message, "id")) {
      void this.#handleServerRequest(message);
    }

    for (const listener of [...this.listeners]) listener(record);
  }

  async #handleServerRequest(message) {
    const method = String(message.method);
    const id = message.id;

    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    ) {
      this.respond(id, { decision: "decline" });
      return;
    }

    if (method === "mcpServer/elicitation/request") {
      this.respond(id, { action: "decline", content: null });
      return;
    }

    if (method === "currentTime/read") {
      this.respond(id, { currentTimeAt: Math.floor(Date.now() / 1000) });
      return;
    }

    this.respondError(
      id,
      -32601,
      `AICL protocol spike does not implement server request: ${method}`,
    );
  }
}

class TraceWriter {
  constructor(path) {
    this.path = path;
    this.stream = createWriteStream(path, { flags: "a", encoding: "utf8" });
  }

  write(value) {
    this.stream.write(`${JSON.stringify(value)}\n`);
  }

  async close() {
    await new Promise((resolveClose, rejectClose) => {
      this.stream.end((error) => (error ? rejectClose(error) : resolveClose()));
    });
  }
}

function parseArgs(argv) {
  const args = {
    codex: "codex",
    cwd: process.cwd(),
    out: "",
    model: "",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    benchmarkTurns: 1,
    killAfterDeltas: 5,
    killDelayMs: 25,
    killMaxWaitMs: 30_000,
    recoveryDelayMs: 750,
    skipSchema: false,
    skipKill: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value after ${token}`);
      return argv[i];
    };

    switch (token) {
      case "--codex": args.codex = next(); break;
      case "--cwd": args.cwd = next(); break;
      case "--out": args.out = next(); break;
      case "--model": args.model = next(); break;
      case "--timeout-ms": args.timeoutMs = positiveInt(next(), token); break;
      case "--benchmark-turns": args.benchmarkTurns = positiveInt(next(), token); break;
      case "--kill-after-deltas": args.killAfterDeltas = positiveInt(next(), token); break;
      case "--kill-delay-ms": args.killDelayMs = nonNegativeInt(next(), token); break;
      case "--kill-max-wait-ms": args.killMaxWaitMs = positiveInt(next(), token); break;
      case "--recovery-delay-ms": args.recoveryDelayMs = nonNegativeInt(next(), token); break;
      case "--skip-schema": args.skipSchema = true; break;
      case "--skip-kill": args.skipKill = true; break;
      case "--help": printHelpAndExit(); break;
      default: throw new Error(`Unknown argument: ${token}`);
    }
  }

  args.cwd = resolve(args.cwd);
  if (!existsSync(args.cwd) || !statSync(args.cwd).isDirectory()) {
    throw new Error(`--cwd is not a directory: ${args.cwd}`);
  }

  args.codexInvocation = normalizeCommandInvocation(args.codex);

  if (!args.out) {
    args.out = resolve("artifacts", timestampForPath());
  } else {
    args.out = resolve(args.out);
  }
  return args;
}

function normalizeCommandInvocation(command) {
  const pathLike = command.includes("/") || command.includes("\\");
  const candidate = pathLike ? resolve(command) : command;
  if (pathLike && existsSync(candidate) && [".js", ".mjs", ".cjs"].includes(extname(candidate).toLowerCase())) {
    return { command: process.execPath, prefixArgs: [candidate], display: candidate };
  }
  return { command: candidate, prefixArgs: [], display: candidate };
}

function printHelpAndExit() {
  console.log(`AICL Codex app-server protocol spike ${TOOL_VERSION}

Usage:
  node spike.mjs [options]

Options:
  --codex PATH              Codex executable or command (default: codex)
  --cwd PATH                Existing project directory (default: current dir)
  --out PATH                Artifact directory
  --model ID                Optional model override
  --benchmark-turns N       Completed text-only turns to measure (default: 1)
  --timeout-ms N            JSON-RPC/turn timeout (default: 180000)
  --kill-after-deltas N     Kill after N agent-message deltas (default: 5)
  --kill-delay-ms N         Extra delay before kill (default: 25)
  --kill-max-wait-ms N      Fallback kill deadline (default: 30000)
  --recovery-delay-ms N     Delay before restart/read/resume (default: 750)
  --skip-schema             Do not generate installed-version JSON Schema
  --skip-kill               Skip the mid-turn process-kill experiment
  --help                    Show this help
`);
  process.exit(0);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });
  const trace = new TraceWriter(join(args.out, "trace.jsonl"));
  const startedAt = new Date().toISOString();
  const report = {
    toolVersion: TOOL_VERSION,
    startedAt,
    finishedAt: null,
    environment: {},
    schema: null,
    benchmark: [],
    killRecovery: null,
    errors: [],
  };

  const env = {
    ...process.env,
    NO_COLOR: "1",
    LOG_FORMAT: "json",
    RUST_LOG: process.env.RUST_LOG ?? "warn",
  };

  console.log(`Output: ${args.out}`);
  console.log(`Project cwd: ${args.cwd}`);

  try {
    const codexVersion = captureCommand(args.codexInvocation.command, [...args.codexInvocation.prefixArgs, "--version"], args.cwd, env);
    report.environment = {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      hostname: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? null,
      cwd: args.cwd,
      codexCommand: args.codexInvocation.display,
      codexVersion: codexVersion.stdout.trim(),
      codexVersionStderr: codexVersion.stderr.trim(),
      codexHome: process.env.CODEX_HOME ?? null,
    };
    console.log(`Codex: ${report.environment.codexVersion || "version output empty"}`);

    if (!args.skipSchema) {
      report.schema = generateSchema(args.codexInvocation, args.cwd, args.out, env);
      console.log(`Schema fingerprint: ${report.schema.fingerprint}`);
      if (report.schema.requiredMethodsMissing.length > 0) {
        console.warn(
          `Schema scan warning; method strings not found: ${report.schema.requiredMethodsMissing.join(", ")}`,
        );
      }
    }

    for (let i = 0; i < args.benchmarkTurns; i += 1) {
      console.log(`Benchmark turn ${i + 1}/${args.benchmarkTurns}`);
      const result = await runBenchmarkTurn({
        args,
        env,
        trace,
        generation: `benchmark-${i + 1}`,
      });
      report.benchmark.push(result);
      console.log(
        `  ${result.agentMessageDeltas} agent deltas, ` +
        `${formatNumber(result.averageAgentDeltasPerSecond)} avg delta/s, ` +
        `${formatNumber(result.peakAgentDeltasPerSecond)} peak delta/s`,
      );
    }

    if (!args.skipKill) {
      console.log("Mid-turn kill and recovery experiment");
      report.killRecovery = await runKillRecovery({ args, env, trace });
      console.log(`  observed recovery status: ${report.killRecovery.observedStatus ?? "unknown"}`);
    }
  } catch (error) {
    report.errors.push(serializeError(error));
    console.error(error?.stack ?? String(error));
  } finally {
    report.finishedAt = new Date().toISOString();
    writeFileSync(join(args.out, "report.json"), JSON.stringify(report, null, 2));
    writeFileSync(join(args.out, "REPORT.md"), renderMarkdownReport(report));
    await trace.close();
  }

  console.log(`Report: ${join(args.out, "REPORT.md")}`);
  if (report.errors.length > 0) process.exitCode = 1;
}

async function runBenchmarkTurn({ args, env, trace, generation }) {
  const client = new JsonlRpcClient({
    command: args.codexInvocation.command,
    commandArgs: args.codexInvocation.prefixArgs,
    cwd: args.cwd,
    env,
    generation,
    trace,
    timeoutMs: args.timeoutMs,
  });

  await client.start();
  let threadId = null;
  try {
    const init = await client.initialize();
    const thread = await startSafeThread(client, args);
    threadId = thread.id;

    const prompt = [
      "This is a transport benchmark. Do not use tools, shell commands, files, network, skills, or external data.",
      "Write exactly 180 numbered lines of plain text.",
      "Each line must use the format `NNN | AICL streaming measurement payload`.",
      "Do not add headings, code fences, explanations, or a conclusion.",
    ].join("\n");

    const startIndex = client.records.length;
    const requestAt = performance.now();
    const params = {
      threadId,
      clientUserMessageId: randomUUID(),
      input: [{ type: "text", text: prompt }],
    };
    if (args.model) params.model = args.model;

    const response = await client.request("turn/start", params);
    const responseAt = performance.now();
    const turnId = response?.turn?.id;
    if (!turnId) throw new Error("turn/start response did not include result.turn.id");

    const completed = await client.waitFor(
      (record) =>
        record.message?.method === "turn/completed" &&
        sameId(record.message?.params?.threadId, threadId) &&
        sameId(record.message?.params?.turn?.id ?? record.message?.params?.turnId, turnId),
      { since: startIndex, timeoutMs: args.timeoutMs },
    );

    const relevant = client.records.slice(startIndex, completed.index + 1);
    return summarizeTurn({
      generation,
      init,
      threadId,
      turnId,
      requestAt,
      responseAt,
      completed,
      records: relevant,
    });
  } finally {
    await client.stop();
  }
}

async function runKillRecovery({ args, env, trace }) {
  const first = new JsonlRpcClient({
    command: args.codexInvocation.command,
    commandArgs: args.codexInvocation.prefixArgs,
    cwd: args.cwd,
    env,
    generation: "kill-source",
    trace,
    timeoutMs: args.timeoutMs,
  });
  await first.start();

  let threadId = null;
  let turnId = null;
  let killReason = null;
  let killAt = null;
  let turnStartResponse = null;
  let sourceRecords = [];

  try {
    await first.initialize();
    const thread = await startSafeThread(first, args);
    threadId = thread.id;

    const prompt = [
      "This is a crash-recovery transport experiment. Do not use tools, shell commands, files, network, skills, or external data.",
      "Write 600 numbered lines of plain text, one line at a time.",
      "Each line must use the format `NNN | AICL kill recovery payload`.",
      "Do not stop early and do not add any other text.",
    ].join("\n");

    const startIndex = first.records.length;
    const params = {
      threadId,
      clientUserMessageId: randomUUID(),
      input: [{ type: "text", text: prompt }],
    };
    if (args.model) params.model = args.model;

    turnStartResponse = await first.request("turn/start", params);
    turnId = turnStartResponse?.turn?.id;
    if (!turnId) throw new Error("kill test turn/start response omitted result.turn.id");

    let agentDeltaCount = 0;
    let killScheduled = false;
    let resolveKill;
    const killed = new Promise((resolveKilled) => { resolveKill = resolveKilled; });

    const scheduleKill = (reason) => {
      if (killScheduled) return;
      killScheduled = true;
      killReason = reason;
      setTimeout(async () => {
        killAt = performance.now();
        try {
          await first.killTree(reason);
        } finally {
          resolveKill();
        }
      }, args.killDelayMs);
    };

    const unsubscribe = first.onRecord((record) => {
      if (!isRecordForTurn(record, threadId, turnId)) return;
      if (record.message?.method === "item/agentMessage/delta") {
        agentDeltaCount += 1;
        if (agentDeltaCount >= args.killAfterDeltas) {
          scheduleKill(`agent_delta_threshold_${agentDeltaCount}`);
        }
      }
      if (record.message?.method === "turn/completed") {
        scheduleKill("turn_completed_before_kill_threshold");
      }
    });

    const fallback = setTimeout(
      () => scheduleKill("kill_max_wait_timeout"),
      args.killMaxWaitMs,
    );

    await killed;
    clearTimeout(fallback);
    unsubscribe();
    sourceRecords = first.records.slice(startIndex);
  } finally {
    if (first.child?.exitCode === null && first.child?.signalCode === null) {
      await first.killTree("kill_test_cleanup");
    }
  }

  await sleep(args.recoveryDelayMs);

  const second = new JsonlRpcClient({
    command: args.codexInvocation.command,
    commandArgs: args.codexInvocation.prefixArgs,
    cwd: args.cwd,
    env,
    generation: "kill-recovery",
    trace,
    timeoutMs: args.timeoutMs,
  });
  await second.start();

  let readResult = null;
  let readError = null;
  let resumeResult = null;
  let resumeError = null;
  try {
    await second.initialize();
    try {
      readResult = await second.request("thread/read", { threadId, includeTurns: true });
    } catch (error) {
      readError = serializeError(error);
    }

    try {
      resumeResult = await second.request("thread/resume", { threadId });
    } catch (error) {
      resumeError = serializeError(error);
    }
  } finally {
    await second.stop();
  }

  const terminalSeenBeforeKill = sourceRecords.some(
    (record) =>
      record.message?.method === "turn/completed" &&
      isRecordForTurn(record, threadId, turnId),
  );
  const agentDeltasBeforeKill = sourceRecords.filter(
    (record) =>
      record.message?.method === "item/agentMessage/delta" &&
      isRecordForTurn(record, threadId, turnId),
  ).length;

  const readTurn = findTurn(readResult, turnId);
  const resumedTurn = findTurn(resumeResult, turnId);
  const observedTurn = resumedTurn ?? readTurn;
  const observedStatus = observedTurn?.status ?? null;

  return {
    threadId,
    turnId,
    turnStartResponse,
    killReason,
    killAtMonoMs: killAt,
    terminalSeenBeforeKill,
    agentDeltasBeforeKill,
    sourceNotificationCount: sourceRecords.length,
    readResult,
    readError,
    resumeResult,
    resumeError,
    observedStatus,
    observedTurn,
    interpretation: interpretRecovery({
      terminalSeenBeforeKill,
      observedStatus,
      readError,
      resumeError,
      observedTurn,
    }),
  };
}

async function startSafeThread(client, args) {
  const preferred = {
    cwd: args.cwd,
    approvalPolicy: "never",
    sandbox: "readOnly",
    personality: "none",
  };
  if (args.model) preferred.model = args.model;

  try {
    const result = await client.request("thread/start", preferred);
    if (!result?.thread?.id) throw new Error("thread/start response omitted result.thread.id");
    return result.thread;
  } catch (error) {
    if (!(error instanceof RpcError) || !isParameterCompatibilityError(error.rpc)) throw error;
    const fallback = { cwd: args.cwd };
    if (args.model) fallback.model = args.model;
    const result = await client.request("thread/start", fallback);
    if (!result?.thread?.id) throw new Error("fallback thread/start omitted result.thread.id");
    return result.thread;
  }
}

function summarizeTurn({ generation, init, threadId, turnId, requestAt, responseAt, completed, records }) {
  const notifications = records.filter((record) => record.message?.method && !Object.hasOwn(record.message, "id"));
  const agentDeltas = records.filter((record) => record.message?.method === "item/agentMessage/delta");
  const allDeltas = records.filter((record) => /delta$/i.test(String(record.message?.method ?? "")));
  const outputDeltas = records.filter((record) => record.message?.method === "item/commandExecution/outputDelta");
  const turnStarted = records.find((record) => record.message?.method === "turn/started");
  const firstAgentDelta = agentDeltas[0] ?? null;
  const agentDeltaTimes = agentDeltas.map((record) => record.tMonoMs);
  const deltaBytes = agentDeltas.map((record) => record.bytes);
  const deltaChars = agentDeltas.map((record) => String(record.message?.params?.delta ?? "").length);
  const interArrival = consecutiveDiffs(agentDeltaTimes);
  const eventCounts = {};

  for (const record of notifications) {
    const method = String(record.message.method);
    eventCounts[method] = (eventCounts[method] ?? 0) + 1;
  }

  const first = turnStarted?.tMonoMs ?? requestAt;
  const lastDelta = agentDeltaTimes.at(-1) ?? first;
  const deltaSpanSeconds = Math.max((lastDelta - (firstAgentDelta?.tMonoMs ?? first)) / 1000, 0.001);

  return {
    generation,
    initializeResult: init,
    threadId,
    turnId,
    requestToResponseMs: round(responseAt - requestAt),
    requestToTurnStartedMs: turnStarted ? round(turnStarted.tMonoMs - requestAt) : null,
    requestToFirstAgentDeltaMs: firstAgentDelta ? round(firstAgentDelta.tMonoMs - requestAt) : null,
    turnStartedToFirstAgentDeltaMs:
      firstAgentDelta && turnStarted ? round(firstAgentDelta.tMonoMs - turnStarted.tMonoMs) : null,
    turnDurationMs: round(completed.tMonoMs - first),
    totalNotifications: notifications.length,
    totalRxBytes: records.reduce((sum, record) => sum + record.bytes, 0),
    allDeltaEvents: allDeltas.length,
    agentMessageDeltas: agentDeltas.length,
    commandOutputDeltas: outputDeltas.length,
    agentDeltaCharacters: deltaChars.reduce((sum, value) => sum + value, 0),
    averageAgentDeltasPerSecond: round(agentDeltas.length / deltaSpanSeconds),
    peakAgentDeltasPerSecond: peakEventsInWindow(agentDeltaTimes, 1000),
    peakAgentDeltasPer100ms: peakEventsInWindow(agentDeltaTimes, 100),
    agentDeltaPayloadBytes: stats(deltaBytes),
    agentDeltaInterArrivalMs: stats(interArrival),
    eventCounts,
    finalTurn: completed.message?.params?.turn ?? null,
  };
}

function generateSchema(invocation, cwd, out, env) {
  const schemaDir = join(out, "schema");
  mkdirSync(schemaDir, { recursive: true });
  const result = captureCommand(
    invocation.command,
    [...invocation.prefixArgs, "app-server", "generate-json-schema", "--out", schemaDir],
    cwd,
    env,
  );
  const files = walkFiles(schemaDir);
  if (files.length === 0) {
    throw new Error("Schema generation succeeded but produced no files");
  }

  const hash = createHash("sha256");
  let combinedText = "";
  for (const file of files) {
    const content = readFileSync(file);
    hash.update(relative(schemaDir, file));
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
    combinedText += content.toString("utf8");
  }

  return {
    directory: schemaDir,
    fileCount: files.length,
    bytes: files.reduce((sum, file) => sum + statSync(file).size, 0),
    fingerprint: `sha256:${hash.digest("hex")}`,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    requiredMethodsFound: REQUIRED_METHODS.filter((method) => combinedText.includes(method)),
    requiredMethodsMissing: REQUIRED_METHODS.filter((method) => !combinedText.includes(method)),
  };
}

function captureCommand(command, args, cwd, env) {
  const result = spawnProcessSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Command failed (${String(result.status)}): ${command} ${args.join(" ")}\n` +
      `${result.stderr || result.stdout}`,
    );
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}


function isParameterCompatibilityError(error) {
  const code = error?.code;
  const message = String(error?.message ?? "").toLowerCase();
  return (
    code === -32602 ||
    (code === -32600 && (
      message.includes("invalid") ||
      message.includes("unknown field") ||
      message.includes("unsupported")
    ))
  );
}

function findTurn(result, turnId) {
  const turns = result?.thread?.turns;
  if (!Array.isArray(turns)) return null;
  return turns.find((turn) => sameId(turn?.id, turnId)) ?? null;
}

function interpretRecovery({ terminalSeenBeforeKill, observedStatus, readError, resumeError, observedTurn }) {
  if (terminalSeenBeforeKill) {
    return "The process was not conclusively killed mid-turn; lower --kill-after-deltas or --kill-delay-ms and rerun.";
  }
  if (observedStatus === "completed") {
    return "The restarted app-server reconstructed a completed turn even though this client did not observe turn/completed before the kill.";
  }
  if (["failed", "interrupted", "cancelled", "canceled"].includes(String(observedStatus))) {
    return `The restarted app-server reconstructed a terminal ${observedStatus} turn.`;
  }
  if (["inProgress", "running", "streaming"].includes(String(observedStatus))) {
    return "The persisted history still reports a non-terminal turn after process death. AICL must reconcile and must not auto-resubmit the prompt.";
  }
  if (observedTurn) {
    return `The turn was reconstructed with status ${String(observedStatus)}. Treat any unrecognized status conservatively until adapter mapping is verified.`;
  }
  if (readError && resumeError) {
    return "Neither thread/read nor thread/resume could reconstruct the killed turn. Preserve both errors and classify the local command as outcome_unknown.";
  }
  return "The thread was reachable but the killed turn was absent from reconstructed history. Do not infer success or retry automatically.";
}

function renderMarkdownReport(report) {
  const lines = [];
  lines.push("# AICL Codex app-server empirical spike report", "");
  lines.push(`- Started: ${report.startedAt}`);
  lines.push(`- Finished: ${report.finishedAt}`);
  lines.push(`- Codex: ${report.environment?.codexVersion ?? "unknown"}`);
  lines.push(`- Node: ${report.environment?.node ?? "unknown"}`);
  lines.push(`- Platform: ${report.environment?.platform ?? "unknown"}/${report.environment?.arch ?? "unknown"}`);
  lines.push(`- Working directory: \`${report.environment?.cwd ?? "unknown"}\``, "");

  if (report.schema) {
    lines.push("## Installed-version schema", "");
    lines.push(`- Fingerprint: \`${report.schema.fingerprint}\``);
    lines.push(`- Files: ${report.schema.fileCount}`);
    lines.push(`- Bytes: ${report.schema.bytes}`);
    lines.push(`- Required method strings missing from scan: ${report.schema.requiredMethodsMissing.join(", ") || "none"}`, "");
  }

  lines.push("## Streaming measurements", "");
  if (report.benchmark.length === 0) {
    lines.push("No completed benchmark turn was recorded.", "");
  }
  for (const [index, item] of report.benchmark.entries()) {
    lines.push(`### Turn ${index + 1}`, "");
    lines.push(`- Thread: \`${item.threadId}\``);
    lines.push(`- Turn: \`${item.turnId}\``);
    lines.push(`- Request → first agent delta: ${formatNumber(item.requestToFirstAgentDeltaMs)} ms`);
    lines.push(`- Turn duration: ${formatNumber(item.turnDurationMs)} ms`);
    lines.push(`- Agent-message deltas: ${item.agentMessageDeltas}`);
    lines.push(`- Average delta rate: ${formatNumber(item.averageAgentDeltasPerSecond)} /s`);
    lines.push(`- Peak delta rate, rolling 1 s: ${item.peakAgentDeltasPerSecond} /s`);
    lines.push(`- Peak deltas in rolling 100 ms: ${item.peakAgentDeltasPer100ms}`);
    lines.push(`- Delta payload bytes p50/p95/max: ${formatStats(item.agentDeltaPayloadBytes)}`);
    lines.push(`- Delta inter-arrival ms p50/p95/max: ${formatStats(item.agentDeltaInterArrivalMs)}`);
    lines.push(`- Total received bytes for the turn: ${item.totalRxBytes}`, "");
  }

  lines.push("## Mid-turn kill and recovery", "");
  if (!report.killRecovery) {
    lines.push("Skipped or not completed.", "");
  } else {
    const item = report.killRecovery;
    lines.push(`- Thread: \`${item.threadId}\``);
    lines.push(`- Turn: \`${item.turnId}\``);
    lines.push(`- Kill trigger: \`${item.killReason}\``);
    lines.push(`- Agent deltas observed before kill: ${item.agentDeltasBeforeKill}`);
    lines.push(`- turn/completed observed before kill: ${item.terminalSeenBeforeKill}`);
    lines.push(`- Reconstructed status: \`${item.observedStatus ?? "not found"}\``);
    lines.push(`- thread/read error: ${item.readError ? `\`${item.readError.message}\`` : "none"}`);
    lines.push(`- thread/resume error: ${item.resumeError ? `\`${item.resumeError.message}\`` : "none"}`);
    lines.push(`- Interpretation: ${item.interpretation}`, "");
  }

  if (report.errors.length > 0) {
    lines.push("## Errors", "");
    for (const error of report.errors) lines.push(`- ${error.name}: ${error.message}`);
    lines.push("");
  }

  lines.push("## Architectural use", "");
  lines.push("Use the measured delta rate and payload distribution to set ephemeral batching and WebSocket backpressure limits. Do not derive database write throughput from raw token-delta frequency: message and command-output deltas should be ephemeral or checkpointed/coalesced, while turn boundaries, approvals, completed items, final messages, errors, and diff snapshots remain durable append-before-broadcast events.", "");
  lines.push("The kill experiment is observational. A missing terminal event is not evidence that the provider did not execute work. Any state that cannot be reconciled from provider history remains `outcome_unknown`, and the original prompt must not be resubmitted automatically.", "");
  lines.push("Raw protocol traffic is in `trace.jsonl`; the generated schema snapshot is in `schema/`.", "");
  return `${lines.join("\n")}\n`;
}

function isRecordForTurn(record, threadId, turnId) {
  const params = record.message?.params;
  const recordThreadId = params?.threadId ?? params?.thread?.id ?? null;
  const recordTurnId = params?.turnId ?? params?.turn?.id ?? null;
  const threadMatches = recordThreadId == null || sameId(recordThreadId, threadId);
  const turnMatches = recordTurnId == null || sameId(recordTurnId, turnId);
  return threadMatches && turnMatches;
}

function sameId(left, right) {
  return left != null && right != null && String(left) === String(right);
}

function consecutiveDiffs(values) {
  const result = [];
  for (let i = 1; i < values.length; i += 1) result.push(values[i] - values[i - 1]);
  return result;
}

function peakEventsInWindow(times, windowMs) {
  let peak = 0;
  let left = 0;
  for (let right = 0; right < times.length; right += 1) {
    while (times[right] - times[left] > windowMs) left += 1;
    peak = Math.max(peak, right - left + 1);
  }
  return peak;
}

function stats(values) {
  if (values.length === 0) return { count: 0, min: null, p50: null, p95: null, p99: null, max: null, mean: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    min: round(sorted[0]),
    p50: round(percentile(sorted, 0.50)),
    p95: round(percentile(sorted, 0.95)),
    p99: round(percentile(sorted, 0.99)),
    max: round(sorted.at(-1)),
    mean: round(values.reduce((sum, value) => sum + value, 0) / values.length),
  };
}

function percentile(sorted, fraction) {
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function walkFiles(directory) {
  const result = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) result.push(...walkFiles(path));
    else if (stat.isFile()) result.push(path);
  }
  return result.sort();
}

function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    stack: error?.stack ?? null,
    rpc: error?.rpc ?? null,
  };
}

function positiveInt(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function nonNegativeInt(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative integer`);
  return parsed;
}

function timestampForPath() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function round(value) {
  return value == null || !Number.isFinite(value) ? null : Math.round(value * 100) / 100;
}

function formatNumber(value) {
  return value == null ? "n/a" : String(value);
}

function formatStats(value) {
  if (!value || value.count === 0) return "n/a";
  return `${value.p50}/${value.p95}/${value.max}`;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

void main();
