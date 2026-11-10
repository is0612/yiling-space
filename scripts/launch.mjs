#!/usr/bin/env node
/**
 * 一键启动器。双击项目根目录的「启动忆灵空间.bat」会走到这里。
 *
 * 做四件事，任一步失败就明确告诉你卡在哪、下一步该敲什么：
 *   1. 环境自检：Node 版本、.env、yarn（没有就自动装）、依赖、Prisma Client
 *   2. 数据库：连不上就试着把 Docker 容器拉起来，等到端口真正可连
 *   3. 已经在跑？那就只打开浏览器，不重复起第二个 dev server
 *   4. 起 nuxt dev（自带 --open，就绪后自动开浏览器）
 *
 * 项目相关的东西一律从仓库自己身上读（package.json / docker-compose.yml / .env），
 * 所以把这个脚本连 .bat 一起复制到 yiling-space 这类同构项目里就能直接用。
 * 只有下面 CONFIG 里那两行是人工设定的。
 *
 * 中文全部写在这层：.bat 里只放 ASCII，避免 cmd 的代码页把提示变成乱码。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ---------- 只在这里改 ---------- */
const CONFIG = {
  /** 中文名。换项目/换语言只改这一行；留空则只显示英文名。 */
  cnName: "忆灵空间",
  /** 数据库容器名。留空 = 自动从 docker-compose.yml 里找 postgres 服务的 container_name。 */
  dbContainer: "",
};

/* ---------- 从仓库自述文件里推导 ---------- */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const PKG = readJson(path.join(ROOT, "package.json")) ?? {};
const PROJECT_NAME = typeof PKG.name === "string" && PKG.name ? PKG.name : "app";
const titleCase = (slug) =>
  slug
    .split(/[-_.]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
const EN_NAME = titleCase(PROJECT_NAME);
/** 显示名：中文名 · 英文名，英文名取 package.json 的 name。 */
const APP_LABEL = CONFIG.cnName ? `${CONFIG.cnName} · ${EN_NAME}` : EN_NAME;

/** 和 package.json 的 packageManager 同步；本机缺 yarn 时按这个版本装。 */
const YARN_VERSION = /^yarn@(\d+\.\d+\.\d+)/.exec(PKG.packageManager ?? "")?.[1] ?? "1.22.22";

const TOTAL_STEPS = 4;
const DEFAULT_PORT = 3000;

/* ---------- 输出 ---------- */
const COLOR = process.env.NO_COLOR !== "1" && process.stdout.isTTY;
const paint = (code, text) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = (t) => paint(90, t);
const cyan = (t) => paint(36, t);
const green = (t) => paint(32, t);
const yellow = (t) => paint(33, t);
const red = (t) => paint(31, t);

const step = (n, text) => console.log(`${dim(`[${n}/${TOTAL_STEPS}]`)} ${text}`);
const ok = (text) => console.log(`      ${green("✓")} ${text}`);
const warn = (text) => console.log(`      ${yellow("!")} ${text}`);
const bad = (text) => console.log(`      ${red("✗")} ${text}`);

/* ---------- 环境变量 ---------- */
function loadEnv() {
  const file = path.join(ROOT, ".env");
  if (!existsSync(file)) {
    throw new Error(
      [
        "项目根目录没有 .env，数据库和模型都读不到配置。",
        "先跑一次交互式向导（生成 .env、拉起容器、建管理员账号）：",
        "  yarn setup",
        "只想先看看它要做什么：yarn setup --dry-run",
      ].join("\n"),
    );
  }
  const env = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  // 已经导出的环境变量优先（和 Nuxt/Prisma 的 dotenv 行为一致），方便临时指向别的库。
  for (const key of Object.keys(env)) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

/* ---------- 端口探测 ---------- */
function pingPort(host, port, timeout = 1200) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function waitPort(host, port, totalMs) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (await pingPort(host, port, 800)) return true;
    await new Promise((r) => setTimeout(r, 600));
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseDatabase(env) {
  const raw = env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL 是空的。跑一次 yarn setup 会把三处数据库密码对齐并写好。");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("DATABASE_URL 不是合法的连接串，检查 .env 里有没有多余的空格或引号。");
  }
  const port = Number(url.port || 5432);
  const host = url.hostname === "localhost" ? "127.0.0.1" : url.hostname;
  return { host, port };
}

/* ---------- 项目自省 ---------- */
/**
 * 从 docker-compose.yml 里找数据库容器：按 2 空格缩进切服务块，
 * 取第一个 image 含 postgres 的块里的 container_name。
 * 找不到就退回 `<项目名>-db` —— 和 compose 里常见命名习惯一致。
 */
function detectDbContainer() {
  if (CONFIG.dbContainer) return CONFIG.dbContainer;
  const fallback = `${PROJECT_NAME}-db`;
  const file = path.join(ROOT, "docker-compose.yml");
  if (!existsSync(file)) return fallback;

  const blocks = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (/^\s{2}[\w.-]+:\s*$/.test(line)) blocks.push(line);
    else if (blocks.length) blocks[blocks.length - 1] += `\n${line}`;
  }
  for (const block of blocks) {
    if (!/image:\s*\S*postgres/i.test(block)) continue;
    const name = /container_name:\s*([\w.-]+)/.exec(block);
    if (name) return name[1];
  }
  return fallback;
}

