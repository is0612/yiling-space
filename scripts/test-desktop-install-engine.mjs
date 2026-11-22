import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { installDesktopPackage, uninstallDesktopPackage } from "./desktop-install-engine.mjs";
import { acquireDesktopPgLock } from "./desktop-pg-lock.mjs";
import { protectPgDirectory } from "./desktop-pg-tools.mjs";

// Synthetic payload only. No real PostgreSQL, user installation, registry or shortcuts.
const parent = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(parent, "yiling-install-test-"));
const source = path.join(root, "合成载荷"), target = path.join(root, "program"), stateDir = path.join(root, "state"), dataDir = path.join(root, "userdata", "data");
let opened = 0, closed = 0, failStage = false;
const dependencies = {
  verifyPg: async directory => {
    assert(fs.existsSync(path.join(directory, "fixture-manifest.json")));
    if (failStage && directory.includes(".installing-")) throw new Error("synthetic-stage-verification-failed");
  },
  openBound: async ({ dataDir: requested }) => {
    assert.equal(requested, dataDir); opened++;
    return { close: async () => { closed++; } };
  },
};
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const options = { source, target, stateDir, dataDir, dependencies };
function payload(version) {
  fs.mkdirSync(path.join(source, "runtime", "pgsql"), { recursive: true });
  fs.mkdirSync(path.join(source, "app"), { recursive: true });
  write(path.join(source, "runtime", "pgsql", "fixture-manifest.json"), { synthetic: true });
  const metadata = { format: "yiling-desktop-package", version: 1, packageId: randomUUID(), appVersion: version, runtime: "embedded", pgRelease: "16.16-2" };
  write(path.join(source, "desktop-package.json"), metadata);
  fs.writeFileSync(path.join(source, "app", "fixture.txt"), version);
  for (const file of ["runtime/node.exe", "app/desktop/launch.cjs", "app/scripts/desktop-supervisor.mjs", "app/scripts/desktop-install.mjs",
    "app/.output/server/index.mjs", "app/node_modules/tsx/dist/cli.mjs", "app/node_modules/prisma/build/index.js", "app/src/generated/prisma/client.ts"]) {
    const destination = path.join(source, ...file.split("/")); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, "synthetic-placeholder");
  }
  return metadata;
}
let succeeded = false;
try {
  if (process.platform !== "win32") throw new Error("This integration test requires Windows OS locks and ACLs");
  protectPgDirectory(root);
  const first = payload("1.0.0");
  const requiredFile = path.join(source, "app", "scripts", "desktop-install.mjs"); fs.unlinkSync(requiredFile);
  await assert.rejects(() => installDesktopPackage(options), /payload_required_file_missing/u);
  assert(!fs.existsSync(stateDir));
  fs.writeFileSync(requiredFile, "synthetic-placeholder");
  await assert.rejects(() => installDesktopPackage({ ...options, target: path.join(root, "中文程序") }), /ascii_program_path_required/u);
  await assert.rejects(() => installDesktopPackage({ ...options, dataDir: path.join(target, "data") }), /paths_overlap/u);
  fs.writeFileSync(path.join(source, "app", ".env"), "synthetic-private");
  await assert.rejects(() => installDesktopPackage(options), /private_payload_refused/u);
  fs.unlinkSync(path.join(source, "app", ".env"));
  const unknown = path.join(root, "unknown"); fs.mkdirSync(unknown); fs.writeFileSync(path.join(unknown, "keep"), "preserve");
  await assert.rejects(() => installDesktopPackage({ ...options, target: unknown, stateDir: path.join(root, "unknown-state") }), /unknown_existing_installation/u);
  assert.equal(fs.readFileSync(path.join(unknown, "keep"), "utf8"), "preserve");
  const linked = path.join(root, "linked-source"); fs.symlinkSync(source, linked, "junction");
  try { await assert.rejects(() => installDesktopPackage({ ...options, source: linked }), /junction_refused/u); }
  finally { fs.unlinkSync(linked); }
  const dangling = path.join(root, "dangling"); fs.symlinkSync(path.join(root, "does-not-exist"), dangling, "junction");
  try { await assert.rejects(() => installDesktopPackage({ ...options, target: path.join(dangling, "program") }), /junction_refused/u); }
  finally { fs.unlinkSync(dangling); }
  const lowSpace = { ...dependencies, availableBytes: () => 64n * 1024n * 1024n };
  await assert.rejects(() => installDesktopPackage({ ...options, dependencies: lowSpace }), /desktop_install_insufficient_space/u);
  assert(!fs.existsSync(target)); assert(!fs.existsSync(stateDir)); assert(!fs.existsSync(dataDir));
  assert.equal(opened, 0, "low-space fresh install must not touch PostgreSQL");
  const fresh = await installDesktopPackage(options);
  assert.equal(fresh.packageId, first.packageId);
  assert(!fs.existsSync(dataDir), "fresh install must not create the data directory");
  assert(fs.existsSync(path.dirname(dataDir)));
  const anchorFile = path.join(stateDir, "installation.json");
  const installFile = path.join(target, "desktop-install.json");
  const anchor = read(anchorFile);
  assert.equal(read(installFile).installationId, anchor.installationId);
  assert.equal(anchor.databaseInstanceId, null);
  const active = await acquireDesktopPgLock(stateDir);
  try {
    await assert.rejects(() => installDesktopPackage(options), { code: "DESKTOP_PG_LOCK_BUSY" });
    await assert.rejects(() => uninstallDesktopPackage({ programRoot: target, stateDir, dependencies }), { code: "DESKTOP_PG_LOCK_BUSY" });
  } finally { await active.release(); }
  fs.mkdirSync(dataDir); protectPgDirectory(dataDir);
  fs.mkdirSync(path.join(dataDir, "database"));
  const databaseInstanceId = randomUUID(), systemIdentifier = "1234567890123456789";
  write(path.join(dataDir, "desktop-database.json"), { format: "yiling-desktop-database", version: 1, runtime: "embedded", root: "database", phase: "ready", installationId: anchor.installationId, instanceId: databaseInstanceId, systemIdentifier });
  fs.writeFileSync(path.join(dataDir, "preserved-user-data"), "synthetic-private-record");
  await assert.rejects(() => installDesktopPackage(options), /database_binding_mismatch/u, "unregistered old data is not adopted");
  write(anchorFile, { ...anchor, databaseInstanceId, systemIdentifier });
  const second = payload("2.0.0");
  const beforeLowSpace = fs.readFileSync(anchorFile, "utf8"), opensBeforeLowSpace = opened;
  await assert.rejects(() => installDesktopPackage({ ...options, dependencies: lowSpace }), /desktop_install_insufficient_space/u);
  assert.equal(fs.readFileSync(anchorFile, "utf8"), beforeLowSpace);
  assert.equal(opened, opensBeforeLowSpace, "low-space update must not open or stop the registered database");
  assert.equal(fs.readFileSync(path.join(target, "app", "fixture.txt"), "utf8"), "1.0.0");
  assert.equal(fs.readFileSync(path.join(dataDir, "preserved-user-data"), "utf8"), "synthetic-private-record");
  assert(!fs.readdirSync(root).some(name => name.includes(".installing-") || name.includes(".previous-")), "low-space update must not stage or rename old programs");
  const upgrade = await installDesktopPackage(options);
  assert.equal(upgrade.installationId, anchor.installationId);
  assert.equal(read(anchorFile).packageId, second.packageId);
  assert.equal(fs.readFileSync(path.join(upgrade.previousProgramRoot, "app", "fixture.txt"), "utf8"), "1.0.0");
  assert.equal(opened, closed);
  assert.equal(fs.readFileSync(path.join(dataDir, "preserved-user-data"), "utf8"), "synthetic-private-record");
  const previousAnchor = fs.readFileSync(anchorFile, "utf8");
  failStage = true; payload("3.0.0");
  await assert.rejects(() => installDesktopPackage(options), /synthetic-stage-verification-failed/u);
  failStage = false;
  assert.equal(fs.readFileSync(anchorFile, "utf8"), previousAnchor);
  assert.equal(fs.readFileSync(path.join(target, "app", "fixture.txt"), "utf8"), "2.0.0");
  const writeFailure = { ...dependencies, writeJson: () => { throw new Error("synthetic-anchor-write-failed"); } };
  await assert.rejects(() => installDesktopPackage({ ...options, dependencies: writeFailure }), /synthetic-anchor-write-failed/u);
  assert.deepEqual(read(anchorFile), JSON.parse(previousAnchor));
  assert.equal(fs.readFileSync(path.join(target, "app", "fixture.txt"), "utf8"), "2.0.0", "failed anchor commit must restore the old program");
  await assert.rejects(() => uninstallDesktopPackage({ programRoot: target, stateDir, dependencies: writeFailure }), /synthetic-anchor-write-failed/u);
  assert(fs.existsSync(target)); assert.equal(read(anchorFile).status, "installed");
  const mismatched = read(installFile); write(installFile, { ...mismatched, installationId: randomUUID() });
  try { await assert.rejects(() => uninstallDesktopPackage({ programRoot: target, stateDir, dependencies }), /metadata_mismatch/u); }
  finally { write(installFile, mismatched); }
  const uninstalled = await uninstallDesktopPackage({ programRoot: target, stateDir, dependencies });
  assert(!fs.existsSync(target));
  assert(fs.existsSync(uninstalled.preservedProgramRoot));
  assert.equal(read(anchorFile).status, "uninstalled");
  assert.equal(read(anchorFile).databaseInstanceId, databaseInstanceId);
  assert.equal(fs.readFileSync(path.join(dataDir, "preserved-user-data"), "utf8"), "synthetic-private-record");
  const reinstalled = await installDesktopPackage(options);
  assert.equal(reinstalled.installationId, anchor.installationId);
  assert.equal(read(anchorFile).status, "installed");
  assert.equal(read(anchorFile).databaseInstanceId, databaseInstanceId);
  assert.equal(fs.readFileSync(path.join(target, "app", "fixture.txt"), "utf8"), "3.0.0");
  assert.equal(opened, closed);
  const wrongRoot = path.join(root, "other-program");
  await assert.rejects(() => installDesktopPackage({ ...options, target: wrongRoot }), /registered_paths_mismatch/u);
  const deniedOpen = { ...dependencies, openBound: async () => { const error = new Error("busy"); error.code = "DESKTOP_PG_LOCK_BUSY"; throw error; } };
  await assert.rejects(() => uninstallDesktopPackage({ programRoot: target, stateDir, dependencies: deniedOpen }), { code: "DESKTOP_PG_LOCK_BUSY" });
  assert(fs.existsSync(target)); assert.equal(read(anchorFile).status, "installed");
  const neverStarted = { ...options, target: path.join(root, "never-started-program"), stateDir: path.join(root, "never-started-state"), dataDir: path.join(root, "never-started-data") };
  await installDesktopPackage(neverStarted);
  await uninstallDesktopPackage({ programRoot: neverStarted.target, stateDir: neverStarted.stateDir, dependencies });
  assert(!fs.existsSync(neverStarted.dataDir), "uninitialized data must remain absent after uninstall");
  assert.equal(read(path.join(neverStarted.stateDir, "installation.json")).databaseInstanceId, null);
  succeeded = true;
  console.log("Desktop install engine synthetic integration passed: Unicode payload/ASCII target, path/privacy guards, fresh/update, state busy, DB identity, failed stage rollback, uninstall/reinstall, data preservation; no real installation/database/registry used.");
} finally {
  if (succeeded && path.dirname(root) === parent && path.basename(root).startsWith("yiling-install-test-")) fs.rmSync(root, { recursive: true });
  else console.error("Retained synthetic installer diagnostics: " + root);
}
