import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPrisma } from "../server/utils/prisma";
import { encryptApiKey } from "../server/utils/credential-encryption";
import { deleteReflections, listReflectionRuns, requestReflection, reviewReflectionSuggestion, retryReflection } from "../server/utils/reflection-service";
import { collectReflectionSources, processNextReflectionRun, type ReflectionSource } from "../server/utils/reflection-worker";

const url = new URL(process.env.DATABASE_URL ?? "");
assert(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Reflection DB tests require a local host.");
assert(/^\/yiling_reflection_test_[a-f0-9]{32}$/.test(url.pathname), "Run test:reflection-isolated only.");
const options = url.searchParams.get("options") ?? "";
url.searchParams.set("options", `${options} -c statement_timeout=10000 -c lock_timeout=5000`.trim());
process.env.DATABASE_URL = url.toString();
const prisma = getPrisma();
const originalFetch = globalThis.fetch;
const endpoint = "https://reflection-test.example/v1/chat/completions";
const config = { chatModel: "reflection-test-model", chatApiBaseUrl: "https://reflection-test.example/v1", chatApiKeyEncrypted: await encryptApiKey("isolated-reflection-key"), dailyTokenLimit: 0 };
const requests: Array<{ sources: ReflectionSource[]; body: Record<string, unknown> }> = [];
type Model = (sources: ReflectionSource[]) => Promise<unknown> | unknown;
let respond: Model = () => ({ suggestions: [] });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  assert.equal(String(input), endpoint, "All network requests must be intercepted as the fake model endpoint.");
  assert.equal(new Headers(init?.headers).get("authorization"), "Bearer isolated-reflection-key");
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  const messages = body.messages as Array<{ role: string; content: string }>;
  const payload = JSON.parse(messages.find(message => message.role === "user")!.content) as { sources: ReflectionSource[] };
  requests.push({ sources: payload.sources, body });
  const output = await respond(payload.sources);
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

function suggestion(sources: ReflectionSource[], title = "值得保持的做法") {
  return { title, observation: "来源记录了明确的实践。", inference: "可能形成稳定习惯，但仍需要观察。", recommendation: "下次继续验证，暂不修改核心设定。", sourceRefs: sources.slice(0, 1).map(item => item.key) };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function guarded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Reflection test exceeded 15 second guard.")), 15_000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function status(error: unknown, code: number) { return typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === code; }
type Fixture = { ownerId: string; foreignOwnerId: string; characterId: string; foreignCharacterId: string; globalScopeId: string; privateScopeId: string; before: number };
async function scenario(label: string, run: (fixture: Fixture) => Promise<void>) {
  console.log(`\n[reflection-db] ${label}`);
  const owners: string[] = [];
  const characters: string[] = [];
  respond = () => ({ suggestions: [] });
  try {
    for (let index = 0; index < 2; index++) {
      const owner = await prisma.user.create({ data: { username: `reflection-${randomUUID()}`, passwordHash: "test-only", role: "USER", status: "ACTIVE" } });
      owners.push(owner.id);
      const character = await prisma.character.create({ data: { ownerId: owner.id, name: "反思隔离角色", basePrompt: "CORE_PROMPT_UNCHANGED", styleExamples: "STYLE_UNCHANGED", modelConfig: config } });
      characters.push(character.id);
    }
    const global = await prisma.memoryScope.create({ data: { characterId: characters[0]!, scopeType: "CHARACTER_GLOBAL", scopeKey: randomUUID() } });
    const privateScope = await prisma.memoryScope.create({ data: { characterId: characters[0]!, scopeType: "USER_PRIVATE", scopeKey: randomUUID(), userId: owners[0]! } });
    await run({ ownerId: owners[0]!, foreignOwnerId: owners[1]!, characterId: characters[0]!, foreignCharacterId: characters[1]!, globalScopeId: global.id, privateScopeId: privateScope.id, before: requests.length });
  } finally {
    respond = () => { throw new Error("No model call may escape a completed scenario."); };
    await prisma.modelUsage.deleteMany({ where: { characterId: { in: characters } } });
    await prisma.auditLog.deleteMany({ where: { characterId: { in: characters } } });
    await prisma.reflectionRun.deleteMany({ where: { characterId: { in: characters } } });
    await prisma.memoryScope.deleteMany({ where: { characterId: { in: characters } } });
    await prisma.character.deleteMany({ where: { id: { in: characters } } });
    await prisma.user.deleteMany({ where: { id: { in: owners } } });
  }
}
async function memory(f: Fixture, scopeId = f.globalScopeId, detail = "公开反思来源：一次持续学习并核验资料的实践。") {
  return prisma.memoryEvent.create({ data: { memoryScopeId: scopeId, dayKey: "2026-11-10", occurredAt: new Date(Date.now() - 60_000), title: "核验资料", detail, dedupeKey: randomUUID() } });
}
function request(f: Fixture, requestKey = randomUUID(), days = 7) { return requestReflection(prisma, { ownerId: f.ownerId, characterId: f.characterId, requestKey, days }); }
function work(workerId = "reflection-test") { return processNextReflectionRun(prisma, { workerId }); }
async function generate(f: Fixture, count = 1) {
  for (let index = 0; index < count; index++) await memory(f);
  respond = sources => ({ suggestions: Array.from({ length: count }, (_, index) => suggestion(sources.slice(index, index + 1), `建议${index + 1}`)) });
  const result = await request(f);
  assert.equal((await work()).status, "SUCCEEDED");
  return prisma.reflectionRun.findUniqueOrThrow({ where: { id: result.run.id }, include: { suggestions: true } });
}
const review = (f: Fixture, suggestionId: string, decision: "ACCEPTED" | "REJECTED" | "DEFERRED") => reviewReflectionSuggestion(prisma, { ownerId: f.ownerId, characterId: f.characterId, suggestionId, decision, note: "隔离测试审核" });

try {
  await scenario("owner isolation, concurrent request idempotency and active-run exclusion", async f => {
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 4 }, () => request(f, key)));
    assert.equal(results.filter(result => result.created).length, 1);
    assert.equal(new Set(results.map(result => result.run.id)).size, 1);
    await assert.rejects(() => request(f, key, 14), error => status(error, 409));
    await assert.rejects(() => request(f), error => status(error, 409));
    const params = { ownerId: f.foreignOwnerId, characterId: f.characterId, page: 1, pageSize: 20 };
    await assert.rejects(() => listReflectionRuns(prisma, params), error => status(error, 404));
    await assert.rejects(() => requestReflection(prisma, { ...params, requestKey: randomUUID(), days: 7 }), error => status(error, 404));
    const list = await listReflectionRuns(prisma, { ...params, ownerId: f.ownerId });
    assert.equal(list.total, 1); assert(!("leaseToken" in list.items[0]!)); assert(!("fencingToken" in list.items[0]!));
    await assert.rejects(() => retryReflection(prisma, { ...params, runId: results[0]!.run.id }), error => status(error, 404));
  });

  await scenario("real worker uses public sources and saves at most three source-backed suggestions", async f => {
    const publicMemory = await memory(f);
    await memory(f, f.privateScopeId, "PRIVATE_MEMORY_MUST_NOT_REACH_PROMPT");
    const snapshot = await prisma.memorySnapshot.create({ data: {
      memoryScopeId: f.globalScopeId, snapshotKey: randomUUID(), periodStart: new Date(Date.now() - 3 * 86_400_000), periodEnd: new Date(Date.now() - 60_000), summary: "PUBLIC_SNAPSHOT_ALLOWED", structuredContent: {},
    } });
    await prisma.memorySnapshot.create({ data: {
      memoryScopeId: f.privateScopeId, snapshotKey: randomUUID(), periodStart: new Date(Date.now() - 3 * 86_400_000), periodEnd: new Date(Date.now() - 60_000), summary: "PRIVATE_SNAPSHOT_MUST_NOT_REACH_PROMPT", structuredContent: {},
    } });
    await prisma.knowledgeItem.createMany({ data: [
      { characterId: f.characterId, title: "公开知识", content: "MANUAL_KNOWLEDGE_ALLOWED", sourceType: "MANUAL" },
      { characterId: f.characterId, title: "私聊知识", content: "CHAT_KNOWLEDGE_MUST_NOT_REACH_PROMPT", sourceType: "CHAT" },
    ] });
    const sources = await collectReflectionSources(prisma, f.characterId, new Date(Date.now() - 7 * 86_400_000), new Date());
    assert(sources.some(source => source.id === publicMemory.id));
    assert(sources.some(source => source.id === snapshot.id));
    respond = items => ({ suggestions: ["memory", "knowledge", "snapshot"].map(type => suggestion(items.filter(item => item.type === type), type)) });
    const pending = await request(f);
    assert.equal((await work()).status, "SUCCEEDED");
    const run = await prisma.reflectionRun.findUniqueOrThrow({ where: { id: pending.run.id }, include: { suggestions: true } });
    assert.equal(run.suggestions.length, 3);
    const body = JSON.stringify(requests.at(-1)!.body);
    assert(!body.includes("PRIVATE_MEMORY_MUST_NOT_REACH_PROMPT")); assert(!body.includes("CHAT_KNOWLEDGE_MUST_NOT_REACH_PROMPT"));
    assert(body.includes("MANUAL_KNOWLEDGE_ALLOWED"));
    assert(body.includes("PUBLIC_SNAPSHOT_ALLOWED")); assert(!body.includes("PRIVATE_SNAPSHOT_MUST_NOT_REACH_PROMPT"));
    for (const item of run.suggestions) {
      const refs = item.sourceRefs as Array<{ key: string; hash: string }>;
      assert(refs.length > 0 && refs.every(ref => requests.at(-1)!.sources.some(source => source.key === ref.key && source.hash === ref.hash)));
    }
  });

  await scenario("unchanged evidence reuses results across request keys and windows; changed evidence can reflect again", async f => {
    const first = await generate(f);
    for (const decision of ["DEFERRED", "REJECTED"] as const) {
      await review(f, first.suggestions[0]!.id, decision);
      const repeated = await Promise.all([request(f), request(f, randomUUID(), 14), request(f, randomUUID(), 30)]);
      assert(repeated.every(result => !result.created && result.run.id === first.id));
      assert.equal(requests.length, f.before + 1);
      assert.equal(await prisma.reflectionRun.count({ where: { characterId: f.characterId } }), 1);
    }
    const ref = (first.suggestions[0]!.sourceRefs as Array<{ id: string }>)[0]!;
    await prisma.memoryEvent.update({ where: { id: ref.id }, data: { detail: "新增核验结果，原来的判断需要调整。" } });
    const next = await request(f); assert(next.created);
    assert.equal((await work()).status, "SUCCEEDED");
    assert.equal(await prisma.reflectionSuggestion.count({ where: { runId: next.run.id } }), 1);
  });

  await scenario("new evidence cannot resurrect suggestions based only on previously accepted evidence", async f => {
    const first = await generate(f);
    await review(f, first.suggestions[0]!.id, "ACCEPTED");
    const oldId = (first.suggestions[0]!.sourceRefs as Array<{ id: string }>)[0]!.id;
    const fresh = await memory(f);
    respond = sources => ({ suggestions: [
      suggestion(sources.filter(ref => ref.id === oldId), "换了说法的旧建议"),
      suggestion(sources.filter(ref => ref.id === fresh.id), "新增证据建议"),
      suggestion(sources.filter(ref => ref.id === fresh.id), "本轮重复建议"),
    ] });
    const next = await request(f); assert(next.created);
    assert.equal((await work()).status, "SUCCEEDED");
    const suggestions = await prisma.reflectionSuggestion.findMany({ where: { runId: next.run.id } });
    assert.deepEqual(suggestions.map(row => row.title), ["新增证据建议"]);
    assert.equal((await request(f)).run.id, next.run.id);
  });

  await scenario("empty evidence succeeds without model calls; forged source suggestions are discarded entirely", async f => {
    const empty = await request(f);
    assert.equal((await work()).status, "SUCCEEDED");
    assert.equal(requests.length, f.before);
    assert.equal(await prisma.reflectionSuggestion.count({ where: { runId: empty.run.id } }), 0);
    await memory(f);
    respond = sources => ({ suggestions: [{ ...suggestion(sources), sourceRefs: [sources[0]!.key, `memory:${randomUUID()}`] }, suggestion(sources, "唯一有效建议")] });
    const next = await request(f);
    await work();
    const rows = await prisma.reflectionSuggestion.findMany({ where: { runId: next.run.id } });
    assert.equal(rows.length, 1); assert.equal(rows[0]!.title, "唯一有效建议");
  });

  await scenario("accept/defer/reject audit and accepted conclusions never edit personality or formal knowledge", async f => {
    const run = await generate(f, 3);
    const [accept, defer, reject] = run.suggestions;
    assert(accept && defer && reject);
    const wrong = { ownerId: f.foreignOwnerId, characterId: f.characterId, suggestionId: accept.id, decision: "ACCEPTED" as const, note: "" };
    await assert.rejects(() => reviewReflectionSuggestion(prisma, wrong), error => status(error, 404));
    await assert.rejects(() => reviewReflectionSuggestion(prisma, { ...wrong, ownerId: f.ownerId, characterId: f.foreignCharacterId }), error => status(error, 404));
    const accepted = await review(f, accept.id, "ACCEPTED"); assert(accepted.suggestion.acceptedAt);
    await review(f, defer.id, "DEFERRED"); await review(f, reject.id, "REJECTED");
    await assert.rejects(() => review(f, accept.id, "REJECTED"), error => status(error, 409));
    await assert.rejects(() => review(f, reject.id, "ACCEPTED"), error => status(error, 409));
    const character = await prisma.character.findUniqueOrThrow({ where: { id: f.characterId } });
    assert.equal(character.basePrompt, "CORE_PROMPT_UNCHANGED"); assert.equal(character.styleExamples, "STYLE_UNCHANGED");
    assert.equal(await prisma.knowledgeItem.count({ where: { characterId: f.characterId } }), 0);
    assert.equal((await prisma.reflectionSuggestion.findUniqueOrThrow({ where: { id: accept.id } })).acceptedAt?.getTime(), accepted.suggestion.acceptedAt!.getTime());
    for (const decision of ["accepted", "deferred", "rejected"]) assert.equal(await prisma.auditLog.count({ where: { characterId: f.characterId, action: `reflection.suggestion.${decision}` } }), 1);
    await review(f, defer.id, "ACCEPTED");
  });

  await scenario("concurrent opposite final reviews permit one winner", async f => {
    const run = await generate(f);
    const id = run.suggestions[0]!.id;
    const results = await Promise.allSettled([review(f, id, "ACCEPTED"), review(f, id, "REJECTED")]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    assert(status(rejected.reason, 409));
    assert.equal(await prisma.auditLog.count({ where: { entityId: id, action: { startsWith: "reflection.suggestion." } } }), 1);
  });

  for (const mutation of ["changed", "archived", "private"] as const) await scenario(`accept rejects ${mutation} evidence`, async f => {
    const run = await generate(f);
    const ref = (run.suggestions[0]!.sourceRefs as Array<{ id: string }>)[0]!;
    await prisma.memoryEvent.update({ where: { id: ref.id }, data: mutation === "changed" ? { detail: "内容已改动" } : mutation === "archived" ? { status: "ARCHIVED" } : { memoryScopeId: f.privateScopeId } });
    await assert.rejects(() => review(f, run.suggestions[0]!.id, "ACCEPTED"), error => status(error, 409));
    assert.equal((await prisma.reflectionSuggestion.findUniqueOrThrow({ where: { id: run.suggestions[0]!.id } })).status, "PENDING");
  });

  await scenario("three model failures back off, fail terminally, then authorized manual retry is audited", async f => {
    await memory(f); respond = () => { throw new Error("synthetic model failure containing no business data"); };
    const requested = await request(f);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const before = Date.now();
      const result = await work(); assert.equal(result.status, attempt < 3 ? "QUEUED" : "FAILED");
      const run = await prisma.reflectionRun.findUniqueOrThrow({ where: { id: requested.run.id } });
      assert.equal(run.attemptCount, attempt); assert(run.runAt.getTime() >= before + 60_000 * 2 ** (attempt - 1));
      assert(run.lastError && !run.lastError.includes("synthetic"));
      if (attempt < 3) await prisma.reflectionRun.update({ where: { id: run.id }, data: { runAt: new Date(Date.now() - 1) } });
    }
    await assert.rejects(() => retryReflection(prisma, { ownerId: f.foreignOwnerId, characterId: f.characterId, runId: requested.run.id }), error => status(error, 404));
    const retried = await retryReflection(prisma, { ownerId: f.ownerId, characterId: f.characterId, runId: requested.run.id });
    assert.equal(retried.run.status, "QUEUED"); assert.equal(retried.run.attemptCount, 0);
    assert.equal(await prisma.auditLog.count({ where: { action: "reflection.manual_retry", entityId: requested.run.id, actorId: f.ownerId } }), 1);
    respond = () => ({ suggestions: [] }); await work();
  });

  await scenario("expired RUNNING lease is reclaimed with backoff and rejects an old model result", async f => {
    await memory(f);
    const started = deferred(); const release = deferred();
    let calls = 0;
    respond = async sources => { const call = ++calls; if (call === 1) { started.resolve(); await release.promise; } return { suggestions: [suggestion(sources, call === 1 ? "旧执行结果" : "新执行结果")] }; };
    const requested = await request(f);
    const old = work("old-worker");
    try {
      await guarded(started.promise);
      const held = await prisma.reflectionRun.findUniqueOrThrow({ where: { id: requested.run.id } });
      await prisma.reflectionRun.update({ where: { id: held.id }, data: { leaseExpiresAt: new Date(Date.now() - 1) } });
      assert.equal((await work("reclaimer")).processed, false);
      const recovered = await prisma.reflectionRun.findUniqueOrThrow({ where: { id: held.id } });
      assert.equal(recovered.status, "QUEUED"); assert.equal(recovered.leaseToken, null); assert(recovered.runAt > new Date());
      await prisma.reflectionRun.update({ where: { id: held.id }, data: { runAt: new Date(Date.now() - 1) } });
      assert.equal((await work("new-worker")).status, "SUCCEEDED");
      const current = await prisma.reflectionRun.findUniqueOrThrow({ where: { id: held.id } }); assert(current.fencingToken > held.fencingToken);
      release.resolve(); const stale = await guarded(old); assert.equal(stale.status, undefined);
      assert.equal(await prisma.reflectionSuggestion.count({ where: { runId: held.id } }), 1);
      assert.equal((await prisma.reflectionSuggestion.findFirstOrThrow({ where: { runId: held.id } })).title, "新执行结果");
      assert.equal((await prisma.reflectionRun.findUniqueOrThrow({ where: { id: held.id } })).status, "SUCCEEDED");
    } finally { release.resolve(); await guarded(old); }
  });

  await scenario("two workers claim once and long fetch holds no transaction blocking another review", async f => {
    const previous = await generate(f);
    await memory(f);
    const started = deferred(); const release = deferred();
    respond = async sources => { started.resolve(); await release.promise; return { suggestions: [suggestion(sources)] }; };
    const next = await request(f);
    const workers = [work("parallel-a"), work("parallel-b")];
    try {
      await guarded(started.promise);
      const result = await guarded(review(f, previous.suggestions[0]!.id, "DEFERRED"));
      assert.equal(result.suggestion.status, "DEFERRED");
      release.resolve(); const results = await guarded(Promise.all(workers));
      assert.equal(results.filter(row => row.processed).length, 1);
      assert.equal(await prisma.reflectionSuggestion.count({ where: { runId: next.run.id } }), 1);
    } finally { release.resolve(); await guarded(Promise.all(workers)); }
  });

  await scenario("deletion is owner-scoped, cascades accepted conclusions, preserves evidence and permits regeneration", async f => {
    const run = await generate(f);
    await review(f, run.suggestions[0]!.id, "ACCEPTED");
    await assert.rejects(() => deleteReflections(prisma, { ownerId: f.foreignOwnerId, characterId: f.characterId, runId: run.id }), error => status(error, 404));
    await assert.rejects(() => deleteReflections(prisma, { ownerId: f.ownerId, characterId: f.foreignCharacterId, runId: run.id }), error => status(error, 404));
    const deleted = await deleteReflections(prisma, { ownerId: f.ownerId, characterId: f.characterId, runId: run.id });
    assert.deepEqual(deleted, { deletedRuns: 1, deletedSuggestions: 1 });
    assert.equal(await prisma.reflectionSuggestion.count({ where: { runId: run.id } }), 0);
    assert.equal(await prisma.memoryEvent.count({ where: { memoryScopeId: f.globalScopeId } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { entityId: run.id, action: "reflection.deleted" } }), 1);
    await assert.rejects(() => deleteReflections(prisma, { ownerId: f.ownerId, characterId: f.characterId, runId: run.id }), error => status(error, 404));
    assert((await request(f)).created);
    assert.equal((await work()).status, "SUCCEEDED");
  });

  await scenario("clear cancels queued runs, is role-scoped and succeeds on empty history", async f => {
    await generate(f); await memory(f); await request(f);
    const foreign = await prisma.reflectionRun.create({ data: { characterId: f.foreignCharacterId, requestKey: randomUUID(), periodStart: new Date(Date.now() - 86_400_000), periodEnd: new Date() } });
    const input = { ownerId: f.ownerId, characterId: f.characterId };
    assert.deepEqual(await deleteReflections(prisma, input), { deletedRuns: 2, deletedSuggestions: 1 });
    assert.equal(await prisma.reflectionRun.count({ where: { characterId: f.characterId } }), 0);
    assert(await prisma.reflectionRun.findUnique({ where: { id: foreign.id } }));
    assert.deepEqual(await deleteReflections(prisma, input), { deletedRuns: 0, deletedSuggestions: 0 });
    assert.equal(await prisma.auditLog.count({ where: { characterId: f.characterId, action: "reflection.cleared" } }), 2);
  });

  await scenario("deleting a running task fences out its in-flight model result", async f => {
    await memory(f);
    const started = deferred(); const release = deferred();
    respond = async sources => { started.resolve(); await release.promise; return { suggestions: [suggestion(sources)] }; };
    const requested = await request(f); const worker = work();
    try {
      await guarded(started.promise);
      assert.deepEqual(await deleteReflections(prisma, { ownerId: f.ownerId, characterId: f.characterId, runId: requested.run.id }), { deletedRuns: 1, deletedSuggestions: 0 });
      release.resolve(); assert.equal((await guarded(worker)).status, undefined);
      assert.equal(await prisma.reflectionRun.count({ where: { characterId: f.characterId } }), 0);
      assert.equal(await prisma.reflectionSuggestion.count({ where: { runId: requested.run.id } }), 0);
    } finally { release.resolve(); await guarded(worker); }
  });

  console.log("Reflection DB tests passed: deletion/clear isolation and fencing, domain authorization, source-backed model output, empty/forged sources, review audit, retry/backoff, expiry/fencing, concurrent claim and nonblocking model I/O.");
} finally { globalThis.fetch = originalFetch; await prisma.$disconnect(); }
