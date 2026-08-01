# Claude Task — Read-Only Security and Recovery Review

Perform an independent read-only audit. Do not modify code or configuration.

## Scope

Review the implemented Prototype 0 trust boundaries:

- browser ↔ Core
- Core ↔ Connector
- Connector ↔ Codex app-server
- Connector ↔ project filesystem
- Core/Connector SQLite databases
- artifacts and diffs
- local logs and diagnostics

## Security checks

- WebSocket origin/authentication/session handling as currently designed
- schema validation and size limits for every external envelope
- command and approval authorization/correlation
- duplicate/replay behavior
- project-root allowlist enforcement after canonicalization
- Windows junction/symlink/path traversal escapes
- artifact authorization, opaque identifiers, hashing, range bounds, and path hiding
- no unrestricted shell endpoint
- no credential/trace leakage in logs
- safe process spawning without shell-string interpolation
- bounded stdout/stderr and malformed provider input handling
- denial-of-service risks from deltas, diffs, output, reconnect, and many tabs

## Recovery checks

- browser disconnect during active Turn
- Core restart while Connector remains alive
- Connector restart
- provider process death
- Windows restart
- commit succeeds but broadcast fails
- Connector durable event sent but ack lost
- approval response races expiry or runtime loss
- completed provider state exists but Core has not observed it
- database busy/corrupt/disk-full behavior

Confirm that the implementation never claims certainty it cannot prove and never silently resubmits side-effecting work.

## Report format

For every finding include severity, exact location, exploit/failure sequence, impact, evidence, and minimal remediation. Separate verified issues from defense-in-depth recommendations. Save to `reviews/claude/security-recovery-review.md` when possible.
