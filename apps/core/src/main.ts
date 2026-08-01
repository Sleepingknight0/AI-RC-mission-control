import { startCoreServer } from "./server.js";

const port = Number(process.env.AICL_CORE_PORT ?? "8787");
const server = await startCoreServer({ port });
console.log(`AICL Core listening on http://${server.host}:${server.port}`);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
