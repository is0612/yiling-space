#!/usr/bin/env node
/**
 * 桌面运行时的无界面 supervisor（阶段二原型）。
 *
 * 它只做一件事：把忆灵空间在本机可靠地跑起来，并把「现在到哪一步」用 JSON 行报出来。
 * Electron 主进程之后只需要启动它、读 ready 事件、加载 url；不需要自己懂 Docker/Prisma/Worker。
 *
 *   显式数据库运行时 → 迁移/备份闸门 → Nitro → Scheduler → Worker → ready
 *
 * 为什么先做无界面版：
 *   - 可以直接在命令行验证，不需要先装 Electron；
 *   - Electron 主进程只做窗口与 IPC，不把业务生命周期塞进主进程；
 *   - 阶段三的本地执行代理也可以复用同一套「子进程 + 日志 + 退出收尾」模式。
 *
 * 用法：
 *   node scripts/desktop-supervisor.mjs
 *   node scripts/desktop-supervisor.mjs --port 0 --skip-migrate --no-worker --no-scheduler
 *
 * 输出：stdout 每行一个 JSON；同时追加到 <data>/logs/desktop-supervisor.log。
 * 退出：先停消费者，再停自有 embedded 数据库；已有 Docker/external 实例不主动停，
 *       避免把用户本来就在用的服务一起关掉。
 */
import "dotenv/config";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { superviseMemoryWorker } from "./memory-worker-supervisor.mjs";
import { resolveDesktopDatabaseMode, openBoundDesktopDatabase, desktopPgBin } from "./desktop-database-config.mjs";
import { createDesktopPgBackup } from "./desktop-pg-backup.mjs";
import { applyDesktopPgMigrations } from "./desktop-pg-migrations.mjs";
import parentWatchApi from "./desktop-parent-watch.cjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHILD_PARENT_GUARD = new URL("./memory-worker-parent.mjs", import.meta.url).href;
const args = new Set(process.argv.slice(2));
const argValue = (name, fallback = "") => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
};

const SKIP_MIGRATE = args.has("--skip-migrate");
const NO_WORKER = args.has("--no-worker");
const NO_SCHEDULER = args.has("--no-scheduler");
const NO_QQ = args.has("--no-qq");
let databaseRuntime = null;
let databaseEnvironment = process.env;
let workerHandle = null;
let launcherWatch = null;
const PARENT_STDIN = args.has("--parent-stdin");
const REQUESTED_PORT = Number(argValue("--port", "0"));
const DATA_DIR = path.resolve(process.env.YILING_DATA_DIR?.trim() || path.join(ROOT, ".data"));
const LOG_DIR = path.join(DATA_DIR, "logs");
const LOG_FILE = path.join(LOG_DIR, "desktop-supervisor.log");
const DB_WAIT_MS = Number(process.env.YILING_DB_WAIT_MS || 120_000);
const WEB_WAIT_MS = Number(process.env.YILING_WEB_WAIT_MS || 60_000);

fs.mkdirSync(LOG_DIR, { recursive: true });
let stdoutAvailable = true;
process.stdout.on("error", () => { stdoutAvailable = false; });
process.stderr.on("error", () => {});

/**
 * 换到新的 YILING_DATA_DIR 时，至少把「解旧库凭据」需要的文件带过去：
 * - credentials-encryption.key：不带的话数据库里的 OneBot/SnowLuma 凭据解不开；
 * - snowluma-home.json：用户填过的协议端目录，避免重新扫盘/手填。
 * 不自动搬 stickers / 语音临时文件（体积大，且不是启动必需）。
 */
function migrateLegacyDataDir() {
  const legacy = path.join(ROOT, ".data");
  if (path.resolve(legacy) === path.resolve(DATA_DIR)) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const name of ["credentials-encryption.key", "snowluma-home.json"]) {
    const source = path.join(legacy, name);
    const target = path.join(DATA_DIR, name);
    if (!fs.existsSync(source) || fs.existsSync(target)) continue;
    try {
      fs.copyFileSync(source, target);
      log("data-dir-migrated", { name, from: legacy, to: DATA_DIR });
    } catch (error) {
      log("data-dir-migrate-failed", { name, message: error instanceof Error ? error.message : String(error) });
    }
  }
}

