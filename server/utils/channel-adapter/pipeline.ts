import { resolveImageRequest, isAutonomousImageEligible, validateImageScenePrompt, type ImageRequestResolution } from "../image-request-policy";
import { imageDecisionReply, imageStatusReply, blockedImageReply, type ImageAttemptRecord, type ImageGenerationRecord } from "../image-execution";
import { readGeneratedImageFacts } from "../image-assets";
import { sanitizeGeneratedImageFacts, type GeneratedImageFacts } from "../image-facts";
import { createMediaVisionBudget, isExplicitMediaQuestion, type MediaVisionBudget } from "../media-questions";
import { attachQuotedImageDescriptions, inspectLatestGeneratedImageForQuestion } from "./quoted-image-observation";
import type { ImageTextPart } from "../media-text";
import { mergeStoredMediaMetadata, storedMediaObservations, type ChannelMediaObservation, type MediaVision } from "./media-observation";
import { loadPromptEventCandidates } from "../prompt-event-candidates";
import { selectPromptMemoryContext } from "../prompt-memory-selection";
import { fillContextPlanUsage, planContextTurn } from "../context-plan";
import { estimateTokens as estimateContextTokens } from "../memory-retrieval";
import { loadPromptMemoryCandidates } from "../prompt-memory-candidates";
import { projectToolMemories, projectToolKnowledge, qqReadOnlyTaskRequested } from "../qq-read-only-tools";
import { filterPassiveGroupAt } from "../channel-behavior-policy";
import { readDeliveredAtMention, readDeliveredAtTarget, blockedDeliveredAtTargets, mergeSuppressedAtDelivery } from "./reply-delivery";
import { readInteractionGuidance } from "../interaction-guidance";
import { asksSelfUnderstandingHistory, wantsSelfUnderstanding, selfUnderstandingReferences } from "../self-understanding";
import { loadSelfUnderstanding } from "../self-understanding-reader";
import { readInteractionExperiences } from "../interaction-experiences";
import { prepareConversationSummary } from "../conversation-summary";
import { createGrowthReadDiagnostic, reconcileGrowthReadUsage, type GrowthReadDiagnostic } from "../growth-read-diagnostics";
import { loadGoalsForPrompt, usedGoalSnapshots } from "../goal-retrieval";
import { loadExpressionHabitsForPrompt, usedExpressionHabitSnapshots } from "../expression-habit-retrieval";
import { loadPreferencesForPrompt, usedPreferenceSnapshots } from "../preference-retrieval";
import { randomUUID } from "node:crypto";
import { createAssistantTurnContext } from "../assistant-turn-context";
import { runAssistantTurnStage, skipAssistantTurnStage } from "../assistant-turn-execution";
import { createModelTurnDetail } from "../model-turn-detail";
import type { Prisma, PrismaClient } from "../../../src/generated/prisma/client";
import { type ConversationContextMessage, type ConversationGroupDecision, type ConversationKnowledgeItem, type ConversationQuotedMessage } from "../chat-reply";
import {
  formatMentionContent,
  conversationSourcePolicy,
  type ConversationSourcePolicy,
  readMessageMentions,
  sanitizeMessageMentions,
  type ConversationMessageMention,
} from "../conversation-message";
import {
  buildMemoryAssistantCandidates,
  resolveMemoryAssistantRuntime,
} from "../memory-assistant";
import { resolveChatTimeZone } from "../chat-time-context";
import { analyzePrivateKnowledgeCandidate, resolveContextAssistantRuntime, shouldAnalyzePrivateKnowledge } from "../context-assistant";
import { historyCursorWhere, historyExcludedIds, loadMessageHistoryCoverage } from "../message-history-coverage";
import { loadChatKnowledge } from "../chat-knowledge-retrieval";
import { isGroupKnowledgeSource, isPrivateKnowledgeSource, readKnowledgeCollectScope } from "../knowledge-collect-policy";
import { generateGroupContextReply } from "../group-context-reply";
import { loadConversationWorkingContext, saveConversationWorkingContext } from "../conversation-working-context";
import { analyzeOwnerHistoryIntent, isOwnerJournalTurn, privateContextPurpose } from "../owner-history-intent";
import { loadOwnerHistoryContext, saveOwnerHistoryContext, planOwnerHistory, applyOwnerHistoryIntent, isOwnerHistoryDateRetry, planRestartedHistoryRetry, loadOwnerHistoryPage, type OwnerHistoryAuthorization, type OwnerHistoryCoverage } from "../owner-private-history";
import { parseEventTimeRange } from "../memory-event-time";
import {
  CROSS_CHANNEL_WINDOW_MINUTES,
  selectCrossChannelContext,
  type CrossChannelCandidate,
  type CrossChannelLine,
} from "../cross-channel-context";
import { parseEventParticipantQuery, resolveEventItemLimit, resolveEventRecentDays, resolveEventTokenBudget } from "../memory-event-retrieval";
import { rehomeConversationScope } from "../memory-event-move";
import {
  resolveRawMessageLimit, resolveRawMessageTokenBudget, selectRawMessagesForPrompt,
} from "../message-retrieval";
import { resolveEventParticipantNames, resolveParticipantAccounts } from "../participant-names";
import {
  buildOwnerTimelineGroupRawMessageWhere,
  buildPrivateScopeRawMessageWhere,
  resolveOwnerTimelineGroupScopeIds,
  shouldUseOnlyTargetGroupRawRows,
} from "../owner-timeline-retrieval";
import { isEmojiEnabled, resolveChatModelSettings } from "../chat-model-config";
import { resolveCharacterApiKey, resolveCharacterAsrApiKey, resolveCharacterImageApiKey, resolveCharacterVoiceApiKey } from "../credential-encryption";
import {
  extractMemoryAssistantSearchTerms,
  resolveMemoryItemLimit, resolveMemoryTokenBudget, resolveRecentMessageLimit, resolveSnapshotTokenBudget,
} from "../memory-retrieval";
import { recordModelUsage, readDailyQuota, toUsageTokens, usageDayKey } from "../model-usage";
import {
  applyImageDescriptions,
  describeImages,
  MAX_IMAGES_PER_TURN,
  resolveVisionSettingsForCharacter,
  type ChannelImageRef,
} from "../image-understanding";
import { CLOSE_FRIEND_LIMIT, listAcquaintances, recordFriendInteraction } from "../friends";
import { isEmojiBudgetSpent, resolveEmojiFrequency } from "../emoji-frequency";
import { alignMediaResults } from "../media-result-alignment";
import { ensureOwnerPrivateScope } from "../memory-scope-access";
import { isSystemBroadcast, looksLikeSystemMessage } from "../system-message";
import { getPrisma } from "../prisma";
import { shouldBlockFriendSpeaker } from "../friend-chat-policy";
import { pickStickerCatalog, type StickerCatalogEntry } from "../stickers";
import {
  loadCatchphraseCatalog, markCatchphrasesUsed, pickCatchphraseCatalog, toCatchphrasePromptEntries,
} from "../catchphrases";
import { maybeAutoMineCatchphrases } from "../catchphrase-mine";
import { readPreviousJournalLine, readRecentJournals, dropDuplicateJournalQuote } from "../journal-service";
import { isSelfFactQuery, loadJournalFacts } from "../journal-facts";
import { buildGroupActivityContext, isGroupActivityQuery } from "../group-activity-stats";
import { collectStickersFromTurn } from "../sticker-collect";
import { splitReplySegments } from "../reply-segments";
import {
  applyVoiceTranscripts,
  canSpeakReply,
  isVoiceRequested,
  isVoiceReplyEnabled,
  isVoiceTranscribeEnabled,
  MAX_VOICES_PER_TURN,
  planVoiceReply,
  resolveVoiceAsrSettings,
  resolveVoiceTtsSettings,
  transcribeVoices,
  VOICE_TEXT_MAX_CHARS,
  type ChannelVoiceRef,
  type VoiceTtsSettings,
} from "../voice";
import {
  generateImage,
  isImageGenerationEnabled,
  readImageExecutionState,
  planImageReplyDecision,
  type ImageReplyDecision,
  sanitizeImagePrompt,
  readStoredImageFlag,
  readSentImageFlag,
  resolveImageGenerationSettings,
  type GeneratedImage,
  type ImageGenerationSettings,
} from "../image-generation";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export type ChannelReplyOptions = {
  /** 表情 id。渠道自己保证 id 合法；不支持表情的渠道忽略即可。 */
  faces?: string[];
  /**
   * 她自己的表情包（贴图）。渠道把它单独发一条；与 faces 二选一，
   * 传了 sticker 就不再发内置表情。
   *
   * `qqEmojiId` 有值时渠道应该优先走「QQ 收藏表情」通道（原生表情段），
   * 拿不到或发失败再退回图片段 —— 具体取舍在渠道里，流水线只负责把 id 带下去。
   */
  sticker?: { id: string; filePath: string; qqEmojiId?: string | null };
  /**
   * 这一轮她自己画的一张图（文生图，不是表情包）。
   *
   * 渠道把它**单独发一条**：图和文字拼在一条里在 QQ 能显示，但引用块会跟图挤在一起，
   * 而图单独一条和表情包的行为一致（已经跑了几千轮）。发不出来只记日志 ——
   * 文字已经发出去了，不能因为一张图把整轮判成失败。
   */
  image?: GeneratedImage;
  /** 引用回复的消息 id（本平台原始 id）。群聊里让她锚定「接的是哪一句」。 */
  replyToMessageId?: string;  /**
   * 要点名的人 —— 填他说过的那条消息 id，渠道 @ 这条消息的作者。
   *
   * 与 `replyToMessageId` 分开传，因为两件事的目的不同：引用说明「接哪一句」，
   * @ 是**去叫人**（对方客户端会亮提醒）。混成一个字段就变成「凡引用必 @"，
   * 群里每条都弹提醒。渠道不支持 @ 就忽略这个字段。
   */
  atMessageId?: string;
  /**
   * 这一条用语音发。渠道自己决定能不能真发（要合成、要转 silk），
   * 发不出来就退回发文字 —— 语音是锦上添花，不能成为整轮沉默的原因。
   */
  voice?: boolean;
  /**
   * 这一轮要发的文字，按「一条一条弹」拆好的分段（含第一条）。
   *
   * 只在渠道声明了 `segmentCapable` 且模型真的换了行时才出现；不传就是单条，
   * 渠道走原来的路径。**引用和 @ 只能挂在第一条上**（挂在每条上等于每句弹一次提醒），
   * 表情/语音仍按老规矩接在最后。
   *
   * 落库仍是一行 ASSISTANT（`content` 保留换行），所以群限流按「轮」算，
   * 不会因为拆成三条就把额度吃掉三份。
   */
  segments?: string[];
  /**
   * 语音合成参数。由流水线解析好后带下来（含角色自己的 API Key），
   * 这样渠道不必为了合成再查一次库、再解密一次凭据。
   */
  voiceSettings?: VoiceTtsSettings;
  /** Report the first successful text delivery before later segments/media can fail. */
  onDelivery?: (delivery: ChannelReplyDelivery) => Promise<void>;
};

/** Internal delivery facts; platform identifiers must never be copied into prompt payloads. */
export type ChannelReplyDelivery = {
  image?: { status: "sent" | "failed" | "unknown"; sentAt?: string; externalMessageId?: string; reason?: "read_failed" | "send_failed" | "unconfirmed" };
  at?: {
    requestedMessageId: string;
    targetQq?: string;
    status: "sent" | "suppressed" | "unknown";
    reason?: string;
    sentAt?: string;
    attemptedAt?: string;
  };
};

export type ChannelReplySender = (text: string, options?: ChannelReplyOptions) => Promise<void | ChannelReplyDelivery>;

/**
 * 渠道会话键 `g:<群号>` / `c:<账号>` 里取出群号。
 *
 * 只用于把「这是哪个群」写进会话标题和 metadata —— 路由仍以完整的 externalConversationId
 * 为准。群聊记录会进角色全局记忆，事后要能看出「这句话是在哪个群说的」，而标题原来
 * 取的是第一条消息的前 80 字，翻记录时根本认不出是哪个群。
 */
/**
 * 一轮回复回看多少条已落库的消息，按角色 `modelConfig.recentMessageLimit` 取（默认 40）。
 *
 * 别指望它做「十分钟内发了几张表情」这种统计：40 条在热群依旧覆盖不到十分钟，
 * 那类判断必须按 occurredAt 回表数（见 `emoji-frequency.ts`）。
 */

function readGroupIdFromConversationKey(key: string): string | null {
  const matched = /^g:(\d+)$/.exec(key);
  return matched?.[1] ?? null;
}

/** 一轮里的一个人说的话。群聊会把几秒内的几条消息合成一轮。 */
export type ChannelTurnMessage = {
  externalMessageId: string;
  authorOpenId: string;
  /** Stable per-platform author id (qq openid / external uid). Used to upsert ExternalIdentity. */
  authorPlatformUid?: string;
  /** Optional author display name for identity metadata. */
  authorDisplayName?: string;
  quotedMessage?: ConversationQuotedMessage;
  kind?: "AI" | "HUMAN" | "UNKNOWN";
  excludeFromGrowth?: true;
  content: string;
  /** 这条消息 @ 的是谁（self / other / all）。落库给忆泡提炼判断对象用。 */
  mentionTargets?: string[];
  /**
   * 这条消息 @ 到谁（按出现顺序）：群成员代号、显示名、身份。
   *
   * 比 `mentionTargets` 多出来的正是「是谁」：只给 `other` 时，模型知道不是她，
   * 但不知道是另一个 bot 还是某个人，于是会把对方的称呼和关系算到她头上。
   */
  mentions?: ConversationMessageMention[];
  /** 给模型看的正文（@ 已代号化）；不传就等于 content。落库仍用 content。 */
  promptContent?: string;
  /** 群聊里的成员代号；只有群聊会传。 */
  member?: string;
  /** 收到这条消息的时刻（不是模型返回的时刻）。 */
  occurredAt?: Date;
  /** 这条消息里带的图。只有接了「看图」旁路才会被读，没配视觉模型时完全忽略。 */
  images?: ChannelImageRef[];
  commandText?: string;
  addressedToSelf?: boolean;
  quotedToSelf?: boolean;
  readOnly?: boolean;
  imageTextParts?: ImageTextPart[];
  promptImageTextParts?: ImageTextPart[];
  /** Safe per-segment observations, excluded from model payloads. */
  observedMedia?: ChannelMediaObservation[];
  /** 这条消息里带的语音。只有接了「听懂语音」旁路才会被读，没配 ASR 时完全忽略。 */
  voices?: ChannelVoiceRef[];
  /** 当前说话人是不是主人；只用于提示词，不参与鉴权。 */
  speaker?: {
    displayName?: string;
    isOwner: boolean;
    ownerDisplayName?: string;
  };
};

export type ChannelMessageInput = {
  commandText?: string;
  addressedToSelf?: boolean;
  quotedToSelf?: boolean;
  readOnly?: boolean;
  platform: string;
  characterId: string;
  bindingId: string;
  /** Platform-specific message event type (e.g. QQ group message, private chat). */
  eventType: string;
  /** Stable key for the conversation: "g:<group_openid>", "c:<user_openid>", "dm:<id>", etc. */
  externalConversationId: string;
  externalMessageId: string;
  authorOpenId: string;
  /** Stable per-platform author id (qq openid / external uid). Used to upsert ExternalIdentity. */
  authorPlatformUid?: string;
  /** Optional author display name for identity metadata. */
  authorDisplayName?: string;
  /** 当前说话人是不是主人；只用于提示词，不参与鉴权。 */
  speaker?: {
    displayName?: string;
    isOwner: boolean;
    ownerDisplayName?: string;
  };
  quotedMessage?: ConversationQuotedMessage;
  kind?: "AI" | "HUMAN" | "UNKNOWN";
  excludeFromGrowth?: true;
  content: string;
  /**
   * 这条消息 @ 的是谁：`self` = 她本人，`other` = 别的群成员/别的 bot，`all` = @全体。
   *
   * 落库原因：群聊里同时跑着好几个 bot，别人 @ 另一个号说的话，提炼时很容易被记成
   * 「群友说她」。闸门早就算过这份信息（`readOnebotMentionTargets`），但以前只用来
   * 放行/丢弃，没有存下来，模型只能靠猜。
   */
  mentionTargets?: string[];
  /** 这条消息带的图。渠道不传就等于「这个渠道没有图」，不影响其他行为。 */
  images?: ChannelImageRef[];
  imageTextParts?: ImageTextPart[];
  promptImageTextParts?: ImageTextPart[];
  observedMedia?: ChannelMediaObservation[];
  /** 这条消息带的语音。渠道不传就等于「这个渠道没有语音」。 */
  voices?: ChannelVoiceRef[];
  /**
   * 这个渠道能发的表情清单。**传了就等于声明「本渠道支持表情」**——不支持表情段的渠道
   * 不传；流水线不认平台名，只认这份清单在不在。
   */
  faceCatalog?: ReadonlyArray<{ id: string; name: string }>;
  /**
   * 这个角色的表情包清单。**传了就等于声明「本渠道能发图片」**，并且优先于内置表情：
   * 有清单时模型从里面挑一张，内置表情不再进提示词。
   */
  stickerCatalog?: ReadonlyArray<StickerCatalogEntry>;
  /**
   * 这个渠道能不能发语音条。**传了就等于声明「本渠道支持语音」**——不传就永远发文字。
   * 与 faceCatalog 同理：流水线不认平台名，只认这份能力声明在不在。
   */
  voiceCapable?: boolean;
  /**
   * 这个渠道能不能把一张图发出去（文生图的结果）。
   *
   * 与 `voiceCapable` 同一个道理：传了就等于声明「本渠道能发图」。
   * 不声明就永远不画 —— 画出来发不出去，等于花一笔钱换一张谁也看不见的图。
   */
  imageCapable?: boolean;
  /**
   * 这个渠道能不能把一条回复拆成几条消息依次发（QQ 一句一句弹）。
   *
   * 和 `voiceCapable` 同一个道理：流水线不认平台名，只认这份能力声明。声明之后，
   * 提示词才会告诉她「换行 = 另起一条」，发送时 `ChannelReplyOptions.segments`
   * 才可能带内容。不声明（网页对话）就永远是一整段。
   */
  segmentCapable?: boolean;
  sendReply: ChannelReplySender;
};

/**
 * 渠道消息落库时的 metadata。
 *
 * 抽成纯函数是为了能单独测：这些字段直接决定「忆泡能不能判断这句话是不是冲她说的」。
 * 靠 e2e 断言代价太高 —— 那个文件是按群号串起来的时序测试，插一条会调模型的消息
 * 会打乱后面所有场景（试过两次，都让别的断言红了）。
 */
export function buildStoredMessageMetadata(input: {
  platform: string;
  /**
   * 落库原因。清理策略按它分档，所以别随手加值：
   * - `replied` / `mentioned`：证据类，按角色保留天数走；
   * - `silent` / `context`：纯上下文行，7 天清理（`context` = 主人在群里说的话，
   *   这一轮没接她，但私聊里要能接上，见 `cross-channel-context.ts`）；
   * - `recorded`：私聊预落库，私聊不进清理。
   */
  storedReason: "replied" | "silent" | "mentioned" | "recorded" | "context";
  message: {
    authorOpenId: string;
    authorDisplayName?: string;
    member?: string;
    mentionTargets?: string[];
    mentions?: ConversationMessageMention[];
    speaker?: { isOwner?: boolean };
    voices?: unknown[];
    observedMedia?: ChannelMediaObservation[];
    quotedMessage?: ConversationQuotedMessage;
    kind?: "AI" | "HUMAN" | "UNKNOWN";
    excludeFromGrowth?: true;
    content: string;
  };
}): Prisma.InputJsonObject {
  const { message } = input;
  const mentions = sanitizeMessageMentions(message.mentions);
  return {
    source: "channel",
    platform: input.platform,
    storedReason: input.storedReason,
    ...conversationSourcePolicy(message),
    ...(message.observedMedia?.length ? { media: storedMediaObservations(message.observedMedia) as Prisma.InputJsonArray,
      ...(message.observedMedia.length > 100 ? { mediaOmitted: message.observedMedia.length - 100 } : {}),
    } : {}),
    // 谁被 @ 了：提炼忆泡时用来判断「这句话是不是冲她说的」。
    ...(message.mentionTargets?.length ? { mentionTargets: message.mentionTargets } : {}),
    // 被 @ 的具体是谁：代号 / 显示名 / 身份。昵称会改，认人仍以 qq 为准。
    ...(mentions.length ? { mentions } : {}),
    authorOpenId: message.authorOpenId,
    ...(message.authorDisplayName ? { authorDisplayName: message.authorDisplayName } : {}),
    // 群聊的成员代号（member_n）：昵称可能缺失或被改，代号在同一个群里稳定。
    ...(message.member ? { member: message.member } : {}),
    // 主人发的消息：群聊提炼时也要认得出「这是主人」，不能跟群友混。
    ...(message.speaker?.isOwner ? { isOwner: true } : {}),
    // 这条原本是语音条；落库的 content 是转写后的文字（没配 ASR 就还是 `[语音]`）。
    ...(message.voices?.length ? { hasVoice: true } : {}),
    ...(message.quotedMessage ? { quotedMessage: {
      ...conversationSourcePolicy(message.quotedMessage), messageId: message.quotedMessage.messageId,
      ...(message.quotedMessage.content !== undefined ? { content: message.quotedMessage.content } : {}),
      ...(message.quotedMessage.isSelf !== undefined ? { isSelf: message.quotedMessage.isSelf } : {}),
      ...(message.quotedMessage.speaker ? { speaker: message.quotedMessage.speaker } : {}),
      ...(message.quotedMessage.member ? { member: message.quotedMessage.member } : {}),
      ...(sanitizeGeneratedImageFacts(message.quotedMessage.image) ? { image: sanitizeGeneratedImageFacts(message.quotedMessage.image) as Prisma.InputJsonObject } : {}),
    } } : {}),
    ...(isSystemBroadcast(message.content) ? { systemBroadcast: true } : {}),
  };
}

/**
 * 主人私聊的会话要不要改挂到主人专属私人范围。
 *
 * 会话按 `(binding, externalConversationId)` 唯一，找到就复用 —— 而「主人专属范围」是
 * 后加的功能，更早创建的会话还挂在这个 QQ 的 EXTERNAL_IDENTITY 上。不迁移的话，之后
 * 主人说的每一句仍旧落在外人范围里：不排忆泡、也进不了主人私人记忆，页面上完全看不出来。
 *
 * 只做「迁移到主人范围」这一个方向：主人 QQ 换人、或者同一会话突然不是主人了，
 * 不在这里往回搬 —— 那种情况猜错会把主人的私聊暴露给外人。
 */
export function resolveOwnerPrivateScopeRepair(input: {
  isOwnerTurn: boolean;
  ownerPrivateScopeId: string | null;
  currentScopeId: string;
}): string | null {
  if (!input.isOwnerTurn || !input.ownerPrivateScopeId) return null;
  return input.currentScopeId === input.ownerPrivateScopeId ? null : input.ownerPrivateScopeId;
}

/**
 * 群会话要不要归位到角色全局范围。
 *
 * 会话按 `(binding, externalConversationId)` 唯一、找到就复用，而「群聊挂全局」是后来
 * 才定的规则：更早建出来的群会话仍挂在当初那个 `EXTERNAL_IDENTITY` 上。后果比私聊更隐蔽 ——
 * - 群聊写进去的消息落在外部身份范围里，按天忆泡只排全局与私聊范围，这些消息一辈子不被整理；
 * - 群聊的检索范围是 `[global]`，于是她在群里查不到这个群自己说过的话；
 * - 聊天记录列表上一切正常，只有「她怎么什么都不记得」这一个症状。
 *
 * 只认一个方向：群 → 全局。反向（全局 → 某个人）没有任何正当场景，猜错就是把群聊
 * 塞进别人私聊。私聊的归位由 `resolveOwnerPrivateScopeRepair` 单独负责。
 */
export function resolveGroupScopeRepair(input: {
  isGroup: boolean;
  globalScopeId: string;
  currentScopeId: string;
}): string | null {
  if (!input.isGroup) return null;
  return input.currentScopeId === input.globalScopeId ? null : input.globalScopeId;
}

/**
 * 私聊消息先落库。
 *
 * 以前整轮要等模型回完才写 `messages`：模型没配、Key 解密失败、额度用完、生成报错，
 * 甚至进程崩在模型调用里，这一句私聊就彻底没了 —— 群里还能靠短期上下文，私聊则连
 * 「她看过」都留不下。私聊量小，产品上要求尽量全部保留，所以先把 USER 消息写进去，
 * 再决定回不回。
 *
 * 幂等靠 `(conversationId, externalMessageId)` 唯一约束 + `skipDuplicates`：预落库之后
 * 正常路径还会再跑一次同样的写入，不会多出一条。失败只记日志、退回原来的「回完再存」，
 * 不让记录失败把一轮回复也拖死。
 */
