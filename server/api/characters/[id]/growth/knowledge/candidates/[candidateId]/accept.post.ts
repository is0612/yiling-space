import { createError, getRouterParam } from "h3";
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
  const item = await prisma.$transaction(async (tx) => {
    const created = await tx.knowledgeItem.create({
      data: {
        characterId, candidateId, title, content, category, tags, confidence,
        sourceType: candidate.sourceType, sourceRef: candidate.sourceRef ?? undefined,
      },
    });
    await tx.knowledgeCandidate.update({
      where: { id: candidateId },
      data: { status: "ACCEPTED" },
    });
    return created;
  });
  return { item, alreadyAccepted: false };
});
