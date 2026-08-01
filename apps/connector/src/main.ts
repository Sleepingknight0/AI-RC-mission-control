import { startMockConnector } from "./client.js";

const coreUrl = process.env.AICL_CORE_CONNECTOR_URL ?? "ws://127.0.0.1:8787/connector";
const healthPort = Number(process.env.AICL_CONNECTOR_PORT ?? "8788");

const connector = startMockConnector({ coreUrl, healthPort });
await connector.ready;
console.log(`AICL Connector connected to ${coreUrl}; health on ${healthPort}`);

const shutdown = async () => {
  await connector.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
