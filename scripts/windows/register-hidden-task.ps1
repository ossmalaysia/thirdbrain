# Registers a logon task that runs a script from this folder with no visible window, then starts it.
# conhost --headless is used because Windows Terminal (the default terminal) ignores -WindowStyle Hidden.
param(
    [Parameter(Mandatory)][string]$TaskName,
    [Parameter(Mandatory)][string]$Script,
    [Parameter(Mandatory)][string]$Description
)
$ErrorActionPreference = 'Stop'
$path = Join-Path $PSScriptRoot $Script
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$path`"" -WorkingDirectory $PSScriptRoot
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $Description -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
