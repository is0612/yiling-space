import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { loadPromptMemoryCandidates } from "../server/utils/prompt-memory-candidates";
import { rankMemoriesWithBudget, rankSnapshotsWithBudget } from "../server/utils/memory-retrieval";

const connectionString = process.env.DATABASE_URL ?? "";
assert.equal(process.env.YILING_CHAT_ISOLATED_DB, "1");
assert(/^\/yiling_chat_test_[a-f0-9]{32}$/.test(new URL(connectionString).pathname), "Disposable chat database required.");
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const userId = randomUUID();
const characterId = randomUUID();
const global = randomUUID();
const own = randomUUID();
const other = randomUUID();
const old = new Date("2025-01-01T00:00:00Z");
const recent = new Date("2026-11-20T00:00:00Z");
try {
  await prisma.user.create({ data: { id: userId, username: `retrieval-${userId}`, passwordHash: "synthetic-only" } });
  await prisma.character.create({ data: {
    id: characterId, ownerId: userId, name: "检索验收角色", basePrompt: "synthetic-only",
    memoryScopes: { create: [
      { id: global, scopeType: "CHARACTER_GLOBAL", scopeKey: `global:${characterId}` },
      { id: own, scopeType: "USER_PRIVATE", scopeKey: `own:${characterId}`, userId },
      { id: other, scopeType: "EXTERNAL_IDENTITY", scopeKey: `other:${characterId}` },
    ] },
  } });
  const oldMemoryId = randomUUID();
  const oldSnapshotId = randomUUID();
  await prisma.memoryItem.createMany({ data: [
    ...Array.from({ length: 305 }, (_, i) => ({ memoryScopeId: global, category: "FACT" as const,
      content: `近期园艺安排${i}`, createdAt: recent, updatedAt: recent })),
    { id: oldMemoryId, memoryScopeId: global, category: "FACT", content: "星砂计划的纪念物是铜色风铃。", createdAt: old, updatedAt: old },
    { memoryScopeId: own, category: "FACT", content: "星砂计划私人约定是秋日重访。", createdAt: old, updatedAt: old },
    { memoryScopeId: other, category: "FACT", content: "星砂计划别人的秘密。" },
    { memoryScopeId: global, category: "FACT", content: "星砂计划旧错误是银色风铃。", status: "SUPERSEDED", createdAt: old, updatedAt: old },
    { memoryScopeId: global, category: "FACT", content: "星砂计划已删除的内容。", deletedAt: recent, createdAt: old, updatedAt: old },
  ] });
  await prisma.memorySnapshot.createMany({ data: [
    ...Array.from({ length: 85 }, (_, i) => ({ memoryScopeId: global, snapshotKey: `recent:${characterId}:${i}`,
      summary: `近期园艺总结${i}`, structuredContent: {}, periodStart: recent, periodEnd: recent, createdAt: recent })),
    { id: oldSnapshotId, memoryScopeId: global, snapshotKey: `old:${characterId}`, summary: "星砂计划完成了铜色风铃的制作。",
      structuredContent: {}, periodStart: old, periodEnd: old, createdAt: old },
    { memoryScopeId: other, snapshotKey: `private:${characterId}`, summary: "星砂计划别人的私人总结。",
      structuredContent: {}, periodStart: old, periodEnd: old, createdAt: old },
  ] });

  const query = "星砂计划";
  const legacyMemories = await prisma.memoryItem.findMany({ where: { memoryScopeId: global, status: "ACTIVE", deletedAt: null },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 300 });
  const legacySnapshots = await prisma.memorySnapshot.findMany({ where: { memoryScopeId: global, status: "CURRENT" },
    orderBy: [{ createdAt: "desc" }, { version: "desc" }], take: 80 });
  assert(!legacyMemories.some(item => item.id === oldMemoryId), "Fixture must reproduce the old memory window miss.");
  assert(!legacySnapshots.some(item => item.id === oldSnapshotId), "Fixture must reproduce the old snapshot window miss.");

  const candidates = await loadPromptMemoryCandidates(prisma, { readableScopeIds: [global, own], query });
  const selectedMemories = rankMemoriesWithBudget(query, candidates.memories, { tokenBudget: 1800, limit: 20 });
  const selectedSnapshots = rankSnapshotsWithBudget(query, candidates.snapshots, { tokenBudget: 2500, limit: 4 });
  const report = {
    memory: { exists: true, candidate: candidates.memories.some(item => item.id === oldMemoryId), supplied: selectedMemories.items.some(item => item.id === oldMemoryId) },
    snapshot: { exists: true, candidate: candidates.snapshots.some(item => item.id === oldSnapshotId), supplied: selectedSnapshots.items.some(item => item.id === oldSnapshotId) },
    answerCorrect: "unverified: no real model called",
  };
  assert(report.memory.candidate && report.memory.supplied);
  assert(report.snapshot.candidate && report.snapshot.supplied);
  assert.equal(new Set(candidates.memories.map(item => item.id)).size, candidates.memories.length);
  assert(candidates.memories.every(item => [global, own].includes(item.memoryScopeId)));
  assert(candidates.snapshots.every(item => [global, own].includes(item.memoryScopeId)));
  assert(!candidates.memories.some(item => /旧错误|已删除/.test(item.content)));
  assert(candidates.memories.some(item => item.memoryScopeId === own), "Authorized private evidence must remain accessible.");
  const smallPool = await loadPromptMemoryCandidates(prisma, { readableScopeIds: [own], query });
  assert.equal(smallPool.memories.length, 1, "An unsaturated pool must retain the full authorized sample.");
  const group = await loadPromptMemoryCandidates(prisma, { readableScopeIds: [global], query });
  assert(group.memories.every(item => item.memoryScopeId === global), "Group scopes must not widen to private memory.");
  assert.deepEqual(await loadPromptMemoryCandidates(prisma, { readableScopeIds: [], query }), { memories: [], snapshots: [] });
  const absent = await loadPromptMemoryCandidates(prisma, { readableScopeIds: [global], query: "赤焰珊瑚" });
  assert.equal(rankMemoriesWithBudget("赤焰珊瑚", absent.memories).items.length, 0);
  assert.equal(rankSnapshotsWithBudget("赤焰珊瑚", absent.snapshots).items.length, 0);
  console.log("Layered retrieval acceptance:", JSON.stringify(report));
} finally {
  await prisma.memoryScope.deleteMany({ where: { characterId } });
  await prisma.character.deleteMany({ where: { id: characterId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
}
