# Package Contents

This starter package contains the minimum repository control files needed to coordinate Codex, Grok Build, and Claude Code around the first AICL Mission Control prototype.

## Control files

- `AGENTS.md` — shared repository rules and architecture invariants
- `CLAUDE.md` — imports shared rules and sets Claude to independent read-only review
- `PLANS.md` — execution-plan conventions for long tasks
- `docs/05-IMPLEMENTATION-STATUS.md` — milestone queue
- `docs/EXECUTION-PLAN.md` — active plan updated by Codex
- `docs/06-HANDOFF-LOG.md` — cross-agent evidence and decisions

## Implementation prompts

Eight Codex prompts cover empirical measurement through final release gate. Two Grok prompts cover frontend implementation and UX audit. Three Claude prompts cover correctness, security/recovery, and final audit.

## IDE files

- VS Code workspace
- recommended extensions
- settings
- runnable tasks
- PowerShell automation wrappers

## Reference material

- AICL Mission Control specification v2.2
- correctness patch v2.2
- Windows Codex app-server spike and fixture project

## Generated code status

No product implementation is pre-generated. Codex should first run the empirical spike, then scaffold the walking skeleton under `apps/` and `packages/`.
