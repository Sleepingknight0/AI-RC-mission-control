[CmdletBinding()]
param(
    [string]$ConfigPath,
    [switch]$Build,
    [int]$TimeoutSeconds = 45
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Aicl-Lifecycle.ps1')

$repositoryRoot = Get-AiclRepositoryRoot
$resolvedConfigPath = Get-AiclConfigPath -ConfigPath $ConfigPath
$buildRoot = Join-Path $repositoryRoot 'build\production'
if ($Build) {
    & (Join-Path $PSScriptRoot 'Build-Production.ps1')
    if ($LASTEXITCODE -ne 0) {
        throw 'Production build failed.'
    }
}
Assert-AiclProductionBuild -BuildRoot $buildRoot

$runtimePaths = Get-AiclRuntimePaths -ConfigPath $resolvedConfigPath
$state = Get-AiclProductionState -StatePath $runtimePaths.StatePath
if ($null -ne $state) {
    if (Test-AiclProcess -ProcessId $state.supervisorPid) {
        Write-Host "AICL production is already running (PID $($state.supervisorPid))."
        return
    }
    if ((Test-AiclProcess -ProcessId $state.corePid) -or
        (Test-AiclProcess -ProcessId $state.connectorPid)) {
        throw 'A stale state still names a live child process. Run pnpm stop before starting.'
    }
    Remove-Item -LiteralPath $runtimePaths.StatePath -Force
}
New-Item -ItemType Directory -Path $runtimePaths.RunDirectory -Force | Out-Null
Remove-Item -LiteralPath $runtimePaths.StopRequestPath -Force -ErrorAction SilentlyContinue

$node = (Get-Command node -ErrorAction Stop).Source
$supervisor = Join-Path $buildRoot 'apps\host\supervisor.mjs'
$arguments = @(
    (ConvertTo-AiclCommandLineArgument -Value $supervisor),
    '--repository-root',
    (ConvertTo-AiclCommandLineArgument -Value $repositoryRoot),
    '--config-path',
    (ConvertTo-AiclCommandLineArgument -Value $resolvedConfigPath),
    '--build-root',
    (ConvertTo-AiclCommandLineArgument -Value $buildRoot)
)
$process = Start-Process -FilePath $node -ArgumentList $arguments `
    -WorkingDirectory $repositoryRoot -WindowStyle Hidden -PassThru

$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
while ([DateTime]::UtcNow -lt $deadline) {
    if ($process.HasExited) {
        throw "AICL production supervisor exited during startup (code $($process.ExitCode))."
    }
    $state = Get-AiclProductionState -StatePath $runtimePaths.StatePath
    if ($null -ne $state -and $state.status -eq 'running') {
        Write-Host "AICL production ready: $($state.coreUrl) (supervisor PID $($state.supervisorPid))"
        return
    }
    Start-Sleep -Milliseconds 200
}

throw 'Timed out waiting for AICL production startup. Run pnpm status and pnpm doctor.'
