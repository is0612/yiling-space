import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { createApp, createRouter, readBody, toNodeListener } from "h3";
import { createSession } from "../server/utils/auth";
import { getPrisma } from "../server/utils/prisma";
import { processNextKnowledgeTopicRun } from "../server/utils/knowledge-topic-worker";

const database = new URL(process.env.DATABASE_URL ?? "");
assert(["localhost", "127.0.0.1", "[::1]"].includes(database.hostname));
assert.match(database.pathname, /^\/yiling_knowledge_topic_test_[a-f0-9]{32}$/,
  "Run through test:knowledge-topic-isolated only.");

(globalThis as Record<string, unknown>).defineEventHandler = (handler: unknown) => handler;
(globalThis as Record<string, unknown>).readBody = readBody;
(globalThis as Record<string, unknown>).createError = (await import("h3")).createError;

const createRun = (await import("../server/api/characters/[id]/growth/knowledge/topics/runs.post")).default;
const acceptSuggestion = (await import("../server/api/characters/[id]/growth/knowledge/topics/suggestions/[suggestionId]/accept.post")).default;
const dismissSuggestion = (await import("../server/api/characters/[id]/growth/knowledge/topics/suggestions/[suggestionId]/dismiss.post")).default;
const listTopics = (await import("../server/api/characters/[id]/growth/knowledge/topics/index.get")).default;
const getTopic = (await import("../server/api/characters/[id]/growth/knowledge/topics/[topicId].get")).default;
const listRuns = (await import("../server/api/characters/[id]/growth/knowledge/topics/runs.get")).default;
const getRun = (await import("../server/api/characters/[id]/growth/knowledge/topics/runs/[runId].get")).default;
const createTopic = (await import("../server/api/characters/[id]/growth/knowledge/topics/index.post")).default;
const patchTopic = (await import("../server/api/characters/[id]/growth/knowledge/topics/[topicId].patch")).default;
const addTopicMembers = (await import("../server/api/characters/[id]/growth/knowledge/topics/[topicId]/members/index.post")).default;
const removeTopicMember = (await import("../server/api/characters/[id]/growth/knowledge/topics/[topicId]/members/[itemId].delete")).default;
const splitTopic = (await import("../server/api/characters/[id]/growth/knowledge/topics/[topicId]/split.post")).default;
const mergeTopic = (await import("../server/api/characters/[id]/growth/knowledge/topics/[topicId]/merge.post")).default;
const listTopicRevisions = (await import("../server/api/characters/[id]/growth/knowledge/topics/[topicId]/revisions.get")).default;
const getTopicRevision = (await import("../server/api/characters/[id]/growth/knowledge/topics/[topicId]/revisions/[revision].get")).default;
const restoreTopicRevision = (await import("../server/api/characters/[id]/growth/knowledge/topics/[topicId]/revisions/[revision]/restore.post")).default;
const revertTopicRevision = (await import("../server/api/characters/[id]/growth/knowledge/topics/[topicId]/revert.post")).default;
const prisma = getPrisma();
const ownerId = randomUUID();
const otherOwnerId = randomUUID();
const characterId = randomUUID();
const otherCharacterId = randomUUID();
const app = createApp();
const router = createRouter();
router.post("/characters/:id/growth/knowledge/topics/runs", createRun);
router.post("/characters/:id/growth/knowledge/topics/suggestions/:suggestionId/accept", acceptSuggestion);
router.post("/characters/:id/growth/knowledge/topics/suggestions/:suggestionId/dismiss", dismissSuggestion);
router.get("/characters/:id/growth/knowledge/topics", listTopics);
router.get("/characters/:id/growth/knowledge/topics/:topicId", getTopic);
router.get("/characters/:id/growth/knowledge/topics/runs", listRuns);
router.get("/characters/:id/growth/knowledge/topics/runs/:runId", getRun);
router.post("/characters/:id/growth/knowledge/topics", createTopic);
router.patch("/characters/:id/growth/knowledge/topics/:topicId", patchTopic);
router.post("/characters/:id/growth/knowledge/topics/:topicId/members", addTopicMembers);
router.delete("/characters/:id/growth/knowledge/topics/:topicId/members/:itemId", removeTopicMember);
router.post("/characters/:id/growth/knowledge/topics/:topicId/split", splitTopic);
router.post("/characters/:id/growth/knowledge/topics/:topicId/merge", mergeTopic);
router.get("/characters/:id/growth/knowledge/topics/:topicId/revisions", listTopicRevisions);
router.get("/characters/:id/growth/knowledge/topics/:topicId/revisions/:revision", getTopicRevision);
router.post("/characters/:id/growth/knowledge/topics/:topicId/revisions/:revision/restore", restoreTopicRevision);
router.post("/characters/:id/growth/knowledge/topics/:topicId/revert", revertTopicRevision);
app.use(router);
const api = createServer(toNodeListener(app));