function log(event, detail = {}) {
  const entry = { at: new Date().toISOString(), event, ...detail };
  let line = JSON.stringify(entry);
  const databaseUrl = databaseEnvironment.DATABASE_URL;
  if (databaseUrl) {
    line = line.split(databaseUrl).join("[database-url]");
    try {
      const password = new URL(databaseUrl).password;
      for (const secret of [password, decodeURIComponent(password)]) {
        if (secret && secret.length >= 8) line = line.split(secret).join("[database-password]");
      }
    } catch { /* malformed configuration is reported separately, never echoed here */ }
  }
  try { fs.appendFileSync(LOG_FILE, line + "\n", "utf8"); } catch { /* keep lifecycle independent of log I/O */ }
  if (stdoutAvailable) {
    try { process.stdout.write(line + "\n"); } catch { stdoutAvailable = false; }
  }
}

function fail(message, hint = "", code = "") {
  log("fatal", { message, ...(hint ? { hint } : {}), ...(code ? { code } : {}) });
  process.exitCode = 1;
}

function startupError(message, code, hint) {
  const error = new Error(message);
  error.code = code;
  error.hint = hint;
  return error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pingPort(host, port, timeout = 1200) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function waitPort(host, port, totalMs, label) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (await pingPort(host, port)) return true;
    await sleep(600);
  }
  throw new Error(`${label} 在 ${Math.round(totalMs / 1000)} 秒内没有就绪（${host}:${port}）。`);
}

function parseDatabase() {
  const raw = databaseEnvironment.DATABASE_URL;
  if (!raw) throw new Error("缺少 DATABASE_URL；先跑 yarn setup 或配置 .env。");
  const url = new URL(raw);
  return {
    host: url.hostname === "localhost" ? "127.0.0.1" : url.hostname,
    port: Number(url.port || 5432),
  };
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    // stdin 必须断开：Electron 的 supervisor stdin 是一条一直开着的管道，
    // Prisma CLI 在继承这条管道时会停在读 stdin 上，表现为 migrate 永远不返回。
    stdio: ["ignore", "inherit", "inherit"],
    env: databaseEnvironment,
    ...options,
  });
  return result.status === 0;
}

/** Docker 不在就尝试拉起 Docker Desktop；只认「端口最终通了」，不认命令退出码。 */
async function ensureDockerDatabase() {
  const db = parseDatabase();
  if (await pingPort(db.host, db.port)) {
    log("db-reused", { host: db.host, port: db.port });
    return;
  }

  log("db-starting", { host: db.host, port: db.port });
  const dockerVersion = spawnSync("docker", ["--version"], { stdio: "ignore", env: databaseEnvironment });
  if (dockerVersion.error?.code === "ENOENT") {
    throw startupError(
      "没有找到 Docker。",
      "docker_missing",
      "先安装并启动 Docker Desktop：https://www.docker.com/products/docker-desktop/ 。装好后回到这里重试。",
    );
  }

  if (!run("docker", ["info"], { stdio: "ignore" })) {
    log("docker-not-running");
    // 非 Windows / 没装 Desktop 集成时这条会失败，交给下面的 info 再判一次。
    run("docker", ["desktop", "start", "--timeout", "180"], { stdio: "inherit" });
  }
  if (!run("docker", ["info"], { stdio: "ignore" })) {
    throw startupError(
      "Docker 引擎没有启动。",
      "docker_daemon_down",
      "打开 Docker Desktop，等左下角变成绿色 Running；如果卡在登录/更新，先处理它，再回这里重试。",
    );
  }

  const container = (process.env.YILING_DB_CONTAINER || "").trim();
  const started = container
    ? run("docker", ["start", container], { stdio: "ignore" })
    : run("docker", ["compose", "up", "-d", "db"], { stdio: "ignore" });
  if (!started) {
    throw startupError(
      "数据库容器起不来。",
      "db_start_failed",
      "在项目目录运行 `docker compose logs db` 看真实原因；常见是端口 5432 被别的程序占用。",
    );
  }

  try {
    await waitPort(db.host, db.port, DB_WAIT_MS, "PostgreSQL");
  } catch {
    throw startupError(
      "数据库容器启动了，但端口一直没有就绪。",
      "db_timeout",
      "看 `docker compose logs db`；如果容器反复重启，多半是数据卷/密码和 .env 对不上。",
    );
  }
  log("db-ready", { host: db.host, port: db.port });
}

