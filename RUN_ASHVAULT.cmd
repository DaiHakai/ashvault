@echo off
setlocal
set "ASHVAULT_DIR=%~dp0"

rem Starts the local game server only when it is not already running.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$listening = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue; if (-not $listening) { Start-Process -FilePath npm.cmd -ArgumentList 'start' -WorkingDirectory '%ASHVAULT_DIR%' -WindowStyle Hidden }"
timeout /t 2 /nobreak >nul
start "" "http://localhost:3000/"
endlocal
