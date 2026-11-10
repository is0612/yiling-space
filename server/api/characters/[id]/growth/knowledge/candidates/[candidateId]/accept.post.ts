import { createError, getRouterParam } from "h3";
import type { Prisma } from "../../../../../../../../src/generated/prisma/client";
import { requireActorUserId } from "../../../../../../../utils/auth";
import { requireUuid } from "../../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../../utils/prisma";
import { requireValidMemoryKnowledgeCandidateSource } from "../../../../../../../utils/knowledge-memory-candidates";

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const candidateId = requireUuid(getRouterParam(event, "candidateId") ?? "", "知识候选");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  const candidate = await prisma.knowledgeCandidate.findFirst({ where: { id: candidateId, characterId } });
  if (!candidate) throw createError({ statusCode: 404, statusMessage: "知识候选不存在。" });
  if (candidate.status === "ACCEPTED") {
    const existing = await prisma.knowledgeItem.findUnique({ where: { candidateId } });
    return { item: existing, alreadyAccepted: true };
  }
  if (candidate.status !== "REVIEW") throw createError({ statusCode: 409, statusMessage: "请先完成知识处理，再确认入库。" });
  const result = asRecord(candidate.processedResult);
  const title = typeof result.title === "string" ? result.title.trim().slice(0, 240) : "";
  const content = typeof result.content === "string" ? result.content.trim().slice(0, 12_000) : "";
  if (result.isKnowledge !== true || !title || !content) {
    throw createError({ statusCode: 400, statusMessage: "处理结果没有形成有效知识，不能入库。" });
  }
  const category = typeof result.category === "string" ? result.category : "GENERAL";
  const tags = Array.isArray(result.tags) ? result.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 20) : [];
  const confidence = typeof result.confidence === "number" && Number.isFinite(result.confidence)
    ? Math.min(1, Math.max(0, result.confidence)) : null;
  const outcome = await prisma.$transaction(async (tx) => {
    await requireValidMemoryKnowledgeCandidateSource(tx, candidate);
    const claimed = await tx.knowledgeCandidate.updateMany({
      where: { id: candidateId, characterId, status: "REVIEW" },
      data: { status: "ACCEPTING" },
    });
    if (!claimed.count) {
      const existing = await tx.knowledgeItem.findUnique({ where: { candidateId } });
      if (existing) return { item: existing, alreadyAccepted: true };
      throw createError({ statusCode: 409, statusMessage: "候选状态已变化，请刷新后重试。" });
    }
    const created = await tx.knowledgeItem.create({
      data: {
        characterId, candidateId, title, content, category, tags, confidence,
        sourceType: candidate.sourceType, sourceRef: candidate.sourceRef === null ? undefined : candidate.sourceRef as Prisma.InputJsonValue,
      },
    });

    const recommendation = result.recommendation;
    const suggestedIds = Array.isArray(result.relatedItemIds)
      ? result.relatedItemIds.filter((id): id is string => typeof id === "string")
      : [];
    const confirmedIds = Array.isArray(result.confirmedRelatedItemIds)
      ? [...new Set(result.confirmedRelatedItemIds.filter((id): id is string => typeof id === "string" && suggestedIds.includes(id)))]
      : [];
    if (confirmedIds.length && (recommendation === "DUPLICATE" || recommendation === "CONFLICT")) {
      const activeTargets = await tx.knowledgeItem.findMany({
        where: { id: { in: confirmedIds }, characterId, status: "ACTIVE" },
        select: { id: true },
      });
      if (activeTargets.length !== confirmedIds.length) {
        throw createError({ statusCode: 409, statusMessage: "已确认的关联知识发生变化，请重新检查候选后再入库。" });
      }
      for (const target of activeTargets) {
        // 对称关系落库前固定条目顺序，避免 A→B 与 B→A 各存一条。
        // 直接比较两个 ID，不走数组排序，省掉一次可能为 undefined 的取值。
        const sourceItemId = created.id < target.id ? created.id : target.id;
        const targetItemId = created.id < target.id ? target.id : created.id;
        await tx.knowledgeItemRelation.upsert({
          where: {
            characterId_sourceItemId_targetItemId_relationType: {
              characterId, sourceItemId, targetItemId, relationType: recommendation,
            },
          },
          create: {
            characterId, sourceItemId, targetItemId, relationType: recommendation,
            metadata: {
              origin: "KNOWLEDGE_CANDIDATE",
              candidateId,
              reason: typeof result.reason === "string" ? result.reason.slice(0, 2000) : "",
            },
          },
          update: {},
        });
      }
    }
    await tx.knowledgeCandidate.update({
      where: { id: candidateId },
      data: { status: "ACCEPTED" },
    });
    return { item: created, alreadyAccepted: false };
  });
  return outcome;
});
