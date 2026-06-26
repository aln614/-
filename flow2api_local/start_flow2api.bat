@echo off
chcp 65001 >nul
cd /d "%~dp0"
docker compose up -d --build
if errorlevel 1 (
  echo Flow2API 启动失败，请确认 Docker Desktop 已启动。
  pause
  exit /b 1
)
echo Flow2API 已启动：http://127.0.0.1:38000
timeout /t 3 >nul
start "" "http://127.0.0.1:38000"
