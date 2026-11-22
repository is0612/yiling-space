#!/usr/bin/env node
/** Generate an ordinary-user Windows installer around a clean, verified desktop payload. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readDesktopPackage } from "./desktop-package-state.mjs";
import { verifyDesktopPgDistribution } from "./desktop-pg-distribution.mjs";
import { VC_DOWNLOAD_URL } from "./desktop-vc-runtime.mjs";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const source = fs.realpathSync(value("--source", path.join(ROOT, "dist", `YilingSpace-Payload-${version}`)));
const output = path.resolve(value("--out", path.join(ROOT, "dist", `YilingSpace-Installer-${version}`)));
const lower = input => path.resolve(input).toLowerCase();
if (lower(source) === lower(output) || lower(source).startsWith(lower(output) + path.sep) || lower(output).startsWith(lower(source) + path.sep)
  || lower(ROOT) === lower(output) || lower(ROOT).startsWith(lower(output) + path.sep)) throw new Error("desktop_installer_unsafe_output");
const metadata = readDesktopPackage(source);
for (const file of ["app/scripts/desktop-vc-check.mjs", "app/scripts/desktop-vc-runtime.mjs"]) {
  if (!fs.existsSync(path.join(source, file))) throw new Error("desktop_installer_vc_checker_missing: rebuild the clean payload");
}
for (const file of ["desktop-install.json", "data", "state", "app/.data", "app/.env", ".env"]) {
  if (fs.existsSync(path.join(source, file))) throw new Error("desktop_installer_private_or_initialized_payload_refused");
}
await verifyDesktopPgDistribution(path.join(source, "runtime", "pgsql"));
if (fs.existsSync(output)) {
  if (!args.includes("--force")) throw new Error("desktop_installer_output_exists");
  const prior = JSON.parse(fs.readFileSync(path.join(output, "installer.json"), "utf8"));
  if (prior.format !== "yiling-desktop-installer") throw new Error("desktop_installer_unknown_existing_output");
}
fs.mkdirSync(path.dirname(output), { recursive: true });
const staging = output + ".building-" + randomUUID(); fs.mkdirSync(staging);
fs.cpSync(source, path.join(staging, "payload"), { recursive: true });
const utf8Header = `$ErrorActionPreference = 'Stop'
$u = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $u
[Console]::OutputEncoding = $u
$OutputEncoding = $u
`;
const prerequisiteCheck = `$vcCheck = Join-Path $payload 'app/scripts/desktop-vc-check.mjs'
$vcText = & $node $vcCheck --pg-root (Join-Path $payload 'runtime/pgsql')
$vcExit = $LASTEXITCODE
if ($vcExit -notin @(0,2)) { throw 'Runtime inspection failed: payload may be damaged. No installation was started.' }
$vc = ($vcText -join [Environment]::NewLine) | ConvertFrom-Json
if ($vc.format -ne 'yiling-desktop-vc-check' -or $vc.version -ne 1 -or $vc.scope -ne 'pg-distribution') { throw 'Unexpected runtime inspection report' }
if ($vc.status -ne 'ready') {
  Write-Host 'VC x64 运行库未就绪，安装尚未开始，已有数据未改动。'
  $vcLabels = @{'missing'='缺失';'wrong-architecture'='位数不匹配，需要 x64';'load-failed'='文件存在但无法加载';'unverified'='无法验证'}
  foreach ($check in $vc.checks) { if ($check.status -ne 'ready') { Write-Host ($check.name + ': ' + $vcLabels[$check.status]) } }
  Write-Host '请阅读同目录的 VC-runtime-guide.html，从微软自行下载并交互安装后重试。可能需要管理员授权或重启，由你决定。'
  Write-Host '${VC_DOWNLOAD_URL}'
  exit 2
}
Write-Host 'VC x64 系统运行库检查通过。'
`;
const install = `param([string]$Target='', [string]$StateDir='', [string]$DataDir='', [switch]$NoShortcuts, [switch]$NoRegistry)
${utf8Header}
$payload = Join-Path $PSScriptRoot 'payload'
$node = Join-Path $payload 'runtime/node.exe'
${prerequisiteCheck}
$script = Join-Path $payload 'app/scripts/desktop-install.mjs'
$arguments = @($script, 'install', '--source', $payload)
if ($Target) { $arguments += @('--target', $Target) }
if ($StateDir) { $arguments += @('--state-dir', $StateDir) }
if ($DataDir) { $arguments += @('--data-dir', $DataDir) }
$resultText = & $node @arguments
if ($LASTEXITCODE -ne 0) { throw 'Installation stopped; no database was reset. Read the diagnostic above.' }
$result = ($resultText -join [Environment]::NewLine) | ConvertFrom-Json
$Target = $result.programRoot
$start = Join-Path $Target 'start.bat'
if (-not $NoShortcuts) {
  $ws = New-Object -ComObject WScript.Shell
  $icon = Join-Path $Target 'app/desktop/node_modules/electron/dist/electron.exe'
  $desktop = [Environment]::GetFolderPath('Desktop')
  $menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Yiling Space'
  New-Item -ItemType Directory -Force -Path $menu | Out-Null
  foreach ($location in @((Join-Path $desktop 'Yiling Space.lnk'),(Join-Path $menu 'Yiling Space.lnk'))) {
    $shortcut = $ws.CreateShortcut($location)
    $shortcut.TargetPath = $start; $shortcut.WorkingDirectory = $Target; $shortcut.IconLocation = "$icon,0"; $shortcut.Save()
  }
  $un = $ws.CreateShortcut((Join-Path $menu 'Uninstall Yiling Space.lnk'))
  $un.TargetPath = 'powershell.exe'
  $un.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $Target 'uninstall.ps1') + '"'
  $un.WorkingDirectory = $Target; $un.Save()
}
if (-not $NoRegistry) {
  $key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\YilingSpace'
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty $key DisplayName 'Yiling Space'
  Set-ItemProperty $key DisplayVersion $result.appVersion
  Set-ItemProperty $key InstallLocation $Target
  Set-ItemProperty $key UninstallString ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $Target 'uninstall.ps1') + '"')
}
Write-Output ($result | ConvertTo-Json -Compress)
Write-Host 'Installation complete. Data is separate from program files.'
`;
const uninstall = `param([switch]$Yes, [switch]$NoShortcuts, [switch]$NoRegistry)
${utf8Header}
$target = $PSScriptRoot
if (-not $Yes) {
  $answer = Read-Host 'Uninstall program files? Database and private files will remain at their existing data directory. [y/N]'
  if ($answer -notin @('y','Y','yes','YES')) { Write-Host 'Cancelled.'; exit 0 }
}
$metadata = Get-Content -LiteralPath (Join-Path $target 'desktop-install.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('yiling-uninstall-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporary | Out-Null
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $temporary /inheritance:r /grant:r (('*' + $sid + ':(OI)(CI)F')) '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot protect maintenance directory' }
try {
  $node = Join-Path $temporary 'node.exe'
  Copy-Item -LiteralPath (Join-Path $target 'runtime/node.exe') -Destination $node
  $text = & $node (Join-Path $target 'app/scripts/desktop-install.mjs') uninstall --program-root $target --state-dir $metadata.stateDir --confirm
  if ($LASTEXITCODE -ne 0) { throw 'Uninstall refused; exit the app first. Data and program evidence were retained.' }
  $result = ($text -join [Environment]::NewLine) | ConvertFrom-Json
} finally {
  if ((Split-Path -Parent $temporary) -ne [IO.Path]::GetTempPath().TrimEnd([IO.Path]::DirectorySeparatorChar)) { throw 'Unexpected maintenance directory' }
  Remove-Item -LiteralPath $temporary -Recurse -Force
}
if (-not $NoShortcuts) {
  $ws = New-Object -ComObject WScript.Shell
  $menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Yiling Space'
  foreach ($location in @((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Yiling Space.lnk'),(Join-Path $menu 'Yiling Space.lnk'),(Join-Path $menu 'Uninstall Yiling Space.lnk'))) {
    if (Test-Path -LiteralPath $location) {
      $shortcut = $ws.CreateShortcut($location)
      if (($shortcut.TargetPath -eq (Join-Path $target 'start.bat')) -or ($shortcut.Arguments -like ('*' + $target + '*'))) { Remove-Item -LiteralPath $location -Force }
    }
  }
  if ((Test-Path -LiteralPath $menu) -and -not (Get-ChildItem -LiteralPath $menu)) { Remove-Item -LiteralPath $menu }
}
if (-not $NoRegistry) {
  $key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\YilingSpace'
  if ((Test-Path $key) -and (Get-ItemProperty $key).InstallLocation -eq $target) { Remove-Item $key -Recurse -Force }
}
Write-Output ($result | ConvertTo-Json -Compress)
Write-Host 'Program removed; private data remains at its original location. Previous program snapshot is retained.'
`;
const checkOnly = `${utf8Header}\n$payload = Join-Path $PSScriptRoot 'payload'\n$node = Join-Path $payload 'runtime/node.exe'\n${prerequisiteCheck}\n`;
fs.writeFileSync(path.join(staging, "check-runtime.ps1"), "\ufeff" + checkOnly.replace(/\n/gu, "\r\n"), "utf8");
fs.writeFileSync(path.join(staging, "检查运行库.bat"), '@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "check-runtime.ps1"\r\npause\r\n', "ascii");
fs.writeFileSync(path.join(staging, "VC-runtime-guide.html"), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>VC x64 运行库准备说明</title><style>body{max-width:800px;margin:40px auto;padding:0 20px;font:16px/1.8 system-ui,sans-serif;color:#243447}h1{font-size:24px}a{color:#1764a0}li{margin:12px 0}</style><h1>准备 Microsoft VC x64 运行库</h1><p>本包不携带微软运行库安装程序或 DLL，也不会自动下载、安装、提权或重启系统。应用本体不要求另外安装 Docker、Node 或 Yarn。</p><ol><li>先双击「检查运行库.bat」。检查只读取 PG 依赖和系统运行库；通过后可以继续安装忆灵空间。</li><li>若提示缺失、不兼容或无法验证，请打开<a href="${VC_DOWNLOAD_URL}">微软官方运行库下载说明</a>，自行选择最新受支持的 x64 安装程序。仅从微软来源下载。</li><li>由你运行微软安装程序，阅读并决定是否接受许可、管理员授权或重启请求；本项目不会代替你接受。</li><li>完成微软安装器要求的步骤后，重新运行检查，通过后再执行 install.ps1 或安装批处理。原有数据库不会被此检查清空或替换。</li></ol><p>当前未确认本项目维护者的 Visual Studio 再分发资格。微软对完整安装程序和单独 DLL 都有再分发条件，故默认采用用户从微软自行下载的流程，不能宣称完全无管理员前置。<a href="https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files">查看微软再分发说明</a>。</p></html>`, "utf8");
const installedCheck = `${utf8Header}\n$payload = $PSScriptRoot\n$node = Join-Path $payload 'runtime/node.exe'\n${prerequisiteCheck}\n`;
fs.writeFileSync(path.join(staging, "payload", "check-runtime.ps1"), "\ufeff" + installedCheck.replace(/\n/gu, "\r\n"), "utf8");
fs.copyFileSync(path.join(staging, "检查运行库.bat"), path.join(staging, "payload", "检查运行库.bat"));
fs.copyFileSync(path.join(staging, "VC-runtime-guide.html"), path.join(staging, "payload", "VC-runtime-guide.html"));
fs.writeFileSync(path.join(staging, "install.ps1"), "\ufeff" + install.replace(/\n/gu, "\r\n"), "utf8");
fs.writeFileSync(path.join(staging, "payload", "uninstall.ps1"), "\ufeff" + uninstall.replace(/\n/gu, "\r\n"), "utf8");
fs.writeFileSync(path.join(staging, "payload", "start.bat"), '@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\n"runtime\\node.exe" "app\\desktop\\launch.cjs" %*\r\nif errorlevel 1 pause\r\n', "ascii");
fs.writeFileSync(path.join(staging, "payload", "backup.bat"), '@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\n"runtime\\node.exe" "app\\scripts\\desktop-installed-backup.mjs"\r\npause\r\n', "ascii");
fs.writeFileSync(path.join(staging, "安装忆灵空间.bat"), '@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "install.ps1"\r\npause\r\n', "ascii");
fs.writeFileSync(path.join(staging, "installer.json"), JSON.stringify({ format: "yiling-desktop-installer", version: 1, packageId: metadata.packageId, appVersion: metadata.appVersion }, null, 2));
fs.writeFileSync(path.join(staging, "README.txt"), `Yiling Space ${metadata.appVersion} Windows installer\r\n\r\nDouble-click the install batch file. Bundled Node/Electron/PostgreSQL are included; no Docker/Node/Yarn is needed on the target.\r\nProgram files use a supported ASCII location. Chinese user profiles use a private SID-specific directory under the OS Public path when required. Data and install state remain under the current user's LocalAppData, separate from program updates. No administrator elevation is requested. PostgreSQL still requires the Microsoft VC x64 system runtime; missing, wrong-architecture or unloadable runtime is detected, not installed automatically. Use check-runtime.ps1 / the runtime-check batch file and VC-runtime-guide.html. Download from Microsoft yourself; its interactive installer may require administrator approval or restart.\r\nExisting unknown installations/data are refused, never overwritten or replaced by a blank database.\r\nClose the application before upgrade/backup/uninstall. Program snapshots are retained; uninstall never deletes the data directory. Reinstall with the retained install state preserves the database.\r\nFirst login still uses the original account flow. For a new database, the generated password is in first-run-admin.txt inside the data directory (open it from the desktop menu). Model keys must be configured in the app.\r\nNo auto-login or old Docker data migration is implemented in this stage. Clean Windows / antivirus / multi-user validation remains required before public release.\r\n`, "utf8");
let previous;
if (fs.existsSync(output)) { previous = output + ".previous-" + randomUUID(); fs.renameSync(output, previous); }
try { fs.renameSync(staging, output); }
catch (error) { if (previous && !fs.existsSync(output)) fs.renameSync(previous, output); throw error; }
console.log(`Desktop installer prepared: ${output}`);
if (previous) console.log(`Previous installer retained: ${previous}`);
