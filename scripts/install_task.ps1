# Registers a Windows Task Scheduler job that starts the watcher when you log on and
# restarts it if it dies. It runs in your interactive session ("Run only when user is
# logged on") because the MetaTrader5 Python bridge cannot reach a terminal from
# Session 0 (services / "run whether user is logged on or not").
#
#   Set-ExecutionPolicy -Scope Process Bypass
#   .\scripts\install_task.ps1
#
# Remove with .\scripts\uninstall_task.ps1

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$taskName = "Aurum Signal watcher"
$startScript = Join-Path $projectRoot "scripts\start.ps1"

if (-not (Test-Path $startScript)) { throw "start.ps1 not found at $startScript" }

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`"" `
    -WorkingDirectory $projectRoot

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# Give MT5 and the network a moment after sign-in before the first initialize() attempt.
$trigger.Delay = "PT30S"

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero)   # PT0S: never kill the long-running loop (default is 3 days)

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "Registered task '$taskName' (at log-on, interactive session, restart every 1 min up to 3 times, no time limit)." -ForegroundColor Green
Write-Host "Start it now with:  Start-ScheduledTask -TaskName '$taskName'" -ForegroundColor Yellow
Write-Host "Remember: the laptop must stay powered (lid open or lid action = do nothing); the watcher keeps it awake but cannot override lid-close." -ForegroundColor Yellow
