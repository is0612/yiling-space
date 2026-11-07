import { createError, getRouterParam } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";
import { MEMORY_JOB_LEASE_MS, planJobRequeue } from "../../../utils/memory-job-lease";

/**
 * 手动重新入队：失败 / 等待重试 / 已取消的任务照旧放回去；
 * **租约已过期的「运行中」任务也放行** —— 那是「卡住了没人回收」，不是「正在跑」。
 *
 * 别把运行中一律拒掉：Worker 没在跑的时候（比如 `yarn dev` 起的一次性请求被重启打断），
 * 任务会永远停在 RUNNING，页面上却写着「Worker 正在执行」，只能靠重启 Worker 才能解开。
 */
export default defineEventHandler(async (event) => {
  const actor = await requireAdminActor(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "", "任务");
  const now = new Date();
  const prisma = getPrisma();

  return prisma.$transaction(async (tx) => {
    const job = await tx.memoryJob.findFirst({
      where: { id },
      select: {
        id: true,
        type: true,
        status: true,
        attemptCount: true,
        lockedAt: true,
        lockedBy: true,
        memoryScope: { select: { character: { select: { id: true, memorySetting: { select: { rawMessageCleanupEnabled: true, rawMessageRetentionDays: true } } } } } },
      },
    });
    if (!job) throw createError({ statusCode: 404, statusMessage: "任务不存在。" });

    const plan = planJobRequeue(job, now);
    if (!plan.ok) throw createError({ statusCode: 409, statusMessage: plan.message });

    if (
      job.type === "CLEAN_EXPIRED_MESSAGES" &&
      (!job.memoryScope.character.memorySetting?.rawMessageCleanupEnabled ||
        !job.memoryScope.character.memorySetting.rawMessageRetentionDays)
    ) {
      throw createError({ statusCode: 409, statusMessage: "请先在角色记忆设置中明确启用有限期限的原始消息自动清理，再重新入队。" });
    }

    // 回收卡住的任务时，条件用「租约到现在仍然过期」而不是「lockedAt 等于刚才读到的值」：
    // 库里的 lockedAt 是微秒精度、读进内存只剩毫秒，等值比较永远对不上，
    // 而「仍然过期」恰好就是我们要的语义 —— 中间要是被别的 Worker 重新领走（租约变新），这次更新就落空。
    const staleBefore = new Date(now.getTime() - MEMORY_JOB_LEASE_MS);
    const updated = await tx.memoryJob.updateMany({
      where: plan.recoveredLease
        ? { id: job.id, status: "RUNNING", OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }] }
        : { id: job.id, status: job.status },
      data: {
        status: "QUEUED",
        attemptCount: 0,
        runAt: now,
        lockedAt: null,
        lockedBy: null,
        lastError: null,
        startedAt: null,
        completedAt: null,
      },
    });
    if (updated.count !== 1) {
      throw createError({ statusCode: 409, statusMessage: "任务状态已发生变化，请刷新列表后重试。" });
    }

    await tx.auditLog.create({
      data: {
        actorType: "USER",
        actorId: actor.user.id,
        characterId: job.memoryScope.character.id,
        action: "memory_job.manual_retry",
        entityType: "MemoryJob",
        entityId: job.id,
        details: {
          previousStatus: job.status,
          previousAttemptCount: job.attemptCount,
          recoveredLease: plan.recoveredLease,
          previousLockedAt: job.lockedAt?.toISOString() ?? null,
          // 记录是谁把这条任务丢下的：排查「为什么总卡住」时，这一格比时间戳有用
          previousLockedBy: job.lockedBy,
        },
      },
    });
    return { id: job.id, status: "QUEUED", runAt: now.toISOString(), recoveredLease: plan.recoveredLease };
  });
});
