[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BackupFile,

    [switch]$ConfirmOverwrite,

    # Restore into this database instead of the one from .env. Used for drills: the target is
    # a scratch database, the production one stays untouched, and no interactive prompt is asked.
    [string]$TargetDb = "",

    [string]$ContainerName = "yiling-hub-db",

    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"

if (-not $ConfirmOverwrite) {
    throw "Restore overwrites the target database. Confirm the target and the backup, then re-run with -ConfirmOverwrite."
}

if ($RepoRoot) {
    $repoRoot = (Resolve-Path $RepoRoot).Path
} elseif ($PSScriptRoot) {
    $repoRoot = Split-Path -Parent $PSScriptRoot
} else {
    $repoRoot = (Get-Location).Path
}
Set-Location $repoRoot

function Get-DockerExe {
    $cmd = Get-Command docker -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $candidates = @(
        "C:\Program Files\Docker\Docker\resources\bin\docker.exe",
        "C:\Program Files (x86)\Docker\Docker\resources\bin\docker.exe"
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { return $candidate }
    }
    throw "docker was not found. Install Docker Desktop or add docker to PATH."
}

$docker = Get-DockerExe

function Get-EnvValue([string]$Name, [string]$DefaultValue) {
    $envPath = Join-Path $repoRoot ".env"
    if (-not (Test-Path $envPath)) {
        throw "Missing .env. Copy .env.example to .env and configure the local database first."
    }

    foreach ($line in [System.IO.File]::ReadAllLines($envPath)) {
        if ($line -match "^\s*$([regex]::Escape($Name))\s*=\s*(.*?)\s*$") {
            $value = $Matches[1].Trim()
            if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
                ($value.StartsWith("'") -and $value.EndsWith("'"))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            return $value
        }
    }
    return $DefaultValue
}

$dbName = Get-EnvValue "POSTGRES_DB" "yiling_hub"
$dbUser = Get-EnvValue "POSTGRES_USER" "yiling_hub"

$targetDb = if ($TargetDb) { $TargetDb } else { $dbName }
$isDrill = $targetDb -ne $dbName
if ($isDrill -and $targetDb -notmatch '^[a-z0-9_]+$') {
    throw "TargetDb may only contain lowercase letters, digits and underscores: '$targetDb'"
}
$backupDir = [System.IO.Path]::GetFullPath((Join-Path $repoRoot "backups"))
[System.IO.Directory]::CreateDirectory($backupDir) | Out-Null

if ([System.IO.Path]::IsPathRooted($BackupFile)) {
    $backupPath = [System.IO.Path]::GetFullPath($BackupFile)
} else {
    $backupPath = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $BackupFile))
}

# Restrict restores to files inside the repository backups directory.
$prefix = $backupDir.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $backupPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "For safety, backups may only be restored from the repository backups directory."
}
if (-not (Test-Path $backupPath -PathType Leaf)) {
    throw "Backup file not found: $backupPath"
}
if ((Get-Item $backupPath).Length -le 0) {
    throw "Backup file is empty: $backupPath"
}

$fileName = [System.IO.Path]::GetFileName($backupPath)
$containerPath = "/backups/$fileName"

if ($isDrill) {
    # Drill target: production is not touched, so no "type RESTORE" prompt — that prompt is
    # exactly what made drills impossible to script before.
    Write-Warning "Drill restore into '$targetDb'. Production database '$dbName' is NOT touched."
} else {
    Write-Warning "This will drop existing objects in database '$targetDb' and restore '$fileName'. It cannot be easily undone."
    $answer = Read-Host "Type RESTORE to continue"
    if ($answer -cne "RESTORE") {
        Write-Host "Restore cancelled."
        exit 0
    }
}

Write-Host "Ensuring database container '$ContainerName' is running..."
& $docker start $ContainerName 2>$null
if ($LASTEXITCODE -ne 0) {
    & $docker compose up -d db 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Could not start container '$ContainerName'."
    }
}

$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    & $docker exec $ContainerName pg_isready --username $dbUser --dbname $dbName *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 2
}
if (-not $ready) { throw "Database was not ready within 60 seconds. Check the container logs." }

if ($isDrill) {
    # Create the scratch database when it does not exist yet, so a drill is one command.
    $exists = & $docker exec $ContainerName psql --username $dbUser --dbname postgres --tuples-only --no-align --command "SELECT 1 FROM pg_database WHERE datname = '$targetDb'"
    if ($LASTEXITCODE -ne 0) { throw "Could not list databases in container '$ContainerName'." }
    if (($exists | Out-String).Trim() -ne "1") {
        Write-Host "Creating drill database '$targetDb'..."
        & $docker exec $ContainerName createdb --username $dbUser $targetDb
        if ($LASTEXITCODE -ne 0) { throw "Could not create database '$targetDb'." }
    }
}

& $docker exec $ContainerName pg_restore --username $dbUser --dbname $targetDb --clean --if-exists --no-owner --no-privileges --exit-on-error $containerPath
if ($LASTEXITCODE -ne 0) {
    throw "pg_restore failed. The target database may be partially restored. Keep the original backup and consider restoring into a fresh empty database."
}

if ($isDrill) {
    Write-Host "Drill restore finished into '$targetDb'. Compare it against '$dbName', then drop it:"
    Write-Host "  docker exec $ContainerName dropdb --username $dbUser $targetDb"
} else {
    Write-Host "Restore finished. Start the app and verify characters, messages, memories, snapshots and tasks."
}

# The dump does not contain the credential encryption key, so a restore is only usable if the
# key file is back in place. Without it every channel token and model API key stays encrypted
# and unreadable — silently, with no error.
$keyPath = Join-Path $repoRoot ".data\credentials-encryption.key"
if (-not (Test-Path $keyPath)) {
    Write-Warning "Missing $keyPath. Channel tokens and model API keys in this database cannot be decrypted. Restore the matching .key file produced by backup-db.ps1, or re-enter the credentials."
}
