/**
 * QQ 小号（OneBot v11）渠道的消息处理 —— 对应官方 QQ 的 serve.ts。
 *
 * 把 OneBot 消息事件路由到绑定角色，走通用流水线，再把回复通过 OneBot HTTP API 发回。
 * 群聊默认仅在被 @ 时回复（replyOnlyWhenMentioned），私聊总是回复。
 */

import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { getPrisma } from "../../prisma";
import { loadStickerCatalog, MAX_STICKER_BYTES } from "../../stickers";
import type { OnebotConnectionConfig, OnebotOutgoingMessage, OnebotResolvedEvent } from "./client";
import type { OnebotSegment } from "./types";
import { sendOnebotCustomFace, sendOnebotGroupMessage, sendOnebotPrivateMessage } from "./client";
import { parseBindingRoutingKeys, type OnebotBindingRecord, type OnebotConnectionRecord } from "./configure";
import { ONEBOT_FACES, toOnebotFaceSegments } from "./faces";
import { handleChannelBatch, handleChannelMessage, type ChannelReplySender } from "../pipeline";
import { loadBiliConnections } from "../bili/configure";
import { runDutyRound, type BiliDutyRoundResult } from "../bili/duty-pipeline";
import { isBiliRunCommand } from "./bili-run";
import {
  createGroupChatBuffer,
  evaluateGroupChatGate,
  groupChatDayStart,
  groupChatForGroup,
  groupChatWindowMs,
  isClarificationMessage,
  mentionsCharacterName,
} from "./group-chat";
import { createGroupContext, type GroupMessageFacts } from "./group-context";
import { createGroupActivityRecorder } from "../../group-activity";
import { ONEBOT_PLATFORM, readOnebotMentionQqs, readOnebotMentionTargets, readOnebotReplyToId } from "./types";
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

// 解析函数挪去了 configure.ts（绑定配置的地盘），这里重新导出保持既有引用可用。
export { parseBindingRoutingKeys };

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
  const data = event.data as { message?: unknown } | null;
  const message = data?.message;
  if (!Array.isArray(message)) {
    // 非数组时退回检查文本里的 @selfId
    return event.content.includes(`@${selfId}`);
  }
  for (const segment of message) {
    if (!segment || typeof segment !== "object") continue;
    const seg = segment as { type?: unknown; data?: { qq?: unknown } | null };
    if (seg.type === "at" && seg.data?.qq !== undefined) {
      if (String(seg.data.qq) === selfId) return true;
    }
  }
  return false;
}

/** 已处理的群指令消息 id，防止 QQ 网关重复投递导致连刷两轮。 */
const processedBiliRunCommands = new Set<string>();
/** 正在跑 B站 的角色；同一角色不并发跑两轮。 */
const biliRunInFlight = new Set<string>();

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

function rememberBiliRunCommand(messageId: string) {
  processedBiliRunCommands.add(messageId);
  if (processedBiliRunCommands.size > 500) {
    const oldest = processedBiliRunCommands.values().next().value;
    if (oldest) processedBiliRunCommands.delete(oldest);
  }
}

function summarizeBiliRound(result: BiliDutyRoundResult): string {
  if (!result.ok) return `这轮没刷成：${result.error ?? "未知原因"}`;
  if (result.picked === 0) {
    return result.error ? `这轮没刷成：${result.error}` : "刷完了，这轮没有挑中新视频。";
  }
  const parts = [`刷完了：挑中 ${result.picked} 条，跳过 ${result.skipped} 条`];
  if (result.delivered.comments > 0) parts.push(`评论 ${result.delivered.comments} 条`);
  if (result.delivered.fav > 0) parts.push(`收藏 ${result.delivered.fav} 条`);
  if (result.delivered.dynamic) parts.push("发了动态");
  const lines = [parts.join("，") + "。"];
  // 只回条数等于没评价。把挑中的标题、分数、理由带回来，主人不用再翻值班台。
  for (const item of result.pickedItems.slice(0, 3)) {
    const score = item.score !== null ? `${item.score} 分` : "未评分";
    const reason = item.reason.trim().slice(0, 48);
    lines.push(`· 《${item.title.slice(0, 30)}》${score}${reason ? `：${reason}` : ""}`);
  }
  if (result.picked > 3) lines.push(`· 还有 ${result.picked - 3} 条，详见 B站 值班台。`);
  return lines.join("\n");
}

