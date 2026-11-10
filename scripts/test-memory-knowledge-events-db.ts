import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { Prisma } from "../src/generated/prisma/client";
import { getPrisma } from "../server/utils/prisma";
import { readPublicMemoryKnowledgeSource } from "../server/utils/growth-domain-gateway";
import { publishGrowthEvent } from "../server/utils/growth-event-center";
import { GROWTH_EVENT_HANDLERS } from "../server/utils/growth-event-consumers";
import {
  claimNextGrowthEventDelivery, cleanupGrowthEvents, completeGrowthEventDelivery, failGrowthEventDelivery,
} from "../server/utils/growth-event-delivery";
import {
  memoryKnowledgeSourceHash, parseMemoryKnowledgeRequest, requestMemoryKnowledgeCandidate,
  requireValidMemoryKnowledgeCandidateSource,
} from "../server/utils/knowledge-memory-candidates";

// This suite is registered after the original Growth Event Center suites, never run against business data.
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
assert(["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname), "Memory knowledge tests require a local PostgreSQL host.");
assert(/^\/yiling_growth_event_test_[a-f0-9]{32}$/.test(databaseUrl.pathname), "Memory knowledge tests require a disposable Growth Event Center database.");
const options = databaseUrl.searchParams.get("options") ?? "";
databaseUrl.searchParams.set("options", `${options} -c statement_timeout=6000 -c lock_timeout=3000`.trim());
process.env.DATABASE_URL = databaseUrl.toString();
const prisma = getPrisma();
const consumerKey = "knowledge.memory-candidate-create";
const consumer = GROWTH_EVENT_HANDLERS[consumerKey];
assert(consumer, "Memory knowledge consumer must be registered.");
const EXCERPT = "这是一段由主人明确选择的连续原文摘录，只应成为待处理知识候选。";
const ALTERNATIVE = "这是同一来源中另一段足够长的连续原文，用来证明重复申请不会覆盖原摘录。";
const DETAIL = `来源前文。${EXCERPT}中间分隔。${ALTERNATIVE}来源后文。`;
const DAY = 24 * 60 * 60 * 1_000;

type Fixture = {
  ownerId: string; otherOwnerId: string; characterId: string; otherCharacterId: string;
  globalScopeId: string; privateScopeId: string; externalScopeId: string; otherGlobalScopeId: string;
};
async function scenario(label: string, run: (fixture: Fixture) => Promise<void>) {
  console.log(`\n[memory-knowledge] ${label}`);
  const owners: string[] = [];
  const characters: string[] = [];
  let identityId: string | undefined;
  try {
    for (let index = 0; index < 2; index += 1) {
      const owner = await prisma.user.create({ data: { username: `memory-knowledge-${randomUUID()}`, passwordHash: "isolated-test-only", role: "USER", status: "ACTIVE" } });
      owners.push(owner.id);
      const character = await prisma.character.create({ data: { ownerId: owner.id, name: "知识来源隔离测试角色", basePrompt: "disposable fixture" } });
      characters.push(character.id);
    }
    const identity = await prisma.externalIdentity.create({ data: { platform: "qq-onebot", platformUid: `memory-knowledge-${randomUUID()}` } });
    identityId = identity.id;
    const scope = (characterId: string, scopeType: "CHARACTER_GLOBAL" | "USER_PRIVATE" | "EXTERNAL_IDENTITY") => prisma.memoryScope.create({ data: {
      characterId, scopeType, scopeKey: `memory-knowledge:${randomUUID()}`,
      ...(scopeType === "USER_PRIVATE" ? { userId: owners[0] } : {}),
      ...(scopeType === "EXTERNAL_IDENTITY" ? { externalIdentityId: identity.id } : {}),
    } });
    const global = await scope(characters[0]!, "CHARACTER_GLOBAL");
    const privateScope = await scope(characters[0]!, "USER_PRIVATE");
    const external = await scope(characters[0]!, "EXTERNAL_IDENTITY");
    const otherGlobal = await scope(characters[1]!, "CHARACTER_GLOBAL");
    await run({ ownerId: owners[0]!, otherOwnerId: owners[1]!, characterId: characters[0]!, otherCharacterId: characters[1]!,
      globalScopeId: global.id, privateScopeId: privateScope.id, externalScopeId: external.id, otherGlobalScopeId: otherGlobal.id });
    assert.equal(await prisma.knowledgeItem.count({ where: { characterId: { in: characters } } }), 0, "Events must never create formal knowledge items.");
    assert.equal(await prisma.modelUsage.count({ where: { characterId: { in: characters } } }), 0, "Events must not record model calls.");
  } finally {
    // Claims are global. Remove only this scenario's fixtures before the next scenario starts.
    await prisma.growthEvent.deleteMany({ where: { characterId: { in: characters } } });
    await prisma.auditLog.deleteMany({ where: { characterId: { in: characters } } });
    await prisma.modelUsage.deleteMany({ where: { characterId: { in: characters } } });
    await prisma.memoryScope.deleteMany({ where: { characterId: { in: characters } } });
    await prisma.character.deleteMany({ where: { id: { in: characters } } });
    if (identityId) await prisma.externalIdentity.deleteMany({ where: { id: identityId } });
    await prisma.user.deleteMany({ where: { id: { in: owners } } });
  }
}
async function source(fixture: Fixture, memoryScopeId = fixture.globalScopeId) {
  return prisma.memoryEvent.create({ data: {
    memoryScopeId, dayKey: "2026-11-10", occurredAt: new Date("2026-11-10T00:00:00.000Z"),
    title: "公开忆泡知识来源", detail: DETAIL, dedupeKey: `memory-knowledge:${randomUUID()}`,
  } });
}
function input(fixture: Fixture, memoryEventId: string, excerpt = EXCERPT) {
  return { ownerId: fixture.ownerId, characterId: fixture.characterId, memoryEventId, excerpt, reason: "" };
}
async function request(fixture: Fixture) {
  const event = await source(fixture);
  const result = await requestMemoryKnowledgeCandidate(prisma, { ...input(fixture, event.id), reason: "主人提出的待核验说明" });
  assert.equal(result.created, true);
  return { source: event, result };
}
async function claim(fixture: Fixture, now = new Date(Date.now() + 1_000)) {
  const lease = await claimNextGrowthEventDelivery(prisma, { workerId: `memory-knowledge-${randomUUID()}`, now });
  assert(lease, "Expected isolated knowledge request delivery.");
  assert.equal(lease.event.characterId, fixture.characterId);
  assert.equal(lease.consumerKey, consumerKey);
  return lease;
}
async function consume(fixture: Fixture) {
  const lease = await claim(fixture);
  const status = await completeGrowthEventDelivery(prisma, lease, consumer, new Date());
  return { lease, status };
}
async function republish(fixture: Fixture, requestId: string, idempotencyKey = `replay:${randomUUID()}`) {
  const durable = await prisma.memoryKnowledgeCandidateRequest.findUniqueOrThrow({ where: { id: requestId } });
  return prisma.$transaction(tx => publishGrowthEvent(tx, {
    characterId: fixture.characterId, sourceDomain: "memory", eventType: "memory.knowledge-candidate.requested",
    aggregateType: "MemoryKnowledgeCandidateRequest", aggregateId: requestId, occurredAt: durable.createdAt,
    idempotencyKey, payload: { requestId },
  }));
}
function statusCode(error: unknown, expected: number) { return Boolean(error && typeof error === "object" && "statusCode" in error && error.statusCode === expected); }

// Parsing is pure; run it before any fixture creation. Unknown properties must never steer a write.
assert.deepEqual(parseMemoryKnowledgeRequest({ excerpt: `  ${EXCERPT}  ` }), { excerpt: EXCERPT, reason: "" });
assert.deepEqual(parseMemoryKnowledgeRequest({ excerpt: EXCERPT, reason: "  因为值得进一步核验  " }), { excerpt: EXCERPT, reason: "因为值得进一步核验" });
for (const invalid of [null, [], "text", {}, { excerpt: 123 }, { excerpt: EXCERPT, reason: null }, { excerpt: EXCERPT, reason: 1 }, { excerpt: "短" }, { excerpt: "x".repeat(2_001) }, { excerpt: EXCERPT, reason: "x".repeat(241) }, { excerpt: EXCERPT, characterId: randomUUID() }, { excerpt: EXCERPT, sourceType: "MANUAL" }, { excerpt: EXCERPT, rawContent: "injected" }]) {
  assert.throws(() => parseMemoryKnowledgeRequest(invalid), error => statusCode(error, 400));
}
assert.equal(parseMemoryKnowledgeRequest({ excerpt: "x".repeat(20), reason: "x".repeat(240) }).excerpt.length, 20);
assert.equal(parseMemoryKnowledgeRequest({ excerpt: "x".repeat(2_000) }).excerpt.length, 2_000);
assert.notEqual(memoryKnowledgeSourceHash({ title: "a", detail: DETAIL }), memoryKnowledgeSourceHash({ title: "b", detail: DETAIL }));

const originalFetch = globalThis.fetch;
let modelCalls = 0;
globalThis.fetch = (async () => { modelCalls += 1; throw new Error("Knowledge candidate event must not call a model or external service."); }) as typeof fetch;
try {
  await scenario("owner/global request: four concurrent submissions share one durable request, event and delivery", async fixture => {
    const event = await source(fixture);
    const results = await Promise.all(Array.from({ length: 4 }, () => requestMemoryKnowledgeCandidate(prisma, input(fixture, event.id))));
    assert.equal(results.filter(result => result.created).length, 1);
    assert.equal(new Set(results.map(result => result.requestId)).size, 1);
    assert.equal(new Set(results.map(result => result.eventId)).size, 1);
    assert.equal(await prisma.memoryKnowledgeCandidateRequest.count({ where: { characterId: fixture.characterId } }), 1);
    assert.equal(await prisma.growthEvent.count({ where: { characterId: fixture.characterId } }), 1);
    assert.equal(await prisma.growthEventDelivery.count({ where: { event: { characterId: fixture.characterId } } }), 1);
    const duplicate = await requestMemoryKnowledgeCandidate(prisma, { ...input(fixture, event.id, ALTERNATIVE), reason: "不能覆盖首个请求" });
    assert.equal(duplicate.created, false);
    const durable = await prisma.memoryKnowledgeCandidateRequest.findUniqueOrThrow({ where: { id: duplicate.requestId } });
    assert.equal(durable.excerpt, EXCERPT); assert.equal(durable.reason ?? "", ""); assert.equal(durable.status, "PENDING");
    assert.equal(durable.sourceHash, memoryKnowledgeSourceHash(event));
    const outbox = await prisma.growthEvent.findUniqueOrThrow({ where: { id: duplicate.eventId! } });
    assert.deepEqual(outbox.payload, { requestId: durable.id });
    assert(!JSON.stringify(outbox.payload).includes(EXCERPT));
    assert.equal(await prisma.knowledgeCandidate.count({ where: { characterId: fixture.characterId } }), 0);
    assert.equal(await prisma.knowledgeItem.count({ where: { characterId: fixture.characterId } }), 0);
    // Substring validation is a service check; a valid-length but altered excerpt must be rejected.
    const another = await source(fixture);
    await assert.rejects(() => requestMemoryKnowledgeCandidate(prisma, input(fixture, another.id, "太短")), error => statusCode(error, 400));
    await assert.rejects(() => requestMemoryKnowledgeCandidate(prisma, input(fixture, another.id, "x".repeat(2_001))), error => statusCode(error, 400));
    await assert.rejects(() => requestMemoryKnowledgeCandidate(prisma, { ...input(fixture, another.id), reason: "x".repeat(241) }), error => statusCode(error, 400));
    await assert.rejects(() => requestMemoryKnowledgeCandidate(prisma, input(fixture, another.id, `${EXCERPT}改写`)), error => statusCode(error, 409));
    assert.equal(await prisma.memoryKnowledgeCandidateRequest.count({ where: { memoryEventId: another.id } }), 0);
  });

  await scenario("private, external, archived, cross-role and non-owner sources cannot be requested", async fixture => {
    const publicSource = await source(fixture);
    const privateSource = await source(fixture, fixture.privateScopeId);
    const externalSource = await source(fixture, fixture.externalScopeId);
    const otherSource = await source(fixture, fixture.otherGlobalScopeId);
    const archived = await source(fixture);
    await prisma.memoryEvent.update({ where: { id: archived.id }, data: { status: "ARCHIVED" } });
    for (const id of [privateSource.id, externalSource.id, otherSource.id, archived.id, randomUUID()]) {
      assert.equal(await prisma.$transaction(tx => readPublicMemoryKnowledgeSource(tx, fixture.characterId, id)), null);
      await assert.rejects(() => requestMemoryKnowledgeCandidate(prisma, input(fixture, id)), error => statusCode(error, 404));
    }
    await assert.rejects(() => requestMemoryKnowledgeCandidate(prisma, { ...input(fixture, publicSource.id), ownerId: fixture.otherOwnerId }), error => statusCode(error, 404));
    assert.equal(await prisma.memoryKnowledgeCandidateRequest.count({ where: { characterId: fixture.characterId } }), 0);
    assert.equal(await prisma.growthEvent.count({ where: { characterId: fixture.characterId } }), 0);
  });

  await scenario("consumer creates only one PENDING exact-excerpt candidate and clears the terminal request excerpt", async fixture => {
    const { source: event, result } = await request(fixture);
    assert.equal((await consume(fixture)).status, "SUCCEEDED");
    const durable = await prisma.memoryKnowledgeCandidateRequest.findUniqueOrThrow({ where: { id: result.requestId } });
    assert.equal(durable.status, "CREATED"); assert.equal(durable.excerpt, ""); assert.equal(durable.reason ?? "", ""); assert(durable.candidateId);
    const candidate = await prisma.knowledgeCandidate.findUniqueOrThrow({ where: { id: durable.candidateId } });
    assert.equal(candidate.status, "PENDING"); assert.equal(candidate.sourceType, "MEMORY_EVENT");
    assert.equal(candidate.rawContent, EXCERPT); assert.equal(candidate.processedResult, null); assert.equal(candidate.processedAt, null);
    const ref = candidate.sourceRef as Prisma.JsonObject;
    assert.equal(ref.kind, "MEMORY_EVENT"); assert.equal(ref.memoryEventId, event.id); assert.equal(ref.requestId, durable.id);
    assert.equal(ref.sourceHash, memoryKnowledgeSourceHash(event)); assert.equal(ref.ownerProposed, true);
    assert(!("reason" in ref), "Reason must not be duplicated into sourceRef.");
    assert(!("excerpt" in ref), "Only rawContent stores the selected excerpt.");
    await prisma.$transaction(tx => requireValidMemoryKnowledgeCandidateSource(tx, candidate));
    assert.equal(await prisma.knowledgeItem.count({ where: { characterId: fixture.characterId } }), 0);
    assert.equal(await prisma.modelUsage.count({ where: { characterId: fixture.characterId } }), 0);
    assert.equal(modelCalls, 0);
    const repeated = await requestMemoryKnowledgeCandidate(prisma, input(fixture, event.id, ALTERNATIVE));
    assert.equal(repeated.created, false); assert.equal(repeated.status, "CREATED"); assert.equal(repeated.candidateId, candidate.id);
    assert.equal((await prisma.knowledgeCandidate.findUniqueOrThrow({ where: { id: candidate.id } })).rawContent, EXCERPT);
  });

  await scenario("two different events concurrently consume one request and create one candidate", async fixture => {
    const { result } = await request(fixture);
    await republish(fixture, result.requestId);
    const leases = await Promise.all([claim(fixture), claim(fixture)]);
    assert.notEqual(leases[0]!.deliveryId, leases[1]!.deliveryId);
    const completed = await Promise.allSettled(leases.map(lease => completeGrowthEventDelivery(prisma, lease, consumer, new Date())));
    for (const result of completed) if (result.status === "rejected") throw result.reason;
    assert.deepEqual(completed.map(result => result.status === "fulfilled" ? result.value : null).sort(), ["SKIPPED", "SUCCEEDED"]);
    assert.equal(await prisma.knowledgeCandidate.count({ where: { characterId: fixture.characterId } }), 1);
    assert.equal((await prisma.memoryKnowledgeCandidateRequest.findUniqueOrThrow({ where: { id: result.requestId } })).excerpt, "");
  });

  await scenario("consumer throw rolls request and candidate back together, then retry succeeds", async fixture => {
    const { result } = await request(fixture);
    const lease = await claim(fixture);
    const failedAt = new Date();
    await assert.rejects(() => completeGrowthEventDelivery(prisma, lease, async (tx, event) => {
      await consumer(tx, event);
      assert.equal((await tx.memoryKnowledgeCandidateRequest.findUniqueOrThrow({ where: { id: result.requestId } })).status, "CREATED");
      assert.equal(await tx.knowledgeCandidate.count({ where: { characterId: fixture.characterId } }), 1);
      throw new Error("candidate transaction rollback expected");
    }, failedAt), /candidate transaction rollback expected/);
    const pending = await prisma.memoryKnowledgeCandidateRequest.findUniqueOrThrow({ where: { id: result.requestId } });
    assert.equal(pending.status, "PENDING"); assert.equal(pending.excerpt, EXCERPT); assert.equal(pending.reason, "主人提出的待核验说明"); assert.equal(pending.candidateId, null);
    assert.equal(await prisma.knowledgeCandidate.count({ where: { characterId: fixture.characterId } }), 0);
    assert.equal(await prisma.auditLog.count({ where: { characterId: fixture.characterId, action: "knowledge.memory_candidate.created" } }), 0);
    assert.equal(await failGrowthEventDelivery(prisma, lease, new Error("retry expected"), failedAt), "RETRY_WAIT");
    const delivery = await prisma.growthEventDelivery.findUniqueOrThrow({ where: { id: lease.deliveryId } });
    const retryAt = new Date(delivery.runAt.getTime() + 1);
    const retried = await claim(fixture, retryAt);
    assert.equal(retried.deliveryId, lease.deliveryId); assert(retried.fencingToken > lease.fencingToken);
    assert.equal(await completeGrowthEventDelivery(prisma, retried, consumer, retryAt), "SUCCEEDED");
    assert.equal(await prisma.knowledgeCandidate.count({ where: { characterId: fixture.characterId } }), 1);
  });

  for (const mutation of ["archive", "delete", "privatize", "change-title", "change-detail"] as const) {
    await scenario(`source ${mutation} after request makes the request terminal SKIPPED`, async fixture => {
      const { source: event, result } = await request(fixture);
      if (mutation === "archive") await prisma.memoryEvent.update({ where: { id: event.id }, data: { status: "ARCHIVED" } });
      else if (mutation === "delete") await prisma.memoryEvent.delete({ where: { id: event.id } });
      else if (mutation === "privatize") await prisma.memoryEvent.update({ where: { id: event.id }, data: { memoryScopeId: fixture.privateScopeId } });
      else if (mutation === "change-title") await prisma.memoryEvent.update({ where: { id: event.id }, data: { title: "已经变更的标题" } });
      else await prisma.memoryEvent.update({ where: { id: event.id }, data: { detail: `${DETAIL}后补新内容` } });
      assert.equal((await consume(fixture)).status, "SKIPPED");
      const terminal = await prisma.memoryKnowledgeCandidateRequest.findUniqueOrThrow({ where: { id: result.requestId } });
      assert.equal(terminal.status, "SKIPPED"); assert.equal(terminal.excerpt, ""); assert.equal(terminal.reason ?? "", ""); assert(terminal.skipReason); assert.equal(terminal.candidateId, null);
      assert.equal(await prisma.knowledgeCandidate.count({ where: { characterId: fixture.characterId } }), 0);
      if (mutation !== "delete") {
        await prisma.memoryEvent.update({ where: { id: event.id }, data: { status: "ACTIVE", memoryScopeId: fixture.globalScopeId, title: event.title, detail: event.detail } });
        const repeated = await requestMemoryKnowledgeCandidate(prisma, input(fixture, event.id));
        assert.equal(repeated.created, false); assert.equal(repeated.requestId, result.requestId); assert.equal(repeated.status, "SKIPPED", "Terminal requests cannot reopen after source restoration.");
      }
    });
  }

  await scenario("candidate deletion and Outbox cleanup cannot reopen the durable source request", async fixture => {
    const { source: event, result } = await request(fixture);
    const completed = await consume(fixture);
    const durable = await prisma.memoryKnowledgeCandidateRequest.findUniqueOrThrow({ where: { id: result.requestId } });
    assert(durable.candidateId);
    await prisma.knowledgeCandidate.delete({ where: { id: durable.candidateId } });
    const duplicate = await requestMemoryKnowledgeCandidate(prisma, input(fixture, event.id, ALTERNATIVE));
    assert.equal(duplicate.created, false); assert.equal(duplicate.status, "CREATED");
    assert.equal(await cleanupGrowthEvents(prisma, { now: new Date(Date.now() + 31 * DAY), retentionDays: 30 }), 1);
    assert.equal(await prisma.growthEvent.findUnique({ where: { id: completed.lease.eventId } }), null);
    await republish(fixture, result.requestId, `memory.knowledge-candidate.requested:${result.requestId}`);
    assert.equal((await consume(fixture)).status, "SKIPPED");
    assert.equal(await prisma.knowledgeCandidate.count({ where: { characterId: fixture.characterId } }), 0);
    assert.equal((await prisma.memoryKnowledgeCandidateRequest.findUniqueOrThrow({ where: { id: result.requestId } })).status, "CREATED");
  });

  await scenario("candidate source helper rejects changed, private, archived, deleted and malformed references", async fixture => {
    const { source: event, result } = await request(fixture);
    await consume(fixture);
    const durable = await prisma.memoryKnowledgeCandidateRequest.findUniqueOrThrow({ where: { id: result.requestId } });
    const candidate = await prisma.knowledgeCandidate.findUniqueOrThrow({ where: { id: durable.candidateId! } });
    await prisma.$transaction(tx => requireValidMemoryKnowledgeCandidateSource(tx, candidate));
    await assert.rejects(() => prisma.$transaction(tx => requireValidMemoryKnowledgeCandidateSource(tx, { ...candidate, characterId: fixture.otherCharacterId })), error => statusCode(error, 409));
    for (const data of [{ title: "修改后的标题" }, { detail: `${DETAIL}改变` }, { status: "ARCHIVED" as const }, { memoryScopeId: fixture.privateScopeId }, { memoryScopeId: fixture.externalScopeId }]) {
      await prisma.memoryEvent.update({ where: { id: event.id }, data });
      await assert.rejects(() => prisma.$transaction(tx => requireValidMemoryKnowledgeCandidateSource(tx, candidate)), error => statusCode(error, 409));
      await prisma.memoryEvent.update({ where: { id: event.id }, data: { title: event.title, detail: event.detail, status: "ACTIVE", memoryScopeId: fixture.globalScopeId } });
    }
    await assert.rejects(() => prisma.$transaction(tx => requireValidMemoryKnowledgeCandidateSource(tx, { ...candidate, sourceRef: { kind: "MEMORY_EVENT" } })), error => statusCode(error, 409));
    await prisma.memoryEvent.delete({ where: { id: event.id } });
    await assert.rejects(() => prisma.$transaction(tx => requireValidMemoryKnowledgeCandidateSource(tx, candidate)), error => statusCode(error, 409));
    await prisma.$transaction(tx => requireValidMemoryKnowledgeCandidateSource(tx, { ...candidate, sourceType: "MANUAL", sourceRef: null }));
  });

  await scenario("source SHARE lock blocks edits until the knowledge read transaction ends", async fixture => {
    const event = await source(fixture);
    const editor = new Client({ connectionString: databaseUrl.toString(), connectionTimeoutMillis: 5_000 });
    await editor.connect();
    try {
      await prisma.$transaction(async tx => {
        assert(await readPublicMemoryKnowledgeSource(tx, fixture.characterId, event.id));
        await editor.query("SET lock_timeout = '250ms'");
        await assert.rejects(() => editor.query('UPDATE "memory_events" SET "title" = $2 WHERE "id" = $1', [event.id, "锁等待修改"]), error => Boolean(error && typeof error === "object" && "code" in error && error.code === "55P03"));
      });
      await editor.query('UPDATE "memory_events" SET "title" = $2 WHERE "id" = $1', [event.id, "事务结束后可修改"]);
      assert.equal((await prisma.memoryEvent.findUniqueOrThrow({ where: { id: event.id } })).title, "事务结束后可修改");
    } finally { await editor.end(); }
  });

  await scenario("deleting the character cascades its durable requests", async fixture => {
    const { result } = await request(fixture);
    await prisma.memoryScope.deleteMany({ where: { characterId: fixture.characterId } });
    assert(await prisma.memoryKnowledgeCandidateRequest.findUnique({ where: { id: result.requestId } }), "Deleting the source alone must preserve the durable request.");
    await prisma.character.delete({ where: { id: fixture.characterId } });
    assert.equal(await prisma.memoryKnowledgeCandidateRequest.findUnique({ where: { id: result.requestId } }), null);
  });
  assert.equal(modelCalls, 0, "No suite scenario may invoke a model or external HTTP service.");
  console.log("Memory knowledge event DB tests passed: durable requests, exact excerpts, privacy/source lifecycle, concurrency, rollback, replay, source locks and cascade.");
} finally {
  globalThis.fetch = originalFetch;
  await prisma.$disconnect();
}
