import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { pgProcessIdentity } from "./desktop-pg-tools.mjs";

if (process.platform !== "win32" || !process.env.YILING_TEST_INSTALLER) throw new Error("Windows and YILING_TEST_INSTALLER are required");
const installer = fs.realpathSync(process.env.YILING_TEST_INSTALLER);
const parent = path.resolve(".data", "desktop-package-tests"); fs.mkdirSync(parent, { recursive: true });
const root = fs.mkdtempSync(path.join(parent, "installation-"));
const programRoot = path.join(root, "program");
const stateDir = path.join(root, "安装状态");
const dataDir = path.join(root, "私人数据");
const windows = process.env.SystemRoot || "C:\\Windows";
const powershell = path.join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const env = { ...process.env, PATH: [path.join(windows, "System32"), path.dirname(powershell)].join(path.delimiter),
  LLM_API_KEY: "", LLM_MODEL: "", DEV_OWNER_PASSWORD: "", DEV_OWNER_USERNAME: "admin", YILING_WORKER_DISABLED: "0", YILING_ONEBOT_AUTOSTART: "0" };
for (const key of ["DATABASE_URL", "DIRECT_URL", "YILING_DATA_DIR", "YILING_DB_RUNTIME", "YILING_PG_BIN", "YILING_ELECTRON_PROFILE", "ELECTRON_RUN_AS_NODE"]) delete env[key];
const sourceMetadataFile = path.join(installer, "payload", "desktop-package.json");
const sourceMetadata = fs.readFileSync(sourceMetadataFile, "utf8");
let launcher = null, debugSocket = null, activeController = null;
let succeeded = false;
const readState = () => JSON.parse(fs.readFileSync(path.join(stateDir, "installation.json"), "utf8"));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const windowPid = () => JSON.parse(fs.readFileSync(path.join(dataDir, "electron", "instance.json"), "utf8")).pid;
function latestBackendEvents() {
  return fs.readFileSync(path.join(dataDir, "logs", "desktop-supervisor.log"), "utf8").split(/\r?\n/u).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}
