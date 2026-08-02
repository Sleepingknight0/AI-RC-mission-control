import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadAiclConfig } from "@aicl/config";

import { ConnectorJournal } from "./journal.js";

const repositoryRoot =
  process.env.AICL_REPOSITORY_ROOT ??
  resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const path = loadAiclConfig({ repositoryRoot }).config.paths.connectorDatabase;
const journal = new ConnectorJournal({ path });
console.log(JSON.stringify({ component: "connector", path, schemaVersion: journal.schemaVersion }));
journal.close();
