import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDesktopDatabaseMode, DESKTOP_DATABASE_FILE, desktopPgBin } from "./desktop-database-config.mjs";
import { validateDesktopPgBackup, restoreDesktopPgBackup } from "./desktop-pg-backup.mjs";

// Synthetic files only; no binaries, dotenv, network connections or database operations.
const parent = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(parent, "yiling-desktop-config-"));
const dataDir = path.join(root, "data"); fs.mkdirSync(dataDir);
const instanceId = randomUUID();
const config = { format: "yiling-desktop-database", version: 1, runtime: "embedded", root: "database", phase: "ready", instanceId, systemIdentifier: "1234567890123456789", majorVersion: 16 };
try {
  assert.equal(resolveDesktopDatabaseMode(dataDir, {}), "docker");
  assert.equal(resolveDesktopDatabaseMode(dataDir, { YILING_DB_RUNTIME: "external" }), "external");
  assert.throws(() => resolveDesktopDatabaseMode(dataDir, { YILING_DB_RUNTIME: "auto" }), /runtime_invalid/u);
  assert.throws(() => resolveDesktopDatabaseMode(dataDir, { YILING_DB_RUNTIME: "embedded" }), /binding_missing/u);
  assert.throws(() => desktopPgBin(root, { YILING_PG_BIN: "relative" }), /must_be_absolute/u);
  fs.writeFileSync(path.join(dataDir, DESKTOP_DATABASE_FILE), JSON.stringify(config));
  assert.equal(resolveDesktopDatabaseMode(dataDir, { DATABASE_URL: "postgresql://never-used.invalid" }), "embedded");
  assert.throws(() => resolveDesktopDatabaseMode(dataDir, { YILING_DB_RUNTIME: "docker" }), /runtime_conflict/u);
  for (const change of [{ phase: "initializing" }, { phase: "restoring" }, { root: "../outside" }, { majorVersion: 17 }]) {
    fs.writeFileSync(path.join(dataDir, DESKTOP_DATABASE_FILE), JSON.stringify({ ...config, ...change }));
    assert.throws(() => resolveDesktopDatabaseMode(dataDir, {}), /binding/u);
  }
  fs.unlinkSync(path.join(dataDir, DESKTOP_DATABASE_FILE));
  fs.mkdirSync(path.join(dataDir, "database")); fs.writeFileSync(path.join(dataDir, "database", "runtime.json"), "{}");
  assert.throws(() => resolveDesktopDatabaseMode(dataDir, {}), /binding_missing/u, "missing binding cannot fall back to Docker");

  const archive = path.join(root, "archive"); fs.mkdirSync(archive);
  const dump = Buffer.from("synthetic dump payload for validation only");
  fs.writeFileSync(path.join(archive, "database.dump"), dump);
  const entry = { path: "database.dump", bytes: dump.length, sha256: createHash("sha256").update(dump).digest("hex") };
  const manifest = { format: "yiling-desktop-backup", version: 1, source: { runtime: "embedded", majorVersion: 16 }, encryptionKey: "not-required", files: [entry] };
  const write = value => fs.writeFileSync(path.join(archive, "manifest.json"), JSON.stringify(value));
  write(manifest);
  assert.equal((await validateDesktopPgBackup(archive)).manifest.files.length, 1);
  for (const malicious of ["../outside", "data/stickers/../../outside", "C:/outside", "data\\stickers\\outside", "/absolute"]) {
    write({ ...manifest, files: [{ ...entry, path: malicious }] });
    await assert.rejects(() => validateDesktopPgBackup(archive), /invalid_path/u);
  }
  write({ ...manifest, files: [entry, entry] });
  await assert.rejects(() => validateDesktopPgBackup(archive), /invalid_file_record/u);
  write({ ...manifest, encryptionKey: "included" });
  await assert.rejects(() => validateDesktopPgBackup(archive), /missing_or_invalid_key/u);
  write(manifest);
  fs.writeFileSync(path.join(archive, "unlisted.txt"), "unexpected");
  await assert.rejects(() => validateDesktopPgBackup(archive), /unlisted_payload/u);
  fs.unlinkSync(path.join(archive, "unlisted.txt"));
  fs.appendFileSync(path.join(archive, "database.dump"), "tampered");
  const destination = path.join(root, "never-create");
  await assert.rejects(() => restoreDesktopPgBackup({ directory: archive, dataDir: destination, binDir: "unused" }), /checksum_mismatch/u);
  assert(!fs.existsSync(destination));
  console.log("Desktop config/backup validation passed: explicit modes, incomplete/conflicting binding refusal, paths, duplicate/missing/unlisted payload, hashes and validate-before-create; no database used.");
} finally {
  assert.equal(path.dirname(root), parent);
  assert(path.basename(root).startsWith("yiling-desktop-config-"));
  fs.rmSync(root, { recursive: true });
}
