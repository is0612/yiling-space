import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyDesktopPgMigrations, runDesktopPrismaCli } from "./desktop-pg-migrations.mjs";

// No dotenv, pg import, socket or database. Ledger and CLI are explicit synthetic fixtures.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "yiling-migration-test-"));
const sql = ["CREATE TABLE fixture_one(id integer);\n", "CREATE TABLE fixture_two(id integer);\n"];
const names = ["20260101000000_one", "20260102000000_two"];
const checksum = text => createHash("sha256").update(text).digest("hex");
const completed = index => ({ migration_name: names[index], checksum: checksum(sql[index]), finished_at: new Date(), rolled_back_at: null });
function fixture({ rows = [], table = false, business = false, backupFails = false, cliFails = false, applied = true, binding = "embedded", afterBackup } = {}) {
  const events = [], logs = [];
  let closed = 0, present = table;
  const client = {
    async query(query) {
      if (query.includes("to_regclass")) return { rows: [{ present }] };
      if (query.includes("pg_catalog.pg_tables")) return { rows: business ? [{ tablename: "real_data" }] : [] };
      assert(query.includes("FROM public._prisma_migrations"));
      return { rows };
    },
    async end() { closed++; },
  };
  const runtime = {
    async verify() { events.push("verify"); return { runtime: binding, instanceId: "fixture-instance", systemIdentifier: "fixture-cluster" }; },
    async connect() { return client; },
    childEnvironment(base) { assert.equal(base, process.env); events.push("environment"); return { DATABASE_URL: "postgresql://synthetic:private-password@127.0.0.1:1234/isolated", FIXTURE: "yes" }; },
  };
  return {
    events, logs, closed: () => closed,
    args: {
      applicationRoot: root, runtime,
      backup: async metadata => { events.push("backup"); assert.equal(metadata.initialEmpty, !present); assert(Array.isArray(metadata.pending)); if (backupFails) throw new Error("postgresql://secret@private-host"); if (afterBackup) await afterBackup(rows); },
      log: event => logs.push(event),
      runner: async input => {
        events.push("runner");
        assert.equal(input.executable, process.execPath);
        assert.equal(input.cwd, await fs.realpath(root));
        assert(input.args.includes("--config"));
        const config = input.args.at(-1);
        const text = await fs.readFile(config, "utf8");
        assert(!text.includes("dotenv")); assert(!text.includes("private-password"));
        assert(text.includes("process.env.DATABASE_URL"));
        assert.equal(input.env.FIXTURE, "yes");
        assert.equal(input.env.PRISMA_SCHEMA_ENGINE_BINARY, path.join(await fs.realpath(root), "node_modules", "@prisma", "engines", "schema-engine-windows.exe"));
        if (cliFails) throw new Error("CLI output leaked postgresql://private-password@host");
        if (applied) { present = true; rows.splice(0, rows.length, completed(0), completed(1)); }
      },
    },
  };
}
async function rejection(options, code) {
  const f = fixture(options);
  await assert.rejects(() => applyDesktopPgMigrations(f.args), { code });
  assert(!f.events.includes("runner"));
  assert.equal(f.closed(), options?.binding && options.binding !== "embedded" ? 0 : 1);
  assert(!JSON.stringify(f.logs).includes("secret"));
  return f;
}
try {
  for (let i = 0; i < names.length; i++) {
    const directory = path.join(root, "prisma", "migrations", names[i]);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "migration.sql"), sql[i]);
  }
  await fs.writeFile(path.join(root, "prisma", "migrations", "migration_lock.toml"), 'provider = "postgresql"\n');
  const sentinel = path.join(root, "prisma", "migrations", ".gitkeep");
  await fs.writeFile(sentinel, "");
  await fs.writeFile(path.join(root, "prisma", "schema.prisma"), "// synthetic schema\n");
  // A real dotenv file is planted only as a trap; this module must never import it.
  await fs.writeFile(path.join(root, ".env"), "DATABASE_URL=must-not-load\n");
  await fs.writeFile(path.join(root, "prisma.config.ts"), "throw new Error('Default config must not be imported');\n");
  await fs.mkdir(path.join(root, "node_modules", "prisma", "build"), { recursive: true });
  await fs.writeFile(path.join(root, "node_modules", "prisma", "build", "index.js"), "// mock only\n");
  await fs.mkdir(path.join(root, "node_modules", "@prisma", "engines"), { recursive: true });
  await fs.writeFile(path.join(root, "node_modules", "@prisma", "engines", "schema-engine-windows.exe"), "fixture only");
  const originalUrl = process.env.DATABASE_URL;
  await fs.unlink(sentinel);
  await fs.mkdir(sentinel);
  try {
    const invalidSentinel = fixture();
    await assert.rejects(() => applyDesktopPgMigrations(invalidSentinel.args), { code: "desktop_pg_migration_directory_invalid" });
    assert(!invalidSentinel.events.includes("backup") && !invalidSentinel.events.includes("runner"));
  } finally { await fs.rmdir(sentinel); await fs.writeFile(sentinel, ""); }
  const unexpected = path.join(root, "prisma", "migrations", "unexpected.txt");
  await fs.writeFile(unexpected, "not a migration");
  try {
    await assert.rejects(() => applyDesktopPgMigrations(fixture().args), { code: "desktop_pg_migration_directory_invalid" });
  } finally { await fs.unlink(unexpected); }
  const fresh = fixture();
  assert.deepEqual(await applyDesktopPgMigrations(fresh.args), { status: "completed", applied: 2 });
  assert(fresh.events.indexOf("backup") < fresh.events.indexOf("runner"));
  assert.equal(fresh.closed(), 1);
  assert.equal(process.env.DATABASE_URL, originalUrl);
  const current = fixture({ table: true, rows: [completed(0), completed(1)] });
  assert.deepEqual(await applyDesktopPgMigrations(current.args), { status: "up-to-date", applied: 0 });
  assert(!current.events.includes("backup") && !current.events.includes("runner"));
  assert.equal(current.closed(), 1);
  const partial = fixture({ table: true, rows: [completed(0)] });
  assert.equal((await applyDesktopPgMigrations(partial.args)).applied, 1);
  await rejection({ business: true }, "desktop_pg_migration_baseline_refused");
  await rejection({ table: true, business: true }, "desktop_pg_migration_baseline_refused");
  const failedBackup = await rejection({ backupFails: true }, "desktop_pg_migration_backup_failed");
  assert.deepEqual(failedBackup.logs.map(event => event.status), ["backup-starting", "failed"]);
  await rejection({ table: true, rows: [{ ...completed(0), finished_at: null }] }, "desktop_pg_migration_failed_ledger");
  await rejection({ table: true, rows: [{ ...completed(0), checksum: "changed" }] }, "desktop_pg_migration_checksum_drift");
  await rejection({ table: true, rows: [{ ...completed(0), migration_name: "unknown" }] }, "desktop_pg_migration_history_unknown");
  await rejection({ table: true, rows: [completed(1)] }, "desktop_pg_migration_history_out_of_order");
  await rejection({ table: true, rows: [completed(0), completed(0)] }, "desktop_pg_migration_duplicate_ledger");
  await rejection({ table: true, rows: [{ ...completed(0), rolled_back_at: new Date() }] }, "desktop_pg_migration_ambiguous_ledger");
  await rejection({ binding: "docker" }, "desktop_pg_migration_binding_required");
  await rejection({ table: true, afterBackup: rows => rows.push(completed(0)) }, "desktop_pg_migration_history_changed");
  const rolledBack = fixture({ table: true, rows: [{ ...completed(0), finished_at: null, rolled_back_at: new Date() }] });
  assert.equal((await applyDesktopPgMigrations(rolledBack.args)).applied, 2);
  const notApplied = fixture({ applied: false });
  await assert.rejects(() => applyDesktopPgMigrations(notApplied.args), { code: "desktop_pg_migration_verification_failed" });
  assert.equal(notApplied.closed(), 1);
  const cliFailure = fixture({ cliFails: true });
  await assert.rejects(() => applyDesktopPgMigrations(cliFailure.args), { code: "desktop_pg_migration_cli_failed" });
  assert(!JSON.stringify(cliFailure.logs).includes("private-password"));
  assert.equal(cliFailure.closed(), 1);
  // Exercise the real default process runner using safe Node fixtures, not Prisma or a DB.
  const run = await runDesktopPrismaCli({ executable: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(200000))"], cwd: root, env: {} });
  assert.equal(run.status, "completed"); assert.equal(run.outputBytes, 64 * 1024);
  await assert.rejects(() => runDesktopPrismaCli({ executable: process.execPath, args: ["-e", "console.error('postgresql://secret@host');process.exit(2)"], cwd: root, env: {} }), { code: "desktop_pg_migration_cli_failed" });
  console.log("Desktop PG migration mock tests passed: checksums/history, baseline refusal, backup ordering/failure, rollback, post-deploy verification, explicit config, engine override, bounded private runner; no database used.");
} finally {
  assert(path.basename(root).startsWith("yiling-migration-test-"));
  await fs.rm(root, { recursive: true, force: true });
}
