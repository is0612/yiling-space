import { createError } from "h3";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { eventMessageWhere } from "./memory-event-source";
import { localDayHour, resolveDailyEventWindow, resolveDayWindow } from "./memory-event-time";
import { MEMORY_JOB_LEASE_MS } from "./memory-job-lease";
import { collectOwnerQqs, isOwnerPrivateScopeKey } from "./memory-scheduler";

export type MemoryEventsPreview = {
  characterId: string;
  characterName: string;
  timeZone: string;
  checkedAt: string;
  totalMessages: number;
  rows: Array<{ key: string; dayKey: string; conversationLabel: string; scopeLabel: string; pendingMessages: number }>;
  truncated: boolean;
  hasLegacyOwnerChats: boolean;
  notice: string | null;
};

/** Same targets/cursors as manual extraction, but never migrates scopes or writes jobs. */
export async function previewMemoryEvents(
  prisma: Pick<PrismaClient, "character" | "characterChannelBinding" | "memoryScope" | "memoryEventDay" | "memoryJob" | "message" | "conversation">,
  input: { ownerId: string; characterId: string; now?: Date },
): Promise<MemoryEventsPreview> {
  const now = input.now ?? new Date();
  const character = await prisma.character.findFirst({
    where: { id: input.characterId, ownerId: input.ownerId },
    select: { id: true, name: true, ownerId: true, memorySetting: { select: { timezone: true } },
      memoryScopes: { select: { id: true, scopeType: true, userId: true } } },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  const global = character.memoryScopes.find(scope => scope.scopeType === "CHARACTER_GLOBAL");
  if (!global) throw createError({ statusCode: 409, statusMessage: "角色还没有记忆范围，先完成初始化。" });
  const ownerPrivate = character.memoryScopes.find(scope => scope.scopeType === "USER_PRIVATE" && scope.userId === character.ownerId);
  const ownerQqs = collectOwnerQqs(await prisma.characterChannelBinding.findMany({
    where: { characterId: character.id }, select: { connection: { select: { metadata: true } } },
  }));
  const legacyOwnerConversation = ownerQqs.size ? await prisma.conversation.findFirst({
    where: {
      characterId: character.id,
      externalConversationId: { in: [...ownerQqs].map(qq => `c:${qq}`) },
      ...(ownerPrivate ? { memoryScopeId: { not: ownerPrivate.id } } : {}),
    },
    select: { id: true },
  }) : null;
  const external = (await prisma.memoryScope.findMany({
    where: { characterId: character.id, scopeType: "EXTERNAL_IDENTITY", conversations: { some: { externalConversationId: { startsWith: "c:" } } } },
    select: { id: true, scopeKey: true }, orderBy: { id: "asc" },
  })).filter(scope => !isOwnerPrivateScopeKey(scope.scopeKey, ownerQqs));
  const scopes = [
    { id: global.id, label: "角色全局", privateOnly: false },
    ...(ownerPrivate ? [{ id: ownerPrivate.id, label: "主人私人", privateOnly: false }] : []),
    ...external.map(scope => ({ id: scope.id, label: "外部私聊", privateOnly: true })),
  ];
  const timeZone = character.memorySetting?.timezone || "Asia/Shanghai";
  const { dayKey: today, hour } = localDayHour(now, timeZone);
  const yesterday = resolveDailyEventWindow(now, timeZone);
  const todayWindow = resolveDayWindow(today, timeZone);
  const windows = [
    { dayKey: yesterday.dayKey, start: yesterday.start, end: yesterday.end, hourly: false },
    { dayKey: today, start: todayWindow.start, end: todayWindow.end, hourly: true },
  ];
  const keyFor = (scopeId: string, window: typeof windows[number]) => window.hourly
    ? `events-hour:${scopeId}:${window.dayKey}:${hour}` : `events-final:${scopeId}:${window.dayKey}`;
  const [days, jobs] = await Promise.all([
    prisma.memoryEventDay.findMany({ where: { memoryScopeId: { in: scopes.map(scope => scope.id) }, dayKey: { in: windows.map(window => window.dayKey) } },
      select: { memoryScopeId: true, dayKey: true, state: true, extractedAt: true, extractedMessageId: true } }),
    prisma.memoryJob.findMany({ where: { type: "EXTRACT_EVENTS", idempotencyKey: { in: scopes.flatMap(scope => windows.map(window => keyFor(scope.id, window))) } },
      select: { idempotencyKey: true, status: true, lockedAt: true } }),
  ]);
  const pending: Array<{ key: string; dayKey: string; conversationId: string; scopeLabel: string; pendingMessages: number }> = [];
  let totalMessages = 0;
  let truncated = false;
  let running = false;
  // Each target uses a full database COUNT plus a bounded group query. Never load message bodies.
  for (const window of windows) {
    for (const scope of scopes) {
      const day = days.find(item => item.memoryScopeId === scope.id && item.dayKey === window.dayKey);
      if (window.hourly && day?.state === "FINAL") continue; // Daily worker skips finalized hourly targets.
      const job = jobs.find(item => item.idempotencyKey === keyFor(scope.id, window));
      if (!window.hourly && (job?.status === "SUCCEEDED" || job?.status === "SKIPPED")) continue;
      if (job?.status === "RUNNING" && job.lockedAt && job.lockedAt.getTime() >= now.getTime() - MEMORY_JOB_LEASE_MS) {
        running = true;
        continue;
      }
      const where = eventMessageWhere({ memoryScopeId: scope.id, privateOnly: scope.privateOnly,
        periodStart: window.start, periodEnd: window.end, progress: day ?? null });
      const count = await prisma.message.count({ where });
      totalMessages += count;
      if (!count) continue;
      const room = 100 - pending.length;
      if (!room) { truncated = true; continue; }
      const groups = await prisma.message.groupBy({ by: ["conversationId"], where, _count: { _all: true },
        orderBy: { conversationId: "asc" }, take: room + 1 });
      if (groups.length > room) truncated = true;
      for (const group of groups.slice(0, room)) pending.push({
        key: `${window.dayKey}:${scope.id}:${group.conversationId}`, dayKey: window.dayKey,
        conversationId: group.conversationId, scopeLabel: scope.label, pendingMessages: group._count._all,
      });
    }
  }
  const conversations = pending.length ? await prisma.conversation.findMany({
    where: { characterId: character.id, id: { in: [...new Set(pending.map(row => row.conversationId))] } },
    select: { id: true, title: true, externalConversationId: true },
  }) : [];
  const notices = [
    ...(legacyOwnerConversation ? ["预览不含待归位主人的旧私聊；开始整理时才会归位，实际待整理数量可能增加。"] : []),
    ...(running ? ["正在运行的整理任务未计入本次可启动预览。"] : []),
  ];
  return {
    characterId: character.id, characterName: character.name, timeZone, checkedAt: now.toISOString(), totalMessages,
    rows: pending.map(({ conversationId, ...row }) => {
      const conversation = conversations.find(item => item.id === conversationId);
      const externalId = conversation?.externalConversationId;
      const conversationLabel = conversation?.title?.trim() || (externalId?.startsWith("g:")
        ? `QQ群 ${externalId.slice(2)}` : externalId?.startsWith("c:") ? `QQ私聊 ${externalId.slice(2)}` : "本地对话");
      return { ...row, conversationLabel };
    }),
    truncated, hasLegacyOwnerChats: Boolean(legacyOwnerConversation), notice: notices.length ? notices.join(" ") : null,
  };
}
