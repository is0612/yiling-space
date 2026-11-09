import assert from "node:assert/strict";
import type { PrismaClient } from "../src/generated/prisma/client";
import {
  eventMessageWhere, loadEventMessageBatch, loadEventContextMessages, splitEventMessagesByBudget,
  EVENT_AI_INPUT_TOKENS, EVENT_AI_MESSAGES_PER_REQUEST, EVENT_MESSAGE_BATCH_SIZE,
} from "../server/utils/memory-event-source";
import { estimateTokens } from "../server/utils/memory-retrieval";
import { runDailyEventJob } from "../server/utils/memory-worker";
import { validateMemoryAiOutput } from "../server/utils/memory-ai";

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

function fixture(count: number, sameTime = false, withContext = false) {
  const rows = makeRows(count, sameTime);
  const contextQueries: Array<Record<string, unknown>> = [];
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
      if (JSON.stringify(query.orderBy).includes("desc")) {
        contextQueries.push(query);
        if (!withContext) return [];
        const where = query.where as unknown as {
          conversationId: string; occurredAt: { gte: Date; lt: Date };
          OR: [{ occurredAt: { lt: Date } }, { occurredAt: Date; id: { lt: string } }];
        };
        assert.deepEqual(query.orderBy, [{ occurredAt: "desc" }, { id: "desc" }]);
        assert.equal(query.take, 12);
        return rows.filter(row => row.conversationId === where.conversationId
          && row.occurredAt >= where.occurredAt.gte && row.occurredAt < where.occurredAt.lt
          && (row.occurredAt < where.OR[0].occurredAt.lt
            || row.occurredAt.getTime() === where.OR[1].occurredAt.getTime() && row.id < where.OR[1].id.lt))
          .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || b.id.localeCompare(a.id))
          .slice(0, query.take);
      }
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
    prisma: mock as unknown as PrismaClient, rows, jobs, queries, contextQueries, eventStates,
    progress: () => progress,
    reclaim: () => { leaseRow = { status: "RUNNING", lockedBy: `pagination:claim-${++claims}` }; },
    setProgress: (value: Progress) => { progress = value; },
    failAt: (value: number) => { failTransactionAt = value; },
  };
}
const job = { id: "job", memoryScopeId: "scope", periodStart: start, periodEnd: end, idempotencyKey: "events-final:scope:2026-11-01" };
const seen: string[] = [];
type PromptMessage = { id: string; content: string; occurredAt: string };
const requests: Array<{ messages: PromptMessage[]; contextMessages?: PromptMessage[] }> = [];
let emitContextOnlyEvent = false;
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body));
  const prompt = JSON.parse(body.messages.find((m: { role: string }) => m.role === "user").content);
  requests.push(prompt);
  seen.push(...prompt.messages.map((m: { id: string }) => m.id));
  const context = prompt.contextMessages?.[0];
  const events = emitContextOnlyEvent && context ? [{
    occurredAt: context.occurredAt, title: "Already recorded context", detail: "Old evidence only",
    participants: [], keywords: [], evidenceMessageIds: [context.id], confidence: 0.9,
  }] : [];
  if (events.length) assert.equal(validateMemoryAiOutput({ summary: "Test summary", events }, [context.id], []).events.length, 1,
    "the context-only candidate must be valid before the new-evidence filter rejects it");
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    summary: "Test summary", importantEvents: [], factAndPreferenceChanges: [], relationshipChanges: [],
    goalsAndCommitments: [], unresolvedTopics: [], differencesFromPrevious: [], memoryChanges: [], events,
  }) } }] }), { status: 200, headers: { "content-type": "application/json" } });
};

