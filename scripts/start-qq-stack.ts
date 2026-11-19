/**
 * 一键起「QQ 链路」：先把 SnowLuma 拉起来，等 3001/3002 通了，再把适配器拉起来。
 *
 * 分两个窗口各起一次是常见的翻车点：协议端还没开端口，适配器就已经在重连；
 * 起了两个协议端实例还会抢同一个 messages.db（SQLITE_READONLY，消息直接写不进去）。
 *
 * ⚠️ 适配器必须走 run-onebot-adapter.ts（runner），不能在这里直接 supervise：
 * runner 每秒 reconcile，网页上改的绑定级设置（仅 @ 回复、限流、群号）
 * 才会自动重载；直接 supervise 只在启动时读一次，改了等于没改。
 */

import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { superviseMemoryWorker } from "./memory-worker-supervisor.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

/**
 * SnowLuma 是外部 QQ 协议端，不在本仓库里，所以路径不能猜。
 *
 * 顺序：`SNOWLUMA_HOME`（命令行临时覆盖）→ 网页「QQ 渠道 → 换目录」保存的那份。
 * 那个文件和服务端 `readSnowlumaStatus()` 读的是同一份配置，网页上填一次两边都认。
 *
 * 空值不在这里抛错：3001 已经在听说明协议端跑着，这种情况根本不需要路径。
 */
const DATA_DIR = process.env.YILING_DATA_DIR?.trim()
  ? resolve(process.env.YILING_DATA_DIR.trim())
  : join(REPO_ROOT, ".data");
const SAVED_SNOWLUMA_HOME = join(DATA_DIR, "snowluma-home.json");

function readSavedSnowlumaHome(): string {
  try {
    const parsed = JSON.parse(readFileSync(SAVED_SNOWLUMA_HOME, "utf8")) as { home?: unknown };
    if (typeof parsed.home === "string" && parsed.home.trim()) return resolve(parsed.home.trim());
  } catch {
    // 页面没填过、文件不存在、或内容坏了，都当作没配置
  }
  return "";
}

const SNOWLUMA_HOME = process.env.SNOWLUMA_HOME?.trim() || readSavedSnowlumaHome();
const PORTS = [3001, 3002];
const PANEL_PORT = Number(process.env.SNOWLUMA_PANEL_PORT || 5099);
const READY_TIMEOUT_MS = 120_000;
const MANAGED = process.argv.includes("--managed");

let running = true;
let requestShutdown: (() => void) | null = null;
let shutdownRequested = false;

/**
 * 桌面 supervisor 通过 stdin 发 shutdown。Windows 上 SIGTERM 等于直接杀进程，
 * 所以必须留一条能按顺序停 adapter → watchdog → SnowLuma 的通道。
 */
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (!MANAGED) return;
  for (const line of String(chunk).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const command = JSON.parse(line);
      if (command?.command === "shutdown") {
        shutdownRequested = true;
        requestShutdown?.();
      }
    } catch {
      // 非 JSON 输入忽略
    }
  }
});
for (const event of ["end", "close"]) {
  process.stdin.on(event, () => {
    if (!MANAGED) return;
    shutdownRequested = true;
    requestShutdown?.();
  });
}

function log(entry: Record<string, unknown>) {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (open: boolean) => {
      socket.destroy();
      resolvePromise(open);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

async function waitForPorts(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (running && Date.now() < deadline) {
    const states = await Promise.all(PORTS.map(portOpen));
    if (states.every(Boolean)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function startSnowLuma(): ChildProcess {
  // 用协议端自带的 node（版本是它挑过的），没有才退回当前这个。
  const nodeExe = existsSync(join(SNOWLUMA_HOME, "node.exe")) ? join(SNOWLUMA_HOME, "node.exe") : process.execPath;
  // SnowLuma 的更新临时目录默认落在系统 %TEMP%；部分 Windows 安全策略会让它 mkdir/rmdir 失败，
  // 表现为启动时 EPERM、面板 5099 永远不起来。把 TEMP 指到数据目录下，它自己就能清理。
  const tmpRoot = join(DATA_DIR, "tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const child = spawn(nodeExe, ["index.mjs"], {
    cwd: SNOWLUMA_HOME,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TEMP: tmpRoot, TMP: tmpRoot, TMPDIR: tmpRoot },
  });
  pipeWithPrefix(child.stdout, "snowluma");
  pipeWithPrefix(child.stderr, "snowluma");
  child.on("error", (error) => log({ event: "snowluma-spawn-failed", error: error.message }));
  child.on("exit", (code) => {
    if (running) log({ event: "snowluma-exited", code: code ?? "未知" });
  });
  return child;
}

/** 子进程的输出逐行转成带前缀的一行，一个窗口里能分清是谁在说话。 */
function pipeWithPrefix(stream: NodeJS.ReadableStream | null, label: string) {
  if (!stream) return;
  let buffer = "";
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) process.stdout.write(`[${label}] ` + line + "\n");
    }
  });
}

