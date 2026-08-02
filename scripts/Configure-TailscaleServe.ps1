[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$ConfigPath,
    [string]$TailscalePath
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Aicl-Lifecycle.ps1')
. (Join-Path $PSScriptRoot 'Aicl-Tailscale.ps1')

$resolvedConfigPath = Get-AiclConfigPath -ConfigPath $ConfigPath
$runtimePaths = Get-AiclRuntimePaths -ConfigPath $resolvedConfigPath
$state = Get-AiclProductionState -StatePath $runtimePaths.StatePath
if ($null -ne $state -and (Test-AiclProcess -ProcessId $state.supervisorPid)) {
    throw 'Stop AICL before changing its exact browser Origin: pnpm stop'
}

$config = Get-AiclPersistentConfig -ConfigPath $resolvedConfigPath
$localHealth = "http://127.0.0.1:$([int]$config.core.port)/health"
$coreOnline = $false
try {
    $healthResponse = Invoke-WebRequest -UseBasicParsing -Uri $localHealth -TimeoutSec 1
    $coreOnline = $healthResponse.StatusCode -eq 200
}
catch {
    $coreOnline = $false
}
if ($coreOnline) {
    throw 'Stop pnpm dev or pnpm start before changing the exact browser Origin.'
}
$executable = Resolve-AiclTailscalePath -TailscalePath $TailscalePath
$tailnet = Get-AiclTailscaleState -Executable $executable
$target = "http://127.0.0.1:$([int]$config.core.port)"

if ($PSCmdlet.ShouldProcess($tailnet.Origin, "Configure private Tailscale Serve to $target")) {
    $serve = Invoke-AiclTailscale -Executable $executable `
        -Arguments @('serve', '--bg', '--yes', $target)
    if ($serve.ExitCode -ne 0) {
        throw 'Tailscale Serve configuration failed. Funnel was not invoked.'
    }

    $verified = $false
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        if (Test-AiclServeTarget -Executable $executable -Target $target) {
            $verified = $true
            break
        }
        Start-Sleep -Milliseconds 200
    }
    if (-not $verified) {
        throw "Tailscale Serve did not report the expected private target: $target"
    }
    $originAdded = Add-AiclBrowserOrigin -ConfigPath $resolvedConfigPath `
        -Config $config -Origin $tailnet.Origin

    [pscustomobject]@{
        status = 'configured'
        origin = $tailnet.Origin
        target = $target
        exactOriginAdded = $originAdded
        publicFunnel = $false
        next = 'Run pnpm start, then pnpm remote:status.'
    } | ConvertTo-Json
}
