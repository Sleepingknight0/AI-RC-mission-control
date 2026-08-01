# Grok Task — Implement the Mission-Control Frontend

You are the assigned frontend specialist for AICL Mission Control. Codex remains the architecture and integration owner.

## Allowed edit scope

You may edit only:

```text
apps/web/**
packages/ui-kit/**
frontend-focused tests/fixtures
reviews/grok/**
```

You may update `docs/03-FRONTEND-MISSION-CONTROL-BRIEF.md` only to clarify implemented UI behavior. Do not edit Core, Connector, database, provider adapters, migrations, shared protocol contracts, or architecture decisions.

When required data is missing, record a typed protocol request in `reviews/grok/frontend-handoff.md`; do not invent provider/backend fields.

## Read first

- `AGENTS.md`
- `.grok/rules/frontend.md`
- `docs/02-MULTI-AI-WORKFLOW.md`
- `docs/03-FRONTEND-MISSION-CONTROL-BRIEF.md`
- `docs/04-ACCEPTANCE-TESTS.md`
- exported types and fixtures from `packages/protocol` and `packages/test-fixtures`

## Goal

Build a dense, calm, mission-control interface optimized for rapidly understanding multiple AI CLI states. Use an original visual system inspired by aerospace control rooms; do not copy SpaceX trademarks, logos, or proprietary screen designs.

## Required UX

Implement or refine:

- mission overview and compact Session rows
- Session header showing provider, model, profile, cwd, token/usage summary when available, elapsed time, and state
- streaming timeline with stable item identity
- composer and interrupt action
- sticky approval dock that does not change the reading position
- command/tool output presentation
- diff drawer/view with inline and artifact-backed loading states
- reconnect/offline/lost-runtime/`outcome_unknown` states
- mobile layout suitable for approval and monitoring

## Interaction rules

- Never force auto-scroll while the operator has scrolled away from the bottom.
- Show an unread/new-output affordance and one-action return to live edge.
- Do not use a blocking modal for ordinary approval flow.
- Preserve scroll anchor when deltas coalesce or timeline items expand.
- Use motion sparingly and honor reduced-motion settings.
- Do not encode status by color alone.
- Use monospace primarily for state, paths, IDs, metrics, and output—not all body text.
- Use a restrained neutral palette with one main accent; reserve warning/error colors for semantic states.
- Maintain keyboard navigation, visible focus, and accessible labels.

## Engineering constraints

- Consume only normalized AICL protocol/read-model types.
- Keep components deterministic with supplied fixtures.
- Include loading, empty, partial-stream, error, expired approval, artifact unavailable, and offline states.
- Do not use unrestricted raw HTML for model or command output.
- Virtualize or bound long timelines/output where necessary without breaking accessibility.
- Preserve current build tooling unless the task explicitly requires a minimal compatible addition.

## Verification

Run all frontend type, unit, accessibility, and production-build checks. Add interaction tests for scroll behavior, approval dock, mobile controls, and reconnect state.

Write `reviews/grok/frontend-handoff.md` with:

1. files changed
2. commands/tests run
3. screenshots or local routes when available
4. protocol assumptions
5. missing data requests
6. known UX limitations
7. exact instructions for Codex integration
