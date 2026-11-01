import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { resolveChatMemoryScopes } from "../server/utils/memory-scope-access";
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
const unverifiedScopeId = randomUUID();
const identityId = randomUUID();

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
  await prisma.externalIdentity.create({
    data: {
      id: identityId,
      platform: "test-platform",
      platformUid: `uid-${suffix}`,
      linkedUserId: actingUserId,
      status: "UNVERIFIED",
    },
  });
  await prisma.memoryScope.create({
    data: {
      id: unverifiedScopeId,
      characterId,
      scopeType: "USER_PRIVATE",
      scopeKey: `character:${characterId}:identity:${identityId}`,
      externalIdentityId: identityId,
    },
  });

  await prisma.memoryItem.createMany({
    data: [
      { memoryScopeId: globalScopeId, category: "FACT", content: "角色全局：喜欢清晨散步。", status: "ACTIVE" },
      { memoryScopeId: actingPrivateScopeId, category: "GOAL", content: "我的私人：想在今年学会潜水。", status: "ACTIVE" },
      { memoryScopeId: otherPrivateScopeId, category: "GOAL", content: "别人的私人：正在准备考研。", status: "ACTIVE" },
      { memoryScopeId: unverifiedScopeId, category: "FACT", content: "未验证身份：自称住在海边。", status: "ACTIVE" },
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
    [globalScopeId, actingPrivateScopeId].sort(),
    "Only the global scope and the acting user's own private scope may be readable.",
  );

  const readableIds = readable.map((scope) => scope.id);
  const memories = await prisma.memoryItem.findMany({
    where: { memoryScopeId: { in: readableIds }, status: "ACTIVE", deletedAt: null },
    select: { id: true, content: true, memoryScopeId: true },
  });
  const contents = memories.map((memory) => memory.content).sort();
  assert.deepEqual(contents, ["角色全局：喜欢清晨散步。", "我的私人：想在今年学会潜水。"].sort(), "Cross-user or unverified-scope memory must not be readable.");
  assert(!memories.some((memory) => memory.memoryScopeId === otherPrivateScopeId), "Another user's private memory leaked.");
  assert(!memories.some((memory) => memory.memoryScopeId === unverifiedScopeId), "Unverified identity memory leaked.");

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
  const globalEntry = timeline.find((entry) => entry.summary.includes("角色全局"));
  assert.equal(privateEntry?.channel, "私人记忆", "Private memory must be labelled in the timeline.");
  assert.equal(globalEntry?.channel, "长期记忆", "Global memory keeps its existing timeline label.");

  console.log("Private memory DB integration passed: scope allow-list, cross-user rejection, unverified identity rejection, and timeline labelling.");
} finally {
  await prisma.auditLog.deleteMany({ where: { characterId } });
  await prisma.memoryItem.deleteMany({ where: { memoryScope: { is: { characterId } } } });
  await prisma.memoryScope.deleteMany({ where: { characterId } });
  await prisma.externalIdentity.deleteMany({ where: { id: identityId } });
  await prisma.character.deleteMany({ where: { id: characterId } });
  await prisma.user.deleteMany({ where: { id: { in: [actingUserId, otherUserId] } } });
  await prisma.$disconnect();
}
