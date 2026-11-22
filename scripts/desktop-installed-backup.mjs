import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { peekPackagedDesktop, preparePackagedDesktop } from "./desktop-package-state.mjs";
import { readPgJson } from "./desktop-pg-store.mjs";

const applicationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const info = peekPackagedDesktop(applicationRoot);
if (!fs.existsSync(path.join(info.dataDir, "desktop-database.json"))
  || readPgJson(path.join(info.dataDir, "desktop-database.json")).phase !== "ready") {
  throw new Error("desktop_backup_installation_not_initialized");
}
const prepared = await preparePackagedDesktop({ applicationRoot });
try {
  if (!prepared.packaged) throw new Error("desktop_backup_installed_package_required");
  const child = spawnSync(process.execPath, [path.join(applicationRoot, "scripts", "desktop-backup.mjs"), "backup"], {
    cwd: applicationRoot, env: prepared.env, stdio: "inherit", windowsHide: true,
  });
  if (child.error || child.status !== 0) process.exitCode = 1;
} finally { await prepared.release(); }
