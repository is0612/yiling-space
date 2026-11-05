import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPrisma } from "../server/utils/prisma";
import { processNextMemoryJob } from "../server/utils/memory-worker";

const database = new URL(process.env.DATABASE_URL ?? "").pathname.slice(1);
assert(/^yiling_memory_test_[a-f0-9]{32}$/.test(database), "Run through test:memory-reliability-isolated only.");
const prisma = getPrisma();
const ownerId = randomUUID();
const characterId = randomUUID();
const scopeId = randomUUID();
const groupId = randomUUID();
const privateId = randomUUID();
const now = new Date("2026-11-05T12:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
const originalFetch = globalThis.fetch;
const originalEnv = Object.fromEntries(["LLM_API_KEY", "LLM_MODEL", "LLM_BASE_URL"].map((key) => [key, process.env[key]]));
let modelCalls = 0;
for (const key of Object.keys(originalEnv)) process.env[key] = "";
globalThis.fetch = async () => { modelCalls += 1; throw new Error("Model/network calls are forbidden in cleanup dependency tests"); };

async function messagesAt(days: number) {
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  await prisma.message.createMany({ data: ids.map((id, index) => ({
    id, conversationId: index === 2 ? privateId : groupId, role: "USER" as const, eventType: "message",
    content: `cleanup dependency fixture ${id}`, occurredAt: daysAgo(days),
    metadata: { storedReason: index === 0 ? "silent" : "context" },
  })) });
  return ids;
}

try {
  await prisma.user.create({ data: { id: ownerId, username: `cleanup-dependency-${ownerId}`, passwordHash: "test-only" } });
  await prisma.character.create({ data: { id: characterId, ownerId, name: `cleanup-${characterId}`, basePrompt: "test", modelConfig: {} } });
  await prisma.memoryScope.create({ data: { id: scopeId, characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `cleanup-dependency:${scopeId}` } });
  await prisma.characterMemorySetting.create({ data: {
    characterId, rawMessageCleanupEnabled: true, rawMessageRetentionDays: 30, autoSnapshotEnabled: false,
  } });
  await prisma.conversation.createMany({ data: [
    { id: groupId, characterId, memoryScopeId: scopeId, externalConversationId: `g:${randomUUID()}` },
    { id: privateId, characterId, memoryScopeId: scopeId, externalConversationId: `c:${randomUUID()}` },
  ] });
  const ids = await messagesAt(9);
  const dependency = await prisma.memoryJob.create({ data: {
    memoryScopeId: scopeId, type: "EXTRACT_EVENTS", status: "QUEUED",
    idempotencyKey: `cleanup-events:${randomUUID()}`, periodStart: daysAgo(9), periodEnd: daysAgo(8),
    // Not runnable yet, but still consumes evidence that cleanup must retain.
    runAt: new Date(now.getTime() + 86_400_000),
  } });
  const cleanup = await prisma.memoryJob.create({ data: {
    memoryScopeId: scopeId, type: "CLEAN_EXPIRED_MESSAGES", idempotencyKey: `cleanup:${randomUUID()}`,
    periodEnd: daysAgo(30), runAt: now,
  } });
  for (const status of ["QUEUED", "RETRY_WAIT"] as const) {
    await prisma.memoryJob.update({ where: { id: dependency.id }, data: { status } });
    await prisma.memoryJob.update({ where: { id: cleanup.id }, data: { runAt: now } });
    const result = await processNextMemoryJob(prisma, { now, ownerId, workerId: `cleanup-${randomUUID()}` });
    assert.equal(result.processed && result.jobId, cleanup.id);
    assert.equal(result.processed && result.status, "RETRY_WAIT");
    const deferred = await prisma.memoryJob.findUniqueOrThrow({ where: { id: cleanup.id } });
    assert.equal(deferred.status, "RETRY_WAIT");
    assert.equal(deferred.attemptCount, 0, "Dependency waits must not consume attempts");
    assert.equal(deferred.lockedBy, null);
    assert.equal(deferred.lockedAt, null);
    assert(deferred.runAt > now);
    assert.equal(await prisma.message.count({ where: { id: { in: ids } } }), 3, `${status} dependency protects 9-day context despite 30-day evidence cutoff`);
  }

  await prisma.memoryJob.delete({ where: { id: dependency.id } });
  await prisma.memoryJob.update({ where: { id: cleanup.id }, data: { runAt: now } });
  const completed = await processNextMemoryJob(prisma, { now, ownerId });
  assert.equal(completed.processed && completed.jobId, cleanup.id);
  assert.equal(completed.processed && completed.status, "SUCCEEDED");
  assert.equal(await prisma.message.count({ where: { id: { in: ids.slice(0, 2) } } }), 0);
  assert.equal(await prisma.message.count({ where: { id: ids[2] } }), 1, "Private context must survive cleanup");
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { characterId, action: "message.retention_cleanup" } });
  assert.equal((audit.details as { contextMessages: number }).contextMessages, 2);

  // A shorter configured retention wins over the seven-day context default.
  await prisma.characterMemorySetting.update({ where: { characterId }, data: { rawMessageRetentionDays: 3 } });
  const shorter = await messagesAt(4);
  const boundaryId = randomUUID();
  await prisma.message.create({ data: {
    id: boundaryId, conversationId: groupId, role: "USER", eventType: "message", content: "exact cutoff",
    occurredAt: daysAgo(3), metadata: { storedReason: "context" },
  } });
  const shortCleanup = await prisma.memoryJob.create({ data: {
    memoryScopeId: scopeId, type: "CLEAN_EXPIRED_MESSAGES", idempotencyKey: `cleanup-short:${randomUUID()}`,
    periodEnd: daysAgo(3), runAt: now,
  } });
  const shortResult = await processNextMemoryJob(prisma, { now, ownerId });
  assert.equal(shortResult.processed && shortResult.jobId, shortCleanup.id);
  assert.equal(shortResult.processed && shortResult.status, "SUCCEEDED");
  assert.equal(await prisma.message.count({ where: { id: { in: shorter.slice(0, 2) } } }), 0);
  assert.equal(await prisma.message.count({ where: { id: shorter[2] } }), 1);
  assert.equal(await prisma.message.count({ where: { id: boundaryId } }), 1, "Cleanup uses a strict before-cutoff boundary");
  assert.equal(modelCalls, 0);
  console.log("Cleanup dependency PostgreSQL checks passed: QUEUED/RETRY_WAIT event dependencies protect 9-day context under 30-day retention, released cleanup removes group context and preserves private messages, 3-day retention and exact cutoff boundary, zero model calls.");
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try {
    await prisma.conversation.deleteMany({ where: { id: { in: [groupId, privateId] }, characterId } });
    await prisma.memoryScope.deleteMany({ where: { id: scopeId, characterId } });
    await prisma.auditLog.deleteMany({ where: { characterId } });
    await prisma.character.deleteMany({ where: { id: characterId, ownerId } });
    await prisma.user.deleteMany({ where: { id: ownerId } });
  } finally {
    await prisma.$disconnect();
  }
}
