import type { PrismaClient } from "../../src/generated/prisma/client";
import { MEMORY_JOB_LEASE_MS } from "./memory-job-lease";
import { eventMessageWhere } from "./memory-event-source";

/** Manual queueing shares the scheduler's keys; it never creates click-specific jobs. */
export async function queueManualMemoryEvents(
  prisma: Pick<PrismaClient, "message" | "memoryJob" | "memoryEventDay" | "$queryRaw" | "$executeRaw">,
  input: {
    memoryScopeId: string; privateOnly: boolean; dayKey: string;
    idempotencyKey: string; periodStart: Date; periodEnd: Date;
    hourly: boolean; now: Date;
  },
): Promise<string | null> {
  const where = eventMessageWhere({ ...input, progress: null });
  if (!await prisma.message.findFirst({ where, select: { id: true } })) return null;
  const created = await prisma.memoryJob.createMany({
    data: [{
      memoryScopeId: input.memoryScopeId, type: "EXTRACT_EVENTS",
      idempotencyKey: input.idempotencyKey, periodStart: input.periodStart,
      periodEnd: input.periodEnd, status: "QUEUED", runAt: input.now,
    }],
    skipDuplicates: true,
  });
  // Keep PostgreSQL's full microsecond version: JS Date truncates legacy timestamps.
  const [job] = await prisma.$queryRaw<Array<{
    id: string; memoryScopeId: string; type: string; status: string;
    lockedAt: Date | null; updatedAt: Date; version: string;
  }>>`SELECT id, "memoryScopeId", type, status, "lockedAt", "updatedAt", "updatedAt"::text AS version
      FROM memory_jobs WHERE "idempotencyKey" = ${input.idempotencyKey}`;
  if (!job || job.memoryScopeId !== input.memoryScopeId || job.type !== "EXTRACT_EVENTS") return null;
  if (created.count) return job.id;
  const waiting = job.status === "QUEUED" || job.status === "RETRY_WAIT";
  const completedHour = input.hourly && (job.status === "SUCCEEDED" || job.status === "SKIPPED");
  /**
   * 手动点击就是人工重试的唯一入口，失败的、被连带取消的都能再跑一次。
   *
   * 以前这里只放行「等待中」和「今天已整理但又有新消息」，于是模型超时或没配好时，
   * 任务落成 FAILED，用户再点「立即整理忆泡」拿到的是 `null`，页面回一句
   * 「昨天和今天都还没有对话，没什么可整理的」—— 对话明明在，只是上一次没跑成。
   * 想重试只能绕去任务监控页，那不叫「再整理一次」。
   *
   * 放宽不会让失败任务被自动重排：调度器不走这个函数（它用 `missingDays` 那套 SQL，
   * 按状态一律不复制），只有用户真的点了按钮才会走到这里。
   */
  const retrying = job.status === "FAILED" || job.status === "CANCELLED";
  /**
   * 租约过期的「运行中」也算可以重来：那是「领走它的进程已经不在了」，不是「正在跑」。
   *
   * 和任务监控的「重新入队」用同一个 5 分钟（`MEMORY_JOB_LEASE_MS`）：三处判定必须
   * 一致，否则页面上标着「卡住」、按钮却坚持「正在整理」。没过期的运行中一律不抢 ——
   * 那一边真的在等模型。回收后旧执行者即使返回也会被 fencing token 拒绝。
   */
  const staleBefore = new Date(input.now.getTime() - MEMORY_JOB_LEASE_MS);
  const reclaiming = job.status === "RUNNING" && (!job.lockedAt || job.lockedAt.getTime() < staleBefore.getTime());
  if (!waiting && !completedHour && !retrying && !reclaiming) return null;
  if (completedHour) {
    const progress = await prisma.memoryEventDay.findUnique({
      where: { memoryScopeId_dayKey: { memoryScopeId: input.memoryScopeId, dayKey: input.dayKey } },
      select: { extractedAt: true, extractedMessageId: true },
    });
    if (!await prisma.message.findFirst({
      where: eventMessageWhere({ ...input, progress }), select: { id: true },
    })) return null;
  }
  // 重新开跑的那几种状态都要把上一次的痕迹清干净，否则 attemptCount 会接着上次往下扣。
  const resetRun = completedHour || retrying || reclaiming;
  // CAS prevents a stale request from changing a worker's claim or a user's cancellation.
  // Force a different timestamp even when two operations happen within one millisecond.
  const updatedAt = new Date(Math.max(input.now.getTime(), job.updatedAt.getTime() + 1));
  const changed = await prisma.$executeRaw`
    UPDATE memory_jobs SET status = 'QUEUED', "runAt" = ${input.now},
      "lockedAt" = NULL, "lockedBy" = NULL, "updatedAt" = ${updatedAt},
      "attemptCount" = CASE WHEN ${resetRun} THEN 0 ELSE "attemptCount" END,
      "startedAt" = CASE WHEN ${resetRun} THEN NULL ELSE "startedAt" END,
      "completedAt" = CASE WHEN ${resetRun} THEN NULL ELSE "completedAt" END,
      "lastError" = CASE WHEN ${resetRun} THEN NULL ELSE "lastError" END
    WHERE id = ${job.id}::uuid AND status::text = ${job.status}
      AND "updatedAt" = ${job.version}::timestamptz
      AND (${reclaiming}::boolean = false OR "lockedAt" IS NULL OR "lockedAt" < ${staleBefore}::timestamptz)`;
  return changed ? job.id : null;
}
