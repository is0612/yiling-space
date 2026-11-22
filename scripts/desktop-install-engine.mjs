import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { acquireDesktopPgLock } from "./desktop-pg-lock.mjs";
import { protectPgDirectory } from "./desktop-pg-tools.mjs";
import { readPgJson, writePgJsonAtomic } from "./desktop-pg-store.mjs";
import { openBoundDesktopDatabase } from "./desktop-database-config.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
function fail(reason) { throw new Error("desktop_install_" + reason); }
function canonical(input) {
  if (typeof input !== "string" || !path.isAbsolute(input) || path.dirname(input) === input) fail("absolute_nonroot_path_required");
  const absolute = path.resolve(input);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (stat) {
      if (stat.isSymbolicLink()) fail("junction_refused");
      if (!stat.isDirectory()) fail("path_chain_not_directory");
      current = fs.realpathSync(current);
    }
  }
  return current;
}
function key(value) { return path.normalize(value).toLowerCase(); }
function contains(a, b) { const relative = path.relative(key(a), key(b)); return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)); }
function disjoint(...values) {
  for (let i = 0; i < values.length; i++) for (let j = i + 1; j < values.length; j++) {
    if (contains(values[i], values[j]) || contains(values[j], values[i])) fail("paths_overlap");
  }
}
function packageInfo(root) {
  const info = readPgJson(path.join(root, "desktop-package.json"));
  if (info.format !== "yiling-desktop-package" || info.version !== 1 || !UUID.test(info.packageId ?? "")
    || typeof info.appVersion !== "string" || !info.appVersion.trim() || info.appVersion.length > 100
    || info.runtime !== "embedded" || info.pgRelease !== "16.16-2") fail("package_invalid");
  for (const name of [".env", ".data", "app/.env", "app/.data", "data", "state", "desktop-install.json", "installation.json"]) {
    if (fs.existsSync(path.join(root, ...name.split("/")))) fail("private_payload_refused");
  }
  for (const name of ["runtime/node.exe", "app/desktop/launch.cjs", "app/scripts/desktop-supervisor.mjs", "app/scripts/desktop-install.mjs",
    "app/.output/server/index.mjs", "app/node_modules/tsx/dist/cli.mjs", "app/node_modules/prisma/build/index.js", "app/src/generated/prisma/client.ts"]) {
    let stat;
    try { stat = fs.lstatSync(path.join(root, ...name.split("/"))); } catch { fail("payload_required_file_missing"); }
    if (!stat.isFile() || stat.isSymbolicLink()) fail("payload_required_file_invalid");
  }
  return info;
}
function noLinks(root) {
  let bytes = 0n;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) fail("payload_link_refused");
    if (entry.isDirectory()) bytes += noLinks(file);
    else if (!entry.isFile()) fail("payload_special_file_refused");
    else bytes += fs.lstatSync(file, { bigint: true }).size;
  }
  return bytes;
}
function availableBytes(directory) {
  let existing = path.dirname(directory);
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) fail("space_probe_failed");
    existing = parent;
  }
  canonical(existing);
  const stat = fs.statfsSync(existing, { bigint: true });
  return stat.bavail * stat.bsize;
}
function requireSpace(deps, target, payloadBytes) {
  const free = deps.availableBytes(target);
  if ((typeof free !== "bigint" && (typeof free !== "number" || !Number.isSafeInteger(free))) || free < 0) fail("space_probe_failed");
  if (BigInt(free) < payloadBytes + 64n * 1024n * 1024n) fail("insufficient_space");
}
function dependencies(options) {
  return { acquireLock: acquireDesktopPgLock, protectDirectory: protectPgDirectory, openBound: openBoundDesktopDatabase, writeJson: writePgJsonAtomic, availableBytes,
    verifyPg: async pgRoot => (await import("./desktop-pg-distribution.mjs")).verifyDesktopPgDistribution(pgRoot),
    ...options.dependencies };
}
function mkdirPrivate(directory, protect) {
  if (fs.existsSync(directory)) { canonical(directory); return; }
  const parent = path.dirname(directory);
  if (!fs.existsSync(parent)) mkdirPrivate(parent, protect);
  fs.mkdirSync(directory); protect(directory);
}
function stateInfo(stateDir) {
  const anchor = readPgJson(path.join(stateDir, "installation.json"));
  if (anchor.format !== "yiling-desktop-state" || anchor.version !== 1 || !UUID.test(anchor.installationId ?? "")
    || !["installed", "uninstalled"].includes(anchor.status) || !UUID.test(anchor.packageId ?? "")
    || typeof anchor.appVersion !== "string" || (anchor.databaseInstanceId !== null && !UUID.test(anchor.databaseInstanceId ?? ""))
    || (anchor.systemIdentifier !== null && !/^\d+$/u.test(anchor.systemIdentifier ?? ""))
    || (anchor.databaseInstanceId === null) !== (anchor.systemIdentifier === null)) fail("state_invalid");
  anchor.programRoot = canonical(anchor.programRoot); anchor.dataDir = canonical(anchor.dataDir);
  disjoint(anchor.programRoot, stateDir, anchor.dataDir);
  return anchor;
}
function validateInstalled(root, stateDir, anchor) {
  const metadata = readPgJson(path.join(root, "desktop-install.json"));
  if (metadata.format !== "yiling-desktop-install" || metadata.version !== 1
    || metadata.installationId !== anchor.installationId || key(canonical(metadata.stateDir)) !== key(stateDir)) fail("installation_metadata_mismatch");
  const info = packageInfoInstalled(root);
  if (info.packageId !== anchor.packageId || info.appVersion !== anchor.appVersion) fail("installed_package_mismatch");
}
function packageInfoInstalled(root) {
  const info = readPgJson(path.join(root, "desktop-package.json"));
  if (info.format !== "yiling-desktop-package" || info.version !== 1 || info.runtime !== "embedded"
    || info.pgRelease !== "16.16-2" || !UUID.test(info.packageId ?? "")) fail("installed_package_invalid");
  return info;
}
async function stopKnownDatabase(anchor, deps) {
  const bindingFile = path.join(anchor.dataDir, "desktop-database.json");
  if (!fs.existsSync(anchor.dataDir)) {
    if (anchor.databaseInstanceId !== null) fail("registered_database_missing");
    return;
  }
  if (!fs.existsSync(bindingFile)) fail("unknown_data_directory");
  const binding = readPgJson(bindingFile);
  if (binding.format !== "yiling-desktop-database" || binding.version !== 1 || binding.runtime !== "embedded" || binding.root !== "database"
    || binding.phase !== "ready" || binding.installationId !== anchor.installationId || binding.instanceId !== anchor.databaseInstanceId || binding.systemIdentifier !== anchor.systemIdentifier
    || !UUID.test(binding.instanceId ?? "") || !/^\d+$/u.test(binding.systemIdentifier ?? "")) fail("database_binding_mismatch");
  canonical(path.join(anchor.dataDir, "database"));
  const runtime = await deps.openBound({ dataDir: anchor.dataDir, binDir: path.join(anchor.programRoot, "runtime", "pgsql", "bin") });
  await runtime.close();
}

