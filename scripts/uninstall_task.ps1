$ErrorActionPreference = "Stop"
$taskName = "Aurum Signal watcher"
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed task '$taskName'." -ForegroundColor Green
} else {
    Write-Host "Task '$taskName' is not registered." -ForegroundColor Yellow
}
