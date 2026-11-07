import { createError, getRouterParam } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";

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
        memoryScope: { select: { character: { select: { id: true } } } },
      },
    });
    if (!job) throw createError({ statusCode: 404, statusMessage: "任务不存在。" });
    if (job.status !== "QUEUED" && job.status !== "RETRY_WAIT") {
      throw createError({ statusCode: 409, statusMessage: "只有等待执行或等待重试的任务可以取消；运行中的任务不能强制终止。" });
    }

    const updated = await tx.memoryJob.updateMany({
      where: { id: job.id, status: job.status },
      data: {
        status: "CANCELLED",
        completedAt: now,
        lockedAt: null,
        lockedBy: null,
        lastError: "任务已由管理员手动取消。",
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
        action: "memory_job.cancelled",
        entityType: "MemoryJob",
        entityId: job.id,
        details: { previousStatus: job.status, type: job.type },
      },
    });
    return { id: job.id, status: "CANCELLED", completedAt: now.toISOString() };
  });
});
