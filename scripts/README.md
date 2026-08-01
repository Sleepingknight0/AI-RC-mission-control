# Automation Scripts

| Script | Purpose |
|---|---|
| `Check-Toolchain.ps1` | Check required and optional CLI tools |
| `Run-CodexSpike.ps1` | Run the real app-server spike multiple times |
| `Invoke-Codex.ps1` | Send a Markdown task to `codex exec -` with workspace-write sandbox |
| `Invoke-GrokFrontend.ps1` | Open Grok interactively with the frontend prompt copied, or run headlessly |
| `Invoke-ClaudeReview.ps1` | Run Claude in plan mode with read-only tools and save the report |
| `Show-NextStep.ps1` | Print the first incomplete milestone and suggested prompt |

All scripts resolve paths relative to the repository root. Run them from PowerShell on the target Windows host.
