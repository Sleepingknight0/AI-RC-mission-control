import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startConnector } from "./client.js";
import { CodexProvider } from "./codex/adapter.js";
import { probeInstalledCodex } from "./codex/compatibility.js";
import { DEFAULT_CONNECTOR_JOURNAL_PATH } from "./journal.js";
import { MockProvider } from "./mock-provider.js";
import { canonicalProjectRoot } from "./project-root.js";

const coreUrl = process.env.AICL_CORE_CONNECTOR_URL ?? "ws://127.0.0.1:8787/connector";
const connectorToken = process.env.AICL_CONNECTOR_TOKEN;
const healthPort = Number(process.env.AICL_CONNECTOR_PORT ?? "8788");
const providerName = process.env.AICL_PROVIDER ?? "codex";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const requestedProjectPath = process.env.AICL_PROJECT_PATH ?? repositoryRoot;
const allowedProjectRoots = (
  process.env.AICL_PROJECT_ROOTS ?? repositoryRoot
)
  .split(process.platform === "win32" ? ";" : ":")
  .map((path) => path.trim())
  .filter(Boolean);
const projectPath = canonicalProjectRoot(requestedProjectPath, allowedProjectRoots);
const journalPath =
  process.env.AICL_CONNECTOR_DB_PATH ?? DEFAULT_CONNECTOR_JOURNAL_PATH;

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
    : new CodexProvider({ cwd: projectPath });

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
console.log(`AICL Connector connected to ${coreUrl}; health on ${healthPort}`);

const shutdown = async () => {
  await connector.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
