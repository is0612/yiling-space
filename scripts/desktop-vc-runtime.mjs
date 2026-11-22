import fs from "node:fs";
import path from "node:path";
import { verifyDesktopPgDistribution } from "./desktop-pg-distribution.mjs";
import { windowsPrivateOperation } from "./desktop-pg-tools.mjs";

const VC = /^(?:vcruntime140(?:_[a-z0-9]+)*|msvcp140(?:_[a-z0-9]+)*|concrt140|vccorlib140)\.dll$/iu;
const CHECK_STATUSES = new Set(["ready", "missing", "wrong-architecture", "load-failed", "unverified"]);
export const VC_DOWNLOAD_URL = "https://learn.microsoft.com/zh-cn/cpp/windows/latest-supported-vc-redist";
function invalidPe() { throw new Error("desktop_vc_invalid_pe"); }
/** Bounded static import reader. No image mapping, relocations, executable loading or DLL search. */
export function readPeImports(buffer) {
  if (!Buffer.isBuffer(buffer)) invalidPe();
  const within = (offset, length) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > buffer.length - length) invalidPe();
  };
  const u16 = offset => { within(offset, 2); return buffer.readUInt16LE(offset); };
  const u32 = offset => { within(offset, 4); return buffer.readUInt32LE(offset); };
  if (u16(0) !== 0x5a4d) invalidPe();
  const pe = u32(0x3c); within(pe, 24);
  if (u32(pe) !== 0x00004550) invalidPe();
  const machine = u16(pe + 4), count = u16(pe + 6), size = u16(pe + 20), optional = pe + 24;
  if (!count || count > 96) invalidPe();
  within(optional, size);
  const magic = u16(optional), directory = magic === 0x20b ? 112 : magic === 0x10b ? 96 : 0;
  if (!directory || size < directory) invalidPe();
  const number = u32(optional + directory - 4);
  if (number > 16 || size < directory + number * 8) invalidPe();
  const headerSize = u32(optional + 60);
  if (!headerSize || headerSize > buffer.length) invalidPe();
  const sections = [];
  within(optional + size, count * 40);
  for (let index = 0; index < count; index++) {
    const section = optional + size + index * 40;
    const virtualAddress = u32(section + 12), rawSize = u32(section + 16), raw = u32(section + 20);
    within(raw, rawSize);
    if (virtualAddress + rawSize > 0x100000000) invalidPe();
    sections.push({ virtualAddress, rawSize, raw });
  }
  const map = (rva, length) => {
    if (!Number.isSafeInteger(rva) || rva <= 0 || rva + length > 0x100000000) invalidPe();
    if (rva < headerSize && length <= headerSize - rva) { within(rva, length); return rva; }
    const matches = sections.filter(section => rva >= section.virtualAddress && rva - section.virtualAddress <= section.rawSize - length);
    if (matches.length !== 1) invalidPe();
    const offset = matches[0].raw + rva - matches[0].virtualAddress; within(offset, length); return offset;
  };
  const dllName = rva => {
    const bytes = [];
    for (let index = 0; index < 256; index++) {
      const byte = buffer[map(rva + index, 1)];
      if (!byte) {
        const name = Buffer.from(bytes).toString("ascii");
        if (!/^[a-z0-9_+-][a-z0-9_.+-]*\.(?:dll|drv|exe)$/iu.test(name)) invalidPe();
        return name.toLowerCase();
      }
      if (byte < 0x21 || byte > 0x7e) invalidPe();
      bytes.push(byte);
    }
    invalidPe();
  };
  const imports = new Set();
  const table = (entry, width, nameOffset, delay) => {
    if (number <= entry) return;
    const rva = u32(optional + directory + entry * 8), bytes = u32(optional + directory + entry * 8 + 4);
    if (!rva && !bytes) return;
    if (!rva || bytes < width || bytes > 1024 * 1024) invalidPe();
    for (let index = 0; index < Math.floor(bytes / width); index++) {
      const position = map(rva + index * width, width);
      if (buffer.subarray(position, position + width).every(byte => byte === 0)) return;
      // Modern delay import descriptors encode RVAs. Legacy VA descriptors cannot be
      // safely interpreted without architecture/image-base handling; reject, never omit.
      if (delay && u32(position) !== 1) invalidPe();
      imports.add(dllName(u32(position + nameOffset)));
      if (imports.size > 4096) invalidPe();
    }
    invalidPe(); // A table without its terminating descriptor is malformed.
  };
  table(1, 20, 12, false);
  table(13, 32, 4, true);
  return { machine, linkerMajor: buffer[optional + 2], linkerMinor: buffer[optional + 3], imports: [...imports].sort() };
}

