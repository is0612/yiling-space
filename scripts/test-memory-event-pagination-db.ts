import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPrisma } from "../server/utils/prisma";
import { runDailyEventJob } from "../server/utils/memory-worker";

// This test intentionally refuses the business database, even when invoked directly.
const database = new URL(process.env.DATABASE_URL ?? "").pathname.slice(1);
assert(/^yiling_memory_test_[a-f0-9]{32}$/.test(database), "Run through test:memory-reliability-isolated only.");
const prisma = getPrisma();
const originalFetch = globalThis.fetch;
const ownerId = randomUUID();
const characterId = randomUUID();
const scopeId = randomUUID();
const conversationId = randomUUID();
const start = new Date("2026-11-01T00:00:00Z");
const end = new Date("2026-11-02T00:00:00Z");
process.env.LLM_API_KEY = "isolated-fake-key";
process.env.LLM_MODEL = "isolated-model";
process.env.LLM_BASE_URL = "http://127.0.0.1:4010/v1";
const seen: string[] = [];
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body));
  const prompt = JSON.parse(body.messages.find((m: { role: string }) => m.role === "user").content);
  seen.push(...prompt.messages.map((m: { id: string }) => m.id));
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    summary: "isolated pagination", importantEvents: [], factAndPreferenceChanges: [], relationshipChanges: [],
    goalsAndCommitments: [], unresolvedTopics: [], differencesFromPrevious: [], memoryChanges: [], events: [],
  }) } }] }), { status: 200 });
};
try {
  await prisma.user.create({ data: { id: ownerId, username: `event-page-${ownerId}`, passwordHash: "test-only" } });
  await prisma.character.create({ data: { id: characterId, ownerId, name: "Pagination test", basePrompt: "test" } });
  await prisma.memoryScope.create({ data: { id: scopeId, characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `test:${scopeId}` } });
  await prisma.conversation.create({ data: { id: conversationId, characterId, memoryScopeId: scopeId } });
  const ids = Array.from({ length: 961 }, () => randomUUID()).sort();
  await prisma.message.createMany({ data: ids.map((id) => ({
    id, conversationId, role: "USER" as const, eventType: "message", content: "test evidence",
    occurredAt: new Date(start.getTime() + 1000),
  })) });
  const job = await prisma.memoryJob.create({ data: {
    memoryScopeId: scopeId, type: "EXTRACT_EVENTS", idempotencyKey: `events-final:${scopeId}:2026-11-01`,
    periodStart: start, periodEnd: end, status: "RUNNING", attemptCount: 1, lockedBy: `pagination:${randomUUID()}`, lockedAt: end,
  } });
  const input = { ...job, periodStart: start, periodEnd: end };
  const first = await runDailyEventJob(prisma, input, end);
  assert.equal(first.processed && first.status, "RETRY_WAIT");
  let progress = await prisma.memoryEventDay.findUniqueOrThrow({ where: { memoryScopeId_dayKey: { memoryScopeId: scopeId, dayKey: "2026-11-01" } } });
  assert.equal(progress.state, "DRAFT");
  assert.equal(progress.extractedMessageId, ids[959]);
  assert.deepEqual(seen, ids.slice(0, 960));
  await prisma.memoryJob.update({ where: { id: job.id }, data: { status: "RUNNING", lockedBy: `pagination:${randomUUID()}`, lockedAt: new Date(end.getTime() + 60_000) } });
  const second = await runDailyEventJob(prisma, input, new Date(end.getTime() + 60_000));
  assert.equal(second.processed && second.status, "SUCCEEDED");
  assert.deepEqual(seen, ids);
  progress = await prisma.memoryEventDay.findUniqueOrThrow({ where: { memoryScopeId_dayKey: { memoryScopeId: scopeId, dayKey: "2026-11-01" } } });
  assert.equal(progress.state, "FINAL");
  assert.equal(progress.extractedMessageId, ids[960]);
  console.log("Isolated PostgreSQL event pagination passed: 961 same-timestamp messages, UUID keyset order, resumable progress, no skipped evidence.");
} finally {
  globalThis.fetch = originalFetch;
  // The guarded isolated runner removes the entire disposable database, even on failure.
  await prisma.$disconnect();
}
