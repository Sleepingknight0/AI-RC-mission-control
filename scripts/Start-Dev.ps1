$ErrorActionPreference = 'Stop'

$connectorToken = [guid]::NewGuid().ToString('N')

$null = Remove-Item Env:AICL_BROWSER_TOKEN,Env:VITE_AICL_BROWSER_TOKEN `
    -ErrorAction SilentlyContinue
$env:AICL_CONNECTOR_TOKEN = $connectorToken
if ([string]::IsNullOrWhiteSpace($env:VITE_CORE_WS_URL)) {
    $corePort = if ([string]::IsNullOrWhiteSpace($env:AICL_CORE_PORT)) {
        '8787'
    } else {
        $env:AICL_CORE_PORT
    }
    $env:VITE_CORE_WS_URL = "ws://127.0.0.1:$corePort/ws"
}
if ([string]::IsNullOrWhiteSpace($env:AICL_PROJECT_ROOTS)) {
    $repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
    $env:AICL_PROJECT_ROOTS = $repositoryRoot
    $env:AICL_PROJECT_PATH = $repositoryRoot
}

Write-Host 'Starting AICL with runtime browser tickets and a fresh Connector capability.'
pnpm -r --parallel --if-present run dev
