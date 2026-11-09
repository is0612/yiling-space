import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { Prisma } from "../../../../../../../../src/generated/prisma/client";
import { requireActorUserId } from "../../../../../../../../utils/auth";
import { requireUuid } from "../../../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../../../utils/prisma";

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const candidateId = requireUuid(getRouterParam(event, "candidateId") ?? "", "知识候选");
  const body = asRecord(await readBody<unknown>(event));
  const targetItemId = requireUuid(typeof body.targetItemId === "string" ? body.targetItemId : "", "关联知识");
  const prisma = getPrisma();

  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const candidate = await prisma.knowledgeCandidate.findFirst({
    where: { id: candidateId, characterId },
    select: { id: true, status: true, processedResult: true },
  });
  if (!candidate) throw createError({ statusCode: 404, statusMessage: "知识候选不存在。" });
  if (candidate.status !== "REVIEW") {
    throw createError({ statusCode: 409, statusMessage: "只有待确认的知识候选可以建立关联。" });
  }

  const result = asRecord(candidate.processedResult);
  const recommendation = result.recommendation;
  if (recommendation !== "DUPLICATE" && recommendation !== "CONFLICT") {
    throw createError({ statusCode: 400, statusMessage: "这条候选没有重复或冲突关联建议。" });
  }
  const suggestedIds = Array.isArray(result.relatedItemIds)
    ? result.relatedItemIds.filter((id): id is string => typeof id === "string")
    : [];
  if (!suggestedIds.includes(targetItemId)) {
    throw createError({ statusCode: 400, statusMessage: "只能确认知识助手本次明确建议的关联对象。" });
  }

  const target = await prisma.knowledgeItem.findFirst({
    where: { id: targetItemId, characterId, status: "ACTIVE" },
    select: { id: true, title: true },
  });
  if (!target) throw createError({ statusCode: 404, statusMessage: "关联知识不存在或已不处于正式状态。" });

  // DUPLICATE / CONFLICT 是无向关系，统一 ID 顺序，避免 A-B 与 B-A 重复。
  const [sourceItemId, normalizedTargetId] = [candidateId, targetItemId].sort();
  const relationType = recommendation;
  const metadata = {
    origin: "KNOWLEDGE_CANDIDATE",
    candidateId,
    reason: typeof result.reason === "string" ? result.reason.slice(0, 2000) : "",
  } satisfies Prisma.InputJsonObject;

  const where = {
    characterId_sourceItemId_targetItemId_relationType: {
      characterId,
      sourceItemId,
      targetItemId: normalizedTargetId,
      relationType,
    },
  };
  const relation = await prisma.knowledgeItemRelation.upsert({
    where,
    create: {
      characterId,
      sourceItemId,
      targetItemId: normalizedTargetId,
      relationType,
      metadata,
    },
    update: {},
  });
  return { relation, target };
});
