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
    ('aicl-m86-clean-install-' + [guid]::NewGuid().ToString('N'))
$cleanRoot = Join-Path $temporaryRoot 'install'
$cleanScripts = Join-Path $cleanRoot 'scripts'
$configPath = Join-Path $temporaryRoot 'application\config.json'
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

New-Item -ItemType Directory -Path $cleanScripts -Force | Out-Null
try {
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'build\production') `
        -Destination (Join-Path $cleanRoot 'build\production') -Recurse
    foreach ($name in @(
        'Aicl-Lifecycle.ps1',
        'Start-Production.ps1',
        'Stop-Production.ps1',
        'Status-Production.ps1',
        'Backup-Aicl.ps1',
        'Verify-AiclBackup.ps1',
        'Restore-Aicl.ps1',
        'Migrate-Aicl.ps1'
    )) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) `
            -Destination (Join-Path $cleanScripts $name)
    }
    if (Test-Path -LiteralPath (Join-Path $cleanRoot 'node_modules')) {
        throw 'Clean production directory unexpectedly contains node_modules.'
    }
    if ($null -ne (Get-ChildItem -LiteralPath $cleanRoot -Recurse -Filter '*.ts' |
            Select-Object -First 1)) {
        throw 'Clean production directory unexpectedly contains TypeScript source.'
    }

    $env:AICL_CONFIG_PATH = $configPath
    $env:AICL_CORE_HOST = '127.0.0.1'
    $env:AICL_CORE_PORT = [string](Get-FreeTcpPort)
    $env:AICL_CONNECTOR_PORT = [string](Get-FreeTcpPort)
    $env:AICL_PROVIDER = 'mock'
    $env:AICL_PROJECT_ROOTS = $cleanRoot
    $env:AICL_PROJECT_PATH = $cleanRoot

    & (Join-Path $cleanScripts 'Start-Production.ps1') `
        -ConfigPath $configPath -TimeoutSeconds 30
    $statusJson = & (Join-Path $cleanScripts 'Status-Production.ps1') `
        -ConfigPath $configPath -Json
    $status = (($statusJson -join [Environment]::NewLine) | ConvertFrom-Json)
    if ($status.status -ne 'running') {
        throw "Clean production status was not running: $statusJson"
    }
    $health = Invoke-RestMethod -Uri ($status.url + '/health') -TimeoutSec 5
    if ($health.databaseSchemaVersion -ne 9 -or -not $health.connectorConnected) {
        throw 'Clean production install did not initialize the expected schemas.'
    }
    $page = Invoke-WebRequest -Uri ($status.url + '/') `
        -Headers @{ Accept = 'text/html' } -UseBasicParsing -TimeoutSec 5
    if ($page.StatusCode -ne 200) {
        throw 'Clean production install did not serve the same-origin Web app.'
    }
    $backupJson = & (Join-Path $cleanScripts 'Backup-Aicl.ps1') `
        -ConfigPath $configPath -RetentionCount 2
    $backup = (($backupJson -join [Environment]::NewLine) | ConvertFrom-Json)
    $null = & (Join-Path $cleanScripts 'Verify-AiclBackup.ps1') `
        -ConfigPath $configPath -BackupPath $backup.backupPath

    $pids = @(
        [int]$status.supervisorPid,
        [int]$status.corePid,
        [int]$status.connectorPid
    )
    & (Join-Path $cleanScripts 'Stop-Production.ps1') `
        -ConfigPath $configPath -TimeoutSeconds 15
    $migrationJson = & (Join-Path $cleanScripts 'Migrate-Aicl.ps1') `
        -ConfigPath $configPath
    $migration = (($migrationJson -join [Environment]::NewLine) | ConvertFrom-Json)
    if ($migration.migrated -or $migration.coreSchemaVersion -ne 9 -or
        $migration.connectorSchemaVersion -ne 3) {
        throw 'Clean compiled migration was not repeat-safe at the expected schemas.'
    }
    foreach ($processId in $pids) {
        if ($null -ne (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
            throw "Clean production process $processId survived stop."
        }
    }
    Write-Host 'Clean-directory compiled production install gate passed.'
}
finally {
    try {
        & (Join-Path $cleanScripts 'Stop-Production.ps1') `
            -ConfigPath $configPath -TimeoutSeconds 5 2>$null
    }
    catch {
        Write-Warning 'Clean-install cleanup could not use the normal stop path.'
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
    ).TrimEnd('\') + '\aicl-m86-clean-install-'
    if ($resolvedTemporaryRoot.StartsWith(
        $expectedPrefix,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        Remove-Item -LiteralPath $resolvedTemporaryRoot -Recurse -Force `
            -ErrorAction SilentlyContinue
    }
}
