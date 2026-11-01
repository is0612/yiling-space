[CmdletBinding()]
param(
    [string]$ContainerName = "yiling-hub-db",
    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"
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
$backupDir = Join-Path $repoRoot "backups"
[System.IO.Directory]::CreateDirectory($backupDir) | Out-Null

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$safeDbName = $dbName -replace '[^a-zA-Z0-9_-]', '_'
$fileName = "yiling-hub-$safeDbName-$timestamp.dump"
$hostPath = Join-Path $backupDir $fileName
$containerPath = "/backups/$fileName"

Write-Host "Ensuring database container '$ContainerName' is running..."
& $docker start $ContainerName 2>$null
if ($LASTEXITCODE -ne 0) {
    & $docker compose up -d db 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Could not start container '$ContainerName'. Start it from Docker Desktop first."
    }
}

Write-Host "Waiting for the database to become ready..."
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    & $docker exec $ContainerName pg_isready --username $dbUser --dbname $dbName *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 2
}
if (-not $ready) { throw "Database was not ready within 60 seconds. Check the container logs." }

Write-Host "Creating backup: $hostPath"
& $docker exec $ContainerName pg_dump --username $dbUser --dbname $dbName --format=custom --file=$containerPath
if ($LASTEXITCODE -ne 0) {
    if (Test-Path $hostPath) { Remove-Item $hostPath -Force }
    throw "pg_dump failed. Check the database status and permissions."
}
if (-not (Test-Path $hostPath) -or (Get-Item $hostPath).Length -le 0) {
    throw "Backup file is missing or empty: $hostPath"
}

Write-Host "Backup complete. Store this file safely outside the repository."
Write-Host $hostPath

# The database holds encrypted credentials (channel tokens, model API keys) whose key file
# lives outside Postgres: .data/credentials-encryption.key. Restoring the dump without it
# leaves every credential undecryptable — silently, with no error, just empty fields.
# So copy it alongside the dump; both files are required for a complete restore.
$keySource = Join-Path $repoRoot ".data\credentials-encryption.key"
$keyTarget = Join-Path $backupDir ($fileName -replace '\.dump$', '.key')
if (Test-Path $keySource) {
    Copy-Item -Path $keySource -Destination $keyTarget -Force
    Write-Host "Encryption key copied: $keyTarget"
    Write-Host "Restore needs BOTH the .dump and the .key file."
} else {
    Write-Warning "No encryption key at $keySource. This backup cannot decrypt channel tokens or model API keys; they will need to be re-entered after a restore."
}
