# apps/core

Authoritative coordinator and HTTP/WSS server.

Prototype responsibilities:

- command validation and idempotency
- Session/Runtime/Turn projections
- Core SQLite writer boundary
- durable event replay
- ephemeral live-frame relay
- approval compare-and-set and runtime-generation fencing
- authenticated, hash-addressed artifact retrieval
- Connector channel
- static web serving in production builds

Core does not access arbitrary project files or spawn provider CLIs.

After `pnpm --filter @aicl/web build`, Core serves `apps/web/dist` with hashed
asset caching and an HTML-only SPA fallback. `/health`, `/ws`, `/connector`, and
`/artifacts/*` remain reserved. Override the build directory for a packaged or
test layout with `AICL_WEB_DIST_PATH`.

Production browser connections obtain a 30-second, one-time WebSocket ticket
from bodyless `POST /runtime-config`. Issuance and upgrade both require the same
exact allowed Origin; outstanding tickets are bounded and stored only by digest.
Core restart invalidates them. The Connector keeps its separate launch token.

Run `pnpm --filter @aicl/core migrate` before first use. Schema version 4 uses
SQLite WAL, foreign keys, strict tables, and a single serialized writer. The
production entry point reads the versioned LocalAppData config and defaults to
`%LOCALAPPDATA%\AICL Mission Control\data\aicl-core.db`; override it with
`AICL_CORE_DB_PATH` for development or tests.
Durable transitions commit before broadcast. High-rate assistant deltas remain
ephemeral and the authoritative completed message is persisted for replay.
Approval CAS is scoped to the approval revision, Turn, provider correlation,
runtime ID/generation, and expiry—not the high-rate Session revision. Artifact
URLs accept only opaque IDs and require the ephemeral token sent in `server.hello`.
