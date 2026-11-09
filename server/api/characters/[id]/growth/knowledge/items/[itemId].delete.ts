import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../../../utils/auth";
import { requireUuid } from "../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../utils/prisma";
import { parsePurgeBody, purgeKnowledgeItem } from "../../../../../../utils/knowledge-lifecycle";

/**
 * 永久删除回收站里的知识。
 *
 * 三重闸门：必须是 TRASHED、必须带 confirm=PERMANENT_DELETE、必须没有 MERGED_INTO 审计关系。
 * 关系与版本历史在同一事务内清理，不会留下孤立关系。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const itemId = requireUuid(getRouterParam(event, "itemId") ?? "", "正式知识");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const { expectedRevision } = parsePurgeBody(await readBody(event));
  const result = await prisma.$transaction(tx => purgeKnowledgeItem(tx, {
    characterId, itemId, expectedRevision,
  }));
  return { ok: true, ...result, message: "知识已永久删除。" };
});
