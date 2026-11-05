import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPrisma } from "../server/utils/prisma";
import { runDailyEventJob } from "../server/utils/memory-worker";

// Only the disposable database created by the isolated runner is permitted.
const database = new URL(process.env.DATABASE_URL ?? "").pathname.slice(1);
assert(/^yiling_memory_test_[a-f0-9]{32}$/.test(database), "Run through test:memory-reliability-isolated only.");
const prisma = getPrisma();
const originalFetch = globalThis.fetch;
const ownerId = randomUUID();
const characterId = randomUUID();
const scopeId = randomUUID();
const conversations = [randomUUID(), randomUUID()];
const start = new Date("2026-11-01T00:00:00Z");
const end = new Date("2026-11-02T00:00:00Z");
const timestamp = new Date(start.getTime() + 1000);
const ids = Array.from({ length: 360 }, () => randomUUID()).sort();
const conversationById = new Map(ids.map((id, index) => [id, conversations[index % 2]!]));
const tail = "IMPORTANT_TAIL_AFTER_1200_完整保留";
const titles = new Map(ids.map((id) => [id, `事项${id.slice(0, 8)}`]));
process.env.LLM_API_KEY = "isolated-fake-key";
process.env.LLM_MODEL = "isolated-model";
process.env.LLM_BASE_URL = "http://127.0.0.1:4010/v1";
type PromptMessage = { id: string; content: string; occurredAt: string };
type Prompt = {
  messages: PromptMessage[];
  contextMessages?: PromptMessage[];
  existingEvents?: Array<{ title: string }>;
};
const requests: Prompt[] = [];
let failSecondChunk = true;
let sawContextOnlyAttempt = false;
globalThis.fetch = async (url, init) => {
  assert.match(String(url), /^http:\/\/127\.0\.0\.1:4010\//, "No paid model request is allowed");
  const body = JSON.parse(String(init?.body));
  const prompt: Prompt = JSON.parse(body.messages.find((message: { role: string }) => message.role === "user").content);
  requests.push(prompt);
  const first = prompt.messages[0]!;
  const conversationId = conversationById.get(first.id);
  assert(conversationId);
  assert(prompt.messages.every((message) => conversationById.get(message.id) === conversationId), "Model request mixed conversations");
  const context = prompt.contextMessages ?? [];
  assert(context.length <= 6);
  for (const message of context) {
    assert.equal(conversationById.get(message.id), conversationId, "Context crossed conversation or period");
    assert(new Date(message.occurredAt) >= start && new Date(message.occurredAt) < end);
    assert(new Date(message.occurredAt) < new Date(first.occurredAt)
      || (message.occurredAt === first.occurredAt && message.id < first.id), "Context must precede first timestamp/id");
  }
  for (const event of prompt.existingEvents ?? []) {
    assert.notEqual(event.title, "无效草稿不能记住");
    assert.notEqual(event.title, "只有前文的伪事件");
    assert(!event.title.endsWith("！"), "Draft rejected during apply must not enter known events");
    const source = [...titles.entries()].find(([, title]) => title === event.title);
    assert(source, "Known event must have actually been persisted");
    assert.equal(conversationById.get(source[0]), conversationId, "Known event crossed conversation");
  }
  if (first.id === ids[0]) assert(first.content.endsWith(tail), "Important tail after 1200 characters was lost");
  if (failSecondChunk && requests.length === 4) {
    return new Response("injected second-chunk subgroup failure", { status: 503 });
  }
  const draft = (evidenceMessageIds: string[], title: string, detail = "仅用于隔离数据库回归的模拟事件") => ({
    occurredAt: timestamp.toISOString(), precision: "exact", title, detail,
    keywords: [], participants: [], confidence: 0.95, evidenceMessageIds,
  });
  const events = [
    draft([first.id, ...context.slice(-1).map((message) => message.id)], titles.get(first.id)!),
    draft([first.id], "无效草稿不能记住", ""),
    // This valid draft reaches apply but has the same normalized title/dedupe key.
    draft([first.id], `${titles.get(first.id)!}！`),
  ];
  if (context.length) {
    sawContextOnlyAttempt = true;
    events.push(draft([context[0]!.id], "只有前文的伪事件"));
  }
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    summary: "Isolated local mock extraction", importantEvents: [], factAndPreferenceChanges: [],
    relationshipChanges: [], goalsAndCommitments: [], unresolvedTopics: [], differencesFromPrevious: [],
    memoryChanges: [], events,
  }) } }] }), { status: 200 });
};
try {
  await prisma.user.create({ data: { id: ownerId, username: `event-quality-${ownerId}`, passwordHash: "test-only" } });
  await prisma.character.create({ data: { id: characterId, ownerId, name: "Extraction quality test", basePrompt: "test" } });
  await prisma.memoryScope.create({ data: { id: scopeId, characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `test:${scopeId}` } });
  await prisma.conversation.createMany({ data: conversations.map((id) => ({ id, characterId, memoryScopeId: scopeId })) });
  await prisma.message.createMany({ data: ids.map((id, index) => ({
    id, conversationId: conversationById.get(id)!, role: "USER" as const, eventType: "message",
    content: index === 0 ? `${"长文本".repeat(500)}${tail}` : `isolated evidence ${index}`,
    occurredAt: timestamp,
  })) });
  // An earlier message outside this day must never enter context.
  await prisma.message.create({ data: {
    conversationId: conversations[0]!, role: "USER", eventType: "message", content: "outside period",
    occurredAt: new Date(start.getTime() - 1),
  } });
  const job = await prisma.memoryJob.create({ data: {
    memoryScopeId: scopeId, type: "EXTRACT_EVENTS", idempotencyKey: `events-final:${scopeId}:2026-11-01`,
    periodStart: start, periodEnd: end, status: "RUNNING", attemptCount: 1, lockedBy: `quality:${randomUUID()}`, lockedAt: end,
  } });
  const first = await runDailyEventJob(prisma, { ...job, periodStart: start, periodEnd: end }, end);
  assert.equal(first.processed && first.status, "RETRY_WAIT");
  const progress = await prisma.memoryEventDay.findUniqueOrThrow({ where: { memoryScopeId_dayKey: { memoryScopeId: scopeId, dayKey: "2026-11-01" } } });
  assert.equal(progress.extractedMessageId, ids[119], "Failed subgroup must not advance its original global chunk");
  assert.equal(await prisma.memoryEvent.count({ where: { memoryScopeId: scopeId } }), 2, "Only the first complete chunk may commit");
  failSecondChunk = false;
  await prisma.memoryJob.update({ where: { id: job.id }, data: { status: "RUNNING", lockedBy: `quality:${randomUUID()}`, lockedAt: new Date(end.getTime() + 60_000) } });
  const retried = await runDailyEventJob(prisma, { ...job, periodStart: start, periodEnd: end }, new Date(end.getTime() + 60_000));
  assert.equal(retried.processed && retried.status, "SUCCEEDED");
  assert(sawContextOnlyAttempt, "Mock must attempt a context-only pseudo event");
  const saved = await prisma.memoryEvent.findMany({ where: { memoryScopeId: scopeId } });
  assert.equal(saved.length, 6, "Context-only and invalid drafts must not be stored");
  assert(saved.every((event) => event.title !== "只有前文的伪事件" && event.title !== "无效草稿不能记住"));
  assert(saved.some((event) => event.sourceMessageIds.some((id) => ids.indexOf(id) < 120) && event.sourceMessageIds.some((id) => ids.indexOf(id) >= 120)), "Apply must retain context evidence from a previous chunk");
  for (const event of saved) {
    assert(event.sourceMessageIds.every((id) => conversationById.get(id) === event.conversationId));
  }
  const finalProgress = await prisma.memoryEventDay.findUniqueOrThrow({ where: { memoryScopeId_dayKey: { memoryScopeId: scopeId, dayKey: "2026-11-01" } } });
  assert.equal(finalProgress.extractedMessageId, ids[359]);
  assert.equal(finalProgress.state, "FINAL");
  console.log("Isolated PostgreSQL event extraction quality passed: conversation requests, prior-chunk context, context-only rejection, atomic failed chunk retry, full long-message tail.");
} finally {
  globalThis.fetch = originalFetch;
  await prisma.$disconnect();
}
