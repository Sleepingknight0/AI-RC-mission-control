import {
  existsSync,
  linkSync,
  lstatSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";

import { z, type ZodError } from "zod";

import {
  assertAbsoluteLocalPath,
  canonicalExistingDirectory,
  canonicalFilePath,
  canonicalProjectRoot,
  canonicalWritableDirectory,
  samePath,
} from "./paths.js";

export { canonicalProjectRoot } from "./paths.js";

export const AICL_CONFIG_VERSION = 1 as const;
export const AICL_APPLICATION_DIRECTORY = "AICL Mission Control";

const PortSchema = z.number().int().min(1).max(65_535);

const BrowserOriginSchema = z.string().min(1).refine(isExactOrigin, {
  message:
    "must be an exact http(s) origin without path, query, fragment, or trailing slash",
});

const AiclConfigSchema = z
  .object({
    version: z.literal(AICL_CONFIG_VERSION),
    core: z
      .object({
        host: z.enum(["127.0.0.1", "::1"]),
        port: PortSchema,
        allowedBrowserOrigins: z.array(BrowserOriginSchema).min(1),
      })
      .strict(),
    connector: z
      .object({
        healthPort: PortSchema,
      })
      .strict(),
    provider: z
      .object({
        name: z.enum(["codex", "mock"]),
        profile: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/u),
        codexHome: z.string().min(1),
      })
      .strict(),
    workspace: z
      .object({
        allowedRoots: z.array(z.string().min(1)).min(1),
        defaultProject: z.string().min(1),
      })
      .strict(),
    paths: z
      .object({
        coreDatabase: z.string().min(1),
        connectorDatabase: z.string().min(1),
        logs: z.string().min(1),
        backups: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export type AiclConfig = z.infer<typeof AiclConfigSchema>;

export interface LoadedAiclConfig {
  config: AiclConfig;
  configPath: string;
  applicationRoot: string;
}

export interface LoadAiclConfigOptions {
  repositoryRoot: string;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
  homeDirectory?: string;
}

export function loadAiclConfig(
  options: LoadAiclConfigOptions,
): LoadedAiclConfig {
  const env = options.env ?? process.env;
  const requestedConfigPath =
    options.configPath ?? env.AICL_CONFIG_PATH ?? defaultConfigPath(env);
  assertAbsoluteLocalPath(requestedConfigPath, "AICL config path");
  const applicationRoot = canonicalWritableDirectory(
    dirname(requestedConfigPath),
    "AICL application directory",
  );
  const configPath = join(applicationRoot, basename(requestedConfigPath));
  rejectLinkedConfig(configPath);

  if (!existsSync(configPath)) {
    const defaults = defaultConfig({
      applicationRoot,
      repositoryRoot: options.repositoryRoot,
      homeDirectory: options.homeDirectory ?? homedir(),
    });
    persistDefaultConfig(configPath, defaults);
  }

  const persisted = parseConfig(configPath);
  const overridden = parseCandidate(applyEnvironmentOverrides(persisted, env));
  return {
    config: canonicalizeConfig(overridden),
    configPath,
    applicationRoot,
  };
}

function defaultConfigPath(env: NodeJS.ProcessEnv) {
  const localAppData = env.LOCALAPPDATA;
  if (localAppData === undefined || localAppData.trim() === "") {
    throw new Error("LOCALAPPDATA is required when AICL_CONFIG_PATH is not set");
  }
  assertAbsoluteLocalPath(localAppData, "LOCALAPPDATA");
  return join(localAppData, AICL_APPLICATION_DIRECTORY, "config.json");
}

function defaultConfig(input: {
  applicationRoot: string;
  repositoryRoot: string;
  homeDirectory: string;
}): AiclConfig {
  const repositoryRoot = canonicalExistingDirectory(
    input.repositoryRoot,
    "repository root",
  );
  const codexHome = canonicalExistingDirectory(
    join(input.homeDirectory, ".codex"),
    "Codex home",
  );
  return {
    version: AICL_CONFIG_VERSION,
    core: {
      host: "127.0.0.1",
      port: 8787,
      allowedBrowserOrigins: [
        "http://127.0.0.1:5173",
        "http://localhost:5173",
      ],
    },
    connector: { healthPort: 8788 },
    provider: { name: "codex", profile: "default", codexHome },
    workspace: {
      allowedRoots: [repositoryRoot],
      defaultProject: repositoryRoot,
    },
    paths: {
      coreDatabase: join(input.applicationRoot, "data", "aicl-core.db"),
      connectorDatabase: join(
        input.applicationRoot,
        "data",
        "aicl-connector.db",
      ),
      logs: join(input.applicationRoot, "logs"),
      backups: join(input.applicationRoot, "backups"),
    },
  };
}

function parseConfig(configPath: string) {
  let candidate: unknown;
  try {
    candidate = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  } catch {
    throw new Error(`AICL config is not valid JSON: ${configPath}`);
  }
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    "version" in candidate &&
    candidate.version !== AICL_CONFIG_VERSION
  ) {
    throw new Error(
      `Unsupported AICL config version; expected ${AICL_CONFIG_VERSION}`,
    );
  }
  return parseCandidate(candidate);
}

function parseCandidate(candidate: unknown): AiclConfig {
  const result = AiclConfigSchema.safeParse(candidate);
  if (!result.success) throw invalidConfigError(result.error);
  return result.data;
}

function invalidConfigError(error: ZodError) {
  const locations = [
    ...new Set(
      error.issues.map((issue) =>
        issue.path.length === 0 ? "root" : issue.path.join("."),
      ),
    ),
  ];
  return new Error(`Invalid AICL config at ${locations.join(", ")}`);
}

function applyEnvironmentOverrides(
  config: AiclConfig,
  env: NodeJS.ProcessEnv,
): AiclConfig {
  const overridden: AiclConfig = {
    ...config,
    core: {
      ...config.core,
      allowedBrowserOrigins: [...config.core.allowedBrowserOrigins],
    },
    connector: { ...config.connector },
    provider: { ...config.provider },
    workspace: {
      ...config.workspace,
      allowedRoots: [...config.workspace.allowedRoots],
    },
    paths: { ...config.paths },
  };

  if (env.AICL_CORE_HOST !== undefined) {
    overridden.core.host = env.AICL_CORE_HOST as AiclConfig["core"]["host"];
  }
  if (env.AICL_CORE_PORT !== undefined) {
    overridden.core.port = Number(env.AICL_CORE_PORT);
  }
  if (env.AICL_BROWSER_ORIGINS !== undefined) {
    overridden.core.allowedBrowserOrigins = env.AICL_BROWSER_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean);
  }
  if (env.AICL_CONNECTOR_PORT !== undefined) {
    overridden.connector.healthPort = Number(env.AICL_CONNECTOR_PORT);
  }
  if (env.AICL_PROVIDER !== undefined) {
    overridden.provider.name =
      env.AICL_PROVIDER as AiclConfig["provider"]["name"];
  }
  if (env.AICL_CODEX_PROFILE !== undefined) {
    overridden.provider.profile = env.AICL_CODEX_PROFILE;
  }
  if (env.CODEX_HOME !== undefined) {
    overridden.provider.codexHome = env.CODEX_HOME;
  }
  if (env.AICL_PROJECT_ROOTS !== undefined) {
    overridden.workspace.allowedRoots = env.AICL_PROJECT_ROOTS
      .split(delimiter)
      .map((path) => path.trim())
      .filter(Boolean);
  }
  if (env.AICL_PROJECT_PATH !== undefined) {
    overridden.workspace.defaultProject = env.AICL_PROJECT_PATH;
  }
  if (env.AICL_CORE_DB_PATH !== undefined) {
    overridden.paths.coreDatabase = env.AICL_CORE_DB_PATH;
  }
  if (env.AICL_CONNECTOR_DB_PATH !== undefined) {
    overridden.paths.connectorDatabase = env.AICL_CONNECTOR_DB_PATH;
  }
  if (env.AICL_LOG_DIR !== undefined) {
    overridden.paths.logs = env.AICL_LOG_DIR;
  }
  if (env.AICL_BACKUP_DIR !== undefined) {
    overridden.paths.backups = env.AICL_BACKUP_DIR;
  }
  return overridden;
}

function canonicalizeConfig(config: AiclConfig): AiclConfig {
  const allowedRoots = [
    ...new Map(
      config.workspace.allowedRoots.map((root) => {
        const canonical = canonicalExistingDirectory(
          root,
          "allowed project root",
        );
        const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
        return [key, canonical];
      }),
    ).values(),
  ];
  const defaultProject = canonicalProjectRoot(
    config.workspace.defaultProject,
    allowedRoots,
  );
  const coreDatabase = canonicalFilePath(
    config.paths.coreDatabase,
    "Core database path",
  );
  const connectorDatabase = canonicalFilePath(
    config.paths.connectorDatabase,
    "Connector database path",
  );
  if (samePath(coreDatabase, connectorDatabase)) {
    throw new Error("Core and Connector database paths must be different");
  }
  if (config.core.port === config.connector.healthPort) {
    throw new Error("Core and Connector health ports must be different");
  }

  return {
    ...config,
    core: {
      ...config.core,
      // The same-origin production host (M8.1) is only reachable when the Core
      // origin itself is allowed, so admit it regardless of operator edits to
      // the port. Operator entries are preserved for split-origin development.
      allowedBrowserOrigins: [
        ...new Set([
          httpOrigin(config.core.host, config.core.port),
          ...config.core.allowedBrowserOrigins,
        ]),
      ],
    },
    provider: {
      ...config.provider,
      codexHome: canonicalExistingDirectory(
        config.provider.codexHome,
        "Codex home",
      ),
    },
    workspace: { allowedRoots, defaultProject },
    paths: {
      coreDatabase,
      connectorDatabase,
      logs: canonicalWritableDirectory(config.paths.logs, "log directory"),
      backups: canonicalWritableDirectory(
        config.paths.backups,
        "backup directory",
      ),
    },
  };
}

function persistDefaultConfig(configPath: string, config: AiclConfig) {
  const temporaryPath = `${configPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  try {
    try {
      linkSync(temporaryPath, configPath);
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
    }
  } finally {
    unlinkSync(temporaryPath);
  }
}

function rejectLinkedConfig(configPath: string) {
  if (existsSync(configPath) && lstatSync(configPath).isSymbolicLink()) {
    throw new Error("AICL config file must not be a symbolic link or junction");
  }
}

/** Bare IPv6 literals must be bracketed to form a valid URL authority. */
export function urlHost(host: string) {
  return host.includes(":") ? `[${host}]` : host;
}

export function httpOrigin(host: string, port: number) {
  return `http://${urlHost(host)}:${port}`;
}

export function webSocketOrigin(host: string, port: number) {
  return `ws://${urlHost(host)}:${port}`;
}

function isExactOrigin(candidate: string) {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.origin === candidate;
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}
