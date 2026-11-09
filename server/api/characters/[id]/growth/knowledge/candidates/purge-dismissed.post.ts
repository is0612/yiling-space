import { createError, defineEventHandler, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../../utils/auth";
import { requireUuid } from "../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../utils/prisma";

/**
 * 批量清理「已忽略」的知识候选。
 *
 * 边界写死在 where 条件里，不靠调用方传状态：
 * - 只删 DISMISSED，待处理（PENDING / REVIEW）与已入库（ACCEPTED）一律不动；
 * - 额外要求 candidate 没有关联的正式知识，双保险防止误删入库候选；
 * - 只删候选记录，候选本身没有可恢复的软删，删除即不可回滚。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const deleted = await prisma.knowledgeCandidate.deleteMany({
    where: { characterId, status: "DISMISSED", knowledgeItem: { is: null } },
  });
  return { ok: true, deletedCount: deleted.count };
});