async function recordPrivateTurnMessages(input: {
  prisma: PrismaClient;
  characterId: string;
  bindingId: string;
  platform: string;
  externalConversationId: string;
  conversation: { id: string; title: string | null; memoryScopeId: string } | null;
  messages: ChannelTurnMessage[];
  targetScopeId: string;
  repairScopeId: string | null;
  title: string;
}): Promise<{ id: string; title: string | null; memoryScopeId: string } | null> {
  const now = new Date();
  try {
    return await input.prisma.$transaction(async (tx) => {
      let conversation = input.conversation;
      if (conversation) {
        if (input.repairScopeId && conversation.memoryScopeId !== input.repairScopeId) {
          await tx.conversation.update({
            where: { id: conversation.id },
            data: { memoryScopeId: input.repairScopeId },
          });
          conversation = { ...conversation, memoryScopeId: input.repairScopeId };
        }
      } else {
        conversation = await tx.conversation.create({
          data: {
            characterId: input.characterId,
            memoryScopeId: input.targetScopeId,
            channelBindingId: input.bindingId,
            externalConversationId: input.externalConversationId,
            title: input.title,
            status: "ACTIVE",
            metadata: { platform: input.platform, kind: "private" },
          },
          select: { id: true, title: true, memoryScopeId: true },
        });
      }
      await tx.message.createMany({
        data: input.messages.map((message, index) => ({
          conversationId: conversation.id,
          externalMessageId: message.externalMessageId,
          role: "USER" as const,
          content: message.content,
          occurredAt: message.occurredAt ?? (input.messages.length === 1
            ? now
            : new Date(now.getTime() - (input.messages.length - index))),
          metadata: buildStoredMessageMetadata({
            platform: input.platform,
            storedReason: "recorded",
            message,
          }),
        })),
        skipDuplicates: true,
      });
      const lastMessage = input.messages[input.messages.length - 1]!;
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: lastMessage.occurredAt ?? now },
      });
      return conversation;
    });
  } catch (error) {
    console.error(
      "[channel] 私聊消息预落库失败，退回「回完再存」：",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

/**
 * 这一轮里，谁在这个群说过话 —— 落 `group_members` 用。
 *
 * 和 `recordFriendInteraction` 是两条线，别合并：
 * - 这里记**所有开口的人**（哪怕她一个字都没回），回答「这个屋里都有谁」；
 * - 那个只记**她回过的人**，回答「她跟谁有交情」。
 *
 * 少了这张表，熟客榜只能按「在群里认识的」筛，A 群的熟人会出现在 B 群的榜上，
 * 于是她会冲着一个第一次见的人叫老朋友。
 *
 * 抽成纯函数是为了能单测：群名、昵称、成员代号都能假，时间去重最容易写错。
 */
export function buildGroupMemberDeltas(messages: ReadonlyArray<{
  authorOpenId: string;
  authorPlatformUid?: string;
  authorDisplayName?: string;
  occurredAt?: Date;
}>): Array<{
  platformUid: string;
  displayName: string | null;
  count: number;
  firstSpokeAt: Date;
  lastSpokeAt: Date;
}> {
  const byUid = new Map<string, {
    platformUid: string;
    displayName: string | null;
    count: number;
    firstSpokeAt: Date;
    lastSpokeAt: Date;
  }>();
  for (const message of messages) {
    const platformUid = (message.authorPlatformUid || message.authorOpenId || "").trim();
    if (!platformUid) continue;
    const at = message.occurredAt ?? new Date();
    const name = message.authorDisplayName?.trim() || null;
    const existing = byUid.get(platformUid);
    if (!existing) {
      byUid.set(platformUid, { platformUid, displayName: name, count: 1, firstSpokeAt: at, lastSpokeAt: at });
      continue;
    }
    existing.count += 1;
    // 同一轮里他说了不止一句：取最早和最晚，别让数组顺序决定区间。
    if (at < existing.firstSpokeAt) existing.firstSpokeAt = at;
    if (at > existing.lastSpokeAt) existing.lastSpokeAt = at;
    // 昵称以最新一条为准（群里改群名片很频繁）。
    if (name) existing.displayName = name;
  }
  return [...byUid.values()];
}

/** 群聊这一轮的上下文：本轮是否 @ 她、之前几句、她参与过的话题。 */
export type ChannelGroupTurnContext = {
  direct: boolean;
  /** Internal identity resolver from the current group cache; never serialize the callback or QQ. */
  resolveMember?: (qq: string) => { member: string; speaker?: string } | null;
  background: Array<{
    id: string; at: number; member: string; speaker: string; text: string;
    mentions?: Array<{ target: "self" | "other" | "all"; member?: string; speaker?: string }>;
    kind?: "AI" | "HUMAN" | "UNKNOWN";
    readOnly?: true;
    excludeFromGrowth?: true;
    quoted?: { id: string; member?: string; speaker?: string; text?: string; isSelf?: boolean } & ConversationSourcePolicy;
  }>;
  analysisBackground?: Array<{
    id: string; at: number; member: string; speaker: string; text: string;
    mentions?: Array<{ target: "self" | "other" | "all"; member?: string; speaker?: string }>;
    kind?: "AI" | "HUMAN" | "UNKNOWN";
    readOnly?: true;
    excludeFromGrowth?: true;
    quoted?: { id: string; member?: string; speaker?: string; text?: string; isSelf?: boolean } & ConversationSourcePolicy;
  }>;
  anchors: Array<{ id: string; label: string }>;
  /** 群内归属（「X的Y」「@某人 主人夸我了」学来的）。空数组 = 这轮没学到，不注入。 */
  members?: Array<{ member: string; speaker: string; belongsTo: string; belongsToName: string }>;
  /** 她自己在这个群的 QQ 号：统计「谁在跟她说话」时只有 @ 这个号才算。 */
  selfQq?: string;
  /** 主人的 QQ 号：统计里标出 isOwner，显示名叫「主人」的群友不算。 */
  ownerQq?: string;
  /** 她在这个群可能被叫到的名字（角色名 + 绑定别名），统计用。 */
  selfNames?: string[];
};

/** 群聊一轮：几秒内几个人说的话，一次看、最多回一次。 */
export type ChannelBatchInput = {
  platform: string;
  characterId: string;
  bindingId: string;
  eventType: string;
  externalConversationId: string;
  messages: ChannelTurnMessage[];
  /** 原始群成员观察。被身份策略过滤的消息不进入模型/聊天记录，但成员名单仍能看到说话者。 */
  memberObservations?: ChannelTurnMessage[];
  faceCatalog?: ReadonlyArray<{ id: string; name: string }>;
  stickerCatalog?: ReadonlyArray<StickerCatalogEntry>;
  /** 允许模型说「这轮不插嘴」。被 @ 时传 false —— 点名了还不回比乱回更糟。 */
  allowSilent?: boolean;
  /** 见 `ChannelMessageInput.voiceCapable`。 */
  voiceCapable?: boolean;
  /** 见 `ChannelMessageInput.imageCapable`。 */
  imageCapable?: boolean;
  /** 见 `ChannelMessageInput.segmentCapable`。 */
  segmentCapable?: boolean;
  /** 群聊上下文；私聊不传。 */
  group?: ChannelGroupTurnContext;
  sendReply: ChannelReplySender;
};

export type ChannelMessageResult =
  | { status: "replied"; conversationId: string; groupDecision?: ConversationGroupDecision }
  | { status: "silent"; conversationId: string; groupDecision?: ConversationGroupDecision }
  | { status: "duplicate" }
  | { status: "ignored"; reason: string };

/** 从已存消息的 metadata 里取表情包 id。没有（或不是字符串）返回 null。 */
function readStoredStickerId(metadata: unknown): string | null {
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  return typeof record.stickerId === "string" && record.stickerId ? record.stickerId : null;
}

/**
 * 上一条回复是不是语音条。存的是个标记而不是音频本身（音频发完就没了）。
 *
 * 两处用：① 算语音冷却；② 给 recentMessages 带 `hadVoice`，让她下一轮知道
 * 「刚才那条是我在说话」—— 不带的话对方说「语音我这边听不了」，她会回
 * 「本宝本来也只会打字」。不要拿它判断「她刚才说了什么」，那是 content 的事。
 */
function readStoredVoiceFlag(metadata: unknown): boolean {
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  return record.voice === true;
}

/**
 * 这一条回复带没带图（表情包 / 表情段）。
 *
 * 她贴的图落库时 `content` 只有文字，图只记在 metadata 的 `stickerId`（表情包）
 * 或 `faceIds`（内置表情）里。下一轮模型只看得到 content，于是「她发过图」这件事
 * 凭空消失 —— 有人问「这图是你发的吗」，她能回「图又不是本宝发的」。
 * 把这个痕迹读出来，recentMessages 里才带得上 `hadSticker`。
 */
function readStoredStickerFlag(metadata: unknown): boolean {
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  if (typeof record.stickerId === "string" && record.stickerId) return true;
  if (Array.isArray(record.faceIds) && record.faceIds.length) return true;
  return false;
}

/**
 * 要引用哪一句。指向最新一条就当作「没引用」。
 *
 * 一边要求「回上一条别引用、别 @」，一边指望模型每次都判断对「哪条是上一条」，
 * 是不现实的：一忙起来它会把 id 填成本轮第一条。所以这层判断放在代码里 ——
 * 模型只管说「我在接哪句」，要不要显示成引用由这里定。
 *
 * 只对**文字**回复生效：语音条一律不带引用段，理由见 `runChannelTurn` 里那个
 * `replyVoice` 判断（引用 + 语音拼在一条消息里，客户端只显示引用块）。
 */
export function pickQuoteTarget(
  replyToMessageId: string | undefined,
  newestMessageId: string | undefined,
): string | undefined {
  if (!replyToMessageId) return undefined;
  if (newestMessageId && replyToMessageId === newestMessageId) return undefined;
  return replyToMessageId;
}

/**
 * 这一轮该记成「跟谁互动过」—— 也就是给她记账的那几条消息。
 *
 * 先按她引用 / @ 的 id 在本批里找作者；**找不到就退回本轮最新一条**。
 *
 * 为什么必须往回退：引用的可以是本批之外的消息（历史消息、上一轮的尾巴）。按 id 硬匹配
 * 会一条都不中，于是她明明回了人，关系行却停在几小时前 —— 「她的朋友」页面看起来就像
 * 统计坏了（2026-11-02 复核时正是这个坑）。退回最新一条是原来的兜底语义：她接的就是那句话。
 */
export function pickFriendTargets<T extends { externalMessageId?: string | null }>(
  messages: readonly T[],
  ids: { replyToMessageId?: string; atMessageId?: string },
): T[] {
  const wanted = new Set(
    [ids.replyToMessageId, ids.atMessageId].filter((id): id is string => Boolean(id)),
  );
  if (wanted.size) {
    const hit = messages.filter((message) => message.externalMessageId && wanted.has(message.externalMessageId));
    if (hit.length) return hit;
  }
  const latest = messages[messages.length - 1];
  return latest?.externalMessageId ? [latest] : [];
}

/**
 * 落库时记下的发言人。
 *
 * 群聊历史全是 `role: "USER"`，谁说的只有 metadata 知道。不把它读出来，
 * 20 条历史在提示词里就是 20 句没有主人的话 —— 模型只好按「谁口吻像谁」猜，
 * 于是把 A 说的安到 B 头上（`recentMessages` 原来只映射 role/content/occurredAt）。
 */
function readStoredSpeaker(metadata: unknown): { speaker?: string; isOwner: boolean } {
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  const name = typeof record.authorDisplayName === "string" ? record.authorDisplayName.trim().slice(0, 80) : "";
  return {
    ...(name ? { speaker: name } : {}),
    isOwner: record.isOwner === true,
  };
}

/**
 * 这条消息是谁发的（平台账号）。跨窗口旁路要拿它认出「这一句是主人自己在群里说的」。
 *
 * 不能拿昵称认：群里改名是常事，同名也不同人。账号在同一个平台内稳定。
 */
function readStoredAuthorOpenId(metadata: unknown): string {
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  return typeof record.authorOpenId === "string" ? record.authorOpenId.trim() : "";
}

/** 会话 key 是 `g:<群号>`；认不出就原样返回，别编一个群名出来。 */
function groupLabelFromConversationKey(key: string): string {
  const groupId = /^g:(\d+)$/.exec(key)?.[1];
  return groupId ? `QQ群 ${groupId}` : key;
}

/**
 * 把附件的转写结果写回这条消息。
 *
 * **必须同时改 `content` 和 `promptContent`**：落库看 `content`，进提示词看 `promptContent`
 * （群聊里它是 @ 代号化后的正文）。只改一个的话，群聊这一路等于没接 ——
 * 私聊测着是好的，群里却一直只看到 `[图片]` / `[语音]`。
 */
function patchMessageText(
  message: ChannelTurnMessage,
  transform: (text: string) => string,
): ChannelTurnMessage {
  const content = transform(message.content);
  if (!message.promptContent) return { ...message, content };
  return { ...message, content, promptContent: transform(message.promptContent) };
}

/**
 * 把这一轮里的图先变成文字，再交给聊天模型。
 *
 * 聊天模型（deepseek-flash 这类）在聊天这条路上走的是文本 body，图没法直接混进去，
 * 所以"看图"只能发生在进提示词之前：视觉模型出 2-4 句描述，正文里的 `[图片]` 换成
 * `[图片：描述]`。角色没打开 `imageUnderstanding` 时这里原样返回 —— 行为与接入前一致。
 *
 * 放在额度检查之后：额度已经超了就别再为看图多花一次调用。
 * 失败一律吞掉：少一句描述不该让整轮回复变成错误事件。
 */
export async function attachImageDescriptions(
  messages: ChannelTurnMessage[],
  context: {
    modelConfig: unknown;
    chatModel: string;
    apiBaseUrl: string;
    apiKey: string;
    characterId: string;
    bindingId: string;
  },
  services: { resolveSettings: typeof resolveVisionSettingsForCharacter; describe: typeof describeImages } = { resolveSettings: resolveVisionSettingsForCharacter, describe: describeImages },
  budget?: MediaVisionBudget,
): Promise<ChannelTurnMessage[]> {
  if (!messages.some((message) => (message.images?.length ?? 0) > 0)) return messages;
  // 视觉 Key 可能是这个角色单独配的另一家（智谱 / 通义），所以走会解密的那层入口。
  const settings = await services.resolveSettings({
    modelConfig: context.modelConfig,
    chatModel: context.chatModel,
    chatApiBaseUrl: context.apiBaseUrl,
    chatApiKey: context.apiKey,
  });
  const observed = messages.map(message => ({ ...message,
    ...(message.observedMedia?.length ? { observedMedia: message.observedMedia.map(media => media.source === "image"
      ? { ...media, vision: { status: "skipped", reason: !settings ? "not_enabled"
        : media.kind === "sticker" && !isExplicitMediaQuestion(message.commandText ?? "", Boolean(message.images?.length || message.quotedMessage?.images?.length || message.quotedMessage?.image)) ? "sticker_policy"
        : media.imageIndex !== undefined && !message.images?.[media.imageIndex]?.url ? "no_url" : "limit" } as MediaVision } : media) } : {}),
  }));
  if (!settings) return observed;
  const setVision = (message: ChannelTurnMessage, imageIndex: number, vision: MediaVision) => {
    for (const media of message.observedMedia ?? []) if (media.source === "image" && media.imageIndex === imageIndex) media.vision = vision;
  };

  let remaining = budget?.remaining ?? MAX_IMAGES_PER_TURN;
  const descriptionsByMessage = new Map<string, Array<string | null | undefined>>();
  for (const message of observed) {
    if (remaining <= 0) break;
    const refs = message.images ?? [];
    if (!refs.length) continue;

    // 只对有 URL 的媒体发起视觉请求，但保留它们在原始图片数组里的序号。
    // 不能先 filter 再按结果顺序回填，否则前面的无 URL 图片会让后续描述错位。
    const targetIndexes: number[] = [];
    for (let index = 0; index < refs.length && targetIndexes.length < remaining; index += 1) {
      const kind = message.observedMedia?.find(media => media.source === "image" && media.imageIndex === index)?.kind ?? refs[index]?.mediaKind;
      if (refs[index]?.url && (kind !== "sticker" || isExplicitMediaQuestion(message.commandText ?? "", Boolean(message.images?.length || message.quotedMessage?.images?.length || message.quotedMessage?.image)))) targetIndexes.push(index);
    }
    if (!targetIndexes.length) {
      if (refs.some(ref => ref.url)) continue;
      // 这一条消息里的图片都没有可下载直链：不发起模型请求，但逐个标成无法读取。
      descriptionsByMessage.set(
        message.externalMessageId,
        refs.map((_, index) => { setVision(message, index, { status: "skipped", reason: "no_url" }); return null; }),
      );
      continue;
    }

    const batch = targetIndexes.map((index) => ({ ...refs[index]!,
      mediaKind: message.observedMedia?.find(media => media.source === "image" && media.imageIndex === index)?.kind ?? refs[index]!.mediaKind,
    }));
    if (budget && !budget.consume(batch.length)) break;
    remaining -= batch.length;
    let batchDescriptions: Array<string | null>;
    try {
      batchDescriptions = await services.describe(batch, settings, {
        characterId: context.characterId,
        channelBindingId: context.bindingId,
      });
    } catch {
      // 看图失败只是少一句描述，`[图片]` 原样保留。
      batchDescriptions = batch.map(() => null);
    }

    targetIndexes.forEach((imageIndex, index) => setVision(message, imageIndex, batchDescriptions[index]?.trim()
      ? { status: "ok" } : { status: "failed", reason: "description_unavailable" }));
    const aligned = alignMediaResults(refs.length, targetIndexes, batchDescriptions, undefined);
    // 没有直链的图片是明确的读取失败；有直链但本轮额度未覆盖的图片保持原占位符。
    refs.forEach((image, index) => {
      if (!image.url) { aligned[index] = null; const kind = message.observedMedia?.find(media => media.imageIndex === index && media.source === "image")?.kind ?? image.mediaKind;
        if (kind !== "sticker" || isExplicitMediaQuestion(message.commandText ?? "", Boolean(message.images?.length || message.quotedMessage?.images?.length || message.quotedMessage?.image))) setVision(message, index, { status: "skipped", reason: "no_url" }); }
    });
    descriptionsByMessage.set(message.externalMessageId, aligned);
  }
  if (!descriptionsByMessage.size) return observed;

  return observed.map((message) => {
    const descriptions = descriptionsByMessage.get(message.externalMessageId);
    if (!descriptions?.length) return message;
    if (!message.imageTextParts) return patchMessageText(message, text => applyImageDescriptions(text, descriptions));
    return { ...message, content: applyImageDescriptions(message.content, descriptions, message.imageTextParts),
      ...(message.promptContent !== undefined ? { promptContent: applyImageDescriptions(message.promptContent, descriptions,
        message.promptImageTextParts ?? message.imageTextParts) } : {}),
    };
  });
}

/**
 * 把这一轮里的语音先转成文字，再交给聊天模型。
 *
 * 与看图同构，理由也一样：聊天模型读不懂音频，语音必须在进提示词之前变成文字。
 * 角色没打开 `voiceTranscribe`（或没配 ASR 模型）时这里原样返回 —— 行为与接入前一致，
 * 群里的语音仍然只是 `[语音]`。
 *
 * 放在额度检查之后：额度已经超了就别再为听语音多花一次调用。
 *
 * 失败不抛错（少一句转写不该让整轮回复变成错误事件），但也不再是「静默」：
 * 转不出来的那条占位符会换成 `[语音（没转成文字）]`，让模型知道「有语音、没听懂」。
 * 以前留的是裸的 `[语音]`，模型会把它当贴纸，自己编一句「本宝只收到个壳」糊过去。
 */
async function attachVoiceTranscripts(
  messages: ChannelTurnMessage[],
  context: {
    modelConfig: unknown;
    chatModel: string;
    apiBaseUrl: string;
    apiKey: string;
    voiceApiKey: string;
    asrApiKey: string;
  },
): Promise<ChannelTurnMessage[]> {
  if (!messages.some((message) => (message.voices?.length ?? 0) > 0)) return messages;

  /*
   * 开关必须先看，不能只看「ASR 配没配」。
   *
   * 这里原本漏了这个判断：页面上「听懂语音」明明关着，只要 ASR 模型配得齐，每轮
   * 还是照常下载、转码、调一次识别（按秒计费）。用户看到的是「我关了它还在花钱」，
   * 而注释里写的是「没打开 voiceTranscribe 时原样返回」—— 文档与实现打架，
   * 输的总是用户的钱包。所以以开关为准，ASR 配置只决定「开了之后能不能用」。
   */
  if (!isVoiceTranscribeEnabled(context.modelConfig)) return messages;

  const settings = resolveVoiceAsrSettings({
    modelConfig: context.modelConfig,
    chatModel: context.chatModel,
    chatApiBaseUrl: context.apiBaseUrl,
    chatApiKey: context.apiKey,
    voiceApiKey: context.voiceApiKey,
    asrApiKey: context.asrApiKey,
  });
  if (!settings) return messages;

  let remaining = MAX_VOICES_PER_TURN;
  const transcriptsByMessage = new Map<string, Array<string | null | undefined>>();
  for (const message of messages) {
    const voices = message.voices ?? [];
    if (!voices.length) continue;

    // 与图片相同：只请求有 URL 的语音，但回填必须使用原始语音数组序号。
    const targetIndexes = voices
      .map((voice, index) => (voice.url ? index : -1))
      .filter((index) => index >= 0);
    // 网关没给直链 = 这条音频根本拿不到，等同于「转了但没转出来」。
    if (!targetIndexes.length) {
      transcriptsByMessage.set(message.externalMessageId, voices.map(() => null));
      continue;
    }
    if (remaining <= 0) break;

    const selectedIndexes = targetIndexes.slice(0, remaining);
    const batch = selectedIndexes.map((index) => voices[index]!);
    remaining -= batch.length;

    let batchTranscripts: Array<string | null>;
    try {
      batchTranscripts = await transcribeVoices(batch, settings);
    } catch {
      // 整批都炸了就按「一条都没转出来」标记，别让调用方以为这轮没有语音。
      batchTranscripts = batch.map(() => null);
    }

    const aligned = alignMediaResults(voices.length, selectedIndexes, batchTranscripts, undefined);
    // 没有直链的语音明确标记为无法转写；超出每轮 ASR 上限的语音保留原占位符。
    voices.forEach((voice, index) => {
      if (!voice.url) aligned[index] = null;
    });
    transcriptsByMessage.set(message.externalMessageId, aligned);
  }
  if (!transcriptsByMessage.size) return messages;

  return messages.map((message) => {
    const transcripts = transcriptsByMessage.get(message.externalMessageId);
    if (!transcripts?.length) return message;
    return patchMessageText(message, (text) => applyVoiceTranscripts(text, transcripts));
  });
}

const channelTurnCharacterSelect = {
  id: true,
  name: true,
  ownerId: true,
  basePrompt: true,
  styleExamples: true,
  status: true,
  modelConfig: true,
  memorySetting: { select: { timezone: true } },
  memoryScopes: { where: { scopeType: "CHARACTER_GLOBAL" as const }, select: { id: true } },
} satisfies Prisma.CharacterSelect;

type ChannelTurnCharacter = Prisma.CharacterGetPayload<{ select: typeof channelTurnCharacterSelect }>;

const channelTurnConversationSelect = {
  id: true,
  title: true,
  memoryScopeId: true,
} satisfies Prisma.ConversationSelect;

type ChannelTurnConversation = Prisma.ConversationGetPayload<{ select: typeof channelTurnConversationSelect }>;

type ChannelTurnPreparation =
  | {
      ok: true;
      /** 批内去重 + 幂等过滤后、本轮真的要处理的消息。 */
      messages: ChannelTurnMessage[];
      character: ChannelTurnCharacter;
      globalScope: { id: string };
      existingConversation: ChannelTurnConversation | null;
    }
  /** 任何一步不过关都直接给出整轮结果，调用方原样返回。 */
  | { ok: false; result: ChannelMessageResult };

/**
 * 入口三件事：批内去重、角色与全局范围、幂等检查 + 会话查找。
 *
 * 同一批里可能出现同一条消息两次（网关重投、或者两个适配器都连着 —— 后者已经在
 * `run-onebot-adapter.ts` 里用单实例标记挡住）。不去重的话，整轮会撞
 * `messages(conversationId, externalMessageId)` 唯一约束，事务回滚，**整轮都不回**：
 * 一条重复消息把同一轮里别人的话也一起拖死。
 */
async function prepareChannelTurn(
  prisma: PrismaClient,
  input: {
    characterId: string;
    bindingId: string;
    externalConversationId: string;
    messages: ChannelTurnMessage[];
  },
): Promise<ChannelTurnPreparation> {
  const seenInBatch = new Set<string>();
  let messages = input.messages
    .filter((message) => message.externalMessageId && message.content)
    .filter((message) => {
      if (seenInBatch.has(message.externalMessageId)) return false;
      seenInBatch.add(message.externalMessageId);
      return true;
    })
    .slice(-10);
  if (!messages.length) return { ok: false, result: { status: "ignored", reason: "missing_fields" } };

  // Character lookup comes first: a paused or archived character must not answer channel
  // messages, and rejecting early also avoids creating an external identity for a dead character.
  const character = await prisma.character.findUnique({
    where: { id: input.characterId },
    select: channelTurnCharacterSelect,
  });
  if (!character) return { ok: false, result: { status: "ignored", reason: "character_missing" } };
  if (character.status !== "ACTIVE") return { ok: false, result: { status: "ignored", reason: "character_inactive" } };
  const globalScope = character.memoryScopes[0];
  if (!globalScope) return { ok: false, result: { status: "ignored", reason: "no_global_scope" } };

  // Idempotency: a QQ message id is unique for the application, so a re-delivered event is dropped
  // regardless of whether its conversation has been created yet. 群聊一轮里有几条，全查一遍。
  // 会话查找与幂等检查互不依赖，一起发，省一个 RTT（P3）。
  const [seen, foundConversation] = await Promise.all([
    prisma.message.findMany({
      where: { externalMessageId: { in: messages.map((message) => message.externalMessageId) } },
      select: { externalMessageId: true },
    }),
    prisma.conversation.findFirst({
      where: { channelBindingId: input.bindingId, externalConversationId: input.externalConversationId },
      select: channelTurnConversationSelect,
    }),
  ]);
  // 私聊预落库会建会话，后面的正常路径要接着用这一条，不能再建第二个。
  if (seen.length) {
    const seenIds = new Set(seen.map((row) => row.externalMessageId));
    const fresh = messages.filter((message) => !seenIds.has(message.externalMessageId));
    if (!fresh.length) return { ok: false, result: { status: "duplicate" } };
    messages = fresh;
  }

  return { ok: true, messages, character, globalScope, existingConversation: foundConversation };
}

const channelTurnRecentMessageSelect = {
  id: true,
  role: true,
  content: true,
  occurredAt: true,
  metadata: true,
  externalMessageId: true,
} satisfies Prisma.MessageSelect;

type ChannelTurnStoredMessage = Prisma.MessageGetPayload<{ select: typeof channelTurnRecentMessageSelect }>;

type ChannelTurnRawMessage = {
  id: string;
  role: string;
  content: string;
  occurredAt: string;
  /** 群聊原文的发言人与主人标记：不带上，她读到的就是一句句没有主人的话。 */
  speaker?: string;
  isOwner?: boolean;
  scope: "character" | "private";
};

/**
 * 忆泡还没覆盖到那一段时用原文兜底；只在问句指向某一天时才查。
 *
 * 截断在 `selectRawMessagesForPrompt` 里做（并按截断后的长度算预算），这里不要再切一刀：
 * 两处各有一个上限时，短的那个生效、长的那个没人知道它已经失效了。
 */
async function loadChannelTurnRawMessages(input: {
  prisma: PrismaClient;
  character: ChannelTurnCharacter;
  isGroup: boolean;
  platform: string;
  characterId: string;
  eventSelectionRange: { start: Date; end: Date } | null | undefined;
  readableScopeIds: string[];
  retrievalQuery: string;
  recentStoredMessages: ChannelTurnStoredMessage[];
  crossChannel: CrossChannelLine[];
  globalScopeId: string;
  group?: ChannelGroupTurnContext;
}): Promise<ChannelTurnRawMessage[]> {
  const { prisma, isGroup } = input;
  if (!input.eventSelectionRange) return [];
  const rawCandidates = await prisma.message.findMany({
    where: {
      conversation: { memoryScopeId: { in: input.readableScopeIds } },
      occurredAt: { gte: input.eventSelectionRange.start, lt: input.eventSelectionRange.end },
    },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    take: 200,
    select: {
      id: true, role: true, content: true, occurredAt: true, metadata: true,
      conversation: { select: { memoryScopeId: true } },
    },
  });
  let rawPromptCandidates = rawCandidates;
  if (isGroup && rawCandidates.length) {
    const rawUids = [...new Set(
      rawCandidates
        .filter((item) => item.role === "USER" && !readStoredSpeaker(item.metadata).isOwner)
        .map((item) => readStoredAuthorOpenId(item.metadata))
        .filter(Boolean),
    )];
    if (rawUids.length) {
      const rawIdentities = await prisma.externalIdentity.findMany({
        where: { platform: input.platform, platformUid: { in: rawUids } },
        select: {
          platformUid: true,
          kind: true,
          memoryScopes: {
            where: { characterId: input.characterId, scopeType: "EXTERNAL_IDENTITY" },
            take: 1,
            select: { friendChatPolicy: true },
          },
        },
      });
      const rawPolicyByUid = new Map(rawIdentities.map((identity) => [
        identity.platformUid,
        {
          kind: identity.kind,
          policy: identity.memoryScopes[0]?.friendChatPolicy ?? "DEFAULT",
        },
      ] as const));
      rawPromptCandidates = rawCandidates.filter((item) => {
        if (item.role !== "USER") return true;
        const speaker = readStoredSpeaker(item.metadata);
        const uid = readStoredAuthorOpenId(item.metadata);
        if (speaker.isOwner || (input.group?.ownerQq && uid === input.group.ownerQq)) return true;
        const identity = rawPolicyByUid.get(uid);
        return !shouldBlockFriendSpeaker(identity?.kind ?? "UNKNOWN", identity?.policy ?? "DEFAULT");
      });
    }
  }
  const selected = selectRawMessagesForPrompt(input.retrievalQuery, rawPromptCandidates, {
    timeZone: resolveChatTimeZone(input.character.memorySetting?.timezone),
    tokenBudget: resolveRawMessageTokenBudget(input.character.modelConfig),
    limit: resolveRawMessageLimit(input.character.modelConfig),
    // 已经通过跨窗口旁路带进来的那几条不要再算一遍：同一句在提示词里出现两次，
    // 模型会当成两件事，或者以为对方重复说过。
    excludeIds: new Set([...input.recentStoredMessages.map((message) => message.id), ...input.crossChannel.map((line) => line.id)]),
  });
  return selected.items.map((message) => {
    const speaker = readStoredSpeaker(message.metadata);
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      occurredAt: message.occurredAt.toISOString(),
      // 原文兜底也要说清是谁讲的：只给 role，群聊里每一句都是「user」。
      ...(speaker.speaker ? { speaker: speaker.speaker } : {}),
      ...(speaker.isOwner ? { isOwner: true } : {}),
      scope: message.conversation.memoryScopeId === input.globalScopeId ? ("character" as const) : ("private" as const),
    };
  });
}

/**
 * 落库：会话归位/创建、本轮消息、群成员、她的回复 —— 全在一个事务里。
 *
 * 为什么必须同事务：「消息写进去了但成员表没记」会让熟客榜在某个群永远筛不出人来，
 * 而这种缺口事后无从发现（只能靠翻消息表重建）。
 */
async function persistChannelTurnResult(input: {
  prisma: PrismaClient;
  existingConversation: ChannelTurnConversation | null;
  isGroup: boolean;
  globalScope: { id: string };
  ownerPrivateScopeId: string | null;
  isOwnerTurn: boolean;
  turn: {
    characterId: string;
    platform: string;
    bindingId: string;
    externalConversationId: string;
    memberObservations?: ChannelTurnMessage[];
  };
  conversationScopeId: string;
  groupId: string | null;
  title: string;
  messages: ChannelTurnMessage[];
  privateMessagesRecorded: boolean;
  now: Date;
  assistantAt: Date;
  generated: Awaited<ReturnType<typeof generateGroupContextReply>>;
  observedReadOnlyAiEvidence: boolean;
  privateHistorySelection: ChannelTurnWindow["privateHistorySelection"];
  selfUnderstanding: ChannelTurnGrowthPreparation["selfUnderstanding"];
  replyFaces: string[];
  replySticker: StickerCatalogEntry | null;
  replyVoice: boolean;
  /** 这一轮她自己画的那张图；没画就是 null。只落相对路径，不存图片字节。 */
  replyImage: GeneratedImage | null;
  imageOffer?: { prompt: string; authorOpenId: string };
  imageAttempt?: ImageAttemptRecord;
  imageGeneration?: ImageGenerationRecord;
  imageStatusOverride?: boolean;
  replySegments: string[];
  goals: ChannelTurnGrowthPreparation["goals"];
  expressionHabits: ChannelTurnGrowthPreparation["expressionHabits"];
  preferences: ChannelTurnGrowthPreparation["preferences"];
}): Promise<{ conversationId: string; assistantMessageId?: string }> {
  const {
    prisma, existingConversation, isGroup, globalScope, ownerPrivateScopeId, isOwnerTurn, turn,
    conversationScopeId, groupId, title, messages, privateMessagesRecorded, now, assistantAt, generated,
    observedReadOnlyAiEvidence, privateHistorySelection, selfUnderstanding, replyFaces, replySticker,
    replyVoice, replyImage, replySegments, goals, expressionHabits, preferences, imageOffer, imageAttempt, imageGeneration, imageStatusOverride,
  } = input;
  return await prisma.$transaction(async (tx) => {
    let conversation = existingConversation;
    /**
     * 已有会话可能要换记忆范围。两条路，方向都是单向的：
     *
     * - 群聊 → 角色全局（`resolveGroupScopeRepair`）：新建时写 global，但历史会话可能还挂在
     *   建群那一刻的外部身份范围下。不修则群消息永不进忆泡、她在群里也查不到自己的话。
     * - 主人私聊 → 主人专属范围（`resolveOwnerPrivateScopeRepair`）：会话按
     *   `(binding, externalConversationId)` 唯一、找到就复用，早于该功能建出来的会话仍挂在
     *   这个 QQ 的 EXTERNAL_IDENTITY 上，之后主人说的每一句都落在外面。
     *
     * 两个都返回 null 表示不用动。私聊的预落库（`recordPrivateTurnMessages`）只处理主人
     * 范围那一半，群聊不走那条路，所以群聊的归位只能落在下面这个事务里。
     */
    if (conversation) {
      const repairScopeId = resolveGroupScopeRepair({
        isGroup,
        globalScopeId: globalScope.id,
        currentScopeId: conversation.memoryScopeId,
      }) ?? resolveOwnerPrivateScopeRepair({
        isOwnerTurn,
        ownerPrivateScopeId,
        currentScopeId: conversation.memoryScopeId,
      });
      if (repairScopeId) {
        // 旧范围里已经整理出的忆泡跟着会话走：否则新范围读不到，归位后还会重复提一遍。
        const moved = await rehomeConversationScope(tx, {
          conversationId: conversation.id,
          fromScopeId: conversation.memoryScopeId,
          toScopeId: repairScopeId,
        });
        if (isGroup && (moved.moved || moved.merged)) {
          console.log("[scope] 群会话归位到全局范围 " + JSON.stringify({
            conversationId: conversation.id,
            moved: moved.moved,
            merged: moved.merged,
            days: moved.days,
          }));
        }
        conversation = { ...conversation, memoryScopeId: repairScopeId };
      }
    } else {
      conversation = await tx.conversation.create({
        data: {
          characterId: turn.characterId,
          // 群聊挂在角色全局 scope 下：它属于一群人，不属于某一个外部身份。
          memoryScopeId: conversationScopeId,
          channelBindingId: turn.bindingId,
          externalConversationId: turn.externalConversationId,
          title,
          status: "ACTIVE",
          // kind/groupId 让「这段记录属于哪个群」可查；记忆页的群聊记录按它分组。
          metadata: {
            platform: turn.platform,
            kind: isGroup ? "group" : "private",
            ...(groupId ? { groupId } : {}),
          },
        },
        select: { id: true, title: true, memoryScopeId: true },
      });
    }
    // 一轮 N 条一次写入（P3）：逐条 create 是 N 次往返。去重前面已做，
    // 撞唯一约束仍整个事务回滚，行为与逐条一致。
    // 私聊已经在模型调用前预落库了，这里不再重复写。
    if (!privateMessagesRecorded) {
      await tx.message.createMany({
        data: messages.map((message, index) => ({
          conversationId: conversation.id,
          externalMessageId: message.externalMessageId,
          role: "USER" as const,
          content: message.content,
          // 一条一轮时保持原来的「处理时刻」，多条时用各自的收到时刻，别让并发把顺序搅乱。
          occurredAt: messages.length === 1 ? now : (message.occurredAt ?? new Date(now.getTime() - (messages.length - index))),
          metadata: buildStoredMessageMetadata({
            platform: turn.platform,
            storedReason: generated.action === "reply" ? "replied" : "silent",
            message,
          }),
        })),
      });
    }
    /**
     * 群成员归属：谁在这个群里说过话。
     *
     * 和上面的消息落库同一个事务 —— 「消息写进去了但成员表没记」会让熟客榜在某个群
     * 永远筛不出人来，而这种缺口事后无从发现（只能靠翻消息表重建）。
     *
     * 记的是**所有开口的人**，不是「她回过的人」：这张表要回答「这个屋里都有谁」，
     * 熟客榜再拿它跟「她回过谁」取交集。混成一件事，她就只认得自己搭理过的几个人，
     * 对同一个群里天天见的其他人无从判断。
     */
    if (isGroup) {
      for (const member of buildGroupMemberDeltas(turn.memberObservations ?? messages)) {
        await tx.groupMember.upsert({
          where: {
            conversationId_platformUid: { conversationId: conversation.id, platformUid: member.platformUid },
          },
          create: {
            conversationId: conversation.id,
            characterId: turn.characterId,
            platformUid: member.platformUid,
            displayName: member.displayName,
            messageCount: member.count,
            firstSpokeAt: member.firstSpokeAt,
            lastSpokeAt: member.lastSpokeAt,
          },
          update: {
            messageCount: { increment: member.count },
            // 只往前推：乱序补录一条旧消息时不要把「最后说话时间」拉回去。
            lastSpokeAt: member.lastSpokeAt,
            ...(member.displayName ? { displayName: member.displayName } : {}),
          },
        });
      }
    }
    let assistantMessageId: string | undefined;
    if (generated.action === "reply") {
      const assistantMessage = await tx.message.create({
        data: {
          conversationId: conversation.id,
          role: "ASSISTANT",
          content: generated.reply,
          occurredAt: assistantAt,
          metadata: {
            source: "channel",
            platform: turn.platform,
            generatedBy: imageStatusOverride ? "image-execution-status" : generated.localHistoryReceipt ? "local-history-receipt" : "llm",
            ...(observedReadOnlyAiEvidence ? { excludeFromGrowth: true, growthExclusionReason: "read_only_ai_context" } : {}),
            model: generated.model,
            provider: generated.provider,
            promptTemplateVersion: generated.promptTemplateVersion,
            ...(imageOffer ? { imageOffer } : {}),
            ...(imageAttempt ? { imageAttempt } : {}),
            usedMemoryIds: generated.usedMemoryIds,
            usedSnapshotIds: generated.usedSnapshotIds,
            usedPreferenceIds: generated.usedPreferenceIds ?? [],
            usedExpressionHabitIds: generated.usedExpressionHabitIds ?? [],
            usedGoalIds: generated.usedGoalIds ?? [],
            ...(privateHistorySelection ? { privateHistorySelection } : {}),
            ...(selfUnderstanding && !generated.localHistoryReceipt ? { providedSelfUnderstandingSources: selfUnderstandingReferences(selfUnderstanding) } : {}),
            usedGoals: usedGoalSnapshots(goals, generated.usedGoalIds ?? []),
            usedExpressionHabits: usedExpressionHabitSnapshots(expressionHabits, generated.usedExpressionHabitIds ?? []),
            usedPreferences: usedPreferenceSnapshots(preferences, generated.usedPreferenceIds ?? []),
            ...(generated.usedRawMessageIds.length ? { usedRawMessageIds: generated.usedRawMessageIds } : {}),
            ...(generated.usedEventIds.length ? { usedEventIds: generated.usedEventIds } : {}),
            ...(generated.usedCatchphraseIds.length ? { usedCatchphraseIds: generated.usedCatchphraseIds } : {}),
            // 表情段不进 content：正文要能原样重放给下一轮模型，混进 [face] 会被当成用户打的字。
            ...(replyFaces.length ? { faceIds: replyFaces } : {}),
            ...(replySticker ? { stickerId: replySticker.id } : {}),
            // 只记「这一条是语音」，不存音频：音频发完就没了，存下来也没法重放给模型。
            ...(replyVoice ? { voice: true } : {}),
            // 她画的那张图：只存相对路径与尺寸，不存字节，也不记聊天模型 ——
            // 只证明生成；下一轮 hadImage 还要核对 replyDelivery.image 的发送回执。
            ...(replyImage
              ? {
                  image: {
                    path: replyImage.relativePath,
                    ...(imageGeneration ? { generation: imageGeneration } : {}),
                    vision: { status: "not_requested" },
                    ...(replyImage.width ? { width: replyImage.width } : {}),
                    ...(replyImage.height ? { height: replyImage.height } : {}),
                  },
                }
              : {}),
            // 这一轮在 QQ 上弹了几条。content 里保留着换行，这里只留个数方便排查
            // 「她怎么一下发了三条」—— 单条时不记，免得 metadata 里多一个恒为 1 的字段。
            ...(replySegments.length > 1 ? { replySegments: replySegments.length } : {}),
          },
        },
        select: { id: true },
      });
      assistantMessageId = assistantMessage.id;
      await tx.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: assistantAt } });
    } else {
      await tx.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: messages[messages.length - 1]!.occurredAt ?? now } });
    }
    return { conversationId: conversation.id, ...(assistantMessageId ? { assistantMessageId } : {}) };
  });
}