try {
  // These are request limits, independent of the 960-message persistence page.
  assert.equal(EVENT_AI_INPUT_TOKENS, 4_000);
  assert.equal(EVENT_AI_MESSAGES_PER_REQUEST, 40);
  assert.deepEqual(splitEventMessagesByBudget([]), []);
  function checkChunks<T extends { id: string; content: string; occurredAt?: Date }>(messages: T[], budget = 4_000) {
    const before = JSON.stringify(messages);
    const chunks = splitEventMessagesByBudget(messages, budget);
    const effectiveBudget = Number.isFinite(budget) ? Math.min(4_000, Math.max(2_000, budget)) : 4_000;
    const flattened = chunks.flat();
    assert.deepEqual(flattened, messages, "splitting must preserve global order and every complete message exactly once");
    assert.equal(new Set(flattened.map((message) => message.id)).size, messages.length);
    flattened.forEach((message, index) => assert.equal(message, messages[index], "messages must remain intact"));
    assert.equal(JSON.stringify(messages), before, "splitting must not mutate its input");
    for (const chunk of chunks) {
      assert(chunk.length > 0 && chunk.length <= 40);
      const tokens = chunk.reduce((sum, message) => sum + estimateTokens(JSON.stringify(message)), 0);
      assert(tokens <= effectiveBudget || chunk.length === 1, "only a standalone oversized message may exceed the token budget");
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

  const timed = (count: number, gaps: Array<[number, number]> = [], tied = false) => short.slice(0, count).map((row, index) => ({
    ...row, occurredAt: new Date(start.getTime() + (tied ? 0 : index * 1_000)
      + gaps.filter(([boundary]) => index >= boundary).reduce((sum, [, gap]) => sum + gap, 0)),
  }));
  const lengths = <T>(chunks: T[][]) => chunks.map(chunk => chunk.length);
  assert.deepEqual(lengths(checkChunks(timed(45, [[24, 300_000], [32, 300_000]]))), [32, 13],
    "choose the latest qualifying pause in the hard block's latter half");
  assert.deepEqual(lengths(checkChunks(timed(45, [[20, 299_000]]))), [20, 25], "an exact five-minute gap at the halfway boundary is eligible");
  assert.deepEqual(lengths(checkChunks(timed(45, [[19, 600_000]]))), [40, 5], "an early pause must not create a tiny block");
  assert.deepEqual(lengths(checkChunks(timed(45, [[32, 298_999]]))), [40, 5], "a gap below five minutes is not a boundary");
  assert.deepEqual(lengths(checkChunks(timed(40, [[32, 300_000]]))), [40], "a final hard block must not split at a pause");
  assert.deepEqual(lengths(checkChunks(timed(81))), [40, 40, 1], "continuous messages retain the hard count boundary");
  assert.deepEqual(lengths(checkChunks(timed(81, [], true))), [40, 40, 1], "tied timestamps preserve id order and the forty-row cap");
  const budgetRows = Array.from({ length: 7 }, (_, index) => ({ id: String(index), content: "中".repeat(900) }));
  assert.deepEqual(lengths(checkChunks(budgetRows, 2_000)), [2, 2, 2, 1]);
  assert.deepEqual(lengths(checkChunks(budgetRows, 3_000)), [3, 3, 1]);
  for (const budget of [-1, 0, 1_999]) assert.deepEqual(checkChunks(budgetRows, budget), checkChunks(budgetRows, 2_000));
  for (const budget of [4_001, Infinity, NaN]) assert.deepEqual(checkChunks(budgetRows, budget), checkChunks(budgetRows));
  const tokenTimed = budgetRows.map((row, index) => ({ ...row, occurredAt: new Date(start.getTime() + index * 1_000 + (index >= 3 ? 300_000 : 0)) }));
  assert.deepEqual(lengths(checkChunks(tokenTimed)), [3, 4], "token-limited hard blocks also move to a natural pause");

  // Context is optional, bounded, complete, and chronological; an oversized nearest
  // message stops the window instead of skipping to unrelated older context.
  const contextRows = [{ id: "latest", content: "最近" }, { id: "older", content: "前文" }];
  const contextInput = { conversationId: "conversation", periodStart: start, periodEnd: end, first: { occurredAt: end, id: "first" } };
  const contextPrisma = (rows: typeof contextRows) => ({ message: { findMany: async () => rows } }) as unknown as Pick<PrismaClient, "message">;
  assert.deepEqual(await loadEventContextMessages(contextPrisma(contextRows), contextInput), [...contextRows].reverse());
  assert.deepEqual(await loadEventContextMessages(contextPrisma([{ id: "huge", content: "中".repeat(4_000) }, ...contextRows]), contextInput), [],
    "a nearest row above the context cap stops the window instead of skipping to older rows");
  const boundedContext = await loadEventContextMessages(contextPrisma([
    { id: "recent", content: "中".repeat(1_800) }, { id: "old", content: "中".repeat(1_800) },
  ]), contextInput);
  assert.deepEqual(boundedContext.map((row) => row.id), ["recent"]);
  const longContext = { id: "long-context", content: "中".repeat(2_000) };
  assert.deepEqual(await loadEventContextMessages(contextPrisma([longContext]), { ...contextInput, newMessageTokens: 0 }), [longContext],
    "a two-thousand-token nearest message fits intact when new evidence leaves room");
  assert.deepEqual(await loadEventContextMessages(contextPrisma([longContext]), { ...contextInput, newMessageTokens: 7_000 }), [],
    "the same nearest message must not be truncated into the minimum context window");
  for (const newMessageTokens of [0, 2_000, 3_000, 4_000, 9_000]) {
    const candidates = Array.from({ length: 12 }, (_, index) => ({ id: `ctx-${index}`, content: "中".repeat(450) }));
    // 前文与新消息共享 7000 token（= 前文上限 3000 + 新消息上限 4000）。
    const budget = Math.min(3_000, Math.max(1_000, 7_000 - newMessageTokens));
    const selected = await loadEventContextMessages(contextPrisma(candidates), { ...contextInput, newMessageTokens });
    const cost = selected.reduce((sum, row) => sum + estimateTokens(JSON.stringify(row)), 0);
    assert(cost <= budget);
    assert(cost + estimateTokens(JSON.stringify(candidates[selected.length]!)) > budget, "use all contiguous context that fits");
    assert.deepEqual(selected, candidates.slice(0, selected.length).reverse());
  }
  assert.deepEqual(await loadEventContextMessages(contextPrisma([
    { id: "near", content: "中".repeat(600) }, longContext, { id: "old-small", content: "old" },
  ]), { ...contextInput, newMessageTokens: 7_000 }), [{ id: "near", content: "中".repeat(600) }],
  "stop at a long middle row instead of skipping to older small messages");
  const isolation = fixture(20, true, true);
  isolation.rows[0]!.conversationId = "another-conversation";
  isolation.rows[1]!.occurredAt = new Date(start.getTime() - 1);
  const isolated = await loadEventContextMessages(isolation.prisma, {
    ...contextInput, first: isolation.rows[19]!, newMessageTokens: 0,
  });
  assert.equal(isolated.length, 12, "context query is capped at twelve even when more rows fit");
  assert.deepEqual(isolated.map(row => row.id), isolation.rows.slice(7, 19).map(row => row.id),
    "same-time context uses smaller ids and returns the nearest twelve in chronological order");
  const contextQuery = isolation.contextQueries[0]!;
  assert.deepEqual(contextQuery.where, {
    conversationId: "conversation", occurredAt: { gte: start, lt: end },
    OR: [{ occurredAt: { lt: isolation.rows[19]!.occurredAt } },
      { occurredAt: isolation.rows[19]!.occurredAt, id: { lt: isolation.rows[19]!.id } }],
  }, "context must stay in the conversation, period and strict timestamp/id predecessor window");

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

  // The real worker reserves context before sub-splitting each global block.
  seen.length = 0;
  requests.length = 0;
  const contextual = fixture(9, true, true);
  contextual.rows[0]!.content = "中".repeat(2_100);
  contextual.rows.slice(1).forEach(row => { row.content = "新".repeat(600); });
  const initialProgress: Progress = { state: "DRAFT", eventCount: 0,
    extractedAt: contextual.rows[0]!.occurredAt, extractedMessageId: contextual.rows[0]!.id };
  contextual.setProgress(initialProgress);
  emitContextOnlyEvent = true;
  const contextualResult = await runDailyEventJob(contextual.prisma, job, end);
  emitContextOnlyEvent = false;
  assert.equal(contextualResult.processed && contextualResult.status, "SUCCEEDED",
    "context-only model events must be removed before persistence (the mock has no event writer)");
  assert.deepEqual(seen, contextual.rows.slice(1).map(row => row.id), "context must never be consumed again as new evidence");
  assert.equal(requests.length, 2,
    "a long context must not shrink the new-evidence block: the subrequest size follows the 4000-token new-message budget, not the context already consumed");
  assert(requests[0]!.contextMessages?.some(row => row.id === id(1) && row.content === contextual.rows[0]!.content),
    "the long nearest context must reach the model intact");
  for (const request of requests) {
    const all = [...request.messages, ...(request.contextMessages ?? [])];
    const tokens = all.reduce((sum, row) => sum + estimateTokens(JSON.stringify(row)), 0);
    assert(tokens <= 7_000 || request.messages.length === 1 && estimateTokens(JSON.stringify(request.messages[0])) > 4_000,
      `new evidence plus context must share the seven-thousand-token budget: ${tokens}`);
    assert((request.contextMessages?.length ?? 0) <= 12);
    assert(!request.contextMessages?.some(row => request.messages.some(message => message.id === row.id)));
  }
  assert.equal(contextual.progress()?.extractedMessageId, id(9));
  assert.equal(contextual.progress()?.eventCount, 0, "context-only events must not be recorded again");

  // Failure after context-driven subrequests must replay the whole original global block.
  const atomic = fixture(9, true, true);
  atomic.rows.forEach((row, index) => { row.content = contextual.rows[index]!.content; });
  atomic.setProgress({ ...initialProgress });
  atomic.failAt(1);
  seen.length = 0;
  requests.length = 0;
  const atomicFailure = await runDailyEventJob(atomic.prisma, job, end);
  assert.equal(atomicFailure.processed && atomicFailure.status, "RETRY_WAIT");
  // The first block is one subrequest: context no longer eats into the new-message budget,
  // so the eight rows only split on the global block boundary above.
  assert.equal(requests.length, 1, "the first block must be a single subrequest before its transaction fails");
  assert.equal(atomic.progress()?.extractedMessageId, id(1), "no child request may advance the original block cursor independently");
  const replayIds = [...seen];
  atomic.failAt(0);
  atomic.reclaim();
  seen.length = 0;
  const atomicResume = await runDailyEventJob(atomic.prisma, job, end);
  assert.equal(atomicResume.processed && atomicResume.status, "SUCCEEDED");
  assert.deepEqual(seen.slice(0, replayIds.length), replayIds, "retry must replay every subrequest in the failed global block");
  assert.deepEqual(seen, atomic.rows.slice(1).map(row => row.id));

  // Legacy timestamp-only cursor must replay its boundary, not skip every same-time row.
  const legacy = fixture(3, true);
  legacy.setProgress({ state: "DRAFT", eventCount: 0, extractedAt: legacy.rows[0]!.occurredAt, extractedMessageId: null });
  seen.length = 0;
  await runDailyEventJob(legacy.prisma, job, end);
  assert.deepEqual(seen, legacy.rows.map((row) => row.id));
  console.log("Memory event pagination passed: natural pauses/early gaps/final blocks, clamped 2000–4000-token and 40-message limits, intact evidence, twelve-row contiguous context, shared 7000-token worker budget, context-only event rejection, atomic subrequest replay, 960/961 keysets, failure resume, legacy cursor, and partial FINAL guard.");
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries({ LLM_API_KEY: originalEnv.key, LLM_BASE_URL: originalEnv.base, LLM_MODEL: originalEnv.model })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
