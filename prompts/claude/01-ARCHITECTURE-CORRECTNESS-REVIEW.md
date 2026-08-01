# Claude Task — Read-Only Architecture and Correctness Review

Act as an independent adversarial reviewer. Do not edit source code. Produce a report that Codex can reproduce and triage.

## Read

- `AGENTS.md`
- `CLAUDE.md`
- `docs/00-PROTOTYPE-0-SCOPE.md`
- `docs/01-ARCHITECTURE-DECISIONS.md`
- `docs/04-ACCEPTANCE-TESTS.md`
- current implementation and tests
- only relevant sections of the long-form specification

## Review focus

Check the implemented behavior—not merely the prose—for:

- separation of Session, Runtime, Turn, Connection, Command, Approval, and Event
- one executing Turn per Session and absence of a dead `queued` state
- stable command idempotency and same-ID/different-payload handling
- connector-source event deduplication with correct nullable-source semantics
- durable event sequence separate from resource revisions
- durable versus ephemeral stream handling
- no row/transaction per token
- commit/broadcast boundary and replay gaps
- Core/Connector database ownership
- runtime generation and stale-event rejection
- Connector/provider loss semantics
- absence of impossible stdio process reattachment
- correct use of `outcome_unknown`
- prohibition on automatic prompt replay after ambiguous side effects
- approval compare-and-set correctness
- WebSocket versus inline diff size consistency
- provider-generated schema isolation and compatibility gating

## Method

For each suspected issue:

1. cite exact file and line or symbol
2. give a minimal failure scenario
3. explain the violated invariant
4. state whether an existing test catches it
5. propose the narrowest remediation

Do not raise speculative concerns without a plausible execution path.

## Severity

- P0: data corruption, unsafe command execution, or unrecoverable security boundary failure
- P1: likely incorrect state, duplicate side effects, false success, or blocked core workflow
- P2: material maintainability/performance/recovery risk
- P3: minor robustness or clarity issue

Write the report to `reviews/claude/architecture-correctness-review.md` when possible. Include a final section listing invariants that were checked and appear sound.
