import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { extname } from "node:path";

import { redactSensitiveText } from "@aicl/protocol";

import { BoundedLineFramer, parseJsonLine } from "./line-framer.js";
import { platformCommand } from "./command.js";

type JsonRecord = Record<string, unknown>;
type NotificationListener = (message: JsonRecord) => void;
type ServerRequestListener = (message: JsonRecord) => boolean;
type ExitListener = (exit: { code: number | null; signal: NodeJS.Signals | null }) => void;
type FaultListener = (error: Error) => void;

export class ProviderRpcError extends Error {
  constructor(
    readonly method: string,
    readonly rpcError: unknown,
  ) {
    super(`${method}: provider returned a JSON-RPC error`);
    this.name = "ProviderRpcError";
  }
}

export class ProviderRpcTimeoutError extends Error {
  constructor(readonly method: string, readonly timeoutMs: number) {
    super(`${method} timed out after ${timeoutMs} ms`);
    this.name = "ProviderRpcTimeoutError";
  }
}

const PROVIDER_ENVIRONMENT_KEYS = [
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "CODEX_HOME",
] as const;

export function buildProviderEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    NO_COLOR: "1",
    LOG_FORMAT: "json",
  };
  for (const key of PROVIDER_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

interface PendingRequest {
  method: string;
  timer: NodeJS.Timeout;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class RpcRequestBroker {
  #nextId = 1;
  readonly #pending = new Map<number, PendingRequest>();

  request(
    method: string,
    params: unknown,
    timeoutMs: number,
    write: (message: JsonRecord) => void,
  ): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new ProviderRpcTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.#pending.set(id, { method, timer, resolve, reject });
      write(params === undefined ? { id, method } : { id, method, params });
    });
  }

  settle(message: JsonRecord): boolean {
    if (typeof message.id !== "number" || typeof message.method === "string") {
      return false;
    }
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return false;
    clearTimeout(pending.timer);
    this.#pending.delete(message.id);
    if ("error" in message) {
      pending.reject(new ProviderRpcError(pending.method, message.error));
    } else {
      pending.resolve(message.result);
    }
    return true;
  }

  rejectAll(error: Error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

export interface CodexRpcProcessOptions {
  command?: string;
  cwd: string;
  timeoutMs?: number;
  maxLineBytes?: number;
}

export class CodexRpcProcess {
  readonly #broker = new RpcRequestBroker();
  readonly #notifications = new Set<NotificationListener>();
  readonly #serverRequests = new Set<ServerRequestListener>();
  readonly #exits = new Set<ExitListener>();
  readonly #faults = new Set<FaultListener>();
  readonly #stderr: string[] = [];
  readonly #options: Required<CodexRpcProcessOptions>;
  #child: ChildProcessWithoutNullStreams | undefined;
  #exitPromise: Promise<void> = Promise.resolve();

  constructor(options: CodexRpcProcessOptions) {
    this.#options = {
      command: options.command ?? process.env.AICL_CODEX_COMMAND ?? "codex",
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? 180_000,
      maxLineBytes: options.maxLineBytes ?? 8 * 1024 * 1024,
    };
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  get stderrTail(): readonly string[] {
    return this.#stderr;
  }

  onNotification(listener: NotificationListener) {
    this.#notifications.add(listener);
    return () => this.#notifications.delete(listener);
  }

  onServerRequest(listener: ServerRequestListener) {
    this.#serverRequests.add(listener);
    return () => this.#serverRequests.delete(listener);
  }

  onExit(listener: ExitListener) {
    this.#exits.add(listener);
    return () => this.#exits.delete(listener);
  }

  onProtocolFault(listener: FaultListener) {
    this.#faults.add(listener);
    return () => this.#faults.delete(listener);
  }

  async start() {
    if (this.#child !== undefined) throw new Error("Codex process already started");
    const commandIsScript = [".js", ".mjs", ".cjs"].includes(
      extname(this.#options.command).toLowerCase(),
    );
    const invocation = platformCommand(
      commandIsScript ? process.execPath : this.#options.command,
      [
        ...(commandIsScript ? [this.#options.command] : []),
        "app-server",
        "--stdio",
      ],
      commandIsScript ? "direct" : process.platform,
    );
    const child = spawn(
      invocation.command,
      invocation.args,
      {
        cwd: this.#options.cwd,
        env: buildProviderEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
        shell: invocation.shell,
      },
    );
    this.#child = child;
    const framer = new BoundedLineFramer(this.#options.maxLineBytes);

    child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const line of framer.push(chunk)) this.#handleLine(line);
      } catch (error) {
        this.#reportFault(error);
        void this.killTree();
      }
    });
    child.stdout.on("end", () => {
      try {
        for (const line of framer.finish()) this.#handleLine(line);
      } catch (error) {
        this.#reportFault(error);
      }
    });
    const stderrFramer = new BoundedLineFramer(64 * 1024);
    child.stderr.on("data", (chunk: Buffer) => {
      try {
        for (const line of stderrFramer.push(chunk)) {
          this.#stderr.push(redactSensitiveText(line));
          if (this.#stderr.length > 50) this.#stderr.shift();
        }
      } catch {
        this.#stderr.push("[stderr line exceeded limit]");
      }
    });

    this.#exitPromise = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        this.#broker.rejectAll(
          new Error(
            `Codex app-server exited (code=${String(code)}, signal=${String(signal)})`,
          ),
        );
        for (const listener of this.#exits) listener({ code, signal });
        resolve();
      });
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }

  async initialize() {
    const result = await this.request("initialize", {
      clientInfo: {
        name: "aicl_mission_control",
        title: "AICL Mission Control",
        version: "0.1.0",
      },
    });
    this.notify("initialized");
    return result;
  }

  async request(method: string, params?: unknown) {
    try {
      return await this.#broker.request(
        method,
        params,
        this.#options.timeoutMs,
        (message) => this.#write(message),
      );
    } catch (error) {
      if (error instanceof ProviderRpcTimeoutError) void this.killTree();
      throw error;
    }
  }

  notify(method: string, params?: unknown) {
    this.#write(params === undefined ? { method } : { method, params });
  }

  respond(id: string | number, result: unknown) {
    this.#write({ id, result });
  }

  async stop() {
    const child = this.#child;
    if (child === undefined || child.exitCode !== null) return;
    child.stdin.end();
    await Promise.race([
      this.#exitPromise,
      new Promise((resolve) => setTimeout(resolve, 750)),
    ]);
    if (child.exitCode === null && child.signalCode === null) await this.killTree();
  }

  async killTree() {
    const child = this.#child;
    if (child?.pid === undefined || child.exitCode !== null) return;
    terminateProcessTree(child.pid);
    await Promise.race([
      this.#exitPromise,
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }

  #write(message: JsonRecord) {
    if (this.#child?.stdin.writable !== true) {
      throw new Error("Codex app-server stdin is not writable");
    }
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line: string) {
    const parsed = parseJsonLine(line);
    if (!parsed.ok) {
      this.#reportFault(new Error(`Malformed provider JSON: ${parsed.error.message}`));
      void this.killTree();
      return;
    }
    if (parsed.value === null || typeof parsed.value !== "object") {
      this.#reportFault(new Error("Provider JSON-RPC payload must be an object"));
      void this.killTree();
      return;
    }
    const message = parsed.value as JsonRecord;
    if (this.#broker.settle(message)) return;
    if (typeof message.method === "string" && "id" in message) {
      this.#handleServerRequest(message);
      return;
    }
    if (typeof message.method === "string") {
      for (const listener of this.#notifications) listener(message);
    }
  }

  #handleServerRequest(message: JsonRecord) {
    const id = message.id;
    const method = String(message.method);
    for (const listener of this.#serverRequests) {
      try {
        if (listener(message)) return;
      } catch (error) {
        this.#reportFault(error);
        this.#write({
          id,
          error: { code: -32602, message: "Invalid provider approval request" },
        });
        return;
      }
    }
    if (method === "currentTime/read") {
      this.#write({ id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } });
      return;
    }
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    ) {
      this.#write({ id, result: { decision: "decline" } });
      return;
    }
    if (method === "mcpServer/elicitation/request") {
      this.#write({ id, result: { action: "decline", content: null } });
      return;
    }
    this.#write({
      id,
      error: { code: -32601, message: `Unsupported server request: ${method}` },
    });
  }

  #reportFault(error: unknown) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    for (const listener of this.#faults) listener(normalized);
  }
}

export function terminateProcessTree(pid: number) {
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    process.kill(pid, "SIGKILL");
  }
}
