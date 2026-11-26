import { findGeneratedImageAsset } from "../../image-assets";
import { observeOnebotMedia } from "../media-observation";
import { readOnebotMedia, readOnebotMessageParts, readOnebotAddressedCommandText } from "./types";
/**
 * QQ 小号（OneBot v11）渠道的消息处理 —— 对应官方 QQ 的 serve.ts。
 *
 * 把 OneBot 消息事件路由到绑定角色，走通用流水线，再把回复通过 OneBot HTTP API 发回。
 * 群聊默认仅在被 @ 时回复（replyOnlyWhenMentioned），私聊总是回复。
 */

import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { dataPath } from "../../data-dir";
import { getPrisma } from "../../prisma";
import { handleRoleplayChannel, parseRoleplayCommand, findRoleplayChannelReplay } from "../../roleplay-channel";
import { readDailyQuota } from "../../model-usage";
import { readGroupMemberProfile } from "../../friends";
import { loadStickerCatalog, MAX_STICKER_BYTES } from "../../stickers";
import type { OnebotConnectionConfig, OnebotOutgoingMessage, OnebotResolvedEvent } from "./client";
import type { OnebotSegment } from "./types";
import { isOnebotSendRejected, fillOnebotImageUrls, resolveOnebotGroupQuotes, resolveOnebotPrivateQuote, sendOnebotCustomFace, sendOnebotGroupMessage, sendOnebotPrivateMessage } from "./client";
import { parseBindingRoutingKeys, type OnebotBindingRecord, type OnebotConnectionRecord } from "./configure";
import { ONEBOT_FACES, toOnebotFaceSegments } from "./faces";
import { handleChannelBatch, handleChannelMessage, buildStoredMessageMetadata, type ChannelReplySender, type ChannelReplyDelivery } from "../pipeline";
import type { ConversationMessageMention } from "../../conversation-message";
import {
  createGroupChatBuffer,
  evaluateGroupChatGate,
  groupChatDayStart,
  groupChatForGroup,
  groupChatWindowMs,
  isClarificationMessage,
  mentionsCharacterName,
} from "./group-chat";
import {
  isAiOnlyGroupRound,
  MAX_CONSECUTIVE_AI_ROUNDS,
  nextConsecutiveAiRounds,
  shouldBlockFriendSpeaker,
  shouldHideFriendContent,
  isReadOnlyFriendContent,
  shouldPauseAiOnlyRound,
} from "../../friend-chat-policy";
import { createGroupContext, type GroupMessageFacts } from "./group-context";
import { shouldStoreAmbientGroupMessage } from "../../group-ambient-memory";
import { GROUP_MUTE_MS, createGroupMuteStore, isQuietRequest, isResumeRequest } from "./group-mute";
import { createGroupActivityRecorder } from "../../group-activity";
import { ONEBOT_PLATFORM, readOnebotMentions, readOnebotReplyToId, readOnebotRoleplayText } from "./types";
import { claimGroupAt, groupAtKey } from "./at-cooldown";
import {
  resolveVoiceTtsSettings,
  synthesizeSpeechSilk,
} from "../../voice";
import {
  claimPendingAnnouncement,
  createPendingAnnouncement,
  draftAnnouncementText,
  findAnnouncementConversationId,
  findDuplicateAnnouncementEvent,
  findPendingAnnouncement,
  finishAnnouncement,
  isAnnouncementConfirm,
  parseAnnouncementRequest,
  publishPendingAnnouncement,
  recordAnnouncementExchange,
  writeAnnouncementAudit,
} from "./announcement";

export type OnebotHandleOutcome =
  | { status: "replied"; conversationId: string }
  | { status: "silent"; conversationId: string }
  /** 群聊攒批中：几秒后连同这一轮其他人的话一起处理。`poke` 表示这一轮是被戳出来的。 */
  | { status: "buffered"; poke?: true }
  | { status: "duplicate" }
  | { status: "ignored"; reason: string };

/**
 * 选择处理此事件的绑定角色：群聊优先匹配 routingKey（支持一个绑定挂多个群号），
 * 否则用默认绑定（routingKey 为空或 "*"）；私聊优先默认绑定，
 * 没有默认绑定但只有一条启用中的绑定时也用她（否则填了群号就私聊永久静默）。
 */
export function routeOnebotEventToBinding(
  bindings: readonly OnebotBindingRecord[],
  event: OnebotResolvedEvent,
): OnebotBindingRecord | null {
  const defaults = bindings.filter((binding) => !binding.routingKey || binding.routingKey === "*");
  if (event.messageType === "group" && event.groupId) {
    const exact = bindings.find((binding) => parseBindingRoutingKeys(binding.routingKey).includes(event.groupId!));
    if (exact) return exact;
  }
  if (defaults[0]) return defaults[0]!;
  // 私聊的兜底：没有默认绑定时，只有一条启用中的绑定就直接给她。
  //
  // 以前这里只有 defaults[0]，于是「把群号填进绑定」等于「私聊永久静默」——
  // 而群里照常能回，从群聊那边完全看不出问题，用户只会觉得「她私聊不理我了」。
  // 多条绑定又没有默认绑定时仍然返回 null：那种情况下猜错人比不回更糟。
  return event.messageType === "private" && bindings.length === 1 ? bindings[0]! : null;
}

/**
 * 判断群聊消息是否 @ 了机器人自己。
 *
 * 优先用事件里的 self_id；网关没给时退回连接上记的小号 QQ —— 少了这个兜底，
 * 一旦 self_id 缺失，「仅 @ 时回复」就变成「永远不回」，而且日志里只会是一串 not_mentioned。
 */
function isSelfMentioned(event: OnebotResolvedEvent, fallbackSelfId = ""): boolean {
  const selfId = event.selfId || fallbackSelfId;
  if (!selfId) return false;
  // 只认 OneBot at 段或字符串消息中的 CQ:at 码。
  // 正文里手打的「@QQ」不是点名，不能用 event.content.includes() 兜底。
  return readOnebotMentions(event.data, selfId).some((mention) => mention.target === "self");
}

/**
 * 同一个绑定在同一个会话里的消息必须排队处理，不能并发。
 *
 * OneBot 的 WS 帧是各帧独立派发的：群里连着来 6 条消息，6 个 handler 会同时跑起来。
 * 而群聊限流统计的是「已经落库的回复」—— 前面几条还在等模型，库里还是 0 条，
 * 于是全部放行，32 秒说完本该撑 10 分钟的 5 条额度（2026-10-29 实测 6 条）。
 * 排队同时修掉另一件事：回复顺序不再和群里的发言顺序错开。
 */
const conversationChains = new Map<string, Promise<unknown>>();

/** 排到队时已经过了这么久 = 这句话在群里早过去了，补一句只会更怪。 */
const QUEUE_STALE_MS = 20_000;

/**
 * 「他刚 @ 过别人」这条线索留多久。
 *
 * 真人「@ 他一句 + 连发三条解释」基本在两分钟内说完；再长就该重新判听者了，
 * 不然一个人上午 @ 过别人，下午说什么都会被当成「还在跟那个人讲」。
 */
const CONTINUED_TO_OTHER_MS = 120_000;

type PendingGroupMessage = {
  event: OnebotResolvedEvent;
  binding: OnebotBindingRecord;
  at: number;
  /** 这一条真实 @ 了她。 */
  direct: boolean;
  /** 这一条正文里出现了她的名字/别名。 */
  named: boolean;
  /** 这一条是主人发的。群聊里也要认得主人，落库和提炼时标「主人」。 */
  isOwner: boolean;
  /**
   * 入队时解析好的事实（@ 目标、原始 QQ、引用 id）。
   *
   * CQ 码只在入队时解析一次：以前 `remember`、mention 档早退、flush 各解析一遍，
   * 同一条消息三遍。存下来之后 flush 直接用，背景/归属/续话判断看到的也是同一份。
   */
  facts: GroupMessageFacts;
};

/** 群里怎么叫她：角色名 + 手填的昵称。@ 由 isSelfMentioned 单独判。 */
function cueNames(binding: OnebotBindingRecord): string[] {
  return [binding.characterName, ...binding.groupChat.aliases]
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

function enqueueConversation<T>(key: string, task: () => Promise<T>): Promise<T> {
  const tail = conversationChains.get(key) ?? Promise.resolve();
  // 前一个失败也要继续跑自己的，所以 then 的 onRejected 也接 task。
  const run = tail.then(task, task);
  const guard = run.then(() => undefined, () => undefined);
  conversationChains.set(key, guard);
  void guard.then(() => {
    // 只有自己还是队尾时才清理，否则会把后来者的链一起删掉。
    if (conversationChains.get(key) === guard) conversationChains.delete(key);
  });
  return run;
}

/** 群规限流：滚动时间窗由绑定自己定，只统计这条鱼在该群已落库的回复。0 条 = 不限。 */
async function isGroupReplyLimited(
  binding: OnebotBindingRecord,
  event: OnebotResolvedEvent,
): Promise<boolean> {
  if (event.messageType !== "group" || binding.replyLimitPerWindow <= 0) return false;
  const windowMs = Math.max(1, binding.replyWindowMinutes) * 60 * 1000;
  const recentReplies = await getPrisma().message.count({
    where: {
      role: "ASSISTANT",
      occurredAt: { gte: new Date(Date.now() - windowMs) },
      conversation: {
        is: { channelBindingId: binding.id, externalConversationId: event.conversationKey },
      },
    },
  });
  const roleplayReplies = await getPrisma().roleplayMessage.count({
    where: {
      role: "assistant", source: "qq-group",
      createdAt: { gte: new Date(Date.now() - windowMs) },
      session: { groupBindingId: binding.id, groupConversationId: event.conversationKey },
    },
  });
  return recentReplies + roleplayReplies >= binding.replyLimitPerWindow;
}

function announcementErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  if (code === "MODEL_NOT_CONFIGURED") return "模型还没配置，写不了公告。请先在角色模型设置里填好 API。";
  if (code === "DAILY_QUOTA_EXCEEDED") return "今天的模型额度用完了，暂时写不了公告。";
  if (code === "CHARACTER_INACTIVE") return "这个角色当前不在运行中，写不了公告。";
  if (code === "CHARACTER_MISSING") return "找不到绑定到这个群的角色。";
  if (code === "API_KEY_DECRYPT_FAILED") return "角色 API Key 解不开，请到模型设置里重新填写。";
  if (code === "EMPTY_ANNOUNCEMENT") return "模型这次没写出正文，请再说一次公告主题。";
  return `写公告失败：${code.slice(0, 160)}`;
}

function announcementErrorReply(error: unknown): string {
  if (error instanceof Error && error.message.startsWith("ONEBOT_SEND_")) {
    return `公告发布失败：${error.message.slice(0, 220)}`;
  }
  return `公告发布失败：${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`;
}

