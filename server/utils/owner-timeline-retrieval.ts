import type { Prisma } from "../../src/generated/prisma/client";

/** 精确昵称与精确别名优先；存在多个不同账号时不猜。 */
export function selectUnambiguousParticipantAccounts(input: {
  exactDisplayNameIds?: readonly string[];
  aliasIds?: readonly string[];
  fuzzyDisplayNameIds?: readonly string[];
}): string[] {
  const exactIds = [...new Set([
    ...(input.exactDisplayNameIds ?? []),
    ...(input.aliasIds ?? []),
  ].map((id) => id.trim()).filter(Boolean))];
  if (exactIds.length > 1) return [];
  if (exactIds.length === 1) return exactIds;
  const fuzzyIds = [...new Set((input.fuzzyDisplayNameIds ?? []).map((id) => id.trim()).filter(Boolean))];
  return fuzzyIds.length === 1 ? fuzzyIds : [];
}

/** 普通好友只有角色全局范围；主人可额外读自己当前 QQ 身份范围中的旧群记录。 */
export function resolveOwnerTimelineGroupScopeIds(input: {
  isOwnerTurn: boolean;
  globalScopeId: string;
  ownerIdentityScopeId: string | null;
}): string[] {
  const ids = new Set([input.globalScopeId]);
  if (input.isOwnerTurn && input.ownerIdentityScopeId) ids.add(input.ownerIdentityScopeId);
  return [...ids];
}

/** 目标人物群原文查询：群会话、允许范围、平台、发言账号必须同时匹配。 */
export function buildOwnerTimelineGroupRawMessageWhere(input: {
  memoryScopeIds: readonly string[];
  platform: string;
  participantIds: readonly string[];
  range?: { start: Date; end: Date } | null;
}): Prisma.MessageWhereInput {
  const participantIds = [...new Set(input.participantIds.map((id) => id.trim()).filter(Boolean))];
  if (!input.memoryScopeIds.length || !participantIds.length) {
    // 空目标必须拒绝查询，不能退化成整群扫描。
    return { id: { equals: "__no_owner_timeline_target__" } };
  }
  return {
    conversation: {
      memoryScopeId: { in: [...input.memoryScopeIds] },
      externalConversationId: { startsWith: "g:" },
    },
    role: "USER",
    AND: [
      { metadata: { path: ["platform"], equals: input.platform } },
      { OR: participantIds.map((platformUid) => ({
        metadata: { path: ["authorOpenId"], equals: platformUid },
      })) },
    ],
    ...(input.range ? { occurredAt: { gte: input.range.start, lt: input.range.end } } : {}),
  };
}

/** 私聊身份范围可能残留旧群会话；私聊原文候选必须在 SQL 层排除 g: 群会话。 */
export function buildPrivateScopeRawMessageWhere(
  memoryScopeId: string,
  range?: { start: Date; end: Date } | null,
): Prisma.MessageWhereInput {
  return {
    conversation: {
      memoryScopeId,
      NOT: { externalConversationId: { startsWith: "g:" } },
    },
    role: { in: ["USER", "ASSISTANT"] },
    ...(range ? { occurredAt: { gte: range.start, lt: range.end } } : {}),
  };
}
