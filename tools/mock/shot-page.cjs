/**
 * 截真实运行中的页面（不是静态稿）。用本机 Chrome CDP，等客户端渲染完再截。
 * 用法：node tools/mock/shot-page.cjs --url=http://localhost:3000/xxx --out=live.png
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => fs.existsSync(p));

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const URL_ = arg("url");
const OUT = arg("out", "live.png");
const W = Number(arg("w", 1440));
const H = Number(arg("h", 900));
const PORT = Number(arg("port", 9334));
const WAIT = Number(arg("wait", 2500));
const EVAL = arg("eval", "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* 等 Chrome 起来 */ }
    await sleep(200);
  }
  throw new Error("Chrome DevTools 没起来");
}

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let seq = 0;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", (e) => reject(e));
  });
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { ws, ready, send };
}

(async () => {
  if (!CHROME) throw new Error("找不到 Chrome");
  if (!URL_) throw new Error("缺少 --url");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "live-shot-"));
  const chrome = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
    "--no-first-run", "--no-default-browser-check", "about:blank",
  ], { stdio: "ignore" });

  try {
    const cdp = connect(await waitForDevtools());
    await cdp.ready;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: URL_ });
    await sleep(WAIT);
    if (EVAL) {
      await cdp.send("Runtime.evaluate", { expression: EVAL, awaitPromise: true });
      await sleep(900);
    }
    const facts = await cdp.send("Runtime.evaluate", {
      expression: `JSON.stringify({
        title: document.title,
        h1: document.querySelector('.phead h1')?.textContent?.trim() || '',
        ident: !!document.querySelector('.ident'),
        kpis: document.querySelectorAll('.kpi').length,
        rows: document.querySelectorAll('.ev li').length,
        domains: document.querySelectorAll('.domrow').length,
        timeline: document.querySelectorAll('.tl-item').length,
        height: Math.round(document.documentElement.scrollHeight),
        overflowX: document.documentElement.scrollWidth > window.innerWidth,
        dom: Array.from(document.querySelectorAll(".domrow")).map((el) => el.textContent.replace(/\s+/g, " ").trim()),
        kpi: Array.from(document.querySelectorAll(".kpi-cell")).map((el) => el.textContent.replace(/\s+/g, " ").trim()),
        probe: (() => { const g = document.querySelector(".route-ghost"); const f = document.querySelector(".flow-glow path"); const n = document.querySelector(".planet-orb"); return { ghostOpacity: g ? getComputedStyle(g).strokeOpacity : "-", ghostWidth: g ? getComputedStyle(g).strokeWidth : "-", ghostStroke: g ? getComputedStyle(g).stroke : "-", flowOpacity: f ? getComputedStyle(f).strokeOpacity : "-", orbBorder: n ? getComputedStyle(n).borderColor : "-" }; })(),
        wrap: (() => { const r = document.querySelector(".self-page")?.getBoundingClientRect(); return r ? [Math.round(r.left), Math.round(r.width)] : null; })(),
        quoteH: Math.round(document.querySelector(".quote")?.getBoundingClientRect().height || 0),
        listH: Math.round(document.querySelector(".list")?.getBoundingClientRect().height || 0),
      })`,
      returnByValue: true,
    });
    console.log("[live] " + facts.result.value);
    const png = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const file = path.join(__dirname, "out", OUT);
    fs.writeFileSync(file, Buffer.from(png.data, "base64"));
    console.log("[shot] " + file);
    cdp.ws.close();
  } finally {
    chrome.kill();
  }
})().catch((e) => { console.error("[fail] " + e.message); process.exit(1); });
