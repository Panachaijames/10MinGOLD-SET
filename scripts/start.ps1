$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

if (-not (Test-Path ".\.venv\Scripts\python.exe")) {
    throw "Python environment is missing. Run .\scripts\setup.ps1 first."
}
if (-not (Test-Path ".env")) {
    throw ".env is missing. Run .\scripts\setup.ps1 first."
}
if (-not (Test-Path "frontend\dist\index.html")) {
    throw "The React production build is missing. Run .\scripts\setup.ps1 first."
}

& ".\.venv\Scripts\python.exe" -m uvicorn backend.main:app --host 127.0.0.1 --port 8000

