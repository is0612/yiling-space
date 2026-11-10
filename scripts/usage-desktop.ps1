param(
    [ValidateSet('start', 'update')][string]$Mode = 'start'
)

$ErrorActionPreference = 'Stop'

function Invoke-Docker {
    param([string[]]$Arguments)
    & $script:Docker @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Docker 命令失败（退出码 $LASTEXITCODE）：docker $($Arguments -join ' ')" }
}

function Invoke-Compose {
    param([string[]]$Arguments)
    Invoke-Docker -Arguments (@('compose', '--env-file', $script:EnvFile, '-f', $script:ComposeFile) + $Arguments)
}

function Get-ServiceState {
    param([string]$Service)
    $ids = @(Invoke-Compose -Arguments @('ps', '-a', '-q', $Service))
    if (!$ids.Count) { return $null }
    $json = (Invoke-Docker -Arguments @('inspect', [string]$ids[0])) -join "`n"
    return @($json | ConvertFrom-Json)[0]
}

function Wait-Service {
    param([string]$Service, [int]$Seconds = 180)
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        $container = Get-ServiceState $Service
        if ($container) {
            $status = $container.State.Status
            $health = $container.State.Health.Status
            if ($status -in @('exited', 'dead', 'restarting') -or $health -eq 'unhealthy') {
                throw "$Service 启动失败（状态：$status，健康状态：$health）。请查看下方日志。"
            }
            if ($status -eq 'running' -and $health -eq 'healthy') { return }
        }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$Service 在 $Seconds 秒内未就绪。请查看日志，排除问题后重新运行。"
}

function Select-UpdatePackage {
    param([string]$Root)
    $files = @(Get-ChildItem -LiteralPath (Join-Path $Root 'updates') -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^yiling-space-(\d+\.\d+\.\d+)\.(tar|tar\.gz)$' } |
        Sort-Object @{ Expression = { [version]([regex]::Match($_.Name, '\d+\.\d+\.\d+').Value) }; Descending = $true },
                    @{ Expression = { $_.LastWriteTimeUtc }; Descending = $true })
    if (!$files.Count) { return $null }
    Write-Host "使用镜像包：$($files[0].Name)（如需更新，请先放入新版本的镜像包）"
    return $files[0].FullName
}

function Import-AppImage {
    param([string]$Package, [switch]$Pull)
    if ($Package) {
        $loaded = @(Invoke-Docker -Arguments @('load', '-i', $Package))
        $loaded | ForEach-Object { Write-Host $_ }
        if (!($loaded | Where-Object { $_.Trim() -eq "Loaded image: $script:Image" })) {
            throw "镜像包未包含配置的镜像 $script:Image，停止操作。请核对 YILING_IMAGE 与发布包。"
        }
    }
    elseif ($Pull) { Invoke-Compose -Arguments @('pull', 'app') }
    else {
        if (Test-Path -LiteralPath (Join-Path (Split-Path $script:ComposeFile -Parent) 'Dockerfile')) {
            throw '源码目录尚未构建使用版镜像。请先在项目根目录执行 node scripts/docker-pack.mjs --no-save，构建成功后重新启动。构建需要能访问 Docker 镜像仓库；开发版入口无需此镜像。'
        }
        throw '发布包不完整：缺少使用版镜像。请将发布包中的 yiling-space-版本.tar 放入 updates 文件夹，再重新启动。'
    }
    Invoke-Docker -Arguments @('image', 'inspect', $script:Image, '--format', '{{.Id}}') | Out-Null
}

