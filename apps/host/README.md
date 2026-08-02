# AICL Production Host

The Host is the production-only supervisor for the separate Core and Connector
processes. `pnpm build` bundles all three Node entry points as JavaScript under
`build/production`; production never executes repository TypeScript or Vite.

The Host starts Core, waits for health, starts Connector, waits for
reconciliation, then writes non-secret PID/endpoint state under the configured
LocalAppData directory. It generates the Connector capability in memory and
never writes it to state or logs. Operator stop requests cause IPC shutdown in
Connector/provider-first order, followed by Core; a verified process-tree kill
is the bounded fallback.

Child output is converted to redacted JSON and rotated at five 5 MiB files per
service. Lines over 64 KiB are discarded. Use the root `build`, `start`, `stop`,
`status`, and `doctor` commands rather than launching this package directly.

Doctor reports the local application, Connector, databases, Codex compatibility,
Tailscale connection, exact remote Origin, and private Serve mapping as separate
checks. Missing Tailscale is a warning because loopback operation remains valid;
it is still a blocker for M8.5 remote acceptance.
