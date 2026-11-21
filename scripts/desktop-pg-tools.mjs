import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const TOOLS = ["postgres", "initdb", "pg_ctl", "pg_controldata", "pg_dump", "pg_restore"];
export function isolatedPgEnv(source = process.env) {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) =>
    !/^PG/i.test(key) && !/^(DATABASE_URL|DIRECT_URL)$/i.test(key)));
  return { ...env, PGCONNECT_TIMEOUT: "5", PGSSLMODE: "disable", LC_ALL: "C" };
}
export function pgExecutable(binDir, name) {
  return path.join(binDir, name + (process.platform === "win32" ? ".exe" : ""));
}
export function pgCommand(file, args, env = isolatedPgEnv(), timeout = 60_000, initdbDiagnosticFile) {
  // A daemon can inherit captured handles on Windows even with pg_ctl -l.
  const capture = !(/^pg_ctl(?:\.exe)?$/iu.test(path.basename(file)) && args.some(arg => arg === "start" || arg === "stop"));
  const result = spawnSync(file, args, { env, encoding: "utf8", windowsHide: true, timeout,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "ignore", maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    // Only initdb has this opt-in private diagnostic; never include argv or environment.
    if (initdbDiagnosticFile && /^initdb(?:\.exe)?$/iu.test(path.basename(file))) {
      fs.writeFileSync(initdbDiagnosticFile, JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }), { mode: 0o600 });
    }
    const error = new Error(`embedded_pg_command_failed:${path.basename(file)}`);
    error.code = result.error?.code || "PG_COMMAND_FAILED";
    throw error;
  }
  return result.stdout?.trim() ?? "";
}
export function verifyPgBinaries(binDir) {
  if (!path.isAbsolute(binDir)) throw new Error("embedded_pg_bin_must_be_absolute");
  const versions = {};
  for (const name of TOOLS) {
    const file = pgExecutable(binDir, name);
    if (!fs.statSync(file).isFile()) throw new Error("embedded_pg_binary_missing");
    const version = pgCommand(file, ["--version"]);
    if (!/\(PostgreSQL\) 16\./u.test(version)) throw new Error("embedded_pg_requires_version_16");
    versions[name] = version;
  }
  if (new Set(Object.values(versions).map(value => value.match(/\(PostgreSQL\) (\S+)/u)?.[1])).size !== 1) {
    throw new Error("embedded_pg_binary_versions_mismatch");
  }
  return versions;
}
export function protectPgDirectory(directory) {
  if (process.platform !== "win32") { fs.chmodSync(directory, 0o700); return; }
  const identity = pgCommand("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
  const sid = identity.match(/S-1-5-(?:\d+-)+\d+/u)?.[0];
  if (!sid) throw new Error("embedded_pg_user_sid_unavailable");
  pgCommand("icacls.exe", [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"]);
  // grant:r does not remove an unrelated explicit Everyone/Users ACE. Fail closed rather
  // than claiming a previously modified root is private just because inheritance is off.
  try {
    windowsPrivateOperation("$v=([Console]::In.ReadToEnd()|ConvertFrom-Json);$a=Get-Acl -LiteralPath $v.directory;" +
      "if(-not $a.AreAccessRulesProtected){throw 'ACL inheritance is not protected'};" +
      "foreach($r in $a.Access){if($r.AccessControlType -eq 'Allow'){" +
      "$s=$r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;" +
      "if($s -ne $v.sid -and $s -ne 'S-1-5-18'){throw 'Unexpected explicit allow ACL'}}};'ok'", { directory, sid });
  } catch { throw new Error("desktop_pg_directory_acl_rejected"); }
}
export async function availablePgPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
export function pgControlIdentifier(binDir, dataDir) {
  const control = pgCommand(pgExecutable(binDir, "pg_controldata"), ["-D", dataDir]);
  const identifier = control.match(/Database system identifier:\s+(\d+)/u)?.[1];
  if (!identifier) throw new Error("embedded_pg_control_identity_unavailable");
  return identifier;
}

/** The fixed script receives JSON via private stdin, never secrets in argv or stderr. */
export function windowsPrivateOperation(script, input) {
  if (process.platform !== "win32") throw new Error("desktop_pg_windows_required");
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from("$ErrorActionPreference='Stop';$u=[Text.UTF8Encoding]::new($false);[Console]::InputEncoding=$u;[Console]::OutputEncoding=$u;" + script, "utf16le").toString("base64")], {
    input: JSON.stringify(input), encoding: "utf8", env: isolatedPgEnv(), windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"], timeout: 15_000, maxBuffer: 256 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error("desktop_pg_private_operation_failed");
  return result.stdout.trim();
}
export function decodePgNativeText(bytes) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch {
    // PostgreSQL's Windows PID/control path text can use the system ANSI code page.
    const result = windowsPrivateOperation("$v=([Console]::In.ReadToEnd()|ConvertFrom-Json);" +
      "$s=[Text.Encoding]::Default.GetString([Convert]::FromBase64String($v.bytes));" +
      "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s))", { bytes: bytes.toString("base64") });
    return Buffer.from(result, "base64").toString("utf8");
  }
}
export function pgProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("desktop_pg_invalid_pid");
  const output = windowsPrivateOperation(
    "$v=([Console]::In.ReadToEnd()|ConvertFrom-Json);$p=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$v.pid);" +
    "if($p){@{pid=$p.ProcessId;exe=$p.ExecutablePath;createdAt=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress}else{'null'}",
    { pid });
  const result = JSON.parse(output);
  if (result && (!result.exe || !result.createdAt || result.pid !== pid)) throw new Error("desktop_pg_process_identity_unavailable");
  return result;
}
