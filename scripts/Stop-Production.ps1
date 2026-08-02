[CmdletBinding()]
param(
    [string]$ConfigPath,
    [int]$TimeoutSeconds = 20
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Aicl-Lifecycle.ps1')

$repositoryRoot = Get-AiclRepositoryRoot
$resolvedConfigPath = Get-AiclConfigPath -ConfigPath $ConfigPath
$runtimePaths = Get-AiclRuntimePaths -ConfigPath $resolvedConfigPath
$state = Get-AiclProductionState -StatePath $runtimePaths.StatePath
if ($null -eq $state) {
    Write-Host 'AICL production is already stopped.'
    return
}

New-Item -ItemType Directory -Path $runtimePaths.RunDirectory -Force | Out-Null
[ordered]@{
    version = 1
    requestedAt = [DateTime]::UtcNow.ToString('o')
    requestId = [guid]::NewGuid().ToString('N')
} | ConvertTo-Json | Set-Content -LiteralPath $runtimePaths.StopRequestPath -Encoding UTF8

$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
while ([DateTime]::UtcNow -lt $deadline) {
    if (-not (Test-AiclProcess -ProcessId $state.supervisorPid) -and
        -not (Test-AiclProcess -ProcessId $state.corePid) -and
        -not (Test-AiclProcess -ProcessId $state.connectorPid)) {
        Remove-Item -LiteralPath $runtimePaths.StatePath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $runtimePaths.StopRequestPath -Force `
            -ErrorAction SilentlyContinue
        Write-Host 'AICL production stopped gracefully.'
        return
    }
    Start-Sleep -Milliseconds 200
}

$supervisor = Join-Path $repositoryRoot 'build\production\apps\host\supervisor.mjs'
Stop-AiclVerifiedSupervisorTree -State $state -ExpectedSupervisorPath $supervisor
Remove-Item -LiteralPath $runtimePaths.StatePath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $runtimePaths.StopRequestPath -Force -ErrorAction SilentlyContinue
Write-Warning 'AICL exceeded the graceful timeout; its verified supervisor tree was force-stopped.'
