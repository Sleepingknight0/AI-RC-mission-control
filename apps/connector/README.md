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
