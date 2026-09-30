@echo off
chcp 65001 >nul
title RevealPlayer (LAN)
cd /d "%~dp0"
echo RevealPlayer LAN mode: phones / tablets on the same Wi-Fi can open it.
echo.

rem The server starts first, in the background, so this script can wait for it
rem and open the browser only once it answers. Opening the browser straight
rem away is what used to show "localhost refused to connect".
start /b "" cmd /c npx vite --port 5174 --host

echo Waiting for the server on port 5174 ...
powershell -NoProfile -Command "for ($i=0; $i -lt 120; $i++) { try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:5174/' -UseBasicParsing -TimeoutSec 3; if ($r.StatusCode -eq 200) { exit 0 } } catch { } ; Start-Sleep -Milliseconds 500 } ; exit 1"

if errorlevel 1 (
  echo.
  echo The server did not come up. Read the messages above, fix that, and run
  echo this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo Your LAN addresses - open one of these on the phone, with :5174 added:
ipconfig | findstr /i "IPv4"
echo.
echo Note: while this runs, devices on the same network can reach the app and
echo       the local helper service. Do not use it on untrusted networks.
echo.

start "" http://localhost:5174
echo Ready: http://localhost:5174
echo Leave this window open - closing it stops the server.
echo.

:keepalive
timeout /t 5 >nul
goto keepalive
