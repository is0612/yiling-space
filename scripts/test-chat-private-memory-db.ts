import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import {
  readableMemoryScopeSql,
  readableMemoryScopeWhere,
  resolveChatMemoryScopes,
} from "../server/utils/memory-scope-access";
import { toMemoryTimelineDtos } from "../server/utils/memory-timeline-dto";

// Database-backed isolation test. It reuses the exact Prisma query shape the chat endpoint runs,
// creates only its own records, and deletes them again in the finally block. Point DATABASE_URL at a
// local development/test database, not one holding data you care about.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL。");

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

const suffix = randomUUID();
const actingUserId = randomUUID();
const otherUserId = randomUUID();
const characterId = randomUUID();
const globalScopeId = randomUUID();
const actingPrivateScopeId = randomUUID();
const otherPrivateScopeId = randomUUID();
const legacyScopeId = randomUUID();
const externalOwnScopeId = randomUUID();
const externalOtherScopeId = randomUUID();
const externalUnverifiedScopeId = randomUUID();
const externalRevokedScopeId = randomUUID();
const verifiedOwnIdentityId = randomUUID();
const verifiedOtherIdentityId = randomUUID();
const unverifiedIdentityId = randomUUID();
const revokedIdentityId = randomUUID();

try {
  await prisma.user.createMany({
    data: [
      { id: actingUserId, username: `scope-test-a-${suffix}`, passwordHash: "integration-test-only" },
      { id: otherUserId, username: `scope-test-b-${suffix}`, passwordHash: "integration-test-only" },
    ],
  });
  await prisma.character.create({
    data: {
      id: characterId,
      ownerId: actingUserId,
      name: "范围隔离测试角色",
      basePrompt: "integration test",
      memoryScopes: {
        create: [
          { id: globalScopeId, scopeType: "CHARACTER_GLOBAL", scopeKey: `character:${characterId}:global` },
          { id: actingPrivateScopeId, scopeType: "USER_PRIVATE", scopeKey: `character:${characterId}:user:${actingUserId}`, userId: actingUserId },
          { id: otherPrivateScopeId, scopeType: "USER_PRIVATE", scopeKey: `character:${characterId}:user:${otherUserId}`, userId: otherUserId },
        ],
      },
    },
  });
  await prisma.externalIdentity.createMany({
    data: [
      { id: verifiedOwnIdentityId, platform: "test-platform", platformUid: `own-${suffix}`, linkedUserId: actingUserId, status: "VERIFIED" },
      { id: verifiedOtherIdentityId, platform: "test-platform", platformUid: `other-${suffix}`, linkedUserId: otherUserId, status: "VERIFIED" },
      // UNVERIFIED 但 linkedUserId 已填：status 本身必须是放行条件。
      { id: unverifiedIdentityId, platform: "test-platform", platformUid: `unverified-${suffix}`, linkedUserId: actingUserId, status: "UNVERIFIED" },
      { id: revokedIdentityId, platform: "test-platform", platformUid: `revoked-${suffix}`, linkedUserId: actingUserId, status: "REVOKED" },
    ],
  });
  await prisma.memoryScope.createMany({
    data: [
      // 历史写法：外部身份私人记忆存成 USER_PRIVATE + externalIdentityId。
      {
        id: legacyScopeId, characterId, scopeType: "USER_PRIVATE",
        scopeKey: `character:${characterId}:identity:${unverifiedIdentityId}`, externalIdentityId: unverifiedIdentityId,
      },
      // 真实写法：平台范围就是 EXTERNAL_IDENTITY。
      {
        id: externalOwnScopeId, characterId, scopeType: "EXTERNAL_IDENTITY",
        scopeKey: `character:${characterId}:external:test-platform:own-${suffix}`,
        externalIdentityId: verifiedOwnIdentityId,
      },
      {
        id: externalOtherScopeId, characterId, scopeType: "EXTERNAL_IDENTITY",
        scopeKey: `character:${characterId}:external:test-platform:other-${suffix}`,
        externalIdentityId: verifiedOtherIdentityId,
      },
      {
        id: externalUnverifiedScopeId, characterId, scopeType: "EXTERNAL_IDENTITY",
        scopeKey: `character:${characterId}:external:test-platform:unverified-${suffix}`,
        externalIdentityId: unverifiedIdentityId,
      },
      {
        id: externalRevokedScopeId, characterId, scopeType: "EXTERNAL_IDENTITY",
        scopeKey: `character:${characterId}:external:test-platform:revoked-${suffix}`,
        externalIdentityId: revokedIdentityId,
      },
    ],
  });

  await prisma.memoryItem.createMany({
    data: [
      { memoryScopeId: globalScopeId, category: "FACT", content: "角色全局：喜欢清晨散步。", status: "ACTIVE" },
      { memoryScopeId: actingPrivateScopeId, category: "GOAL", content: "我的私人：想在今年学会潜水。", status: "ACTIVE" },
      { memoryScopeId: otherPrivateScopeId, category: "GOAL", content: "别人的私人：正在准备考研。", status: "ACTIVE" },
      { memoryScopeId: legacyScopeId, category: "FACT", content: "历史未验证身份：自称住在海边。", status: "ACTIVE" },
      { memoryScopeId: externalOwnScopeId, category: "PREFERENCE", content: "我的已验证 QQ：喜欢下雨天。", status: "ACTIVE" },
      { memoryScopeId: externalOtherScopeId, category: "PREFERENCE", content: "别人的已验证 QQ：养了一只猫。", status: "ACTIVE" },
      { memoryScopeId: externalUnverifiedScopeId, category: "FACT", content: "未验证 QQ：说自己在医院工作。", status: "ACTIVE" },
      { memoryScopeId: externalRevokedScopeId, category: "FACT", content: "已撤销 QQ：旧备注。", status: "ACTIVE" },
    ],
  });

  // Same query shape as the chat endpoint.
  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId: actingUserId },
    select: {
      id: true,
      memoryScopes: {
        select: {
          id: true,
          scopeType: true,
          userId: true,
          externalIdentityId: true,
          externalIdentity: { select: { status: true, linkedUserId: true } },
        },
      },
    },
  });
  assert(character, "Character lookup must succeed.");

  const readable = resolveChatMemoryScopes(character.memoryScopes, actingUserId);
  assert.deepEqual(
    readable.map((scope) => scope.id).sort(),
    [globalScopeId, actingPrivateScopeId, externalOwnScopeId].sort(),
    "Only the global scope, the acting user's private scope and their verified identity may be readable.",
  );
  assert(
    readable.find((scope) => scope.id === externalOwnScopeId)?.origin === "private",
    "A real EXTERNAL_IDENTITY scope must be labelled private, not character-global.",
  );

  const readableIds = readable.map((scope) => scope.id);
  const expectedContents = ["角色全局：喜欢清晨散步。", "我的私人：想在今年学会潜水。", "我的已验证 QQ：喜欢下雨天。"].sort();

  const memories = await prisma.memoryItem.findMany({
    where: { memoryScopeId: { in: readableIds }, status: "ACTIVE", deletedAt: null },
    select: { id: true, content: true, memoryScopeId: true },
  });
  assert.deepEqual(memories.map((memory) => memory.content).sort(), expectedContents, "Cross-user or unverified-scope memory must not be readable.");
  for (const leaked of [otherPrivateScopeId, legacyScopeId, externalOtherScopeId, externalUnverifiedScopeId, externalRevokedScopeId]) {
    assert(!memories.some((memory) => memory.memoryScopeId === leaked), `Scope leaked into chat retrieval: ${leaked}`);
  }

  // The owner-facing memory list uses a Prisma where instead of an in-memory allow-list.
  const listed = await prisma.memoryItem.findMany({
    where: {
      status: "ACTIVE",
      memoryScope: { is: { characterId, ...readableMemoryScopeWhere(actingUserId) } },
    },
    select: { content: true, memoryScopeId: true },
  });
  assert.deepEqual(listed.map((memory) => memory.content).sort(), expectedContents, "The memory list must use the same readable-scope rule as chat.");
  for (const leaked of [otherPrivateScopeId, legacyScopeId, externalOtherScopeId, externalUnverifiedScopeId, externalRevokedScopeId]) {
    assert(!listed.some((memory) => memory.memoryScopeId === leaked), `Scope leaked into the memory list: ${leaked}`);
  }

  // The raw-SQL variant is used by endpoints that lock a row before checking ownership.
  const rawListed = await prisma.$queryRaw<Array<{ content: string; memoryScopeId: string }>>`
    SELECT m.content, m."memoryScopeId"
    FROM memory_items m
    JOIN memory_scopes s ON s.id = m."memoryScopeId"
    WHERE s."characterId" = ${characterId}::uuid
      AND m.status::text = 'ACTIVE'
      AND ${readableMemoryScopeSql(actingUserId)}
  `;
  assert.deepEqual(rawListed.map((memory) => memory.content).sort(), expectedContents, "The raw-SQL scope filter must match the Prisma filter.");
  for (const leaked of [otherPrivateScopeId, legacyScopeId, externalOtherScopeId, externalUnverifiedScopeId, externalRevokedScopeId]) {
    assert(!rawListed.some((memory) => memory.memoryScopeId === leaked), `Scope leaked into the locked row query: ${leaked}`);
  }

  // Timeline labelling for private memory.
  const timelineRecords = await prisma.memoryItem.findMany({
    where: { memoryScope: { is: { characterId } } },
    select: {
      id: true,
      category: true,
      content: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      memoryScope: { select: { scopeType: true } },
    },
  });
  const timeline = toMemoryTimelineDtos({ messages: [], memoryItems: timelineRecords, snapshots: [] });
  const privateEntry = timeline.find((entry) => entry.summary.includes("我的私人"));
  const externalEntry = timeline.find((entry) => entry.summary.includes("我的已验证 QQ"));
  const globalEntry = timeline.find((entry) => entry.summary.includes("角色全局"));
  assert.equal(privateEntry?.channel, "私人记忆", "Private memory must be labelled in the timeline.");
  assert.equal(externalEntry?.channel, "私人记忆", "A verified external identity scope must also be labelled private.");
  assert.equal(globalEntry?.channel, "长期记忆", "Global memory keeps its existing timeline label.");

  console.log("Private memory DB integration passed: real EXTERNAL_IDENTITY scopes, verified/unverified/revoked/other-user rejection, Prisma + raw SQL list filters, and timeline labelling.");
} finally {
  await prisma.auditLog.deleteMany({ where: { characterId } });
  await prisma.memoryItem.deleteMany({ where: { memoryScope: { is: { characterId } } } });
  await prisma.memoryScope.deleteMany({ where: { characterId } });
  await prisma.externalIdentity.deleteMany({
    where: { id: { in: [verifiedOwnIdentityId, verifiedOtherIdentityId, unverifiedIdentityId, revokedIdentityId] } },
  });
  await prisma.character.deleteMany({ where: { id: characterId } });
  await prisma.user.deleteMany({ where: { id: { in: [actingUserId, otherUserId] } } });
  await prisma.$disconnect();
}
