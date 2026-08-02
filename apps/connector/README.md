# apps/connector

Local execution boundary for provider processes and project filesystem access.

Prototype responsibilities:

- Codex version/schema probe
- app-server stdio lifecycle
- provider event normalization
- bounded command-output coalescing and file-change normalization
- provider-local approval correlation and one-shot resolution
- journaled artifact chunk delivery
- Connector journal
- runtime generation ownership
- project-root allowlist
- command and event acknowledgement

Connector never opens the Core database.

Run `pnpm --filter @aicl/connector migrate` before first use. Schema version 2
stores the durable inbox/outbox journal under the configured LocalAppData data
directory; override it with `AICL_CONNECTOR_DB_PATH` for development or tests.
The same versioned config supplies canonical project roots/default project and
a CODEX_HOME profile reference. Only that path—not credentials—is forwarded
through the provider child environment allowlist. A restart keeps `connectorId`,
allocates a new `bootId` and runtime generation, and never redispatches an
accepted command with an uncertain outcome.
