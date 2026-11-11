import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp, createRouter, eventHandler, toNodeListener } from "h3";
import { getPrisma } from "../server/utils/prisma";
import { createSession } from "../server/utils/auth";
import { createAssistantTurnContext } from "../server/utils/assistant-turn-context";
import { createModelTurnDetail, type ModelTurnDetail } from "../server/utils/model-turn-detail";
import { generateGroupContextReply } from "../server/utils/group-context-reply";
import { recordModelUsage, toUsageTokens } from "../server/utils/model-usage";
import type { ConversationReplyInput } from "../server/utils/chat-reply";
import type { MemoryAssistantRuntime } from "../server/utils/memory-assistant";
import { loadPreferencesForPrompt } from "../server/utils/preference-retrieval";
import { loadExpressionHabitsForPrompt } from "../server/utils/expression-habit-retrieval";
import { loadGoalsForPrompt } from "../server/utils/goal-retrieval";
import { rankKnowledgeItems } from "../server/utils/knowledge-retrieval";
import { createGrowthReadDiagnostic, reconcileGrowthReadUsage, type GrowthReadDiagnostic } from "../server/utils/growth-read-diagnostics";

const database = new URL(process.env.DATABASE_URL ?? "");
assert(["localhost", "127.0.0.1", "[::1]"].includes(database.hostname));
assert(/^\/yiling_collaboration_test_[a-f0-9]{32}$/.test(database.pathname), "Run test-assistant-collaboration-isolated only.");
process.env.YILING_ALLOW_DEV_OWNER_BYPASS = "false";
(globalThis as unknown as { defineEventHandler: typeof eventHandler }).defineEventHandler = eventHandler;
const turnHandler = (await import("../server/api/characters/[id]/usage/logs/[logId]/turn.get")).default;
const prisma = getPrisma();
const originalFetch = globalThis.fetch;
const users: string[] = []; const roles: string[] = [];
let api: http.Server | undefined;
let mode: "success" | "failed" | "silent" = "success";
let growthFixture: { preference: string; language: string; goal: string; knowledge: string; foreign: string[] };
const growthQuery = "电影 cinema";
let contextCalls = 0, responseCalls = 0;
const modelRequests: Array<{ model: string; body: string }> = [];
const runtime: MemoryAssistantRuntime = { model: "context-mock", apiKey: "isolated-context-secret", apiBaseUrl: "https://collaboration-model.invalid/v1", temperature: 0.1, maxInputTokens: 16384, maxOutputTokens: 2048 };
const provider = (content: string, finish = "stop", usage = true) => Response.json({ choices: [{ finish_reason: finish, message: { content } }], ...(usage ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) });
globalThis.fetch = (async (input, init) => {
  const url = String(input);
  if (url.startsWith("http://127.0.0.1:")) return originalFetch(input, init);
  assert.equal(url, "https://collaboration-model.invalid/v1/chat/completions", "No network request may escape the mocked model endpoint.");
  const body = JSON.parse(String(init?.body)) as { model: string };
  modelRequests.push({ model: body.model, body: String(init?.body) });
  assert(!String(init?.body).includes("PRIVATE_SOURCE_SENTINEL"));
  for (const id of growthFixture?.foreign ?? []) assert(!String(init?.body).includes(id), "Foreign role growth may not reach the model");
  if (body.model === "context-mock") {
    contextCalls++;
    if (mode === "success" && contextCalls === 1) return provider("", "length");
    return provider(JSON.stringify({ summary: "询问公开电影经历", evidenceMessageIds: ["current"], participation: "invited", ...(mode === "success" ? { memoryQuery: "之前讨论的电影", knowledgeQuery: "cinema" } : {}) }));
  }
  if (body.model === "memory-mock") return provider('{"sourceKeys":["memory/public","memory/private","invented"]}');
  assert.equal(body.model, "character-mock"); responseCalls++;
  if (mode === "failed") return new Response("provider-error-secret", { status: 503 });
  if (mode === "success" && responseCalls === 1) return provider("not-json");
  return provider(JSON.stringify({ action: mode === "silent" ? "silent" : "reply", reply: mode === "silent" ? "" : "之前谈过那部电影。",
    usedMemoryIds: ["public"], usedSnapshotIds: [], usedEventIds: [], usedRawMessageIds: [],
    usedPreferenceIds: [growthFixture.preference, "invented"], usedExpressionHabitIds: [growthFixture.language, "invented"], usedGoalIds: [growthFixture.goal, "invented"],
  }), "stop", false);
}) as typeof fetch;

