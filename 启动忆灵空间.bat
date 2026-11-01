@echo off
rem One-click launcher for Yiling Space. Double-click this file.
rem All real logic and all Chinese output live in scripts\launch.mjs --
rem this wrapper stays ASCII-only so the cmd code page can never garble it.
chcp 65001 >nul
title %~n0
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js not found.
  echo Install Node 20.19+ from https://nodejs.org/ then double-click this file again.
  echo.
  pause
  exit /b 1
)

node "scripts\launch.mjs"
set "EXITCODE=%ERRORLEVEL%"

echo.
if not "%EXITCODE%"=="0" echo [EXITCODE %EXITCODE%]
echo Press any key to close this window...
pause >nul
