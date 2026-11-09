import { createError, getQuery, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";

type JsonRecord = Record<string, unknown>;
function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}
function stringIds(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string"))] : [];
}

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
  const [rawCandidates, rawItems, candidateCount, itemCount, relations] = await Promise.all([
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
    prisma.knowledgeItemRelation.findMany({
      where: { characterId },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true, sourceItemId: true, targetItemId: true, relationType: true, status: true, resolution: true, metadata: true, createdAt: true, updatedAt: true,
        sourceItem: { select: { id: true, title: true, content: true, category: true, tags: true, confidence: true, status: true, revision: true, sourceType: true, sourceRef: true } },
        targetItem: { select: { id: true, title: true, content: true, category: true, tags: true, confidence: true, status: true, revision: true, sourceType: true, sourceRef: true } },
      },
    }),
  ]);

  const suggestedIds = [...new Set(rawCandidates.flatMap((candidate) => {
    const result = asRecord(candidate.processedResult);
    return stringIds(result.relatedItemIds);
  }))];
  const candidateTargets = suggestedIds.length
    ? await prisma.knowledgeItem.findMany({
      where: { id: { in: suggestedIds }, characterId, status: "ACTIVE" },
      select: { id: true, title: true, content: true, category: true, tags: true, revision: true },
    })
    : [];
  const candidateTargetById = new Map(candidateTargets.map(item => [item.id, item]));
  const candidates = rawCandidates.map((candidate) => {
    const result = asRecord(candidate.processedResult);
    const ids = stringIds(result.relatedItemIds);
    return {
      ...candidate,
      relatedItems: ids.map(id => candidateTargetById.get(id)).filter((item): item is (typeof candidateTargets)[number] => Boolean(item)),
    };
  });

  const items = rawItems.map((item) => ({
    ...item,
    relations: relations
      .filter(relation => relation.sourceItemId === item.id || relation.targetItemId === item.id)
      .map(relation => ({
        id: relation.id,
        sourceItemId: relation.sourceItemId,
        targetItemId: relation.targetItemId,
        relationType: relation.relationType,
        status: relation.status,
        resolution: relation.resolution,
        metadata: relation.metadata,
        updatedAt: relation.updatedAt,
        relatedItem: relation.sourceItemId === item.id ? relation.targetItem : relation.sourceItem,
      })),
  }));
  return { candidates, items, candidateCount, itemCount };
});
