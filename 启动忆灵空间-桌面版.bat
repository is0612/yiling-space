@echo off
rem ===========================================================================
rem  Yiling Space desktop launcher.
rem  Double-click this file. All real logic lives in desktop\launch.cjs.
rem  This wrapper stays ASCII-only so the cmd code page cannot garble it.
rem ===========================================================================

chcp 65001 >nul
title Yiling Space Desktop
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :nonode

where yarn >nul 2>nul
if errorlevel 1 goto :noyarn

if exist "desktop\node_modules\electron\dist\electron.exe" goto :start

echo.
echo First run: installing the desktop runtime (Electron, about 100 MB).
echo If download fails, set the mirror and run again:
echo   set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
echo.
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
call yarn desktop:install
if errorlevel 1 goto :installfail

:start
call yarn desktop
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" echo [ERROR] Desktop exited with code %EXITCODE%.
echo.
echo Press any key to close this window...
pause >nul
exit /b %EXITCODE%

:nonode
echo.
echo [ERROR] Node.js was not found.
echo Install Node.js 20.19+ from https://nodejs.org and try again.
echo.
pause
exit /b 1

:noyarn
echo.
echo [ERROR] yarn was not found.
echo Open a terminal in this folder and run:
echo   npm install -g yarn@1.22.22
echo then double-click this file again.
echo.
pause
exit /b 1

:installfail
echo.
echo [ERROR] Desktop runtime install failed.
echo Check the network or set ELECTRON_MIRROR, then try again.
echo You can also run manually: yarn desktop:install
echo.
pause
exit /b 1
