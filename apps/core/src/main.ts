import { startCoreServer } from "./server.js";

const port = Number(process.env.AICL_CORE_PORT ?? "8787");
const connectorToken = process.env.AICL_CONNECTOR_TOKEN;

if (connectorToken === undefined) {
  throw new Error("AICL_CONNECTOR_TOKEN is required");
}

const allowedBrowserOrigins = (
  process.env.AICL_BROWSER_ORIGINS ??
  "http://127.0.0.1:5173,http://localhost:5173"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const server = await startCoreServer({
  port,
  legacyBrowserTokenEnabled: false,
  connectorToken,
  allowedBrowserOrigins,
});
console.log(`AICL Core listening on http://${server.host}:${server.port}`);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
