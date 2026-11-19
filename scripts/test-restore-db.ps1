[CmdletBinding()]
param()

# Offline integration test: only an ephemeral, network-isolated PostgreSQL container
# and synthetic fixtures are used. Never reads the checkout's .env or database.
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$runId = [guid]::NewGuid().ToString("N")
$fixtureRoot = Join-Path $repo ".data/restore-atomicity-$runId"
$backups = Join-Path $fixtureRoot "backups"
$container = "yiling-restore-test-$runId"
$started = $false

function Invoke-DockerChecked {
    param([string[]]$DockerArgs)
    $output = & docker @DockerArgs 2>&1
    if ($LASTEXITCODE -ne 0) { throw "docker command failed: $($output | Out-String)" }
    return $output
}
function Invoke-Sql([string]$Database, [string]$Sql) {
    Invoke-DockerChecked -DockerArgs @("exec", $container, "psql", "-U", "fixture", "-d", $Database, "-v", "ON_ERROR_STOP=1", "-At", "-c", $Sql)
}
function Assert-Equal($Actual, [string]$Expected, [string]$Label) {
    if (($Actual | Out-String).Trim() -ne $Expected) { throw "Assertion failed: $Label" }
}

try {
    New-Item -ItemType Directory -Path $backups -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $fixtureRoot ".env") -Value "POSTGRES_DB=postgres`nPOSTGRES_USER=fixture"
    Invoke-DockerChecked -DockerArgs @("run", "--pull", "never", "--detach", "--name", $container, "--network", "none", "--env", "POSTGRES_USER=fixture", "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "--mount", "type=bind,source=$backups,target=/backups", "--tmpfs", "/var/lib/postgresql/data", "postgres:16-alpine") | Out-Null
    $started = $true
    $ready = $false
    for ($index = 0; $index -lt 30; $index++) {
        & docker exec $container pg_isready -U fixture -d postgres *> $null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw "Isolated fixture database did not become ready." }

    Invoke-Sql "postgres" "CREATE DATABASE fixture_source" | Out-Null
    Invoke-Sql "postgres" "CREATE DATABASE fixture_target" | Out-Null
    Invoke-Sql "fixture_source" "CREATE TABLE a_records (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO a_records VALUES (1, 'from-backup');" | Out-Null
    Invoke-DockerChecked -DockerArgs @("exec", $container, "pg_dump", "-U", "fixture", "-d", "fixture_source", "-Fc", "-f", "/backups/success.dump") | Out-Null
    Invoke-Sql "fixture_target" "CREATE TABLE a_records (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO a_records VALUES (1, 'original');" | Out-Null
    & (Join-Path $PSScriptRoot "restore-db.ps1") -BackupFile "backups/success.dump" -ConfirmOverwrite -TargetDb "fixture_target" -ContainerName $container -RepoRoot $fixtureRoot
    Assert-Equal (Invoke-Sql "fixture_target" "SELECT value FROM a_records WHERE id = 1") "from-backup" "successful restore applies backup"

    # The archive is valid, but intentionally omits a dependency. pg_restore has
    # already dropped/recreated a_records before CREATE TABLE z_failure fails.
    Invoke-Sql "fixture_source" "CREATE SCHEMA omitted; CREATE FUNCTION omitted.valid(integer) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true'; CREATE TABLE z_failure (id integer CHECK (omitted.valid(id)));" | Out-Null
    Invoke-DockerChecked -DockerArgs @("exec", $container, "pg_dump", "-U", "fixture", "-d", "fixture_source", "-Fc", "--exclude-schema=omitted", "-f", "/backups/failure.dump") | Out-Null
    # Control: prove this fixture really destroys prior state without the guard.
    Invoke-Sql "postgres" "CREATE DATABASE fixture_control" | Out-Null
    Invoke-Sql "fixture_control" "CREATE TABLE a_records (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO a_records VALUES (1, 'control-sentinel');" | Out-Null
    $controlOutput = & docker exec $container pg_restore -U fixture -d fixture_control --clean --if-exists --no-owner --no-privileges --exit-on-error /backups/failure.dump 2>&1
    if ($LASTEXITCODE -eq 0) { throw "Nontransactional control unexpectedly succeeded." }
    Assert-Equal (Invoke-Sql "fixture_control" "SELECT count(*) FROM a_records") "0" "control demonstrates cleanup applied before failure"

    Invoke-Sql "fixture_target" "UPDATE a_records SET value = 'sentinel-before-failure';" | Out-Null
    $failed = $false
    try {
        & (Join-Path $PSScriptRoot "restore-db.ps1") -BackupFile "backups/failure.dump" -ConfirmOverwrite -TargetDb "fixture_target" -ContainerName $container -RepoRoot $fixtureRoot
    } catch {
        if ($_.Exception.Message -notmatch "restore transaction was not committed") { throw }
        $failed = $true
    }
    if (-not $failed) { throw "Restore with omitted dependency unexpectedly succeeded." }
    Assert-Equal (Invoke-Sql "fixture_target" "SELECT value FROM a_records WHERE id = 1") "sentinel-before-failure" "failed restore rolls back cleanup and schema/data changes"
    Assert-Equal (Invoke-Sql "fixture_target" "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'z_failure'") "0" "failed restore creates no partial tables"
    Write-Host "PASS: successful restore and mid-restore failure atomicity (isolated synthetic PostgreSQL)."
} finally {
    if ($started) { & docker rm --force $container | Out-Null }
    # Keep the uniquely named synthetic dumps for inspection; never delete user files.
    Write-Host "Synthetic test fixtures: $fixtureRoot"
}
