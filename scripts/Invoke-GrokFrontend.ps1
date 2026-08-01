[CmdletBinding()]
param(
    [string] $PromptPath = 'prompts/grok/01-FRONTEND-IMPLEMENTATION.md',

    [switch] $Headless,

    [switch] $AlwaysApprove,

    [string] $Model
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$grok = Get-Command grok -ErrorAction SilentlyContinue
if ($null -eq $grok) {
    throw 'Grok Build CLI was not found on PATH. It is optional and used only after Prototype 0.'
}

$resolvedPrompt = if ([System.IO.Path]::IsPathRooted($PromptPath)) {
    $PromptPath
} else {
    Join-Path $repoRoot $PromptPath
}

if (-not (Test-Path -LiteralPath $resolvedPrompt -PathType Leaf)) {
    throw "Prompt file not found: $resolvedPrompt"
}

$prompt = Get-Content -LiteralPath $resolvedPrompt -Raw
if ([string]::IsNullOrWhiteSpace($prompt)) {
    throw "Prompt file is empty: $resolvedPrompt"
}

if (-not $Headless) {
    Set-Clipboard -Value $prompt
    Write-Host 'The optional post-prototype Grok prompt has been copied to the clipboard.'
    Write-Host 'Grok will open interactively in the repository. Paste the prompt and review permissions before execution.'
    Write-Host ''
    & grok
    exit $LASTEXITCODE
}

$artifactRoot = Join-Path $repoRoot 'reviews/grok'
New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outputPath = Join-Path $artifactRoot "$timestamp-headless-frontend.jsonl"

$arguments = @('--no-auto-update', '-p', $prompt, '--output-format', 'streaming-json')
if ($AlwaysApprove) {
    Write-Warning 'AlwaysApprove permits tool executions without ordinary prompts. Use only after inspecting the task and working tree.'
    $arguments += '--always-approve'
}
if (-not [string]::IsNullOrWhiteSpace($Model)) {
    $arguments += @('--model', $Model)
}

& grok @arguments 2>&1 | Tee-Object -FilePath $outputPath
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    throw "Grok exited with code $exitCode. See $outputPath"
}
