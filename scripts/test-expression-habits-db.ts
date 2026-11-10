import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPrisma } from "../server/utils/prisma";
import { createExpressionHabit, updateExpressionHabit, listExpressionHabits, listExpressionHabitHistory, listExpressionHabitSources } from "../server/utils/expression-habits";
import { parseExpressionHabitCreate, parseExpressionHabitPatch, parseExpressionHabitListQuery } from "../server/utils/expression-habits-domain";
import { preferenceSourceHash, type PreferenceSourceRef } from "../server/utils/preferences-domain";
import { suggestExpressionHabit } from "../server/utils/expression-habit-suggestion";
import { encryptApiKey } from "../server/utils/credential-encryption";

const url = new URL(process.env.DATABASE_URL ?? "");
assert(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
assert(/^\/yiling_expression_habits_test_[a-f0-9]{32}$/.test(url.pathname), "Run only through test-expression-habits-isolated.ts.");
url.searchParams.set("options", "-c statement_timeout=10000 -c lock_timeout=5000");
process.env.DATABASE_URL = url.toString();
const prisma = getPrisma();
const originalFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("Habit CRUD must not call external services."); }) as typeof fetch;
const owners: string[] = []; const roles: string[] = [];
function httpStatus(error: unknown, expected: number) { return !!error && typeof error === "object" && "statusCode" in error && error.statusCode === expected; }
const log = (label: string) => console.log(`[expression-habits-db] ${label}`);
try {
  for (let n = 0; n < 2; n++) {
    const user = await prisma.user.create({ data: { username: `expression-${randomUUID()}`, passwordHash: "isolated-test-only", role: "USER" } }); owners.push(user.id);
    const character = await prisma.character.create({ data: { ownerId: user.id, name: "表达习惯隔离角色", basePrompt: "unchanged-core", styleExamples: "unchanged-style" } }); roles.push(character.id);
  }
  const ownerId = owners[0]!; const characterId = roles[0]!; const own = { ownerId, characterId };
  const global = await prisma.memoryScope.create({ data: { characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: randomUUID() } });
  const privateScope = await prisma.memoryScope.create({ data: { characterId, scopeType: "USER_PRIVATE", userId: ownerId, scopeKey: randomUUID() } });
  const foreignScope = await prisma.memoryScope.create({ data: { characterId: roles[1]!, scopeType: "CHARACTER_GLOBAL", scopeKey: randomUUID() } });
  const memory = async (scope = global.id) => prisma.memoryEvent.create({ data: { memoryScopeId: scope, dayKey: "2026-11-10", occurredAt: new Date(), title: "解释更清楚", detail: "她在解释复杂概念时先给一句简明结论，再补具体例子。", dedupeKey: randomUUID() } });
  const options = (type: PreferenceSourceRef["type"] = "MEMORY_EVENT") => listExpressionHabitSources(prisma, { ...own, type, q: "", page: 1, pageSize: 50 });
  const refFor = async (id: string, type: PreferenceSourceRef["type"] = "MEMORY_EVENT") => {
    const row = (await options(type)).items.find(item => item.id === id); assert(row);
    return { type: row.type, id: row.id, hash: row.hash };
  };
  const create = (body: unknown) => createExpressionHabit(prisma, { ...own, body });
  const patch = (habitId: string, expectedRevision: number, operation: string, extra: Record<string, unknown> = {}) => updateExpressionHabit(prisma, { ...own, habitId, body: { expectedRevision, operation, ...extra } });
  const data = { kind: "TONE", content: "先给简明结论，再补具体例子", reason: "希望解释更清楚" };

  log("strict input boundaries and independent domain storage");
  assert.throws(() => parseExpressionHabitCreate({ ...data, phrase: "逐字台词" }));
  assert.throws(() => parseExpressionHabitCreate({ ...data, kind: "LIKE" }));
  assert.throws(() => parseExpressionHabitCreate({ ...data, content: "字".repeat(301) }));
  assert.throws(() => parseExpressionHabitCreate({ ...data, context: "字".repeat(201) }));
  assert.throws(() => parseExpressionHabitPatch({ expectedRevision: 1, operation: "ACTIVATE", content: "混入编辑" }));
  assert.throws(() => parseExpressionHabitListQuery({ pageSize: "51" }));
  const first = (await create({ ...data, status: "ACTIVE" })).habit;
  assert.equal(first.context, ""); assert.equal(first.status, "ACTIVE"); assert.equal(first.revision, 1);
  assert.equal(await prisma.characterCatchphrase.count({ where: { characterId } }), 0);
  assert.equal(await prisma.characterPreference.count({ where: { characterId } }), 0);
  const role = await prisma.character.findUniqueOrThrow({ where: { id: characterId } });
  assert.equal(role.basePrompt, "unchanged-core"); assert.equal(role.styleExamples, "unchanged-style");

  log("resulting snapshots, no-op edit, explicit state transitions and audit transaction");
  const edited = (await patch(first.id, 1, "EDIT", { context: "解释问题", reason: "先结论便于理解" })).habit;
  assert.equal(edited.revision, 2); assert.equal(edited.status, "ACTIVE");
  await patch(first.id, 2, "EDIT", { context: "解释问题", reason: edited.reason });
  assert.equal(await prisma.characterExpressionHabitRevision.count({ where: { habitId: first.id } }), 2);
  const history = await listExpressionHabitHistory(prisma, { ...own, habitId: first.id, page: 1, pageSize: 20 });
  assert.deepEqual(history.items.map(row => [row.revision, row.action]), [[2, "EDIT"], [1, "CREATE"]]);
  assert.equal(history.items[1]!.context, "");
  assert.equal(await prisma.auditLog.count({ where: { entityId: first.id, action: { startsWith: "expression_habit." } } }), 2);
  const pending = (await create({ ...data, kind: "WORDING", content: "优先使用具体易懂的词" })).habit;
  assert.equal(pending.status, "PENDING");
  await patch(pending.id, 1, "EDIT", { context: "技术解释" });
  assert.equal((await prisma.characterExpressionHabit.findUniqueOrThrow({ where: { id: pending.id } })).status, "PENDING");
  await patch(pending.id, 2, "REJECT");
  await assert.rejects(() => patch(pending.id, 3, "ACTIVATE"), error => httpStatus(error, 409));

  log("public source scope, stale selection and first acceptance validation");
  const event = await memory(); const privateEvent = await memory(privateScope.id); const foreignEvent = await memory(foreignScope.id);
  const archived = await memory(); await prisma.memoryEvent.update({ where: { id: archived.id }, data: { status: "ARCHIVED" } });
  const sourceRows = await options();
  assert(sourceRows.items.some(row => row.id === event.id));
  for (const id of [privateEvent.id, foreignEvent.id, archived.id]) assert(!sourceRows.items.some(row => row.id === id));
  const fakeRef = (row: typeof event): PreferenceSourceRef => ({ type: "MEMORY_EVENT", id: row.id, hash: preferenceSourceHash("MEMORY_EVENT", row.id, row.title, row.detail, row.occurredAt.toISOString()) });
  for (const row of [privateEvent, foreignEvent, archived]) await assert.rejects(() => create({ ...data, sources: [fakeRef(row)] }), error => httpStatus(error, 409));
  const selected = await refFor(event.id);
  await assert.rejects(() => create({ ...data, sources: [selected], status: "ACTIVE" }), error => httpStatus(error, 400));
  const candidate = (await create({ ...data, sources: [selected] })).habit;
  await prisma.memoryEvent.update({ where: { id: event.id }, data: { detail: "来源已修改" } });
  await assert.rejects(() => create({ ...data, sources: [selected] }), error => httpStatus(error, 409));
  await assert.rejects(() => patch(candidate.id, 1, "ACTIVATE"), error => httpStatus(error, 409));
  assert.equal((await prisma.characterExpressionHabit.findUniqueOrThrow({ where: { id: candidate.id } })).revision, 1);
  assert.equal(await prisma.characterExpressionHabitRevision.count({ where: { habitId: candidate.id } }), 1);
  const retainedEvent = await memory();
  const retained = (await create({ ...data, sources: [await refFor(retainedEvent.id)] })).habit;
  await patch(retained.id, 1, "ACTIVATE"); await prisma.memoryEvent.delete({ where: { id: retainedEvent.id } });
  await patch(retained.id, 2, "DISABLE"); await patch(retained.id, 3, "ACTIVATE");
  assert.equal((await prisma.characterExpressionHabit.findUniqueOrThrow({ where: { id: retained.id } })).revision, 4);

  log("accepted reflections only and independent retention after source deletion");
  const run = await prisma.reflectionRun.create({ data: { characterId, requestKey: randomUUID(), periodStart: new Date(Date.now() - 86400000), periodEnd: new Date(), status: "SUCCEEDED" } });
  const reflection = await prisma.reflectionSuggestion.create({ data: { runId: run.id, title: "说清楚", observation: "观察", inference: "推断", recommendation: "先简后详", sourceRefs: [], status: "PENDING" } });
  assert(!(await options("REFLECTION_SUGGESTION")).items.some(row => row.id === reflection.id));
  const reflectionRef: PreferenceSourceRef = { type: "REFLECTION_SUGGESTION", id: reflection.id, hash: preferenceSourceHash("REFLECTION_SUGGESTION", reflection.id, reflection.title, JSON.stringify([reflection.observation, reflection.inference, reflection.recommendation]), reflection.sourceRefs) };
  await assert.rejects(() => create({ ...data, sources: [reflectionRef] }), error => httpStatus(error, 409));
  await prisma.reflectionSuggestion.update({ where: { id: reflection.id }, data: { status: "ACCEPTED", acceptedAt: new Date() } });
  const fromReflection = (await create({ ...data, sources: [await refFor(reflection.id, "REFLECTION_SUGGESTION")] })).habit;
  await patch(fromReflection.id, 1, "ACTIVATE"); await prisma.reflectionRun.delete({ where: { id: run.id } });
  assert.equal((await prisma.characterExpressionHabit.findUniqueOrThrow({ where: { id: fromReflection.id } })).status, "ACTIVE");

  log("owner isolation and concurrent stale revision loser has no history or audit");
  for (const input of [{ ownerId: owners[1]!, characterId }, { ownerId, characterId: roles[1]! }]) {
    await assert.rejects(() => listExpressionHabits(prisma, { ...input, status: "ALL", q: "", page: 1, pageSize: 20 }), error => httpStatus(error, 404));
    await assert.rejects(() => createExpressionHabit(prisma, { ...input, body: data }), error => httpStatus(error, 404));
    await assert.rejects(() => updateExpressionHabit(prisma, { ...input, habitId: first.id, body: { expectedRevision: 2, operation: "DISABLE" } }), error => httpStatus(error, 404));
    await assert.rejects(() => listExpressionHabitHistory(prisma, { ...input, habitId: first.id, page: 1, pageSize: 20 }), error => httpStatus(error, 404));
  }
  const auditBefore = await prisma.auditLog.count({ where: { entityId: first.id } });
  const races = await Promise.allSettled([patch(first.id, 2, "EDIT", { context: "并发甲" }), patch(first.id, 2, "EDIT", { context: "并发乙" })]);
  assert.equal(races.filter(row => row.status === "fulfilled").length, 1);
  assert.equal(races.filter(row => row.status === "rejected" && httpStatus(row.reason, 409)).length, 1);
  assert.equal(await prisma.characterExpressionHabitRevision.count({ where: { habitId: first.id } }), 3);
  assert.equal(await prisma.auditLog.count({ where: { entityId: first.id } }), auditBefore + 1);

  log("status search and stable pagination");
  for (let n = 0; n < 4; n++) await create({ ...data, kind: "LENGTH", content: `分页表达${n}`, context: "特定场景", status: "ACTIVE" });
  const page1 = await listExpressionHabits(prisma, { ...own, status: "ACTIVE", q: "分页表达", page: 1, pageSize: 2 });
  const page2 = await listExpressionHabits(prisma, { ...own, status: "ACTIVE", q: "分页表达", page: 2, pageSize: 2 });
  assert.equal(page1.pagination.total, 4); assert.equal(page1.items.length, 2); assert.equal(page2.items.length, 2);
  assert.equal(new Set([...page1.items, ...page2.items].map(row => row.id)).size, 4);
  assert.equal((await listExpressionHabits(prisma, { ...own, status: "PENDING", q: "分页表达", page: 1, pageSize: 2 })).items.length, 0);
  assert.equal((await listExpressionHabits(prisma, { ...own, status: "ACTIVE", q: "特定场景", page: 1, pageSize: 20 })).items.length, 4);
  assert.equal((await listExpressionHabitHistory(prisma, { ...own, habitId: retained.id, page: 2, pageSize: 2 })).items.length, 2);
  assert.equal(await prisma.modelUsage.count({ where: { characterId } }), 0);

  log("model suggestion is draft only, revalidates changed evidence and meters calls");
  await prisma.character.update({ where: { id: characterId }, data: { modelConfig: { chatModel: "expression-test", chatApiBaseUrl: "https://expression-test.example/v1", chatApiKeyEncrypted: await encryptApiKey("expression-isolated-key"), dailyTokenLimit: 0 } } });
  const aiEvent = await memory(); const aiRef = await refFor(aiEvent.id);
  const beforeCount = await prisma.characterExpressionHabit.count({ where: { characterId } });
  let calls = 0; let mutate = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "https://expression-test.example/v1/chat/completions");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer expression-isolated-key");
    assert.equal(init?.redirect, "error"); assert(init?.signal);
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }>; max_tokens: number };
    assert.equal(body.max_tokens, 4096);
    assert.deepEqual(JSON.parse(body.messages.find(row => row.role === "user")!.content).sources, [{ title: aiEvent.title, summary: aiEvent.detail.slice(0, 600) }]);
    calls++; if (mutate) await prisma.memoryEvent.update({ where: { id: aiEvent.id }, data: { detail: "模型请求期间来源变化" } });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: "LENGTH", content: "解释时先简短作答", context: "解释问题", reason: "公开经历支持尝试先简后详" }) } }], usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 } }), { status: 200 });
  }) as typeof fetch;
  const suggested = await suggestExpressionHabit(prisma, { ...own, body: { sources: [aiRef] } });
  assert.equal(suggested.suggestion?.kind, "LENGTH"); assert.equal(calls, 1);
  assert.equal(await prisma.characterExpressionHabit.count({ where: { characterId } }), beforeCount);
  mutate = true;
  await assert.rejects(() => suggestExpressionHabit(prisma, { ...own, body: { sources: [aiRef] } }), error => httpStatus(error, 409));
  for (const row of [privateEvent, foreignEvent]) await assert.rejects(() => suggestExpressionHabit(prisma, { ...own, body: { sources: [fakeRef(row)] } }), error => httpStatus(error, 409));
  assert.equal(calls, 2); assert.equal(await prisma.modelUsage.count({ where: { characterId } }), 2);
  assert.equal(await prisma.characterExpressionHabit.count({ where: { characterId } }), beforeCount);
  console.log("Expression habit database assertions passed (only intercepted model calls).");
} finally {
  globalThis.fetch = originalFetch;
  await prisma.modelUsage.deleteMany({ where: { characterId: { in: roles } } });
  await prisma.auditLog.deleteMany({ where: { characterId: { in: roles } } });
  await prisma.reflectionRun.deleteMany({ where: { characterId: { in: roles } } });
  await prisma.memoryScope.deleteMany({ where: { characterId: { in: roles } } });
  await prisma.character.deleteMany({ where: { id: { in: roles } } });
  assert.equal(await prisma.characterExpressionHabit.count({ where: { characterId: { in: roles } } }), 0);
  assert.equal(await prisma.characterExpressionHabitRevision.count({ where: { habit: { characterId: { in: roles } } } }), 0);
  await prisma.user.deleteMany({ where: { id: { in: owners } } });
  await prisma.$disconnect();
}
