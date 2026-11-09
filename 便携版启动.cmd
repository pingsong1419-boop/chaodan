@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 订单抄单自动化

if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" "%~dp0src\index.js"
) else (
  where node >nul 2>nul
  if errorlevel 1 goto no_node
  node "%~dp0src\index.js"
)

echo.
echo 程序已经退出。按任意键关闭窗口。
pause >nul
exit /b 0

:no_node
echo 未找到随包运行环境，也未检测到 Node.js。
echo 请确认压缩包已经完整解压后再运行。
pause
exit /b 1
