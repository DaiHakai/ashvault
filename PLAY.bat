@echo off
title Ashvault
cd /d "%~dp0"

echo.
echo   ASHVAULT
echo   Nothing below is a safe zone.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js is not installed. Get it from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo   First run - installing dependencies, this takes a few seconds...
  echo.
  call npm install --no-audit --no-fund
  echo.
)

echo   Starting the server. Your browser will open in a moment.
echo   Leave this window open while you play. Close it to stop the game.
echo.

rem Give the server a beat to bind the port, then open the browser.
start "" cmd /c "timeout /t 2 >nul && start http://localhost:3000"

node server/index.js

echo.
echo   The server has stopped.
pause
