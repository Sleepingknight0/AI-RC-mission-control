[CmdletBinding()]
param([string]$ConfigPath)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Aicl-Lifecycle.ps1')

$repositoryRoot = Get-AiclRepositoryRoot
$resolvedConfigPath = Get-AiclConfigPath -ConfigPath $ConfigPath
$buildRoot = Join-Path $repositoryRoot 'build\production'
$compiledMaintenance = Join-Path $buildRoot 'apps\host\maintenance.mjs'
$sourceMaintenance = Join-Path $repositoryRoot 'apps\host\src\maintenance-cli.ts'

if (Test-Path -LiteralPath $sourceMaintenance -PathType Leaf) {
    Push-Location $repositoryRoot
    try {
        & pnpm exec tsx apps/host/src/maintenance-cli.ts migrate `
            --repository-root $repositoryRoot `
            --config-path $resolvedConfigPath `
            --migration-root $repositoryRoot
        if ($LASTEXITCODE -ne 0) {
            throw 'AICL source migration failed.'
        }
    }
    finally {
        Pop-Location
    }
    return
}

if (Test-Path -LiteralPath $compiledMaintenance -PathType Leaf) {
    & node $compiledMaintenance migrate `
        --repository-root $repositoryRoot `
        --config-path $resolvedConfigPath `
        --migration-root $buildRoot
    if ($LASTEXITCODE -ne 0) {
        throw 'AICL migration failed.'
    }
    return
}

throw 'AICL maintenance entrypoint is missing. Run pnpm build or install source dependencies.'
