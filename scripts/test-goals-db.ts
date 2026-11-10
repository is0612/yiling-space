import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPrisma } from "../server/utils/prisma";
import { createGoal, updateGoal, addGoalProgress, listGoals, listGoalHistory, listGoalProgress, listGoalSources } from "../server/utils/goals";
import { parseGoalCreate, parseGoalPatch, parseGoalProgress, parseGoalListQuery } from "../server/utils/goals-domain";
import { type PreferenceSourceRef, preferenceSourceHash } from "../server/utils/preferences-domain";
import { suggestGoal } from "../server/utils/goal-suggestion";
import { encryptApiKey } from "../server/utils/credential-encryption";
const url = new URL(process.env.DATABASE_URL ?? "");
assert(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
assert(/^\/yiling_goals_test_[a-f0-9]{32}$/.test(url.pathname), "Run only through test-goals-isolated.ts.");
url.searchParams.set("options", "-c statement_timeout=10000 -c lock_timeout=5000"); process.env.DATABASE_URL = url.toString();
const prisma = getPrisma(); const originalFetch = globalThis.fetch;
globalThis.fetch = (() => { throw Error("CRUD must not call external services."); }) as typeof fetch;
const owners: string[] = [], roles: string[] = [];
function status(e: unknown, code: number) { return !!e && typeof e === "object" && "statusCode" in e && e.statusCode === code; }
const log = (s: string) => console.log(`[goals-db] ${s}`);
try {
  for (let n = 0; n < 2; n++) { const user = await prisma.user.create({ data: { username: `goals-${randomUUID()}`, passwordHash: "test-only", role: "USER" } }); owners.push(user.id); const role = await prisma.character.create({ data: { ownerId: user.id, name: "目标隔离角色", basePrompt: "unchanged-core", styleExamples: "unchanged-style" } }); roles.push(role.id); }
  const own = { ownerId: owners[0]!, characterId: roles[0]! }, foreign = { ownerId: owners[1]!, characterId: roles[1]! };
  const global = await prisma.memoryScope.create({ data: { characterId: own.characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: randomUUID() } });
  const privateScope = await prisma.memoryScope.create({ data: { characterId: own.characterId, scopeType: "USER_PRIVATE", userId: own.ownerId, scopeKey: randomUUID() } });
  const foreignScope = await prisma.memoryScope.create({ data: { characterId: foreign.characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: randomUUID() } });
  const memory = (scope = global.id) => prisma.memoryEvent.create({ data: { memoryScopeId: scope, dayKey: "2026-11-10", occurredAt: new Date(), title: "想了解星座", detail: "她明确表示想逐步了解几个常见星座。", dedupeKey: randomUUID() } });
  const data = { kind: "GOAL", title: "了解星座", description: "了解几个常见星座", reason: "手动确认的目标" };
  const create = (body: unknown) => createGoal(prisma, { ...own, body });
  const patch = (goalId: string, expectedRevision: number, operation: string, extra: Record<string, unknown> = {}) => updateGoal(prisma, { ...own, goalId, body: { expectedRevision, operation, ...extra } });
  const progress = (goalId: string, expectedRevision: number, requestKey = randomUUID(), content = "了解了第一个星座", sources?: PreferenceSourceRef[]) => addGoalProgress(prisma, { ...own, goalId, body: { expectedRevision, requestKey, content, ...(sources ? { sources } : {}) } });
  const options = (type: PreferenceSourceRef["type"] = "MEMORY_EVENT") => listGoalSources(prisma, { ...own, type, q: "", page: 1, pageSize: 50 });
  const refFor = async (id: string, type: PreferenceSourceRef["type"] = "MEMORY_EVENT") => { const row = (await options(type)).items.find(x => x.id === id); assert(row); return { type: row.type, id: row.id, hash: row.hash }; };
  const fakeRef = (row: { id: string; title: string; detail: string; occurredAt: Date }) => ({ type: "MEMORY_EVENT" as const, id: row.id, hash: preferenceSourceHash("MEMORY_EVENT", row.id, row.title, row.detail, row.occurredAt.toISOString()) });

  log("strict input and resulting version lifecycle");
  assert.throws(() => parseGoalCreate({ ...data, title: "字".repeat(101) })); assert.throws(() => parseGoalCreate({ ...data, kind: "LIKE" })); assert.throws(() => parseGoalCreate({ ...data, status: "COMPLETED" }));
  assert.throws(() => parseGoalPatch({ operation: "COMPLETE", expectedRevision: 1, title: "mixed" })); assert.throws(() => parseGoalProgress({ expectedRevision: 1, requestKey: "bad", content: "x" })); assert.throws(() => parseGoalListQuery({ pageSize: "51" }));
  const pending = (await create(data)).goal; assert.equal(pending.status, "PENDING");
  const active = (await patch(pending.id, 1, "ACTIVATE")).goal; assert.equal(active.revision, 2);
  const edited = (await patch(active.id, 2, "EDIT", { description: "先了解三个常见星座" })).goal; assert.equal(edited.revision, 3);
  await patch(active.id, 3, "EDIT", { description: edited.description }); assert.equal(await prisma.characterGoalRevision.count({ where: { goalId: active.id } }), 3);
  const paused = (await patch(active.id, 3, "PAUSE")).goal; assert.equal(paused.status, "PAUSED");
  const resumed = (await patch(active.id, 4, "ACTIVATE")).goal; const completed = (await patch(active.id, resumed.revision, "COMPLETE")).goal;
  assert.equal(completed.status, "COMPLETED");
  for (const operation of ["EDIT", "ACTIVATE", "PAUSE", "COMPLETE", "ABANDON", "REJECT"]) await assert.rejects(() => patch(active.id, completed.revision, operation, operation === "EDIT" ? { title: "不能改" } : {}), e => status(e, 409));
  assert.equal((await listGoalHistory(prisma, { ...own, goalId: active.id, page: 1, pageSize: 50 })).items[0]!.action, "COMPLETE");
  const rejected = (await create({ ...data, kind: "WISH" })).goal; await patch(rejected.id, 1, "REJECT");
  const abandoned = (await create({ ...data, status: "ACTIVE" })).goal; await patch(abandoned.id, 1, "ABANDON");

  log("source role privacy state hashes and independent accepted retention");
  const src = await memory(), priv = await memory(privateScope.id), other = await memory(foreignScope.id), archived = await memory();
  await prisma.memoryEvent.update({ where: { id: archived.id }, data: { status: "ARCHIVED" } });
  const ref = await refFor(src.id);
  assert.throws(() => parseGoalCreate({ ...data, sources: [ref], status: "ACTIVE" }));
  for (const row of [priv, other, archived]) await assert.rejects(() => create({ ...data, sources: [fakeRef(row)] }), e => status(e, 409));
  const sourced = (await create({ ...data, sources: [ref] })).goal;
  await prisma.memoryEvent.update({ where: { id: src.id }, data: { detail: "来源内容已变更" } });
  await assert.rejects(() => patch(sourced.id, 1, "ACTIVATE"), e => status(e, 409)); assert.equal(await prisma.characterGoalRevision.count({ where: { goalId: sourced.id } }), 1);
  await assert.rejects(() => create({ ...data, sources: [ref] }), e => status(e, 409));
  const live = await memory(), liveRef = await refFor(live.id); const acceptedSource = (await create({ ...data, sources: [liveRef] })).goal;
  await patch(acceptedSource.id, 1, "ACTIVATE"); await prisma.memoryEvent.delete({ where: { id: live.id } }); await patch(acceptedSource.id, 2, "PAUSE"); await patch(acceptedSource.id, 3, "ACTIVATE");
  const run = await prisma.reflectionRun.create({ data: { characterId: own.characterId, requestKey: randomUUID(), periodStart: new Date(Date.now() - 10000), periodEnd: new Date(), status: "SUCCEEDED" } });
  const refl = await prisma.reflectionSuggestion.create({ data: { runId: run.id, title: "愿望线索", observation: "明确想学", inference: "可能有持续兴趣", recommendation: "逐步了解", sourceRefs: [], status: "ACCEPTED", acceptedAt: new Date() } });
  const reflRef = await refFor(refl.id, "REFLECTION_SUGGESTION"); const reflGoal = (await create({ ...data, sources: [reflRef] })).goal; await patch(reflGoal.id, 1, "ACTIVATE"); await prisma.reflectionRun.delete({ where: { id: run.id } }); assert.equal((await prisma.characterGoal.findUniqueOrThrow({ where: { id: reflGoal.id } })).status, "ACTIVE");

  log("append-only progress idempotence including terminal replay and conflicting payload");
  const target = (await create({ ...data, status: "ACTIVE" })).goal; const key = randomUUID();
  const duplicates = await Promise.all(Array.from({ length: 4 }, () => progress(target.id, 1, key)));
  assert.equal(duplicates.filter(x => x.created).length, 1); assert.equal(await prisma.characterGoalProgress.count({ where: { goalId: target.id } }), 1);
  assert.equal(duplicates[0]!.goal.progressCount, 1); assert.equal(duplicates[0]!.goal.latestProgress?.content, "了解了第一个星座");
  assert.equal(await prisma.characterGoalRevision.count({ where: { goalId: target.id } }), 2);
  assert.equal(await prisma.auditLog.count({ where: { entityId: target.id, action: "goal.progress" } }), 1);
  await assert.rejects(() => progress(target.id, 2, key, "另一个内容"), e => status(e, 409));
  await patch(target.id, 2, "PAUSE"); const second = await progress(target.id, 3, randomUUID(), "暂缓期间整理了资料", []); assert.equal(second.goal.status, "PAUSED");
  const withSrc = await memory(), withRef = await refFor(withSrc.id); await progress(target.id, 4, randomUUID(), "增加一个公开依据", [withRef]);
  const end = (await patch(target.id, 5, "COMPLETE")).goal;
  assert.equal((await progress(target.id, end.revision, key)).created, false, "Replay must precede terminal and revision checks.");
  await assert.rejects(() => progress(target.id, end.revision), e => status(e, 409));
  const progressPage = await listGoalProgress(prisma, { ...own, goalId: target.id, page: 1, pageSize: 2 }); assert.equal(progressPage.pagination.total, 3); assert.equal(progressPage.items.length, 2); assert(!("payloadHash" in progressPage.items[0]!));
  const progressPrivate = (await create({ ...data, status: "ACTIVE" })).goal;
  await assert.rejects(() => progress(progressPrivate.id, 1, randomUUID(), "不能带私聊", [fakeRef(priv)]), e => status(e, 409)); assert.equal(await prisma.characterGoalProgress.count({ where: { goalId: progressPrivate.id } }), 0);

  log("role ownership, stale revision competition, search paging and audit rollback");
  const race = (await create({ ...data, status: "ACTIVE" })).goal;
  const results = await Promise.allSettled([patch(race.id, 1, "PAUSE"), progress(race.id, 1)]); assert.equal(results.filter(x => x.status === "fulfilled").length, 1); assert.equal(await prisma.characterGoalRevision.count({ where: { goalId: race.id } }), 2);
  await assert.rejects(() => updateGoal(prisma, { ...foreign, goalId: race.id, body: { expectedRevision: 1, operation: "PAUSE" } }), e => status(e, 404));
  await assert.rejects(() => addGoalProgress(prisma, { ownerId: foreign.ownerId, characterId: own.characterId, goalId: target.id, body: { expectedRevision: 1, requestKey: key, content: "了解了第一个星座" } }), e => status(e, 404));
  await assert.rejects(() => listGoalHistory(prisma, { ...foreign, goalId: target.id, page: 1, pageSize: 20 }), e => status(e, 404));
  const listed = await listGoals(prisma, { ...own, status: "COMPLETED", q: "星座", page: 1, pageSize: 1 }); assert.equal(listed.items.length, 1); assert(listed.pagination.total >= 2);
  assert.equal((await prisma.character.findUniqueOrThrow({ where: { id: own.characterId } })).basePrompt, "unchanged-core");
  const rollbackGoal = (await create({ ...data, status: "ACTIVE" })).goal;
  await prisma.$executeRawUnsafe(`CREATE FUNCTION goals_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."action"='goal.progress' THEN RAISE EXCEPTION 'test audit unavailable'; END IF; RETURN NEW; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER goals_test_audit_failure BEFORE INSERT ON "audit_logs" FOR EACH ROW EXECUTE FUNCTION goals_test_reject_audit()`);
  try { await assert.rejects(() => progress(rollbackGoal.id, 1)); }
  finally { await prisma.$executeRawUnsafe(`DROP TRIGGER goals_test_audit_failure ON "audit_logs"`); await prisma.$executeRawUnsafe(`DROP FUNCTION goals_test_reject_audit()`); }
  assert.equal((await prisma.characterGoal.findUniqueOrThrow({ where: { id: rollbackGoal.id } })).revision, 1);
  assert.equal(await prisma.characterGoalProgress.count({ where: { goalId: rollbackGoal.id } }), 0);
  assert.equal(await prisma.characterGoalRevision.count({ where: { goalId: rollbackGoal.id } }), 1);

  log("explicit mock model suggestions do not persist and revalidate sources after request");
  await prisma.character.update({ where: { id: own.characterId }, data: { modelConfig: { chatModel: "goals-mock", chatApiBaseUrl: "https://goals-test.example/v1", chatApiKeyEncrypted: await encryptApiKey("goals-test-key"), dailyTokenLimit: 0 } } });
  const aiSource = await memory(), aiRef = await refFor(aiSource.id); let calls = 0, mutate = false;
  const before = await prisma.characterGoal.count({ where: { characterId: own.characterId } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => { assert.equal(String(input), "https://goals-test.example/v1/chat/completions"); assert.equal(init?.redirect, "error"); const body = JSON.parse(String(init?.body)); assert.equal(body.max_tokens, 4096); assert.equal(JSON.parse(body.messages[1].content).sources.length, 1); calls++; if (mutate) await prisma.memoryEvent.update({ where: { id: aiSource.id }, data: { detail: "模型期间来源变了" } }); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) } }], usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 } }), { status: 200 }); }) as typeof fetch;
  assert.equal((await suggestGoal(prisma, { ...own, body: { sources: [aiRef] } })).suggestion?.title, data.title); mutate = true;
  await assert.rejects(() => suggestGoal(prisma, { ...own, body: { sources: [aiRef] } }), e => status(e, 409));
  await assert.rejects(() => suggestGoal(prisma, { ...own, body: { sources: [fakeRef(priv)] } }), e => status(e, 409)); assert.equal(calls, 2);
  assert.equal(await prisma.characterGoal.count({ where: { characterId: own.characterId } }), before); assert.equal(await prisma.modelUsage.count({ where: { characterId: own.characterId } }), 2);
  console.log("Goals database checks passed (only intercepted mock model calls).");
} finally {
  globalThis.fetch = originalFetch;
  await prisma.modelUsage.deleteMany({ where: { characterId: { in: roles } } }); await prisma.auditLog.deleteMany({ where: { characterId: { in: roles } } });
  await prisma.reflectionRun.deleteMany({ where: { characterId: { in: roles } } }); await prisma.memoryScope.deleteMany({ where: { characterId: { in: roles } } }); await prisma.character.deleteMany({ where: { id: { in: roles } } });
  assert.equal(await prisma.characterGoal.count({ where: { characterId: { in: roles } } }), 0); await prisma.user.deleteMany({ where: { id: { in: owners } } }); await prisma.$disconnect();
}
