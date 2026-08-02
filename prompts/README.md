# Prompt Index

## Codex — primary implementation owner

| Prompt | Use |
|---|---|
| `codex/00-MASTER-NEXT-MILESTONE.md` | Choose and execute the first incomplete milestone |
| `codex/01-RUN-EMPIRICAL-SPIKE.md` | Run/analyze real Codex app-server measurements |
| `codex/02-SCAFFOLD-WALKING-SKELETON.md` | Build strict TypeScript mock end-to-end skeleton |
| `codex/03-FIRST-TOKEN-VERTICAL-SLICE.md` | Connect browser to real Codex app-server |
| `codex/04-DURABILITY-AND-RECONNECT.md` | Add SQLite, idempotency, replay, recovery |
| `codex/05-APPROVAL-INTERRUPT-AND-DIFF.md` | Add command output, approvals, interrupt, artifacts |
| `codex/06-INTEGRATE-GROK-AND-CLAUDE-FEEDBACK.md` | Integrate frontend and triage audits |
| `codex/07-FINAL-PROTOTYPE-GATE.md` | Run clean-checkout release gate |
| `codex/08-CODEX-ONLY-PROTOTYPE-LOOP.md` | Reusable owner loop for every remaining Prototype 0 milestone |
| `codex/09-DAILY-USE-OPERATIONALIZATION.md` | Execute one M8 Windows daily-use milestone |

## Grok — optional post-prototype UX reviewer

| Prompt | Use |
|---|---|
| `grok/01-FRONTEND-IMPLEMENTATION.md` | Implement mission-control frontend in assigned paths |
| `grok/02-FRONTEND-UX-AUDIT.md` | Read-only frontend UX review |

## Claude — optional post-prototype independent checker

| Prompt | Use |
|---|---|
| `claude/01-ARCHITECTURE-CORRECTNESS-REVIEW.md` | State-machine, database, protocol, concurrency audit |
| `claude/02-SECURITY-RECOVERY-REVIEW.md` | Trust-boundary and failure-recovery audit |
| `claude/03-FINAL-READ-ONLY-AUDIT.md` | Final release-candidate audit |

## Selection rule

Codex owns Prototype 0 and M8 daily-use implementation. Run Grok or Claude only as optional sequential reviews; Codex remains the integration authority.
