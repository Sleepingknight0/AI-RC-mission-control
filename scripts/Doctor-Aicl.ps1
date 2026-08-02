[CmdletBinding()]
param([string]$ConfigPath)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Aicl-Lifecycle.ps1')

$repositoryRoot = Get-AiclRepositoryRoot
$resolvedConfigPath = Get-AiclConfigPath -ConfigPath $ConfigPath
$buildRoot = Join-Path $repositoryRoot 'build\production'
Assert-AiclProductionBuild -BuildRoot $buildRoot
$doctor = Join-Path $buildRoot 'apps\host\doctor.mjs'
& node $doctor --repository-root $repositoryRoot --config-path $resolvedConfigPath `
    --build-root $buildRoot
exit $LASTEXITCODE
