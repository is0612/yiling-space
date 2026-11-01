import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { describeProactiveReason, runProactiveTick } from "../../../../utils/proactive";

/**
 * 立即试一次。
 *
 * force 只跳时间类闸门（安静时段 / 间隔 / 主人是否在聊 / 每日上限），
 * 开关、收件人、模型额度照判 —— 全跳过的话这个按钮就变成「绕过所有保护」了。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");

  const prisma = getPrisma();
  const exists = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!exists) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const results = await runProactiveTick({ characterId, force: true });
  const result = results[0];
  if (!result) {
    // 只可能是角色不在「运行中」：tick 只处理 ACTIVE 的角色。
    return {
      status: "skipped",
      reason: "not_active",
      reasonLabel: "角色没有在「运行中」，先启用再试。",
      content: null,
      detail: null,
    };
  }

  return {
    status: result.status,
    reason: result.reason,
    reasonLabel: describeProactiveReason(result.reason),
    content: result.content ?? null,
    detail: result.detail ?? null,
  };
});
