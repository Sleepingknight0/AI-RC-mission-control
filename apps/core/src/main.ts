import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { httpOrigin, loadAiclConfig } from "@aicl/config";

import { startCoreServer } from "./server.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
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

const shutdown = async () => {
  await server.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
