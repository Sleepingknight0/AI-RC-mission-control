[CmdletBinding()]
param(
    [string]$ConfigPath,
    [string]$TailscalePath
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Aicl-Lifecycle.ps1')
. (Join-Path $PSScriptRoot 'Aicl-Tailscale.ps1')

$resolvedConfigPath = Get-AiclConfigPath -ConfigPath $ConfigPath
$config = Get-AiclPersistentConfig -ConfigPath $resolvedConfigPath
$target = "http://127.0.0.1:$([int]$config.core.port)"
$coreUrl = $target
$connectorUrl = "http://127.0.0.1:$([int]$config.connector.healthPort)"

function Test-HealthEndpoint {
    param([Parameter(Mandatory = $true)][string]$Uri)
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 2
        return $response.StatusCode -eq 200
    }
    catch {
        return $false
    }
}

$tailscaleState = 'missing'
$serveState = 'not_checked'
$remoteOrigin = $null
$originState = 'not_checked'
try {
    $executable = Resolve-AiclTailscalePath -TailscalePath $TailscalePath
    try {
        $tailnet = Get-AiclTailscaleState -Executable $executable
        $tailscaleState = 'online'
        $remoteOrigin = $tailnet.Origin
        $originState = if (@($config.core.allowedBrowserOrigins) -contains $remoteOrigin) {
            'configured'
        }
        else {
            'not_configured'
        }
        $serveState = if (Test-AiclServeTarget -Executable $executable -Target $target) {
            'configured'
        }
        else {
            'not_configured'
        }
    }
    catch {
        $tailscaleState = 'offline'
    }
}
catch {
    $tailscaleState = 'missing'
}

[pscustomobject]@{
    application = if (Test-HealthEndpoint -Uri "$coreUrl/health") { 'online' } else { 'offline' }
    connector = if (Test-HealthEndpoint -Uri "$connectorUrl/health") { 'online' } else { 'offline' }
    tailscale = $tailscaleState
    serve = $serveState
    exactOrigin = $originState
    remoteOrigin = $remoteOrigin
    target = $target
    secondDeviceEvidence = 'not_recorded_by_this_command'
} | ConvertTo-Json
