import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { createApp, createRouter, toNodeListener } from "h3";
import reviewHandler from "../server/api/characters/[id]/snapshots/[snapshotId]/review.post";
import { createSession } from "../server/utils/auth";
import { getPrisma } from "../server/utils/prisma";
import { applyMemoryChange, normalizeMemoryText } from "../server/utils/memory-change-apply";
import type { MemoryApplyContext } from "../server/utils/memory-change-apply";
import { makeMemoryDedupeKey } from "../server/utils/memory-ai";

// This entry may only write to a disposable local database created by the isolated runner.
const url = new URL(process.env.DATABASE_URL ?? "");
assert(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
assert(/^yiling_memory_test_[a-f0-9]{32}$/.test(url.pathname.slice(1)), "Use the isolated memory DB runner.");
const prisma = getPrisma();
const ownerId = randomUUID();
const otherId = randomUUID();
const characterId = randomUUID();
const scopeId = randomUUID();
const periodStart = new Date("2026-10-01T00:00:00Z");
const occurredAt = new Date("2026-10-02T00:00:00Z");
const app = createApp();
const router = createRouter();
router.post("/characters/:id/snapshots/:snapshotId/review", reviewHandler);
app.use(router);
const server = createServer(toNodeListener(app));
const context = (snapshotId: string, content = ""): MemoryApplyContext => ({
  memoryScopeId: scopeId, characterId, snapshotId, actorType: "WORKER", auditActionPrefix: "memory.ai_",
  canTarget: () => true, resolvePrevious: async () => null, handledMemoryIds: new Set(),
  existingItemSignatures: new Set(content ? [`FACT:${normalizeMemoryText(content)}`] : []),
  existingDedupeKeys: new Set(),
});
try {
  for (const id of [ownerId, otherId]) {
    await prisma.user.create({ data: { id, username: `review-${id}`, passwordHash: "test-only" } });
  }
  await prisma.character.create({ data: { id: characterId, ownerId, name: "Snapshot review test", basePrompt: "test" } });
  await prisma.memoryScope.create({ data: { id: scopeId, characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `test:${scopeId}` } });
  const conversation = await prisma.conversation.create({ data: { characterId, memoryScopeId: scopeId } });
  const message = await prisma.message.create({ data: { conversationId: conversation.id, role: "USER", content: "evidence", occurredAt } });
  const suggestion = (content: string) => ({ action: "ADD", category: "FACT", content, confidence: 0.9,
    importance: 0.87, evidenceMessageIds: [message.id], result: "NOT_APPLIED_REGENERATION" });
  const snapshotKey = `review:${randomUUID()}`;
  const first = await prisma.memorySnapshot.create({ data: {
    memoryScopeId: scopeId, snapshotKey, version: 1, periodStart, periodEnd: new Date("2026-10-09T00:00:00Z"), summary: "immutable",
    structuredContent: { memoryChangesApplied: [suggestion("用户居住在杭州"), suggestion("用户居住在杭州"), suggestion("用户擅长木雕"), suggestion("用户有一只黑猫")] },
  } });
  const second = await prisma.memorySnapshot.create({ data: {
    memoryScopeId: scopeId, snapshotKey, version: 2, periodStart, periodEnd: first.periodEnd, summary: "immutable second",
    structuredContent: { memoryChangesApplied: [suggestion("用户居住在杭州"), suggestion("用户喜欢无糖乌龙茶")] },
  } });
  await prisma.memorySnapshotSource.create({ data: { snapshotId: second.id, sourceType: "MESSAGE", sourceRef: message.id, messageId: message.id } });
  const session = await createSession({ userId: ownerId });
  const otherSession = await createSession({ userId: otherId });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const request = async (snapshotId: string, changeIndex: number, decision = "ACCEPT", token = session.token) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/characters/${characterId}/snapshots/${snapshotId}/review`, {
      method: "POST", headers: { cookie: `yiling_session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ changeIndex, decision }),
    });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request(first.id, 0, "ACCEPT", "invalid")).status, 401);
  assert.equal((await request(first.id, 0, "ACCEPT", otherSession.token)).status, 404);
  const duplicates = await Promise.all([
    request(first.id, 0), request(first.id, 1), request(second.id, 0),
    prisma.$transaction((tx) => applyMemoryChange(tx, context(first.id), {
      action: "ADD", category: "FACT", content: "用户居住在杭州", confidence: 0.9, evidenceMessageIds: [message.id],
    }, [message])).then((outcome) => ({ status: 200, body: { outcome: outcome?.result } })),
  ]);
  assert.ok(duplicates.every((result) => result.status === 200), JSON.stringify(duplicates));
  assert.deepEqual(duplicates.map((result) => result.body.outcome).sort(), ["CREATED", "DUPLICATE_IGNORED", "DUPLICATE_IGNORED", "DUPLICATE_IGNORED"]);
  assert.equal(await prisma.memoryItem.count({ where: { memoryScopeId: scopeId, status: "ACTIVE", content: "用户居住在杭州" } }), 1);
  assert.equal(await prisma.memoryReview.count({ where: { snapshotId: { in: [first.id, second.id] } } }), 3);
  const race = await Promise.all([request(first.id, 2), request(first.id, 2, "IGNORE")]);
  assert.deepEqual(race.map((result) => result.status).sort(), [200, 409]);
  const ignoreRace = await Promise.all([request(first.id, 3, "IGNORE"), request(first.id, 3, "IGNORE")]);
  assert.deepEqual(ignoreRace.map((result) => result.status).sort(), [200, 409]);

  await prisma.message.delete({ where: { id: message.id } });
  const accepted = await request(second.id, 1);
  assert.equal(accepted.status, 200, JSON.stringify(accepted));
  const retained = await prisma.memoryItem.findUniqueOrThrow({ where: { id: accepted.body.memoryItemId } });
  assert.equal(retained.sourceMessageId, null);
  assert.equal(retained.validFrom?.toISOString(), periodStart.toISOString());
  assert.equal(retained.importance, 0.87);
  assert.equal(retained.sourceSnapshotId, second.id);
  const source = await prisma.memorySnapshotSource.findFirstOrThrow({ where: { snapshotId: second.id } });
  assert.equal(source.sourceRef, message.id);
  assert.equal(source.messageId, null);
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: retained.id, action: "memory.review_added" } });
  assert.deepEqual((audit.details as { evidenceMessageIds: string[] }).evidenceMessageIds, [message.id]);
  const change = { action: "ADD" as const, category: "FACT" as const, content: "用户收藏老唱片", confidence: 0.9, evidenceMessageIds: [] };
  assert.equal(await prisma.$transaction((tx) => applyMemoryChange(tx, context(first.id), change, [])), null);
  assert.equal(await prisma.$transaction((tx) => applyMemoryChange(tx, context(first.id), change, [], { reviewEvidenceFallbackAt: periodStart })), null,
    "even an explicit fallback never bypasses Worker evidence requirements");

  // A stale context signature and a historical occupied key must not suppress a new ACTIVE row.
  const content = "用户会制作陶瓷杯";
  await prisma.memoryItem.create({ data: { memoryScopeId: scopeId, category: "FACT", content, status: "TRASHED", dedupeKey: makeMemoryDedupeKey("FACT", content) } });
  const live = await prisma.message.create({ data: { conversationId: conversation.id, role: "USER", content: "fresh evidence", occurredAt } });
  const workerChange = { ...change, content, evidenceMessageIds: [live.id] };
  const applied = await Promise.all([1, 2].map(() => prisma.$transaction((tx) => applyMemoryChange(tx, context(first.id, content), workerChange, [live]))));
  assert.deepEqual(applied.map((result) => result?.result).sort(), ["CREATED", "DUPLICATE_IGNORED"]);
  assert.equal(await prisma.memoryItem.count({ where: { memoryScopeId: scopeId, content, status: "ACTIVE" } }), 1);
  const invalidContent = "用户每周学习一次古琴";
  await prisma.memoryItem.create({ data: { memoryScopeId: scopeId, category: "FACT", content: invalidContent, status: "INVALIDATED", dedupeKey: makeMemoryDedupeKey("FACT", invalidContent) } });
  const recreated = await prisma.$transaction((tx) => applyMemoryChange(tx, context(first.id, invalidContent), {
    ...workerChange, content: invalidContent,
  }, [live]));
  assert.equal(recreated?.result, "CREATED", "an invalidated historical key does not represent an ACTIVE memory");
  const missingHistory = { ...context(first.id), actorType: "USER" as const, auditActionPrefix: "memory.review_" as const, actorId: ownerId };
  assert.equal(await prisma.$transaction((tx) => applyMemoryChange(tx, missingHistory, change, [], { reviewEvidenceFallbackAt: periodStart })), null,
    "review fallback only applies to a suggestion with historical evidence IDs");
  for (const original of [first, second]) {
    const current = await prisma.memorySnapshot.findUniqueOrThrow({ where: { id: original.id } });
    assert.deepEqual(current.structuredContent, original.structuredContent);
    assert.equal(current.summary, original.summary);
  }
  console.log("Snapshot review passed: real h3/session, concurrent ADD/reviews, retention fallback, Worker evidence, owner isolation and immutable snapshots.");
} finally {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await prisma.$disconnect();
}