/**
 * 群聊工作摘要落库：模型这一轮总结出的「刚才聊到哪」。
 *
 * 证据 id 只认本会话里真实存在的行；有一条对不上就不写摘要（只留证据），
 * 免得下一轮拿着半截摘要当上下文。失败只记日志，不阻断已经发出的回复。
 */
async function saveChannelTurnWorkingContext(input: {
  prisma: PrismaClient;
  conversationId: string;
  characterId: string;
  messages: ChannelTurnMessage[];
  workingContext: Awaited<ReturnType<typeof loadConversationWorkingContext>>;
  pendingWorkingContext: { summary: string; evidenceMessageIds: string[] } | undefined;
  contextRuntime: unknown;
  isGroup: boolean;
}): Promise<void> {
  const { prisma, conversationId, characterId, messages, workingContext, pendingWorkingContext, contextRuntime, isGroup } = input;
  if (!pendingWorkingContext || !contextRuntime || !isGroup) return;
  try {
    const references = pendingWorkingContext.evidenceMessageIds;
    const sources = await prisma.message.findMany({
      where: { conversationId, OR: [{ id: { in: references.filter(id => /^[0-9a-f-]{36}$/iu.test(id)) } }, { externalMessageId: { in: references } }] },
      select: { id: true, externalMessageId: true, occurredAt: true },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 24,
    });
    const cursor = await prisma.message.findFirst({
      where: { conversationId, role: "USER", externalMessageId: { in: messages.map(row => row.externalMessageId) } },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }], select: { id: true, occurredAt: true },
    });
    const complete = references.every(id => sources.some(row => row.id === id || row.externalMessageId === id));
    if (sources.length && cursor) await saveConversationWorkingContext(prisma, {
      conversationId, characterId: characterId, expectedRevision: workingContext?.revision ?? 0,
      summary: complete ? pendingWorkingContext.summary : "", evidenceMessageIds: sources.map(row => row.id),
      cursor,
    });
  } catch {
    console.warn("[context] 工作摘要保存失败，下轮仍可读取原始记录。");
  }
}

/**
 * 发送这一轮回复，并在发完之后记账：朋友关系、贴纸使用次数、梗冷却、顺手扫梗。
 *
 * 记账一律放在发送之后：不能让记账拖住已经生成的那句话。
 * 语音轮次不带引用与 @ —— 语音段与额外段并存时 QQ 客户端不渲染语音。
 */
async function deliverChannelTurnReply(input: {
  prisma: PrismaClient;
  character: ChannelTurnCharacter;
  platform: string;
  characterId: string;
  sendReply: ChannelReplySender;
  isGroup: boolean;
  messages: ChannelTurnMessage[];
  generated: Awaited<ReturnType<typeof generateGroupContextReply>>;
  replyFaces: string[];
  replySticker: StickerCatalogEntry | null;
  replyVoice: boolean;
  /** 这一轮她自己画的那张图；没画就是 null。只落相对路径，不存图片字节。 */
  replyImage: GeneratedImage | null;
  replySegments: string[];
  voiceSettings: VoiceTtsSettings | null;
  recordDelivery: (delivery: ChannelReplyDelivery) => Promise<void>;
}): Promise<void> {
  const { prisma, character, platform, characterId, sendReply, isGroup, messages, generated,
    replyFaces, replySticker, replyVoice, replyImage, replySegments, voiceSettings } = input;
  if (generated.action !== "reply") return;
  /**
   * 语音条只发一个 record 段 —— 引用和 @ 都不带。
   *
   * 这不是审美取舍，是实测出来的硬限制（2026-11-01 01:02，某群）：
   * `[回复:12345678] [语音]` 两条段拼在一条消息里发出去，协议端日志显示
   * PTT 上传成功（11871 字节、96ms），服务端回显她自己的消息也同时带着
   * 「回复」和「语音」两个元素 —— 但 QQ 客户端**只渲染了引用块，语音条不见**。
   * 用户看到的就是一条空引用：「又是引用，然后发语音，结果语音不出来」。
   *
   * 同一批语音里不带引用的那条全部正常播放（25/25）。所以规律是：
   * **语音段与额外段并存时客户端不渲染语音**，而不是发送失败。
   *
   * 取舍：语音能播出来 ≫ 看得出在回谁。语音轮次因此退化成「一条纯语音」。
   * `at` 也一并去掉 —— 同样是额外段，没有理由相信它比引用更安全。
   * 别为了「让语音也带上引用或 @」再把这两行改回去，除非协议端/客户端换了。
   */
  const quoteTarget = replyVoice
    ? undefined
    : pickQuoteTarget(generated.groupDecision?.replyToMessageId, messages.at(-1)?.externalMessageId);
  const requestedAtTarget = replyVoice ? undefined : generated.groupDecision?.atMessageId;
  const atTarget = platform === "qq-onebot" && isGroup
    ? await filterPassiveGroupAt(prisma, characterId, requestedAtTarget)
    : requestedAtTarget;
  const replyOptions = replyFaces.length || replySticker || replyVoice || replyImage || quoteTarget || atTarget || replySegments.length > 1
    ? {
        ...(replyFaces.length ? { faces: replyFaces } : {}),
        ...(replyImage ? { image: replyImage } : {}),
        ...(replySticker
          ? {
              sticker: {
                id: replySticker.id,
                filePath: replySticker.filePath,
                qqEmojiId: replySticker.qqEmojiId ?? null,
              },
            }
          : {}),
        ...(replyVoice && voiceSettings ? { voice: true, voiceSettings } : {}),
        ...(quoteTarget ? { replyToMessageId: quoteTarget } : {}),
        ...(atTarget ? { atMessageId: atTarget } : {}),
        // 只有真的拆开了才带，单条时渠道那边连这个字段都看不到。
        ...(replySegments.length > 1 ? { segments: replySegments } : {}),
      }
    : undefined;
  // Preserve the model's request even when this layer suppresses it before the sender sees it.
  const requestedAt = generated.groupDecision?.atMessageId;
  let reported = false;
  const reportDelivery = async (delivery: ChannelReplyDelivery) => {
    reported = true;
    await input.recordDelivery(delivery.at || !requestedAt || atTarget ? delivery
      : mergeSuppressedAtDelivery(delivery, requestedAt, replyVoice ? "voice" : "passive_policy"));
  };
  const delivery = await sendReply(generated.reply, {
    ...replyOptions,
    onDelivery: reportDelivery,
  });
  if (delivery?.at || delivery?.image) await reportDelivery(delivery);
  else if (!reported && requestedAt && !atTarget) await reportDelivery({ at: {
    requestedMessageId: requestedAt,
    status: "suppressed",
    reason: replyVoice ? "voice" : "passive_policy",
  } });
  /**
   * 群聊里「跟谁互动过」＝她真的回了谁。
   *
   * 对象从三处取：她引用的那条、她 @ 的那条、两样都没有就是这轮最新的一句（她接的
   * 就是这句话）。`silent` 走不到这个分支，所以没被搭理的发言不会变成朋友 —— 这正
   * 是「她回过的人才算」的落地位置。
   *
   * **引用的是本批之外的消息时，退回本轮最新一条**（判定见 `pickFriendTargets`）：
   * 她引用历史消息、或者上一轮的尾巴时，按 id 匹配会一条都不中，整轮白记 ——
   * 她明明回了，关系行却停在几小时前（2026-11-02 复核「她的朋友」页面时发现）。
   *
   * 放在发完之后：朋友簿晚半秒无所谓，不能让记账拖住已经生成的那句话。
   */
  if (isGroup) {
    const targets = pickFriendTargets(messages, {
      replyToMessageId: quoteTarget,
      atMessageId: atTarget,
    });
    const recordedAuthors = new Set<string>();
    for (const message of targets) {
      const platformUid = (message.authorPlatformUid || message.authorOpenId || "").trim();
      if (!platformUid || recordedAuthors.has(platformUid)) continue;
      recordedAuthors.add(platformUid);
      await recordFriendInteraction({
        characterId: characterId,
        platform: platform,
        platformUid,
        displayName: message.authorDisplayName,
        source: "GROUP",
        at: message.occurredAt,
      }).catch(() => undefined);
    }
  }
  // 记一次使用：页面要能看出「哪几张她根本没用过」。写失败不影响已经发出去的回复。
  if (replySticker) {
    await prisma.characterSticker.update({
      where: { id: replySticker.id },
      data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
    }).catch(() => undefined);
  }
  // 梗的记账同理：漏记就等于没有冷却，那句「不烧心吗」会连着刷。
  await markCatchphrasesUsed(character.id, generated.usedCatchphraseIds);
  // 顺手扫一遍群里的梗（开关默认关、6 小时最多一次、不 await）。
  // 放在回复发完之后：扫梗绝不能挡住她说这一句话。
  maybeAutoMineCatchphrases(character.modelConfig, character.id);
}

/**
 * 尾段记账：记忆召回计数 + 记忆助手的用量与诊断。
 *
 * 两者都不影响已经发出去的回复：任何失败都只吞掉，不改变这一轮的结果。
 */
async function recordChannelTurnTailUsage(input: {
  prisma: PrismaClient;
  characterId: string;
  bindingId: string;
  conversationId: string;
  turnId: string;
  generated: Awaited<ReturnType<typeof generateGroupContextReply>>;
  turnDetail: ReturnType<typeof createModelTurnDetail>;
}): Promise<void> {
  const { prisma, characterId, bindingId, conversationId, turnId, generated, turnDetail } = input;
  if (generated.usedMemoryIds.length) {
    await prisma.memoryItem.updateMany({
      where: { id: { in: generated.usedMemoryIds } },
      data: { lastRecalledAt: new Date(), recallCount: { increment: 1 } },
    }).catch(() => undefined);
  }

  if (generated.memoryAssistantModel && generated.memoryAssistantStatus) {
    let memoryDiagnostics: {
      queryLength?: number;
      candidateCount?: number;
      sourceCount: number;
      memorySourceCount: number;
      snapshotSourceCount: number;
      eventSourceCount: number;
      messageSourceCount: number;
    } = {
      sourceCount: 0, memorySourceCount: 0, snapshotSourceCount: 0,
      eventSourceCount: 0, messageSourceCount: 0,
    };
    try {
      const detail = JSON.parse(turnDetail.serialize()) as {
        memory?: { query?: unknown; candidateCount?: unknown; sources?: Array<{ type?: unknown }> };
      };
      const memory = detail.memory ?? {};
      const sources = Array.isArray(memory.sources) ? memory.sources : [];
      const count = (type: string) => sources.filter((source) => source.type === type).length;
      memoryDiagnostics = {
        ...(typeof memory.query === "string" ? { queryLength: memory.query.length } : {}),
        ...(typeof memory.candidateCount === "number" ? { candidateCount: memory.candidateCount } : {}),
        sourceCount: sources.length,
        memorySourceCount: count("memory"),
        snapshotSourceCount: count("snapshot"),
        eventSourceCount: count("event"),
        messageSourceCount: count("message"),
      };
    } catch {
      // 诊断序列化失败不能影响回复或用量记账。
    }
    await recordModelUsage({
      kind: "memory-assistant",
      model: generated.memoryAssistantModel,
      usage: toUsageTokens(generated.memoryAssistantUsage),
      characterId: characterId,
      channelBindingId: bindingId,
      conversationId,
      metadata: {
        status: generated.memoryAssistantStatus,
        turnId,
        ...memoryDiagnostics,
        ...(generated.memoryAssistantFailureReason ? { reason: generated.memoryAssistantFailureReason } : {}),
        ...(typeof generated.memoryAssistantAttempts === "number" ? { attempts: generated.memoryAssistantAttempts } : {}),
        ...(generated.memoryAssistantFinishReason ? { finishReason: generated.memoryAssistantFinishReason } : {}),
        ...(typeof generated.memoryAssistantHttpStatus === "number" ? { httpStatus: generated.memoryAssistantHttpStatus } : {}),
      },
    });
  }
}

