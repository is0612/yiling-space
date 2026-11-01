import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { runGroupInitiativeTick } from "../../../../utils/group-initiative";
import { describeGroupInitiativeReason } from "../../../../utils/group-initiative-settings";

/**
 * 群内找话题的「立即试一次」。
 *
 * `force` 只跳过时间类闸门（安静时段 / 冷场 / 间隔 / 每日条数），
 * 开关、每群是 0、模型额度照判 —— 全跳过的话这个按钮就变成「绕过所有保护」。
 * 会挑最冷的那个群，真发一次到群里（不是试写），所以按钮文案要写清楚。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");

  const prisma = getPrisma();
  const exists = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!exists) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const results = await runGroupInitiativeTick({ characterId, force: true });
  // 优先报「真跑过模型」的那条；只有跳过时，报第一个有群号的原因，别拿角色级跳过糊弄人。
  const result = results.find((item) => item.status !== "skipped")
    ?? results.find((item) => item.groupId)
    ?? results[0];

  if (!result) {
    // 只可能是角色不在「运行中」：tick 只处理 ACTIVE 的角色。
    return {
      status: "skipped",
      reason: "not_active",
      reasonLabel: "角色没有在「运行中」，先启用再试。",
      groupId: null,
      content: null,
      detail: null,
    };
  }

  return {
    status: result.status,
    reason: result.reason,
    reasonLabel: describeGroupInitiativeReason(result.reason),
    groupId: result.groupId ?? null,
    content: result.content ?? null,
    detail: result.detail ?? null,
  };
});