function tsxArgs(script: string): string[] {
  const tsxCli = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  return existsSync(tsxCli)
    ? [tsxCli, script]
    : ["--import", "tsx", script];
}

/**
 * 停滞检测跟着这条链路一起起：它只看产出，不看进程，所以和 QQ 是否连通无关。
 * 放在这里是「既然你已经开着一个常驻窗口，就别再多开一个」—— 它自己崩了不影响 QQ 收发，
 * 但要留下 `watchdog-exited` 这一行，否则仪表没了没人知道。
 */
function startWatchdog(): ChildProcess {
  const child = spawn(process.execPath, tsxArgs("scripts/watchdog.ts").concat("--watch"), {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  pipeWithPrefix(child.stdout, "watchdog");
  pipeWithPrefix(child.stderr, "watchdog");
  child.on("error", (error) => log({ event: "watchdog-spawn-failed", error: error.message }));
  child.on("exit", (code) => {
    if (running) log({ event: "watchdog-exited", code: code ?? "未知" });
  });
  return child;
}

function startAdapter(): ChildProcess {
  const child = spawn(process.execPath, tsxArgs("scripts/run-onebot-adapter.ts"), { cwd: REPO_ROOT, stdio: "inherit" });
  child.on("error", (error) => log({ event: "adapter-spawn-failed", error: error.message }));
  child.on("exit", (code) => {
    if (running) log({ event: "adapter-exited", code: code ?? "未知" });
  });
  return child;
}

async function main() {
  let snowluma: ChildProcess | null = null;
  // 只看 3001 不够：网关端口可能还在，但面板 5099 已经死了。
  // 面板没人应答时页面会报「面板端口 5099 没人应答，3001 上没有 WS 节点」，
  // 这时必须重新拉起 SnowLuma，而不是直接跳过。
  if (await portOpen(PORTS[0]!) && await portOpen(PANEL_PORT)) {
    log({ event: "snowluma-already-running", hint: `${PORTS[0]} 与面板 ${PANEL_PORT} 都在监听，跳过启动。` });
  } else {
    if (!SNOWLUMA_HOME) {
      throw new Error(
        "没找到 SnowLuma 目录。它是外部 QQ 协议端，不在本仓库里——"
        + "先在网页「系统管理 → QQ 渠道」点「换目录」填一次，或用 SNOWLUMA_HOME 指定。",
      );
    }
    if (!existsSync(join(SNOWLUMA_HOME, "index.mjs"))) {
      throw new Error(`SnowLuma 目录里没有 index.mjs：${SNOWLUMA_HOME}。请指向协议端根目录（里面应有 start.bat）。`);
    }
    log({ event: "snowluma-starting", home: SNOWLUMA_HOME, source: process.env.SNOWLUMA_HOME?.trim() ? "env" : "saved" });
    snowluma = startSnowLuma();
  }

  if (!(await waitForPorts(READY_TIMEOUT_MS))) {
    throw new Error(
      `${PORTS.join(" / ")} 一直没起来。多半是 QQ 客户端没登录或协议端没探测到它 —— `
      + `打开 http://127.0.0.1:5099 看进程注入那一页，登录后重试。`,
    );
  }
  if (!running) return;
  log({ event: "snowluma-ready", ports: PORTS });

  // 停滞检测挂在同一个窗口里（`YILING_WATCHDOG_DISABLED=1` 可以关掉）。
  const watchdog = process.env.YILING_WATCHDOG_DISABLED === "1" ? null : startWatchdog();
  if (!watchdog) log({ event: "watchdog-skipped", reason: "YILING_WATCHDOG_DISABLED=1" });

  // 记忆 Worker 也挂进来（`YILING_WORKER_DISABLED=1` 可以关掉）。
  let worker: Awaited<ReturnType<typeof superviseMemoryWorker>> | null = null;
  let adapter: ChildProcess | null = null;
  const shutdown = () => {
    running = false;
    adapter?.kill();
    watchdog?.kill();
    snowluma?.kill();
    void worker?.stop();
  };
  requestShutdown = shutdown;
  if (shutdownRequested) shutdown();
  try {
    worker = await superviseMemoryWorker({ root: REPO_ROOT, log });
    if (!running) return;
    adapter = startAdapter();
    const activeAdapter = adapter;
    const exitCode = await new Promise<number>((resolveExit) => {
      activeAdapter.once("exit", (code) => resolveExit(code ?? 0));
      activeAdapter.once("error", () => resolveExit(1));
    });
    process.exitCode = exitCode;
  } finally {
    running = false;
    await worker?.stop();
    watchdog?.kill();
    snowluma?.kill();
  }
}

const stop = () => {
  running = false;
  requestShutdown?.();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

main().catch((error) => {
  console.error("QQ 链路启动失败：", error instanceof Error ? error.message : error);
  process.exit(1);
});
