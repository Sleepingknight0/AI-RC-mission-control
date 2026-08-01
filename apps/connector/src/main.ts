import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startConnector } from "./client.js";
import { CodexProvider } from "./codex/adapter.js";
import { probeInstalledCodex } from "./codex/compatibility.js";
import { MockProvider } from "./mock-provider.js";

const coreUrl = process.env.AICL_CORE_CONNECTOR_URL ?? "ws://127.0.0.1:8787/connector";
const healthPort = Number(process.env.AICL_CONNECTOR_PORT ?? "8788");
const providerName = process.env.AICL_PROVIDER ?? "codex";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const projectPath = process.env.AICL_PROJECT_PATH ?? repositoryRoot;

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
  healthPort,
  provider,
  providerName,
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
