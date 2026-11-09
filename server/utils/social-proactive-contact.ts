/**
 * 社交关系主动联系：只负责「选一位已授权好友 → 在共同 QQ 群里定向 @」。
 *
 * 与 group-initiative（群冷场开话题）完全分开：
 * - 必须有明确的好友级主动联系授权；
 * - 必须有 FRIEND / CLOSE_FRIEND 且 NORMAL 的关系；
 * - 必须在当前有效绑定的共同群里找到好友，并在发送前实时核验群成员；
 * - 只生成有上下文依据的一句话；没有合适内容就跳过；
 * - 一轮最多联系一位好友，绝不过期补发。
 */

import { resolveChatModelSettings } from "./chat-model-config";
import {
  bindingAcceptsGroup,
  loadOnebotConnections,
  type OnebotConnectionRecord,
} from "./channel-adapter/onebot/configure";
import { verifyOnebotGroupMember, sendOnebotGroupMessage } from "./channel-adapter/onebot/client";
import { groupChatForGroup, groupChatDayStart } from "./channel-adapter/onebot/group-chat";
import { resolveCharacterApiKey } from "./credential-encryption";
import { readDailyQuota, recordModelUsage } from "./model-usage";
import { getPrisma } from "./prisma";
import { callRawModel } from "./raw-llm";
import { parseMessage } from "./proactive-prompt";
import { inQuietHours } from "./proactive-settings";
import {
  buildSocialProactiveContactSegments,
  evaluateSocialProactiveContactGate,
} from "./social-proactive-contact-policy";

const ROLE_DAILY_LIMIT = 2;
const FRIEND_COOLDOWN_MS = 7 * 24 * 60 * 60_000;
const MAX_AI_ROUNDS = 3;
const ATTEMPT_DEDUPE_WINDOW_MS = 30 * 60_000;
const MAX_CONTEXT_LINES = 8;

type SocialContactCharacter = {
  id: string;
  name: string;
  basePrompt: string;
  styleExamples: string;
  modelConfig: unknown;
};

type CommonGroup = {
  groupId: string;
  conversationId: string;
  connection: OnebotConnectionRecord;
  groupMode: "mention" | "ambient" | "all";
  quietStart: string;
  quietEnd: string;
  consecutiveAiRounds: number;
  recentLines: string[];
};

export type SocialProactiveContactResult = {
  characterId: string;
  characterName: string;
  status: "sent" | "skipped" | "failed";
  reason: string;
  friend?: string;
  groupId?: string;
  content?: string;
  detail?: string;
};

function dayKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function loadRecentLines(conversationId: string): Promise<string[]> {
  const rows = await getPrisma().message.findMany({
    where: { conversationId, role: { in: ["USER", "ASSISTANT"] } },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: MAX_CONTEXT_LINES,
    select: { role: true, content: true, metadata: true },
  });
  return rows.reverse().map((row) => {
    const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? row.metadata as Record<string, unknown>
      : {};
    const author = asText(metadata.authorName) || (row.role === "ASSISTANT" ? "小鲸鱼" : "群友");
    return `${author}：${row.content.slice(0, 180)}`;
  });
}

