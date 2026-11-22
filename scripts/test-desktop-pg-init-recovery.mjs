import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initializeDesktopDatabase, openBoundDesktopDatabase, quarantineFailedDesktopInitialization,
  resolveDesktopDatabaseMode } from "./desktop-database-config.mjs";
import { readPgJson } from "./desktop-pg-store.mjs";
import { acquireDesktopPgLock } from "./desktop-pg-lock.mjs";

// Real Windows failure/recovery only, using a private copy of the verified distribution.
// No dotenv, business DATABASE_URL, installed service or source binary modification.
if (process.platform !== "win32" || !process.env.YILING_TEST_PG_BIN) {
  console.log("Windows 和 YILING_TEST_PG_BIN 缺一不可；跳过真实 PostgreSQL 初始化失败恢复测试。");
  process.exit(0);
}
const binDir = fs.realpathSync(process.env.YILING_TEST_PG_BIN);
const parent = path.resolve(".data", "desktop-pg-runtime-tests");
fs.mkdirSync(parent, { recursive: true });
const temporary = fs.mkdtempSync(path.join(parent, "init-recovery-"));
const dataDir = path.join(temporary, "实例资料");
const brokenRuntime = path.join(temporary, "broken-runtime");
fs.cpSync(path.dirname(binDir), brokenRuntime, { recursive: true });
const bki = path.join(brokenRuntime, "share", "postgres.bki");
assert(fs.statSync(bki).isFile());
fs.unlinkSync(bki); // Tools still pass --version; actual initdb now deterministically fails.
const brokenBin = path.join(brokenRuntime, "bin");
let runtime;
let succeeded = false;
const bindingFile = path.join(dataDir, "desktop-database.json");
const stateFile = path.join(dataDir, "database", "runtime.json");
const fakePgData = path.join(dataDir, "database", "pgdata");
async function rejectQuarantine(pattern, message) {
  await assert.rejects(() => quarantineFailedDesktopInitialization(dataDir), pattern, message);
  assert(fs.existsSync(dataDir));
}
try {
  await assert.rejects(() => initializeDesktopDatabase({ dataDir, binDir: brokenBin }), /embedded_pg_command_failed:initdb/u);
  assert.equal(readPgJson(bindingFile).phase, "initializing");
  assert(!fs.existsSync(path.join(fakePgData, "PG_VERSION")));
  assert.throws(() => resolveDesktopDatabaseMode(dataDir), /desktop_database_incomplete_binding/u);
  await assert.rejects(() => openBoundDesktopDatabase({ dataDir, binDir }), /desktop_database_incomplete_binding/u);
  await assert.rejects(() => initializeDesktopDatabase({ dataDir, binDir }), { code: "EEXIST" });
  // Same app lock as initialization: quarantine cannot rename the directory mid-initialize.
  const appLock = await acquireDesktopPgLock(dataDir);
  try { await rejectQuarantine({ code: "DESKTOP_PG_LOCK_BUSY" }, "initializing app manager blocks quarantine"); }
  finally { await appLock.release(); }
  const databaseLock = await acquireDesktopPgLock(path.join(dataDir, "database"));
  try { await rejectQuarantine({ code: "DESKTOP_PG_LOCK_BUSY" }, "database manager also blocks quarantine"); }
  finally { await databaseLock.release(); }
  const failedBinding = fs.readFileSync(bindingFile, "utf8");
  for (const change of [{ root: "../outside" }, { runtime: "docker" }]) {
    try {
      fs.writeFileSync(bindingFile, JSON.stringify({ ...JSON.parse(failedBinding), ...change }));
      await rejectQuarantine(/desktop_database_invalid_binding/u);
    } finally { fs.writeFileSync(bindingFile, failedBinding); }
  }
  const failedState = fs.readFileSync(stateFile, "utf8");
  for (const [change, expected] of [
    [{ phase: "ready" }, /desktop_database_runtime_ready/u],
    [{ postmaster: { pid: process.pid } }, /desktop_database_runtime_may_be_live/u],
    [{ systemIdentifier: "123456789" }, /desktop_database_runtime_may_be_live/u],
  ]) {
    try {
      fs.writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(failedState), ...change }));
      await rejectQuarantine(expected);
    } finally { fs.writeFileSync(stateFile, failedState); }
  }
  fs.mkdirSync(fakePgData, { recursive: true });
  fs.writeFileSync(path.join(fakePgData, "postmaster.pid"), "synthetic marker\n");
  try { await rejectQuarantine(/desktop_database_runtime_may_be_live/u); }
  finally { fs.unlinkSync(path.join(fakePgData, "postmaster.pid")); }
  fs.writeFileSync(path.join(fakePgData, "PG_VERSION"), "16\n");
  try { await rejectQuarantine(/desktop_database_cluster_offline_unproven/u, "missing PID is not proof an established cluster is offline"); }
  finally { fs.unlinkSync(path.join(fakePgData, "PG_VERSION")); }
  const outside = path.join(temporary, "outside"); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep"), "outside is not ours");
  const link = path.join(dataDir, "unexpected-junction");
  fs.symlinkSync(outside, link, "junction");
  try { await rejectQuarantine(/desktop_database_link_or_invalid_directory/u); }
  finally { fs.unlinkSync(link); }
  assert.equal(fs.readFileSync(path.join(outside, "keep"), "utf8"), "outside is not ours");
  await assert.rejects(() => quarantineFailedDesktopInitialization(temporary), /desktop_database_binding_missing/u);
  const quarantined = await quarantineFailedDesktopInitialization(dataDir);
  assert(quarantined.startsWith(dataDir + ".failed-"));
  assert.equal(path.dirname(quarantined), path.dirname(dataDir));
  assert(!fs.existsSync(dataDir));
  assert.equal(readPgJson(path.join(quarantined, "desktop-database.json")).phase, "initializing");
  assert(fs.existsSync(path.join(quarantined, "database", "runtime.json")));
  runtime = await initializeDesktopDatabase({ dataDir, binDir });
  const descriptor = runtime.descriptor();
  assert.equal(readPgJson(bindingFile).phase, "ready");
  assert.equal(readPgJson(bindingFile).instanceId, descriptor.instanceId);
  assert.equal(resolveDesktopDatabaseMode(dataDir), "embedded");
  const client = await runtime.connect();
  try {
    const probe = await client.query("SELECT 42 AS answer, current_setting('TimeZone') AS timezone");
    assert.equal(probe.rows[0].answer, 42);
    // 集群必须固定 UTC：驱动适配器把原始 SQL 返回的 timestamptz 当「本地墙上时间」读成 UTC，
    // 服务器时区一旦跟随系统（例如东八区），租约与回填这类比较会整体偏移。
    assert.equal(probe.rows[0].timezone, "UTC", "桌面集群会话时区必须是 UTC");
  } finally { await client.end(); }
  await runtime.close(); runtime = null;
  runtime = await openBoundDesktopDatabase({ dataDir, binDir });
  assert.equal((await runtime.verify()).systemIdentifier, descriptor.systemIdentifier);
  await runtime.close(); runtime = null;
  await rejectQuarantine(/desktop_database_not_failed_initialization/u);
  succeeded = true;
  console.log("Initialization recovery passed: real initdb input failure, app/database lock guards, strict binding, links/ready/PID/cluster guards, evidence-preserving rename, fresh retry and reopen; no business database used.");
} finally {
  if (runtime) await runtime.close();
  if (fs.existsSync(path.join(fakePgData, "postmaster.pid"))) throw new Error(`Cleanup refused: inspect ${temporary}`);
  if (path.dirname(temporary) !== parent || !path.basename(temporary).startsWith("init-recovery-")) throw new Error("Unexpected test cleanup root");
  if (succeeded) fs.rmSync(temporary, { recursive: true, force: true });
  else console.error(`Retained isolated initialization diagnostics: ${temporary}`);
}
