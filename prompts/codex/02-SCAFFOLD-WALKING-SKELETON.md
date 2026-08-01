# Codex Task — Scaffold the Prototype Walking Skeleton

Complete milestones **M1.1–M1.3** only after the empirical spike results are recorded.

## Goal

Create a strict-TypeScript monorepo in which Core, Connector, and Web run as separate components and demonstrate a mock normalized event stream from Connector through Core to the browser.

This is not yet the real Codex integration.

## Read first

- `AGENTS.md`
- `docs/00-PROTOTYPE-0-SCOPE.md`
- `docs/01-ARCHITECTURE-DECISIONS.md`
- `docs/04-ACCEPTANCE-TESTS.md`
- `docs/05-IMPLEMENTATION-STATUS.md`
- `docs/measurements/CODEX-SPIKE-RESULTS.md`

If real spike results are absent, stop and report that M0 is incomplete.

## Required structure

Create or complete:

```text
apps/web
apps/core
apps/connector
packages/protocol
packages/domain
packages/test-fixtures
```

Use:

- pnpm workspaces
- TypeScript strict mode
- React + Vite for Web
- a small explicit HTTP/WebSocket server for Core
- a separate Node process for Connector
- a schema validator for all external envelopes
- deterministic mock provider fixtures

## Minimal normalized protocol

Define versioned envelopes for at least:

- client hello/subscription
- command accepted/rejected
- session snapshot
- runtime status
- turn started/completed/failed/`outcome_unknown`
- assistant message delta/completed
- replay boundary
- protocol error

Raw mock-provider payloads must terminate inside Connector/provider-adapter code. Add a test proving they cannot appear in frontend messages.

## Demo behavior

A single development command should start all components. The browser must be able to:

1. connect to Core
2. create or open a mock Session
3. submit one stable-`commandId` prompt
4. receive a streamed normalized mock message
5. reject a second concurrent Turn with `TURN_ALREADY_ACTIVE`
6. refresh and reconstruct the current view from a snapshot or deterministic mock replay

Persistence may remain in memory for this milestone; do not implement the full SQLite event store yet.

## Boundaries

- Keep Core and Connector process ownership explicit.
- Do not place provider-specific names in `packages/protocol`.
- Do not implement Claude, Grok provider control, PTY, authentication, notifications, updater, worktrees, or SaaS features.
- Avoid premature UI polish; a diagnostic screen is sufficient.

## Verification

Add and run:

- type checking
- unit tests for envelope validation and active-Turn rejection
- an integration test for mock Connector → Core → WebSocket flow
- a check that frontend protocol output contains no raw provider event fields

Update the execution plan, status, and handoff log with exact commands and results.
