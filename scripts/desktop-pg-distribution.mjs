import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const FORMAT = "yiling-desktop-postgresql-distribution";
const RELEASE = "16.16-2";
const SHA = "add1de261b150e6923266abee293f05050795e73f5356158aee4221a2170c073";
const LICENSES = ["server_license.txt", "commandlinetools_3rd_party_licenses.txt"];
const TOOLS = ["postgres", "initdb", "pg_ctl", "pg_controldata", "pg_dump", "pg_restore"].map(name => `bin/${name}.exe`);
function fail(code) { throw new Error(`desktop_pg_distribution_${code}`); }
async function hash(file) {
  const digest = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
function allowed(relative) {
  if (typeof relative !== "string" || relative.includes("\\") || relative.includes(":") || relative.startsWith("/")
    || relative.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/u.test(part))) return false;
  return LICENSES.includes(relative) || /^(bin|lib|share)\/.+/u.test(relative);
}
function files(root) {
  const result = [];
  function walk(directory, prefix = "") {
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) fail("link_or_directory_invalid");
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), relative = prefix + name;
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) fail("link_refused");
      if (stat.isDirectory()) {
        if (!/^(bin|lib|share)(\/|$)/u.test(relative)) fail("extra_directory");
        walk(file, relative + "/");
      } else if (stat.isFile()) result.push(relative);
      else fail("special_file");
      if (result.length > 100_000) fail("file_limit");
    }
  }
  walk(root);
  return result;
}
const EXTRACT = `$ErrorActionPreference='Stop';$u=[Text.UTF8Encoding]::new($false);[Console]::InputEncoding=$u;[Console]::OutputEncoding=$u;
Add-Type -AssemblyName System.IO.Compression.FileSystem;
$v=([Console]::In.ReadToEnd()|ConvertFrom-Json);
$zip=[IO.Compression.ZipFile]::OpenRead($v.archive);
try {
 $root=[IO.Path]::GetFullPath($v.target);$prefix=$root+[IO.Path]::DirectorySeparatorChar;
 $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase);
 foreach($e in $zip.Entries){
  $n=$e.FullName;
  if($n.Contains('\\') -or $n.Contains(':') -or $n.StartsWith('/') -or ($n.Split('/')|Where-Object {$_ -eq '..' -or $_ -eq '.'})){throw 'Unsafe zip path'};
  if($n -notmatch '^pgsql/(bin/|lib/|share/|server_license[.]txt$|commandlinetools_3rd_party_licenses[.]txt$)'){continue};
  $r=$n.Substring(6);if(-not $r){continue};
  if(($r.TrimEnd('/').Split('/')|Where-Object { -not $_ -or $_ -match '[. ]$'})){throw 'Unsafe Windows path'};
  $unixMode=($e.ExternalAttributes -shr 16) -band 61440;if($unixMode -eq 40960){throw 'Zip symlink refused'};
  $dest=[IO.Path]::GetFullPath((Join-Path $root $r));
  if(-not $dest.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw 'Zip escaped root'};
  if(-not $seen.Add($r.TrimEnd('/'))){throw 'Duplicate zip path'};
  if($n.EndsWith('/')){[IO.Directory]::CreateDirectory($dest)|Out-Null;continue};
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($dest))|Out-Null;
  [IO.Compression.ZipFileExtensions]::ExtractToFile($e,$dest,$false);
 }
} finally {$zip.Dispose()}
'ok';`;
async function extract(archive, target) {
  if (process.platform !== "win32") fail("windows_required");
  await new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(EXTRACT, "utf16le").toString("base64")],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let timer;
    const error = () => reject(new Error("desktop_pg_distribution_extract_failed"));
    child.once("error", error);
    child.stdin.on("error", () => {});
    child.stdout.on("data", () => {}); child.stderr.on("data", () => {});
    child.once("close", code => { clearTimeout(timer); if (code === 0) resolve(); else error(); });
    timer = setTimeout(() => child.kill(), 180_000);
    child.stdin.end(JSON.stringify({ archive, target }));
  });
}

