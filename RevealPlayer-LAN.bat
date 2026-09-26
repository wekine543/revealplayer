@echo off
chcp 65001 >nul
title RevealPlayer (LAN)
cd /d "%~dp0"
echo RevealPlayer LAN mode: phones / tablets on the same Wi-Fi can open it.
echo.
echo Your LAN addresses (open one of these on the phone, add :5174):
ipconfig | findstr /i "IPv4"
echo.
echo Note: while this runs, devices on the same network can reach the app and
echo       the local helper service. Do not use it on untrusted networks.
echo.
start "" http://localhost:5174
npx vite --port 5174 --host