/** Prisma 生成物位置各版本/各项目不同，挨个探一遍，能探到就不重复生成。 */
function findPrismaClient() {
  const candidates = [
    "src/generated/prisma/client.ts",
    "src/generated/prisma/index.ts",
    "app/generated/prisma/client.ts",
    "node_modules/.prisma/client/index.js",
    "prisma/generated/client.ts",
  ];
  return candidates.find((p) => existsSync(path.join(ROOT, p))) ?? null;
}

const HAS_NUXT = Boolean(PKG.dependencies?.nuxt ?? PKG.devDependencies?.nuxt);

/* ---------- yarn ---------- */
/**
 * Windows 上 yarn / npm 是 .cmd 垫片，必须过 shell 才起得来。
 * shell:true 时把参数拼成一条命令串再交给 shell —— Node 24 起把「args 数组 + shell」
 * 视为不安全用法并抛 DEP0190 警告（截图里那行黄字就是它），拼串就干净了。
 */
function commandOutput(cmd, args) {
  const line = [cmd, ...args].join(" ");
  const res = spawnSync(line, { cwd: ROOT, encoding: "utf8", shell: true, timeout: 30_000 });
  if (res.error || res.status !== 0) return null;
  return `${res.stdout || ""}`.trim();
}

function hasCommand(cmd, args = ["--version"]) {
  return commandOutput(cmd, args) !== null;
}

function checkNode() {
  const want = /(\d+)\.(\d+)/.exec(PKG.engines?.node ?? "") ?? [null, "20", "19"];
  const minMajor = Number(want[1] ?? 20);
  const minMinor = Number(want[2] ?? 19);
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < minMajor || (major === minMajor && minor < minMinor)) {
    throw new Error(
      `当前 Node 是 v${process.versions.node}，项目要求 ≥ ${minMajor}.${minMinor}。升级后重开这个窗口。`,
    );
  }
}

function currentYarn() {
  const out = commandOutput("yarn", ["-v"]);
  if (!out) return null;
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
  return m ? { text: m[0], major: Number(m[1]) } : null;
}

/**
 * 缺 yarn 就现场用 npm 装一个，省得用户自己去查 `npm i -g yarn@x`。
 * 返回要用的包管理器命令：'yarn'，或者 null（表示退回 npx 跑本地依赖）。
 * 装不上不算致命错误 —— 依赖都在 node_modules 里，npx 一样能起。
 */
