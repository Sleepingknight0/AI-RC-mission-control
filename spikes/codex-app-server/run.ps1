[CmdletBinding()]
param(
    [Parameter()]
    [string]$ProjectPath = (Get-Location).Path,

    [Parameter()]
    [string]$Codex = "codex",

    [Parameter()]
    [string]$OutputPath = "",

    [Parameter()]
    [string]$Model = "",

    [Parameter()]
    [switch]$SkipKill
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js 20 or newer is required. The 'node' command was not found."
}

$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) {
    throw "Node.js 20 or newer is required. Found: $(node --version)"
}

$arguments = @(
    ".\spike.mjs",
    "--cwd", (Resolve-Path -LiteralPath $ProjectPath).Path,
    "--codex", $Codex
)

if ($OutputPath) {
    $arguments += @("--out", $OutputPath)
}
if ($Model) {
    $arguments += @("--model", $Model)
}
if ($SkipKill) {
    $arguments += "--skip-kill"
}

& node @arguments
exit $LASTEXITCODE
