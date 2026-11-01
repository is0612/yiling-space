@echo off
cd /d "%~dp0.."
if "%~1"=="" (
  echo Usage: restore-db.bat backups\yiling-hub-YYYYMMDD-HHMMSS.dump
  echo.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restore-db.ps1" -BackupFile "%~1" -ConfirmOverwrite
echo.
pause
