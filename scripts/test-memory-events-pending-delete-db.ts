import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPrisma } from "../server/utils/prisma";
import { previewMemoryEvents } from "../server/utils/memory-events-preview";
import { deletePendingMemoryEvents, parsePendingMemoryDelete } from "../server/utils/memory-events-pending-delete";

const p = getPrisma();
const ownerId = randomUUID(), characterId = randomUUID(), scopeId = randomUUID();
try {
  await p.user.create({ data: { id: ownerId, username: `pending-delete-${ownerId}`, passwordHash: "test-only" } });
  await p.character.create({ data: { id: characterId, ownerId, name: "待整理删除测试", basePrompt: "test", memoryScopes: { create: { id: scopeId, scopeType: "CHARACTER_GLOBAL", scopeKey: `test:${scopeId}` } } } });
  const conversation = await p.conversation.create({ data: { characterId, memoryScopeId: scopeId, title: "测试会话" } });
  const other = await p.conversation.create({ data: { characterId, memoryScopeId: scopeId, title: "保留会话" } });
  const occurredAt = new Date(Date.now() - 60_000);
  const old = await p.message.create({ data: { conversationId: conversation.id, role: "USER", content: "已整理", occurredAt: new Date(occurredAt.getTime() - 1000) } });
  const pending = await p.message.create({ data: { conversationId: conversation.id, role: "USER", content: "待删除", occurredAt } });
  await p.message.create({ data: { conversationId: other.id, role: "USER", content: "其他会话", occurredAt } });
  const memory = await p.memoryItem.create({ data: { memoryScopeId: scopeId, content: "保留的结论", category: "FACT", sourceMessageId: pending.id } });
  const checked = new Date();
  const preview = await previewMemoryEvents(p, { ownerId, characterId, now: checked });
  const row = preview.rows.find(row => row.key.endsWith(conversation.id))!;
  assert.equal(row.pendingMessages, 2);
  const body = { key: row.key, expectedCount: 2, checkedAt: preview.checkedAt };
  assert.throws(() => parsePendingMemoryDelete({ ...body, expectedCount: 0 }), { statusCode: 400 });
  await assert.rejects(deletePendingMemoryEvents(p, { ownerId: randomUUID(), characterId, body }), { statusCode: 404 });
  await assert.rejects(deletePendingMemoryEvents(p, { ownerId, characterId, body: { ...body, expectedCount: 3 } }), { statusCode: 409 });
  assert.equal(await p.message.count({ where: { conversationId: conversation.id } }), 2);
  const job = await p.memoryJob.create({ data: { memoryScopeId: scopeId, type: "EXTRACT_EVENTS", status: "QUEUED", idempotencyKey: `delete-test:${characterId}`, periodStart: new Date(occurredAt.getTime() - 1000), periodEnd: new Date(checked.getTime() + 60_000), runAt: new Date(checked.getTime() + 3_600_000) } });
  await assert.rejects(deletePendingMemoryEvents(p, { ownerId, characterId, body }), { statusCode: 409 });
  await p.memoryJob.delete({ where: { id: job.id } });
  // A worker cursor changing after the preview must cause a conflict, never delete processed data.
  const dayKey = row.dayKey;
  await p.memoryEventDay.create({ data: { memoryScopeId: scopeId, dayKey, state: "DRAFT", extractedAt: old.occurredAt, extractedMessageId: old.id } });
  await assert.rejects(deletePendingMemoryEvents(p, { ownerId, characterId, body }), { statusCode: 409 });
  const fresh = await previewMemoryEvents(p, { ownerId, characterId });
  const target = fresh.rows.find(item => item.key.endsWith(conversation.id))!;
  assert.equal(target.pendingMessages, 1);
  // A newly ingested backdated message is outside the confirmed preview, and survives.
  const late = await p.message.create({ data: { conversationId: conversation.id, role: "USER", content: "预览后到达", occurredAt, ingestedAt: new Date(Date.parse(fresh.checkedAt) + 1000) } });
  const result = await deletePendingMemoryEvents(p, { ownerId, characterId, body: { key: target.key, expectedCount: 1, checkedAt: fresh.checkedAt } });
  assert.equal(result.deletedMessages, 1);
  assert(await p.message.findUnique({ where: { id: old.id } }));
  assert(await p.message.findUnique({ where: { id: late.id } }));
  assert.equal(await p.message.count({ where: { conversationId: other.id } }), 1);
  const retained = await p.memoryItem.findUniqueOrThrow({ where: { id: memory.id } });
  assert.equal(retained.sourceMessageId, null);
  assert.equal(retained.content, "保留的结论");
  assert.equal(await p.auditLog.count({ where: { characterId, action: "memory_events.pending_messages_deleted" } }), 1);
  console.log("Pending message deletion DB tests passed: ownership, count conflicts, active jobs, cursors, frozen ingestion bound, unrelated messages and retained memories.");
} finally {
  await p.memoryItem.deleteMany({ where: { memoryScopeId: scopeId } });
  await p.memoryJob.deleteMany({ where: { memoryScopeId: scopeId } });
  await p.memoryEventDay.deleteMany({ where: { memoryScopeId: scopeId } });
  await p.conversation.deleteMany({ where: { characterId } });
  await p.auditLog.deleteMany({ where: { characterId } });
  await p.memoryScope.deleteMany({ where: { characterId } });
  await p.character.deleteMany({ where: { id: characterId } });
  await p.user.deleteMany({ where: { id: ownerId } });
  await p.$disconnect();
}
