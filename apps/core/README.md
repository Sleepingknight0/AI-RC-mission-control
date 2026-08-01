# apps/core

Authoritative coordinator and HTTP/WSS server.

Prototype responsibilities:

- command validation and idempotency
- Session/Runtime/Turn projections
- Core SQLite writer boundary
- durable event replay
- ephemeral live-frame relay
- Connector channel
- static web serving in production builds

Core does not access arbitrary project files or spawn provider CLIs.

Run `pnpm --filter @aicl/core migrate` before first use. Schema version 1 uses
SQLite WAL, foreign keys, strict tables, and a single serialized writer. The
default database is `.data/aicl-core.db`; override it with `AICL_CORE_DB_PATH`.
Durable transitions commit before broadcast. High-rate assistant deltas remain
ephemeral and the authoritative completed message is persisted for replay.
