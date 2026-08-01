[CmdletBinding()]
param(
    [string] $PromptPath = 'prompts/codex/00-MASTER-NEXT-MILESTONE.md',

    [ValidateSet('read-only', 'workspace-write', 'danger-full-access')]
    [string] $Sandbox = 'workspace-write',

    [string] $Model,

    [switch] $Json,

    [switch] $Ephemeral
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$codex = Get-Command codex -ErrorAction SilentlyContinue
if ($null -eq $codex) {
    throw 'Codex CLI was not found on PATH. Install/login first and run scripts/Check-Toolchain.ps1.'
}

$resolvedPrompt = if ([System.IO.Path]::IsPathRooted($PromptPath)) {
    $PromptPath
} else {
    Join-Path $repoRoot $PromptPath
}

if (-not (Test-Path -LiteralPath $resolvedPrompt -PathType Leaf)) {
    throw "Prompt file not found: $resolvedPrompt"
}

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot '.git'))) {
    Write-Warning 'This starter folder is not yet a Git repository. Codex exec may refuse to run. Initialize with: git init'
}

$prompt = Get-Content -LiteralPath $resolvedPrompt -Raw
if ([string]::IsNullOrWhiteSpace($prompt)) {
    throw "Prompt file is empty: $resolvedPrompt"
}

$artifactRoot = Join-Path $repoRoot 'artifacts/codex'
New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$baseName = [System.IO.Path]::GetFileNameWithoutExtension($resolvedPrompt)
$outputPath = Join-Path $artifactRoot "$timestamp-$baseName.out"

$arguments = @('exec', '--sandbox', $Sandbox)
if ($Json) {
    $arguments += '--json'
}
if ($Ephemeral) {
    $arguments += '--ephemeral'
}
if (-not [string]::IsNullOrWhiteSpace($Model)) {
    $arguments += @('--model', $Model)
}
$arguments += '-'

Write-Host "Prompt: $resolvedPrompt"
Write-Host "Sandbox: $Sandbox"
Write-Host "Output: $outputPath"
Write-Host ''

$prompt | & codex @arguments 2>&1 | Tee-Object -FilePath $outputPath
$exitCode = $LASTEXITCODE

if ($exitCode -ne 0) {
    throw "Codex exited with code $exitCode. See $outputPath"
}
