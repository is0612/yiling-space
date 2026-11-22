import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { protectPgDirectory } from "./desktop-pg-tools.mjs";
import { initializeDesktopDatabase, commitDesktopDatabaseBinding, DESKTOP_DATABASE_FILE } from "./desktop-database-config.mjs";

const DURABLE_FILES = ["credentials-encryption.key", "snowluma-home.json", "local-exec-audit.jsonl"];
const DURABLE_DIRS = ["stickers", "sticker-originals"];
const FORMAT = "yiling-desktop-backup";
const quoted = value => '"' + value.replaceAll('"', '""') + '"';
async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("desktop_backup_non_regular_file");
  return stat;
}
function listFiles(directory) {
  const result = [];
  function walk(folder, relative = "") {
    if (fs.lstatSync(folder).isSymbolicLink()) throw new Error("desktop_backup_link_refused");
    for (const name of fs.readdirSync(folder).sort()) {
      const file = path.join(folder, name), key = relative ? relative + "/" + name : name;
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error("desktop_backup_link_refused");
      if (stat.isDirectory()) walk(file, key);
      else if (stat.isFile()) result.push(key);
      else throw new Error("desktop_backup_special_file_refused");
      if (result.length > 100_000) throw new Error("desktop_backup_too_many_files");
    }
  }
  walk(directory);
  return result;
}
function safeEntry(relative) {
  if (typeof relative !== "string" || relative.includes("\\") || relative.includes(":") || relative.startsWith("/")
    || relative.split("/").some(part => !part || part === "." || part === "..")) throw new Error("desktop_backup_invalid_path");
  if (relative === "database.dump") return;
  if (!relative.startsWith("data/")) throw new Error("desktop_backup_invalid_path");
  const parts = relative.slice(5).split("/");
  if (!(parts.length === 1 && DURABLE_FILES.includes(parts[0])) && !(parts.length > 1 && DURABLE_DIRS.includes(parts[0]))) {
    throw new Error("desktop_backup_unexpected_payload");
  }
}
function boundDataDirectory(dataDir, runtime) {
  const descriptor = runtime.descriptor();
  const root = fs.realpathSync(dataDir);
  if (fs.realpathSync(path.join(root, "database")) !== fs.realpathSync(descriptor.rootDir)) throw new Error("desktop_backup_instance_root_mismatch");
  return { descriptor, root };
}
async function requiresLegacyKey(runtime) {
  const client = await runtime.connect();
  try {
    const columns = await client.query(`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND
      ((table_name='characters' AND column_name='modelConfig') OR
       (table_name='platform_connections' AND column_name='credentialsCiphertext') OR
       (table_name='roleplay_settings' AND column_name='apiKeyCiphertext'))`);
    for (const { table_name: table, column_name: column } of columns.rows) {
      const condition = table === "platform_connections" ? `${quoted(column)} IS NOT NULL`
        : table === "roleplay_settings" ? `${quoted(column)} LIKE 'v1.%'`
          : `${quoted(column)}::text ~ '"[^" ]*Encrypted"[[:space:]]*:[[:space:]]*"v1[.]'`;
      const result = await client.query(`SELECT EXISTS(SELECT 1 FROM ${quoted(table)} WHERE ${condition}) AS needed`);
      if (result.rows[0].needed) return true;
    }
    return false;
  } finally { await client.end(); }
}

