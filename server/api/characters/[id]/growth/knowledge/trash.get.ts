import { createError, defineEventHandler, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";

/**
 * 当前角色的回收站。
 *
 * 只返回 status=TRASHED 的知识，且强制按 characterId 过滤：
 * 归档（ARCHIVED）不在这里，正常检索也不会返回它们。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const items = await prisma.knowledgeItem.findMany({
    where: { characterId, status: "TRASHED" },
    orderBy: { updatedAt: "desc" },
    take: 100,
    select: {
      id: true, title: true, content: true, category: true, tags: true, confidence: true,
      status: true, sourceType: true, sourceRef: true, revision: true, createdAt: true, updatedAt: true,
    },
  });
  return { characterId, items, itemCount: items.length };
});
