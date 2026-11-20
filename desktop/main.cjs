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
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, session, shell, Tray } = require("electron");

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
let tray = null;
let trayReady = false;
let closeToTray = false;
let isQuitting = false;
let saveStateTimer = null;
const WINDOW_STATE_FILE = () => path.join(app.getPath("userData"), "window-state.json");
const ICON_PATH = path.join(__dirname, "assets", "icon.png");
const WINDOWS_TRAY_ICON = path.join(__dirname, "assets", "icon.ico");
if (process.platform === "win32") app.setAppUserModelId("YilingSpace.Desktop");

function loadWindowState() {
  const fallback = { width: 1440, height: 900, maximized: false };
  try {
    const state = JSON.parse(fs.readFileSync(WINDOW_STATE_FILE(), "utf8"));
    if (!Number.isFinite(state.width) || !Number.isFinite(state.height)) return fallback;
    const width = Math.max(1040, Math.round(state.width));
    const height = Math.max(680, Math.round(state.height));
    if (!Number.isFinite(state.x) || !Number.isFinite(state.y)) {
      return { width, height, maximized: Boolean(state.maximized) };
    }
    const bounds = { x: Math.round(state.x), y: Math.round(state.y), width, height };
    const visible = screen.getAllDisplays().some((display) => {
      const area = display.workArea;
      return bounds.x < area.x + area.width
        && bounds.x + bounds.width > area.x
        && bounds.y < area.y + area.height
        && bounds.y + bounds.height > area.y;
    });
    return visible ? { ...bounds, maximized: Boolean(state.maximized) } : { width, height, maximized: false };
  } catch {
    return fallback;
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const bounds = typeof mainWindow.getNormalBounds === "function"
      ? mainWindow.getNormalBounds()
      : mainWindow.getBounds();
    fs.writeFileSync(WINDOW_STATE_FILE(), JSON.stringify({
      ...bounds,
      maximized: mainWindow.isMaximized(),
    }), "utf8");
  } catch {
    // 写不了窗口状态不影响使用
  }
}

function scheduleSaveWindowState() {
  clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(saveWindowState, 300);
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createApplicationMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "文件",
      submenu: [
        { label: "打开忆灵空间", click: showMainWindow },
        { label: "打开数据目录", click: () => void shell.openPath(DATA_DIR) },
        { label: "打开日志目录", click: () => void shell.openPath(LOG_DIR) },
        { type: "separator" },
        {
          label: "关闭窗口时保留在托盘",
          type: "checkbox",
          checked: closeToTray,
          enabled: trayReady,
          click: (item) => { closeToTray = item.checked; },
        },
        { label: "退出忆灵空间", accelerator: "CommandOrControl+Shift+Q", click: () => { isQuitting = true; app.quit(); } },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "重新加载页面" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
      ],
    },
  ]));
}

