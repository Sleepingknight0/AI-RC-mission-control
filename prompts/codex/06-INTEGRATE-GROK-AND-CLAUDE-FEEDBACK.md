# Codex Task — Integrate Grok Frontend Work and Claude Audit Findings

You are the integration authority. Do not accept AI-generated changes or findings merely because they sound plausible.

## Inputs

Read:

- `AGENTS.md`
- `docs/02-MULTI-AI-WORKFLOW.md`
- `docs/03-FRONTEND-MISSION-CONTROL-BRIEF.md`
- `docs/04-ACCEPTANCE-TESTS.md`
- `reviews/grok/**`
- `reviews/claude/**`
- the current working-tree diff

## Part A — Grok integration

1. Verify Grok stayed within its assigned frontend paths.
2. Check that UI code consumes normalized protocol types and does not invent backend/provider fields.
3. Reconcile any requested protocol additions explicitly; do not silently add fields only for visual convenience.
4. Run frontend unit, accessibility, type, build, and interaction checks.
5. Verify:
   - stable stream scroll behavior
   - no forced auto-scroll while the operator is reading history
   - approval dock does not obscure the timeline
   - diff view handles loading/error/large-artifact states
   - mobile layout remains operable
   - state color is not the sole signal
6. Fix integration defects in the appropriate owner area.

## Part B — Claude finding triage

For every P0/P1 finding and any relevant P2 finding:

1. Reproduce or disprove it with code, a test, schema, trace, or documented provider behavior.
2. Record the disposition in `docs/06-HANDOFF-LOG.md`:
   - accepted
   - accepted with narrower remediation
   - duplicate/already fixed
   - rejected with evidence
   - deferred with explicit risk
3. Implement accepted fixes without weakening established invariants.
4. Add regression tests for accepted correctness/security findings.

Pay particular attention to:

- connector-source partial uniqueness
- event sequence vs resource revision
- no process reattach after Connector loss
- no dormant `queued` state
- durable vs ephemeral stream handling
- command/approval idempotency
- runtime generation checks
- `outcome_unknown`
- WebSocket/diff size limits
- canonical path and artifact authorization

## Completion gate

Run the full affected repository checks and produce one integrated report. Do not begin new product features. Update milestone status only for work genuinely demonstrated.
