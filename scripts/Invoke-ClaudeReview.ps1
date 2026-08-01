[CmdletBinding()]
param(
    [string] $PromptPath = 'prompts/claude/01-ARCHITECTURE-CORRECTNESS-REVIEW.md',

    [string] $OutputPath,

    [string] $Model,

    [ValidateSet('low', 'medium', 'high', 'xhigh', 'max', 'ultracode')]
    [string] $Effort = 'high'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$claude = Get-Command claude -ErrorAction SilentlyContinue
if ($null -eq $claude) {
    throw 'Claude Code CLI was not found on PATH. It is optional and used only after Prototype 0.'
}

$resolvedPrompt = if ([System.IO.Path]::IsPathRooted($PromptPath)) {
    $PromptPath
} else {
    Join-Path $repoRoot $PromptPath
}

if (-not (Test-Path -LiteralPath $resolvedPrompt -PathType Leaf)) {
    throw "Prompt file not found: $resolvedPrompt"
}

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $baseName = [System.IO.Path]::GetFileNameWithoutExtension($resolvedPrompt)
    $OutputPath = Join-Path $repoRoot "reviews/claude/$timestamp-$baseName.md"
} elseif (-not [System.IO.Path]::IsPathRooted($OutputPath)) {
    $OutputPath = Join-Path $repoRoot $OutputPath
}

$outputDirectory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

$prompt = Get-Content -LiteralPath $resolvedPrompt -Raw
$instruction = @'
Follow the audit task contained in the piped Markdown. This is a read-only review. Do not edit repository files. Return the complete Markdown report on stdout. Cite exact repository paths and symbols for every material finding.
'@

$arguments = @(
    '-p',
    '--permission-mode', 'plan',
    '--tools', 'Read,Glob,Grep',
    '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'mcp__*',
    '--strict-mcp-config',
    '--output-format', 'text',
    '--effort', $Effort,
    $instruction
)
if (-not [string]::IsNullOrWhiteSpace($Model)) {
    $arguments = @('-p', '--permission-mode', 'plan', '--tools', 'Read,Glob,Grep', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'mcp__*', '--strict-mcp-config', '--output-format', 'text', '--effort', $Effort, '--model', $Model, $instruction)
}

Write-Host "Prompt: $resolvedPrompt"
Write-Host "Review output: $OutputPath"
Write-Host 'Mode: read-only audit (plan permission mode; edit tools removed)'
Write-Host ''

$prompt | & claude @arguments 2>&1 | Tee-Object -FilePath $OutputPath
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    throw "Claude exited with code $exitCode. See $OutputPath"
}
