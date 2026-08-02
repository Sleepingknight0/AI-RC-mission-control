[CmdletBinding()]
param(
    [string]$ConfigPath,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Aicl-Lifecycle.ps1')

$resolvedConfigPath = Get-AiclConfigPath -ConfigPath $ConfigPath
$runtimePaths = Get-AiclRuntimePaths -ConfigPath $resolvedConfigPath
$state = Get-AiclProductionState -StatePath $runtimePaths.StatePath
if ($null -eq $state) {
    $result = [ordered]@{
        status = 'stopped'
        supervisor = 'offline'
        core = 'offline'
        connector = 'offline'
    }
}
else {
    $supervisorAlive = Test-AiclProcess -ProcessId $state.supervisorPid
    $coreAlive = Test-AiclProcess -ProcessId $state.corePid
    $connectorAlive = Test-AiclProcess -ProcessId $state.connectorPid
    $coreHealth = 'offline'
    $connectorHealth = 'offline'
    if ($coreAlive) {
        try {
            $null = Invoke-RestMethod -Uri ($state.coreUrl + '/health') -TimeoutSec 2
            $coreHealth = 'ready'
        }
        catch {
            $coreHealth = 'unhealthy'
        }
    }
    if ($connectorAlive) {
        try {
            $null = Invoke-RestMethod -Uri ($state.connectorHealthUrl + '/health') `
                -TimeoutSec 2
            $connectorHealth = 'ready'
        }
        catch {
            $connectorHealth = 'unhealthy'
        }
    }
    $running = $supervisorAlive -and $coreHealth -eq 'ready' -and
        $connectorHealth -eq 'ready'
    $result = [ordered]@{
        status = if ($running) { 'running' } else { 'degraded' }
        supervisor = if ($supervisorAlive) { 'running' } else { 'offline' }
        core = $coreHealth
        connector = $connectorHealth
        supervisorPid = [int]$state.supervisorPid
        corePid = [int]$state.corePid
        connectorPid = [int]$state.connectorPid
        startedAt = $state.startedAt
        url = $state.coreUrl
    }
}

if ($Json) {
    $result | ConvertTo-Json
}
else {
    $result | Format-List
}
