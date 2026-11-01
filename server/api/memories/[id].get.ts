import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../utils/auth";
import { requireUuid } from "../../utils/local-api";
import { getPrisma } from "../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const memoryId = requireUuid(getRouterParam(event, "id") ?? "", "记忆");
  const prisma = getPrisma();
  const memory = await prisma.memoryItem.findFirst({
    where: {
      id: memoryId,
      memoryScope: { is: { character: { is: { ownerId } } } },
    },
    select: {
      id: true,
      category: true,
      content: true,
      status: true,
      confidence: true,
      createdAt: true,
      updatedAt: true,
      sourceMessageId: true,
      sourceSnapshotId: true,
      sourceMessage: {
        select: {
          id: true,
          role: true,
          eventType: true,
          content: true,
          occurredAt: true,
          conversation: { select: { id: true, title: true } },
        },
      },
      sourceSnapshot: {
        select: {
          id: true,
          summary: true,
          periodStart: true,
          periodEnd: true,
          version: true,
          status: true,
        },
      },
    },
  });

  if (!memory) {
    throw createError({ statusCode: 404, statusMessage: "长期记忆不存在。" });
  }
  return memory;
});
