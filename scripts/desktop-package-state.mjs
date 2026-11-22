import fs from "node:fs";
import path from "node:path";
import { acquireDesktopPgLock } from "./desktop-pg-lock.mjs";
import { initializeDesktopDatabase, openBoundDesktopDatabase, DESKTOP_DATABASE_FILE } from "./desktop-database-config.mjs";
import { readPgJson, writePgJsonAtomic } from "./desktop-pg-store.mjs";
import { isolatedPgEnv, protectPgDirectory } from "./desktop-pg-tools.mjs";
import { verifyDesktopPgDistribution } from "./desktop-pg-distribution.mjs";
import { requireDesktopVcRuntime } from "./desktop-vc-check.mjs";

const uuid = value => typeof value === "string" && /^[a-f0-9-]{36}$/iu.test(value);
function directory(file) {
  if (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isDirectory()) throw new Error("desktop_package_link_or_directory_invalid");
  return fs.realpathSync(file);
}
const equalPath = (a, b) => fs.realpathSync(a).toLowerCase() === fs.realpathSync(b).toLowerCase();
function overlaps(a, b) {
  const x = path.resolve(a).toLowerCase(), y = path.resolve(b).toLowerCase();
  return x === y || x.startsWith(y + path.sep) || y.startsWith(x + path.sep);
}
export function readDesktopPackage(programRoot) {
  const metadata = readPgJson(path.join(programRoot, "desktop-package.json"));
  if (metadata.format !== "yiling-desktop-package" || metadata.version !== 1 || metadata.runtime !== "embedded"
    || metadata.pgRelease !== "16.16-2" || !uuid(metadata.packageId) || typeof metadata.appVersion !== "string") {
    throw new Error("desktop_package_metadata_invalid");
  }
  return metadata;
}

export function peekPackagedDesktop(applicationRoot) {
  const programRoot = path.dirname(fs.realpathSync(applicationRoot));
  readDesktopPackage(programRoot);
  const install = readPgJson(path.join(programRoot, "desktop-install.json"));
  if (install.format !== "yiling-desktop-install" || install.version !== 1 || !uuid(install.installationId) || !path.isAbsolute(install.stateDir)) {
    throw new Error("desktop_package_install_metadata_invalid");
  }
  const state = readPgJson(path.join(directory(install.stateDir), "installation.json"));
  if (state.status !== "installed" || state.installationId !== install.installationId || !equalPath(state.programRoot, programRoot)
    || !path.isAbsolute(state.dataDir) || overlaps(state.dataDir, programRoot)) throw new Error("desktop_package_installation_mismatch");
  return { dataDir: state.dataDir, profileDir: path.join(state.dataDir, "electron") };
}

/** Installed builds only. Source launches retain the existing development/Docker behavior. */
export async function preparePackagedDesktop({ applicationRoot, env = process.env }) {
  const programRoot = path.dirname(fs.realpathSync(applicationRoot));
  if (!fs.existsSync(path.join(programRoot, "desktop-package.json"))) {
    if (fs.existsSync(path.join(programRoot, "desktop-install.json")) || env.YILING_DESKTOP_PACKAGED === "1") {
      throw new Error("desktop_package_metadata_missing: repair the installation; legacy database fallback is refused");
    }
    return { packaged: false, env: { ...env }, release: async () => {} };
  }
  if (process.platform !== "win32") throw new Error("desktop_package_windows_required");
  if (/[^\x00-\x7F]/u.test(programRoot)) throw new Error("desktop_package_ascii_program_path_required: run the installer to select a supported location");
  const metadata = readDesktopPackage(programRoot);
  if (!fs.existsSync(path.join(programRoot, "desktop-install.json"))) throw new Error("desktop_package_install_required: run install.ps1 instead of starting the payload directly");
  const install = readPgJson(path.join(programRoot, "desktop-install.json"));
  if (install.format !== "yiling-desktop-install" || install.version !== 1 || !uuid(install.installationId)
    || !path.isAbsolute(install.stateDir)) throw new Error("desktop_package_install_metadata_invalid");
  const stateDir = directory(install.stateDir);
  protectPgDirectory(stateDir);
  const lease = await acquireDesktopPgLock(stateDir);
  try {
    const stateFile = path.join(stateDir, "installation.json");
    const state = readPgJson(stateFile);
    if (state.format !== "yiling-desktop-state" || state.version !== 1 || state.status !== "installed"
      || state.installationId !== install.installationId || state.packageId !== metadata.packageId
      || !equalPath(state.programRoot, programRoot) || !path.isAbsolute(state.dataDir)
      || overlaps(state.dataDir, programRoot) || overlaps(stateDir, programRoot) || overlaps(stateDir, state.dataDir)
      || (state.databaseInstanceId !== null && !uuid(state.databaseInstanceId))) throw new Error("desktop_package_installation_mismatch");
    const binDir = path.join(programRoot, "runtime", "pgsql", "bin");
    await verifyDesktopPgDistribution(path.join(programRoot, "runtime", "pgsql"));
    await requireDesktopVcRuntime({ pgRoot: path.join(programRoot, "runtime", "pgsql") });
    if (!fs.existsSync(state.dataDir)) {
      if (state.databaseInstanceId !== null) throw new Error("desktop_package_bound_data_missing");
      const runtime = await initializeDesktopDatabase({ dataDir: state.dataDir, binDir, installationId: state.installationId });
      await runtime.close();
    }
    directory(state.dataDir);
    protectPgDirectory(state.dataDir);
    const binding = readPgJson(path.join(state.dataDir, DESKTOP_DATABASE_FILE));
    if (binding.installationId !== state.installationId || binding.phase !== "ready" || !uuid(binding.instanceId)
      || !/^\d+$/u.test(binding.systemIdentifier ?? "")
      || (state.databaseInstanceId !== null && state.databaseInstanceId !== binding.instanceId)
      || (state.systemIdentifier !== null && state.systemIdentifier !== binding.systemIdentifier)) {
      throw new Error("desktop_package_foreign_or_incomplete_data");
    }
    if (state.databaseInstanceId === null) {
      writePgJsonAtomic(stateFile, { ...state, databaseInstanceId: binding.instanceId, systemIdentifier: binding.systemIdentifier });
    }
    const profileDir = path.join(state.dataDir, "electron");
    return { packaged: true, dataDir: state.dataDir, profileDir,
      env: { ...isolatedPgEnv(env), YILING_DATA_DIR: state.dataDir, YILING_PG_BIN: binDir, YILING_DB_RUNTIME: "embedded",
        YILING_DESKTOP_PACKAGED: "1", YILING_ELECTRON_PROFILE: profileDir, NODE_ENV: "production" },
      async recoverDatabaseAfterExit() {
        lease.assertHeld();
        const current = readPgJson(stateFile);
        const config = readPgJson(path.join(state.dataDir, DESKTOP_DATABASE_FILE));
        if (current.installationId !== state.installationId || config.installationId !== state.installationId
          || current.databaseInstanceId !== config.instanceId || current.systemIdentifier !== config.systemIdentifier) {
          throw new Error("desktop_package_recovery_binding_mismatch");
        }
        const runtime = await openBoundDesktopDatabase({ dataDir: state.dataDir, binDir });
        await runtime.close();
      },
      release: () => lease.release() };
  } catch (error) { await lease.release(); throw error; }
}
