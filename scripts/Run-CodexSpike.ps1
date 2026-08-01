[CmdletBinding()]
param(
    [ValidateRange(1, 20)]
    [int] $Runs = 3,

    [string] $ProjectPath,

    [string] $Model,

    [string] $Codex = 'codex',

    [switch] $SkipKillTest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$spikeRoot = Join-Path $repoRoot 'spikes/codex-app-server'
$runner = Join-Path $spikeRoot 'run.ps1'

if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) {
    throw "Spike runner not found: $runner"
}

if ([string]::IsNullOrWhiteSpace($ProjectPath)) {
    $ProjectPath = Join-Path $repoRoot 'spikes/fixture-project'
}

$resolvedProject = (Resolve-Path -LiteralPath $ProjectPath).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$batchRoot = Join-Path $spikeRoot "artifacts/real-$timestamp"
New-Item -ItemType Directory -Path $batchRoot -Force | Out-Null

Write-Host "Running $Runs Codex app-server spike run(s)."
Write-Host "Project: $resolvedProject"
Write-Host "Artifacts: $batchRoot"
Write-Host ''

$failures = [System.Collections.Generic.List[string]]::new()

for ($index = 1; $index -le $Runs; $index++) {
    $runOut = Join-Path $batchRoot ("run-{0:D2}" -f $index)
    New-Item -ItemType Directory -Path $runOut -Force | Out-Null

    $arguments = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $runner,
        '-ProjectPath', $resolvedProject,
        '-OutputPath', $runOut,
        '-Codex', $Codex
    )

    if (-not [string]::IsNullOrWhiteSpace($Model)) {
        $arguments += @('-Model', $Model)
    }
    if ($SkipKillTest) {
        $arguments += '-SkipKill'
    }

    Write-Host "[$index/$Runs] Starting real spike..."
    & powershell @arguments
    if ($LASTEXITCODE -ne 0) {
        $failures.Add("run-$index exit=$LASTEXITCODE")
        Write-Warning "Spike run $index failed. Continue to preserve independent evidence."
    }
}

$summary = @(
    '# Codex Spike Batch',
    '',
    "- Started: $(Get-Date -Format o)",
    "- Runs requested: $Runs",
    "- Project: $resolvedProject",
    "- Codex command: $Codex",
    "- Model: $(if ($Model) { $Model } else { '(CLI default)' })",
    "- Kill test skipped: $($SkipKillTest.IsPresent)",
    "- Failures: $(if ($failures.Count) { $failures -join '; ' } else { 'none' })",
    '',
    'Use `prompts/codex/01-RUN-EMPIRICAL-SPIKE.md` to have Codex inspect these reports and update the measurement document.'
)
$summary | Set-Content -LiteralPath (Join-Path $batchRoot 'BATCH.md') -Encoding UTF8

Write-Host ''
Write-Host "Batch complete: $batchRoot"
if ($failures.Count -gt 0) {
    Write-Error "One or more spike runs failed: $($failures -join ', ')"
    exit 1
}
