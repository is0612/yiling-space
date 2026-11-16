import { createError, defineEventHandler, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { purgeTrashedMemories } from "../../../../utils/memory-trash";
import { getPrisma } from "../../../../utils/prisma";

/**
 * 清空某个角色的记忆回收站：把状态是 TRASHED 的条目一次性永久删除。
 *
 * 与单条 `DELETE /api/memories/<id>` 的语义完全一致（只删当前长期记忆条目，
 * 已有阶段总结里的生成时副本和来源记录仍然保留），只是把「逐条点」变成「一次清完」。
 * 不可恢复，页面那边必须过二次确认。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  return purgeTrashedMemories(characterId);
});