function ensureYarn() {
  const yarn = currentYarn();
  if (yarn?.major === 1) {
    ok(`yarn ${yarn.text}`);
    return "yarn";
  }
  if (yarn) {
    warn(`本机 yarn 是 ${yarn.text}（Berry/新版），项目锁的是 ${YARN_VERSION}，这次改用 npx 起，不动你的全局环境`);
    return null;
  }

  warn("没装 yarn");
  if (!hasCommand("npm", ["-v"])) {
    warn("npm 也没有 —— Node 装得不完整，重装一次 Node 20+ 这两样就都齐了");
    return null;
  }

  // 先官方源，挂了再换镜像。国内直连 registry.npmjs.org 实测会 502，多这一步能省掉一次人工排查。
  const registries = [
    { label: "官方源", extra: [] },
    { label: "国内镜像 npmmirror", extra: ["--registry=https://registry.npmmirror.com"] },
  ];
  for (const { label, extra } of registries) {
    console.log(`      正在用 npm 全局安装 yarn@${YARN_VERSION}（${label}，大约几十秒）…`);
    spawnSync("npm", ["i", "-g", `yarn@${YARN_VERSION}`, ...extra], {
      cwd: ROOT,
      stdio: "inherit",
      shell: true,
    });
    const installed = currentYarn();
    if (installed?.major === 1) {
      ok(`已装好 yarn ${installed.text}，之后每次都会直接用`);
      return "yarn";
    }
  }

  warn("两个源都没装成，这次改用 npx 起，功能一样（依赖都在 node_modules 里，不影响使用）");
  console.log(dim("      上面 npm 的报错行才是真实原因。想自己修："));
  console.log(dim(`        npm i -g yarn@${YARN_VERSION} --registry=https://registry.npmmirror.com`));
  return null;
}

/* ---------- 依赖 ---------- */
function ensureDeps(yarnCmd) {
  const depMarker = HAS_NUXT ? path.join(ROOT, "node_modules", "nuxt") : path.join(ROOT, "node_modules");
  if (!existsSync(depMarker)) {
    warn("没找到 node_modules，先装依赖（首次可能要几分钟）");
    const res = spawnSync(yarnCmd ?? "npm", ["install"], { cwd: ROOT, stdio: "inherit", shell: true });
    if (res.status !== 0) throw new Error("依赖安装失败，往上翻看报错；网络问题可以先换镜像源再重试。");
  }

  // Prisma 的 client 是生成物，缺了服务一起来就报错。位置由 schema 的 generator.output 决定。
  if (existsSync(path.join(ROOT, "prisma", "schema.prisma")) && !findPrismaClient()) {
    warn("Prisma Client 还没生成，补一次 prisma generate");
    const res = spawnSync("npx", ["prisma", "generate"], { cwd: ROOT, stdio: "inherit", shell: true });
    if (res.status !== 0) throw new Error("prisma generate 失败，检查 prisma/schema.prisma 和 DATABASE_URL。");
  }
}

/* ---------- Docker ---------- */
/** 拉起引擎总共肯等多久。Docker Desktop 冷启动 + WSL 后端实测常见 40~90 秒，慢盘会更久。 */
const DOCKER_WAIT_MS = Number(process.env.LAUNCH_DOCKER_WAIT_MS || 0) || 180_000;

/** 引擎在跑吗（CLI 在但 Desktop 没启动时，docker info 会失败）。 */
function dockerDaemonUp() {
  const res = spawnSync("docker", ["info"], { cwd: ROOT, stdio: "ignore", timeout: 20_000 });
  return res.status === 0;
}

/** Docker Desktop 4.37+ 自带 `docker desktop start`，同步等到引擎可用，比拉 GUI 进程稳。 */
function supportsDockerDesktopCli() {
  const help = commandOutput("docker", ["desktop", "--help"]);
  return Boolean(help && /\bstart\b/.test(help));
}

/**
 * 找 Docker Desktop 的启动入口（老版本没有 desktop 子命令时的兜底）。
 * Windows 装法有几种（Program Files / 用户目录 / winget），挨个探；都探不到就交给
 * 开始菜单的 App Execution Alias，由 shell 去解析。
 */
function dockerStarter() {
  if (process.platform === "win32") {
    const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]
      .filter(Boolean);
    const rels = [
      ["Docker", "Docker", "Docker Desktop.exe"],
      ["Docker", "Docker Desktop.exe"],
      ["Programs", "Docker", "Docker", "Docker Desktop.exe"],
      ["Docker Desktop", "Docker Desktop.exe"],
    ];
    for (const root of roots) {
      for (const rel of rels) {
        const exe = path.join(root, ...rel);
        if (existsSync(exe)) return { cmd: exe, args: [], shell: false };
      }
    }
    return { cmd: "Docker Desktop.exe", args: [], shell: true };
  }
  if (process.platform === "darwin") return { cmd: "open", args: ["-a", "Docker"], shell: false };
  return { cmd: "systemctl", args: ["start", "docker"], shell: false };
}