function createTray() {
  try {
    const png = nativeImage.createFromBuffer(fs.readFileSync(ICON_PATH));
    const windowsIcon = process.platform === "win32" ? nativeImage.createFromPath(WINDOWS_TRAY_ICON) : null;
    const icon = windowsIcon && !windowsIcon.isEmpty() ? windowsIcon : png.resize({ width: 32, height: 32 });
    if (icon.isEmpty()) throw new Error("托盘图标无法加载");
    // The development launcher can reach electron.exe through different Windows path aliases.
    tray = new Tray(icon);
    tray.setToolTip("忆灵空间");
    const menu = Menu.buildFromTemplate([
      { label: "打开忆灵空间", click: showMainWindow },
      { type: "separator" },
      { label: "打开数据目录", click: () => void shell.openPath(DATA_DIR) },
      { label: "打开日志目录", click: () => void shell.openPath(LOG_DIR) },
      { type: "separator" },
      { label: "退出", click: () => { isQuitting = true; app.quit(); } },
    ]);
    tray.setContextMenu(menu);
    tray.on("click", showMainWindow);
    tray.on("double-click", showMainWindow);
    trayReady = true;
    log("tray-registered", { icon: windowsIcon && !windowsIcon.isEmpty() ? "ico" : "png" });
  } catch (error) {
    tray?.destroy();
    tray = null;
    trayReady = false;
    log("tray-create-failed", { message: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * 角色卡/对话 Markdown 都是浏览器下载。默认下载目录如果落在受保护位置，
 * Windows/Chromium 会报「需要权限」，用户以为应用要管理员。这里统一弹保存对话框，
 * 让用户自己选一个可写目录（桌面/文档）。
 */
function setupDownloads() {
  session.defaultSession.on("will-download", (_event, item) => {
    const filename = item.getFilename() || "yiling-export.json";
    const extension = path.extname(filename).replace(/^\./, "");
    const options = {
      title: "保存导出文件",
      defaultPath: path.join(app.getPath("downloads"), filename),
      ...(extension ? { filters: [{ name: extension.toUpperCase(), extensions: [extension] }] } : {}),
    };
    const selected = mainWindow && !mainWindow.isDestroyed()
      ? dialog.showSaveDialogSync(mainWindow, options)
      : dialog.showSaveDialogSync(options);
    if (!selected) {
      item.cancel();
      return;
    }
    item.setSavePath(selected);
    log("download-save", { path: selected });
  });
}

/**
 * 渲染进程只加载本机 127.0.0.1 上的页面，但没有 CSP 时 Electron 会在控制台报
 * 「Insecure Content-Security-Policy」，并且真的允许页面执行任意远端脚本。
 * 这里补一条最小策略，只放开页面确实用到的：
 *   - 'unsafe-inline'（script / style）：Nuxt 的内联 importmap、运行时注入的样式
 *   - https://q1.qlogo.cn：QQ 公开头像，浏览器直连（见 SocialFriendsWorkspace 的 avatarUrl）
 *   - data: / blob:：语音、表情、预览的本地对象 URL
 * 不含 'unsafe-eval'：Vue 模板在构建期就编译好了，代码里也没有 new Function / eval。
 * 模型接口都是服务端（Nitro）转发，前端不直连，所以 connect-src 只留自身。
 */
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://q1.qlogo.cn",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function setupContentSecurityPolicy() {
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ["http://127.0.0.1/*", "http://localhost/*"] },
    (details, callback) => {
      const headers = { ...(details.responseHeaders || {}) };
      const existing = Object.keys(headers).some((key) => key.toLowerCase() === "content-security-policy");
      if (!existing) headers["Content-Security-Policy"] = [APP_CSP];
      callback({ responseHeaders: headers });
    },
  );
}

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
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<title>忆灵空间</title>
<style>
  /* 与 app/assets/css/main.css 同一套值：底色 #f4f6f9、品牌 #c9416b、字号 16/14/12 */
  html,body{height:100%;margin:0;background:#f4f6f9;color:#101620;font:14px/1.7 "Microsoft YaHei",system-ui,sans-serif}
  main{height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px}
  .mark{width:44px;height:44px;border-radius:10px;background:#c9416b;display:grid;place-items:center;font-size:20px;font-weight:700;color:#fff}
  strong{font-size:16px;font-weight:700;letter-spacing:.01em}
  p{margin:0;color:#68717f}
  small{color:#9aa3b1;font-size:12px}
</style></head><body><main><div class="mark">忆</div><strong>忆灵空间</strong><p>${message}</p><small>首次启动会检查 Docker 数据库，可能需要几十秒</small></main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function createWindow() {
  const state = loadWindowState();
  mainWindow = new BrowserWindow({
    ...(Number.isFinite(state.x) ? { x: state.x, y: state.y } : {}),
    width: state.width,
    height: state.height,
    minWidth: 1040,
    minHeight: 680,
    useContentSize: true,
    show: false,
    backgroundColor: "#f4f6f9",
    title: "忆灵空间",
    icon: ICON_PATH,
    autoHideMenuBar: process.platform !== "win32",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: true,
      spellcheck: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    if (state.maximized) mainWindow?.maximize();
    mainWindow?.show();
  });
  mainWindow.on("resize", scheduleSaveWindowState);
  mainWindow.on("move", scheduleSaveWindowState);
  mainWindow.on("maximize", scheduleSaveWindowState);
  mainWindow.on("unmaximize", scheduleSaveWindowState);
  mainWindow.on("close", (event) => {
    saveWindowState();
    if (isQuitting) return;
    // Electron 建好了图标也不代表 Explorer 已显示；只有用户主动开启才隐藏。
    if (!trayReady || !closeToTray) {
      isQuitting = true;
      return;
    }
    event.preventDefault();
    mainWindow?.hide();
  });
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

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function errorPage(message, hint = "") {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<title>忆灵空间启动失败</title>
<style>
  html,body{height:100%;margin:0;background:#f4f6f9;color:#101620;font:14px/1.7 "Microsoft YaHei",system-ui,sans-serif}
  main{max-width:760px;margin:0 auto;height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;padding:24px;box-sizing:border-box;text-align:center}
  .mark{width:52px;height:52px;border-radius:10px;background:#fdecee;display:grid;place-items:center;font-size:26px;color:#c92b41}
  h1{font-size:18px;margin:0;font-weight:700}
  p{margin:0;color:#68717f}
  /* hint 走 main.css 的 --amber 三件套，别再单独调一套黄 */
  .hint{max-width:620px;color:#8f5c05;background:#fdf6e7;border:1px solid #ecd9b4;border-radius:10px;padding:10px 14px;font-size:14px;line-height:1.7;text-align:left}
  .path{font-size:12px;color:#9aa3b1;word-break:break-all}
  .actions{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:4px}
  button{border:1px solid #dbe0e9;background:#fff;color:#454f5e;border-radius:8px;padding:7px 14px;font-size:14px;cursor:pointer;transition:background .14s ease,border-color .14s ease}
  button.primary{background:#c9416b;border-color:#c9416b;color:#fff}
  button.primary:hover{background:#b8375f;border-color:#b8375f}
</style></head><body><main>
  <div class="mark">!</div>
  <h1>忆灵空间启动失败</h1>
  <p>${escapeHtml(message)}</p>
  ${hint ? `<div class="hint">${escapeHtml(hint)}</div>` : ""}
  <div class="actions">
    <button class="primary" onclick="window.yilingDesktop?.openLogs()">打开日志目录</button>
    <button onclick="window.yilingDesktop?.openDataDir()">打开数据目录</button>
  </div>
  <div class="path">日志：${escapeHtml(LOG_FILE)}</div>
</main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function showError(message, hint = "") {
  log("startup-error", { message, hint });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(errorPage(message, hint));
    return;
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

/**
 * Chromium 的锁在少数机器上会因为 userData 权限/残留文件直接返回 false，
 * 和「真的已经开着一个实例」分不出来。用我们自己的 PID 标记再确认一次：
 * 标记里的进程还活着才让位；否则照常启动（宁可多开一个，也别双击没反应）。
 */
function instanceMarkerPath() {
  return path.join(app.getPath("userData"), "instance.json");
}

function markedInstanceAlive() {
  try {
    const info = JSON.parse(fs.readFileSync(instanceMarkerPath(), "utf8"));
    if (!info || !Number.isInteger(info.pid) || !Number.isFinite(info.at)) return false;
    if (Date.now() - info.at > 6 * 60 * 60 * 1000) return false;
    process.kill(info.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function markInstance() {
  try {
    fs.writeFileSync(instanceMarkerPath(), JSON.stringify({ pid: process.pid, at: Date.now() }), "utf8");
  } catch {
    // 写不了就算了，下次顶多多开一个
  }
}

function clearInstanceMarker() {
  try {
    const info = JSON.parse(fs.readFileSync(instanceMarkerPath(), "utf8"));
    if (info?.pid === process.pid) fs.unlinkSync(instanceMarkerPath());
  } catch {
    // 不是我们写的 / 已经没了
  }
}

const yieldToOther = !gotLock && markedInstanceAlive();
if (yieldToOther) {
  log("yield-to-existing-instance", { userData: app.getPath("userData") });
  app.quit();
} else {
  if (!gotLock) log("starting-without-chromium-lock", { userData: app.getPath("userData") });
  markInstance();
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    appReady = true;
    setupContentSecurityPolicy();
    createTray();
    createApplicationMenu();
    createWindow();
    setupDownloads();
    startSupervisor();
  }).catch((error) => {
    showError("Electron 启动失败", error instanceof Error ? error.message : String(error));
  });

  app.on("activate", showMainWindow);

  app.on("window-all-closed", () => {
    if (isQuitting) app.quit();
  });

  app.on("before-quit", (event) => {
    isQuitting = true;
    clearInstanceMarker();
    saveWindowState();
    if (!supervisor) return;
    event.preventDefault();
    void stopSupervisor().finally(() => app.quit());
  });
}

ipcMain.handle("desktop:open-data-dir", () => shell.openPath(DATA_DIR));
ipcMain.handle("desktop:open-logs", () => shell.openPath(LOG_DIR));
ipcMain.handle("desktop:version", () => app.getVersion());
