# IDE Workflow

## Workspace

Open:

```text
AICL-Mission-Control.code-workspace
```

The workspace includes repository-wide TypeScript, Markdown, formatting, and file-exclusion settings. Recommended extensions are listed in `.vscode/extensions.json`.

## VS Code tasks

Open **Terminal → Run Task** and select:

- `AICL: Check toolchain`
- `AICL: Run Codex spike (3 runs)`
- `AICL: Codex next milestone`
- `AICL: Optional post-prototype Grok UX review`
- `AICL: Optional post-prototype Claude audit`
- `AICL: Show next milestone`
- `AICL: pnpm dev`
- `AICL: pnpm check`

## First run

```powershell
git init
.\scripts\Check-Toolchain.ps1
.\scripts\Run-CodexSpike.ps1 -Runs 3
.\scripts\Invoke-Codex.ps1 -PromptPath .\prompts\codex\01-RUN-EMPIRICAL-SPIKE.md
```

Do not ask Codex to scaffold the product before real spike measurements are recorded.

## Normal milestone loop

```text
1. Show next milestone
2. Run the suggested Codex prompt
3. Inspect changed files and test evidence
4. Run the repository checks yourself
5. Update/verify status and handoff logs
6. Commit a stable checkpoint manually
```

The Codex-only loop prompt may create a local commit after checks pass. It never pushes.

## Optional post-prototype frontend review

After Prototype 0 is complete, an optional Grok UX review can be run:

```powershell
.\scripts\Invoke-GrokFrontend.ps1
```

The default mode copies the task to the clipboard and opens Grok interactively. This is advisory and does not block M0–M7.

## Optional post-prototype independent review

After Prototype 0 is complete:

```powershell
.\scripts\Invoke-ClaudeReview.ps1 `
  -PromptPath .\prompts\claude\01-ARCHITECTURE-CORRECTNESS-REVIEW.md

.\scripts\Invoke-ClaudeReview.ps1 `
  -PromptPath .\prompts\claude\02-SECURITY-RECOVERY-REVIEW.md
```

Reports are stored under `reviews/claude/`. Codex must reproduce and triage findings before applying them.

## Parallel work

Prototype 0 uses the Codex-only sequential milestone loop. If optional
post-prototype reviews need isolated edits, a Grok worktree may be created:

```powershell
git worktree add ..\aicl-grok-ui -b grok/ui-prototype
```

Do not let multiple agents edit the same paths at the same time.

## IDE file map

```text
AGENTS.md                         shared implementation rules
CLAUDE.md                         Claude read-only review overlay
PLANS.md                          execution-plan convention
prompts/                          exact task prompts per agent
scripts/                          PowerShell launchers
.vscode/                          IDE tasks/settings/extensions
docs/00–08                        scope, decisions, workflow, status, IDE guide
docs/spec/                        long-form reference specification
spikes/codex-app-server/          empirical protocol runner
apps/ and packages/               product code created by Codex
reviews/                          Grok/Claude handoffs and audits
artifacts/                        local run output; normally not committed
```
