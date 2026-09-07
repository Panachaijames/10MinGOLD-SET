$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

if (-not (Test-Path ".venv")) {
    py -3.11 -m venv .venv
}

& ".\.venv\Scripts\python.exe" -m pip install --upgrade pip
& ".\.venv\Scripts\python.exe" -m pip install -r requirements.txt

Push-Location frontend
npm install
npm run build
Pop-Location

if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    $generatedToken = & ".\.venv\Scripts\python.exe" -c "import secrets; print(secrets.token_urlsafe(32))"
    (Get-Content ".env" -Raw).Replace("replace-with-a-long-random-token", $generatedToken) | Set-Content ".env" -Encoding utf8
    Write-Host "Created .env with a random APP_TOKEN. Update VAPID_SUBJECT before remote use." -ForegroundColor Yellow
}

Write-Host "Setup complete. Run .\scripts\start.ps1 while MetaTrader 5 is open." -ForegroundColor Green