type ChannelTurnChatInputContext = {
  preferences: ChannelTurnGrowthPreparation["preferences"];
  expressionHabits: ChannelTurnGrowthPreparation["expressionHabits"];
  goals: ChannelTurnGrowthPreparation["goals"];
  memories: ChannelTurnRetrieval["memories"];
  snapshots: ChannelTurnRetrieval["snapshots"];
  events: ChannelTurnRetrieval["events"];
  recentEvents: ChannelTurnRetrieval["recentEvents"];
  rawMessages: ChannelTurnRawMessage[];
  selfUnderstanding: ChannelTurnGrowthPreparation["selfUnderstanding"];
  journalLine: ChannelTurnReplyToggles["journalLine"];
  journalRecent: ChannelTurnReplyToggles["journalRecent"];
  journalFacts: ChannelTurnRetrieval["journalFacts"];
  groupActivity: ChannelTurnRetrieval["groupActivity"];
  catchphrasePrompt: ChannelTurnReplyToggles["catchphrasePrompt"];
  emojiFaces: ChannelTurnReplyToggles["emojiFaces"];
  stickerCatalog: ChannelTurnReplyToggles["stickerCatalog"];
  interactionGuidance: Awaited<ReturnType<typeof readInteractionGuidance>>;
  interactionExperiences: Awaited<ReturnType<typeof readInteractionExperiences>>;
  conversationSummary: Awaited<ReturnType<typeof prepareConversationSummary>>;
  groupAcquaintances: Array<{ name: string; note: string }> | undefined;
  acquaintances: ChannelTurnRetrieval["acquaintanceRows"];
  privateKnowledgeItems: ChannelTurnGrowthPreparation["privateKnowledgeItems"];
  voiceSettings: ChannelTurnReplyToggles["voiceSettings"];
  voicePlanned: boolean;
  imageSettings: ChannelTurnReplyToggles["imageSettings"];
  imageCapable?: boolean;
  imageDecision: ImageReplyDecision;
  generatedImageContext?: GeneratedImageFacts;
  visionAvailable: boolean;
  imagePlanned: boolean;
  allowSilent: boolean;
  useTranscript: boolean;
  isGroup: boolean;
  character: { name: string; basePrompt: string; styleExamples: string | null; modelConfig: ChannelTurnCharacter["modelConfig"] };
  chatSettings: ReturnType<typeof resolveChatModelSettings>;
  apiKey: string;
  currentMessage: string;
  chatTimeZone: string;
  messages: ChannelTurnMessage[];
  backgroundLines: NonNullable<ChannelGroupTurnContext["background"]>;
  recentMessages: ConversationContextMessage[];
  recentStoredMessages: ChannelTurnStoredMessage[];
  crossChannel: CrossChannelLine[];
  readOnlyTools: Record<string, unknown> | undefined;
  ownerHistoryHold: boolean;
  turn: {
    platform: string;
    group?: ChannelGroupTurnContext;
    voiceCapable?: boolean;
    segmentCapable?: boolean;
  };
};

/**
 * 组装这一轮进模型的载荷。
 *
 * 纯数据构造、无副作用：所有「查库/判定」都已在前面完成，这里只负责把结果摆到
 * 提示词该在的位置，并按群聊/私聊、语音/分条、主人/群友等维度决定哪些段出现。
 * 群元数据（背景、成员、锚点）缺了只是语境变薄，不改变「这是群聊」这个事实。
 */
function buildChannelTurnChatInput(ctx: ChannelTurnChatInputContext): Parameters<typeof generateGroupContextReply>[0]["chatInput"] {
  const {
    preferences, expressionHabits, goals, memories, snapshots, events, recentEvents, rawMessages,
    selfUnderstanding, journalLine, journalRecent, journalFacts, groupActivity, catchphrasePrompt,
    emojiFaces, stickerCatalog, interactionGuidance, interactionExperiences, conversationSummary,
    groupAcquaintances, acquaintances, privateKnowledgeItems, voiceSettings, voicePlanned,
    imageSettings, imagePlanned, allowSilent,
    useTranscript, isGroup, character, chatSettings, apiKey, currentMessage, chatTimeZone, messages,
    backgroundLines, recentMessages, recentStoredMessages, crossChannel, readOnlyTools, ownerHistoryHold, turn,
  } = ctx;
  return {
        ...(turn.platform === "qq-onebot" && !(ownerHistoryHold) && qqReadOnlyTaskRequested(currentMessage) ? { readOnlyTools } : {}),
        preferences,
        expressionHabits,
        goals,
        characterName: character.name,
        characterPrompt: character.basePrompt.slice(0, 12_000),
        ...(!useTranscript && messages[0]!.speaker ? { speaker: messages[0]!.speaker } : {}),
        styleExamples: (character.styleExamples ?? "").slice(0, 8000),
        model: chatSettings.model,
        apiKey,
        apiBaseUrl: chatSettings.apiBaseUrl,
        temperature: chatSettings.temperature,
        maxTokens: chatSettings.maxTokens,
        thinking: chatSettings.thinking,
        currentMessage,
        ...(!isGroup && messages[0]?.quotedMessage ? { quotedMessage: messages[0].quotedMessage } : {}),
        timeZone: chatTimeZone,
        ...(journalLine ? { journalLine } : {}),
        ...(journalRecent.length ? { journalRecent } : {}),
        ...(journalFacts.length ? { journalFacts } : {}),
        ...(groupActivity ? { groupActivity } : {}),
        events,
        ...(recentEvents.length ? { recentEvents } : {}),
        rawMessages,
        ...(useTranscript
          ? {
              transcript: messages.map((message) => ({
                id: message.externalMessageId,
                ...(message.member ? { member: message.member } : {}),
                speaker: message.authorDisplayName ?? "",
                content: message.promptContent ?? message.content,
                // 谁是主人必须逐行带：顶层 speaker 在群聊路径下不会传（一轮里好几个人说话），
                // 漏掉这一行，模型只能从「谁说话口吻像主人」里猜，结果就是对谁都喊主人。
                isOwner: message.speaker?.isOwner === true,
                // 这一行 @ 的是谁：只给 `@member_n` 不够，模型不知道代号背后是谁。
                ...(message.mentions?.length ? { mentions: message.mentions } : {}),
                // 他引用的哪一句：带上作者和原文，模型才看得出这句在接谁的话。
                ...(message.quotedMessage ? {
                  quoted: {
                    id: message.quotedMessage.messageId,
                    ...(message.quotedMessage.member ? { member: message.quotedMessage.member } : {}),
                    ...(message.quotedMessage.speaker ? { speaker: message.quotedMessage.speaker } : {}),
                    ...(message.quotedMessage.content ? { content: message.quotedMessage.content } : {}),
                    ...(message.quotedMessage.isSelf ? { isSelf: true } : {}),
                    ...(sanitizeGeneratedImageFacts(message.quotedMessage.image) ? { image: sanitizeGeneratedImageFacts(message.quotedMessage.image)! } : {}),
                    ...conversationSourcePolicy(message.quotedMessage),
                  },
                } : {}),
                ...(message.occurredAt ? { occurredAt: message.occurredAt.toISOString() } : {}),
              })),
            }
          : {}),
        /**
         * 「这一轮是群聊」只认 `isGroup`，不认 `turn.group` 有没有值。
         *
         * 这两者必须同源：助理回合身份在 `createAssistantTurnContext` 里按 `isGroup` 写成
         * `channel: "qq-group"`，`assertAssistantTurnChannel` 再拿 `chatInput.groupChat` 去校对。
         * 如果 groupChat 按「群里带了元数据」算，一条缺 `group` 的群消息就会变成身份说群聊、
         * chatInput 说私聊，断言抛错、整轮 abort —— 而且是在写库事务之前 abort，于是群会话
         * 归位、旧忆泡搬家、这一轮消息落库全都不发生，日志里只有一句 ignored。
         * 群元数据（背景、成员、锚点）仍然只在 `turn.group` 有值时附带，缺了只是语境变薄。
         */
        ...(isGroup ? { groupChat: true } : {}),
        ...(turn.group
          ? {
              direct: turn.group.direct,
              ...(backgroundLines.length
                ? {
                    groupBackground: backgroundLines.map((line) => ({
                      id: line.id,
                      member: line.member,
                      speaker: line.speaker,
                      content: line.text,
                      ...conversationSourcePolicy(line),
                      ...(line.mentions?.length ? { mentions: line.mentions } : {}),
                      ...(line.quoted ? { quoted: { id: line.quoted.id,
                        ...(line.quoted.member ? { member: line.quoted.member } : {}),
                        ...(line.quoted.speaker ? { speaker: line.quoted.speaker } : {}),
                        ...(line.quoted.text ? { content: line.quoted.text } : {}),
                        ...(typeof line.quoted.isSelf === "boolean" ? { isSelf: line.quoted.isSelf } : {}),
                        ...conversationSourcePolicy(line.quoted),
                      } } : {}),
                      occurredAt: new Date(line.at).toISOString(),
                    })),
                  }
                : {}),
              ...(turn.group.anchors.length ? { groupAnchors: turn.group.anchors } : {}),
              ...(turn.group.members?.length ? { groupMembers: turn.group.members } : {}),
            }
          : {}),
        ...(allowSilent ? { allowSilent } : {}),
        // 当前会话只有在渠道支持、角色开关开启且 TTS 配置完整时，才算真的能发语音。
        voiceEnabled: turn.voiceCapable === true
          && isVoiceReplyEnabled(character.modelConfig)
          && Boolean(voiceSettings),
        // 能不能分条发，是渠道的事，不看角色配置 —— QQ 一条一条弹是平台习惯，不是设定。
        ...(turn.segmentCapable ? { segmentedReply: true } : {}),
        ...(groupAcquaintances?.length ? { groupAcquaintances } : {}),
        ...(acquaintances ? { acquaintances } : {}),
        ...(interactionGuidance.length ? { interactionGuidance } : {}),
        ...(selfUnderstanding ? { selfUnderstanding } : {}),
        ...(interactionExperiences.length ? (isGroup ? { groupInteractionExperiences: interactionExperiences } : { interactionExperiences }) : {}),
        ...(conversationSummary ? { conversationSummary } : {}),
        recentMessages: conversationSummary ? recentMessages.filter(row => {
          const source = recentStoredMessages.find(item => (item.externalMessageId || item.id) === row.id);
          return !source || source.occurredAt.toISOString() > conversationSummary.through.occurredAt ||
            (source.occurredAt.toISOString() === conversationSummary.through.occurredAt && source.id > conversationSummary.through.id);
        }) : recentMessages,
        // 他在群里说的那几句：单独一路，不并进 recentMessages（见上面 crossChannel 的注释）。
        ...(crossChannel.length ? { crossChannel: { label: "QQ 群", lines: crossChannel } } : {}),
        memories,
        snapshots,
        ...(privateKnowledgeItems.length ? { knowledgeItems: privateKnowledgeItems } : {}),
        ...(emojiFaces ? { emojiFaces } : {}),
        ...(stickerCatalog?.length ? { emojiStickers: stickerCatalog } : {}),
        // 告诉她「这一条会被念出来」：语气、长度、不要表情符号都靠这一段。
        ...(voicePlanned ? { voiceReply: true } : {}),
        // 画图能力：开关开着她就知道自己会画（被问「你会画图吗」不会否认）。
        // 真画的那一轮另传 imageReply，要求她把画面描述写进 imagePrompt。
        ...(imageSettings ? { imageEnabled: true } : {}),
        ...(ctx.imageCapable ? { imageExecution: { plannedThisTurn: imagePlanned,
          status: ctx.imageDecision.status, trigger: ctx.imageDecision.trigger, requested: ctx.imageDecision.requested,
          ...(ctx.imageDecision.blockedReason ? { blockedReason: ctx.imageDecision.blockedReason } : {}),
          ...(ctx.imageDecision.todayCount !== null ? { todayCount: ctx.imageDecision.todayCount } : {}), dailyLimit: ctx.imageDecision.limit,
          latestAssistant: recentStoredMessages.find(row => row.role === "ASSISTANT")
            ? readImageExecutionState(recentStoredMessages.find(row => row.role === "ASSISTANT")!.metadata) : "none" as const,
        } } : {}),
        ...(ctx.imageCapable ? { imageCapabilities: { generation: "text_to_image" as const, referenceInput: false as const, edit: false as const,
          selfInspection: ctx.visionAvailable ? "on_demand" as const : "disabled" as const,
          quotedImageInspection: ctx.visionAvailable,
        } } : {}),
        ...(ctx.generatedImageContext ? { generatedImageContext: ctx.generatedImageContext } : {}),
        allowStickerDescription: messages.some(message => isExplicitMediaQuestion(message.commandText ?? "", Boolean(message.images?.length || message.quotedMessage?.image || message.quotedMessage?.images?.length))),
        ...(imagePlanned ? { imageReply: true } : {}),
        ...(catchphrasePrompt.length ? { catchphrases: catchphrasePrompt } : {}),
  };
}

type ChannelTurnMemoryLoader = {
  loadMemoryCandidates: (
    searchQuery: string,
    lookupOptions?: { participantName?: string; deterministicTimeline: boolean },
  ) => Promise<Awaited<ReturnType<typeof buildMemoryAssistantCandidates>>>;
  /** 主人历史分页读到的覆盖范围；尾部 `saveOwnerHistoryContext` 要带着它续期。 */
  ownerHistoryCoverage: () => OwnerHistoryCoverage | undefined;
};

/**
 * 深度检索：记忆助手/只读工具要按任意查询词补查旧记忆时走这里。
 *
 * 与聊天前置阶段的检索不同，这里按主题词与时间范围**补查**，不再局限于最近 300 条。
 * 主人历史任务链优先：有授权与计划时只读那一页，并记下覆盖范围。
 *
 * 群聊的可见性过滤（被标为 AI / 禁止交流的人）在这里重复一遍：深度检索会跨会话取数，
 * 不能假设前置过滤已经覆盖到。认不出作者就不给，漏一条只是少个候选。
 */
