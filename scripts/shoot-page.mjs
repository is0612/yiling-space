/**
 * 页面截图 / 探针：起一个 headless Chrome，用 CDP 打开本机页面，
 * 截前可以跑一小段 JS（开弹窗、展开折叠、点刷新），也可以按区域裁剪放大。
 * 项目里没有 puppeteer，用 Chrome 的 --remote-debugging-port + Node 22 自带的 WebSocket。
 *
 * 本机 dev 默认允许 localhost 免登录回退，所以直接开 http://127.0.0.1:3000 就是管理员视角。
 *
 * 用法：
 *   node scripts/shoot-page.mjs --url=http://127.0.0.1:3000/qq --w=1440 --h=900 --out=design/x.png
 *   node scripts/shoot-page.mjs ... --js="(async()=>{document.querySelector('.abtn').click();await new Promise(r=>setTimeout(r,800));return 1})()"
 *   node scripts/shoot-page.mjs ... --clip="344,415,530,70,2.6"     # x,y,w,h,scale（视口坐标）
 *   node scripts/shoot-page.mjs ... --probe="JSON.stringify(getComputedStyle(document.body))"
 *
 * 弹窗要等一帧再点：el-dialog 是懒渲染，点完立刻查 .el-dialog 是 0。
 * 页面刚改完时 SSR 会变慢，--nav 至少给 6000，否则点到的是还没 hydrate 的壳。
 * 想截空态：点一个计数为 0 的筛选 chip（或调一个没有数据的页），比拦接口稳 ——
 * 这份脚本试过 CDP Fetch 拦截和 patch window.fetch 两条路，在 hydrate 那一帧都不可靠。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=([\s\S]*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "true"];
  }),
);

const url = args.url || "http://127.0.0.1:3000/qq";
const width = Number(args.w || 1440);
const height = Number(args.h || 900);
const out = args.out || ".data/shots/shot.png";
const wait = Number(args.wait || 900);
const scale = Number(args.scale || 1);
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = path.join(os.tmpdir(), `cr-probe-${Date.now()}`);

const chrome = spawn(CHROME, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--no-first-run",
  "--remote-debugging-port=9333",
  `--user-data-dir=${profile}`,
  `--window-size=${width},${height}`,
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch("http://127.0.0.1:9333/json/version");
      const json = await res.json();
      if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  throw new Error("Chrome DevTools 没起来");
}

const wsUrl = await getWsUrl();
const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let seq = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
};

function send(method, params = {}, sessionId) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

// 用一个 page target
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const call = (method, params) => send(method, params, sessionId);

await call("Page.enable");
await call("Runtime.enable");
await call("Emulation.setDeviceMetricsOverride", {
  width, height, deviceScaleFactor: scale, mobile: width < 600,
});
await call("Page.navigate", { url });
await sleep(Number(args.nav || 2500));

if (args.js) {
  const r = await call("Runtime.evaluate", { expression: args.js, awaitPromise: true });
  if (r.exceptionDetails) console.error("[js error]", JSON.stringify(r.exceptionDetails).slice(0, 400));
  await sleep(wait);
}

if (args.probe) {
  const r = await call("Runtime.evaluate", { expression: args.probe, returnByValue: true, awaitPromise: true });
  console.log("[probe]", JSON.stringify(r.result?.value ?? r.exceptionDetails, null, 2));
}

const shotParams = { format: "png", captureBeyondViewport: false };
if (args.clip) {
  const [x, y, width_, height_, sc] = args.clip.split(",").map(Number);
  shotParams.clip = { x, y, width: width_, height: height_, scale: sc || 1 };
  shotParams.captureBeyondViewport = args.clipPage === "true";
}
const shot = await call("Page.captureScreenshot", shotParams);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
console.log("[shot]", out, `${width}x${height}`);

ws.close();
chrome.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(0);
