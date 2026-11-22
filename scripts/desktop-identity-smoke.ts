import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { Client } from "pg";
import WebSocket from "ws";
import { initializeDesktopDatabase, openBoundDesktopDatabase } from "./desktop-database-config.mjs";
import { loadPgCredentials } from "./desktop-pg-store.mjs";
import privateAuth from "./desktop-auth-ipc.cjs";

if (process.platform !== "win32" || !process.env.YILING_TEST_PG_BIN || !process.env.YILING_IDENTITY_BUILD) throw new Error("Windows, YILING_TEST_PG_BIN and isolated YILING_IDENTITY_BUILD required");
const build = fs.realpathSync(process.env.YILING_IDENTITY_BUILD);
const binDir = fs.realpathSync(process.env.YILING_TEST_PG_BIN);
const parent = path.resolve(".tmp", "electron", "identity-integration"); fs.mkdirSync(parent, { recursive: true });
const root = fs.mkdtempSync(path.join(parent, "auth-")), dataDir = path.join(root, "data"), profileDir = path.join(root, "profile");
fs.mkdirSync(profileDir);
const installationId = randomUUID();
const require = createRequire(import.meta.url);
const electronExe = require("../desktop/node_modules/electron") as string;
const tokens: string[] = [];
let backend: ReturnType<typeof spawn> | null = null, window: ReturnType<typeof spawn> | null = null;
let rpc: ReturnType<typeof privateAuth.createDesktopAuthPeer> | null = null, windowRpc: ReturnType<typeof privateAuth.createDesktopAuthPeer> | null = null;
let socket: WebSocket | null = null;
let sql: Client | null = null;
let succeeded = false;
const baseEnv = { ...process.env, NODE_ENV: "production", YILING_DATA_DIR: dataDir, YILING_PG_BIN: binDir,
  YILING_DB_RUNTIME: "embedded", YILING_DESKTOP_PACKAGED: "1", YILING_SESSION_COOKIE: "yiling_session_desktop", YILING_ONEBOT_AUTOSTART: "0", LLM_API_KEY: "", LLM_MODEL: "", DEV_OWNER_USERNAME: "identity-fixture", DEV_OWNER_PASSWORD: "" };