function inspectStaticSystemDll({ name, systemRoot }) {
  if (process.platform !== "win32" || process.arch !== "x64") return { name, status: "unverified", reason: "windows-x64-process-required" };
  if (typeof systemRoot !== "string" || !path.isAbsolute(systemRoot)) return { name, status: "unverified", reason: "absolute-system-root-required" };
  const file = path.join(systemRoot, "System32", name);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024 * 1024) return { name, status: "unverified", reason: "system-file-not-regular-or-too-large" };
    const { machine } = readPeImports(fs.readFileSync(file));
    if (machine !== 0x8664) return { name, status: "wrong-architecture", machine };
    const native = JSON.parse(windowsPrivateOperation(`$v=([Console]::In.ReadToEnd()|ConvertFrom-Json);
$system=[Environment]::SystemDirectory;
$expected=Join-Path $system $v.name;
if($v.name -notmatch '^(vcruntime140(_[a-z0-9]+)*|msvcp140(_[a-z0-9]+)*|concrt140|vccorlib140)[.]dll$' -or [IO.Path]::GetFullPath($v.file) -ne [IO.Path]::GetFullPath($expected)){@{status='unverified';reason='not-native-system-directory'}|ConvertTo-Json -Compress;exit 0};
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DesktopVcNative {
[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr LoadLibraryExW(string file, IntPtr reserved, uint flags);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeLibrary(IntPtr module);
}
'@;
$h=[DesktopVcNative]::LoadLibraryExW($expected,[IntPtr]::Zero,2048);
if($h -eq [IntPtr]::Zero){@{status='load-failed';win32Error=[Runtime.InteropServices.Marshal]::GetLastWin32Error()}|ConvertTo-Json -Compress}
else{try{@{status='ready';fileVersion=([Diagnostics.FileVersionInfo]::GetVersionInfo($expected)).FileVersion}|ConvertTo-Json -Compress}finally{[DesktopVcNative]::FreeLibrary($h)|Out-Null}}`, { name, file }));
    if (!["ready", "load-failed", "unverified"].includes(native.status)) throw new Error("invalid-native-report");
    return { name, machine, readable: true, status: native.status,
      ...(Number.isInteger(native.win32Error) ? { win32Error: native.win32Error } : {}),
      ...(typeof native.fileVersion === "string" && /^[\d. ]{1,64}$/u.test(native.fileVersion) ? { fileVersion: native.fileVersion.trim() } : {}),
      ...(native.status === "unverified" ? { reason: "not-native-system-directory" } : {}) };
  } catch (error) {
    if (error.code === "ENOENT") return { name, status: "missing" };
    return { name, status: "unverified", reason: error.message === "desktop_vc_invalid_pe" ? "invalid-system-pe" : "system-file-unreadable" };
  }
}

export async function inspectDesktopVcRuntime({ pgRoot, systemRoot = process.env.SystemRoot, inspectSystemDll = inspectStaticSystemDll } = {}) {
  const required = new Set();
  if (pgRoot !== undefined) {
    const distribution = await verifyDesktopPgDistribution(pgRoot);
    for (const entry of distribution.files) {
      if (!/^bin\/.+\.(?:exe|dll)$/iu.test(entry.path)) continue;
      const file = path.join(pgRoot, ...entry.path.split("/"));
      if (fs.statSync(file).size > 128 * 1024 * 1024) throw new Error("desktop_vc_pe_too_large");
      const pe = readPeImports(fs.readFileSync(file));
      if (pe.machine !== 0x8664) throw new Error("desktop_vc_pg_architecture_mismatch");
      for (const name of pe.imports) if (VC.test(name)) required.add(name);
    }
  } else required.add("vcruntime140.dll");
  const names = [...required].sort();
  const checks = [];
  for (const name of names) {
    try {
      const check = await inspectSystemDll({ name, systemRoot, architecture: "x64" });
      if (!check || !CHECK_STATUSES.has(check.status)) throw new Error("invalid-check");
      // Only explicitly supported, non-secret evidence enters the public result.
      checks.push({ name, status: check.status,
        ...(Number.isInteger(check.machine) ? { machine: check.machine } : {}),
        ...(typeof check.readable === "boolean" ? { readable: check.readable } : {}),
        ...(Number.isInteger(check.win32Error) ? { win32Error: check.win32Error } : {}),
        ...(typeof check.fileVersion === "string" && /^[\d. ]{1,64}$/u.test(check.fileVersion) ? { fileVersion: check.fileVersion.trim() } : {}),
        ...(typeof check.reason === "string" && /^[a-z0-9-]{1,100}$/u.test(check.reason) ? { reason: check.reason } : {}) });
    } catch { checks.push({ name, status: "unverified", reason: "inspection-failed" }); }
  }
  const status = checks.some(check => ["wrong-architecture", "load-failed"].includes(check.status)) ? "incompatible"
    : checks.some(check => check.status === "missing") ? "missing"
      : !checks.length || checks.some(check => check.status === "unverified") ? "unverified" : "ready";
  return { format: "yiling-desktop-vc-check", version: 1, status, architecture: "x64", required: names, checks,
    scope: pgRoot === undefined ? "known-minimum" : "pg-distribution",
    downloadUrl: VC_DOWNLOAD_URL, automaticInstall: false, redistributed: false };
}
