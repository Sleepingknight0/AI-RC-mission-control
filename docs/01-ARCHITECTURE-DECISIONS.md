# Accepted Architecture Decisions for Prototype 0

This file is the concise implementation authority for the prototype. The long-form specification remains the design reference.

## AD-001 — Codex owns Prototype 0 end to end

Codex owns architecture, Core, Connector, provider integration, database, normalized protocol, frontend, tests, self-audits, remediation, and final integration through the clean-checkout gate. Grok visual review and Claude independent audit are optional post-prototype phases and never block Prototype 0.

## AD-002 — Separate Core and Connector processes

Even on one Windows host:

```text
Browser <-> Core <-> Connector <-> Codex app-server
```

Core remains available when a provider process fails. Connector owns provider processes and project filesystem access.

## AD-003 — SQLite is the baseline source of truth

Use one SQLite WAL database for Core and another SQLite file for the Connector journal. PostgreSQL is not part of Prototype 0.

## AD-004 — Generated provider schema is authoritative

Never hardcode protocol names solely from old documentation. Generate schema from the installed Codex binary, fingerprint it, and gate compatibility.

## AD-005 — Frontend receives normalized protocol only

Provider notifications are converted inside the adapter/Connector boundary. Raw Codex events must never appear in frontend types or WebSocket payloads.

## AD-006 — Domain identities remain separate

At minimum, model separately:

- Session: durable conversation/work identity
- Runtime: a specific provider process attachment with generation
- Turn: one user request and its provider activity
- Connection: a browser/WebSocket subscriber
- Command: durable client mutation request
- Approval: a specific pending permission decision
- Event: durable replay record

## AD-007 — Durable events and ephemeral frames are different

Durable examples:

- Session/Runtime/Turn state transition
- approval requested/resolved
- tool completion
- final assistant message
- final error/result

Ephemeral examples:

- token delta
- reasoning delta
- stdout/stderr delta
- progress tick

Durable events commit before broadcast. Ephemeral frames may broadcast after validation and coalescing. Final completed records are authoritative.

## AD-008 — Sequence and revision are independent

- `last_event_seq` advances for durable replay events.
- Session revision advances only for Session projection/config changes.
- Turn revision advances only for Turn changes.
- Approval revision advances only for Approval changes.

Approval resolution never depends on a fast-moving global Session revision.

## AD-009 — Approval uses row-level compare-and-set

Resolve only when all expected facts still match:

- approval ID and revision
- state is pending
- runtime ID and generation
- turn ID and active state
- provider request ID
- not expired

## AD-010 — No queued Turn state in the prototype

One executing Turn per Session. A second submit returns `TURN_ALREADY_ACTIVE`. Text typed while busy remains a local draft and is never auto-sent.

## AD-011 — No provider-process reattach

If Connector process dies, stdio/SDK ownership is gone. The old Runtime becomes `lost`. A later resume creates a new provider process and a new Runtime generation. An unfinished Turn becomes `outcome_unknown` unless provider history proves a terminal outcome.

## AD-012 — Ambiguous side effects are never auto-replayed

`commandId` prevents duplicate dispatch at the Core boundary. It does not claim exactly-once execution across the provider process boundary. Unknown outcomes require operator review.

## AD-013 — Payload limits are internally consistent

WebSocket envelope maximum is larger than every inline payload limit. Large diffs and artifacts use authenticated HTTP retrieval with metadata and hash verification.

## AD-014 — Windows-first process semantics

Test process-tree termination, stdio closure, restart, and path handling on Windows. Do not infer them from Unix behavior.

## AD-015 — Prototype scope overrides broad enterprise scope

Do not implement excluded features merely because the full specification describes them. Every milestone must end with a runnable, observable vertical slice.

## AD-016 — Daily-use deployment is same-origin and loopback-only

Post-Prototype M8 places the built React application, `/ws`, `/health`, and
authenticated artifacts behind one Core origin. Core and Connector continue to
bind loopback; private remote access is delegated to Tailscale Serve, never
Funnel. Missing static assets return 404, and SPA fallback is limited to HTML
navigation so it cannot conceal malformed API or artifact requests.

M8.2 replaces production build-time browser capability injection with a
30-second, one-time ticket issued by `POST /runtime-config`. Tickets are bound
to an exact allowed Origin, stored only as SHA-256 digests, bounded in count,
and invalidated by use, expiry, or Core restart. Connector authentication stays
separate. Direct test harnesses may explicitly retain the legacy browser token;
the production entry point disables it.

## AD-017 — Operational configuration is versioned, shared, and secret-free

Core and Connector load one strict JSON configuration from
`%LOCALAPPDATA%\AICL Mission Control\config.json`. The file is created atomically,
has an explicit schema version, rejects unknown fields, and contains only
loopback endpoint settings, exact browser origins, provider profile paths,
canonical workspace paths, and operational data/log/backup paths. The active
same-origin Core URL is always derived into the effective allowlist after
overrides. Provider credentials and runtime capabilities are not configuration
fields.

Environment variables may override individual fields for development and tests,
but overrides are validated through the same schema and never persisted. Project
roots and the default project resolve through real filesystem paths before the
Connector starts, including junction containment. Core and Connector database
paths must remain distinct. Migration of the prior repository-local databases
is deferred to the explicit backup/upgrade gate in M8.6.

## AD-018 — Production lifecycle is supervised and compiled

Production runs source-map-free JavaScript bundles under one lightweight Host
supervisor; neither Vite nor `tsx watch` participates. The Host creates the
per-launch Connector capability in memory, starts Core before Connector, waits
for both health gates, and records only non-secret PID/endpoint state beneath
LocalAppData. Stop requests are local files; the Host sends authenticated-parent
IPC to close Connector (including its provider tree) before Core, then uses a
bounded verified process-tree kill only after graceful timeout.

Child output becomes bounded JSON operational logs (five 5 MiB generations per
service). Complete lines are buffered only to 64 KiB before being discarded, and
known secrets are redacted before disk writes. The Windows logon task runs under
the current interactive operator with limited privileges and remains attached to
the supervisor so Task Scheduler can restart failures. LocalSystem is rejected.
Backup and restore commands fail closed until M8.6 rather than copying a live WAL
database and presenting it as a verified backup.

## AD-019 — Tailnet exposure is explicit, exact-origin, and privately verified

Tailscale Serve is the only supported M8 remote ingress. Deployment derives the
device DNS name from an online `tailscale status --json`, requires an exact
HTTPS `*.ts.net` Origin, persists that Origin in the existing strict Core
allowlist, and proxies only to `http://127.0.0.1:<core-port>`. AICL never invokes
Funnel and never changes Core or Connector away from loopback.

Local diagnostics and remote acceptance are separate claims. Doctor reports
application, Connector, database, Codex, Tailscale, Origin, and Serve state
independently. Remote completion additionally requires a probe executed from a
different online tailnet device that completes HTTPS, runtime-ticket, and WSS
authentication without persisting the ticket. Automation alone is not evidence
that mobile or second-device access works.
