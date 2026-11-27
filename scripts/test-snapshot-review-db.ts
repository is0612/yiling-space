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
import { processNextMemoryJob } from "../server/utils/memory-worker";
import { encryptApiKey } from "../server/utils/credential-encryption";
import type { PrismaClient } from "../src/generated/prisma/client";
import { Client } from "pg";
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
  const request = async (snapshotId: string, changeIndex: number, decision = "ACCEPT", token = session.token, extra: Record<string, unknown> = {}) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/characters/${characterId}/snapshots/${snapshotId}/review`, {
      method: "POST", headers: { cookie: `yiling_session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...extra, changeIndex, decision }),
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
  const history = await prisma.memoryItem.create({ data: { memoryScopeId: scopeId, category: "EVENT", content: "过去曾修复语音故障。", validFrom: periodStart } });
  const pending = await prisma.memoryItem.create({ data: { memoryScopeId: scopeId, category: "COMMITMENT", content: "导出测试仍待完成。", validFrom: periodStart } });
  const wrongFact = await prisma.memoryItem.create({ data: { memoryScopeId: scopeId, category: "FACT", content: "当前配置为 A。", validFrom: periodStart } });
  const completion = await prisma.message.create({ data: { conversationId: conversation.id, role: "USER", content: "导出测试已经通过。", occurredAt } });
  const correction = await prisma.message.create({ data: { conversationId: conversation.id, role: "USER", content: "当前配置为 B。", occurredAt } });
  const plan = await prisma.message.create({ data: { conversationId: conversation.id, role: "USER", content: "准备跑导出测试。", occurredAt: periodStart } });
  const invalidation = (item: typeof pending, sourceId: string, basis?: string) => ({ ...suggestion("已核对新消息"),
    action: "INVALIDATE", category: "FACT", supersededMemoryId: item.id, supersededCategory: item.category, supersededContent: item.content,
    evidenceMessageIds: [plan.id, sourceId], ...(basis ? { invalidationBasis: basis } : {}),
    ...(basis === "TEMPORARY_STATE_ENDED" ? { endingEvidenceMessageIds: [sourceId] } : {}),
    ...(basis === "CONTRADICTED" ? { contradictionEvidenceMessageIds: [sourceId] } : {}),
  });
  const { endingEvidenceMessageIds: _legacyMissing, ...legacyInvalidation } = invalidation(pending, completion.id, "TEMPORARY_STATE_ENDED");
  const third = await prisma.memorySnapshot.create({ data: {
    memoryScopeId: scopeId, snapshotKey, version: 3, periodStart, periodEnd: first.periodEnd, summary: "review completion",
    structuredContent: {
      activeMemoriesConsidered: [history.id, pending.id, wrongFact.id],
      analysis: { importantEvents: [{ title: "完成导出测试", detail: completion.content, evidenceMessageIds: [plan.id, completion.id], endedMemoryIds: [pending.id] }] },
      memoryChangesApplied: [invalidation(history, completion.id, "TEMPORARY_STATE_ENDED"), invalidation(pending, completion.id),
        invalidation(pending, message.id, "TEMPORARY_STATE_ENDED"), invalidation(pending, completion.id, "TEMPORARY_STATE_ENDED"),
        invalidation(wrongFact, correction.id, "CONTRADICTED"), legacyInvalidation],
    },
  } });
  for (const index of [0, 1, 2, 5]) assert.equal((await request(third.id, index)).status, 409);
  for (const index of [3, 4]) assert.equal((await request(third.id, index)).body.outcome, "INVALIDATED");
  assert.deepEqual((await prisma.memoryItem.findUniqueOrThrow({ where: { id: pending.id } })).validTo, completion.occurredAt);
  assert.deepEqual((await prisma.memoryItem.findUniqueOrThrow({ where: { id: wrongFact.id } })).validTo, correction.occurredAt,
    "earlier plan evidence must not determine contradiction validTo");
  assert.equal((await prisma.memoryItem.findUniqueOrThrow({ where: { id: history.id } })).status, "ACTIVE");
  assert.equal(await prisma.memoryReview.count({ where: { snapshotId: third.id } }), 2);
  assert.equal(await prisma.auditLog.count({ where: { entityId: { in: [pending.id, wrongFact.id] }, actorType: "USER", action: "memory.review_invalidated" } }), 2);
  const pendingBinding = await prisma.memoryItem.create({ data: { memoryScopeId: scopeId, category: "COMMITMENT", content: "发布核对待完成。", validFrom: periodStart } });
  const relatedBinding = await prisma.memoryItem.create({ data: { memoryScopeId: scopeId, category: "COMMITMENT", content: "发布结果复核待完成。", validFrom: periodStart } });
  const otherBinding = await prisma.memoryItem.create({ data: { memoryScopeId: scopeId, category: "COMMITMENT", content: "另一事项待完成。", validFrom: periodStart } });
  const confirmation = await prisma.message.create({ data: { conversationId: conversation.id, role: "USER", content: "发布及结果复核已完成。", occurredAt: new Date("2026-10-03T00:00:00Z") } });
  const secondConfirmation = await prisma.message.create({ data: { conversationId: conversation.id, role: "USER", content: "再次确认发布完成。", occurredAt: new Date("2026-10-04T00:00:00Z") } });
  const bindingChange = (item: typeof pendingBinding) => ({ ...invalidation(item, confirmation.id, "TEMPORARY_STATE_ENDED"),
    evidenceMessageIds: [plan.id, confirmation.id, secondConfirmation.id], endingEvidenceMessageIds: [secondConfirmation.id, confirmation.id],
  });
  const bindingEvent = (endedMemoryIds: string[], evidenceMessageIds = [confirmation.id, secondConfirmation.id]) => ({
    title: "完成发布与复核", detail: confirmation.content, endedMemoryIds, evidenceMessageIds,
  });
  const invalidEvents = [
    [{ title: "旧事件没有绑定", detail: confirmation.content, evidenceMessageIds: [confirmation.id, secondConfirmation.id] }],
    [bindingEvent([otherBinding.id])],
    [bindingEvent([pendingBinding.id, randomUUID()])],
    [bindingEvent([pendingBinding.id, pendingBinding.id])],
    [bindingEvent([pendingBinding.id], [confirmation.id]), bindingEvent([pendingBinding.id], [secondConfirmation.id])],
  ];
  const bindingSnapshots = [];
  for (const [index, importantEvents] of invalidEvents.entries()) {
    const fixture = await prisma.memorySnapshot.create({ data: {
      memoryScopeId: scopeId, snapshotKey, version: 4 + index, periodStart, periodEnd: first.periodEnd, summary: "invalid binding",
      structuredContent: { activeMemoriesConsidered: [pendingBinding.id, relatedBinding.id, otherBinding.id],
        analysis: { importantEvents }, memoryChangesApplied: [bindingChange(pendingBinding)] },
    } });
    bindingSnapshots.push(fixture);
    const beforeAudits = await prisma.auditLog.count({ where: { characterId } });
    const forged = await request(fixture.id, 0, "ACCEPT", session.token, {
      endedMemoryIds: [pendingBinding.id], endingEvidenceMessageIds: [confirmation.id],
      importantEvents: [bindingEvent([pendingBinding.id])],
      analysis: { importantEvents: [bindingEvent([pendingBinding.id])] },
      activeMemoriesConsidered: [pendingBinding.id],
    });
    assert.equal(forged.status, 409, `invalid binding case ${index} cannot be repaired by client fields`);
    assert.equal(await prisma.memoryReview.count({ where: { snapshotId: fixture.id } }), 0);
    assert.equal(await prisma.auditLog.count({ where: { characterId } }), beforeAudits);
    const unchanged = await prisma.memoryItem.findUniqueOrThrow({ where: { id: pendingBinding.id } });
    assert.equal(unchanged.status, "ACTIVE");
    assert.equal(unchanged.validTo, null);
  }
  const validBinding = await prisma.memorySnapshot.create({ data: {
    memoryScopeId: scopeId, snapshotKey, version: 9, periodStart, periodEnd: first.periodEnd, summary: "valid shared binding",
    structuredContent: { activeMemoriesConsidered: [pendingBinding.id, relatedBinding.id],
      // Keep invalid and unrelated entries before the matching event: indexes are immutable.
      analysis: { importantEvents: [null, { title: "不完整事件" }, bindingEvent([pendingBinding.id, relatedBinding.id])] },
      memoryChangesApplied: [bindingChange(pendingBinding), bindingChange(relatedBinding)] },
  } });
  bindingSnapshots.push(validBinding);
  for (const [index, item] of [pendingBinding, relatedBinding].entries()) {
    const response = await request(validBinding.id, index, "ACCEPT", session.token, {
      importantEvents: [], endingEvidenceMessageIds: [plan.id], endedMemoryIds: [otherBinding.id],
    });
    assert.equal(response.status, 200, JSON.stringify(response));
    const stored = await prisma.memoryItem.findUniqueOrThrow({ where: { id: item.id } });
    assert.equal(stored.status, "INVALIDATED");
    assert.deepEqual(stored.validTo, confirmation.occurredAt);
    const bindingAudit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: item.id, action: "memory.review_invalidated" } });
    assert.deepEqual((bindingAudit.details as { matchedImportantEventIndexes: number[] }).matchedImportantEventIndexes, [2]);
  }
  assert.equal(await prisma.memoryReview.count({ where: { snapshotId: validBinding.id, decision: "ACCEPTED" } }), 2);
  assert.equal((await request(validBinding.id, 0)).status, 409);
  const missingCorrection = await prisma.memoryItem.create({ data: { memoryScopeId: scopeId, category: "FACT", content: "旧配置待更正", validFrom: periodStart } });
  const { contradictionEvidenceMessageIds: _missingCorrectionIds, ...legacyCorrection } = invalidation(missingCorrection, correction.id, "CONTRADICTED");
  const missingCorrectionSnapshot = await prisma.memorySnapshot.create({ data: {
    memoryScopeId: scopeId, snapshotKey, version: 10, periodStart, periodEnd: first.periodEnd, summary: "missing correction confirmation",
    structuredContent: { memoryChangesApplied: [legacyCorrection] },
  } });
  const auditsBeforeCorrection = await prisma.auditLog.count({ where: { characterId } });
  assert.equal((await request(missingCorrectionSnapshot.id, 0, "ACCEPT", session.token, { contradictionEvidenceMessageIds: [correction.id] })).status, 409);
  assert.equal(await prisma.memoryReview.count({ where: { snapshotId: missingCorrectionSnapshot.id } }), 0);
  assert.equal(await prisma.auditLog.count({ where: { characterId } }), auditsBeforeCorrection);
  assert.equal((await prisma.memoryItem.findUniqueOrThrow({ where: { id: missingCorrection.id } })).status, "ACTIVE");

  // Real PostgreSQL barrier: hold Worker-order scope lock, wait until the HTTP review
  // is actually blocked on that scope, then prove it has not locked the snapshot.
  // This is lock-order integration coverage, not a mock Worker or model.
  const blocker = new Client({ connectionString: url.toString() });
  const observer = new Client({ connectionString: url.toString() });
  await blocker.connect();
  await observer.connect();
  try {
    for (const [index, decision] of ["ACCEPT", "IGNORE"].entries()) {
      const fixture = await prisma.memorySnapshot.create({ data: {
        memoryScopeId: scopeId, snapshotKey, version: 11 + index, periodStart, periodEnd: first.periodEnd, summary: "scope lock contention",
        structuredContent: { memoryChangesApplied: [suggestion(`锁顺序回归事实 ${decision}`)] },
      } });
      let pendingReview: ReturnType<typeof request> | undefined;
      await blocker.query("BEGIN");
      try {
        await blocker.query('SELECT id FROM memory_scopes WHERE id = $1::uuid FOR UPDATE', [scopeId]);
        pendingReview = request(fixture.id, 0, decision);
        const deadline = Date.now() + 4000;
        let waitingOnScope = false;
        while (Date.now() < deadline) {
          const waits = await observer.query("SELECT query FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%memory_scopes%' AND pid <> pg_backend_pid()");
          waitingOnScope = waits.rows.length > 0;
          if (waitingOnScope) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert(waitingOnScope, `${decision} must reach the real scope lock barrier`);
        // Old snapshot->scope ordering would make this NOWAIT fail with 55P03.
        await blocker.query('SELECT id FROM memory_snapshots WHERE id = $1::uuid FOR UPDATE NOWAIT', [fixture.id]);
        await blocker.query('UPDATE memory_snapshots SET status = $2 WHERE id = $1::uuid', [fixture.id, "SUPERSEDED"]);
        await blocker.query("COMMIT");
        const outcome = await pendingReview;
        assert.equal(outcome.status, 200, JSON.stringify(outcome));
        assert.equal(await prisma.memoryReview.count({ where: { snapshotId: fixture.id } }), 1);
      } finally {
        await blocker.query("ROLLBACK");
        if (pendingReview) await pendingReview;
      }
    }
  } finally {
    await Promise.all([blocker.end(), observer.end()]);
  }
  // Unknown or inverted temporal intervals fail in the actual HTTP/DB path.
  for (const [offset, validFrom] of [null, new Date("2026-10-06T00:00:00Z"), correction.occurredAt].entries()) {
    const item = await prisma.memoryItem.create({ data: { memoryScopeId: scopeId, category: "FACT", content: `interval-rejected-${offset}`, validFrom } });
    const fixture = await prisma.memorySnapshot.create({ data: {
      memoryScopeId: scopeId, snapshotKey, version: 13 + offset, periodStart, periodEnd: first.periodEnd, summary: "invalid temporal interval",
      structuredContent: { memoryChangesApplied: [invalidation(item, correction.id, "CONTRADICTED")] },
    } });
    const before = await prisma.auditLog.count({ where: { characterId } });
    const response = await request(fixture.id, 0);
    const stored = await prisma.memoryItem.findUniqueOrThrow({ where: { id: item.id } });
    if (offset === 2) {
      assert.equal(response.status, 200);
      assert.equal(stored.status, "INVALIDATED");
      assert.deepEqual(stored.validTo, correction.occurredAt, "equal interval endpoints are valid");
      assert.equal(await prisma.memoryReview.count({ where: { snapshotId: fixture.id } }), 1);
    } else {
      assert.equal(response.status, 409);
      assert.equal(stored.status, "ACTIVE");
      assert.equal(stored.validTo, null);
      assert.equal(await prisma.memoryReview.count({ where: { snapshotId: fixture.id } }), 0);
      assert.equal(await prisma.auditLog.count({ where: { characterId } }), before);
    }
  }

  // Actual REGENERATE worker holds its real scope row lock while an actual HTTP
  // review queues behind it. The proxy supplies only a scheduling barrier; every
  // query, mutation, transaction and lease check remains the production operation.
  {
    const originalFetch = globalThis.fetch;
    await prisma.character.update({ where: { id: characterId }, data: { modelConfig: {
      chatModel: "review-lock-model", chatApiBaseUrl: "https://review-lock.invalid/v1", chatApiKeyEncrypted: await encryptApiKey("test-only-review-key"),
    } } });
    const sourceSnapshot = await prisma.memorySnapshot.create({ data: {
      memoryScopeId: scopeId, snapshotKey: `actual-worker-lock:${randomUUID()}`, periodStart, periodEnd: first.periodEnd, summary: "worker contention source",
      structuredContent: { memoryChangesApplied: [suggestion("实际 Worker 并发采纳事实")] },
    } });
    const job = await prisma.memoryJob.create({ data: {
      memoryScopeId: scopeId, type: "REGENERATE_SNAPSHOT", snapshotId: sourceSnapshot.id,
      periodStart, periodEnd: first.periodEnd, idempotencyKey: `review-worker-lock:${randomUUID()}`, runAt: new Date(0),
    } });
    let entered!: () => void;
    let release!: () => void;
    const scopeLocked = new Promise<void>(resolve => { entered = resolve; });
    const continueWorker = new Promise<void>(resolve => { release = resolve; });
    let gated = false;
    const workerPrisma = new Proxy(prisma, { get(target, property, receiver) {
      if (property !== "$transaction") return Reflect.get(target, property, receiver);
      return (run: (tx: any) => Promise<unknown>, options?: any) => target.$transaction(async tx => run(new Proxy(tx, { get(realTx, key, txReceiver) {
        if (key !== "$queryRaw") return Reflect.get(realTx, key, txReceiver);
        return async (parts: TemplateStringsArray, ...values: unknown[]) => {
          const result = await realTx.$queryRaw(parts, ...values);
          if (!gated && parts.join("").includes("memory_scopes") && parts.join("").includes("FOR UPDATE")) {
            gated = true;
            entered();
            await continueWorker;
          }
          return result;
        };
      } })), { ...options, timeout: 15_000 });
    } }) as PrismaClient;
    globalThis.fetch = async (input, init) => {
      if (!String(input).startsWith("https://review-lock.invalid/")) return originalFetch(input, init);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "重新提炼并发测试", memoryChanges: [], importantEvents: [] }) } }] }), { headers: { "content-type": "application/json" } });
    };
    const inspect = new Client({ connectionString: url.toString() });
    await inspect.connect();
    const worker = processNextMemoryJob(workerPrisma, { jobId: job.id, ownerId, workerId: "review-concurrency-worker" });
    let concurrentReview: ReturnType<typeof request> | undefined;
    let barrierTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([scopeLocked, new Promise<never>((_resolve, reject) => { barrierTimeout = setTimeout(() => reject(new Error("actual Worker did not reach scope lock")), 8000); })]);
      if (barrierTimeout) clearTimeout(barrierTimeout);
      concurrentReview = request(sourceSnapshot.id, 0);
      const deadline = Date.now() + 4000;
      let queued = false;
      while (Date.now() < deadline) {
        const waits = await inspect.query("SELECT query FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%memory_scopes%' AND pid <> pg_backend_pid()");
        queued = waits.rows.length > 0;
        if (queued) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert(queued, "HTTP review must wait for the actual Worker scope lock");
      release();
      const [workerResult, reviewResult] = await Promise.all([worker, concurrentReview]);
      assert(workerResult.processed && workerResult.status === "SUCCEEDED", JSON.stringify(workerResult));
      assert.equal(reviewResult.status, 200, JSON.stringify(reviewResult));
      assert.equal((await prisma.memorySnapshot.findUniqueOrThrow({ where: { id: sourceSnapshot.id } })).status, "SUPERSEDED");
      assert.equal(await prisma.memoryReview.count({ where: { snapshotId: sourceSnapshot.id, decision: "ACCEPTED" } }), 1);
      assert.equal(await prisma.memoryItem.count({ where: { memoryScopeId: scopeId, content: "实际 Worker 并发采纳事实", status: "ACTIVE" } }), 1);
      assert.equal(await prisma.auditLog.count({ where: { entityId: sourceSnapshot.id, action: "snapshot.review_accepted" } }), 1);
    } finally {
      if (barrierTimeout) clearTimeout(barrierTimeout);
      release();
      await Promise.allSettled([worker, ...(concurrentReview ? [concurrentReview] : [])]);
      globalThis.fetch = originalFetch;
      await inspect.end();
    }
  }
  for (const original of [first, second, third, ...bindingSnapshots]) {
    const current = await prisma.memorySnapshot.findUniqueOrThrow({ where: { id: original.id } });
    assert.deepEqual(current.structuredContent, original.structuredContent);
    assert.equal(current.summary, original.summary);
  }
  console.log("Snapshot review passed: real h3/session, concurrent ADD/reviews, retention fallback, Worker evidence, owner isolation and immutable snapshots.");
} finally {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await prisma.$disconnect();
}
