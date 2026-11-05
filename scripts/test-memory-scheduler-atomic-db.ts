import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { enqueueDueMemorySnapshots } from "../server/utils/memory-scheduler";

// Never allow this regression to write to the user's business database.
const connectionString = process.env.DATABASE_URL ?? "";
const database = new URL(connectionString);
assert(/^\/yiling_memory_test_[a-f0-9]{32}$/.test(database.pathname), "Run through the disposable memory reliability runner.");
assert(["localhost", "127.0.0.1", "[::1]"].includes(database.hostname));

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

const suffix = randomUUID();
const ownerId = randomUUID();
const characterId = randomUUID();
const globalScopeId = randomUUID();
const ownerPrivateScopeId = randomUUID();
const friendScopeId = randomUUID();
const friendConversationId = randomUUID();
const now = new Date("2026-10-24T12:00:00.000Z");
const nextSnapshotAt = new Date("2026-10-01T00:00:00.000Z");
const expectedNextSnapshotAt = new Date("2026-10-25T00:00:00.000Z");

/**
 * 让「主人私聊范围」的入队失败一次。
 *
 * 这一条以前发生在全局事务提交之后：只要进程在那一步退出，下一轮就会从已经推进的
 * 游标重新反推周期，主人私聊/朋友范围的那段时间永远没有任务，也不会自动追补。
 */
function failingClient() {
  let failed = false;
  return prisma.$extends({
    query: {
      memoryJob: {
        async createMany({ args, query }) {
          const data = Array.isArray(args.data) ? args.data : [args.data];
          if (!failed && data.some((row: { memoryScopeId?: string }) => row.memoryScopeId === ownerPrivateScopeId)) {
            failed = true;
            throw new Error("injected companion enqueue failure");
          }
          return query(args);
        },
      },
    },
  });
}

try {
  await prisma.user.create({ data: { id: ownerId, username: `scheduler-atomic-${suffix}`, passwordHash: "test-only" } });
  await prisma.character.create({
    data: {
      id: characterId,
      ownerId,
      name: "调度器原子性测试角色",
      basePrompt: "仅用于自动化测试。",
      memorySetting: {
        create: {
          timezone: "UTC",
          anchorAt: new Date("2026-10-01T00:00:00.000Z"),
          nextSnapshotAt,
          snapshotIntervalDays: 3,
          autoSnapshotEnabled: true,
        },
      },
    },
  });
  await prisma.memoryScope.create({
    data: { id: globalScopeId, characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `atomic:${suffix}` },
  });
  await prisma.memoryScope.create({
    data: { id: ownerPrivateScopeId, characterId, userId: ownerId, scopeType: "USER_PRIVATE", scopeKey: `atomic-private:${suffix}` },
  });
  await prisma.memoryScope.create({
    data: {
      id: friendScopeId, characterId, scopeType: "EXTERNAL_IDENTITY", scopeKey: `atomic-friend:${suffix}`,
      interactionCount: 1, lastInteractedAt: now,
    },
  });
  await prisma.conversation.create({
    data: {
      id: friendConversationId, characterId, memoryScopeId: friendScopeId, title: "朋友会话",
      lastMessageAt: new Date("2026-10-10T00:00:00.000Z"),
    },
  });

  const failing = failingClient();
  const failedPass = await enqueueDueMemorySnapshots(failing as unknown as PrismaClient, { now, ownerId })
    .then(() => null, (error: unknown) => error);
  assert(failedPass instanceof Error, "注入的入队失败必须冒泡，不能被当成空列表吞掉");

  const jobsAfterFailure = await prisma.memoryJob.count({ where: { memoryScope: { characterId } } });
  assert.equal(jobsAfterFailure, 0, "补排失败时全局任务也必须回滚，不能只留下半套");
  const settingAfterFailure = await prisma.characterMemorySetting.findUniqueOrThrow({ where: { characterId } });
  assert.equal(settingAfterFailure.nextSnapshotAt?.toISOString(), nextSnapshotAt.toISOString(),
    "补排失败时周期游标不能前进，否则这些范围会永久漏排");

  const recovered = await enqueueDueMemorySnapshots(prisma, { now, ownerId });
  assert.equal(recovered.settingsAdvanced, 1);

  for (const [label, scopeId] of [["全局", globalScopeId], ["主人私聊", ownerPrivateScopeId], ["朋友", friendScopeId]] as const) {
    const count = await prisma.memoryJob.count({ where: { memoryScopeId: scopeId, type: "GENERATE_SNAPSHOT" } });
    assert(count > 0, `${label}范围必须在重试的那一轮补上，实际 ${count} 条`);
  }
  const settingAfterRecovery = await prisma.characterMemorySetting.findUniqueOrThrow({ where: { characterId } });
  assert.equal(settingAfterRecovery.nextSnapshotAt?.toISOString(), expectedNextSnapshotAt.toISOString());

  console.log("Scheduler atomicity DB regression passed: companion scopes and the cycle cursor commit together, a failed pass rolls back and is retried.");
} finally {
  await prisma.modelUsage.deleteMany({ where: { characterId } });
  await prisma.memoryJob.deleteMany({ where: { memoryScope: { characterId } } });
  await prisma.memorySnapshot.deleteMany({ where: { memoryScope: { characterId } } });
  await prisma.memoryEvent.deleteMany({ where: { memoryScope: { characterId } } });
  await prisma.memoryEventDay.deleteMany({ where: { memoryScope: { characterId } } });
  await prisma.characterJournal.deleteMany({ where: { memoryScope: { characterId } } });
  await prisma.conversation.deleteMany({ where: { characterId } });
  await prisma.auditLog.deleteMany({ where: { characterId } });
  await prisma.memoryScope.deleteMany({ where: { characterId } });
  await prisma.characterMemorySetting.deleteMany({ where: { characterId } });
  await prisma.character.delete({ where: { id: characterId } });
  await prisma.user.delete({ where: { id: ownerId } });
  await prisma.$disconnect();
}
