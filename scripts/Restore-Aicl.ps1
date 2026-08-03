[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$BackupPath,
    [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Aicl-Lifecycle.ps1')

$repositoryRoot = Get-AiclRepositoryRoot
$resolvedConfigPath = Get-AiclConfigPath -ConfigPath $ConfigPath
$resolvedBackupPath = [System.IO.Path]::GetFullPath($BackupPath)
$buildRoot = Join-Path $repositoryRoot 'build\production'
Assert-AiclProductionBuild -BuildRoot $buildRoot

& node (Join-Path $buildRoot 'apps\host\maintenance.mjs') restore `
    --repository-root $repositoryRoot `
    --config-path $resolvedConfigPath `
    --backup-path $resolvedBackupPath
if ($LASTEXITCODE -ne 0) {
    throw 'Verified AICL restore failed; the active database was not accepted.'
}
