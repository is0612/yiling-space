import { createError, defineEventHandler, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../../utils/auth";
import { requireUuid } from "../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../utils/prisma";

/**
 * 删除单条知识候选。
 *
 * 只删候选记录，不碰正式知识：
 * `KnowledgeItem.candidateId` 的外键是 `onDelete: SetNull`，
 * 所以即使是 ACCEPTED 候选，入库的知识也会保留，只是不再指回这条候选
 * （正文、来源、版本历史都在知识自己身上）。
 *
 * 正在处理的候选（PROCESSING / ACCEPTING）拒绝删除，避免后台任务写到一半失去宿主。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const candidateId = requireUuid(getRouterParam(event, "candidateId") ?? "", "知识候选");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  return prisma.$transaction(async (tx) => {
    const candidate = await tx.knowledgeCandidate.findFirst({
      where: { id: candidateId, characterId },
      select: { id: true, status: true, knowledgeItem: { select: { id: true } } },
    });
    if (!candidate) throw createError({ statusCode: 404, statusMessage: "知识候选不存在或不属于当前角色。" });
    if (candidate.status === "PROCESSING" || candidate.status === "ACCEPTING") {
      throw createError({ statusCode: 409, statusMessage: "这条候选正在处理，请等待完成后再删除。" });
    }

    // 先记下入库条目，删完之后用于向调用方确认「正式知识还在」。
    const knowledgeItemId = candidate.knowledgeItem?.id ?? null;
    await tx.knowledgeCandidate.delete({ where: { id: candidate.id } });

    return {
      ok: true,
      candidateId: candidate.id,
      deletedStatus: candidate.status,
      knowledgeItemId,
      knowledgeItemRetained: knowledgeItemId !== null,
    };
  });
});
