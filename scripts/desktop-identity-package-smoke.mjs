import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { pgProcessIdentity } from "./desktop-pg-tools.mjs";

/**
 * 正常安装入口的免登录闭环验收（独立 fixture，不做卸载，不点原生确认框）。
 *
 * 前置：YILING_TEST_INSTALLER 指向包含桌面身份功能的最新安装器。
 * 覆盖：全新库自动绑定 exact owner → 首屏已登录 → 退出清理 → 重启同 owner 免密进入 → 再退出。
 * 不做：真实模型/QQ 调用、系统运行库安装、注册表/快捷方式、默认安装路径。
 */

if (process.platform !== "win32" || !process.env.YILING_TEST_INSTALLER) throw new Error("Windows and YILING_TEST_INSTALLER are required");
const installer = fs.realpathSync(process.env.YILING_TEST_INSTALLER);
const parent = path.resolve(".data", "desktop-identity-package-tests");
fs.mkdirSync(parent, { recursive: true });
const root = fs.mkdtempSync(path.join(parent, "identity-"));
const programRoot = path.join(root, "program");
const stateDir = path.join(root, "state");
const dataDir = path.join(root, "data");
if (/[^\x00-\x7F]/u.test(programRoot)) throw new Error("fixture program path must be ASCII");
const windows = process.env.SystemRoot || "C:\\Windows";
const powershell = path.join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const env = {
  ...process.env,
  PATH: [path.join(windows, "System32"), path.dirname(powershell)].join(path.delimiter),
  LLM_API_KEY: "",
  LLM_MODEL: "",
  DEV_OWNER_USERNAME: "",
  DEV_OWNER_PASSWORD: "",
  YILING_WORKER_DISABLED: "1",
  YILING_ONEBOT_AUTOSTART: "0",
};
for (const key of ["DATABASE_URL", "DIRECT_URL", "YILING_DATA_DIR", "YILING_DB_RUNTIME", "YILING_PG_BIN",
  "YILING_ELECTRON_PROFILE", "YILING_SESSION_COOKIE", "ELECTRON_RUN_AS_NODE", "YILING_DESKTOP_PACKAGED"]) delete env[key];

const launcherPath = path.join(programRoot, "app", "desktop", "launch.cjs");
const bundledNode = path.join(programRoot, "runtime", "node.exe");
const activePortFile = path.join(dataDir, "electron", "DevToolsActivePort");
const ownerFile = path.join(dataDir, "desktop-owner.json");
const bindingFile = path.join(dataDir, "desktop-database.json");
const pgPidFile = path.join(dataDir, "database", "pgdata", "postmaster.pid");
const cookieName = "yiling_session_desktop";
let launcher = null;
let socket = null;
let controller = null;
let succeeded = false;

function install() {
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", path.join(installer, "install.ps1"), "-Target", programRoot, "-StateDir", stateDir, "-DataDir", dataDir,
    "-NoShortcuts", "-NoRegistry"], { env, encoding: "utf8", timeout: 240_000, windowsHide: true, maxBuffer: 1024 * 1024 });
  fs.writeFileSync(path.join(root, `install-${Date.now()}.log`), `${result.stdout}\n${result.stderr}`);
  return result;
}

async function until(condition, timeout, label) {
  const deadline = Date.now() + timeout;
  while (true) {
    const value = await condition();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(label);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

function waitExit(child, timeout = 60_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("launcher exit timeout")), timeout);
    child.once("exit", code => { clearTimeout(timer); resolve(code); });
  });
}

function readOwner() {
  return JSON.parse(fs.readFileSync(ownerFile, "utf8"));
}

