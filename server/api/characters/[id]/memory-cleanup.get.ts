import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../utils/auth";
import { requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";
import { readLatestCleanupSummary } from "../../../utils/memory-cleanup-summary";

/**
 * 最近一次原始消息清理的结果。
 *
 * 消费者是「记忆设置」页：用户设了 30 天保留，最想知道的是「上次到底删了多少、
 * 其中多少是纯上下文行」。这些数字 Worker 早就在审计里写了，但一直没人读出来 ——
 * 页面上只有一句「清理任务会删除截止时间之前的原始消息」。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();

  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  return { cleanup: await readLatestCleanupSummary(prisma, characterId) };
});
