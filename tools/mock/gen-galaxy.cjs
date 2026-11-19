/**
 * 生成成长星图的两个设计方向静态稿（1440×900，含真实侧栏/顶栏）。
 * 节点坐标与连线直接读 app/utils/growth-galaxy.ts，避免稿子和数据对不上。
 * 用法：node tools/mock/gen-galaxy.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "../../app/utils/growth-galaxy.ts");
const OUT = path.join(__dirname, "galaxy-directions.html");
const src = fs.readFileSync(SRC, "utf8");

const nodes = [...src.matchAll(/(\w+): \{ name: "([^"]+)", planet: "([^"]+)", orbit: "([^"]+)", x: (\d+), y: (\d+), size: (\d+), color: "(#[0-9a-f]{6})"/g)]
  .map((m) => ({ id: m[1], name: m[2], planet: m[3], orbit: m[4], x: +m[5], y: +m[6], size: +m[7], color: m[8] }));
const edges = [...src.matchAll(/\{ from: "(\w+)", to: "(\w+)", kind: "(\w+)"(?:, bend: (-?\d+))?/g)]
  .map((m) => ({ from: m[1], to: m[2], kind: m[3], bend: m[4] ? +m[4] : 0 }));

const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
const W = 840;
const H = 640;

function edgePath({ from, to, bend = 0 }) {
  const a = byId[from];
  const b = byId[to];
  if (!a || !b) return "";
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const mx = (a.x + b.x) / 2 - (dy / len) * bend;
  const my = (a.y + b.y) / 2 + (dx / len) * bend;
  const endpoint = (node, gap) => {
    const d = Math.hypot(mx - node.x, my - node.y);
    const r = node.size / 2 + gap;
    return `${node.x + ((mx - node.x) * r) / d},${node.y + ((my - node.y) * r) / d}`;
  };
  return `M${endpoint(a, 5)} Q${mx},${my} ${endpoint(b, 12)}`;
}

// 确定性伪随机，保证每次出图一致
let seed = 20261119;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const dust = Array.from({ length: 64 }, () => {
  const x = rnd() * W;
  const y = rnd() * H;
  const r = 0.5 + rnd() * 0.9;
  const o = 0.12 + rnd() * 0.3;
  return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}" fill="#cfe4ff" opacity="${o.toFixed(2)}"/>`;
}).join("");

const core = byId.core;
const orbits = [150, 262, 372]
  .map((r, i) => `<circle cx="${core.x}" cy="${core.y}" r="${r}" fill="none" stroke="#8fc9ff" stroke-width="${i === 2 ? 0.7 : 0.9}" stroke-opacity="${(0.16 - i * 0.04).toFixed(2)}"${i === 2 ? ' stroke-dasharray="2 7"' : ""}/>`)
  .join("");

function nodeMarkup(n, extraClass = "") {
  const left = ((n.x / W) * 100).toFixed(3);
  const top = ((n.y / H) * 100).toFixed(3);
  const size = (n.size / W) * 100;
  const label = n.id === "core" ? "鲸宁宁" : n.planet;
  const sub = n.id === "core" ? '<span class="cap">互动核心</span>' : "";
  return `<div class="node ${extraClass} n-${n.id}" style="left:${left}%;top:${top}%;--d:${size.toFixed(3)}cqw;--tone:${n.color}">
  <div class="orb"></div>
  <span class="lbl">${label}${sub}</span>
</div>`;
}

const nodesMarkup = nodes.map((n) => nodeMarkup(n)).join("\n");

const ghostPaths = edges.map((e) => `<path class="ghost" d="${edgePath(e)}" stroke="${byId[e.from]?.color ?? "#8fc9ff"}"/>`).join("");

// D2：每条边一条渐变（源色 → 目标色），外加一条宽的柔光底色
const defsD2 = edges
  .map((e, i) => `<linearGradient id="g${i}" gradientUnits="userSpaceOnUse" x1="${byId[e.from].x}" y1="${byId[e.from].y}" x2="${byId[e.to].x}" y2="${byId[e.to].y}">
    <stop offset="0" stop-color="${byId[e.from].color}" stop-opacity=".05"/>
    <stop offset=".55" stop-color="${byId[e.from].color}" stop-opacity=".55"/>
    <stop offset="1" stop-color="${byId[e.to].color}" stop-opacity=".85"/>
  </linearGradient>`)
  .join("");

const glowPaths = edges.map((e) => `<path class="glow" d="${edgePath(e)}" stroke="url(#g${edges.indexOf(e)})"/>`).join("");
const brightPaths = edges.map((e, i) => `<path class="flow" d="${edgePath(e)}" stroke="url(#g${i})"/>`).join("");

// 选中「经验星球」：只亮它相关的那几条，并在沿途中点亮三颗光点
const focusId = "experience";
const focusEdges = edges.filter((e) => e.from === focusId || e.to === focusId);

const shell = (active) => `
  <aside class="side">
    <div class="brand"><div class="brand-mark">忆</div><div><div class="brand-title">忆灵空间<span>Yiling</span></div><div class="brand-sub">AI CHARACTER HUB</div></div></div>
    <nav class="nav">
      <div class="nav-sec">工作空间</div>
      <a class="nav-link" href="#">总览</a><a class="nav-link" href="#">聊天</a><a class="nav-link" href="#">角色管理</a><a class="nav-link" href="#">日记手账</a>
      <div class="nav-sec">成长系统</div>
      <a class="nav-link" href="#">总览</a><a class="nav-link on" href="#">成长星图</a><a class="nav-link" href="#">记忆系统</a>
      <a class="nav-link" href="#">社交系统</a><a class="nav-link" href="#">语言系统</a><a class="nav-link" href="#">反思系统</a>
      <a class="nav-link" href="#">知识系统</a><a class="nav-link" href="#">自我认知</a>
    </nav>
    <div class="nav-bottom"><span class="nav-ava">鲸</span><div><div class="nav-name">鲸宁宁</div><div class="nav-note">当前角色 · 共 3 个</div></div></div>
  </aside>
  <div class="page">
    <header class="top"><span class="crumb">成长系统</span><span class="crumb-sep">/</span><h1>成长星图</h1>
      <div class="top-right"><span class="me">管</span></div></header>`;

const commonCss = `
  :root{ --bg:#090f20; --muted:#93a9c4; }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;display:block;background:#05080f}
  html{scrollbar-width:none}
  ::-webkit-scrollbar{width:0;height:0}
  body{font-family:"Microsoft YaHei","Noto Sans SC",system-ui,sans-serif;color:#e8f1ff;-webkit-font-smoothing:antialiased}
  .frame{width:1440px;height:900px;display:grid;grid-template-columns:260px minmax(0,1fr);background:var(--bg);overflow:hidden;position:relative}
  .side{background:#fff;padding:12px 10px 10px;display:flex;flex-direction:column;border-right:1px solid #e6e9ef;color:#101620}
  .brand{display:flex;align-items:center;gap:10px;padding:2px 4px 10px}
  .brand-mark{width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,#ff8fae,#ef5f8b);color:#fff;font-size:17px;font-weight:700;display:grid;place-items:center}
  .brand-title{font-size:15px;font-weight:700}
  .brand-title span{color:#68717f;font-weight:600;font-size:12px;margin-left:3px}
  .brand-sub{font-size:9px;letter-spacing:.14em;color:#68717f;margin-top:2px}
  .nav{flex:1;min-height:0;overflow:hidden;margin-top:4px}
  .nav-sec{padding:13px 8px 4px;color:#68717f;font-size:12px;font-weight:700;letter-spacing:.02em}
  .nav-link{display:flex;align-items:center;height:34px;padding:0 9px;border-radius:8px;color:#454f5e;font-size:14px;text-decoration:none}
  .nav-link.on{background:#fdf0f4;color:#c9416b;font-weight:600}
  .nav-bottom{border-top:1px solid #e6e9ef;padding:10px 8px 4px;display:flex;align-items:center;gap:9px}
  .nav-ava{width:28px;height:28px;border-radius:50%;background:#fdf0f4;color:#c9416b;font-size:13px;font-weight:700;display:grid;place-items:center}
  .nav-name{font-size:13px;font-weight:600}
  .nav-note{font-size:12px;color:#68717f;margin-top:1px}
  .page{display:flex;flex-direction:column;min-width:0}
  .top{height:56px;flex:none;background:#fff;display:flex;align-items:center;gap:10px;padding:0 18px;color:#101620}
  .crumb{font-size:14px;color:#68717f}.crumb-sep{color:#b9c0cb;font-size:14px}
  .top h1{margin:0;font-size:18px;font-weight:700}
  .top-right{margin-left:auto}.me{width:30px;height:30px;border-radius:50%;background:#eef0f3;color:#454f5e;font-size:13px;display:grid;place-items:center}
  .stage{position:relative;flex:1;min-height:0;overflow:hidden;background:var(--bg);container-type:inline-size}
  .map{position:absolute;inset:0;width:100%;height:100%}
  .node{position:absolute;transform:translate(-50%,-50%);display:grid;place-items:center;width:max(26px,var(--d));height:max(26px,var(--d))}
  .orb{width:100%;height:100%;border-radius:50%;border:1px solid color-mix(in srgb,var(--tone) 74%,transparent);background:color-mix(in srgb,var(--tone) 9%,transparent);display:grid;place-items:center}
  .orb::after{content:"";width:24%;aspect-ratio:1;border-radius:50%;background:var(--tone);box-shadow:0 0 12px color-mix(in srgb,var(--tone) 85%,transparent)}
  .lbl{position:absolute;top:calc(100% + 8px);left:50%;transform:translateX(-50%);white-space:nowrap;font-size:12px;letter-spacing:.02em;color:#c3d6ea;text-shadow:0 1px 6px #05080f}
  .n-core .lbl{font-size:14px;color:#eafcff;text-align:center}
  .cap{display:block;font-size:12px;color:#8fb4d6;margin-top:2px}
  .hud{position:absolute;font-size:11px;letter-spacing:.18em;color:#7f97b5;font-family:"Cascadia Mono",Consolas,monospace}
`;

const dirA = `
  <div class="frame" data-shot="G1-轨道仪" data-dir="A">
    ${shell()}
      <div class="stage">
        <svg class="map" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
          ${orbits}
          ${dust}
          ${ghostPaths}
        </svg>
        ${nodesMarkup}
        <div class="hud" style="left:26px;top:22px">11 SYSTEMS · 29 LINKS</div>
        <div class="hud" style="right:26px;top:22px">CELESTIAL ATLAS</div>
        <div class="hud" style="left:26px;bottom:22px">资料读取 · 证据沉淀 · 事件投递 · 认知整合</div>
      </div>
    </div>
  </div>`;

const dirB = (shot, focused) => `
  <div class="frame" data-shot="${shot}" data-dir="B">
    ${shell()}
      <div class="stage">
        <svg class="map" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
          <defs>${defsD2}</defs>
          ${dust}
          ${focused ? "" : glowPaths}
          ${focused ? "" : brightPaths}
          ${focused ? focusEdges.map((e) => `<path class="glow" d="${edgePath(e)}" stroke="${byId[e.from].color}" stroke-opacity=".5"/><path class="flow on" d="${edgePath(e)}" stroke="${byId[e.to].color}"/>`).join("") : ""}
        </svg>
        ${nodes.map((n) => nodeMarkup(n, focused && n.id !== focusId ? "dim" : focused && n.id === focusId ? "focus" : "")).join("\n")}
        <div class="hud" style="left:26px;top:22px">11 SYSTEMS · 29 LINKS</div>
        <div class="hud" style="right:26px;top:22px">${focused ? "INTERACTION EXPERIENCE" : "CELESTIAL ATLAS"}</div>
        <div class="hud" style="left:26px;bottom:22px">资料读取 · 证据沉淀 · 事件投递 · 认知整合</div>
      </div>
    </div>
  </div>`;

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>成长星图 · 方向稿</title>
<style>${commonCss}
  /* A 轨道仪：同心轨道 + 星尘 + 极淡网 */
  [data-dir="A"] .ghost{fill:none;stroke-width:.8;stroke-opacity:.12}
  [data-dir="A"] .orb{border-color:color-mix(in srgb,var(--tone) 62%,transparent);box-shadow:0 0 16px color-mix(in srgb,var(--tone) 14%,transparent)}
  [data-dir="A"] .n-core .orb{border-color:color-mix(in srgb,#8be4ff 90%,transparent);box-shadow:0 0 64px #8be4ff2e}
  [data-dir="A"] .n-core .orb::before{content:"";position:absolute;inset:-16px;border-radius:50%;border:1px dashed #8be4ff42}

  /* B 能量流：渐变光带 + 节点光晕 */
  [data-dir="B"] .glow{fill:none;stroke-width:5;stroke-opacity:.16;filter:blur(2px)}
  [data-dir="B"] .flow{fill:none;stroke-width:1.1;stroke-opacity:.8}
  [data-dir="B"] .flow.on{stroke-width:1.8;stroke-opacity:1}
  [data-dir="B"] .orb{border-color:color-mix(in srgb,var(--tone) 82%,transparent);box-shadow:0 0 26px color-mix(in srgb,var(--tone) 30%,transparent),inset 0 0 18px color-mix(in srgb,var(--tone) 12%,transparent)}
  [data-dir="B"] .n-core .orb{box-shadow:0 0 80px #8be4ff33,0 0 160px #8be4ff1c,inset 0 0 30px #8be4ff22}
  [data-dir="B"] .node.dim{opacity:.42}
  [data-dir="B"] .node.focus .orb{outline:1px solid color-mix(in srgb,var(--tone) 60%,transparent);outline-offset:6px;box-shadow:0 0 40px color-mix(in srgb,var(--tone) 55%,transparent)}
</style></head>
<body>
${dirA}
${dirB("G2-能量流", false)}
${dirB("G3-能量流-选中", true)}
</body></html>`;

fs.writeFileSync(OUT, html);
console.log("written", OUT, `${(html.length / 1024).toFixed(1)} KB`, "nodes", nodes.length, "edges", edges.length);
