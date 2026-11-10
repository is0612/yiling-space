import { loadGoalsForPrompt, usedGoalSnapshots } from "../../../utils/goal-retrieval";
import { loadExpressionHabitsForPrompt, usedExpressionHabitSnapshots } from "../../../utils/expression-habit-retrieval";
import { loadPreferencesForPrompt, usedPreferenceSnapshots } from "../../../utils/preference-retrieval";
import { createHash, randomUUID } from "node:crypto";
import { createError, getRouterParam, readBody, setResponseStatus } from "h3";
import { type ConversationContextMessage } from "../../../utils/chat-reply";
import { createModelTurnDetail } from "../../../utils/model-turn-detail";
import {
  buildMemoryAssistantCandidates,
  generateConversationReplyWithMemoryAssistant,
  resolveMemoryAssistantRuntime,
} from "../../../utils/memory-assistant";
import {
  loadCatchphraseCatalog, markCatchphrasesUsed, pickCatchphraseCatalog, toCatchphrasePromptEntries,
} from "../../../utils/catchphrases";
import { resolveChatModelSettings } from "../../../utils/chat-model-config";
import { resolveChatTimeZone } from "../../../utils/chat-time-context";
import { parseEventTimeRange } from "../../../utils/memory-event-time";
import { resolveCharacterApiKey } from "../../../utils/credential-encryption";
import { CLOSE_FRIEND_LIMIT, listAcquaintances } from "../../../utils/friends";
import {
  extractMemoryAssistantSearchTerms, rankMemoriesWithBudget, rankSnapshotsWithBudget,
  resolveMemoryItemLimit, resolveMemoryTokenBudget, resolveRecentMessageLimit, resolveSnapshotTokenBudget,
} from "../../../utils/memory-retrieval";
import {
  parseEventParticipantQuery, resolveEventItemLimit, resolveEventTokenBudget, resolveEventRecentDays,
  selectEventsForPrompt, selectRecentEvents,
} from "../../../utils/memory-event-retrieval";
import {
  resolveRawMessageLimit, resolveRawMessageTokenBudget, selectRawMessagesForPrompt,
} from "../../../utils/message-retrieval";
import { recordModelUsage, readDailyQuota, toUsageTokens } from "../../../utils/model-usage";
import { resolveChatMemoryScopes } from "../../../utils/memory-scope-access";
import { requireActorUserId } from "../../../utils/auth";
import { readTrimmedString, requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";
import { desktopConversationWhere, DELETED_DESKTOP_CONVERSATION_REQUEST_ERROR, lockActiveDesktopConversationForWrite, throwDeletedDesktopConversationRequest, validateDesktopConversationReplay } from "../../../utils/desktop-conversation";
import { readMessageIsOwner, readMessageSpeaker } from "../../../utils/conversation-message";
import { resolveEventParticipantNames, resolveParticipantAccounts } from "../../../utils/participant-names";
import { readPreviousJournalLine } from "../../../utils/journal-service";
import { isSelfFactQuery, loadJournalFacts } from "../../../utils/journal-facts";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const body = await readBody<Record<string, unknown>>(event);
  const message = readTrimmedString(body?.message, "消息", 8000, { required: true });
  const rawRequestKey = body?.requestKey;
  if (rawRequestKey !== undefined && typeof rawRequestKey !== "string") {
    throw createError({ statusCode: 400, statusMessage: "requestKey 格式无效。" });
  }
  const requestKey = typeof rawRequestKey === "string" && rawRequestKey
    ? requireUuid(rawRequestKey, "请求")
    : randomUUID();
  const rawConversationId = body?.conversationId;
  if (rawConversationId !== undefined && typeof rawConversationId !== "string") {
    throw createError({ statusCode: 400, statusMessage: "conversationId 格式无效。" });
  }
  const requestedConversationId = typeof rawConversationId === "string" && rawConversationId
    ? requireUuid(rawConversationId, "会话")
    : null;
  // Bind a stable idempotency key to the exact user input and target conversation.
  // The hash contains no credentials or model configuration.
  const requestHash = createHash("sha256")
    .update(JSON.stringify({ message, conversationId: requestedConversationId }))
    .digest("hex");

  const prisma = getPrisma();
  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: {
      id: true,
      name: true,
      basePrompt: true,
      styleExamples: true,
      userAddress: true,
      status: true,
      modelConfig: true,
      memorySetting: { select: { timezone: true } },
      memoryScopes: {
        select: {
          id: true,
          scopeType: true,
          userId: true,
          externalIdentityId: true,
          externalIdentity: { select: { status: true, linkedUserId: true } },
        },
      },
    },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  if (character.status !== "ACTIVE") {
    throw createError({ statusCode: 409, statusMessage: "角色已停用，无法继续对话。请先在「角色管理」里重新启用。" });
  }

  // A stable client requestKey prevents duplicate model calls and duplicate conversation creation on retries.
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000);
  let chatRequest = await prisma.chatRequest.findUnique({
    where: { ownerId_characterId_requestKey: { ownerId, characterId, requestKey } },
  });
  if (chatRequest && chatRequest.requestHash !== requestHash) {
    throw createError({ statusCode: 409, statusMessage: "该请求标识已用于不同的消息内容，请重新发送以生成新的请求标识。" });
  }
  if (chatRequest?.lastError === DELETED_DESKTOP_CONVERSATION_REQUEST_ERROR) {
    throwDeletedDesktopConversationRequest();
  }
  if (chatRequest?.status === "COMPLETED" && chatRequest.response) {
    await validateDesktopConversationReplay(prisma, {
      conversationId: chatRequest.conversationId, characterId,
      memoryScopeId: character.memoryScopes.find((scope) => scope.scopeType === "CHARACTER_GLOBAL")?.id ?? null,
    });
    setResponseStatus(event, 200);
    return chatRequest.response;
  }
  if (chatRequest) {
    const claimed = await prisma.chatRequest.updateMany({
      where: {
        id: chatRequest.id,
        AND: [{ OR: [{ lastError: null }, { lastError: { not: DELETED_DESKTOP_CONVERSATION_REQUEST_ERROR } }] }],
        OR: [
          { status: "FAILED" },
          { status: "PROCESSING", updatedAt: { lt: staleBefore } },
        ],
      },
      data: { status: "PROCESSING", claimToken: randomUUID(), lastError: null, response: undefined, conversationId: null },
    });
    if (claimed.count !== 1) {
      throw createError({ statusCode: 409, statusMessage: "相同聊天请求正在处理中，请稍后刷新会话，避免重复发送。" });
    }
    chatRequest = await prisma.chatRequest.findUniqueOrThrow({ where: { id: chatRequest.id } });
  } else {
    try {
      chatRequest = await prisma.chatRequest.create({
        data: { ownerId, characterId, requestKey, requestHash, claimToken: randomUUID(), status: "PROCESSING" },
      });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
        const concurrentRequest = await prisma.chatRequest.findUnique({
          where: { ownerId_characterId_requestKey: { ownerId, characterId, requestKey } },
        });
        if (concurrentRequest && concurrentRequest.requestHash !== requestHash) {
          throw createError({ statusCode: 409, statusMessage: "该请求标识已用于不同的消息内容，请重新发送以生成新的请求标识。" });
        }
        if (concurrentRequest?.lastError === DELETED_DESKTOP_CONVERSATION_REQUEST_ERROR) {
          throwDeletedDesktopConversationRequest();
        }
        if (concurrentRequest?.status === "COMPLETED" && concurrentRequest.response) {
          await validateDesktopConversationReplay(prisma, {
            conversationId: concurrentRequest.conversationId, characterId,
            memoryScopeId: character.memoryScopes.find((scope) => scope.scopeType === "CHARACTER_GLOBAL")?.id ?? null,
          });
          setResponseStatus(event, 200);
          return concurrentRequest.response;
        }
        throw createError({ statusCode: 409, statusMessage: "相同聊天请求正在处理中，请稍后刷新会话，避免重复发送。" });
      }
      throw error;
    }
  }

  try {

  // Only character-global scopes and the acting user's own verified private scopes may be read.
  const accessibleScopes = resolveChatMemoryScopes(character.memoryScopes, ownerId);
  const globalScope = accessibleScopes.find((scope) => scope.origin === "character");
  if (!globalScope) throw createError({ statusCode: 409, statusMessage: "该角色尚未建立全局记忆范围，请重新保存角色档案。" });
  const memoryScopeId = globalScope.id;
  const readableScopeIds = accessibleScopes.map((scope) => scope.id);
  const scopeOriginById = new Map(accessibleScopes.map((scope) => [scope.id, scope.origin]));
  const privateScopeActive = accessibleScopes.some((scope) => scope.origin === "private");
  const chatSettings = resolveChatModelSettings(character.modelConfig);
  let apiKey = "";
  try {
    apiKey = await resolveCharacterApiKey(character.modelConfig, chatSettings.apiBaseUrl);
  } catch {
    throw createError({ statusCode: 503, statusMessage: "当前角色保存的 API Key 无法解密，请重新打开模型参数并填写 API Key。" });
  }
  if (!apiKey || !chatSettings.model) {
    throw createError({ statusCode: 503, statusMessage: "尚未配置模型 API。请在当前角色的「模型设置 → 模型参数」中填写 API Key 和模型名称。" });
  }

  const quota = await readDailyQuota(characterId, character.modelConfig);
  if (quota.exceeded) {
    throw createError({
      statusCode: 429,
      statusMessage: `今天的模型额度已用完（${quota.used} / ${quota.limit} tokens）。可以在「模型参数」里调高每日额度，或明天再聊。`,
    });
  }

  const existingConversation = requestedConversationId
    ? await prisma.conversation.findFirst({
        // channelBindingId: null —— 桌面端对话不能往 QQ 等外部渠道的会话里写消息。
        where: desktopConversationWhere({ id: requestedConversationId, characterId, memoryScopeId, status: "ACTIVE" }),
        select: { id: true, title: true },
      })
    : null;
  if (requestedConversationId && !existingConversation) {
    throw createError({ statusCode: 404, statusMessage: "会话不存在或不属于当前角色。" });
  }

  const recentStoredMessages = existingConversation
    ? await prisma.message.findMany({
        where: { conversationId: existingConversation.id },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        // 40 条约 20 轮问答，条数可在「模型设置」里按角色调整。
        // 20 条时她经常接不上十分钟前提过的事，用户会以为「记性差」，其实只是没被喂进去。
        take: resolveRecentMessageLimit(character.modelConfig),
        select: { id: true, role: true, content: true, occurredAt: true },
      })
    : [];
  const recentMessages: ConversationContextMessage[] = recentStoredMessages
    .reverse()
    .filter((item) => item.role === "USER" || item.role === "ASSISTANT")
    .map((item) => ({
      role: item.role as "USER" | "ASSISTANT",
      content: item.content.slice(0, 1800),
      occurredAt: item.occurredAt.toISOString(),
    }));

  const memoryCandidates = await prisma.memoryItem.findMany({
    where: { memoryScopeId: { in: readableScopeIds }, status: "ACTIVE", deletedAt: null },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: 300,
    select: {
      id: true, category: true, content: true, confidence: true, updatedAt: true, createdAt: true,
      validFrom: true, memoryScopeId: true, importance: true, lastRecalledAt: true, recallCount: true,
    },
  });
  const retrievalQuery = [
    message,
    ...recentMessages.filter((item) => item.role === "USER").slice(-2).map((item) => item.content),
  ].join("\n");
  const memoryRank = rankMemoriesWithBudget(retrievalQuery, memoryCandidates, {
    limit: resolveMemoryItemLimit(character.modelConfig),
    tokenBudget: resolveMemoryTokenBudget(character.modelConfig),
  });
  const memories = memoryRank.items.map((memory) => ({
    id: memory.id,
    category: memory.category,
    content: memory.content.slice(0, 1200),
    confidence: memory.confidence,
    relevanceScore: memory.relevanceScore,
    scope: scopeOriginById.get(memory.memoryScopeId) ?? "character",
    // 「这条记忆是什么时候的」：有 validFrom 就用它（那才是事实成立的时间），
    // 否则退回入库时间。没有这行，模型答不出「什么时候」，只能含糊过去。
    occurredAt: (memory.validFrom ?? memory.createdAt).toISOString(),
  }));

  const snapshotCandidates = await prisma.memorySnapshot.findMany({
    where: { memoryScopeId: { in: readableScopeIds }, status: "CURRENT" },
    orderBy: [{ createdAt: "desc" }, { version: "desc" }],
    take: 80,
    select: { id: true, summary: true, periodStart: true, periodEnd: true, version: true, createdAt: true, memoryScopeId: true },
  });
  const snapshotRank = rankSnapshotsWithBudget(retrievalQuery, snapshotCandidates, {
    limit: 4,
    tokenBudget: resolveSnapshotTokenBudget(character.modelConfig),
  });
  const snapshots = snapshotRank.items.map((snapshot) => ({
    id: snapshot.id,
    summary: snapshot.summary.slice(0, 3000),
    periodStart: snapshot.periodStart.toISOString(),
    periodEnd: snapshot.periodEnd.toISOString(),
    version: snapshot.version,
    relevanceScore: snapshot.relevanceScore,
    scope: scopeOriginById.get(snapshot.memoryScopeId) ?? "character",
  }));

  // 忆泡：先按问句里的日期框住那一天，框不住才退化成关键词。
  const eventCandidates = await prisma.memoryEvent.findMany({
    where: { memoryScopeId: { in: readableScopeIds }, status: "ACTIVE" },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: 200,
    select: {
      id: true, occurredAt: true, timeOfDay: true, place: true, participants: true,
      keywords: true, title: true, detail: true, memoryScopeId: true,
      // 按账号检索要读引用列（5–12 位数字当 QQ 号匹配）。
      participantRefs: true,
    },
  });
  /**
   * 名字是入口，账号才是身份。
   *
   * 问「小刚最近说了什么」时，忆泡里存的可能还是旧名「小明」—— 只比字符串一条都
   * 查不到。先把名字解析成平台账号，再让检索用 `participantRefs` 兜住改名。
   * 认不出是谁（或问句里没提人）就不传，退回纯字符串匹配。
   */
  const participantName = parseEventParticipantQuery(retrievalQuery);
  const participantIds = participantName ? await resolveParticipantAccounts(prisma, participantName, { characterId, platform: "web" }) : [];
  const eventSelection = selectEventsForPrompt(retrievalQuery, eventCandidates, {
    timeZone: resolveChatTimeZone(character.memorySetting?.timezone),
    tokenBudget: resolveEventTokenBudget(character.modelConfig),
    limit: resolveEventItemLimit(character.modelConfig),
    ...(participantIds.length ? { participantIds } : {}),
  });

  /**
   * 最近几天的忆泡：不看问句，无条件当背景带上。
   *
   * 和上面 `events` 是两条路：那条要靠时间或关键词命中，群里没人提问时它一条都不会带；
   * 这条只按时间取「最近几天我干了什么」，让她不至于对昨天一无所知。默认关（0），
   * 打开后会多占几百 token，所以做成按角色的开关。
   */
  const recentEventDays = resolveEventRecentDays(character.modelConfig);
  const recentEventSelection = recentEventDays > 0
    ? selectRecentEvents(eventCandidates, {
        days: recentEventDays,
        excludeIds: new Set(eventSelection.items.map((event) => event.id)),
      })
    : null;
  const recentEventItems = recentEventSelection?.items ?? [];

  /**
   * 名字刷新的唯一入口：忆泡存的是**记那一刻**的名字，群名片随时会改。
   * 两批一起过一遍，一次查询搞定（见 `participant-names.ts`）。
   */
  const participantsByEvent = await resolveEventParticipantNames(
    prisma,
    [...eventSelection.items, ...recentEventItems],
  );
  const participantsAt = (index: number, fallback: readonly string[]): string[] =>
    participantsByEvent[index] ?? [...fallback];

  const events = eventSelection.items.map((event, index) => ({
    id: event.id,
    occurredAt: event.occurredAt.toISOString(),
    ...(event.timeOfDay ? { timeOfDay: event.timeOfDay } : {}),
    ...(event.place ? { place: event.place } : {}),
    participants: participantsAt(index, event.participants),
    title: event.title,
    detail: event.detail.slice(0, 600),
    scope: scopeOriginById.get(event.memoryScopeId) ?? "character",
  }));
  const recentEvents = recentEventItems.map((event, index) => ({
    id: event.id,
    occurredAt: event.occurredAt.toISOString(),
    ...(event.timeOfDay ? { timeOfDay: event.timeOfDay } : {}),
    ...(event.place ? { place: event.place } : {}),
    participants: participantsAt(eventSelection.items.length + index, event.participants),
    title: event.title,
    detail: event.detail.slice(0, 600),
    scope: scopeOriginById.get(event.memoryScopeId) ?? "character",
  }));

  // 忆泡还没覆盖到那一段时，用原始对话兜底 —— 原文一直在库里，只是以前没有检索入口。
  // 只在问句确实指向某一天时才查，避免和最近对话窗口重复。
  let rawMessages: Array<{
    id: string;
    role: string;
    content: string;
    occurredAt: string;
    /** 群聊原文的发言人与主人标记：不带上，她读到的就是一句句没有主人的话。 */
    speaker?: string;
    isOwner?: boolean;
    scope: "character" | "private";
  }> = [];
  if (eventSelection.range) {
    const rawCandidates = await prisma.message.findMany({
      where: {
        conversation: { memoryScopeId: { in: readableScopeIds } },
        occurredAt: { gte: eventSelection.range.start, lt: eventSelection.range.end },
      },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      take: 200,
      select: {
        id: true, role: true, content: true, occurredAt: true, metadata: true,
        conversation: { select: { memoryScopeId: true } },
      },
    });
    const selected = selectRawMessagesForPrompt(retrievalQuery, rawCandidates, {
      timeZone: resolveChatTimeZone(character.memorySetting?.timezone),
      tokenBudget: resolveRawMessageTokenBudget(character.modelConfig),
      limit: resolveRawMessageLimit(character.modelConfig),
      excludeIds: new Set(recentStoredMessages.map((message) => message.id)),
    });
    rawMessages = selected.items.map((message) => {
      const speaker = readMessageSpeaker(message.metadata);
      return {
        id: message.id,
        role: message.role,
        // 截断由 selectRawMessagesForPrompt 统一负责（含「后面还有 N 字」标记），这里不再切片。
        content: message.content,
        occurredAt: message.occurredAt.toISOString(),
        // 原文兜底也要说清是谁讲的：只给 role，群聊里每一句都是「user」。
        ...(speaker.speaker ? { speaker: speaker.speaker } : {}),
        ...(readMessageIsOwner(message.metadata) ? { isOwner: true } : {}),
        scope: scopeOriginById.get(message.conversation.memoryScopeId) ?? "character",
      };
    });
  }

  /**
   * 梗语录：挑这一轮给她看的那几条。
   *
   * 读失败就当她没设过梗（`loadCatchphraseCatalog` 内部已经兜住异常）——
   * 一张附属表读不动，不该让整条回复失败。
   */
  const catchphrasePrompt = toCatchphrasePromptEntries(
    pickCatchphraseCatalog(await loadCatchphraseCatalog(characterId)),
  );
  /**
   * 昨天手账里的那一句：让她接得上「昨天自己写过什么」，但只给一句。
   * 整篇日记进提示词会把上下文撑爆，而一句已经够延续。
   */
  const journalLine = await readPreviousJournalLine(
    prisma,
    characterId,
    new Date(),
    resolveChatTimeZone(character.memorySetting?.timezone),
  );
  // 生日、名字、外观这类稳定事实只在手账里；群里问得到，网页对话也该问得到。
  const journalFacts = isSelfFactQuery(message)
    ? await loadJournalFacts(prisma, { characterId, query: message }).catch(() => [])
    : [];
  /**
   * 熟人名册：网页对话里同样要能回答「你跟谁关系最好」。
   *
   * 网页对话没有「当前群」，所以只有私聊的与跨群的两档（`inThisGroup` 是空数组）。
   * 读失败就当没有 —— 一张关系表读不动，不该让整条回复失败。
   */
  const acquaintances = await listAcquaintances({ characterId, limit: CLOSE_FRIEND_LIMIT }).catch(() => null);
  const timeZone = resolveChatTimeZone(character.memorySetting?.timezone);
  const memoryAssistant = await resolveMemoryAssistantRuntime(character.modelConfig, chatSettings.apiBaseUrl);

  const goals = await loadGoalsForPrompt(prisma, characterId, message).catch(() => []);
  const expressionHabits = await loadExpressionHabitsForPrompt(prisma, characterId, message).catch(() => []);
  const preferences = await loadPreferencesForPrompt(prisma, characterId, message).catch(() => []);
  const turnId = randomUUID();
  const turnDetail = createModelTurnDetail(false, [{ content: message, speaker: "主人" }]);
  let generated;
  const generationStartedAt = Date.now();
  try {
    generated = await generateConversationReplyWithMemoryAssistant({
      assistant: memoryAssistant,
      onTurnDetail: turnDetail.update,
      candidates: [],
      loadCandidates: async (searchQuery) => {
        const searchParticipantName = parseEventParticipantQuery(searchQuery);
        const searchParticipantIds = searchParticipantName
          ? await resolveParticipantAccounts(prisma, searchParticipantName, { characterId, platform: "web" })
          : [];
        const searchRange = parseEventTimeRange(searchQuery, new Date(), timeZone);
        const searchTerms = extractMemoryAssistantSearchTerms(searchQuery, 20);
        const contentMatches = searchTerms.map((term) => ({
          content: { contains: term, mode: "insensitive" as const },
        }));
        const rangeWhere = searchRange
          ? { occurredAt: { gte: searchRange.start, lt: searchRange.end } }
          : {};
        const wantsFirst = /第一次|首次|最开始|初次|头一回/u.test(searchQuery);
        const wantsLatest = /最近一次|上一次|上回|上次|最后一次/u.test(searchQuery);
        const eventOrder = wantsFirst ? "asc" as const : "desc" as const;
        const rawMessageOrder = wantsFirst ? "asc" as const : "desc" as const;

        // 深度检索不再只看最近 200 个忆泡 / 80 篇快照：明确主题和时间范围会额外查历史候选。
        const [targetedMemories, targetedSnapshots, targetedEvents] = await Promise.all([
          searchTerms.length
            ? prisma.memoryItem.findMany({
                where: {
                  memoryScopeId: { in: readableScopeIds },
                  status: "ACTIVE",
                  deletedAt: null,
                  OR: searchTerms.map((term) => ({ content: { contains: term, mode: "insensitive" as const } })),
                },
                orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
                take: 180,
                select: {
                  id: true, category: true, content: true, confidence: true, updatedAt: true, createdAt: true,
                  validFrom: true, memoryScopeId: true, importance: true, lastRecalledAt: true, recallCount: true,
                },
              })
            : Promise.resolve([]),
          searchRange || searchTerms.length
            ? prisma.memorySnapshot.findMany({
                where: {
                  memoryScopeId: { in: readableScopeIds },
                  status: "CURRENT",
                  ...(searchRange
                    ? { periodStart: { lt: searchRange.end }, periodEnd: { gte: searchRange.start } }
                    : {}),
                  ...(searchTerms.length
                    ? { OR: searchTerms.map((term) => ({ summary: { contains: term, mode: "insensitive" as const } })) }
                    : {}),
                },
                orderBy: [{ periodEnd: "desc" }, { version: "desc" }],
                take: 120,
                select: {
                  id: true, summary: true, periodStart: true, periodEnd: true, version: true, createdAt: true, memoryScopeId: true,
                },
              })
            : Promise.resolve([]),
          searchRange || searchTerms.length || wantsFirst || wantsLatest
            ? prisma.memoryEvent.findMany({
                where: {
                  memoryScopeId: { in: readableScopeIds },
                  status: "ACTIVE",
                  ...rangeWhere,
                  ...(searchTerms.length
                    ? {
                        OR: searchTerms.flatMap((term) => [
                          { title: { contains: term, mode: "insensitive" as const } },
                          { detail: { contains: term, mode: "insensitive" as const } },
                          { keywords: { has: term } },
                        ]),
                      }
                    : {}),
                },
                orderBy: [{ occurredAt: eventOrder }, { id: eventOrder }],
                take: searchRange ? 500 : 350,
                select: {
                  id: true, occurredAt: true, timeOfDay: true, place: true, participants: true,
                  keywords: true, title: true, detail: true, memoryScopeId: true, participantRefs: true,
                },
              })
            : Promise.resolve([]),
        ]);

        // 主题词没有命中或命中很少时，仍给语义检索器一小批同时间段候选，兼容同义表达。
        const fallbackEvents = (searchRange || searchTerms.length || wantsFirst || wantsLatest) && targetedEvents.length < 16
          ? await prisma.memoryEvent.findMany({
              where: {
                memoryScopeId: { in: readableScopeIds },
                status: "ACTIVE",
                ...rangeWhere,
              },
              orderBy: [{ occurredAt: eventOrder }, { id: eventOrder }],
              take: searchRange ? 500 : 350,
              select: {
                id: true, occurredAt: true, timeOfDay: true, place: true, participants: true,
                keywords: true, title: true, detail: true, memoryScopeId: true, participantRefs: true,
              },
            })
          : [];
        const uniqueById = <T extends { id: string }>(items: T[]): T[] =>
          [...new Map(items.map((item) => [item.id, item])).values()];
        const assistantMemoryCandidates = uniqueById([...memoryCandidates, ...targetedMemories]);
        const assistantSnapshotCandidates = uniqueById([...snapshotCandidates, ...targetedSnapshots]);
        const assistantEventCandidates = uniqueById([...eventCandidates, ...targetedEvents, ...fallbackEvents]);

        // 原文按当前用户 private scope 查询；主题词命中可跨过「最近 250 条」找到较早记录。
        // 不扫描共享 global scope 的群聊原文，避免把群聊里的话误当成主人的私聊。
        const privateRawScopeIds = readableScopeIds.filter((scopeId) => scopeOriginById.get(scopeId) === "private");
        const rawRowsByScope = await Promise.all(privateRawScopeIds.map(async (scopeId) => {
          const baseWhere = {
            conversation: { memoryScopeId: scopeId },
            role: { in: ["USER", "ASSISTANT"] as Array<"USER" | "ASSISTANT"> },
            ...rangeWhere,
          };
          const matched = await prisma.message.findMany({
            where: {
              ...baseWhere,
              ...(contentMatches.length ? { OR: contentMatches } : {}),
            },
            orderBy: [{ occurredAt: rawMessageOrder }, { id: rawMessageOrder }],
            take: searchRange ? 500 : 350,
            select: {
              id: true, role: true, content: true, occurredAt: true, metadata: true,
              conversation: { select: { memoryScopeId: true } },
            },
          });
          // 主题词命中不足时补一小批原文，给语义检索器识别近义表达的机会。
          // 无日期的泛问句最多补最近 40 条；明确时间范围仍可补 120 条。
          if ((!searchRange && !contentMatches.length) || matched.length >= 16) return matched;
          const fallback = await prisma.message.findMany({
            where: baseWhere,
            orderBy: [{ occurredAt: rawMessageOrder }, { id: rawMessageOrder }],
            take: searchRange ? 120 : 40,
            select: {
              id: true, role: true, content: true, occurredAt: true, metadata: true,
              conversation: { select: { memoryScopeId: true } },
            },
          });
          return uniqueById([...matched, ...fallback]);
        }));
        const assistantRawMessages = rawRowsByScope.flat().map((row) => {
          const speaker = readMessageSpeaker(row.metadata);
          return {
            id: row.id,
            role: row.role,
            content: row.content,
            occurredAt: row.occurredAt,
            memoryScopeId: row.conversation.memoryScopeId,
            ...(speaker.speaker ? { speaker: speaker.speaker } : {}),
            ...(readMessageIsOwner(row.metadata) ? { isOwner: true } : {}),
          };
        });
        return buildMemoryAssistantCandidates({
          query: searchQuery,
          memories: assistantMemoryCandidates,
          snapshots: assistantSnapshotCandidates,
          events: assistantEventCandidates,
          rawMessages: assistantRawMessages,
          excludeRawMessageIds: new Set([
            ...recentStoredMessages.map((item) => item.id),
            ...rawMessages.map((item) => item.id),
          ]),
          scopeOf: (scopeId) => scopeOriginById.get(scopeId) ?? "character",
          timeZone,
          ...(searchParticipantIds.length ? { participantIds: searchParticipantIds } : {}),
          allowPrivate: true,
        });
      },
      chatInput: {
        preferences,
        expressionHabits,
        goals,
        characterName: character.name,
        characterPrompt: character.basePrompt.slice(0, 12_000),
        styleExamples: (character.styleExamples ?? "").slice(0, 8000),
        // 称呼是角色级的私人设定：只在网页对话注入，QQ/B站 的对话方不一定是本人。
        userAddress: character.userAddress ?? "",
        model: chatSettings.model,
        apiKey,
        apiBaseUrl: chatSettings.apiBaseUrl,
        temperature: chatSettings.temperature,
        maxTokens: chatSettings.maxTokens,
        thinking: chatSettings.thinking,
        currentMessage: message,
        recentMessages,
        memories,
        snapshots,
        events,
        ...(recentEvents.length ? { recentEvents } : {}),
        rawMessages,
        timeZone,
        ...(journalLine ? { journalLine } : {}),
        ...(journalFacts.length ? { journalFacts } : {}),
        ...(acquaintances ? { acquaintances } : {}),
        ...(catchphrasePrompt.length ? { catchphrases: catchphrasePrompt } : {}),
      },
    });
  } catch (error) {
    await recordModelUsage({
      kind: "chat", model: chatSettings.model, characterId, userId: ownerId,
      metadata: { status: "failed", reason: "model_generation_failed", durationMs: Date.now() - generationStartedAt, turnId, turnDetail: turnDetail.serialize() },
    });
    const detail = error instanceof Error ? error.message : "模型调用失败。";
    throw createError({
      statusCode: detail.startsWith("LLM_NOT_CONFIGURED") ? 503 : 502,
      statusMessage: detail.slice(0, 700),
    });
  }

  turnDetail.update({ response: { action: generated.action, reply: generated.reply, explanation: generated.responseExplanation } });
  const generationDurationMs = Date.now() - generationStartedAt;
  await recordModelUsage({
    kind: "chat", model: generated.model, usage: toUsageTokens(generated.usage), characterId, userId: ownerId,
    ...(existingConversation ? { conversationId: existingConversation.id } : {}),
    metadata: { status: "success", durationMs: generationDurationMs, turnId, turnDetail: turnDetail.serialize() },
  });
  const usedMemoryIds = new Set(generated.usedMemoryIds);
  const usedSnapshotIds = new Set(generated.usedSnapshotIds);
  const usedEventIds = new Set(generated.usedEventIds);
  const usedRawMessageIds = new Set(generated.usedRawMessageIds);
  const assistantSources = generated.memoryAssistantSources ?? [];
  const allMemorySources = [
    ...memories,
    ...assistantSources.filter((source) => source.sourceType === "memory").map((source) => ({
      id: source.id, category: source.category ?? "FACT", content: source.content ?? "", scope: source.scope,
    })),
  ];
  const allSnapshotSources = [
    ...snapshots,
    ...assistantSources.filter((source) => source.sourceType === "snapshot").map((source) => ({
      id: source.id, summary: source.summary ?? "", periodStart: source.periodStart ?? "",
      periodEnd: source.periodEnd ?? "", version: source.version ?? 1, scope: source.scope,
    })),
  ];
  const allRawMessageSources = [
    ...rawMessages,
    ...assistantSources.filter((source) => source.sourceType === "message").map((source) => ({
      id: source.id,
      role: source.role ?? "USER",
      content: source.content ?? "",
      occurredAt: source.occurredAt ?? "",
      ...(source.speaker ? { speaker: source.speaker } : {}),
      ...(source.isOwner ? { isOwner: true } : {}),
      scope: source.scope,
    })),
  ];
  const usedSources = {
    goals: usedGoalSnapshots(goals, generated.usedGoalIds ?? []),
    expressionHabits: usedExpressionHabitSnapshots(expressionHabits, generated.usedExpressionHabitIds ?? []),
    preferences: usedPreferenceSnapshots(preferences, generated.usedPreferenceIds ?? []),
    memories: allMemorySources.filter((memory, index, all) => usedMemoryIds.has(memory.id)
      && all.findIndex((candidate) => candidate.id === memory.id) === index)
      .map(({ id, category, content, scope }) => ({ id, category, content, scope })),
    snapshots: allSnapshotSources.filter((snapshot, index, all) => usedSnapshotIds.has(snapshot.id)
      && all.findIndex((candidate) => candidate.id === snapshot.id) === index)
      .map(({ id, summary, periodStart, periodEnd, version, scope }) => ({ id, summary, periodStart, periodEnd, version, scope })),
    // 忆泡：模型回填的 id 已经过来源白名单校验，这里只负责按 id 取出展示信息。
    events: eventCandidates.filter((event) => usedEventIds.has(event.id))
      .map((event) => ({ id: event.id, title: event.title, occurredAt: event.occurredAt, participants: event.participants })),
    rawMessages: allRawMessageSources.filter((message, index, all) => usedRawMessageIds.has(message.id)
      && all.findIndex((candidate) => candidate.id === message.id) === index)
      .map(({ id, role, content, occurredAt, speaker, isOwner, scope }) => ({
        id, role, content, occurredAt, ...(speaker ? { speaker } : {}), ...(isOwner ? { isOwner } : {}), scope,
      })),
  };

  const now = new Date();
  const assistantAt = new Date(now.getTime() + 1);
  const proposedTitle = message.slice(0, 80);
  const title = existingConversation?.title || proposedTitle;
  const response = await prisma.$transaction(async (tx) => {
    const conversation = existingConversation ?? await tx.conversation.create({
      data: { characterId, memoryScopeId, title, status: "ACTIVE", metadata: { createdFrom: "yiling-chat-ui" } },
      select: { id: true, title: true },
    });
    await lockActiveDesktopConversationForWrite(tx, {
      id: conversation.id, characterId, memoryScopeId, lastMessageAt: assistantAt,
    });
    const userMessage = await tx.message.create({
      data: {
        conversationId: conversation.id,
        role: "USER",
        content: message,
        occurredAt: now,
        metadata: { source: "yiling-chat-ui" },
      },
      select: { id: true, role: true, content: true, occurredAt: true },
    });
    const assistantMessage = await tx.message.create({
      data: {
        conversationId: conversation.id,
        role: "ASSISTANT",
        content: generated.reply,
        occurredAt: assistantAt,
        metadata: {
          generatedBy: "llm",
          model: generated.model,
          provider: generated.provider,
          promptTemplateVersion: generated.promptTemplateVersion,
          usedMemoryIds: generated.usedMemoryIds,
          usedSnapshotIds: generated.usedSnapshotIds,
          usedRawMessageIds: generated.usedRawMessageIds,
          usedCatchphraseIds: generated.usedCatchphraseIds,
          usedPreferenceIds: generated.usedPreferenceIds ?? [],
          usedExpressionHabitIds: generated.usedExpressionHabitIds ?? [],
          usedGoalIds: generated.usedGoalIds ?? [],
          usedSources,
          usage: generated.usage ?? {},
        },
      },
      select: { id: true, role: true, content: true, occurredAt: true },
    });

    const saved = {
      conversationId: conversation.id,
      title: conversation.title || title,
      userMessage,
      assistantMessage,
    };
    const result = {
      ...saved,
      userMessage: { ...saved.userMessage, sources: { memories: [], snapshots: [] } },
      assistantMessage: { ...saved.assistantMessage, sources: usedSources },
      model: { name: generated.model, provider: generated.provider, promptTemplateVersion: generated.promptTemplateVersion },
      retrieval: {
        memoriesAvailable: memories.length,
        snapshotsAvailable: snapshots.length,
        privateScopeActive,
        memoryTokens: memoryRank.usedTokens,
        memoryDropped: memoryRank.dropped,
        snapshotTokens: snapshotRank.usedTokens,
        snapshotDropped: snapshotRank.dropped,
      },
    };
    // Commit messages and the replayable response atomically. A database failure must not
    // leave saved messages behind while the request is marked FAILED and retried.
    const finalized = await tx.chatRequest.updateMany({
      where: { id: chatRequest.id, status: "PROCESSING", claimToken: chatRequest.claimToken },
      data: { status: "COMPLETED", conversationId: saved.conversationId, response: result, lastError: null },
    });
    if (finalized.count !== 1) {
      // The lease was reclaimed while this model call was running. Throwing rolls back
      // this transaction, so the stale claimant cannot append duplicate messages.
      throw createError({ statusCode: 409, statusMessage: "聊天请求已被新的重试接管，请刷新会话后查看结果。" });
    }
    return result;
  });
  // 只给模型真的用到的记忆记一次召回：进过提示词但没被引用的不算"用上了"。
  if (usedMemoryIds.size) {
    await prisma.memoryItem.updateMany({
      where: { id: { in: [...usedMemoryIds] } },
      data: { lastRecalledAt: new Date(), recallCount: { increment: 1 } },
    }).catch(() => undefined);
  }
  // 梗的使用记账：`lastUsedAt` 是冷却的唯一依据，漏记就等于没有冷却。
  // 写失败静默 —— 回复已经落在库里了，这时候抛错只会让用户以为没发出去。
  await markCatchphrasesUsed(characterId, generated.usedCatchphraseIds);


  if (generated.memoryAssistantModel && generated.memoryAssistantStatus) {
    await recordModelUsage({
      kind: "memory-assistant",
      model: generated.memoryAssistantModel,
      usage: toUsageTokens(generated.memoryAssistantUsage),
      characterId,
      userId: ownerId,
      conversationId: response.conversationId,
      metadata: {
        status: generated.memoryAssistantStatus,
        turnId,
        ...(generated.memoryAssistantFailureReason ? { reason: generated.memoryAssistantFailureReason } : {}),
        ...(typeof generated.memoryAssistantAttempts === "number" ? { attempts: generated.memoryAssistantAttempts } : {}),
        ...(generated.memoryAssistantFinishReason ? { finishReason: generated.memoryAssistantFinishReason } : {}),
        ...(typeof generated.memoryAssistantHttpStatus === "number" ? { httpStatus: generated.memoryAssistantHttpStatus } : {}),
      },
    });
  }
  setResponseStatus(event, 201);
  return response;
  } catch (error) {
    const statusMessage = error instanceof Error ? error.message : "聊天请求失败。";
    try {
      await prisma.chatRequest.updateMany({
        where: { id: chatRequest.id, status: "PROCESSING", claimToken: chatRequest.claimToken },
        data: { status: "FAILED", lastError: statusMessage.slice(0, 700) },
      });
    } catch {
      // Preserve the original error; a stale PROCESSING request can be reclaimed after the lease expires.
    }
    throw error;
  }
});
