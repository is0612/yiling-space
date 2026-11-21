import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { readLatestCleanupSummary } from "../server/utils/memory-cleanup-summary";

// 一次性库：只造自己的角色与审计行，结束时按外键顺序清理。
const connectionString = process.env.DATABASE_URL ?? "";
assert.equal(process.env.YILING_CHAT_ISOLATED_DB, "1");
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const userId = randomUUID();
const characterId = randomUUID();
const emptyCharacterId = randomUUID();
const globalScope = randomUUID();
const privateScope = randomUUID();
try {
  await prisma.user.create({ data: { id: userId, username: `cleanup-${userId}`, passwordHash: "synthetic-only" } });
  await prisma.character.createMany({ data: [
    { id: characterId, ownerId: userId, name: "清理摘要角色", basePrompt: "synthetic-only" },
    { id: emptyCharacterId, ownerId: userId, name: "没有清理记录的角色", basePrompt: "synthetic-only" },
  ] });
  await prisma.memoryScope.createMany({ data: [
    { id: globalScope, characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `g:${characterId}` },
    { id: privateScope, characterId, scopeType: "USER_PRIVATE", scopeKey: `p:${characterId}`, userId },
  ] });

  // 没有清理记录：返回 null，页面据此不显示这一行。
  assert.equal(await readLatestCleanupSummary(prisma, emptyCharacterId), null);

  // 两条记录：私人范围那条更新，应该取它。
  await prisma.auditLog.create({ data: {
    actorType: "WORKER", characterId, action: "message.retention_cleanup", entityType: "MemoryScope", entityId: globalScope,
    details: { cutoff: "2026-10-01T00:00:00.000Z", deletedMessages: 12, contextMessages: 5, contextCutoff: "2026-10-08T00:00:00.000Z" },
    createdAt: new Date("2026-11-10T02:00:00Z"),
  } });
  await prisma.auditLog.create({ data: {
    actorType: "WORKER", characterId, action: "message.retention_cleanup", entityType: "MemoryScope", entityId: privateScope,
    details: { cutoff: "2026-10-20T00:00:00.000Z", deletedMessages: 30, contextMessages: 9, contextCutoff: "2026-10-27T00:00:00.000Z" },
    createdAt: new Date("2026-11-20T02:00:00Z"),
  } });

  const latest = await readLatestCleanupSummary(prisma, characterId);
  assert(latest, "有记录时应返回摘要");
  assert.equal(latest.deletedMessages, 30, "取最近一条，不按范围偏好");
  assert.equal(latest.contextMessages, 9);
  assert.equal(latest.at, "2026-11-20T02:00:00.000Z");
  assert.equal(latest.cutoff, "2026-10-20T00:00:00.000Z");

  // 别的动作、别的实体都不该被当成清理记录。
  await prisma.auditLog.create({ data: {
    actorType: "WORKER", characterId, action: "memory_job.manual_retry", entityType: "MemoryScope", entityId: privateScope,
    details: { deletedMessages: 999 }, createdAt: new Date("2026-11-21T02:00:00Z"),
  } });
  assert.equal((await readLatestCleanupSummary(prisma, characterId))?.deletedMessages, 30, "只认清理动作");

  // 坏字段：类型不对就不编数字，页面会显示 0。
  await prisma.memoryScope.update({ where: { id: globalScope }, data: { scopeKey: `g2:${characterId}` } });
  await prisma.auditLog.create({ data: {
    actorType: "WORKER", characterId, action: "message.retention_cleanup", entityType: "MemoryScope", entityId: globalScope,
    details: { deletedMessages: "三十", contextMessages: -4, cutoff: "not-a-date" },
    createdAt: new Date("2026-11-22T02:00:00Z"),
  } });
  const dirty = await readLatestCleanupSummary(prisma, characterId);
  assert.equal(dirty?.deletedMessages, null, "类型不对不猜值");
  assert.equal(dirty?.contextMessages, 0, "负数归零");
  assert.equal(dirty?.cutoff, null, "解析不了的日期不硬转");

  console.log("清理摘要读取通过：无记录返回 null、取最新一条、只认清理动作、坏字段不编数字。");
} finally {
  await prisma.auditLog.deleteMany({ where: { characterId } });
  await prisma.memoryScope.deleteMany({ where: { characterId } });
  await prisma.character.deleteMany({ where: { id: { in: [characterId, emptyCharacterId] } } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
}
