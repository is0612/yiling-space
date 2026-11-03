import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBiliConnections, type BiliConnectionRecord, type BiliDutyConfig } from "../server/utils/channel-adapter/bili/configure";
import { runDutyRound } from "../server/utils/channel-adapter/bili/duty-pipeline";
import {
  shouldRunDuty,
  toDayKey,
  windowsRunFromTimestamps,
  type BiliDutyState,
} from "../server/utils/channel-adapter/bili/duty-scheduler";
import { createBiliMessageHandler, pollBiliInbox } from "../server/utils/channel-adapter/bili/serve";
import { getPrisma } from "../server/utils/prisma";

const prisma = getPrisma();
let running = true;
const shutdown = () => {
  running = false;
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

/**
 * 「我在跑」的标记文件，和 server/utils/channel-adapter/bili/runtime.ts 里读的是同一个。
 *
 * 两个作用：
 *   1. 网页上能看出适配器在不在跑 —— 它是唯一会「到点自己刷」的东西，没有它，
 *      perDay 和 peakValley 配得再对也一轮都不会发生，而页面此前完全看不出来；
 *   2. 顺手当单实例锁（`docs/B站值班服务器部署清单.md`：两台同时跑会重复刷、重复私信）。
 * 放在 .data/（已在 .gitignore，也不会被 nuxt 重启清空）。
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_FILE = path.join(REPO_ROOT, ".data", "bili-adapter.json");

/** 标记里的 pid 还活着吗。活着返回它，陈旧或读不动返回 null。 */
async function runningPid(): Promise<number | null> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as { pid?: number };
    const pid = typeof parsed.pid === "number" ? parsed.pid : null;
    if (!pid || pid === process.pid) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/**
 * 认领标记文件。已经有实例在跑就返回它的 pid，调用方直接退出。
 *
 * 用 `flag: "wx"` 抢占（不存在才创建）而不是「先读再写」：两个进程几乎同时启动时，
 * 先读再写会双双读到空、双双开跑。
 */
async function claimRunning(): Promise<number | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
      await fs.writeFile(
        STATE_FILE,
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), cwd: REPO_ROOT }),
        { encoding: "utf8", flag: "wx" },
      );
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null; // 写不了就照常跑，别把值班卡死
      const pid = await runningPid();
      if (pid) return pid;
      await fs.rm(STATE_FILE, { force: true });
    }
  }
  return null;
}

/** 退出时清掉标记。别的实例接管了这个文件时不要误删。 */
async function markStopped() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as { pid?: number };
    if (parsed.pid === process.pid) await fs.rm(STATE_FILE, { force: true });
  } catch {
    // 文件不在或读不动都无所谓
  }
}

const SCAN_INTERVAL_MS = Number(process.env.YILING_BILI_DUTY_INTERVAL_MS ?? 60_000);

/**
 * 窗口状态的回溯窗口。
 * 夜间谷时窗口跨午夜（18:00–09:00），只查「今天」的报告会在凌晨丢失昨晚的窗口标记，
 * 于是同一个夜被跑两轮。这里往前多查一天，让 windowsRunFromTimestamps 能重建标记。
 */
const STATE_LOOKBACK_MS = 26 * 60 * 60 * 1000;

function log(record: Record<string, unknown>) {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 正在跑一轮的绑定（防重入；顺序执行下其实不会并发，留着防将来改成并发）。 */
const inFlight = new Set<string>();

/**
 * 从数据库重建今日状态。
 *
 * 老实现这里把 `windowsRun` 写死成 `[]`，而 shouldRunDuty 恰恰靠它判断「这个窗口今天跑过没」，
 * 结果窗口内每分钟都会触发一轮（perDay 只能限条数，限不住频次）。
 * 现在改成从 BiliRoundReport 的创建时间反推，重启后也不会重复刷。
 */
async function refreshState(bindingId: string, config: BiliDutyConfig): Promise<BiliDutyState> {
  const now = new Date();
  const today = toDayKey(now);
  const since = new Date(now.getTime() - STATE_LOOKBACK_MS);
  const reports = await prisma.biliRoundReport.findMany({
    where: { bindingId, createdAt: { gte: since } },
    select: { pickedCount: true, createdAt: true, day: true },
  });
  // 额度按自然日算（每天上限），窗口标记按窗口业务日算（跨午夜同一个夜）
  const resetAt = config.quotaResetAt ? new Date(config.quotaResetAt) : null;
  const picked = reports
    .filter((report) => report.day === today && (!resetAt || report.createdAt >= resetAt))
    .reduce((sum, report) => sum + report.pickedCount, 0);
  return { day: today, picked, windowsRun: windowsRunFromTimestamps(reports.map((report) => report.createdAt)) };
}

async function serveConnection(record: BiliConnectionRecord): Promise<void> {
  // B站连接可能绑定多个角色，逐个绑定服务
  for (const binding of record.bindings) {
    const config = record.duty;
    const now = new Date();

    if (inFlight.has(binding.id)) {
      log({ event: "bili-duty-skip", bindingId: binding.id, reason: "上一轮还没跑完" });
    } else {
      const state = await refreshState(binding.id, config);
      const decision = shouldRunDuty(now, config, state, false);

      if (decision.due && decision.window) {
        inFlight.add(binding.id);
        log({
          event: "bili-duty-start",
          connectionId: record.id,
          bindingId: binding.id,
          window: decision.window,
          picked: state.picked,
          perDay: config.perDay,
          windowsRun: state.windowsRun,
        });
        try {
          const result = await runDutyRound(record, binding);
          log({ event: "bili-duty-done", connectionId: record.id, bindingId: binding.id, ...result });
        } catch (error) {
          log({
            event: "bili-duty-error",
            connectionId: record.id,
            bindingId: binding.id,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          inFlight.delete(binding.id);
        }
      } else {
        log({ event: "bili-duty-idle", bindingId: binding.id, reason: decision.reason });
      }
    }

    // 被动回复：轮询收件箱（私信 / 回复我的评论）
    try {
      const handler = createBiliMessageHandler(record, binding);
      const handled = await pollBiliInbox(record, binding, handler);
      if (handled > 0) {
        log({ event: "bili-inbox-handled", connectionId: record.id, bindingId: binding.id, handled });
      }
    } catch (error) {
      log({
        event: "bili-inbox-error",
        connectionId: record.id,
        bindingId: binding.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function main() {
  const otherPid = await claimRunning();
  if (otherPid) {
    log({ event: "bili-adapter-already-running", pid: otherPid, hint: "已有一个实例在跑，本进程退出（两个实例会重复刷、重复私信）。" });
    await prisma.$disconnect();
    return;
  }

  log({ event: "bili-adapter-start", intervalMs: SCAN_INTERVAL_MS });

  while (running) {
    try {
      const records = await loadBiliConnections();
      if (records.length === 0) {
        log({ event: "bili-no-connections", hint: "请先在「系统管理 → B站值班台」添加账号并绑定角色。" });
      } else {
        for (const record of records) {
          await serveConnection(record);
        }
      }
    } catch (error) {
      log({ event: "bili-scan-error", error: error instanceof Error ? error.message : String(error) });
    }
    await sleep(SCAN_INTERVAL_MS);
  }

  await markStopped();
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error("B站适配器启动失败：", error);
  await markStopped();
  await prisma.$disconnect();
  process.exit(1);
});