/** Call only before consumers start or after they stop; the runtime manager lock is held. */
export async function createDesktopPgBackup({ runtime, dataDir, label = "manual", quiescent = false }) {
  if (!quiescent) throw new Error("desktop_backup_requires_quiescent_consumers");
  await runtime.verify();
  const { descriptor, root } = boundDataDirectory(dataDir, runtime);
  const keyFile = path.join(root, "credentials-encryption.key");
  const needsKey = await requiresLegacyKey(runtime);
  const hasKey = fs.existsSync(keyFile);
  if (hasKey && regular(keyFile).size !== 32) throw new Error("desktop_backup_invalid_encryption_key");
  if (needsKey && !hasKey) throw new Error("desktop_backup_required_encryption_key_missing");
  const backupRoot = path.join(root, "backups");
  if (!fs.existsSync(backupRoot)) fs.mkdirSync(backupRoot);
  if (fs.lstatSync(backupRoot).isSymbolicLink()) throw new Error("desktop_backup_link_refused");
  const name = `desktop-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-${randomUUID()}`;
  const staging = path.join(backupRoot, name + ".partial");
  fs.mkdirSync(staging); protectPgDirectory(staging);
  const files = [];
  async function copy(source, relative) {
    safeEntry(relative); regular(source);
    const destination = path.join(staging, ...relative.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    files.push({ path: relative, bytes: fs.statSync(destination).size, sha256: await hashFile(destination) });
  }
  const dump = await runtime.backup();
  await copy(dump, "database.dump");
  for (const name of DURABLE_FILES) {
    const source = path.join(root, name);
    if (fs.existsSync(source)) await copy(source, "data/" + name);
  }
  for (const name of DURABLE_DIRS) {
    const source = path.join(root, name);
    if (!fs.existsSync(source)) continue;
    if (!fs.lstatSync(source).isDirectory() || fs.lstatSync(source).isSymbolicLink()) throw new Error("desktop_backup_invalid_asset_directory");
    for (const file of listFiles(source)) await copy(path.join(source, ...file.split("/")), `data/${name}/${file}`);
  }
  const manifest = { format: FORMAT, version: 1, createdAt: new Date().toISOString(), label: String(label).slice(0, 80),
    source: { runtime: "embedded", majorVersion: 16, instanceId: descriptor.instanceId, systemIdentifier: descriptor.systemIdentifier },
    encryptionKey: hasKey ? "included" : "not-required", files,
    warnings: ["External protocol program files and login state are not included.", "Backup contains private records, credentials and assets; keep it protected."] };
  fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
  const target = path.join(backupRoot, name);
  fs.renameSync(staging, target);
  // Remove only the exact private dump generated by this operation, after the bundle is committed.
  const dumpRoot = path.join(descriptor.rootDir, "backups");
  if (path.dirname(dump) === dumpRoot && /^desktop-[a-f0-9-]+\.dump$/u.test(path.basename(dump))) fs.unlinkSync(dump);
  return target;
}

export async function validateDesktopPgBackup(directory) {
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("desktop_backup_link_refused");
  const root = fs.realpathSync(directory);
  const manifestFile = path.join(root, "manifest.json");
  const stat = regular(manifestFile);
  if (stat.size > 32 * 1024 * 1024) throw new Error("desktop_backup_manifest_too_large");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (manifest.format !== FORMAT || manifest.version !== 1 || manifest.source?.runtime !== "embedded"
    || manifest.source.majorVersion !== 16 || !Array.isArray(manifest.files) || manifest.files.length > 100_000
    || !["included", "not-required"].includes(manifest.encryptionKey)) throw new Error("desktop_backup_invalid_manifest");
  const paths = new Set();
  for (const entry of manifest.files) {
    safeEntry(entry.path);
    if (paths.has(entry.path) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
      throw new Error("desktop_backup_invalid_file_record");
    }
    paths.add(entry.path);
    let current = root;
    for (const part of entry.path.split("/")) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error("desktop_backup_link_refused");
    }
    if (regular(current).size !== entry.bytes || await hashFile(current) !== entry.sha256) throw new Error("desktop_backup_checksum_mismatch");
  }
  if (!paths.has("database.dump") || !manifest.files.find(file => file.path === "database.dump").bytes) throw new Error("desktop_backup_missing_dump");
  const keyEntry = manifest.files.find(file => file.path === "data/credentials-encryption.key");
  if ((manifest.encryptionKey === "included") !== Boolean(keyEntry) || (keyEntry && keyEntry.bytes !== 32)) throw new Error("desktop_backup_missing_or_invalid_key");
  const actual = listFiles(root).filter(file => file !== "manifest.json");
  if (actual.length !== paths.size || actual.some(file => !paths.has(file))) throw new Error("desktop_backup_unlisted_payload");
  return { root, manifest };
}

/** New destination only. Never modifies/cleans the source instance or an existing target. */
export async function restoreDesktopPgBackup({ directory, dataDir, binDir }) {
  const { root, manifest } = await validateDesktopPgBackup(directory); // Verify before any target is created.
  let runtime;
  try {
    runtime = await initializeDesktopDatabase({ dataDir, binDir, restoring: true });
    await runtime.restoreEmptyDatabase(path.join(root, "database.dump"));
    for (const entry of manifest.files.filter(entry => entry.path.startsWith("data/"))) {
      const relative = entry.path.slice(5), target = path.join(dataDir, ...relative.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(root, ...entry.path.split("/")), target, fs.constants.COPYFILE_EXCL);
      if (await hashFile(target) !== entry.sha256) throw new Error("desktop_restore_copy_mismatch");
    }
    if (await requiresLegacyKey(runtime) && !fs.existsSync(path.join(dataDir, "credentials-encryption.key"))) throw new Error("desktop_restore_required_key_missing");
    const client = await runtime.connect();
    try {
      const sessions = await client.query("SELECT to_regclass('public.sessions') AS name");
      if (sessions.rows[0].name) await client.query('UPDATE sessions SET "revokedAt"=now() WHERE "revokedAt" IS NULL');
    } finally { await client.end(); }
    await runtime.verify();
    commitDesktopDatabaseBinding(dataDir, runtime); // Ready only after database and all assets passed validation.
    return { dataDir, instanceId: runtime.descriptor().instanceId, files: manifest.files.length };
  } finally { await runtime?.close(); }
}