function Backup-UsageData {
    param([string]$Root)
    Wait-Service 'db'
    $name = 'pre-update-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
    $directory = Join-Path $Root 'backups'
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $dump = Join-Path $directory ($name + '.dump')
    $data = Join-Path $directory ($name + '-app-data.tar.gz')
    Write-Host '备份数据库与应用数据（包含凭据解密密钥、表情包等）…'
    # Binary stays inside Docker / docker cp; PowerShell 5.1 redirection corrupts binary output.
    $remote = '/tmp/' + $name + '.dump'
    Invoke-Compose -Arguments @('exec', '-T', 'db', 'sh', '-c', 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f "$1"', 'sh', $remote)
    Invoke-Compose -Arguments @('exec', '-T', 'db', 'pg_restore', '--list', $remote) | Out-Null
    $db = Get-ServiceState 'db'
    Invoke-Docker -Arguments @('cp', ($db.Id + ':' + $remote), $dump)
    if (!(Test-Path -LiteralPath $dump) -or (Get-Item -LiteralPath $dump).Length -eq 0) { throw '数据库备份为空，停止更新。' }
    # Use the OLD application image and its actual mount, even when app is stopped.
    $app = Get-ServiceState 'app'
    $mount = @($app.Mounts | Where-Object { $_.Destination -eq '/app/.data' })
    if (!$app -or $mount.Count -ne 1 -or $mount[0].Type -ne 'volume') { throw '无法确定原应用数据卷，停止更新。' }
    Invoke-Docker -Arguments @('run', '--rm', '--network', 'none', '--entrypoint', 'tar',
        '--mount', ('type=volume,src=' + $mount[0].Name + ',dst=/source,readonly'),
        '--mount', ('type=bind,src=' + $directory + ',dst=/backup'), $app.Image,
        '-czf', ('/backup/' + $name + '-app-data.tar.gz'), '-C', '/source', '.')
    if (!(Test-Path -LiteralPath $data) -or (Get-Item -LiteralPath $data).Length -eq 0) { throw '应用数据备份为空，停止更新。' }
    Copy-Item -LiteralPath $script:EnvFile -Destination (Join-Path $directory ($name + '.env'))
    @{ imageId = $app.Image; appDataVolume = $mount[0].Name; databaseContainer = $db.Id; createdAt = [DateTime]::UtcNow.ToString('o') } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $directory ($name + '.json')) -Encoding UTF8
    Invoke-Compose -Arguments @('exec', '-T', 'db', 'rm', '-f', $remote)
    Write-Host "备份完成：$directory\$name.*（包含私人数据，请妥善保管）"
}

