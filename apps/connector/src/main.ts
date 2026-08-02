import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadAiclConfig, webSocketOrigin } from "@aicl/config";

import { startConnector } from "./client.js";
import { CodexProvider } from "./codex/adapter.js";
import { probeInstalledCodex } from "./codex/compatibility.js";
import { MockProvider } from "./mock-provider.js";

const repositoryRoot =
  process.env.AICL_REPOSITORY_ROOT ??
  resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const loadedConfig = loadAiclConfig({ repositoryRoot });
const config = loadedConfig.config;
const coreUrl =
  process.env.AICL_CORE_CONNECTOR_URL ??
  `${webSocketOrigin(config.core.host, config.core.port)}/connector`;
const connectorToken = process.env.AICL_CONNECTOR_TOKEN;
const healthPort = config.connector.healthPort;
const providerName = config.provider.name;
const projectPath = config.workspace.defaultProject;
const journalPath = config.paths.connectorDatabase;

if (connectorToken === undefined) {
  throw new Error("AICL_CONNECTOR_TOKEN is required");
}

const compatibility = providerName === "codex" ? probeInstalledCodex() : null;
if (compatibility !== null && !compatibility.compatible) {
  console.error(`Codex compatibility gate failed: ${compatibility.reason}`);
  process.exit(1);
}

const provider =
  providerName === "mock"
    ? new MockProvider()
    : new CodexProvider({
        cwd: projectPath,
        codexHome: config.provider.codexHome,
      });

const connector = startConnector({
  coreUrl,
  connectorToken,
  healthPort,
  provider,
  providerName,
  journalPath,
  healthDetails:
    compatibility === null
      ? {}
      : {
          codexVersion: compatibility.installedVersion,
          schemaFingerprint: compatibility.canonicalSchemaSha256,
          compatibility: "accepted",
        },
});
await connector.ready;
console.log(
  `AICL Connector connected to ${coreUrl}; health on ${healthPort} using ${loadedConfig.configPath}`,
);

let shutdownPromise: Promise<void> | undefined;
const shutdown = (reason: string) => {
  shutdownPromise ??= connector
    .close()
    .then(() => console.log(`AICL Connector stopped: ${reason}`))
    .catch((error: unknown) => {
      console.error("AICL Connector shutdown failed", error);
      process.exitCode = 1;
    })
    .finally(() => {
      if (process.connected) process.disconnect();
    });
  return shutdownPromise;
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.on("message", (message: unknown) => {
  if (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "aicl.shutdown"
  ) {
    void shutdown("production supervisor request");
  }
});
