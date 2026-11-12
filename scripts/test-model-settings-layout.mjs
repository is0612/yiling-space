/**
 * Offline Chrome/CDP regression for the model workspace layout.
 * Run: node scripts/test-model-settings-layout.mjs
 * Optional: CHROME_PATH=/path/to/chrome node scripts/test-model-settings-layout.mjs
 * Uses the same browser approach as shoot-page.mjs; never opens the app or calls APIs.
 * Real source CSS + Vue template structure, representative fixture (not hydrated Element Plus).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, compileStyle } from "@vue/compiler-sfc";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = readFileSync(path.join(root, "app/components/CharacterModelSettings.vue"), "utf8");
const workspaceCss = readFileSync(path.join(root, "app/assets/css/model-settings.css"), "utf8");
const workspacePage = readFileSync(path.join(root, "app/pages/models.vue"), "utf8");
assert(!workspacePage.includes('class="model-purpose-header"'), "Do not restore the redundant capability header above the form");
assert(!workspacePage.includes('class="model-settings-guidance"'), "Do not restore the redundant guidance strip above the form");
assert(workspacePage.includes('class="model-settings-panel"'), "Keep the actual settings panel");
const { descriptor, errors } = parse(source);
assert.deepEqual(errors, []);
function walk(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children || []) { const found = walk(child, predicate); if (found) return found; }
}
function hasClass(node, name) {
  return node.type === 1 && node.props.some(p => p.type === 6 && p.name === "class" && p.value?.content.split(/\s+/).includes(name));
}
const generationDialog = walk(descriptor.template.ast, node => node.type === 1 && node.tag === "el-dialog" && node.props.some(p => p.type === 6 && p.name === "title" && p.value?.content === "生成参数"));
assert(generationDialog, "Chat generation parameters belong in a dialog");
assert(walk(generationDialog, node => node.type === 1 && node.props.some(p => p.type === 7 && p.name === "model" && p.exp?.content === "draftChatTemperature")), "Dialog edits the original chat draft");
const chatModelRow = walk(descriptor.template.ast, node => hasClass(node, "model-row"));
assert.deepEqual(chatModelRow.children.filter(node => node.type === 1).map(node => node.tag), ["el-select", "el-button", "el-button"], "Chat model select, fetch and test share one row");
for (const tab of ["voice", "vision"]) {
  const pane = walk(descriptor.template.ast, node => node.type === 1 && node.props.some(p => p.type === 7 && p.name === "show" && p.exp?.content === `activeTab === '${tab}'`));
  assert(pane, `${tab} pane remains available`);
  const row = walk(pane, node => hasClass(node, "model-row"));
  assert.deepEqual(row.children.filter(node => node.type === 1).map(node => node.tag), ["el-select", "el-button", "el-button"], `${tab} model, fetch and test share one row`);
  assert(walk(pane, node => node.type === 1 && node.tag === "el-tooltip"), `${tab} title has hover help`);
}
const voiceDialog = walk(descriptor.template.ast, node => node.type === 1 && node.tag === "el-dialog" && node.props.some(p => p.type === 6 && p.name === "title" && p.value?.content === "语音合成 · 生成参数"));
assert(voiceDialog, "Voice synthesis options use a parameter dialog");
for (const model of ["draftVoiceSpeed", "draftVoiceTtsVoice", "draftVoiceInstructions"]) assert(walk(voiceDialog, node => node.type === 1 && node.props.some(p => p.type === 7 && p.name === "model" && p.exp?.content === model)), `Voice dialog preserves ${model}`);
const assistantSource = readFileSync(path.join(root, "app/components/AssistantOverridePanel.vue"), "utf8");
const assistantTemplate = parse(assistantSource).descriptor.template.ast;
assert(!walk(assistantTemplate, node => node.type === 1 && node.tag === "el-switch"), "Assistant model cards no longer expose enable switches");
assert(!assistantSource.includes("inheritanceLabel"), "Remove redundant inheritance badge");
assert(walk(assistantTemplate, node => node.type === 1 && node.tag === "el-tooltip"), "Assistant help is available on hover and focus");
assert(!source.includes("model-name-field") && !assistantSource.includes("model-name-field"), "Model name labels use the same stacked field layout as provider labels");
const assistantDialog = walk(assistantTemplate, node => node.type === 1 && node.tag === "el-dialog");
assert(assistantDialog, "Assistant parameters use the same dialog interaction");
for (const model of ["temperature", "maxInputTokens", "maxOutputTokens"]) {
  assert(walk(assistantDialog, node => node.type === 1 && node.props.some(p => p.type === 7 && p.name === "model" && p.exp?.content === model)), `Assistant dialog preserves ${model} draft binding`);
}
assert(assistantSource.includes("margin-top: 16px; gap: 16px"), "Assistant field spacing is defined locally rather than relying on parent scoped CSS");
const aside = walk(descriptor.template.ast, node => hasClass(node, "ms-side"));
assert(aside && aside.tag === "aside", "Retain the model settings information aside");
const cards = aside.children.filter(node => hasClass(node, "brick"));
assert.equal(cards.length, 2, "Only configuration and usage cards remain in the aside");
const headings = cards.map(node => walk(node, item => item.type === 1 && item.tag === "h2")?.children.filter(item => item.type === 2).map(item => item.content).join("").trim());
assert.deepEqual(headings, ["当前配置", "今日用量"]);
for (const card of cards) assert(!card.props.some(p => p.type === 7 && ["if", "show"].includes(p.name)), "Cards must not be hidden conditionally");
assert(!/font-size:\s*(?:\d|1[01])px\b/.test(workspaceCss), "Workspace font sizes must remain at least 12px");
const compiled = descriptor.styles.map(style => {
  const result = compileStyle({ source: style.content, filename: "CharacterModelSettings.vue", id: "data-v-layout", scoped: style.scoped });
  assert.deepEqual(result.errors, []);
  return result.code;
}).join("\n");
const chromePath = process.env.CHROME_PATH || [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].find(existsSync);
assert(chromePath && existsSync(chromePath), "Chrome/Edge is required for computed-layout assertions; set CHROME_PATH (no silent static-only pass)");
const profile = mkdtempSync(path.join(tmpdir(), "model-layout-test-"));
const chrome = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let launchError;
chrome.on("error", error => { launchError = error; });
let ws;
const pending = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const activePort = path.join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 15000;
  while (!existsSync(activePort)) {
    if (launchError) throw launchError;
    assert(Date.now() < deadline, "Chrome did not start within 15 seconds");
    await delay(100);
  }
  const [port, browserPath] = readFileSync(activePort, "utf8").trim().split(/\r?\n/);
  ws = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let sequence = 0;
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  };
  function send(method, params = {}, sessionId) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);
  await call("Page.enable");
  const { frameTree } = await call("Page.getFrameTree");
  const fixture = `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;font:14px sans-serif;--sp-1:4px;--sp-2:8px;--sp-3:12px;--sp-4:16px;--sp-5:20px;--sp-6:24px;--surface:#fff;--surface-2:#eee;--text:#222;--text-2:#444;--dim:#666}
    #host{margin:auto}.ms-main>.brick{min-height:360px}input{width:100%;min-width:0}h2{overflow-wrap:anywhere}
    ${compiled}\n${workspaceCss}
    </style></head><body><div id="host"><div class="model-settings-workspace"><div class="model-workspace-layout"><aside class="model-capability-sidebar"><nav class="model-capability-nav">模型能力导航</nav></aside><main class="model-workspace-content"><div class="model-settings-panel"><div class="page-wrap ms-a"><div class="ms-grid"><div class="ms-main"><section class="brick"><h2>对话模型设置</h2><div class="field"><input aria-label="模型" value="deepseek-flash"></div></section></div><aside class="ms-side">${headings.map(heading => `<section class="brick"><div class="card-head"><h2>${heading}</h2></div><p>模型设置的说明与状态</p></section>`).join("")}</aside></div></div></div></main></div></div></div></body></html>`;
  await call("Page.setDocumentContent", { frameId: frameTree.frame.id, html: fixture });
  const setup = await call("Runtime.evaluate", { expression: `document.querySelectorAll('*').forEach(el=>el.setAttribute('data-v-layout',''))` });
  assert(!setup.exceptionDetails);
  const cases = [
    { name: "ultrawide desktop", viewport: 2560, host: 2200, mode: "right" },
    { name: "large desktop", viewport: 1920, host: 1840, mode: "right" },
    { name: "desktop 1366", viewport: 1366, host: 1300, mode: "right" },
    { name: "narrow panel on wide viewport", viewport: 1920, host: 1100, mode: "bottom-two" },
    { name: "tablet", viewport: 900, host: 860, mode: "bottom-two" },
    { name: "tablet 768", viewport: 768, host: 744, mode: "bottom-one" },
    { name: "zoom-equivalent narrow layout", viewport: 1100, host: 1000, mode: "bottom-two" },
    { name: "container boundary 960", viewport: 1920, host: 1400, panel: 960, mode: "right" },
    { name: "container boundary 959", viewport: 1920, host: 1400, panel: 959, mode: "bottom-two" },
    { name: "container boundary 600", viewport: 1920, host: 1400, panel: 600, mode: "bottom-two" },
    { name: "container boundary 599", viewport: 1920, host: 1400, panel: 599, mode: "bottom-one" },
    { name: "phone", viewport: 375, host: 351, mode: "bottom-one" },
  ];
  for (const test of cases) {
    await call("Emulation.setDeviceMetricsOverride", { width: test.viewport, height: 1000, deviceScaleFactor: 1, mobile: false });
    const response = await call("Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression: `(async()=>{
      document.querySelector('#host').style.width='${test.host}px';
      document.querySelector('.model-settings-panel').style.width='${test.panel ? `${test.panel}px` : ""}';
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const get=s=>document.querySelector(s), rect=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right}};
      return {workspaceMax:getComputedStyle(get('.model-settings-workspace')).maxWidth,workspace:rect(get('.model-settings-workspace')),nav:rect(get('.model-capability-sidebar')),panel:rect(get('.model-settings-panel')),main:rect(get('.ms-main')),side:rect(get('.ms-side')),cards:[...document.querySelectorAll('.ms-side>.brick')].map(rect),grid:getComputedStyle(get('.ms-grid')).gridTemplateColumns,sideGrid:getComputedStyle(get('.ms-side')).gridTemplateColumns,overflow:document.documentElement.scrollWidth>innerWidth};
    })()` });
    assert(!response.exceptionDetails, JSON.stringify(response.exceptionDetails));
    const result = response.result.value;
    assert.equal(result.workspaceMax, "1760px", `${test.name}: workspace max width`);
    assert.equal(result.cards.length, 2);
    assert(!result.overflow, `${test.name}: no viewport horizontal overflow`);
    for (const card of result.cards) {
      assert(card.width > 0 && card.height > 0, `${test.name}: card remains visible`);
      assert(card.right <= result.panel.right + 1, `${test.name}: cards stay inside panel`);
    }
    if (test.mode === "right") {
      assert(Math.abs(result.nav.width - 180) < 1, `${test.name}: 180px capability navigation`);
      assert(result.panel.width >= 960, `${test.name}: fixture reaches wide-container threshold`);
      assert(result.side.x >= result.main.right, `${test.name}: information cards in right rail`);
      assert(Math.abs(result.side.y - result.main.y) < 1, `${test.name}: rail aligns with main form`);
      assert(result.side.width >= 300 && result.side.width <= 340, `${test.name}: 300–340px right rail`);
      assert(result.cards[1].y >= result.cards[0].bottom, `${test.name}: right rail cards stack`);
    } else {
      assert(result.panel.width < 960, `${test.name}: fixture reaches narrow-container state`);
      assert(result.side.y >= result.main.bottom, `${test.name}: information cards below form`);
      if (test.mode === "bottom-two") {
        assert(Math.abs(result.cards[0].y - result.cards[1].y) < 1, `${test.name}: first two cards share a row`);
        assert(result.cards[1].x >= result.cards[0].right, `${test.name}: bottom cards use two columns`);
      } else {
        assert(result.cards[1].y >= result.cards[0].bottom, `${test.name}: phone cards form one column`);
      }
    }
    console.log(`PASS ${test.name}: panel=${Math.round(result.panel.width)}px; main grid=${result.grid}; cards=${result.sideGrid}`);
  }
  console.log("PASS: two Vue-template status cards; real scoped + workspace CSS in Chrome; desktop/right, narrow-container/bottom, tablet/two-column, phone/single-column, no fixture overflow.");
  console.log("Limit: offline representative DOM, not hydrated application/Element Plus; does not verify real API data, app-shell gutters, interactions or visual appearance.");
} finally {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  ws?.close();
  if (chrome.exitCode === null) {
    const exited = new Promise(resolve => chrome.once("exit", resolve));
    chrome.kill();
    await exited;
  }
  // Exact temporary directory created above, never a business-data or repository path.
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