async function findCommonGroups(
  characterId: string,
  platformUid: string,
  connections: readonly OnebotConnectionRecord[],
): Promise<CommonGroup[]> {
  const byBinding = new Map<string, { connection: OnebotConnectionRecord; binding: OnebotConnectionRecord["bindings"][number] }>();
  for (const connection of connections) {
    for (const binding of connection.bindings) {
      if (binding.characterId === characterId) byBinding.set(binding.id, { connection, binding });
    }
  }
  if (!byBinding.size) return [];

  const members = await getPrisma().groupMember.findMany({
    where: {
      characterId,
      platformUid,
      conversation: {
        channelBindingId: { in: [...byBinding.keys()] },
        externalConversationId: { startsWith: "g:" },
      },
    },
    orderBy: { lastSpokeAt: "desc" },
    take: 20,
    select: {
      conversationId: true,
      conversation: {
        select: {
          id: true,
          externalConversationId: true,
          consecutiveAiRounds: true,
          channelBindingId: true,
          channelBinding: { select: { routingKey: true, status: true } },
        },
      },
    },
  });

  const groups: CommonGroup[] = [];
  for (const member of members) {
    const conversation = member.conversation;
    const bindingId = conversation.channelBindingId;
    const linked = bindingId ? byBinding.get(bindingId) : undefined;
    const externalId = conversation.externalConversationId ?? "";
    const groupId = externalId.startsWith("g:") ? externalId.slice(2) : "";
    if (!linked || !conversation.channelBinding || conversation.channelBinding.status !== "ACTIVE") continue;
    if (!/^\d{5,15}$/u.test(groupId) || !bindingAcceptsGroup(linked.binding.routingKey, groupId)) continue;

    const groupSettings = groupChatForGroup(linked.binding.groupChat, linked.binding.groupChatModes, groupId);
    const mode = groupSettings.mode;
    if (mode !== "ambient" && mode !== "all") continue;

    groups.push({
      groupId,
      conversationId: conversation.id,
      connection: linked.connection,
      groupMode: mode,
      quietStart: groupSettings.quietStart,
      quietEnd: groupSettings.quietEnd,
      consecutiveAiRounds: conversation.consecutiveAiRounds,
      recentLines: await loadRecentLines(conversation.id),
    });
  }
  return groups;
}

