import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPrisma } from "../server/utils/prisma";
import { readGrowthOverview, readGrowthOverviewDays } from "../server/utils/growth-overview";

// These guards precede client construction; this script is only run by the isolated harness.
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
assert(["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname), "Growth overview checks require a local PostgreSQL host.");
assert(/^\/yiling_reflection_test_[a-f0-9]{32}$/.test(databaseUrl.pathname), "Run through the disposable reflection database harness only.");
const prisma = getPrisma();
const now = new Date("2026-11-10T08:00:00.000Z");
const start = new Date(now.getTime() - 7 * 86_400_000);
const beforeStart = new Date(start.getTime() - 1);
const recent = new Date(now.getTime() - 1_000);
const owners: string[] = [];
const characters: string[] = [];
const identities: string[] = [];
type Role = { id: string; ownerId: string; global: string; private: string; external: string };
type TimelineEntry = { id: string; type: string; at: string };
const expectedTimeline: TimelineEntry[] = [];

function hasStatus(error: unknown, statusCode: number) {
  return error !== null && typeof error === "object" && "statusCode" in error && error.statusCode === statusCode;
}
async function makeRole(ownerId: string, label: string): Promise<Role> {
  const character = await prisma.character.create({ data: { ownerId, name: `总览测试${label}`, basePrompt: "synthetic overview fixture" } });
  characters.push(character.id);
  const identity = await prisma.externalIdentity.create({ data: { platform: "qq-onebot", platformUid: `overview-${randomUUID()}` } });
  identities.push(identity.id);
  const makeScope = (scopeType: "CHARACTER_GLOBAL" | "USER_PRIVATE" | "EXTERNAL_IDENTITY") => prisma.memoryScope.create({ data: {
    characterId: character.id, scopeType, scopeKey: randomUUID(),
    ...(scopeType === "USER_PRIVATE" ? { userId: ownerId } : {}),
    ...(scopeType === "EXTERNAL_IDENTITY" ? { externalIdentityId: identity.id } : {}),
  } });
  const global = await makeScope("CHARACTER_GLOBAL");
  const privateScope = await makeScope("USER_PRIVATE");
  const external = await makeScope("EXTERNAL_IDENTITY");
  return { id: character.id, ownerId, global: global.id, private: privateScope.id, external: external.id };
}
async function memory(role: Role, occurredAt: Date, scopeId = role.global, status: "ACTIVE" | "ARCHIVED" = "ACTIVE") {
  return prisma.memoryEvent.create({ data: { memoryScopeId: scopeId, occurredAt, dayKey: "2026-11-10", title: "测试公开经历", detail: "仅供总览聚合测试。", dedupeKey: randomUUID(), status } });
}
async function knowledge(role: Role, createdAt: Date, status = "ACTIVE") {
  return prisma.knowledgeItem.create({ data: { characterId: role.id, title: "测试正式知识", content: "synthetic knowledge", createdAt, status } });
}
async function run(role: Role) {
  return prisma.reflectionRun.create({ data: { characterId: role.id, requestKey: randomUUID(), periodStart: beforeStart, periodEnd: now, status: "SUCCEEDED" } });
}
async function suggestion(runId: string, status: "PENDING" | "DEFERRED" | "ACCEPTED" | "REJECTED", acceptedAt: Date | null, createdAt = beforeStart) {
  return prisma.reflectionSuggestion.create({ data: { runId, status, acceptedAt, createdAt, title: "测试成长结论", observation: "观察", inference: "推断", recommendation: "建议", sourceRefs: [] } });
}
async function assessment(role: Role, status: "RUNNING" | "SUCCEEDED" | "FAILED", reviewStatus: "PENDING" | "DEFERRED" | "ACCEPTED" | "REJECTED" | "NOT_REQUIRED", scopeId = role.external) {
  return prisma.socialRelationshipAssessment.create({ data: { scopeId, generation: 1, evaluatedStage: "STRANGER", evaluatedStatus: "UNOBSERVED", relationshipVersion: 0, status, reviewStatus, createdAt: beforeStart } });
}
async function change(role: Role, createdAt: Date, scopeId = role.external) {
  return prisma.socialRelationChange.create({ data: { scopeId, fromStage: "ACQUAINTANCE", toStage: "FRIEND", reason: "测试关系变化", idempotencyKey: randomUUID(), createdAt } });
}
async function snapshot(role: Role, createdAt: Date, scopeId = role.global, status: "CURRENT" | "SUPERSEDED" = "CURRENT") {
  return prisma.memorySnapshot.create({ data: { memoryScopeId: scopeId, snapshotKey: randomUUID(), periodStart: beforeStart, periodEnd: start, summary: "synthetic summary", structuredContent: {}, createdAt, status } });
}
async function delivery(role: Role, status: "FAILED" | "RUNNING" | "QUEUED" | "RETRY_WAIT" | "SUCCEEDED", runAt = now, leaseExpiresAt: Date | null = null) {
  const event = await prisma.growthEvent.create({ data: { characterId: role.id, sourceDomain: "memory", eventType: "memory.event.created", aggregateType: "MemoryEvent", aggregateId: randomUUID(), occurredAt: beforeStart, idempotencyKey: randomUUID() } });
  return prisma.growthEventDelivery.create({ data: { eventId: event.id, consumerKey: "growth.memory-source-integrity", status, runAt, leaseExpiresAt } });
}
const recordTimeline = (row: { id: string }, type: string, at: Date) => expectedTimeline.push({ id: row.id, type, at: at.toISOString() });

try {
  console.log("\n[growth-overview] strict time-range parser");
  assert.equal(readGrowthOverviewDays(undefined), 7);
  for (const days of ["7", "14", "30"]) assert.equal(readGrowthOverviewDays(days), Number(days));
  for (const invalid of [null, "", "0", "8", "31", " 7", "7 ", 7, ["7"], ["7", "14"], {}, true]) {
    assert.throws(() => readGrowthOverviewDays(invalid), error => hasStatus(error, 400));
  }
  for (let index = 0; index < 2; index++) {
    const owner = await prisma.user.create({ data: { username: `growth-overview-${randomUUID()}`, passwordHash: "test-only", role: "USER", status: "ACTIVE" } });
    owners.push(owner.id);
  }
  const roleA = await makeRole(owners[0]!, "A");
  const roleB = await makeRole(owners[0]!, "B");
  const foreign = await makeRole(owners[1]!, "外部");
  const empty = await makeRole(owners[0]!, "空");
  const input = { ownerId: roleA.ownerId, characterId: roleA.id, days: 7 as const, now };

  console.log("\n[growth-overview] inclusive start/exclusive end and scope/status filtering");
  await memory(roleA, start); await memory(roleA, recent);
  await memory(roleA, beforeStart); await memory(roleA, now);
  await memory(roleA, recent, roleA.private); await memory(roleA, recent, roleA.external); await memory(roleA, recent, roleA.global, "ARCHIVED");
  const kStart = await knowledge(roleA, start); recordTimeline(kStart, "knowledge", start);
  const kRecent = await knowledge(roleA, recent); recordTimeline(kRecent, "knowledge", recent);
  await knowledge(roleA, beforeStart); await knowledge(roleA, now); await knowledge(roleA, recent, "ARCHIVED");
  const runA = await run(roleA);
  const accepted = [];
  for (const at of [start, new Date(now.getTime() - 2_000), recent]) {
    const row = await suggestion(runA.id, "ACCEPTED", at); accepted.push(row); recordTimeline(row, "reflection", at);
  }
  await suggestion(runA.id, "ACCEPTED", beforeStart); await suggestion(runA.id, "ACCEPTED", now);
  await suggestion(runA.id, "PENDING", recent); await suggestion(runA.id, "DEFERRED", null);
  await suggestion(runA.id, "REJECTED", recent);
  // Pending work is intentionally counted over all time, independently of the overview range.
  for (const state of ["PENDING", "REVIEW", "FAILED", "PROCESSING", "ACCEPTED", "DISMISSED"]) {
    await prisma.knowledgeCandidate.create({ data: { characterId: roleA.id, rawContent: "synthetic candidate", status: state, createdAt: beforeStart } });
  }
  await assessment(roleA, "SUCCEEDED", "PENDING"); await assessment(roleA, "SUCCEEDED", "DEFERRED");
  await assessment(roleA, "RUNNING", "PENDING"); await assessment(roleA, "FAILED", "PENDING");
  await assessment(roleA, "SUCCEEDED", "ACCEPTED"); await assessment(roleA, "SUCCEEDED", "REJECTED");
  await assessment(roleA, "SUCCEEDED", "NOT_REQUIRED"); await assessment(roleA, "SUCCEEDED", "PENDING", roleA.global);
  const cStart = await change(roleA, start); recordTimeline(cStart, "relationship", start);
  const cRecent = await change(roleA, recent); recordTimeline(cRecent, "relationship", recent);
  await change(roleA, beforeStart); await change(roleA, now); await change(roleA, recent, roleA.private);
  const sStart = await snapshot(roleA, start); recordTimeline(sStart, "snapshot", start);
  const sRecent = await snapshot(roleA, recent); recordTimeline(sRecent, "snapshot", recent);
  await snapshot(roleA, beforeStart); await snapshot(roleA, now); await snapshot(roleA, recent, roleA.private);
  await snapshot(roleA, recent, roleA.external); await snapshot(roleA, recent, roleA.global, "SUPERSEDED");

  console.log("\n[growth-overview] delivery status and current runnable time");
  await delivery(roleA, "FAILED");
  await delivery(roleA, "RUNNING", now, new Date(now.getTime() - 1));
  await delivery(roleA, "RUNNING", now, now); await delivery(roleA, "RUNNING", now, null);
  await delivery(roleA, "RUNNING", now, new Date(now.getTime() + 1));
  await delivery(roleA, "QUEUED", beforeStart); await delivery(roleA, "RETRY_WAIT", now);
  await delivery(roleA, "QUEUED", new Date(now.getTime() + 1)); await delivery(roleA, "RETRY_WAIT", new Date(now.getTime() + 60_000));
  await delivery(roleA, "SUCCEEDED");

  console.log("\n[growth-overview] same-owner other role and foreign-owner fixtures never leak");
  for (const role of [roleB, foreign]) {
    await memory(role, recent); await knowledge(role, recent);
    const otherRun = await run(role);
    await suggestion(otherRun.id, "ACCEPTED", recent); await suggestion(otherRun.id, "PENDING", null);
    await prisma.knowledgeCandidate.create({ data: { characterId: role.id, rawContent: "OTHER_ROLE_MUST_NOT_LEAK", status: "PENDING" } });
    await assessment(role, "SUCCEEDED", "PENDING"); await change(role, recent); await snapshot(role, recent);
    await delivery(role, "FAILED"); await delivery(role, "RUNNING", now, null); await delivery(role, "QUEUED", recent);
  }
  const countsBefore = {
    usage: await prisma.modelUsage.count(), audit: await prisma.auditLog.count(), events: await prisma.growthEvent.count(),
    candidates: await prisma.knowledgeCandidate.count(), runs: await prisma.reflectionRun.count(), suggestions: await prisma.reflectionSuggestion.count(),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("Overview must not call a model or external endpoint."); }) as typeof fetch;
  let overview: Awaited<ReturnType<typeof readGrowthOverview>>;
  try { overview = await readGrowthOverview(prisma, input); }
  finally { globalThis.fetch = originalFetch; }
  assert.deepEqual(overview.character, { id: roleA.id, name: "总览测试A" });
  assert.deepEqual(overview.period, { days: 7, start: start.toISOString(), end: now.toISOString() });
  assert.equal(overview.generatedAt, now.toISOString());
  assert.deepEqual(overview.stats, { memories: 2, knowledge: 2, relationships: 2, conclusions: 3 });
  assert.deepEqual(overview.pending, { reflections: 2, knowledge: 3, relationships: 2 });
  assert.deepEqual(overview.delivery, { failed: 1, stuck: 3, ready: 2 });
  assert.deepEqual(overview.conclusions.map(row => row.id), [accepted[2]!.id, accepted[1]!.id]);
  assert(overview.conclusions.every(row => row.acceptedAt >= start.toISOString() && row.acceptedAt < now.toISOString()));
  const sortedTimeline = expectedTimeline.sort((left, right) => right.at.localeCompare(left.at) || right.id.localeCompare(left.id)).slice(0, 8);
  assert.equal(overview.timeline.length, 8);
  assert.deepEqual(overview.timeline.map(({ id, type, at }) => ({ id, type, at })), sortedTimeline,
    "The merged timeline must sort by timestamp then ID descending before applying its global limit.");
  for (const row of overview.timeline) {
    const link = new URL(row.href, "https://overview-test.example");
    assert.equal(link.searchParams.get("c"), roleA.id);
    assert(["/growth/reflection", "/growth/knowledge", "/growth/social/assessments", "/growth/memory/snapshots"].includes(link.pathname));
  }
  assert.deepEqual(await readGrowthOverview(prisma, input), overview, "Repeated reads keep deterministic ordering, including timestamp ties.");
  const countsAfter = {
    usage: await prisma.modelUsage.count(), audit: await prisma.auditLog.count(), events: await prisma.growthEvent.count(),
    candidates: await prisma.knowledgeCandidate.count(), runs: await prisma.reflectionRun.count(), suggestions: await prisma.reflectionSuggestion.count(),
  };
  assert.deepEqual(countsAfter, countsBefore, "Aggregation must neither call models nor write derived rows or audit entries.");

  console.log("\n[growth-overview] empty role returns honest zero counts and empty collections; unauthorized requests return 404");
  const emptyResult = await readGrowthOverview(prisma, { ...input, characterId: empty.id });
  assert.deepEqual(emptyResult.stats, { memories: 0, knowledge: 0, relationships: 0, conclusions: 0 });
  assert.deepEqual(emptyResult.pending, { reflections: 0, knowledge: 0, relationships: 0 });
  assert.deepEqual(emptyResult.delivery, { failed: 0, stuck: 0, ready: 0 });
  assert.deepEqual(emptyResult.conclusions, []); assert.deepEqual(emptyResult.timeline, []);
  await assert.rejects(() => readGrowthOverview(prisma, { ...input, ownerId: foreign.ownerId }), error => hasStatus(error, 404));
  await assert.rejects(() => readGrowthOverview(prisma, { ...input, characterId: foreign.id }), error => hasStatus(error, 404));
  await assert.rejects(() => readGrowthOverview(prisma, { ...input, characterId: randomUUID() }), error => hasStatus(error, 404));
  const b = await readGrowthOverview(prisma, { ...input, characterId: roleB.id });
  assert.deepEqual(b.stats, { memories: 1, knowledge: 1, relationships: 1, conclusions: 1 });
  assert.deepEqual(b.pending, { reflections: 1, knowledge: 1, relationships: 1 });
  assert.deepEqual(b.delivery, { failed: 1, stuck: 1, ready: 1 });
  console.log("Growth overview DB checks passed: period boundaries, role/owner isolation, pending semantics, bounded stable timeline, conclusions, deliveries, empty data and read-only aggregation.");
} finally {
  await prisma.auditLog.deleteMany({ where: { characterId: { in: characters } } });
  await prisma.modelUsage.deleteMany({ where: { characterId: { in: characters } } });
  await prisma.memoryScope.deleteMany({ where: { characterId: { in: characters } } });
  await prisma.character.deleteMany({ where: { id: { in: characters } } });
  await prisma.externalIdentity.deleteMany({ where: { id: { in: identities } } });
  await prisma.user.deleteMany({ where: { id: { in: owners } } });
  await prisma.$disconnect();
}