/** 群里让角色拟公告：先写成草稿，等管理员确认后才发。 */
async function handleAnnouncementDraft(
  record: OnebotConnectionRecord,
  event: OnebotResolvedEvent,
  binding: OnebotBindingRecord,
  topic: string,
  sendReply: ChannelReplySender,
): Promise<OnebotHandleOutcome> {
  if (await findDuplicateAnnouncementEvent(event.messageId)) return { status: "duplicate" };

  const prisma = getPrisma();
  await prisma.platformConnection.update({
    where: { id: record.id },
    data: { lastEventAt: new Date() },
  }).catch(() => undefined);

  let reply: string;
  try {
    const conversationId = await findAnnouncementConversationId(binding.id, event.conversationKey);
    const draft = await draftAnnouncementText({
      characterId: binding.characterId,
      bindingId: binding.id,
      conversationId,
      topic,
    });
    await createPendingAnnouncement({
      connectionId: record.id,
      groupId: event.groupId,
      requestedBy: event.userId,
      characterId: binding.characterId,
      topic,
      content: draft.content,
    });
    reply = [
      "公告草稿（10 分钟内回复「确认发布」才会发出）：",
      "",
      draft.content,
    ].join("\n");
  } catch (error) {
    reply = announcementErrorMessage(error);
  }

  const persisted = await recordAnnouncementExchange({
    characterId: binding.characterId,
    bindingId: binding.id,
    event,
    userContent: event.content,
    assistantContent: reply,
  }).catch(() => null);
  await sendReply(reply);
  return { status: "replied", conversationId: persisted ?? "" };
}

/** 管理员确认发布：认领草稿 → 调 SnowLuma 公告接口 → 记审计。 */
async function handleAnnouncementConfirm(
  record: OnebotConnectionRecord,
  event: OnebotResolvedEvent,
  binding: OnebotBindingRecord,
  sendReply: ChannelReplySender,
): Promise<OnebotHandleOutcome> {
  if (await findDuplicateAnnouncementEvent(event.messageId)) return { status: "duplicate" };

  const prisma = getPrisma();
  await prisma.platformConnection.update({
    where: { id: record.id },
    data: { lastEventAt: new Date() },
  }).catch(() => undefined);

  let reply: string;
  const pending = await findPendingAnnouncement(record.id, event.groupId);
  if (!pending) {
    reply = "没有待发布的公告，或草稿已过期。先 @我 说要写什么公告。";
  } else if (!(await claimPendingAnnouncement(pending.id))) {
    reply = "这条公告正在发布或已经处理过，不会重复发送。";
  } else {
    const result = await publishPendingAnnouncement({
      pending,
      config: record.config,
      groupId: event.groupId,
    });
    await finishAnnouncement(pending.id, result);
    await writeAnnouncementAudit({
      connectionId: record.id,
      characterId: pending.characterId ?? binding.characterId,
      groupId: event.groupId,
      announcementId: pending.id,
      requestedBy: pending.requestedBy,
      ok: result.ok,
      error: result.error,
    });
    reply = result.ok ? "公告已发布。" : announcementErrorReply(new Error(result.error ?? ""));
  }

  const persisted = await recordAnnouncementExchange({
    characterId: binding.characterId,
    bindingId: binding.id,
    event,
    userContent: event.content,
    assistantContent: reply,
  }).catch(() => null);
  await sendReply(reply);
  return { status: "replied", conversationId: persisted ?? "" };
}


/** 主人的显示名：优先当前消息里的群名片，其次外部身份表里记过的昵称。 */
async function resolveOwnerDisplayName(record: OnebotConnectionRecord, event: OnebotResolvedEvent): Promise<string> {
  if (!record.ownerQq) return "";
  // 手填的称呼优先：外部身份表里可能是旧昵称，群名片又只在这个群有效。
  if (record.ownerName) return record.ownerName;
  if (event.userId === record.ownerQq && event.displayName) return event.displayName;
  try {
    const identity = await getPrisma().externalIdentity.findUnique({
      where: { platform_platformUid: { platform: ONEBOT_PLATFORM, platformUid: record.ownerQq } },
      select: { displayName: true },
    });
    return identity?.displayName?.trim() ?? "";
  } catch {
    return "";
  }
}

/**
 * 回复发回原处：群消息发群，私聊发人。
 * 表情必须单独一条 —— 拼进正文会卡在句子中间，而且它发失败也没必要让正文背锅。
 */
/**
 * 把正文和可选的「引用回复」「@ 某人」拼成出站消息。
 *
 * 群聊里多条鱼并存时，引用让「我接的是哪一句」不再靠猜：模型给的 replyToMessageId
 * 是 transcript 里那条消息的 QQ 真实 message id，这里转成 OneBot reply 段拼在正文前。
 * id 必须是纯数字（QQ message id），否则退回纯文本 —— 宁可少引一次，也不发坏段。
 *
 * **引用不附带 @**。QQ 的引用块本身就把原文摆出来了，读的人一眼看得见她在接哪句；
 * 再补一个 at 段只是多弹一次提醒。「凡引用必 @」是上一版的写法，用户的评价是
 * 「经常 @ 也不好」—— @ 留给「单独对某人说、希望他看见」那种场合，见 `at-cooldown.ts`。
 * 引用与提醒互斥：有有效引用时只发 reply → text，否则可发 at → text。
 */
export function buildQuoteSegments(replyToMessageId?: string, atQq?: string | null): OnebotSegment[] {
  const segments: OnebotSegment[] = [];
  if (replyToMessageId && /^\d+$/.test(replyToMessageId)) {
    segments.push({ type: "reply", data: { id: replyToMessageId } });
  }
  if (!segments.length && atQq && /^\d+$/.test(atQq)) {
    segments.push({ type: "at", data: { qq: atQq } });
  }
  return segments;
}

export function buildOnebotReplyMessage(
  reply: string,
  replyToMessageId?: string,
  atQq?: string | null,
): OnebotOutgoingMessage {
  const prefix = buildQuoteSegments(replyToMessageId, atQq);
  if (!prefix.length) return reply;
  return [...prefix, { type: "text", data: { text: reply } }];
}

/**
 * 表情包（贴图）段：图片走 `image` 段的 base64 形式。
 *
 * 用 `base64://` 而不是本地路径：网关不一定和适配器在同一台机器上，路径方式一旦跨机就是
 * 一张发不出去的图，而表情包最多 2MB，base64 传过去完全够用（本地路径省下的那点开销不值这个风险）。
 */
export function toOnebotStickerSegments(base64: string): OnebotSegment[] {
  if (!base64) return [];
  return [{ type: "image", data: { file: `base64://${base64}` } }];
}

/** 读回表情包文件并转成段。文件没了（换电脑只搬了库）返回空数组，静默跳过。 */
export async function loadStickerSegments(filePath: string): Promise<OnebotSegment[]> {
  return loadImageSegments(filePath);
}

/**
 * 读一张本地图片并转成 `image` 段。
 *
 * 表情包和她自己画的图走的是同一条路：都是「本地文件 → base64 → image 段」，
 * 区别只在谁生成的。所以只留一份实现 —— 表情那条已经在线上跑了很久，
 * 画图这条跟着它走，就少一处「表情能发、图发不出去」的可能。
 *
 * 超过上限返回空数组而不是截断：截断出来的图是坏的，宁可不发。
 */
export async function loadImageSegments(filePath: string): Promise<OnebotSegment[]> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_STICKER_BYTES) return [];
    const file = await fs.readFile(filePath);
    return toOnebotStickerSegments(file.toString("base64"));
  } catch {
    return [];
  }
}

/**
 * 语音段：silk 走 `record` 段的 base64 形式。
 *
 * 与表情包同一个理由用 `base64://` 而不是本地路径：网关不一定和适配器同机。
 * **必须是 silk**：QQ 客户端只认 Tencent silk，喂 mp3/wav 要么发不出去，要么变成
 * 一条打不开的语音。转码在 `voice.ts` 里做，这里只管发。
 */
export function toOnebotVoiceSegments(silkBase64: string): OnebotSegment[] {
  if (!silkBase64) return [];
  return [{ type: "record", data: { file: `base64://${silkBase64}` } }];
}

/**
 * 语音落盘目录。OneBot 实现与本站**同机**时，`file://` 直传比 base64 稳得多：
 * base64 要在网关里再解一遍、再落地、再上传，中间任何一步出问题都会得到
 * 「发送成功但有人播不出来」——那正是这个目录存在的理由。
 */
const VOICE_OUT_DIR = dataPath("voice-out");
/** 语音文件留着没用，一小时前的顺手清掉，避免 .data 里堆成山 */
const VOICE_OUT_KEEP_MS = 60 * 60 * 1000;

async function writeVoiceFile(silk: Buffer): Promise<string> {
  await fs.mkdir(VOICE_OUT_DIR, { recursive: true });
  const name = `voice-${Date.now()}-${randomBytes(4).toString("hex")}.silk`;
  const filePath = resolve(VOICE_OUT_DIR, name);
  await fs.writeFile(filePath, silk);
  // 清理过期文件；失败无所谓，别影响发送
  void cleanupVoiceFiles().catch(() => undefined);
  return filePath;
}

async function cleanupVoiceFiles(): Promise<void> {
  const cutoff = Date.now() - VOICE_OUT_KEEP_MS;
  const entries = await fs.readdir(VOICE_OUT_DIR).catch(() => [] as string[]);
  await Promise.all(entries
    .filter((name) => name.startsWith("voice-") && name.endsWith(".silk"))
    .map(async (name) => {
      const full = resolve(VOICE_OUT_DIR, name);
      const stat = await fs.stat(full).catch(() => null);
      if (stat && stat.mtimeMs < cutoff) await fs.unlink(full).catch(() => undefined);
    }));
}

/** Windows 的 `D:\a\b.silk` 要变成 `file:///D:/a/b.silk` 才被识别成绝对路径 */
function toFileUri(filePath: string): string {
  return "file:///" + filePath.replace(/\\/g, "/").replace(/^\/+/, "");
}

