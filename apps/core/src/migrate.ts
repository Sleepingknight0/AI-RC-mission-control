import { CoreDatabase } from "./store.js";
import { DEFAULT_CORE_DB_PATH } from "./server.js";

const path = process.env.AICL_CORE_DB_PATH ?? DEFAULT_CORE_DB_PATH;
const database = new CoreDatabase({ path });
console.log(JSON.stringify({ component: "core", path, schemaVersion: database.schemaVersion }));
await database.close();
