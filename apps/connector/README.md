# apps/connector

Local execution boundary for provider processes and project filesystem access.

Prototype responsibilities:

- Codex version/schema probe
- app-server stdio lifecycle
- provider event normalization
- Connector journal
- runtime generation ownership
- project-root allowlist
- command and event acknowledgement

Connector never opens the Core database.

Run `pnpm --filter @aicl/connector migrate` before first use. Schema version 1
stores the durable inbox/outbox journal in `.data/aicl-connector.db`; override
it with `AICL_CONNECTOR_DB_PATH`. A restart keeps `connectorId`, allocates a new
`bootId` and runtime generation, and never redispatches an accepted command with
an uncertain outcome.
