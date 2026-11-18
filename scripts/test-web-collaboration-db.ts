import "dotenv/config";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createApp, createRouter, defineEventHandler, readBody, setResponseStatus, createError, toNodeListener } from "h3";
import { getPrisma } from "../server/utils/prisma";
import { createSession } from "../server/utils/auth";
import { readModelTurnDetail } from "../server/utils/model-turn-detail";
assert.equal(process.env.YILING_CHAT_ISOLATED_DB, "1");
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/yiling_chat_test_[a-f0-9]{32}$/);
Object.assign(globalThis, { defineEventHandler, readBody, setResponseStatus, createError });
const handler = (await import("../server/api/characters/[id]/chat.post")).default;
const prisma = getPrisma();
let calls = 0;
const promptPayloads: Array<{ selfUnderstanding?: import("../server/utils/self-understanding").SelfUnderstandingView }> = [];
const model = createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  const payload = JSON.parse(raw);
  assert(!JSON.stringify(payload).includes("FORBIDDEN_FOREIGN_KNOWLEDGE"));
  calls++;
  promptPayloads.push(JSON.parse(payload.messages.find((message: {role:string}) => message.role === "user").content));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: "番茄育苗需要通风。", usedMemoryIds: [], usedSnapshotIds: [] }) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
});
const api = createServer();
try {
  model.listen(0, "127.0.0.1"); await once(model, "listening");
  const owner = await prisma.user.create({ data: { username: `web-test-${randomUUID()}`, passwordHash: "test" } });
  const stranger = await prisma.user.create({ data: { username: `web-other-${randomUUID()}`, passwordHash: "test" } });
  const character = await prisma.character.create({ data: { ownerId: owner.id, name: "合成 Web 角色", basePrompt: "测试", modelConfig: { chatModel: "mock-web", chatApiBaseUrl: `http://127.0.0.1:${(model.address() as {port:number}).port}/v1`, chatApiKey: "test", memoryAssistantEnabled: false }, memoryScopes: { create: { scopeType: "CHARACTER_GLOBAL", scopeKey: `web-test:${randomUUID()}` } } } });
  const foreign = await prisma.character.create({ data: { ownerId: stranger.id, name: "其他角色", basePrompt: "测试" } });
  const knowledge = await prisma.knowledgeItem.create({ data: { characterId: character.id, title: "番茄育苗", content: "需要通风", category: "GENERAL", sourceType: "MANUAL", tags: [] } });
  await prisma.knowledgeItem.create({ data: { characterId: foreign.id, title: "番茄育苗", content: "FORBIDDEN_FOREIGN_KNOWLEDGE", category: "GENERAL", sourceType: "MANUAL", tags: [] } });
  const session = await createSession({ userId: owner.id });
  const otherSession = await createSession({ userId: stranger.id });
  const app = createApp(); const router = createRouter(); router.post("/characters/:id/chat", handler); app.use(router); api.on("request", toNodeListener(app));
  api.listen(0, "127.0.0.1"); await once(api, "listening");
  const requestKey = randomUUID();
  const request = async (token?: string) => fetch(`http://127.0.0.1:${(api.address() as {port:number}).port}/characters/${character.id}/chat`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { cookie: `yiling_session=${token}` } : {}) }, body: JSON.stringify({ message: "番茄育苗", requestKey }) });
  assert.equal((await request()).status, 401);
  assert.equal((await request(otherSession.token)).status, 404);
  const response = await request(session.token); const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.equal((await request(session.token)).status, 200);
  assert.equal(calls, 1, "Idempotent replay must not read/generate another turn");
  const usage = await prisma.modelUsage.findFirstOrThrow({ where: { characterId: character.id, kind: "chat" } });
  const detail = readModelTurnDetail((usage.metadata as {turnDetail?:unknown}).turnDetail)!;
  assert.equal(detail.channel, "web");
  assert.equal(detail.collaboration?.stages.find(s => s.stage === "knowledge")?.logicalCalls, 1);
  assert.equal(detail.collaboration?.stages.find(s => s.stage === "knowledge")?.operations[0]?.reportedAttempts, 0);
  assert.deepEqual(detail.growthReads?.find(r => r.domain === "knowledge")?.provided.map(r => r.id), [knowledge.id]);
  assert.equal(detail.response.status, "success");
  assert.equal(promptPayloads[0]?.selfUnderstanding, undefined, "Ordinary question must not build cognition context");
  const preference = await prisma.characterPreference.create({ data: { characterId: character.id, kind: "LIKE", topic: "园艺", reason: "人工确认", status: "ACTIVE" } });
  const pending = await prisma.characterPreference.create({ data: { characterId: character.id, kind: "LIKE", topic: "PENDING_SELF_SENTINEL", reason: "候选", status: "PENDING" } });
  const selfResponse = await fetch(`http://127.0.0.1:${(api.address() as {port:number}).port}/characters/${character.id}/chat`, {
    method: "POST", headers: { "content-type": "application/json", cookie: `yiling_session=${session.token}` },
    body: JSON.stringify({ message: "你对自己的认识是什么？", conversationId: body.conversationId, requestKey: randomUUID(), selfUnderstanding: { identity: { name: "CLIENT_FORGED_IDENTITY" } } }),
  });
  const selfBody = await selfResponse.json();
  assert.equal(selfResponse.status, 201, JSON.stringify(selfBody));
  assert.equal(calls, 2, "Self view must not add another model call");
  const selfView = promptPayloads[1]?.selfUnderstanding;
  assert.equal(selfView?.identity.name, "合成 Web 角色");
  assert(selfView.evidence.some(row => row.id === preference.id));
  assert(!selfView.evidence.some(row => row.id === pending.id));
  const saved = await prisma.message.findUniqueOrThrow({ where: { id: selfBody.assistantMessage.id } });
  const references = (saved.metadata as {providedSelfUnderstandingSources?: Array<{id:string;excerpt?:string}>}).providedSelfUnderstandingSources;
  assert(references?.some(row => row.id === preference.id));
  assert(references.every(row => row.excerpt === undefined));
  assert.equal(await prisma.characterPreference.count({ where: { characterId: character.id } }), 2, "Self interpretation cannot write new preferences");
  const follow = async (message: string) => {
    const response = await fetch(`http://127.0.0.1:${(api.address() as {port:number}).port}/characters/${character.id}/chat`, {
      method: "POST", headers: { "content-type": "application/json", cookie: `yiling_session=${session.token}` },
      body: JSON.stringify({ message, conversationId: body.conversationId, requestKey: randomUUID() }),
    });
    const result = await response.json(); assert.equal(response.status, 201, JSON.stringify(result)); return result;
  };
  const followed = await follow("这段时间有什么变化？有没有具体的经历能说明？");
  assert(promptPayloads[2]?.selfUnderstanding?.evidence.some(row => row.id === preference.id), "Omitted subject must inherit only the preceding self reply");
  const followedMessage = await prisma.message.findUniqueOrThrow({ where: { id: followed.assistantMessage.id } });
  assert(Array.isArray((followedMessage.metadata as {providedSelfUnderstandingSources?:unknown}).providedSelfUnderstandingSources));
  await follow("最近天气有什么变化？");
  assert.equal(promptPayloads[3]?.selfUnderstanding, undefined, "An unrelated topic must not inherit a self subject");
  await follow("最近有什么变化？");
  assert.equal(promptPayloads[4]?.selfUnderstanding, undefined, "An ordinary intervening reply ends self continuity");
  assert.equal(calls, 5);
  console.log("Web HTTP collaboration passed: auth, isolation, diagnostics, idempotency, trusted self view and bounded follow-up continuity without topic contamination.");
} finally {
  if (api.listening) await new Promise<void>(resolve => api.close(() => resolve()));
  if (model.listening) await new Promise<void>(resolve => model.close(() => resolve()));
  await prisma.$disconnect();
}
