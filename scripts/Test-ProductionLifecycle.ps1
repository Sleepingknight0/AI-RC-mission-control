[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Get-FreeTcpPort {
    $listener = [System.Net.Sockets.TcpListener]::new(
        [System.Net.IPAddress]::Loopback,
        0
    )
    $listener.Start()
    try {
        return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    }
    finally {
        $listener.Stop()
    }
}

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) `
    ('aicl-m84-lifecycle-' + [guid]::NewGuid().ToString('N'))
$configPath = Join-Path $temporaryRoot 'config.json'
$environmentNames = @(
    'AICL_CONFIG_PATH',
    'AICL_CORE_HOST',
    'AICL_CORE_PORT',
    'AICL_CONNECTOR_PORT',
    'AICL_PROVIDER',
    'AICL_PROJECT_ROOTS',
    'AICL_PROJECT_PATH'
)
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
try {
    $env:AICL_CONFIG_PATH = $configPath
    $env:AICL_CORE_HOST = '127.0.0.1'
    $env:AICL_CORE_PORT = [string](Get-FreeTcpPort)
    $env:AICL_CONNECTOR_PORT = [string](Get-FreeTcpPort)
    $env:AICL_PROVIDER = 'mock'
    $env:AICL_PROJECT_ROOTS = $repositoryRoot
    $env:AICL_PROJECT_PATH = $repositoryRoot

    & (Join-Path $PSScriptRoot 'Start-Production.ps1') -ConfigPath $configPath `
        -TimeoutSeconds 30
    $statusJson = & (Join-Path $PSScriptRoot 'Status-Production.ps1') `
        -ConfigPath $configPath -Json
    $status = $statusJson | ConvertFrom-Json
    if ($status.status -ne 'running' -or $status.core -ne 'ready' -or
        $status.connector -ne 'ready') {
        throw "Unexpected production status: $statusJson"
    }
    $page = Invoke-WebRequest -Uri ($status.url + '/') -Headers @{ Accept = 'text/html' } `
        -UseBasicParsing -TimeoutSec 5
    if ($page.StatusCode -ne 200) {
        throw 'Compiled same-origin Web page did not return HTTP 200.'
    }
    $state = Get-Content -LiteralPath `
        (Join-Path $temporaryRoot 'run\production-state.json') -Raw
    if ($state -match '(?i)token|secret|capability') {
        throw 'Production state contains a forbidden capability field.'
    }
    $pids = @(
        [int]$status.supervisorPid,
        [int]$status.corePid,
        [int]$status.connectorPid
    )

    & (Join-Path $PSScriptRoot 'Stop-Production.ps1') -ConfigPath $configPath `
        -TimeoutSeconds 15
    foreach ($processId in $pids) {
        if ($null -ne (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
            throw "Production process $processId survived stop."
        }
    }
    if (Test-Path -LiteralPath (Join-Path $temporaryRoot 'run\production-state.json')) {
        throw 'Production state survived a clean stop.'
    }
    Write-Host 'Compiled production lifecycle smoke passed.'
}
finally {
    try {
        & (Join-Path $PSScriptRoot 'Stop-Production.ps1') -ConfigPath $configPath `
            -TimeoutSeconds 5 2>$null
    }
    catch {
        Write-Warning 'Lifecycle smoke cleanup could not use the normal stop path.'
    }
    foreach ($name in $environmentNames) {
        [Environment]::SetEnvironmentVariable(
            $name,
            $previousEnvironment[$name],
            'Process'
        )
    }
    $resolvedTemporaryRoot = [System.IO.Path]::GetFullPath($temporaryRoot)
    $expectedPrefix = [System.IO.Path]::GetFullPath(
        [System.IO.Path]::GetTempPath()
    ).TrimEnd('\') + '\aicl-m84-lifecycle-'
    if ($resolvedTemporaryRoot.StartsWith(
        $expectedPrefix,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        Remove-Item -LiteralPath $resolvedTemporaryRoot -Recurse -Force `
            -ErrorAction SilentlyContinue
    }
}
