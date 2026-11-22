import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { acquireDesktopPgLock } from "./desktop-pg-lock.mjs";
import { openDesktopPostgres } from "./desktop-pg-runtime.mjs";
import { protectPgDirectory, verifyPgBinaries } from "./desktop-pg-tools.mjs";
import { readPgJson, writePgJsonAtomic } from "./desktop-pg-store.mjs";

export const DESKTOP_DATABASE_FILE = "desktop-database.json";
const FORMAT = "yiling-desktop-database";
function validate(config, ready = false) {
  if (config?.format !== FORMAT || config.version !== 1 || config.runtime !== "embedded" || config.root !== "database"
    || !["initializing", "restoring", "ready"].includes(config.phase)) throw new Error("desktop_database_invalid_binding");
  if (ready && (config.phase !== "ready" || config.majorVersion !== 16 || !/^[a-f0-9-]{36}$/iu.test(config.instanceId ?? "")
    || !/^\d+$/u.test(config.systemIdentifier ?? ""))) throw new Error("desktop_database_incomplete_binding");
  if (config.installationId !== undefined && !/^[a-f0-9-]{36}$/iu.test(config.installationId)) throw new Error("desktop_database_invalid_installation_binding");
  return config;
}
export function desktopPgBin(applicationRoot, env = process.env) {
  const configured = env.YILING_PG_BIN?.trim();
  if (configured && !path.isAbsolute(configured)) throw new Error("desktop_database_binary_path_must_be_absolute");
  return configured || path.resolve(applicationRoot, "..", "runtime", "pgsql", "bin");
}
export function resolveDesktopDatabaseMode(dataDir, env = process.env) {
  const requested = env.YILING_DB_RUNTIME?.trim() || "";
  if (requested && !["embedded", "docker", "external"].includes(requested)) throw new Error("desktop_database_runtime_invalid");
  const bindingFile = path.join(dataDir, DESKTOP_DATABASE_FILE);
  if (fs.existsSync(bindingFile)) {
    const config = validate(readPgJson(bindingFile), true);
    if (requested && requested !== config.runtime) throw new Error("desktop_database_runtime_conflict");
    return "embedded";
  }
  if (fs.existsSync(path.join(dataDir, "database", "runtime.json"))) throw new Error("desktop_database_binding_missing");
  if (requested === "embedded") throw new Error("desktop_database_binding_missing: initialize explicitly in a new data directory");
  return requested || "docker"; // Existing installations keep their original path; no fault fallback.
}
export function commitDesktopDatabaseBinding(dataDir, runtime) {
  const descriptor = runtime.descriptor();
  const expectedRoot = fs.realpathSync(path.join(dataDir, "database"));
  if (fs.realpathSync(descriptor.rootDir) !== expectedRoot) throw new Error("desktop_database_root_mismatch");
  const existing = validate(readPgJson(path.join(dataDir, DESKTOP_DATABASE_FILE)));
  const config = { format: FORMAT, version: 1, runtime: "embedded", root: "database", phase: "ready",
    ...(existing.installationId ? { installationId: existing.installationId } : {}),
    instanceId: descriptor.instanceId, systemIdentifier: descriptor.systemIdentifier, majorVersion: 16 };
  writePgJsonAtomic(path.join(dataDir, DESKTOP_DATABASE_FILE), config);
  return config;
}
export async function initializeDesktopDatabase({ dataDir, binDir, restoring = false, installationId }) {
  if (installationId !== undefined && !/^[a-f0-9-]{36}$/iu.test(installationId)) throw new Error("desktop_database_invalid_installation_binding");
  if (process.platform !== "win32") throw new Error("desktop_pg_windows_required");
  binDir = fs.realpathSync(binDir);
  if (/[^\x00-\x7F]/u.test(binDir)) throw new Error("desktop_pg_non_ascii_binary_path_unsupported");
  verifyPgBinaries(binDir);
  if (!path.isAbsolute(dataDir) || path.dirname(dataDir) === dataDir) throw new Error("desktop_database_invalid_data_dir");
  fs.realpathSync(path.dirname(dataDir));
  fs.mkdirSync(dataDir); // No adoption of an empty-looking legacy directory, even with an explicit init.
  protectPgDirectory(dataDir);
  const applicationLock = await acquireDesktopPgLock(dataDir);
  let runtime;
  try {
    applicationLock.assertHeld();
    writePgJsonAtomic(path.join(dataDir, DESKTOP_DATABASE_FILE), {
      format: FORMAT, version: 1, runtime: "embedded", root: "database", phase: restoring ? "restoring" : "initializing",
      ...(installationId ? { installationId } : {}),
    });
    runtime = await openDesktopPostgres({ binDir, rootDir: path.join(dataDir, "database"), initialize: true });
    if (!restoring) commitDesktopDatabaseBinding(dataDir, runtime);
    return runtime;
  } catch (error) {
    if (runtime) await runtime.close();
    throw error;
  } finally { await applicationLock.release(); }
}
export async function openBoundDesktopDatabase({ dataDir, binDir }) {
  const config = validate(readPgJson(path.join(dataDir, DESKTOP_DATABASE_FILE)), true);
  protectPgDirectory(dataDir);
  const rootDir = path.join(dataDir, config.root);
  const state = readPgJson(path.join(rootDir, "runtime.json"));
  // Check both binding IDs before openDesktopPostgres can start any postmaster.
  if (state.instanceId !== config.instanceId || state.systemIdentifier !== config.systemIdentifier) throw new Error("desktop_database_binding_mismatch");
  return openDesktopPostgres({ binDir, rootDir, expectedInstanceId: config.instanceId });
}

