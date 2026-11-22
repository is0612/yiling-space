#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { windowsPrivateOperation } from "./desktop-pg-tools.mjs";
import { installDesktopPackage, uninstallDesktopPackage } from "./desktop-install-engine.mjs";
import { requireDesktopVcRuntime } from "./desktop-vc-check.mjs";

export function desktopDefaultLayout({ localAppData, publicDir, sid }) {
  if (!path.isAbsolute(localAppData) || !path.isAbsolute(publicDir) || !/^S-1-5-(?:\d+-)+\d+$/u.test(sid)) throw new Error("desktop_install_profile_invalid");
  const normal = path.join(localAppData, "YilingSpace");
  const target = /[^\x00-\x7F]/u.test(normal) ? path.join(publicDir, "YilingSpace-" + sid) : normal;
  if (/[^\x00-\x7F]/u.test(target)) throw new Error("desktop_install_ascii_location_required: specify a writable ASCII Target");
  return { target, dataDir: path.join(localAppData, "YilingSpaceData"), stateDir: path.join(localAppData, "YilingSpaceInstallState") };
}
export async function verifyDesktopSystemRuntime(systemRoot = process.env.SystemRoot, { pgRoot, inspectRuntime } = {}) {
  return requireDesktopVcRuntime({ systemRoot, pgRoot }, inspectRuntime);
}
function windowsProfile() {
  return JSON.parse(windowsPrivateOperation("$s=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;" +
    "$p=(Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList').Public;" +
    "@{localAppData=[Environment]::GetFolderPath('LocalApplicationData');publicDir=[Environment]::ExpandEnvironmentVariables($p);sid=$s}|ConvertTo-Json -Compress", {}));
}
export async function desktopInstallCommand(args, { inspectRuntime } = {}) {
  if (process.platform !== "win32") throw new Error("desktop_install_windows_required");
  const command = args.shift(), values = new Map();
  let confirmed = false;
  while (args.length) {
    const key = args.shift();
    if (key === "--confirm") { confirmed = true; continue; }
    const value = args.shift();
    if (!["--source", "--target", "--state-dir", "--data-dir", "--program-root"].includes(key) || !value || value.startsWith("--") || values.has(key)) throw new Error("desktop_install_arguments_invalid");
    values.set(key, value);
  }
  if (command === "plan") return { status: "planned", ...desktopDefaultLayout(windowsProfile()) };
  if (command === "install") {
    if (!values.has("--source")) throw new Error("desktop_install_source_required");
    await verifyDesktopSystemRuntime(process.env.SystemRoot, { pgRoot: path.join(path.resolve(values.get("--source")), "runtime", "pgsql"), inspectRuntime });
    const defaults = values.has("--target") && values.has("--state-dir") && values.has("--data-dir") ? {} : desktopDefaultLayout(windowsProfile());
    return installDesktopPackage({ source: path.resolve(values.get("--source")), target: path.resolve(values.get("--target") || defaults.target),
      stateDir: path.resolve(values.get("--state-dir") || defaults.stateDir), dataDir: path.resolve(values.get("--data-dir") || defaults.dataDir) });
  }
  if (command === "uninstall") {
    if (!confirmed || !values.has("--program-root") || !values.has("--state-dir")) throw new Error("desktop_uninstall_confirmation_required");
    return uninstallDesktopPackage({ programRoot: path.resolve(values.get("--program-root")), stateDir: path.resolve(values.get("--state-dir")) });
  }
  throw new Error("desktop_install_unknown_command");
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try { console.log(JSON.stringify(await desktopInstallCommand(process.argv.slice(2)))); }
  catch (error) { console.error(error.message); process.exitCode = error.code === "DESKTOP_VC_PREREQUISITE" ? 2 : 1; }
}