function assertOwnerRecord(owner, expectedOwnerId) {
  assert.equal(owner.format, "yiling-desktop-owner");
  assert.equal(owner.version, 1);
  assert.equal(owner.status, "active");
  assert.deepEqual(Object.keys(owner).sort(), ["context", "currentSession", "format", "ownerUserId", "status", "version"]);
  assert.match(owner.ownerUserId, /^[0-9a-f-]{36}$/iu);
  if (expectedOwnerId) assert.equal(owner.ownerUserId, expectedOwnerId);
  assert.deepEqual(Object.keys(owner.context).sort(), ["databaseInstanceId", "installationId", "systemIdentifier"]);
  assert.ok(owner.currentSession, "owner file must hold a current session reference");
  assert.match(owner.currentSession.id, /^[0-9a-f-]{36}$/iu);
  assert.match(owner.currentSession.tokenHash, /^[0-9a-f]{64}$/u);
  assert.ok(Number.isFinite(Date.parse(owner.currentSession.expiresAt)));
  // 文件里不应出现明文 token：不存在 token 字段，也不存在 43 位 base64url 值。
  assert.equal(Object.prototype.hasOwnProperty.call(owner, "token"), false);
  assert.equal(JSON.stringify(owner).includes('"token":'), false, "owner file must not contain a plaintext token field");
}

async function startWindow(label) {
  const launcherLog = path.join(root, `launcher-${label}.log`);
  const previousPortMtime = fs.existsSync(activePortFile) ? fs.statSync(activePortFile).mtimeMs : -1;
  const out = fs.openSync(launcherLog, "w");
  launcher = spawn(bundledNode, [launcherPath, "--remote-debugging-port=0"], {
    cwd: programRoot, env, stdio: ["ignore", out, out], windowsHide: true,
  });
  fs.closeSync(out);
  await until(async () => {
    if (launcher.exitCode !== null) throw new Error(`launcher exited before ready (${launcher.exitCode}); see ${launcherLog}`);
    const readyUrl = /\[desktop\] runtime ready: (http:\/\/127\.0\.0\.1:\d+)/u.exec(fs.readFileSync(launcherLog, "utf8"))?.[1];
    if (!readyUrl || !fs.existsSync(activePortFile)) return false;
    if (fs.statSync(activePortFile).mtimeMs <= previousPortMtime) return false;
    const port = Number(fs.readFileSync(activePortFile, "utf8").split(/\r?\n/u)[0]);
    if (!port) return false;
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find(item => {
        try { return item.type === "page" && new URL(item.url).origin === readyUrl; } catch { return false; }
      });
      if (!page) return false;
      socket = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
      return true;
    } catch { return false; }
  }, 300_000, "installed Electron window not ready");

  let messageId = 0;
  const pending = new Map();
  socket.on("message", raw => {
    const message = JSON.parse(raw.toString());
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    clearTimeout(task.timer);
    message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++messageId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  controller = { send };
  const evaluate = async (expression, awaitPromise = false) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "renderer evaluation failed");
    return result.result?.value;
  };
  controller.evaluate = evaluate;

  const readyUrl = /\[desktop\] runtime ready: (http:\/\/127\.0\.0\.1:\d+)/u.exec(fs.readFileSync(launcherLog, "utf8"))[1];
  await until(async () => {
    const info = await evaluate("({origin: document.location.origin, ready: document.readyState})");
    return info?.origin === readyUrl && info.ready === "complete";
  }, 120_000, "application page did not finish loading at its own origin");

  const sessionInfo = await evaluate("(async()=>{const r=await fetch('/api/auth/session',{credentials:'same-origin'});return {status:r.status,body:await r.json()};})()", true);
  assert.equal(sessionInfo.status, 200, "session endpoint must answer for the injected desktop cookie");
  assert.equal(sessionInfo.body.mode, "session");
  assert.equal(sessionInfo.body.user?.role, "ADMIN");
  assert.match(sessionInfo.body.user?.id ?? "", /^[0-9a-f-]{36}$/iu);

  const cookieText = await evaluate("document.cookie");
  assert.equal(String(cookieText).includes(cookieName), false, "desktop cookie is HttpOnly and must not be readable by page JS");

  const identity = await evaluate("window.yilingDesktop.identityStatus()", true);
  assert.equal(identity.enabled, true);
  assert.equal(identity.state, "bound");
  assert.equal(Object.prototype.hasOwnProperty.call(identity, "cookieName"), false, "bridge must not expose the cookie name");

  return { evaluate, userId: sessionInfo.body.user.id, readyUrl };
}

