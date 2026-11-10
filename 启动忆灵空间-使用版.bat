@echo off
rem One-click launcher for Yiling Space (usage build, Docker).
rem ASCII only: this file must never depend on the cmd code page.
rem Chinese docs and all explanations live in 使用说明.md
chcp 65001 >nul
title Yiling Space

cd /d "%~dp0"

echo.
echo   Yiling Space
echo   ------------
echo.

rem [1/3] Docker
where docker >nul 2>nul
if errorlevel 1 (
  echo   [ERROR] Docker is not installed or not in PATH.
  echo           Install Docker Desktop first, then run this again.
  echo.
  pause
  exit /b 1
)
docker info >nul 2>nul
if errorlevel 1 (
  echo   [ERROR] Docker is installed but not running.
  echo           Start Docker Desktop and wait until it says "Running", then run this again.
  echo.
  pause
  exit /b 1
)
echo   [1/3] Docker .......... OK

rem [2/3] Config file
if not exist ".env" (
  if exist "prod.env.example" (
    copy /Y "prod.env.example" ".env" >nul
    echo   [2/3] Config .......... created .env from prod.env.example
  ) else (
    echo   [ERROR] Missing .env and prod.env.example.
    pause
    exit /b 1
  )
) else (
  echo   [2/3] Config .......... .env found
)

rem Read APP_PORT from .env, fall back to 8801.
set "APP_PORT=8801"
for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
  if /i "%%a"=="APP_PORT" set "APP_PORT=%%b"
)

rem Image must exist before compose up; otherwise compose tries to pull from a registry.
docker image inspect yiling-space:latest >nul 2>nul
if errorlevel 1 (
  echo   [3/3] Image ........... not loaded yet, loading from updates\ ...
  call :LOAD_PACKAGE
)

echo   [3/3] Image ........... ready
echo.
echo   Starting containers...
docker compose -f docker-compose.prod.yml up -d
if errorlevel 1 (
  echo.
  echo   [ERROR] docker compose failed. See the output above.
  pause
  exit /b 1
)

echo.
echo   Waiting for the web server...
set /a WAITED=0
:WAIT_LOOP
ping -n 3 127.0.0.1 >nul
set /a WAITED+=2
docker compose -f docker-compose.prod.yml ps --format "{{.Health}}" 2>nul | findstr /i "healthy" >nul && goto READY
if %WAITED% GEQ 120 goto SLOW
goto WAIT_LOOP

:READY
echo   Ready:  http://127.0.0.1:%APP_PORT%
echo.
echo   First run: log in as "admin" with DEV_OWNER_PASSWORD from .env
start "" "http://127.0.0.1:%APP_PORT%"
echo   Logs:   docker compose -f docker-compose.prod.yml logs -f app
echo   Stop:   docker compose -f docker-compose.prod.yml down
echo.
pause
exit /b 0

:SLOW
echo   Still starting (database first boot can take a while).
echo   Open http://127.0.0.1:%APP_PORT% in a minute; if it fails, check:
echo     docker compose -f docker-compose.prod.yml logs --tail 50 app
echo.
pause
exit /b 0

:LOAD_PACKAGE
set "FOUND="
for %%f in ("updates\*.tar") do (
  echo         loading %%~nxf
  docker load -i "%%f"
  set "FOUND=1"
)
for %%f in ("updates\*.tar.gz") do (
  echo         loading %%~nxf
  docker load -i "%%f"
  set "FOUND=1"
)
if not defined FOUND (
  echo.
  echo   [ERROR] No image found and no package in updates\.
  echo           Put the release file ^(yiling-space-*.tar^) into the updates folder,
  echo           or run 更新到最新版.bat.
  echo.
  pause
  exit /b 1
)
exit /b 0