let holdNextModelCall: { signal: () => void; wait: Promise<void> } | null = null;
let failNextModelCall = false;
let modelCalls = 0;
const model = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const payload = JSON.parse(raw) as { messages?: Array<{ content?: string }> };
  const input = JSON.parse(payload.messages?.at(-1)?.content ?? "{}") as { knowledge?: Array<{ itemId: string }> };
  const ids = (input.knowledge ?? []).map(item => item.itemId);
  modelCalls++;
  const held = holdNextModelCall;
  if (held) {
    holdNextModelCall = null;
    held.signal();
    await held.wait;
  }
  if (failNextModelCall) {
    failNextModelCall = false;
    response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "temporary" }));
    return;
  }
  const topics = ids.length >= 2
    ? [{ name: "测试主题", description: "测试说明", reason: "测试理由", itemIds: ids.slice(0, 2) }]
    : [];
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ topics, ungroupedIds: ids.slice(2) }) } }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  }));
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
const modelUrl = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;
let session!: Awaited<ReturnType<typeof createSession>>;
let otherSession!: Awaited<ReturnType<typeof createSession>>;

async function getRequest(path: string, cookie?: string) {
  const response = await fetch(`http://127.0.0.1:${(api.address() as { port: number }).port}${path}`, {
    method: "GET",
    headers: cookie ? { cookie: `yiling_session=${cookie}` } : {},
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, any> : {} };
}
async function request(path: string, body?: Record<string, unknown>, cookie?: string) {
  const response = await fetch(`http://127.0.0.1:${(api.address() as { port: number }).port}${path}`, {
    method: "POST",
    headers: {
      ...(cookie ? { cookie: `yiling_session=${cookie}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, any> : {} };
}
async function mutate(path: string, method: "PATCH" | "DELETE", body?: Record<string, unknown>, cookie?: string) {
  const response = await fetch(`http://127.0.0.1:${(api.address() as { port: number }).port}${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie: `yiling_session=${cookie}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, any> : {} };
}
const runPath = `/characters/${characterId}/growth/knowledge/topics/runs`;
async function newRun(ids: string[]) {
  const result = await request(runPath, { itemIds: ids }, session.token);
  assert.equal(result.status, 202, JSON.stringify(result.body));
  return result.body.run.id as string;
}
async function makeItems(targetCharacterId: string, prefix: string, count = 2) {
  return Promise.all(Array.from({ length: count }, (_, index) => prisma.knowledgeItem.create({
    data: {
      characterId: targetCharacterId, title: `${prefix}-${index}`, content: `${prefix} 正文 ${index}`,
      category: "GENERAL", tags: ["topic-test"], sourceType: "MANUAL",
    },
  })));
}
async function runWorker() {
  return processNextKnowledgeTopicRun(prisma, { workerId: `topic-test-${randomUUID()}` });
}
function holdModelOnce() {
  let signal!: () => void;
  let release!: () => void;
  const reached = new Promise<void>(resolve => { signal = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  holdNextModelCall = { signal, wait };
  return { reached, release };
}

try {
  await prisma.user.createMany({ data: [
    { id: ownerId, username: `topic-owner-${ownerId.slice(0, 8)}`, passwordHash: "test-only" },
    { id: otherOwnerId, username: `topic-other-${otherOwnerId.slice(0, 8)}`, passwordHash: "test-only" },
  ] });
  session = await createSession({ userId: ownerId });
  otherSession = await createSession({ userId: otherOwnerId });
  await prisma.character.createMany({ data: [
    {
      id: characterId, ownerId, name: "主题聚类测试角色", basePrompt: "test",
      modelConfig: { chatModel: "topic-test-model", chatApiBaseUrl: modelUrl, chatApiKey: "topic-test-key" },
    },
    { id: otherCharacterId, ownerId: otherOwnerId, name: "其他用户角色", basePrompt: "test" },
  ] });
  const normalItems = await makeItems(characterId, "正常知识");
  const a = normalItems[0]!;
  const b = normalItems[1]!;
  const foreign = (await makeItems(otherCharacterId, "其他角色知识", 1))[0]!;

  api.listen(0, "127.0.0.1");
  await once(api, "listening");

  // Authentication, ownership, payload shape, status and character isolation.
  assert.equal((await request(runPath, { itemIds: [a.id, b.id] })).status, 401);
  assert.equal((await request(runPath, { itemIds: [a.id, b.id] }, otherSession.token)).status, 404);
  assert.equal((await request(runPath, { itemIds: [a.id, a.id] }, session.token)).status, 400);
  assert.equal((await request(runPath, { itemIds: [a.id, foreign.id] }, session.token)).status, 409);
  await prisma.knowledgeItem.update({ where: { id: foreign.id }, data: { status: "ARCHIVED" } });
  assert.equal((await request(runPath, { itemIds: [a.id, foreign.id] }, session.token)).status, 409);
  await prisma.knowledgeItem.update({ where: { id: foreign.id }, data: { status: "ACTIVE" } });

  // Successful request stores an immutable item/revision snapshot and returns 202.
  const readyRunId = await newRun([a.id, b.id]);
  const snapshotRun = await prisma.knowledgeTopicRun.findUniqueOrThrow({ where: { id: readyRunId } });
  assert.equal(snapshotRun.status, "QUEUED");
  assert.deepEqual(snapshotRun.inputSnapshot, [
    { itemId: a.id, revision: 1 }, { itemId: b.id, revision: 1 },
  ]);

  // Worker persists suggestions atomically and releases its lease on success.
  const ready = await runWorker();
  assert.equal(ready.status, "READY", JSON.stringify(ready));
  const readyAfter = await prisma.knowledgeTopicRun.findUniqueOrThrow({ where: { id: readyRunId } });
  assert.equal(readyAfter.status, "READY");
  assert.equal(readyAfter.attemptCount, 1);
  assert.equal(readyAfter.fencingToken, 1);
  assert.equal(readyAfter.leaseToken, null);
  const suggestions = await prisma.knowledgeTopicSuggestion.findMany({ where: { runId: readyRunId } });
  assert.equal(suggestions.length, 1);
  assert.deepEqual(suggestions[0]!.memberItemIds, [a.id, b.id]);
  assert.equal(suggestions[0]!.status, "PENDING");

  // Suggestion review: owner isolation, atomic CREATE, partial APPLY, immutable revisions and dismissal.
  const suggestionId = suggestions[0]!.id;
  const acceptPath = (id: string) => `/characters/${characterId}/growth/knowledge/topics/suggestions/${id}/accept`;
  const dismissPath = (id: string) => `/characters/${characterId}/growth/knowledge/topics/suggestions/${id}/dismiss`;
  assert.equal((await request(acceptPath(suggestionId), { mode: "CREATE" }, otherSession.token)).status, 404);
  const [createAcceptA, createAcceptB] = await Promise.all([
    request(acceptPath(suggestionId), { mode: "CREATE" }, session.token),
    request(acceptPath(suggestionId), { mode: "CREATE" }, session.token),
  ]);
  assert.deepEqual([createAcceptA.status, createAcceptB.status].sort(), [200, 409]);
  const createdTopicResult = createAcceptA.status === 200 ? createAcceptA : createAcceptB;
  const createdTopicId = (createdTopicResult.body.topic as { id: string }).id;
  const createdTopic = await prisma.knowledgeTopic.findUniqueOrThrow({
    where: { id: createdTopicId }, include: { members: true },
  });
  assert.equal(createdTopic.name, "测试主题");
  assert.equal(createdTopic.members.length, 2);
  const acceptedSuggestion = await prisma.knowledgeTopicSuggestion.findUniqueOrThrow({ where: { id: suggestionId } });
  assert.equal(acceptedSuggestion.status, "ACCEPTED");
  assert.deepEqual(acceptedSuggestion.acceptedMemberItemIds, [a.id, b.id]);
  assert.equal((await request(acceptPath(suggestionId), { mode: "CREATE" }, session.token)).status, 409);
  // Read APIs expose only this character's topic/run data and current member validity.
  const topicsList = await getRequest(`/characters/${characterId}/growth/knowledge/topics?status=ACTIVE`, session.token);
  assert.equal(topicsList.status, 200);
  assert.ok((topicsList.body.topics as Array<{ id: string; memberCount: number }>).some(topic =>
    topic.id === createdTopicId && topic.memberCount === 2));
  assert.equal((await getRequest(`/characters/${characterId}/growth/knowledge/topics`, otherSession.token)).status, 404);
  const topicDetail = await getRequest(`/characters/${characterId}/growth/knowledge/topics/${createdTopicId}`, session.token);
  assert.equal(topicDetail.status, 200);
  assert.equal((topicDetail.body.topic as { members: unknown[] }).members.length, 2);
  assert.equal((await getRequest(`/characters/${characterId}/growth/knowledge/topics/${createdTopicId}`, otherSession.token)).status, 404);
  // Even inconsistent legacy membership must not expose another character's knowledge body.
  const isolatedTopic = await prisma.knowledgeTopic.create({
    data: {
      characterId, name: "隔离防护主题",
      members: { create: { itemId: foreign.id, itemRevision: 1 } },
    },
  });
  const isolatedDetail = await getRequest(`/characters/${characterId}/growth/knowledge/topics/${isolatedTopic.id}`, session.token);
  const isolatedMember = (isolatedDetail.body.topic as { members: Array<{ valid: boolean; item: unknown; invalidReason: string }> }).members[0]!;
  assert.equal(isolatedMember.valid, false);
  assert.equal(isolatedMember.item, null);
  assert.equal(isolatedMember.invalidReason, "NOT_IN_CHARACTER");
  const runList = await getRequest(`/characters/${characterId}/growth/knowledge/topics/runs?status=READY`, session.token);
  assert.equal(runList.status, 200);
  assert.ok((runList.body.runs as Array<{ id: string }>).some(run => run.id === readyRunId));
  const runDetail = await getRequest(`/characters/${characterId}/growth/knowledge/topics/runs/${readyRunId}`, session.token);
  assert.equal(runDetail.status, 200);
  assert.equal((runDetail.body.run as { suggestions: unknown[] }).suggestions.length, 1);
  assert.equal((await getRequest(`/characters/${characterId}/growth/knowledge/topics/runs/${readyRunId}`, otherSession.token)).status, 404);


  const applyItems = await makeItems(characterId, "部分采纳知识");
  const applyRunId = await newRun(applyItems.map(row => row.id));
  assert.equal((await runWorker()).status, "READY");
  const applySuggestion = await prisma.knowledgeTopicSuggestion.findFirstOrThrow({ where: { runId: applyRunId } });
  const existingTopic = await prisma.knowledgeTopic.create({
    data: {
      characterId, name: "已有主题", description: "已有说明",
      members: { create: [{ itemId: a.id, itemRevision: 1 }] },
    },
  });
  assert.equal((await request(acceptPath(applySuggestion.id), {
    mode: "APPLY", topicId: existingTopic.id, memberItemIds: [foreign.id],
  }, session.token)).status, 400);
  const applied = await request(acceptPath(applySuggestion.id), {
    mode: "APPLY", topicId: existingTopic.id, memberItemIds: [applyItems[0]!.id],
  }, session.token);
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.deepEqual(applied.body.acceptedMemberItemIds, [applyItems[0]!.id]);
  const updatedTopic = await prisma.knowledgeTopic.findUniqueOrThrow({
    where: { id: existingTopic.id }, include: { members: true, revisions: true },
  });
  assert.equal(updatedTopic.revision, 2);
  assert.equal(updatedTopic.members.length, 2);
  assert.equal(updatedTopic.revisions.length, 1);
  assert.equal(updatedTopic.revisions[0]!.revision, 1);
  assert.deepEqual(acceptedSuggestion.acceptedMemberItemIds, [a.id, b.id]);

  const dismissItems = await makeItems(characterId, "忽略建议知识");
  const dismissRunId = await newRun(dismissItems.map(row => row.id));
  assert.equal((await runWorker()).status, "READY");
  const dismissSuggestion = await prisma.knowledgeTopicSuggestion.findFirstOrThrow({ where: { runId: dismissRunId } });
  const dismissed = await request(dismissPath(dismissSuggestion.id), {}, session.token);
  assert.equal(dismissed.status, 200, JSON.stringify(dismissed.body));
  assert.equal(dismissed.body.status, "DISMISSED");
  assert.equal((await prisma.knowledgeTopicSuggestion.findUniqueOrThrow({ where: { id: dismissSuggestion.id } })).status, "DISMISSED");
  assert.equal((await request(dismissPath(dismissSuggestion.id), {}, session.token)).status, 409);

  const staleReviewItems = await makeItems(characterId, "过期审核知识");
  const staleReviewRunId = await newRun(staleReviewItems.map(row => row.id));
  assert.equal((await runWorker()).status, "READY");
  const staleReviewSuggestion = await prisma.knowledgeTopicSuggestion.findFirstOrThrow({ where: { runId: staleReviewRunId } });
  await prisma.knowledgeItem.update({ where: { id: staleReviewItems[0]!.id }, data: { revision: 2 } });
  assert.equal((await request(acceptPath(staleReviewSuggestion.id), { mode: "CREATE" }, session.token)).status, 409);
  assert.equal((await prisma.knowledgeTopicSuggestion.findUniqueOrThrow({ where: { id: staleReviewSuggestion.id } })).status, "PENDING");

  // Manual topic management: create, edit, archive/restore, add/remove members and revision snapshots.
  const manualItems = await makeItems(characterId, "手动主题成员");
  const manualCreate = await request(`/characters/${characterId}/growth/knowledge/topics`, {
    name: "手动主题", description: "初始说明",
  }, session.token);
  assert.equal(manualCreate.status, 200, JSON.stringify(manualCreate.body));
  const manualTopicId = (manualCreate.body.topic as { id: string; revision: number }).id;
  assert.equal((manualCreate.body.topic as { revision: number }).revision, 1);
  assert.equal((await request(`/characters/${characterId}/growth/knowledge/topics`, {
    name: "   ",
  }, session.token)).status, 400);
  assert.equal((await request(`/characters/${characterId}/growth/knowledge/topics`, {
    name: "越权主题",
  }, otherSession.token)).status, 404);
  const edited = await mutate(`/characters/${characterId}/growth/knowledge/topics/${manualTopicId}`, "PATCH", {
    name: "编辑后的主题", description: "编辑后的说明", revision: 1,
  }, session.token);
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal((edited.body.topic as { revision: number }).revision, 2);
  assert.equal((await mutate(`/characters/${characterId}/growth/knowledge/topics/${manualTopicId}`, "PATCH", {
    name: "过期覆盖", revision: 1,
  }, session.token)).status, 409);
  const archived = await mutate(`/characters/${characterId}/growth/knowledge/topics/${manualTopicId}`, "PATCH", {
    status: "ARCHIVED", revision: 2,
  }, session.token);
  assert.equal(archived.status, 200);
  assert.equal((archived.body.topic as { status: string; revision: number }).status, "ARCHIVED");
  assert.equal((archived.body.topic as { revision: number }).revision, 3);
  assert.equal((await request(`/characters/${characterId}/growth/knowledge/topics/${manualTopicId}/members`, {
    itemIds: [manualItems[0]!.id], revision: 3,
  }, session.token)).status, 409);
  const restored = await mutate(`/characters/${characterId}/growth/knowledge/topics/${manualTopicId}`, "PATCH", {
    status: "ACTIVE", revision: 3,
  }, session.token);
  assert.equal(restored.status, 200);
  assert.equal((restored.body.topic as { revision: number }).revision, 4);
  const added = await request(`/characters/${characterId}/growth/knowledge/topics/${manualTopicId}/members`, {
    itemIds: [manualItems[0]!.id], revision: 4,
  }, session.token);
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.deepEqual(added.body.addedItemIds, [manualItems[0]!.id]);
  assert.equal(added.body.revision, 5);
  const duplicateAdd = await request(`/characters/${characterId}/growth/knowledge/topics/${manualTopicId}/members`, {
    itemIds: [manualItems[0]!.id], revision: 5,
  }, session.token);
  assert.equal(duplicateAdd.status, 200);
  assert.equal(duplicateAdd.body.revision, 5);
  assert.equal((await request(`/characters/${characterId}/growth/knowledge/topics/${manualTopicId}/members`, {
    itemIds: [foreign.id], revision: 5,
  }, session.token)).status, 409);
  const removed = await mutate(`/characters/${characterId}/growth/knowledge/topics/${manualTopicId}/members/${manualItems[0]!.id}`, "DELETE", {
    revision: 5,
  }, session.token);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.revision, 6);
  assert.equal((await mutate(`/characters/${characterId}/growth/knowledge/topics/${manualTopicId}/members/${manualItems[0]!.id}`, "DELETE", {
    revision: 6,
  }, session.token)).status, 404);
  const manualAfter = await prisma.knowledgeTopic.findUniqueOrThrow({
    where: { id: manualTopicId }, include: { members: true, revisions: { orderBy: { revision: "asc" } } },
  });
  assert.equal(manualAfter.name, "编辑后的主题");
  assert.equal(manualAfter.members.length, 0);
  assert.equal(manualAfter.revision, 6);
  assert.equal(manualAfter.revisions.length, 5);
  assert.deepEqual(manualAfter.revisions.map(row => row.revision), [1, 2, 3, 4, 5]);

  const historyPath = `/characters/${characterId}/growth/knowledge/topics/${manualTopicId}/revisions`;
  const history = await getRequest(historyPath, session.token);
  assert.equal(history.status, 200, JSON.stringify(history.body));
  assert.equal((history.body.revisions as Array<{ revision: number }>).length, 5);
  const historicalDetail = await getRequest(`${historyPath}/1`, session.token);
  assert.equal(historicalDetail.status, 200, JSON.stringify(historicalDetail.body));
  assert.equal((historicalDetail.body.snapshot as { name: string }).name, "手动主题");
  assert.equal((await getRequest(`${historyPath}/1`, otherSession.token)).status, 404);
  const restoredHistory = await request(`${historyPath}/1/restore`, { expectedRevision: 6 }, session.token);
  assert.equal(restoredHistory.status, 200, JSON.stringify(restoredHistory.body));
  assert.equal((restoredHistory.body.topic as { name: string; revision: number }).name, "手动主题");
  assert.equal((restoredHistory.body.topic as { revision: number }).revision, 7);
  assert.equal((await request(`${historyPath}/1/restore`, { expectedRevision: 6 }, session.token)).status, 409);
  const afterHistoryRestore = await prisma.knowledgeTopic.findUniqueOrThrow({
    where: { id: manualTopicId }, include: { members: true, revisions: true },
  });
  assert.equal(afterHistoryRestore.revision, 7);
  assert.equal(afterHistoryRestore.name, "手动主题");
  assert.equal(afterHistoryRestore.revisions.length, 6);

  assert.equal((await mutate(`/characters/${characterId}/growth/knowledge/topics/${manualTopicId}`, "PATCH", {
    name: "越权", revision: 7,
  }, otherSession.token)).status, 404);

  // Topic split and merge: membership is moved, both operations are revision-guarded and auditable.
  const splitItems = await makeItems(characterId, "主题拆分合并", 3);
  const splitSource = await prisma.knowledgeTopic.create({
    data: {
      characterId, name: "拆分前主题", description: "原主题说明",
      members: { create: splitItems.map(item => ({ itemId: item.id, itemRevision: item.revision })) },
    },
  });
  const splitPath = `/characters/${characterId}/growth/knowledge/topics/${splitSource.id}/split`;
  assert.equal((await request(splitPath, {
    name: "拆分子主题", description: "拆分说明",
    memberItemIds: [splitItems[0]!.id], revision: 1,
  }, otherSession.token)).status, 404);
  assert.equal((await request(splitPath, {
    name: "拆分子主题", memberItemIds: [splitItems[0]!.id], revision: 99,
  }, session.token)).status, 409);
  const splitResult = await request(splitPath, {
    name: "拆分子主题", description: "拆分说明",
    memberItemIds: [splitItems[0]!.id], revision: 1,
  }, session.token);
  assert.equal(splitResult.status, 200, JSON.stringify(splitResult.body));
  const splitNewId = (splitResult.body.newTopic as { id: string; revision: number }).id;
  assert.equal((splitResult.body.newTopic as { revision: number }).revision, 1);
  assert.deepEqual(splitResult.body.movedItemIds, [splitItems[0]!.id]);
  assert.deepEqual(
    [...(splitResult.body.remainingItemIds as string[])].sort(),
    [splitItems[1]!.id, splitItems[2]!.id].sort(),
  );
  const splitSourceAfter = await prisma.knowledgeTopic.findUniqueOrThrow({
    where: { id: splitSource.id }, include: { members: true, revisions: true },
  });
  const splitNewTopic = await prisma.knowledgeTopic.findUniqueOrThrow({
    where: { id: splitNewId }, include: { members: true },
  });
  assert.equal(splitSourceAfter.revision, 2);
  assert.equal(splitSourceAfter.members.length, 2);
  assert.equal(splitSourceAfter.revisions.length, 1);
  assert.equal(splitSourceAfter.revisions[0]!.revision, 1);
  assert.deepEqual(splitNewTopic.members.map(member => member.itemId), [splitItems[0]!.id]);
  assert.equal((await request(splitPath, {
    name: "不能全拆", memberItemIds: [splitItems[1]!.id, splitItems[2]!.id], revision: 2,
  }, session.token)).status, 400);

  const mergeTarget = await prisma.knowledgeTopic.create({
    data: {
      characterId, name: "合并目标主题",
      members: { create: { itemId: splitItems[2]!.id, itemRevision: splitItems[2]!.revision } },
    },
  });
  const mergePath = `/characters/${characterId}/growth/knowledge/topics/${splitSource.id}/merge`;
  assert.equal((await request(mergePath, {
    targetTopicId: mergeTarget.id, sourceRevision: 2, targetRevision: 99,
  }, session.token)).status, 409);
  assert.equal((await prisma.knowledgeTopic.findUniqueOrThrow({ where: { id: splitSource.id } })).status, "ACTIVE");
  assert.equal((await request(mergePath, {
    targetTopicId: splitSource.id, sourceRevision: 2, targetRevision: 2,
  }, session.token)).status, 400);
  assert.equal((await request(mergePath, {
    targetTopicId: mergeTarget.id, sourceRevision: 2, targetRevision: 1,
  }, otherSession.token)).status, 404);
  const merged = await request(mergePath, {
    targetTopicId: mergeTarget.id, sourceRevision: 2, targetRevision: 1,
  }, session.token);
  assert.equal(merged.status, 200, JSON.stringify(merged.body));
  assert.equal((merged.body.sourceTopic as { status: string; revision: number; mergedIntoId: string }).status, "MERGED");
  assert.equal((merged.body.sourceTopic as { revision: number }).revision, 3);
  assert.equal((merged.body.sourceTopic as { mergedIntoId: string }).mergedIntoId, mergeTarget.id);
  assert.deepEqual(merged.body.addedItemIds, [splitItems[1]!.id]);
  assert.deepEqual(merged.body.alreadyPresentItemIds, [splitItems[2]!.id]);
  const mergeSourceAfter = await prisma.knowledgeTopic.findUniqueOrThrow({
    where: { id: splitSource.id }, include: { members: true, revisions: true },
  });
  const mergeTargetAfter = await prisma.knowledgeTopic.findUniqueOrThrow({
    where: { id: mergeTarget.id }, include: { members: true, revisions: true },
  });
  assert.equal(mergeSourceAfter.members.length, 2, "merged source retains its members for audit");
  assert.equal(mergeSourceAfter.revisions.length, 2);
  assert.equal(mergeTargetAfter.members.length, 2);
  assert.equal(mergeTargetAfter.revision, 2);
  assert.equal(mergeTargetAfter.revisions.length, 1);

  // Grouped history makes merge rollback atomic across source and target.
  const operationHistoryPath = `/characters/${characterId}/growth/knowledge/topics/${splitSource.id}/revisions`;
  const operationHistory = await getRequest(operationHistoryPath, session.token);
  assert.equal(operationHistory.status, 200, JSON.stringify(operationHistory.body));
  const mergeHistory = (operationHistory.body.revisions as Array<{ id: string; action: string; revision: number }>)
    .find(row => row.action === "MERGE");
  assert.ok(mergeHistory, "merge revision should be visible in history");
  assert.equal((await request(operationHistoryPath, undefined, otherSession.token)).status, 404);
  const revertPath = `/characters/${characterId}/growth/knowledge/topics/${splitSource.id}/revert`;
  const revertedMerge = await request(revertPath, {
    revisionId: mergeHistory.id, expectedRevision: 3,
  }, session.token);
  assert.equal(revertedMerge.status, 200, JSON.stringify(revertedMerge.body));
  const sourceAfterMergeRevert = await prisma.knowledgeTopic.findUniqueOrThrow({
    where: { id: splitSource.id }, include: { members: true },
  });
  const targetAfterMergeRevert = await prisma.knowledgeTopic.findUniqueOrThrow({
    where: { id: mergeTarget.id }, include: { members: true },
  });
  assert.equal(sourceAfterMergeRevert.status, "ACTIVE");
  assert.equal(sourceAfterMergeRevert.members.length, 2);
  assert.equal(targetAfterMergeRevert.members.length, 1);
  assert.equal(targetAfterMergeRevert.revision, 3);
  assert.equal((await request(revertPath, {
    revisionId: mergeHistory.id, expectedRevision: 4,
  }, session.token)).status, 409, "the same merge snapshot cannot be replayed");

  // Split rollback restores the source and archives the operation-created topic.
  const rollbackItems = await makeItems(characterId, "主题拆分撤销", 2);
  const rollbackSource = await prisma.knowledgeTopic.create({
    data: {
      characterId, name: "待撤销拆分主题",
      members: { create: rollbackItems.map(item => ({ itemId: item.id, itemRevision: item.revision })) },
    },
  });
  const rollbackSplit = await request(
    `/characters/${characterId}/growth/knowledge/topics/${rollbackSource.id}/split`,
    { name: "待归档拆分主题", memberItemIds: [rollbackItems[0]!.id], revision: 1 },
    session.token,
  );
  assert.equal(rollbackSplit.status, 200, JSON.stringify(rollbackSplit.body));
  const rollbackNewId = (rollbackSplit.body.newTopic as { id: string }).id;
  const rollbackHistory = await getRequest(
    `/characters/${characterId}/growth/knowledge/topics/${rollbackSource.id}/revisions`, session.token,
  );
  const splitHistory = (rollbackHistory.body.revisions as Array<{ id: string; action: string }>)
    .find(row => row.action === "SPLIT");
  assert.ok(splitHistory);
  const splitReverted = await request(
    `/characters/${characterId}/growth/knowledge/topics/${rollbackSource.id}/revert`,
    { revisionId: splitHistory.id, expectedRevision: 2 },
    session.token,
  );
  assert.equal(splitReverted.status, 200, JSON.stringify(splitReverted.body));
  const restoredSplitSource = await prisma.knowledgeTopic.findUniqueOrThrow({
    where: { id: rollbackSource.id }, include: { members: true },
  });
  const archivedSplitTopic = await prisma.knowledgeTopic.findUniqueOrThrow({
    where: { id: rollbackNewId }, include: { members: true },
  });
  assert.equal(restoredSplitSource.members.length, 2);
  assert.equal(archivedSplitTopic.status, "ARCHIVED");
  assert.equal(archivedSplitTopic.members.length, 0);
  assert.equal((await mutate(`/characters/${characterId}/growth/knowledge/topics/${splitSource.id}`, "PATCH", {
    name: "不允许编辑已合并主题", revision: 3,
  }, session.token)).status, 409);

  // Revision changes before execution make the run STALE without calling the model.
  const beforeStaleCalls = modelCalls;
  const staleBeforeId = await newRun([a.id, b.id]);
  await prisma.knowledgeItem.update({ where: { id: a.id }, data: { revision: 2 } });
  const staleBefore = await runWorker();
  assert.equal(staleBefore.status, "STALE");
  assert.equal(modelCalls, beforeStaleCalls);
  assert.equal(await prisma.knowledgeTopicSuggestion.count({ where: { runId: staleBeforeId } }), 0);
  await prisma.knowledgeItem.update({ where: { id: a.id }, data: { revision: 1 } });

  // Revision changes while the model is running; the transaction rejects the result.
  const staleDuringId = await newRun([a.id, b.id]);
  const held = holdModelOnce();
  const staleDuringPromise = runWorker();
  await held.reached;
  await prisma.knowledgeItem.update({ where: { id: b.id }, data: { revision: 2 } });
  held.release();
  const staleDuring = await staleDuringPromise;
  assert.equal(staleDuring.status, "STALE", JSON.stringify(staleDuring));
  assert.equal(await prisma.knowledgeTopicSuggestion.count({ where: { runId: staleDuringId } }), 0);
  await prisma.knowledgeItem.update({ where: { id: b.id }, data: { revision: 1 } });

  // Transient model errors are retried with backoff and never leave partial suggestions.
  const retryId = await newRun([a.id, b.id]);
  failNextModelCall = true;
  const failedAttempt = await runWorker();
  assert.equal(failedAttempt.status, "QUEUED", JSON.stringify(failedAttempt));
  const queuedRetry = await prisma.knowledgeTopicRun.findUniqueOrThrow({ where: { id: retryId } });
  assert.equal(queuedRetry.status, "QUEUED");
  assert.equal(queuedRetry.attemptCount, 1);
  assert.equal(queuedRetry.leaseToken, null);
  assert.equal(await prisma.knowledgeTopicSuggestion.count({ where: { runId: retryId } }), 0);
  await prisma.knowledgeTopicRun.update({ where: { id: retryId }, data: { runAt: new Date(0) } });
  const retried = await runWorker();
  assert.equal(retried.status, "READY", JSON.stringify(retried));
  assert.equal((await prisma.knowledgeTopicRun.findUniqueOrThrow({ where: { id: retryId } })).attemptCount, 2);

  // Expired leases are recovered, backed off, and fenced by a new token on the next claim.
  const expiredId = await newRun([a.id, b.id]);
  await prisma.knowledgeTopicRun.update({ where: { id: expiredId }, data: {
    status: "PROCESSING", attemptCount: 1, fencingToken: 1, leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() - 10_000),
  } });
  const recovery = await runWorker();
  assert.equal(recovery.processed, false, JSON.stringify(recovery));
  const recovered = await prisma.knowledgeTopicRun.findUniqueOrThrow({ where: { id: expiredId } });
  assert.equal(recovered.status, "QUEUED");
  assert.equal(recovered.leaseToken, null);
  assert.ok(recovered.runAt.getTime() > Date.now());
  await prisma.knowledgeTopicRun.update({ where: { id: expiredId }, data: { runAt: new Date(0) } });
  const afterRecovery = await runWorker();
  assert.equal(afterRecovery.status, "READY", JSON.stringify(afterRecovery));
  assert.equal((await prisma.knowledgeTopicRun.findUniqueOrThrow({ where: { id: expiredId } })).fencingToken, 2);

  // An old in-flight worker must not overwrite a successor after its lease is reclaimed.
  const fencedId = await newRun([a.id, b.id]);
  const oldGate = holdModelOnce();
  const oldWorker = runWorker();
  await oldGate.reached;
  await prisma.knowledgeTopicRun.update({ where: { id: fencedId }, data: { leaseExpiresAt: new Date(Date.now() - 1_000) } });
  await runWorker(); // reclaim the expired lease; the row is queued with backoff.
  await prisma.knowledgeTopicRun.update({ where: { id: fencedId }, data: { runAt: new Date(0) } });
  const successorGate = holdModelOnce();
  const successorWorker = runWorker();
  await successorGate.reached;
  const successorLease = await prisma.knowledgeTopicRun.findUniqueOrThrow({ where: { id: fencedId } });
  oldGate.release();
  await oldWorker;
  const afterOldWorker = await prisma.knowledgeTopicRun.findUniqueOrThrow({ where: { id: fencedId } });
  assert.equal(afterOldWorker.status, "PROCESSING");
  assert.equal(afterOldWorker.leaseToken, successorLease.leaseToken);
  assert.equal(await prisma.knowledgeTopicSuggestion.count({ where: { runId: fencedId } }), 0);
  successorGate.release();
  const successorResult = await successorWorker;
  assert.equal(successorResult.status, "READY", JSON.stringify(successorResult));
  assert.equal(await prisma.knowledgeTopicSuggestion.count({ where: { runId: fencedId } }), 1);

  // Concurrent workers must claim distinct runs; SKIP LOCKED prevents double claims.
  const [concurrentA, concurrentB] = await Promise.all([
    makeItems(characterId, "并发知识 A"), makeItems(characterId, "并发知识 B"),
  ]);
  const concurrentRunA = await newRun(concurrentA.map(row => row.id));
  const concurrentRunB = await newRun(concurrentB.map(row => row.id));
  const concurrentResults = await Promise.all([runWorker(), runWorker()]);
  assert.equal(concurrentResults.filter(result => result.status === "READY").length, 2, JSON.stringify(concurrentResults));
  assert.equal((await prisma.knowledgeTopicRun.findUniqueOrThrow({ where: { id: concurrentRunA } })).status, "READY");
  assert.equal((await prisma.knowledgeTopicRun.findUniqueOrThrow({ where: { id: concurrentRunB } })).status, "READY");

  console.log("Knowledge topic DB/worker checks passed: API auth and isolation, immutable snapshots, atomic persistence, stale-input rejection, bounded retry, expired lease recovery/fencing, and concurrent claims.");
} finally {
  if (api.listening) await new Promise<void>(resolve => api.close(() => resolve()));
  if (model.listening) await new Promise<void>(resolve => model.close(() => resolve()));
  await prisma.knowledgeTopicSuggestion.deleteMany({ where: { run: { characterId } } }).catch(() => undefined);
  await prisma.knowledgeTopicRun.deleteMany({ where: { characterId } }).catch(() => undefined);
  await prisma.knowledgeItem.deleteMany({ where: { characterId: { in: [characterId, otherCharacterId] } } }).catch(() => undefined);
  await prisma.character.deleteMany({ where: { id: { in: [characterId, otherCharacterId] } } }).catch(() => undefined);
  await prisma.session.deleteMany({ where: { userId: { in: [ownerId, otherOwnerId] } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherOwnerId] } } }).catch(() => undefined);
  await prisma.$disconnect();
}
