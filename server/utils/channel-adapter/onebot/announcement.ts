/**
 * QQ 群公告：管理员让角色拟稿 → 角色回复草稿 → 管理员回复「确认发布」才真正发出去。
 *
 * 三条硬约束：
 * 1. 只认群主/管理员（`sender.role`），普通成员说什么都不会触发；
 * 2. 连接级开关默认关闭，打开后也只开「群公告」这一项，不做踢人/禁言；
 * 3. 草稿有有效期且只能被认领一次，避免重复投递或隔天误发。
 */

import { resolveChatModelSettings } from "../../chat-model-config";
import { resolveCharacterApiKey } from "../../credential-encryption";
import { getPrisma } from "../../prisma";
import { callRawModel } from "../../raw-llm";
import { readDailyQuota, recordModelUsage, type ModelUsageTokens } from "../../model-usage";
import type { OnebotConnectionConfig, OnebotResolvedEvent } from "./client";
import { sendOnebotGroupNotice } from "./client";
import { ONEBOT_PLATFORM } from "./types";

export const ANNOUNCEMENT_TTL_MS = 10 * 60 * 1000;
export const ANNOUNCEMENT_MAX_CHARS = 500;
const ANNOUNCEMENT_PROMPT_MARKER = "YILING_GROUP_ANNOUNCEMENT_V1";

export type PendingAnnouncement = {
  id: string;
  content: string;
  topic: string;
  requestedBy: string;
  characterId: string | null;
  expiresAt: Date;
};

/** 从群消息文本里识别「要拟公告」的请求；不是请求返回 null。 */
export function parseAnnouncementRequest(content: string): { topic: string } | null {
  const text = content.replace(/\s+/g, " ").trim();
  if (!text) return null;
  // 必须带动作或冒号：「群公告写得真好」这种闲聊不能触发。
  const matched = /(?:设置|写|拟|发|发布|更新|改|做)(?:一个|一条|个|条)?\s*群公告|群公告\s*[：:]/u.test(text);
  if (!matched) return null;
  if (isAnnouncementConfirm(text)) return null;

  const index = text.indexOf("群公告");
  if (index < 0) return null;
  const topic = text
    .slice(index + "群公告".length)
    .replace(/^[\s：:，,。.、-]+/u, "")
    .trim();
  return { topic: topic.slice(0, ANNOUNCEMENT_MAX_CHARS) };
}

/**
 * 只认完整的「确认发布」。
 * 不收裸「确认」「发布」：管理员在群里随口说一句「发布」就可能把十分钟前的草稿发出去。
 */
export function isAnnouncementConfirm(content: string): boolean {
  // 群里回复时常常顺手 @ 她一下，@QQ号 不算内容。
  const text = content
    .replace(/@\d+/gu, "")
    .replace(/\s+/g, "")
    .replace(/[。！!～~]+$/u, "");
  return /^确认发布$/u.test(text);
}

