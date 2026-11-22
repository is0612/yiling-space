import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stageDesktopPgDistribution, verifyDesktopPgDistribution } from "./desktop-pg-distribution.mjs";

const parent = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(parent, "yiling-pg-dist-test-"));
const fixture = path.join(root, "synthetic"); fs.mkdirSync(fixture);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const records = [];
for (const directory of ["bin", "lib", "share"]) fs.mkdirSync(path.join(fixture, directory));
for (const name of ["postgres", "initdb", "pg_ctl", "pg_controldata", "pg_dump", "pg_restore"]) {
  const relative = `bin/${name}.exe`, bytes = Buffer.from("SYNTHETIC; NOT EXECUTABLE; " + name);
  fs.writeFileSync(path.join(fixture, ...relative.split("/")), bytes);
  records.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
}
for (const name of ["server_license.txt", "commandlinetools_3rd_party_licenses.txt"]) {
  const bytes = Buffer.from([0xff, 0xfe, 0x41, 0x00]); fs.writeFileSync(path.join(fixture, name), bytes);
  records.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
}
const manifest = { format: "yiling-desktop-postgresql-distribution", version: 1, release: "16.16-2",
  archiveSHA: "add1de261b150e6923266abee293f05050795e73f5356158aee4221a2170c073", files: records };
const write = value => fs.writeFileSync(path.join(fixture, "distribution.json"), JSON.stringify(value));
try {
  const badArchive = path.join(root, "not-official.zip"); fs.writeFileSync(badArchive, "synthetic wrong archive");
  const never = path.join(root, "never-create");
  await assert.rejects(() => stageDesktopPgDistribution({ archive: badArchive, targetDir: never }), /archive_checksum_mismatch/u);
  assert(!fs.existsSync(never));
  await assert.rejects(() => stageDesktopPgDistribution({ archive: badArchive, targetDir: "relative" }), /absolute_target_required/u);
  await assert.rejects(() => stageDesktopPgDistribution({ archive: badArchive, targetDir: fixture }), /target_exists/u);
  write(manifest);
  assert.equal((await verifyDesktopPgDistribution(fixture)).files.length, 8);
  for (const update of [{ version: 2 }, { release: "17.0" }, { archiveSHA: "0".repeat(64) }]) {
    write({ ...manifest, ...update }); await assert.rejects(() => verifyDesktopPgDistribution(fixture), /metadata_invalid/u);
  }
  for (const relative of ["../outside", "bin/../../outside", "C:/outside", "bin\\outside", "pgAdmin/file", "bin/a."]) {
    write({ ...manifest, files: [{ ...records[0], path: relative }, ...records.slice(1)] });
    await assert.rejects(() => verifyDesktopPgDistribution(fixture), /file_record_invalid/u);
  }
  write({ ...manifest, files: [...records, records[0]] });
  await assert.rejects(() => verifyDesktopPgDistribution(fixture), /file_record_invalid/u);
  write({ ...manifest, files: records.slice(1) });
  await assert.rejects(() => verifyDesktopPgDistribution(fixture), /required_file_missing/u);
  write(manifest);
  fs.writeFileSync(path.join(fixture, "bin", "extra.exe"), "extra");
  await assert.rejects(() => verifyDesktopPgDistribution(fixture), /extra_file/u);
  fs.unlinkSync(path.join(fixture, "bin", "extra.exe"));
  fs.mkdirSync(path.join(fixture, "lib", "extra-empty"));
  await assert.rejects(() => verifyDesktopPgDistribution(fixture), /extra_directory/u);
  fs.rmdirSync(path.join(fixture, "lib", "extra-empty"));
  fs.appendFileSync(path.join(fixture, "server_license.txt"), "corruption");
  await assert.rejects(() => verifyDesktopPgDistribution(fixture), /checksum_or_file_mismatch/u);
  fs.writeFileSync(path.join(fixture, "server_license.txt"), Buffer.from([0xff, 0xfe, 0x41, 0x00]));
  const link = path.join(fixture, "share", "linked-directory");
  fs.symlinkSync(path.join(fixture, "lib"), link, process.platform === "win32" ? "junction" : "dir");
  try { await assert.rejects(() => verifyDesktopPgDistribution(fixture), /link_refused/u); }
  finally { fs.unlinkSync(link); }
  fs.unlinkSync(path.join(fixture, "distribution.json"));
  await assert.rejects(() => verifyDesktopPgDistribution(fixture), /manifest_missing_or_large/u);
  console.log("Distribution synthetic tests passed: bad archive never creates target; metadata, paths, missing/extra/duplicate files, raw license bytes, hashes, links and incomplete stages. Synthetic manifests test integrity logic only, not official archive authenticity; no executable was run.");
} finally {
  assert.equal(path.dirname(root), parent); assert(path.basename(root).startsWith("yiling-pg-dist-test-"));
  fs.rmSync(root, { recursive: true });
}
