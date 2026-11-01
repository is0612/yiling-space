import type { Prisma, PrismaClient } from "../../../src/generated/prisma/client";
import { generateConversationReply, type ConversationContextMessage, type ConversationGroupDecision } from "../chat-reply";
import { resolveChatTimeZone } from "../chat-time-context";
import { resolveEventItemLimit, resolveEventTokenBudget, selectEventsForPrompt } from "../memory-event-retrieval";
import { moveConversationEventsToScope } from "../memory-event-move";
import { resolveRawMessageLimit, resolveRawMessageTokenBudget, selectRawMessagesForPrompt } from "../message-retrieval";
import { isEmojiEnabled, resolveChatModelSettings } from "../chat-model-config";
import { resolveCharacterApiKey, resolveCharacterVoiceApiKey } from "../credential-encryption";
import {
  rankMemoriesWithBudget, rankSnapshotsWithBudget,
  resolveMemoryItemLimit, resolveMemoryTokenBudget, resolveRecentMessageLimit, resolveSnapshotTokenBudget,
} from "../memory-retrieval";
import { recordModelUsage, readDailyQuota, toUsageTokens } from "../model-usage";
import {
  applyImageDescriptions,
  describeImages,
  MAX_IMAGES_PER_TURN,
  resolveImageUnderstandingSettings,
  type ChannelImageRef,
} from "../image-understanding";
import { CLOSE_FRIEND_LIMIT, listAcquaintances, recordFriendInteraction } from "../friends";
import { isEmojiBudgetSpent, resolveEmojiFrequency } from "../emoji-frequency";
import { ensureOwnerPrivateScope } from "../memory-scope-access";
import { isSystemBroadcast, looksLikeSystemMessage } from "../system-message";
import { getPrisma } from "../prisma";
import { pickStickerCatalog, type StickerCatalogEntry } from "../stickers";
import {
  loadCatchphraseCatalog, markCatchphrasesUsed, pickCatchphraseCatalog, toCatchphrasePromptEntries,
} from "../catchphrases";
import { maybeAutoMineCatchphrases } from "../catchphrase-mine";
import { readPreviousJournalLine } from "../journal-service";
import { collectStickersFromTurn } from "../sticker-collect";
import {
  applyVoiceTranscripts,
  canSpeakReply,
  isVoiceRequested,
  MAX_VOICES_PER_TURN,
  planVoiceReply,
  resolveVoiceAsrSettings,
  resolveVoiceTtsSettings,
  transcribeVoices,
  VOICE_TEXT_MAX_CHARS,
  type ChannelVoiceRef,
  type VoiceTtsSettings,
} from "../voice";

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
  /** 引用回复的消息 id（本平台原始 id）。群聊里让她锚定「接的是哪一句」。 */
  replyToMessageId?: string;
  /**
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
   * 语音合成参数。由流水线解析好后带下来（含角色自己的 API Key），
   * 这样渠道不必为了合成再查一次库、再解密一次凭据。
   */
  voiceSettings?: VoiceTtsSettings;
};