function Invoke-UsageDesktop {
    param([string]$Root, [string]$Action)
    $script:Docker = 'docker'
    if (!(Get-Command docker -ErrorAction SilentlyContinue)) {
        $fallback = Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe'
        if (!(Test-Path -LiteralPath $fallback)) { throw '未找到 Docker Desktop，请安装后重新运行。' }
        $script:Docker = $fallback
    }
    Invoke-Docker -Arguments @('info', '--format', '{{.OSType}}') | Out-Null
    Invoke-Docker -Arguments @('compose', 'version') | Out-Null
    $script:ComposeFile = Join-Path $Root 'docker-compose.prod.yml'
    if (!(Test-Path -LiteralPath $script:ComposeFile)) { throw '缺少 docker-compose.prod.yml，请使用完整发布包。' }
    # A source checkout already has a development .env; never reuse it for production.
    $envName = if (Test-Path -LiteralPath (Join-Path $Root 'package.json')) { '.env.prod' } else { '.env' }
    $script:EnvFile = Join-Path $Root $envName
    if (!(Test-Path -LiteralPath $script:EnvFile)) {
        if ($Action -eq 'update') { throw "缺少 $envName，请先运行使用版启动脚本。" }
        $template = Join-Path $Root 'prod.env.example'
        if (!(Test-Path -LiteralPath $template)) { throw '缺少 prod.env.example，请使用完整发布包。' }
        $text = [IO.File]::ReadAllText($template)
        foreach ($placeholder in @('__POSTGRES_PASSWORD__', '__ADMIN_PASSWORD__')) {
            $bytes = New-Object byte[] 24
            $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
            try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
            $password = [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
            $text = $text.Replace($placeholder, $password)
        }
        [IO.File]::WriteAllText($script:EnvFile, $text, (New-Object Text.UTF8Encoding($false)))
        Write-Host "已创建 $envName，管理员账号和初始密码请查看其中的 DEV_OWNER_*。"
    }
    $previousEnv = $env:YILING_ENV_FILE
    $savedVariables = @{}
    # Compose gives parent environment precedence; isolate settings from the development launcher.
    foreach ($key in @('APP_PORT', 'YILING_IMAGE', 'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'COMPOSE_FILE', 'COMPOSE_PROJECT_NAME', 'COMPOSE_PROFILES')) {
        $savedVariables[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, $null, 'Process')
    }
    try {
        $env:YILING_ENV_FILE = $script:EnvFile
        $config = ((Invoke-Compose -Arguments @('config', '--format', 'json')) -join "`n") | ConvertFrom-Json
        $script:Image = $config.services.app.image
        $port = [int]$config.services.app.ports[0].published
        if (!$script:Image -or !$port) { throw '无法读取使用版的镜像或端口配置。' }
        $url = "http://127.0.0.1:$port"
        $package = Select-UpdatePackage $Root
        if ($Action -eq 'update') {
            $app = Get-ServiceState 'app'
            if (!$app) {
                Write-Host '尚未安装使用版容器，转入首次启动流程。'
                Invoke-UsageDesktop -Root $Root -Action 'start'
                return
            }
            if (!$package -and $script:Image -notmatch '^[^/]+[.:][^/]*/') {
                throw '未发现新版本镜像包，现有服务保持运行。请将新版 yiling-space-X.Y.Z.tar 放入 updates 文件夹后重试；源码目录需要先执行 node scripts/docker-pack.mjs 生成发布包。启动现有版本请运行启动脚本。'
            }
            $wasRunning = $app.State.Running
            Invoke-Compose -Arguments @('up', '-d', 'db')
            Invoke-Compose -Arguments @('stop', 'app')
            try { Backup-UsageData $Root } catch {
                if ($wasRunning) { Invoke-Compose -Arguments @('start', 'app') }
                throw
            }
            try { Import-AppImage -Package $package -Pull } catch {
                if ($wasRunning) { Invoke-Compose -Arguments @('start', 'app') }
                throw
            }
        } else {
            $imageExists = $false
            try {
                Invoke-Docker -Arguments @('image', 'inspect', $script:Image) | Out-Null
                $imageExists = $true
            } catch { $imageExists = $false }
            if (!$imageExists) { Import-AppImage -Package $package }
        }
        Write-Host '启动使用版，等待数据库迁移、网页及后台进程就绪…'
        Invoke-Compose -Arguments @('up', '-d')
        Wait-Service 'app'
        $response = Invoke-WebRequest -UseBasicParsing -Uri "$url/api/health" -TimeoutSec 10
        if ($response.StatusCode -ne 200) { throw '宿主机无法访问使用版健康检查接口。' }
        Write-Host "使用版已就绪：$url"
        Write-Host "配置：$script:EnvFile；已有账号的密码以网页里修改后的为准。"
        if ($Action -eq 'start') { Start-Process $url }
    } catch {
        Write-Host '操作失败，以下为应用最近日志：' -ForegroundColor Red
        try { Invoke-Compose -Arguments @('logs', '--tail', '60', 'app') } catch { Write-Host '日志暂不可用。' }
        throw
    } finally {
        $env:YILING_ENV_FILE = $previousEnv
        foreach ($key in $savedVariables.Keys) {
            [Environment]::SetEnvironmentVariable($key, $savedVariables[$key], 'Process')
        }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        Invoke-UsageDesktop -Root (Split-Path $PSScriptRoot -Parent) -Action $Mode
        exit 0
    } catch {
        Write-Host "错误：$($_.Exception.Message)" -ForegroundColor Red
        Write-Host '未自动回滚数据库；请保留备份，排除错误后重试。'
        exit 1
    }
}