/** 迁移失败必须停：带着旧表结构起服务只会静默写坏数据。 */
function migrateDatabase() {
  if (SKIP_MIGRATE) {
    log("migrate-skipped");
    return;
  }
  const prismaBin = path.join(ROOT, "node_modules", "prisma", "build", "index.js");
  if (!fs.existsSync(prismaBin)) throw new Error("找不到 Prisma CLI（node_modules/prisma 缺失），安装包不完整。");
  const schemaEngine = path.join(ROOT, "node_modules", "@prisma", "engines", "schema-engine-windows.exe");
  const prismaEnv = {
    ...databaseEnvironment,
    // 便携包里 --ignore-scripts 不会下载 Prisma 引擎；用打进去的二进制，
    // 避免目标机器写 `%APPDATA%\Prisma` 缓存时被安全策略挡住。
    ...(fs.existsSync(schemaEngine) ? { PRISMA_SCHEMA_ENGINE_BINARY: schemaEngine } : {}),
  };

  // 有未应用迁移时先备份；升级把数据写坏时至少有一个 pre-migrate dump。
  const status = spawnSync(process.execPath, [prismaBin, "migrate", "status"], {
    cwd: ROOT,
    env: prismaEnv,
    encoding: "utf8",
  });
  const statusText = `${status.stdout || ""}\n${status.stderr || ""}`;
  const pending = /not yet been applied|尚未应用|not been applied/i.test(statusText);
  if (pending) {
    log("pre-migrate-backup-starting");
    if (!run(process.execPath, [path.join(ROOT, "scripts", "desktop-backup.mjs"), "backup", "--label", "pre-migrate"], { env: prismaEnv })) {
      throw startupError(
        "升级前备份失败，已停止迁移。",
        "backup_failed",
        "检查 Docker 容器是否在跑、磁盘空间是否足够；也可以手动执行 `node scripts/desktop-backup.mjs backup`。",
      );
    }
    log("pre-migrate-backup-done");
  }

  log("migrate-starting");
  if (!run(process.execPath, [prismaBin, "migrate", "deploy"], { env: prismaEnv })) {
    throw new Error("数据库迁移失败；服务没有启动。先备份并修复迁移，再重试。");
  }
  log("migrate-done");
}

/**
 * 全新数据库没有任何管理员时，自动建一个，并把随机密码写到 <data>/first-run-admin.txt。
 * 桌面版没有安装向导，不能让人卡在登录页外面；已有用户的库完全不动。
 */
