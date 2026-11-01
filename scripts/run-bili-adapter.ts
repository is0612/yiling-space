import "dotenv/config";
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

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error("B站适配器启动失败：", error);
  await prisma.$disconnect();
  process.exit(1);
});
