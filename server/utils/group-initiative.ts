/**
 * QQ 群「冷场了自己找话题」：读活跃度 → 闸门 → 写一句 → 发群里。
 *
 * 与私聊主动找话（`proactive.ts`）分开的一条链，共用的只有人设、记忆打分和记账。
 * 不该合并：私聊那条是「攒着想对他说的事」，靠目的池和置信度挑；
 * 群里根本没有「非说不可的事」这种东西，只有「这个群安静太久了，我起个头」。
 *
 * ⚠️ 顺序刻意：**先判闸门再调模型**。反过来的话，一个死群每分钟都会花一次模型调用
 * 才发现「现在不该说话」。
 */

import { resolveChatModelSettings } from "./chat-model-config";
import {
  bindingAcceptsGroup,
  loadOnebotConnections,
  type OnebotBindingRecord,
  type OnebotConnectionRecord,
} from "./channel-adapter/onebot/configure";
import { sendOnebotGroupMessage } from "./channel-adapter/onebot/client";
import { groupChatForGroup, groupChatDayStart, type GroupChatMode } from "./channel-adapter/onebot/group-chat";
import { ONEBOT_PLATFORM } from "./channel-adapter/onebot/types";
import { resolveCharacterApiKey } from "./credential-encryption";
import {
  buildGroupInitiativeSystemPrompt,
  buildGroupInitiativeUserPrompt,
} from "./group-initiative-prompt";
import {
  describeGroupInitiativeReason,
  evaluateGroupInitiativeGate,
  resolveGroupInitiativeSettings,
} from "./group-initiative-settings";
import { parseMessage } from "./proactive-prompt";
import { rankMemoryLines } from "./proactive";
import { readDailyQuota, recordModelUsage } from "./model-usage";
import { getPrisma } from "./prisma";
import { callRawModel } from "./raw-llm";

/**
 * 同一个角色两次「在群里开口」之间至少隔这么久（跨群生效）。
 *
 * 每群每天 3 条是按群算的，加了这条才不会被「挂了十个群」放大成一天三十条 ——
 * 用户看到的是「这条鱼今天到处在群里找人说话」，而不是「某个群被照顾到了」。
 */
const CHARACTER_COOLDOWN_MINUTES = 30;
/** 一次 tick 最多评估几个群（按最冷排序）。查库不算贵，但没必要几十个群全跑一遍。 */
const MAX_GROUPS_PER_TICK = 5;
/** 超过这么久没消息的群不再考虑：多半是退群了或者绑定换了，留着只是噪声。 */
const ACTIVITY_MAX_AGE_DAYS = 30;
/** 每轮素材里带几条群消息。够判「刚才聊到哪」，再多她就开始复述。 */
const MAX_RECENT_LINES = 12;

export type GroupInitiativeResult = {
  characterId: string;
  characterName: string;
  /** 群号；角色级以上（没开、没群）的跳过没有这个值。 */
  groupId?: string;
  status: "sent" | "skipped" | "failed";
  /** 机器可读的原因，页面按它显示中文。 */
  reason: string;
  /** 这个群安静了多少分钟（只在有具体群时给）。 */
  idleMinutes?: number;
  content?: string;
  detail?: string;
};

type CharacterForGroups = {
  id: string;
  name: string;
  basePrompt: string;
  styleExamples: string;
  modelConfig: unknown;
  memoryScopes: Array<{ id: string }>;
};

type Candidate = {
  activityId: string;
  binding: OnebotBindingRecord;
  connection: OnebotConnectionRecord;
  groupId: string;
  externalConversationId: string;
  /** 这个群在「自然接话」里的档位（按群覆盖后）。`mention` 的群不参与主动找话题。 */
  groupMode: GroupChatMode;
  idleMinutes: number;
  lastAttemptAt: Date | null;
  lastInitiativeAt: Date | null;
  recentLines: string[];
};

/** `group_activities.recentLines` 是 Json 列：库里的东西一律当脏数据读，认不出就丢。 */
export function readRecentLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const lines: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (!text) continue;
    const speaker = typeof record.speaker === "string" && record.speaker.trim() ? record.speaker.trim() : "群友";
    lines.push(`${speaker}：${text}`);
    if (lines.length >= MAX_RECENT_LINES) break;
  }
  return lines;
}

