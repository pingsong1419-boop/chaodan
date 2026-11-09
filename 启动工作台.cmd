@echo off
chcp 65001 >nul
title Order Entry Workbench
cd /d "%~dp0"

where node >nul 2>nul
if not "%ERRORLEVEL%"=="0" (
  echo ==================================================
  echo   [!] node.exe NOT FOUND in PATH
  echo   [!] Install Node.js, or add it to PATH, then retry.
  echo ==================================================
  echo.
  pause
  exit /b 1
)

echo ==================================================
echo   Order Entry Workbench
echo ==================================================
echo.
echo   Browser will open : http://localhost:8787
echo   Keep this window OPEN. Closing it stops the workbench.
echo.
echo --------------------------------------------------
node "workbench\server.mjs" --open
set "EC=%ERRORLEVEL%"
echo --------------------------------------------------
echo.
if not "%EC%"=="0" (
  echo   [!] Workbench exited with code %EC%
  echo   [!] If you did NOT press Ctrl+C or close it, check:
  echo       logs\workbench-crash.log
  echo.
)
echo   Workbench stopped. Press any key to close this window.
pause >nul