export type ChannelReplySender = (text: string, options?: ChannelReplyOptions) => Promise<void>;

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
  /** Stable per-platform author id (bili uid / qq openid). Used to upsert ExternalIdentity. */
  authorPlatformUid?: string;
  /** Optional author display name for identity metadata. */
  authorDisplayName?: string;
  content: string;
  /** 这条消息 @ 的是谁（self / other / all）。落库给忆泡提炼判断对象用。 */
  mentionTargets?: string[];
  /** 给模型看的正文（@ 已代号化）；不传就等于 content。落库仍用 content。 */
  promptContent?: string;
  /** 群聊里的成员代号；只有群聊会传。 */
  member?: string;
  /** 收到这条消息的时刻（不是模型返回的时刻）。 */
  occurredAt?: Date;
  /** 这条消息里带的图。只有接了「看图」旁路才会被读，没配视觉模型时完全忽略。 */
  images?: ChannelImageRef[];
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
  platform: string;
  characterId: string;
  bindingId: string;
  /** Platform-specific message event type (e.g. QQ group message, bili dm). */
  eventType: string;
  /** Stable key for the conversation: "g:<group_openid>", "c:<user_openid>", "dm:<id>", etc. */
  externalConversationId: string;
  externalMessageId: string;
  authorOpenId: string;
  /** Stable per-platform author id (bili uid / qq openid). Used to upsert ExternalIdentity. */
  authorPlatformUid?: string;
  /** Optional author display name for identity metadata. */
  authorDisplayName?: string;
  /** 当前说话人是不是主人；只用于提示词，不参与鉴权。 */
  speaker?: {
    displayName?: string;
    isOwner: boolean;
    ownerDisplayName?: string;
  };
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
  /** 这条消息带的语音。渠道不传就等于「这个渠道没有语音」。 */
  voices?: ChannelVoiceRef[];
  /**
   * 这个渠道能发的表情清单。**传了就等于声明「本渠道支持表情」**——B站 私信没有表情段，
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
  storedReason: "replied" | "silent" | "mentioned" | "recorded";
  message: {
    authorOpenId: string;
    authorDisplayName?: string;
    member?: string;
    mentionTargets?: string[];
    speaker?: { isOwner?: boolean };
    voices?: unknown[];
    content: string;
  };
}): Prisma.InputJsonObject {
  const { message } = input;
  return {
    source: "channel",
    platform: input.platform,
    storedReason: input.storedReason,
    // 谁被 @ 了：提炼忆泡时用来判断「这句话是不是冲她说的」。
    ...(message.mentionTargets?.length ? { mentionTargets: message.mentionTargets } : {}),
    authorOpenId: message.authorOpenId,
    ...(message.authorDisplayName ? { authorDisplayName: message.authorDisplayName } : {}),
    // 群聊的成员代号（member_n）：昵称可能缺失或被改，代号在同一个群里稳定。
    ...(message.member ? { member: message.member } : {}),
    // 主人发的消息：群聊提炼时也要认得出「这是主人」，不能跟群友混。
    ...(message.speaker?.isOwner ? { isOwner: true } : {}),
    // 这条原本是语音条；落库的 content 是转写后的文字（没配 ASR 就还是 `[语音]`）。
    ...(message.voices?.length ? { hasVoice: true } : {}),
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

/** 群聊这一轮的上下文：本轮是否 @ 她、之前几句、她参与过的话题。 */export type ChannelGroupTurnContext = {
  direct: boolean;
  background: Array<{ id: string; at: number; member: string; speaker: string; text: string }>;
  anchors: Array<{ id: string; label: string }>;
  /** 群内归属（「X的Y」「@某人 主人夸我了」学来的）。空数组 = 这轮没学到，不注入。 */
  members?: Array<{ member: string; speaker: string; belongsTo: string; belongsToName: string }>;
};

