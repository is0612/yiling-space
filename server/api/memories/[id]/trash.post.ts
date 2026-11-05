import { createError, defineEventHandler, getRouterParam } from "h3";
import { requireActorUserId } from "../../../utils/auth";
import { requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const memoryId = requireUuid(getRouterParam(event, "id") ?? "", "记忆");
  const prisma = getPrisma();
  return prisma.$transaction(async (tx) => {
    // Authorize in the locking query, then read the latest state after any lock wait.
    await tx.$queryRaw`
      SELECT m.id FROM memory_items m
      JOIN memory_scopes s ON s.id = m."memoryScopeId"
      JOIN characters c ON c.id = s."characterId"
      WHERE m.id = ${memoryId}::uuid AND c."ownerId" = ${ownerId}::uuid
      FOR UPDATE OF m
    `;
    const existing = await tx.memoryItem.findFirst({
      where: {
        id: memoryId,
        memoryScope: { is: { character: { is: { ownerId } } } },
      },
      select: { id: true, status: true },
    });

    if (!existing) throw createError({ statusCode: 404, statusMessage: "长期记忆不存在。" });
    if (existing.status === "TRASHED") throw createError({ statusCode: 409, statusMessage: "该记忆已经在回收站。" });

    return tx.memoryItem.update({
      where: { id: memoryId },
      data: { statusBeforeTrash: existing.status, status: "TRASHED", deletedAt: new Date() },
      select: { id: true, status: true, statusBeforeTrash: true, deletedAt: true, updatedAt: true },
    });
  });
});
