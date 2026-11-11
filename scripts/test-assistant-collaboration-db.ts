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
let mode: "success" | "failed" = "success";
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
  if (body.model === "context-mock") {
    contextCalls++;
    if (mode === "success" && contextCalls === 1) return provider("", "length");
    return provider(JSON.stringify({ summary: "询问公开电影经历", evidenceMessageIds: ["current"], participation: "invited", ...(mode === "success" ? { memoryQuery: "之前讨论的电影" } : {}) }));
  }
  if (body.model === "memory-mock") return provider('{"sourceKeys":["memory/public","memory/private","invented"]}');
  assert.equal(body.model, "character-mock"); responseCalls++;
  if (mode === "failed") return new Response("provider-error-secret", { status: 503 });
  if (responseCalls === 1) return provider("not-json");
  return provider('{"action":"reply","reply":"之前谈过那部电影。","usedMemoryIds":["public"],"usedSnapshotIds":[],"usedEventIds":[],"usedRawMessageIds":[]}', "stop", false);
}) as typeof fetch;

async function saveTurn(characterId: string, scopeId: string, shouldFail = false) {
  mode = shouldFail ? "failed" : "success"; contextCalls = 0; responseCalls = 0;
  const turnId = randomUUID();
  const context = createAssistantTurnContext({ turnId, identity: { characterId, channel: "qq-group", channelBindingId: randomUUID(), conversationKey: "g:synthetic", readableScopeIds: [scopeId], allowPrivate: false }, evidenceIds: ["current"] });
  const detail = createModelTurnDetail(true, [{ id: "current", content: "之前讨论的电影呢" }]);
  const chatInput: ConversationReplyInput = { groupChat: true, allowSilent: true, characterName: "协作隔离测试角色", characterPrompt: "自然交流", model: "character-mock", apiKey: "isolated-chat-secret", apiBaseUrl: runtime.apiBaseUrl, thinking: false, currentMessage: "之前讨论的电影呢", transcript: [{ id: "current", content: "之前讨论的电影呢" }], recentMessages: [], memories: [], snapshots: [] };
  let failure: unknown;
  try {
    const generated = await generateGroupContextReply({ chatInput, turnContext: context, contextAssistant: runtime, assistant: { ...runtime, model: "memory-mock", apiKey: "isolated-memory-secret" }, candidates: [
      { id: "public", sourceKey: "memory/public", sourceType: "memory", scope: "character", relevanceScore: 1, category: "FACT", content: "公开电影经历" },
      { id: "private", sourceKey: "memory/private", sourceType: "memory", scope: "private", relevanceScore: 1, category: "FACT", content: "PRIVATE_SOURCE_SENTINEL" },
    ], onTurnDetail: detail.update, recordAssistantUsage: async entry => recordModelUsage({ characterId, kind: entry.kind, model: entry.model, usage: entry.usage, metadata: { turnId, status: entry.status } }) });
    detail.update({ response: { action: generated.action, reply: generated.reply, explanation: generated.responseExplanation }, collaboration: context.snapshot() });
    await recordModelUsage({ characterId, kind: "channel", model: generated.model, usage: toUsageTokens(generated.usage), metadata: { turnId, status: "success", turnDetail: detail.serialize() } });
  } catch (error) {
    failure = error;
    detail.update({ collaboration: context.snapshot() });
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
  assert.equal((await legacyResponse.json() as DetailResponse).detail.collaboration, undefined);
  const failed = await saveTurn(roles[0]!, scope.id, true);
  const failedResponse = await read(roles[0]!, failed.mainId); assert.equal(failedResponse.status, 200);
  const failure = await failedResponse.json() as DetailResponse;
  assert.equal(failure.detail.response.status, "failed");
  const failedStage = failure.detail.collaboration!.stages.find(stage => stage.stage === "response")!;
  assert.equal(failedStage.operations[0]!.state, "failed");
  assert.deepEqual(failedStage.operations[0]!.attempts.map(attempt => attempt.status), ["http_error"]);
  assert.equal(failedStage.operations[0]!.attempts[0]!.usageReported, false);
  assert(!JSON.stringify(failure).includes("provider-error-secret"));
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
