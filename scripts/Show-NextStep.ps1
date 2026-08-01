[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$statusPath = Join-Path $repoRoot 'docs/05-IMPLEMENTATION-STATUS.md'

if (-not (Test-Path -LiteralPath $statusPath -PathType Leaf)) {
    throw "Status file not found: $statusPath"
}

$next = Get-Content -LiteralPath $statusPath | Where-Object { $_ -match '^\s*- \[ \] ' } | Select-Object -First 1
if ($null -eq $next) {
    Write-Host 'All listed Prototype 0 milestones are checked.'
    exit 0
}

$label = ($next -replace '^\s*- \[ \] ', '').Trim()
Write-Host "Next milestone: $label"
Write-Host ''

$promptSuggestion = switch -Regex ($label) {
    '^M0\.' { 'prompts/codex/01-RUN-EMPIRICAL-SPIKE.md'; break }
    '^M1\.' { 'prompts/codex/02-SCAFFOLD-WALKING-SKELETON.md'; break }
    '^M2\.' { 'prompts/codex/03-FIRST-TOKEN-VERTICAL-SLICE.md'; break }
    '^M3\.' { 'prompts/codex/04-DURABILITY-AND-RECONNECT.md'; break }
    '^M4\.' { 'prompts/codex/05-APPROVAL-INTERRUPT-AND-DIFF.md'; break }
    '^M5\.1' { 'prompts/grok/01-FRONTEND-IMPLEMENTATION.md'; break }
    '^M5\.2|^M7\.1' { 'prompts/codex/06-INTEGRATE-GROK-AND-CLAUDE-FEEDBACK.md'; break }
    '^M6\.1' { 'prompts/claude/01-ARCHITECTURE-CORRECTNESS-REVIEW.md'; break }
    '^M6\.2' { 'prompts/claude/02-SECURITY-RECOVERY-REVIEW.md'; break }
    '^M7\.2' { 'prompts/codex/07-FINAL-PROTOTYPE-GATE.md'; break }
    default { 'prompts/codex/00-MASTER-NEXT-MILESTONE.md' }
}

Write-Host "Suggested prompt: $promptSuggestion"
