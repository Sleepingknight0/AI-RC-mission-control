import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadAiclConfig } from "@aicl/config";

import { CoreDatabase } from "./store.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const path = loadAiclConfig({ repositoryRoot }).config.paths.coreDatabase;
const database = new CoreDatabase({ path });
console.log(JSON.stringify({ component: "core", path, schemaVersion: database.schemaVersion }));
await database.close();
