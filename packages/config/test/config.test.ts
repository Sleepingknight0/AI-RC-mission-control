import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  AICL_CONFIG_VERSION,
  loadAiclConfig,
  type AiclConfig,
} from "../src/index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const configEntryPoint = join(packageRoot, "src", "index.ts");
const tsxCli = join(repositoryRoot, "node_modules/tsx/dist/cli.mjs");

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("persistent AICL configuration", () => {
  it("creates a versioned LocalAppData config and canonical operational paths", () => {
    const fixture = makeFixture();

    const loaded = loadAiclConfig({
      repositoryRoot: fixture.repository,
      homeDirectory: fixture.home,
      env: { LOCALAPPDATA: fixture.localAppData },
    });

    expect(loaded.configPath.toLowerCase()).toBe(
      realpathSync
        .native(join(fixture.localAppData, "AICL Mission Control", "config.json"))
        .toLowerCase(),
    );
    expect(loaded.config).toMatchObject({
      version: AICL_CONFIG_VERSION,
      core: {
        host: "127.0.0.1",
        port: 8787,
        allowedBrowserOrigins: [
          "http://127.0.0.1:8787",
          "http://127.0.0.1:5173",
          "http://localhost:5173",
        ],
      },
      connector: { healthPort: 8788 },
      provider: {
        name: "codex",
        profile: "default",
        codexHome: realpathSync.native(fixture.codexHome),
      },
      workspace: {
        allowedRoots: [realpathSync.native(fixture.repository)],
        defaultProject: realpathSync.native(fixture.repository),
      },
      paths: {
        coreDatabase: join(loaded.applicationRoot, "data", "aicl-core.db"),
        connectorDatabase: join(
          loaded.applicationRoot,
          "data",
          "aicl-connector.db",
        ),
        logs: join(loaded.applicationRoot, "logs"),
        backups: join(loaded.applicationRoot, "backups"),
      },
    });
    // The effective Core origin is derived at load time, never persisted, so
    // changing core.port cannot strand the same-origin production host.
    const persisted = JSON.parse(
      readFileSync(loaded.configPath, "utf8"),
    ) as AiclConfig;
    expect(persisted.core.allowedBrowserOrigins).toEqual([
      "http://127.0.0.1:5173",
      "http://localhost:5173",
    ]);
    expect(persisted).toEqual({
      ...loaded.config,
      core: {
        ...loaded.config.core,
        allowedBrowserOrigins: persisted.core.allowedBrowserOrigins,
      },
    });
  });

  it("derives the effective Core origin after a port change", () => {
    const fixture = makeFixture();
    loadFixture(fixture);

    const moved = loadAiclConfig({
      repositoryRoot: fixture.repository,
      homeDirectory: fixture.home,
      env: { LOCALAPPDATA: fixture.localAppData, AICL_CORE_PORT: "9099" },
    });

    expect(moved.config.core.allowedBrowserOrigins[0]).toBe(
      "http://127.0.0.1:9099",
    );
    expect(moved.config.core.allowedBrowserOrigins).not.toContain(
      "http://127.0.0.1:8787",
    );
  });

  it("applies development overrides without persisting them", () => {
    const fixture = makeFixture();
    const first = loadAiclConfig({
      repositoryRoot: fixture.repository,
      homeDirectory: fixture.home,
      env: { LOCALAPPDATA: fixture.localAppData },
    });
    const secondRoot = join(fixture.base, "second-root");
    const secondProject = join(secondRoot, "project");
    const alternateCodexHome = join(fixture.home, ".codex-alt");
    mkdirSync(secondProject, { recursive: true });
    mkdirSync(alternateCodexHome);
    const customData = join(fixture.base, "custom-data");

    const overridden = loadAiclConfig({
      repositoryRoot: fixture.repository,
      homeDirectory: fixture.home,
      env: {
        LOCALAPPDATA: fixture.localAppData,
        AICL_CORE_HOST: "::1",
        AICL_CORE_PORT: "9797",
        AICL_BROWSER_ORIGINS: "http://127.0.0.1:4173, https://mission.example.ts.net",
        AICL_CONNECTOR_PORT: "9898",
        AICL_PROVIDER: "mock",
        AICL_CODEX_PROFILE: "alternate",
        CODEX_HOME: alternateCodexHome,
        AICL_PROJECT_ROOTS: [fixture.repository, secondRoot].join(delimiter),
        AICL_PROJECT_PATH: secondProject,
        AICL_CORE_DB_PATH: join(customData, "core.db"),
        AICL_CONNECTOR_DB_PATH: join(customData, "connector.db"),
        AICL_LOG_DIR: join(fixture.base, "custom-logs"),
        AICL_BACKUP_DIR: join(fixture.base, "custom-backups"),
      },
    });

    expect(overridden.config).toMatchObject({
      core: {
        host: "::1",
        port: 9797,
        allowedBrowserOrigins: [
          "http://[::1]:9797",
          "http://127.0.0.1:4173",
          "https://mission.example.ts.net",
        ],
      },
      connector: { healthPort: 9898 },
      provider: {
        name: "mock",
        profile: "alternate",
        codexHome: realpathSync.native(alternateCodexHome),
      },
      workspace: { defaultProject: realpathSync.native(secondProject) },
      paths: {
        coreDatabase: join(realpathSync.native(customData), "core.db"),
        connectorDatabase: join(realpathSync.native(customData), "connector.db"),
        logs: realpathSync.native(join(fixture.base, "custom-logs")),
        backups: realpathSync.native(join(fixture.base, "custom-backups")),
      },
    });
    const stillPersisted = JSON.parse(
      readFileSync(first.configPath, "utf8"),
    ) as AiclConfig;
    expect(stillPersisted.core.port).toBe(8787);
    expect(stillPersisted.connector.healthPort).toBe(8788);
    expect(stillPersisted.core.allowedBrowserOrigins).toEqual([
      "http://127.0.0.1:5173",
      "http://localhost:5173",
    ]);
  });

  it("rejects unknown credential fields without echoing their values", () => {
    const fixture = makeFixture();
    const loaded = loadAiclConfig({
      repositoryRoot: fixture.repository,
      homeDirectory: fixture.home,
      env: { LOCALAPPDATA: fixture.localAppData },
    });
    const persisted = JSON.parse(readFileSync(loaded.configPath, "utf8")) as {
      provider: Record<string, unknown>;
    };
    persisted.provider.apiKey = "DO_NOT_ECHO_THIS_SECRET";
    writeFileSync(loaded.configPath, JSON.stringify(persisted));

    expect(() =>
      loadAiclConfig({
        repositoryRoot: fixture.repository,
        homeDirectory: fixture.home,
        env: { LOCALAPPDATA: fixture.localAppData },
      }),
    ).toThrowError(
      expect.objectContaining({
        message: expect.not.stringContaining("DO_NOT_ECHO_THIS_SECRET"),
      }),
    );
  });

  it("rejects unsupported versions, non-loopback hosts, and relative paths", () => {
    const fixture = makeFixture();
    const loaded = loadAiclConfig({
      repositoryRoot: fixture.repository,
      homeDirectory: fixture.home,
      env: { LOCALAPPDATA: fixture.localAppData },
    });
    const persisted = JSON.parse(
      readFileSync(loaded.configPath, "utf8"),
    ) as Record<string, unknown>;

    writeFileSync(loaded.configPath, JSON.stringify({ ...persisted, version: 2 }));
    expect(() => loadFixture(fixture)).toThrow("Unsupported AICL config version");

    writeFileSync(
      loaded.configPath,
      JSON.stringify({
        ...persisted,
        core: {
          ...(persisted.core as Record<string, unknown>),
          host: "0.0.0.0",
        },
      }),
    );
    expect(() => loadFixture(fixture)).toThrow("Invalid AICL config");

    writeFileSync(
      loaded.configPath,
      JSON.stringify({
        ...persisted,
        paths: {
          ...(persisted.paths as Record<string, unknown>),
          coreDatabase: "relative/core.db",
        },
      }),
    );
    expect(() => loadFixture(fixture)).toThrow("must be an absolute local path");
  });

  it("rejects a default project that escapes an allowed root through a junction", () => {
    const fixture = makeFixture();
    const loaded = loadAiclConfig({
      repositoryRoot: fixture.repository,
      homeDirectory: fixture.home,
      env: { LOCALAPPDATA: fixture.localAppData },
    });
    const outside = join(fixture.base, "outside");
    const linked = join(fixture.repository, "linked-outside");
    mkdirSync(outside);
    symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
    const persisted = JSON.parse(readFileSync(loaded.configPath, "utf8")) as {
      workspace: Record<string, unknown>;
    };
    persisted.workspace.defaultProject = linked;
    writeFileSync(loaded.configPath, JSON.stringify(persisted));

    expect(() => loadFixture(fixture)).toThrow(
      "outside the configured allowlist",
    );
  });

  it("keeps the Core and Connector databases physically separate", () => {
    const fixture = makeFixture();
    const loaded = loadFixture(fixture);
    const persisted = JSON.parse(readFileSync(loaded.configPath, "utf8")) as {
      paths: Record<string, unknown>;
    };
    persisted.paths.connectorDatabase = persisted.paths.coreDatabase;
    writeFileSync(loaded.configPath, JSON.stringify(persisted));

    expect(() => loadFixture(fixture)).toThrow(
      "Core and Connector database paths must be different",
    );
  });

  it("keeps Core and Connector listening ports distinct", () => {
    const fixture = makeFixture();
    loadFixture(fixture);

    expect(() =>
      loadAiclConfig({
        repositoryRoot: fixture.repository,
        homeDirectory: fixture.home,
        env: {
          LOCALAPPDATA: fixture.localAppData,
          AICL_CONNECTOR_PORT: "8787",
        },
      }),
    ).toThrow("Core and Connector health ports must be different");
  });

  it("rejects browser origins that are not exact http(s) origins", () => {
    const fixture = makeFixture();
    loadFixture(fixture);

    for (const origin of [
      "http://127.0.0.1:5173/",
      "http://127.0.0.1:5173/app",
      "*",
      "ws://127.0.0.1:5173",
      "127.0.0.1:5173",
    ]) {
      expect(() =>
        loadAiclConfig({
          repositoryRoot: fixture.repository,
          homeDirectory: fixture.home,
          env: {
            LOCALAPPDATA: fixture.localAppData,
            AICL_BROWSER_ORIGINS: origin,
          },
        }),
      ).toThrow("Invalid AICL config");
    }
  });

  it("reuses an existing config on repeated startup without rewriting it", () => {
    const fixture = makeFixture();
    const first = loadFixture(fixture);
    const firstRaw = readFileSync(first.configPath, "utf8");
    const firstStat = statSync(first.configPath);

    const second = loadFixture(fixture);

    expect(second.config).toEqual(first.config);
    expect(readFileSync(second.configPath, "utf8")).toBe(firstRaw);
    expect(statSync(second.configPath).mtimeMs).toBe(firstStat.mtimeMs);
  });

  it("reports invalid JSON without falling back to defaults", () => {
    const fixture = makeFixture();
    const loaded = loadFixture(fixture);
    writeFileSync(loaded.configPath, "{ not valid json");

    expect(() => loadFixture(fixture)).toThrow("AICL config is not valid JSON");
  });

  it("fails with an actionable error when required directories are missing", () => {
    const fixture = makeFixture();

    expect(() =>
      loadAiclConfig({
        repositoryRoot: fixture.repository,
        homeDirectory: fixture.home,
        env: {},
      }),
    ).toThrow("LOCALAPPDATA is required");

    const homeWithoutCodex = join(fixture.base, "home-without-codex");
    mkdirSync(homeWithoutCodex);
    expect(() =>
      loadAiclConfig({
        repositoryRoot: fixture.repository,
        homeDirectory: homeWithoutCodex,
        env: { LOCALAPPDATA: join(fixture.base, "fresh-app-data") },
      }),
    ).toThrow(/Codex home/u);
  });

  it("creates exactly one config when processes start concurrently", async () => {
    const fixture = makeFixture();
    const loaderScript = join(fixture.base, "load-config.ts");
    writeFileSync(
      loaderScript,
      [
        `import { loadAiclConfig } from ${JSON.stringify(configEntryPoint)};`,
        `const loaded = loadAiclConfig({`,
        `  repositoryRoot: ${JSON.stringify(fixture.repository)},`,
        `  homeDirectory: ${JSON.stringify(fixture.home)},`,
        `  env: { LOCALAPPDATA: ${JSON.stringify(fixture.localAppData)} },`,
        `});`,
        `process.stdout.write(JSON.stringify(loaded.config));`,
      ].join("\n"),
    );

    const results = await Promise.all(
      Array.from({ length: 4 }, () => runLoader(loaderScript)),
    );

    const applicationRoot = join(fixture.localAppData, "AICL Mission Control");
    for (const result of results) {
      expect(result.code, result.output).toBe(0);
    }
    const configs = results.map((result) => result.output);
    expect(new Set(configs).size).toBe(1);
    expect(
      readdirSync(applicationRoot).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
    expect(readdirSync(applicationRoot)).toContain("config.json");
  });
});

interface Fixture {
  base: string;
  repository: string;
  home: string;
  codexHome: string;
  localAppData: string;
}

function makeFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), "aicl-config-"));
  temporaryDirectories.push(base);
  const repository = join(base, "repository");
  const home = join(base, "home");
  const codexHome = join(home, ".codex");
  const localAppData = join(base, "local-app-data");
  mkdirSync(repository);
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(localAppData);
  return { base, repository, home, codexHome, localAppData };
}

function runLoader(scriptPath: string) {
  return new Promise<{ code: number | null; output: string }>((resolvePromise) => {
    const child = spawn(process.execPath, [tsxCli, scriptPath], {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.once("exit", (code) => resolvePromise({ code, output }));
  });
}

function loadFixture(fixture: Fixture) {
  return loadAiclConfig({
    repositoryRoot: fixture.repository,
    homeDirectory: fixture.home,
    env: { LOCALAPPDATA: fixture.localAppData },
  });
}
