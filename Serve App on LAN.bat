@echo off
setlocal enabledelayedexpansion
title AKS Finance - test on tablet (LAN)
cd /d "%~dp0"

rem Pick a listening port. 8080 is often already taken by other dev tools, and
rem Windows can reserve port ranges, so fall back through a small list and then
rem to a random high port. No pipes inside these PowerShell calls: cmd's for /f
rem does not un-escape them.
set "PORT="
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "$used=@(); foreach($c in (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)){ $used+=$c.LocalPort }; $pick=0; foreach($p in (8080,8081,8090,8099,8123)){ if($pick -eq 0 -and $used -notcontains $p){ $pick=$p } }; if($pick -eq 0){ $pick=Get-Random -Minimum 49152 -Maximum 65000 }; $pick"`) do set "PORT=%%p"
if not defined PORT set "PORT=8080"
set "ROOT=%TEMP%\aks-lan"

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [!] Python was not found on PATH.
  echo       Install Python, or use "npx serve ." instead.
  echo.
  pause
  exit /b 1
)

rem Copy only the files the app needs. Serving the whole folder would also
rem expose activation-check\.profile and activation-check\reports over Wi-Fi.
echo Copying the current app files...
if exist "%ROOT%" rmdir /s /q "%ROOT%"
mkdir "%ROOT%" >nul 2>nul
copy /y index.html   "%ROOT%" >nul
copy /y manifest.json "%ROOT%" >nul
copy /y sw.js        "%ROOT%" >nul
copy /y LOGO.jpeg    "%ROOT%" >nul
xcopy /e /i /y /q css    "%ROOT%\css"    >nul
xcopy /e /i /y /q js     "%ROOT%\js"     >nul
xcopy /e /i /y /q assets "%ROOT%\assets" >nul

set "IP="
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$a=Get-NetIPAddress -AddressFamily IPv4; foreach($x in $a){ if($x.IPAddress -notlike '127.*' -and $x.IPAddress -notlike '169.254*' -and $x.PrefixOrigin -ne 'WellKnown'){ $x.IPAddress; break } }"`) do set "IP=%%i"
if not defined IP for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$a=Get-NetIPAddress -AddressFamily IPv4; foreach($x in $a){ if($x.IPAddress -notlike '127.*'){ $x.IPAddress; break } }"`) do set "IP=%%i"

echo.
echo  ============================================================
echo   On the tablet (same Wi-Fi as this PC), open:
echo.
if defined IP echo        http://!IP!:%PORT%/
if not defined IP echo        (no network address found - connect to Wi-Fi)
echo.
echo   Plain http://, so the tablet will NOT offer to install this
echo   as an app and the service worker stays off. That means every
echo   reload gets the newest files - no cache fights.
echo.
echo   Close this window to stop sharing.
echo  ============================================================
echo.
echo   If Windows asks about the firewall, allow Private networks.
echo   Re-run this script after editing any file.
echo.

python -m http.server %PORT% --bind 0.0.0.0 --directory "%ROOT%"
if errorlevel 1 (
  echo.
  echo   The server stopped early. If it mentioned "address already in use",
  echo   "permission", or "forbidden by its access permissions", change the
  echo   port list in this file and run it again.
  echo.
  pause
)
