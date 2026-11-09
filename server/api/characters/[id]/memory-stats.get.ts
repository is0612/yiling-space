import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../utils/auth";
import { requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";

/**
 * 记忆系统的几个计数：长期记忆、承诺与约定、已记录对话 / 平台事件、阶段总结、忆泡。
 *
 * 记忆页的统计带只读这几个数字。以前它们跟着 `/timeline?limit=400` 一起回来 ——
 * 为了两行统计把 400 条记忆拉到前端，列表改成分页后这段就该独立出来。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();

  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true },
  });
  if (!character) {
    throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  }

  const conversationWhere = { conversation: { is: { characterId } } };
  const [memory, commitment, message, platformEvent, snapshot, memoryEvent] = await Promise.all([
    prisma.memoryItem.count({
      where: { status: { not: "TRASHED" }, memoryScope: { is: { characterId } } },
    }),
    // 与页面上「承诺与约定 N 项」同一个口径：角色全局范围里还在生效的承诺。
    prisma.memoryItem.count({
      where: {
        category: "COMMITMENT",
        status: "ACTIVE",
        memoryScope: { is: { characterId, scopeType: "CHARACTER_GLOBAL" } },
      },
    }),
    prisma.message.count({ where: conversationWhere }),
    prisma.message.count({ where: { ...conversationWhere, eventType: { not: "message" } } }),
    prisma.memorySnapshot.count({ where: { memoryScope: { is: { characterId } } } }),
    prisma.memoryEvent.count({ where: { status: "ACTIVE", memoryScope: { is: { characterId } } } }),
  ]);

  return { memory, commitment, message, event: platformEvent, snapshot, memoryEvent };
});
