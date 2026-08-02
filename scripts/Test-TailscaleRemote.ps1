[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Origin,
    [string]$EvidencePath,
    [string]$TailscalePath
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Aicl-Tailscale.ps1')

try {
    $uri = [Uri]$Origin
}
catch {
    throw 'Origin must be an absolute HTTPS URL.'
}
if ($uri.Scheme -ne 'https' -or $uri.AbsolutePath -ne '/' -or
    -not [string]::IsNullOrEmpty($uri.Query) -or
    -not [string]::IsNullOrEmpty($uri.Fragment) -or
    $uri.Host -notmatch '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$') {
    throw 'Origin must be an exact https://*.ts.net origin without path, query, or fragment.'
}
$exactOrigin = $uri.GetLeftPart([System.UriPartial]::Authority)
if ($exactOrigin -ne $Origin) {
    throw 'Origin must use its exact canonical form without a trailing slash.'
}

$executable = Resolve-AiclTailscalePath -TailscalePath $TailscalePath
$clientTailnet = Get-AiclTailscaleState -Executable $executable
if ($clientTailnet.DnsName -eq $uri.Host.ToLowerInvariant()) {
    throw 'This proof must run on a second tailnet device, not on the AICL host.'
}

try {
    $page = Invoke-WebRequest -UseBasicParsing -Uri "$exactOrigin/" -TimeoutSec 10
    $health = Invoke-RestMethod -Uri "$exactOrigin/health" -TimeoutSec 10
    $ticketResponse = Invoke-WebRequest -UseBasicParsing -Method Post `
        -Uri "$exactOrigin/runtime-config" -Headers @{ Origin = $exactOrigin; Accept = 'application/json' } `
        -TimeoutSec 10
    $runtime = $ticketResponse.Content | ConvertFrom-Json
}
catch {
    throw 'Remote HTTPS/runtime bootstrap probe failed.'
}
if ($page.StatusCode -ne 200 -or $page.Headers['Content-Type'] -notmatch 'text/html') {
    throw 'Remote page did not return the production HTML shell.'
}
if ($health.status -ne 'ready' -or $health.connectorConnected -ne $true) {
    throw 'Remote health is not ready or Connector is offline.'
}
if ([string]::IsNullOrWhiteSpace([string]$runtime.ticket)) {
    throw 'Remote runtime bootstrap did not return a ticket.'
}

$socket = [System.Net.WebSockets.ClientWebSocket]::new()
try {
    $socket.Options.SetRequestHeader('Origin', $exactOrigin)
    $socket.Options.AddSubProtocol("aicl.browser.$($runtime.ticket)")
    $webSocketUri = [Uri]("wss://$($uri.Authority)/ws")
    $cancellation = [System.Threading.CancellationTokenSource]::new()
    $cancellation.CancelAfter([TimeSpan]::FromSeconds(10))
    try {
        $socket.ConnectAsync($webSocketUri, $cancellation.Token).GetAwaiter().GetResult()
    }
    catch {
        throw 'Remote authenticated WebSocket probe failed.'
    }
    if ($socket.State -ne [System.Net.WebSockets.WebSocketState]::Open) {
        throw 'Remote authenticated WebSocket did not open.'
    }
    $socket.CloseAsync(
        [System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure,
        'probe complete',
        [System.Threading.CancellationToken]::None
    ).GetAwaiter().GetResult()
}
finally {
    $socket.Dispose()
}

$evidence = [ordered]@{
    version = 1
    testedAt = [DateTime]::UtcNow.ToString('o')
    clientDnsName = $clientTailnet.DnsName
    serverOrigin = $exactOrigin
    secondDevice = $true
    checks = [ordered]@{
        httpsPage = 'pass'
        coreHealth = 'pass'
        connectorHealth = 'pass'
        runtimeTicket = 'pass (not recorded)'
        authenticatedWebSocket = 'pass'
    }
    databaseSchemaVersion = $health.databaseSchemaVersion
}
$evidenceJson = $evidence | ConvertTo-Json -Depth 8
if (-not [string]::IsNullOrWhiteSpace($EvidencePath)) {
    $resolvedEvidencePath = [System.IO.Path]::GetFullPath($EvidencePath)
    $parent = Split-Path -Parent $resolvedEvidencePath
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    [System.IO.File]::WriteAllText(
        $resolvedEvidencePath,
        $evidenceJson + [Environment]::NewLine,
        [System.Text.UTF8Encoding]::new($false)
    )
}
$evidenceJson
