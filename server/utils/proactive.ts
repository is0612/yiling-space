/**
 * 主动找话：目的池 → 硬闸门 → 写一句话 → 走 QQ 私信发出去。一次 tick 只发一条。
 *
 * ⚠️ 两个刻意的顺序：
 *   - **先判闸门再调模型**，否则「凌晨三点不该发」要花两次调用才发现。
 *   - **发了就要落库成一条 ASSISTANT 消息**，否则用户回一句「你说啥」，
 *     她读上下文读不到自己刚说过的话，只能重新编一遍。
 */

import { resolveChatModelSettings } from "./chat-model-config";
import { loadOnebotConnections } from "./channel-adapter/onebot/configure";
import { sendOnebotPrivateMessage } from "./channel-adapter/onebot/client";
import { resolveCharacterApiKey } from "./credential-encryption";
import { parseJsonLoose } from "./loose-json";
import { readDailyQuota, recordModelUsage } from "./model-usage";
import { getPrisma } from "./prisma";
import {
  buildIntentSystemPrompt,
  buildIntentUserPrompt,
  buildMessageSystemPrompt,
  buildMessageUserPrompt,
  isProactiveKind,
  parseIntents,
  parseMessage,
  type ProactiveMaterials,
} from "./proactive-prompt";
import {
  evaluateProactiveGate,
  goalDedupeKey,
  pickIntent,
  proactiveDayKey,
  resolveProactiveSettings,
  type ProactiveSettings,
} from "./proactive-settings";
import { callRawModel } from "./raw-llm";

/** 池子里少于这个数就补一次。留余量是为了「挑」真的在挑，而不是永远只有一条可选。 */
const REFILL_THRESHOLD = 2;
/** 喂给模型的最大记忆条数。给太多她会开始复述记忆，而不是说想说的话。 */
const MAX_MEMORY_LINES = 12;
/** 最近对话的条数。只用来判断「刚聊到哪」，不是让模型接着聊。 */
const MAX_CHAT_LINES = 8;
/** 目的放多久算过期。过期不等于删掉，只是不再挑中。 */
const INTENT_TTL_DAYS = 14;

export type ProactiveTickResult = {
  characterId: string;
  characterName: string;
  status: "sent" | "skipped" | "failed";
  /** 机器可读的原因，页面直接按它显示中文。 */
  reason: string;
  intentId?: string;
  /** 真发出去的正文。 */
  content?: string;
  /** 补充说明（模型报错等），只在失败时有值。 */
  detail?: string;
};

const REASON_LABELS: Record<string, string> = {
  disabled: "主动找话没开",
  daily_max_zero: "每日上限设成了 0",
  no_recipient: "没有可发的 QQ 私聊（她还没跟谁在 QQ 上说过话）",
  no_memory_scope: "这个角色还没有记忆空间",
  quota_exceeded: "今天的模型额度用完了",
  daily_limit: "今天的主动条数用完了",
  quiet_hours: "现在在安静时段",
  min_gap: "离上一条还不够久",
  user_active: "主人刚说过话，先不打扰",
  no_intent: "池子里没有够格的目的",
  model_error: "模型调用失败",
  empty_reply: "模型这轮没写出话",
  send_failed: "私信发送失败",
  ok: "发出去了",
};

export function describeProactiveReason(reason: string): string {
  return REASON_LABELS[reason] ?? reason;
}

type CharacterForProactive = {
  id: string;
  name: string;
  basePrompt: string;
  styleExamples: string;
  status: string;
  modelConfig: unknown;
  memoryScopes: Array<{ id: string }>;
};

/**
 * 记忆打分：重要度和新鲜度各占一半。只看重要度会翻出三个月前的老账，
 * 只看新鲜度会挑到鸡毛蒜皮。
 *
 * 私聊主动找话与群内找话题共用这一份口径 —— 两边挑出来的素材不一样，
 * 会让同一个角色在私聊里「记得」的事和在群里「想起」的事对不上。
 */
export function rankMemoryLines(
  rows: ReadonlyArray<{ category: string; content: string; importance: number; updatedAt: Date }>,
  now: Date,
  limit = MAX_MEMORY_LINES,
): string[] {
  return rows
    .map((row) => {
      const ageDays = Math.max(0, (now.getTime() - row.updatedAt.getTime()) / 86_400_000);
      const freshness = 1 / (1 + ageDays / 14);
      return { row, score: row.importance * 0.5 + freshness * 0.5 };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ row }) => `[${row.category}] ${row.content.slice(0, 220)}`);
}

