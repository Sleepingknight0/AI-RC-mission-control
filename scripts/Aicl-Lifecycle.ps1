function Get-AiclRepositoryRoot {
    return [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
}

function Get-AiclConfigPath {
    param([string]$ConfigPath)

    if (-not [string]::IsNullOrWhiteSpace($ConfigPath)) {
        return [System.IO.Path]::GetFullPath($ConfigPath)
    }
    if (-not [string]::IsNullOrWhiteSpace($env:AICL_CONFIG_PATH)) {
        return [System.IO.Path]::GetFullPath($env:AICL_CONFIG_PATH)
    }
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw 'LOCALAPPDATA is required when AICL_CONFIG_PATH is not set.'
    }
    return Join-Path $env:LOCALAPPDATA 'AICL Mission Control\config.json'
}

function Get-AiclRuntimePaths {
    param([Parameter(Mandatory = $true)][string]$ConfigPath)

    $runDirectory = Join-Path (Split-Path -Parent $ConfigPath) 'run'
    return [pscustomobject]@{
        RunDirectory = $runDirectory
        StatePath = Join-Path $runDirectory 'production-state.json'
        StopRequestPath = Join-Path $runDirectory 'stop-request.json'
    }
}

function Get-AiclProductionState {
    param([Parameter(Mandatory = $true)][string]$StatePath)

    if (-not (Test-Path -LiteralPath $StatePath)) {
        return $null
    }
    try {
        $state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
    }
    catch {
        throw 'AICL production state is unreadable. Run pnpm stop before retrying.'
    }
    if ($state.version -ne 1 -or $state.status -ne 'running') {
        throw 'AICL production state has an unsupported shape.'
    }
    return $state
}

function Test-AiclProcess {
    param([object]$ProcessId)

    if ($null -eq $ProcessId) {
        return $false
    }
    return $null -ne (Get-Process -Id ([int]$ProcessId) -ErrorAction SilentlyContinue)
}

function Assert-AiclProductionBuild {
    param([Parameter(Mandatory = $true)][string]$BuildRoot)

    $required = @(
        (Join-Path $BuildRoot 'apps\host\supervisor.mjs'),
        (Join-Path $BuildRoot 'apps\host\doctor.mjs'),
        (Join-Path $BuildRoot 'apps\core\src\main.mjs'),
        (Join-Path $BuildRoot 'apps\connector\src\main.mjs'),
        (Join-Path $BuildRoot 'apps\web\dist\index.html')
    )
    foreach ($path in $required) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Production build is incomplete. Run pnpm build. Missing: $path"
        }
    }
}

function ConvertTo-AiclCommandLineArgument {
    param([Parameter(Mandatory = $true)][string]$Value)

    if ($Value.Contains('"')) {
        throw 'AICL command-line paths may not contain quote characters.'
    }
    return '"' + $Value + '"'
}

function Stop-AiclVerifiedSupervisorTree {
    param(
        [Parameter(Mandatory = $true)][object]$State,
        [Parameter(Mandatory = $true)][string]$ExpectedSupervisorPath
    )

    $processId = [int]$State.supervisorPid
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" `
        -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        return
    }
    $expected = [System.IO.Path]::GetFullPath($ExpectedSupervisorPath)
    if ([string]::IsNullOrWhiteSpace($process.CommandLine) -or
        $process.CommandLine.IndexOf($expected, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw 'Refusing forced stop because the recorded PID is not the AICL supervisor.'
    }
    $created = if ($process.CreationDate -is [DateTime]) {
        ([DateTime]$process.CreationDate).ToUniversalTime()
    }
    else {
        [System.Management.ManagementDateTimeConverter]::ToDateTime(
            [string]$process.CreationDate
        ).ToUniversalTime()
    }
    $recorded = [DateTime]::Parse($State.startedAt).ToUniversalTime()
    if ($created -gt $recorded.AddSeconds(5) -or $created -lt $recorded.AddMinutes(-5)) {
        throw 'Refusing forced stop because the supervisor PID creation time does not match.'
    }
    & taskkill.exe /PID $processId /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Forced AICL process-tree stop failed.'
    }
}