function buildVoiceSegment(file: string): OnebotSegment[] {
  return [{ type: "record", data: { file } }];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 分条之间的间隔。随机而不是固定：固定间隔连着发几条，节奏太像程序。
 * 这个区间是「打完一句抬手再打下一句」的手速，也让网关不至于同时收到三条。
 */
function segmentGapMs(): number {
  return 350 + Math.floor(Math.random() * 550);
}


export function createReplySender(
  config: OnebotConnectionConfig,
  target: Pick<OnebotResolvedEvent, "messageType" | "groupId" | "userId" | "tempGroupId">,
  /**
   * 点名的 id 翻译成真实 QQ 号：模型手上只有 message id（提示词里不能出现真实账号），
   * 所以由这里按 id 现查。`selfQq` 用来挡掉「引用自己发的」那种情况 —— 自己叫自己
   * 名字很傻。只有群聊会传，私聊没有 @ 这回事。
   */
  quote?: { resolveAtQq?: (messageId: string) => string | null; selfQq?: string },
): ChannelReplySender {
  return async (reply, options) => {
    const send = (message: OnebotOutgoingMessage): Promise<import("./client").OnebotSendReceipt> => {
      if (target.messageType === "group" && target.groupId) {
        return sendOnebotGroupMessage(config, target.groupId, message);
      }
      if (target.userId) {
        // 临时会话要带来源群，否则协议端拒绝 —— 回复会「生成成功但发不出去」。
        return sendOnebotPrivateMessage(config, target.userId, message, target.tempGroupId || undefined);
      }
      return Promise.resolve({ messageId: null });
    };

    const delivery: ChannelReplyDelivery = {
      ...(options?.sticker || options?.faces?.length ? { emoji: { status: "unknown", reason: "unconfirmed" } as const } : {}),
    };
    let atTarget: string | null = null;
    let reservation: ReturnType<typeof claimGroupAt> | undefined;
    const requested = options?.atMessageId;
    if (requested) {
      const qq = quote?.resolveAtQq?.(requested);
      const reason = target.messageType !== "group" || !target.groupId ? "not_group"
        : options?.voice ? "voice" : options?.replyToMessageId ? "quote"
        : !qq || !/^\d+$/.test(qq) ? "unresolved" : qq === quote?.selfQq ? "self" : undefined;
      delivery.at = { requestedMessageId: requested, ...(qq ? { targetQq: qq } : {}), status: "suppressed", ...(reason ? { reason } : {}) };
      if (!reason && qq) {
        reservation = claimGroupAt(groupAtKey(quote?.selfQq || config.httpUrl, target.groupId, qq));
        if (reservation.allowed) atTarget = qq;
        else {
          delivery.at.reason = "cooldown";
          console.log("[onebot] 跳过 @ " + JSON.stringify({ reason: "cooldown", sinceSeconds: Math.round(reservation.sinceMs / 1000) }));
        }
      }
    }
    const sendText = async (text: string) => {
      try {
        await send(buildOnebotReplyMessage(text, options?.replyToMessageId, atTarget));
        if (atTarget && reservation?.allowed) {
          const sentAt = Date.now();
          reservation.commit(sentAt);
          delivery.at = { requestedMessageId: requested!, targetQq: atTarget, status: "sent", sentAt: new Date(sentAt).toISOString() };
        }
      } catch (error) {
        const rejected = isOnebotSendRejected(error);
        if (reservation?.allowed) {
          if (rejected) reservation.release();
          else reservation.commit();
        }
        if (delivery.at && atTarget) {
          delivery.at = { ...delivery.at, status: rejected ? "suppressed" : "unknown", reason: rejected ? "send_failed" : "unconfirmed",
            ...(!rejected ? { attemptedAt: new Date().toISOString() } : {}) };
        }
        if (delivery.at) await options?.onDelivery?.(delivery);
        throw error;
      }
      await options?.onDelivery?.(delivery);
    };

    // 语音条替代正文：发了语音就不再补一条文字，否则同一句话会被说两遍。
    // 合成失败则原样发文字 —— 语音失败绝不能变成「这轮她没说话」。
    if (options?.voice && options.voiceSettings) {
      const silk = await synthesizeSpeechSilk(reply, options.voiceSettings);
      if (silk?.length) {

        /**
         * 先 `file://` 再 `base64://`。
         *
         * base64 要在网关里解开、落地、再上传，中间任何一步出错都会得到
         * 「消息发出去了，但有人播不出来」（QQ 语音是上传+转码+CDN 分发，不像文字直接可见）。
         * 同机部署时 `file://` 让网关直接读文件，少一道编解码，是更接近官方客户端的上传路径。
         * 网关不认 `file://`（比如跑在容器里）时自动退回 base64，行为与以前一致。
         */
        const attempts: Array<{ via: string; file: string }> = [];
        try {
          attempts.push({ via: "file", file: toFileUri(await writeVoiceFile(silk)) });
        } catch (error) {
          console.error("[onebot] 写语音文件失败，改走 base64：", error instanceof Error ? error.message : String(error));
        }
        attempts.push({ via: "base64", file: "base64://" + silk.toString("base64") });

        for (const attempt of attempts) {
          try {
            await send(buildVoiceSegment(attempt.file));
            // QQ 语音只发 record 段；引用和提醒不能叠加。
            console.log("[onebot] 语音已发送 " + JSON.stringify({
              via: attempt.via,
              bytes: silk.length,
              quoted: false,
              at: false,
            }));
          } catch (error) {
            if (!isOnebotSendRejected(error)) throw error;
            console.error(`[onebot] 语音发送失败（${attempt.via}）：`, error instanceof Error ? error.message : String(error));
            continue;
          }
          await options?.onDelivery?.(delivery);
          return delivery;
        }
      }
    }

    /**
     * 分条发送：一条一条弹，像真人连着打两三句。
     *
     * 为什么要间隔：连着几个 HTTP 调用打过去，网关那边几乎同时到达，QQ 里看是「砰」
     * 一下冒出三条，而且更容易撞频率风控。三百到九百毫秒的随机间隔刚好是「打完一句
     * 再打下一句」的手速，也让风控看到的是人的节奏而不是循环。
     *
     * **引用和 @ 只挂第一条**：挂在每条上等于每句弹一次提醒（v8 那种写法被用户骂过）。
     * 后面几条是纯文字 —— 它们属于同一段话，不需要各自交代在回谁。
     *
     * 后续条失败了就停手、只记日志：第一条已经发出去了，这一段本来就有头有尾；
     * 把它变成整轮报错，反倒是「她说了一半，页面上却是红的」。
     */
    const replySegments = options?.segments?.length ? options.segments : [reply];
    if (replySegments.length <= 1) {
      await sendText(reply);
      // 单条也记一笔 @ 目标：这是事后唯一能查到「她今天叫了谁」的地方。
      if (atTarget) console.log("[onebot] 已 @ " + JSON.stringify({ groupId: target.groupId, qq: atTarget }));
    } else {
      await sendText(replySegments[0]!);
      console.log("[onebot] 回复分条发送 " + JSON.stringify({
        segments: replySegments.length,
        quoted: Boolean(options?.replyToMessageId),
        at: Boolean(atTarget),
      }));
      for (const segment of replySegments.slice(1)) {
        await sleep(segmentGapMs());
        try {
          await send(segment);
        } catch (error) {
          console.error("[onebot] 分条发送中断：", error instanceof Error ? error.message : String(error));
          // 停止剩余文字；已经生成的图片仍需独立投递并记录回执。
          // 没有图片时保留原先停止整轮的行为，避免接着发送表情。
          if (!options?.image) return delivery;
          break;
        }
      }
    }
    /**
     * 表情单独一条消息跟上。三条路，从「最像她本人」到「一定能发出去」：
     *
     * 1. **QQ 收藏表情**（`send_custom_face`）：她那 62 张收藏里就有这张，走原生表情通道，
     *    QQ 里显示成表情而不是一张图。要用完整 `emoji_id`，所以只有同步过的才有。
     * 2. **图片段**：从本地 `.data/stickers` 读出来转 base64。收藏里没有（还没同步、
     *    或刚在 QQ 里删了）时用它兜底 —— 表情发不出去比发成图片糟得多。
     * 3. **QQ 内置表情**（face 段）：只在没有表情包时才会走到，有素材库时上游根本不传。
     *
     * 贴了图就不再发内置表情：一句话后面挂两种表情，像自动回复机器人。
     */
    /**
     * 她自己画的图：单独一条消息，紧跟在文字后面。
     *
     * 为什么单独一条而不是和文字拼一起：引用块、文字、图挤在一条里，手机端显示出来
     * 是一坨；单独一条和表情包的行为一致（那条路已经跑了很久）。图不带引用也不带 @ ——
     * 引用已经挂在文字上了，图属于同一段话的延续。
     *
     * 走 base64 而不是 `file://`：图可能有几百 KB，但网关不一定和适配器同机，
     * 而 `file://` 一旦跨机就是一张发不出去的图。表情包用同一个理由。
     *
     * 发失败只记日志：文字已经发出去了，不能因为一张图把整轮判成失败。
     */
    const image = options?.image;
    if (image) {
      const segments = await loadImageSegments(image.filePath);
      if (!segments.length) {
        console.error("[onebot] 图片读不出来（文件没了或超过上限），这一条不发：", image.filePath);
        delivery.image = { status: "failed", reason: "read_failed" };
        await options?.onDelivery?.(delivery);
        return delivery;
      }
      try {
        const receipt = await send(segments);
        delivery.image = { status: "sent", sentAt: new Date().toISOString(), ...(receipt.messageId ? { externalMessageId: receipt.messageId } : {}) };
        console.log("[onebot] 图片已发送 " + JSON.stringify({
          bytes: image.bytes,
          width: image.width,
          height: image.height,
        }));
      } catch (error) {
        delivery.image = isOnebotSendRejected(error)
          ? { status: "failed", reason: "send_failed" } : { status: "unknown", reason: "unconfirmed" };
        console.error("[onebot] 图片发送失败：", error instanceof Error ? error.message : String(error));
      }
      await options?.onDelivery?.(delivery);
      return delivery;
    }

    const sticker = options?.sticker;
    if (sticker) {
      if (sticker.qqEmojiId) {
        try {
          await sendOnebotCustomFace(config, target, sticker.qqEmojiId);
          console.log("[onebot] 收藏表情已发送 " + JSON.stringify({ emojiId: sticker.qqEmojiId, stickerId: sticker.id }));
          delivery.emoji = { status: "sent" };
        } catch (error) {
          if (!isOnebotSendRejected(error)) {
            // Unknown remote outcome: another send could duplicate a delivered sticker.
            delivery.emoji = { status: "unknown", reason: "unconfirmed" };
            console.error("[onebot] 收藏表情发送结果未确认，停止发送，不退回图片段。");
            await options?.onDelivery?.(delivery);
            return delivery;
          }
          // Only explicit rejection permits an image fallback.
          console.error(
            "[onebot] 收藏表情发送失败，退回图片段：",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      if (delivery.emoji?.status === "sent") {
        await options?.onDelivery?.(delivery);
        return delivery;
      }
      const segments = await loadStickerSegments(sticker.filePath);
      if (!segments.length) {
        delivery.emoji = { status: "failed", reason: "read_failed" };
      } else {
        try {
          await send(segments);
          delivery.emoji = { status: "sent" };
        } catch (error) {
          delivery.emoji = isOnebotSendRejected(error) ? { status: "failed", reason: "send_failed" } : { status: "unknown", reason: "unconfirmed" };
          console.error("[onebot] 表情发送失败：", error instanceof Error ? error.message : String(error));
        }
      }
      await options?.onDelivery?.(delivery);
      return delivery;
    }

    const faceSegments = toOnebotFaceSegments(options?.faces ?? []);
    if (!faceSegments.length) return delivery;
    try {
      await send(faceSegments);
      delivery.emoji = { status: "sent" };
    } catch (error) {
      delivery.emoji = isOnebotSendRejected(error) ? { status: "failed", reason: "send_failed" } : { status: "unknown", reason: "unconfirmed" };
      console.error("[onebot] 内置表情发送失败：", error instanceof Error ? error.message : String(error));
    }
    await options?.onDelivery?.(delivery);
    return delivery;
  };
}

function logGroupRound(groupId: string, detail: Record<string, unknown>): void {
  console.log("[onebot] 群聊", JSON.stringify({ groupId, ...detail }));
}

export function createOnebotMessageHandler(record: OnebotConnectionRecord) {
  /** 连接内的短期群聊上下文：背景、成员代号、话题参与。按绑定+群隔离。 */
  const groupContext = createGroupContext({ selfQq: record.accountQq });
  /**
   * 静默档：有人明确让她闭嘴之后，这个群十分钟内不接话。
   *
   * 状态放内存、按「绑定 + 群」存：十分钟的临时状态，重启丢了最多多回两句；
   * 写库要为每群维护一行状态加清理任务，不划算。
   */
  const groupMute = createGroupMuteStore();
  // Register mode switches before awaiting DB so following events queue behind the switch.
  const roleplayTransitions = new Map<string, number>();
  /**
   * 群活跃度落库（节流）。和 `groupContext` 的分工：那边是给这一轮模型看的短期背景，
   * 这边是给**另一个进程**的主动找话题判断「这个群多久没动静」用的。
   * 被闸门丢掉的消息也要记 —— 群里正热闹却被判成冷场，是这套功能最糟的失败方式。
   */
  const groupActivity = createGroupActivityRecorder();

  /**
   * 连接活性：事件一到就更新 `lastEventAt`，而不是等它走到 flush。
   *
   * 以前只在 `flushGroupRound` 和私聊分支里更新，于是 mention 档的早退
   * （`not_mentioned`）根本不经过那两处 —— 群里没人 @ 她时消息一直在进，
   * 连接页却显示掉线。这里按事件入口更新，60 秒节流，避免每条消息都写一次库。
   */
  let lastEventAtWrittenAt = 0;
  const touchLastEventAt = (): void => {
    const now = Date.now();
    if (now - lastEventAtWrittenAt < 60_000) return;
    lastEventAtWrittenAt = now;
    void getPrisma().platformConnection
      .update({ where: { id: record.id }, data: { lastEventAt: new Date() } })
      .catch(() => undefined);
  };

  /**
   * 这条群消息是不是「指令」（公告确认/拟稿）—— 需要排队的那种。
   *
   * 普通群消息不需要排队：`remember` + `buffer.push` 都是同步的，真正要串行的是
   * flush（查库、调模型），它在 `onFlush` 里已经自己排队。指令要改公告草稿，
   * 得和私聊/其他指令保持串行，所以走外层队列。
   */
  const isGroupCommandMessage = (event: OnebotResolvedEvent, _binding: OnebotBindingRecord): boolean => {
    if (event.messageType !== "group" || !event.groupId) return false;
    const canManageAnnouncement = record.groupAnnouncementEnabled && event.senderRole !== "member";
    if (canManageAnnouncement) {
      if (isAnnouncementConfirm(event.content)) return true;
      if (parseAnnouncementRequest(event.content)) return true;
    }
    return false;
  };

  /**
   * 一条群消息的事实。@ 只在这里解析一次，后续 remember / 闸门 / 落库 / 入模
   * 都用同一份结构化结果，不再各自从 `content` 里的 `@数字` 反推。
   */
  const factsOf = (event: OnebotResolvedEvent, at: number): GroupMessageFacts => {
    const parsedMentions = readOnebotMentions(event.data, event.selfId || record.accountQq);
    const mentions = parsedMentions.map((mention) => ({
      qq: mention.qq,
      ...(mention.name ? { name: mention.name } : {}),
      target: mention.target,
    }));
    return {
      messageId: event.messageId,
      at,
      senderQq: event.userId,
      displayName: event.displayName,
      text: event.content,
      mentionTargets: [...new Set(parsedMentions.map((mention) => mention.target))],
      // 具体 @ 了谁：分类结果只够判断「是不是叫她」，学归属要原始 QQ。
      mentionQqs: [...new Set(parsedMentions.map((mention) => mention.qq))],
      mentions,
      replyToMessageId: readOnebotReplyToId(event.data),
    };
  };

  /**
   * 一轮群聊的判定与处理。
   *
   * 闸门放在这里而不是 push 的那一刻：push 时还不知道这一轮到底聊了什么，
   * 也不知道她上一次开口是什么时候 —— 这两样都要等这一轮安静下来才成立。
   */
  /**
   * 只落库、不调模型：把「被 @ / 被叫到名字 / 主人说了话、但这一轮没接」的消息写进会话。
   *
   * 为什么需要它：群聊记录原本只等于「她回过话的那几轮」，群里发生但没找她、
   * 或找了但被闸门挡下的事，从来没进过库，自然也就永远成不了忆泡。
   * 这里只补两种：冲她来的，以及**主人说的**。量小、也不改变任何回复行为。
   *
   * 主人那一轮为什么要存：他被闸门挡下之后往往会到私聊里接着问，而私聊的最近对话
   * 窗口只回看自己那条会话。不落库的话，「我在群里跟你说的」在私聊里就是凭空消失，
   * 她只能回「这边真没接到」（2026-11-02 实况）。落库是那条跨窗口旁路的前提。
   *
   * 两种原因分开标，不能混：
   * - `mentioned`：冲她来的，是证据，按角色设置的保留天数走（默认 30 天）；
   * - `context`：只是「他当时在群里说过这句」，属于上下文，跟 `silent` 一样 7 天清理。
   * 合用一个标签的话，主人随便聊两句就会在库里留 30 天。
   */
  const persistMentionedRound = async (
    items: PendingGroupMessage[],
    storedReason: "mentioned" | "context" | "ambient" = "mentioned",
    mentionInfoByMessageId: ReadonlyMap<string, ConversationMessageMention[]> = new Map(),
  ): Promise<void> => {
    const binding = items[0]!.binding;
    const groupEvent = items[0]!.event;
    const contextKey = `${binding.id}:${groupEvent.conversationKey}`;
    const prisma = getPrisma();
    const scope = await prisma.memoryScope.findFirst({
      where: { characterId: binding.characterId, scopeType: "CHARACTER_GLOBAL" },
      select: { id: true },
    });
    if (!scope) return;
    const conversation = await prisma.conversation.upsert({
      where: {
        channelBindingId_externalConversationId: {
          channelBindingId: binding.id,
          externalConversationId: groupEvent.conversationKey,
        },
      },
      create: {
        characterId: binding.characterId,
        memoryScopeId: scope.id,
        channelBindingId: binding.id,
        externalConversationId: groupEvent.conversationKey,
        title: `QQ群 ${groupEvent.groupId}`,
        status: "ACTIVE",
        metadata: { platform: ONEBOT_PLATFORM, kind: "group", groupId: groupEvent.groupId },
      },
      update: {
        // 群会话恒挂角色全局范围。老会话可能是「群聊挂全局」这条规则定下来之前建的，
        // 还挂在某个外部身份范围下 —— 那里不排忆泡，写进去的群消息等于不存在。
        memoryScopeId: scope.id,
      },
      select: { id: true },
    });
    await prisma.message.createMany({
      data: items.map((item) => {
        const mentions = mentionInfoByMessageId.get(item.event.messageId) ?? [];
        return {
          conversationId: conversation.id,
          externalMessageId: item.event.messageId,
          role: "USER" as const,
          content: item.event.content,
          occurredAt: new Date(item.at),
          // 和正常回复走同一套 metadata 组装：被闸门挡下的群消息同样要带
          // member / mentionTargets / mentions，否则长期记忆只看到 @数字 和一句正文。
          metadata: {
            ...buildStoredMessageMetadata({
              platform: ONEBOT_PLATFORM,
              storedReason,
              message: {
                authorOpenId: item.event.userId,
                ...(item.facts.kind ? { kind: item.facts.kind } : {}),
                ...(item.facts.excludeFromGrowth ? { excludeFromGrowth: true as const } : {}),
                ...(item.event.displayName ? { authorDisplayName: item.event.displayName } : {}),
                member: groupContext.memberCode(contextKey, item.event.userId),
                ...(item.facts.mentionTargets.length ? { mentionTargets: item.facts.mentionTargets } : {}),
                ...(mentions.length ? { mentions } : {}),
                // 主人说的那句：提炼忆泡时靠它把「主人」和群友分开，别在私聊里读成别人说的。
                ...(item.isOwner ? { speaker: { isOwner: true } } : {}),
                content: item.event.content,
                observedMedia: observeOnebotMedia(readOnebotMedia(item.event.data)),
              },
            }),
            ...(item.event.poke !== undefined ? { poke: true } : {}),
          },
        };
      }),
      // 同一轮可能被重放（重连/重试），靠 (conversationId, externalMessageId) 唯一约束去重。
      skipDuplicates: true,
    });
  };

  const flushGroupRound = async (items: PendingGroupMessage[]): Promise<void> => {
    const originalItems = items;
    const binding = items[0]!.binding;
    const groupEvent = items[0]!.event;
    const contextKey = `${binding.id}:${groupEvent.conversationKey}`;
    const prisma = getPrisma();
    const storeAmbient = shouldStoreAmbientGroupMessage(binding.storeAmbientGroupMessages, groupEvent.groupId);
    // A batch buffered before the explicit mode switch must not speak as the daily persona afterward.
    if (await prisma.roleplayRoute.findUnique({ where: { bindingId_externalConversationId: { bindingId: binding.id, externalConversationId: groupEvent.conversationKey } }, select: { id: true } })) return;
    const originalIds = originalItems.map((item) => item.event.messageId);
    let backgroundLines = groupContext.background(contextKey, originalIds);
    let analysisBackgroundLines = groupContext.background(contextKey, originalIds, {
      windowMs: 15 * 60_000,
      maxMessages: 120,
      maxChars: 24_000,
    });
    // 重新检查缓冲前已进入短期上下文的历史发言：用户可能刚刚把某条鱼改成「禁止交流」。
    const contextUidByMessageId = new Map<string, string>();
    for (const line of [...backgroundLines, ...analysisBackgroundLines]) {
      const uid = groupContext.senderOf(contextKey, line.id, 15 * 60_000);
      if (uid) contextUidByMessageId.set(line.id, uid);
    }

    // 冲模型之前按平台账号身份过滤。身份是全局属性，交流权限从当前角色的关系范围读取。
    const authorUids = [...new Set([
      ...originalItems.map((item) => item.event.userId.trim()),
      ...contextUidByMessageId.values(),
    ].filter(Boolean))];
    /**
     * 被 @ 的对象也要查身份：同一条消息里 @ 的是另一个 bot 还是人类，
     * 决定了模型该不该把接下来的称呼算到自己头上。只查号、不建行 ——
     * 对方没在本群说过话时查不到，宁可标 UNKNOWN，也不凭空造一个身份。
     */
    const selfQq = groupEvent.selfId || record.accountQq;
    const mentionUids = [...new Set(
      originalItems.flatMap((item) => (item.facts.mentions ?? []).map((mention) => mention.qq))
        .filter((qq) => qq && qq !== "all" && qq !== selfQq),
    )];
    const quoteAuthorUids = [...backgroundLines, ...analysisBackgroundLines].flatMap(line => line.quoted?.authorQq ? [line.quoted.authorQq] : []);
    const identityUids = [...new Set([...authorUids, ...mentionUids, ...quoteAuthorUids])];
    const identities = identityUids.length
      ? await prisma.externalIdentity.findMany({
          where: { platform: ONEBOT_PLATFORM, platformUid: { in: identityUids } },
          select: {
            platformUid: true,
            kind: true,
            displayName: true,
            memoryScopes: {
              where: { characterId: binding.characterId, scopeType: "EXTERNAL_IDENTITY" },
              take: 1,
              select: { friendChatPolicy: true },
            },
          },
        })
      : [];
    const identityByUid = new Map(identities.map((identity) => [
      identity.platformUid,
      {
        kind: identity.kind,
        displayName: identity.displayName,
        policy: identity.memoryScopes[0]?.friendChatPolicy ?? "DEFAULT",
      },
    ] as const));
    const isBlockedUid = (uid: string) => {
      if (uid === selfQq || (record.ownerQq && uid === record.ownerQq)) return false;
      const identity = identityByUid.get(uid);
      return shouldBlockFriendSpeaker(identity?.kind ?? "UNKNOWN", identity?.policy ?? "DEFAULT");
    };
    const kindFor = (item: PendingGroupMessage) => item.isOwner
      ? "HUMAN" as const
      : identityByUid.get(item.event.userId)?.kind ?? "UNKNOWN" as const;
    const policyFor = (item: PendingGroupMessage) => item.isOwner
      ? "ALLOW" as const
      : identityByUid.get(item.event.userId)?.policy ?? "DEFAULT" as const;
    const blockedSpeakerUids = new Set([...authorUids, ...quoteAuthorUids].filter(isBlockedUid));
    const hiddenSpeakerUids = new Set([...authorUids, ...quoteAuthorUids].filter(uid => {
      if (uid === selfQq || uid === record.ownerQq) return false;
      const identity = identityByUid.get(uid);
      return shouldHideFriendContent(identity?.kind ?? "UNKNOWN", identity?.policy ?? "DEFAULT");
    }));
    backgroundLines = groupContext.background(contextKey, originalIds, undefined, hiddenSpeakerUids);
    analysisBackgroundLines = groupContext.background(contextKey, originalIds, {
      windowMs: 15 * 60_000, maxMessages: 120, maxChars: 24_000,
    }, hiddenSpeakerUids);
    const blockedMessageIds = new Set(
      originalItems
        .filter((item) => shouldBlockFriendSpeaker(kindFor(item), policyFor(item)))
        .map((item) => item.event.messageId),
    );
    const blockedContextMessageIds = new Set(
      [...contextUidByMessageId.entries()]
        .filter(([, uid]) => hiddenSpeakerUids.has(uid))
        .map(([messageId]) => messageId),
    );
    const excludedContextIds = new Set([...blockedMessageIds, ...blockedContextMessageIds]);
    const boundReadOnlyBackground = (lines: typeof backgroundLines): typeof backgroundLines => {
      let readOnlyCount = 0, chars = 0;
      return lines.filter(line => {
        const uid = contextUidByMessageId.get(line.id);
        if (uid && hiddenSpeakerUids.has(uid)) return false;
        const identity = uid ? identityByUid.get(uid) : undefined;
        const readOnly = identity && isReadOnlyFriendContent(identity.kind, identity.policy);
        if (!readOnly) return true;
        const text = line.text.slice(0, 300);
        if (readOnlyCount >= 2 || chars + text.length > 600) return false;
        readOnlyCount++; chars += text.length;
        Object.assign(line, { text, kind: "AI", readOnly: true, excludeFromGrowth: true });
        return true;
      });
    };
    backgroundLines = boundReadOnlyBackground(backgroundLines);
    analysisBackgroundLines = boundReadOnlyBackground(analysisBackgroundLines);
    items = originalItems.filter((item) => !blockedMessageIds.has(item.event.messageId));
    if (!items.length) {
      logGroupRound(groupEvent.groupId, {
        reason: "friend_policy_blocked",
        messages: originalItems.length,
        blocked: blockedMessageIds.size,
        direct: false,
        named: false,
      });
      return;
    }
    const roundIdentityKinds = items.map(kindFor);
    const aiOnlyRound = isAiOnlyGroupRound(roundIdentityKinds);

    // 按群解析：同一个绑定挂了好几个群时，每个群可以有自己的那一档。
    const settings = groupChatForGroup(binding.groupChat, binding.groupChatModes, groupEvent.groupId);
    const direct = items.some((item) => item.direct);
    const named = items.some((item) => item.named);
    // 这一轮是不是被「戳一戳」叫醒的。只在为真时打，避免每行日志多一个 false。
    const poked = items.some((item) => item.event.poke !== undefined);
    // 入队时已解析好，直接用，不再重复解 CQ 码。
    const facts = items.map((item) => item.facts);
    /**
     * 给模型和记忆看的 @ 对象详情：群成员代号 + 显示名 + 身份（AI / HUMAN / UNKNOWN）。
     *
     * 这一步是「@ 的是谁」的唯一出口。正文里的 `@member_n` 只有在它旁边能查到
     * 这个人是谁时才有意义；只给代号，模型就会把 `@member_2 某个称呼` 里的称呼
     * 和当前角色自己合并（2026-11-08 实际踩到）。
     */
    const describeMentions = (fact: GroupMessageFacts): ConversationMessageMention[] =>
      (fact.mentions ?? []).flatMap((mention): ConversationMessageMention[] => {
        if (mention.target === "all") return [{ target: "all" as const }];
        if (mention.target === "self") return [{ target: "self" as const }];
        const identity = identityByUid.get(mention.qq);
        const speaker = (identity?.displayName || mention.name || "").trim();
        return [{
          // qq 只用于和正文里的 @ 对上；进角色提示词前由 chat-reply 剥掉。
          qq: mention.qq,
          target: "other" as const,
          member: groupContext.memberCode(contextKey, mention.qq),
          ...(speaker ? { speaker: speaker.slice(0, 40) } : {}),
          ...(identity?.kind ? { kind: identity.kind } : {}),
        }];
      });
    const mentionInfoByMessageId = new Map(items.map((item) => [
      item.event.messageId,
      describeMentions(item.facts),
    ]));
    const topicCandidate = groupContext.topicCandidate(contextKey, facts, blockedSpeakerUids);
    /**
     * 这一批有没有「@ 的是别人」。
     *
     * @all 不算：那是冲着所有人说的，她也是其中之一。只有一条 @ 她都没沾上的
     * 才叫「别人的私事」—— 判据必须来自 at 段本身，不能靠正文里的称呼去猜。
     */
    const mentionsSelfOrAll = facts.some((fact) =>
      fact.mentionTargets.includes("self") || fact.mentionTargets.includes("all"));
    /**
     * 接着说给同一个人的那几句。
     *
     * 群里的话常拆两条发：`@群友乙 不是刷屏` + `是这个不适合发群里`。第一条被上面那条
     * 判据挡掉、连库都不落；第二条没有 @，就成了一颗孤零零的「对所有人说」的话，
     * 她会当成在说自己（2026-10-31 22:02「不适合你还发」、22:02「登本宝的号？」）。
     * 挡得越干净，孤立的展开句越像在跟她说话 —— 所以这里要把「刚 @ 过别人」接着算。
     *
     * 两分钟：真人「@他一句 + 连发三条解释」基本在这个尺度内；再长就该重新判了。
     */
    const continuedToOther = !mentionsSelfOrAll && facts.some((fact) =>
      fact.mentionTargets.length === 0
      && groupContext.addressedOtherWithin(contextKey, fact.senderQq, fact.at, CONTINUED_TO_OTHER_MS));
    const addressedToOthers = !mentionsSelfOrAll
      && (facts.some((fact) => fact.mentionTargets.includes("other")) || continuedToOther);
    /**
     * 这一轮 @ 她的话，是不是**全都在把话收回来**。
     *
     * 戳一戳永远不算澄清：那是明确在叫她开口（用户的实际用法就是「没接话我就戳一下」）。
     * 只要有一条是真的在跟她说话，就仍是「必须回」—— 澄清只是让这一轮**可以**不接，
     * 不是让整轮都不许接。
     */
    const clarificationOnly = direct
      && items
        .filter((item) => item.direct)
        .every((item) => item.event.poke === undefined && isClarificationMessage(item.event.content));

    // lastEventAt 已挪到事件入口统一更新（含 mention 档早退），这里不再重复写。
    const conversation = await prisma.conversation.findFirst({
      where: { channelBindingId: binding.id, externalConversationId: groupEvent.conversationKey },
      select: { id: true, consecutiveAiRounds: true },
    });
    if (aiOnlyRound && shouldPauseAiOnlyRound(conversation?.consecutiveAiRounds ?? 0)) {
      logGroupRound(groupEvent.groupId, {
        reason: "ai_dialogue_limit",
        messages: items.length,
        direct,
        named,
        consecutiveAiRounds: conversation?.consecutiveAiRounds ?? 0,
        maxConsecutiveAiRounds: MAX_CONSECUTIVE_AI_ROUNDS,
      });
      return;
    }
    const lastAssistant = conversation
      ? await prisma.message.findFirst({
          where: { conversationId: conversation.id, role: "ASSISTANT" },
          orderBy: { occurredAt: "desc" },
          select: { occurredAt: true },
        })
      : null;
    const dailySpokenToday = conversation
      ? await prisma.message.count({
          where: {
            conversationId: conversation.id,
            role: "ASSISTANT",
            occurredAt: { gte: groupChatDayStart() },
          },
        })
      : 0;

    const spokenToday = dailySpokenToday + await prisma.roleplayMessage.count({ where: { role: "assistant", source: "qq-group", createdAt: { gte: groupChatDayStart() }, session: { groupBindingId: binding.id, groupConversationId: groupEvent.conversationKey } } });
    const now = new Date();
    const lastSpokeAt = lastAssistant?.occurredAt ?? null;
    /**
     * 这个群是否在静默期。
     *
     * 在 `flushGroupRound` 里读、不在入队时读：静默是「这一轮要不要开口」的问题，
     * 而入队那一刻还不知道这一轮结束时静默是否已经解除。读的是内存状态，不额外查库。
     */
    const muted = groupMute.isMuted(contextKey);
    const gate = evaluateGroupChatGate({
      settings,
      now,
      direct,
      named,
      topicCandidate,
      addressedToOthers,
      clarificationOnly,
      lastSpokeAt,
      spokenToday,
      muted,
      random: Math.random(),
    });
    if (!gate.allowed) {
      // direct / named 一定要一起打：早退时少了这两个，事后分不清是「@ 没认出来」
      // 还是「认出来了但被别的闸拦了」—— 前者换协议端，后者调参数，处理方式完全不同。
      // `owner` 同理：分不清「主人那句没落库」是漏了还是这一轮本来就没他说的。
      const ownerSpoke = items.some((item) => item.isOwner);
      logGroupRound(groupEvent.groupId, {
        reason: gate.reason, messages: items.length, direct, named, addressedToOthers,
        ...(muted ? { muted: true } : {}),
        ...(ownerSpoke ? { owner: true } : {}),
        ...(poked ? { poked } : {}),
      });
      // 被闸门挡下、但冲她来（@ 或叫名字）或者**主人在说话**：原文仍要落库。
      // 她不接话不等于那件事没发生；不存的话「群里发生的事」永远进不了忆泡，
      // 而且下一句他到私聊里问「我刚才群里说的」，她只能回「这边真没接到」。
      // 只写库、不调模型，所以「闸门不过就不花钱」这条约定没有被破坏。
      //
      // 静默期是例外：这十分钟里她本来就该「只听不说」，只存冲她来的那几句，
      // 等于十分钟的记忆是断的；全量落库不会有回复开销，也不会打扰任何人。
      if (muted || direct || named || ownerSpoke) {
        await persistMentionedRound(items, direct || named ? "mentioned" : "context", mentionInfoByMessageId).catch((error) => {
          console.error("[onebot] 记录被挡下的轮次失败：", error instanceof Error ? error.message : String(error));
        });
      } else if (storeAmbient) {
        // 普通群聊批次没触发回复：按群开关留下原文，48 小时后清理，不进快照/忆泡。
        await persistMentionedRound(items, "ambient", mentionInfoByMessageId).catch((error) => {
          console.warn("[onebot] 群聊原文留存失败：", error instanceof Error ? error.message : String(error));
        });
      }
      return;
    }
    // 群规限流仍然生效：闸门管「该不该接」，这里管「这个群十分钟能说几句」。
    if (await isGroupReplyLimited(binding, groupEvent)) {
      const ownerSpoke = items.some((item) => item.isOwner);
      logGroupRound(groupEvent.groupId, { reason: "group_reply_limit", messages: items.length, direct, named, ...(ownerSpoke ? { owner: true } : {}), ...(poked ? { poked } : {}) });
      // 限流挡下的同样是「冲她来的」轮次，一样落库；主人说的那句也别丢。
      if (direct || named || ownerSpoke) {
        await persistMentionedRound(items, direct || named ? "mentioned" : "context", mentionInfoByMessageId).catch(() => undefined);
      } else if (storeAmbient) {
        await persistMentionedRound(items, "ambient", mentionInfoByMessageId).catch(() => undefined);
      }
      return;
    }

    // Only after the zero-cost gate and reply quota: at most four unique targets,
    // resolved concurrently, with window hits preferred over short same-room get_msg reads.
    type QuotePolicy = { kind: "AI" | "HUMAN" | "UNKNOWN"; policy: "DEFAULT" | "ALLOW" | "BLOCK" };
    const quotePolicies = new Map<string, Promise<QuotePolicy>>();
    const quotePolicyFor = (uid: string): Promise<QuotePolicy> => {
      if (uid === selfQq || uid === record.ownerQq) return Promise.resolve({ kind: "HUMAN", policy: "ALLOW" });
      if (identityByUid.has(uid)) return Promise.resolve(identityByUid.get(uid)!);
      if (!quotePolicies.has(uid)) quotePolicies.set(uid, (async () => {
        try {
          const identity = await prisma.externalIdentity.findUnique({
            where: { platform_platformUid: { platform: ONEBOT_PLATFORM, platformUid: uid } },
            select: { kind: true, memoryScopes: { where: { characterId: binding.characterId, scopeType: "EXTERNAL_IDENTITY" }, take: 1, select: { friendChatPolicy: true } } },
          });
          return { kind: identity?.kind ?? "UNKNOWN", policy: identity?.memoryScopes[0]?.friendChatPolicy ?? "DEFAULT" };
        } catch { return { kind: "UNKNOWN", policy: "BLOCK" }; }
      })());
      return quotePolicies.get(uid)!;
    };
    const quotedByMessageId = await resolveOnebotGroupQuotes(record.config, items.map(item => ({ ...item.event, selfId: item.event.selfId || record.accountQq })), {
      cached: id => {
        const value = groupContext.quoteOf(contextKey, id);
        return value ? { messageId: value.id, authorQq: value.authorQq, speaker: value.speaker, content: value.text, isSelf: value.isSelf } : undefined;
      },
      resolveGeneratedImage: async messageId => (await findGeneratedImageAsset(prisma, {
        characterId: binding.characterId, bindingId: binding.id, externalConversationId: groupEvent.conversationKey,
      }, messageId))?.facts ?? null,
      canReadAuthor: async uid => { const policy = await quotePolicyFor(uid); return !shouldHideFriendContent(policy.kind, policy.policy); },
      authorPolicy: quotePolicyFor,
      formatText: text => groupContext.formatText(contextKey, text),
      memberCode: uid => uid === selfQq ? "self" : groupContext.memberCode(contextKey, uid),
      remember: (messageId, quoted) => groupContext.rememberQuote(contextKey, messageId, { id: quoted.messageId,
        ...(quoted.content ? { text: quoted.content } : {}), ...(quoted.member ? { member: quoted.member } : {}),
        ...(quoted.speaker ? { speaker: quoted.speaker } : {}), ...(quoted.isSelf !== undefined ? { isSelf: quoted.isSelf } : {}),
        ...(quoted.authorQq ? { authorQq: quoted.authorQq } : {}),
        ...(quoted.kind ? { kind: quoted.kind } : {}),
        ...(quoted.readOnly ? { readOnly: true as const } : {}),
        ...(quoted.excludeFromGrowth ? { excludeFromGrowth: true as const } : {}),
      }),
    });
    const currentIds = items.map((item) => item.event.messageId);
    const result = await handleChannelBatch({
      platform: ONEBOT_PLATFORM,
      characterId: binding.characterId,
      bindingId: binding.id,
      eventType: "GROUP_MESSAGE",
      externalConversationId: groupEvent.conversationKey,
      messages: items.map((item, index) => ({
        externalMessageId: item.event.messageId,
        authorOpenId: item.event.userId,
        authorPlatformUid: item.event.userId,
        kind: kindFor(item),
        ...(kindFor(item) === "AI" ? { excludeFromGrowth: true as const } : {}),
        ...(item.event.displayName ? { authorDisplayName: item.event.displayName } : {}),
        content: item.event.content,
        commandText: readOnebotAddressedCommandText(item.event.data, [binding.characterName, ...binding.groupChat.aliases]).commandText,
        addressedToSelf: item.direct || readOnebotAddressedCommandText(item.event.data, [binding.characterName, ...binding.groupChat.aliases]).namedAddressed,
        quotedToSelf: quotedByMessageId.get(item.event.messageId)?.isSelf === true,
        // 谁被 @ 了：落库给提炼用 —— 「@ 的是别的 bot」这类事不能再记成她的事。
        ...(facts[index]?.mentionTargets.length ? { mentionTargets: facts[index]!.mentionTargets } : {}),
        // 被 @ 的是谁：代号 + 显示名 + 身份，语境助手、最终回复与长期记忆共用这一份。
        ...(mentionInfoByMessageId.get(item.event.messageId)?.length
          ? { mentions: mentionInfoByMessageId.get(item.event.messageId)! }
          : {}),
        // 他引用的是哪一句：模型要能看出「这句是在接谁的话」，而不是只看到正文。
        ...(quotedByMessageId.has(item.event.messageId)
          ? { quotedMessage: quotedByMessageId.get(item.event.messageId)! }
          : {}),
        // 入模的正文把 @ 换成代号；落库仍是原样。
        promptContent: groupContext.formatText(contextKey, item.event.content),
        member: groupContext.memberCode(contextKey, item.event.userId),
        // 主人发的消息带上 isOwner：群聊里也认得出主人，落库与提炼时标「主人」。
        ...(item.isOwner ? { speaker: { isOwner: true } } : {}),
        ...(item.event.images.length ? { images: item.event.images } : {}),
        observedMedia: observeOnebotMedia(readOnebotMedia(item.event.data)),
        imageTextParts: readOnebotMessageParts(item.event.data),
        promptImageTextParts: readOnebotMessageParts(item.event.data).map(part => part.type === "text"
          ? { ...part, text: groupContext.formatText(contextKey, part.text) } : part),
        ...(item.event.voices.length ? { voices: item.event.voices } : {}),
        occurredAt: new Date(item.at),
      })),
      // 被身份策略过滤的消息不进模型/消息正文，但仍只登记为群成员，不记录内容。
      memberObservations: originalItems.map((item) => ({
        externalMessageId: item.event.messageId,
        authorOpenId: item.event.userId,
        authorPlatformUid: item.event.userId,
        ...(item.event.displayName ? { authorDisplayName: item.event.displayName } : {}),
        content: item.event.content,
        occurredAt: new Date(item.at),
      })),
      faceCatalog: ONEBOT_FACES,
      // 她自己的表情包：清单非空时优先于内置表情（空清单 = 这个角色还没传过图）。
      stickerCatalog: await loadStickerCatalog(binding.characterId),
      // 声明「本渠道能发语音条」：能不能真发由角色开关和判定决定。
      voiceCapable: true,
      // 声明「本渠道能把图发出去」：她画的图走 image 段，与表情包同一条路。
      imageCapable: true,
      // QQ 的说话习惯就是一句一句弹：声明之后，她可以靠换行把回复拆成几条。
      segmentCapable: true,
      // 只有真实 @ 与 all 档不允许「想了想还是不说」。
      allowSilent: !gate.mustReply,
      group: {
        direct,
        background: backgroundLines.filter((line) => !excludedContextIds.has(line.id)),
        analysisBackground: analysisBackgroundLines.filter((line) => !excludedContextIds.has(line.id)),
        anchors: groupContext.anchors(contextKey, excludedContextIds),
        // 谁是谁的人：让她判断「我的鱼」「我家宝」时能查表，而不是猜自己。
        members: groupContext.members(contextKey, blockedSpeakerUids),
        // 「谁在跟她说话」的统计要用：@ 的是这个号、叫的是这些名字，才算冲她说的。
        resolveMember: (qq) => blockedSpeakerUids.has(qq) ? null : ({ member: qq === record.accountQq ? "self" : groupContext.memberCode(contextKey, qq) }),
        selfQq: record.accountQq,
        ownerQq: record.ownerQq,
        selfNames: [binding.characterName, ...binding.groupChat.aliases],
      },
      sendReply: createReplySender(record.config, groupEvent, {
        // 模型点名的是某条消息（id），这里翻成那句的真实 QQ 号 —— transcript 里不出现账号。
        resolveAtQq: (messageId) => {
          const uid = groupContext.senderOf(contextKey, messageId, 15 * 60_000);
          return uid && !blockedSpeakerUids.has(uid) ? uid : null;
        },
        selfQq: record.accountQq,
      }),
    });

    if (result.status === "replied" || result.status === "silent") {
      await prisma.conversation.updateMany({
        where: { channelBindingId: binding.id, externalConversationId: groupEvent.conversationKey },
        data: {
          consecutiveAiRounds: nextConsecutiveAiRounds(
            conversation?.consecutiveAiRounds ?? 0,
            roundIdentityKinds,
          ),
        },
      }).catch((error) => {
        console.error("[onebot] 更新连续 AI 对话计数失败：", error instanceof Error ? error.message : String(error));
      });
    }
    if (result.status === "replied") {
      groupContext.recordReply(contextKey, facts, { source: direct ? "mention" : "ambient" });
      groupActivity.spoke({
        bindingId: binding.id,
        characterId: binding.characterId,
        conversationId: groupEvent.conversationKey,
        groupId: groupEvent.groupId,
      });
    } else if (result.status === "silent" && result.groupDecision) {
      // 沉默但认得出「还是在聊那个话题」：有界地续一下，不新建。
      groupContext.refreshFromDecision(contextKey, result.groupDecision);
    }
    // ignored 一定要带上原因：只写「ignored」时分不清是额度用完、模型没配、还是她不想说话，
    // 而这三种在群里的表现完全一样——她一句话都不说，查起来只能靠猜。
    logGroupRound(groupEvent.groupId, {
      reason: gate.reason,
      status: result.status === "ignored" ? `ignored:${result.reason}` : result.status,
      messages: items.length,
      direct,
      topics: groupContext.activeTopicCount(contextKey),
      ...(poked ? { poked } : {}),
    });
  };

  const groupChatBuffer = createGroupChatBuffer<PendingGroupMessage>({
    onFlush: async (key, items) => {
      await enqueueConversation(key, () => flushGroupRound(items));
    },
  });

  const handleRoutedEvent = async (
    event: OnebotResolvedEvent,
    binding: OnebotBindingRecord,
  ): Promise<OnebotHandleOutcome> => {
    const sendReply = createReplySender(record.config, event);

    // Isolate roleplay before daily storage and growth.
    if (event.messageType === "private") {
      const roleplayResult = await handleRoleplayChannel({
        platform: ONEBOT_PLATFORM,
        eventType: "PRIVATE_MESSAGE",
        characterId: binding.characterId,
        bindingId: binding.id,
        externalConversationId: event.conversationKey,
        externalMessageId: event.messageId,
        authorUid: event.userId,
        content: event.content,
        sendReply,
      });
      if (roleplayResult) return roleplayResult;
    }

    const canManageAnnouncement = record.groupAnnouncementEnabled
      && event.messageType === "group"
      && Boolean(event.groupId)
      && event.senderRole !== "member";

    const isOwnerEvent = Boolean(record.ownerQq) && event.userId === record.ownerQq;

    // 确认发布允许不带 @：管理员刚看完草稿，回一句「确认发布」就够了。
    if (canManageAnnouncement && isAnnouncementConfirm(event.content)) {
      return handleAnnouncementConfirm(record, event, binding, sendReply);
    }

    const isGroupMessage = event.messageType === "group" && Boolean(event.groupId);
    // 这一条所在的群如果有单独设置，就用它自己那一档；没有才沿绑定的默认档。
    const groupChat = groupChatForGroup(binding.groupChat, binding.groupChatModes, event.groupId);
    const groupChatMode = groupChat.mode;
    /**
     * 两个信号必须分开：真实 @ 是程序事实，名字只是弱线索（群里可能有好几条同款鱼）。
     *
     * 戳一戳也算「叫她」：用户的实际用法就是「她没接话，我戳她一下让她开口」——
     * 相比催人打字，这是群里最轻的提醒方式。解析侧已经把「戳的不是她」丢掉了，
     * 所以走到这里的 `event.poke` 一律是戳她本人。
     */
    const direct = isGroupMessage && (event.poke !== undefined || isSelfMentioned(event, record.accountQq));
    const named = isGroupMessage && mentionsCharacterName(event.content, cueNames(binding));
    const contextKey = `${binding.id}:${event.conversationKey}`;

    // facts 只解析一次（P3）：remember、mention 档早退、攒批入队用的是同一份。
    // 对群消息总是解析（哪怕正文为空），remember 仍只记有正文的。
    const receivedAt = Date.now();
    const facts = isGroupMessage ? factsOf(event, receivedAt) : null;
    let speakerKind: "UNKNOWN" | "HUMAN" | "AI" = isOwnerEvent ? "HUMAN" : "UNKNOWN";
    let speakerPolicy: "DEFAULT" | "ALLOW" | "BLOCK" = isOwnerEvent ? "ALLOW" : "DEFAULT";

    if (isGroupMessage && event.userId.trim()) {
      // 只读已有关系，不建档：关系行只在她真的回过这个人之后才由记账链路创建，
      // 群里没被搭理的发言不该出现在好友档案里。没聊过的人按未知身份 + 默认策略处理。
      const identity = isOwnerEvent
        ? null
        : await readGroupMemberProfile({
            characterId: binding.characterId,
            platform: ONEBOT_PLATFORM,
            platformUid: event.userId.trim(),
          });
      if (identity) {
        speakerKind = identity.kind;
        speakerPolicy = identity.friendChatPolicy;
      }

      if (facts) {
        facts.kind = speakerKind;
        if (speakerKind === "AI") facts.excludeFromGrowth = true;
      }
      // 只统计群里发生了什么；屏蔽只影响她看见的语境和是否回复。
      if (event.content) {
        groupActivity.record({
          bindingId: binding.id,
          characterId: binding.characterId,
          conversationId: event.conversationKey,
          groupId: event.groupId,
          at: receivedAt,
          speaker: event.displayName,
          // 仍刷新群活跃时间，但不把被禁止对象的正文写入群活跃度摘要。
          text: shouldBlockFriendSpeaker(speakerKind, speakerPolicy) ? "" : event.content,
        });
      }

      // 先在入口过滤：被禁止的对象不参与对话，也不能通过 @ 绕过。
      if (shouldBlockFriendSpeaker(speakerKind, speakerPolicy)) {
        if (facts && event.content && isReadOnlyFriendContent(speakerKind, speakerPolicy)) {
          groupContext.remember(contextKey, { ...facts, kind: "AI", readOnly: true, excludeFromGrowth: true });
        }
        return { status: "ignored", reason: "friend_policy_blocked" };
      }

      // 真人重新参与就解除 bot-to-bot 连聊保护。放进同一会话队列，保证先于这一条消息的 flush。
      if (speakerKind === "HUMAN") {
        void enqueueConversation(contextKey, async () => {
          await getPrisma().conversation.updateMany({
            where: {
              channelBindingId: binding.id,
              externalConversationId: event.conversationKey,
            },
            data: { consecutiveAiRounds: 0 },
          });
        }).catch((error) => {
          console.error("[onebot] 重置连续 AI 对话计数失败：", error instanceof Error ? error.message : String(error));
        });
      }
    }

    // 先进短期上下文：只记允许参与的发言；后续被闸门拒绝的消息仍可作为背景。
    if (isGroupMessage && event.content && facts) {
      groupContext.remember(contextKey, { ...facts, kind: speakerKind,
        ...(speakerKind === "AI" ? { excludeFromGrowth: true as const } : {}) });
    }

    /**
     * 仅 @ 档里，非 @ 她的群消息不会进攒批（下面 `requiresMention` 直接早退），
     * 也就永远没机会在 `flushGroupRound` 里补存。想让「她刚才听到了什么」可检索，
     * 只能在这里落一条 `ambient`。
     *
     * 只在 mention 档、且这一条既不是 @ 她也不是主人说的时写：这种消息按档位定义
     * 不会触发回复，不会和 `replied` 抢同一行；ambient 档/all 档的拒绝批次由
     * `flushGroupRound` 统一补存，避免重复插入后把证据行降级成 48 小时上下文。
     */
    if (isGroupMessage && groupChatMode === "mention" && !direct && !isOwnerEvent
      && event.content && facts
      && shouldStoreAmbientGroupMessage(binding.storeAmbientGroupMessages, event.groupId)) {
      void persistMentionedRound(
        [{ event, binding, at: receivedAt, direct: false, named: false, isOwner: false, facts }],
        "ambient",
      ).catch((error) => {
        console.warn("[onebot] 群聊原文留存失败：", error instanceof Error ? error.message : String(error));
      });
    }

    // 仅 @ 模式下，名字与活跃话题只作为背景，不能触发普通回复或发起指令。
    // 主人的普通发言仍进攒批保存上下文，由整轮闸门拒绝无点名的回复。
    const requiresMention = isGroupMessage && groupChatMode === "mention" && !direct;
    if (requiresMention && !isOwnerEvent) return { status: "ignored", reason: "not_mentioned" };
    const ownerContextOnly = requiresMention && isOwnerEvent;

    if (!event.content) return { status: "ignored", reason: "missing_fields" };

    /**
     * 静默档的开关。
     *
     * 谁能按：群主 / 管理员 / 主人。普通群友喊「闭嘴」不生效 —— 一句玩笑让人消失十分钟，
     * 比多回一句难解释得多。
     *
     * 怎么算「冲她说的」：真实 @、叫到名字，或这一条就是刚才那轮的接话。最后一条这里
     * 拿不到（要看她上次开口的时刻，在 flush 里才查），所以留到一条都不满足时不触发，
     * **宁可漏一次，不要误伤**：用户真在意时会再 @ 一次。
     *
     * 触发之后**不让这条消息就此消失**：它照常进攒批，在 flush 里被 `muted` 挡下，
     * 只落库、不调模型 —— 这就是「只听不说」。
     */
    if (isGroupMessage && (direct || named)) {
      const canCommandMute = event.userId === record.ownerQq || event.senderRole !== "member";
      if (canCommandMute) {
        if (groupMute.isMuted(contextKey)) {
          if (isResumeRequest(event.content)) {
            groupMute.unmute(contextKey);
            logGroupRound(event.groupId!, { reason: "mute_off" });
          }
        } else if (isQuietRequest(event.content)) {
          groupMute.mute(contextKey);
          logGroupRound(event.groupId!, {
            reason: "mute_on",
            seconds: GROUP_MUTE_MS / 1000,
            byOwner: event.userId === record.ownerQq,
          });
        }
      }
    }

    // 普通主人上下文不能借 mention 旁路触发群公告指令。
    if (!ownerContextOnly && canManageAnnouncement) {
      const request = parseAnnouncementRequest(event.content);
      if (request) return handleAnnouncementDraft(record, event, binding, request.topic, sendReply);
    }

    // 群聊统一走一条攒批管道：三档只决定「放不放进来」，不再有单条快速路径。
    // 指令类（公告）已经在上面的分支里返回，不会走到这里。
    if (isGroupMessage) {
      groupChatBuffer.push(
        contextKey,
        // 群消息到这里 facts 必已解析（上面 isGroupMessage 分支统一构造）。
        { event, binding, at: receivedAt, direct, named, isOwner: isOwnerEvent, facts: facts! },
        groupChatWindowMs(groupChat, direct || named),
      );
      // 带上 poke 标记：日志里「为什么这一轮是 direct」要能看出是被人戳醒的，不是被 @ 的。
      return { status: "buffered", ...(event.poke ? { poke: true } : {}) };
    }

    // 私聊：单条直接回，行为不变。lastEventAt 已在事件入口更新，这里不重复写。
    const ownerDisplayName = await resolveOwnerDisplayName(record, event);
    const speaker = record.ownerQq
      ? {
          ...(event.displayName ? { displayName: event.displayName } : {}),
          isOwner: event.userId === record.ownerQq,
          ...(ownerDisplayName ? { ownerDisplayName } : {}),
        }
      : undefined;

    const quotedMessage = await resolveOnebotPrivateQuote(record.config, event, {
      resolveGeneratedImage: async messageId => (await findGeneratedImageAsset(getPrisma(), {
        characterId: binding.characterId, bindingId: binding.id, externalConversationId: event.conversationKey,
      }, messageId))?.facts ?? null,
    });
    return handleChannelMessage({
      ...(quotedMessage ? { quotedMessage } : {}),
      platform: ONEBOT_PLATFORM,
      ...(speaker ? { speaker } : {}),
      characterId: binding.characterId,
      bindingId: binding.id,
      eventType: "PRIVATE_MESSAGE",
      externalConversationId: event.conversationKey,
      externalMessageId: event.messageId,
      authorOpenId: event.userId,
      authorPlatformUid: event.userId,
      authorDisplayName: event.displayName || undefined,
      content: event.content,
      commandText: readOnebotAddressedCommandText(event.data, [binding.characterName, ...binding.groupChat.aliases]).commandText,
      addressedToSelf: true,
      quotedToSelf: quotedMessage?.isSelf === true,
      ...(event.images.length ? { images: event.images } : {}),
      observedMedia: observeOnebotMedia(readOnebotMedia(event.data)),
      imageTextParts: readOnebotMessageParts(event.data),
      ...(event.voices.length ? { voices: event.voices } : {}),
      // QQ 是唯一能发表情的渠道；清单非空即声明能力，是否真发还要过角色开关和冷却。
      faceCatalog: ONEBOT_FACES,
      stickerCatalog: await loadStickerCatalog(binding.characterId),
      // 私聊同样能发语音条：语音在私聊里比在群里更合适（一对一，不用怕刷屏）。
      voiceCapable: true,
      // 私聊也能发图：她画的东西更适合一对一发。
      imageCapable: true,
      // 私聊更是「一句一句弹」的地方，模板里那些短回复就是这么来的。
      segmentCapable: true,
      sendReply,
    });
  };

  return async (event: OnebotResolvedEvent): Promise<OnebotHandleOutcome> => {
    // 事件一到就更新活性：mention 档早退、没有绑定，都算「这个连接还活着」。
    touchLastEventAt();
    const binding = routeOnebotEventToBinding(record.bindings, event);
    if (!binding) return { status: "ignored", reason: "no_binding" };
    if (event.messageType === "group" && event.groupId) {
      const key = `${binding.id}:${event.conversationKey}`;
      const content = event.poke ? event.content : readOnebotRoleplayText(event.data, event.selfId || record.accountQq);
      const command = parseRoleplayCommand(content);
      const replayInput = { platform: ONEBOT_PLATFORM, eventType: "GROUP_MESSAGE", characterId: binding.characterId, bindingId: binding.id, externalConversationId: event.conversationKey, externalMessageId: event.messageId, authorUid: event.userId, content };
      const knownReplay = !command ? await findRoleplayChannelReplay(replayInput) : null;
      if (command) roleplayTransitions.set(key, (roleplayTransitions.get(key) ?? 0) + 1);
      try {
        const active = command || knownReplay || roleplayTransitions.has(key) || await getPrisma().roleplayRoute.findUnique({
          where: { bindingId_externalConversationId: { bindingId: binding.id, externalConversationId: event.conversationKey } }, select: { id: true },
        });
        if (active) return await enqueueConversation(key, async () => {
          // Re-read inside the queue: an earlier switch/exit can change this event's destination.
          const route = await getPrisma().roleplayRoute.findUnique({ where: { bindingId_externalConversationId: { bindingId: binding.id, externalConversationId: event.conversationKey } }, select: { id: true, sessionId: true } });
          const replay = !command ? await findRoleplayChannelReplay(replayInput) : null;
          if (replay && replay.sessionId !== route?.sessionId) return { status: "duplicate" };
          if (!command && !route) return handleRoutedEvent(event, binding);
          const addressed = event.poke !== undefined || isSelfMentioned(event, record.accountQq);
          if (route && !command && !content.trim()) return { status: "ignored", reason: "missing_fields" };
          const isOwner = Boolean(record.ownerQq) && event.userId === record.ownerQq;
          if (command && !isOwner) return { status: "ignored", reason: "roleplay_owner_only" };
          if (route && !command && addressed) {
            if (!isOwner) {
              const identity = await getPrisma().externalIdentity.findUnique({
                where: { platform_platformUid: { platform: ONEBOT_PLATFORM, platformUid: event.userId } },
                select: { kind: true, memoryScopes: { where: { characterId: binding.characterId }, select: { friendChatPolicy: true }, take: 1 } },
              });
              if (shouldBlockFriendSpeaker(identity?.kind ?? "UNKNOWN", identity?.memoryScopes[0]?.friendChatPolicy ?? "DEFAULT")) return { status: "ignored", reason: "friend_policy_blocked" };
            }
            if (isOwner || event.senderRole !== "member") {
              if (groupMute.isMuted(key) && isResumeRequest(content)) groupMute.unmute(key);
              else if (isQuietRequest(content)) groupMute.mute(key);
            }
            if (groupMute.isMuted(key)) return { status: "ignored", reason: "roleplay_group_muted" };
            // A completed turn may need transport retry; it is not a new generation.
            if (!replay?.completed) {
              if (await isGroupReplyLimited(binding, event)) return { status: "ignored", reason: "group_reply_limit" };
              const settings = groupChatForGroup(binding.groupChat, binding.groupChatModes, event.groupId);
              if (settings.dailyMax > 0) {
                const since = groupChatDayStart();
                const [daily, stories] = await Promise.all([
                  getPrisma().message.count({ where: { role: "ASSISTANT", occurredAt: { gte: since }, conversation: { channelBindingId: binding.id, externalConversationId: event.conversationKey } } }),
                  getPrisma().roleplayMessage.count({ where: { role: "assistant", source: "qq-group", createdAt: { gte: since }, session: { groupBindingId: binding.id, groupConversationId: event.conversationKey } } }),
                ]);
                if (daily + stories >= settings.dailyMax) return { status: "ignored", reason: "daily_limit" };
              }
              const character = await getPrisma().character.findUnique({ where: { id: binding.characterId }, select: { modelConfig: true } });
              if (character && (await readDailyQuota(binding.characterId, character.modelConfig)).exceeded) return { status: "ignored", reason: "daily_quota_exceeded" };
            }
          }
          const result = await handleRoleplayChannel({
            platform: ONEBOT_PLATFORM, eventType: "GROUP_MESSAGE", characterId: binding.characterId,
            bindingId: binding.id, externalConversationId: event.conversationKey, externalMessageId: event.messageId,
            authorUid: event.userId, content, addressed, sendReply: createReplySender(record.config, event),
          });
          return result ?? handleRoutedEvent(event, binding);
        });
      } finally {
        if (command) {
          const left = (roleplayTransitions.get(key) ?? 1) - 1;
          if (left > 0) roleplayTransitions.set(key, left); else roleplayTransitions.delete(key);
        }
      }
    }
    /**
     * 图片直链可能不在推送事件里（只有 `file`）：缺就回查一次。
     *
     * 放在路由之后、两条路（群聊攒批 / 私聊单条）分叉之前 —— 这里改一次，
     * 群聊和私聊都拿到补好的直链，不用各写一遍。
     */
    if (event.images.length && event.images.some((image) => !image.url)) {
      const missing = event.images.filter((image) => !image.url).length;
      event.images = await fillOnebotImageUrls(record.config, event.messageId, event.images);
      const usable = event.images.filter((image) => image.url).length;
      // 这行出现就说明「推送事件里没带直链」这个假设成立；补齐失败时它会留在这里当证据。
      console.warn(`[vision] 事件里的图缺直链 ${missing} 张，回查后可用 ${usable} 张（message=${event.messageId}）`);
    }
    /**
     * 普通群聊消息走快速通道：直接登记，不排队。
     *
     * 以前所有事件都排进下面这个队列，而队列前面可能是一个正在等模型的 flush
     * （几十秒）。群消息排到队时早已超过 `QUEUE_STALE_MS`，被整条丢掉 ——
     * 连 `remember()` 都没执行，它既不进攒批，也不进短期上下文，等于这段时间
     * 群里说的话她完全看不见；@ 她的那句也一样丢。模型越慢，丢得越多。
     *
     * 登记（remember + push）是同步的，不需要排队；需要串行的是「处理」，
     * flush 在 `onFlush` 里自己排队。指令（公告/空间）仍走队列，保持串行。
     */
    if (event.messageType === "group" && event.groupId && !isGroupCommandMessage(event, binding)) {
      return handleRoutedEvent(event, binding);
    }
    const queuedAt = Date.now();
    return enqueueConversation(`${binding.id}:${event.conversationKey}`, async () => {
      /**
       * 排队超时只丢群指令，不丢私聊。
       *
       * 私聊要「先落库、尽量全留」：排队等太久时回不回可以再判，但这句话不能因为
       * 前面一轮在等模型就整条消失。群指令（公告/空间）仍然按过期丢弃 —— 过了那一刻，
       * 在群里回一句旧指令只会让人莫名其妙。
       */
      if (event.messageType === "group" && Date.now() - queuedAt > QUEUE_STALE_MS) {
        return { status: "ignored", reason: "stale_in_queue" };
      }
      return handleRoutedEvent(event, binding);
    });
  };
}
