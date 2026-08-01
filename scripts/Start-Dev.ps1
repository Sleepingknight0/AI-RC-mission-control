$ErrorActionPreference = 'Stop'

$browserToken = [guid]::NewGuid().ToString('N')
$connectorToken = [guid]::NewGuid().ToString('N')

$env:AICL_BROWSER_TOKEN = $browserToken
$env:VITE_AICL_BROWSER_TOKEN = $browserToken
$env:AICL_CONNECTOR_TOKEN = $connectorToken
if ([string]::IsNullOrWhiteSpace($env:AICL_PROJECT_ROOTS)) {
    $repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
    $env:AICL_PROJECT_ROOTS = $repositoryRoot
    $env:AICL_PROJECT_PATH = $repositoryRoot
}

Write-Host 'Starting AICL with fresh per-launch WebSocket capabilities.'
pnpm -r --parallel --if-present run dev
