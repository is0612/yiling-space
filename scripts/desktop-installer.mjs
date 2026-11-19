#!/usr/bin/env node
/**
 * 打 Windows 安装包（无管理员权限版）。
 *
 * 不是 NSIS，而是「payload + PowerShell 安装器」：
 * - 复制到 %LOCALAPPDATA%\YilingSpace，不触发 UAC；
 * - 创建桌面和开始菜单快捷方式；
 * - 写入 HKCU 卸载项；
 * - 卸载时把 app\.data 移到「文档」，不会直接删用户数据。
 *
 * 以后要 NSIS/签名时，payload 和目录结构可以原样复用。
 *
 * 用法：
 *   node scripts/desktop-installer.mjs --source "D:\YilingSpace-Portable"
 *   node scripts/desktop-installer.mjs --source dist\桌面便携版-0.1.0b --out dist\安装包-0.1.0
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const force = args.has("--force");
const valueOf = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = String(pkg.version ?? "0.0.0");
const source = path.resolve(valueOf("--source", path.join(ROOT, "dist", `桌面便携版-${version}`)));
const outDir = path.resolve(valueOf("--out", path.join(ROOT, "dist", `安装包-${version}-本机`)));

function fail(message, hint = "") {
  console.error(`✗ ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

if (!existsSync(path.join(source, "runtime", "node.exe"))) fail(`source 不是便携包：${source}`);
if (!existsSync(path.join(source, "app", "desktop", "launch.cjs"))) fail(`source 缺少 app/desktop/launch.cjs：${source}`);
if (existsSync(outDir)) {
  if (!force) fail(`输出目录已存在：${outDir}`, "加 --force 覆盖。");
  rmSync(outDir, { recursive: true, force: true });
}
mkdirSync(outDir, { recursive: true });

console.log(`复制 payload：${source}`);
cpSync(source, path.join(outDir, "payload"), { recursive: true });
// 备份和 Electron 测试缓存不进安装包；.data 里的密钥/配置保留。
rmSync(path.join(outDir, "payload", "app", ".data", "backups"), { recursive: true, force: true });
rmSync(path.join(outDir, "payload", "app", ".tmp"), { recursive: true, force: true });

const install = `param(
  [string]$Target = (Join-Path $env:LOCALAPPDATA 'YilingSpace'),
  [switch]$NoShortcuts,
  [switch]$NoRegistry
)
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'payload'
if (-not (Test-Path $source)) { throw "payload not found: $source" }
if (Test-Path $Target) {
  Write-Host "Target exists: $Target"
  $answer = Read-Host "Overwrite program files (data is kept)? [y/N]"
  if ($answer -notin @('y','Y','yes','YES')) { Write-Host "Cancelled."; exit 0 }
}
New-Item -ItemType Directory -Force -Path $Target | Out-Null
Copy-Item -Path (Join-Path $source '*') -Destination $Target -Recurse -Force
$start = Join-Path $Target 'start.bat'
if (-not (Test-Path $start)) {
  $startBody = (@('@echo off', 'cd /d "%~dp0"', '"runtime\\node.exe" "app\\desktop\\launch.cjs"', 'if errorlevel 1 pause') -join [Environment]::NewLine) + [Environment]::NewLine
  Set-Content -Path $start -Value $startBody -Encoding ASCII
}
Copy-Item (Join-Path $PSScriptRoot 'uninstall.ps1') $Target -Force

if (-not $NoShortcuts) {
  $ws = New-Object -ComObject WScript.Shell
  $icon = Join-Path $Target 'app\\desktop\\node_modules\\electron\\dist\\electron.exe'
  $desktop = [Environment]::GetFolderPath('Desktop')
  $lnk = $ws.CreateShortcut((Join-Path $desktop 'Yiling Space.lnk'))
  $lnk.TargetPath = $start
  $lnk.WorkingDirectory = $Target
  if (Test-Path $icon) { $lnk.IconLocation = "$icon,0" }
  $lnk.Save()
  $programs = [Environment]::GetFolderPath('Programs')
  $menu = Join-Path $programs 'Yiling Space'
  New-Item -ItemType Directory -Force -Path $menu | Out-Null
  $lnk2 = $ws.CreateShortcut((Join-Path $menu 'Yiling Space.lnk'))
  $lnk2.TargetPath = $start
  $lnk2.WorkingDirectory = $Target
  if (Test-Path $icon) { $lnk2.IconLocation = "$icon,0" }
  $lnk2.Save()
  $un = $ws.CreateShortcut((Join-Path $menu 'Uninstall Yiling Space.lnk'))
  $un.TargetPath = 'powershell.exe'
  $un.Arguments = "-NoProfile -ExecutionPolicy Bypass -File \`"$Target\\uninstall.ps1\`""
  $un.WorkingDirectory = $Target
  $un.Save()
}

if (-not $NoRegistry) {
  $key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\YilingSpace'
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty $key DisplayName 'Yiling Space'
  Set-ItemProperty $key DisplayVersion '${version}'
  Set-ItemProperty $key InstallLocation $Target
  Set-ItemProperty $key DisplayIcon (Join-Path $Target 'app\\desktop\\node_modules\\electron\\dist\\electron.exe')
  Set-ItemProperty $key UninstallString "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \`"$Target\\uninstall.ps1\`""
}

Write-Host ""
Write-Host "Installed to: $Target"
Write-Host "Start: $start"
Write-Host "Data:  $Target\\app\\.data"
`;
writeFileSync(path.join(outDir, "install.ps1"), install.replace(/\n/g, "\r\n"), "utf8");

const uninstall = `$ErrorActionPreference = 'Stop'
$target = Split-Path -Parent $PSCommandPath
$answer = Read-Host "Uninstall Yiling Space? Data will be moved to Documents. [y/N]"
if ($answer -notin @('y','Y','yes','YES')) { Write-Host "Cancelled."; exit 0 }

$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
Remove-Item (Join-Path $desktop 'Yiling Space.lnk') -Force -ErrorAction SilentlyContinue
$menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Yiling Space'
Remove-Item $menu -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\YilingSpace' -Recurse -Force -ErrorAction SilentlyContinue

$data = Join-Path $target 'app\\.data'
if (Test-Path $data) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backup = Join-Path ([Environment]::GetFolderPath('MyDocuments')) "YilingSpace-data-$stamp"
  Move-Item $data $backup
  Write-Host "Data kept at: $backup"
}
Start-Sleep -Milliseconds 300
Remove-Item $target -Recurse -Force
Write-Host "Uninstalled."
`;
writeFileSync(path.join(outDir, "uninstall.ps1"), uninstall.replace(/\n/g, "\r\n"), "utf8");

const bat = `@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "install.ps1"
pause
`;
writeFileSync(path.join(outDir, "安装忆灵空间.bat"), bat.replace(/\n/g, "\r\n"), "ascii");

const readme = `Yiling Space ${version} installer (no admin)

1. Double-click 安装忆灵空间.bat
2. It installs to %LOCALAPPDATA%\\YilingSpace and creates desktop/Start Menu shortcuts.
3. Uninstall from Start Menu > Yiling Space > Uninstall, or run uninstall.ps1 in the install folder.
4. User data app\\.data is moved to Documents on uninstall, not deleted.

This installer carries the current .env and credentials key if the payload was built from a
configured portable package. Do not share this installer.
`;
writeFileSync(path.join(outDir, "README.txt"), readme.replace(/\n/g, "\r\n"), "utf8");

console.log(`✓ 安装包已生成：${outDir}`);
console.log("  运行 安装忆灵空间.bat 安装到 %LOCALAPPDATA%\\YilingSpace");
