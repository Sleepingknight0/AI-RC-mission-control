import {
  ConnectorJournal,
  DEFAULT_CONNECTOR_JOURNAL_PATH,
} from "./journal.js";

const path = process.env.AICL_CONNECTOR_DB_PATH ?? DEFAULT_CONNECTOR_JOURNAL_PATH;
const journal = new ConnectorJournal({ path });
console.log(JSON.stringify({ component: "connector", path, schemaVersion: journal.schemaVersion }));
journal.close();
