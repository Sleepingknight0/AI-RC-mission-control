# Multi-AI Development Workflow

## Default allocation

The allocation is a planning rule, not a billing or token quota:

```text
Codex   70–80%  Primary implementation and integration
Grok    15–25%  Frontend design and frontend implementation
Claude   5–10%  Independent correctness/security review
```

## Responsibility matrix

| Situation | Lead | Supporting role | Final authority |
|---|---|---|---|
| Codex app-server protocol and Windows process behavior | Codex | Claude reviews failure semantics | Measured trace + Codex integration |
| Core, Connector, SQLite, state machines, idempotency | Codex | Claude audits constraints/concurrency | Tests and accepted decisions |
| Normalized protocol types | Codex | Grok consumes; Claude audits | Codex |
| Mission-control visual design | Grok | Codex supplies typed fixtures | Codex integrates |
| React component implementation | Grok | Codex verifies protocol and tests | Codex |
| Recovery and `outcome_unknown` semantics | Codex | Claude adversarial review | Tests + decision log |
| Security boundary and path validation | Codex | Claude security review | Codex |
| Final regression and release gate | Codex | Grok UX audit, Claude correctness audit | Operator |

## Required sequence

```text
1. Codex runs empirical spike
2. Codex builds the backend/protocol walking skeleton
3. Codex exposes stable protocol types and fixtures
4. Grok implements or refines frontend in its allowed paths
5. Codex integrates Grok changes and runs checks
6. Claude performs read-only audit
7. Codex triages findings, records decisions, fixes accepted issues
8. Codex runs the final prototype gate
```

## Why Codex integrates everything

One agent must own cross-component consistency. Codex is the primary implementer and therefore owns:

- whether a proposed UI field exists in the protocol
- whether a review finding is reproducible
- whether a fix preserves state-machine invariants
- whether tests and migrations remain coherent
- whether the working tree is ready for the next milestone

Grok and Claude do not directly redefine architecture through isolated edits.

## File ownership

### Codex default ownership

```text
apps/core/**
apps/connector/**
packages/protocol/**
packages/domain/**
packages/database-*/**
packages/adapter-*/**
tests/integration/**
tests/fault-injection/**
migrations/**
scripts/**
```

### Grok assigned ownership

```text
apps/web/**
packages/ui-kit/**
frontend tests and fixtures
reviews/grok/**
docs/03-FRONTEND-MISSION-CONTROL-BRIEF.md
```

Grok must not modify protocol fields to make a screen easier. It records missing requirements in its handoff report.

### Claude default ownership

```text
reviews/claude/**
```

Claude is read-only for source code by default.

## Avoiding collisions

Use one of these modes:

### Sequential mode — recommended initially

Only one AI edits the repository at a time. Finish and inspect Codex work before opening Grok; finish integration before running Claude.

### Worktree mode — optional after M2

```powershell
git worktree add ..\aicl-grok-ui -b grok/ui-prototype
git worktree add ..\aicl-audit -b audit/read-only
```

Do not use parallel worktrees before the root build and protocol package are stable.

## Handoff contract

Every agent handoff must state:

- task and scope
- files changed or reviewed
- commands/tests run
- protocol assumptions
- unresolved issues
- requested next action

Use `docs/06-HANDOFF-LOG.md` for implementation handoffs and `reviews/` for detailed reviews.

## Conflict resolution

When AIs disagree:

1. Reproduce the scenario.
2. Prefer measured provider behavior over documentation assumptions.
3. Prefer database constraints and tests over prose.
4. Prefer the narrowest fix that preserves accepted decisions.
5. Record the accepted/rejected decision and reason.
6. Codex implements the final decision.

## Prohibited collaboration patterns

- Asking all three AIs to implement the same feature independently in the same working tree
- Letting Grok change backend contracts without a protocol decision
- Letting Claude silently edit code during an audit
- Applying review findings without reproducing them
- Merging generated code without running the repository checks
- Sending the complete 3,000-line specification as the only task prompt
