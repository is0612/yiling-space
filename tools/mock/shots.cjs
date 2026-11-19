/**
 * 静态稿出图：用本机 Chrome 的 CDP 接口，按 [data-shot] 逐个截 1440×900。
 * 不依赖项目依赖（这台机器上没有 electron），只用 node 内置 fetch / WebSocket。
 *
 * 用法：node tools/mock/shots.js --src=self-understanding.html
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

const SRC = arg("src", "self-understanding.html");
const W = Number(arg("w", 1440));
const H = Number(arg("h", 900));
const PORT = Number(arg("port", 9333));
const OUT = path.join(__dirname, "out");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  throw new Error("Chrome DevTools 端口没起来");
}

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  const events = [];
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
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push(msg.method);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, ready, send, events };
}

async function main() {
  if (!CHROME) throw new Error("找不到 Chrome / Edge 可执行文件");
  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mock-shot-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--no-first-run",
      "--no-default-browser-check",
      "--allow-file-access-from-files",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  try {
    const wsUrl = await waitForDevtools();
    const cdp = connect(wsUrl);
    await cdp.ready;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: W,
      height: H,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const fileUrl = `file:///${path.join(__dirname, SRC).replace(/\\/g, "/")}`;
    await cdp.send("Page.navigate", { url: fileUrl });
    for (let i = 0; i < 80 && !cdp.events.includes("Page.loadEventFired"); i += 1) await sleep(100);
    await cdp.send("Runtime.evaluate", {
      expression: "document.fonts.ready.then(() => true)",
      awaitPromise: true,
      returnByValue: true,
    });
    await sleep(400);

    const probe = await cdp.send("Runtime.evaluate", {
      expression: `JSON.stringify((() => {
        const hex2rgb = (h) => {
          h = String(h || '').trim();
          const m = h.match(/[\\d.]+/g);
          return m ? m.slice(0, 3).map(Number) : [0, 0, 0];
        };
        const lum = (c) => {
          const [r, g, b] = c.map((v) => { const x = v / 255;
            return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const ratio = (a, b) => {
          const x = lum(hex2rgb(a)), y = lum(hex2rgb(b));
          return ((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)).toFixed(2);
        };
        return Array.from(document.querySelectorAll('[data-shot]')).map((frame) => {
          const sheet = getComputedStyle(frame).backgroundColor;
          const pick = (sel) => {
            const el = frame.querySelector(sel);
            return el ? getComputedStyle(el).color : null;
          };
          let worst = 0, sel = '', clip = '';
          for (const el of frame.querySelectorAll('*')) {
            let a = el.parentElement, holder = frame;
            while (a && a !== document.body) {
              const oy = getComputedStyle(a).overflowY;
              if (oy === 'hidden' || oy === 'auto' || oy === 'scroll') { holder = a; break; }
              a = a.parentElement;
            }
            const over = Math.round(el.getBoundingClientRect().bottom - holder.getBoundingClientRect().bottom);
            if (over > worst) {
              worst = over;
              sel = typeof el.className === 'string' ? el.className : el.tagName;
              clip = String(holder.className || holder.tagName);
            }
          }
          const r = frame.getBoundingClientRect();
          return {
            shot: frame.dataset.shot,
            dir: frame.dataset.dir,
            size: Math.round(r.width) + 'x' + Math.round(r.height),
            ink: ratio(pick('.ev-t') || pick('.brow .t') || sheet, sheet),
            dim: ratio(pick('.meta') || sheet, sheet),
            faint: ratio(pick('.b-note') || pick('.ev-foot') || sheet, sheet),
            worst, sel: String(sel).slice(0, 30), clip: clip.slice(0, 24),
          };
        });
      })())`,
      returnByValue: true,
    });
    console.log("[probe] 图名 | 方向 | 尺寸 | 正文 | 次要 | 最次要 | 裁切");
    for (const row of JSON.parse(probe.result.value)) {
      console.log(
        `[probe] ${row.shot} | ${row.dir} | ${row.size} | ${row.ink} | ${row.dim} | ${row.faint} | ` +
          (row.worst > 2 ? `⚠ 被裁 ${row.worst}px @ ${row.sel} <- ${row.clip}` : "ok"),
      );
    }

    const align = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify(Array.from(document.querySelectorAll('[data-shot]')).map((f) => {
        const ed = (el) => { const b = el.getBoundingClientRect(); return Math.round(b.left) + '..' + Math.round(b.right); };
        const ident = f.querySelector('.ident'), kpis = [...f.querySelectorAll('.kpi')], cols = [...f.querySelectorAll('.grid > *')];
        return { shot: f.dataset.shot, ident: ident ? ed(ident) : '-', kpis: kpis.map(ed), cols: cols.map(ed) };
      }))`,
      returnByValue: true,
    });
    for (const row of JSON.parse(align.result.value)) {
      console.log('[align] ' + row.shot + ' | 身份带 ' + row.ident + ' | KPI ' + row.kpis.join(' , ') + ' | 三栏 ' + row.cols.join(' , '));
    }

    const shots = JSON.parse(
      (
        await cdp.send("Runtime.evaluate", {
          expression: `JSON.stringify(Array.from(document.querySelectorAll('[data-shot]')).map((el) => {
            const r = el.getBoundingClientRect();
            return { name: el.dataset.shot, x: r.left, y: r.top, w: r.width, h: r.height };
          }))`,
          returnByValue: true,
        })
      ).result.value,
    );

    console.log("[rects] " + JSON.stringify(shots));
    for (let i = 0; i < shots.length; i += 1) {
      await cdp.send('Runtime.evaluate', {
        expression: `document.querySelectorAll('[data-shot]')[${i}].scrollIntoView({ block: 'start' }); true`,
        returnByValue: true,
      });
      await sleep(260);
      const png = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(OUT, `${shots[i].name}.png`);
      fs.writeFileSync(file, Buffer.from(png.data, 'base64'));
      console.log(`[shot] ${path.basename(file)}  ${Math.round(shots[i].w)}x${Math.round(shots[i].h)}`);
    }

    cdp.ws.close();
  } finally {
    chrome.kill();
  }
}

main().catch((e) => {
  console.error("[fail]", e.message);
  process.exit(1);
});
