/**
 * Memory scope access rules for chat retrieval and the owner-facing memory pages.
 *
 * Design constraints (see CLAUDE.md, docs/memory-system.md §9.1):
 * - Character-global memory is shared knowledge and always readable in this character's chat.
 * - User-private memory is only readable by its owning user.
 * - A private scope that comes from an external identity may only be read after that identity
 *   was verified and linked to the acting user. Unverified identities are never merged.
 * - Real platform scopes are stored with `scopeType = EXTERNAL_IDENTITY` (see identity-scope.ts);
 *   older rows used `USER_PRIVATE` + `externalIdentityId`. Both shapes follow the same rule.
 * - Unknown scope types are denied by default.
 */

import { Prisma } from "../../src/generated/prisma/client";
import { getPrisma } from "./prisma";

// 与前端共用一份（shared/types/chat.ts）。
import type { MemoryScopeOrigin } from "../../shared/types/chat";

export type MemoryScopeCandidate = {
  id: string;
  scopeType: string;
  userId?: string | null;
  externalIdentityId?: string | null;
  externalIdentity?: {
    status?: string | null;
    linkedUserId?: string | null;
  } | null;
};

export type AccessibleChatScope = {
  id: string;
  scopeType: "CHARACTER_GLOBAL" | "USER_PRIVATE";
  origin: MemoryScopeOrigin;
};

export function buildUserPrivateScopeKey(characterId: string, userId: string): string {
  return "character:" + characterId + ":user:" + userId;
}

/**
 * 角色主人的私人记忆范围（USER_PRIVATE）。
 *
 * 「主人」是角色 `Character.ownerId` 指向的那个站内用户；QQ 渠道里主人说话时，他的私聊
 * 会话挂到这个范围下，而不是该账号的外部身份（EXTERNAL_IDENTITY）范围。这样主人的私聊：
 *   - 走「角色主人私人记忆」，由调度器单独排周期快照；
 *   - 只在主人自己的对话里可读（resolveChatMemoryScopes 对 USER_PRIVATE 按 userId 放行）；
 *   - 不混进角色全局记忆，也不会串给群友或其他人。
 *
 * 确定性 scopeKey（character + user），与 memories/index.post.ts 的 private 范围是同一个概念。
 */
export async function ensureOwnerPrivateScope(characterId: string, ownerUserId: string): Promise<string | null> {
  if (!ownerUserId) return null;
  const prisma = getPrisma();
  const scopeKey = buildUserPrivateScopeKey(characterId, ownerUserId);
  const scope = await prisma.memoryScope.upsert({
    where: { scopeKey },
    create: { characterId, scopeType: "USER_PRIVATE", scopeKey, userId: ownerUserId },
    update: {},
    select: { id: true },
  });
  return scope.id;
}

/** 外部身份是否已由管理员验证并绑定到当前用户。缺失身份关系时一律视为未验证。 */
function isVerifiedIdentityOf(scope: MemoryScopeCandidate, actingUserId: string): boolean {
  if (!scope.externalIdentityId) return false;
  const identity = scope.externalIdentity;
  return identity?.status === "VERIFIED" && identity.linkedUserId === actingUserId;
}

/**
 * 单条范围是否可被当前用户读取。`resolveChatMemoryScopes` 与数据库 where/sql 三个入口
 * 必须保持同一套规则；改这里之前先对照 `readableMemoryScopeWhere` 与
 * `readableMemoryScopeSql`，不要只改一处。
 */
export function isMemoryScopeReadable(scope: MemoryScopeCandidate, actingUserId: string): boolean {
  if (scope.scopeType === "CHARACTER_GLOBAL") return true;
  if (scope.scopeType === "EXTERNAL_IDENTITY") return isVerifiedIdentityOf(scope, actingUserId);
  if (scope.scopeType === "USER_PRIVATE") {
    // 历史数据里外部身份私人记忆曾写成 USER_PRIVATE + externalIdentityId。
    if (scope.externalIdentityId) return isVerifiedIdentityOf(scope, actingUserId);
    return Boolean(scope.userId) && scope.userId === actingUserId;
  }
  return false;
}

/**
 * Returns every memory scope the acting user may read in this character's chat, in a stable
 * order: character-global scopes first, then the user's own private scopes.
 * Anything the rules do not explicitly allow is dropped, so a caller that only queries the
 * returned IDs cannot accidentally read another user's private memory.
 */
export function resolveChatMemoryScopes(
  scopes: readonly MemoryScopeCandidate[],
  actingUserId: string,
): AccessibleChatScope[] {
  const accessible: AccessibleChatScope[] = [];
  const seen = new Set<string>();

  const push = (scope: MemoryScopeCandidate, origin: MemoryScopeOrigin) => {
    if (seen.has(scope.id)) return;
    seen.add(scope.id);
    accessible.push({
      id: scope.id,
      scopeType: origin === "character" ? "CHARACTER_GLOBAL" : "USER_PRIVATE",
      origin,
    });
  };

  for (const scope of scopes) {
    if (scope.scopeType === "CHARACTER_GLOBAL") push(scope, "character");
  }

  for (const scope of scopes) {
    if (scope.scopeType === "CHARACTER_GLOBAL") continue;
    if (isMemoryScopeReadable(scope, actingUserId)) push(scope, "private");
  }

  return accessible;
}

/**
 * Prisma 侧的同一套规则，供记忆列表 / 回收站 / 阶段总结等按角色查询的接口使用。
 *
 * 只按 `characterId` 过滤是不够的：那样会把其他站内用户的 USER_PRIVATE 和未验证外部身份
 * 的私人记忆一起列出来。角色主人能看的只有「角色全局 + 自己的私人 + 已验证绑定自己的外部」。
 */
export function readableMemoryScopeWhere(actingUserId: string): Prisma.MemoryScopeWhereInput {
  return {
    OR: [
      { scopeType: "CHARACTER_GLOBAL" },
      { scopeType: "USER_PRIVATE", userId: actingUserId, externalIdentityId: null },
      // 历史外部身份私人记忆（USER_PRIVATE + externalIdentityId）。
      {
        scopeType: "USER_PRIVATE",
        externalIdentityId: { not: null },
        externalIdentity: { is: { status: "VERIFIED", linkedUserId: actingUserId } },
      },
      {
        scopeType: "EXTERNAL_IDENTITY",
        externalIdentityId: { not: null },
        externalIdentity: { is: { status: "VERIFIED", linkedUserId: actingUserId } },
      },
    ],
  };
}

/**
 * 与 `readableMemoryScopeWhere` 等价的原始 SQL 片段，用于先锁行再校验的接口。
 * 调用方自己拼 `AND ${readableMemoryScopeSql(ownerId)}`，别名固定为 `s`（memory_scopes）。
 */
export function readableMemoryScopeSql(actingUserId: string): Prisma.Sql {
  return Prisma.sql`(
    s."scopeType" = 'CHARACTER_GLOBAL'
    OR (s."scopeType" = 'USER_PRIVATE' AND s."externalIdentityId" IS NULL AND s."userId" = ${actingUserId}::uuid)
    OR (
      s."externalIdentityId" IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM external_identities i
        WHERE i.id = s."externalIdentityId"
          AND i.status = 'VERIFIED'
          AND i."linkedUserId" = ${actingUserId}::uuid
      )
    )
  )`;
}

/**
 * Reads a stored source's scope origin. Records written before scope tracking existed have no
 * value and are treated as character-global, which is what they were retrieved from.
 */
export function readStoredMemoryScopeOrigin(value: unknown): MemoryScopeOrigin {
  return value === "private" ? "private" : "character";
}
