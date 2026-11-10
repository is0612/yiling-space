$ErrorActionPreference = 'Stop'
# No Docker, containers, filesystem fixtures, HTTP requests, or sleeps are used.
$script:SourcePath = Join-Path $PSScriptRoot 'usage-desktop.ps1'
# Explicit UTF-8 loading allows logic tests to run even if the BOM check fails.
. ([scriptblock]::Create([IO.File]::ReadAllText($script:SourcePath, [Text.Encoding]::UTF8)))
$script:Failures = @()
$script:Passed = 0
function Assert-True {
    param($Condition, [string]$Message)
    if (!$Condition) { throw $Message }
}
function Assert-Throws {
    param([scriptblock]$Action, [string]$Pattern)
    $caught = $null
    try { & $Action } catch { $caught = $_ }
    Assert-True ($null -ne $caught) 'Expected an exception.'
    Assert-True ($caught.Exception.Message -match $Pattern) "Unexpected exception: $($caught.Exception.Message)"
}
function Test-Case {
    param([string]$Name, [scriptblock]$Action)
    try { & $Action; $script:Passed++; Write-Host "PASS $Name" }
    catch { $script:Failures += "$Name`: $($_.Exception.Message)"; Write-Host "FAIL $Name`: $($_.Exception.Message)" }
}
Test-Case 'shared script has UTF8 BOM for Windows PowerShell 5.1' {
    $bytes = [IO.File]::ReadAllBytes($script:SourcePath)
    Assert-True ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) 'usage-desktop.ps1 lacks UTF8 BOM.'
}
$script:OriginalDocker = ${function:Invoke-Docker}
$script:OriginalCompose = ${function:Invoke-Compose}
$script:OriginalWait = ${function:Wait-Service}
function Start-Sleep { param($Seconds) $script:Sleeps++ }
function Get-ServiceState {
    param($Service)
    $script:RequestedServices += $Service
    return $script:States[$Service]
}
function New-State {
    param($Status, $Health)
    return [pscustomobject]@{ State = [pscustomobject]@{ Status = $Status; Health = [pscustomobject]@{ Status = $Health } } }
}
Test-Case 'app unhealthy must fail even when db is healthy' {
    $script:States = @{ db = (New-State 'running' 'healthy'); app = (New-State 'running' 'unhealthy') }
    $script:RequestedServices = @()
    Assert-Throws { Wait-Service 'app' -Seconds 0 } 'app.*unhealthy'
    Assert-True (($script:RequestedServices -join ',') -eq 'app') 'Wait-Service inspected a different service.'
}
Test-Case 'app starting must time out even when db is healthy' {
    $script:States.app = New-State 'running' 'starting'
    $script:Sleeps = 0
    Assert-Throws { Wait-Service 'app' -Seconds 0 } 'app.*0'
    Assert-True ($script:Sleeps -eq 1) 'Expected one mocked wait.'
}
Test-Case 'app healthy succeeds without sleeping' {
    $script:States.app = New-State 'running' 'healthy'
    $script:Sleeps = 0
    Wait-Service 'app' -Seconds 0
    Assert-True ($script:Sleeps -eq 0) 'Healthy app should return immediately.'
}
Test-Case 'exited app fails even with stale healthy status' {
    $script:States.app = New-State 'exited' 'healthy'
    Assert-Throws { Wait-Service 'app' -Seconds 0 } 'exited'
}
function Invoke-Docker {
    param([string[]]$Arguments)
    $script:Calls += ,@($Arguments)
    if ($script:FlowEvents) { $script:FlowEvents.Add('docker:' + $Arguments[0]) }
    if ($script:MissingImageOnce -and $Arguments[0] -eq 'image') {
        $script:MissingImageOnce = $false
        throw 'mock image not found'
    }
    if ($script:FailCommand -and $Arguments[0] -eq $script:FailCommand) { throw 'mock Docker failure' }
    if ($Arguments[0] -eq 'load') {
        if ($script:LoadedImageOverride) { return "Loaded image: $script:LoadedImageOverride" }
        return "Loaded image: $script:Image"
    }
}
Test-Case 'image load failure propagates without inspecting stale image' {
    $script:Calls = @(); $script:FailCommand = 'load'
    Assert-Throws { Import-AppImage -Package 'broken.tar' } 'mock Docker failure'
    Assert-True ($script:Calls.Count -eq 1 -and $script:Calls[0][0] -eq 'load') 'Continued after failed load.'
    $script:FailCommand = $null
}
Test-Case 'image load verifies the configured image' {
    $script:Calls = @(); $script:Image = 'custom.example/app:2.0.0'
    Import-AppImage -Package 'release.tar'
    Assert-True ($script:Calls.Count -eq 2) 'Expected load followed by inspect.'
    Assert-True (($script:Calls[1] -join '|') -eq 'image|inspect|custom.example/app:2.0.0|--format|{{.Id}}') 'Wrong inspected image.'
}
Test-Case 'wrong image package fails without accepting preexisting configured image' {
    $script:Calls = @(); $script:LoadedImageOverride = 'unrelated:latest'
    try {
        Assert-Throws { Import-AppImage -Package 'wrong.tar' } '.'
        Assert-True ($script:Calls.Count -eq 1) 'Inspected and accepted a stale configured image.'
    } finally { $script:LoadedImageOverride = $null }
}
Test-Case 'source checkout without image explains build command' {
    function Test-Path { param($LiteralPath) return $true }
    $script:ComposeFile = 'mock/docker-compose.prod.yml'
    Assert-Throws { Import-AppImage } 'node scripts/docker-pack.mjs --no-save'
}
Test-Case 'incomplete release without image explains missing archive' {
    function Test-Path { param($LiteralPath) return $false }
    Assert-Throws { Import-AppImage } 'updates'
}
Test-Case 'native Docker nonzero exit becomes an exception' {
    function Mock-NativeDocker { $global:LASTEXITCODE = 23 }
    $script:Docker = 'Mock-NativeDocker'
    Assert-Throws { & $script:OriginalDocker -Arguments @('load', '-i', 'broken.tar') } '23'
}
function Get-ChildItem { param($LiteralPath, [switch]$File, $ErrorAction) return $script:Packages }
function New-Package {
    param($Name, $Date)
    [pscustomobject]@{ Name = $Name; FullName = "mock/$Name"; LastWriteTimeUtc = [datetime]$Date }
}
Test-Case 'package sort uses semantic version before timestamp' {
    $script:Packages = @(
        (New-Package 'yiling-space-1.9.0.tar' '2026-11-10'),
        (New-Package 'yiling-space-1.10.0.tar' '2026-01-01'),
        (New-Package 'unrelated-99.0.0.tar' '2026-11-11')
    )
    Assert-True ((Select-UpdatePackage 'mock') -eq 'mock/yiling-space-1.10.0.tar') 'Did not select version 1.10.0.'
}
Test-Case 'package sort accepts gzip and breaks equal versions by timestamp' {
    $script:Packages = @(
        (New-Package 'yiling-space-2.0.0.tar' '2026-01-01'),
        (New-Package 'yiling-space-2.0.0.tar.gz' '2026-02-01')
    )
    Assert-True ((Select-UpdatePackage 'mock') -eq 'mock/yiling-space-2.0.0.tar.gz') 'Did not select newer gzip package.'
}
Test-Case 'no valid package returns null' {
    $script:Packages = @((New-Package 'notes.tar' '2026-01-01'))
    Assert-True ($null -eq (Select-UpdatePackage 'mock')) 'Unexpected package selection.'
}
function Wait-Service { param($Service) $script:Waited = $Service }
function Invoke-Compose { param([string[]]$Arguments) $script:ComposeCalls += ,@($Arguments) }
function New-Item { param($ItemType, $Path, [switch]$Force) }
function Test-Path { param($LiteralPath) return $true }
function Get-Item { param($LiteralPath) return [pscustomobject]@{ Length = $script:BackupLength } }
function Copy-Item { param($LiteralPath, $Destination) $script:CopiedEnv = @($LiteralPath, $Destination) }
function Set-Content { param($LiteralPath, $Path, $Value, $Encoding) process { } }
Test-Case 'backup writes dump inside container then cp; archives old volume read-only' {
    $script:Calls = @(); $script:ComposeCalls = @(); $script:FailCommand = $null
    $script:BackupLength = 42; $script:EnvFile = 'mock.env'; $script:CopiedEnv = $null
    $script:States = @{
        db = [pscustomobject]@{ Id = 'db-id' }
        app = [pscustomobject]@{ Image = 'sha256:old-image'; Mounts = @([pscustomobject]@{ Destination = '/app/.data'; Type = 'volume'; Name = 'old-data' }) }
    }
    Backup-UsageData 'mock'
    Assert-True ($script:Waited -eq 'db') 'Database readiness was not checked.'
    $dump = @($script:ComposeCalls | Where-Object { $_ -contains 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f "$1"' })
    Assert-True ($dump.Count -eq 1) 'Dump must use a container file and quoted environment variables.'
    $listing = @($script:ComposeCalls | Where-Object { $_ -contains 'pg_restore' -and $_ -contains '--list' })
    Assert-True ($listing.Count -eq 1) 'Dump archive was not validated.'
    $copy = @($script:Calls | Where-Object { $_[0] -eq 'cp' })
    Assert-True ($copy.Count -eq 1 -and $copy[0][1] -match '^db-id:/tmp/.*\.dump$') 'Missing docker cp from container dump.'
    $archive = @($script:Calls | Where-Object { $_[0] -eq 'run' })
    Assert-True ($archive.Count -eq 1) 'Expected one archive helper.'
    Assert-True ($archive[0] -contains 'sha256:old-image') 'Archive did not use old app image.'
    Assert-True ($archive[0] -contains 'type=volume,src=old-data,dst=/source,readonly') 'Original volume must be read-only.'
    Assert-True ($archive[0] -contains '-czf' -and ($archive[0] -join '|') -match '/backup/.*-app-data\.tar\.gz') 'Archive must write a file in mounted backup directory.'
    Assert-True ($script:CopiedEnv[0] -eq 'mock.env') 'Environment backup missing.'
}
Test-Case 'empty database backup aborts before app-data archive' {
    $script:Calls = @(); $script:ComposeCalls = @(); $script:BackupLength = 0
    Assert-Throws { Backup-UsageData 'mock' } '.'
    Assert-True (@($script:Calls | Where-Object { $_[0] -eq 'run' }).Count -eq 0) 'Continued after empty dump.'
}
Test-Case 'backup AST does not route Docker binary output through PowerShell file writers' {
    $backup = (Get-Command Backup-UsageData).ScriptBlock.Ast
    $redirects = @($backup.FindAll({ param($node) $node -is [System.Management.Automation.Language.FileRedirectionAst] }, $true))
    Assert-True ($redirects.Count -eq 0) 'Backup uses file redirection.'
    $writers = @($backup.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -in @('Out-File', 'Add-Content', 'Tee-Object') }, $true))
    Assert-True ($writers.Count -eq 0) 'Backup uses a text file writer.'
}
# Full orchestration tests replace only the two static filesystem calls with memory mocks.
# PowerShell functions cannot override static .NET methods; all control flow stays intact.
$script:FlowSource = (Get-Command Invoke-UsageDesktop).ScriptBlock.ToString()
$script:FlowSource = $script:FlowSource.Replace('[IO.File]::ReadAllText($template)', '(Read-MockTemplate $template)')
$script:FlowSource = $script:FlowSource.Replace('[IO.File]::WriteAllText($script:EnvFile, $text, (New-Object Text.UTF8Encoding($false)))', '(Write-MockConfig $script:EnvFile $text)')
if ($script:FlowSource -match '\[IO.File\]') { throw 'Unmocked static filesystem operation in orchestration test.' }
$script:Flow = [scriptblock]::Create($script:FlowSource)
function Read-MockTemplate { param($Path) return 'POSTGRES_PASSWORD=__POSTGRES_PASSWORD__;DEV_OWNER_PASSWORD=__ADMIN_PASSWORD__' }
function Write-MockConfig { param($Path, $Text) $script:GeneratedConfig = @($Path, $Text) }
function Test-Path {
    param($LiteralPath)
    return !($LiteralPath -match 'package\.json$|[\\/]\.env$')
}
function docker { $global:LASTEXITCODE = 0 }
function Invoke-Compose {
    param([string[]]$Arguments)
    $script:ComposeCalls += ,@($Arguments)
    if ($null -ne $script:FlowEvents) { $script:FlowEvents.Add('compose:' + ($Arguments -join ' ')) }
    if ($Arguments[0] -eq 'config') { return '{"services":{"app":{"image":"mock:latest","ports":[{"published":"9911"}]}}}' }
}
function Select-UpdatePackage { param($Root) return $script:FlowPackage }
function Wait-Service {
    param($Service)
    if ($null -ne $script:FlowEvents) { $script:FlowEvents.Add('wait:' + $Service) }
    if ($script:FlowWaitFails) { throw 'mock app unhealthy' }
}
function Invoke-WebRequest { param([switch]$UseBasicParsing, $Uri, $TimeoutSec) $script:HttpUri = $Uri; return [pscustomobject]@{ StatusCode = 200 } }
function Start-Process { param($FilePath) $script:OpenedUrl = $FilePath }
Test-Case 'first start creates random configuration then verifies HTTP before opening browser' {
    $script:GeneratedConfig = $null; $script:OpenedUrl = $null; $script:HttpUri = $null
    $script:FlowWaitFails = $false; $script:ComposeCalls = @()
    $previousPort = $env:APP_PORT; $previousEnvFile = $env:YILING_ENV_FILE
    try {
        $env:APP_PORT = '1234'; $env:YILING_ENV_FILE = 'prior.env'
        & $script:Flow -Root 'mock' -Action 'start'
        Assert-True ($script:GeneratedConfig[0] -match '[\\/]\.env$') 'Wrong first-install config path.'
        Assert-True ($script:GeneratedConfig[1] -notmatch '__POSTGRES_PASSWORD__|__ADMIN_PASSWORD__') 'Unexpanded password placeholder.'
        Assert-True ($script:GeneratedConfig[1] -match 'POSTGRES_PASSWORD=[A-Za-z0-9_-]{32};DEV_OWNER_PASSWORD=[A-Za-z0-9_-]{32}$') 'Generated passwords are not URI-safe random values.'
        Assert-True ($script:HttpUri -eq 'http://127.0.0.1:9911/api/health') 'Wrong published HTTP port.'
        Assert-True ($script:OpenedUrl -eq 'http://127.0.0.1:9911') 'Browser did not open expected URL.'
        Assert-True ($env:APP_PORT -eq '1234' -and $env:YILING_ENV_FILE -eq 'prior.env') 'Parent environment not restored.'
    } finally { $env:APP_PORT = $previousPort; $env:YILING_ENV_FILE = $previousEnvFile }
}
Test-Case 'full startup failure propagates without HTTP success or browser launch' {
    $script:FlowWaitFails = $true; $script:OpenedUrl = $null; $script:HttpUri = $null; $script:ComposeCalls = @()
    try {
        Assert-Throws { & $script:Flow -Root 'mock' -Action 'start' } 'mock app unhealthy'
        Assert-True ($null -eq $script:OpenedUrl -and $null -eq $script:HttpUri) 'Failure continued to HTTP/browser.'
        Assert-True (@($script:ComposeCalls | Where-Object { $_[0] -eq 'logs' }).Count -eq 1) 'Failure did not collect app logs.'
    } finally { $script:FlowWaitFails = $false }
}
Test-Case 'first start imports release after missing-image inspection and completes readiness' {
    $script:MissingImageOnce = $true; $script:FlowPackage = 'release.tar'
    $script:Calls = @(); $script:ComposeCalls = @(); $script:OpenedUrl = $null; $script:HttpUri = $null
    try {
        & $script:Flow -Root 'mock' -Action 'start'
        Assert-True (@($script:Calls | Where-Object { $_[0] -eq 'load' }).Count -eq 1) 'Missing image did not trigger package import.'
        Assert-True (@($script:Calls | Where-Object { $_[0] -eq 'image' }).Count -eq 2) 'Expected initial failed inspect and post-load inspect.'
        Assert-True ($script:OpenedUrl -eq 'http://127.0.0.1:9911' -and $script:HttpUri -eq 'http://127.0.0.1:9911/api/health') 'Import did not continue to readiness.'
    } finally { $script:MissingImageOnce = $false; $script:FlowPackage = $null }
}
# Update orchestration uses existing config and a stopped-capable old app mock.
function Test-Path { param($LiteralPath) return ($LiteralPath -notmatch 'package\.json$') }
function Backup-UsageData {
    param($Root)
    $script:FlowEvents.Add('backup')
    if ($script:BackupFails) { throw 'mock backup failure' }
}
function Reset-UpdateMocks {
    $script:FlowEvents = New-Object 'System.Collections.Generic.List[string]'
    $script:Calls = @(); $script:ComposeCalls = @(); $script:FailCommand = $null
    $script:BackupFails = $false; $script:FlowWaitFails = $false; $script:FlowPackage = 'release.tar'
    $script:States.app = [pscustomobject]@{ State = [pscustomobject]@{ Running = $true } }
}
Test-Case 'missing update package leaves running service untouched' {
    Reset-UpdateMocks; $script:FlowPackage = $null
    Assert-Throws { & $script:Flow -Root 'mock' -Action 'update' } 'updates'
    Assert-True ($script:FlowEvents -notcontains 'compose:stop app' -and $script:FlowEvents -notcontains 'backup') 'Missing package interrupted the running app.'
}
Test-Case 'update backup failure restarts old app without loading or recreating app' {
    Reset-UpdateMocks; $script:BackupFails = $true
    Assert-Throws { & $script:Flow -Root 'mock' -Action 'update' } 'mock backup failure'
    Assert-True ($script:FlowEvents -contains 'compose:start app') 'Old running app was not resumed.'
    Assert-True ($script:FlowEvents -notcontains 'docker:load' -and $script:FlowEvents -notcontains 'compose:up -d') 'Backup failure continued to image load or app recreation.'
}
Test-Case 'update load failure restarts old app without recreating app' {
    Reset-UpdateMocks; $script:FailCommand = 'load'
    Assert-Throws { & $script:Flow -Root 'mock' -Action 'update' } 'mock Docker failure'
    Assert-True ($script:FlowEvents -contains 'compose:start app') 'Old app was not resumed after load failure.'
    Assert-True ($script:FlowEvents -notcontains 'compose:up -d') 'Load failure continued to app recreation.'
}
Test-Case 'successful update orders stop backup load recreate and wait' {
    Reset-UpdateMocks
    & $script:Flow -Root 'mock' -Action 'update'
    $actual = @($script:FlowEvents | Where-Object { $_ -in @('compose:stop app', 'backup', 'docker:load', 'compose:up -d', 'wait:app') }) -join '|'
    Assert-True ($actual -eq 'compose:stop app|backup|docker:load|compose:up -d|wait:app') "Unexpected update order: $actual"
    Assert-True ($script:FlowEvents -notcontains 'compose:start app') 'Success unexpectedly resumed old container.'
}
Test-Case 'post-migration unhealthy app does not automatically restart old container' {
    Reset-UpdateMocks; $script:FlowWaitFails = $true
    Assert-Throws { & $script:Flow -Root 'mock' -Action 'update' } 'mock app unhealthy'
    Assert-True ($script:FlowEvents -contains 'compose:up -d') 'Did not reach migration stage.'
    Assert-True ($script:FlowEvents -notcontains 'compose:start app') 'Unsafe automatic old-app restart after migration.'
}
Write-Host "Results: $script:Passed passed; $($script:Failures.Count) failed."
if ($script:Failures.Count) { throw ($script:Failures -join "`n") }
