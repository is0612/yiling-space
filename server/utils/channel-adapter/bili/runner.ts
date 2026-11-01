/**
 * bili CLI 执行器 —— 从 bili-desk 的 runner.py / subproc.py / netenv.py 迁移而来。
 *
 * 一次调用 = 一个 `bili <argv...>` 子进程 + 一段 stdout（尝试解析为 JSON）。
 * Node 后端用 child_process.spawn 调用，跨平台处理：
 *   - Windows 上隐藏控制台窗口（对应 bili-desk 的 CREATE_NO_WINDOW / SW_HIDE）。
 *   - 探测代理端口，连不上就摘掉代理变量改直连（对应 netenv.py，避免 ProxyError 502）。
 */

import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type BiliRunResult = {
  code: number | null;
  json: unknown;
  stdout: string;
  stderr: string;
  elapsed: number;
  argv: string[];
  timedOut: boolean;
};

export type BiliRunOptions = {
  /** 超时毫秒，默认 240 秒。 */
  timeoutMs?: number;
  /** 工作目录。 */
  cwd?: string;
  /** 追加的环境变量。 */
  env?: Record<string, string>;
  /** bili 可执行文件路径；缺省从环境变量 BILI_BIN 或 PATH 里找。 */
  bin?: string;
};

const DEFAULT_TIMEOUT_MS = 240_000;

// bili 不是 npm 依赖，是 PyPI 上一个独立的 CLI（`bili-agent`）。新人跑完 yarn setup
// 之后这里仍然是空的，所以「装它」的这条命令要在报错、自检、文档里指向同一份文案。
// 平台差异只在这一个函数里收口。
export function biliInstallCommand(): string {
  const python = process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python";
  return `uv venv .venv && uv pip install --python ${python} bili-agent==0.6.0`;
}

/** 找 bili 时它可能藏在哪里 —— 决定报错文案要说「没装」还是「路径配错了」。 */
export type BiliBinSource = "connection" | "env" | "venv" | "path" | "missing";

export type BiliBinProbe = {
  /** 实际拿去 spawn 的路径；source 是 missing 时是裸命令名，spawn 必然 ENOENT。 */
  bin: string;
  /** 文件是否真实存在。false 时不必再 spawn，直接判缺失。 */
  found: boolean;
  source: BiliBinSource;
};

/** 显式写的值到底是路径还是裸命令名：带分隔符或有盘符的一律按路径处理。 */
function looksLikePath(value: string): boolean {
  return /[/\\]/.test(value) || /^[A-Za-z]:/.test(value);
}

/**
 * 扫 PATH 找 bili。
 *
 * 不用 spawn 去碰运气，是因为 Windows 的 PATHEXT 会把裸命令名解析成 .exe/.cmd/.bat，
 * 而我们要在 spawn 之前就知道「在不在」—— 这决定了报错文案指向安装还是指向路径。
 */
