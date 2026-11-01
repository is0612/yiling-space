import { createHash, randomUUID } from "node:crypto";
import { createError, getRouterParam, readBody, setResponseStatus } from "h3";
import { generateConversationReply, type ConversationContextMessage } from "../../../utils/chat-reply";
import {
  loadCatchphraseCatalog, markCatchphrasesUsed, pickCatchphraseCatalog, toCatchphrasePromptEntries,
} from "../../../utils/catchphrases";
import { resolveChatModelSettings } from "../../../utils/chat-model-config";
import { resolveChatTimeZone } from "../../../utils/chat-time-context";
import { resolveCharacterApiKey } from "../../../utils/credential-encryption";
import { CLOSE_FRIEND_LIMIT, listAcquaintances } from "../../../utils/friends";
import {
  rankMemoriesWithBudget, rankSnapshotsWithBudget,
  resolveMemoryItemLimit, resolveMemoryTokenBudget, resolveRecentMessageLimit, resolveSnapshotTokenBudget,
} from "../../../utils/memory-retrieval";
import {
  resolveEventItemLimit, resolveEventTokenBudget, selectEventsForPrompt,
} from "../../../utils/memory-event-retrieval";
import {
  resolveRawMessageLimit, resolveRawMessageTokenBudget, selectRawMessagesForPrompt,
} from "../../../utils/message-retrieval";
import { recordModelUsage, readDailyQuota, toUsageTokens } from "../../../utils/model-usage";
import { resolveChatMemoryScopes } from "../../../utils/memory-scope-access";
import { requireActorUserId } from "../../../utils/auth";
import { readTrimmedString, requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";
import { readPreviousJournalLine } from "../../../utils/journal-service";

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
  if (chatRequest?.status === "COMPLETED" && chatRequest.response) {
    setResponseStatus(event, 200);
    return chatRequest.response;
  }
  if (chatRequest) {
    const claimed = await prisma.chatRequest.updateMany({
      where: {
        id: chatRequest.id,
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
        if (concurrentRequest?.status === "COMPLETED" && concurrentRequest.response) {
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
    throw createError({ statusCode: 503, statusMessage: "尚未配置模型 API。请在当前角色的「AI 对话 → 模型参数」中填写 API Key 和模型名称。" });
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
        where: { id: requestedConversationId, characterId, memoryScopeId, channelBindingId: null, status: "ACTIVE" },
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
  const eventSelection = selectEventsForPrompt(retrievalQuery, eventCandidates, {
    timeZone: resolveChatTimeZone(character.memorySetting?.timezone),
    tokenBudget: resolveEventTokenBudget(character.modelConfig),
    limit: resolveEventItemLimit(character.modelConfig),
  });
  const events = eventSelection.items.map((event) => ({
    id: event.id,
    occurredAt: event.occurredAt.toISOString(),
    ...(event.timeOfDay ? { timeOfDay: event.timeOfDay } : {}),
    ...(event.place ? { place: event.place } : {}),
    participants: event.participants,
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
        id: true, role: true, content: true, occurredAt: true,
        conversation: { select: { memoryScopeId: true } },
      },
    });
    const selected = selectRawMessagesForPrompt(retrievalQuery, rawCandidates, {
      timeZone: resolveChatTimeZone(character.memorySetting?.timezone),
      tokenBudget: resolveRawMessageTokenBudget(character.modelConfig),
      limit: resolveRawMessageLimit(character.modelConfig),
      excludeIds: new Set(recentStoredMessages.map((message) => message.id)),
    });
    rawMessages = selected.items.map((message) => ({
      id: message.id,
      role: message.role,
      // 截断由 selectRawMessagesForPrompt 统一负责（含「后面还有 N 字」标记），这里不再切片。
      content: message.content,
      occurredAt: message.occurredAt.toISOString(),
      scope: scopeOriginById.get(message.conversation.memoryScopeId) ?? "character",
    }));
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
  /**
   * 熟人名册：网页对话里同样要能回答「你跟谁关系最好」。
   *
   * 网页对话没有「当前群」，所以只有私聊的与跨群的两档（`inThisGroup` 是空数组）。
   * 读失败就当没有 —— 一张关系表读不动，不该让整条回复失败。
   */
  const acquaintances = await listAcquaintances({ characterId, limit: CLOSE_FRIEND_LIMIT }).catch(() => null);

  let generated;
  try {
    generated = await generateConversationReply({
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
      currentMessage: message,
      recentMessages,
      memories,
      snapshots,
      events,
      rawMessages,
      timeZone: resolveChatTimeZone(character.memorySetting?.timezone),
      ...(journalLine ? { journalLine } : {}),
      ...(acquaintances ? { acquaintances } : {}),
      ...(catchphrasePrompt.length ? { catchphrases: catchphrasePrompt } : {}),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "模型调用失败。";
    throw createError({
      statusCode: detail.startsWith("LLM_NOT_CONFIGURED") ? 503 : 502,
      statusMessage: detail.slice(0, 700),
    });
  }

  const usedMemoryIds = new Set(generated.usedMemoryIds);
  const usedSnapshotIds = new Set(generated.usedSnapshotIds);
  const usedEventIds = new Set(generated.usedEventIds);
  const usedSources = {
    memories: memories.filter((memory) => usedMemoryIds.has(memory.id))
      .map(({ id, category, content, scope }) => ({ id, category, content, scope })),
    snapshots: snapshots.filter((snapshot) => usedSnapshotIds.has(snapshot.id))
      .map(({ id, summary, periodStart, periodEnd, version, scope }) => ({ id, summary, periodStart, periodEnd, version, scope })),
    // 忆泡：模型回填的 id 已经过来源白名单校验，这里只负责按 id 取出展示信息。
    events: eventCandidates.filter((event) => usedEventIds.has(event.id))
      .map((event) => ({ id: event.id, title: event.title, occurredAt: event.occurredAt, participants: event.participants })),
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
          usedCatchphraseIds: generated.usedCatchphraseIds,
          usedSources,
          usage: generated.usage ?? {},
        },
      },
      select: { id: true, role: true, content: true, occurredAt: true },
    });
    await tx.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: assistantAt } });

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

  await recordModelUsage({
    kind: "chat",
    model: generated.model,
    usage: toUsageTokens(generated.usage),
    characterId,
    userId: ownerId,
    conversationId: response.conversationId,
  });
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
