import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAssistantTurnContext, type AssistantTurnContext } from "../server/utils/assistant-turn-context";
import { generateGroupContextReply } from "../server/utils/group-context-reply";
import type { ConversationReplyInput } from "../server/utils/chat-reply";
import type { MemoryAssistantRuntime } from "../server/utils/memory-assistant";

const runtime: MemoryAssistantRuntime = { model: "context", apiKey: "context-secret", apiBaseUrl: "https://context.example/v1", temperature: 0.1, maxInputTokens: 16384, maxOutputTokens: 2048 };
const chat: ConversationReplyInput = { groupChat: true, allowSilent: true, characterName: "测试角色", characterPrompt: "自然回复", model: "character", apiKey: "chat-secret", apiBaseUrl: "https://chat.example/v1", thinking: false, currentMessage: "上次说的电影呢", transcript: [{ id: "current", content: "上次说的电影呢" }], recentMessages: [], memories: [], snapshots: [] };
const analysis = { summary: "询问之前的电影", evidenceMessageIds: ["current", "invented"], participation: "invited", memoryQuery: "电影", knowledgeQuery: "电影知识", knowledgeCandidate: { evidenceMessageIds: ["current"], reason: "可复用知识候选" } };
const finalReply = { action: "reply", reply: "那部电影记得。", usedMemoryIds: ["public"], usedSnapshotIds: [], usedEventIds: [], usedRawMessageIds: [] };
const publicSource = { sourceKey: "memory/public", sourceType: "memory" as const, id: "public", scope: "character" as const, relevanceScore: 1, category: "FACT", content: "PUBLIC_EVIDENCE" };
const privateSource = { ...publicSource, sourceKey: "memory/private", id: "private", scope: "private" as const, content: "PRIVATE_MUST_NOT_APPEAR" };
const makeTurn = () => createAssistantTurnContext({ turnId: randomUUID(), identity: { characterId: randomUUID(), channelBindingId: randomUUID(), channel: "qq-group", conversationKey: "g:synthetic", readableScopeIds: [randomUUID()], allowPrivate: false }, evidenceIds: ["current"] });
const logical = (turn: AssistantTurnContext, stage: string) => turn.snapshot().stages.find(row => row.stage === stage)!.logicalCalls;
const originalFetch = globalThis.fetch;
let models: string[] = []; let mode: "success" | "context-fail" | "empty" = "success";
function response(value: unknown) { return Response.json({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }); }
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(String(options?.body)); models.push(body.model);
  assert(!JSON.stringify(body).includes("PRIVATE_MUST_NOT_APPEAR"));
  assert(!JSON.stringify(body).includes("readableScopeIds"));
  assert(!JSON.stringify(body).includes("MUTATED_UNTRUSTED_ROUND"));
  if (body.model === "context") return mode === "context-fail" ? new Response("error", { status: 503 }) : response(analysis);
  if (body.model === "memory") return response({ sourceKeys: mode === "empty" ? [] : ["memory/public", "memory/private"] });
  if (mode === "context-fail" && models.filter(model => model === "character").length === 1) return response({ ...finalReply, memoryAssistantQuery: "之前电影" });
  return response(finalReply);
};
try {
  let loads = 0, knowledge = 0, callbacks = 0, usageRows = 0;
  const turn = makeTurn();
  const args = { chatInput: chat, turnContext: turn, assistant: { ...runtime, model: "memory", apiKey: "memory-secret" }, contextAssistant: runtime, candidates: [],
    loadCandidates: async () => { loads++; return [publicSource, privateSource]; },
    loadKnowledge: async () => { knowledge++; return []; },
    onKnowledgeCandidate: async () => { callbacks++; }, recordAssistantUsage: async () => { usageRows++; },
  };
  const [a, b] = await Promise.all([generateGroupContextReply(args), generateGroupContextReply(args)]);
  assert.equal(a.reply, b.reply); assert.deepEqual(models, ["context", "memory", "character"]);
  assert.equal(loads, 1); assert.equal(knowledge, 1); assert.equal(callbacks, 1); assert.equal(usageRows, 2);
  for (const name of ["context", "memory", "knowledge", "response"]) assert.equal(logical(turn, name), 1);
  for (const name of ["context", "memory", "response"]) assert.equal(turn.snapshot().stages.find(row => row.stage === name)!.operations[0]!.reportedAttempts, 1);
  assert.equal(turn.snapshot().stages.find(row => row.stage === "knowledge")!.operations[0]!.reportedAttempts, 0, "SQL lookup is not an HTTP model request");
  assert(!JSON.stringify(turn.snapshot()).includes("secret"));
  await generateGroupContextReply(args); assert.equal(models.length, 3, "Same request reuse cannot call again");
  assert(Object.isFrozen(a)); assert(Object.isFrozen(a.usedMemoryIds));
  await assert.rejects(generateGroupContextReply({ ...args, chatInput: { ...chat, currentMessage: "不同的问题" } }), /changed group input/);
  assert.equal(models.length, 3);
  await assert.rejects(generateGroupContextReply({ ...args, turnContext: makeTurn(), chatInput: { ...chat, transcript: [{ id: "foreign", content: "不属于本轮" }] } }), /evidence/);

  models = []; mode = "success";
  const mutable = { ...chat, transcript: [{ id: "current", content: "ORIGINAL_VALID_ROUND" }] };
  const pending = generateGroupContextReply({ ...args, turnContext: makeTurn(), chatInput: mutable });
  mutable.transcript[0]!.id = "foreign"; mutable.transcript[0]!.content = "MUTATED_UNTRUSTED_ROUND";
  await pending;
  assert.deepEqual(models, ["context", "memory", "character"]);

  models = []; mode = "context-fail"; const fallback = makeTurn();
  await generateGroupContextReply({ ...args, turnContext: fallback });
  assert.deepEqual(models, ["context", "character", "memory", "character"]);
  assert.equal(logical(fallback, "context"), 1); assert.equal(logical(fallback, "memory"), 1); assert.equal(logical(fallback, "response"), 2);
  assert.equal(fallback.snapshot().stages.find(row => row.stage === "context")!.operations[0]!.state, "failed");

  models = []; mode = "empty"; const empty = makeTurn();
  await generateGroupContextReply({ ...args, turnContext: empty });
  assert.equal(empty.snapshot().stages.find(row => row.stage === "memory")!.operations[0]!.state, "no_sources");
  assert.deepEqual(models, ["context", "memory", "character"]);

  models = []; mode = "success"; const privateTurn = makeTurn();
  await generateGroupContextReply({ ...args, turnContext: privateTurn, chatInput: { ...chat, groupChat: false } });
  assert.deepEqual(models, ["character"]); for (const name of ["context", "memory", "response"]) assert.equal(logical(privateTurn, name), 0);
} finally { globalThis.fetch = originalFetch; }
console.log("Group turn context: once-only stages/callbacks, public evidence, fallback shared budgets, empty-source states and private bypass passed (mocked).");
