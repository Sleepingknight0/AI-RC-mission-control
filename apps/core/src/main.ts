import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { httpOrigin, loadAiclConfig } from "@aicl/config";

import { startCoreServer } from "./server.js";

const repositoryRoot =
  process.env.AICL_REPOSITORY_ROOT ??
  resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const loadedConfig = loadAiclConfig({ repositoryRoot });
const config = loadedConfig.config;
const connectorToken = process.env.AICL_CONNECTOR_TOKEN;

if (connectorToken === undefined) {
  throw new Error("AICL_CONNECTOR_TOKEN is required");
}

const server = await startCoreServer({
  host: config.core.host,
  port: config.core.port,
  dbPath: config.paths.coreDatabase,
  legacyBrowserTokenEnabled: false,
  connectorToken,
  allowedBrowserOrigins: config.core.allowedBrowserOrigins,
});
console.log(
  `AICL Core listening on ${httpOrigin(server.host, server.port)} using ${loadedConfig.configPath}`,
);

let shutdownPromise: Promise<void> | undefined;
const shutdown = (reason: string) => {
  shutdownPromise ??= server
    .close()
    .then(() => console.log(`AICL Core stopped: ${reason}`))
    .catch((error: unknown) => {
      console.error("AICL Core shutdown failed", error);
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