/** 在给定预算内轮询到引擎就绪。 */
async function waitDockerDaemon(budgetMs) {
  const startedAt = Date.now();
  let nextNotice = 15_000;
  while (Date.now() - startedAt < budgetMs) {
    await sleep(2000);
    if (dockerDaemonUp()) {
      ok(`Docker 引擎已就绪（等了 ${Math.round((Date.now() - startedAt) / 1000)} 秒）`);
      return true;
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed >= nextNotice) {
      console.log(dim(`      引擎还在起，继续等…（已 ${Math.round(elapsed / 1000)} 秒）`));
      nextNotice += 15_000;
    }
  }
  return false;
}

/** 拉起引擎并等到可用。返回 true 表示现在可以敲 docker 命令了。 */
async function ensureDockerDaemon() {
  if (dockerDaemonUp()) return true;

  const t0 = Date.now();
  const remaining = () => Math.max(0, DOCKER_WAIT_MS - (Date.now() - t0));

  // 首选官方 CLI：它会自己把 Desktop 拉起来并同步等引擎，进度也由它打印。
  if (supportsDockerDesktopCli()) {
    const budget = Math.max(60, Math.round(remaining() / 1000));
    console.log(dim(`      正在启动 Docker Desktop，最多等 ${budget} 秒…`));
    spawnSync(`docker desktop start --timeout ${budget}`, {
      cwd: ROOT,
      stdio: "inherit",
      shell: true,
      timeout: (budget + 20) * 1000,
    });
    if (dockerDaemonUp()) {
      ok(`Docker 引擎已就绪（等了 ${Math.round((Date.now() - t0) / 1000)} 秒）`);
      return true;
    }
    if (remaining() < 15_000) return false;
    warn("docker desktop start 没成功，换直接拉起 Docker Desktop 再等一次");
  }

  // 兜底：直接起 GUI 进程，然后自己轮询引擎。
  const starter = dockerStarter();
  console.log(dim(`      正在启动 Docker Desktop（${starter.cmd}）…`));
  try {
    const child = spawn(starter.cmd, starter.args, { detached: true, stdio: "ignore", shell: starter.shell });
    child.on("error", () => {}); // 起不来交给轮询统一报错
    child.unref();
  } catch {
    warn("启动 Docker Desktop 失败");
    return false;
  }
  return waitDockerDaemon(remaining());
}

/* ---------- 数据库 ---------- */
async function ensureDatabase(env) {
  const db = parseDatabase(env);
  step(2, `检查数据库 ${db.host}:${db.port}`);

  if (await pingPort(db.host, db.port)) {
    ok("PostgreSQL 在线");
    return;
  }

  const container = detectDbContainer();
  warn(`连不上，先把数据库拉起来（容器 ${container}）`);

  // 1. 连 docker 命令都没有 —— 只能靠用户装，或者改用本机 PostgreSQL。
  if (!hasCommand("docker", ["--version"])) {
    throw new Error(
      [
        "这台机器上没有 docker 命令。三选一：",
        "  1. 装 Docker Desktop（https://www.docker.com/products/docker-desktop/），装完双击一次这个文件",
        "  2. 本机自装的 PostgreSQL 开着服务，把 .env 的 POSTGRES_PORT 改成它的端口",
        "  3. 从零重来：yarn setup",
      ].join("\n"),
    );
  }

  // 2. 装是装了，多半只是 Desktop 没启动 —— 自己拉起来，别让用户去开。
  if (!(await ensureDockerDaemon())) {
    throw new Error(
      [
        "Docker 引擎没能自动起来。常见原因按概率排：",
        "  · Docker Desktop 卡在登录 / 更新 / 接受协议弹窗上 —— 托盘点开图标看完它想让你点什么",
        "  · WSL2 后端没就绪 —— 看 `docker desktop status` 的输出，或在设置里点 Troubleshoot → Restart",
        "  · 虚拟化被关掉了 —— 任务管理器 → 性能 → CPU 里的「虚拟化」要是已启用",
        "查完还是不行，三选一：",
        "  1. 手动启动 Docker Desktop，等它变绿，再双击一次这个文件（之后就不用管了）",
        "  2. 本机自装的 PostgreSQL 开着服务，把 .env 的 POSTGRES_PORT 改成它的端口",
        "  3. 从零重来：yarn setup",
      ].join("\n"),
    );
  }

  // 3. 引擎在跑，把容器起来：先试已有容器（快、保留数据卷），没有再 compose up。
  const started =
    spawnSync("docker", ["start", container], { cwd: ROOT, stdio: "ignore" }).status === 0 ||
    spawnSync("docker", ["compose", "up", "-d", "db"], { cwd: ROOT, stdio: "ignore" }).status === 0;
  if (!started) {
    throw new Error(
      `容器起不来。看一眼真实原因：\n  docker compose logs db\n数据卷还在，不用怕丢数据。`,
    );
  }

  if (await waitPort(db.host, db.port, 90_000)) {
    ok("数据库已就绪");
    return;
  }
  throw new Error(
    [
      "等了 90 秒端口还没通。多半是密码不一致或容器在重启：",
      "  docker compose logs db",
      "密码对不上时最省事的做法是重跑 yarn setup（会问要不要重建 .env，重建前备份成 .env.bak）。",
    ].join("\n"),
  );
}

