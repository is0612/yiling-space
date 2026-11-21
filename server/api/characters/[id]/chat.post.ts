import { loadPromptEventCandidates } from "../../../utils/prompt-event-candidates";
import { loadPromptMemoryCandidates } from "../../../utils/prompt-memory-candidates";
import { readInteractionExperiences } from "../../../utils/interaction-experiences";
import { asksSelfUnderstandingHistory, wantsSelfUnderstanding, selfUnderstandingReferences } from "../../../utils/self-understanding";
import { loadSelfUnderstanding } from "../../../utils/self-understanding-reader";
import { readInteractionGuidance } from "../../../utils/interaction-guidance";
import { prepareConversationSummary } from "../../../utils/conversation-summary";
import { loadGoalsForPrompt, usedGoalSnapshots } from "../../../utils/goal-retrieval";
import { loadExpressionHabitsForPrompt, usedExpressionHabitSnapshots } from "../../../utils/expression-habit-retrieval";
import { loadPreferencesForPrompt, usedPreferenceSnapshots } from "../../../utils/preference-retrieval";
import { createHash, randomUUID } from "node:crypto";
import { createError, getRouterParam, readBody, setResponseStatus } from "h3";
import { type ConversationContextMessage } from "../../../utils/chat-reply";
import { createModelTurnDetail } from "../../../utils/model-turn-detail";
import { createAssistantTurnContext } from "../../../utils/assistant-turn-context";
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
import { loadChatKnowledge } from "../../../utils/chat-knowledge-retrieval";
import { runAssistantTurnStage } from "../../../utils/assistant-turn-execution";
import { reconcileGrowthReadUsage, type GrowthReadDiagnostic } from "../../../utils/growth-read-diagnostics";
import { resolveCharacterApiKey } from "../../../utils/credential-encryption";
import { CLOSE_FRIEND_LIMIT, listAcquaintances } from "../../../utils/friends";
import {
  extractMemoryAssistantSearchTerms,
  resolveMemoryItemLimit, resolveMemoryTokenBudget, resolveRecentMessageLimit, resolveSnapshotTokenBudget,
} from "../../../utils/memory-retrieval";
import {
  parseEventParticipantQuery, resolveEventItemLimit, resolveEventTokenBudget, resolveEventRecentDays,
} from "../../../utils/memory-event-retrieval";
import { selectPromptMemoryContext } from "../../../utils/prompt-memory-selection";
import {
  resolveRawMessageLimit, resolveRawMessageTokenBudget, selectRawMessagesForPrompt,
} from "../../../utils/message-retrieval";
import { recordModelUsage, readDailyQuota, toUsageTokens } from "../../../utils/model-usage";
import { resolveChatMemoryScopes } from "../../../utils/memory-scope-access";
import { requireActor } from "../../../utils/auth";
import { auditLocalObserve, listLocalDirectory, listLocalObserveRoots, readLocalTextFile, searchLocalProject } from "../../../utils/local-observe";
import { createLocalWriteRequest } from "../../../utils/local-write";
import { createLocalTask } from "../../../utils/local-tasks";
import { observePublicBrowser } from "../../../utils/browser-observe";
import { createLocalBrowserRequest } from "../../../utils/local-browser";
import { readLocalContinuationTask } from "../../../utils/local-chat-results";
import { createGitBranchRequest, createLocalCommandRequest } from "../../../utils/local-command";
import { readGitStatus } from "../../../utils/local-git";
import { resolveObserveRoot } from "../../../utils/local-observe";
import { readTrimmedString, requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";
import { desktopConversationWhere, DELETED_DESKTOP_CONVERSATION_REQUEST_ERROR, lockActiveDesktopConversationForWrite, throwDeletedDesktopConversationRequest, validateDesktopConversationReplay } from "../../../utils/desktop-conversation";
import { readMessageIsOwner, readMessageSpeaker } from "../../../utils/conversation-message";
import { resolveEventParticipantNames, resolveParticipantAccounts } from "../../../utils/participant-names";
import { readPreviousJournalLine, readRecentJournals, dropDuplicateJournalQuote } from "../../../utils/journal-service";
import { isSelfFactQuery, loadJournalFacts } from "../../../utils/journal-facts";

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event);
  const ownerId = actor.user.id;
  const isAdmin = actor.user.role === "ADMIN";
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
  const localTaskId = body?.localTaskId === undefined ? null : requireUuid(String(body.localTaskId), "本地任务");
  if (localTaskId) {
    if (!isAdmin) throw createError({ statusCode: 403, message: "本地任务续办仅限管理员。" });
    if (!requestedConversationId) throw createError({ statusCode: 400, message: "续办必须指定原会话。" });
  }
  // Bind a stable idempotency key to the exact user input and target conversation.
  // The hash contains no credentials or model configuration.
  const requestHash = createHash("sha256")
    .update(JSON.stringify({ message, conversationId: requestedConversationId, ...(localTaskId ? { localTaskId } : {}) }))
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
        select: { id: true, role: true, content: true, occurredAt: true, metadata: true },
      })
    : [];
  const recentMessages: ConversationContextMessage[] = recentStoredMessages
    .reverse()
    .filter((item) => item.role === "USER" || item.role === "ASSISTANT")
    .map((item) => ({
      id: item.id,
      role: item.role as "USER" | "ASSISTANT",
      content: item.content.slice(0, 1800),
      occurredAt: item.occurredAt.toISOString(),
    }));

  const retrievalQuery = [
    message,
    ...recentMessages.filter((item) => item.role === "USER").slice(-2).map((item) => item.content),
  ].join("\n");
  const { memories: memoryCandidates, snapshots: snapshotCandidates } = await loadPromptMemoryCandidates(prisma, {
    readableScopeIds, query: retrievalQuery,
  });

  /**
   * 名字是入口，账号才是身份。
   *
   * 问「小刚最近说了什么」时，忆泡里存的可能还是旧名「小明」—— 只比字符串一条都
   * 查不到。先把名字解析成平台账号，再让检索用 `participantRefs` 兜住改名。
   * 认不出是谁（或问句里没提人）就不传，退回纯字符串匹配。
   */
  const eventRetrievalNow = new Date();
  const participantName = parseEventParticipantQuery(retrievalQuery);
  const participantIds = participantName ? await resolveParticipantAccounts(prisma, participantName, { characterId, platform: "web" }) : [];
  const eventCandidates = await loadPromptEventCandidates(prisma, {
    readableScopeIds, query: retrievalQuery, participantIds, now: eventRetrievalNow,
    timeZone: resolveChatTimeZone(character.memorySetting?.timezone),
  });
  /**
   * 记忆、阶段总结、忆泡的选择与整形和 QQ 共用一份（`prompt-memory-selection.ts`）：
   * 预算、600 字截断、scope 标签、名字刷新只在这里定义一次。
   *
   * 最近几天的忆泡（`recentEventDays`，默认关）也在里面：它不看问句，只按时间带背景。
   */
  const { memories, snapshots, events, recentEvents, eventSelection, selection: memorySelection } = await selectPromptMemoryContext({
    query: retrievalQuery,
    now: eventRetrievalNow,
    timeZone: resolveChatTimeZone(character.memorySetting?.timezone),
    memoryCandidates,
    snapshotCandidates,
    eventCandidates,
    participantIds,
    limits: {
      memoryItems: resolveMemoryItemLimit(character.modelConfig),
      memoryTokens: resolveMemoryTokenBudget(character.modelConfig),
      snapshots: 4,
      snapshotTokens: resolveSnapshotTokenBudget(character.modelConfig),
      events: resolveEventItemLimit(character.modelConfig),
      eventTokens: resolveEventTokenBudget(character.modelConfig),
      recentEventDays: resolveEventRecentDays(character.modelConfig),
    },
    scopeOf: (memoryScopeId) => scopeOriginById.get(memoryScopeId) ?? "character",
    loadParticipantNames: (items) => resolveEventParticipantNames(prisma, items),
  });

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
  /**
   * 最近两天的日记正文：网页对话就是主人自己在聊，她该看得到自己写过什么。
   *
   * 只取两天、正文在 `chat-reply` 里按 800 字截断 —— 整本日记进提示词会把上下文撑爆，
   * 这条界限和上面「一句已经够延续」是同一个理由，只是主人这边可以多给一点。
   */
  const journalRecent = await readRecentJournals(prisma, { characterId, limit: 2 })
    .then((entries) => dropDuplicateJournalQuote(entries, journalLine))
    .catch(() => []);
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
  const selfUnderstanding = wantsSelfUnderstanding(message, { groupChat: false, previousMessage: recentStoredMessages.at(-1) })
    ? await loadSelfUnderstanding(prisma, { characterId, readableScopeIds, conversationId: existingConversation?.id, groupChat: false, profileOwner: true, includeHistory: asksSelfUnderstandingHistory(message, true) }).catch(() => { console.warn("[self-understanding] Web evidence unavailable"); return undefined; })
    : undefined;
  const timeZone = resolveChatTimeZone(character.memorySetting?.timezone);
  const memoryAssistant = await resolveMemoryAssistantRuntime(character.modelConfig, chatSettings.apiBaseUrl);

  const growthReads = new Map<GrowthReadDiagnostic["domain"], GrowthReadDiagnostic>();
  const observeGrowthRead = (entry: GrowthReadDiagnostic) => { growthReads.set(entry.domain, entry); };
  const goals = await loadGoalsForPrompt(prisma, characterId, message, observeGrowthRead).catch(() => []);
  const expressionHabits = await loadExpressionHabitsForPrompt(prisma, characterId, message, observeGrowthRead,
    existingConversation ? { conversationId: existingConversation.id, memoryScopeId } : undefined, "PRIVATE").catch(() => []);
  const preferences = await loadPreferencesForPrompt(prisma, characterId, message, observeGrowthRead).catch(() => []);
  const interactionGuidance = await readInteractionGuidance(prisma, { characterId, query: message, chatScene: "PRIVATE" }).catch(() => []);
  const interactionExperiences = existingConversation ? await readInteractionExperiences(prisma, {
    characterId, conversationId: existingConversation.id, memoryScopeId, query: message,
    recentQueries: recentMessages.filter(row => row.role === "USER").slice(-4).map(row => row.content.slice(0, 500)),
  }).catch(() => { console.warn("[interaction-experience] desktop read unavailable"); return []; }) : [];
  const conversationSummary = existingConversation ? await prepareConversationSummary(prisma, {
    characterId, conversationId: existingConversation.id, memoryScopeId, channelBindingId: null,
    model: chatSettings.model, apiKey, apiBaseUrl: chatSettings.apiBaseUrl,
  }).catch(() => null) : null;
  const chatInputRecentMessages = conversationSummary
    ? recentMessages.filter(row => !row.occurredAt || row.occurredAt > conversationSummary.through.occurredAt
      || (row.occurredAt === conversationSummary.through.occurredAt && (row.id ?? "") > conversationSummary.through.id))
    : recentMessages;
  const turnId = randomUUID();
  // The Web API creates its turn only after resolving the actor and readable scopes.
  // Infrastructure names keep compatibility with existing local conversations.
  const turnContext = createAssistantTurnContext({
    turnId,
    identity: {
      characterId, channel: "direct-chat",
      conversationKey: existingConversation?.id ?? chatRequest.id,
      readableScopeIds, allowPrivate: true,
    },
    evidenceIds: [...new Set(chatInputRecentMessages.map(row => row.id).filter((id): id is string => typeof id === "string" && Boolean(id)))],
  });
  turnContext.skip("context", "not_enabled");
  // Reuse the same authorized reader as channel chat. SQL is not a model request.
  const knowledgeItems = await runAssistantTurnStage(turnContext, "knowledge", message,
    { characterId, readableScopeIds }, () => loadChatKnowledge(prisma, characterId, message, observeGrowthRead),
    rows => !rows.length).catch(() => []);
  const turnDetail = createModelTurnDetail(false, [{ content: message, speaker: "主人" }], "web");
  let generated;
  const generationStartedAt = Date.now();
  if (localTaskId) {
    if (!existingConversation) throw createError({ statusCode: 404, message: "原会话不存在。" });
    await readLocalContinuationTask(ownerId, characterId, existingConversation.id, localTaskId);
  }
  let continuationRead = false;
  const requireContinuationRead = () => { if (localTaskId && !continuationRead) throw new Error("续办前必须先调用 read_current_local_task 核对已有结果。"); };
  const proposedWriteIds: string[] = [];
  const localRootsForTools = isAdmin ? await listLocalObserveRoots(false).catch(() => []) : [];
  const resolveLocalToolRoot = async (value: string) => {
    const root = localRootsForTools.find((item) =>
      item.id === value || item.label === value || item.path.toLowerCase() === value.toLowerCase());
    if (!root) throw new Error("这个目录不在授权列表里。");
    return root;
  };
  const localReadOnlyTools = isAdmin ? {
    observeBrowser: async (url: string) => {
      try {
        const { screenshot: _image, ...result } = await observePublicBrowser(url);
        auditLocalObserve(ownerId, "browser.observe", { source: "chat", origin: new URL(result.url).origin, status: "success" });
        return result;
      } catch (error) {
        auditLocalObserve(ownerId, "browser.observe", { source: "chat", status: "failed", code: error instanceof Error ? error.message : "BROWSER_OBSERVE_FAILED" });
        throw error;
      }
    },
    proposeBrowserActions: async (url: string, actionsJson: string, reason: string, taskId?: string) => {
      requireContinuationRead();
      if (localTaskId && taskId && taskId !== localTaskId) throw new Error("续办不能改到其他任务。");
      let actions: unknown;
      try { actions = JSON.parse(actionsJson || "[]"); } catch { throw new Error("actions 必须是 JSON 数组。"); }
      const request = await createLocalBrowserRequest({
        url, actions, reason, actorId: ownerId, characterId,
        attachStep: Boolean(localTaskId),
        ...(existingConversation?.id ? { conversationId: existingConversation.id } : {}),
        ...(taskId ?? localTaskId ? { taskId: taskId ?? localTaskId! } : {}),
      });
      return { status: "PENDING_APPROVAL", requestId: request.id, url: request.url, actions: request.actions,
        submitSelector: request.submitSelector,
        message: request.submitSelector
          ? "申请已提交，等待主人批准填写；提交按钮要等主人看到填写结果后再单独确认一次。"
          : "申请已提交，等待主人批准；网页尚未操作。请在「本地观察 → 网页操作」核对步骤。" };
    },
    ...(localTaskId && existingConversation ? { readLocalTask: async () => {
      const result = await readLocalContinuationTask(ownerId, characterId, existingConversation.id, localTaskId);
      continuationRead = true;
      return result;
    } } : {}),
    localRoots: async () => localRootsForTools.map(({ id, label, path, mode }) => ({ id, label, path, mode })),
    inspectGit: async (rootValue: string, cwd: string) => {
      const { id } = await resolveLocalToolRoot(rootValue);
      const root = await resolveObserveRoot(id);
      const result = readGitStatus(root.path, cwd);
      auditLocalObserve(ownerId, "git.inspect", { source: "chat", rootId: id, cwd });
      return result;
    },
    createLocalTask: async (title: string, goal: string, plan: string) => {
      if (localTaskId) throw new Error("当前在续办已有任务，请勿重新建任务。");
      const task = await createLocalTask({
        title, goal, plan, actorId: ownerId, characterId,
        ...(existingConversation?.id ? { conversationId: existingConversation.id } : {}),
      });
      return { taskId: task.id, title: task.title, status: task.status, message: "任务档案已创建；写文件仍需单独审批。" };
    },
    listLocalFiles: async (rootValue: string, path: string) => {
      let rootId = "";
      try {
        const root = await resolveLocalToolRoot(rootValue);
        rootId = root.id;
        const result = listLocalDirectory(root.path, path);
        auditLocalObserve(ownerId, "list", { source: "chat", rootId, path: result.path, entries: result.entries.length, truncated: result.truncated });
        return { root: { id: root.id, label: root.label }, ...result };
      } catch (error) {
        auditLocalObserve(ownerId, "list", { source: "chat", rootId, path, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },
    readLocalFile: async (rootValue: string, path: string) => {
      let rootId = "";
      try {
        const root = await resolveLocalToolRoot(rootValue);
        rootId = root.id;
        const result = readLocalTextFile(root.path, path);
        const content = result.content.slice(0, 6000);
        auditLocalObserve(ownerId, "read", { source: "chat", rootId, path: result.path, bytes: result.size, lines: result.lines });
        return { root: { id: root.id, label: root.label }, ...result, content, truncated: result.content.length > content.length };
      } catch (error) {
        auditLocalObserve(ownerId, "read", { source: "chat", rootId, path, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },
    searchLocalFiles: async (rootValue: string, query: string, path: string) => {
      let rootId = "";
      try {
        const root = await resolveLocalToolRoot(rootValue);
        rootId = root.id;
        const result = searchLocalProject(root.path, query, path);
        auditLocalObserve(ownerId, "search", { source: "chat", rootId, path, query, matches: result.matches.length, scanned: result.scanned });
        return { root: { id: root.id, label: root.label }, ...result };
      } catch (error) {
        auditLocalObserve(ownerId, "search", { source: "chat", rootId, path, query, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },
    ...(localRootsForTools.some((root) => root.mode === "READ_WRITE") ? {
      proposeFileWrite: async (rootValue: string, path: string, content: string, reason: string, taskId?: string, acceptance?: string) => {
        requireContinuationRead();
        if (localTaskId && taskId && taskId !== localTaskId) throw new Error("续办不能改到其他任务。");
        taskId ??= localTaskId ?? undefined;
        const root = await resolveLocalToolRoot(rootValue);
        const request = await createLocalWriteRequest({
          rootId: root.id,
          relativePath: path,
          content,
          reason,
          actorId: ownerId,
          characterId,
          avoidCompletedDuplicate: Boolean(localTaskId),
          ...(existingConversation?.id ? { conversationId: existingConversation.id } : {}),
          ...(taskId ? { taskId } : { taskPlan: {
            title: `写入文件：${path}`, goal: message,
            acceptance: acceptance?.trim() || "文件保存在指定目录，内容与需求一致。",
          } }),
        });
        proposedWriteIds.push(request.id);
        return {
          status: "PENDING_APPROVAL",
          requestId: request.id,
          taskId: request.taskId,
          path: request.relativePath,
          message: "尚未写入。请在本地观察 → 写审批查看并批准；任务档案可查看结果。",
        };
      },
      proposeGitBranch: async (rootValue: string, cwd: string, branch: string, reason: string) => {
        requireContinuationRead();
        const root = await resolveLocalToolRoot(rootValue);
        const request = await createGitBranchRequest({ rootId: root.id, cwd, branch, reason, actorId: ownerId, characterId,
          ...(localTaskId ? { taskId: localTaskId } : {}), ...(existingConversation ? { conversationId: existingConversation.id } : {}) });
        return { status: "PENDING_APPROVAL", requestId: request.id, branch };
      },
      proposeCommand: async (rootValue: string, command: string, argsJson: string, cwd: string, reason: string, taskId?: string) => {
        requireContinuationRead();
        if (localTaskId && taskId && taskId !== localTaskId) throw new Error("续办不能改到其他任务。");
        taskId ??= localTaskId ?? undefined;
        const root = await resolveLocalToolRoot(rootValue);
        let args: unknown;
        try {
          args = JSON.parse(argsJson || "[]");
        } catch {
          throw new Error("args 必须是 JSON 字符串数组。");
        }
        if (!Array.isArray(args)) throw new Error("args 必须是 JSON 字符串数组。");
        const request = await createLocalCommandRequest({
          rootId: root.id,
          command,
          args: args as string[],
          cwd,
          reason,
          actorId: ownerId,
          characterId,
          ...(existingConversation?.id ? { conversationId: existingConversation.id } : {}),
          ...(taskId ? { taskId } : {}),
        });
        return {
          status: "PENDING_APPROVAL",
          requestId: request.id,
          command: request.command,
          args: request.args,
          cwd: request.cwd,
          message: "已提交给主人审批，命令尚未执行。",
        };
      },
    } : {}),
  } : undefined;
  try {
    generated = await generateConversationReplyWithMemoryAssistant({
      assistant: memoryAssistant,
      turnContext,
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
        // 称呼是角色级的私人设定：只在网页对话注入，QQ 的对话方不一定是本人。
        userAddress: character.userAddress ?? "",
        model: chatSettings.model,
        apiKey,
        apiBaseUrl: chatSettings.apiBaseUrl,
        temperature: chatSettings.temperature,
        maxTokens: chatSettings.maxTokens,
        thinking: chatSettings.thinking,
        currentMessage: message,
        ...(localReadOnlyTools ? { readOnlyTools: localReadOnlyTools } : {}),
        ...(interactionGuidance.length ? { interactionGuidance } : {}),
        ...(selfUnderstanding ? { selfUnderstanding } : {}),
        ...(interactionExperiences.length ? { interactionExperiences } : {}),
        ...(conversationSummary ? { conversationSummary } : {}),
        recentMessages: chatInputRecentMessages,
        memories,
        snapshots,
        events,
        ...(knowledgeItems.length ? { knowledgeItems } : {}),
        ...(recentEvents.length ? { recentEvents } : {}),
        rawMessages,
        timeZone,
        ...(journalLine ? { journalLine } : {}),
        ...(journalRecent.length ? { journalRecent } : {}),
        ...(journalFacts.length ? { journalFacts } : {}),
        ...(acquaintances ? { acquaintances } : {}),
        ...(catchphrasePrompt.length ? { catchphrases: catchphrasePrompt } : {}),
      },
    });
  } catch (error) {
    turnDetail.update({ collaboration: turnContext.snapshot(), growthReads: [...growthReads.values()] });
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

  turnDetail.update({
    response: { action: generated.action, reply: generated.reply, explanation: generated.responseExplanation },
    collaboration: turnContext.snapshot(),
    // 「她为什么没想起那件事」：找到几条、放进去几条、被预算挤掉几条，只记数字不记正文。
    retrieval: memorySelection,
    growthReads: reconcileGrowthReadUsage([...growthReads.values()], {
      preferences: generated.usedPreferenceIds, language: generated.usedExpressionHabitIds, goals: generated.usedGoalIds,
    }, generated.action === "silent"),
  });
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
    if (proposedWriteIds.length) {
      const proposals = await tx.localWriteRequest.findMany({
        where: { id: { in: proposedWriteIds }, actorId: ownerId, characterId, conversationId: null },
        select: { id: true, taskId: true },
      });
      await tx.localWriteRequest.updateMany({
        where: { id: { in: proposals.map(row => row.id) }, actorId: ownerId, characterId, conversationId: null },
        data: { conversationId: conversation.id },
      });
      await tx.localTask.updateMany({
        where: { id: { in: proposals.flatMap(row => row.taskId ? [row.taskId] : []) }, actorId: ownerId, characterId, conversationId: null },
        data: { conversationId: conversation.id },
      });
    }
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
          ...(selfUnderstanding ? { providedSelfUnderstandingSources: selfUnderstandingReferences(selfUnderstanding) } : {}),
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
        memoryTokens: memorySelection.memory.usedTokens,
        memoryDropped: memorySelection.memory.dropped,
        snapshotTokens: memorySelection.snapshot.usedTokens,
        snapshotDropped: memorySelection.snapshot.dropped,
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
