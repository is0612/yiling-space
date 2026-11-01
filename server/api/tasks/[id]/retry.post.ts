import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../utils/auth";
import { requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";

const RETRYABLE_TYPES = new Set(["GENERATE_SNAPSHOT", "REGENERATE_SNAPSHOT", "CLEAN_EXPIRED_MESSAGES", "GENERATE_JOURNAL"]);
const RETRYABLE_STATUSES = new Set(["FAILED", "RETRY_WAIT", "CANCELLED"]);

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "", "任务");
  const now = new Date();
  const prisma = getPrisma();

  return prisma.$transaction(async (tx) => {
    const job = await tx.memoryJob.findFirst({
      where: { id, memoryScope: { is: { character: { is: { ownerId } } } } },
      select: {
        id: true,
        type: true,
        status: true,
        attemptCount: true,
        memoryScope: { select: { character: { select: { id: true, memorySetting: { select: { rawMessageCleanupEnabled: true, rawMessageRetentionDays: true } } } } } },
      },
    });
    if (!job) throw createError({ statusCode: 404, statusMessage: "任务不存在。" });
    if (!RETRYABLE_TYPES.has(job.type)) {
      throw createError({ statusCode: 409, statusMessage: "该任务类型暂时不能手动重试。" });
    }
    if (!RETRYABLE_STATUSES.has(job.status)) {
      throw createError({ statusCode: 409, statusMessage: "只有失败、等待重试或已取消的任务可以手动重新入队。" });
    }
    if (
      job.type === "CLEAN_EXPIRED_MESSAGES" &&
      (!job.memoryScope.character.memorySetting?.rawMessageCleanupEnabled ||
        !job.memoryScope.character.memorySetting.rawMessageRetentionDays)
    ) {
      throw createError({ statusCode: 409, statusMessage: "请先在角色记忆设置中明确启用有限期限的原始消息自动清理，再重新入队。" });
    }

    const updated = await tx.memoryJob.updateMany({
      where: { id: job.id, status: job.status },
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
        actorId: ownerId,
        characterId: job.memoryScope.character.id,
        action: "memory_job.manual_retry",
        entityType: "MemoryJob",
        entityId: job.id,
        details: { previousStatus: job.status, previousAttemptCount: job.attemptCount },
      },
    });
    return { id: job.id, status: "QUEUED", runAt: now.toISOString() };
  });
});