function install() {
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(installer, "install.ps1"),
    "-Target", programRoot, "-StateDir", stateDir, "-DataDir", dataDir, "-NoShortcuts", "-NoRegistry"], {
    env, encoding: "utf8", timeout: 180_000, windowsHide: true, maxBuffer: 1024 * 1024 });
  fs.writeFileSync(path.join(root, `install-${Date.now()}.log`), result.stdout + "\n" + result.stderr);
  return result;
}
function uninstall() {
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(programRoot, "uninstall.ps1"),
    "-Yes", "-NoShortcuts", "-NoRegistry"], { env, encoding: "utf8", timeout: 120_000, windowsHide: true, maxBuffer: 1024 * 1024 });
  fs.writeFileSync(path.join(root, `uninstall-${Date.now()}.log`), result.stdout + "\n" + result.stderr);
  return result;
}
async function until(condition, timeout, message) {
  const deadline = Date.now() + timeout;
  while (true) {
    const result = await condition();
    if (result) return result;
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
function exit(child, timeout = 40_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Packaged launcher exit timeout")), timeout);
    child.once("exit", code => { clearTimeout(timer); resolve(code); });
  });
}
async function startWindow(label) {
  const launcherLog = path.join(root, `launcher-${label}.log`);
  const file = fs.openSync(launcherLog, "w");
  launcher = spawn(path.join(programRoot, "runtime", "node.exe"), [path.join(programRoot, "app", "desktop", "launch.cjs"), "--remote-debugging-port=0"], {
    cwd: programRoot, env, stdio: ["ignore", file, file], windowsHide: true,
  });
  fs.closeSync(file);
  const activePort = path.join(dataDir, "electron", "DevToolsActivePort");
  await until(async () => {
    if (launcher.exitCode !== null) throw new Error("Packaged launcher exited before a window; inspect retained launcher log");
    const ownUrl = /\[desktop\] runtime ready: (http:\/\/127\.0\.0\.1:\d+)/u.exec(fs.readFileSync(launcherLog, "utf8"))?.[1];
    if (!ownUrl || !fs.existsSync(activePort)) return false;
    const port = Number(fs.readFileSync(activePort, "utf8").split(/\r?\n/u)[0]);
    if (!port) return false;
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find(page => { try { return page.type === "page" && new URL(page.url).origin === ownUrl; } catch { return false; } });
      if (!page) return false;
      const socket = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
      debugSocket = socket; return true;
    } catch { return false; }
  }, 240_000, "Installed Electron window not ready");
  let id = 0;
  const pending = new Map();
  debugSocket.on("message", raw => {
    const message = JSON.parse(raw.toString()); const task = pending.get(message.id);
    if (task) { pending.delete(message.id); clearTimeout(task.timer); message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error("CDP operation timeout: " + method)); }, 5000);
    pending.set(key, { resolve, reject, timer }); debugSocket.send(JSON.stringify({ id: key, method, params }));
  });
  activeController = { send };
  const body = await until(async () => {
    const result = await send("Runtime.evaluate", { expression: "document.body.innerText", returnByValue: true });
    return result.result?.value?.includes("登录") ? result.result.value : false;
  }, 20_000, "Expected the existing login page (auto-login is not implemented)");
  assert(body.includes("登录"));
  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(root, `window-${label}.png`), Buffer.from(shot.data, "base64"));
  activeController = { send };
  return activeController;
}
async function closeWindow(controller) {
  await controller.send("Browser.close").catch(() => {});
  debugSocket?.close(); debugSocket = null; activeController = null;
  assert.equal(await exit(launcher), 0); launcher = null;
  assert(!fs.existsSync(path.join(dataDir, "database", "pgdata", "postmaster.pid")));
}
async function probeDatabase(write) {
  const maintenance = path.join(root, "probe-database.mjs");
  const moduleUrl = pathToFileURL(path.join(programRoot, "app", "scripts", "desktop-database-config.mjs")).href;
  fs.writeFileSync(maintenance, `import assert from 'node:assert/strict';import {openBoundDesktopDatabase} from ${JSON.stringify(moduleUrl)};
const r=await openBoundDesktopDatabase({dataDir:${JSON.stringify(dataDir)},binDir:${JSON.stringify(path.join(programRoot, "runtime", "pgsql", "bin"))}});
try{const c=await r.connect();try{${write ? "await c.query(\"CREATE TABLE installation_probe(id integer PRIMARY KEY, body text NOT NULL)\");await c.query(\"INSERT INTO installation_probe VALUES (1,'synthetic installation checkpoint')\");" : "assert.equal((await c.query('SELECT body FROM installation_probe')).rows[0].body,'synthetic installation checkpoint');"}}finally{await c.end();}}finally{await r.close();}\n`);
  const result = spawnSync(path.join(programRoot, "runtime", "node.exe"), [maintenance], { cwd: programRoot, env, encoding: "utf8", timeout: 30_000 });
  fs.writeFileSync(path.join(root, `probe-${Date.now()}.log`), result.stdout + "\n" + result.stderr);
  assert.equal(result.status, 0, "bundled Node must reopen the same real database after upgrade/reinstall");
}
try {
  assert.equal(install().status, 0, "isolated install.ps1 should succeed without registry or shortcut changes");
  assert(!fs.existsSync(dataDir), "installer itself must not precreate or replace a database");
  assert.equal(readState().databaseInstanceId, null);
  const first = await startWindow("first");
  const firstState = readState(); assert(firstState.databaseInstanceId);
  assert.equal(install().status === 0, false, "upgrading a running application must be refused");
  assert.notEqual(uninstall().status, 0, "uninstalling a running application must be refused");
  const activated = spawn(path.join(programRoot, "runtime", "node.exe"), [path.join(programRoot, "app", "desktop", "launch.cjs")], { cwd: programRoot, env, stdio: "ignore", windowsHide: true });
  assert.equal(await exit(activated, 20_000), 0, "second click should activate the existing window without another supervisor");
  await closeWindow(first);
  await probeDatabase(true);
  await startWindow("launcher-crash");
  const attached = latestBackendEvents().filter(event => event.event === "launcher-watch-attached").at(-1);
  assert(attached, "backend must confirm its parent process handle is attached before fault injection");
  const launcherPid = launcher.pid;
  assert.equal(attached.watchedPid, launcherPid, "watch must target the actual spawned launcher");
  assert.equal(attached.parentPid, launcherPid, "supervisor OS parent must be the same launcher");
  const beforeKill = pgProcessIdentity(launcherPid);
  assert(beforeKill && fs.realpathSync(beforeKill.exe).toLowerCase() === fs.realpathSync(path.join(programRoot, "runtime", "node.exe")).toLowerCase());
  const orphanWindow = windowPid();
  const killResult = launcher.kill("SIGKILL"); await exit(launcher);
  fs.writeFileSync(path.join(root, "launcher-kill-evidence.json"), JSON.stringify({ launcherPid, attached, beforeKill, killResult,
    exitCode: launcher.exitCode, signalCode: launcher.signalCode, afterKill: pgProcessIdentity(launcherPid) }, null, 2));
  launcher = null;
  debugSocket?.close(); debugSocket = null; activeController = null;
  await until(() => !alive(orphanWindow) && !fs.existsSync(path.join(dataDir, "database", "pgdata", "postmaster.pid")), 40_000,
    "launcher crash must disconnect its window and stop its managed backend/database");
  await probeDatabase(false);
  await startWindow("backend-crash");
  const crashedWindow = windowPid();
  const events = latestBackendEvents();
  const ready = events.filter(event => event.event === "ready").at(-1);
  const ownedConsumers = ["web-started", "scheduler-started", "worker-started"].map(name => events.filter(event => event.event === name).at(-1)?.pid).filter(Boolean);
  assert.equal(ownedConsumers.length, 3, "all managed consumers need an observable identity");
  const backend = pgProcessIdentity(ready.pid);
  assert.equal(fs.realpathSync(backend.exe).toLowerCase(), fs.realpathSync(path.join(programRoot, "runtime", "node.exe")).toLowerCase());
  assert(Math.abs(Date.parse(ready.at) - Date.parse(backend.createdAt)) < 300_000);
  process.kill(ready.pid, "SIGKILL");
  assert.notEqual(await exit(launcher), 0); launcher = null;
  debugSocket?.close(); debugSocket = null; activeController = null;
  await until(() => !alive(crashedWindow) && ownedConsumers.every(pid => !alive(pid))
    && !fs.existsSync(path.join(dataDir, "database", "pgdata", "postmaster.pid")), 40_000,
    "backend crash must close its window/consumers and let the owning launcher recover its own PG");
  await probeDatabase(false);
  fs.writeFileSync(path.join(dataDir, "keep-private-data.txt"), "synthetic retained file");
  const update = JSON.parse(sourceMetadata); update.packageId = randomUUID(); update.appVersion += "-installation-smoke";
  fs.writeFileSync(sourceMetadataFile, JSON.stringify(update, null, 2));
  assert.equal(install().status, 0, "upgrade should preserve the registered data directory");
  assert.equal(readState().databaseInstanceId, firstState.databaseInstanceId);
  await probeDatabase(false);
  const second = await startWindow("upgraded"); await closeWindow(second);
  assert.equal(uninstall().status, 0, "actual uninstall wrapper must work from a private temporary Node copy");
  assert(!fs.existsSync(programRoot)); assert(fs.existsSync(path.join(dataDir, "keep-private-data.txt")));
  assert.equal(readState().status, "uninstalled");
  assert.equal(install().status, 0, "reinstall should reuse its retained installation state, not an unknown database");
  assert.equal(readState().databaseInstanceId, firstState.databaseInstanceId);
  await probeDatabase(false);
  assert.equal(uninstall().status, 0);
  assert.equal(fs.readFileSync(path.join(dataDir, "keep-private-data.txt"), "utf8"), "synthetic retained file");
  succeeded = true;
  console.log(JSON.stringify({ status: "passed", checks: ["bundled-only PATH", "real Electron login page", "PG first init and migrations", "single instance activation", "launcher/backend crash cleanup", "live update/uninstall refusal", "upgrade preserves database", "uninstall preserves data", "reinstall same database"], artifacts: root }));
} finally {
  fs.writeFileSync(sourceMetadataFile, sourceMetadata);
  if (activeController) await activeController.send("Browser.close").catch(() => {});
  debugSocket?.close();
  if (launcher && launcher.exitCode === null) {
    launcher.kill("SIGINT");
    await exit(launcher).catch(() => { launcher.kill("SIGKILL"); });
  }
  if (succeeded) {
    const state = readState();
    assert.equal(state.status, "uninstalled");
    assert(!fs.existsSync(path.join(dataDir, "database", "pgdata", "postmaster.pid")));
    // Only synthetic test program snapshots are discarded to avoid exhausting the system
    // drive. Real installer behavior still retains rollback snapshots; private test data stays.
    for (const name of fs.readdirSync(root)) {
      if (!/^program\.(?:previous|uninstalled)-[a-f0-9-]{36}$/u.test(name)) continue;
      const folder = path.join(root, name);
      assert(!fs.lstatSync(folder).isSymbolicLink());
      assert.equal(path.dirname(fs.realpathSync(folder)), fs.realpathSync(root));
      const marker = JSON.parse(fs.readFileSync(path.join(folder, "desktop-install.json"), "utf8"));
      assert.equal(marker.installationId, state.installationId);
      assert(!fs.existsSync(path.join(folder, "app", ".data")));
      fs.rmSync(folder, { recursive: true });
    }
  }
  // Preserve private test data, logs and screenshots; never remove an unconfirmed instance.
  console.log(`${succeeded ? "Retained test evidence" : "Inspect failed isolated installation"}: ${root}`);
}
