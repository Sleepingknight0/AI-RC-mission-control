[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$requiredFailures = [System.Collections.Generic.List[string]]::new()
$rows = [System.Collections.Generic.List[object]]::new()

function Add-ToolResult {
    param(
        [Parameter(Mandatory)] [string] $Name,
        [Parameter(Mandatory)] [bool] $Required,
        [Parameter(Mandatory)] [bool] $Found,
        [string] $Version = '',
        [string] $Path = '',
        [string] $Note = ''
    )

    $status = if ($Found) { 'OK' } elseif ($Required) { 'MISSING' } else { 'OPTIONAL' }
    $rows.Add([pscustomobject]@{
        Status   = $status
        Tool     = $Name
        Required = $Required
        Version  = $Version
        Path     = $Path
        Note     = $Note
    })

    if ($Required -and -not $Found) {
        $requiredFailures.Add($Name)
    }
}

function Get-FirstOutputLine {
    param(
        [Parameter(Mandatory)] [string] $Command,
        [string[]] $Arguments = @('--version')
    )

    try {
        $output = & $Command @Arguments 2>&1
        if ($LASTEXITCODE -ne 0) {
            return "exit=$LASTEXITCODE; $($output | Select-Object -First 1)"
        }
        return [string]($output | Select-Object -First 1)
    }
    catch {
        return $_.Exception.Message
    }
}

$tools = @(
    @{ Name = 'git';    Required = $true;  Args = @('--version') },
    @{ Name = 'node';   Required = $true;  Args = @('--version') },
    @{ Name = 'codex';  Required = $true;  Args = @('--version') },
    @{ Name = 'pnpm';   Required = $false; Args = @('--version') },
    @{ Name = 'grok';   Required = $false; Args = @('version') },
    @{ Name = 'claude'; Required = $false; Args = @('--version') },
    @{ Name = 'code';   Required = $false; Args = @('--version') }
)

foreach ($tool in $tools) {
    $command = Get-Command $tool.Name -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        Add-ToolResult -Name $tool.Name -Required $tool.Required -Found $false -Note 'Not found on PATH'
        continue
    }

    $version = Get-FirstOutputLine -Command $tool.Name -Arguments $tool.Args
    Add-ToolResult -Name $tool.Name -Required $tool.Required -Found $true -Version $version -Path $command.Source
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($null -ne $nodeCommand) {
    try {
        $nodeVersionText = (& node --version).TrimStart('v')
        $nodeVersion = [version]$nodeVersionText
        if ($nodeVersion.Major -lt 24) {
            $requiredFailures.Add('Node.js 24+')
            $rows.Add([pscustomobject]@{
                Status   = 'INVALID'
                Tool     = 'node-version'
                Required = $true
                Version  = $nodeVersionText
                Path     = $nodeCommand.Source
                Note     = 'AICL requires Node.js 24+; node:sqlite needs --experimental-sqlite before 23.4.'
            })
        }
    }
    catch {
        $requiredFailures.Add('Node.js version check')
    }
}

$windows = [System.Environment]::OSVersion.VersionString
$rows.Add([pscustomobject]@{
    Status   = 'INFO'
    Tool     = 'operating-system'
    Required = $true
    Version  = $windows
    Path     = $env:OS
    Note     = 'Prototype target is Windows 10/11.'
})

$rows | Format-Table -AutoSize

Write-Host ''
Write-Host "Repository: $repoRoot"
Write-Host "PowerShell: $($PSVersionTable.PSVersion)"

if ($requiredFailures.Count -gt 0) {
    Write-Error "Required toolchain checks failed: $($requiredFailures -join ', ')"
    exit 1
}

Write-Host 'Required toolchain checks passed.'
Write-Host 'Optional Grok/Claude tools are used only for post-prototype review.'