/** Integrity verifier, not an independent signature/authenticity proof. Never executes binaries. */
export async function verifyDesktopPgDistribution(targetDir) {
  if (!path.isAbsolute(targetDir)) fail("absolute_target_required");
  const actual = files(targetDir);
  const manifestPath = path.join(targetDir, "distribution.json");
  if (!actual.includes("distribution.json") || fs.statSync(manifestPath).size > 32 * 1024 * 1024) fail("manifest_missing_or_large");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.format !== FORMAT || manifest.version !== 1 || manifest.release !== RELEASE || manifest.archiveSHA !== SHA
    || !Array.isArray(manifest.files) || manifest.files.length > 100_000) fail("metadata_invalid");
  const registered = new Set();
  const expectedDirectories = new Set(["bin", "lib", "share"]);
  for (const entry of manifest.files) {
    if (!allowed(entry.path) || registered.has(entry.path.toLowerCase()) || !Number.isSafeInteger(entry.bytes)
      || entry.bytes < 0 || !/^[a-f0-9]{64}$/u.test(entry.sha256)) fail("file_record_invalid");
    registered.add(entry.path.toLowerCase());
    const segments = entry.path.split("/");
    for (let index = 1; index < segments.length; index++) expectedDirectories.add(segments.slice(0, index).join("/"));
    const file = path.join(targetDir, ...entry.path.split("/"));
    // Walk was already link-checked; require exact listed spelling as well.
    if (!actual.includes(entry.path) || fs.statSync(file).size !== entry.bytes || await hash(file) !== entry.sha256) fail("checksum_or_file_mismatch");
  }
  for (const required of [...TOOLS, ...LICENSES]) {
    const entry = manifest.files.find(item => item.path === required);
    if (!entry || !entry.bytes) fail("required_file_missing");
  }
  for (const directory of ["bin", "lib", "share"]) {
    const stat = fs.lstatSync(path.join(targetDir, directory));
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("required_directory_missing");
  }
  function checkDirectories(directory, prefix = "") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const relative = prefix + entry.name;
      if (!expectedDirectories.has(relative)) fail("extra_directory");
      checkDirectories(path.join(directory, entry.name), relative + "/");
    }
  }
  checkDirectories(targetDir);
  if (actual.length !== manifest.files.length + 1 || actual.some(file => file !== "distribution.json" && !registered.has(file.toLowerCase()))) fail("extra_file");
  return manifest;
}

export async function stageDesktopPgDistribution({ archive, targetDir }) {
  if (!path.isAbsolute(targetDir)) fail("absolute_target_required");
  if (fs.existsSync(targetDir)) fail("target_exists");
  const source = fs.realpathSync(archive);
  if (!fs.lstatSync(archive).isFile() || fs.lstatSync(archive).isSymbolicLink()) fail("archive_invalid");
  // Stream the pinned official archive before creating any target or extraction output.
  if (await hash(source) !== SHA) fail("archive_checksum_mismatch");
  if (process.platform !== "win32") fail("windows_required");
  fs.realpathSync(path.dirname(targetDir));
  fs.mkdirSync(targetDir); // Exclusive creation; racing stages cannot overwrite another target.
  await extract(source, targetDir);
  // Zip may contain optional empty directories. Files define the distribution; retain
  // required roots but omit unrecordable empty descendants before sealing the manifest.
  function pruneEmpty(directory, root = false) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) fail("link_refused");
      if (entry.isDirectory()) pruneEmpty(path.join(directory, entry.name));
    }
    if (!root && path.dirname(directory) !== targetDir && !fs.readdirSync(directory).length) fs.rmdirSync(directory);
  }
  pruneEmpty(targetDir, true);
  const records = [];
  for (const relative of files(targetDir)) {
    if (!allowed(relative)) fail("unexpected_extracted_file");
    const file = path.join(targetDir, ...relative.split("/"));
    records.push({ path: relative, bytes: fs.statSync(file).size, sha256: await hash(file) });
  }
  const manifest = { format: FORMAT, version: 1, release: RELEASE, archiveSHA: SHA, files: records };
  // The marker is written only after extraction+hashing; incomplete stages never verify.
  const temporary = path.join(targetDir, ".distribution.partial");
  fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, path.join(targetDir, "distribution.json"));
  await verifyDesktopPgDistribution(targetDir);
  return manifest;
}