async function saveTurn(characterId: string, scopeId: string, requestedMode: typeof mode = "success") {
  mode = requestedMode; const shouldFail = requestedMode === "failed"; contextCalls = 0; responseCalls = 0;
  const reads = new Map<GrowthReadDiagnostic["domain"], GrowthReadDiagnostic>();
  const observe = (entry: GrowthReadDiagnostic) => { reads.set(entry.domain, entry); };
  observe(createGrowthReadDiagnostic("knowledge"));
  const preferences = await loadPreferencesForPrompt(prisma, characterId, growthQuery, observe);
  const expressionHabits = await loadExpressionHabitsForPrompt(prisma, characterId, growthQuery, observe);
  const goals = await loadGoalsForPrompt(prisma, characterId, growthQuery, observe);
  assert.deepEqual(preferences.map(row => row.id), [growthFixture.preference]);
  assert.deepEqual(expressionHabits.map(row => row.id), [growthFixture.language]);
  assert.deepEqual(goals.map(row => row.id), [growthFixture.goal]);
  const loadKnowledge = async (query: string) => {
    // Real bounded DB read + existing ranker; this test does not execute the whole channel pipeline.
    const rows = await prisma.knowledgeItem.findMany({ where: { characterId, status: "ACTIVE" }, orderBy: { updatedAt: "desc" }, take: 300 });
    const selected = rankKnowledgeItems(query, rows, 8);
    observe(createGrowthReadDiagnostic("knowledge", { status: selected.length ? "provided" : "no_match", candidateCount: rows.length, matchedCount: selected.length, selectedCount: selected.length,
      provided: selected.map(row => ({ id: row.id, updatedAt: row.updatedAt.toISOString() })) }));
    return selected.map(({ id, title, content, category, tags, confidence, sourceType }) => ({ id, title, content, category, tags, confidence, sourceType }));
  };
  const turnId = randomUUID();
  const context = createAssistantTurnContext({ turnId, identity: { characterId, channel: "qq-group", channelBindingId: randomUUID(), conversationKey: "g:synthetic", readableScopeIds: [scopeId], allowPrivate: false }, evidenceIds: ["current"] });
  const detail = createModelTurnDetail(true, [{ id: "current", content: "之前讨论的电影呢" }]);
  const chatInput: ConversationReplyInput = { groupChat: true, allowSilent: true, characterName: "协作隔离测试角色", characterPrompt: "自然交流", model: "character-mock", apiKey: "isolated-chat-secret", apiBaseUrl: runtime.apiBaseUrl, thinking: false, preferences, expressionHabits, goals, currentMessage: "之前讨论的电影呢", transcript: [{ id: "current", content: "之前讨论的电影呢" }], recentMessages: [], memories: [], snapshots: [] };
  let failure: unknown;
  try {
    const generated = await generateGroupContextReply({ chatInput, loadKnowledge, turnContext: context, contextAssistant: runtime, assistant: { ...runtime, model: "memory-mock", apiKey: "isolated-memory-secret" }, candidates: [
      { id: "public", sourceKey: "memory/public", sourceType: "memory", scope: "character", relevanceScore: 1, category: "FACT", content: "公开电影经历" },
      { id: "private", sourceKey: "memory/private", sourceType: "memory", scope: "private", relevanceScore: 1, category: "FACT", content: "PRIVATE_SOURCE_SENTINEL" },
    ], onTurnDetail: detail.update, recordAssistantUsage: async entry => recordModelUsage({ characterId, kind: entry.kind, model: entry.model, usage: entry.usage, metadata: { turnId, status: entry.status } }) });
    detail.update({ response: { action: generated.action, reply: generated.reply, explanation: generated.responseExplanation }, collaboration: context.snapshot(),
      growthReads: reconcileGrowthReadUsage([...reads.values()], { preferences: generated.usedPreferenceIds, language: generated.usedExpressionHabitIds, goals: generated.usedGoalIds }, generated.action === "silent") });
    await recordModelUsage({ characterId, kind: "channel", model: generated.model, usage: toUsageTokens(generated.usage), metadata: { turnId, status: "success", turnDetail: detail.serialize() } });
  } catch (error) {
    failure = error;
    detail.update({ collaboration: context.snapshot(), growthReads: [...reads.values()] });
    await recordModelUsage({ characterId, kind: "channel", model: "character-mock", metadata: { turnId, status: "failed", turnDetail: detail.serialize() } });
  }
  assert.equal(Boolean(failure), shouldFail);
  const main = await prisma.modelUsage.findFirstOrThrow({ where: { characterId, kind: "channel", metadata: { path: ["turnId"], equals: turnId } } });
  const assistant = await prisma.modelUsage.findFirstOrThrow({ where: { characterId, kind: "context-assistant", metadata: { path: ["turnId"], equals: turnId } } });
  assert.equal(typeof (main.metadata as Record<string, unknown>).turnDetail, "string");
  return { turnId, mainId: main.id, assistantId: assistant.id };
}
type DetailResponse = { turnId: string; createdAt: string; detail: ModelTurnDetail };
try {
  for (let i = 0; i < 2; i++) {
    const user = await prisma.user.create({ data: { username: `collaboration-${randomUUID()}`, passwordHash: "test-only", role: "USER", status: "ACTIVE" } }); users.push(user.id);
  }
  for (const ownerId of [users[0]!, users[0]!, users[1]!]) {
    const character = await prisma.character.create({ data: { ownerId, name: "协作隔离测试角色", basePrompt: "测试" } }); roles.push(character.id);
  }
  const scope = await prisma.memoryScope.create({ data: { characterId: roles[0]!, scopeType: "CHARACTER_GLOBAL", scopeKey: randomUUID() } });
  const preference = await prisma.characterPreference.create({ data: { characterId: roles[0]!, kind: "LIKE", topic: "cinema", reason: "公开电影偏好", status: "ACTIVE", revision: 3 } });
  const language = await prisma.characterExpressionHabit.create({ data: { characterId: roles[0]!, kind: "TONE", content: "讨论电影时简洁自然", context: "cinema", reason: "人工确认", status: "ACTIVE", revision: 4 } });
  const goal = await prisma.characterGoal.create({ data: { characterId: roles[0]!, kind: "WISH", title: "cinema discussion", description: "看电影后记录想法", reason: "人工确认", status: "ACTIVE", revision: 5 } });
  const knowledge = await prisma.knowledgeItem.create({ data: { characterId: roles[0]!, title: "cinema terminology", content: "公开电影知识", category: "GENERAL", sourceType: "MANUAL", status: "ACTIVE" } });
  const foreignPreference = await prisma.characterPreference.create({ data: { characterId: roles[2]!, kind: "LIKE", topic: "cinema", reason: "FOREIGN_GROWTH_SENTINEL", status: "ACTIVE" } });
  const foreignLanguage = await prisma.characterExpressionHabit.create({ data: { characterId: roles[2]!, kind: "TONE", content: "FOREIGN_GROWTH_SENTINEL", context: "cinema", reason: "人工确认", status: "ACTIVE" } });
  const foreignGoal = await prisma.characterGoal.create({ data: { characterId: roles[2]!, kind: "GOAL", title: "cinema", description: "FOREIGN_GROWTH_SENTINEL", reason: "人工确认", status: "ACTIVE" } });
  growthFixture = { preference: preference.id, language: language.id, goal: goal.id, knowledge: knowledge.id, foreign: [foreignPreference.id, foreignLanguage.id, foreignGoal.id] };
  await prisma.characterPreference.create({ data: { characterId: roles[0]!, kind: "LIKE", topic: "cinema", reason: "候选不入模", status: "PENDING" } });
  await prisma.characterExpressionHabit.create({ data: { characterId: roles[0]!, kind: "TONE", content: "停用不入模", context: "cinema", reason: "人工确认", status: "DISABLED" } });
  await prisma.characterGoal.create({ data: { characterId: roles[0]!, kind: "GOAL", title: "cinema", description: "暂停不入模", reason: "人工确认", status: "PAUSED" } });
  const ownerSession = await createSession({ userId: users[0]! });
  const foreignSession = await createSession({ userId: users[1]! });
  const app = createApp(); const router = createRouter();
  router.get("/characters/:id/usage/logs/:logId/turn", turnHandler); app.use(router);
  api = http.createServer(toNodeListener(app)); await new Promise<void>(resolve => api!.listen(0, "127.0.0.1", resolve));
  const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  async function read(characterId: string, logId: string, token = ownerSession.token) {
    return originalFetch(`${apiUrl}/characters/${characterId}/usage/logs/${logId}/turn`, { headers: token ? { cookie: `yiling_session=${token}` } : {} });
  }
  console.log("[collaboration-db] generated group retries -> real usage persistence -> actual handler session readback");
  const success = await saveTurn(roles[0]!, scope.id);
  assert.equal(contextCalls, 2); assert.equal(responseCalls, 2);
  const response = await read(roles[0]!, success.mainId); assert.equal(response.status, 200);
  const data = await response.json() as DetailResponse;
  assert.equal(data.turnId, success.turnId); assert.equal(data.detail.response.status, "success");
  const stages = data.detail.collaboration!.stages;
  const contextStage = stages.find(stage => stage.stage === "context")!;
  assert.equal(contextStage.logicalCalls, 1); assert.equal(contextStage.operations[0]!.reportedAttempts, 2);
  assert.deepEqual(contextStage.operations[0]!.attempts.map(attempt => attempt.status), ["truncated", "success"]);
  const mainStage = stages.find(stage => stage.stage === "response")!;
  assert.equal(mainStage.logicalCalls, 1); assert.equal(mainStage.operations[0]!.reportedAttempts, 2);
  assert.deepEqual(mainStage.operations[0]!.attempts.map(attempt => attempt.status), ["invalid_response", "success"]);
  assert.equal(mainStage.operations[0]!.attempts[1]!.usageReported, false);
  assert.deepEqual((data.detail.memory.sources ?? []).map(source => source.id), ["public"]);
  const growth = data.detail.growthReads!; assert.equal(growth.length, 4);
  for (const [domain, id, revision] of [["preferences", preference.id, 3], ["language", language.id, 4], ["goals", goal.id, 5]] as const) {
    const read = growth.find(row => row.domain === domain)!;
    assert.equal(read.status, "provided"); assert.deepEqual(read.provided, [{ id, revision }]); assert.deepEqual(read.usedIds, [id]);
    assert.equal(read.candidateCount, 1); assert.equal(read.selectedCount, 1);
  }
  const knowledgeRead = growth.find(row => row.domain === "knowledge")!;
  assert.deepEqual(knowledgeRead.provided, [{ id: knowledge.id, updatedAt: knowledge.updatedAt.toISOString() }]);
  assert.deepEqual(knowledgeRead.usedIds, [], "Knowledge has no model-used-ID protocol");
  assert(!JSON.stringify(growth).includes("invented")); assert(!JSON.stringify(data).includes("FOREIGN_GROWTH_SENTINEL"));
  const linked = await read(roles[0]!, success.assistantId); assert.equal(linked.status, 200);
  assert.equal((await linked.json() as DetailResponse).turnId, success.turnId);
  for (const secret of ["isolated-chat-secret", "isolated-context-secret", "isolated-memory-secret", "PRIVATE_SOURCE_SENTINEL", "provider-error-secret"]) assert(!JSON.stringify(data).includes(secret));

  console.log("[collaboration-db] actual handler owner, character and turn boundaries");
  assert.equal((await read(roles[0]!, success.mainId, foreignSession.token)).status, 404);
  assert.equal((await read(roles[1]!, success.mainId)).status, 404);
  assert.equal((await read(roles[0]!, success.mainId, "")).status, 401);
  const unrelatedTurn = randomUUID();
  await recordModelUsage({ characterId: roles[2]!, kind: "channel", model: "foreign", metadata: { turnId: unrelatedTurn, turnDetail: detailJson("FOREIGN_TURN_SENTINEL") } });
  await recordModelUsage({ characterId: roles[0]!, kind: "memory-assistant", model: "link-only", metadata: { turnId: unrelatedTurn } });
  const orphanLink = await prisma.modelUsage.findFirstOrThrow({ where: { characterId: roles[0]!, model: "link-only" } });
  assert.equal((await read(roles[0]!, orphanLink.id)).status, 404, "A shared turnId cannot borrow another character's main row.");

  console.log("[collaboration-db] legacy details and failed generation keep correct diagnostics");
  const legacyTurn = randomUUID();
  await recordModelUsage({ characterId: roles[0]!, kind: "channel", model: "legacy", metadata: { turnId: legacyTurn, turnDetail: detailJson("旧记录") } });
  const legacy = await prisma.modelUsage.findFirstOrThrow({ where: { characterId: roles[0]!, model: "legacy" } });
  const legacyResponse = await read(roles[0]!, legacy.id); assert.equal(legacyResponse.status, 200);
  const legacyDetail = (await legacyResponse.json() as DetailResponse).detail;
  assert.equal(legacyDetail.collaboration, undefined); assert.equal(legacyDetail.growthReads, undefined);
  const failed = await saveTurn(roles[0]!, scope.id, "failed");
  const failedResponse = await read(roles[0]!, failed.mainId); assert.equal(failedResponse.status, 200);
  const failure = await failedResponse.json() as DetailResponse;
  assert.equal(failure.detail.response.status, "failed");
  const failedStage = failure.detail.collaboration!.stages.find(stage => stage.stage === "response")!;
  assert.equal(failedStage.operations[0]!.state, "failed");
  assert.deepEqual(failedStage.operations[0]!.attempts.map(attempt => attempt.status), ["http_error"]);
  assert.equal(failedStage.operations[0]!.attempts[0]!.usageReported, false);
  assert(!JSON.stringify(failure).includes("provider-error-secret"));
  assert.equal(failure.detail.growthReads?.filter(row => row.status === "provided").length, 3);
  assert(failure.detail.growthReads?.every(row => row.usedIds.length === 0));
  const silent = await saveTurn(roles[0]!, scope.id, "silent");
  const silentResponse = await read(roles[0]!, silent.mainId); assert.equal(silentResponse.status, 200);
  const silentDetail = (await silentResponse.json() as DetailResponse).detail;
  assert.equal(silentDetail.response.action, "silent");
  assert.equal(silentDetail.growthReads?.filter(row => row.status === "provided").length, 3);
  assert(silentDetail.growthReads?.every(row => row.usedIds.length === 0), "Silence must clear even model-reported used IDs");
  assert(modelRequests.length > 0);
  console.log("Assistant collaboration DB integration passed; actual handler/session/DB used, provider calls intercepted.");
} finally {
  globalThis.fetch = originalFetch;
  if (api) await new Promise<void>((resolve, reject) => api!.close(error => error ? reject(error) : resolve()));
  try {
    await prisma.modelUsage.deleteMany({ where: { characterId: { in: roles } } });
    await prisma.memoryScope.deleteMany({ where: { characterId: { in: roles } } });
    await prisma.character.deleteMany({ where: { id: { in: roles } } });
    await prisma.session.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  } finally { await prisma.$disconnect(); }
}
function detailJson(reply: string) {
  const detail = createModelTurnDetail(true, [{ content: "隔离测试消息" }]);
  detail.update({ response: { action: "reply", reply } }); return detail.serialize();
}
