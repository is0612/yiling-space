/**
 * 外部身份的记忆范围管理：为某个外部身份（B站 uid / QQ openid）建立/查找其专属
 * EXTERNAL_IDENTITY 记忆范围。这是"按平台隔离私人记忆"的基础。
 *
 * 规则（对齐 memory-system.md 第 6 节与 CLAUDE.md 第 4 条）：
 * - scopeKey 确定性生成：character:{characterId}:external:{platform}:{platformUid}
 * - 未验证身份（UNVERIFIED）的私人记忆仅该身份内部可读，绝不跨平台、绝不自动合并。
 * - 只有管理员显式「验证绑定」到某个 yiling-hub 用户后，resolveChatMemoryScopes 才放行。
 */

import { getPrisma } from "./prisma";

export function buildExternalIdentityScopeKey(characterId: string, platform: string, platformUid: string): string {
  return `character:${characterId}:external:${platform}:${platformUid}`;
}

export async function ensureExternalIdentityScope(
  characterId: string,
  platform: string,
  platformUid: string,
  externalIdentityId: string,
): Promise<{ scopeId: string; created: boolean }> {
  const prisma = getPrisma();
  const scopeKey = buildExternalIdentityScopeKey(characterId, platform, platformUid);

  const existing = await prisma.memoryScope.findUnique({
    where: { scopeKey },
    select: { id: true },
  });
  if (existing) return { scopeId: existing.id, created: false };

  const created = await prisma.memoryScope.create({
    data: {
      characterId,
      scopeType: "EXTERNAL_IDENTITY",
      scopeKey,
      externalIdentityId,
    },
    select: { id: true },
  });
  return { scopeId: created.id, created: true };
}
