[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) `
    "aicl-tailscale-test-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $temporaryRoot | Out-Null

try {
    $configPath = Join-Path $temporaryRoot 'config.json'
    $callLog = Join-Path $temporaryRoot 'calls.log'
    $fakeTailscale = Join-Path $temporaryRoot 'tailscale.ps1'
    $config = [ordered]@{
        version = 1
        core = [ordered]@{
            host = '127.0.0.1'
            port = 49199
            allowedBrowserOrigins = @('http://127.0.0.1:49199')
        }
        connector = [ordered]@{ healthPort = 8788 }
    }
    [System.IO.File]::WriteAllText(
        $configPath,
        (($config | ConvertTo-Json -Depth 10) + [Environment]::NewLine),
        [System.Text.UTF8Encoding]::new($false)
    )

    $fake = @'
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$CommandArgs)
Add-Content -LiteralPath $env:AICL_FAKE_TAILSCALE_LOG -Value ($CommandArgs -join ' ')
$joined = $CommandArgs -join ' '
if ($joined -eq 'status --json') {
    @{ BackendState = 'Running'; Self = @{ DNSName = 'aicl-host.example.ts.net.'; Online = $true } } | ConvertTo-Json -Depth 4 -Compress
    exit 0
}
if ($joined -eq 'serve status --json') {
    @{ Web = @{ 'aicl-host.example.ts.net:443' = @{ Handlers = @{ '/' = @{ Proxy = 'http://127.0.0.1:49199' } } } } } | ConvertTo-Json -Depth 8 -Compress
    exit 0
}
if ($joined -eq 'serve --bg --yes http://127.0.0.1:49199') {
    'Available within your tailnet'
    exit 0
}
exit 9
'@
    [System.IO.File]::WriteAllText(
        $fakeTailscale,
        $fake,
        [System.Text.UTF8Encoding]::new($false)
    )
    $env:AICL_FAKE_TAILSCALE_LOG = $callLog
    & (Join-Path $PSScriptRoot 'Configure-TailscaleServe.ps1') `
        -ConfigPath $configPath -TailscalePath $fakeTailscale | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Tailscale configuration smoke failed.'
    }

    $persisted = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if (@($persisted.core.allowedBrowserOrigins) -notcontains 'https://aicl-host.example.ts.net') {
        throw 'Exact ts.net Origin was not persisted.'
    }
    $calls = Get-Content -LiteralPath $callLog -Raw
    if ($calls -notmatch 'serve --bg --yes http://127\.0\.0\.1:49199') {
        throw 'Private Serve command was not executed.'
    }
    if ($calls -match 'funnel') {
        throw 'Public Funnel must never be invoked.'
    }
    Write-Host 'Tailscale automation smoke passed.'
}
finally {
    Remove-Item Env:AICL_FAKE_TAILSCALE_LOG -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}
