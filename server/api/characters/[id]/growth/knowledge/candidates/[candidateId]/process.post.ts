import { createError, getRouterParam } from "h3";
import { resolveChatModelSettings } from "../../../../../../../utils/chat-model-config";
import { resolveKnowledgeAssistantRuntime, processKnowledgeWithAssistant } from "../../../../../../../utils/knowledge-ai";
import { requireActorUserId } from "../../../../../../../utils/auth";
import { requireUuid } from "../../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../../utils/prisma";
import { Prisma } from "../../../../../../../../src/generated/prisma/client";
import { requireValidMemoryKnowledgeCandidateSource } from "../../../../../../../utils/knowledge-memory-candidates";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const candidateId = requireUuid(getRouterParam(event, "candidateId") ?? "", "知识候选");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true, modelConfig: true },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  const candidate = await prisma.knowledgeCandidate.findFirst({ where: { id: candidateId, characterId } });
  if (!candidate) throw createError({ statusCode: 404, statusMessage: "知识候选不存在。" });
  if (candidate.status === "ACCEPTED" || candidate.status === "DISMISSED") {
    throw createError({ statusCode: 409, statusMessage: "这条候选已经完成处置，不能再次处理。" });
  }
  const claimed = await prisma.$transaction(async tx => {
    await requireValidMemoryKnowledgeCandidateSource(tx, candidate);
    return tx.knowledgeCandidate.updateMany({
      where: { id: candidateId, characterId, status: { in: ["PENDING", "FAILED", "REVIEW"] } },
      data: { status: "PROCESSING", processingError: null, processedResult: Prisma.DbNull, processedAt: null },
    });
  });
  if (!claimed.count) throw createError({ statusCode: 409, statusMessage: "这条候选正在处理中，请稍后刷新。" });
  try {
    const chat = resolveChatModelSettings(character.modelConfig);
    const runtime = await resolveKnowledgeAssistantRuntime(character.modelConfig, chat.apiBaseUrl);
    if (!runtime) throw new Error("知识处理助手尚未启用或配置不完整。请先到知识系统设置中配置独立模型和 API Key。");
    const existingItems = await prisma.knowledgeItem.findMany({
      where: { characterId, status: "ACTIVE" },
      orderBy: { updatedAt: "desc" },
      take: 30,
      select: { id: true, title: true, content: true, category: true, tags: true },
    });
    const result = await processKnowledgeWithAssistant({
      runtime, characterId, candidateId, candidateContent: candidate.rawContent, existingItems,
    });
    const updated = await prisma.$transaction(async tx => {
      await requireValidMemoryKnowledgeCandidateSource(tx, candidate);
      return tx.knowledgeCandidate.update({
        where: { id: candidateId },
        data: { status: "REVIEW", processedResult: result as unknown as Prisma.InputJsonValue, processingError: null, processedAt: new Date() },
        select: { id: true, status: true, processedResult: true, processedAt: true },
      });
    });
    return { candidate: updated };
  } catch (error) {
    const message = error instanceof Error ? error.message : "知识处理失败。";
    await prisma.knowledgeCandidate.updateMany({
      where: { id: candidateId, characterId, status: "PROCESSING" },
      data: { status: "FAILED", processingError: message.slice(0, 2000) },
    });
    throw createError({ statusCode: 502, statusMessage: message });
  }
});