function findInPath(): string | null {
  const raw = process.env.PATH ?? process.env.Path ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const names = process.platform === "win32" ? ["bili.exe", "bili.cmd", "bili.bat"] : ["bili"];
  for (const entry of raw.split(sep)) {
    // 注册表里残留的 PATH 段可能带引号或尾部空格
    const dir = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * 探测 bili 可执行文件，查找顺序（对齐 bili-desk 的 paths.py）：
 *   0. 连接配置里的 biliBin（用户手动指到任意位置，优先级最高）
 *   1. 环境变量 BILI_BIN
 *   2. 本项目 .venv（Windows: .venv/Scripts/bili.exe；Unix: .venv/bin/bili）
 *   3. 回退到 PATH 里的 `bili`
 *
 * bili 是 PyPI 的 `bili-agent` 包（独立安装，不依赖 bili-desk），
 * 装进项目自己的 .venv 后换台机器也不用全局装。
 */
export function probeBiliBin(preferred?: string): BiliBinProbe {
  const explicit = preferred?.trim();
  if (explicit) {
    // 显式指定的一律照用，不回退到别处 —— 用户指的路径要是错了，
    // 换一个「别处的 bili」跑起来反而更难查。裸命令名当作「交给系统解析」。
    const found = existsSync(explicit) || !looksLikePath(explicit);
    return { bin: explicit, found, source: found ? "connection" : "missing" };
  }

  const fromEnv = process.env.BILI_BIN?.trim();
  if (fromEnv) {
    const found = existsSync(fromEnv) || !looksLikePath(fromEnv);
    return { bin: fromEnv, found, source: found ? "env" : "missing" };
  }

  const root = process.cwd();
  const candidates =
    process.platform === "win32"
      ? [join(root, ".venv", "Scripts", "bili.exe"), join(root, ".venv", "Scripts", "bili")]
      : [join(root, ".venv", "bin", "bili")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { bin: candidate, found: true, source: "venv" };
  }

  const viaPath = findInPath();
  if (viaPath) return { bin: viaPath, found: true, source: "path" };

  return { bin: "bili", found: false, source: "missing" };
}

/** 只要路径的老接口，给不关心来源的调用方用。 */
function resolveBiliBin(): string {
  return probeBiliBin().bin;
}

// ---------------------------------------------------------------------------
// 代理处理：机器上残留了死代理时，bili 子进程会撞上 ProxyError 502。
// 起子进程前探一下代理端口，连不上就摘掉 http_proxy / https_proxy / all_proxy。
// ---------------------------------------------------------------------------

const PROXY_KEYS = ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"];

// 光看端口通不通不够：端口活着也可能是个 SOCKS 口，或者代理自己连不上上游
// （那正是 `ProxyError: 502 Bad Gateway` 的来源）。所以再发一次 CONNECT 探针，
// 代理真能建立到 B站 的隧道才认为可用。对齐 bili-desk 的 netenv.py。
const PROBE_TARGET = "api.bilibili.com:443";

function hostPort(value: string): { host: string; port: number } | null {
  const raw = (value || "").trim();
  if (!raw) return null;
  let withScheme = raw;
  if (!withScheme.includes("://")) withScheme = "http://" + withScheme;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (!u.hostname) return null;
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  return { host: u.hostname, port };
}

function proxyAlive(value: string): Promise<boolean> {
  const hp = hostPort(value);
  if (!hp) return Promise.resolve(false);
  return new Promise((resolve) => {
    // 第一步：TCP 连通性（代理软件没开的情况，0.4 秒连不上基本就是没开）。
    const sock = createConnection({ host: hp.host, port: hp.port, timeout: 400 });
    sock.once("connect", () => {
      // 第二步：发 CONNECT 探针，确认代理能真正建立到 B站 的隧道。
      // 200 = 隧道通；407 = 要认证但代理本身好。5xx = 代理连不上上游，不能信。
      const request = `CONNECT ${PROBE_TARGET} HTTP/1.1\r\nHost: ${PROBE_TARGET}\r\nProxy-Connection: keep-alive\r\n\r\n`;
      sock.write(request);
      sock.setTimeout(1500);
      let buf = "";
      sock.on("data", (data: Buffer) => {
        buf += data.toString("utf8");
        const head = buf.split("\r\n", 1)[0] || "";
        if (head.startsWith("HTTP/1.")) {
          const ok = head.includes(" 200") || head.includes(" 407");
          sock.destroy();
          resolve(ok);
        }
      });
      sock.once("error", () => resolve(false));
      sock.once("timeout", () => {
        sock.destroy();
        resolve(false);
      });
      sock.once("close", () => resolve(false));
    });
    sock.once("error", () => resolve(false));
    sock.once("timeout", () => {
      sock.destroy();
      resolve(false);
    });
  });
}

async function childEnv(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  env.PYTHONIOENCODING = "utf-8";
  for (const key of PROXY_KEYS) {
    const val = env[key];
    if (val && !(await proxyAlive(val))) {
      delete env[key];
    }
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v) env[k] = v;
  }
  return env;
}

// ---------------------------------------------------------------------------
// 主执行函数
// ---------------------------------------------------------------------------

/** 缺 CLI 时的统一文案：说清「是什么、怎么装」，而不是只说「找不到」。 */
export function biliMissingMessage(bin: string): string {
  return `找不到 bili 可执行文件（${bin}）。B站值班台依赖独立的 bili CLI，在项目根执行：${biliInstallCommand()}；已装在别处的用 BILI_BIN 指过去。详见 docs/bili-desk-integration.md「4.0」。`;
}

export async function runBili(argv: string[], options: BiliRunOptions = {}): Promise<BiliRunResult> {
  const started = Date.now();
  const probe = probeBiliBin(options.bin?.trim() || undefined);
  const bin = probe.bin;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!argv || argv.length === 0) {
    return { code: 2, json: null, stdout: "", stderr: "空命令", elapsed: 0, argv: [], timedOut: false };
  }

  // 已经能确定没有这个文件，就别再 spawn 一次去等 ENOENT 了。
  if (!probe.found) {
    return {
      code: 127,
      json: null,
      stdout: "",
      stderr: biliMissingMessage(bin),
      elapsed: Math.round((Date.now() - started) / 10) / 100,
      argv,
      timedOut: false,
    };
  }

  const env = await childEnv(options.env);

  return new Promise<BiliRunResult>((resolve) => {
    const child = spawn(bin, argv, {
      cwd: options.cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString("utf8");
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const notFound = error.code === "ENOENT";
      resolve({
        code: notFound ? 127 : 125,
        json: null,
        stdout,
        stderr: notFound ? biliMissingMessage(bin) : String(error.message || error),
        elapsed: Math.round((Date.now() - started) / 10) / 100,
        argv,
        timedOut,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const trimmedOut = stdout.trim();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(trimmedOut);
      } catch {
        parsed = null;
      }
      resolve({
        code,
        json: parsed,
        stdout: trimmedOut.slice(-20_000),
        stderr: stderr.trim().slice(-4_000),
        elapsed: Math.round((Date.now() - started) / 10) / 100,
        argv,
        timedOut,
      });
    });
  });
}

/** 只返回 bili 输出的 JSON 部分（等价 bili-desk 的 bili_json）。 */
export async function biliJson(argv: string[], options: BiliRunOptions = {}): Promise<unknown> {
  const result = await runBili(argv, { ...options, timeoutMs: options.timeoutMs ?? 60_000 });
  return result.json;
}

// 导出用于测试
export { resolveBiliBin };
