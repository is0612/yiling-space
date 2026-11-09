import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { Prisma } from "../../../../../../../../src/generated/prisma/client";
import { requireActorUserId } from "../../../../../../../utils/auth";
import { requireUuid } from "../../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../../utils/prisma";

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const candidateId = requireUuid(getRouterParam(event, "candidateId") ?? "", "知识候选");
  const body = asRecord(await readBody<unknown>(event));
  const targetItemId = requireUuid(typeof body.targetItemId === "string" ? body.targetItemId : "", "关联知识");
  const confirmed = body.confirmed !== false;
  const prisma = getPrisma();

  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const candidate = await prisma.knowledgeCandidate.findFirst({
    where: { id: candidateId, characterId },
    select: { id: true, status: true, processedResult: true, updatedAt: true },
  });
  if (!candidate) throw createError({ statusCode: 404, statusMessage: "知识候选不存在。" });
  if (candidate.status !== "REVIEW") {
    throw createError({ statusCode: 409, statusMessage: "只有待确认的知识候选可以调整关联。" });
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
    throw createError({ statusCode: 400, statusMessage: "只能调整知识助手本次明确建议的关联对象。" });
  }

  const target = await prisma.knowledgeItem.findFirst({
    where: { id: targetItemId, characterId, status: "ACTIVE" },
    select: { id: true, title: true, content: true, category: true, tags: true, revision: true },
  });
  if (!target) throw createError({ statusCode: 404, statusMessage: "关联知识不存在或已不处于正式状态。" });

  const confirmedIds = new Set(
    Array.isArray(result.confirmedRelatedItemIds)
      ? result.confirmedRelatedItemIds.filter((id): id is string => typeof id === "string" && suggestedIds.includes(id))
      : [],
  );
  if (confirmed) confirmedIds.add(targetItemId);
  else confirmedIds.delete(targetItemId);
  const nextResult = { ...result, confirmedRelatedItemIds: [...confirmedIds] };
  const updated = await prisma.knowledgeCandidate.updateMany({
    where: { id: candidateId, characterId, status: "REVIEW", updatedAt: candidate.updatedAt },
    data: { processedResult: nextResult as Prisma.InputJsonObject },
  });
  if (!updated.count) throw createError({ statusCode: 409, statusMessage: "候选内容刚刚发生变化，请刷新后重试。" });

  return { target, relationType: recommendation, confirmedRelatedItemIds: [...confirmedIds] };
});