/** 素材：高重要度 + 新鲜的长期记忆，加上最近一次会话的尾巴。 */
async function collectMaterials(
  characterId: string,
  scopeId: string,
  now: Date,
): Promise<ProactiveMaterials> {
  const prisma = getPrisma();
  const rows = await prisma.memoryItem.findMany({
    where: { memoryScopeId: scopeId, status: "ACTIVE", deletedAt: null },
    orderBy: [{ importance: "desc" }, { updatedAt: "desc" }],
    take: 60,
    select: { category: true, content: true, importance: true, updatedAt: true },
  });

  const ranked = rankMemoryLines(rows, now);

  const conversation = await prisma.conversation.findFirst({
    where: { characterId },
    orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
    select: { id: true },
  });
  const recent = conversation
    ? (await prisma.message.findMany({
        where: { conversationId: conversation.id, role: { in: ["USER", "ASSISTANT"] } },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: MAX_CHAT_LINES,
        select: { role: true, content: true },
      })).reverse()
    : [];

  return {
    memories: ranked,
    recentChat: recent.map((item) => `${item.role === "USER" ? "他" : "我"}：${item.content.slice(0, 160)}`),
  };
}

type DeliveryTarget = {
  bindingId: string;
  userId: string;
  conversationId: string;
  config: { wsUrl: string; httpUrl: string; accessToken?: string; httpToken?: string };
};

/**
 * 找收件人：这个角色最近一次 QQ 私聊的对方。
 *
 * 不让用户手填「主人 QQ」：一串数字容易填错，填错了还发得出去；
 * 而「最近跟谁私聊过」本身就是答案 —— 没人跟她聊过，她也就不该主动开口。
 */
export async function findDeliveryTarget(characterId: string): Promise<DeliveryTarget | null> {
  const prisma = getPrisma();
  const conversation = await prisma.conversation.findFirst({
    where: {
      characterId,
      externalConversationId: { startsWith: "c:" },
      channelBinding: { connection: { platform: "qq-onebot" } },
    },
    orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
    select: { id: true, externalConversationId: true, channelBindingId: true },
  });
  if (!conversation?.channelBindingId || !conversation.externalConversationId) return null;
  const userId = conversation.externalConversationId.slice(2);
  if (!userId) return null;

  const connections = await loadOnebotConnections();
  const connection = connections.find((item) => item.bindings.some((binding) => binding.id === conversation.channelBindingId));
  if (!connection) return null;

  return {
    bindingId: conversation.channelBindingId,
    userId,
    conversationId: conversation.id,
    config: connection.config,
  };
}

/** 收件人脱敏：页面只需能认出「发给谁」，不需要完整 QQ 号。 */
export function maskProactiveRecipient(userId: string): string {
  if (userId.length <= 4) return "*".repeat(Math.max(2, userId.length));
  return `${userId.slice(0, 3)}***${userId.slice(-2)}`;
}

/** 补目的：调一次模型，落 1-3 条进池子。返回新入库条数。 */
async function refillIntents(
  character: CharacterForProactive,
  materials: ProactiveMaterials,
): Promise<{ created: number; error?: string }> {
  const prisma = getPrisma();
  const modelSettings = resolveChatModelSettings(character.modelConfig);
  const apiKey = await resolveCharacterApiKey(character.modelConfig, modelSettings.apiBaseUrl).catch(() => "");
  if (!apiKey || !modelSettings.model) return { created: 0, error: "model_not_configured" };

  let reply = "";
  try {
    reply = await callRawModel({
      systemPrompt: buildIntentSystemPrompt(character.name, character.basePrompt),
      userPrompt: buildIntentUserPrompt(materials),
      model: modelSettings.model,
      apiKey,
      apiBaseUrl: modelSettings.apiBaseUrl,
      temperature: 0.8,
      onUsage: (usage) => {
        void recordModelUsage({ kind: "proactive", model: modelSettings.model, usage, characterId: character.id });
      },
    });
  } catch (error) {
    return { created: 0, error: error instanceof Error ? error.message : String(error) };
  }

  const intents = parseIntents(parseJsonLoose(reply));
  if (!intents.length) return { created: 0, error: "empty_reply" };

  // 过期的先清出去，否则池子会越堆越旧，挑出来的永远是陈年旧事。
  const cutoff = new Date(Date.now() - INTENT_TTL_DAYS * 86_400_000);
  await prisma.proactiveIntent.updateMany({
    where: { characterId: character.id, status: "PENDING", createdAt: { lt: cutoff } },
    data: { status: "EXPIRED" },
  }).catch(() => undefined);

  const created = await prisma.proactiveIntent.createMany({
    data: intents.map((intent) => ({
      characterId: character.id,
      kind: intent.kind,
      goal: intent.goal,
      confidence: intent.confidence,
      urgency: intent.urgency,
      origin: "memory",
      dedupeKey: goalDedupeKey(intent.kind, intent.goal),
      status: "PENDING",
    })),
    skipDuplicates: true,
  });
  return { created: created.count };
}

