import { createError, defineEventHandler, getQuery, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../../utils/auth";
import { requireUuid } from "../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../utils/prisma";

const TOPIC_STATUSES = new Set(["ACTIVE", "ARCHIVED", "MERGED"]);

export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const query = getQuery(event);
  const requestedStatus = typeof query.status === "string" ? query.status : "ACTIVE";
  if (!TOPIC_STATUSES.has(requestedStatus)) {
    throw createError({ statusCode: 400, statusMessage: "主题状态筛选值无效。" });
  }
  const keyword = typeof query.q === "string" ? query.q.trim().slice(0, 100) : "";
  const page = Math.max(1, Math.min(10_000, Number.parseInt(String(query.page ?? "1"), 10) || 1));
  const pageSize = Math.max(1, Math.min(50, Number.parseInt(String(query.pageSize ?? "30"), 10) || 30));
  const where = {
    characterId,
    status: requestedStatus as "ACTIVE" | "ARCHIVED" | "MERGED",
    ...(keyword ? { OR: [
      { name: { contains: keyword, mode: "insensitive" as const } },
      { description: { contains: keyword, mode: "insensitive" as const } },
    ] } : {}),
  };
  const [topics, total] = await Promise.all([
    prisma.knowledgeTopic.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true, name: true, description: true, status: true, revision: true,
        mergedIntoId: true, mergedAt: true, createdAt: true, updatedAt: true,
        // Retain historical member links, but count only currently usable knowledge.
        _count: { select: { members: { where: { item: { characterId, status: "ACTIVE" } } } } },
      },
    }),
    prisma.knowledgeTopic.count({ where }),
  ]);
  return {
    topics: topics.map(({ _count, ...topic }) => ({ ...topic, memberCount: _count.members })),
    pagination: { page, pageSize, total, pageCount: Math.max(1, Math.ceil(total / pageSize)) },
  };
});
