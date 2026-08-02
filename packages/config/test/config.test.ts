import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AICL_CONFIG_VERSION,
  loadAiclConfig,
  type AiclConfig,
} from "../src/index.js";

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
      core: { host: "127.0.0.1", port: 8787 },
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
    expect(JSON.parse(readFileSync(loaded.configPath, "utf8"))).toEqual(
      loaded.config,
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
      core: { host: "::1", port: 9797 },
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
    expect(
      (JSON.parse(readFileSync(first.configPath, "utf8")) as AiclConfig).core
        .port,
    ).toBe(8787);
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
      JSON.stringify({ ...persisted, core: { host: "0.0.0.0", port: 8787 } }),
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

function loadFixture(fixture: Fixture) {
  return loadAiclConfig({
    repositoryRoot: fixture.repository,
    homeDirectory: fixture.home,
    env: { LOCALAPPDATA: fixture.localAppData },
  });
}
