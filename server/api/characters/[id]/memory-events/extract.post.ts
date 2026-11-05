import { createError, defineEventHandler, getRouterParam } from "h3";
import { queueManualMemoryEvents } from "../../../../utils/memory-events-manual-queue";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import {
  localDayHour, resolveDailyEventWindow, resolveDayWindow,
} from "../../../../utils/memory-event-time";
import { processNextMemoryJob } from "../../../../utils/memory-worker";
import { collectOwnerQqs, isOwnerPrivateScopeKey } from "../../../../utils/memory-scheduler";
import { ensureOwnerPrivateScope } from "../../../../utils/memory-scope-access";
import { moveConversationEventsToScope } from "../../../../utils/memory-event-move";

/**
 * 立即整理忆泡（手动触发）。
 *
 * 调度器每小时才跑一次增量、夜里才收口；用户点这个按钮时不该等。
 * 这里做两件事：① 把「昨天（收口）」和「今天（增量）」两段写进队列；
 * ② 当场把刚排的任务跑掉，不用另开 worker 进程。
 *
 * 为什么要走队列而不是直接调抽取函数：任务表本来就是唯一的执行入口，
 * 手动触发和定时触发共用幂等键（`events-final:` / `events-hour:`）。等待中的任务
 * 直接唤醒；小时任务完成后出现新消息才复用重排，进度由当天消息游标保证。
 */
export function createManualMemoryEventsHandler(processJob = processNextMemoryJob) {
  return defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();

  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: {
      id: true,
      ownerId: true,
      memorySetting: { select: { timezone: true } },
      memoryScopes: { select: { id: true, scopeType: true, userId: true } },
    },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const globalScopeId = character.memoryScopes.find((scope) => scope.scopeType === "CHARACTER_GLOBAL")?.id;
  if (!globalScopeId) throw createError({ statusCode: 409, statusMessage: "角色还没有记忆范围，先完成初始化。" });

  /**
   * 和调度器保持同一批范围：全局 + 主人私人 + 每个有私聊的外部身份范围。
   *
   * 只排全局的话，主人在 QQ 私聊里说的话点这个按钮永远不会被整理；只排主人则漏掉
   * 群友的私聊 —— 而它们在页面上是同一个「整理忆泡」动作。
   */
  let ownerPrivateScopeId = character.memoryScopes.find(
    (scope) => scope.scopeType === "USER_PRIVATE" && scope.userId === character.ownerId,
  )?.id;
  /**
   * 主人自己的 QQ 范围不排：老会话可能还挂在 EXTERNAL，写进去的事件主人读不到，
   * 等会话归位后还会重复提一遍。和调度器用同一套判据。
   */
  const ownerQqs = collectOwnerQqs(await prisma.characterChannelBinding.findMany({
    where: { characterId },
    select: { connection: { select: { metadata: true } } },
  }));
  /**
   * 手动点「立即整理」时顺手把主人自己的老私聊会话归位。
   *
   * 自动调度只排除、不迁移（迁移留给主人下次开口时的 pipeline）。但手动整理是用户
   * 明确要看这一下，如果老会话还挂在 EXTERNAL，排除后按钮会回「昨天和今天都没有对话」——
   * 明明有。这里先把它挪到 USER_PRIVATE，再正常排队；历史消息跟着会话一起过去。
   */
  if (ownerQqs.size) {
    const targetScopeId = ownerPrivateScopeId ?? await ensureOwnerPrivateScope(characterId, character.ownerId);
    if (targetScopeId) {
      ownerPrivateScopeId = targetScopeId;
      const ownerConversations = await prisma.conversation.findMany({
        where: {
          characterId,
          externalConversationId: { in: [...ownerQqs].map((qq) => `c:${qq}`) },
          memoryScopeId: { not: targetScopeId },
        },
        select: { id: true, memoryScopeId: true },
      });
      if (ownerConversations.length) {
        await prisma.$transaction(async (tx) => {
          for (const conversation of ownerConversations) {
            // 旧范围里的忆泡跟着走，归位后既读得到、也不会被重新提一遍。
            await moveConversationEventsToScope(tx, {
              conversationId: conversation.id,
              fromScopeId: conversation.memoryScopeId,
              toScopeId: targetScopeId,
            });
            await tx.conversation.update({
              where: { id: conversation.id },
              data: { memoryScopeId: targetScopeId },
            });
          }
        });
      }
    }
  }
  const externalPrivateScopes = (await prisma.memoryScope.findMany({
    where: {
      characterId,
      scopeType: "EXTERNAL_IDENTITY",
      conversations: { some: { externalConversationId: { startsWith: "c:" } } },
    },
    select: {
      id: true,
      scopeKey: true,
      conversations: {
        where: { externalConversationId: { startsWith: "c:" } },
        select: { externalConversationId: true },
        take: 1,
      },
    },
  })).filter((scope) => !isOwnerPrivateScopeKey(scope.scopeKey, ownerQqs));
  const scopes = [
    { id: globalScopeId, label: "", privateOnly: false },
    ...(ownerPrivateScopeId ? [{ id: ownerPrivateScopeId, label: "（主人私聊）", privateOnly: false }] : []),
    ...externalPrivateScopes.map((scope) => {
      const qq = /^c:(\d+)$/.exec(scope.conversations[0]?.externalConversationId ?? "")?.[1];
      return { id: scope.id, label: `（QQ私聊 ${qq ?? "未知账号"}）`, privateOnly: true };
    }),
  ];

  const now = new Date();
  const timeZone = character.memorySetting?.timezone || "Asia/Shanghai";
  const { dayKey: todayKey, hour } = localDayHour(now, timeZone);
  const todayWindow = resolveDayWindow(todayKey, timeZone);
  const yesterday = resolveDailyEventWindow(now, timeZone);

  const windows = [
    { suffix: `events-final:`, dayKey: yesterday.dayKey, start: yesterday.start, end: yesterday.end, label: "昨天收口" },
    { suffix: `events-hour:`, dayKey: `${todayKey}:${hour}`, start: todayWindow.start, end: todayWindow.end, label: "今天增量" },
  ];

  const queued: string[] = [];
  const jobIds: string[] = [];
  for (const scope of scopes) {
    for (const window of windows) {
      const jobId = await queueManualMemoryEvents(prisma, {
        memoryScopeId: scope.id, privateOnly: scope.privateOnly,
        dayKey: window.dayKey.slice(0, 10),
        idempotencyKey: `${window.suffix}${scope.id}:${window.dayKey}`,
        periodStart: window.start, periodEnd: window.end,
        hourly: window.suffix === "events-hour:", now,
      });
      if (jobId) {
        jobIds.push(jobId);
        queued.push(window.label + scope.label);
      }
    }
  }

  // Only attempt this request's targets. A concurrent worker may already own one;
  // skip that target without consuming an unrelated job or abandoning later scopes.
  const processed: Array<{ status: string; message: string }> = [];
  for (const jobId of jobIds) {
    const result = await processJob(prisma, { ownerId, jobId });
    if (!result.processed) continue;
    processed.push({ status: result.status, message: result.message });
  }

  return {
    queued,
    processed,
    windows: windows.map((window) => ({ label: window.label, start: window.start.toISOString(), end: window.end.toISOString() })),
  };
  });
}

export default createManualMemoryEventsHandler();
