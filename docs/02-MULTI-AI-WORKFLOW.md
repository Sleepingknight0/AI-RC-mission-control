# Codex-Only Prototype Workflow

## Prototype 0 ownership

Codex owns every implementation and review milestone through M7.2:

```text
M0–M4  measurements, vertical slice, durability, approvals, artifacts
M5     mission-control frontend and UX verification
M6     correctness/recovery and security/boundary self-audits
M7     finding remediation, regressions, and clean-checkout gate
```

Grok and Claude are not blocking gates. Their launchers and prompts remain in
the repository only for optional post-prototype review.

## One-round loop

Run:

```powershell
.\scripts\Invoke-Codex.ps1 `
  -PromptPath .\prompts\codex\08-CODEX-ONLY-PROTOTYPE-LOOP.md
```

Each round reads the first unchecked item in
`docs/05-IMPLEMENTATION-STATUS.md`, completes one coherent milestone group,
runs the applicable checks, updates the execution plan and handoff log, then
stops. Do not continue into the next milestone in the same run.

## Authority and evidence

Codex owns all code paths and resolves conflicts in this order:

1. measured provider behavior and generated schema
2. accepted scope and architecture decisions
3. database constraints and reproducible tests
4. active milestone prompt
5. long-form specification

No review claim is accepted without a reproduction or concrete evidence.

## Safe checkpoints

Before a round, inspect `git status`. After it completes, run:

```powershell
pnpm check
git diff --check
.\scripts\Show-NextStep.ps1
```

Create a local commit only when the active prompt authorizes it, the diff is
coherent, and required checks pass. Never push automatically.

## Optional post-prototype phases

- P1: Grok visual hierarchy and UX review.
- P2: Claude independent correctness/security audit.
- P3: Codex reproduces, triages, and integrates only proven feedback.

Optional reviewers do not edit concurrently with Codex and do not redefine
backend contracts. Their reports must include file paths, evidence, severity,
and actionable remediation.
