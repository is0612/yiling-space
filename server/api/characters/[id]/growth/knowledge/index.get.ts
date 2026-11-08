import { createError, getQuery, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  const query = getQuery(event);
  const candidateStatus = typeof query.candidateStatus === "string" ? query.candidateStatus : undefined;
  const itemStatus = typeof query.itemStatus === "string" ? query.itemStatus : "ACTIVE";
  const keyword = typeof query.q === "string" ? query.q.trim().slice(0, 100) : "";
  const [candidates, items, candidateCount, itemCount] = await Promise.all([
    prisma.knowledgeCandidate.findMany({
      where: { characterId, ...(candidateStatus ? { status: candidateStatus } : {}) },
      orderBy: { createdAt: "desc" }, take: 50,
      select: { id: true, sourceType: true, sourceRef: true, rawContent: true, status: true, processedResult: true, processingError: true, processedAt: true, createdAt: true, updatedAt: true },
    }),
    prisma.knowledgeItem.findMany({
      where: {
        characterId, status: itemStatus,
        ...(keyword ? { OR: [{ title: { contains: keyword, mode: "insensitive" } }, { content: { contains: keyword, mode: "insensitive" } }, { tags: { has: keyword } }] } : {}),
      },
      orderBy: { updatedAt: "desc" }, take: 100,
      select: { id: true, title: true, content: true, category: true, tags: true, confidence: true, status: true, sourceType: true, sourceRef: true, revision: true, createdAt: true, updatedAt: true },
    }),
    prisma.knowledgeCandidate.count({ where: { characterId, status: "PENDING" } }),
    prisma.knowledgeItem.count({ where: { characterId, status: "ACTIVE" } }),
  ]);
  return { candidates, items, candidateCount, itemCount };
});
