@echo off
chcp 65001 >nul
cd /d "%~dp0"
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm install
npm start
pause