/** 幂等占位：先用唯一键抢占本轮联系，再执行外部发送，避免多 worker 同时 @ 同一个人。 */
async function claimAttempt(input: {
  scopeId: string;
  groupId: string;
  dedupeKey: string;
  now: Date;
}): Promise<boolean> {
  try {
    await getPrisma().socialProactiveContactAttempt.create({
      data: {
        scopeId: input.scopeId,
        status: "SENDING",
        reason: "dispatching",
        groupId: input.groupId,
        dedupeKey: input.dedupeKey,
        attemptedAt: input.now,
        metadata: { source: "social-proactive-contact" },
      },
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Unique constraint")) return false;
    throw error;
  }
}

async function recordAttempt(input: {
  scopeId: string;
  status: "SENT" | "SKIPPED" | "FAILED" | "EXPIRED";
  reason: string;
  groupId?: string;
  content?: string;
  dedupeKey: string;
  sentAt?: Date;
}) {
  await getPrisma().socialProactiveContactAttempt.create({
    data: {
      scopeId: input.scopeId,
      status: input.status,
      reason: input.reason,
      groupId: input.groupId,
      content: input.content,
      dedupeKey: input.dedupeKey,
      sentAt: input.sentAt,
      metadata: { source: "social-proactive-contact" },
    },
  }).catch((error: unknown) => {
    // Unique 冲突表示同一时间窗已处理过；不能为了重试而重复发送。
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Unique constraint")) throw error;
  });
}

async function generateContactLine(input: {
  character: SocialContactCharacter;
  friendName: string;
  relationshipStage: string;
  memories: string[];
  recentLines: string[];
}): Promise<{ content: string; error?: string }> {
  const settings = resolveChatModelSettings(input.character.modelConfig);
  const apiKey = await resolveCharacterApiKey(input.character.modelConfig, settings.apiBaseUrl).catch(() => "");
  if (!apiKey || !settings.model) return { content: "", error: "model_not_configured" };

  const systemPrompt = [
    `你是「${input.character.name}」。以下是你的人设：`,
    input.character.basePrompt.slice(0, 12_000),
    input.character.styleExamples.trim()
      ? `\n平时说话风格（只学语气）：\n${input.character.styleExamples.slice(0, 3_000)}`
      : "",
    "",
    "现在你可以主动联系一位朋友。你不是在完成任务，也不需要为了联系而联系。",
    "只有当下面的共同经历、记忆或最近群聊里确实有自然的延续点，才写一句话；没有就只输出 -。",
    "必须像在 QQ 群里自然地 @ 对方说话，不要客服腔、不要自我介绍、不要提系统或记忆。",
    "不编造共同经历，不假设对方此刻在线，不问候式刷存在感。",
    "最多 35 个汉字，只输出消息正文；没有合适内容只输出 -。",
  ].join("\n");

  const userPrompt = [
    `这次联系的朋友：${input.friendName}`,
    `目前关系阶段：${input.relationshipStage}`,
    "",
    "她可能记得的相关内容（只作为依据，不要复述资料）：",
    ...(input.memories.length ? input.memories.map((line) => `- ${line}`) : ["- 暂无可用记忆"]),
    "",
    "共同群最近的对话：",
    ...(input.recentLines.length ? input.recentLines : ["- 没有可用的近期群聊记录"]),
    "",
    "如果没有具体而自然的接话理由，输出 -。否则写一句直接对这位朋友说的话。",
  ].join("\n");

  try {
    const reply = await callRawModel({
      systemPrompt,
      userPrompt,
      model: settings.model,
      apiKey,
      apiBaseUrl: settings.apiBaseUrl,
      temperature: 0.85,
      onUsage: (usage) => {
        void recordModelUsage({
          kind: "proactive",
          model: settings.model,
          usage,
          characterId: input.character.id,
        });
      },
    });
    return { content: parseMessage(reply) };
  } catch (error) {
    return { content: "", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 每轮最多联系一位好友。60 秒 tick 只重新计算当前候选；
 * 发送失败不会自动补发，进程停机期间也没有待发队列。
 */
export async function runSocialProactiveContactTick(
  options: { characterId?: string } = {},
): Promise<SocialProactiveContactResult[]> {
  const prisma = getPrisma();
  const now = new Date();
  // 进程若在占位后崩溃，30 分钟后将悬挂中的尝试标记过期；绝不在恢复时补发旧消息。
  await prisma.socialProactiveContactAttempt.updateMany({
    where: {
      status: "SENDING",
      attemptedAt: { lt: new Date(now.getTime() - ATTEMPT_DEDUPE_WINDOW_MS) },
    },
    data: { status: "EXPIRED", reason: "dispatch_lease_expired" },
  });
  const connections = await loadOnebotConnections().catch(() => [] as OnebotConnectionRecord[]);
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
    },
  });

  const results: SocialProactiveContactResult[] = [];
  for (const character of characters) {
    const skip = (reason: string, friend?: string): SocialProactiveContactResult => ({
      characterId: character.id,
      characterName: character.name,
      status: "skipped",
      reason,
      ...(friend ? { friend } : {}),
    });

    const [sentToday, quota, friends] = await Promise.all([
      prisma.socialProactiveContactAttempt.count({
        where: {
          status: "SENT",
          sentAt: { gte: groupChatDayStart(now) },
          scope: { characterId: character.id },
        },
      }),
      readDailyQuota(character.id, character.modelConfig),
      prisma.memoryScope.findMany({
        where: {
          characterId: character.id,
          scopeType: "EXTERNAL_IDENTITY",
          proactiveContactEnabled: true,
          relationshipStage: { in: ["FRIEND", "CLOSE_FRIEND"] },
          relationshipStatus: "NORMAL",
          externalIdentity: { is: { platform: "qq-onebot", status: { not: "REVOKED" } } },
        },
        orderBy: [{ lastInteractedAt: "desc" }, { updatedAt: "desc" }],
        take: 30,
        select: {
          id: true,
          friendChatPolicy: true,
          relationshipStage: true,
          relationshipStatus: true,
          externalIdentity: {
            select: { id: true, platformUid: true, displayName: true, kind: true },
          },
          socialProactiveContactAttempts: {
            where: { status: "SENT" },
            orderBy: { sentAt: "desc" },
            take: 1,
            select: { sentAt: true },
          },
        },
      }),
    ]);

    if (sentToday >= ROLE_DAILY_LIMIT) {
      results.push(skip("daily_limit"));
      continue;
    }
    if (quota.exceeded) {
      results.push(skip("quota_exceeded"));
      continue;
    }
    if (!friends.length) {
      results.push(skip("no_authorized_friend"));
      continue;
    }

    let handled = false;
    let lastSkipReason = "no_eligible_common_group";
    for (const friend of friends) {
      const identity = friend.externalIdentity;
      if (!identity || !/^\d{5,15}$/u.test(identity.platformUid)) continue;
      const friendName = identity.displayName?.trim() || identity.platformUid;
      const lastContactAt = friend.socialProactiveContactAttempts[0]?.sentAt ?? null;

      const groups = await findCommonGroups(character.id, identity.platformUid, connections);
      if (!groups.length) {
        lastSkipReason = "no_common_group";
        await recordAttempt({
          scopeId: friend.id,
          status: "SKIPPED",
          reason: "no_common_group",
          dedupeKey: `${dayKey(now)}:no-group:${Math.floor(now.getTime() / ATTEMPT_DEDUPE_WINDOW_MS)}`,
        });
        continue;
      }

      for (const group of groups) {
        const dedupeKey = dayKey(now) + ":" + group.groupId + ":" + Math.floor(now.getTime() / ATTEMPT_DEDUPE_WINDOW_MS);
        // 同一好友/群在本时间窗内已经尝试过（包括「没话说」）就不再重复消耗模型额度。
        const priorAttempt = await prisma.socialProactiveContactAttempt.findUnique({
          where: { scopeId_dedupeKey: { scopeId: friend.id, dedupeKey } },
          select: { status: true },
        });
        if (priorAttempt) {
          lastSkipReason = priorAttempt.status === "SENDING" ? "dispatch_in_progress" : "already_attempted";
          handled = true;
          break;
        }
        const activeClaim = await prisma.socialProactiveContactAttempt.findFirst({
          where: {
            scopeId: friend.id,
            status: "SENDING",
            attemptedAt: { gte: new Date(Date.now() - ATTEMPT_DEDUPE_WINDOW_MS) },
          },
          select: { id: true },
        });
        if (activeClaim) {
          results.push({ ...skip("dispatch_in_progress", friendName), groupId: group.groupId });
          handled = true;
          break;
        }

        const gate = evaluateSocialProactiveContactGate({
          proactiveContactEnabled: true,
          relationshipStage: friend.relationshipStage,
          relationshipStatus: friend.relationshipStatus,
          identityKind: identity.kind,
          friendChatPolicy: friend.friendChatPolicy,
          channelAvailable: true,
          hasCommonGroup: true,
          groupMode: group.groupMode,
          quietHours: inQuietHours(now, group),
          targetMemberVerified: false,
          targetIsAi: identity.kind === "AI",
          consecutiveAiRounds: group.consecutiveAiRounds,
          maxConsecutiveAiRounds: MAX_AI_ROUNDS,
          sentToday,
          dailyLimit: ROLE_DAILY_LIMIT,
          lastContactAt,
          cooldownMs: FRIEND_COOLDOWN_MS,
          now,
        });
        if (!gate.allowed && gate.reason !== "target_not_verified") {
          lastSkipReason = gate.reason;
          await recordAttempt({
            scopeId: friend.id,
            status: "SKIPPED",
            reason: gate.reason,
            groupId: group.groupId,
            dedupeKey: `${dayKey(now)}:${group.groupId}:${Math.floor(now.getTime() / ATTEMPT_DEDUPE_WINDOW_MS)}`,
          });
          continue;
        }

        // 先核验一次群成员，避免对已退群/不在群的人白白调用模型；发送前仍会再核验。
        const preverified = await verifyOnebotGroupMember(group.connection.config, group.groupId, identity.platformUid);
        if (!preverified) {
          lastSkipReason = "target_not_verified";
          await recordAttempt({
            scopeId: friend.id,
            status: "SKIPPED",
            reason: "target_not_verified",
            groupId: group.groupId,
            dedupeKey,
          });
          handled = true;
          break;
        }

        const memories = await prisma.memoryItem.findMany({
          where: { memoryScopeId: friend.id, status: "ACTIVE", deletedAt: null },
          orderBy: [{ importance: "desc" }, { updatedAt: "desc" }],
          take: 8,
          select: { category: true, content: true },
        });
        const generated = await generateContactLine({
          character,
          friendName,
          relationshipStage: friend.relationshipStage ?? "FRIEND",
          memories: memories.map((item) => `[${item.category}] ${item.content.slice(0, 180)}`),
          recentLines: group.recentLines,
        });

        if (generated.error) {
          await recordAttempt({
            scopeId: friend.id,
            status: "FAILED",
            reason: "model_error",
            groupId: group.groupId,
            dedupeKey,
          });
          results.push({
            characterId: character.id,
            characterName: character.name,
            status: "failed",
            reason: "model_error",
            friend: friendName,
            groupId: group.groupId,
            detail: generated.error,
          });
          handled = true;
          break;
        }
        if (!generated.content) {
          await recordAttempt({
            scopeId: friend.id,
            status: "SKIPPED",
            reason: "nothing_to_say",
            groupId: group.groupId,
            dedupeKey,
          });
          results.push({ ...skip("nothing_to_say", friendName), groupId: group.groupId });
          handled = true;
          break;
        }

        // 模型生成期间好友可能退群、管理员可能改群模式、用户也可能撤销授权。
        // 因此发送前重新读取关系和 OneBot 绑定，不能沿用 tick 开始时的旧快照。
        const freshScope = await prisma.memoryScope.findUnique({
          where: { id: friend.id },
          select: {
            proactiveContactEnabled: true,
            friendChatPolicy: true,
            relationshipStage: true,
            relationshipStatus: true,
            externalIdentity: { select: { id: true, platformUid: true, kind: true, displayName: true, status: true } },
          },
        });
        const freshConnections = await loadOnebotConnections().catch(() => [] as OnebotConnectionRecord[]);
        const freshGroups = freshScope?.externalIdentity
          ? await findCommonGroups(character.id, freshScope.externalIdentity.platformUid, freshConnections)
          : [];
        const freshGroup = freshGroups.find((item) =>
          item.groupId === group.groupId && item.conversationId === group.conversationId
        );
        const freshSentToday = await prisma.socialProactiveContactAttempt.count({
          where: {
            status: "SENT",
            sentAt: { gte: groupChatDayStart(new Date()) },
            scope: { characterId: character.id },
          },
        });
        const freshLastContact = await prisma.socialProactiveContactAttempt.findFirst({
          where: { scopeId: friend.id, status: "SENT", sentAt: { not: null } },
          orderBy: { sentAt: "desc" },
          select: { sentAt: true },
        });
        const memberVerified = freshScope?.proactiveContactEnabled === true
          && freshScope.externalIdentity?.status !== "REVOKED"
          && freshScope.externalIdentity?.platformUid === identity.platformUid
          && Boolean(freshGroup)
          && await verifyOnebotGroupMember(freshGroup!.connection.config, freshGroup!.groupId, identity.platformUid);
        if (!freshScope || !freshScope.externalIdentity || !freshGroup || !memberVerified) {
          await recordAttempt({
            scopeId: friend.id,
            status: "SKIPPED",
            reason: "target_not_verified",
            groupId: group.groupId,
            dedupeKey,
          });
          results.push({ ...skip("target_not_verified", friendName), groupId: group.groupId });
          handled = true;
          break;
        }

        // 发之前再过一次所有策略闸门，尤其是重新授权、关系状态、群模式、冷却与每日上限。
        const finalGate = evaluateSocialProactiveContactGate({
          proactiveContactEnabled: freshScope.proactiveContactEnabled,
          relationshipStage: freshScope.relationshipStage,
          relationshipStatus: freshScope.relationshipStatus,
          identityKind: freshScope.externalIdentity.kind,
          friendChatPolicy: freshScope.friendChatPolicy,
          channelAvailable: true,
          hasCommonGroup: true,
          groupMode: freshGroup.groupMode,
          quietHours: inQuietHours(new Date(), freshGroup),
          targetMemberVerified: true,
          targetIsAi: freshScope.externalIdentity.kind === "AI",
          consecutiveAiRounds: freshGroup.consecutiveAiRounds,
          maxConsecutiveAiRounds: MAX_AI_ROUNDS,
          sentToday: freshSentToday,
          dailyLimit: ROLE_DAILY_LIMIT,
          lastContactAt: freshLastContact?.sentAt ?? null,
          cooldownMs: FRIEND_COOLDOWN_MS,
          now: new Date(),
        });
        if (!finalGate.allowed) {
          await recordAttempt({
            scopeId: friend.id,
            status: "SKIPPED",
            reason: finalGate.reason,
            groupId: group.groupId,
            dedupeKey,
          });
          results.push({ ...skip(finalGate.reason, friendName), groupId: group.groupId });
          handled = true;
          break;
        }

        const activeClaim = await prisma.socialProactiveContactAttempt.findFirst({
          where: {
            scopeId: friend.id,
            status: "SENDING",
            attemptedAt: { gte: new Date(Date.now() - ATTEMPT_DEDUPE_WINDOW_MS) },
          },
          select: { id: true },
        });
        if (activeClaim) {
          results.push({ ...skip("dispatch_in_progress", friendName), groupId: group.groupId });
          handled = true;
          break;
        }
        const claimed = await claimAttempt({
          scopeId: friend.id,
          groupId: group.groupId,
          dedupeKey,
          now: new Date(),
        });
        if (!claimed) {
          results.push({ ...skip("duplicate_attempt", friendName), groupId: group.groupId });
          handled = true;
          break;
        }

        let outboundSent = false;
        try {
          await sendOnebotGroupMessage(
            freshGroup.connection.config,
            freshGroup.groupId,
            buildSocialProactiveContactSegments(identity.platformUid, generated.content),
          );
          outboundSent = true;
          // 外部发送已成功，先把审计账本置为 SENT；后续消息转录写库失败也不能让它被再次发送。
          await prisma.socialProactiveContactAttempt.update({
            where: { scopeId_dedupeKey: { scopeId: friend.id, dedupeKey } },
            data: {
              status: "SENT",
              reason: "ok",
              content: generated.content,
              sentAt: now,
              metadata: {
                source: "social-proactive-contact",
                identityId: identity.id,
                platformUid: identity.platformUid,
                conversationId: group.conversationId,
              },
            },
          });
          await prisma.$transaction(async (tx) => {
            await tx.message.create({
              data: {
                conversationId: group.conversationId,
                role: "ASSISTANT",
                content: `@${friendName} ${generated.content}`,
                occurredAt: now,
                metadata: {
                  source: "social-proactive-contact",
                  platform: "qq-onebot",
                  groupId: group.groupId,
                  targetIdentityId: identity.id,
                  targetPlatformUid: identity.platformUid,
                },
              },
            });
            await tx.conversation.update({
              where: { id: group.conversationId },
              data: { lastMessageAt: now, consecutiveAiRounds: freshScope.externalIdentity.kind === "AI" ? freshGroup.consecutiveAiRounds + 1 : 0 },
            });
          });
          results.push({
            characterId: character.id,
            characterName: character.name,
            status: "sent",
            reason: "ok",
            friend: friendName,
            groupId: group.groupId,
            content: generated.content,
          });
        } catch (error) {
          if (!outboundSent) {
            await prisma.socialProactiveContactAttempt.update({
              where: { scopeId_dedupeKey: { scopeId: friend.id, dedupeKey } },
              data: { status: "FAILED", reason: "send_failed" },
            }).catch(() => undefined);
          }
          results.push({
            characterId: character.id,
            characterName: character.name,
            status: "failed",
            reason: outboundSent ? "sent_but_transcript_failed" : "send_failed",
            friend: friendName,
            groupId: group.groupId,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
        handled = true;
        break;
      }
      if (handled) break;
    }
    if (!handled) results.push(skip(lastSkipReason));
  }

  return results;
}
