function Resolve-AiclTailscalePath {
    param([string]$TailscalePath)

    if (-not [string]::IsNullOrWhiteSpace($TailscalePath)) {
        $resolved = [System.IO.Path]::GetFullPath($TailscalePath)
        if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
            throw "Tailscale CLI was not found: $resolved"
        }
        return $resolved
    }

    $command = Get-Command tailscale.exe -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        $command = Get-Command tailscale -ErrorAction SilentlyContinue
    }
    if ($null -ne $command) {
        return $command.Source
    }

    $installed = 'C:\Program Files\Tailscale\tailscale.exe'
    if (Test-Path -LiteralPath $installed -PathType Leaf) {
        return $installed
    }
    throw 'Tailscale CLI is not installed or is not on PATH.'
}

function Invoke-AiclTailscale {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $output = @(& $Executable @Arguments 2>&1)
    return [pscustomobject]@{
        ExitCode = $LASTEXITCODE
        Output = ($output -join [Environment]::NewLine)
    }
}

function Get-AiclTailscaleState {
    param([Parameter(Mandatory = $true)][string]$Executable)

    $result = Invoke-AiclTailscale -Executable $Executable -Arguments @('status', '--json')
    if ($result.ExitCode -ne 0) {
        throw 'Tailscale is offline, signed out, or unavailable.'
    }
    try {
        $status = $result.Output | ConvertFrom-Json
    }
    catch {
        throw 'Tailscale returned invalid status JSON.'
    }
    if ($status.BackendState -ne 'Running' -or $status.Self.Online -eq $false) {
        throw 'Tailscale is not online.'
    }
    $dnsName = ([string]$status.Self.DNSName).Trim().TrimEnd('.').ToLowerInvariant()
    if ($dnsName -notmatch '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$') {
        throw 'Tailscale did not return an exact ts.net DNS name.'
    }
    return [pscustomobject]@{
        DnsName = $dnsName
        Origin = "https://$dnsName"
    }
}

function Get-AiclPersistentConfig {
    param([Parameter(Mandatory = $true)][string]$ConfigPath)

    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
        throw "AICL config is missing. Run pnpm doctor once before deployment: $ConfigPath"
    }
    $item = Get-Item -LiteralPath $ConfigPath -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'AICL config must not be a symbolic link or junction.'
    }
    try {
        $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    }
    catch {
        throw 'AICL config is not valid JSON.'
    }
    if ($config.version -ne 1 -or $null -eq $config.core) {
        throw 'AICL config has an unsupported shape or version.'
    }
    if ($config.core.host -ne '127.0.0.1') {
        throw 'Tailscale deployment requires Core host 127.0.0.1.'
    }
    $port = [int]$config.core.port
    if ($port -lt 1 -or $port -gt 65535) {
        throw 'AICL Core port is invalid.'
    }
    return $config
}

function Add-AiclBrowserOrigin {
    param(
        [Parameter(Mandatory = $true)][string]$ConfigPath,
        [Parameter(Mandatory = $true)][object]$Config,
        [Parameter(Mandatory = $true)][string]$Origin
    )

    $origins = @($Config.core.allowedBrowserOrigins | ForEach-Object { [string]$_ })
    if ($origins -contains $Origin) {
        return $false
    }
    $Config.core.allowedBrowserOrigins = @($origins + $Origin)
    $json = ($Config | ConvertTo-Json -Depth 20) + [Environment]::NewLine
    $temporaryPath = "$ConfigPath.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
    $backupPath = "$ConfigPath.$PID.$([Guid]::NewGuid().ToString('N')).bak"
    try {
        [System.IO.File]::WriteAllText(
            $temporaryPath,
            $json,
            [System.Text.UTF8Encoding]::new($false)
        )
        [System.IO.File]::Replace($temporaryPath, $ConfigPath, $backupPath, $true)
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath) {
            Remove-Item -LiteralPath $temporaryPath -Force
        }
        if (Test-Path -LiteralPath $backupPath) {
            Remove-Item -LiteralPath $backupPath -Force
        }
    }
    return $true
}

function Test-AiclServeTarget {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string]$Target
    )

    $result = Invoke-AiclTailscale -Executable $Executable `
        -Arguments @('serve', 'status', '--json')
    if ($result.ExitCode -ne 0) {
        return $false
    }
    try {
        $null = $result.Output | ConvertFrom-Json
    }
    catch {
        $result = $null
    }
    if ($null -ne $result -and $result.Output.IndexOf(
            $Target,
            [System.StringComparison]::OrdinalIgnoreCase
        ) -ge 0) {
        return $true
    }
    $textResult = Invoke-AiclTailscale -Executable $Executable `
        -Arguments @('serve', 'status')
    return $textResult.ExitCode -eq 0 -and $textResult.Output.IndexOf(
        $Target,
        [System.StringComparison]::OrdinalIgnoreCase
    ) -ge 0
}
