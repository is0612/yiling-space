@echo off
rem Update Yiling Space (usage build) to the newest release: image + database schema.
rem ASCII only. Chinese docs live in the readme (shouce) file.
rem Notes for whoever edits this file:
rem   * cmd does NOT treat single quotes as quoting -> always use double quotes for sh -c.
rem   * never hardcode a path with non-ASCII characters: use %~dp0 only.
rem   * use "ping -n" instead of "timeout /t" so the script also works with redirected input.
chcp 65001 >nul
title Yiling Space - Update

cd /d "%~dp0"

echo.
echo   Yiling Space - update
echo   ---------------------
echo.

where docker >nul 2>nul
if errorlevel 1 (
  echo   [ERROR] Docker is not installed or not in PATH.
  pause
  exit /b 1
)
docker info >nul 2>nul
if errorlevel 1 (
  echo   [ERROR] Docker is installed but not running. Start Docker Desktop first.
  pause
  exit /b 1
)

if not exist ".env" (
  echo   [ERROR] .env not found. Run the start script once first.
  pause
  exit /b 1
)

if not exist "backups" mkdir "backups"

set "APP_PORT=8801"
for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
  if /i "%%a"=="APP_PORT" set "APP_PORT=%%b"
)

rem ---------- 1) Back up the database before touching anything ----------
rem Timestamp is computed at top level on purpose: inside an "if (...)" block, redirection
rem needs a different escaping level and "docker run ... 2>nul" turns into a parse error.
set "TS="
for /f %%i in ('docker run --rm --entrypoint date yiling-space:latest +%%Y-%%m-%%d-%%H%%M%%S 2^>nul') do set "TS=%%i"
if not defined TS set "TS=manual"

set "RUNNING="
for /f %%i in ('docker ps --filter "name=yiling-space-postgres" --filter "status=running" -q') do set "RUNNING=%%i"
if defined RUNNING (
  echo   [1/4] Backing up database to backups\pre-update-%TS%.dump ...
  docker compose -f docker-compose.prod.yml exec -T db sh -c "pg_dump -U $POSTGRES_USER -d $POSTGRES_DB -Fc" > "backups\pre-update-%TS%.dump"
  if errorlevel 1 (
    if exist "backups\pre-update-%TS%.dump" del /q "backups\pre-update-%TS%.dump"
    echo.
    echo   [WARN] Backup failed. Nothing has been changed yet.
    echo          Close this window to abort, or press any key to continue without a backup.
    pause
  ) else (
    echo         backup ok: backups\pre-update-%TS%.dump
  )
) else (
  echo   [1/4] Database not running, skip backup.
)

rem ---------- 2) Get the new image ----------
echo   [2/4] Looking for the new image ...
set "GOT="
for %%f in ("updates\*.tar") do (
  echo         loading updates\%%~nxf
  docker load -i "%%f" >nul
  set "GOT=1"
)
for %%f in ("updates\*.tar.gz") do (
  echo         loading updates\%%~nxf
  docker load -i "%%f" >nul
  set "GOT=1"
)
if not defined GOT (
  echo         no package in updates\, trying registry pull ...
  docker compose -f docker-compose.prod.yml pull app
  if errorlevel 1 (
    echo.
    echo   [ERROR] No update package found and pull failed.
    echo           Put the release file yiling-space-*.tar into the updates folder.
    pause
    exit /b 1
  )
)

set "IMGVER=unknown"
for /f %%v in ('docker run --rm --entrypoint cat yiling-space:latest /app/VERSION 2^>nul') do set "IMGVER=%%v"
echo         image version: %IMGVER%

rem ---------- 3) Recreate containers; migrations run automatically on start ----------
echo   [3/4] Restarting with the new image ...
docker compose -f docker-compose.prod.yml up -d
if errorlevel 1 (
  echo.
  echo   [ERROR] docker compose failed. See output above.
  pause
  exit /b 1
)

echo         waiting for the app to finish migrating ...
set /a WAITED=0
:WAIT_LOOP
ping -n 4 127.0.0.1 >nul
set /a WAITED+=3
docker compose -f docker-compose.prod.yml ps --format "{{.Health}}" 2>nul | findstr /i "healthy" >nul && goto DONE
if %WAITED% GEQ 180 goto SLOW
goto WAIT_LOOP

:DONE
echo.
echo   [4/4] Updated to %IMGVER%. Database schema is up to date.
echo         Open http://127.0.0.1:%APP_PORT%  (APP_PORT in .env)
echo         Logs: docker compose -f docker-compose.prod.yml logs --tail 80 app
echo.
pause
exit /b 0

:SLOW
echo.
echo   [WARN] Not healthy after 3 minutes. Nothing was rolled back.
echo          Check:   docker compose -f docker-compose.prod.yml logs --tail 100 app
echo          Backup:  backups\pre-update-*.dump
echo.
pause
exit /b 0