/** 模型偶尔会套代码块或自己加「公告：」前缀；发到群里的正文要干净。 */
export function sanitizeAnnouncement(text: string): string {
  let value = String(text ?? "").trim();
  value = value.replace(/^```[a-zA-Z]*\s*/u, "").replace(/\s*```$/u, "").trim();
  value = value.replace(/^(群公告|公告)\s*[：:]\s*/u, "").trim();
  value = value.replace(/^["“”'‘’]+|["“”'‘’]+$/gu, "").trim();
  value = value.replace(/\n{3,}/g, "\n\n").trim();
  return value.slice(0, ANNOUNCEMENT_MAX_CHARS).trim();
}

export function buildAnnouncementSystemPrompt(input: {
  characterName: string;
  characterPrompt: string;
  styleExamples?: string | null;
}): string {
  return [
    ANNOUNCEMENT_PROMPT_MARKER,
    `你正在以「${input.characterName}」的身份为 QQ 群写一则群公告。`,
    "要求：",
    "- 只输出公告正文，不要标题、解释、Markdown 或代码块；",
    "- 200 字以内，简洁清楚，群成员能一眼读懂；",
    "- 不编造未提供的时间、地点、奖励或承诺；没有把握的细节就写得笼统一些；",
    "- 不要 @全体成员，不要提自己是 AI；",
    "- 保持角色的人设与语气，但公告要清楚，不能为了卖萌牺牲信息。",
    "",
    "角色人设：",
    input.characterPrompt.slice(0, 12_000),
    ...(input.styleExamples?.trim()
      ? ["", "说话风格示例：", input.styleExamples.trim().slice(0, 4_000)]
      : []),
  ].join("\n");
}

export function buildAnnouncementUserPrompt(input: {
  topic: string;
  recentContext: string;
}): string {
  const topic = input.topic.trim();
  return [
    topic
      ? `公告主题/要求：${topic}`
      : "公告主题：未指定。请根据最近的群聊内容，拟一则此刻适合发在群里的公告。",
    ...(input.recentContext.trim()
      ? ["", "最近的群聊（仅供参考，不要逐句复述）：", input.recentContext.trim().slice(0, 4_000)]
      : []),
  ].join("\n");
}

function recentContextFrom(messages: Array<{ role: string; content: string }>): string {
  return messages
    .slice(-12)
    .map((message) => `${message.role === "USER" ? "群成员" : "你"}：${message.content.slice(0, 200)}`)
    .join("\n");
}

export async function draftAnnouncementText(input: {
  characterId: string;
  bindingId: string;
  conversationId: string | null;
  topic: string;
}): Promise<{ content: string; model: string }> {
  const prisma = getPrisma();
  const character = await prisma.character.findUnique({
    where: { id: input.characterId },
    select: { name: true, basePrompt: true, styleExamples: true, status: true, modelConfig: true },
  });
  if (!character) throw new Error("CHARACTER_MISSING");
  if (character.status !== "ACTIVE") throw new Error("CHARACTER_INACTIVE");

  const settings = resolveChatModelSettings(character.modelConfig);
  let apiKey = "";
  try {
    apiKey = await resolveCharacterApiKey(character.modelConfig, settings.apiBaseUrl);
  } catch {
    throw new Error("API_KEY_DECRYPT_FAILED");
  }
  if (!apiKey || !settings.model) throw new Error("MODEL_NOT_CONFIGURED");

  const quota = await readDailyQuota(input.characterId, character.modelConfig);
  if (quota.exceeded) throw new Error("DAILY_QUOTA_EXCEEDED");

  const recent = input.conversationId
    ? await prisma.message.findMany({
        where: { conversationId: input.conversationId },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: 12,
        select: { role: true, content: true },
      })
    : [];

  let usage: ModelUsageTokens | null = null;
  const raw = await callRawModel({
    systemPrompt: buildAnnouncementSystemPrompt({
      characterName: character.name,
      characterPrompt: character.basePrompt,
      styleExamples: character.styleExamples,
    }),
    userPrompt: buildAnnouncementUserPrompt({
      topic: input.topic,
      recentContext: recentContextFrom(recent.reverse()),
    }),
    model: settings.model,
    apiKey,
    apiBaseUrl: settings.apiBaseUrl,
    temperature: settings.temperature,
    maxTokens: Math.min(Math.max(settings.maxTokens, 600), 2_000),
    onUsage: (value) => { usage = value; },
  });

  const content = sanitizeAnnouncement(raw);
  if (!content) throw new Error("EMPTY_ANNOUNCEMENT");

  await recordModelUsage({
    kind: "channel",
    model: settings.model,
    usage,
    characterId: input.characterId,
    channelBindingId: input.bindingId,
    conversationId: input.conversationId,
    metadata: { task: "group-announcement" },
  });
  return { content, model: settings.model };
}

/** 找（或建）该群会话，并把这一轮请求与回复写成消息，供后续记忆提炼。 */
export async function recordAnnouncementExchange(input: {
  characterId: string;
  bindingId: string;
  event: OnebotResolvedEvent;
  userContent: string;
  assistantContent: string;
}): Promise<string | null> {
  const prisma = getPrisma();
  const scope = await prisma.memoryScope.findFirst({
    where: { characterId: input.characterId, scopeType: "CHARACTER_GLOBAL" },
    select: { id: true },
  });
  if (!scope) return null;

  try {
    return await prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.upsert({
        where: {
          channelBindingId_externalConversationId: {
            channelBindingId: input.bindingId,
            externalConversationId: input.event.conversationKey,
          },
        },
        create: {
          characterId: input.characterId,
          memoryScopeId: scope.id,
          channelBindingId: input.bindingId,
          externalConversationId: input.event.conversationKey,
          title: `群 ${input.event.groupId} 公告`,
          status: "ACTIVE",
          metadata: { platform: ONEBOT_PLATFORM },
        },
        update: {},
        select: { id: true },
      });
      const now = new Date();
      await tx.message.create({
        data: {
          conversationId: conversation.id,
          externalMessageId: input.event.messageId,
          role: "USER",
          content: input.userContent,
          occurredAt: now,
          metadata: {
            source: "channel",
            platform: ONEBOT_PLATFORM,
            authorOpenId: input.event.userId,
            senderRole: input.event.senderRole,
          },
        },
      });
      await tx.message.create({
        data: {
          conversationId: conversation.id,
          role: "ASSISTANT",
          content: input.assistantContent,
          occurredAt: new Date(now.getTime() + 1),
          metadata: { source: "channel", platform: ONEBOT_PLATFORM, kind: "group-announcement" },
        },
      });
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date(now.getTime() + 1) },
      });
      return conversation.id;
    });
  } catch (error) {
    // 同一条外部消息被重复投递时唯一约束会命中；这不是失败。
    if (typeof error === "object" && error && "code" in error && (error as { code?: string }).code === "P2002") {
      return null;
    }
    throw error;
  }
}

