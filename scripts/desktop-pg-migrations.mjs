import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function failure(code) { const error = new Error(code); error.code = code; return error; }
async function regular(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw failure("desktop_pg_migration_file_invalid");
}
async function localMigrations(root) {
  const directory = path.join(root, "prisma", "migrations");
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const migrations = [];
  for (const entry of entries) {
    if (["migration_lock.toml", ".gitkeep"].includes(entry.name) && entry.isFile() && !entry.isSymbolicLink()) continue;
    if (!entry.isDirectory() || !/^[A-Za-z0-9_-]+$/u.test(entry.name)) throw failure("desktop_pg_migration_directory_invalid");
    const file = path.join(directory, entry.name, "migration.sql");
    await regular(file);
    migrations.push({ name: entry.name, checksum: createHash("sha256").update(await fs.readFile(file)).digest("hex") });
  }
  return migrations.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
async function ledger(client, migrations) {
  const exists = await client.query("SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS present");
  if (!exists.rows[0]?.present) {
    const tables = await client.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'");
    if (tables.rows.length) throw failure("desktop_pg_migration_baseline_refused");
    return { pending: migrations, initialEmpty: true };
  }
  const result = await client.query('SELECT migration_name, checksum, finished_at, rolled_back_at FROM public._prisma_migrations ORDER BY started_at, id');
  if (!result.rows.length) {
    const tables = await client.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'");
    if (tables.rows.length) throw failure("desktop_pg_migration_baseline_refused");
  }
  const local = new Map(migrations.map(migration => [migration.name, migration]));
  const completed = new Set();
  for (const row of result.rows) {
    const migration = local.get(row.migration_name);
    if (!migration) throw failure("desktop_pg_migration_history_unknown");
    if (row.checksum !== migration.checksum) throw failure("desktop_pg_migration_checksum_drift");
    if (row.rolled_back_at && row.finished_at) throw failure("desktop_pg_migration_ambiguous_ledger");
    if (row.rolled_back_at) continue;
    if (!row.finished_at) throw failure("desktop_pg_migration_failed_ledger");
    if (completed.has(row.migration_name)) throw failure("desktop_pg_migration_duplicate_ledger");
    completed.add(row.migration_name);
  }
  let pendingSeen = false;
  for (const migration of migrations) {
    if (!completed.has(migration.name)) pendingSeen = true;
    else if (pendingSeen) throw failure("desktop_pg_migration_history_out_of_order");
  }
  return { pending: migrations.filter(migration => !completed.has(migration.name)), initialEmpty: false };
}

/** Capture bounded CLI output without ever returning it or forwarding it to a logger. */
export async function runDesktopPrismaCli({ executable, args, cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    let bytes = 0;
    // Diagnostic output may contain credentials; keep only a bounded byte count, not raw text.
    const consume = chunk => { bytes = Math.min(64 * 1024, bytes + chunk.length); };
    child.stdout.on("data", consume); child.stderr.on("data", consume);
    const timer = setTimeout(() => { child.kill(); }, 10 * 60_000);
    child.once("error", () => { if (!settled) { settled = true; clearTimeout(timer); reject(failure("desktop_pg_migration_cli_failed")); } });
    child.once("close", code => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) resolve({ status: "completed", outputBytes: bytes });
      else reject(failure("desktop_pg_migration_cli_failed"));
    });
  });
}

/** Explicit bound embedded runtime only. Does not import dotenv or stop/release the runtime. */
export async function applyDesktopPgMigrations({ applicationRoot, runtime, backup, log = () => {}, runner = runDesktopPrismaCli }) {
  let client;
  let temporary;
  const notify = status => { try { log({ event: "desktop-pg-migrations", status }); } catch { /* logging must not change migration state */ } };
  try {
    if (!path.isAbsolute(applicationRoot) || typeof backup !== "function" || typeof runner !== "function") throw failure("desktop_pg_migration_arguments_invalid");
    const identity = await runtime.verify();
    if (identity?.runtime !== "embedded" || !identity.instanceId || !identity.systemIdentifier) throw failure("desktop_pg_migration_binding_required");
    const root = await fs.realpath(applicationRoot);
    const migrations = await localMigrations(root);
    client = await runtime.connect();
    const before = await ledger(client, migrations);
    const { pending, initialEmpty } = before;
    if (!pending.length) { notify("up-to-date"); return { status: "up-to-date", applied: 0 }; }
    const cli = path.join(root, "node_modules", "prisma", "build", "index.js");
    await regular(cli);
    await regular(path.join(root, "prisma", "schema.prisma"));
    notify("backup-starting");
    try { await backup({ initialEmpty, pending: pending.map(migration => migration.name) }); } catch { throw failure("desktop_pg_migration_backup_failed"); }
    notify("backup-completed");
    await runtime.verify();
    // Recheck after backup; do not deploy if history changed while it ran.
    if (JSON.stringify(await ledger(client, migrations)) !== JSON.stringify(before)) throw failure("desktop_pg_migration_history_changed");
    if (JSON.stringify(await localMigrations(root)) !== JSON.stringify(migrations)) throw failure("desktop_pg_migration_files_changed");
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), "yiling-prisma-config-"));
    const config = path.join(temporary, "prisma.config.mjs");
    // Explicit config prevents discovery of the application's dotenv-importing config.
    await fs.writeFile(config, `export default {schema:${JSON.stringify(path.join(root, "prisma", "schema.prisma"))},migrations:{path:${JSON.stringify(path.join(root, "prisma", "migrations"))}},datasource:{url:process.env.DATABASE_URL}};\n`, { flag: "wx", mode: 0o600 });
    const env = runtime.childEnvironment(process.env);
    if (!env?.DATABASE_URL) throw failure("desktop_pg_migration_environment_invalid");
    const engine = path.join(root, "node_modules", "@prisma", "engines", "schema-engine-windows.exe");
    try { await regular(engine); env.PRISMA_SCHEMA_ENGINE_BINARY = engine; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    notify("deploy-starting");
    try { await runner({ executable: process.execPath, args: [cli, "migrate", "deploy", "--config", config], cwd: root, env }); }
    catch { throw failure("desktop_pg_migration_cli_failed"); }
    if (JSON.stringify(await localMigrations(root)) !== JSON.stringify(migrations)) throw failure("desktop_pg_migration_files_changed");
    if ((await ledger(client, migrations)).pending.length) throw failure("desktop_pg_migration_verification_failed");
    await runtime.verify();
    notify("completed");
    return { status: "completed", applied: pending.length };
  } catch (error) {
    notify("failed");
    if (typeof error?.code === "string" && error.code.startsWith("desktop_pg_migration_")) throw failure(error.code);
    throw failure("desktop_pg_migration_validation_failed");
  } finally {
    if (client) await client.end().catch(() => {});
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
  }
}
