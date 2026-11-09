import { createError, defineEventHandler, getQuery } from "h3";
import { requireUuid } from "../utils/local-api";
import { requireActorUserId } from "../utils/auth";
import { listMemoryProgress } from "../utils/memory-progress";
import { getPrisma } from "../utils/prisma";

/**
 * 正在跑的记忆任务（忆泡整理 / 阶段总结）。
 *
 * 只读、只算当前账号名下的任务。面板前端轮询这个接口，不依赖哪个页面发起的请求 ——
 * 请求被切走、页面刷新都不影响「任务在跑」这件事被看见。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const query = getQuery(event);
  if (Array.isArray(query.characterId)) throw createError({ statusCode: 400, statusMessage: "角色参数只能提供一次。" });
  const characterId = query.characterId === undefined ? undefined : requireUuid(String(query.characterId), "角色");
  const type = query.type;
  if (type !== undefined && type !== "GENERATE_SNAPSHOT" && type !== "EXTRACT_EVENTS") {
    throw createError({ statusCode: 400, statusMessage: "无效的记忆任务类型。" });
  }
  const prisma = getPrisma();
  if (characterId && !await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } })) {
    throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  }
  const jobs = await listMemoryProgress(prisma, { ownerId, characterId, type });
  return { jobs, checkedAt: new Date().toISOString() };
});
