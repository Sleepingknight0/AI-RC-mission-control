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
