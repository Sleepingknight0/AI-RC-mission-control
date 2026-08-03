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

function ConvertFrom-CommandJson {
    param([Parameter(Mandatory = $true)][object[]]$Lines)

    return (($Lines -join [Environment]::NewLine) | ConvertFrom-Json)
}

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) `
    ('aicl-m86-maintenance-' + [guid]::NewGuid().ToString('N'))
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

    & (Join-Path $PSScriptRoot 'Start-Production.ps1') `
        -ConfigPath $configPath -TimeoutSeconds 30
    $firstStatus = ConvertFrom-CommandJson -Lines @(
        & (Join-Path $PSScriptRoot 'Status-Production.ps1') `
            -ConfigPath $configPath -Json
    )
    $health = Invoke-RestMethod -Uri ($firstStatus.url + '/health') -TimeoutSec 5
    if ($health.databaseSchemaVersion -ne 8 -or -not $health.connectorConnected) {
        throw 'Empty production startup did not reach Core schema 8 with Connector ready.'
    }

    $backup = ConvertFrom-CommandJson -Lines @(
        & (Join-Path $PSScriptRoot 'Backup-Aicl.ps1') `
            -ConfigPath $configPath -RetentionCount 3
    )
    if (-not (Test-Path -LiteralPath $backup.backupPath -PathType Container)) {
        throw 'Compiled online backup did not create a backup set.'
    }
    $null = ConvertFrom-CommandJson -Lines @(
        & (Join-Path $PSScriptRoot 'Verify-AiclBackup.ps1') `
            -ConfigPath $configPath -BackupPath $backup.backupPath
    )

    & (Join-Path $PSScriptRoot 'Stop-Production.ps1') `
        -ConfigPath $configPath -TimeoutSeconds 15

    $coreDatabase = Join-Path $temporaryRoot 'data\aicl-core.db'
    $probeScript = @'
import { DatabaseSync } from 'node:sqlite';
const database = new DatabaseSync(process.argv[1]);
database.exec('CREATE TABLE m86_restore_probe (id INTEGER PRIMARY KEY) STRICT');
database.close();
'@
    & node --input-type=module -e $probeScript $coreDatabase
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not create the isolated restore probe.'
    }

    $null = ConvertFrom-CommandJson -Lines @(
        & (Join-Path $PSScriptRoot 'Restore-Aicl.ps1') `
            -ConfigPath $configPath -BackupPath $backup.backupPath
    )
    $verifyRestoreScript = @'
import { DatabaseSync } from 'node:sqlite';
const database = new DatabaseSync(process.argv[1], { readOnly: true });
const row = database.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'm86_restore_probe'`).get();
database.close();
if (row.count !== 0) process.exitCode = 1;
'@
    & node --input-type=module -e $verifyRestoreScript $coreDatabase
    if ($LASTEXITCODE -ne 0) {
        throw 'Restore did not atomically replace the isolated Core database.'
    }

    $firstSupervisorPid = [int]$firstStatus.supervisorPid
    & (Join-Path $PSScriptRoot 'Start-Production.ps1') `
        -ConfigPath $configPath -TimeoutSeconds 30
    $secondStatus = ConvertFrom-CommandJson -Lines @(
        & (Join-Path $PSScriptRoot 'Status-Production.ps1') `
            -ConfigPath $configPath -Json
    )
    if ($secondStatus.status -ne 'running' -or
        [int]$secondStatus.supervisorPid -eq $firstSupervisorPid) {
        throw 'Reboot simulation did not start a new healthy supervisor generation.'
    }
    & (Join-Path $PSScriptRoot 'Stop-Production.ps1') `
        -ConfigPath $configPath -TimeoutSeconds 15

    $firstMigration = ConvertFrom-CommandJson -Lines @(
        & (Join-Path $PSScriptRoot 'Migrate-Aicl.ps1') -ConfigPath $configPath
    )
    $secondMigration = ConvertFrom-CommandJson -Lines @(
        & (Join-Path $PSScriptRoot 'Migrate-Aicl.ps1') -ConfigPath $configPath
    )
    if ($firstMigration.migrated -or $secondMigration.migrated -or
        $secondMigration.coreSchemaVersion -ne 8 -or
        $secondMigration.connectorSchemaVersion -ne 3) {
        throw 'Repeated migration was not idempotent at Core 6 / Connector 3.'
    }

    Add-Content -LiteralPath (Join-Path $backup.backupPath 'aicl-core.db') `
        -Value 'intentional-corruption' -NoNewline
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & node (Join-Path $repositoryRoot 'build\production\apps\host\maintenance.mjs') `
            verify `
            --repository-root $repositoryRoot `
            --config-path $configPath `
            --backup-path $backup.backupPath 2>$null
        $corruptExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($corruptExitCode -eq 0) {
        throw 'Corrupt backup verification unexpectedly succeeded.'
    }

    Write-Host 'M8 backup, restore, migration, restart, and corruption gate passed.'
}
finally {
    try {
        & (Join-Path $PSScriptRoot 'Stop-Production.ps1') `
            -ConfigPath $configPath -TimeoutSeconds 5 2>$null
    }
    catch {
        Write-Warning 'M8 maintenance cleanup could not use the normal stop path.'
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
    ).TrimEnd('\') + '\aicl-m86-maintenance-'
    if ($resolvedTemporaryRoot.StartsWith(
        $expectedPrefix,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        Remove-Item -LiteralPath $resolvedTemporaryRoot -Recurse -Force `
            -ErrorAction SilentlyContinue
    }
}