export async function findDuplicateAnnouncementEvent(externalMessageId: string): Promise<boolean> {
  if (!externalMessageId) return false;
  const found = await getPrisma().message.findFirst({
    where: { externalMessageId },
    select: { id: true },
  });
  return Boolean(found);
}

export async function createPendingAnnouncement(input: {
  connectionId: string;
  groupId: string;
  requestedBy: string;
  characterId: string;
  topic: string;
  content: string;
}): Promise<PendingAnnouncement> {
  const prisma = getPrisma();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ANNOUNCEMENT_TTL_MS);
  return prisma.$transaction(async (tx) => {
    // 同一个群只保留最新草稿：连发几次请求时，旧草稿不该还能被「确认发布」。
    await tx.onebotGroupAnnouncement.updateMany({
      where: { connectionId: input.connectionId, groupId: input.groupId, status: "PENDING" },
      data: { status: "CANCELLED" },
    });
    const created = await tx.onebotGroupAnnouncement.create({
      data: {
        connectionId: input.connectionId,
        groupId: input.groupId,
        requestedBy: input.requestedBy,
        characterId: input.characterId,
        topic: input.topic,
        content: input.content,
        status: "PENDING",
        expiresAt,
      },
      select: { id: true, content: true, topic: true, requestedBy: true, characterId: true, expiresAt: true },
    });
    return created;
  });
}

export async function findPendingAnnouncement(
  connectionId: string,
  groupId: string,
): Promise<PendingAnnouncement | null> {
  const prisma = getPrisma();
  await prisma.onebotGroupAnnouncement.updateMany({
    where: { connectionId, groupId, status: "PENDING", expiresAt: { lte: new Date() } },
    data: { status: "EXPIRED" },
  });
  return prisma.onebotGroupAnnouncement.findFirst({
    where: { connectionId, groupId, status: "PENDING" },
    orderBy: { createdAt: "desc" },
    select: { id: true, content: true, topic: true, requestedBy: true, characterId: true, expiresAt: true },
  });
}

/** 认领草稿；返回 false 说明已被另一个重复事件抢先处理。 */
export async function claimPendingAnnouncement(id: string): Promise<boolean> {
  const result = await getPrisma().onebotGroupAnnouncement.updateMany({
    where: { id, status: "PENDING", expiresAt: { gt: new Date() } },
    data: { status: "PUBLISHING" },
  });
  return result.count === 1;
}

export async function finishAnnouncement(
  id: string,
  result: { ok: boolean; error?: string },
): Promise<void> {
  await getPrisma().onebotGroupAnnouncement.update({
    where: { id },
    data: {
      status: result.ok ? "PUBLISHED" : "FAILED",
      error: result.ok ? null : (result.error ?? "UNKNOWN").slice(0, 500),
      publishedAt: result.ok ? new Date() : null,
    },
  });
}

export async function publishPendingAnnouncement(input: {
  pending: PendingAnnouncement;
  config: OnebotConnectionConfig;
  groupId: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    await sendOnebotGroupNotice(input.config, input.groupId, input.pending.content);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function writeAnnouncementAudit(input: {
  connectionId: string;
  characterId: string | null;
  groupId: string;
  announcementId: string;
  requestedBy: string;
  ok: boolean;
  error?: string;
}): Promise<void> {
  await getPrisma().auditLog.create({
    data: {
      actorType: "SYSTEM",
      characterId: input.characterId,
      action: input.ok ? "channel.group_announcement_published" : "channel.group_announcement_failed",
      entityType: "PlatformConnection",
      entityId: input.connectionId,
      details: {
        groupId: input.groupId,
        announcementId: input.announcementId,
        requestedBy: input.requestedBy,
        ...(input.ok ? {} : { error: (input.error ?? "").slice(0, 300) }),
      },
    },
  }).catch(() => undefined);
}

export async function findAnnouncementConversationId(
  bindingId: string,
  conversationKey: string,
): Promise<string | null> {
  const conversation = await getPrisma().conversation.findUnique({
    where: {
      channelBindingId_externalConversationId: {
        channelBindingId: bindingId,
        externalConversationId: conversationKey,
      },
    },
    select: { id: true },
  }).catch(() => null);
  return conversation?.id ?? null;
}