async function ensureFirstAdmin() {
  if ((process.env.YILING_FIRST_ADMIN || "").trim() === "0") return;
  const connectionString = databaseEnvironment.DATABASE_URL;
  if (!connectionString) throw new Error("缺少 DATABASE_URL，无法检查管理员账号。");

  const client = new Client({ connectionString });
  let count = 0;
  try {
    await client.connect();
    const result = await client.query('SELECT count(*)::int AS count FROM "users"');
    count = result.rows[0]?.count ?? 0;
  } finally {
    await client.end().catch(() => {});
  }
  if (count > 0) return;

  const username = (process.env.DEV_OWNER_USERNAME || "admin").trim() || "admin";
  const ownerId = (process.env.DEV_OWNER_ID || "").trim() || randomUUID();
  let password = (process.env.DEV_OWNER_PASSWORD || "").trim();
  let generated = false;
  if (!password || password.startsWith("replace_with_") || password.length < 8) {
    password = randomBytes(15).toString("base64url");
    generated = true;
  }

  const seeded = run(process.execPath, ["--import", "tsx", "scripts/seed-dev-user.ts"], {
    env: {
      ...databaseEnvironment,
      DEV_OWNER_ID: ownerId,
      DEV_OWNER_USERNAME: username,
      DEV_OWNER_PASSWORD: password,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (!seeded) {
    throw startupError(
      "数据库还没有管理员，自动创建失败。",
      "first_admin_failed",
      "检查 .env 的 DATABASE_URL 与迁移状态；也可以手动执行 `yarn seed:dev`。",
    );
  }

  let passwordFile = "";
  if (generated) {
    passwordFile = path.join(DATA_DIR, "first-run-admin.txt");
    fs.writeFileSync(
      passwordFile,
      `username=${username}\npassword=${password}\n\n首次登录后请在「设置」里修改密码。\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }
  log("first-admin-created", {
    username,
    ...(passwordFile ? { passwordFile } : { passwordFrom: "env" }),
  });
}

function tsxArgs(script) {
  const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  return fs.existsSync(tsxCli) ? [tsxCli, script] : ["--import", "tsx", script];
}

async function pickPort() {
  if (Number.isInteger(REQUESTED_PORT) && REQUESTED_PORT > 0) return REQUESTED_PORT;
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitHttp(url, totalMs) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (shutdownRequested) return false;
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return true;
    } catch {
      // 还没起来
    }
    await sleep(500);
  }
  return false;
}

function pipeLines(child, label) {
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) log("child-output", { process: label, line });
      }
    });
  }
}

const children = new Set();
let stopping = false;
let shutdownRequested = false;
let requestShutdown = null;
let qqStack = null;
let stdinBuffer = "";

/**
 * Windows 上 `child.kill('SIGTERM')` 等于直接 TerminateProcess，supervisor 收不到信号、
 * 也就没机会停 Worker/Nitro。所以 Electron 用 stdin 发一条 shutdown 命令；stdin 关闭
 * （Electron 崩溃/被任务管理器结束）也按退出处理，避免留下半套服务。
 */
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  const lines = stdinBuffer.split(/\r?\n/);
  stdinBuffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const command = JSON.parse(line);
      if (command?.command === "shutdown") {
        shutdownRequested = true;
        if (requestShutdown) requestShutdown("stdin");
      }
    } catch {
      // 非 JSON 的 stdin 输入忽略
    }
  }
});
process.stdin.on("end", () => {
  if (!PARENT_STDIN) return;
  shutdownRequested = true;
  if (requestShutdown) requestShutdown("stdin-end");
});
process.stdin.on("close", () => {
  if (!PARENT_STDIN) return;
  shutdownRequested = true;
  if (requestShutdown) requestShutdown("stdin-close");
});

function track(child, label) {
  children.add(child);
  child.once("exit", () => children.delete(child));
  child.once("error", (error) => log("child-error", { process: label, message: error.message }));
  return child;
}

function startScheduler() {
  if (NO_SCHEDULER) {
    log("scheduler-disabled");
    return null;
  }
  const child = track(spawn(process.execPath, ["--import", CHILD_PARENT_GUARD, ...tsxArgs("scripts/run-memory-scheduler.ts"), "--watch"], {
    cwd: ROOT,
    env: { ...databaseEnvironment, ...(databaseRuntime ? { PGAPPNAME: "yiling-desktop-scheduler" } : {}) },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  }), "scheduler");
  log("scheduler-started", { pid: child.pid });
  pipeLines(child, "scheduler");
  return child;
}

/** QQ 栈优先用系统 Node：SnowLuma / adapter 在 Electron 的 run-as-node 子进程里
 *  偶尔会被安全策略挡住（面板 5099 起不来、3001 没有节点）。系统装了 Node 就用它。 */
function findNodeExecutable() {
  const explicit = process.env.YILING_NODE_BIN?.trim();
  if (explicit && fs.existsSync(explicit) && !(process.platform === "win32" && !/\.exe$/i.test(explicit))) {
    return explicit;
  }
  // Yarn 1 会在 PATH 最前面塞一个临时 node.cmd；Windows 上 spawn 一个 .cmd 会直接 EINVAL，
  // 所以这里只找 node.exe / node 实体，不认垫片脚本。
  const finder = process.platform === "win32" ? "where" : "which";
  const target = process.platform === "win32" ? "node.exe" : "node";
  const result = spawnSync(finder, [target], { encoding: "utf8" });
  const first = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line
      && fs.existsSync(line)
      && fs.statSync(line).isFile()
      && !/\.(cmd|bat|ps1)$/i.test(line));
  return first || process.execPath;
}

async function startQqStackIfNeeded() {
  if (NO_QQ) { log("qq-stack-disabled"); return; }
  if (databaseRuntime) {
    // Existing global ports do not prove a QQ stack belongs to this newly bound database.
    log("qq-stack-manual-required", { reason: "embedded-instance-routing-not-bound" });
    return;
  }
  // 3001/3002/5099 都在听 = 用户手动跑过 `yarn onebot:stack`，不要再起第二套。
  // 只看 3001 不够：网关可能活着但面板已经死了（5099 没人应答），
  // 这时页面会报「面板端口没人应答」，必须重新拉起 SnowLuma。
  const gatewayReady = await pingPort("127.0.0.1", 3001) && await pingPort("127.0.0.1", 3002);
  const panelReady = await pingPort("127.0.0.1", 5099);
  if (gatewayReady && panelReady) {
    log("qq-stack-already-running");
    return;
  }
  const nodeBin = findNodeExecutable();
  log("qq-stack-starting", { node: nodeBin, gatewayReady, panelReady });
  const stack = track(spawn(nodeBin, tsxArgs("scripts/start-qq-stack.ts").concat("--managed"), {
    cwd: ROOT,
    env: {
      ...databaseEnvironment,
      // supervisor 已经管了 Worker；watchdog 也不是桌面启动的必需品。
      YILING_WORKER_DISABLED: "1",
      YILING_WATCHDOG_DISABLED: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }), "qq-stack");
  qqStack = stack;
  pipeLines(stack, "qq-stack");
  stack.once("exit", (code, signal) => {
    if (qqStack === stack) qqStack = null;
    log("qq-stack-exited", { code, signal });
  });
}

async function stopQqStack() {
  const stack = qqStack;
  qqStack = null;
  if (!stack || stack.exitCode !== null) return;
  try {
    stack.stdin.write(JSON.stringify({ command: "shutdown" }) + "\n");
    stack.stdin.end();
  } catch {
    // stdin 已断，走下面的兜底
  }
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        stack.kill("SIGKILL");
      } catch {
        // 已经退出
      }
      resolve();
    }, 10_000);
    stack.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function startWorker() {
  if (NO_WORKER) {
    log("worker-disabled");
    return null;
  }
  return await superviseMemoryWorker({
    root: ROOT,
    identityKey: databaseRuntime ? "embedded:" + databaseRuntime.descriptor().instanceId + ":" + databaseRuntime.descriptor().systemIdentifier : "",
    env: { ...databaseEnvironment, ...(databaseRuntime ? { PGAPPNAME: "yiling-desktop-worker" } : {}) },
    command: process.execPath,
    args: tsxArgs("scripts/run-memory-worker.ts").concat("--watch"),
    log: (entry) => log("worker", entry),
  });
}

let startupInProgress = true;
let shutdownPromise = null;
function shutdown(reason, exitCode = 0) {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  shutdownPromise = (async () => {
    log("stopping", { reason });
    try { await stopQqStack(); } catch { log("qq-stack-stop-failed"); exitCode = 1; }
    try { await workerHandle?.stop(); } catch { log("worker-stop-failed"); exitCode = 1; }
    log("worker-stopped");
    for (const child of [...children]) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const wait = new Promise(resolve => { const timer = setTimeout(resolve, 2000); child.once("exit", () => { clearTimeout(timer); resolve(); }); });
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      await wait;
      if (child.exitCode === null && child.signalCode === null) {
        const killed = new Promise(resolve => { const timer = setTimeout(resolve, 3000); child.once("exit", () => { clearTimeout(timer); resolve(); }); });
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        await killed;
      }
      if (child.exitCode === null && child.signalCode === null) { log("child-stop-unconfirmed"); exitCode = 1; }
    }
    log("consumers-stopped");
    try { await databaseRuntime?.close(); } catch { log("db-stop-unconfirmed", { dataDir: DATA_DIR }); exitCode = 1; }
    log("db-stop-finished");
    await launcherWatch?.stop();
    log("stopped", { exitCode });
    process.exit(exitCode);
  })();
  return shutdownPromise;
}
function checkStartupCancellation() {
  if (shutdownRequested) throw new Error("desktop_startup_cancelled");
}
requestShutdown = reason => {
  shutdownRequested = true;
  if (!startupInProgress) void shutdown(reason);
};
process.once("SIGINT", () => requestShutdown("SIGINT"));
process.once("SIGTERM", () => requestShutdown("SIGTERM"));

async function main() {
  if (process.platform === "win32" && process.env.YILING_DESKTOP_PARENT_PID) {
    launcherWatch = parentWatchApi.watchWindowsProcess(Number(process.env.YILING_DESKTOP_PARENT_PID), process.env.YILING_DESKTOP_PARENT_BIRTH,
      () => requestShutdown("parent-process-exited"));
    if (!await launcherWatch.ready) throw new Error("desktop_parent_watch_not_attached");
    log("launcher-watch-attached", { watchedPid: Number(process.env.YILING_DESKTOP_PARENT_PID), parentPid: process.ppid });
  }
  log("starting", { root: ROOT, dataDir: DATA_DIR });
  checkStartupCancellation();
  const mode = resolveDesktopDatabaseMode(DATA_DIR);
  log("db-runtime", { runtime: mode });
  if (mode === "embedded") {
    databaseRuntime = await openBoundDesktopDatabase({ dataDir: DATA_DIR, binDir: desktopPgBin(ROOT) });
    databaseEnvironment = databaseRuntime.childEnvironment({ ...process.env, YILING_DB_RUNTIME: "embedded", YILING_DATA_DIR: DATA_DIR });
    checkStartupCancellation();
    if (SKIP_MIGRATE) throw new Error("desktop_embedded_skip_migrate_refused");
    await applyDesktopPgMigrations({ applicationRoot: ROOT, runtime: databaseRuntime,
      backup: () => createDesktopPgBackup({ runtime: databaseRuntime, dataDir: DATA_DIR, label: "pre-migrate", quiescent: true }),
      log: entry => log(entry.event, { status: entry.status }) });
  } else {
    migrateLegacyDataDir();
    if (mode === "docker") await ensureDockerDatabase();
    else {
      const client = new Client({ connectionString: databaseEnvironment.DATABASE_URL, connectionTimeoutMillis: 5000 });
      try { await client.connect(); await client.query("SELECT 1"); } finally { await client.end().catch(() => {}); }
    }
    checkStartupCancellation();
    migrateDatabase();
  }
  checkStartupCancellation();
  await ensureFirstAdmin();
  checkStartupCancellation();

  const port = await pickPort();
  const url = `http://127.0.0.1:${port}`;
  const nitro = track(spawn(process.execPath, ["--import", CHILD_PARENT_GUARD, path.join(ROOT, "scripts", "local-production-entry.mjs")], {
    cwd: ROOT,
    env: {
      ...databaseEnvironment,
      ...(databaseRuntime ? { PGAPPNAME: "yiling-desktop-web" } : {}),
      NODE_ENV: "production",
      NITRO_HOST: "127.0.0.1",
      PORT: String(port),
      YILING_DATA_DIR: DATA_DIR,
      // 桌面版用独立 Cookie 名，避免和开发版（同一 Cookie 域、不同端口）互相顶登录。
      YILING_SESSION_COOKIE: process.env.YILING_SESSION_COOKIE || "yiling_session_desktop",
      // QQ 栈由这个 supervisor 起，避免 Nitro 插件再起一套。
      YILING_ONEBOT_AUTOSTART: "0",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  }), "nitro");
  log("web-started", { pid: nitro.pid });
  pipeLines(nitro, "nitro");
  nitro.once("exit", (code, signal) => {
    if (stopping) return;
    log("web-exited", { code, signal });
    shutdownRequested = true;
    if (!startupInProgress) void shutdown("web-exited", 1);
  });

  const ready = await waitHttp(url, WEB_WAIT_MS);
  if (!ready) throw new Error(`网页服务没有在 ${Math.round(WEB_WAIT_MS / 1000)} 秒内就绪。`);
  log("web-ready", { url });

  checkStartupCancellation();
  startScheduler();
  workerHandle = await startWorker();
  checkStartupCancellation();
  await startQqStackIfNeeded();
  checkStartupCancellation();
  startupInProgress = false;
  log("ready", { url, pid: process.pid, dataDir: DATA_DIR });

}

main().catch(async (error) => {
  fail(
    error instanceof Error ? error.message : String(error),
    error && typeof error === "object" ? error.hint ?? "" : "",
    error && typeof error === "object" ? error.code ?? "" : "",
  );
  await shutdown("startup-failed", 1);
});
