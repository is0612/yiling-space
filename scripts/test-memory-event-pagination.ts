import assert from "node:assert/strict";
import type { PrismaClient } from "../src/generated/prisma/client";
import {
  eventMessageWhere, loadEventMessageBatch, loadEventContextMessages, splitEventMessagesByBudget,
  EVENT_AI_INPUT_TOKENS, EVENT_AI_MESSAGES_PER_REQUEST, EVENT_MESSAGE_BATCH_SIZE,
} from "../server/utils/memory-event-source";
import { estimateTokens } from "../server/utils/memory-retrieval";
import { runDailyEventJob } from "../server/utils/memory-worker";

// No dotenv, real database, usage writes, or network: all provider and persistence I/O is mocked.
const originalFetch = globalThis.fetch;
const originalEnv = { key: process.env.LLM_API_KEY, base: process.env.LLM_BASE_URL, model: process.env.LLM_MODEL };
process.env.LLM_API_KEY = "test-only-key";
process.env.LLM_BASE_URL = "https://memory-test.invalid/v1";
process.env.LLM_MODEL = "test-model";
const start = new Date("2026-11-01T00:00:00Z");
const end = new Date("2026-11-02T00:00:00Z");
const input = { memoryScopeId: "scope", privateOnly: true, periodStart: start, periodEnd: end, progress: null };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const makeRows = (count: number, sameTime = false) => Array.from({ length: count }, (_, n) => ({
  id: id(n + 1), role: "USER", eventType: "message", content: `evidence ${n + 1}`,
  occurredAt: new Date(start.getTime() + (sameTime ? 1_000 : (n + 1) * 1_000)),
  metadata: null, conversationId: "conversation", conversation: { externalConversationId: "c:100" },
}));
type Progress = { state: string; extractedAt: Date | null; extractedMessageId: string | null; eventCount: number };

function fixture(count: number, sameTime = false) {
  const rows = makeRows(count, sameTime);
  let progress: Progress | null = null;
  let failTransactionAt = 0;
  let transactions = 0;
  const jobs: Array<Record<string, unknown>> = [];
  let leaseRow = { status: "RUNNING", lockedBy: "pagination:claim-1" as string | null };
  let claims = 1;
  const queries: Array<Record<string, unknown>> = [];
  const eventStates: string[] = [];
  const mock = {
    memoryScope: { findUnique: async () => ({ characterId: "character", scopeType: "EXTERNAL_IDENTITY", character: {
      name: "Test", modelConfig: {}, memorySetting: { timezone: "UTC" },
    } }) },
    message: { findMany: async (query: { where: ReturnType<typeof eventMessageWhere>; take: number; orderBy: unknown }) => {
      // 取材新增的历史上下文查询独立于待消费正序批次；本用例不提供上下文。
      if (JSON.stringify(query.orderBy).includes("desc")) return [];
      queries.push(query);
      assert.deepEqual(query.orderBy, [{ occurredAt: "asc" }, { id: "asc" }]);
      assert.equal(query.take, EVENT_MESSAGE_BATCH_SIZE + 1);
      assert.deepEqual(query.where.conversation, { is: { memoryScopeId: "scope", externalConversationId: { startsWith: "c:" } } });
      // Apply the actual generated keyset predicate to fake rows, including same-time boundaries.
      const range = query.where.occurredAt as { gte: Date; lt: Date };
      const or = query.where.OR as Array<{ occurredAt: Date | { gt: Date }; id?: { gt: string } }> | undefined;
      return rows.filter((row) => row.occurredAt >= range.gte && row.occurredAt < range.lt && (!or || or.some((part) =>
        part.occurredAt instanceof Date
          ? row.occurredAt.getTime() === part.occurredAt.getTime() && row.id > part.id!.gt
          : row.occurredAt > part.occurredAt.gt,
      ))).slice(0, query.take);
    } },
    memoryEventDay: {
      findUnique: async () => progress && { ...progress },
      upsert: async (query: { create: Progress; update: Partial<Progress> & { eventCount?: unknown } }) => {
        progress = progress ? { ...progress, ...query.update, eventCount: progress.eventCount } : { ...query.create };
      },
      updateMany: async (query: { data: Partial<Progress> }) => { if (progress) Object.assign(progress, query.data); },
    },
    memoryEvent: { findMany: async () => [], count: async () => 0,
      updateMany: async (query: { data: { state: string } }) => { eventStates.push(query.data.state); return { count: 0 }; } },
    memoryJob: {
      findFirst: async () => leaseRow.status === "RUNNING" && leaseRow.lockedBy ? { lockedBy: leaseRow.lockedBy } : null,
      updateMany: async (query: { where: { id: string; status: string; lockedBy: string }; data: Record<string, unknown> }) => {
        assert.equal(query.where.id, "job");
        if (query.where.status !== leaseRow.status || query.where.lockedBy !== leaseRow.lockedBy) return { count: 0 };
        jobs.push(query.data);
        leaseRow = { ...leaseRow, ...query.data };
        return { count: 1 };
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      transactions++;
      if (failTransactionAt === transactions) throw new Error("mock transaction failure");
      return fn(mock);
    },
  };
  return {
    prisma: mock as unknown as PrismaClient, rows, jobs, queries, eventStates,
    progress: () => progress,
    reclaim: () => { leaseRow = { status: "RUNNING", lockedBy: `pagination:claim-${++claims}` }; },
    setProgress: (value: Progress) => { progress = value; },
    failAt: (value: number) => { failTransactionAt = value; },
  };
}
const job = { id: "job", memoryScopeId: "scope", periodStart: start, periodEnd: end, idempotencyKey: "events-final:scope:2026-11-01" };
const seen: string[] = [];
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body));
  const prompt = JSON.parse(body.messages.find((m: { role: string }) => m.role === "user").content);
  seen.push(...prompt.messages.map((m: { id: string }) => m.id));
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    summary: "Test summary", importantEvents: [], factAndPreferenceChanges: [], relationshipChanges: [],
    goalsAndCommitments: [], unresolvedTopics: [], differencesFromPrevious: [], memoryChanges: [], events: [],
  }) } }] }), { status: 200, headers: { "content-type": "application/json" } });
};

