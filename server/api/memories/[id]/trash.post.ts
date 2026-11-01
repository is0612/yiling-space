import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../utils/auth";
import { requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const memoryId = requireUuid(getRouterParam(event, "id") ?? "", "记忆");
  const prisma = getPrisma();
  const existing = await prisma.memoryItem.findFirst({
    where: {
      id: memoryId,
      memoryScope: { is: { character: { is: { ownerId } } } },
    },
    select: { id: true, status: true },
  });

  if (!existing) throw createError({ statusCode: 404, statusMessage: "长期记忆不存在。" });
  if (existing.status === "TRASHED") throw createError({ statusCode: 409, statusMessage: "该记忆已经在回收站。" });

  return prisma.memoryItem.update({
    where: { id: memoryId },
    data: { statusBeforeTrash: existing.status, status: "TRASHED", deletedAt: new Date() },
    select: { id: true, status: true, statusBeforeTrash: true, deletedAt: true, updatedAt: true },
  });
});