/* ---------- 是否已在运行 ---------- */
function readLock() {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, ".nuxt", "nuxt.lock"), "utf8"));
  } catch {
    return null;
  }
}

const samePath = (a, b) =>
  typeof a === "string" &&
  path.resolve(a).toLowerCase().replaceAll("\\", "/") === path.resolve(b).toLowerCase().replaceAll("\\", "/");

/**
 * 已经在跑就别起第二个。Nuxt 自己会拦（"Another Nuxt dev server is already running"），
 * 但那句话对双击启动的人没用 —— 所以先读 .nuxt/nuxt.lock：cwd 对得上就认它，
 * 顺便拿到真实端口（用户可能自己配了 3001，不能只盯着 3000）。
 */
async function findRunningDevServer(defaultUrl) {
  const lock = readLock();
  const candidates = [];
  if (lock?.url && samePath(lock.cwd, ROOT)) candidates.push({ url: lock.url, owned: true });
  if (!candidates.some((c) => c.url === defaultUrl)) candidates.push({ url: defaultUrl, owned: false });

  for (const { url, owned } of candidates) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
        if (!res.ok) break;
        // 锁文件证明是我们的进程；没有锁时只敢认「页面里有项目名」的，避免把别人的 3000 当成自己。
        if (owned) return url;
        const marker = PROJECT_NAME.split("-")[0];
        if (marker.length >= 4 && (await res.text()).toLowerCase().includes(marker)) return url;
        break;
      } catch {
        await sleep(600); // 刚起来还没接手请求，再给一次机会
      }
    }
  }
  return null;
}

/* ---------- 启动 ---------- */
function openBrowser(url) {
  // 调试/自动化时不想被弹窗打扰：LAUNCH_NO_OPEN=1
  if (process.env.LAUNCH_NO_OPEN === "1") return false;
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
  return true;
}

function tsxArgs(script, ...args) {
  const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  return existsSync(tsxCli)
    ? [tsxCli, script, ...args]
    : ["--import", "tsx", script, ...args];
}

/** 后台进程输出带前缀，和开发服务器共用启动窗口。 */
function pipeWithPrefix(stream, label) {
  if (!stream) return;
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) console.log(`[${label}] ${line}`);
  });
}