/**
 * 显式隔离一次失败的初始化，让同一个数据目录可以重新初始化。
 *
 * 初始化跨多个文件，不是事务：可能停在「binding 写了 initializing、pgdata 还没建好」
 * 或「cluster 建好了、commit 没写成」。这类目录不能自动接管（见 resolveDesktopDatabaseMode），
 * 但也不能让用户永远卡在这里。这里只做改名，不删除任何东西，失败现场完整留在
 * `<dataDir>.failed-<时间戳>` 里供人工排查。
 *
 * 只接受 phase = initializing / restoring；ready 的绑定或 live postmaster 一律拒绝，
 * 避免把可用实例当成失败品挪走。
 */
export async function quarantineFailedDesktopInitialization(dataDir) {
  if (!path.isAbsolute(dataDir) || path.dirname(dataDir) === dataDir) throw new Error("desktop_database_invalid_data_dir");
  const noLinkDirectory = directory => {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("desktop_database_link_or_invalid_directory");
  };
  noLinkDirectory(dataDir);
  dataDir = fs.realpathSync(dataDir);
  protectPgDirectory(dataDir);
  const applicationLock = await acquireDesktopPgLock(dataDir);
  let databaseLock;
  try {
    const bindingFile = path.join(dataDir, DESKTOP_DATABASE_FILE);
    const readFailedBinding = () => {
      if (!fs.existsSync(bindingFile)) throw new Error("desktop_database_binding_missing");
      const config = validate(readPgJson(bindingFile));
      if (!["initializing", "restoring"].includes(config.phase)) throw new Error("desktop_database_not_failed_initialization");
      return config;
    };
    readFailedBinding();
    const rootDir = path.join(dataDir, "database");
    if (fs.existsSync(rootDir)) {
      noLinkDirectory(rootDir);
      databaseLock = await acquireDesktopPgLock(rootDir);
    }
    applicationLock.assertHeld(); databaseLock?.assertHeld();
    readFailedBinding(); // State may have changed while either lock was being acquired.
    const stateFile = path.join(rootDir, "runtime.json");
    if (fs.existsSync(stateFile)) {
      const state = readPgJson(stateFile);
      if (state.purpose !== "YILING_DESKTOP_PG_V1" || state.schemaVersion !== 1
        || !["initializing", "failed", "ready"].includes(state.phase)) throw new Error("desktop_database_invalid_runtime_state");
      if (state.phase === "ready") throw new Error("desktop_database_runtime_ready");
      // Conservatively refuse any persisted process or established cluster identity, even
      // if its marker is missing. Proving an existing cluster offline is a separate flow.
      if (state.postmaster || state.systemIdentifier) throw new Error("desktop_database_runtime_may_be_live");
    }
    const pgdata = path.join(rootDir, "pgdata");
    if (fs.existsSync(pgdata)) {
      noLinkDirectory(pgdata);
      if (fs.existsSync(path.join(pgdata, "postmaster.pid"))) throw new Error("desktop_database_runtime_may_be_live");
      if (fs.existsSync(path.join(pgdata, "PG_VERSION")) || fs.existsSync(path.join(pgdata, "global", "pg_control"))) {
        throw new Error("desktop_database_cluster_offline_unproven");
      }
    }
    // Do not move a tree containing a junction/symlink that could conceal cluster state.
    const refuseTreeLinks = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error("desktop_database_link_or_invalid_directory");
        if (entry.isDirectory()) refuseTreeLinks(file);
      }
    };
    refuseTreeLinks(dataDir);
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const target = `${dataDir}.failed-${stamp}-${randomUUID()}`;
    if (fs.existsSync(target)) throw new Error("desktop_database_quarantine_exists");
    fs.renameSync(dataDir, target);
    return target;
  } finally {
    try { await databaseLock?.release(); } finally { await applicationLock.release(); }
  }
}
