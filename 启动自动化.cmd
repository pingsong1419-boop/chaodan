@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0启动面板.ps1"
if errorlevel 1 (
  echo.
  echo 启动失败，请截图此窗口中的错误信息。
  pause
)
