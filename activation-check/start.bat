@echo off
setlocal
title AKS Activation Checker
cd /d "%~dp0"

echo.
echo  ==========================================
echo   AKS Activation Checker
echo   Checks brand activation by IMEI with a
echo   real browser. Solve the captcha for every
echo   IMEI when the Chromium window title warns
echo   and the app says Captcha N of M.
echo  ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js is not installed.
  echo  Install the LTS version from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\playwright" (
  echo  First run: installing Playwright. This downloads about 50 MB...
  echo.
  call npm.cmd install
  if errorlevel 1 (
    echo.
    echo  npm install failed. Check the messages above.
    pause
    exit /b 1
  )
)

if not exist "node_modules\playwright" (
  echo  Playwright did not install correctly.
  pause
  exit /b 1
)

echo  Making sure Chromium is installed...
rem Use the CLI directly: the .bin\playwright.cmd shim breaks on folders
rem whose name contains "&" (like this one).
call node "%~dp0node_modules\playwright\cli.js" install chromium
if errorlevel 1 (
  echo.
  echo  Chromium download failed. Check the internet connection and try again.
  pause
  exit /b 1
)

echo.
echo  Starting the checker. The app will open in your browser.
echo  Keep this window open while a check is running.
echo.

rem Want more time per captcha? Uncomment the next line.
rem set AKS_CAPTCHA_TIMEOUT_MS=180000
rem Prefer sheet order instead of last-row-first? Uncomment the next line.
rem set AKS_REVERSE_ORDER=0

node server.js

echo.
echo  The checker stopped.
pause
