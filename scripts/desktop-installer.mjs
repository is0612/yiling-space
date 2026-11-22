#!/usr/bin/env node
/** Generate an ordinary-user Windows installer around a clean, verified desktop payload. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readDesktopPackage } from "./desktop-package-state.mjs";
import { verifyDesktopPgDistribution } from "./desktop-pg-distribution.mjs";
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
const install = `param([string]$Target='', [string]$StateDir='', [string]$DataDir='', [switch]$NoShortcuts, [switch]$NoRegistry)
${utf8Header}
$payload = Join-Path $PSScriptRoot 'payload'
$node = Join-Path $payload 'runtime/node.exe'
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
fs.writeFileSync(path.join(staging, "install.ps1"), "\ufeff" + install.replace(/\n/gu, "\r\n"), "utf8");
fs.writeFileSync(path.join(staging, "payload", "uninstall.ps1"), "\ufeff" + uninstall.replace(/\n/gu, "\r\n"), "utf8");
fs.writeFileSync(path.join(staging, "payload", "start.bat"), '@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\n"runtime\\node.exe" "app\\desktop\\launch.cjs" %*\r\nif errorlevel 1 pause\r\n', "ascii");
fs.writeFileSync(path.join(staging, "payload", "backup.bat"), '@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\n"runtime\\node.exe" "app\\scripts\\desktop-installed-backup.mjs"\r\npause\r\n', "ascii");
fs.writeFileSync(path.join(staging, "安装忆灵空间.bat"), '@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "install.ps1"\r\npause\r\n', "ascii");
fs.writeFileSync(path.join(staging, "installer.json"), JSON.stringify({ format: "yiling-desktop-installer", version: 1, packageId: metadata.packageId, appVersion: metadata.appVersion }, null, 2));
fs.writeFileSync(path.join(staging, "README.txt"), `Yiling Space ${metadata.appVersion} Windows installer\r\n\r\nDouble-click the install batch file. Bundled Node/Electron/PostgreSQL are included; no Docker/Node/Yarn is needed on the target.\r\nProgram files use a supported ASCII location. Chinese user profiles use a private SID-specific directory under the OS Public path when required. Data and install state remain under the current user's LocalAppData, separate from program updates. No administrator elevation is requested. PostgreSQL still requires the Microsoft VC x64 system runtime; missing runtime is detected, not installed automatically.\r\nExisting unknown installations/data are refused, never overwritten or replaced by a blank database.\r\nClose the application before upgrade/backup/uninstall. Program snapshots are retained; uninstall never deletes the data directory. Reinstall with the retained install state preserves the database.\r\nFirst login still uses the original account flow. For a new database, the generated password is in first-run-admin.txt inside the data directory (open it from the desktop menu). Model keys must be configured in the app.\r\nNo auto-login or old Docker data migration is implemented in this stage. Clean Windows / antivirus / multi-user validation remains required before public release.\r\n`, "utf8");
let previous;
if (fs.existsSync(output)) { previous = output + ".previous-" + randomUUID(); fs.renameSync(output, previous); }
try { fs.renameSync(staging, output); }
catch (error) { if (previous && !fs.existsSync(output)) fs.renameSync(previous, output); throw error; }
console.log(`Desktop installer prepared: ${output}`);
if (previous) console.log(`Previous installer retained: ${previous}`);
