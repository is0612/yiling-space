/**
 * Memory scope access rules for chat retrieval.
 *
 * Design constraints (see CLAUDE.md):
 * - Character-global memory is shared knowledge and always readable in this character's chat.
 * - User-private memory is only readable by its owning user.
 * - A private scope that comes from an external identity may only be read after that identity
 *   was verified and linked to the acting user. Unverified identities are never merged.
 * - Unknown scope types are denied by default.
 */

import { getPrisma } from "./prisma";

export type MemoryScopeOrigin = "character" | "private";

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
    if (scope.scopeType !== "USER_PRIVATE") continue;

    // Identity-scoped memory: require a verified link to the acting user.
    if (scope.externalIdentityId) {
      const identity = scope.externalIdentity;
      if (identity?.status === "VERIFIED" && identity.linkedUserId === actingUserId) {
        push(scope, "private");
      }
      continue;
    }

    // Direct user-scoped memory: only the owner may read it.
    if (scope.userId && scope.userId === actingUserId) push(scope, "private");
  }

  return accessible;
}

/**
 * Reads a stored source's scope origin. Records written before scope tracking existed have no
 * value and are treated as character-global, which is what they were retrieved from.
 */
export function readStoredMemoryScopeOrigin(value: unknown): MemoryScopeOrigin {
  return value === "private" ? "private" : "character";
}
