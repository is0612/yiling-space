#!/usr/bin/env node
/**
 * 桌面运行时的无界面 supervisor（阶段二原型）。
 *
 * 它只做一件事：把忆灵空间在本机可靠地跑起来，并把「现在到哪一步」用 JSON 行报出来。
 * Electron 主进程之后只需要启动它、读 ready 事件、加载 url；不需要自己懂 Docker/Prisma/Worker。
 *
 *   数据库（Docker）→ prisma migrate deploy → Nitro → Scheduler → Worker → ready
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
 * 退出：SIGINT / SIGTERM 会按 Worker → Scheduler → Nitro 的顺序停；数据库容器不主动停，
 *       避免把用户本来就在用的 Docker 或另一个实例的数据库一起关掉。
 */
import "dotenv/config";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { superviseMemoryWorker } from "./memory-worker-supervisor.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const argValue = (name, fallback = "") => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
};

const SKIP_MIGRATE = args.has("--skip-migrate");
const NO_WORKER = args.has("--no-worker");
const NO_SCHEDULER = args.has("--no-scheduler");
const PARENT_STDIN = args.has("--parent-stdin");
const REQUESTED_PORT = Number(argValue("--port", "0"));
const DATA_DIR = path.resolve(process.env.YILING_DATA_DIR?.trim() || path.join(ROOT, ".data"));
const LOG_DIR = path.join(DATA_DIR, "logs");
const LOG_FILE = path.join(LOG_DIR, "desktop-supervisor.log");
const DB_WAIT_MS = Number(process.env.YILING_DB_WAIT_MS || 120_000);
const WEB_WAIT_MS = Number(process.env.YILING_WEB_WAIT_MS || 60_000);

fs.mkdirSync(LOG_DIR, { recursive: true });

function log(event, detail = {}) {
  const entry = { at: new Date().toISOString(), event, ...detail };
  const line = JSON.stringify(entry);
  process.stdout.write(line + "\n");
  try {
    fs.appendFileSync(LOG_FILE, line + "\n", "utf8");
  } catch {
    // 日志写不进去不影响启动，stderr 仍然能看到
  }
}

function fail(message, hint = "") {
  log("fatal", { message, ...(hint ? { hint } : {}) });
  process.exitCode = 1;
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
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("缺少 DATABASE_URL；先跑 yarn setup 或配置 .env。");
  const url = new URL(raw);
  return {
    host: url.hostname === "localhost" ? "127.0.0.1" : url.hostname,
    port: Number(url.port || 5432),
  };
}

function run(command, commandArgs, options = {}) {  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    // stdin 必须断开：Electron 的 supervisor stdin 是一条一直开着的管道，
    // Prisma CLI 在继承这条管道时会停在读 stdin 上，表现为 migrate 永远不返回。
    stdio: ["ignore", "inherit", "inherit"],
    env: process.env,
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
  if (!run("docker", ["info"], { stdio: "ignore" })) {
    log("docker-not-running");
    run("docker", ["desktop", "start", "--timeout", "180"], { stdio: "inherit" });
  }
  if (!run("docker", ["info"], { stdio: "ignore" })) {
    throw new Error("Docker 引擎没有启动。请先打开 Docker Desktop，看到它变绿后再试。");
  }

  const container = (process.env.YILING_DB_CONTAINER || "").trim();
  const started = container
    ? run("docker", ["start", container], { stdio: "ignore" })
    : run("docker", ["compose", "up", "-d", "db"], { stdio: "ignore" });
  if (!started) throw new Error("数据库容器起不来；看 docker compose logs db 的真实原因。");

  await waitPort(db.host, db.port, DB_WAIT_MS, "PostgreSQL");
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
  log("migrate-starting");
  if (!run(process.execPath, [prismaBin, "migrate", "deploy"])) {
    throw new Error("数据库迁移失败；服务没有启动。先备份并修复迁移，再重试。");
  }
  log("migrate-done");
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
  const child = track(spawn(process.execPath, tsxArgs("scripts/run-memory-scheduler.ts").concat("--watch"), {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }), "scheduler");
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
      ...process.env,
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
    env: process.env,
    command: process.execPath,
    args: tsxArgs("scripts/run-memory-worker.ts").concat("--watch"),
    log: (entry) => log("worker", entry),
  });
}

async function main() {
  log("starting", { root: ROOT, dataDir: DATA_DIR });

  await ensureDockerDatabase();
  migrateDatabase();

  const port = await pickPort();
  const url = `http://127.0.0.1:${port}`;
  const nitro = track(spawn(process.execPath, [path.join(ROOT, "scripts", "local-production-entry.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "production",
      NITRO_HOST: "127.0.0.1",
      PORT: String(port),
      YILING_DATA_DIR: DATA_DIR,
      // 桌面版用独立 Cookie 名，避免和开发版（同一 Cookie 域、不同端口）互相顶登录。
      YILING_SESSION_COOKIE: process.env.YILING_SESSION_COOKIE || "yiling_session_desktop",
      // QQ 栈由这个 supervisor 起，避免 Nitro 插件再起一套。
      YILING_ONEBOT_AUTOSTART: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }), "nitro");
  pipeLines(nitro, "nitro");

  const ready = await waitHttp(url, WEB_WAIT_MS);
  if (!ready) throw new Error(`网页服务没有在 ${Math.round(WEB_WAIT_MS / 1000)} 秒内就绪。`);
  log("web-ready", { url });

  startScheduler();
  const worker = await startWorker();
  await startQqStackIfNeeded();

  log("ready", { url, pid: process.pid, dataDir: DATA_DIR });

  const shutdown = async (reason) => {
    if (stopping) return;
    stopping = true;
    log("stopping", { reason });
    try {
      await stopQqStack();
    } catch (error) {
      log("qq-stack-stop-failed", { message: error instanceof Error ? error.message : String(error) });
    }
    try {
      await worker?.stop();
    } catch (error) {
      log("worker-stop-failed", { message: error instanceof Error ? error.message : String(error) });
    }
    for (const child of [...children]) {
      try {
        child.kill("SIGTERM");
      } catch {
        // 已经退出
      }
    }
    await sleep(1000);
    for (const child of children) {
      try {
        child.kill("SIGKILL");
      } catch {
        // 已经退出
      }
    }
    log("stopped");
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  requestShutdown = shutdown;
  if (shutdownRequested) void shutdown("stdin-early");

  nitro.once("exit", (code, signal) => {
    if (stopping) return;
    log("web-exited", { code, signal });
    void shutdown("web-exited");
  });
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
  // 启动失败时把已经起来的子进程收掉，别留半套服务
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      // 已经退出
    }
  }
});
