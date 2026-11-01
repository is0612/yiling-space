import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { ensureExternalIdentityScope, buildExternalIdentityScopeKey } from "../server/utils/identity-scope";
import { ensureOwnerPrivateScope, buildUserPrivateScopeKey, resolveChatMemoryScopes } from "../server/utils/memory-scope-access";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL，身份绑定测试无法运行。");

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

async function main() {
  const ownerId = randomUUID();
  const userId = randomUUID();
  const characterId = randomUUID();

  // 建最小依赖：两个用户 + 一个角色
  await prisma.user.createMany({
    data: [
      { id: ownerId, username: `id-test-owner-${randomUUID().slice(0, 8)}`, passwordHash: "x", role: "ADMIN" },
      { id: userId, username: `id-test-user-${randomUUID().slice(0, 8)}`, passwordHash: "x", role: "USER" },
    ],
  });
  await prisma.character.create({
    data: { id: characterId, ownerId, name: "id-test-character", basePrompt: "persona" },
  });

  // 1. 外部身份 upsert（模拟渠道消息进来时）
  const identity = await prisma.externalIdentity.upsert({
    where: { platform_platformUid: { platform: "bili", platformUid: "uid-123" } },
    create: { platform: "bili", platformUid: "uid-123", displayName: "B站用户", status: "UNVERIFIED" },
    update: {},
    select: { id: true, status: true },
  });
  assert.equal(identity.status, "UNVERIFIED");

  // 2. scopeKey 确定性生成
  const key1 = buildExternalIdentityScopeKey(characterId, "bili", "uid-123");
  const key2 = buildExternalIdentityScopeKey(characterId, "bili", "uid-123");
  assert.equal(key1, key2);
  assert.equal(key1, `character:${characterId}:external:bili:uid-123`);

  // 3. ensureExternalIdentityScope 建立 scope，且幂等
  const first = await ensureExternalIdentityScope(characterId, "bili", "uid-123", identity.id);
  assert.equal(first.created, true);
  const second = await ensureExternalIdentityScope(characterId, "bili", "uid-123", identity.id);
  assert.equal(second.created, false);
  assert.equal(first.scopeId, second.scopeId);

  // 4. resolveChatMemoryScopes：未验证身份 → 私人记忆不可读（只读角色全局）
  const scopes = [
    { id: "global", scopeType: "CHARACTER_GLOBAL", userId: null, externalIdentityId: null, externalIdentity: null },
    { id: "ext", scopeType: "USER_PRIVATE", userId: null, externalIdentityId: identity.id, externalIdentity: { status: "UNVERIFIED", linkedUserId: null } },
  ];
  const accessibleUnverified = resolveChatMemoryScopes(scopes as never, userId);
  const accessibleIdsUnverified = accessibleUnverified.map((s) => s.id);
  assert.ok(accessibleIdsUnverified.includes("global"), "角色全局应始终可读");
  assert.ok(!accessibleIdsUnverified.includes("ext"), "未验证身份私人记忆不应可读");

  // 5. resolveChatMemoryScopes：验证绑定到 userId 后 → 私人记忆可读
  const verifiedScopes = [
    { id: "global", scopeType: "CHARACTER_GLOBAL", userId: null, externalIdentityId: null, externalIdentity: null },
    { id: "ext", scopeType: "USER_PRIVATE", userId: null, externalIdentityId: identity.id, externalIdentity: { status: "VERIFIED", linkedUserId: userId } },
  ];
  const accessibleVerified = resolveChatMemoryScopes(verifiedScopes as never, userId);
  const accessibleIdsVerified = accessibleVerified.map((s) => s.id);
  assert.ok(accessibleIdsVerified.includes("ext"), "验证绑定后的身份私人记忆应可读");

  // 6. resolveChatMemoryScopes：验证绑定到"别人" → 当前用户不可读
  const otherUserId = randomUUID();
  const accessibleOther = resolveChatMemoryScopes(verifiedScopes as never, otherUserId);
  const accessibleIdsOther = accessibleOther.map((s) => s.id);
  assert.ok(!accessibleIdsOther.includes("ext"), "绑定到他人的身份记忆不应被当前用户读取");

  // 7. 主人专属私人范围：角色 owner 的 USER_PRIVATE scope，幂等建立，且只对 owner 可读
  const ownerScopeId = await ensureOwnerPrivateScope(characterId, ownerId);
  assert.ok(ownerScopeId, "主人专属范围应建立");
  const ownerScopeAgain = await ensureOwnerPrivateScope(characterId, ownerId);
  assert.equal(ownerScopeId, ownerScopeAgain, "主人专属范围应幂等");
  const ownerScopeKey = buildUserPrivateScopeKey(characterId, ownerId);
  assert.equal(ownerScopeKey, `character:${characterId}:user:${ownerId}`);
  const ownerScopes = [
    { id: "global", scopeType: "CHARACTER_GLOBAL", userId: null, externalIdentityId: null, externalIdentity: null },
    { id: "owner-private", scopeType: "USER_PRIVATE", userId: ownerId, externalIdentityId: null, externalIdentity: null },
  ];
  const ownerAccessible = resolveChatMemoryScopes(ownerScopes as never, ownerId);
  assert.ok(ownerAccessible.some((s) => s.id === "owner-private"), "主人的私人范围应只对主人可读");
  const nonOwnerAccessible = resolveChatMemoryScopes(ownerScopes as never, userId);
  assert.ok(!nonOwnerAccessible.some((s) => s.id === "owner-private"), "主人的私人范围不应被他人读取");

  console.log("✅ test-identity 全部通过");
  console.log("   身份 upsert + scope 幂等：通过");
  console.log("   未验证/已验证/他人绑定 三类隔离：通过");
  console.log("   主人专属范围建立 + 幂等 + 仅主人可读：通过");

  // 清理（先删 scope 和 identity，再删 character 和 user，因为 MemoryScope.character 是 Restrict）
  await prisma.memoryScope.deleteMany({ where: { characterId } });
  await prisma.externalIdentity.deleteMany({ where: { platform: "bili", platformUid: "uid-123" } });
  await prisma.character.delete({ where: { id: characterId } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, userId] } } });
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error("❌ test-identity 失败：", error);
  await prisma.$disconnect();
  process.exit(1);
});