/** 东八区的 `HH:MM`，给提示词用 —— 「现在几点」是群里最常见的一个话题引子。 */
export function clockLabelCst(date: Date): string {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${String(shifted.getUTCHours()).padStart(2, "0")}:${String(shifted.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * 这个群今天她已经主动开了几次话题。按消息元数据数，不另存计数器 —— 消息才是事实，
 * 存计数器会在「发出去了但写库失败」时永久少算一次。
 */
export async function countGroupInitiativesToday(
  channelBindingId: string,
  externalConversationId: string,
): Promise<number> {
  return getPrisma().message.count({
    where: {
      role: "ASSISTANT",
      occurredAt: { gte: groupChatDayStart() },
      conversation: { is: { channelBindingId, externalConversationId } },
      metadata: { path: ["source"], equals: "group-initiative" },
    },
  });
}

/** 群会话不存在就建：群聊挂在角色全局 scope 下，和 pipeline 建会话时保持一致。 */
async function ensureGroupConversation(input: {
  characterId: string;
  scopeId: string;
  bindingId: string;
  externalConversationId: string;
  groupId: string;
}): Promise<string> {
  const prisma = getPrisma();
  const existing = await prisma.conversation.findFirst({
    where: { channelBindingId: input.bindingId, externalConversationId: input.externalConversationId },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await prisma.conversation.create({
    data: {
      characterId: input.characterId,
      memoryScopeId: input.scopeId,
      channelBindingId: input.bindingId,
      externalConversationId: input.externalConversationId,
      title: `QQ群 ${input.groupId}`,
      status: "ACTIVE",
      metadata: { platform: ONEBOT_PLATFORM, kind: "group", groupId: input.groupId },
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * 花掉一次模型调用（成功或失败都算），闸门的最短间隔看它。
 *
 * 真开口时顺手把 `lastSpokeAt` 推到此刻：冷场时长是从「她最后一次说话」起算的，
 * 不推的话，她刚在群里起完头，下一轮仍会算成「已经安静了三小时」。
 */
async function markAttempt(activityId: string, spoke: boolean, at: Date): Promise<void> {
  await getPrisma().groupActivity.update({
    where: { id: activityId },
    data: {
      lastAttemptAt: at,
      ...(spoke ? { lastInitiativeAt: at, lastSpokeAt: at, lastMessageAt: at } : {}),
    },
  }).catch(() => undefined);
}

/**
 * 在群里说一句。
 *
 * 三步顺序不能换：先发（真发出去才算数）→ 再落消息 → 再记活跃度。
 * 反过来会出现「库里说发了、群里没有」——那比不发更糟，因为下一次 tick 会认为刚说过。
 */
async function speakInGroup(input: {
  character: CharacterForGroups;
  scopeId: string;
  candidate: Candidate;
  now: Date;
}): Promise<{ ok: boolean; reason: string; content?: string; detail?: string }> {
  const { character, candidate, now } = input;
  const prisma = getPrisma();
  const modelSettings = resolveChatModelSettings(character.modelConfig);
  const apiKey = await resolveCharacterApiKey(character.modelConfig, modelSettings.apiBaseUrl).catch(() => "");
  if (!apiKey || !modelSettings.model) {
    // 配置不全也算一次尝试：否则每分钟都会重试一次「没配模型」。
    await markAttempt(candidate.activityId, false, now);
    return { ok: false, reason: "model_error", detail: "model_not_configured" };
  }

  const memories = await prisma.memoryItem.findMany({
    where: { memoryScopeId: input.scopeId, status: "ACTIVE", deletedAt: null },
    orderBy: [{ importance: "desc" }, { updatedAt: "desc" }],
    take: 40,
    select: { category: true, content: true, importance: true, updatedAt: true },
  }).then((rows) => rankMemoryLines(rows, now, 6)).catch(() => [] as string[]);

  let reply = "";
  try {
    reply = await callRawModel({
      systemPrompt: buildGroupInitiativeSystemPrompt(character.name, character.basePrompt, character.styleExamples),
      userPrompt: buildGroupInitiativeUserPrompt({
        groupLabel: `QQ群 ${candidate.groupId}`,
        idleMinutes: Math.round(candidate.idleMinutes),
        nowLabel: clockLabelCst(now),
        recentLines: candidate.recentLines,
        memories,
      }),
      model: modelSettings.model,
      apiKey,
      apiBaseUrl: modelSettings.apiBaseUrl,
      temperature: 0.9,
      onUsage: (usage) => {
        void recordModelUsage({ kind: "proactive", model: modelSettings.model, usage, characterId: character.id });
      },
    });
  } catch (error) {
    await markAttempt(candidate.activityId, false, now);
    return { ok: false, reason: "model_error", detail: error instanceof Error ? error.message : String(error) };
  }

  const content = parseMessage(reply);
  if (!content) {
    // 模型自己判定「这时候没什么想说的」—— 正常结果，不是错误。
    await markAttempt(candidate.activityId, false, now);
    return { ok: false, reason: "nothing_to_say" };
  }

  try {
    await sendOnebotGroupMessage(candidate.connection.config, candidate.groupId, content);
  } catch (error) {
    await markAttempt(candidate.activityId, false, now);
    return { ok: false, reason: "send_failed", detail: error instanceof Error ? error.message : String(error) };
  }

  const conversationId = await ensureGroupConversation({
    characterId: character.id,
    scopeId: input.scopeId,
    bindingId: candidate.binding.id,
    externalConversationId: candidate.externalConversationId,
    groupId: candidate.groupId,
  });
  await prisma.$transaction(async (tx) => {
    await tx.message.create({
      data: {
        conversationId,
        role: "ASSISTANT",
        content,
        occurredAt: now,
        metadata: {
          source: "group-initiative",
          platform: ONEBOT_PLATFORM,
          groupId: candidate.groupId,
          idleMinutes: Math.round(candidate.idleMinutes),
        },
      },
      select: { id: true },
    });
    await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: now } });
  });
  await markAttempt(candidate.activityId, true, now);
  return { ok: true, reason: "ok", content };
}

/** 加载这个角色的群活跃度行，并拼上绑定与连接（发消息要用连接配置）。 */
async function loadCandidates(
  characterId: string,
  connections: readonly OnebotConnectionRecord[],
  now: Date,
): Promise<Candidate[]> {
  const byBinding = new Map<string, { binding: OnebotBindingRecord; connection: OnebotConnectionRecord }>();
  for (const connection of connections) {
    for (const binding of connection.bindings) {
      if (binding.characterId === characterId) byBinding.set(binding.id, { binding, connection });
    }
  }
  if (!byBinding.size) return [];

  const rows = await getPrisma().groupActivity.findMany({
    where: {
      channelBindingId: { in: [...byBinding.keys()] },
      lastMessageAt: { gte: new Date(now.getTime() - ACTIVITY_MAX_AGE_DAYS * 86_400_000) },
    },
    orderBy: { lastMessageAt: "desc" },
    take: 50,
  });

  const candidates: Candidate[] = [];
  for (const row of rows) {
    const linked = byBinding.get(row.channelBindingId);
    if (!linked) continue;
    /**
     * 群号还在不在这个绑定的 routingKey 里。
     *
     * 活跃度表是「见过这个群就记一行」，而 routingKey 是「我现在管哪些群」——
     * 用户把某个群号从绑定里删掉之后，旧行不会自动消失。只看 bindingId 就选候选，
     * 她会跑到一个已经解绑的群里主动开口，而这个错没法撤回。
     */
    if (!bindingAcceptsGroup(linked.binding.routingKey, row.groupId)) continue;
    /**
     * 档位必须走 `groupChatForGroup` 按群解析，不能直读 `binding.groupChat`：
     * 一条绑定可以挂多个群，`groupChatModes` 里可能单独把某个群设成「仅 @ 时回复」。
     * 直读绑定会让那个群被当成 ambient，然后在里面自己冒头。
     */
    const groupMode = groupChatForGroup(linked.binding.groupChat, linked.binding.groupChatModes, row.groupId).mode;
    // 「安静了多久」要取「最后一条群消息」和她「最后一次说话」里更近的那个：
    // 她刚回过一句，群里没人再说话，那次回复之后就不算冷场。
    const lastActiveAt = Math.max(
      row.lastMessageAt.getTime(),
      row.lastSpokeAt?.getTime() ?? 0,
    );
    candidates.push({
      activityId: row.id,
      binding: linked.binding,
      connection: linked.connection,
      groupId: row.groupId,
      externalConversationId: row.externalConversationId,
      groupMode,
      idleMinutes: Math.max(0, (now.getTime() - lastActiveAt) / 60_000),
      lastAttemptAt: row.lastAttemptAt,
      lastInitiativeAt: row.lastInitiativeAt,
      recentLines: readRecentLines(row.recentLines),
    });
  }
  return candidates.sort((a, b) => b.idleMinutes - a.idleMinutes);
}

/**
 * 页面用的现状：设置 + 每个群现在能不能开口 + 为什么不能。
 *
 * 复用 tick 的同一把闸门，不另写一套判断 —— 页面上说「可以」、后台实际不发，
 * 是这类功能最容易被信任崩塌的地方。
 */
export async function readGroupInitiativeStatus(characterId: string, modelConfig: unknown) {
  const now = new Date();
  const settings = resolveGroupInitiativeSettings(modelConfig);
  const connections = await loadOnebotConnections().catch(() => [] as OnebotConnectionRecord[]);
  // 页面只列前几个：每个群都要单独数一次「今天说过几条」，十次查询换来的信息没人看。
  const candidates = (await loadCandidates(characterId, connections, now)).slice(0, 5);
  const quota = await readDailyQuota(characterId, modelConfig);

  const groups = [];
  for (const candidate of candidates) {
    const sentToday = await countGroupInitiativesToday(candidate.binding.id, candidate.externalConversationId);
    const gate = evaluateGroupInitiativeGate({
      settings,
      now,
      groupMode: candidate.groupMode,
      idleMinutes: candidate.idleMinutes,
      sentToday,
      lastAttemptAt: candidate.lastAttemptAt,
      quotaExceeded: quota.exceeded,
    });
    // 这里只说「现在能不能开口」，千万不能回 `ok` —— 那个文案是「发出去了」，
    // 而这条路径一个字都没发，页面会显示成刚在群里说过话。
    const reason = gate.allowed ? "ready" : gate.reason;
    groups.push({
      groupId: candidate.groupId,
      idleMinutes: Math.round(candidate.idleMinutes),
      sentToday,
      lastInitiativeAt: candidate.lastInitiativeAt?.toISOString() ?? null,
      canSendNow: gate.allowed,
      reason,
      reasonLabel: describeGroupInitiativeReason(reason),
    });
  }

  // 角色级结论取「最冷那个群」：它才是下一个真会轮到的群。
  const first = groups[0];
  const reason = !settings.enabled
    ? "disabled"
    : settings.dailyMax <= 0
      ? "daily_max_zero"
      : quota.exceeded
        ? "quota_exceeded"
        : first?.reason ?? "no_group";

  return {
    settings,
    status: {
      canSendNow: groups.some((group) => group.canSendNow),
      reason,
      reasonLabel: describeGroupInitiativeReason(reason),
      quotaExceeded: quota.exceeded,
      groups,
    },
  };
}

/**
 * 跑一次群内找话题的 tick。
 *
 * 一个角色一轮**最多花一次模型调用**（第一次过闸门的那条）：群里刷一句的社交成本，
 * 比私聊发一条高一个量级，一次 tick 里连开两个群的话题就是「到处找人说话」。
 */
export async function runGroupInitiativeTick(
  options: { characterId?: string; force?: boolean } = {},
): Promise<GroupInitiativeResult[]> {
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
      modelConfig: true,
      memoryScopes: { where: { scopeType: "CHARACTER_GLOBAL" }, select: { id: true } },
    },
  });
  if (!characters.length) return [];

  const connections = await loadOnebotConnections().catch(() => [] as OnebotConnectionRecord[]);
  const results: GroupInitiativeResult[] = [];

  for (const character of characters) {
    const settings = resolveGroupInitiativeSettings(character.modelConfig);
    const skip = (reason: string): GroupInitiativeResult =>
      ({ characterId: character.id, characterName: character.name, status: "skipped", reason });

    if (!settings.enabled) {
      results.push(skip("disabled"));
      continue;
    }
    if (settings.dailyMax <= 0) {
      results.push(skip("daily_max_zero"));
      continue;
    }
    const scope = character.memoryScopes[0];
    if (!scope) {
      results.push(skip("no_memory_scope"));
      continue;
    }

    const candidates = await loadCandidates(character.id, connections, now);
    if (!candidates.length) {
      results.push(skip("no_group"));
      continue;
    }

    // 角色级冷却：刚在 A 群开过口，这轮不在 B 群接着开。
    if (!options.force) {
      const lastAttempt = candidates.reduce<number>(
        (latest, item) => Math.max(latest, item.lastAttemptAt?.getTime() ?? 0),
        0,
      );
      if (lastAttempt && now.getTime() - lastAttempt < CHARACTER_COOLDOWN_MINUTES * 60_000) {
        results.push(skip("just_attempted"));
        continue;
      }
    }

    const quota = await readDailyQuota(character.id, character.modelConfig);

    for (const candidate of candidates.slice(0, MAX_GROUPS_PER_TICK)) {
      const sentToday = await countGroupInitiativesToday(candidate.binding.id, candidate.externalConversationId);
      const gate = evaluateGroupInitiativeGate({
        settings,
        now,
        groupMode: candidate.groupMode,
        idleMinutes: candidate.idleMinutes,
        sentToday,
        lastAttemptAt: candidate.lastAttemptAt,
        quotaExceeded: quota.exceeded,
        ...(options.force ? { ignoreTimeGates: true } : {}),
      });
      if (!gate.allowed) {
        results.push({
          characterId: character.id,
          characterName: character.name,
          groupId: candidate.groupId,
          status: "skipped",
          reason: gate.reason,
          idleMinutes: Math.round(candidate.idleMinutes),
        });
        continue;
      }

      // 一次 tick 只花一次模型调用：过闸门的第一条就是这一轮要处理的群。
      const outcome = await speakInGroup({ character, scopeId: scope.id, candidate, now });
      results.push({
        characterId: character.id,
        characterName: character.name,
        groupId: candidate.groupId,
        status: outcome.ok ? "sent" : outcome.reason === "nothing_to_say" ? "skipped" : "failed",
        reason: outcome.reason,
        idleMinutes: Math.round(candidate.idleMinutes),
        ...(outcome.content ? { content: outcome.content } : {}),
        ...(outcome.detail ? { detail: outcome.detail } : {}),
      });
      break;
    }
  }

  return results;
}