async function quitAndVerify(label, previousOwnerId) {
  const quitResult = await controller.evaluate("void window.yilingDesktop.quit()").catch(() => undefined);
  assert.equal(quitResult, undefined);
  socket?.close(); socket = null; controller = null;
  assert.equal(await waitExit(launcher), 0, `${label}: launcher must exit cleanly through the bridge`);
  launcher = null;
  await until(() => !fs.existsSync(pgPidFile), 60_000, `${label}: managed PostgreSQL must stop`);
  const owner = await until(() => {
    const current = readOwner();
    return current.currentSession === null ? current : false;
  }, 30_000, `${label}: owner reference must be cleared`);
  assertOwnerShapeWithoutSession(owner, previousOwnerId);
  const binding = JSON.parse(fs.readFileSync(bindingFile, "utf8"));
  assert.equal(binding.phase, "ready", `${label}: database binding must stay active`);
  fs.writeFileSync(path.join(root, `owner-after-${label}.json`), JSON.stringify(owner, null, 2));
}

function assertOwnerShapeWithoutSession(owner, expectedOwnerId) {
  assert.equal(owner.format, "yiling-desktop-owner");
  assert.equal(owner.status, "active");
  assert.equal(owner.ownerUserId, expectedOwnerId);
  assert.equal(owner.currentSession, null);
}

function closeOwnLauncher() {
  if (!launcher || launcher.exitCode !== null) return;
  try {
    const identity = pgProcessIdentity(launcher.pid);
    assert(identity, "owning launcher process is gone");
    assert.equal(fs.realpathSync(identity.exe).toLowerCase(), fs.realpathSync(bundledNode).toLowerCase(), "refuse to kill a reused PID");
  } catch {
    return;
  }
  try { launcher.kill("SIGTERM"); } catch { /* already gone */ }
}

try {
  assert.equal(install().status, 0, "isolated install.ps1 must succeed without shortcuts or registry");
  assert(!fs.existsSync(dataDir), "fresh install must not precreate data");

  const first = await startWindow("first");
  const firstOwner = readOwner();
  assertOwnerRecord(firstOwner, first.userId);
  assert.equal(firstOwner.ownerUserId, first.userId, "owner bound to the exact fresh admin account");
  fs.writeFileSync(path.join(root, "owner-after-first.json"), JSON.stringify(firstOwner, null, 2));
  await quitAndVerify("first", first.userId);

  const second = await startWindow("second");
  assert.equal(second.userId, first.userId, "restart must restore the same owner account without a password");
  const secondOwner = readOwner();
  assertOwnerRecord(secondOwner, first.userId);
  assert.equal(secondOwner.ownerUserId, firstOwner.ownerUserId);
  await quitAndVerify("second", first.userId);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "installation.json"), "utf8"));
  assert.equal(state.status, "installed");
  assert.ok(state.databaseInstanceId, "installation must record the database instance");
  fs.writeFileSync(path.join(root, "evidence.json"), JSON.stringify({
    status: "passed",
    ownerUserId: first.userId,
    firstLaunch: { role: "ADMIN", bridge: "bound", cookieHttpOnly: true },
    restart: { sameOwnerWithoutPassword: true },
    postQuit: { pgStopped: true, ownerSessionCleared: true, bindingActive: true },
  }, null, 2));
  succeeded = true;
  console.log(JSON.stringify({ status: "passed", checks: ["fresh exact owner auto-bind", "real HttpOnly Secure first screen", "no page-readable desktop cookie", "bridge bound", "owner file hash-only", "clean quit stops PG and clears owner ref", "restart same owner without password", "second clean quit"], artifacts: root }));
} finally {
  if (controller) await controller.send("Browser.close").catch(() => undefined);
  socket?.close(); socket = null;
  if (launcher) {
    closeOwnLauncher();
    await waitExit(launcher, 20_000).catch(() => { launcher?.kill("SIGKILL"); });
  }
  console.log(`${succeeded ? "Retained identity evidence" : "Inspect failed identity installation"}: ${root}`);
}
