[CmdletBinding(SupportsShouldProcess = $true)]
param([string]$TaskName = 'AICL Mission Control')

$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -eq $task) {
    Write-Host "Scheduled task '$TaskName' is not installed."
    return
}
if ($PSCmdlet.ShouldProcess($TaskName, 'Uninstall AICL scheduled task')) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Uninstalled '$TaskName'."
}
