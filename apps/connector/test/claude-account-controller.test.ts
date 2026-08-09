import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ClaudeAccountController } from "../src/claude/account-controller.js";
import type { ClaudeCliRunner } from "../src/claude/cli.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Claude Code measured inventory adapter", () => {
  it("discovers bounded account-scoped Sessions but advertises no unproven control", async () => {
    const registryRoot = temporaryDirectory("claude-registry");
    const profilePath = temporaryDirectory("claude-profile");
    const workspace = temporaryDirectory("claude-workspace");
    const providerRoot = join(registryRoot, "providers", "claude");
    mkdirSync(join(providerRoot, "accounts", "work"), { recursive: true });
    writeFileSync(
      join(providerRoot, "provider.json"),
      JSON.stringify({ id: "claude", displayName: "Claude Code", enabled: true }),
    );
    writeFileSync(
      join(providerRoot, "accounts", "work", "profile.json"),
      JSON.stringify({ id: "work", displayName: "Work", profilePath }),
    );
    const runner: ClaudeCliRunner = ({ args }) => {
      if (args.join(" ") === "auth status --json") {
        return { ok: true, stdout: JSON.stringify({ loggedIn: true }) };
      }
      if (args.join(" ") === "agents --json --all") {
        return {
          ok: true,
          stdout: JSON.stringify([
            {
              pid: 123,
              cwd: workspace,
              kind: "background",
              startedAt: Date.parse("2026-08-10T00:00:00.000Z"),
              sessionId: "11111111-1111-4111-8111-111111111111",
              name: "Review workspace",
              status: "idle",
            },
          ]),
        };
      }
      return { ok: false, stdout: "" };
    };
    const controller = new ClaudeAccountController({
      cwd: workspace,
      allowedRoots: [workspace],
      registryRoot,
      runner,
    });
    const account = controller.open("claude", "work");
    expect(account).not.toBeNull();
    if (account === null) throw new Error("Expected Claude account");

    const capabilities = await account.capabilities(1, false);
    const state = (key: string) =>
      capabilities.capabilities.find((item) => item.key === key)?.state;
    expect(capabilities.authentication).toBe("authenticated");
    expect(capabilities.control).toBe("inventory_only");
    expect(state("list_sessions")).toBe("supported");
    expect(state("read_history")).toBe("unsupported");
    expect(state("observe_live")).toBe("unsupported");
    expect(state("resume_session")).toBe("unsupported");
    expect(state("submit_turn")).toBe("unsupported");
    expect(state("interrupt_turn")).toBe("unsupported");

    const page = await controller.nativeSessionPage(account, {
      providerId: "claude",
      accountId: "work",
      pageSize: 20,
      cursor: null,
      search: null,
      archived: "exclude",
    });
    expect(page.sessions).toEqual([
      expect.objectContaining({
        providerId: "claude",
        accountId: "work",
        providerSessionId: "11111111-1111-4111-8111-111111111111",
        providerStatus: "idle",
        projectName: expect.any(String),
        canResume: false,
      }),
    ]);
    expect(JSON.stringify(page)).not.toContain(profilePath);
  });

  it("drops Sessions outside allowed roots and fails stale account evidence closed", async () => {
    const registryRoot = temporaryDirectory("claude-registry");
    const profilePath = temporaryDirectory("claude-profile");
    const workspace = temporaryDirectory("claude-workspace");
    const outside = temporaryDirectory("claude-outside");
    const providerRoot = join(registryRoot, "providers", "claude");
    mkdirSync(join(providerRoot, "accounts", "work"), { recursive: true });
    writeFileSync(join(providerRoot, "provider.json"), JSON.stringify({
      id: "claude", enabled: true,
    }));
    writeFileSync(
      join(providerRoot, "accounts", "work", "profile.json"),
      JSON.stringify({ id: "work", profilePath }),
    );
    const runner: ClaudeCliRunner = ({ args }) =>
      args[0] === "auth"
        ? { ok: false, stdout: "" }
        : {
            ok: true,
            stdout: JSON.stringify([{
              pid: 321,
              cwd: outside,
              kind: "interactive",
              startedAt: Date.now(),
              sessionId: "22222222-2222-4222-8222-222222222222",
              name: "Outside",
              status: "active",
            }]),
          };
    const controller = new ClaudeAccountController({
      cwd: workspace,
      allowedRoots: [workspace],
      registryRoot,
      runner,
    });
    const account = controller.open("claude", "work");
    if (account === null) throw new Error("Expected Claude account");
    expect((await account.capabilities(2, false)).freshness).toBe("unavailable");
    expect((await controller.nativeSessionPage(account, {
      providerId: "claude",
      accountId: "work",
      pageSize: 20,
      cursor: null,
      search: null,
      archived: "exclude",
    })).sessions).toEqual([]);
  });
});

function temporaryDirectory(label: string) {
  const root = mkdtempSync(join(tmpdir(), `aicl-${label}-`));
  roots.push(root);
  return root;
}
