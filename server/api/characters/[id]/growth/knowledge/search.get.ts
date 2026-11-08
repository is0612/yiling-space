import { createError, getQuery, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import { rankKnowledgeItems } from "../../../../../utils/knowledge-retrieval";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const query = getQuery(event);
  const q = typeof query.q === "string" ? query.q.trim().slice(0, 300) : "";
  if (!q) return { items: [] };
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  const rows = await prisma.knowledgeItem.findMany({
    where: { characterId, status: "ACTIVE" },
    orderBy: { updatedAt: "desc" },
    take: 300,
    select: { id: true, title: true, content: true, category: true, tags: true, confidence: true, updatedAt: true },
  });
  return { items: rankKnowledgeItems(q, rows, 8) };
});
