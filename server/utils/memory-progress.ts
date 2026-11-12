import type { PrismaClient } from "../../src/generated/prisma/client";
import { eventMessageWhere } from "./memory-event-source";
import { isMemoryJobLeaseExpired } from "./memory-job-lease";

/**
 * 手动触发的记忆任务，在跑的时候到底跑到哪了。
 *
 * 两个按钮（「立即整理忆泡」「立即 AI 归档」）都是**在 HTTP 请求里当场执行**的，
 * 慢的时候几十秒到几分钟，页面只能转个圈 —— 一旦切走，圈也没了，用户以为被中断。
 * 这里把进度从数据库里算出来：任务行本身就在，进度不该只存在于那个请求里。
 *
 * 两类任务能说的东西不一样，不能糊成同一个百分比：
 * - **忆泡按天整理**是**分块**提交的：每块落库时同时推进 `memory_event_days` 的游标。
 *   所以「已处理消息 / 这段一共多少条」是真实进度，可以画确定进度条；
 * - **阶段总结**是整个周期一次模型调用，中间没有任何可观测的中间态。
 *   这里只给「正在调模型 + 已用时」，画不确定进度条 —— 编一个百分比才是骗人。
 */

const RECENT_FINISHED_MS = 90_000;
/** 一次只算这么多条运行中任务的消息数，避免面板每秒轮询时把库拖慢。 */
const MAX_PROGRESS_JOBS = 6;

export type MemoryProgressJob = {
  id: string;
  type: "GENERATE_SNAPSHOT" | "EXTRACT_EVENTS";
  status: string;
  characterId: string;
  characterName: string;
  label: string;
  /** 已处理消息数；`null` 表示这条任务算不出比例（例如阶段总结）。 */
  done: number | null;
  total: number | null;
  /** 忆泡已写入条数；阶段总结没有这个概念。 */
  eventCount: number | null;
  startedAt: string | null;
  updatedAt: string;
  runAt: string;
  attemptCount: number;
  maxAttempts: number;
  /** 运行中但租约过期：领走它的进程可能已经不在了，面板会标「卡住」。 */
  leaseExpired: boolean;
  lastError: string | null;
};

function dayText(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", { timeZone, month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    return date.toISOString().slice(5, 10);
  }
}

