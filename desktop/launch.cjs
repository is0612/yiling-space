/**
 * 桌面启动器（普通 Node 进程）。
 *
 * 顺序：先起 desktop-supervisor（数据库 / Nitro / Worker / QQ 栈都在普通 Node 下），
 * 拿到 ready URL 后再开 Electron 窗口；窗口退出后由这里停 supervisor。
 *
 * 为什么不把 supervisor 放到 Electron 主进程里起：Electron 的子进程在部分 Windows
 * 安全策略下拿不到正常文件权限，SnowLuma 会在 `mkdir <SnowLuma>\tmp` 处 EPERM；
 * 由普通 Node 起 supervisor，QQ 栈才能像手动 `yarn onebot:stack` 一样工作。
 *
 * 同时处理：
 * - `ELECTRON_RUN_AS_NODE=1` 时 electron.exe 会退化成 Node；
 * - Chromium 沙箱在个别机器上以 0x80000003 退出，自动重试一次 `--no-sandbox`；
 * - Chromium profile 由这里先建好，再通过 `--user-data-dir` 交给 Electron。
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let electronPath;
try {
  electronPath = require("electron");
} catch {
  console.error("找不到 Electron。先在项目根目录执行：yarn desktop:install");
  process.exit(1);
}

const ROOT = path.resolve(__dirname, "..");
const appDir = __dirname;
const passthrough = process.argv.slice(2).filter((arg) => arg !== "--no-sandbox");
const forceNoSandbox = process.argv.includes("--no-sandbox");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

function prepareDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

const dataDir = path.resolve(env.YILING_DATA_DIR?.trim() || path.join(ROOT, ".data"));
const hasUserDataArg = passthrough.some((arg) => arg.startsWith("--user-data-dir"));
if (!hasUserDataArg) {
  const candidates = [
    path.join(ROOT, ".tmp", "electron"),
    path.join(dataDir, "electron"),
    path.join(os.tmpdir(), "yiling-space-electron"),
  ];
  const profile = candidates.find(prepareDir);
  if (profile) {
    env.YILING_ELECTRON_PROFILE = profile;
    passthrough.push(`--user-data-dir=${profile}`);
  }
}

function log(message, detail = {}) {
  console.log(`[desktop] ${JSON.stringify({ at: new Date().toISOString(), message, ...detail })}`);
}

function startSupervisor() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "scripts", "desktop-supervisor.mjs"), "--port", "0", "--parent-stdin"], {
      cwd: ROOT,
      env: { ...env, YILING_DATA_DIR: dataDir },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    let buffer = "";
    const finish = (error, url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ child, url });
    };
    const timer = setTimeout(() => {
      finish(new Error("桌面运行时 120 秒内没有就绪。"));
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    }, 120_000);
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => {
      if (!settled) finish(new Error(`桌面运行时提前退出（code=${code ?? "未知"}）。`));
    });
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.event === "ready" && event.url) finish(null, event.url);
          else if (event.event === "fatal") finish(new Error(event.message || "桌面运行时启动失败"));
          else if (event.event === "starting" || event.event === "qq-stack-starting" || event.event === "qq-stack-already-running") {
            console.log(`[runtime] ${line}`);
          }
        } catch {
          console.log(`[runtime] ${line}`);
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) console.error(`[runtime] ${text}`);
    });
  });
}

function stopSupervisor(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    try {
      child.stdin.write(JSON.stringify({ command: "shutdown" }) + "\n");
      child.stdin.end();
    } catch {
      // stdin 已断
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
      resolve();
    }, 15_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function runElectron(url, noSandbox) {
  const args = [...(noSandbox ? ["--no-sandbox"] : []), ...passthrough, appDir];
  return new Promise((resolve) => {
    const child = spawn(electronPath, args, {
      stdio: "inherit",
      env: { ...env, YILING_DESKTOP_URL: url },
      windowsHide: false,
    });
    child.once("error", (error) => {
      console.error(`Electron 启动失败：${error.message}`);
      resolve(1);
    });
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

(async () => {
  let supervisor;
  try {
    const started = await startSupervisor();
    supervisor = started.child;
    console.log(`[desktop] runtime ready: ${started.url}`);

    let code = await runElectron(started.url, forceNoSandbox);
    if (!forceNoSandbox && (code === 2147483651 || code === 3)) {
      console.warn("\n[desktop] 沙箱启动被系统拦截，重试一次 --no-sandbox（不影响功能）。\n");
      code = await runElectron(started.url, true);
    }
    await stopSupervisor(supervisor);
    process.exit(code);
  } catch (error) {
    console.error(`[desktop] 启动失败：${error instanceof Error ? error.message : String(error)}`);
    if (supervisor) await stopSupervisor(supervisor);
    process.exit(1);
  }
})();