/** 写并发送一条：模型写话 → 私信发出 → 记进会话历史。 */
async function deliverIntent(
  character: CharacterForProactive,
  target: DeliveryTarget,
  intent: { id: string; goal: string; kind: string },
  materials: ProactiveMaterials,
): Promise<{ ok: boolean; reason: string; content?: string }> {
  const prisma = getPrisma();
  const modelSettings = resolveChatModelSettings(character.modelConfig);
  const apiKey = await resolveCharacterApiKey(character.modelConfig, modelSettings.apiBaseUrl).catch(() => "");
  if (!apiKey || !modelSettings.model) return { ok: false, reason: "model_not_configured" };

  let reply = "";
  try {
    reply = await callRawModel({
      systemPrompt: buildMessageSystemPrompt(character.name, character.basePrompt, character.styleExamples),
      userPrompt: buildMessageUserPrompt(
        { goal: intent.goal, kind: isProactiveKind(intent.kind) ? intent.kind : "SHARE" },
        materials,
      ),
      model: modelSettings.model,
      apiKey,
      apiBaseUrl: modelSettings.apiBaseUrl,
      temperature: 0.9,
      onUsage: (usage) => {
        void recordModelUsage({ kind: "proactive", model: modelSettings.model, usage, characterId: character.id });
      },
    });
  } catch (error) {
    await prisma.proactiveIntent.update({
      where: { id: intent.id },
      data: { attempts: { increment: 1 } },
    }).catch(() => undefined);
    return { ok: false, reason: `model_error:${error instanceof Error ? error.message : String(error)}` };
  }

  const content = parseMessage(reply);
  if (!content) {
    // 模型自己判定「没什么可说的」——这是正常结果，不是错误。
    await prisma.proactiveIntent.update({
      where: { id: intent.id },
      data: { status: "SKIPPED", attempts: { increment: 1 } },
    }).catch(() => undefined);
    return { ok: false, reason: "empty_reply" };
  }

  try {
    await sendOnebotPrivateMessage(target.config, target.userId, content);
  } catch (error) {
    await prisma.proactiveIntent.update({
      where: { id: intent.id },
      data: { attempts: { increment: 1 } },
    }).catch(() => undefined);
    return { ok: false, reason: `send_failed:${error instanceof Error ? error.message : String(error)}` };
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.proactiveIntent.update({
      where: { id: intent.id },
      data: {
        status: "SENT",
        sentAt: now,
        content,
        recipient: `qq-onebot:c:${target.userId}`,
        attempts: { increment: 1 },
      },
    });
    // 落成一条 ASSISTANT 消息：她下一次聊天要能读到自己说过什么。
    await tx.message.create({
      data: {
        conversationId: target.conversationId,
        role: "ASSISTANT",
        content,
        occurredAt: now,
        metadata: { source: "proactive", platform: "qq-onebot", intentId: intent.id, goal: intent.goal },
      },
      select: { id: true },
    });
    await tx.conversation.update({ where: { id: target.conversationId }, data: { lastMessageAt: now } });
  });

  return { ok: true, reason: "ok", content };
}

/**
 * 跑一次 tick。
 *
 * `force`（页面上的「立即试一次」）只跳过时间类闸门（安静时段 / 间隔 / 主人在聊 / 每日上限），
 * **不跳过**开关、收件人和模型额度 —— 那几条跳过就等于让按钮变成「绕过所有保护」。
 */
