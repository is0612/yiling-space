import "dotenv/config";
import { getPrisma } from "../server/utils/prisma";
import { collectWatchdogFindings, type WatchdogFinding } from "../server/utils/watchdog";

/**
 * 停滞检测的独立进程。
 *
 * 为什么要单独跑，而不是在 Web 里 `setInterval`：项目约束里已经写明正式任务不能依赖
 * Web 进程内的定时器 —— 看门的人不能和可能一起倒下的进程共用一条命。
 *
 * 它只看「产出有没有往前走」：任务卡在运行中没有、队列有没有人认领、该排的周期排了没有、
 * 自动归档是不是长期零产出。不调模型、不写库、不改任何状态，判定逻辑在
 * `server/utils/watchdog.ts`，总览页用的是同一份判定。
 *
 * 用法：
 *   yarn watchdog:run            跑一次，有需要处理的项时退出码为 1（能直接进 cron / 计划任务）
 *   yarn watchdog:run --watch    常驻，每 5 分钟判一次
 *
 * 输出是 JSON 行，方便重定向到日志后 grep。
 */

const INTERVAL_MS = Number(process.env.YILING_WATCHDOG_INTERVAL_MS ?? 5 * 60_000);
const intervalMs = Number.isFinite(INTERVAL_MS) && INTERVAL_MS >= 30_000 ? INTERVAL_MS : 5 * 60_000;
const watch = process.argv.includes("--watch");
let running = true;

process.on("SIGINT", () => { running = false; });
process.on("SIGTERM", () => { running = false; });

function log(record: Record<string, unknown>) {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n");
}

function summarize(findings: WatchdogFinding[]) {
  return {
    err: findings.filter((finding) => finding.severity === "err").length,
    warn: findings.filter((finding) => finding.severity === "warn").length,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const prisma = getPrisma();
  try {
    do {
      const now = new Date();
      try {
        const findings = await collectWatchdogFindings(prisma, now);
        const counts = summarize(findings);
        // 没有问题时也写一行：日志里「昨天没有输出」和「昨天一切正常」必须能区分开。
        log({ event: "watchdog", ok: findings.length === 0, counts, findings });
        if (!watch && counts.err > 0) process.exitCode = 1;
      } catch (error) {
        log({ event: "watchdog-error", error: error instanceof Error ? error.message : String(error) });
        if (!watch) process.exitCode = 1;
      }
      if (!watch || !running) break;
      await sleep(intervalMs);
    } while (running);
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

void main();
