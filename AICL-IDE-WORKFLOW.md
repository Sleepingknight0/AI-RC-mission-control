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
- `AICL: Grok frontend pass`
- `AICL: Claude read-only review`
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

Codex does not commit by default.

## Frontend handoff

After `packages/protocol` and `packages/test-fixtures` are stable:

```powershell
.\scripts\Invoke-GrokFrontend.ps1
```

The default mode copies the frontend task to the clipboard and opens Grok interactively. Keep permission review enabled. Grok is limited by instruction to frontend paths and records missing protocol requirements instead of changing backend contracts.

## Independent review

After a working vertical slice:

```powershell
.\scripts\Invoke-ClaudeReview.ps1 `
  -PromptPath .\prompts\claude\01-ARCHITECTURE-CORRECTNESS-REVIEW.md

.\scripts\Invoke-ClaudeReview.ps1 `
  -PromptPath .\prompts\claude\02-SECURITY-RECOVERY-REVIEW.md
```

Reports are stored under `reviews/claude/`. Codex must reproduce and triage findings before applying them.

## Parallel work

Use sequential operation during M0–M2. After the protocol package is stable, an optional Grok worktree may be created:

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
