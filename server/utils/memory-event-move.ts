import type { Prisma } from "../../src/generated/prisma/client";

type MemoryTransaction = Prisma.TransactionClient;

/**
 * 把一段会话的忆泡与当天进度从旧范围挪到新范围。
 *
 * 为什么需要它：主人的老私聊会话可能还挂在 `EXTERNAL_IDENTITY`，而会话归位
 * （`resolveOwnerPrivateScopeRepair` / 手动整理）只改 `Conversation.memoryScopeId`。
 * 已经写进旧范围的忆泡如果不跟着走，会有两个后果：
 * - 主人私聊时读的是 `USER_PRIVATE`，旧忆泡看不见；
 * - 归位后 `USER_PRIVATE` 的按天任务会重新提一遍同一天，产生跨范围重复。
 *
 * 只搬「这条会话自己的」忆泡：以 `sourceMessageId` 为锚（写入时它就是最早证据，
 * 也就决定了忆泡归属的会话），不碰同范围里群聊等其他会话的事件。
 * 搬完重算两边的 `memoryEventDays.eventCount`，并把旧范围的整理水位带过去，
 * 避免新范围把已经整理过的消息再喂一遍模型。
 */
export async function moveConversationEventsToScope(
  tx: MemoryTransaction,
  input: { conversationId: string; fromScopeId: string; toScopeId: string },
): Promise<{ moved: number; merged: number; days: number }> {
  if (input.fromScopeId === input.toScopeId) return { moved: 0, merged: 0, days: 0 };

  const messages = await tx.message.findMany({
    where: { conversationId: input.conversationId },
    select: { id: true },
  });
  const messageIds = messages.map((message) => message.id);
  if (!messageIds.length) return { moved: 0, merged: 0, days: 0 };

  const events = await tx.memoryEvent.findMany({
    where: {
      memoryScopeId: input.fromScopeId,
      sourceMessageId: { in: messageIds },
    },
    select: { id: true, dayKey: true, dedupeKey: true },
  });
  if (!events.length) return { moved: 0, merged: 0, days: 0 };

  const affectedDays = new Set(events.map((event) => event.dayKey));
  let moved = 0;
  let merged = 0;
  for (const event of events) {
    // 目标范围已有同一件事（同一天同标题）：旧的那条是重复，删掉即可。
    const conflict = await tx.memoryEvent.findFirst({
      where: { memoryScopeId: input.toScopeId, dedupeKey: event.dedupeKey },
      select: { id: true },
    });
    if (conflict) {
      await tx.memoryEvent.delete({ where: { id: event.id } });
      merged += 1;
      continue;
    }
    await tx.memoryEvent.update({
      where: { id: event.id },
      data: { memoryScopeId: input.toScopeId },
    });
    moved += 1;
  }

  for (const dayKey of affectedDays) {
    const [oldDay, newDay, oldCount, newCount] = await Promise.all([
      tx.memoryEventDay.findUnique({
        where: { memoryScopeId_dayKey: { memoryScopeId: input.fromScopeId, dayKey } },
        select: { state: true, extractedAt: true },
      }),
      tx.memoryEventDay.findUnique({
        where: { memoryScopeId_dayKey: { memoryScopeId: input.toScopeId, dayKey } },
        select: { state: true, extractedAt: true },
      }),
      tx.memoryEvent.count({ where: { memoryScopeId: input.fromScopeId, dayKey } }),
      tx.memoryEvent.count({ where: { memoryScopeId: input.toScopeId, dayKey } }),
    ]);
    if (oldDay) {
      await tx.memoryEventDay.update({
        where: { memoryScopeId_dayKey: { memoryScopeId: input.fromScopeId, dayKey } },
        data: { eventCount: oldCount },
      });
    }
    if (newDay) {
      const extractedAt = [newDay.extractedAt, oldDay?.extractedAt]
        .filter((value): value is Date => value instanceof Date)
        .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;
      await tx.memoryEventDay.update({
        where: { memoryScopeId_dayKey: { memoryScopeId: input.toScopeId, dayKey } },
        data: {
          eventCount: newCount,
          // 任一边还在长就保持 DRAFT；两边都收口了才算 FINAL。
          state: newDay.state === "DRAFT" || oldDay?.state === "DRAFT" ? "DRAFT" : "FINAL",
          extractedAt,
        },
      });
    } else if (oldDay) {
      await tx.memoryEventDay.create({
        data: {
          memoryScopeId: input.toScopeId,
          dayKey,
          state: oldDay.state,
          eventCount: newCount,
          extractedAt: oldDay.extractedAt,
        },
      });
    }
  }

  return { moved, merged, days: affectedDays.size };
}
