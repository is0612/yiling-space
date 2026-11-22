/** Ordinary bundled Node owns the installed lifecycle; Electron only owns the window. */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
const ROOT = path.resolve(__dirname, "..");
const { windowsProcessBirth } = require(path.join(ROOT, "scripts", "desktop-parent-watch.cjs"));
const { createDesktopAuthPeer } = require(path.join(ROOT, "scripts", "desktop-auth-ipc.cjs"));
const passthrough = process.argv.slice(2).filter(arg => arg !== "--no-sandbox");
const forceNoSandbox = process.argv.includes("--no-sandbox");
let env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of ["YILING_DESKTOP_PARENT_PID", "YILING_DESKTOP_PARENT_BIRTH", "YILING_DESKTOP_BACKEND_PID", "YILING_DESKTOP_BACKEND_BIRTH"]) delete env[key];
let dataDir, profileDir = "", prepared, supervisor, windowProcess, backendIdentity;
let stopping = false;
let electronPath;
try { electronPath = require("electron"); }
catch { console.error("Electron runtime missing; source users run yarn desktop:install, installed users repair the package."); process.exit(1); }
function writable(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true });
    const probe = path.join(directory, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, "ok", { flag: "wx" }); fs.unlinkSync(probe); return true;
  } catch { return false; }
}
function configureProfile(packaged, preferred) {
  const supplied = passthrough.find(arg => arg.startsWith("--user-data-dir="));
  if (packaged && passthrough.some(arg => arg.startsWith("--user-data-dir"))) throw new Error("Installed builds use their bound private Electron profile; external profile overrides are refused.");
  if (supplied) { profileDir = supplied.slice("--user-data-dir=".length); return; }
  const separate = passthrough.indexOf("--user-data-dir");
  if (separate >= 0) {
    const directory = passthrough[separate + 1];
    if (!directory || directory.startsWith("--")) throw new Error("Missing --user-data-dir value");
    profileDir = path.resolve(directory); return;
  }
  const candidates = packaged ? [preferred] : [path.join(ROOT, ".tmp", "electron"), path.join(dataDir, "electron"), path.join(os.tmpdir(), "yiling-space-electron")];
  profileDir = candidates.find(writable) || "";
  if (!profileDir) throw new Error("No writable private Electron profile");
  env.YILING_ELECTRON_PROFILE = profileDir;
  passthrough.push(`--user-data-dir=${profileDir}`);
}
function instanceAlive() {
  if (!profileDir) return false;
  try {
    const info = JSON.parse(fs.readFileSync(path.join(profileDir, "instance.json"), "utf8"));
    if (!Number.isInteger(info.pid) || !Number.isFinite(info.at)) return false;
    process.kill(info.pid, 0); return true;
  } catch { return false; }
}
function stopSupervisor(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve(child?.exitCode ?? 0);
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } resolve(1); }, 30_000);
    child.once("exit", code => { clearTimeout(timer); resolve(code ?? 1); });
    try { child.stdin.write(JSON.stringify({ command: "shutdown" }) + "\n"); child.stdin.end(); } catch { /* wait for exit */ }
  });
}
function startSupervisor() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "scripts", "desktop-supervisor.mjs"), "--port", "0", "--parent-stdin"], {
      cwd: ROOT, env: { ...env, YILING_DATA_DIR: dataDir,
        ...(prepared?.packaged && process.platform === "win32" ? { YILING_DESKTOP_PARENT_PID: String(process.pid), YILING_DESKTOP_PARENT_BIRTH: windowsProcessBirth(process.pid) } : {}) },
      stdio: prepared?.packaged ? ["pipe", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe"], windowsHide: true, detached: Boolean(prepared?.packaged && process.platform === "win32"),
    });
    supervisor = child; // Keep ownership before ready, including migration/startup failure.
    if (prepared?.packaged) backendIdentity = createDesktopAuthPeer(child, { role: "parent", timeoutMs: 30_000 });
    let settled = false, buffer = "";
    const finish = (error, url) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(url);
    };
    const timer = setTimeout(() => finish(new Error("Desktop runtime did not become ready within five minutes; logs are retained.")), 300_000);
    child.once("error", error => finish(error));
    child.once("exit", code => {
      if (!settled) finish(new Error(`Desktop runtime exited before ready (${code ?? "unknown"}).`));
      else if (!stopping) {
        console.error(`[desktop] backend exited after ready (${code ?? "unknown"}); closing its window.`);
        void close(1);
      }
    });
    child.stdout.on("data", chunk => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.event === "ready" && event.url) finish(null, event.url);
          else if (event.event === "fatal") finish(new Error(event.message || "Desktop runtime failed"));
          else if (["starting", "desktop-pg-migrations", "web-ready"].includes(event.event)) console.log(`[runtime] ${line}`);
        } catch { /* other child output is already in supervisor logs */ }
      }
    });
    child.stderr.on("data", chunk => { const text = chunk.toString("utf8").trim(); if (text) console.error(`[runtime] ${text}`); });
  });
}
function runElectron(url, noSandbox) {
  return new Promise(resolve => {
    const child = spawn(electronPath, [...(noSandbox ? ["--no-sandbox"] : []), ...passthrough, __dirname], {
      env: { ...env, YILING_DESKTOP_URL: url,
        ...(prepared?.packaged && url && supervisor && process.platform === "win32" ? { YILING_DESKTOP_BACKEND_PID: String(supervisor.pid), YILING_DESKTOP_BACKEND_BIRTH: windowsProcessBirth(supervisor.pid) } : {}) },
      stdio: prepared?.packaged ? ["inherit", "inherit", "inherit", "ipc"] : "inherit", windowsHide: false,
      detached: Boolean(prepared?.packaged && process.platform === "win32"),
    });
    windowProcess = child;
    const identity = prepared?.packaged && url && backendIdentity ? createDesktopAuthPeer(child, { role: "parent", handle: async (method, value) => {
      if (!["status", "bind", "issue", "unbind"].includes(method)) throw new Error("desktop_identity_method_refused");
      return backendIdentity.request(method, value);
    } }) : null;
    child.once("error", error => { identity?.dispose(); console.error(error.message); resolve(1); });
    child.once("exit", code => { identity?.dispose(); if (windowProcess === child) windowProcess = null; resolve(code ?? 1); });
  });
}
async function runWindow(url) {
  let code = await runElectron(url, forceNoSandbox);
  if (!forceNoSandbox && (code === 2147483651 || code === 3)) {
    console.warn("Chromium sandbox could not start; retrying once without its sandbox.");
    code = await runElectron(url, true);
  }
  return code;
}
async function close(code) {
  if (stopping) return;
  stopping = true;
  const window = windowProcess;
  if (window && window.exitCode === null && window.signalCode === null) {
    await new Promise(resolve => {
      const timer = setTimeout(() => { try { window.kill("SIGKILL"); } catch { /* already gone */ } resolve(); }, 10_000);
      window.once("exit", () => { clearTimeout(timer); resolve(); });
      try { if (window.connected) window.send({ command: "desktop-shutdown" }); else window.kill("SIGTERM"); } catch { /* bounded fallback */ }
    });
  }
  const stopped = await stopSupervisor(supervisor);
  if (stopped && prepared?.packaged) {
    try { await prepared.recoverDatabaseAfterExit(); }
    catch { console.error("[desktop] backend cleanup could not be confirmed; bound data and diagnostics are retained."); }
  }
  backendIdentity?.dispose();
  await prepared?.release();
  process.exit(code || stopped || 0);
}
process.once("SIGINT", () => void close(0));
process.once("SIGTERM", () => void close(0));
(async () => {
  try {
    const state = await import(pathToFileURL(path.join(ROOT, "scripts", "desktop-package-state.mjs")).href);
    try { prepared = await state.preparePackagedDesktop({ applicationRoot: ROOT, env }); }
    catch (error) {
      if (error.code !== "DESKTOP_PG_LOCK_BUSY") throw error;
      // Read only enough to activate an existing window. Never start a supervisor on busy.
      const existing = state.peekPackagedDesktop(ROOT);
      dataDir = existing.dataDir; env.YILING_DATA_DIR = dataDir;
      configureProfile(true, existing.profileDir);
      if (!instanceAlive()) throw error;
      process.exit(await runWindow(""));
    }
    env = prepared.env;
    dataDir = path.resolve(env.YILING_DATA_DIR?.trim() || path.join(ROOT, ".data"));
    configureProfile(prepared.packaged, prepared.profileDir);
    if (instanceAlive()) {
      if (prepared.packaged) throw new Error("A desktop window remains without its owning launcher; close that window and retry. Data will not be reset.");
      await prepared.release(); prepared = null; process.exit(await runWindow(""));
    }
    const url = await startSupervisor();
    console.log(`[desktop] runtime ready: ${url}`);
    const code = await runWindow(url);
    await close(code);
  } catch (error) {
    console.error(`[desktop] ${error.message}`);
    await close(1);
  }
})();