/** Installation transaction. Optional dependencies are for isolated synthetic tests only. */
export async function installDesktopPackage(options) {
  const deps = dependencies(options);
  const source = canonical(options.source), target = canonical(options.target), stateDir = canonical(options.stateDir), dataDir = canonical(options.dataDir);
  if (/[^\x00-\x7f]/u.test(target)) fail("ascii_program_path_required");
  disjoint(target, stateDir, dataDir); disjoint(source, target, stateDir, dataDir);
  if (!fs.statSync(source).isDirectory()) fail("source_not_directory");
  const incoming = packageInfo(source), payloadBytes = noLinks(source);
  requireSpace(deps, target, payloadBytes);
  await deps.verifyPg(path.join(source, "runtime", "pgsql"));
  const stateExisted = fs.existsSync(stateDir);
  if (!stateExisted) mkdirPrivate(stateDir, deps.protectDirectory);
  deps.protectDirectory(stateDir);
  const lease = await deps.acquireLock(stateDir);
  let staging, previous;
  let promoted = false;
  let priorAnchor;
  const anchorFile = path.join(stateDir, "installation.json");
  try {
    requireSpace(deps, target, payloadBytes);
    const hasAnchor = fs.existsSync(anchorFile);
    if (!hasAnchor && (fs.existsSync(target) || fs.existsSync(dataDir) || (stateExisted && fs.readdirSync(stateDir).length))) fail("unknown_existing_installation");
    const anchor = hasAnchor ? stateInfo(stateDir) : { installationId: randomUUID(), databaseInstanceId: null, systemIdentifier: null };
    if (hasAnchor) {
      if (key(anchor.programRoot) !== key(target) || key(anchor.dataDir) !== key(dataDir)) fail("registered_paths_mismatch");
      priorAnchor = fs.readFileSync(anchorFile);
      if (anchor.status === "installed") {
        if (!fs.existsSync(target)) fail("registered_program_missing");
        validateInstalled(target, stateDir, anchor);
        await deps.verifyPg(path.join(target, "runtime", "pgsql"));
        await stopKnownDatabase(anchor, deps);
      } else {
        if (fs.existsSync(target)) fail("unknown_existing_program");
        // Uninstalled state keeps DB identity; restoration is verified after staging the old-compatible PG.
        if (fs.existsSync(dataDir)) {
          const b = readPgJson(path.join(dataDir, "desktop-database.json"));
          if (b.installationId !== anchor.installationId || b.instanceId !== anchor.databaseInstanceId || b.systemIdentifier !== anchor.systemIdentifier || b.phase !== "ready") fail("database_binding_mismatch");
        } else if (anchor.databaseInstanceId !== null) fail("registered_database_missing");
      }
    }
    mkdirPrivate(path.dirname(target), deps.protectDirectory);
    mkdirPrivate(path.dirname(dataDir), deps.protectDirectory); // DATA_DIR itself is created only by bootstrap.
    staging = target + ".installing-" + randomUUID();
    fs.mkdirSync(staging); deps.protectDirectory(staging);
    for (const name of fs.readdirSync(source)) {
      fs.cpSync(path.join(source, name), path.join(staging, name), { recursive: true, force: false, errorOnExist: true });
    }
    noLinks(staging);
    const staged = packageInfo(staging);
    if (JSON.stringify(staged) !== JSON.stringify(incoming)) fail("payload_changed_during_copy");
    await deps.verifyPg(path.join(staging, "runtime", "pgsql"));
    if (hasAnchor && anchor.status === "uninstalled") await stopKnownDatabase({ ...anchor, programRoot: staging }, deps);
    writePgJsonAtomic(path.join(staging, "desktop-install.json"), { format: "yiling-desktop-install", version: 1,
      installationId: anchor.installationId, stateDir });
    lease.assertHeld(); canonical(target); canonical(stateDir); canonical(dataDir);
    if (hasAnchor && anchor.status === "installed") validateInstalled(target, stateDir, anchor);
    else if (fs.existsSync(target)) fail("target_appeared_during_install");
    if (fs.existsSync(target)) { previous = target + ".previous-" + randomUUID(); fs.renameSync(target, previous); }
    fs.renameSync(staging, target); promoted = true;
    deps.writeJson(anchorFile, { format: "yiling-desktop-state", version: 1, status: "installed", installationId: anchor.installationId,
      programRoot: target, dataDir, packageId: incoming.packageId, appVersion: incoming.appVersion,
      databaseInstanceId: anchor.databaseInstanceId, systemIdentifier: anchor.systemIdentifier });
    return { status: "installed", installationId: anchor.installationId, programRoot: target, stateDir, dataDir,
      packageId: incoming.packageId, appVersion: incoming.appVersion, previousProgramRoot: previous ?? null };
  } catch (error) {
    try {
      if (promoted && fs.existsSync(target)) fs.renameSync(target, target + ".failed-install-" + randomUUID());
      if (previous && fs.existsSync(previous) && !fs.existsSync(target)) fs.renameSync(previous, target);
      if (priorAnchor) writePgJsonAtomic(anchorFile, JSON.parse(priorAnchor.toString("utf8")));
    } catch { throw new Error("desktop_install_rollback_unconfirmed", { cause: error }); }
    throw error;
  } finally { await lease.release(); }
}

export async function uninstallDesktopPackage(options) {
  const deps = dependencies(options), programRoot = canonical(options.programRoot), stateDir = canonical(options.stateDir);
  disjoint(programRoot, stateDir);
  deps.protectDirectory(stateDir);
  const lease = await deps.acquireLock(stateDir);
  let moved;
  try {
    const anchor = stateInfo(stateDir);
    if (anchor.status !== "installed" || key(anchor.programRoot) !== key(programRoot)) fail("not_registered_installed_program");
    validateInstalled(programRoot, stateDir, anchor);
    await deps.verifyPg(path.join(programRoot, "runtime", "pgsql"));
    await stopKnownDatabase(anchor, deps);
    disjoint(programRoot, stateDir, canonical(anchor.dataDir));
    moved = programRoot + ".uninstalled-" + randomUUID();
    fs.renameSync(programRoot, moved);
    try { deps.writeJson(path.join(stateDir, "installation.json"), { ...anchor, status: "uninstalled" }); }
    catch (error) { fs.renameSync(moved, programRoot); moved = undefined; throw error; }
    return { status: "uninstalled", installationId: anchor.installationId, stateDir, dataDir: anchor.dataDir,
      programRoot, preservedProgramRoot: moved };
  } finally { await lease.release(); }
}
