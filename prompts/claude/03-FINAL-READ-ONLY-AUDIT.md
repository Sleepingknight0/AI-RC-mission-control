# Claude Task — Final Read-Only Prototype Audit

Audit the release candidate after Codex has integrated Grok work and prior review findings. Do not edit source.

## Determine

1. Does the implementation satisfy every completed item in `docs/05-IMPLEMENTATION-STATUS.md`?
2. Can each claimed acceptance criterion be mapped to a test or reproducible demo?
3. Are any prior P0/P1 findings unresolved or incorrectly dismissed?
4. Do docs match the actual commands, configuration, database schema, and failure behavior?
5. Are unsafe claims made about exactly-once execution, reattachment, crash certainty, or production security?

## Regression hot spots

Recheck:

- normalized event boundary
- event source uniqueness
- event sequence vs resource revision
- active-Turn constraint
- command/approval idempotency
- runtime generation
- durable/ephemeral stream split
- reconnect replay boundary
- provider-loss `outcome_unknown`
- artifact size/auth/path rules
- Windows process-tree termination
- frontend stale approval and reconnect UX

## Output

Provide:

- go / conditional-go / no-go
- P0–P3 findings with evidence
- acceptance-criterion traceability gaps
- tests that were claimed but not demonstrated
- residual risks explicitly accepted by Prototype 0
- the smallest remediation set required for go

Save to `reviews/claude/final-read-only-audit.md` when possible.