try {
  // These are request limits, independent of the 960-message persistence page.
  assert.equal(EVENT_AI_INPUT_TOKENS, 4_000);
  assert.equal(EVENT_AI_MESSAGES_PER_REQUEST, 40);
  assert.deepEqual(splitEventMessagesByBudget([]), []);
  function checkChunks<T extends { id: string; content: string }>(messages: T[]) {
    const before = JSON.stringify(messages);
    const chunks = splitEventMessagesByBudget(messages);
    const flattened = chunks.flat();
    assert.deepEqual(flattened, messages, "splitting must preserve global order and every complete message exactly once");
    assert.equal(new Set(flattened.map((message) => message.id)).size, messages.length);
    flattened.forEach((message, index) => assert.equal(message, messages[index], "messages must remain intact"));
    assert.equal(JSON.stringify(messages), before, "splitting must not mutate its input");
    for (const chunk of chunks) {
      assert(chunk.length > 0 && chunk.length <= 40);
      const tokens = chunk.reduce((sum, message) => sum + estimateTokens(JSON.stringify(message)), 0);
      assert(tokens <= 4_000 || chunk.length === 1, "only a standalone oversized message may exceed the token budget");
    }
    return chunks;
  }
  const short = Array.from({ length: 81 }, (_, index) => ({ id: String(index), content: "short" }));
  assert.deepEqual(checkChunks(short).map((chunk) => chunk.length), [40, 40, 1]);
  const mixed = [
    { id: "short-before", content: "short" },
    { id: "long", content: "x".repeat(12_000) },
    { id: "short-after", content: "short" },
    { id: "next-long", content: "y".repeat(8_000) },
    { id: "last", content: "short" },
  ];
  assert.deepEqual(checkChunks(mixed).map((chunk) => chunk.map((message) => message.id)), [
    ["short-before", "long", "short-after"], ["next-long", "last"],
  ]);
  const chinese = Array.from({ length: 5 }, (_, index) => ({ id: String(index), content: "中".repeat(1_500) }));
  assert.deepEqual(checkChunks(chinese).map((chunk) => chunk.length), [2, 2, 1], "Chinese must use its estimated token cost, not four characters per token");
  const oversized = { id: "oversized", content: "完整证据".repeat(5_000) };
  const oversizedChunks = checkChunks([short[0]!, oversized, short[1]!]);
  assert.deepEqual(oversizedChunks.map((chunk) => chunk.length), [1, 1, 1]);
  assert.equal(oversizedChunks[1]![0]!.content, oversized.content, "an oversized message must be preserved in full");

  // Context is optional, bounded, complete, and chronological; an oversized nearest
  // message stops the window instead of skipping to unrelated older context.
  const contextRows = [{ id: "latest", content: "最近" }, { id: "older", content: "前文" }];
  const contextInput = { conversationId: "conversation", periodStart: start, periodEnd: end, first: { occurredAt: end, id: "first" } };
  const contextPrisma = (rows: typeof contextRows) => ({ message: { findMany: async () => rows } }) as unknown as Pick<PrismaClient, "message">;
  assert.deepEqual(await loadEventContextMessages(contextPrisma(contextRows), contextInput), [...contextRows].reverse());
  assert.deepEqual(await loadEventContextMessages(contextPrisma([{ id: "huge", content: "中".repeat(2_000) }, ...contextRows]), contextInput), []);
  const boundedContext = await loadEventContextMessages(contextPrisma([
    { id: "recent", content: "中".repeat(600) }, { id: "old", content: "中".repeat(600) },
  ]), contextInput);
  assert.deepEqual(boundedContext.map((row) => row.id), ["recent"]);

  // Exactly 960: no phantom continuation; 961: oldest 960 first, one row remains.
  for (const count of [0, 960, 961]) {
    const f = fixture(count);
    const batch = await loadEventMessageBatch(f.prisma, input);
    assert.equal(batch.messages.length, Math.min(count, 960));
    assert.equal(batch.hasMore, count > 960);
    if (count) assert.equal(batch.messages[0]!.id, id(1));
  }
  // Reproduce the old latest-window selection: it would drop evidence #1 at count 961.
  const oldWindow = makeRows(961).slice(-960);
  assert.equal(oldWindow.some((row) => row.id === id(1)), false);

  for (const sameTime of [false, true]) {
    seen.length = 0;
    const f = fixture(961, sameTime);
    const first = await runDailyEventJob(f.prisma, job, end);
    assert.equal(first.processed && first.status, "RETRY_WAIT");
    assert.equal(f.progress()?.state, "DRAFT", `partial final extraction must not prematurely close the day: ${JSON.stringify(first)}`);
    assert.equal(f.progress()?.extractedMessageId, id(960));
    assert.deepEqual(seen, f.rows.slice(0, 960).map((row) => row.id));
    assert(f.jobs.some((data) => data.attemptCount === 0), "normal pagination must not exhaust model-failure retries");
    f.reclaim();
    const second = await runDailyEventJob(f.prisma, job, new Date(end.getTime() + 60_000));
    assert.equal(second.processed && second.status, "SUCCEEDED");
    assert.equal(f.progress()?.state, "FINAL");
    assert.deepEqual(seen, f.rows.map((row) => row.id), "all evidence must be read exactly once, even at identical timestamps");
  }
  // An hourly pass may already consume everything: empty final still closes existing DRAFT events.
  const hourly = fixture(2);
  await runDailyEventJob(hourly.prisma, { ...job, idempotencyKey: "events-hour:scope:2026-11-01:10" }, end);
  assert.equal(hourly.progress()?.state, "DRAFT");
  const seenBeforeFinal = seen.length;
  hourly.reclaim();
  const emptyFinal = await runDailyEventJob(hourly.prisma, job, end);
  assert.equal(emptyFinal.processed && emptyFinal.status, "SKIPPED");
  assert.equal(hourly.progress()?.state, "FINAL");
  assert.deepEqual(hourly.eventStates, ["FINAL"]);
  assert.equal(seen.length, seenBeforeFinal, "empty final must not call the model");

  // Failed second chunk: committed first chunk remains the restart cursor.
  seen.length = 0;
  const failing = fixture(241, true);
  failing.failAt(2);
  const failed = await runDailyEventJob(failing.prisma, job, end);
  assert.equal(failed.processed && failed.status, "RETRY_WAIT");
  assert.equal(failing.progress()?.extractedMessageId, id(40), "only the first 40-message chunk may commit");
  assert.deepEqual(seen, failing.rows.slice(0, 80).map((row) => row.id), "the failed second chunk was sent but must not advance the cursor");
  const committed = failing.progress()!.extractedMessageId;
  seen.length = 0;
  failing.failAt(0);
  failing.reclaim();
  const resumed = await runDailyEventJob(failing.prisma, job, end);
  assert.equal(resumed.processed && resumed.status, "SUCCEEDED");
  assert.equal(seen[0], id(Number(committed!.slice(-12)) + 1));
  assert.deepEqual(seen, failing.rows.slice(40).map((row) => row.id), "resume must replay the entire uncommitted chunk and consume the remaining evidence exactly once");
  assert.equal(failing.progress()?.extractedMessageId, id(241));
  assert.equal(failing.progress()?.state, "FINAL");

  // Legacy timestamp-only cursor must replay its boundary, not skip every same-time row.
  const legacy = fixture(3, true);
  legacy.setProgress({ state: "DRAFT", eventCount: 0, extractedAt: legacy.rows[0]!.occurredAt, extractedMessageId: null });
  seen.length = 0;
  await runDailyEventJob(legacy.prisma, job, end);
  assert.deepEqual(seen, legacy.rows.map((row) => row.id));
  console.log("Memory event pagination passed: 4000-token/40-message budgets, mixed lengths, Chinese, intact oversized evidence, ordered exact coverage, 960/961, same-time keysets, atomic cursor, failure resume, legacy cursor, and partial FINAL guard.");
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries({ LLM_API_KEY: originalEnv.key, LLM_BASE_URL: originalEnv.base, LLM_MODEL: originalEnv.model })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
