import type { PrismaClient } from "../../../../src/generated/prisma/client";
import type { BiliWindowKey } from "./duty-scheduler";

export type BiliScheduledWindow = {
  businessDay: string;
  windowKey: BiliWindowKey;
};

type BiliWindowRunPrisma = Pick<PrismaClient, "biliDutyWindowRun">;

function windowRunUniqueKey(bindingId: string, window: BiliScheduledWindow) {
  return {
    bindingId_businessDay_windowKey: {
      bindingId,
      businessDay: window.businessDay,
      windowKey: window.windowKey,
    },
  };
}

/**
 * 在已取得 binding 执行租约后，先持久化本次计划窗口。
 *
 * 同一窗口唯一一行。即使流水线因「没有候选」等情况提前返回而没有日报，
 * 调度器也能知道该窗口已经尝试过；进程崩溃留下的 RUNNING 行同样阻止自动重放，
 * 避免无法判断外部动作是否已发生时再次评论/私信/互动。
 */
export async function startBiliDutyWindowRun(
  prisma: BiliWindowRunPrisma,
  bindingId: string,
  window: BiliScheduledWindow,
  leaseToken: string,
): Promise<void> {
  await prisma.biliDutyWindowRun.upsert({
    where: windowRunUniqueKey(bindingId, window),
    create: {
      bindingId,
      businessDay: window.businessDay,
      windowKey: window.windowKey,
      status: "RUNNING",
      attemptCount: 1,
      leaseToken,
      startedAt: new Date(),
    },
    update: {
      status: "RUNNING",
      attemptCount: { increment: 1 },
      leaseToken,
      startedAt: new Date(),
      finishedAt: null,
      lastError: null,
    },
  });
}

/** 只有当前租约 token 能结束该窗口记录；旧执行者不能覆盖接管者的状态。 */
export async function completeBiliDutyWindowRun(
  prisma: BiliWindowRunPrisma,
  bindingId: string,
  window: BiliScheduledWindow,
  leaseToken: string,
  lastError: string | null,
): Promise<boolean> {
  const result = await prisma.biliDutyWindowRun.updateMany({
    where: {
      ...windowRunUniqueKey(bindingId, window).bindingId_businessDay_windowKey,
      status: "RUNNING",
      leaseToken,
    },
    data: {
      status: "COMPLETED",
      finishedAt: new Date(),
      lastError: lastError?.slice(0, 2000) ?? null,
    },
  });
  return result.count === 1;
}

/** 异常结束也保留窗口占用；同一窗口不自动重放未知副作用，留给手动恢复或下个窗口。 */
export async function failBiliDutyWindowRun(
  prisma: BiliWindowRunPrisma,
  bindingId: string,
  window: BiliScheduledWindow,
  leaseToken: string,
  error: unknown,
): Promise<boolean> {
  const message = error instanceof Error ? error.message : String(error);
  const result = await prisma.biliDutyWindowRun.updateMany({
    where: {
      ...windowRunUniqueKey(bindingId, window).bindingId_businessDay_windowKey,
      status: "RUNNING",
      leaseToken,
    },
    data: {
      status: "FAILED",
      finishedAt: new Date(),
      lastError: message.slice(0, 2000),
    },
  });
  return result.count === 1;
}

/**
 * 任何已开始的窗口尝试都计入 windowsRun。
 *
 * 特别是没有候选/配置错误/认证失败这类正常提前返回，以及进程崩溃留下的 RUNNING，
 * 都不能只因没有 BiliRoundReport 而在下一次 60 秒扫描时重复启动。
 */
export async function readBiliDutyWindowRunMarks(
  prisma: BiliWindowRunPrisma,
  bindingId: string,
  since: Date,
): Promise<string[]> {
  const rows = await prisma.biliDutyWindowRun.findMany({
    where: { bindingId, createdAt: { gte: since } },
    select: { businessDay: true, windowKey: true },
  });
  return [...new Set(rows.map((row) => `${row.businessDay}:${row.windowKey}`))];
}
