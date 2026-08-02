[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$TaskName = 'AICL Mission Control',
    [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Aicl-Lifecycle.ps1')

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
if ([string]::IsNullOrWhiteSpace($identity) -or
    $identity -match '^(?:NT AUTHORITY\\)?SYSTEM$') {
    throw 'The startup task must be installed by the interactive operator, never LocalSystem.'
}
$repositoryRoot = Get-AiclRepositoryRoot
$buildRoot = Join-Path $repositoryRoot 'build\production'
Assert-AiclProductionBuild -BuildRoot $buildRoot
$taskScript = Join-Path $PSScriptRoot 'Run-ProductionTask.ps1'
$resolvedConfigPath = Get-AiclConfigPath -ConfigPath $ConfigPath
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
$arguments = '-NoProfile -ExecutionPolicy Bypass -File ' +
    (ConvertTo-AiclCommandLineArgument -Value $taskScript) + ' -ConfigPath ' +
    (ConvertTo-AiclCommandLineArgument -Value $resolvedConfigPath)
$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments `
    -WorkingDirectory $repositoryRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive `
    -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

if ($PSCmdlet.ShouldProcess($identity, "Install scheduled task '$TaskName'")) {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings -Force | Out-Null
    Write-Host "Installed '$TaskName' for interactive user $identity."
}
else {
    Write-Host "Would install '$TaskName' for interactive user $identity (LogonType=Interactive, RunLevel=Limited)."
}
