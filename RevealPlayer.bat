@echo off
chcp 65001 >nul
title RevealPlayer
cd /d "%~dp0"
echo RevealPlayer 正在启动...
start "" http://localhost:5174
npx vite --port 5174
