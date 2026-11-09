import { createError, defineEventHandler, getQuery, getRouterParam } from "h3";
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

  const query = getQuery(event);
  const keyword = typeof query.q === "string" ? query.q.trim().slice(0, 100) : "";
  const page = Math.max(1, Math.min(10000, Number.parseInt(String(query.page ?? "1"), 10) || 1));
  const pageSize = 30;
  const where = {
    characterId,
    status: "TRASHED" as const,
    ...(keyword ? { OR: [{ title: { contains: keyword, mode: "insensitive" as const } }, { content: { contains: keyword, mode: "insensitive" as const } }, { tags: { has: keyword } }] } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.knowledgeItem.findMany({
    where,
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * pageSize,
    take: pageSize,
    select: {
      id: true, title: true, content: true, category: true, tags: true, confidence: true,
      status: true, sourceType: true, sourceRef: true, revision: true, createdAt: true, updatedAt: true,
    },
    }),
    prisma.knowledgeItem.count({ where }),
  ]);

  // `canPermanentlyDelete` 只是给页面用的展示派生字段：条目只要作为 MERGED_INTO 的
  // 源或目标出现过，就属于合并审计链，页面据此禁用「永久删除」并给出说明。
  // 前端判断不可信，永久删除接口仍会在事务内重新检查同一关系，见 knowledge-lifecycle.ts。
  const itemIds = items.map(item => item.id);
  const auditRelations = itemIds.length
    ? await prisma.knowledgeItemRelation.findMany({
        where: {
          characterId,
          relationType: "MERGED_INTO",
          OR: [{ sourceItemId: { in: itemIds } }, { targetItemId: { in: itemIds } }],
        },
        select: { sourceItemId: true, targetItemId: true },
      })
    : [];
  const auditedItemIds = new Set(auditRelations.flatMap(relation => [relation.sourceItemId, relation.targetItemId]));
  const rows = items.map(item => ({ ...item, canPermanentlyDelete: !auditedItemIds.has(item.id) }));

  return {
    characterId,
    items: rows,
    itemCount: total,
    pagination: { page, pageSize, total, pageCount: Math.max(1, Math.ceil(total / pageSize)) },
  };
});
