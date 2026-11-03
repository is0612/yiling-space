import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * 值班适配器（`yarn bili:run`）在不在跑。
 *
 * 为什么需要这个：B站 的「值班」有三层开关，任何一层没到位都表现为「页面一切正常、
 * 但一轮都没跑过」——
 *   1. 连接上 perDay > 0（配额没关）；
 *   2. 连接上 peakValley = true（谷时自动调度，关掉就只能手动点「现在跑一轮」）；
 *   3. **适配器进程在跑**（真正判断「现在到窗口了吗」并触发那一轮的只有它）。
 * 前两层都存在库里，页面能读；第三层以前完全看不出来 —— 数据库里没有它的任何痕迹，
 * 于是 2026-11-03 出现「值班开着、3 天没跑、点去处理又没东西可处理」这种局面：
 * 用户以为是功能坏了，其实是终端里那个进程根本没起。
 *
 * 判定方式和 onebot 适配器一致：进程启动时写一个「我在跑」的标记文件（`.data/bili-adapter.json`），
 * 读的时候再用 `process.kill(pid, 0)` 探活。标记文件同时兼任**单实例锁** ——
 * `docs/B站值班服务器部署清单.md` 里明确写了「两台同时跑会重复刷、重复私信」。
 */
export type BiliAdapterStatus = {
  running: boolean;
  pid?: number;
  startedAt?: string;
};

function adapterStateFile(): string {
  return path.join(process.cwd(), ".data", "bili-adapter.json");
}

export async function readBiliAdapterStatus(): Promise<BiliAdapterStatus> {
  try {
    const raw = await fs.readFile(adapterStateFile(), "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown; startedAt?: unknown };
    const pid = Number(parsed.pid);
    if (!Number.isInteger(pid) || pid <= 0) return { running: false };
    try {
      // 只探活，不真的发信号；进程没了会抛 ESRCH
      process.kill(pid, 0);
    } catch {
      return { running: false };
    }
    return {
      running: true,
      pid,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : undefined,
    };
  } catch {
    return { running: false };
  }
}

/**
 * 在项目根目录开一个命令行窗口跑 `yarn bili:run`。
 *
 * 和 onebot 的「启动适配器」同一套做法：独立控制台（detached），不挂在 nuxt 底下 ——
 * dev server 每次热重启都会带走子进程，而值班要长期跑。窗口里能看到每分钟一条
 * `bili-duty-idle`（带跳过原因），关掉窗口就是停。
 *
 * 网页只管「把终端拉起来」，不做 supervise、不去 kill：进程崩了要人来判断原因，
 * 悄悄重启会把 `risk_control` 这类需要立刻停手的情况盖成「看起来一切正常」。
 */
export async function launchBiliAdapter(): Promise<{ ok: boolean; pid?: number; message?: string }> {
  const current = await readBiliAdapterStatus();
  if (current.running) {
    return { ok: true, pid: current.pid, message: "值班适配器已经在跑，不用再开一个（两个实例会重复刷、重复私信）。" };
  }
  if (process.platform !== "win32") {
    return { ok: false, message: "自动开终端只做了 Windows 版，请手动在项目根目录运行 yarn bili:run。" };
  }
  try {
    const child = spawn("cmd.exe", ["/k", "yarn", "bili:run"], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "启动终端失败，请手动运行 yarn bili:run。",
    };
  }
}
