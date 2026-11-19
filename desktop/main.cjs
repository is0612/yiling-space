/**
 * 忆灵空间 Windows 桌面壳（Electron）。
 *
 * 主进程只做三件事：单实例、窗口、启动/停止桌面 supervisor。
 * 数据库、迁移、Nitro、Scheduler、Worker 全在 `scripts/desktop-supervisor.mjs` 里，
 * 这样桌面壳可以换（Electron → 以后其它），核心运行逻辑不用重写。
 *
 * 渲染层加载的是本机 Nitro 服务（http://127.0.0.1:<随机端口>），
 * 不是 file:// 页面，因此 Web 端页面、SSR、Cookie 登录都能原样复用。
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.resolve(process.env.YILING_DATA_DIR?.trim() || path.join(ROOT, ".data"));
const LOG_DIR = path.join(DATA_DIR, "logs");
const LOG_FILE = path.join(LOG_DIR, "desktop.log");
const SUPERVISOR = path.join(ROOT, "scripts", "desktop-supervisor.mjs");
const EXTERNAL_URL = process.env.YILING_DESKTOP_URL?.trim() || "";

function ensureWritableDir(dir) {
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

// Chromium 的 profile 也放项目数据目录：默认的 %APPDATA%\Yiling Space 在部分机器上
// 会被安全软件/权限策略拒绝写 Lock file，表现是窗口还没出来进程就退出了。
// 启动器会先用普通 Node 建好目录并通过 --user-data-dir 传进来；直接 `electron desktop`
// 时这里再兜一次，项目目录写不进去就回退系统临时目录。
const hasUserDataArg = process.argv.some((arg) => arg.startsWith("--user-data-dir"));
if (!hasUserDataArg) {
  const candidates = [
    process.env.YILING_ELECTRON_PROFILE,
    path.join(DATA_DIR, "electron"),
    path.join(app.getPath("temp"), "yiling-space-electron"),
  ].filter(Boolean);
  const ELECTRON_PROFILE_DIR = candidates.find(ensureWritableDir) ?? null;
  if (ELECTRON_PROFILE_DIR) {
    app.setPath("userData", ELECTRON_PROFILE_DIR);
  } else {
    console.warn("[desktop] 没有可写的 Electron profile 目录，继续使用默认 userData。");
  }
}

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch {
  // 日志目录写不了时，log() 会只输出到控制台
}

let mainWindow = null;
let supervisor = null;
let supervisorStopping = false;
let appReady = false;
let currentUrl = "";

function log(message, detail = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), message, ...detail });
  console.log(`[desktop] ${line}`);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n", "utf8");
  } catch {
    // 日志写不进去不影响窗口
  }
}

function loadingPage(message) {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>忆灵空间</title>
<style>
  html,body{height:100%;margin:0;background:#f4f6f9;color:#38414d;font:14px/1.7 "Microsoft YaHei",system-ui,sans-serif}
  main{height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px}
  .mark{width:44px;height:44px;border-radius:14px;background:#e8eefb;display:grid;place-items:center;font-size:20px;color:#4c6ef5}
  p{margin:0;color:#68717f}
  small{color:#98a2b3}
</style></head><body><main><div class="mark">忆</div><strong>忆灵空间</strong><p>${message}</p><small>首次启动会检查 Docker 数据库，可能需要几十秒</small></main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    useContentSize: true,
    show: false,
    backgroundColor: "#f4f6f9",
    title: "忆灵空间",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: true,
      spellcheck: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.loadURL(loadingPage("正在启动…"));
  mainWindow.webContents.on("did-finish-load", () => {
    log("window-loaded", { url: mainWindow?.webContents.getURL() });
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, description, url) => {
    log("window-load-failed", { code, description, url });
  });

  // 桌面端默认没有菜单栏，F12 / Ctrl+Shift+I 需要自己接到 DevTools。
  // 只在窗口聚焦时生效，不注册全局快捷键，避免影响系统里其它应用。
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const inspect = (input.control || input.meta) && input.shift && input.key?.toLowerCase() === "i";
    if (input.key === "F12" || inspect) {
      event.preventDefault();
      mainWindow?.webContents.toggleDevTools();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!currentUrl) return;
    const target = new URL(url);
    const current = new URL(currentUrl);
    if (target.origin === current.origin) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function showError(message, hint = "") {
  log("startup-error", { message, hint });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(loadingPage(`启动失败：${message}`));
  }
  dialog.showMessageBox({
    type: "error",
    title: "忆灵空间启动失败",
    message,
    detail: hint || "日志位置：" + LOG_FILE,
  }).catch(() => {});
}

function startSupervisor() {
  // 正常桌面启动路径：launcher（普通 Node）已经起好了 supervisor，
  // 这里只负责把窗口加载到它给的 URL。只有直接 `electron desktop` 时才自己起。
  if (EXTERNAL_URL) {
    currentUrl = EXTERNAL_URL;
    log("using-external-supervisor", { url: EXTERNAL_URL });
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(EXTERNAL_URL);
    return;
  }
  if (supervisor) return;
  log("supervisor-starting", { root: ROOT, dataDir: DATA_DIR });
  supervisor = spawn(process.execPath, [SUPERVISOR, "--port", "0", "--parent-stdin"], {
    cwd: ROOT,
    env: {
      ...process.env,
      YILING_DATA_DIR: DATA_DIR,
      // Electron 可执行文件在子进程里退化成 Node，Nitro / Worker / Prisma 都由它跑。
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let buffer = "";
  supervisor.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      let event = null;
      try {
        event = JSON.parse(text);
      } catch {
        log("supervisor-output", { line: text });
        continue;
      }
      if (event.event === "ready" && event.url) {
        currentUrl = event.url;
        log("supervisor-ready", { url: event.url });
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL(event.url);
        }
      } else if (event.event === "fatal") {
        showError(event.message || "桌面运行时启动失败", event.hint || "");
      } else {
        log("supervisor-event", event);
      }
    }
  });
  supervisor.stderr.on("data", (chunk) => log("supervisor-stderr", { line: chunk.toString("utf8").trim() }));

  supervisor.once("error", (error) => {
    showError("无法启动桌面运行时", error.message);
  });
  supervisor.once("exit", (code, signal) => {
    supervisor = null;
    if (supervisorStopping) return;
    log("supervisor-exited", { code, signal });
    if (appReady) {
      showError("桌面运行时已退出", `退出码 ${code ?? "未知"}。日志：${LOG_FILE}`);
    }
  });
}

async function stopSupervisor() {
  supervisorStopping = true;
  const child = supervisor;
  supervisor = null;
  if (!child || child.exitCode !== null) return;
  // Windows 上 SIGTERM 等于直接杀进程；用 stdin 让 supervisor 自己按顺序停
  // Worker → Scheduler → Nitro。stdin 一关它也会走同一条收尾路径。
  try {
    child.stdin.write(JSON.stringify({ command: "shutdown" }) + "\n");
    child.stdin.end();
  } catch {
    // stdin 已经断了，直接等退出/兜底杀
  }
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // 已经退出
      }
      resolve();
    }, 8000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  log("single-instance-lock-failed", { userData: app.getPath("userData") });
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    appReady = true;
    createWindow();
    startSupervisor();
  }).catch((error) => {
    showError("Electron 启动失败", error instanceof Error ? error.message : String(error));
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", (event) => {
    if (!supervisor) return;
    event.preventDefault();
    void stopSupervisor().finally(() => app.quit());
  });
}

ipcMain.handle("desktop:open-data-dir", () => shell.openPath(DATA_DIR));
ipcMain.handle("desktop:open-logs", () => shell.openPath(LOG_DIR));
ipcMain.handle("desktop:version", () => app.getVersion());
