import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { describe, expect, it } from "vitest";

import { terminateProcessTree } from "../src/codex/rpc-process.js";

describe.skipIf(process.platform !== "win32")("Windows process supervision", () => {
  it("terminates the provider process and its child tree", async () => {
    const parent = spawn(
      process.execPath,
      [
        "-e",
        "const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});console.log(c.pid);setInterval(()=>{},1000);",
      ],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    const lines = createInterface({ input: parent.stdout, crlfDelay: Infinity });
    const childPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Child PID timeout")), 2_000);
      lines.once("line", (line) => {
        clearTimeout(timer);
        resolve(Number(line));
      });
    });

    try {
      expect(isAlive(parent.pid)).toBe(true);
      expect(isAlive(childPid)).toBe(true);
      if (parent.pid === undefined) throw new Error("Parent PID missing");
      terminateProcessTree(parent.pid);
      await waitUntil(() => !isAlive(parent.pid) && !isAlive(childPid));
    } finally {
      if (parent.pid !== undefined && isAlive(parent.pid)) {
        terminateProcessTree(parent.pid);
      }
      if (isAlive(childPid)) terminateProcessTree(childPid);
    }

    expect(isAlive(parent.pid)).toBe(false);
    expect(isAlive(childPid)).toBe(false);
  });
});

function isAlive(pid: number | undefined) {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for process tree termination");
}