/** 主人让鱼刷一轮 B站：先回执，再在后台跑；同一角色不并发。 */
async function handleBiliRunCommand(
  event: OnebotResolvedEvent,
  characterId: string,
  sendReply: (text: string) => Promise<void>,
): Promise<OnebotHandleOutcome> {
  if (processedBiliRunCommands.has(event.messageId)) return { status: "duplicate" };
  rememberBiliRunCommand(event.messageId);

  if (biliRunInFlight.has(characterId)) {
    await sendReply("上一轮 B站 还在跑，等它结束再说。");
    return { status: "replied", conversationId: "" };
  }

  let target: Awaited<ReturnType<typeof loadBiliConnections>>[number] | null = null;
  let binding: { id: string; characterId: string } | null = null;
  try {
    const connections = await loadBiliConnections();
    for (const connection of connections) {
      const found = connection.bindings.find((item) => item.characterId === characterId);
      if (found) {
        target = connection;
        binding = found;
        break;
      }
    }
  } catch (error) {
    await sendReply(`读 B站 配置失败：${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`);
    return { status: "replied", conversationId: "" };
  }

  if (!target || !binding) {
    await sendReply("这个角色还没绑定 B站 值班账号，先到「B站 值班台」绑定后再试。");
    return { status: "replied", conversationId: "" };
  }

  const connection = target;
  const biliBinding = binding;
  biliRunInFlight.add(characterId);
  await sendReply("收到，我去刷一轮 B站，刷完在群里说。");
  void (async () => {
    try {
      const result = await runDutyRound(connection, biliBinding);
      await sendReply(summarizeBiliRound(result));
    } catch (error) {
      await sendReply(`这轮没刷成：${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`).catch(() => undefined);
    } finally {
      biliRunInFlight.delete(characterId);
    }
  })();
  return { status: "replied", conversationId: "" };
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
  return recentReplies >= binding.replyLimitPerWindow;
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
  sendReply: (text: string) => Promise<void>,
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
  sendReply: (text: string) => Promise<void>,
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
 * 把正文和可选的「引用回复」「@ 原文作者」拼成出站消息。
 *
 * 群聊里多条鱼并存时，引用让「我接的是哪一句」不再靠猜：模型给的 replyToMessageId
 * 是 transcript 里那条消息的 QQ 真实 message id，这里转成 OneBot reply 段拼在正文前。
 * id 必须是纯数字（QQ message id），否则退回纯文本 —— 宁可少引一次，也不发坏段。
 *
 * 引用之后还要 @ 原文作者：QQ 的引用块只是把原文贴出来，被回的人**收不到提醒**，
 * 只有 `at` 段才会让他那边亮红点。少了这一段的表现正是「引用了，但没 @ 人」。
 * 顺序固定 reply → at → text：QQ 客户端把 @ 显示在正文开头，先回引用再叫名字。
 */
export function buildQuoteSegments(replyToMessageId?: string, atQq?: string | null): OnebotSegment[] {
  const segments: OnebotSegment[] = [];
  if (replyToMessageId && /^\d+$/.test(replyToMessageId)) {
    segments.push({ type: "reply", data: { id: replyToMessageId } });
  }
  if (atQq && /^\d+$/.test(atQq)) {
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
const VOICE_OUT_DIR = resolve(process.cwd(), ".data", "voice-out");
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


function createReplySender(
  config: OnebotConnectionConfig,
  target: Pick<OnebotResolvedEvent, "messageType" | "groupId" | "userId" | "tempGroupId">,
  /**
   * 引用回复要 @ 原文作者，但模型手上只有 message id（提示词里不能出现真实账号），
   * 所以真实 QQ 号由这里按 id 现查。`selfQq` 用来挡掉「引用自己发的」那种情况 ——
   * 自己叫自己名字很傻。只有群聊会传，私聊没有 @ 这回事。
   */
  quote?: { resolveAtQq?: (messageId: string) => string | null; selfQq?: string },
): ChannelReplySender {
  return async (reply, options) => {
    const send = (message: OnebotOutgoingMessage): Promise<void> => {
      if (target.messageType === "group" && target.groupId) {
        return sendOnebotGroupMessage(config, target.groupId, message);
      }
      if (target.userId) {
        // 临时会话要带来源群，否则协议端拒绝 —— 回复会「生成成功但发不出去」。
        return sendOnebotPrivateMessage(config, target.userId, message, target.tempGroupId || undefined);
      }
      return Promise.resolve();
    };

    /**
     * 该 @ 谁：只在模型明确「点名」时（`options.atMessageId` 指向某人的一句话）。
     *
     * 不再跟着引用走 —— 「凡引用必 @」是上一版的写法，群里每条回复都弹一次提醒，
     * 用户的原话是「经常 @ 也不好」。引的是她自己发的也不 @（自己叫自己名字很傻）。
     */
    const atQq = (): string | null => {
      const atMessage = options?.atMessageId;
      if (!atMessage || target.messageType !== "group" || !quote?.resolveAtQq) return null;
      const qq = quote.resolveAtQq(atMessage);
      if (!qq || qq === quote.selfQq) return null;
      return qq;
    };

    // 语音条替代正文：发了语音就不再补一条文字，否则同一句话会被说两遍。
    // 合成失败则原样发文字 —— 语音失败绝不能变成「这轮她没说话」。
    if (options?.voice && options.voiceSettings) {
      const silk = await synthesizeSpeechSilk(reply, options.voiceSettings);
      if (silk?.length) {
        // 语音条同样要带引用和 @：只发语音不带这两段，被回的人根本不知道是在跟他说话。
        // 一次算好：既给 `withQuote` 用，也给下面那行日志用（结果只取决于 options）。
        const atTarget = atQq();
        const withQuote = (segments: OnebotSegment[]): OnebotSegment[] =>
          [...buildQuoteSegments(options.replyToMessageId, atTarget), ...segments];

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
            await send(withQuote(buildVoiceSegment(attempt.file)));
            /**
             * `quoted` 单独记：带引用的语音在 QQ 里是「引用框里嵌一条语音」，
             * 渲染本来就不如纯语音稳。日后有人报「发不出去」，先看这一项 ——
             * `quoted:true` 又确实发出去了，那就是客户端/服务端展示的问题，
             * 不是没发；反过来就得继续查发送。
             */
            console.log("[onebot] 语音已发送 " + JSON.stringify({
              via: attempt.via,
              bytes: silk.length,
              quoted: Boolean(options.replyToMessageId),
              at: Boolean(atTarget),
            }));
            return;
          } catch (error) {
            console.error(`[onebot] 语音发送失败（${attempt.via}）：`, error instanceof Error ? error.message : String(error));
          }
        }
      }
    }

    await send(buildOnebotReplyMessage(reply, options?.replyToMessageId, atQq()));
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
    const sticker = options?.sticker;
    if (sticker) {
      if (sticker.qqEmojiId) {
        try {
          await sendOnebotCustomFace(config, target, sticker.qqEmojiId);
          console.log("[onebot] 收藏表情已发送 " + JSON.stringify({ emojiId: sticker.qqEmojiId, stickerId: sticker.id }));
          return;
        } catch (error) {
          // 收藏里那张可能已经被删了（QQ 侧改动还没同步回来），退回图片段，这一条不丢。
          console.error(
            "[onebot] 收藏表情发送失败，退回图片段：",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      const segments = await loadStickerSegments(sticker.filePath);
      if (!segments.length) return;
      await send(segments).catch((error) => {
        console.error("[onebot] 表情发送失败：", error instanceof Error ? error.message : String(error));
      });
      return;
    }

    const faceSegments = toOnebotFaceSegments(options?.faces ?? []);
    if (!faceSegments.length) return;
    await send(faceSegments).catch((error) => {
      console.error("[onebot] 内置表情发送失败：", error instanceof Error ? error.message : String(error));
    });
  };
}

function logGroupRound(groupId: string, detail: Record<string, unknown>): void {
  console.log("[onebot] 群聊", JSON.stringify({ groupId, ...detail }));
}

export function createOnebotMessageHandler(record: OnebotConnectionRecord) {
  /** 连接内的短期群聊上下文：背景、成员代号、话题参与。按绑定+群隔离。 */
  const groupContext = createGroupContext({ selfQq: record.accountQq });
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
   * 这条群消息是不是「指令」（公告确认/拟稿、B站 跑任务）—— 需要排队的那种。
   *
   * 普通群消息不需要排队：`remember` + `buffer.push` 都是同步的，真正要串行的是
   * flush（查库、调模型），它在 `onFlush` 里已经自己排队。指令要改公告草稿、
   * 跑 B站 任务，得和私聊/其他指令保持串行，所以走外层队列。
   */
  const isGroupCommandMessage = (event: OnebotResolvedEvent, binding: OnebotBindingRecord): boolean => {
    if (event.messageType !== "group" || !event.groupId) return false;
    const canManageAnnouncement = record.groupAnnouncementEnabled && event.senderRole !== "member";
    if (canManageAnnouncement) {
      if (isAnnouncementConfirm(event.content)) return true;
      if (parseAnnouncementRequest(event.content)) return true;
    }
    return binding.groupBiliRunEnabled && isBiliRunCommand(event.content);
  };

  const factsOf = (event: OnebotResolvedEvent, at: number): GroupMessageFacts => ({
    messageId: event.messageId,
    at,
    senderQq: event.userId,
    displayName: event.displayName,
    text: event.content,
    mentionTargets: readOnebotMentionTargets(event.data, event.selfId || record.accountQq),
    // 具体 @ 了谁：分类结果只够判断「是不是叫她」，学归属要原始 QQ。
    mentionQqs: readOnebotMentionQqs(event.data),
    replyToMessageId: readOnebotReplyToId(event.data),
  });

  /**
   * 一轮群聊的判定与处理。
   *
   * 闸门放在这里而不是 push 的那一刻：push 时还不知道这一轮到底聊了什么，
   * 也不知道她上一次开口是什么时候 —— 这两样都要等这一轮安静下来才成立。
   */
  /**
   * 只落库、不调模型：把「被 @ / 被叫到名字、但这一轮没接」的消息写进会话。
   *
   * 为什么需要它：群聊记录原本只等于「她回过话的那几轮」，群里发生但没找她、
   * 或找了但被闸门挡下的事，从来没进过库，自然也就永远成不了忆泡。
   * 这里只补「冲她来的」那一部分，量小、也不改变任何回复行为。
   *
   * 落库标 `storedReason: "mentioned"`，和正常回复的 `replied` / 判断后沉默的
   * `silent` 区分开，方便以后按原因做保留策略。
   */
  const persistMentionedRound = async (items: PendingGroupMessage[]): Promise<void> => {
    const binding = items[0]!.binding;
    const groupEvent = items[0]!.event;
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
      update: {},
      select: { id: true },
    });
    await prisma.message.createMany({
      data: items.map((item) => ({
        conversationId: conversation.id,
        externalMessageId: item.event.messageId,
        role: "USER" as const,
        content: item.event.content,
        occurredAt: new Date(item.at),
        metadata: {
          source: "channel",
          platform: ONEBOT_PLATFORM,
          storedReason: "mentioned",
          authorOpenId: item.event.userId,
          ...(item.event.displayName ? { authorDisplayName: item.event.displayName } : {}),
          ...(item.event.poke !== undefined ? { poke: true } : {}),
        },
      })),
      // 同一轮可能被重放（重连/重试），靠 (conversationId, externalMessageId) 唯一约束去重。
      skipDuplicates: true,
    });
  };

  const flushGroupRound = async (items: PendingGroupMessage[]): Promise<void> => {
    const binding = items[0]!.binding;
    const groupEvent = items[0]!.event;
    // 按群解析：同一个绑定挂了好几个群时，每个群可以有自己的那一档。
    const settings = groupChatForGroup(binding.groupChat, binding.groupChatModes, groupEvent.groupId);
    const contextKey = `${binding.id}:${groupEvent.conversationKey}`;
    const direct = items.some((item) => item.direct);
    const named = items.some((item) => item.named);
    // 这一轮是不是被「戳一戳」叫醒的。只在为真时打，避免每行日志多一个 false。
    const poked = items.some((item) => item.event.poke !== undefined);
    // 入队时已解析好，直接用，不再重复解 CQ 码。
    const facts = items.map((item) => item.facts);
    const topicCandidate = groupContext.topicCandidate(contextKey, facts);
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

    const prisma = getPrisma();
    // lastEventAt 已挪到事件入口统一更新（含 mention 档早退），这里不再重复写。
    const conversation = await prisma.conversation.findFirst({
      where: { channelBindingId: binding.id, externalConversationId: groupEvent.conversationKey },
      select: { id: true },
    });
    const lastAssistant = conversation
      ? await prisma.message.findFirst({
          where: { conversationId: conversation.id, role: "ASSISTANT" },
          orderBy: { occurredAt: "desc" },
          select: { occurredAt: true },
        })
      : null;
    const spokenToday = conversation
      ? await prisma.message.count({
          where: {
            conversationId: conversation.id,
            role: "ASSISTANT",
            occurredAt: { gte: groupChatDayStart() },
          },
        })
      : 0;

    const now = new Date();
    const lastSpokeAt = lastAssistant?.occurredAt ?? null;
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
      random: Math.random(),
    });
    if (!gate.allowed) {
      // direct / named 一定要一起打：早退时少了这两个，事后分不清是「@ 没认出来」
      // 还是「认出来了但被别的闸拦了」—— 前者换协议端，后者调参数，处理方式完全不同。
      logGroupRound(groupEvent.groupId, { reason: gate.reason, messages: items.length, direct, named, addressedToOthers, ...(poked ? { poked } : {}) });
      // 被闸门挡下、但确实是冲她来的（@ 或叫名字）：原文仍要落库。
      // 她不接话不等于那件事没发生；不存的话「群里发生的事」永远进不了忆泡。
      // 只写库、不调模型，所以「闸门不过就不花钱」这条约定没有被破坏。
      if (direct || named) {
        await persistMentionedRound(items).catch((error) => {
          console.error("[onebot] 记录被挡下的点名轮次失败：", error instanceof Error ? error.message : String(error));
        });
      }
      return;
    }
    // 群规限流仍然生效：闸门管「该不该接」，这里管「这个群十分钟能说几句」。
    if (await isGroupReplyLimited(binding, groupEvent)) {
      logGroupRound(groupEvent.groupId, { reason: "group_reply_limit", messages: items.length, direct, named, ...(poked ? { poked } : {}) });
      // 限流挡下的同样是「冲她来的」轮次，一样按 mentioned 落库。
      if (direct || named) {
        await persistMentionedRound(items).catch(() => undefined);
      }
      return;
    }

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
        ...(item.event.displayName ? { authorDisplayName: item.event.displayName } : {}),
        content: item.event.content,
        // 谁被 @ 了：落库给提炼用 —— 「@ 的是别的 bot」这类事不能再记成她的事。
        ...(facts[index]?.mentionTargets.length ? { mentionTargets: facts[index]!.mentionTargets } : {}),
        // 入模的正文把 @ 换成代号；落库仍是原样。
        promptContent: groupContext.formatText(contextKey, item.event.content),
        member: groupContext.memberCode(contextKey, item.event.userId),
        // 主人发的消息带上 isOwner：群聊里也认得出主人，落库与提炼时标「主人」。
        ...(item.isOwner ? { speaker: { isOwner: true } } : {}),
        ...(item.event.images.length ? { images: item.event.images } : {}),
        ...(item.event.voices.length ? { voices: item.event.voices } : {}),
        occurredAt: new Date(item.at),
      })),
      faceCatalog: ONEBOT_FACES,
      // 她自己的表情包：清单非空时优先于内置表情（空清单 = 这个角色还没传过图）。
      stickerCatalog: await loadStickerCatalog(binding.characterId),
      // 声明「本渠道能发语音条」：能不能真发由角色开关和判定决定。
      voiceCapable: true,
      // 只有真实 @ 与 all 档不允许「想了想还是不说」。
      allowSilent: !gate.mustReply,
      group: {
        direct,
        background: groupContext.background(contextKey, currentIds),
        anchors: groupContext.anchors(contextKey),
        // 谁是谁的人：让她判断「我的鱼」「我家宝」时能查表，而不是猜自己。
        members: groupContext.members(contextKey),
      },
      sendReply: createReplySender(record.config, groupEvent, {
        // 引用谁就 @ 谁：transcript 里只有 message id，真实 QQ 号留在进程内查。
        resolveAtQq: (messageId) => groupContext.senderOf(contextKey, messageId),
        selfQq: record.accountQq,
      }),
    });

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

    const canManageAnnouncement = record.groupAnnouncementEnabled
      && event.messageType === "group"
      && Boolean(event.groupId)
      && event.senderRole !== "member";

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
    // 先进短期上下文：哪怕这条后面被闸门丢掉，它也是下一轮的背景。
    if (isGroupMessage && event.content && facts) {
      groupContext.remember(contextKey, facts);
      /**
       * 同时记进群活跃度。放在这里（而不是 `flushGroupRound`）是因为 mention 档下
       * 没被叫到的消息根本进不了攒批 —— 那些消息恰恰是「群里在聊、只是没叫她」的证据，
       * 漏掉它们，一个热闹的群会被判成冷场。
       */
      groupActivity.record({
        bindingId: binding.id,
        characterId: binding.characterId,
        conversationId: event.conversationKey,
        groupId: event.groupId,
        at: receivedAt,
        speaker: event.displayName,
        text: event.content,
      });
    }

    // 「仅 @ 时回复」是对整个群聊的开关，指令类消息也受它约束（保持老行为）。
    // 名字命中与已参与话题算「可以看一眼」，交给后面的闸门与模型判断。
    if (isGroupMessage && groupChatMode === "mention") {
      if (!direct && !named && !groupContext.topicCandidate(contextKey, facts ? [facts] : [])) {
        return { status: "ignored", reason: "not_mentioned" };
      }
    }

    if (!event.content) return { status: "ignored", reason: "missing_fields" };

    // 拟稿请求必须先 @ 她，否则管理员在群里正常聊到「群公告」也会被当成指令。
    if (canManageAnnouncement) {
      const request = parseAnnouncementRequest(event.content);
      if (request) return handleAnnouncementDraft(record, event, binding, request.topic, sendReply);
    }

    // B站 指令只认主人：群友发同一句话直接忽略，不进入普通聊天，避免她答应别人。
    if (binding.groupBiliRunEnabled && event.messageType === "group" && isBiliRunCommand(event.content)) {
      if (!record.ownerQq || event.userId !== record.ownerQq) {
        return { status: "ignored", reason: "bili_run_not_owner" };
      }
      return handleBiliRunCommand(event, binding.characterId, sendReply);
    }

    // 群聊统一走一条攒批管道：三档只决定「放不放进来」，不再有单条快速路径。
    // 指令类（公告、B站）已经在上面的分支里返回，不会走到这里。
    if (isGroupMessage) {
      groupChatBuffer.push(
        contextKey,
        // 群消息到这里 facts 必已解析（上面 isGroupMessage 分支统一构造）。
        { event, binding, at: receivedAt, direct, named, isOwner: Boolean(record.ownerQq) && event.userId === record.ownerQq, facts: facts! },
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

    return handleChannelMessage({
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
      ...(event.images.length ? { images: event.images } : {}),
      ...(event.voices.length ? { voices: event.voices } : {}),
      // QQ 是唯一能发表情的渠道；清单非空即声明能力，是否真发还要过角色开关和冷却。
      faceCatalog: ONEBOT_FACES,
      stickerCatalog: await loadStickerCatalog(binding.characterId),
      // 私聊同样能发语音条：语音在私聊里比在群里更合适（一对一，不用怕刷屏）。
      voiceCapable: true,
      sendReply,
    });
  };

  return async (event: OnebotResolvedEvent): Promise<OnebotHandleOutcome> => {
    // 事件一到就更新活性：mention 档早退、没有绑定，都算「这个连接还活着」。
    touchLastEventAt();
    const binding = routeOnebotEventToBinding(record.bindings, event);
    if (!binding) return { status: "ignored", reason: "no_binding" };
    /**
     * 普通群聊消息走快速通道：直接登记，不排队。
     *
     * 以前所有事件都排进下面这个队列，而队列前面可能是一个正在等模型的 flush
     * （几十秒）。群消息排到队时早已超过 `QUEUE_STALE_MS`，被整条丢掉 ——
     * 连 `remember()` 都没执行，它既不进攒批，也不进短期上下文，等于这段时间
     * 群里说的话她完全看不见；@ 她的那句也一样丢。模型越慢，丢得越多。
     *
     * 登记（remember + push）是同步的，不需要排队；需要串行的是「处理」，
     * flush 在 `onFlush` 里自己排队。指令（公告/B站）仍走队列，保持串行。
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
       * 前面一轮在等模型就整条消失。群指令（公告/B站）仍然按过期丢弃 —— 过了那一刻，
       * 在群里回一句旧指令只会让人莫名其妙。
       */
      if (event.messageType === "group" && Date.now() - queuedAt > QUEUE_STALE_MS) {
        return { status: "ignored", reason: "stale_in_queue" };
      }
      return handleRoutedEvent(event, binding);
    });
  };
}
