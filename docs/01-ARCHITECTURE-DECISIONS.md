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