function localDayKey(date: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(date);
    const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    return `${read("year")}-${read("month")}-${read("day")}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function scopeSuffix(scopeType: string): string {
  if (scopeType === "USER_PRIVATE") return "（主人私聊）";
  if (scopeType === "EXTERNAL_IDENTITY") return "（私聊）";
  return "";
}

export async function listMemoryProgress(
  prisma: PrismaClient,
  options: { ownerId: string; now?: Date; characterId?: string; type?: "GENERATE_SNAPSHOT" | "EXTRACT_EVENTS" },
): Promise<MemoryProgressJob[]> {
  const now = options.now ?? new Date();
  const jobs = await prisma.memoryJob.findMany({
    where: {
      memoryScope: { is: { ...(options.characterId ? { characterId: options.characterId } : {}), character: { is: { ownerId: options.ownerId } } } },
      type: options.type ?? { in: ["GENERATE_SNAPSHOT", "EXTRACT_EVENTS"] },
      ...(!options.characterId ? { OR: [
        { status: { in: ["QUEUED", "RUNNING", "RETRY_WAIT"] } },
        // 全局面板仅保留刚结束的任务；角色弹窗可看最近历史失败。
        { completedAt: { gte: new Date(now.getTime() - RECENT_FINISHED_MS) } },
      ] } : {}),
    },
    orderBy: [{ createdAt: options.characterId ? "desc" : "asc" }],
    take: 20,
    select: {
      id: true,
      memoryScopeId: true,
      type: true,
      status: true,
      idempotencyKey: true,
      periodStart: true,
      periodEnd: true,
      startedAt: true,
      updatedAt: true,
      runAt: true,
      attemptCount: true,
      maxAttempts: true,
      completedAt: true,
      lockedAt: true,
      lastError: true,
      memoryScope: {
        select: {
          scopeType: true,
          character: {
            select: { id: true, name: true, memorySetting: { select: { timezone: true } } },
          },
        },
      },
    },
  });

  const rows: MemoryProgressJob[] = [];
  let progressBudget = MAX_PROGRESS_JOBS;

  for (const job of jobs) {
    // 两类任务都有周期；真有不带的（历史脏数据）就跳过，面板不该因为一条脏行整块报错。
    if (!job.periodStart || !job.periodEnd) continue;
    const periodStart = job.periodStart;
    const periodEnd = job.periodEnd;
    const timeZone = job.memoryScope.character.memorySetting?.timezone ?? "Asia/Shanghai";
    const scopeType = job.memoryScope.scopeType;
    const isExtract = job.type === "EXTRACT_EVENTS";
    const finalize = job.idempotencyKey.startsWith("events-final:");
    const label = isExtract
      ? `忆泡整理 · ${dayText(periodStart, timeZone)} ${finalize ? "收口" : "增量"}${scopeSuffix(scopeType)}`
      : `阶段总结 · ${dayText(periodStart, timeZone)} — ${dayText(periodEnd, timeZone)}${scopeSuffix(scopeType)}`;

    let done: number | null = null;
    let total: number | null = null;
    let eventCount: number | null = null;

    /**
     * 只给「正在跑」的忆泡任务算比例：排队中的一定是 0，跑完的没有意义。
     * 每条要两次 count（存量 + 游标之后），所以有预算上限。
     */
    if (isExtract && job.status === "RUNNING" && progressBudget > 0) {
      progressBudget -= 1;
      const dayKey = localDayKey(periodStart, timeZone);
      try {
        const day = await prisma.memoryEventDay.findUnique({
          where: { memoryScopeId_dayKey: { memoryScopeId: job.memoryScopeId, dayKey } },
          select: { extractedAt: true, extractedMessageId: true, eventCount: true },
        });
        const [all, remaining] = await Promise.all([
          prisma.message.count({
            where: eventMessageWhere({
              memoryScopeId: job.memoryScopeId,
              privateOnly: scopeType === "EXTERNAL_IDENTITY",
              periodStart,
              periodEnd,
              progress: null,
            }),
          }),
          prisma.message.count({
            where: eventMessageWhere({
              memoryScopeId: job.memoryScopeId,
              privateOnly: scopeType === "EXTERNAL_IDENTITY",
              periodStart,
              periodEnd,
              progress: day,
            }),
          }),
        ]);
        total = all;
        done = Math.max(0, all - remaining);
        eventCount = day?.eventCount ?? 0;
      } catch {
        // 进度只是显示用：算不出来就退回「正在跑」，绝不能让面板 500。
      }
    }

    rows.push({
      id: job.id,
      type: isExtract ? "EXTRACT_EVENTS" : "GENERATE_SNAPSHOT",
      status: job.status,
      characterId: job.memoryScope.character.id,
      characterName: job.memoryScope.character.name,
      label,
      done,
      total,
      eventCount,
      startedAt: job.startedAt?.toISOString() ?? null,
      updatedAt: job.updatedAt.toISOString(),
      runAt: job.runAt.toISOString(),
      attemptCount: job.attemptCount,
      maxAttempts: job.maxAttempts,
      leaseExpired: job.status === "RUNNING" && isMemoryJobLeaseExpired(job.lockedAt, now),
      lastError: job.lastError,
    });
  }

  // 先跑完的排在后面，面板从上往下就是「最该看的在上面」。
  return rows.sort((left, right) => {
    const rank = (status: string) => (status === "RUNNING" ? 0 : status === "QUEUED" || status === "RETRY_WAIT" ? 1 : 2);
    return rank(left.status) - rank(right.status) || left.updatedAt.localeCompare(right.updatedAt);
  });
}