/** 群聊一轮：几秒内几个人说的话，一次看、最多回一次。 */
export type ChannelBatchInput = {
  platform: string;
  characterId: string;
  bindingId: string;
  eventType: string;
  externalConversationId: string;
  messages: ChannelTurnMessage[];
  faceCatalog?: ReadonlyArray<{ id: string; name: string }>;
  stickerCatalog?: ReadonlyArray<StickerCatalogEntry>;
  /** 允许模型说「这轮不插嘴」。被 @ 时传 false —— 点名了还不回比乱回更糟。 */
  allowSilent?: boolean;
  /** 见 `ChannelMessageInput.voiceCapable`。 */
  voiceCapable?: boolean;
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
 * 上一条回复是不是语音条。存的是个标记而不是音频本身（音频发完就没了），
 * 只用来算冷却 —— 不要拿它判断「她刚才说了什么」，那是 content 的事。
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
async function attachImageDescriptions(
  messages: ChannelTurnMessage[],
  context: {
    modelConfig: unknown;
    chatModel: string;
    apiBaseUrl: string;
    apiKey: string;
    characterId: string;
    bindingId: string;
  },
): Promise<ChannelTurnMessage[]> {
  if (!messages.some((message) => (message.images?.length ?? 0) > 0)) return messages;
  const settings = resolveImageUnderstandingSettings({
    modelConfig: context.modelConfig,
    chatModel: context.chatModel,
    chatApiBaseUrl: context.apiBaseUrl,
    chatApiKey: context.apiKey,
  });
  if (!settings) return messages;

  let remaining = MAX_IMAGES_PER_TURN;
  const descriptionsByMessage = new Map<string, Array<string | null>>();
  for (const message of messages) {
    if (remaining <= 0) break;
    const refs = (message.images ?? []).filter((image) => Boolean(image.url));
    if (!refs.length) continue;
    const batch = refs.slice(0, remaining);
    remaining -= batch.length;
    try {
      descriptionsByMessage.set(
        message.externalMessageId,
        await describeImages(batch, settings, {
          characterId: context.characterId,
          channelBindingId: context.bindingId,
        }),
      );
    } catch {
      // 看图失败只是少一句描述，`[图片]` 原样保留。
    }
  }
  if (!descriptionsByMessage.size) return messages;

  return messages.map((message) => {
    const descriptions = descriptionsByMessage.get(message.externalMessageId);
    if (!descriptions?.length) return message;
    return patchMessageText(message, (text) => applyImageDescriptions(text, descriptions));
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
 * 失败一律吞掉：少一句转写不该让整轮回复变成错误事件。
 */
async function attachVoiceTranscripts(
  messages: ChannelTurnMessage[],
  context: {
    modelConfig: unknown;
    chatModel: string;
    apiBaseUrl: string;
    apiKey: string;
    voiceApiKey: string;
  },
): Promise<ChannelTurnMessage[]> {
  if (!messages.some((message) => (message.voices?.length ?? 0) > 0)) return messages;
  const settings = resolveVoiceAsrSettings({
    modelConfig: context.modelConfig,
    chatModel: context.chatModel,
    chatApiBaseUrl: context.apiBaseUrl,
    chatApiKey: context.apiKey,
    voiceApiKey: context.voiceApiKey,
  });
  if (!settings) return messages;

  let remaining = MAX_VOICES_PER_TURN;
  const transcriptsByMessage = new Map<string, Array<string | null>>();
  for (const message of messages) {
    if (remaining <= 0) break;
    const refs = (message.voices ?? []).filter((voice) => Boolean(voice.url));
    if (!refs.length) continue;
    const batch = refs.slice(0, remaining);
    remaining -= batch.length;
    try {
      transcriptsByMessage.set(message.externalMessageId, await transcribeVoices(batch, settings));
    } catch {
      // 转写失败只是少一句文字，`[语音]` 原样保留。
    }
  }
  if (!transcriptsByMessage.size) return messages;

  return messages.map((message) => {
    const transcripts = transcriptsByMessage.get(message.externalMessageId);
    if (!transcripts?.length) return message;
    return patchMessageText(message, (text) => applyVoiceTranscripts(text, transcripts));
  });
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
  faceCatalog?: ReadonlyArray<{ id: string; name: string }>;
  stickerCatalog?: ReadonlyArray<StickerCatalogEntry>;
  /** 允许模型说「这轮我不插嘴」。只有群聊批处理会传。 */
  allowSilent?: boolean;
  /** 群聊上下文；私聊不传。 */
  group?: ChannelGroupTurnContext;
  voiceCapable?: boolean;
  sendReply: ChannelReplySender;
}): Promise<ChannelMessageResult> {
  const prisma = getPrisma();
  const isGroup = input.eventType === "GROUP_MESSAGE";
  /**
   * 同一批里可能出现同一条消息两次（网关重投、或者两个适配器都连着 —— 后者已经在
   * `run-onebot-adapter.ts` 里用单实例标记挡住）。不去重的话，整轮会撞
   * `messages(conversationId, externalMessageId)` 唯一约束，事务回滚，**整轮都不回**：
   * 一条重复消息把同一轮里别人的话也一起拖死。
   */
  const seenInBatch = new Set<string>();
  let messages = input.messages
    .filter((message) => message.externalMessageId && message.content)
    .filter((message) => {
      if (seenInBatch.has(message.externalMessageId)) return false;
      seenInBatch.add(message.externalMessageId);
      return true;
    })
    .slice(-10);
  if (!messages.length) return { status: "ignored", reason: "missing_fields" };

  // Character lookup comes first: a paused or archived character must not answer channel
  // messages, and rejecting early also avoids creating an external identity for a dead character.
  const character = await prisma.character.findUnique({
    where: { id: input.characterId },
    select: {
      id: true,
      name: true,
      ownerId: true,
      basePrompt: true,
      styleExamples: true,
      status: true,
      modelConfig: true,
      memorySetting: { select: { timezone: true } },
      memoryScopes: { where: { scopeType: "CHARACTER_GLOBAL" }, select: { id: true } },
    },
  });
  if (!character) return { status: "ignored", reason: "character_missing" };
  if (character.status !== "ACTIVE") return { status: "ignored", reason: "character_inactive" };
  const globalScope = character.memoryScopes[0];
  if (!globalScope) return { status: "ignored", reason: "no_global_scope" };

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
      select: { id: true, title: true, memoryScopeId: true },
    }),
  ]);
  // 私聊预落库会建会话，后面的正常路径要接着用这一条，不能再建第二个。
  let existingConversation = foundConversation;
  if (seen.length) {
    const seenIds = new Set(seen.map((row) => row.externalMessageId));
    const fresh = messages.filter((message) => !seenIds.has(message.externalMessageId));
    if (!fresh.length) return { status: "duplicate" };
    messages = fresh;
  }

  /**
   * 私聊：一进来就记一次「她认识这个人」，并把会话要落的身份范围准备好。
   *
   * 群聊不在这里记。谁在群里冒一句就建一条身份，一个活跃群几天就能攒出几百个没跟她
   * 说过话的「朋友」—— 那不是朋友，是群成员名单。群聊等她**真的回了谁**再记，
   * 见下面回复发出的那段（`isGroup` 分支）。
   */
  let primaryIdentityScopeId: string | null = null;
  const identityScopeByAuthor = new Map<string, string | null>();
  if (!isGroup) {
    for (const message of messages) {
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
    const first = messages[0]!;
    const firstUid = (first.authorPlatformUid || first.authorOpenId || "").trim();
    primaryIdentityScopeId = firstUid ? identityScopeByAuthor.get(firstUid) ?? null : null;
  }

  // 主人专属私人范围：说话人明确是主人（私聊里渠道传 isOwner）时，会话挂到角色主人的
  // USER_PRIVATE 范围，而不是该账号的外部身份范围。这样主人的私聊走「角色主人私人记忆」，
  // 由调度器单独排快照，且只在主人自己的对话里可读 —— 不会混进全局、也不会串给群友。
  const isOwnerTurn = !isGroup && messages[0]?.speaker?.isOwner === true;
  let ownerPrivateScopeId: string | null = null;
  if (isOwnerTurn) {
    ownerPrivateScopeId = await ensureOwnerPrivateScope(input.characterId, character.ownerId);
  }

  const conversationScopeId = isGroup
    ? globalScope.id
    : (isOwnerTurn && ownerPrivateScopeId ? ownerPrivateScopeId : (primaryIdentityScopeId ?? globalScope.id));

  /**
   * 私聊先落库，再判断回不回。模型没配 / Key 坏 / 额度用完时下面会 early return，
   * 但这句话已经留在记录里；私聊不进清理，所以它之后还能参与忆泡整理。
   */
  let privateMessagesRecorded = false;
  if (!isGroup) {
    const repairScopeId = resolveOwnerPrivateScopeRepair({
      isOwnerTurn,
      ownerPrivateScopeId,
      currentScopeId: existingConversation?.memoryScopeId ?? conversationScopeId,
    });
    const title = existingConversation?.title
      || (messages[0]!.promptContent ?? messages[0]!.content).slice(0, 80);
    const recorded = await recordPrivateTurnMessages({
      prisma,
      characterId: input.characterId,
      bindingId: input.bindingId,
      platform: input.platform,
      externalConversationId: input.externalConversationId,
      conversation: existingConversation,
      messages,
      targetScopeId: conversationScopeId,
      repairScopeId,
      title,
    });
    if (recorded) {
      existingConversation = recorded;
      privateMessagesRecorded = true;
    }
  }

  const chatSettings = resolveChatModelSettings(character.modelConfig);
  let apiKey = "";
  try {
    apiKey = await resolveCharacterApiKey(character.modelConfig, chatSettings.apiBaseUrl);
  } catch {
    return { status: "ignored", reason: "api_key_decrypt_failed" };
  }
  if (!apiKey || !chatSettings.model) return { status: "ignored", reason: "model_not_configured" };

  /**
   * 语音 Key 与聊天 Key 是**两把**：语音几乎总是另一家服务商
   * （DeepSeek / 通义这类纯文本服务商的 /audio/speech 直接 404），
   * 而它常常是页面上单独填的。解密失败按没配处理，不影响聊天。
   */
  const voiceApiKey = await resolveCharacterVoiceApiKey(character.modelConfig).catch(() => "");

  // 额度用完就静默不回：渠道里抛错会把一条普通聊天变成失败事件，还会触发重试。
  const quota = await readDailyQuota(input.characterId, character.modelConfig);
  if (quota.exceeded) return { status: "ignored", reason: "daily_quota_exceeded" };

  // 图先变成文字再进提示词；角色没开看图开关时这一步什么都不做。
  messages = await attachImageDescriptions(messages, {
    modelConfig: character.modelConfig,
    chatModel: chatSettings.model,
    apiBaseUrl: chatSettings.apiBaseUrl,
    apiKey,
    characterId: input.characterId,
    bindingId: input.bindingId,
  });

  // 语音同理：先转写成文字再进提示词，没开「听懂语音」时原样保留 `[语音]`。
  messages = await attachVoiceTranscripts(messages, {
    modelConfig: character.modelConfig,
    chatModel: chatSettings.model,
    apiBaseUrl: chatSettings.apiBaseUrl,
    apiKey,
    voiceApiKey,
  });

  /**
   * 预落库写的是原始正文（`[图片]` / `[语音]`）。图/语音在进模型前才变成文字，
   * 这里把落库那几行同步成同一份文字 —— 否则记录页看到的和忆泡读到的不一致。
   * 失败只记日志：描述是锦上添花，不能拦住回复。
   */
  if (privateMessagesRecorded && existingConversation) {
    for (const message of messages) {
      await prisma.message.updateMany({
        where: { conversationId: existingConversation.id, externalMessageId: message.externalMessageId },
        data: { content: message.content },
      }).catch(() => undefined);
    }
  }

  // 「偷表情包」：群里的图值得收就存进她的表情库。只收群聊、不看她自己发的图，
  // 由开关 `modelConfig.stickerAutoCollect` 控制（默认关）。失败静默，不影响这轮回复。
  if (isGroup) {
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

  // 最近对话窗口与表情额度历史都依赖同一个会话，一起查（P3）。emojiFrequency 提前到这里。
  const emojiFrequency = resolveEmojiFrequency(character.modelConfig);
  const [recentStoredMessages, emojiHistory] = await Promise.all([
    existingConversation
      ? prisma.message.findMany({
          where: {
            conversationId: existingConversation.id,
            // 私聊预落库之后，这条消息已经在库里了；它作为 currentMessage 单独进提示词，
            // 不能又出现在 recentMessages 里（模型会以为自己说过两遍）。
            ...(privateMessagesRecorded
              ? { externalMessageId: { notIn: messages.map((message) => message.externalMessageId) } }
              : {}),
          },
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
          take: resolveRecentMessageLimit(character.modelConfig),
          select: { id: true, role: true, content: true, occurredAt: true, metadata: true, externalMessageId: true },
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

  // 表情要看三件事：渠道收不收（清单）、角色开没开开关、这个会话的额度用没用完。
  // 只看前两个的话，一个爱发表情的角色会在每句后面都挂一张。
  const lastAssistant = recentStoredMessages.find((item) => item.role === "ASSISTANT");
  const lastStickerId = lastAssistant ? readStoredStickerId(lastAssistant.metadata) : null;
  /**
   * 上一条语音是什么时候发的。语音冷却看它：连着两条都在「说话」像在读稿。
   * recentStoredMessages 是按时间倒序取的，所以第一条命中的就是最近一条。
   */
  const lastVoiceAt = recentStoredMessages.find(
    (item) => item.role === "ASSISTANT" && readStoredVoiceFlag(item.metadata),
  )?.occurredAt ?? null;

  /**
   * 语音必须在**生成之前**决定 —— 关键是模型得知道自己在说话。
   *
   * 生成后再判定的话，提示词里压根没提语音，她会回「我只有打字和嘴硬」
   * 「我这打字声你当语音听吧」：内容解释得通，但暴露了她根本不知道这条要被念出来。
   * 所以这里先定「这一轮说不说」，把结果放进提示词，再让它写；
   * 生成后只用 `canSpeakReply` 复核长度，超长就降级发文字。
   *
   * 判定只看开关、冷却、概率（用户明确要语音时跳过冷却与概率，但不跳过开关）。
   */
  const voiceRequested = input.voiceCapable === true
    && messages.some((message) => isVoiceRequested(message.promptContent ?? message.content));
  const voiceSettings = input.voiceCapable === true
    ? resolveVoiceTtsSettings({
        modelConfig: character.modelConfig,
        chatModel: chatSettings.model,
        chatApiBaseUrl: chatSettings.apiBaseUrl,
        chatApiKey: apiKey,
        voiceApiKey,
      })
    : null;
  const voicePlanned = Boolean(voiceSettings) && planVoiceReply({
    modelConfig: character.modelConfig,
    lastVoiceAt,
    force: voiceRequested,
  });

  /**
   * 额度：「每 N 分钟最多 N 张」，按**这个会话**算（A 群贴过三张不该让 B 群闭嘴）。
   *
   * 只取窗口内的助手消息，不看全部：`recentStoredMessages` 只是最近对话窗口（默认 40 条），
   * 热聊时几十条可能还没覆盖十分钟，用它数会少算。
   * `emojiFrequency` 与 `emojiHistory` 已和最近窗口一起并行查好（见上）。
   */
  const emojiBudgetSpent = isEmojiBudgetSpent(emojiHistory, new Date(), emojiFrequency);
  // 表情包优先于内置表情：有素材库就只给素材库（并剔除上一张，避免她一直贴同一张）。
  // 这一条要走语音时一律不给：语音条后面再挂一张图，等于把两种表达叠在一起说同一件事。
  const stickerCatalog = input.stickerCatalog?.length
    && isEmojiEnabled(character.modelConfig)
    && !emojiBudgetSpent
    && !voicePlanned
    ? pickStickerCatalog(input.stickerCatalog, lastStickerId)
    : undefined;
  const emojiFaces = !stickerCatalog?.length
    && input.faceCatalog?.length
    && isEmojiEnabled(character.modelConfig)
    && !emojiBudgetSpent
    && !voicePlanned
    ? input.faceCatalog
    : undefined;

  /**
   * 梗语录：和表情包不同，**不从调用方传**，流水线自己查。
   *
   * 表情包要按渠道能力决定（B站私信发不了图），梗是纯文字、哪个渠道都能说；
   * 交给每个 adapter 各自去查，只会有一边忘了接。角色级的文字习惯应该在角色级生效。
   */
  const catchphrasePrompt = toCatchphrasePromptEntries(
    pickCatchphraseCatalog(await loadCatchphraseCatalog(character.id)),
  );

  /**
   * 手账那句只在「她自己的对话」里注入：网页对话与主人私聊。
   * 群聊不传（手账是写给她自己的，群里复述就是泄露），对普通人的私聊也不传。
   */
  const journalLine = !input.group && messages[0]?.speaker?.isOwner === true
    ? await readPreviousJournalLine(
        prisma,
        character.id,
        new Date(),
        resolveChatTimeZone(character.memorySetting?.timezone),
      )
    : null;

  /**
   * 别人的系统播报不进窗口。
   *
   * 群里同时跑几个机器人时，它们对同一条命令各回一次（实测「管理命令仅管理员可用。」
   * 一天 34 条），onebot 会当普通群友消息收进来。这些行留在窗口里有两个坏处：
   * 一是白白占掉 40 条里的一大截，二是模型会把它们当「群友在说话」跟着接。
   *
   * 这里用**宽判据**（`looksLikeSystemMessage`）：误判也只是这一行不进提示词，
   * 原文还在库里，群聊原文页照常能看到。写入侧用的是窄判据，两件事别搞反。
   */
  const recentMessages: ConversationContextMessage[] = recentStoredMessages
    .reverse()
    .filter((item) => item.role === "USER" || item.role === "ASSISTANT")
    .filter((item) => !(item.role === "USER" && looksLikeSystemMessage(item.content)))
    .map((item) => ({
      role: item.role as "USER" | "ASSISTANT",
      content: item.content.slice(0, 1800),
      occurredAt: item.occurredAt.toISOString(),
      // 只有她自己的话不需要发言人；USER 的话一律带上，否则群里几条历史分不清是谁说的。
      ...(item.role === "USER" ? readStoredSpeaker(item.metadata) : {}),
      // 她自己发过图的回复：标出来，让她认得「那张图是我贴的」。
      ...(item.role === "ASSISTANT" && readStoredStickerFlag(item.metadata) ? { hadSticker: true } : {}),
    }));

  const modelText = (message: ChannelTurnMessage) => message.promptContent ?? message.content;
  const currentMessage = messages.length === 1
    ? modelText(messages[0]!)
    : messages.map((message) => `${message.authorDisplayName || "群友"}：${modelText(message)}`).join("\n");

  const retrievalQuery = [
    currentMessage,
    ...recentMessages.filter((item) => item.role === "USER").slice(-2).map((item) => item.content),
  ].join("\n");

  // Retrieval scope: character-global (shared persona) plus the author's own identity scope
  // (per-platform private memory). 群聊只用全局：一轮里好几个人，谁的私人记忆都不该端出来。
  // 主人私聊用 owner 的 USER_PRIVATE 范围，**同时带上主人自己 QQ 的旧身份范围**：
  // 会话在归位前可能还挂在 EXTERNAL_IDENTITY 上，旧记忆/忆泡写在那里，不带就永远读不到。
  // 两个范围都属于同一个主人，不涉及把别人的私人记忆端出来。
  const readableScopeIds = isGroup
    ? [globalScope.id]
    : (isOwnerTurn && ownerPrivateScopeId
      ? [globalScope.id, ownerPrivateScopeId, ...(primaryIdentityScopeId ? [primaryIdentityScopeId] : [])]
      : (primaryIdentityScopeId ? [globalScope.id, primaryIdentityScopeId] : [globalScope.id]));

  // 熟人卡要用的说话人 id 也算在这里，好和记忆检索一起并行（P3）。
  const speakerUids = isGroup
    ? [...new Set(messages.map((message) => (message.authorPlatformUid || message.authorOpenId || "").trim()).filter(Boolean))]
    : [];
  // 记忆、阶段总结、忆泡、熟人卡、熟客榜五类检索互不依赖，并行查，省四个 RTT。排序与筛选仍在各自原处。
  const [memoryCandidates, snapshotCandidates, eventCandidates, knownIdentities, acquaintanceRows] = await Promise.all([
    prisma.memoryItem.findMany({
      where: { memoryScopeId: { in: readableScopeIds }, status: "ACTIVE", deletedAt: null },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 300,
      select: {
        id: true, category: true, content: true, confidence: true, updatedAt: true, createdAt: true,
        validFrom: true, memoryScopeId: true, importance: true, lastRecalledAt: true, recallCount: true,
      },
    }),
    prisma.memorySnapshot.findMany({
      where: { memoryScopeId: { in: readableScopeIds }, status: "CURRENT" },
      orderBy: [{ createdAt: "desc" }, { version: "desc" }],
      take: 80,
      select: { id: true, summary: true, periodStart: true, periodEnd: true, version: true, createdAt: true, memoryScopeId: true },
    }),
    prisma.memoryEvent.findMany({
      where: { memoryScopeId: { in: readableScopeIds }, status: "ACTIVE" },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: 200,
      select: {
        id: true, occurredAt: true, timeOfDay: true, place: true, participants: true,
        keywords: true, title: true, detail: true, memoryScopeId: true,
        // 按账号检索要读引用列（5–12 位数字当 QQ 号匹配）。
        participantRefs: true,
      },
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
  ]);
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
    scope: memory.memoryScopeId === globalScope.id ? ("character" as const) : ("private" as const),
    // 和网页对话一致：有 validFrom 用它，否则退回入库时间。
    occurredAt: (memory.validFrom ?? memory.createdAt).toISOString(),
  }));

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
    scope: snapshot.memoryScopeId === globalScope.id ? ("character" as const) : ("private" as const),
  }));

  // 忆泡和网页对话走同一套选择逻辑：先按日期框住，框不住才退化成关键词。
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
    scope: event.memoryScopeId === globalScope.id ? ("character" as const) : ("private" as const),
  }));

  // 忆泡还没覆盖到那一段时用原文兜底；只在问句指向某一天时才查。
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
      // 截断在 selectRawMessagesForPrompt 里做（并按截断后的长度算预算），这里不要再切一刀：
      // 两处各有一个上限时，短的那个生效、长的那个没人知道它已经失效了。
      content: message.content,
      occurredAt: message.occurredAt.toISOString(),
      scope: message.conversation.memoryScopeId === globalScope.id ? ("character" as const) : ("private" as const),
    }));
  }

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

  let generated;
  try {
    generated = await generateConversationReply({
      characterName: character.name,
      characterPrompt: character.basePrompt.slice(0, 12_000),
      ...(!useTranscript && messages[0]!.speaker ? { speaker: messages[0]!.speaker } : {}),
      styleExamples: (character.styleExamples ?? "").slice(0, 8000),
      model: chatSettings.model,
      apiKey,
      apiBaseUrl: chatSettings.apiBaseUrl,
      temperature: chatSettings.temperature,
      maxTokens: chatSettings.maxTokens,
      currentMessage,
      timeZone: resolveChatTimeZone(character.memorySetting?.timezone),
      ...(journalLine ? { journalLine } : {}),
      events,
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
              ...(message.occurredAt ? { occurredAt: message.occurredAt.toISOString() } : {}),
            })),
          }
        : {}),
      ...(input.group
        ? {
            groupChat: true,
            direct: input.group.direct,
            ...(backgroundLines.length
              ? {
                  groupBackground: backgroundLines.map((line) => ({
                    id: line.id,
                    member: line.member,
                    speaker: line.speaker,
                    content: line.text,
                    occurredAt: new Date(line.at).toISOString(),
                  })),
                }
              : {}),
            ...(input.group.anchors.length ? { groupAnchors: input.group.anchors } : {}),
            ...(input.group.members?.length ? { groupMembers: input.group.members } : {}),
          }
        : {}),
      ...(allowSilent ? { allowSilent } : {}),
      ...(groupAcquaintances?.length ? { groupAcquaintances } : {}),
      ...(acquaintances ? { acquaintances } : {}),
      recentMessages,
      memories,
      snapshots,
      ...(emojiFaces ? { emojiFaces } : {}),
      ...(stickerCatalog?.length ? { emojiStickers: stickerCatalog } : {}),
      // 告诉她「这一条会被念出来」：语气、长度、不要表情符号都靠这一段。
      ...(voicePlanned ? { voiceReply: true } : {}),
      ...(catchphrasePrompt.length ? { catchphrases: catchphrasePrompt } : {}),
    });
  } catch (error) {
    return { status: "ignored", reason: (error instanceof Error ? error.message : "model_error").slice(0, 200) };
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
  const conversationId = await prisma.$transaction(async (tx) => {
    let conversation = existingConversation;
    /**
     * 主人私聊的会话可能比「主人专属范围」这个功能更早建出来 —— 那时它还挂在这个 QQ 的
     * EXTERNAL_IDENTITY 范围下。会话按 `(binding, externalConversationId)` 唯一，找到就复用，
     * 不迁移的话：之后主人说的每一句仍旧落在外人范围里，既不排忆泡、也进不了主人私人记忆，
     * 而且从页面上完全看不出来。这里在主人发言时把会话归位。
     */
    if (conversation) {
      const repairScopeId = resolveOwnerPrivateScopeRepair({
        isOwnerTurn,
        ownerPrivateScopeId,
        currentScopeId: conversation.memoryScopeId,
      });
      if (repairScopeId) {
        // 旧范围里已经整理出的忆泡跟着会话走：否则主人私聊读不到，归位后还会重复提一遍。
        await moveConversationEventsToScope(tx, {
          conversationId: conversation.id,
          fromScopeId: conversation.memoryScopeId,
          toScopeId: repairScopeId,
        });
        await tx.conversation.update({
          where: { id: conversation.id },
          data: { memoryScopeId: repairScopeId },
        });
        conversation = { ...conversation, memoryScopeId: repairScopeId };
      }
    } else {
      conversation = await tx.conversation.create({
        data: {
          characterId: input.characterId,
          // 群聊挂在角色全局 scope 下：它属于一群人，不属于某一个外部身份。
          memoryScopeId: conversationScopeId,
          channelBindingId: input.bindingId,
          externalConversationId: input.externalConversationId,
          title,
          status: "ACTIVE",
          // kind/groupId 让「这段记录属于哪个群」可查；记忆页的群聊记录按它分组。
          metadata: {
            platform: input.platform,
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
            platform: input.platform,
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
      for (const member of buildGroupMemberDeltas(messages)) {
        await tx.groupMember.upsert({
          where: {
            conversationId_platformUid: { conversationId: conversation.id, platformUid: member.platformUid },
          },
          create: {
            conversationId: conversation.id,
            characterId: input.characterId,
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
    if (generated.action === "reply") {
      await tx.message.create({
        data: {
          conversationId: conversation.id,
          role: "ASSISTANT",
          content: generated.reply,
          occurredAt: assistantAt,
          metadata: {
            source: "channel",
            platform: input.platform,
            generatedBy: "llm",
            model: generated.model,
            provider: generated.provider,
            promptTemplateVersion: generated.promptTemplateVersion,
            usedMemoryIds: generated.usedMemoryIds,
            usedSnapshotIds: generated.usedSnapshotIds,
            ...(generated.usedEventIds.length ? { usedEventIds: generated.usedEventIds } : {}),
            ...(generated.usedCatchphraseIds.length ? { usedCatchphraseIds: generated.usedCatchphraseIds } : {}),
            // 表情段不进 content：正文要能原样重放给下一轮模型，混进 [face] 会被当成用户打的字。
            ...(replyFaces.length ? { faceIds: replyFaces } : {}),
            ...(replySticker ? { stickerId: replySticker.id } : {}),
            // 只记「这一条是语音」，不存音频：音频发完就没了，存下来也没法重放给模型。
            ...(replyVoice ? { voice: true } : {}),
          },
        },
        select: { id: true },
      });
      await tx.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: assistantAt } });
    } else {
      await tx.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: messages[messages.length - 1]!.occurredAt ?? now } });
    }
    return conversation.id;
  });

  if (generated.action === "reply") {
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
    const atTarget = replyVoice ? undefined : generated.groupDecision?.atMessageId;
    const replyOptions = replyFaces.length || replySticker || replyVoice || quoteTarget || atTarget
      ? {
          ...(replyFaces.length ? { faces: replyFaces } : {}),
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
        }
      : undefined;
    await input.sendReply(generated.reply, replyOptions);
    /**
     * 群聊里「跟谁互动过」＝她真的回了谁。
     *
     * 对象从三处取：她引用的那条、她 @ 的那条、两样都没有就是这轮最新的一句（她接的
     * 就是这句话）。`silent` 走不到这个分支，所以没被搭理的发言不会变成朋友 —— 这正
     * 是「她回过的人才算」的落地位置。
     *
     * 放在发完之后：朋友簿晚半秒无所谓，不能让记账拖住已经生成的那句话。
     */
    if (isGroup) {
      const targetedMessageIds = new Set(
        [quoteTarget, atTarget].filter((id): id is string => Boolean(id)),
      );
      const latest = messages.at(-1);
      if (!targetedMessageIds.size && latest?.externalMessageId) {
        targetedMessageIds.add(latest.externalMessageId);
      }
      const recordedAuthors = new Set<string>();
      for (const message of messages) {
        if (!message.externalMessageId || !targetedMessageIds.has(message.externalMessageId)) continue;
        const platformUid = (message.authorPlatformUid || message.authorOpenId || "").trim();
        if (!platformUid || recordedAuthors.has(platformUid)) continue;
        recordedAuthors.add(platformUid);
        await recordFriendInteraction({
          characterId: input.characterId,
          platform: input.platform,
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
  if (generated.usedMemoryIds.length) {
    await prisma.memoryItem.updateMany({
      where: { id: { in: generated.usedMemoryIds } },
      data: { lastRecalledAt: new Date(), recallCount: { increment: 1 } },
    }).catch(() => undefined);
  }
  await recordModelUsage({
    kind: "channel",
    model: chatSettings.model,
    usage: toUsageTokens(generated.usage),
    characterId: input.characterId,
    channelBindingId: input.bindingId,
    conversationId,
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

/** 单条消息（私聊、B站、以及群聊里 @ 她的那一条）。行为与此前一致。 */
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
      ...(input.images?.length ? { images: input.images } : {}),
      ...(input.voices?.length ? { voices: input.voices } : {}),
      ...(input.speaker ? { speaker: input.speaker } : {}),
    }],
    ...(input.faceCatalog ? { faceCatalog: input.faceCatalog } : {}),
    ...(input.stickerCatalog?.length ? { stickerCatalog: input.stickerCatalog } : {}),
    ...(input.voiceCapable ? { voiceCapable: true } : {}),
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
    ...(input.faceCatalog ? { faceCatalog: input.faceCatalog } : {}),
    ...(input.stickerCatalog?.length ? { stickerCatalog: input.stickerCatalog } : {}),
    ...(input.group ? { group: input.group } : {}),
    ...(input.voiceCapable ? { voiceCapable: true } : {}),
    allowSilent: input.allowSilent !== false,
    sendReply: input.sendReply,
  });
}
