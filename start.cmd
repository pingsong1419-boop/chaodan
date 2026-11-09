@echo off
cd /d "%~dp0"
if exist "startup-error.log" del /q "startup-error.log"
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0app.ps1" 2>"%~dp0startup-error.log"
set EXIT_CODE=%ERRORLEVEL%
if not "%EXIT_CODE%"=="0" goto failed
exit /b 0

:failed
echo.
echo The control panel failed to start. Error log:
echo.
type "%~dp0startup-error.log"
echo.
pause
exit /b %EXIT_CODE%
