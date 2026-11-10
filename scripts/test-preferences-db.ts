import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPrisma } from "../server/utils/prisma";
import { createPreference, updatePreference, listPreferences, listPreferenceHistory } from "../server/utils/preferences";
import { listPreferenceSources } from "../server/utils/preferences-sources";
import { preferenceSourceHash, type PreferenceSourceRef } from "../server/utils/preferences-domain";
import { suggestPreference } from "../server/utils/preference-suggestion";
import { encryptApiKey } from "../server/utils/credential-encryption";
import { loadPreferencesForPrompt } from "../server/utils/preference-retrieval";

const url = new URL(process.env.DATABASE_URL ?? "");
assert(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
assert(/^\/yiling_preferences_test_[a-f0-9]{32}$/.test(url.pathname), "Run only through test-preferences-isolated.ts.");
url.searchParams.set("options", "-c statement_timeout=10000 -c lock_timeout=5000");
process.env.DATABASE_URL = url.toString();
const prisma = getPrisma();
const originalFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("Basic preferences must not call any model or external service."); }) as typeof fetch;
const owners: string[] = []; const roles: string[] = [];
function httpStatus(error: unknown, expected: number) { return !!error && typeof error === "object" && "statusCode" in error && error.statusCode === expected; }
const logged = (label: string) => console.log(`[preferences-db] ${label}`);
try {
  for (let n = 0; n < 2; n++) {
    const user = await prisma.user.create({ data: { username: `preference-${randomUUID()}`, passwordHash: "isolated-test-only", role: "USER" } }); owners.push(user.id);
    const role = await prisma.character.create({ data: { ownerId: user.id, name: "偏好隔离角色", basePrompt: "unchanged-core" } }); roles.push(role.id);
  }
  const ownerId = owners[0]!; const characterId = roles[0]!;
  const own = { ownerId, characterId };
  const global = await prisma.memoryScope.create({ data: { characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: randomUUID() } });
  const privateScope = await prisma.memoryScope.create({ data: { characterId, scopeType: "USER_PRIVATE", userId: ownerId, scopeKey: randomUUID() } });
  const foreignScope = await prisma.memoryScope.create({ data: { characterId: roles[1]!, scopeType: "CHARACTER_GLOBAL", scopeKey: randomUUID() } });
  const memory = async (scope = global.id, detail = "一起观察星空并核对星图。") => prisma.memoryEvent.create({ data: { memoryScopeId: scope, dayKey: "2026-11-10", occurredAt: new Date(), title: "观察星空", detail, dedupeKey: randomUUID() } });
  const sourceOptions = (type: PreferenceSourceRef["type"] = "MEMORY_EVENT") => listPreferenceSources(prisma, { ...own, type, q: "", page: 1, pageSize: 50 });
  const refFor = async (id: string, type: PreferenceSourceRef["type"] = "MEMORY_EVENT") => {
    const row = (await sourceOptions(type)).items.find(item => item.id === id); assert(row);
    return { type: row.type, id: row.id, hash: row.hash };
  };
  const create = (body: unknown) => createPreference(prisma, { ...own, body });
  const patch = (preferenceId: string, expectedRevision: number, operation: string, extra: Record<string, unknown> = {}) => updatePreference(prisma, { ...own, preferenceId, body: { expectedRevision, operation, ...extra } });

  logged("manual creation, revision snapshots, audit and explicit state transitions");
  const first = (await create({ kind: "LIKE", topic: "星空", reason: "觉得观测过程很有趣", status: "ACTIVE" })).preference;
  assert.equal(first.status, "ACTIVE"); assert.equal(first.revision, 1); assert.equal(first.sourceType, "MANUAL");
  const edited = (await patch(first.id, 1, "EDIT", { reason: "喜欢一起核对星图" })).preference;
  assert.equal(edited.revision, 2); assert.equal(edited.status, "ACTIVE");
  const history = await listPreferenceHistory(prisma, { ...own, preferenceId: first.id, page: 1, pageSize: 20 });
  assert.deepEqual(history.items.map(row => [row.revision, row.action]), [[2, "EDIT"], [1, "CREATE"]]);
  assert.equal(history.items[1]!.reason, "觉得观测过程很有趣");
  assert.equal(await prisma.auditLog.count({ where: { entityId: first.id, action: { startsWith: "preference." } } }), 2);
  await patch(first.id, 2, "EDIT", { reason: edited.reason });
  assert.equal(await prisma.characterPreferenceRevision.count({ where: { preferenceId: first.id } }), 2);
  await assert.rejects(() => patch(first.id, 2, "REJECT"), error => httpStatus(error, 409));
  const pending = (await create({ kind: "INTEREST", topic: "手工", reason: "愿意继续尝试" })).preference;
  const pendingEdited = (await patch(pending.id, 1, "EDIT", { topic: "纸艺" })).preference;
  assert.equal(pendingEdited.status, "PENDING");
  await patch(pending.id, 2, "REJECT");
  await assert.rejects(() => patch(pending.id, 3, "ACTIVATE"), error => httpStatus(error, 409));

  logged("source options reject private/cross-role/archived references and stale selection");
  const publicEvent = await memory(); const privateEvent = await memory(privateScope.id); const foreignEvent = await memory(foreignScope.id);
  const archived = await memory(); await prisma.memoryEvent.update({ where: { id: archived.id }, data: { status: "ARCHIVED" } });
  const options = await sourceOptions();
  assert(options.items.some(row => row.id === publicEvent.id));
  for (const id of [privateEvent.id, foreignEvent.id, archived.id]) assert(!options.items.some(row => row.id === id));
  const fakeRef = (row: typeof privateEvent): PreferenceSourceRef => ({ type: "MEMORY_EVENT", id: row.id, hash: preferenceSourceHash("MEMORY_EVENT", row.id, row.title, row.detail, row.occurredAt.toISOString()) });
  for (const event of [privateEvent, foreignEvent, archived]) await assert.rejects(() => create({ kind: "LIKE", topic: "秘密", reason: "不得使用", sources: [fakeRef(event)] }), error => httpStatus(error, 409));
  const selected = await refFor(publicEvent.id);
  await assert.rejects(() => create({ kind: "LIKE", topic: "星空", reason: "候选必须确认", status: "ACTIVE", sources: [selected] }), error => httpStatus(error, 400));
  await prisma.memoryEvent.update({ where: { id: publicEvent.id }, data: { detail: "更新后的观察结果" } });
  const before = await prisma.characterPreference.count({ where: { characterId } });
  await assert.rejects(() => create({ kind: "LIKE", topic: "星空", reason: "过期选择", sources: [selected] }), error => httpStatus(error, 409));
  assert.equal(await prisma.characterPreference.count({ where: { characterId } }), before);

  logged("pending accept revalidates source hash; accepted preferences survive deleted evidence");
  const event = await memory(); const source = await refFor(event.id);
  const candidate = (await create({ kind: "INTEREST", topic: "观星", reason: "这次经历带来兴趣", sources: [source] })).preference;
  assert.equal(candidate.status, "PENDING"); assert.equal(candidate.sourceType, "SOURCES");
  await prisma.memoryEvent.update({ where: { id: event.id }, data: { title: "变化后的经历" } });
  await assert.rejects(() => patch(candidate.id, 1, "ACTIVATE"), error => httpStatus(error, 409));
  assert.equal((await prisma.characterPreference.findUniqueOrThrow({ where: { id: candidate.id } })).revision, 1);
  assert.equal(await prisma.characterPreferenceRevision.count({ where: { preferenceId: candidate.id } }), 1);
  const retainedEvent = await memory(); const retainedSource = await refFor(retainedEvent.id);
  const retained = (await create({ kind: "LIKE", topic: "共同探索", reason: "共同探索令人开心", sources: [retainedSource] })).preference;
  await patch(retained.id, 1, "ACTIVATE");
  await prisma.memoryEvent.delete({ where: { id: retainedEvent.id } });
  assert.equal((await prisma.characterPreference.findUniqueOrThrow({ where: { id: retained.id } })).status, "ACTIVE");
  await patch(retained.id, 2, "DISABLE"); await patch(retained.id, 3, "ACTIVATE");
  assert.equal((await prisma.characterPreference.findUniqueOrThrow({ where: { id: retained.id } })).revision, 4);

  logged("accepted reflection only; source deletion retains accepted preference");
  const run = await prisma.reflectionRun.create({ data: { characterId, requestKey: randomUUID(), periodStart: new Date(Date.now() - 86400000), periodEnd: new Date(), status: "SUCCEEDED" } });
  const reflection = await prisma.reflectionSuggestion.create({ data: { runId: run.id, title: "保持求知", observation: "观察", inference: "推断", recommendation: "继续探索", sourceRefs: [], status: "PENDING" } });
  assert(!(await sourceOptions("REFLECTION_SUGGESTION")).items.some(row => row.id === reflection.id));
  const unacceptedRef: PreferenceSourceRef = { type: "REFLECTION_SUGGESTION", id: reflection.id, hash: preferenceSourceHash("REFLECTION_SUGGESTION", reflection.id, reflection.title, JSON.stringify([reflection.observation, reflection.inference, reflection.recommendation]), reflection.sourceRefs) };
  await assert.rejects(() => create({ kind: "INTEREST", topic: "不得偷采纳", reason: "尚未确认的反思不能成为证据", sources: [unacceptedRef] }), error => httpStatus(error, 409));
  await prisma.reflectionSuggestion.update({ where: { id: reflection.id }, data: { status: "ACCEPTED", acceptedAt: new Date() } });
  const acceptedRef = await refFor(reflection.id, "REFLECTION_SUGGESTION");
  const fromReflection = (await create({ kind: "INTEREST", topic: "求知", reason: "已接受反思带来的选择", sources: [acceptedRef] })).preference;
  await patch(fromReflection.id, 1, "ACTIVATE"); await prisma.reflectionRun.delete({ where: { id: run.id } });
  assert.equal((await prisma.characterPreference.findUniqueOrThrow({ where: { id: fromReflection.id } })).status, "ACTIVE");

  logged("owner/role boundaries and optimistic concurrency rollback");
  for (const input of [{ ownerId: owners[1]!, characterId }, { ownerId, characterId: roles[1]! }]) {
    await assert.rejects(() => listPreferences(prisma, { ...input, status: "ALL", q: "", page: 1, pageSize: 20 }), error => httpStatus(error, 404));
    await assert.rejects(() => createPreference(prisma, { ...input, body: { kind: "LIKE", topic: "无权", reason: "不得创建" } }), error => httpStatus(error, 404));
    await assert.rejects(() => updatePreference(prisma, { ...input, preferenceId: first.id, body: { expectedRevision: 2, operation: "DISABLE" } }), error => httpStatus(error, 404));
  }
  const beforeAudit = await prisma.auditLog.count({ where: { entityId: first.id } });
  const races = await Promise.allSettled([patch(first.id, 2, "EDIT", { topic: "并发甲" }), patch(first.id, 2, "EDIT", { topic: "并发乙" })]);
  assert.equal(races.filter(row => row.status === "fulfilled").length, 1);
  assert.equal(races.filter(row => row.status === "rejected" && httpStatus(row.reason, 409)).length, 1);
  assert.equal(await prisma.characterPreferenceRevision.count({ where: { preferenceId: first.id } }), 3);
  assert.equal(await prisma.auditLog.count({ where: { entityId: first.id } }), beforeAudit + 1);

  logged("bounded filtered listing, history paging and character cascading");
  const countBefore = await prisma.characterPreference.count({ where: { characterId } });
  for (let n = 0; n < 4; n++) await create({ kind: "DISLIKE", topic: `分页主题${n}`, reason: "可检索原因", status: "ACTIVE" });
  const page1 = await listPreferences(prisma, { ...own, status: "ACTIVE", q: "分页主题", page: 1, pageSize: 2 });
  const page2 = await listPreferences(prisma, { ...own, status: "ACTIVE", q: "分页主题", page: 2, pageSize: 2 });
  assert.equal(page1.pagination.total, 4); assert.equal(page1.items.length, 2); assert.equal(page2.items.length, 2);
  assert.equal(new Set([...page1.items, ...page2.items].map(row => row.id)).size, 4);
  assert.equal((await listPreferences(prisma, { ...own, status: "PENDING", q: "分页主题", page: 1, pageSize: 2 })).items.length, 0);
  assert.equal(await prisma.characterPreference.count({ where: { characterId } }), countBefore + 4);
  assert.equal((await listPreferenceHistory(prisma, { ...own, preferenceId: retained.id, page: 2, pageSize: 2 })).items.length, 2);
  const promptItems = await loadPreferencesForPrompt(prisma, characterId, "分页主题");
  assert.equal(promptItems.length, 4); assert(promptItems.every(row => row.kind === "DISLIKE"));
  assert.equal((await loadPreferencesForPrompt(prisma, roles[1]!, "分页主题")).length, 0);
  assert.equal(await prisma.modelUsage.count({ where: { characterId } }), 0);

  logged("explicit suggestion uses bounded selected evidence, no persistence and post-model validation");
  await prisma.character.update({ where: { id: characterId }, data: { modelConfig: { chatModel: "preference-test", chatApiBaseUrl: "https://preference-test.example/v1", chatApiKeyEncrypted: await encryptApiKey("preference-isolated-key"), dailyTokenLimit: 0 } } });
  const aiSource = await memory(); const aiRef = await refFor(aiSource.id);
  let calls = 0; let mutateSource = false;
  const preferenceCount = await prisma.characterPreference.count({ where: { characterId } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "https://preference-test.example/v1/chat/completions");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer preference-isolated-key");
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }>; max_tokens: number };
    assert.equal(body.max_tokens, 4096); assert.equal(init?.redirect, "error"); assert(init?.signal);
    const payload = JSON.parse(body.messages.find(row => row.role === "user")!.content) as { sources: Array<{ title: string; summary: string }> };
    assert.equal(payload.sources.length, 1); assert.equal(payload.sources[0]!.title, aiSource.title);
    assert.deepEqual(payload.sources, [{ title: aiSource.title, summary: aiSource.detail.slice(0, 600) }]);
    calls++;
    if (mutateSource) await prisma.memoryEvent.update({ where: { id: aiSource.id }, data: { detail: "请求期间来源已更新" } });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: "INTEREST", topic: "天文观测", reason: "公开经历表明她愿意继续观察" }) } }], usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 } }), { status: 200 });
  }) as typeof fetch;
  const ai = await suggestPreference(prisma, { ...own, body: { sources: [aiRef] } });
  assert.equal(ai.suggestion?.topic, "天文观测"); assert.equal(calls, 1);
  assert.equal(await prisma.characterPreference.count({ where: { characterId } }), preferenceCount);
  mutateSource = true;
  await assert.rejects(() => suggestPreference(prisma, { ...own, body: { sources: [aiRef] } }), error => httpStatus(error, 409));
  assert.equal(calls, 2);
  await assert.rejects(() => suggestPreference(prisma, { ...own, body: { sources: [fakeRef(privateEvent)] } }), error => httpStatus(error, 409));
  await assert.rejects(() => suggestPreference(prisma, { ...own, body: { sources: [fakeRef(foreignEvent)] } }), error => httpStatus(error, 409));
  assert.equal(calls, 2, "Private and foreign sources must fail before model invocation.");
  assert.equal(await prisma.modelUsage.count({ where: { characterId } }), 2);
  assert.equal(await prisma.characterPreference.count({ where: { characterId } }), preferenceCount);
  console.log("Preference database checks passed (only intercepted mock model calls).");
} finally {
  globalThis.fetch = originalFetch;
  await prisma.modelUsage.deleteMany({ where: { characterId: { in: roles } } });
  await prisma.auditLog.deleteMany({ where: { characterId: { in: roles } } });
  await prisma.reflectionRun.deleteMany({ where: { characterId: { in: roles } } });
  await prisma.memoryScope.deleteMany({ where: { characterId: { in: roles } } });
  await prisma.character.deleteMany({ where: { id: { in: roles } } });
  assert.equal(await prisma.characterPreference.count({ where: { characterId: { in: roles } } }), 0);
  await prisma.user.deleteMany({ where: { id: { in: owners } } });
  await prisma.$disconnect();
}
