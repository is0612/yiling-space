import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { windowsPrivateOperation } from "./desktop-pg-tools.mjs";

export function assertRegularFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error("desktop_pg_invalid_state_file");
}
export function readPgJson(file) {
  assertRegularFile(file);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
export function writePgJsonAtomic(file, value) {
  if (fs.existsSync(file)) assertRegularFile(file);
  const temporary = path.join(path.dirname(file), `.state-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
const DPAPI = "Add-Type -AssemblyName System.Security;$v=([Console]::In.ReadToEnd()|ConvertFrom-Json);" +
  "$b=[Convert]::FromBase64String($v.data);$e=[Text.Encoding]::UTF8.GetBytes($v.entropy);" +
  "$s=[Security.Cryptography.DataProtectionScope]::CurrentUser;";
function dpapi(value, instanceId, decrypt) {
  const operation = decrypt ? "Unprotect" : "Protect";
  const output = windowsPrivateOperation(DPAPI +
    `$o=[Security.Cryptography.ProtectedData]::${operation}($b,$e,$s);[Convert]::ToBase64String($o)`,
  { data: value, entropy: `yiling-desktop-postgres-v1:${instanceId}` });
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(output)) throw new Error("desktop_pg_invalid_protected_data");
  return output;
}
export function savePgCredentials(file, instanceId, credentials) {
  if (fs.existsSync(file)) throw new Error("desktop_pg_credentials_already_exist");
  const payload = Buffer.from(JSON.stringify({ ...credentials, instanceId }), "utf8").toString("base64");
  writePgJsonAtomic(file, { format: "windows-dpapi-current-user-v1", ciphertext: dpapi(payload, instanceId, false) });
}
export function loadPgCredentials(file, instanceId) {
  const protectedValue = readPgJson(file);
  if (protectedValue.format !== "windows-dpapi-current-user-v1" || typeof protectedValue.ciphertext !== "string"
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(protectedValue.ciphertext)) throw new Error("desktop_pg_invalid_credentials");
  let credentials;
  try {
    credentials = JSON.parse(Buffer.from(dpapi(protectedValue.ciphertext, instanceId, true), "base64").toString("utf8"));
  } catch { throw new Error("desktop_pg_credentials_unavailable"); }
  if (credentials.instanceId !== instanceId || !/^[A-Za-z0-9_-]{40,}$/u.test(credentials.adminPassword ?? "")
    || !/^[A-Za-z0-9_-]{40,}$/u.test(credentials.password ?? "")) throw new Error("desktop_pg_invalid_credentials");
  return credentials;
}
