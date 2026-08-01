# Prototype 0 Scope — First Running Vertical Slice

## Objective

Prototype 0 proves that a browser can control a real Codex session through the intended process boundaries without implementing the full enterprise product.

The first decisive success condition is:

```text
User types a prompt in the browser
  -> Core accepts a versioned command
  -> Connector sends the turn to codex app-server over stdio
  -> Connector normalizes provider deltas
  -> Core relays normalized frames
  -> browser renders real incremental text
```

## Why this scope exists

The long-form specification describes the target architecture. It is not a single implementation task. Prototype 0 deliberately validates the riskiest assumptions first:

- Codex app-server behavior on the target Windows machine
- real event rate and payload size
- stdio process lifecycle
- normalized protocol design
- browser streaming and reconnect behavior
- command idempotency at the Core boundary

## Milestones

### M0 — Empirical provider spike

Deliverables:

- installed Codex version
- generated schema and fingerprint
- three benchmark runs
- delta rate, burst rate, payload distribution, and first-delta latency
- kill-during-turn observations
- `thread/read` or equivalent history observation derived from the generated schema
- no automatic prompt resubmission

No product code should be built before the spike runs successfully or has a documented blocker.

### M1 — Repository walking skeleton

Deliverables:

- pnpm monorepo with strict TypeScript
- `apps/web`, `apps/core`, `apps/connector`
- `packages/protocol`, `packages/domain`, `packages/test-fixtures`
- Core and Connector as separate processes
- health endpoints
- local Core-to-Connector channel with explicit envelopes
- mock provider fixture
- one command that starts all development processes
- one command that runs typecheck, lint, and tests

The UI may show mock data at this milestone.

### M2 — Real first-token vertical slice

Deliverables:

- Codex version and compatibility gate
- app-server spawn through stdio
- initialization based on installed generated schema
- one project root and one provider profile
- create Session
- create Runtime generation
- submit one Turn
- stream normalized assistant text deltas
- persist or project the completed message as authoritative text
- interrupt active Turn
- reject a second Turn with `TURN_ALREADY_ACTIVE`
- mark provider death during an unresolved Turn as `outcome_unknown`

The UI only needs one Session Console. Visual polish is not the priority yet.

### M3 — Durability and browser reconnect

Deliverables:

- Core SQLite WAL database
- separate Connector SQLite journal
- durable command record before dispatch
- stable `commandId` deduplication
- durable event sequence per Session
- durable/ephemeral event classification
- browser subscribe handshake with `lastSeenSeq`
- replay durable events, then join live stream
- refresh browser during Turn without creating a new Turn
- final message is authoritative even when intermediate deltas are missed

### M4 — Approval, command output, diff, and interruption

Deliverables:

- normalized command/tool lifecycle
- command output batching
- command and file-change approvals
- approval-row compare-and-set
- runtime generation and expiry checks
- decline and approve-once
- artifact endpoint for large diffs
- sticky Approval Dock in the UI
- no session-global revision check in the approval path

### M5 — Grok frontend pass

Deliverables:

- Mission Overview
- dense Session strip
- Session Console timeline
- stable scroll anchoring
- Approval Dock
- responsive desktop/mobile layouts
- keyboard navigation and reduced motion
- mock fixtures for all important states

Grok may not alter backend contracts. Codex integrates and verifies the result.

### M6 — Claude independent audit

Deliverables:

- read-only architecture/correctness review
- security/recovery review
- findings with severity, evidence, failure scenario, and remediation
- no source edits by Claude unless the operator explicitly changes the role

### M7 — Codex integration and prototype gate

Deliverables:

- accepted Grok and Claude feedback integrated by Codex
- all prototype tests pass
- manual Windows smoke test documented
- known limitations documented
- a runnable demo path from clean checkout

## Included in Prototype 0

- Windows-first development
- local HTTP/WSS on loopback
- one operator
- one Core host
- one Connector host
- one Codex profile at a time
- one project root selected from an allowlist
- real Codex text streaming
- minimal SQLite durability
- command idempotency
- browser replay
- basic approval and diff flow by M4
- aerospace mission-control UI pass by M5

## Explicitly excluded

- Claude provider adapter
- Grok provider adapter
- generic PTY adapter
- multi-user or organizations
- public SaaS control plane
- billing
- Tailscale deployment automation
- Web Push production setup
- multiple Connector machines
- Git worktree isolation
- automatic merge or branch management
- updater and signed installer
- PostgreSQL profile
- unrestricted file browser
- arbitrary remote shell API
- automatic replay of ambiguous provider commands

## Prototype quality bar

Prototype does not mean disposable architecture. It must preserve:

- process boundaries
- normalized protocol boundary
- distinct Session/Runtime/Turn/Connection concepts
- explicit failure states
- testable state transitions
- safe idempotency semantics

It may defer operational completeness, advanced UI, and broad provider support.

## Stop conditions

Stop the active milestone and report a blocker when:

- installed Codex schema contradicts the assumed method/event model
- a provider command would require blind replay after an ambiguous failure
- a schema or state invariant cannot be enforced and tested
- the task would require implementing an excluded feature
- the working tree contains unrelated user changes that would be overwritten

Do not hide the blocker with a mock when the milestone specifically requires real provider behavior.
