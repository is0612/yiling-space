// Real Nuxt dev + Electron verification with an isolated minimal Nuxt fixture.
// This verifies the managed web plan/CSP/HMR, not application auth or business pages.
// No real database, Worker/Scheduler/QQ or model calls.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import WebSocket from "ws";
import runtime from "./desktop-web-runtime.cjs";
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const name = `desktop-hmr-smoke-${randomUUID()}`;
const artifacts = path.join(root, ".tmp", "electron", name);
const routeFile = path.join(artifacts, "app", "pages", "index.vue");
fs.mkdirSync(path.dirname(routeFile), { recursive: true });
fs.writeFileSync(path.join(artifacts, "nuxt.config.ts"), 'export default defineNuxtConfig({ devtools: { enabled: false } })\n');
const server = net.createServer();
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const url = `http://127.0.0.1:${port}`;
const plan = runtime.desktopWebPlan({ root, port, dataDir: path.join(artifacts, "data"),
  env: { ...process.env, YILING_LOCAL_API_ENABLED: "false", YILING_ALLOW_DEV_OWNER_BYPASS: "false" }, mode: "development" });
const log = fs.openSync(path.join(artifacts, "runtime.log"), "w");
let dev, electron, socket;
const pending = new Map(); let sequence = 0;
async function until(test, ms, message) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const result = await test(); if (result) return result; await new Promise(r => setTimeout(r, 250)); }
  throw new Error(message);
}
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, value => { clearTimeout(timer); value.error ? reject(new Error(value.error.message)) : resolve(value.result); });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) { return (await cdp("Runtime.evaluate", { expression, returnByValue: true })).result.value; }
try {
  fs.writeFileSync(routeFile, '<template><main id="hmr-proof">desktop-hmr-before</main></template>\n<script setup>definePageMeta({ layout: false })</script>\n', { flag: "wx" });
  dev = spawn(process.execPath, ["--import", new URL("./memory-worker-parent.mjs", import.meta.url).href, ...plan.args, "--cwd", artifacts], {
    cwd: root, env: plan.env, stdio: ["ignore", log, log, "ipc"], windowsHide: true,
  });
  await until(async () => { if (dev.exitCode !== null) throw new Error(`Nuxt exited ${dev.exitCode}`); try { return (await fetch(`${url}/`, { signal: AbortSignal.timeout(5000) })).ok; } catch { return false; } }, 180000, "Nuxt dev page timeout");
  const electronEnv = { ...process.env, YILING_DESKTOP_URL: url, YILING_DATA_DIR: path.join(artifacts, "data"), YILING_ELECTRON_PROFILE: path.join(artifacts, "profile") };
  delete electronEnv.ELECTRON_RUN_AS_NODE; delete electronEnv.YILING_DESKTOP_PACKAGED;
  electron = spawn(require("../desktop/node_modules/electron"), [...(process.argv.includes("--no-sandbox") ? ["--no-sandbox"] : []), "--remote-debugging-port=0", path.join(root, "desktop")], {
    cwd: root, env: electronEnv, stdio: ["ignore", log, log], windowsHide: true,
  });
  const page = await until(async () => {
    if (electron.exitCode !== null) throw new Error(`Electron exited ${electron.exitCode}`);
    const file = path.join(artifacts, "profile", "DevToolsActivePort");
    if (!fs.existsSync(file)) return false;
    try { const debugPort = Number(fs.readFileSync(file, "utf8").split(/\r?\n/)[0]); return (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(p => p.type === "page" && p.url.startsWith(url)); } catch { return false; }
  }, 30000, "Electron debugging page timeout");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  socket.on("message", raw => { const value = JSON.parse(String(raw)); if (value.id) { pending.get(value.id)?.(value); pending.delete(value.id); } });
  await cdp("Page.navigate", { url: `${url}/` });
  await until(() => evaluate('document.querySelector("#hmr-proof")?.textContent === "desktop-hmr-before"'), 30000, "Initial dev text missing");
  // Wait for hydration and the actual Vite connection before editing the template.
  await until(() => evaluate('Boolean(document.querySelector("#__nuxt")?.__vue_app__)'), 30000, "Nuxt hydration timeout");
  await evaluate('window.__desktopHmrProof = "same-document"');
  fs.writeFileSync(routeFile, '<template><main id="hmr-proof">desktop-hmr-after</main></template>\n<script setup>definePageMeta({ layout: false })</script>\n');
  await until(() => evaluate('document.querySelector("#hmr-proof")?.textContent === "desktop-hmr-after"'), 30000, "Vue hot update timeout");
  assert.equal(await evaluate('window.__desktopHmrProof'), "same-document", "template change must hot update without reloading document");
  // Browser.close can close the debugging socket before its response arrives.
  socket.send(JSON.stringify({ id: ++sequence, method: "Browser.close" }));
  await until(() => electron.exitCode !== null, 15000, "Electron shutdown timeout");
  assert.equal(electron.exitCode, 0);
  dev.disconnect();
  await until(() => dev.exitCode !== null, 10000, "Managed Nuxt disconnect shutdown timeout");
  await assert.rejects(() => fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) }));
  console.log(JSON.stringify({ status: "passed", checks: ["real Nuxt dev with isolated fixture (no business pages)", "real Electron with existing CSP", "Vue template HMR without document reload", "Electron exit", "managed Nuxt disconnect stops HTTP"], artifacts }));
} finally {
  socket?.close();
  if (electron?.exitCode === null) electron.kill();
  if (dev?.exitCode === null) { if (dev.connected) dev.disconnect(); else dev.kill(); }
  fs.closeSync(log);
  // Only our uniquely named route, created with wx above, is removed.
  if (fs.existsSync(routeFile)) fs.unlinkSync(routeFile);
}
