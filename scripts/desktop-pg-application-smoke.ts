import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { Client } from "pg";
import { loadPgCredentials } from "./desktop-pg-store.mjs";
import { encryptApiKeyWithKey, decryptApiKeyWithKey } from "../server/utils/credential-encryption";
import { initializeDesktopDatabase, openBoundDesktopDatabase, resolveDesktopDatabaseMode } from "./desktop-database-config.mjs";
import { createDesktopPgBackup, validateDesktopPgBackup, restoreDesktopPgBackup } from "./desktop-pg-backup.mjs";
import { applyDesktopPgMigrations } from "./desktop-pg-migrations.mjs";
import { protectPgDirectory } from "./desktop-pg-tools.mjs";

// No dotenv; all connections come from freshly created, explicitly bound test instances.
if (process.platform !== "win32" || !process.env.YILING_TEST_PG_BIN) throw new Error("Windows and verified YILING_TEST_PG_BIN required");
const applicationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binDir = fs.realpathSync(process.env.YILING_TEST_PG_BIN);
const parent = path.join(applicationRoot, ".data", "desktop-pg-application-tests");
fs.mkdirSync(parent, { recursive: true });
const root = fs.mkdtempSync(path.join(parent, "application-")); protectPgDirectory(root);
const sourceDir = path.join(root, "源实例");
const restoredDir = path.join(root, "恢复实例");
let source: Awaited<ReturnType<typeof initializeDesktopDatabase>> | null = null;
let target: typeof source = null;
let db: PrismaClient | null = null;
const managedDirs: string[] = [];
let supervisor: ReturnType<typeof spawn> | null = null;
let succeeded = false;
function prisma(runtime: NonNullable<typeof source>) {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: runtime.childEnvironment({}).DATABASE_URL }) });
}
async function counts(runtime: NonNullable<typeof source>) {
  const client = await runtime.connect();
  try {
    const tables = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
    const result: Record<string, number> = {};
    for (const { tablename } of tables.rows) result[tablename] = Number((await client.query('SELECT count(*) AS n FROM "' + tablename.replaceAll('"', '""') + '"')).rows[0].n);
    return result;
  } finally { await client.end(); }
}
async function migrate(runtime: NonNullable<typeof source>, dataDir: string, appRoot = applicationRoot) {
  return applyDesktopPgMigrations({ applicationRoot: appRoot, runtime,
    backup: () => createDesktopPgBackup({ runtime, dataDir, quiescent: true, label: "pre-migrate" }) });
}
function waitExit(child: ReturnType<typeof spawn>, timeout = 20_000): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Supervisor did not exit")), timeout);
    child.once("exit", code => { clearTimeout(timer); resolve(code); });
  });
}
async function startSupervisor(dataDir: string) {
  const child = spawn(process.execPath, ["scripts/desktop-supervisor.mjs", "--port", "0", "--parent-stdin"], {
    cwd: applicationRoot, env: { ...process.env, YILING_DATA_DIR: dataDir, YILING_DB_RUNTIME: "embedded", YILING_PG_BIN: binDir,
      DATABASE_URL: "postgresql://must-not-connect.invalid/forbidden", YILING_FIRST_ADMIN: "0", LLM_API_KEY: "", LLM_MODEL: "", YILING_ONEBOT_AUTOSTART: "0",
      YILING_WORKER_DISABLED: "0", YILING_MEMORY_WORKER_INTERVAL_MS: "1000", YILING_MEMORY_SCHEDULER_INTERVAL_MS: "5000" },
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  supervisor = child;
  let output = "";
  const ready = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Isolated supervisor not ready")), 90_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Supervisor exited before ready: " + output.slice(-2000))); });
    for (const stream of [child.stdout!, child.stderr!]) stream.on("data", chunk => {
      output = (output + chunk.toString("utf8")).slice(-128 * 1024);
      for (const line of output.split(/\r?\n/u)) {
        try { const event = JSON.parse(line); if (event.event === "ready") { clearTimeout(timer); resolve(event.url); } } catch { /* non-event output */ }
      }
    });
  });
  return { child, ready, output: () => output };
}
try {
  source = await initializeDesktopDatabase({ dataDir: sourceDir, binDir }); managedDirs.push(sourceDir);
  const deployed = await migrate(source, sourceDir);
  assert(deployed.applied > 0);
  assert.equal((await migrate(source, sourceDir)).status, "up-to-date");
  db = prisma(source);
  const key = randomBytes(32); fs.writeFileSync(path.join(sourceDir, "credentials-encryption.key"), key, { mode: 0o600 });
  const syntheticSecret = "synthetic-credential-only";
  const owner = await db.user.create({ data: { username: "desktop-fixture-" + randomUUID(), passwordHash: "synthetic-hash", role: "ADMIN" } });
  const character = await db.character.create({ data: { ownerId: owner.id, name: "合成测试角色", basePrompt: "合成设定", modelConfig: { chatApiKeyEncrypted: encryptApiKeyWithKey(syntheticSecret, key) } } });
  const scope = await db.memoryScope.create({ data: { characterId: character.id, scopeType: "CHARACTER_GLOBAL", scopeKey: "global:" + character.id } });
  const conversation = await db.conversation.create({ data: { characterId: character.id, memoryScopeId: scope.id, title: "合成会话" } });
  const message = await db.message.create({ data: { conversationId: conversation.id, role: "USER", content: "仅用于恢复验证的合成消息", occurredAt: new Date("2026-01-02T08:00:00Z") } });
  const snapshot = await db.memorySnapshot.create({ data: { memoryScopeId: scope.id, snapshotKey: "fixture:" + randomUUID(), version: 2,
    periodStart: new Date("2026-01-01T00:00:00Z"), periodEnd: new Date("2026-01-03T00:00:00Z"), summary: "合成快照", structuredContent: { facts: ["恢复验证"] } } });
  await db.memorySnapshotSource.create({ data: { snapshotId: snapshot.id, sourceType: "MESSAGE", sourceRef: message.id, messageId: message.id } });
  const memory = await db.memoryItem.create({ data: { memoryScopeId: scope.id, category: "FACT", content: "合成长期记忆", sourceMessageId: message.id, sourceSnapshotId: snapshot.id } });
  const event = await db.memoryEvent.create({ data: { memoryScopeId: scope.id, conversationId: conversation.id, dayKey: "2026-01-02", occurredAt: new Date("2026-01-02T08:00:00Z"),
    title: "合成忆泡", detail: "合成经历", dedupeKey: randomUUID(), sourceMessageId: message.id, sourceMessageIds: [message.id] } });
  const journal = await db.characterJournal.create({ data: { memoryScopeId: scope.id, dayKey: "2026-01-02", diaryState: "GENERATED", handbookState: "GENERATED" } });
  const diary = await db.journalRevision.create({ data: { journalId: journal.id, kind: "DIARY", version: 1, content: "这是一段合成日记正文。", revisionType: "USER_EDITED", sourceMessageIds: [message.id] } });
  await db.journalRevision.create({ data: { journalId: journal.id, kind: "HANDBOOK", version: 1, content: "合成手账", quote: "合成日记正文", sourceDiaryRevisionId: diary.id, revisionType: "USER_EDITED", sourceEventIds: [event.id] } });
  await db.memoryJob.create({ data: { memoryScopeId: scope.id, type: "GENERATE_JOURNAL", idempotencyKey: "fixture:" + randomUUID(), status: "FAILED", attemptCount: 1, journalDayKey: "2026-01-02", journalTarget: "BOTH" } });
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=", "base64");
  const imageName = randomUUID() + ".png";
  for (const dir of ["stickers", "sticker-originals"]) {
    const destination = path.join(sourceDir, dir, character.id); fs.mkdirSync(destination, { recursive: true }); fs.writeFileSync(path.join(destination, imageName), image);
  }
  await db.characterSticker.create({ data: { characterId: character.id, name: "合成图片", fileName: imageName, mimeType: "image/png", sizeBytes: image.length, contentHash: createHash("sha256").update(image).digest("hex") } });
  const session = await db.session.create({ data: { userId: owner.id, tokenHash: createHash("sha256").update(randomUUID()).digest("hex"), expiresAt: new Date("2099-01-01T00:00:00Z") } });
  await db.$disconnect(); db = null;
  const sourceCounts = await counts(source);
  const archive = await createDesktopPgBackup({ runtime: source, dataDir: sourceDir, quiescent: true });
  await validateDesktopPgBackup(archive);
  // Missing key must not be quietly accepted when encrypted legacy values actually exist.
  const keyPath = path.join(sourceDir, "credentials-encryption.key"); fs.renameSync(keyPath, keyPath + ".saved");
  try { await assert.rejects(() => createDesktopPgBackup({ runtime: source, dataDir: sourceDir, quiescent: true }), /required_encryption_key_missing/u); }
  finally { fs.renameSync(keyPath + ".saved", keyPath); }
  const tampered = path.join(root, "tampered"); fs.cpSync(archive, tampered, { recursive: true });
  fs.appendFileSync(path.join(tampered, "database.dump"), "bad");
  const forbiddenTarget = path.join(root, "must-not-create");
  await assert.rejects(() => restoreDesktopPgBackup({ directory: tampered, dataDir: forbiddenTarget, binDir }), /checksum_mismatch/u);
  assert(!fs.existsSync(forbiddenTarget));
  await assert.rejects(() => restoreDesktopPgBackup({ directory: archive, dataDir: sourceDir, binDir }), { code: "EEXIST" });
  await source.close(); source = null;
  managedDirs.push(restoredDir);
  await restoreDesktopPgBackup({ directory: archive, dataDir: restoredDir, binDir });
  target = await openBoundDesktopDatabase({ dataDir: restoredDir, binDir });
  assert.deepEqual(await counts(target), sourceCounts);
  assert.equal((await migrate(target, restoredDir)).status, "up-to-date");
  db = prisma(target);
  assert.equal((await db.memoryItem.findUniqueOrThrow({ where: { id: memory.id } })).sourceSnapshotId, snapshot.id);
  assert.equal((await db.memorySnapshotSource.findFirstOrThrow({ where: { snapshotId: snapshot.id } })).messageId, message.id);
  assert.equal((await db.journalRevision.findFirstOrThrow({ where: { journalId: journal.id, kind: "HANDBOOK" } })).sourceDiaryRevisionId, diary.id);
  assert((await db.session.findUniqueOrThrow({ where: { id: session.id } })).revokedAt);
  const restoredCharacter = await db.character.findUniqueOrThrow({ where: { id: character.id } });
  const restoredKey = fs.readFileSync(path.join(restoredDir, "credentials-encryption.key"));
  assert.equal(decryptApiKeyWithKey((restoredCharacter.modelConfig as Record<string, string>).chatApiKeyEncrypted, restoredKey), syntheticSecret);
  assert.deepEqual(fs.readFileSync(path.join(restoredDir, "stickers", character.id, imageName)), image);
  await db.$disconnect(); db = null;
  await target.close(); target = null;
  const launched = await startSupervisor(restoredDir);
  const url = await launched.ready;
  assert((await fetch(url + "/api/health")).ok);
  assert.equal((await (await fetch(url + "/api/auth/session")).json()).user, null);
  const refusedLogin = await fetch(url + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: url },
    body: JSON.stringify({ username: "synthetic-nonexistent-user", password: "synthetic-password" }) });
  assert.equal(refusedLogin.status, 401, "exercise a real Web database query without logging in or invoking any model");
  const liveState = JSON.parse(fs.readFileSync(path.join(restoredDir, "database", "runtime.json"), "utf8"));
  const liveCredentials = loadPgCredentials(path.join(restoredDir, "database", "credentials.dpapi.json"), liveState.instanceId);
  const activity = new Client({ host: "127.0.0.1", port: liveState.port, user: "yiling_hub", database: "yiling_hub", password: liveCredentials.password,
    ssl: false, application_name: "desktop-integration-verifier", connectionTimeoutMillis: 5000 });
  try {
    await activity.connect();
    const deadline = Date.now() + 25_000;
    while (true) {
      const names = (await activity.query("SELECT DISTINCT application_name FROM pg_stat_activity WHERE datname=current_database()")).rows.map(row => row.application_name);
      if (["yiling-desktop-web", "yiling-desktop-worker", "yiling-desktop-scheduler"].every(name => names.includes(name))) break;
      assert(Date.now() < deadline, "Web/Worker/Scheduler must all connect to the restored bound database");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } finally { await activity.end(); }
  assert(launched.output().includes("qq-stack-manual-required"));
  assert(!launched.output().includes("worker-already-supervised"), "an unrelated checkout Worker must not suppress the bound instance Worker");
  const busyBackup = spawnSync(process.execPath, ["scripts/desktop-backup.mjs", "backup"], { cwd: applicationRoot,
    env: { ...process.env, YILING_DATA_DIR: restoredDir, YILING_DB_RUNTIME: "embedded", YILING_PG_BIN: binDir }, encoding: "utf8", timeout: 30_000 });
  assert.notEqual(busyBackup.status, 0);
  assert.match(busyBackup.stderr, /DESKTOP_PG_LOCK_BUSY/u, "offline backup must not bypass a live supervisor manager");
  launched.child.stdin!.write(JSON.stringify({ command: "shutdown" }) + "\n"); launched.child.stdin!.end();
  assert.equal(await waitExit(launched.child), 0); supervisor = null;
  assert(!launched.output().includes("postgresql://"));
  assert(!fs.existsSync(path.join(restoredDir, "database", "pgdata", "postmaster.pid")));
  source = await openBoundDesktopDatabase({ dataDir: sourceDir, binDir });
  db = prisma(source); assert.equal((await db.session.findUniqueOrThrow({ where: { id: session.id } })).revokedAt, null);
  assert.deepEqual(await counts(source), sourceCounts);
  await db.$disconnect(); db = null; await source.close(); source = null;
  const offlineBackup = spawnSync(process.execPath, ["scripts/desktop-backup.mjs", "backup"], { cwd: applicationRoot,
    env: { ...process.env, YILING_DATA_DIR: sourceDir, YILING_DB_RUNTIME: "embedded", YILING_PG_BIN: binDir,
      DATABASE_URL: "postgresql://must-not-connect.invalid/forbidden" }, encoding: "utf8", timeout: 60_000 });
  assert.equal(offlineBackup.status, 0, "offline bound backup CLI must use the embedded instance, not Docker or the inherited URL");
  assert(!offlineBackup.stdout.includes("postgresql://"));
  assert(!fs.existsSync(path.join(sourceDir, "database", "pgdata", "postmaster.pid")));
  assert.equal(resolveDesktopDatabaseMode(restoredDir, {}), "embedded");
  await assert.rejects(async () => resolveDesktopDatabaseMode(restoredDir, { YILING_DB_RUNTIME: "docker" }), /runtime_conflict/u);
  // Real SQL failure drill: checkpoint backup must recover a previous good migration version.
  const brokenApp = path.join(root, "broken-app");
  const migrationsDir = path.join(brokenApp, "prisma", "migrations");
  const goodMigration = path.join(migrationsDir, "20260101000000_checkpoint");
  fs.mkdirSync(goodMigration, { recursive: true });
  fs.copyFileSync(path.join(applicationRoot, "prisma", "schema.prisma"), path.join(brokenApp, "prisma", "schema.prisma"));
  fs.writeFileSync(path.join(migrationsDir, "migration_lock.toml"), 'provider = "postgresql"\n');
  fs.writeFileSync(path.join(goodMigration, "migration.sql"), "CREATE TABLE checkpoint(id integer PRIMARY KEY, body text NOT NULL); INSERT INTO checkpoint VALUES (1, 'synthetic checkpoint');\n");
  fs.symlinkSync(path.join(applicationRoot, "node_modules"), path.join(brokenApp, "node_modules"), "junction");
  const failedDir = path.join(root, "failed-migration"); managedDirs.push(failedDir);
  source = await initializeDesktopDatabase({ dataDir: failedDir, binDir });
  assert.equal((await migrate(source, failedDir, brokenApp)).applied, 1);
  const badMigration = path.join(migrationsDir, "20260102000000_deliberate_failure"); fs.mkdirSync(badMigration);
  fs.writeFileSync(path.join(badMigration, "migration.sql"), "BEGIN; CREATE TABLE rollback_probe(id integer); SELECT nonexistent_fixture_function(); COMMIT;\n");
  let checkpointBackup = "";
  let backups = 0;
  const failingMigration = () => applyDesktopPgMigrations({ applicationRoot: brokenApp, runtime: source,
    backup: async () => { backups++; checkpointBackup = await createDesktopPgBackup({ runtime: source, dataDir: failedDir, quiescent: true }); } });
  await assert.rejects(failingMigration, /desktop_pg_migration_cli_failed/u);
  assert.equal(backups, 1);
  const failedClient = await source.connect();
  try {
    assert.equal((await failedClient.query("SELECT body FROM checkpoint")).rows[0].body, "synthetic checkpoint");
    assert.equal((await failedClient.query("SELECT to_regclass('public.rollback_probe') AS name")).rows[0].name, null);
  } finally { await failedClient.end(); }
  await assert.rejects(failingMigration, /desktop_pg_migration_failed_ledger/u);
  assert.equal(backups, 1, "failed history must not silently redeploy or create repeated backups");
  const recoveredDir = path.join(root, "checkpoint-recovery"); managedDirs.push(recoveredDir);
  await restoreDesktopPgBackup({ directory: checkpointBackup, dataDir: recoveredDir, binDir });
  target = await openBoundDesktopDatabase({ dataDir: recoveredDir, binDir });
  const recoveredClient = await target.connect();
  try {
    assert.equal((await recoveredClient.query("SELECT body FROM checkpoint")).rows[0].body, "synthetic checkpoint");
    assert.equal((await recoveredClient.query("SELECT count(*)::integer AS n FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL")).rows[0].n, 0);
  } finally { await recoveredClient.end(); }
  await target.close(); target = null; await source.close(); source = null;
  const refusedStartup = await startSupervisor(failedDir);
  await assert.rejects(() => refusedStartup.ready, /Supervisor exited before ready/u);
  assert.equal(await waitExit(refusedStartup.child), 1); supervisor = null;
  assert(!fs.existsSync(path.join(failedDir, "database", "pgdata", "postmaster.pid")), "migration validation failure must close the owned PG instance");
  assert(!refusedStartup.output().includes('"event":"ready"'));
  assert(!refusedStartup.output().includes("postgresql://"));
  succeeded = true;
  console.log("Desktop application PG passed: real Prisma migrations, full table counts, memory sources, journal versions, encrypted credential+assets restore, revoked target sessions only, tamper/overwrite/missing-key rejection, bound supervisor ready+shutdown, source unchanged.");
} finally {
  await db?.$disconnect();
  if (supervisor && supervisor.exitCode === null) {
    supervisor.stdin?.write(JSON.stringify({ command: "shutdown" }) + "\n"); supervisor.stdin?.end();
    await waitExit(supervisor).catch(() => { supervisor?.kill("SIGKILL"); });
  }
  await source?.close(); await target?.close();
  for (const dataDir of managedDirs) {
    if (fs.existsSync(path.join(dataDir, "database", "pgdata", "postmaster.pid"))) {
      const cleanup = await openBoundDesktopDatabase({ dataDir, binDir }); await cleanup.close();
    }
    if (fs.existsSync(path.join(dataDir, "database", "pgdata", "postmaster.pid"))) throw new Error("Test cleanup stopped: PostgreSQL remains running");
  }
  const modulesLink = path.join(root, "broken-app", "node_modules");
  if (fs.existsSync(modulesLink)) {
    if (!fs.lstatSync(modulesLink).isSymbolicLink()) throw new Error("Unexpected test node_modules directory; cleanup refused");
    fs.unlinkSync(modulesLink); // Remove the junction itself before recursive test-root cleanup.
  }
  if (succeeded && path.dirname(root) === parent && path.basename(root).startsWith("application-")) fs.rmSync(root, { recursive: true });
  else console.error("Retained isolated application diagnostics: " + root);
}
