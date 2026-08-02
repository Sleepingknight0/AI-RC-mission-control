[CmdletBinding()]
param([string]$ConfigPath)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Aicl-Lifecycle.ps1')

$repositoryRoot = Get-AiclRepositoryRoot
$resolvedConfigPath = Get-AiclConfigPath -ConfigPath $ConfigPath
$buildRoot = Join-Path $repositoryRoot 'build\production'
Assert-AiclProductionBuild -BuildRoot $buildRoot
$runtimePaths = Get-AiclRuntimePaths -ConfigPath $resolvedConfigPath
$state = Get-AiclProductionState -StatePath $runtimePaths.StatePath
if ($null -ne $state) {
    if (Test-AiclProcess -ProcessId $state.supervisorPid) {
        Write-Host 'AICL production is already running.'
        return
    }
    if ((Test-AiclProcess -ProcessId $state.corePid) -or
        (Test-AiclProcess -ProcessId $state.connectorPid)) {
        throw 'A stale state still names a live child process. Run pnpm stop.'
    }
    Remove-Item -LiteralPath $runtimePaths.StatePath -Force
}
Remove-Item -LiteralPath $runtimePaths.StopRequestPath -Force `
    -ErrorAction SilentlyContinue

$supervisor = Join-Path $buildRoot 'apps\host\supervisor.mjs'
& node $supervisor --repository-root $repositoryRoot `
    --config-path $resolvedConfigPath --build-root $buildRoot
exit $LASTEXITCODE
