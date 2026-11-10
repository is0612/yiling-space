@echo off
setlocal
chcp 65001 >nul
title Yiling Space
cd /d "%~dp0"
if exist "%~dp0package.json" goto LOCAL
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\usage-desktop.ps1" -Mode start
goto DONE
:LOCAL
node "%~dp0scripts\launch.mjs" --production
:DONE
set "RESULT=%ERRORLEVEL%"
echo.
if not "%RESULT%"=="0" echo [ERROR] Start failed. See the message above.
if not defined YILING_NO_PAUSE pause
exit /b %RESULT%
