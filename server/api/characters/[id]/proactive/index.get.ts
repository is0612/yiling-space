import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { readDailyQuota } from "../../../../utils/model-usage";
import { getPrisma } from "../../../../utils/prisma";
import {
  describeProactiveReason,
  findDeliveryTarget,
  maskProactiveRecipient,
} from "../../../../utils/proactive";
import {
  evaluateProactiveGate,
  inQuietHours,
  proactiveDayKey,
  resolveProactiveSettings,
} from "../../../../utils/proactive-settings";
import { readGroupInitiativeStatus } from "../../../../utils/group-initiative";

/**
 * 主动找话的现状：设置 + 现在到底能不能发 + 池子里剩下什么。
 *
 * 「能不能发」直接复用 tick 用的那把闸门，不另写一套判断 —— 页面上显示的
 * 和后台真跑起来的行为必须是同一份逻辑，否则又会出现「页面说可以、实际不发」。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");

  const prisma = getPrisma();
  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true, modelConfig: true },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const now = new Date();
  const settings = resolveProactiveSettings(character.modelConfig);
  const target = await findDeliveryTarget(characterId);

  const [sentToday, lastSent, lastUserMessage, pending, recent, quota] = await Promise.all([
    prisma.proactiveIntent.count({
      where: {
        characterId,
        status: "SENT",
        sentAt: { gte: new Date(`${proactiveDayKey(now)}T00:00:00+08:00`) },
      },
    }),
    prisma.proactiveIntent.findFirst({
      where: { characterId, status: "SENT", sentAt: { not: null } },
      orderBy: { sentAt: "desc" },
      select: { sentAt: true },
    }),
    prisma.message.findFirst({
      where: { conversation: { characterId }, role: "USER" },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      select: { occurredAt: true },
    }),
    prisma.proactiveIntent.count({ where: { characterId, status: "PENDING" } }),
    prisma.proactiveIntent.findMany({
      where: { characterId },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { id: true, kind: true, goal: true, status: true, content: true, sentAt: true, confidence: true },
    }),
    readDailyQuota(characterId, character.modelConfig),
  ]);

  const lastSentAt = lastSent?.sentAt ?? null;
  const gate = evaluateProactiveGate({
    settings,
    now,
    sentToday,
    lastSentAt,
    lastUserMessageAt: lastUserMessage?.occurredAt ?? null,
    quotaExceeded: quota.exceeded,
    hasRecipient: Boolean(target),
  });

  const gapRemainingMinutes = lastSentAt
    ? Math.max(0, Math.ceil((settings.minGapMinutes * 60_000 - (now.getTime() - lastSentAt.getTime())) / 60_000))
    : 0;

  // 群聊那条是独立的设置与独立的闸门（每个群一个节奏），所以整块单独返回。
  const group = await readGroupInitiativeStatus(characterId, character.modelConfig);

  return {
    settings,
    group,
    status: {
      sentToday,
      pendingCount: pending,
      recipient: target ? maskProactiveRecipient(target.userId) : null,
      lastSentAt: lastSentAt?.toISOString() ?? null,
      gapRemainingMinutes,
      quietNow: inQuietHours(now, settings),
      quotaExceeded: quota.exceeded,
      canSendNow: gate.allowed,
      reason: gate.reason,
      reasonLabel: describeProactiveReason(gate.reason),
    },
    recent: recent.map((item) => ({
      id: item.id,
      kind: item.kind,
      goal: item.goal,
      status: item.status,
      content: item.content,
      confidence: item.confidence,
      sentAt: item.sentAt?.toISOString() ?? null,
    })),
  };
});