for (const key of ["YILING_FIRST_ADMIN", "DEV_OWNER_ID", "YILING_DESKTOP_PARENT_PID", "YILING_DESKTOP_PARENT_BIRTH", "YILING_DESKTOP_BACKEND_PID", "YILING_DESKTOP_BACKEND_BIRTH", "ELECTRON_RUN_AS_NODE"]) delete baseEnv[key];
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
async function until<T>(fn: () => T | Promise<T>, ms: number, message: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  while (true) { const value = await fn(); if (value) return value as NonNullable<T>; if (Date.now() > deadline) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 100)); }
}
async function exit(child: ReturnType<typeof spawn>, ms = 30_000) {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return new Promise<number | null>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Owned child did not exit")), ms); child.once("exit", code => { clearTimeout(timer); resolve(code); }); });
}
async function startBackend(label: string) {
  const log = path.join(root, `backend-${label}.log`), fd = fs.openSync(log, "w");
  backend = spawn(process.execPath, [path.join(build, "scripts", "desktop-supervisor.mjs"), "--port", "0", "--parent-stdin", "--no-worker", "--no-scheduler", "--no-qq"], {
    cwd: build, env: baseEnv, stdio: ["pipe", fd, fd, "ipc"], windowsHide: true,
  }); fs.closeSync(fd);
  rpc = privateAuth.createDesktopAuthPeer(backend, { role: "parent", timeoutMs: 30_000 });
  return until(() => {
    if (backend?.exitCode !== null) throw new Error("Isolated backend exited; inspect retained log");
    for (const line of fs.readFileSync(log, "utf8").split(/\r?\n/u).reverse()) { try { const e = JSON.parse(line); if (e.event === "ready") return e.url as string; } catch { /* line not ready */ } }
    return null;
  }, 180_000, "Isolated identity backend not ready");
}
async function fetchUser(url: string, token?: string, cookieName = "yiling_session_desktop") {
  return (await fetch(url + "/api/auth/session", { headers: token ? { cookie: `${cookieName}=${token}` } : {} })).json() as Promise<{ user: { id: string; role: string } | null; mode: string; reason?: string }>;
}
async function connectSql() {
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, "database", "runtime.json"), "utf8"));
  const secret = loadPgCredentials(path.join(dataDir, "database", "credentials.dpapi.json"), state.instanceId);
  const client = new Client({ host: "127.0.0.1", port: state.port, user: "yiling_hub", database: "yiling_hub", password: secret.password, ssl: false, connectionTimeoutMillis: 5000 });
  await client.connect(); return client;
}
async function startWindow(url: string, label: string) {
  const log = path.join(root, `window-${label}.log`), fd = fs.openSync(log, "w");
  window = spawn(electronExe, ["--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, path.join(build, "desktop")], {
    cwd: build, env: { ...baseEnv, YILING_DESKTOP_URL: url, YILING_ELECTRON_PROFILE: profileDir }, stdio: ["ignore", fd, fd, "ipc"], windowsHide: true,
  }); fs.closeSync(fd);
  windowRpc = privateAuth.createDesktopAuthPeer(window, { role: "parent", timeoutMs: 30_000, handle: async (method: string, value: unknown) => {
    if (!["status", "bind", "issue", "unbind"].includes(method)) throw new Error("desktop_identity_method_refused");
    const result = await rpc!.request(method, value);
    if (method === "issue") tokens.push(result.token);
    return result;
  } });
  const page = await until(async () => {
    if (window?.exitCode !== null) throw new Error("Identity window exited; inspect retained log");
    const portFile = path.join(profileDir, "DevToolsActivePort"); if (!fs.existsSync(portFile)) return null;
    try { const port = Number(fs.readFileSync(portFile, "utf8").split(/\r?\n/u)[0]); const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); return pages.find((p: { type: string; url: string }) => p.type === "page" && new URL(p.url).origin === url); } catch { return null; }
  }, 60_000, "Authenticated desktop page did not load");
  socket = new WebSocket(page.webSocketDebuggerUrl); await new Promise<void>((resolve, reject) => { socket!.once("open", resolve); socket!.once("error", reject); });
  let id = 0;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  socket.on("message", raw => { const m = JSON.parse(raw.toString()); const p = pending.get(m.id); if (p) { clearTimeout(p.timer); pending.delete(m.id); m.error ? p.reject(new Error("CDP command refused")) : p.resolve(m.result); } });
  const send = (method: string, params = {}) => new Promise<any>((resolve, reject) => { const seq = ++id; const timer = setTimeout(() => { pending.delete(seq); reject(new Error("CDP diagnostic timeout")); }, 10_000); pending.set(seq, { resolve, reject, timer }); socket!.send(JSON.stringify({ id: seq, method, params })); });
  const evaluate = async (expression: string) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      fs.writeFileSync(path.join(root, `renderer-${label}-error.json`), JSON.stringify({ text: result.exceptionDetails.text,
        description: String(result.exceptionDetails.exception?.description || "").slice(0, 1000) }));
      throw new Error("Isolated renderer evaluation failed");
    }
    return result.result.value;
  };
  await until(async () => { try { return await evaluate(`location.origin===${JSON.stringify(url)} && document.readyState==='complete'`); } catch { return false; } }, 30_000, "Desktop navigation did not commit before session verification");
  return { send, evaluate };
}
async function stopWindow(controller: Awaited<ReturnType<typeof startWindow>>) {
  await controller.send("Browser.close").catch(() => {}); socket?.close(); socket = null;
  assert.equal(await exit(window!), 0); windowRpc?.dispose(); windowRpc = null; window = null;
}
async function stopBackend() {
  if (!backend) return;
  backend.stdin?.write(JSON.stringify({ command: "shutdown" }) + "\n"); backend.stdin?.end();
  assert.equal(await exit(backend), 0); rpc?.dispose(); rpc = null; backend = null;
}
try {
  const initialized = await initializeDesktopDatabase({ dataDir, binDir, installationId }); await initialized.close();
  const url = await startBackend("fresh");
  assert.equal((await rpc!.request("status")).state, "bound", "fresh-created exact owner should bind automatically");
  assert.equal((await fetchUser(url)).user, null, "normal local HTTP clients must remain anonymous");
  assert.equal((await fetchUser(url, "A".repeat(43))).reason, "invalid_session");
  const manual = await rpc!.request("issue"); tokens.push(manual.token);
  const owner = JSON.parse(fs.readFileSync(path.join(dataDir, "desktop-owner.json"), "utf8"));
  assert.equal((await fetchUser(url, manual.token)).user?.id, owner.ownerUserId);
  const passwordText = fs.readFileSync(path.join(dataDir, "first-run-admin.txt"), "utf8");
  const password = /^password=(.+)$/mu.exec(passwordText)?.[1]; assert(password);
  const login = await fetch(url + "/api/auth/login", { method: "POST", headers: { origin: url, "content-type": "application/json", "user-agent": "synthetic independent web client" }, body: JSON.stringify({ username: "identity-fixture", password }) });
  assert.equal(login.status, 200);
  const webToken = /yiling_session_desktop=([^;]+)/u.exec(login.headers.get("set-cookie") || "")?.[1]; assert(webToken);
  assert.equal((await fetchUser(url, webToken)).user?.id, owner.ownerUserId);
  const ui = await startWindow(url, "fresh");
  const authenticated = await ui.evaluate("fetch('/api/auth/session').then(r=>r.json()).then(s=>({id:s.user?.id,role:s.user?.role}))");
  assert.equal(authenticated.id, owner.ownerUserId); assert.equal(authenticated.role, "ADMIN");
  assert.equal((await ui.evaluate("document.cookie")).includes("yiling_session_desktop"), false, "HttpOnly cookie cannot enter renderer JS");
  assert.equal((await ui.evaluate("window.yilingDesktop.identityStatus()")).state, "bound");
  await ui.send("Network.clearBrowserCookies");
  assert.equal((await ui.evaluate("fetch('/api/auth/session').then(r=>r.json()).then(s=>s.user)")), null);
  assert.deepEqual(await ui.evaluate("window.yilingDesktop.reconnectIdentity()"), { ok: true });
  assert.equal((await ui.evaluate("fetch('/api/auth/session').then(r=>r.json()).then(s=>s.user.id)")), owner.ownerUserId);
  sql = await connectSql();
  await sql.query('UPDATE "users" SET "status"=\'DISABLED\' WHERE id=$1::uuid', [owner.ownerUserId]);
  assert.equal((await rpc!.request("status")).state, "blocked");
  await assert.rejects(() => rpc!.request("issue"), /owner_unavailable/u);
  assert.equal((await fetchUser(url, tokens.at(-1))).user, null);
  await rpc!.request("unbind"); assert.equal((await rpc!.request("status")).state, "revoked");
  await assert.rejects(() => rpc!.request("issue"), /not_bound/u);
  await sql.query('UPDATE "users" SET "status"=\'ACTIVE\' WHERE id=$1::uuid', [owner.ownerUserId]);
  assert.equal((await fetchUser(url, webToken)).user?.id, owner.ownerUserId, "desktop unbind must not revoke independent web login");
  await assert.rejects(() => rpc!.request("bind", { token: "B".repeat(43) }), /session_invalid/u);
  await rpc!.request("bind", { token: webToken });
  await ui.evaluate("window.yilingDesktop.reconnectIdentity()");
  await sql.end(); sql = null;
  await stopWindow(ui); await stopBackend();
  const stopped = await openBoundDesktopDatabase({ dataDir, binDir });
  try { const check = await stopped.connect(); try {
    assert.equal((await check.query('SELECT "revokedAt" FROM sessions WHERE "tokenHash"=$1', [hash(webToken)])).rows[0].revokedAt, null);
    for (const token of tokens) assert((await check.query('SELECT "revokedAt" FROM sessions WHERE "tokenHash"=$1', [hash(token)])).rows[0].revokedAt);
  } finally { await check.end(); } } finally { await stopped.close(); }
  const restartUrl = await startBackend("restart");
  assert.equal((await rpc!.request("status")).state, "bound");
  const restarted = await startWindow(restartUrl, "restart");
  assert.equal((await restarted.evaluate("fetch('/api/auth/session').then(r=>r.json()).then(s=>s.user.id)")), owner.ownerUserId);
  await stopWindow(restarted); await stopBackend();
  fs.renameSync(path.join(dataDir, "desktop-owner.json"), path.join(dataDir, "desktop-owner.saved-test.json"));
  const existingUrl = await startBackend("existing-unbound");
  assert.equal((await rpc!.request("status")).state, "unbound", "a pre-existing single-account database must not be guessed/reclaimed");
  await assert.rejects(() => rpc!.request("issue"), /not_bound/u);
  assert.equal((await fetchUser(existingUrl)).user, null); await stopBackend();
  const logs = fs.readdirSync(root).filter(name => name.endsWith(".log")).map(name => fs.readFileSync(path.join(root, name), "utf8")).join("\n") + fs.readFileSync(path.join(dataDir, "logs", "desktop-supervisor.log"), "utf8");
  for (const token of tokens) assert(!logs.includes(token), "session credentials must not appear in ordinary logs");
  assert(!logs.includes(webToken));
  const record = fs.readFileSync(path.join(dataDir, "desktop-owner.saved-test.json"), "utf8"); for (const token of tokens) assert(!record.includes(token));
  succeeded = true;
  console.log(JSON.stringify({ status: "passed", checks: ["real PG migrations and exact fresh owner", "private IPC session issuance", "real Electron HttpOnly Secure cookie and first-page auth", "cookie-clear reconnect", "disabled/unbound refusal", "web session isolation", "restart same owner", "pre-existing single-user no-guess", "no credential logs/files"], artifacts: root }));
} finally {
  socket?.close(); windowRpc?.dispose();
  if (window && window.exitCode === null) { window.kill("SIGTERM"); await exit(window).catch(() => window?.kill("SIGKILL")); }
  await sql?.end().catch(() => {});
  if (backend && backend.exitCode === null) { backend.stdin?.end(); await exit(backend).catch(() => backend?.kill("SIGKILL")); }
  rpc?.dispose();
  console.log(`${succeeded ? "Retained isolated identity evidence" : "Inspect isolated identity failure"}: ${root}`);
}