function createChannelTurnMemoryLoader(input: {
  prisma: PrismaClient;
  characterId: string;
  platform: string;
  isGroup: boolean;
  groupOwnerQq?: string;
  currentMessage: string;
  chatTimeZone: string;
  readableScopeIds: string[];
  globalScopeId: string;
  isOwnerTurn: boolean;
  primaryIdentityScopeId: string | null;
  existingConversation: ChannelTurnConversation | null;
  messages: ChannelTurnMessage[];
  recentStoredMessages: ChannelTurnStoredMessage[];
  crossChannel: CrossChannelLine[];
  rawMessages: ChannelTurnRawMessage[];
  memoryCandidates: ChannelTurnRetrieval["memoryCandidates"];
  snapshotCandidates: ChannelTurnRetrieval["snapshotCandidates"];
  eventCandidates: ChannelTurnRetrieval["eventCandidates"];
  ownerHistoryAuth: OwnerHistoryAuthorization | null;
  ownerHistoryPlan: ReturnType<typeof planOwnerHistory> | null;
  ownerHistoryStored: Awaited<ReturnType<typeof loadOwnerHistoryContext>>;
}): ChannelTurnMemoryLoader {
  const { prisma, isGroup } = input;
  let ownerHistoryCoverage: OwnerHistoryCoverage | undefined;

  const loadMemoryCandidates = async (searchQuery: string, lookupOptions?: { participantName?: string; deterministicTimeline: boolean }) => {
        if (input.ownerHistoryAuth && input.ownerHistoryPlan) {
          if (!input.ownerHistoryStored) throw new Error("Owner history authorization or continuity unavailable");
          const participantIds = input.ownerHistoryPlan.participantName
            ? await resolveParticipantAccounts(prisma, input.ownerHistoryPlan.participantName, { characterId: input.characterId, platform: input.platform }) : [];
          const page = await loadOwnerHistoryPage(prisma, input.characterId, input.ownerHistoryPlan, participantIds);
          ownerHistoryCoverage = page.coverage;
          return page.sources;
        }
        // 人物名只从主人原始问题解析一次；不从记忆助手模板查询串反向解析。
        const searchParticipantName = lookupOptions?.participantName ?? parseEventParticipantQuery(input.currentMessage);
        const searchParticipantIds = searchParticipantName
          ? await resolveParticipantAccounts(prisma, searchParticipantName, { characterId: input.characterId, platform: input.platform })
          : [];
        const searchRange = parseEventTimeRange(searchQuery, new Date(), input.chatTimeZone);
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

        // 深度检索按主题和时间补查旧记忆，不再只局限于聊天前置阶段的 300 条记录。
        const [targetedMemories, targetedSnapshots, targetedEvents] = await Promise.all([
          searchTerms.length
            ? prisma.memoryItem.findMany({
                where: {
                  memoryScopeId: { in: input.readableScopeIds },
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
                  memoryScopeId: { in: input.readableScopeIds },
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
                  memoryScopeId: { in: input.readableScopeIds },
                  status: "ACTIVE",
                  ...(isGroup ? { conversationId: { in: input.existingConversation ? [input.existingConversation.id] : [] } } : {}),
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
                memoryScopeId: { in: input.readableScopeIds },
                status: "ACTIVE",
                ...(isGroup ? { conversationId: { in: input.existingConversation ? [input.existingConversation.id] : [] } } : {}),
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
        const assistantMemoryCandidates = uniqueById([...input.memoryCandidates, ...targetedMemories]);
        const assistantSnapshotCandidates = uniqueById([...input.snapshotCandidates, ...targetedSnapshots]);
        const assistantEventCandidates = uniqueById([...input.eventCandidates, ...targetedEvents, ...fallbackEvents]);

        // Do not mark the whole recent query as seen: the group composer keeps only six
        // recent rows and the analyzer may clip more. Only explicitly supplied evidence is excluded.
        const excludedHistoryIds = historyExcludedIds({
          groupChat: isGroup,
          recentIds: input.recentStoredMessages.map(item => item.id),
          suppliedIds: [...input.crossChannel.map(item => item.id), ...input.rawMessages.map(item => item.id)],
        });
        const historySelect = {
          id: true, conversationId: true, role: true, content: true, occurredAt: true, metadata: true,
          conversation: { select: { memoryScopeId: true } },
        } satisfies Prisma.MessageSelect;
        type HistoryRow = Prisma.MessageGetPayload<{ select: typeof historySelect }>;
        const filterHistory = async (rows: HistoryRow[]): Promise<HistoryRow[]> => {
          if (!isGroup || !rows.length) return rows;
          const uids = [...new Set(rows.filter(row => row.role === "USER")
            .map(row => readStoredAuthorOpenId(row.metadata)).filter(Boolean))];
          const identities = uids.length ? await prisma.externalIdentity.findMany({
            where: { platform: input.platform, platformUid: { in: uids } },
            select: { platformUid: true, kind: true, memoryScopes: {
              where: { characterId: input.characterId, scopeType: "EXTERNAL_IDENTITY" },
              take: 1, select: { friendChatPolicy: true },
            } },
          }) : [];
          const byUid = new Map(identities.map(identity => [identity.platformUid, identity]));
          return rows.filter(row => {
            if (row.role !== "USER") return true;
            const uid = readStoredAuthorOpenId(row.metadata);
            if (readStoredSpeaker(row.metadata).isOwner || (input.groupOwnerQq && uid === input.groupOwnerQq)) return true;
            const identity = byUid.get(uid);
            return !shouldBlockFriendSpeaker(identity?.kind ?? "UNKNOWN", identity?.memoryScopes[0]?.friendChatPolicy ?? "DEFAULT");
          });
        };
        const loadHistory = async (baseWhere: Prisma.MessageWhereInput): Promise<HistoryRow[]> => {
          const where: Prisma.MessageWhereInput = { AND: [baseWhere, {
            role: { in: ["USER", "ASSISTANT"] },
            id: { notIn: [...excludedHistoryIds] },
            OR: [
              { externalMessageId: null },
              { externalMessageId: { notIn: input.messages.map(message => message.externalMessageId) } },
            ],
          }] };
          const matched = await prisma.message.findMany({
            where: { AND: [where, ...(contentMatches.length ? [{ OR: contentMatches }] : [])] },
            orderBy: [{ occurredAt: rawMessageOrder }, { id: rawMessageOrder }],
            take: searchRange ? 500 : 350, select: historySelect,
          });
          return loadMessageHistoryCoverage({
            matched,
            window: input.recentStoredMessages.map(row => ({ ...row,
              conversationId: input.existingConversation?.id ?? "",
              conversation: { memoryScopeId: isGroup ? input.globalScopeId : "" },
            })).filter(row => isGroup && row.conversationId && !searchRange && !wantsFirst),
            excludeIds: excludedHistoryIds,
            filterVisible: filterHistory,
            oldestFirst: wantsFirst,
            fallbackLimit: searchRange ? 120 : 80,
            fetchPage: ({ excludeIds, cursor, take }) => prisma.message.findMany({
              where: { AND: [where, { id: { notIn: excludeIds } }, ...(cursor ? [historyCursorWhere(cursor, rawMessageOrder)] : [])] },
              orderBy: [{ occurredAt: rawMessageOrder }, { id: rawMessageOrder }], take, select: historySelect,
            }),
            fetchNeighbors: (anchor, direction) => {
              const order = direction === "before" ? "desc" as const : "asc" as const;
              return prisma.message.findMany({
                where: { AND: [where, { conversationId: anchor.conversationId,
                  occurredAt: { gte: new Date(anchor.occurredAt.getTime() - 120_000), lte: new Date(anchor.occurredAt.getTime() + 120_000) },
                }, historyCursorWhere(anchor, order)] },
                orderBy: [{ occurredAt: order }, { id: order }], take: 2, select: historySelect,
              });
            },
          });
        };
        // Every query, including neighboring rows, retains the authorized room/private predicate.
        const rawRowsByScope = isGroup
          ? (input.existingConversation ? [await loadHistory({ conversationId: input.existingConversation.id, ...rangeWhere })] : [])
          : await Promise.all(input.readableScopeIds.filter(scopeId => scopeId !== input.globalScopeId)
            .map(scopeId => loadHistory(buildPrivateScopeRawMessageWhere(scopeId, searchRange))));
        // 主人私聊可以回看角色全局范围中「指定熟人自己发过的群消息」：
        // 仅在明确识别到人物账号时启用，只取该人物的 USER 原文，不把整群聊天搬进私聊。
        // 普通好友私聊仍然只能检索当前用户自己的 private scope。
        const ownerTimelineScopeIds = resolveOwnerTimelineGroupScopeIds({
          isOwnerTurn: input.isOwnerTurn,
          globalScopeId: input.globalScopeId,
          // 旧群会话可能仍挂在主人自己的 EXTERNAL_IDENTITY；普通好友不会获得这个额外范围。
          ownerIdentityScopeId: input.primaryIdentityScopeId,
        });
        const ownerGroupRawRows = !isGroup && input.isOwnerTurn && searchParticipantIds.length
          ? await prisma.message.findMany({
              where: buildOwnerTimelineGroupRawMessageWhere({
                memoryScopeIds: ownerTimelineScopeIds,
                platform: input.platform,
                participantIds: searchParticipantIds,
                range: searchRange,
              }),
              orderBy: [{ occurredAt: rawMessageOrder }, { id: rawMessageOrder }],
              take: 500,
              select: {
                id: true, role: true, content: true, occurredAt: true, metadata: true,
                conversation: { select: { memoryScopeId: true } },
              },
            })
          : [];
        const ownerTimelineQuery = shouldUseOnlyTargetGroupRawRows({
          isGroup,
          isOwnerTurn: input.isOwnerTurn,
          participantName: searchParticipantName ?? null,
          wantsTimeline: wantsFirst || wantsLatest,
        });
        const rawRowsForAssistant = ownerTimelineQuery
          ? ownerGroupRawRows
          : [...rawRowsByScope.flat(), ...ownerGroupRawRows];
        const assistantRawMessages = rawRowsForAssistant.map((row) => {
          const speaker = readStoredSpeaker(row.metadata);
          return {
            id: row.id,
            ...( "conversationId" in row && typeof row.conversationId === "string" ? { conversationId: row.conversationId } : {}),
            role: row.role,
            content: row.role === "USER"
              ? formatMentionContent(row.content, readMessageMentions(row.metadata))
              : row.content,
            occurredAt: row.occurredAt,
            memoryScopeId: row.conversation.memoryScopeId,
            ...(speaker.speaker ? { speaker: speaker.speaker } : {}),
            ...(speaker.isOwner ? { isOwner: true } : {}),
          };
        });
        return buildMemoryAssistantCandidates({
          query: searchQuery,
          memories: assistantMemoryCandidates,
          snapshots: assistantSnapshotCandidates,
          events: assistantEventCandidates,
          rawMessages: assistantRawMessages,
          excludeRawMessageIds: excludedHistoryIds,
          scopeOf: (scopeId) => scopeId === input.globalScopeId ? "character" : "private",
          timeZone: input.chatTimeZone,
          ...(searchParticipantIds.length ? { participantIds: searchParticipantIds } : {}),
          allowPrivate: !isGroup,
        });
  };

  return { loadMemoryCandidates, ownerHistoryCoverage: () => ownerHistoryCoverage };
}

type ChannelTurnReplyToggles = {
  /** 仅当渠道能发语音、角色开关打开且 TTS 配置完整时非空。 */
  voiceSettings: VoiceTtsSettings | null;
  /** 生成**之前**定下的「这一轮说不说」，要进提示词。 */
  voicePlanned: boolean;
  /** 仅当渠道能发图、角色开关打开且生图配置完整时非空。 */
  imageSettings: ImageGenerationSettings | null;
  /** 生成**之前**定下的「这一轮画不画」，要进提示词。 */
  imagePlanned: boolean;
  /** 有人明确让她画（不是概率抽中的）。空画面描述时只有这一种情况才兜底。 */
  imageForced: boolean;
  confirmedImagePrompt: string | null;
  imageRequest: ImageRequestResolution;
  imageDecision: ImageReplyDecision;
  stickerCatalog: ReturnType<typeof pickStickerCatalog> | undefined;
  emojiFaces: ReadonlyArray<{ id: string; name: string }> | undefined;
  catchphrasePrompt: ReturnType<typeof toCatchphrasePromptEntries>;
  journalLine: Awaited<ReturnType<typeof readPreviousJournalLine>>;
  journalRecent: Awaited<ReturnType<typeof readRecentJournals>>;
};

/**
 * 今天（东八区日界）她画了几张。
 *
 * 为什么要回表数而不是看 `recentStoredMessages`：那只是最近 40 条窗口，
 * 热聊时半小时就能刷过去 —— 用它数会把已经画了 8 张算成 3 张，额度形同虚设。
 *
 * 计数判据是 `metadata.image.path` 以 `images/` 开头：那是 `generateImage` 落盘时
 * 写进去的相对路径，比「有这个键」更硬（不会把别的附带图片的 metadata 算进来）。
 * 查询失败按 0 处理 —— 额度是为了省钱，不该因为数不出来就让整轮聊天失败。
 */
async function countImagesToday(prisma: PrismaClient, characterId: string, now: Date = new Date()): Promise<number | null> {
  const start = new Date(`${usageDayKey(now)}T00:00:00+08:00`);
  try {
    return await prisma.message.count({
      where: {
        role: "ASSISTANT",
        occurredAt: { gte: start },
        conversation: { characterId },
        metadata: { path: ["image", "path"], string_starts_with: "images/" },
      },
    });
  } catch {
    return null;
  }
}

/**
 * 这一轮的表达开关：表情/贴图额度、语音、画图、梗语录、手账。
 *
 * 语音和画图都必须在**生成之前**决定 —— 关键是模型得知道自己在说话 / 在画图。
 * 生成后再判定的话，提示词里压根没提这件事，她会回「我只有打字和嘴硬」
 * 或者「我画不了图」：内容解释得通，但暴露了她根本不知道这一轮发生了什么。
 * 所以这里先定「这一轮说不说、画不画」，生成后只做复核（长度 / 画面描述）。
 *
 * 手账只在「她自己的对话」里注入：网页对话与主人私聊。群聊不传（手账是写给她自己的，
 * 群里复述就是泄露），对普通人的私聊也不传。
 */
async function decideChannelTurnReplyToggles(input: {
  prisma: PrismaClient;
  character: ChannelTurnCharacter;
  isGroup: boolean;
  messages: ChannelTurnMessage[];
  recentStoredMessages: ChannelTurnStoredMessage[];
  emojiHistory: Array<{ occurredAt: Date; metadata: Prisma.JsonValue }>;
  emojiFrequency: ReturnType<typeof resolveEmojiFrequency>;
  chatSettings: ReturnType<typeof resolveChatModelSettings>;
  apiKey: string;
  voiceApiKey: string;
  voiceCapable: boolean | undefined;
  imageApiKey: string;
  imageCapable: boolean | undefined;
  stickerCatalog: ReadonlyArray<StickerCatalogEntry> | undefined;
  faceCatalog: ReadonlyArray<{ id: string; name: string }> | undefined;
}): Promise<ChannelTurnReplyToggles> {
  const { prisma, character, isGroup } = input;
  // 表情要看三件事：渠道收不收（清单）、角色开没开开关、这个会话的额度用没用完。
  // 只看前两个的话，一个爱发表情的角色会在每句后面都挂一张。
  const lastAssistant = input.recentStoredMessages.find((item) => item.role === "ASSISTANT");
  const lastStickerId = lastAssistant ? readStoredStickerId(lastAssistant.metadata) : null;
  /**
   * 上一条语音是什么时候发的。语音冷却看它：连着两条都在「说话」像在读稿。
   * recentStoredMessages 是按时间倒序取的，所以第一条命中的就是最近一条。
   */
  const lastVoiceAt = input.recentStoredMessages.find(
    (item) => item.role === "ASSISTANT" && readStoredVoiceFlag(item.metadata),
  )?.occurredAt ?? null;

  // 判定只看开关、冷却、概率（用户明确要语音时跳过冷却与概率，但不跳过开关）。
  const voiceRequested = input.voiceCapable === true
    && input.messages.some((message) => isVoiceRequested(message.promptContent ?? message.content));
  const voiceSettings = input.voiceCapable === true
    ? resolveVoiceTtsSettings({
        modelConfig: character.modelConfig,
        chatModel: input.chatSettings.model,
        chatApiBaseUrl: input.chatSettings.apiBaseUrl,
        chatApiKey: input.apiKey,
        voiceApiKey: input.voiceApiKey,
      })
    : null;
  let voicePlanned = Boolean(voiceSettings) && planVoiceReply({
    modelConfig: character.modelConfig,
    lastVoiceAt,
    force: voiceRequested,
  });

  /**
   * 画图：和语音同构，也必须在**生成之前**定。
   *
   * 与语音互斥：一条语音再配一张图 = 同一句话用两种方式说。语音优先，
   * 因为「引用 + 语音」那条限制已经证明：多种表达叠在一条消息里，客户端只渲染一个。
   *
   * `force` 只认「有人真的让她画」（`isImageRequested`）；询问「你会画图吗」不算，
   * 那种情况她会答「会」，下一句才是下单。
   */
  const lastImageAt = input.recentStoredMessages.find(
    (item) => item.role === "ASSISTANT" && readStoredImageFlag(item.metadata),
  )?.occurredAt ?? null;
  const imageMessages = input.messages.map(message => ({ ...message, source: "current" as const,
    commandText: message.commandText ?? (message.images?.length || message.voices?.length ? "" : message.content),
    addressedToSelf: message.addressedToSelf === true, quotedToSelf: message.quotedToSelf === true || message.quotedMessage?.isSelf === true,
  }));
  const imageRequest = resolveImageRequest({ channel: isGroup ? "group" : "private", history: input.recentStoredMessages, current: imageMessages });
  if ((imageRequest.kind === "direct" || imageRequest.kind === "confirmation") && !voiceRequested) voicePlanned = false;
  const imageSettings = input.imageCapable === true && isImageGenerationEnabled(character.modelConfig)
    ? resolveImageGenerationSettings({ modelConfig: character.modelConfig, chatApiBaseUrl: input.chatSettings.apiBaseUrl, imageApiKey: input.imageApiKey }) : null;
  const imageDecision = planImageReplyDecision({ modelConfig: character.modelConfig,
    channelSupported: input.imageCapable === true, configured: Boolean(imageSettings), request: imageRequest,
    lastImageAt, todayCount: imageSettings ? await countImagesToday(prisma, character.id) : null, voicePlanned,
    allowAutonomous: isAutonomousImageEligible(imageMessages, isGroup ? "group" : "private"),
  });
  const imagePlanned = imageDecision.status === "approved";

  /**
   * 额度：「每 N 分钟最多 N 张」，按**这个会话**算（A 群贴过三张不该让 B 群闭嘴）。
   *
   * 只取窗口内的助手消息，不看全部：`recentStoredMessages` 只是最近对话窗口（默认 40 条），
   * 热聊时几十条可能还没覆盖十分钟，用它数会少算。
   */
  const emojiBudgetSpent = isEmojiBudgetSpent(input.emojiHistory, new Date(), input.emojiFrequency);
  // 表情包优先于内置表情：有素材库就只给素材库（并剔除上一张，避免她一直贴同一张）。
  // 这一条要走语音或要配一张生图时一律不给：同一句话用两种「图/声」表达等于说了两遍，
  // 而且一条消息里两个图片段在手机上会挤成一坨。
  const stickerCatalog = input.stickerCatalog?.length
    && isEmojiEnabled(character.modelConfig)
    && !emojiBudgetSpent
    && !voicePlanned
    && !imagePlanned
    ? pickStickerCatalog(input.stickerCatalog, lastStickerId)
    : undefined;
  const emojiFaces = !stickerCatalog?.length
    && input.faceCatalog?.length
    && isEmojiEnabled(character.modelConfig)
    && !emojiBudgetSpent
    && !voicePlanned
    && !imagePlanned
    ? input.faceCatalog
    : undefined;

  /**
   * 梗语录：和表情包不同，**不从调用方传**，流水线自己查。
   *
   * 表情包要按渠道能力决定（有的渠道发不了图），梗是纯文字、哪个渠道都能说；
   * 交给每个 adapter 各自去查，只会有一边忘了接。角色级的文字习惯应该在角色级生效。
   */
  const catchphrasePrompt = toCatchphrasePromptEntries(
    pickCatchphraseCatalog(await loadCatchphraseCatalog(character.id)),
  );

  // 判据用 `isGroup` 而不是 `input.group`：群元数据是可选的，群聊本身不是。
  const ownerTurn = !isGroup && input.messages[0]?.speaker?.isOwner === true;
  const journalLine = ownerTurn
    ? await readPreviousJournalLine(
        prisma,
        character.id,
        new Date(),
        resolveChatTimeZone(character.memorySetting?.timezone),
      )
    : null;
  /**
   * 同一扇门里的「她自己写过什么」：最近两天的日记正文 + 当天手账。
   * 一句是她带走的情绪，正文是「我前几天写过什么」——她要能聊起自己写的东西。
   * 截断在 `chat-reply` 的载荷里做。
   */
  const journalRecent = ownerTurn
    ? await readRecentJournals(prisma, { characterId: character.id, limit: 2 })
        .then((entries) => dropDuplicateJournalQuote(entries, journalLine))
        .catch(() => [])
    : [];

  return {
    voiceSettings,
    voicePlanned,
    imageSettings,
    imagePlanned,
    imageForced: imageDecision.requested,
    confirmedImagePrompt: imageRequest.kind === "confirmation" ? imageRequest.subject ?? null : null,
    imageRequest, imageDecision,
    stickerCatalog,
    emojiFaces,
    catchphrasePrompt,
    journalLine,
    journalRecent,
  };
}

type ChannelTurnGrowthPreparation = {
  selfUnderstanding: Awaited<ReturnType<typeof loadSelfUnderstanding>> | undefined;
  growthReads: Map<GrowthReadDiagnostic["domain"], GrowthReadDiagnostic>;
  goals: Awaited<ReturnType<typeof loadGoalsForPrompt>>;
  expressionHabits: Awaited<ReturnType<typeof loadExpressionHabitsForPrompt>>;
  preferences: Awaited<ReturnType<typeof loadPreferencesForPrompt>>;
  /** 私聊在这里建好；群聊要等工作上下文证据过滤后再建（见主干）。 */
  collaboration: ReturnType<typeof createAssistantTurnContext> | undefined;
  loadKnowledge: (searchQuery: string) => Promise<ConversationKnowledgeItem[]>;
  loadKnowledgeWithLexical: (query?: string) => Promise<ConversationKnowledgeItem[]>;
  ownerHistoryAuth: OwnerHistoryAuthorization | null;
  ownerHistoryStored: Awaited<ReturnType<typeof loadOwnerHistoryContext>>;
  ownerHistoryPlan: ReturnType<typeof planOwnerHistory> | null;
  ownerHistoryLookup: boolean;
  ownerHistoryHold: boolean;
  ownerHistoryNow: Date;
  privateKnowledgeItems: ConversationKnowledgeItem[];
};

/**
 * 增长域读取（目标/表达习惯/偏好/自我理解）+ 主人私聊历史任务链 + 私聊知识分析。
 *
 * 这一整块只做「读」与「候选登记」：知识候选落库单独兜一层，写库失败不阻断回复。
 * 授权边界：ownerHistoryAuth 只由已验证的主人轮次授予，绝不来自工具查询或落库 metadata。
 */
async function prepareChannelTurnGrowth(input: {
  prisma: PrismaClient;
  character: ChannelTurnCharacter;
  isGroup: boolean;
  platform: string;
  characterId: string;
  bindingId: string;
  externalConversationId: string;
  chatSettings: ReturnType<typeof resolveChatModelSettings>;
  apiKey: string;
  messages: ChannelTurnMessage[];
  currentMessage: string;
  recentMessages: ConversationContextMessage[];
  recentStoredMessages: ChannelTurnStoredMessage[];
  existingConversation: ChannelTurnConversation | null;
  isOwnerTurn: boolean;
  ownerPrivateScopeId: string | null;
  ownerPlatformUid: string;
  conversationScopeId: string;
  readableScopeIds: string[];
  chatTimeZone: string;
  turnId: string;
}): Promise<ChannelTurnGrowthPreparation> {
  const { prisma, character, isGroup, currentMessage, existingConversation } = input;

  const selfUnderstanding = wantsSelfUnderstanding(currentMessage, { groupChat: isGroup, previousMessage: input.recentStoredMessages[0] })
    ? await loadSelfUnderstanding(prisma, { characterId: character.id, readableScopeIds: input.readableScopeIds, conversationId: existingConversation?.id, groupChat: isGroup, profileOwner: input.isOwnerTurn, includeHistory: asksSelfUnderstandingHistory(currentMessage, !isGroup) }).catch(() => { console.warn("[self-understanding] channel evidence unavailable"); return undefined; })
    : undefined;
  const growthReads = new Map<GrowthReadDiagnostic["domain"], GrowthReadDiagnostic>();
  const observeGrowthRead = input.platform === "qq-onebot"
    ? (entry: GrowthReadDiagnostic) => { growthReads.set(entry.domain, entry); }
    : undefined;
  if (observeGrowthRead) observeGrowthRead(createGrowthReadDiagnostic("knowledge"));
  const goals = await loadGoalsForPrompt(prisma, character.id, currentMessage, observeGrowthRead).catch(() => []);
  const expressionHabits = await loadExpressionHabitsForPrompt(prisma, character.id, currentMessage, observeGrowthRead,
    !isGroup && existingConversation ? { conversationId: existingConversation.id, memoryScopeId: input.conversationScopeId } : undefined, isGroup ? "GROUP" : "PRIVATE").catch(() => []);
  const preferences = await loadPreferencesForPrompt(prisma, character.id, currentMessage, observeGrowthRead).catch(() => []);
  // Private context can be created before its dedicated knowledge analysis. The evidence
  // list is limited to this conversation's current and already-authorized recent messages.
  const collaboration = !isGroup && input.platform === "qq-onebot" && Boolean(existingConversation?.id || input.externalConversationId?.trim())
    ? createAssistantTurnContext({
        turnId: input.turnId,
        identity: { characterId: character.id, channel: "qq-private", channelBindingId: input.bindingId,
          conversationKey: existingConversation?.id ?? input.externalConversationId, readableScopeIds: input.readableScopeIds, allowPrivate: true },
        evidenceIds: [...new Set([
          ...input.messages.map(item => item.externalMessageId),
          ...input.recentMessages.map(item => item.id),
        ].filter((id): id is string => typeof id === "string" && Boolean(id)))],
      })
    : undefined;

  // Formal knowledge lookup is shared by group and private paths and is always character-scoped.
  const loadKnowledge = (searchQuery: string): Promise<ConversationKnowledgeItem[]> =>
    loadChatKnowledge(prisma, input.characterId, searchQuery, observeGrowthRead);

  /**
   * 词法兜底：不依赖分析器给的 `knowledgeQuery`，直接用这一轮原文再查一次。
   *
   * 为什么需要：分析器只在它认为「这是可复用的知识话题」时才给 query（提示词里明确排除了
   * 闲聊、个人经历和「可以直接回答」的问题），于是一条完全命中知识库的问题也可能一次都不查。
   * 词法匹配是确定性计算、不花 token，问什么就查什么，比让模型判断「要不要查」更稳。
   */
  const lexicalKnowledgeQuery = (): string => {
    const source = isGroup ? input.messages.slice(-3) : input.messages;
    return source.map(item => item.content).join("\n").replace(/\s+/g, " ").trim().slice(0, 240);
  };
  const loadKnowledgeWithLexical = async (query?: string): Promise<ConversationKnowledgeItem[]> => {
    const merged = new Map<string, ConversationKnowledgeItem>();
    for (const candidate of [query, lexicalKnowledgeQuery()]) {
      const trimmed = candidate?.trim();
      if (!trimmed) continue;
      for (const item of await loadKnowledge(trimmed).catch(() => [])) merged.set(item.id, item);
    }
    // 与分析器结果合并后仍守同一条上限：知识段是参考，不是把整库塞进提示词。
    return [...merged.values()].slice(0, 8);
  };

  // This capability is granted by the verified owner turn, never by a tool query or stored metadata.
  const ownerHistoryAuth: OwnerHistoryAuthorization | null = !isGroup && input.platform === "qq-onebot" && input.isOwnerTurn && input.ownerPrivateScopeId && existingConversation && input.ownerPlatformUid
    ? { characterId: input.characterId, bindingId: input.bindingId, privateScopeId: input.ownerPrivateScopeId,
        conversationId: existingConversation.id, ownerUid: input.ownerPlatformUid } : null;
  const ownerHistoryNow = new Date();
  const ownerHistoryStored = ownerHistoryAuth
    ? await loadOwnerHistoryContext(prisma, ownerHistoryAuth, ownerHistoryNow).catch(() => null) : null;
  const ownerJournalTurn = Boolean(ownerHistoryAuth && isOwnerJournalTurn(currentMessage,
    input.recentStoredMessages.filter(row => row.role === "USER").slice(0, 8).reverse().map(row => row.content)));
  let ownerHistoryPlan = ownerHistoryAuth && !ownerJournalTurn
    ? planOwnerHistory(currentMessage, ownerHistoryStored?.plan ?? null, ownerHistoryNow, input.chatTimeZone) : null;
  // Resolve a referential room only from the owner's own recent explicit room references,
  // then verify the room against this character's QQ group conversations.
  const bareHistoryRetry = /^(?:现在呢|还是呢|再看看|再试试)[？?。！!\s]*$/u.test(currentMessage);
  if (ownerHistoryAuth && !ownerJournalTurn && (!ownerHistoryPlan || !ownerHistoryPlan.groupId)
    && (bareHistoryRetry || /那个群|这个群/u.test(currentMessage))) {
    const roomCandidates = [...new Set(input.recentStoredMessages.filter(row => row.role === "USER"
      && row.occurredAt.getTime() >= ownerHistoryNow.getTime() - 2 * 3_600_000).flatMap(row => {
        const match = /(?:群(?:号)?\s*[:：]?\s*(\d{5,12})|(\d{5,12})\s*(?:这个群|那个群|群|那边|这边))/u.exec(row.content);
        return match?.slice(1).filter((value): value is string => Boolean(value)) ?? [];
      }))];
    if (roomCandidates.length) {
      const rooms = await prisma.conversation.findMany({ where: { characterId: input.characterId,
        externalConversationId: { in: roomCandidates.map(id => `g:${id}`) },
        channelBinding: { connection: { platform: "qq-onebot" } } },
        select: { externalConversationId: true }, take: 40 });
      const verified = new Set(rooms.map(room => room.externalConversationId));
      const groupId = roomCandidates.find(id => verified.has(`g:${id}`));
      if (groupId) {
        ownerHistoryPlan = ownerHistoryPlan
          ? { ...ownerHistoryPlan, groupId }
          // The live task expired or died with the adapter; a bare retry still deserves a real read.
          : planRestartedHistoryRetry(groupId, ownerHistoryNow, input.chatTimeZone);
      }
    }
  }
  let ownerHistoryLookup = Boolean(ownerHistoryPlan);
  let ownerHistoryAnalyzed = false;
  let ownerHistoryHold = ownerJournalTurn;
  const suppliedPendingGroup = Boolean(ownerHistoryStored?.plan && !ownerHistoryStored.plan.groupId
    && ownerHistoryPlan?.groupId && /^\d{5,12}$/u.test(currentMessage.trim()));
  const suppliedDateRetry = Boolean(ownerHistoryStored?.plan && ownerHistoryPlan && isOwnerHistoryDateRetry(currentMessage));
  if (suppliedPendingGroup || suppliedDateRetry) {
    // The owner supplied a missing group or a new date, not a new semantic request.
    ownerHistoryAnalyzed = true;
    skipAssistantTurnStage(collaboration, "context", "not_needed");
  } else if (ownerHistoryAuth && !ownerJournalTurn && (ownerHistoryStored?.plan || ownerHistoryPlan)) {
    const runtime = await resolveContextAssistantRuntime(character.modelConfig, input.chatSettings.apiBaseUrl);
    ownerHistoryAnalyzed = true;
    if (runtime) {
      let usage: import("../model-usage").ModelUsageTokens | undefined;
      try {
        const intent = await runAssistantTurnStage(collaboration, "context", "owner-history-intent",
          { message: currentMessage, previous: ownerHistoryStored?.plan?.query ?? "" },
          () => analyzeOwnerHistoryIntent(runtime, { message: currentMessage,
            recent: input.recentMessages.slice(-8).map(row => ({ role: row.role, content: row.content })),
            previous: ownerHistoryStored?.plan ?? null }, value => { usage = value; }));
        const decision = applyOwnerHistoryIntent(ownerHistoryStored?.plan ?? null, ownerHistoryPlan, intent, currentMessage);
        ownerHistoryPlan = decision.plan;
        ownerHistoryLookup = decision.lookup;
        ownerHistoryHold = intent.action === "hold";
        await recordModelUsage({ kind: "context-assistant", model: runtime.model, usage: toUsageTokens(usage),
          characterId: input.characterId, channelBindingId: input.bindingId,
          ...(existingConversation ? { conversationId: existingConversation.id } : {}),
          metadata: { status: "success", source: "owner-history-intent", turnId: input.turnId, action: intent.action } }).catch(() => undefined);
      } catch {
        ownerHistoryLookup = Boolean(ownerHistoryPlan);
        await recordModelUsage({ kind: "context-assistant", model: runtime.model, usage: toUsageTokens(usage),
          characterId: input.characterId, channelBindingId: input.bindingId,
          ...(existingConversation ? { conversationId: existingConversation.id } : {}),
          metadata: { status: "failed", source: "owner-history-intent", turnId: input.turnId } }).catch(() => undefined);
      }
    } else {
      ownerHistoryLookup = Boolean(ownerHistoryPlan);
      skipAssistantTurnStage(collaboration, "context", "not_enabled");
    }
  }

  // One private analyzer call can both request a knowledge lookup and nominate candidate evidence.
  // The local gate runs regardless of the auto-collect switch: retrieval must keep working when
  // capture is disabled. Only current-round original messages enter this private-only analysis.
  const modelConfigForKnowledge = character.modelConfig !== null && typeof character.modelConfig === "object" && !Array.isArray(character.modelConfig)
    ? character.modelConfig as Record<string, unknown> : {};
  // Reading approved knowledge is independent of the optional model analysis for
  // query rewriting/candidate capture. Natural questions must reach this reader
  // even when the cheap analyzer gate is false or its model is unavailable.
  let privateKnowledgeItems: ConversationKnowledgeItem[] = !isGroup
    ? await loadKnowledgeWithLexical().catch(() => []) : [];
  if (!isGroup) {
    const privateMessages = input.messages.map(item => ({
      id: item.externalMessageId,
      speaker: item.authorDisplayName ?? "",
      content: item.content,
    }));
    if (privateContextPurpose(ownerHistoryAnalyzed, shouldAnalyzePrivateKnowledge(privateMessages)) === "knowledge") {
      const privateContextRuntime = await resolveContextAssistantRuntime(character.modelConfig, input.chatSettings.apiBaseUrl);
      if (privateContextRuntime) {
        try {
          const result = await runAssistantTurnStage(collaboration, "context", "private-knowledge-analysis",
            { characterId: input.characterId, channelBindingId: input.bindingId, conversationKey: existingConversation?.id ?? input.externalConversationId,
              messageIds: privateMessages.map(item => item.id), runtimeModel: privateContextRuntime.model },
            observer => analyzePrivateKnowledgeCandidate(privateContextRuntime, character.name, privateMessages, observer));
          await recordModelUsage({
            kind: "context-assistant",
            model: privateContextRuntime.model,
            usage: toUsageTokens(result.usage),
            characterId: input.characterId,
            channelBindingId: input.bindingId,
            ...(existingConversation ? { conversationId: existingConversation.id } : {}),
            metadata: { status: "success", turnId: input.turnId, source: "private-knowledge-analysis" },
          }).catch(() => undefined);

          // Retrieval is independent of auto-collection: only confirmed ACTIVE items are searchable.
          if (result.knowledgeQuery && !privateKnowledgeItems.length) {
            privateKnowledgeItems = await runAssistantTurnStage(collaboration, "knowledge", result.knowledgeQuery,
              { characterId: input.characterId, readableScopeIds: input.readableScopeIds, query: result.knowledgeQuery },
              () => loadKnowledgeWithLexical(result.knowledgeQuery!), items => items.length === 0).catch(() => []);
          } else {
            // The unconditional local read above already handled the original question.
            skipAssistantTurnStage(collaboration, "knowledge", "not_needed");
          }

          const collectScope = readKnowledgeCollectScope(modelConfigForKnowledge);
          const wantCandidate = modelConfigForKnowledge.knowledgeAutoCollectEnabled === true && result.evidenceMessageIds.length > 0;
          // 第二道闸门只决定「收谁的」，不碰检索：上面的 knowledgeQuery 照常查。
          // 判不出来（没有外部身份范围）就不收 —— SELECTED 模式下宁可漏也不要噪音。
          const allowedSource = wantCandidate
            ? await isPrivateKnowledgeSource(prisma, {
                characterId: input.characterId,
                memoryScopeId: existingConversation?.memoryScopeId ?? input.conversationScopeId,
                isOwnerTurn: input.isOwnerTurn,
                scope: collectScope,
              }).catch(() => false)
            : false;
          if (allowedSource) {
            // 落库单独兜一层：写库失败不该被算成「模型调用失败」，也不能静默消失 ——
            // 否则线上只是「候选没出现」，没有任何痕迹可查。
            try {
              const selected = privateMessages.filter(item => result.evidenceMessageIds.includes(item.id));
              const rawContent = selected.map(item => `[${item.speaker || "好友"}] ${item.content.slice(0, 4_000)}`).join("\n").slice(0, 20_000);
              if (rawContent.trim()) {
                const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);
                const duplicate = await prisma.knowledgeCandidate.findFirst({
                  where: { characterId: input.characterId, sourceType: "CHAT", rawContent, createdAt: { gte: cutoff }, status: { not: "DISMISSED" } },
                  select: { id: true },
                });
                if (!duplicate) {
                  await prisma.knowledgeCandidate.create({
                    data: {
                      characterId: input.characterId,
                      sourceType: "CHAT",
                      rawContent,
                      sourceRef: {
                        ...(existingConversation ? { conversationId: existingConversation.id } : {}),
                        messageIds: selected.map(item => item.id),
                        speakers: [...new Set(selected.map(item => item.speaker).filter(Boolean))],
                        reason: result.reason,
                        capturedAt: new Date().toISOString(),
                        channel: "PRIVATE",
                      } satisfies Prisma.InputJsonObject,
                    },
                  });
                }
              }
            } catch (error) {
              console.warn(
                "[knowledge] 私聊知识候选写入失败（不影响本轮回复）：",
                error instanceof Error ? error.message : String(error),
              );
            }
          }
        } catch (error) {
          await recordModelUsage({
            kind: "context-assistant",
            model: privateContextRuntime.model,
            usage: toUsageTokens(error instanceof Error && "usage" in error ? (error as Error & { usage?: import("../model-usage").ModelUsageTokens }).usage : undefined),
            characterId: input.characterId,
            channelBindingId: input.bindingId,
            ...(existingConversation ? { conversationId: existingConversation.id } : {}),
            metadata: { status: "failed", turnId: input.turnId, source: "private-knowledge-analysis" },
          }).catch(() => undefined);
          skipAssistantTurnStage(collaboration, "knowledge", "not_needed");
        }
      } else {
        skipAssistantTurnStage(collaboration, "context", "not_enabled");
        skipAssistantTurnStage(collaboration, "knowledge", "not_needed");
      }
    } else {
      if (!ownerHistoryAnalyzed) skipAssistantTurnStage(collaboration, "context", "not_needed");
      skipAssistantTurnStage(collaboration, "knowledge", "not_needed");
    }
  }

  return {
    selfUnderstanding,
    growthReads,
    goals,
    expressionHabits,
    preferences,
    collaboration,
    loadKnowledge,
    loadKnowledgeWithLexical,
    ownerHistoryAuth,
    ownerHistoryStored,
    ownerHistoryPlan,
    ownerHistoryLookup,
    ownerHistoryHold,
    ownerHistoryNow,
    privateKnowledgeItems,
  };
}

type ChannelTurnRetrieval = {
  groupActivity: Awaited<ReturnType<typeof buildGroupActivityContext>> | null;
  journalFacts: Awaited<ReturnType<typeof loadJournalFacts>>;
  retrievalQuery: string;
  readableScopeIds: string[];
  ownerPlatformUid: string;
  crossChannel: CrossChannelLine[];
  participantName: ReturnType<typeof parseEventParticipantQuery>;
  participantIds: string[];
  memories: Awaited<ReturnType<typeof selectPromptMemoryContext>>["memories"];
  snapshots: Awaited<ReturnType<typeof selectPromptMemoryContext>>["snapshots"];
  events: Awaited<ReturnType<typeof selectPromptMemoryContext>>["events"];
  recentEvents: Awaited<ReturnType<typeof selectPromptMemoryContext>>["recentEvents"];
  eventSelection: Awaited<ReturnType<typeof selectPromptMemoryContext>>["eventSelection"];
  memorySelection: Awaited<ReturnType<typeof selectPromptMemoryContext>>["selection"];
  /** 未选择的原始候选：深度检索（loadMemoryCandidates）要在它们之上合并补查结果。 */
  memoryCandidates: Awaited<ReturnType<typeof loadPromptMemoryCandidates>>["memories"];
  snapshotCandidates: Awaited<ReturnType<typeof loadPromptMemoryCandidates>>["snapshots"];
  eventCandidates: Awaited<ReturnType<typeof loadPromptEventCandidates>>;
  /** 本轮说话人的身份与互动次数（群聊熟人卡用）。 */
  knownIdentities: Array<{
    platformUid: string;
    displayName: string | null;
    memoryScopes: Array<{ interactionCount: number; lastInteractedAt: Date | null }>;
  }> | null;
  acquaintanceRows: Awaited<ReturnType<typeof listAcquaintances>> | null;
};

/**
 * 记忆检索与装配：按需的问题背景（群活跃度、手账事实）、六类候选并行查询、
 * 跨窗口旁路，以及与网页共用的选择整形（`prompt-memory-selection.ts`）。
 * 差别只在 scope 标签怎么算：这里按「是不是角色全局范围」判断，网页按会话范围来源判断。
 */
async function retrieveChannelTurnContext(input: {
  prisma: PrismaClient;
  character: ChannelTurnCharacter;
  isGroup: boolean;
  platform: string;
  characterId: string;
  messages: ChannelTurnMessage[];
  currentMessage: string;
  recentMessages: ConversationContextMessage[];
  recentStoredMessages: ChannelTurnStoredMessage[];
  existingConversation: ChannelTurnConversation | null;
  isOwnerTurn: boolean;
  ownerPrivateScopeId: string | null;
  primaryIdentityScopeId: string | null;
  globalScopeId: string;
  group?: ChannelGroupTurnContext;
}): Promise<ChannelTurnRetrieval> {
  const { prisma, character, isGroup, currentMessage, existingConversation } = input;

  /**
   * 「这个群里谁跟我聊过」这类问题，名单由代码数出来。
   *
   * 只在群聊、且这一轮确实在问人时查：统计要扫一段消息，普通闲聊不该为它付代价。
   * 失败只少一段背景，不能拦住这轮回复。
   */
  const groupActivity = isGroup && existingConversation && input.group && isGroupActivityQuery(currentMessage)
    ? await buildGroupActivityContext({
        prisma,
        conversationId: existingConversation.id,
        characterId: input.characterId,
        platform: input.platform,
        query: currentMessage,
        timeZone: resolveChatTimeZone(character.memorySetting?.timezone),
        selfQq: input.group.selfQq,
        ownerQq: input.group.ownerQq,
        selfNames: input.group.selfNames?.length ? input.group.selfNames : [character.name],
      }).catch(() => null)
    : null;

  /**
   * 生日、名字、外观这类「关于她本人」的稳定事实，手账里才有。
   * 只在她确实被问到时查，且不查能力类（语音/看图）—— 那些看当前配置，别看旧手账。
   */
  const journalFacts = isSelfFactQuery(currentMessage)
    ? await loadJournalFacts(prisma, { characterId: character.id, query: currentMessage }).catch(() => [])
    : [];

  const retrievalQuery = [
    currentMessage,
    ...input.recentMessages.filter((item) => item.role === "USER").slice(-2).map((item) => item.content),
  ].join("\n");

  // Retrieval scope: character-global (shared persona) plus the author's own identity scope
  // (per-platform private memory). 群聊只用全局：一轮里好几个人，谁的私人记忆都不该端出来。
  // 主人私聊用 owner 的 USER_PRIVATE 范围，**同时带上主人自己 QQ 的旧身份范围**：
  // 会话在归位前可能还挂在 EXTERNAL_IDENTITY 上，旧记忆/忆泡写在那里，不带就永远读不到。
  // 两个范围都属于同一个主人，不涉及把别人的私人记忆端出来。
  const readableScopeIds = isGroup
    ? [input.globalScopeId]
    : (input.isOwnerTurn && input.ownerPrivateScopeId
      ? [input.globalScopeId, input.ownerPrivateScopeId, ...(input.primaryIdentityScopeId ? [input.primaryIdentityScopeId] : [])]
      : (input.primaryIdentityScopeId ? [input.globalScopeId, input.primaryIdentityScopeId] : [input.globalScopeId]));

  /**
   * 他在群里说过的话 —— 跨窗口旁路的取数。
   *
   * 为什么需要：群聊和私聊是两个 `Conversation`，`recentStoredMessages` 写死按当前
   * 会话 id 取。于是他在群里说的，私聊里她一句都接不到，只能回「这边真没接到」。
   * 记忆层那条路（忆泡/长期记忆）补的是「那几天」，这条补的是「刚才这两小时」。
   *
   * 三个限定，缺一条都不能上：
   * 1. **只在主人私聊时查**（`isOwnerTurn`）。群友不进这条路：他在群里说的话，
   *    别的群友的私聊里不该出现；主人自己本来就在那个群里，把他自己说过的话
   *    接回私聊不涉及第三人。
   * 2. 只查 `g:` 群会话，且只认 `authorOpenId` 等于他本人的那些行 —— 群里第三人
   *    说的话一个字都不带（这不是「群聊转播」，是「我刚才说的那句你听见没」）。
   * 3. 她的回应由纯函数按「紧跟在他后面」二次筛（`selectCrossChannelContext`），
   *    这里先把候选放宽拿全，别在 SQL 里写一半逻辑。
   */
  const ownerPlatformUid = input.isOwnerTurn
    ? (input.messages[0]!.authorPlatformUid || input.messages[0]!.authorOpenId || "").trim()
    : "";
  const crossChannelLookup = ownerPlatformUid
    ? prisma.message.findMany({
        where: {
          occurredAt: { gte: new Date(Date.now() - CROSS_CHANNEL_WINDOW_MINUTES * 60_000) },
          conversation: {
            characterId: input.characterId,
            externalConversationId: { startsWith: "g:" },
          },
          OR: [
            { metadata: { path: ["authorOpenId"], equals: ownerPlatformUid } },
            { role: "ASSISTANT" },
          ],
        },
        // 倒序取最近 200 条：热群两小时能滚过上千条，正序取会把「刚才」整段挤掉。
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: 200,
        select: {
          id: true, role: true, content: true, occurredAt: true, metadata: true,
          conversation: { select: { id: true, externalConversationId: true } },
        },
      })
    : Promise.resolve([]);

  // 熟人卡要用的说话人 id 也算在这里，好和记忆检索一起并行（P3）。
  const speakerUids = isGroup
    ? [...new Set(input.messages.map((message) => (message.authorPlatformUid || message.authorOpenId || "").trim()).filter(Boolean))]
    : [];
  const eventRetrievalNow = new Date();
  const participantName = parseEventParticipantQuery(retrievalQuery);
  const participantIds = participantName ? await resolveParticipantAccounts(prisma, participantName, { characterId: input.characterId, platform: input.platform }) : [];
  // 名字解析后，六类检索并行查；授权范围及群聊会话边界仍由本入口确定。
  const [{ memories: memoryCandidates, snapshots: snapshotCandidates }, eventCandidates, knownIdentities, acquaintanceRows, crossChannelRows] = await Promise.all([
    loadPromptMemoryCandidates(prisma, { readableScopeIds, query: retrievalQuery }),
    loadPromptEventCandidates(prisma, {
      readableScopeIds, query: retrievalQuery, participantIds, now: eventRetrievalNow,
      timeZone: resolveChatTimeZone(character.memorySetting?.timezone),
      // 群聊仍只取本群；会话尚不存在时返回空，不退回全局读取。
      groupConversationId: isGroup ? existingConversation?.id ?? null : undefined,
    }),
    speakerUids.length
      ? prisma.externalIdentity.findMany({
          where: { platform: input.platform, platformUid: { in: speakerUids } },
          select: {
            platformUid: true,
            displayName: true,
            memoryScopes: {
              where: { characterId: input.characterId },
              select: { interactionCount: true, lastInteractedAt: true },
            },
          },
        }).catch(() => null)
      : Promise.resolve(null),
    // 「我认识谁」，分三档：私聊的、跨群的、还有眼前这个屋里的。
    // 群聊传会话 id → 多一档 `inThisGroup`：她要靠它决定对谁热络、对谁客气；
    // 另外两档是背景，让她知道「我在别处也有一堆熟人」，别一进群就像个没朋友的。
    // 私聊会话这里没有 `inThisGroup`。
    listAcquaintances({
      characterId: input.characterId,
      limit: CLOSE_FRIEND_LIMIT,
      conversationId: isGroup ? existingConversation?.id ?? null : null,
    }).catch(() => null),
    // 跨窗口旁路失败只应该少一段背景，不能拦住这一轮回复。
    Promise.resolve(crossChannelLookup).catch(() => []),
  ]);
  /**
   * 跨窗口旁路：他在群里说的那几句 + 她当时的回应。
   *
   * 它是**另一个窗口**的记录，不是本窗口的历史 —— 所以单独一路传给提示词，
   * 绝不并进 `recentMessages`。并进去模型会以为自己刚在这个窗口里说过这些，
   * 下一句就可能接着「刚才」往下说，而这个「刚才」对方根本没听见。
   */
  const crossChannel: CrossChannelLine[] = selectCrossChannelContext(
    crossChannelRows.map((row): CrossChannelCandidate => ({
      id: row.id,
      role: row.role,
      content: row.content,
      occurredAt: row.occurredAt,
      conversationId: row.conversation.id,
      groupLabel: groupLabelFromConversationKey(row.conversation.externalConversationId ?? ""),
      authorOpenId: readStoredAuthorOpenId(row.metadata),
      authorDisplayName: readStoredSpeaker(row.metadata).speaker ?? "",
    })),
    { now: new Date(), ownerUid: ownerPlatformUid },
  ).lines;

  // 记忆、阶段总结、忆泡的选择与整形和网页共用一份（`prompt-memory-selection.ts`）。
  const {
    memories, snapshots, events, recentEvents, eventSelection, selection: memorySelection,
  } = await selectPromptMemoryContext({
    query: retrievalQuery,
    now: eventRetrievalNow,
    timeZone: resolveChatTimeZone(character.memorySetting?.timezone),
    memoryCandidates,
    snapshotCandidates,
    eventCandidates,
    participantIds,
    ...(isGroup && (character.modelConfig as Record<string, unknown> | null)?.personCueEnabled === true
      ? { personCue: { speakerIds: speakerUids, platform: input.platform } } : {}),
    limits: {
      memoryItems: resolveMemoryItemLimit(character.modelConfig),
      memoryTokens: resolveMemoryTokenBudget(character.modelConfig),
      snapshots: 4,
      snapshotTokens: resolveSnapshotTokenBudget(character.modelConfig),
      events: resolveEventItemLimit(character.modelConfig),
      eventTokens: resolveEventTokenBudget(character.modelConfig),
      recentEventDays: resolveEventRecentDays(character.modelConfig),
    },
    scopeOf: (memoryScopeId) => (memoryScopeId === input.globalScopeId ? "character" : "private"),
    loadParticipantNames: (items) => resolveEventParticipantNames(prisma, items),
  });

  return {
    groupActivity,
    journalFacts,
    retrievalQuery,
    readableScopeIds,
    ownerPlatformUid,
    crossChannel,
    participantName,
    participantIds,
    memories,
    snapshots,
    events,
    recentEvents,
    eventSelection,
    memorySelection,
    memoryCandidates,
    snapshotCandidates,
    eventCandidates,
    knownIdentities,
    acquaintanceRows,
  };
}

type ChannelTurnWindow = {
  contextRuntime: Awaited<ReturnType<typeof resolveContextAssistantRuntime>>;
  /** 最近窗口：按时间倒序，最新一条在 [0]。 */
  recentStoredMessages: ChannelTurnStoredMessage[];
  emojiHistory: Array<{ occurredAt: Date; metadata: Prisma.JsonValue }>;
  emojiFrequency: ReturnType<typeof resolveEmojiFrequency>;
  /** SQL-selection evidence only, not a claim about post-summary prompt usage. No text or ids. */
  privateHistorySelection?: { version: 1; userRows: number; assistantRows: number };
  /** 已按时间正序、过滤屏蔽与系统播报、整形为提示词载荷的最近消息。 */
  recentMessages: ConversationContextMessage[];
};

/**
 * 最近对话窗口 + 表情额度历史（同一个会话，一起查，省 RTT）。
 *
 * 窗口里被标为 AI / 禁止交流的对象、以及别的机器人的系统播报都不进提示词：
 * 旧消息仍保存在聊天记录里，只是不再占提示词位置。这里用**宽判据**
 * （`looksLikeSystemMessage`）：误判也只是这一行不进提示词，原文还在库里；
 * 写入侧用的是窄判据，两件事别搞反。
 */
async function loadChannelTurnWindow(input: {
  prisma: PrismaClient;
  character: ChannelTurnCharacter;
  isGroup: boolean;
  platform: string;
  characterId: string;
  messages: ChannelTurnMessage[];
  privateMessagesRecorded: boolean;
  existingConversation: ChannelTurnConversation | null;
  group?: ChannelGroupTurnContext;
  chatApiBaseUrl: string;
}): Promise<ChannelTurnWindow> {
  const { prisma, character, isGroup, existingConversation } = input;
  const emojiFrequency = resolveEmojiFrequency(character.modelConfig);
  const contextRuntime = isGroup ? await resolveContextAssistantRuntime(character.modelConfig, input.chatApiBaseUrl) : null;
  const [recentStoredMessages, emojiHistory] = await Promise.all([
    existingConversation
      ? prisma.message.findMany({
          where: {
            conversationId: existingConversation.id,
            // 私聊预落库之后，这条消息已经在库里了；它作为 currentMessage 单独进提示词，
            // 不能又出现在 recentMessages 里（模型会以为自己说过两遍）。
            ...(input.privateMessagesRecorded
              ? { OR: [
                  // Our own replies have no platform message id. SQL NULL NOT IN (...) is
                  // not true, so an unguarded NOT IN silently erased all assistant history.
                  { externalMessageId: null },
                  { externalMessageId: { notIn: input.messages.map((message) => message.externalMessageId) } },
                ] }
              : {}),
          },
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
          take: contextRuntime ? Math.max(120, resolveRecentMessageLimit(character.modelConfig)) : resolveRecentMessageLimit(character.modelConfig),
          select: channelTurnRecentMessageSelect,
        })
      : Promise.resolve([]),
    existingConversation
      ? prisma.message.findMany({
          where: {
            conversationId: existingConversation.id,
            role: "ASSISTANT",
            occurredAt: { gte: new Date(Date.now() - emojiFrequency.windowMinutes * 60_000) },
          },
          select: { occurredAt: true, metadata: true },
        })
      : Promise.resolve([]),
  ]);

  const privateHistorySelection = input.privateMessagesRecorded ? {
    version: 1 as const,
    userRows: recentStoredMessages.filter(row => row.role === "USER").length,
    assistantRows: recentStoredMessages.filter(row => row.role === "ASSISTANT").length,
  } : undefined;

  // 被标记为 AI / 禁止交流的对象，旧消息仍保存在聊天记录中，但不再进入后续群聊提示词。
  const blockedRecentMessageIds = new Set<string>();
  let blockedAtTargets = new Set<string>();
  if (isGroup && recentStoredMessages.length) {
    const historicalUids = [...new Set(
      recentStoredMessages
        .filter((item) => item.role === "USER" && !readStoredSpeaker(item.metadata).isOwner)
        .map((item) => readStoredAuthorOpenId(item.metadata))
        .filter(Boolean).concat(recentStoredMessages.map(item => readDeliveredAtTarget(item.metadata)).filter((uid): uid is string => Boolean(uid))),
    )];
    if (historicalUids.length) {
      const historicalIdentities = await prisma.externalIdentity.findMany({
        where: { platform: input.platform, platformUid: { in: historicalUids } },
        select: {
          platformUid: true,
          kind: true,
          memoryScopes: {
            where: { characterId: input.characterId, scopeType: "EXTERNAL_IDENTITY" },
            take: 1,
            select: { friendChatPolicy: true },
          },
        },
      }).catch(() => null);
      blockedAtTargets = blockedDeliveredAtTargets(recentStoredMessages.map(item => readDeliveredAtTarget(item.metadata)).filter((uid): uid is string => Boolean(uid)), historicalIdentities);
      const historicalPolicyByUid = new Map((historicalIdentities ?? []).map((identity) => [
        identity.platformUid,
        {
          kind: identity.kind,
          policy: identity.memoryScopes[0]?.friendChatPolicy ?? "DEFAULT",
        },
      ] as const));
      for (const [uid, identity] of historicalPolicyByUid) {
        if (shouldBlockFriendSpeaker(identity.kind, identity.policy)) blockedAtTargets.add(uid);
      }
      for (const item of recentStoredMessages) {
        if (item.role !== "USER") continue;
        const speaker = readStoredSpeaker(item.metadata);
        const uid = readStoredAuthorOpenId(item.metadata);
        if (speaker.isOwner || (input.group?.ownerQq && uid === input.group.ownerQq)) continue;
        const identity = historicalPolicyByUid.get(uid);
        if (shouldBlockFriendSpeaker(identity?.kind ?? "UNKNOWN", identity?.policy ?? "DEFAULT")) {
          blockedRecentMessageIds.add(item.id);
        }
      }
    }
  }

  const recentMessages: ConversationContextMessage[] = [...recentStoredMessages]
    .reverse()
    .filter((item) => item.role === "USER" || item.role === "ASSISTANT")
    .filter((item) => !blockedRecentMessageIds.has(item.id))
    .filter((item) => !(item.role === "USER" && looksLikeSystemMessage(item.content)))
    .map((item) => {
      // 历史 USER 行也可能 @ 了别人：只带 role/content 时，模型会把 `@数字`
      // 或 `@member_n` 当成在说它自己。正文按 mentions 代号化，目标信息一起带出去。
      const mentions = item.role === "USER"
        ? readMessageMentions(item.metadata)
        : isGroup ? readDeliveredAtMention(item.metadata, qq => blockedAtTargets.has(qq) ? null : input.group?.resolveMember?.(qq) ?? null) : [];
      return {
        id: item.externalMessageId || item.id,
        role: item.role as "USER" | "ASSISTANT",
        content: (item.role === "USER" && mentions.length
          ? formatMentionContent(item.content, readMessageMentions(item.metadata))
          : item.content).slice(0, 1800),
        occurredAt: item.occurredAt.toISOString(),
        // 只有她自己的话不需要发言人；USER 的话一律带上，否则群里几条历史分不清是谁说的。
        ...(item.role === "USER" ? readStoredSpeaker(item.metadata) : {}),
        ...(mentions.length
          ? { mentions: mentions.map(mention => ({ target: mention.target,
              ...(mention.member ? { member: mention.member } : {}),
              ...(mention.speaker ? { speaker: mention.speaker } : {}),
              ...(mention.kind ? { kind: mention.kind } : {}),
            })) }
          : {}),
        // 她自己发过图的回复：标出来，让她认得「那张图是我贴的」。
        ...(item.role === "ASSISTANT" && readStoredStickerFlag(item.metadata) ? { hadSticker: true } : {}),
        // 她自己发过语音的那条：同理，不带出去她就不知道自己刚才在「说话」。
        ...(item.role === "ASSISTANT" && readStoredVoiceFlag(item.metadata) ? { hadVoice: true } : {}),
        // 她自己画过图的那条：图只在 metadata 里，不标出来被问起会说「我没画过」。
        ...(item.role === "ASSISTANT" && readSentImageFlag(item.metadata) ? { hadImage: true } : {}),
        ...(item.role === "ASSISTANT" && readGeneratedImageFacts(item.metadata) ? { generatedImage: readGeneratedImageFacts(item.metadata)! } : {}),
      };
    });

  return {
    contextRuntime,
    recentStoredMessages,
    emojiHistory,
    emojiFrequency,
    ...(privateHistorySelection ? { privateHistorySelection } : {}),
    recentMessages,
  };
}

type ChannelTurnModelPreparation =
  | {
      ok: true;
      chatSettings: ReturnType<typeof resolveChatModelSettings>;
      apiKey: string;
      voiceApiKey: string;
      asrApiKey: string;
      /** 画图专用 Key：与看图分开，可能指向另一家服务商。 */
      imageApiKey: string;
      visionAvailable: boolean;
      generatedImageContext?: GeneratedImageFacts;
      /** 图/语音已转成文字、可以直接进提示词的消息。 */
      messages: ChannelTurnMessage[];
    }
  | { ok: false; result: ChannelMessageResult };

/**
 * 模型配置、日额度与图/语音预处理。
 *
 * 图先变成文字再进提示词（没开看图开关时什么都不做）；语音同理，先转写。
 * 预落库写的是原始正文（`[图片]` / `[语音]`），图/语音转成文字后要把落库那几行
 * 同步成同一份文字 —— 否则记录页看到的和忆泡读到的不一致。同步失败只记日志。
 */
async function prepareChannelTurnModel(input: {
  prisma: PrismaClient;
  character: ChannelTurnCharacter;
  isGroup: boolean;
  characterId: string;
  bindingId: string;
  platform: string;
  messages: ChannelTurnMessage[];
  privateMessagesRecorded: boolean;
  existingConversation: ChannelTurnConversation | null;
  externalConversationId: string;
}): Promise<ChannelTurnModelPreparation> {
  const { prisma, character } = input;
  let messages = input.messages;
  const chatSettings = resolveChatModelSettings(character.modelConfig);
  let apiKey = "";
  try {
    apiKey = await resolveCharacterApiKey(character.modelConfig, chatSettings.apiBaseUrl);
  } catch {
    return { ok: false, result: { status: "ignored", reason: "api_key_decrypt_failed" } };
  }
  if (!apiKey || !chatSettings.model) return { ok: false, result: { status: "ignored", reason: "model_not_configured" } };

  /**
   * 语音 Key 与聊天 Key 是**两把**：语音几乎总是另一家服务商
   * （DeepSeek / 通义这类纯文本服务商的 /audio/speech 直接 404），
   * 而它常常是页面上单独填的。解密失败按没配处理，不影响聊天。
   */
  const voiceApiKey = await resolveCharacterVoiceApiKey(character.modelConfig).catch(() => "");
  /** 识别专用 Key：合成与识别不是一家时（Breeze + MiniMax）必须分开，否则识别侧 401。 */
  const asrApiKey = await resolveCharacterAsrApiKey(character.modelConfig).catch(() => "");
  /** 画图专用 Key：看图那把可能在智谱，画图在 MiniMax，混用只会 401。 */
  const imageApiKey = await resolveCharacterImageApiKey(character.modelConfig).catch(() => "");

  // 额度用完就静默不回：渠道里抛错会把一条普通聊天变成失败事件，还会触发重试。
  const quota = await readDailyQuota(input.characterId, character.modelConfig);
  if (quota.exceeded) return { ok: false, result: { status: "ignored", reason: "daily_quota_exceeded" } };

  const visionSettings = await resolveVisionSettingsForCharacter({ modelConfig: character.modelConfig,
    chatModel: chatSettings.model, chatApiBaseUrl: chatSettings.apiBaseUrl, chatApiKey: apiKey });
  const mediaBudget = createMediaVisionBudget(MAX_IMAGES_PER_TURN);
  messages = await attachImageDescriptions(messages, {
    modelConfig: character.modelConfig, chatModel: chatSettings.model, apiBaseUrl: chatSettings.apiBaseUrl,
    apiKey, characterId: input.characterId, bindingId: input.bindingId,
  }, { resolveSettings: async () => visionSettings, describe: describeImages }, mediaBudget);
  const imageScope = { characterId: input.characterId, bindingId: input.bindingId, externalConversationId: input.externalConversationId };
  messages = await attachQuotedImageDescriptions(messages, { prisma, scope: imageScope, settings: visionSettings, budget: mediaBudget });
  const latestQuestion = messages.length === 1 && messages[0]!.kind !== "AI" && !messages[0]!.readOnly
    && !messages[0]!.images?.length && !messages[0]!.quotedMessage
    && (!input.isGroup || messages[0]!.addressedToSelf || messages[0]!.quotedToSelf)
    ? messages[0]!.commandText ?? "" : "";
  const generatedImageContext = await inspectLatestGeneratedImageForQuestion(latestQuestion,
    { prisma, scope: imageScope, settings: visionSettings, budget: mediaBudget });

  // 语音同理：先转写成文字再进提示词，没开「听懂语音」时原样保留 `[语音]`。
  messages = await attachVoiceTranscripts(messages, {
    modelConfig: character.modelConfig,
    chatModel: chatSettings.model,
    apiBaseUrl: chatSettings.apiBaseUrl,
    apiKey,
    voiceApiKey,
    asrApiKey,
  });

  if (input.privateMessagesRecorded && input.existingConversation) {
    for (const message of messages) {
      await prisma.message.updateMany({
        where: { conversationId: input.existingConversation.id, externalMessageId: message.externalMessageId },
        data: { content: message.content },
      }).catch(() => undefined);
      if (message.observedMedia?.length || message.quotedMessage) {
        try {
          const stored = await prisma.message.findFirst({
            where: { conversationId: input.existingConversation.id, externalMessageId: message.externalMessageId },
            select: { id: true, metadata: true },
          });
          if (stored) {
            const metadata = message.observedMedia?.length ? mergeStoredMediaMetadata(stored.metadata, message.observedMedia) : asRecord(stored.metadata);
            const quotedMessage = message.quotedMessage ? buildStoredMessageMetadata({ platform: input.platform, storedReason: "recorded", message }).quotedMessage : undefined;
            await prisma.message.updateMany({ where: { id: stored.id, conversationId: input.existingConversation.id },
              data: { metadata: { ...metadata, ...(quotedMessage ? { quotedMessage } : {}) } as Prisma.InputJsonObject } });
          }
        } catch {
          console.warn("[channel] media observation metadata could not be updated");
        }
      }
    }
  }

  // 「偷表情包」：群里的图值得收就存进她的表情库。只收群聊、不看她自己发的图，
  // 由开关 `modelConfig.stickerAutoCollect` 控制（默认关）。失败静默，不影响这轮回复。
  if (input.isGroup) {
    const collectCandidates = messages.flatMap((message) =>
      (message.images ?? []).filter((img) => img.url).map((img) => ({
        url: img.url,
        ...(img.summary ? { summary: img.summary } : {}),
      })),
    );
    if (collectCandidates.length) {
      await collectStickersFromTurn(collectCandidates, {
        characterId: input.characterId,
        ...(input.bindingId ? { bindingId: input.bindingId } : {}),
        modelConfig: character.modelConfig,
        chatModel: chatSettings.model,
        chatApiBaseUrl: chatSettings.apiBaseUrl,
        chatApiKey: apiKey,
      }).catch(() => undefined);
    }
  }

  return { ok: true, chatSettings, apiKey, voiceApiKey, asrApiKey, imageApiKey, messages, visionAvailable: Boolean(visionSettings),
    ...(generatedImageContext ? { generatedImageContext } : {}) };
}

type ChannelTurnPrivateContext = {
  /** 第一个说话人的外部身份范围；群聊恒为 null。 */
  primaryIdentityScopeId: string | null;
  isOwnerTurn: boolean;
  ownerPrivateScopeId: string | null;
  /** 本会话消息与这轮回复应该落入的记忆范围。 */
  conversationScopeId: string;
  /** 私聊已在模型调用前落库时置真，尾部事务不再重复写。 */
  privateMessagesRecorded: boolean;
  existingConversation: ChannelTurnConversation | null;
};

/**
 * 私聊的进门准备：记「她认识这个人」、解析主人专属私人范围、定下会话要落的范围，
 * 并把私聊消息**先落库**——模型没配 / Key 坏 / 额度用完时下面会 early return，
 * 但这句话已经留在记录里；私聊不进清理，所以它之后还能参与忆泡整理。
 *
 * 群聊不在这里记身份：谁在群里冒一句就建一条身份，一个活跃群几天就能攒出几百个
 * 没跟她说过话的「朋友」—— 那不是朋友，是群成员名单。群聊等她**真的回了谁**再记，
 * 见尾部回复发出的那段（`isGroup` 分支）。
 */
async function prepareChannelTurnPrivateContext(input: {
  prisma: PrismaClient;
  isGroup: boolean;
  characterId: string;
  characterOwnerId: string;
  platform: string;
  bindingId: string;
  externalConversationId: string;
  globalScopeId: string;
  messages: ChannelTurnMessage[];
  existingConversation: ChannelTurnConversation | null;
}): Promise<ChannelTurnPrivateContext> {
  const { prisma, isGroup } = input;
  let primaryIdentityScopeId: string | null = null;
  const identityScopeByAuthor = new Map<string, string | null>();
  if (!isGroup) {
    for (const message of input.messages) {
      const platformUid = (message.authorPlatformUid || message.authorOpenId || "").trim();
      if (!platformUid || identityScopeByAuthor.has(platformUid)) continue;
      const touch = await recordFriendInteraction({
        characterId: input.characterId,
        platform: input.platform,
        platformUid,
        displayName: message.authorDisplayName,
        source: "PRIVATE",
        at: message.occurredAt,
      }).catch(() => null);
      identityScopeByAuthor.set(platformUid, touch?.scopeId ?? null);
    }
  }
  {
    const first = input.messages[0]!;
    const firstUid = (first.authorPlatformUid || first.authorOpenId || "").trim();
    primaryIdentityScopeId = firstUid ? identityScopeByAuthor.get(firstUid) ?? null : null;
  }

  // 主人专属私人范围：说话人明确是主人（私聊里渠道传 isOwner）时，会话挂到角色主人的
  // USER_PRIVATE 范围，而不是该账号的外部身份范围。这样主人的私聊走「角色主人私人记忆」，
  // 由调度器单独排快照，且只在主人自己的对话里可读 —— 不会混进全局、也不会串给群友。
  const isOwnerTurn = !isGroup && input.messages[0]?.speaker?.isOwner === true;
  let ownerPrivateScopeId: string | null = null;
  if (isOwnerTurn) {
    ownerPrivateScopeId = await ensureOwnerPrivateScope(input.characterId, input.characterOwnerId);
  }

  const conversationScopeId = isGroup
    ? input.globalScopeId
    : (isOwnerTurn && ownerPrivateScopeId ? ownerPrivateScopeId : (primaryIdentityScopeId ?? input.globalScopeId));

  let privateMessagesRecorded = false;
  let existingConversation = input.existingConversation;
  if (!isGroup) {
    const repairScopeId = resolveOwnerPrivateScopeRepair({
      isOwnerTurn,
      ownerPrivateScopeId,
      currentScopeId: existingConversation?.memoryScopeId ?? conversationScopeId,
    });
    const title = existingConversation?.title
      || (input.messages[0]!.promptContent ?? input.messages[0]!.content).slice(0, 80);
    const recorded = await recordPrivateTurnMessages({
      prisma,
      characterId: input.characterId,
      bindingId: input.bindingId,
      platform: input.platform,
      externalConversationId: input.externalConversationId,
      conversation: existingConversation,
      messages: input.messages,
      targetScopeId: conversationScopeId,
      repairScopeId,
      title,
    });
    if (recorded) {
      existingConversation = recorded;
      privateMessagesRecorded = true;
    }
  }

  return {
    primaryIdentityScopeId,
    isOwnerTurn,
    ownerPrivateScopeId,
    conversationScopeId,
    privateMessagesRecorded,
    existingConversation,
  };
}

/**
 * The reusable channel event pipeline: idempotent ingest → character binding → character-global
 * memory retrieval → model reply → persistence → send back. This is platform-agnostic apart from
 * the QQ message-event type used for the conversation key.
 *
 * 群聊（`GROUP_MESSAGE`）只读角色全局记忆：一个群里说话的是不同的人，
 * 把某一个人的私人记忆端到另一个人面前，等于当面念别人的悄悄话。
 * 私聊仍然带上这个人的 identity scope。
 */
async function runChannelTurn(input: {
  platform: string;
  characterId: string;
  bindingId: string;
  eventType: string;
  externalConversationId: string;
  messages: ChannelTurnMessage[];
  /** 原始群成员观察。被身份策略过滤的内容不落库，只用于更新群成员名单。 */
  memberObservations?: ChannelTurnMessage[];
  faceCatalog?: ReadonlyArray<{ id: string; name: string }>;
  stickerCatalog?: ReadonlyArray<StickerCatalogEntry>;
  /** 允许模型说「这轮我不插嘴」。只有群聊批处理会传。 */
  allowSilent?: boolean;
  /** 群聊上下文；私聊不传。 */
  group?: ChannelGroupTurnContext;
  voiceCapable?: boolean;
  /** 见 `ChannelMessageInput.imageCapable`。 */
  imageCapable?: boolean;
  /** 见 `ChannelMessageInput.segmentCapable`。 */
  segmentCapable?: boolean;
  sendReply: ChannelReplySender;
}): Promise<ChannelMessageResult> {
  const prisma = getPrisma();
  const isGroup = input.eventType === "GROUP_MESSAGE";
  const prepared = await prepareChannelTurn(prisma, input);
  if (!prepared.ok) return prepared.result;
  let messages = prepared.messages;
  const character = prepared.character;
  const globalScope = prepared.globalScope;
  let existingConversation = prepared.existingConversation;

  const privateContext = await prepareChannelTurnPrivateContext({
    prisma,
    isGroup,
    characterId: input.characterId,
    characterOwnerId: character.ownerId,
    platform: input.platform,
    bindingId: input.bindingId,
    externalConversationId: input.externalConversationId,
    globalScopeId: globalScope.id,
    messages,
    existingConversation,
  });
  const primaryIdentityScopeId = privateContext.primaryIdentityScopeId;
  const isOwnerTurn = privateContext.isOwnerTurn;
  const ownerPrivateScopeId = privateContext.ownerPrivateScopeId;
  const conversationScopeId = privateContext.conversationScopeId;
  const privateMessagesRecorded = privateContext.privateMessagesRecorded;
  existingConversation = privateContext.existingConversation;

  const modelPrep = await prepareChannelTurnModel({
    prisma,
    character,
    isGroup,
    characterId: input.characterId,
    bindingId: input.bindingId,
    platform: input.platform,
    messages,
    privateMessagesRecorded,
    existingConversation,
    externalConversationId: input.externalConversationId,
  });
  if (!modelPrep.ok) return modelPrep.result;
  const chatSettings = modelPrep.chatSettings;
  const apiKey = modelPrep.apiKey;
  const voiceApiKey = modelPrep.voiceApiKey;
  const asrApiKey = modelPrep.asrApiKey;
  const imageApiKey = modelPrep.imageApiKey;
  const generatedImageContext = modelPrep.generatedImageContext;
  const visionAvailable = modelPrep.visionAvailable;
  messages = modelPrep.messages;

  // 最近对话窗口与表情额度历史都依赖同一个会话，一起查（P3）。emojiFrequency 提前到这里。
  const window = await loadChannelTurnWindow({
    prisma,
    character,
    isGroup,
    platform: input.platform,
    characterId: input.characterId,
    messages,
    privateMessagesRecorded,
    existingConversation,
    ...(input.group ? { group: input.group } : {}),
    chatApiBaseUrl: chatSettings.apiBaseUrl,
  });
  const contextRuntime = window.contextRuntime;
  const recentStoredMessages = window.recentStoredMessages;
  const emojiHistory = window.emojiHistory;
  const emojiFrequency = window.emojiFrequency;
  const privateHistorySelection = window.privateHistorySelection;
  const recentMessages = window.recentMessages;

  const toggles = await decideChannelTurnReplyToggles({
    prisma,
    character,
    isGroup,
    messages,
    recentStoredMessages,
    emojiHistory,
    emojiFrequency,
    chatSettings,
    apiKey,
    voiceApiKey,
    voiceCapable: input.voiceCapable,
    imageApiKey,
    imageCapable: input.imageCapable,
    stickerCatalog: input.stickerCatalog,
    faceCatalog: input.faceCatalog,
  });
  const voiceSettings = toggles.voiceSettings;
  const voicePlanned = toggles.voicePlanned;
  const imageSettings = toggles.imageSettings;
  const imagePlanned = toggles.imagePlanned;
  const imageForced = toggles.imageForced;
  const confirmedImagePrompt = toggles.confirmedImagePrompt;
  const imageRequest = toggles.imageRequest;
  const imageDecision = toggles.imageDecision;
  const stickerCatalog = toggles.stickerCatalog;
  const emojiFaces = toggles.emojiFaces;
  const catchphrasePrompt = toggles.catchphrasePrompt;
  const journalLine = toggles.journalLine;
  const journalRecent = toggles.journalRecent;

  /**
   * 别人的系统播报不进窗口（宽判据过滤在 loadChannelTurnWindow 里做）。
   */
  const modelText = (message: ChannelTurnMessage) => message.promptContent ?? message.content;
  const currentMessage = messages.length === 1
    ? modelText(messages[0]!)
    : messages.map((message) => `${message.authorDisplayName || "群友"}：${modelText(message)}`).join("\n");

  const retrieval = await retrieveChannelTurnContext({
    prisma,
    character,
    isGroup,
    platform: input.platform,
    characterId: input.characterId,
    messages,
    currentMessage,
    recentMessages,
    recentStoredMessages,
    existingConversation,
    isOwnerTurn,
    ownerPrivateScopeId,
    primaryIdentityScopeId,
    globalScopeId: globalScope.id,
    ...(input.group ? { group: input.group } : {}),
  });
  const groupActivity = retrieval.groupActivity;
  const journalFacts = retrieval.journalFacts;
  const retrievalQuery = retrieval.retrievalQuery;
  const readableScopeIds = retrieval.readableScopeIds;
  const ownerPlatformUid = retrieval.ownerPlatformUid;
  const crossChannel = retrieval.crossChannel;
  const participantName = retrieval.participantName;
  const participantIds = retrieval.participantIds;
  const memories = retrieval.memories;
  const snapshots = retrieval.snapshots;
  const events = retrieval.events;
  const recentEvents = retrieval.recentEvents;
  const eventSelection = retrieval.eventSelection;
  const memorySelection = retrieval.memorySelection;
  const memoryCandidates = retrieval.memoryCandidates;
  const snapshotCandidates = retrieval.snapshotCandidates;
  const eventCandidates = retrieval.eventCandidates;
  const knownIdentities = retrieval.knownIdentities;
  const acquaintanceRows = retrieval.acquaintanceRows;

  // 装配计划：只描述「这一轮打算放哪几类来源、各多少额度」，不驱动下面的查询。
  const questionKind: "date" | "topic" | "none" = eventSelection.range
    ? "date"
    : (participantIds.length || participantName ? "topic" : "none");
  const contextPlan = planContextTurn({
    surface: isGroup ? "group" : "private",
    isOwner: isOwnerTurn,
    questionKind,
    limits: {
      recentMessages: resolveRecentMessageLimit(character.modelConfig),
      memoryItems: resolveMemoryItemLimit(character.modelConfig),
      memoryTokens: resolveMemoryTokenBudget(character.modelConfig),
      snapshotItems: 4,
      snapshotTokens: resolveSnapshotTokenBudget(character.modelConfig),
      eventItems: resolveEventItemLimit(character.modelConfig),
      eventTokens: resolveEventTokenBudget(character.modelConfig),
      rawMessageItems: resolveRawMessageLimit(character.modelConfig),
      rawMessageTokens: resolveRawMessageTokenBudget(character.modelConfig),
    },
  });

  // 忆泡还没覆盖到那一段时用原文兜底；只在问句指向某一天时才查。
  const rawMessages = await loadChannelTurnRawMessages({
    prisma,
    character,
    isGroup,
    platform: input.platform,
    characterId: input.characterId,
    eventSelectionRange: eventSelection.range,
    readableScopeIds,
    retrievalQuery,
    recentStoredMessages,
    crossChannel,
    globalScopeId: globalScope.id,
    ...(input.group ? { group: input.group } : {}),
  });

  // 群聊一轮是「几个人在聊」，不是「某个人在对我说话」：交给 transcript。
  // 进了群聊管道就一律用群聊语境 —— 被 @ 时虽然不允许沉默，但同样需要上下文。
  const allowSilent = input.allowSilent === true && isGroup;
  const useTranscript = Boolean(input.group) || isGroup || messages.length > 1;

  // 群聊背景里可能混着已经落库的历史（recentMessages 里也有一份），按消息 id 去重，
  // 免得同一句在提示词里出现两遍。
  const storedMessageIds = new Set(
    recentStoredMessages
      .map((item) => item.externalMessageId)
      .filter((id): id is string => Boolean(id)),
  );
  const backgroundLines = (input.group?.background ?? []).filter((line) => !storedMessageIds.has(line.id));

  /**
   * 熟人卡：本轮说话的人里，之前跟她聊过不止一次的那些。
   *
   * 只取关系（次数 / 最近一次），**不碰任何消息内容** —— 这份东西要进群聊提示词，
   * 群里所有人都听得见，私人记忆不能端上来。同一个人本轮说两句只算一张卡。
   * 聊过一次的不算熟人：那是「见过」，给每个人都套熟人语气等于没区别。
   */
  let groupAcquaintances: Array<{ name: string; note: string }> | undefined;
  if (isGroup) {
    // speakerUids 与 knownIdentities 已和记忆检索一起并行查好（见上）。
    const cards = (knownIdentities ?? []).flatMap((identity) => {
      const relation = identity.memoryScopes[0];
      if (!relation || relation.interactionCount < 2) return [];
      const last = relation.lastInteractedAt;
      const when = last ? `${last.getMonth() + 1}-${last.getDate()}` : "";
      return [{
        name: identity.displayName?.trim() || identity.platformUid,
        note: `之前跟你聊过 ${relation.interactionCount} 次${when ? `，最近一次 ${when}` : ""}`,
      }];
    });
    if (cards.length) groupAcquaintances = cards;
  }

  /**
   * 熟人三档：私聊的、跨群的、这个屋里的。**主用途是群聊** —— 进一个群说话之前，
   * 先知道自己跟这屋里谁有交情，才谈得上对谁热络、对谁客气。
   *
   * 和熟人卡的分工：熟人卡只覆盖「本轮开口的那几个人」，用来定语气；
   * 熟人三档是「我认识的人」，用来判断谁在这屋里是老面孔。
   * 都只给关系元信息，不含聊过的内容 —— 群里一屋子人都听着，私事不能端上桌。
   *
   * 格式化（日期裁成 M-D、名字截断）在 `chat-reply` 里统一做，这里原样传过去。
   */
  const acquaintances = acquaintanceRows ?? null;
  const chatTimeZone = resolveChatTimeZone(character.memorySetting?.timezone);
  const memoryAssistant = await resolveMemoryAssistantRuntime(character.modelConfig, chatSettings.apiBaseUrl);

  const turnId = randomUUID();
  const growth = await prepareChannelTurnGrowth({
    prisma,
    character,
    isGroup,
    platform: input.platform,
    characterId: input.characterId,
    bindingId: input.bindingId,
    externalConversationId: input.externalConversationId,
    chatSettings,
    apiKey,
    messages,
    currentMessage,
    recentMessages,
    recentStoredMessages,
    existingConversation,
    isOwnerTurn,
    ownerPrivateScopeId,
    ownerPlatformUid,
    conversationScopeId,
    readableScopeIds,
    chatTimeZone,
    turnId,
  });
  const selfUnderstanding = growth.selfUnderstanding;
  const growthReads = growth.growthReads;
  const goals = growth.goals;
  const expressionHabits = growth.expressionHabits;
  const preferences = growth.preferences;
  let collaboration = growth.collaboration;
  const loadKnowledge = growth.loadKnowledge;
  const loadKnowledgeWithLexical = growth.loadKnowledgeWithLexical;
  const ownerHistoryAuth = growth.ownerHistoryAuth;
  const ownerHistoryStored = growth.ownerHistoryStored;
  const ownerHistoryPlan = growth.ownerHistoryPlan;
  const ownerHistoryLookup = growth.ownerHistoryLookup;
  const ownerHistoryHold = growth.ownerHistoryHold;
  const ownerHistoryNow = growth.ownerHistoryNow;
  const privateKnowledgeItems = growth.privateKnowledgeItems;

  const interactionGuidance = await readInteractionGuidance(prisma, { characterId: input.characterId, query: currentMessage, chatScene: isGroup ? "GROUP" : "PRIVATE" }).catch(() => []);
  const interactionExperiences = existingConversation ? await readInteractionExperiences(prisma, {
    characterId: input.characterId, conversationId: existingConversation.id, memoryScopeId: conversationScopeId, group: isGroup, query: currentMessage,
    recentQueries: isGroup ? [] : recentMessages.filter(row => row.role === "USER").slice(-4).map(row => row.content.slice(0, 500)),
  }).catch(() => { console.warn("[interaction-experience] read unavailable"); return []; }) : [];
  const conversationSummary = !isGroup && existingConversation ? await prepareConversationSummary(prisma, {
    characterId: input.characterId, conversationId: existingConversation.id, memoryScopeId: conversationScopeId,
    channelBindingId: input.bindingId, model: chatSettings.model, apiKey, apiBaseUrl: chatSettings.apiBaseUrl,
    excludeExternalMessageIds: messages.map(row => row.externalMessageId),
  }).catch(() => null) : null;
  const workingContext = contextRuntime && existingConversation
    ? await loadConversationWorkingContext(prisma, { conversationId: existingConversation.id, characterId: input.characterId }).catch(() => null)
    : null;
  let workingEvidence = workingContext?.evidence ?? [];
  let blockedWorkingAtTargets = new Set<string>();
  if (workingEvidence.length) {
    const uids = [...new Set(workingEvidence.flatMap(row => [row.role === "USER" ? readStoredAuthorOpenId(row.metadata) : "", readDeliveredAtTarget(row.metadata) ?? ""]).filter(Boolean))];
    const identities = uids.length ? await prisma.externalIdentity.findMany({
      where: { platform: input.platform, platformUid: { in: uids } },
      select: { platformUid: true, kind: true, memoryScopes: { where: { characterId: input.characterId }, select: { friendChatPolicy: true } } },
    }).catch(() => null) : [];
    blockedWorkingAtTargets = blockedDeliveredAtTargets(workingEvidence.map(row => readDeliveredAtTarget(row.metadata)).filter((uid): uid is string => Boolean(uid)), identities);
    const blocked = new Set((identities ?? []).filter(row => shouldBlockFriendSpeaker(row.kind, row.memoryScopes[0]?.friendChatPolicy ?? "DEFAULT")).map(row => row.platformUid));
    for (const uid of blocked) blockedWorkingAtTargets.add(uid);
    workingEvidence = workingEvidence.filter(row => row.role === "ASSISTANT" || readStoredSpeaker(row.metadata).isOwner || !blocked.has(readStoredAuthorOpenId(row.metadata)));
  }
  const previousWorkingContext = workingContext && workingEvidence.length ? {
    summary: workingEvidence.length === workingContext.evidence.length ? workingContext.summary : "",
    evidence: workingEvidence.map(row => ({
      id: row.id, role: row.role as "USER" | "ASSISTANT",
      // Historical member aliases are process-local. Use the source display name for mentions.
      content: formatMentionContent(row.content, readMessageMentions(row.metadata).map(mention => ({ ...mention, member: mention.speaker || "群成员" }))).replace(/@member_\d+/gu, "@群成员"),
      occurredAt: row.occurredAt.toISOString(),
      ...readStoredSpeaker(row.metadata),
      ...(row.role === "ASSISTANT" ? { mentions: readDeliveredAtMention(row.metadata, qq => blockedWorkingAtTargets.has(qq) ? null : input.group?.resolveMember?.(qq) ?? null) } : {}),
    })),
  } : undefined;
  // Group analysis needs its validated working-context evidence, so preserve its later
  // creation point while sharing the same request-local contract as private turns.
  if (isGroup && input.platform === "qq-onebot") {
    collaboration = createAssistantTurnContext({
      turnId,
      identity: { characterId: character.id, channel: "qq-group", channelBindingId: input.bindingId,
        conversationKey: input.externalConversationId, readableScopeIds, allowPrivate: false },
      evidenceIds: [...new Set([
        ...messages.map(item => item.externalMessageId),
        ...backgroundLines.map(item => item.id),
        ...(input.group?.analysisBackground ?? []).map(item => item.id),
        ...recentMessages.map(item => item.id),
        ...(previousWorkingContext?.evidence ?? []).map(item => item.id),
      ].filter((id): id is string => typeof id === "string" && Boolean(id)))],
    });
  }
  let pendingWorkingContext: { summary: string; evidenceMessageIds: string[] } | undefined;
  /**
   * 群聊候选证据是谁说的。
   *
   * 本轮消息直接在内存里认；证据里可能夹着更早的 background 行，那些只能回
   * `messages` 表按 externalMessageId 查。查不到就不算作者 —— SELECTED 模式下
   * 「认不出是谁」等于不收：漏一条只是少个候选，认错人会把别人的话记成知识。
   */
  const resolveGroupEvidenceAuthors = async (messageIds: string[]) => {
    const byId = new Map(messages.map(item => [item.externalMessageId, item]));
    const resolved: Array<{ platformUid: string; isOwner: boolean }> = [];
    const missing: string[] = [];
    for (const id of messageIds) {
      const hit = byId.get(id);
      if (hit) {
        resolved.push({ platformUid: (hit.authorPlatformUid || hit.authorOpenId || "").trim(), isOwner: hit.speaker?.isOwner === true });
        continue;
      }
      if (id) missing.push(id);
    }
    if (missing.length && existingConversation) {
      const rows = await prisma.message.findMany({
        where: { conversationId: existingConversation.id, externalMessageId: { in: missing } },
        select: { metadata: true },
      }).catch(() => []);
      for (const row of rows) {
        resolved.push({ platformUid: readStoredAuthorOpenId(row.metadata), isOwner: readStoredSpeaker(row.metadata).isOwner });
      }
    }
    return resolved;
  };
  const turnDetail = createModelTurnDetail(isGroup, messages.map(item => ({
    id: item.externalMessageId, member: item.member, speaker: item.authorDisplayName,
    content: item.promptContent ?? item.content, occurredAt: item.occurredAt?.toISOString(),
  })), collaboration && !isGroup ? "qq-private" : undefined);
  const memoryLoader = createChannelTurnMemoryLoader({
    prisma,
    characterId: input.characterId,
    platform: input.platform,
    isGroup,
    ...(input.group?.ownerQq ? { groupOwnerQq: input.group.ownerQq } : {}),
    currentMessage,
    chatTimeZone,
    readableScopeIds,
    globalScopeId: globalScope.id,
    isOwnerTurn,
    primaryIdentityScopeId,
    existingConversation,
    messages,
    recentStoredMessages,
    crossChannel,
    rawMessages,
    memoryCandidates,
    snapshotCandidates,
    eventCandidates,
    ownerHistoryAuth,
    ownerHistoryPlan,
    ownerHistoryStored,
  });
  const loadMemoryCandidates = memoryLoader.loadMemoryCandidates;

  const toolReads: Array<{ name: string; status: string; count: number }> = [];
  const observeToolRead = async (name: string, load: () => Promise<unknown[]>): Promise<unknown[]> => {
    try {
      const rows = await load();
      toolReads.push({ name, status: rows.length ? "success" : "no_sources", count: rows.length });
      return rows;
    } catch (error) { toolReads.push({ name, status: "failed", count: 0 }); throw error; }
  };
  const toolMemoryCache = new Map<string, Promise<unknown>>();
  const toolKnowledgeCache = new Map<string, Promise<unknown>>();
  const readOnlyTools = {
    searchMemory: (query: string): Promise<unknown> => {
      const key = query.trim().slice(0, 240);
      if (!toolMemoryCache.has(key)) toolMemoryCache.set(key, observeToolRead("search_memory", async () => projectToolMemories(await loadMemoryCandidates(key), isGroup)));
      return toolMemoryCache.get(key)!;
    },
    searchKnowledge: (query: string): Promise<unknown> => {
      const key = query.trim().slice(0, 240);
      if (!toolKnowledgeCache.has(key)) toolKnowledgeCache.set(key, observeToolRead("search_knowledge", async () => projectToolKnowledge(await loadKnowledge(key))));
      return toolKnowledgeCache.get(key)!;
    },
  };
  let generated: Awaited<ReturnType<typeof generateGroupContextReply>>;
  const observedReadOnlyAiEvidence = isGroup && (
    messages.some(row => Boolean(row.quotedMessage?.content) && conversationSourcePolicy(row.quotedMessage).excludeFromGrowth === true)
    || [...backgroundLines, ...(input.group?.analysisBackground ?? [])].some(row =>
      (Boolean(row.text) && conversationSourcePolicy(row).excludeFromGrowth === true)
      || (Boolean(row.quoted?.text) && conversationSourcePolicy(row.quoted).excludeFromGrowth === true))
  );
  const generationStartedAt = Date.now();
  try {
    generated = await generateGroupContextReply({
      ...(collaboration ? { turnContext: collaboration } : {}),
      assistant: memoryAssistant,
      onTurnDetail: turnDetail.update,
      contextAssistant: contextRuntime,
      previousWorkingContext,
      onWorkingContext: async value => { pendingWorkingContext = value; },
      analysisBackground: input.group?.analysisBackground?.map(line => ({
        id: line.id, member: line.member, speaker: line.speaker, content: line.text,
        ...conversationSourcePolicy(line),
        ...(line.mentions?.length ? { mentions: line.mentions } : {}),
        ...(line.quoted ? { quoted: { id: line.quoted.id, member: line.quoted.member,
          speaker: line.quoted.speaker, content: line.quoted.text, isSelf: line.quoted.isSelf,
          ...conversationSourcePolicy(line.quoted) } } : {}),
        occurredAt: new Date(line.at).toISOString(),
      })),
      loadKnowledge: loadKnowledgeWithLexical,
      onKnowledgeCandidate: async (candidate) => {
        const modelConfig = character.modelConfig !== null && typeof character.modelConfig === "object" && !Array.isArray(character.modelConfig)
          ? character.modelConfig as Record<string, unknown> : {};
        if (modelConfig.knowledgeAutoCollectEnabled !== true) return;
        // 「收谁的」：SELECTED 模式下，证据里得有被标成知识来源的人（或主人本人）说过话。
        // 判定用账号不用昵称；这里失败按「不收」处理，别让一次查询异常变成噪音入库。
        const allowedSource = await isGroupKnowledgeSource(prisma, {
          characterId: input.characterId,
          platform: input.platform,
          evidence: await resolveGroupEvidenceAuthors(candidate.sourceMessageIds),
          scope: readKnowledgeCollectScope(modelConfig),
        }).catch(() => false);
        if (!allowedSource) return;
        const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);
        const duplicate = await prisma.knowledgeCandidate.findFirst({
          where: { characterId: input.characterId, sourceType: "CHAT", rawContent: candidate.rawContent, createdAt: { gte: cutoff }, status: { not: "DISMISSED" } },
          select: { id: true },
        });
        if (duplicate) return;
        await prisma.knowledgeCandidate.create({
          data: {
            characterId: input.characterId,
            sourceType: "CHAT",
            rawContent: candidate.rawContent,
            sourceRef: {
              ...(existingConversation ? { conversationId: existingConversation.id } : {}),
              messageIds: candidate.sourceMessageIds,
              ...(candidate.speakers?.length ? { speakers: candidate.speakers } : {}),
              reason: candidate.reason,
              capturedAt: new Date().toISOString(),
              channel: "GROUP",
            } satisfies Prisma.InputJsonObject,
          },
        });
      },
      recordAssistantUsage: async (entry) => {
        await recordModelUsage({
          kind: entry.kind,
          model: entry.model,
          usage: toUsageTokens(entry.usage),
          characterId: input.characterId,
          channelBindingId: input.bindingId,
          ...(existingConversation ? { conversationId: existingConversation.id } : {}),
          metadata: { status: entry.status, turnId },
        });
      },
      candidates: [],
      ...(ownerHistoryHold ? { suppressHistoryLookup: true } : {}),
      ...(ownerHistoryPlan && ownerHistoryLookup ? { requiredHistoryLookup: { query: ownerHistoryPlan.query, mode: ownerHistoryPlan.mode, load: async () => {
        const sources = await loadMemoryCandidates(ownerHistoryPlan!.query);
        const coverage = memoryLoader.ownerHistoryCoverage();
        if (!coverage) throw new Error("History coverage unavailable");
        return { sources, coverage };
      } } } : {}),
      loadCandidates: loadMemoryCandidates,
      chatInput: buildChannelTurnChatInput({
        preferences,
        expressionHabits,
        goals,
        memories,
        snapshots,
        events,
        recentEvents,
        rawMessages,
        selfUnderstanding,
        journalLine,
        journalRecent,
        journalFacts,
        groupActivity,
        catchphrasePrompt,
        emojiFaces,
        stickerCatalog,
        interactionGuidance,
        interactionExperiences,
        conversationSummary,
        groupAcquaintances,
        acquaintances,
        privateKnowledgeItems,
        voiceSettings,
        voicePlanned,
        imageSettings,
        imageCapable: input.imageCapable,
        imageDecision,
        generatedImageContext,
        visionAvailable,
        imagePlanned,
        allowSilent,
        useTranscript,
        isGroup,
        character,
        chatSettings,
        apiKey,
        currentMessage,
        chatTimeZone,
        messages,
        backgroundLines,
        recentMessages,
        recentStoredMessages,
        crossChannel,
        readOnlyTools,
        ownerHistoryHold,
        turn: input,
      }),
    });
  } catch (error) {
      if (collaboration) turnDetail.update({ collaboration: collaboration.snapshot(), growthReads: [...growthReads.values()] });
    await recordModelUsage({
      kind: "channel", model: chatSettings.model, characterId: input.characterId,
      channelBindingId: input.bindingId,
      metadata: { status: "failed", reason: "model_generation_failed", durationMs: Date.now() - generationStartedAt, turnId, turnDetail: turnDetail.serialize(), ...(toolReads.length ? { toolReads: JSON.stringify(toolReads) } : {}) },
    });
    return { status: "ignored", reason: (error instanceof Error ? error.message : "model_error").slice(0, 200) };
  }

  let imageStatusOverride = false;
  const useImageStatusReply = (reply: string) => {
    generated.reply = reply;
    generated.responseExplanation = "按服务端画图执行记录反馈当前状态。";
    generated.faceIds = []; generated.stickerId = null;
    generated.imagePrompt = null; generated.imageOffer = null;
    generated.usedMemoryIds = []; generated.usedSnapshotIds = []; generated.usedEventIds = []; generated.usedRawMessageIds = [];
    generated.usedCatchphraseIds = []; generated.usedPreferenceIds = []; generated.usedExpressionHabitIds = []; generated.usedGoalIds = [];
    imageStatusOverride = true;
  };
  const enforcedImageReply = imageRequest.kind === "status" ? imageStatusReply(recentStoredMessages) : imageDecisionReply(imageDecision);
  if (enforcedImageReply && generated.action === "reply") useImageStatusReply(enforcedImageReply);

  if (collaboration) turnDetail.update({ collaboration: collaboration.snapshot(), growthReads: reconcileGrowthReadUsage([...growthReads.values()], {
    preferences: generated.usedPreferenceIds, language: generated.usedExpressionHabitIds, goals: generated.usedGoalIds,
  }, generated.action === "silent") });
  turnDetail.update({
    response: { action: generated.action, reply: generated.reply, explanation: generated.responseExplanation },
    // 与网页同一份口径：找到几条、放进去几条、预算挤掉几条，外加模型自报引用了几条。
    contextPlan: fillContextPlanUsage(contextPlan, {
      recentMessages: { used: estimateContextTokens(recentMessages.map((item) => item.content).join("\n")), items: recentMessages.length },
      memory: { used: memorySelection.memory.usedTokens, items: memorySelection.memory.count },
      snapshot: { used: memorySelection.snapshot.usedTokens, items: memorySelection.snapshot.count },
      event: { used: memorySelection.event.usedTokens, items: memorySelection.event.count + memorySelection.recentEvent.count },
      rawMessage: { used: estimateContextTokens(rawMessages.map((item) => item.content).join("\n")), items: rawMessages.length },
      crossChannel: { used: estimateContextTokens(crossChannel.map((line) => line.content).join("\n")), items: crossChannel.length },
    }),
    retrieval: {
      ...memorySelection,
      used: {
        memory: memories.filter((memory) => generated.usedMemoryIds.includes(memory.id)).length,
        snapshot: snapshots.filter((snapshot) => generated.usedSnapshotIds.includes(snapshot.id)).length,
        event: events.filter((event) => generated.usedEventIds.includes(event.id)).length,
      },
    },
  });
  const generationDurationMs = Date.now() - generationStartedAt;
  // 在落消息/发送前保存模型阶段结果，渠道发送失败也能从助手日志打开本轮详情。
  await recordModelUsage({
    kind: "channel", model: generated.localHistoryReceipt ? "local-history-lookup" : chatSettings.model, usage: toUsageTokens(generated.usage),
    characterId: input.characterId, channelBindingId: input.bindingId,
    ...(existingConversation ? { conversationId: existingConversation.id } : {}),
    metadata: { status: generated.localHistoryReceipt ? generated.memoryAssistantStatus ?? "failed" : "success",
      ...(generated.localHistoryReceipt ? { source: "local-history-receipt", supplierCalled: false } : {}),
      ...(generated.ownerHistoryCoverage ? { ownerHistoryCoverage: JSON.stringify(generated.ownerHistoryCoverage) } : {}),
      action: generated.action, durationMs: generationDurationMs, turnId, turnDetail: turnDetail.serialize(), ...(toolReads.length ? { toolReads: JSON.stringify(toolReads) } : {}) },
  });
  if (ownerHistoryAuth && (ownerHistoryStored || memoryLoader.ownerHistoryCoverage())) {
    const nextPlan = ownerHistoryPlan ? { ...ownerHistoryPlan,
      // A completed read starts a fresh TTL. A later short follow-up must not inherit an
      // expired task merely because nothing was re-saved after the original request.
      ...(memoryLoader.ownerHistoryCoverage() ? { anchoredAt: ownerHistoryNow.toISOString() } : {}),
      ...(generated.ownerHistoryCoverage ? { start: generated.ownerHistoryCoverage.start,
        end: generated.ownerHistoryCoverage.end, cursor: generated.ownerHistoryCoverage.oldestCursor } : {}),
      evidenceIds: generated.memoryAssistantStatus === "success"
        ? (generated.memoryAssistantSources ?? []).filter(source => source.sourceType === "message").map(source => source.id)
        : ownerHistoryPlan.evidenceIds } : null;
    await saveOwnerHistoryContext(prisma, ownerHistoryAuth, ownerHistoryStored?.historyContext ?? null, nextPlan)
      .then(saved => { if (!saved) console.warn("[owner-history] continuity save conflict; newer state preserved"); })
      .catch(() => { console.warn("[owner-history] continuity save unavailable"); });
  }
  const now = new Date();
  const assistantAt = new Date(now.getTime() + 1);
  const groupId = isGroup ? readGroupIdFromConversationKey(input.externalConversationId) : null;
  // 群会话标题用群号：原来的「第一条消息前 80 字」在记忆页翻记录时完全认不出是哪个群。
  const title = existingConversation?.title
    || (groupId ? `QQ群 ${groupId}` : currentMessage.slice(0, 80));
  const replyFaces = generated.action === "silent" ? [] : generated.faceIds;
  // 贴纸只认本次给的清单：模型返回了 id 但图不在清单里（比如刚被删掉），就当没选。
  const replySticker = generated.action === "silent" || !generated.stickerId
    ? null
    : input.stickerCatalog?.find((entry) => entry.id === generated.stickerId) ?? null;
  /**
   * 这一条真的用语音发吗。
   *
   * `voicePlanned` 是在生成之前定下的（模型据此按说话的方式写），这里只复核一次长度：
   * 说太长就该用文字，而不是截一段读 —— 截断的话术在语音条里听起来像被掐断。
   * 发不出去怎么办由渠道兜底（合成失败退回发文字，见 serve.ts）。
   */
  const replyVoice = generated.action === "reply"
    && voicePlanned
    && canSpeakReply(generated.reply);
  /**
   * 「决定了要发语音，结果发了文字」必须留痕。
   *
   * 这一层原本一行日志都没有，用户看到的只是「她又不说话」，而可能的原因有三个：
   * 没抽中/冷却（走不到这里）、太长降级（这里）、合成失败（serve.ts 有日志）。
   * 不记的话，事后只能靠猜 —— 分清这三件事是排查「语音发不出去」的第一步。
   */
  if (generated.action === "reply" && voicePlanned && !replyVoice) {
    console.log("[voice] 该发语音却降级成文字 " + JSON.stringify({
      chars: generated.reply.length,
      limit: VOICE_TEXT_MAX_CHARS,
      reason: "too_long",
    }));
  }
  /**
   * 这一轮到底画不画，以及画出来的那张图。
   *
   * 必须放在**落库之前**：图的路径要写进这条 ASSISTANT 的 `metadata.image`，
   * 下一轮 `recentMessages` 才能带 `hadImage`（不然她会说「我没画过图」）。
   *
   * 代价是这一轮要等生图：十几到几十秒。所以自主画图的概率默认只有 5，
   * 有人明确让她画时才无条件画 —— 那种时候等人本来就在等。
   *
   * 模型没给画面描述时：
   *   - 被明确要求 → 用她那句原话兜底（去掉「画一张」这类指令词），保证「要了就一定有」；
   *   - 自主抽中的 → 放弃。凭空拿一句「哈哈哈」去画，既浪费钱又不像她。
   */
  let replyImage: GeneratedImage | null = null;
  let imageGeneration: ImageGenerationRecord | undefined;
  let imageAttempt: ImageAttemptRecord | undefined = (imageDecision.status === "blocked" && imageDecision.requested) || imageRequest.kind === "declined"
    ? { status: "blocked", reason: imageDecision.blockedReason, trigger: imageDecision.trigger,
        sourceMessageId: imageRequest.sourceMessageId, authorOpenId: imageRequest.authorOpenId, todayCount: imageDecision.todayCount, limit: imageDecision.limit } : undefined;
  if (generated.action === "reply" && imagePlanned && imageSettings) {
    const source = confirmedImagePrompt ? "confirmed_offer" as const : generated.imagePrompt ? "model" as const : "request_subject" as const;
    const candidate = confirmedImagePrompt || generated.imagePrompt || imageRequest.subject || "";
    const validation = validateImageScenePrompt(candidate, { requestSubject: imageRequest.subject,
      participantNames: [...new Set([
        ...messages.map(message => message.authorDisplayName ?? ""),
        ...recentStoredMessages.map(row => { const name = asRecord(row.metadata).authorDisplayName; return typeof name === "string" ? name : ""; }),
        ...backgroundLines.map(line => line.speaker ?? ""),
      ].filter(Boolean))],
    });
    const trace = { trigger: imageDecision.trigger, sourceMessageId: imageRequest.sourceMessageId, authorOpenId: imageRequest.authorOpenId,
      promptSource: source, todayCount: imageDecision.todayCount, limit: imageDecision.limit };
    if (!validation.ok) {
      imageAttempt = { status: "blocked", reason: validation.reason, ...trace };
      if (imageDecision.requested) useImageStatusReply(blockedImageReply(validation.reason));
      console.warn("[image] generation blocked", { reason: validation.reason, trigger: imageDecision.trigger });
    } else {
      // Only the explicitly published snapshot may influence drawing. Never read editable profile
      // fields or drafts here: a half-finished edit must not silently change her official appearance.
      let officialVisualPrompt = "";
      try {
        const visualProfile = await prisma.characterVisualProfile.findUnique({
          where: { characterId: input.characterId },
          select: { currentPublishedRevision: true },
        });
        if (visualProfile && visualProfile.currentPublishedRevision > 0) {
          const published = await prisma.characterVisualVersion.findFirst({
            where: { profile: { characterId: input.characterId }, revision: visualProfile.currentPublishedRevision, status: "PUBLISHED" },
            select: { snapshot: true },
          });
          const snapshot = published?.snapshot && typeof published.snapshot === "object" && !Array.isArray(published.snapshot)
            ? published.snapshot as Record<string, unknown> : null;
          if (snapshot) {
            const parts = [
              typeof snapshot.coreAppearance === "string" ? snapshot.coreAppearance.trim() : "",
              typeof snapshot.corePrompt === "string" ? snapshot.corePrompt.trim() : "",
            ];
            if (Array.isArray(snapshot.outfits)) {
              const defaultOutfit = snapshot.outfits.find((item) => item && typeof item === "object" && !Array.isArray(item)
                && (item as Record<string, unknown>).isDefault === true) as Record<string, unknown> | undefined;
              if (typeof defaultOutfit?.prompt === "string" && defaultOutfit.prompt.trim()) parts.push(defaultOutfit.prompt.trim());
            }
            if (typeof snapshot.negativePrompt === "string" && snapshot.negativePrompt.trim()) {
              parts.push(`避免：${snapshot.negativePrompt.trim()}`);
            }
            officialVisualPrompt = parts.filter(Boolean).join("；");
          }
        }
      } catch (error) {
        // Profile lookup is optional and must never break an otherwise valid image request.
        console.warn("[image] published visual profile unavailable", error instanceof Error ? error.message : String(error));
      }
      const prompt = sanitizeImagePrompt([officialVisualPrompt, validation.prompt].filter(Boolean).join("；"));
      const result = await generateImage({ settings: imageSettings, prompt, characterId: input.characterId });
      if (result.ok) {
        replyImage = result.image;
        imageAttempt = { status: "generated", ...trace };
        imageGeneration = { prompt, model: imageSettings.model, provider: imageSettings.provider, generatedAt: new Date().toISOString(), mode: "text_to_image" };
      } else {
        imageAttempt = { status: "generation_failed", reason: "generation_failed", ...trace };
        if (imageDecision.requested) useImageStatusReply(blockedImageReply("generation_failed"));
        console.warn("[image] generation failed", { reason: "generation_failed", trigger: imageDecision.trigger });
      }
    }
  }

  /**
   * 分条发送：只有渠道声明了能拆、且这一轮不走语音时才拆。
   *
   * 语音轮次不拆是硬限制（见上面 `quoteTarget` 那段）：一条语音就是一条消息，
   * 拆开得合成两遍、发两条语音，那已经不是「一句一句说」而是两条语音条了。
   * 拆完 `length <= 1` 一律当单条处理 —— 没换行的回复行为一个字节都不变。
   */
  const replySegments = replyVoice || !input.segmentCapable
    ? []
    : splitReplySegments(generated.reply);
  turnDetail.update({ response: { action: generated.action, reply: generated.reply, explanation: generated.responseExplanation } });
  const { conversationId, assistantMessageId } = await persistChannelTurnResult({
    prisma,
    existingConversation,
    isGroup,
    globalScope,
    ownerPrivateScopeId,
    isOwnerTurn,
    turn: input,
    conversationScopeId,
    groupId,
    title,
    messages,
    privateMessagesRecorded,
    now,
    assistantAt,
    generated,
    observedReadOnlyAiEvidence,
    privateHistorySelection,
    selfUnderstanding,
    replyFaces,
    replySticker,
    replyVoice,
    replyImage,
    imageAttempt,
    imageGeneration,
    imageStatusOverride,
    ...(!imagePlanned && !imageForced && imageSettings && messages.length === 1 && generated.imageOffer
      && imageRequest.kind !== "status" && imageRequest.kind !== "declined"
      ? { imageOffer: { prompt: generated.imageOffer, authorOpenId: messages[0]!.authorOpenId } } : {}),
    replySegments,
    goals,
    expressionHabits,
    preferences,
  });

  await saveChannelTurnWorkingContext({
    prisma,
    conversationId,
    characterId: input.characterId,
    messages,
    workingContext,
    pendingWorkingContext,
    contextRuntime,
    isGroup,
  });



  let recordedDelivery = "";
  const recordDelivery = async (delivery: ChannelReplyDelivery) => {
    if (!assistantMessageId || (!delivery.at && !delivery.image)) return;
    const encoded = JSON.stringify(delivery);
    if (encoded === recordedDelivery) return;
    try {
      const row = await prisma.message.findUnique({ where: { id: assistantMessageId }, select: { metadata: true } });
      if (!row) return;
      const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata : {};
      await prisma.message.update({ where: { id: assistantMessageId }, data: { metadata: {
        ...metadata, replyDelivery: JSON.parse(encoded) as Prisma.InputJsonValue,
      } } });
      recordedDelivery = encoded;
    } catch {
      // Delivery has already happened; persistence failure must never trigger a resend.
      console.warn("[channel] reply delivery metadata could not be saved", { assistantMessageId });
    }
  };

  try {
    const rows = await prisma.modelUsage.findMany({ where: { characterId: input.characterId, kind: "channel",
      metadata: { path: ["turnId"], equals: turnId } }, select: { id: true, metadata: true }, take: 2 });
    for (const row of rows) await prisma.modelUsage.updateMany({ where: { id: row.id, characterId: input.characterId },
      data: { metadata: { ...asRecord(row.metadata), turnDetail: turnDetail.serialize(), imageDecision: {
        status: imageDecision.status, trigger: imageDecision.trigger, requested: imageDecision.requested,
        ...(imageDecision.blockedReason ? { blockedReason: imageDecision.blockedReason } : {}),
        ...(imageDecision.todayCount !== null ? { todayCount: imageDecision.todayCount } : {}), dailyLimit: imageDecision.limit,
      }, ...(imageAttempt ? { imageOutcome: { status: imageAttempt.status, ...(imageAttempt.reason ? { reason: imageAttempt.reason } : {}),
        ...(imageAttempt.promptSource ? { promptSource: imageAttempt.promptSource } : {}) } } : {}) } as Prisma.InputJsonObject } });
  } catch { console.warn("[channel] final delivery diagnostics could not be updated"); }

  await deliverChannelTurnReply({
    prisma,
    character,
    platform: input.platform,
    characterId: input.characterId,
    sendReply: input.sendReply,
    isGroup,
    messages,
    generated,
    replyFaces,
    replySticker,
    replyVoice,
    replyImage,
    replySegments,
    voiceSettings,
    recordDelivery,
  });


  await recordChannelTurnTailUsage({
    prisma,
    characterId: input.characterId,
    bindingId: input.bindingId,
    conversationId,
    turnId,
    generated,
    turnDetail,
  });
  const decision = generated.groupDecision ? { groupDecision: generated.groupDecision } : {};
  return generated.action === "silent"
    ? { status: "silent", conversationId, ...decision }
    : { status: "replied", conversationId, ...decision };
}

/** 单条路径的结果：不传 allowSilent，所以永远不会是 silent。 */
export type ChannelSingleMessageResult =
  | { status: "replied"; conversationId: string }
  | { status: "duplicate" }
  | { status: "ignored"; reason: string };

/** 单条消息（私聊、以及群聊里 @ 她的那一条）。行为与此前一致。 */
export async function handleChannelMessage(input: ChannelMessageInput): Promise<ChannelSingleMessageResult> {
  const result = await runChannelTurn({
    platform: input.platform,
    characterId: input.characterId,
    bindingId: input.bindingId,
    eventType: input.eventType,
    externalConversationId: input.externalConversationId,
    messages: [{
      externalMessageId: input.externalMessageId,
      authorOpenId: input.authorOpenId,
      ...(input.authorPlatformUid ? { authorPlatformUid: input.authorPlatformUid } : {}),
      ...(input.authorDisplayName ? { authorDisplayName: input.authorDisplayName } : {}),
      content: input.content,
      ...(input.quotedMessage ? { quotedMessage: input.quotedMessage } : {}),
      ...conversationSourcePolicy(input),
      ...(input.images?.length ? { images: input.images } : {}),
      ...(input.commandText !== undefined ? { commandText: input.commandText } : {}),
      ...(input.addressedToSelf !== undefined ? { addressedToSelf: input.addressedToSelf } : {}),
      ...(input.quotedToSelf !== undefined ? { quotedToSelf: input.quotedToSelf } : {}),
      ...(input.readOnly !== undefined ? { readOnly: input.readOnly } : {}),
      ...(input.imageTextParts ? { imageTextParts: input.imageTextParts } : {}),
      ...(input.promptImageTextParts ? { promptImageTextParts: input.promptImageTextParts } : {}),
      ...(input.observedMedia?.length ? { observedMedia: input.observedMedia } : {}),
      ...(input.voices?.length ? { voices: input.voices } : {}),
      ...(input.speaker ? { speaker: input.speaker } : {}),
    }],
    ...(input.faceCatalog ? { faceCatalog: input.faceCatalog } : {}),
    ...(input.stickerCatalog?.length ? { stickerCatalog: input.stickerCatalog } : {}),
    ...(input.voiceCapable ? { voiceCapable: true } : {}),
    ...(input.imageCapable ? { imageCapable: true } : {}),
    ...(input.segmentCapable ? { segmentCapable: true } : {}),
    sendReply: input.sendReply,
  });
  // 单条路径不该出现 silent；真出现了就当作没说，别让调用方去处理一个它不可能遇到的状态。
  return result.status === "silent" ? { status: "ignored", reason: "silent" } : result;
}

/** 群聊一轮：几条消息一起看，模型可以决定不说（silent）。 */
export async function handleChannelBatch(input: ChannelBatchInput): Promise<ChannelMessageResult> {
  return runChannelTurn({
    platform: input.platform,
    characterId: input.characterId,
    bindingId: input.bindingId,
    eventType: input.eventType,
    externalConversationId: input.externalConversationId,
    messages: input.messages,
    ...(input.memberObservations ? { memberObservations: input.memberObservations } : {}),
    ...(input.faceCatalog ? { faceCatalog: input.faceCatalog } : {}),
    ...(input.stickerCatalog?.length ? { stickerCatalog: input.stickerCatalog } : {}),
    ...(input.group ? { group: input.group } : {}),
    ...(input.voiceCapable ? { voiceCapable: true } : {}),
    ...(input.imageCapable ? { imageCapable: true } : {}),
    ...(input.segmentCapable ? { segmentCapable: true } : {}),
    allowSilent: input.allowSilent !== false,
    sendReply: input.sendReply,
  });
}