export async function runProactiveTick(options: { characterId?: string; force?: boolean } = {}): Promise<ProactiveTickResult[]> {
  const prisma = getPrisma();
  const now = new Date();
  const characters = await prisma.character.findMany({
    where: {
      status: "ACTIVE",
      ...(options.characterId ? { id: options.characterId } : {}),
    },
    select: {
      id: true,
      name: true,
      basePrompt: true,
      styleExamples: true,
      status: true,
      modelConfig: true,
      memoryScopes: { where: { scopeType: "CHARACTER_GLOBAL" }, select: { id: true } },
    },
  });

  const results: ProactiveTickResult[] = [];
  for (const character of characters) {
    const settings = resolveProactiveSettings(character.modelConfig);
    const skip = (reason: string): ProactiveTickResult =>
      ({ characterId: character.id, characterName: character.name, status: "skipped", reason });

    // 也给出原因而不是静默 continue：「没开」和「开了但发不出去」在排查时完全是两件事。
    if (!settings.enabled) {
      results.push(skip("disabled"));
      continue;
    }
    const scope = character.memoryScopes[0];
    if (!scope) {
      results.push(skip("no_memory_scope"));
      continue;
    }

    const target = await findDeliveryTarget(character.id);
    const [sentToday, lastSent, lastUserMessage, quota] = await Promise.all([
      prisma.proactiveIntent.count({
        where: { characterId: character.id, status: "SENT", sentAt: { gte: new Date(`${proactiveDayKey(now)}T00:00:00+08:00`) } },
      }),
      prisma.proactiveIntent.findFirst({
        where: { characterId: character.id, status: "SENT", sentAt: { not: null } },
        orderBy: { sentAt: "desc" },
        select: { sentAt: true },
      }),
      prisma.message.findFirst({
        where: { conversation: { characterId: character.id }, role: "USER" },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        select: { occurredAt: true },
      }),
      readDailyQuota(character.id, character.modelConfig),
    ]);

    // force（页面上的「立即试一次」）只跳过时间类闸门，开关 / 收件人 / 额度照判。
    const gate = evaluateProactiveGate({
      settings,
      now,
      sentToday: options.force ? 0 : sentToday,
      lastSentAt: options.force ? null : lastSent?.sentAt ?? null,
      lastUserMessageAt: options.force ? null : lastUserMessage?.occurredAt ?? null,
      quotaExceeded: quota.exceeded,
      hasRecipient: Boolean(target),
    });
    if (!gate.allowed) {
      results.push(skip(gate.reason));
      continue;
    }
    if (!target) {
      results.push(skip("no_recipient"));
      continue;
    }

    const materials = await collectMaterials(character.id, scope.id, now);

    let pending = await prisma.proactiveIntent.findMany({
      where: { characterId: character.id, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, kind: true, goal: true, confidence: true, urgency: true, createdAt: true },
    });

    if (pending.length < REFILL_THRESHOLD) {
      const refill = await refillIntents(character, materials);
      if (refill.error && !pending.length) {
        results.push({
          characterId: character.id,
          characterName: character.name,
          status: "failed",
          reason: refill.error === "model_not_configured" ? "model_error" : refill.error === "empty_reply" ? "empty_reply" : "model_error",
          detail: refill.error,
        });
        continue;
      }
      pending = await prisma.proactiveIntent.findMany({
        where: { characterId: character.id, status: "PENDING" },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { id: true, kind: true, goal: true, confidence: true, urgency: true, createdAt: true },
      });
    }

    const chosen = pickIntent(pending, now, settings.minConfidence);
    if (!chosen) {
      results.push(skip("no_intent"));
      continue;
    }

    const outcome = await deliverIntent(character, target, chosen, materials);
    if (!outcome.ok) {
      const isModelError = outcome.reason.startsWith("model_error");
      results.push({
        characterId: character.id,
        characterName: character.name,
        status: "failed",
        reason: outcome.reason === "empty_reply" ? "empty_reply" : isModelError ? "model_error" : "send_failed",
        intentId: chosen.id,
        detail: outcome.reason,
      });
      continue;
    }

    results.push({
      characterId: character.id,
      characterName: character.name,
      status: "sent",
      reason: "ok",
      intentId: chosen.id,
      content: outcome.content,
    });
  }

  return results;
}
