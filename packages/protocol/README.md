# packages/protocol

Versioned normalized commands, Session catalog/snapshot read models, durable
events, ephemeral frames, approval/activity/file-change projections, artifact
references, errors, and payload-limit validators.

This package is provider-independent and safe for `apps/web` to import. Raw
provider method names, payloads, and request IDs are intentionally excluded.

Web requests `sessions.list` and receives `sessions.snapshot`; all catalog fields
come from authoritative Core projections rather than provider payloads.