function runDev(yarnCmd, devUrl, runtimeEnv) {
  const useYarn = Boolean(yarnCmd);
  const cmd = useYarn ? yarnCmd : "npx";
  const args = useYarn ? ["dev"] : ["nuxt", "dev", "--open"];

  console.log("");
  console.log(`${cyan("▶")} 启动开发服务器：${dim(`${cmd} ${args.join(" ")}`)}`);
  console.log(`  ${dim(`地址 ${devUrl}　·　Ctrl+C 或关掉窗口即停止`)}`);
  const qqScript = path.join(ROOT, "scripts", "start-qq.bat");
  if (existsSync(qqScript)) console.log(`  ${dim("QQ 群链路是另一个脚本：scripts\\start-qq.bat")}`);
  console.log("");

  return new Promise((resolve) => {
    // 默认启动共享 Worker，确保本地默认启动路径也会消费记忆、社交和成长事件队列。
    // 只想启动 Web 时可设置 YILING_WORKER_DISABLED=1。
    let worker = null;
    if (runtimeEnv.YILING_WORKER_DISABLED !== "1") {
      worker = spawn(process.execPath, tsxArgs("scripts/run-memory-worker.ts", "--watch"), {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        env: runtimeEnv,
      });
      pipeWithPrefix(worker.stdout, "worker");
      pipeWithPrefix(worker.stderr, "worker");
      worker.once("error", (err) => console.error(red(`[worker] 启动失败：${err.message}`)));
      worker.once("exit", (code) => {
        if (code !== 0 && code !== null) console.error(red(`[worker] 已退出，退出码 ${code}`));
      });
    } else {
      warn("YILING_WORKER_DISABLED=1：本次不启动后台 Worker");
    }

    const child = spawn(cmd, args, {
      cwd: ROOT,
      stdio: "inherit",
      shell: true,
      env: { ...runtimeEnv, FORCE_COLOR: "1" },
    });
    let settled = false;
    const stopWorker = () => {
      if (worker && !worker.killed) worker.kill("SIGTERM");
    };
    // Ctrl+C 在本控制台会同时发给子进程；Worker 不继承控制台输入，所以单独收尾。
    const forward = (signal) => {
      if (!child.killed) child.kill(signal);
      stopWorker();
    };
    process.once("SIGINT", () => forward("SIGINT"));
    process.once("SIGTERM", () => forward("SIGTERM"));
    child.once("exit", (code, signal) => {
      stopWorker();
      if (!settled) {
        settled = true;
        resolve(signal ? 0 : (code ?? 1));
      }
    });
    child.once("error", (err) => {
      stopWorker();
      if (!settled) {
        settled = true;
        console.error(red(`起不来：${err.message}`));
        resolve(1);
      }
    });
  });
}

/* ---------- 主流程 ---------- */
async function main() {
  console.log("");
  console.log(cyan(`  ${APP_LABEL}`));
  console.log(dim(`  一键启动：环境自检 → 数据库 → 开发服务器　${dim(`(${PROJECT_NAME})`)}`));
  console.log("");

  step(1, "环境自检");
  checkNode();
  ok(`Node v${process.versions.node}`);
  const env = loadEnv();
  ok(".env 已就位");

  const port = Number(env.PORT || env.NUXT_PORT || 0) || DEFAULT_PORT;
  const devUrl = `http://127.0.0.1:${port}`;

  // 搬去新仓库时先体检一遍：只看推导出来的参数对不对，不动数据库、不起服务。
  if (process.env.LAUNCH_DRY_RUN === "1") {
    ok(`项目名 ${PROJECT_NAME}（显示为 ${APP_LABEL}）`);
    ok(`数据库容器 ${detectDbContainer()}`);
    ok(`开发端口 ${port}　·　Prisma 生成物 ${findPrismaClient() ?? "未找到（启动时会补生成）"}`);
    console.log("");
    console.log(dim("  LAUNCH_DRY_RUN=1：只体检，没连数据库、没起服务。"));
    return 0;
  }

  const yarnCmd = ensureYarn();
  ensureDeps(yarnCmd);
  ok("依赖与 Prisma Client 齐全");

  await ensureDatabase(env);

  step(3, `检查 ${port} 端口`);
  const running = await findRunningDevServer(devUrl);
  if (running) {
    ok(`服务已经在跑：${running}`);
    const opened = openBrowser(running);
    console.log("");
    console.log(
      green(
        opened
          ? "  已打开浏览器，不用再起一个。要重启就先关掉原来的那个窗口。"
          : "  不用再起一个。要重启就先关掉原来的那个窗口。",
      ),
    );
    return 0;
  }
  if (await pingPort("127.0.0.1", port)) {
    warn(`端口 ${port} 被别的程序占着，Nuxt 会自动换下一个端口，看下面它自己打印的地址`);
  } else {
    ok("端口空闲");
  }

  step(4, "开始运行");
  return runDev(yarnCmd, devUrl, { ...env, ...process.env });
}

try {
  process.exitCode = await main();
} catch (err) {
  console.log("");
  bad(err instanceof Error ? err.message : String(err));
  console.log("");
  console.log(dim("  修完再双击一次这个文件即可。"));
  process.exitCode = 1;
}
