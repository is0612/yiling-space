/**
 * 群聊回复延迟诊断的专项测试。
 *
 * 全部用 mock fetch + 可控时钟：不请求真实模型、不连数据库，也不宣称语义质量。
 * 覆盖：阶段耗时、超时、截断重试、skipped、失败诊断、traceId、并发隔离与理解输入不退化。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAssistantTurnContext, type AssistantTurnContext } from "../server/utils/assistant-turn-context";
import { generateGroupContextReply } from "../server/utils/group-context-reply";
import { createModelTurnDetail, readModelTurnDetail, type TurnDetailPatch } from "../server/utils/model-turn-detail";
import type { ConversationReplyInput } from "../server/utils/chat-reply";
import type { MemoryAssistantCandidate, MemoryAssistantRuntime } from "../server/utils/memory-assistant";

const realNow = Date.now;
const realFetch = globalThis.fetch;
let fakeNow = 1_700_000_000_000;
Date.now = () => fakeNow;

const runtime = (model: string): MemoryAssistantRuntime => ({
  model, apiKey: model + "-key", apiBaseUrl: "https://" + model + ".invalid/v1",
  temperature: 0.1, maxInputTokens: 16_384, maxOutputTokens: 2_048,
});
const baseInput: ConversationReplyInput = {
  groupChat: true, direct: true, allowSilent: false, characterName: "小鱼", characterPrompt: "CHARACTER_COMPOSES_FINAL",
  model: "character", apiKey: "character-key", apiBaseUrl: "https://character.invalid/v1", thinking: false,
  currentMessage: "@self 还记得那部电影吗？",
  transcript: [{ id: "current", content: "@self 还记得那部电影吗？", mentions: [{ target: "self" }] }],
  groupBackground: [{ id: "evidence", content: "说的是科幻电影。" }, { id: "unrelated", content: "UNRELATED_BACKGROUND" }],
  recentMessages: [], memories: [], snapshots: [],
};
const candidates: MemoryAssistantCandidate[] = [
  { sourceKey: "memory/public", sourceType: "memory", id: "public", scope: "character", relevanceScore: 1, category: "FACT", content: "PUBLIC_FILM_EVIDENCE" },
  { sourceKey: "memory/private", sourceType: "memory", id: "private", scope: "private", relevanceScore: 1, category: "FACT", content: "PRIVATE_MUST_NOT_REACH_MODELS" },
];
const analysis = {
  summary: "用户问过去聊过的电影。", evidenceMessageIds: ["current", "evidence"], participation: "invited",
  memoryQuery: "上次科幻电影", knowledgeCandidate: { evidenceMessageIds: ["unrelated"], reason: "群友解释了一个可复用的科学概念。" },
};
const reply = { action: "reply", reply: "上次聊的是这部电影。", usedMemoryIds: ["public"], usedSnapshotIds: [], usedEventIds: [], usedRawMessageIds: [] };
type Call = { model: string; messages: Array<{ role: string; content: string }> };
let calls: Call[] = [];
function jsonResponse(content: unknown, finish = "stop", model?: string): Response {
  return Response.json({ ...(model ? { model } : {}), choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: finish }],
    usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 } });
}
function makeTurn(evidenceIds: string[] = ["current", "evidence", "unrelated"]): AssistantTurnContext {
  return createAssistantTurnContext({
    turnId: randomUUID(),
    identity: { characterId: randomUUID(), channel: "qq-group", channelBindingId: randomUUID(),
      conversationKey: "latency-test-group", readableScopeIds: [randomUUID()], allowPrivate: false },
    evidenceIds,
  });
}
async function runTurn(options: {
  details?: TurnDetailPatch[];
  turnContext?: AssistantTurnContext;
  chatInput?: ConversationReplyInput;
  loadCandidates?: (query: string) => Promise<MemoryAssistantCandidate[]>;
  loadKnowledge?: (query: string) => Promise<never[]>;
  onKnowledgeCandidate?: (candidate: { rawContent: string; sourceMessageIds: string[]; reason: string }) => Promise<void>;
} = {}) {
  const details = options.details ?? [];
  const chatInput = options.chatInput ?? baseInput;
  const evidenceIds = [...(chatInput.transcript ?? []), ...(chatInput.groupBackground ?? []), ...chatInput.recentMessages]
    .map(row => row.id).filter((id): id is string => Boolean(id));
  const turnContext = options.turnContext ?? makeTurn([...new Set(evidenceIds)]);
  const result = await generateGroupContextReply({
    chatInput, turnContext, contextAssistant: runtime("context"), assistant: runtime("memory"),
    candidates, onTurnDetail: patch => details.push(patch), recordAssistantUsage: async () => undefined,
    ...(options.loadCandidates ? { loadCandidates: options.loadCandidates } : {}),
    ...(options.loadKnowledge ? { loadKnowledge: options.loadKnowledge } : {}),
    ...(options.onKnowledgeCandidate ? { onKnowledgeCandidate: options.onKnowledgeCandidate } : {}),
  });
  return { result, details, turnContext };
}
function stageOf(turn: AssistantTurnContext, stage: "context" | "memory" | "knowledge" | "response") {
  return turn.snapshot().stages.find(item => item.stage === stage)!;
}
function resetFetch(handler: (body: Call) => Response | Promise<Response>) {
  calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Call;
    calls.push(body);
    return handler(body);
  };
}
function standardHandler(contextValue: unknown = analysis, memoryValue: unknown = { sourceKeys: ["memory/public"] }) {
  return (body: Call) => {
    fakeNow += body.model === "context" ? 50 : body.model === "memory" ? 30 : 20;
    return jsonResponse(body.model === "context" ? contextValue : body.model === "memory" ? memoryValue : reply, "stop", body.model);
  };
}

try {
  // 1. 正常返回：context / memory 的墙钟时间与请求级 model、token、start/end 都要对得上。
  {
    resetFetch(standardHandler());
    const { details, turnContext } = await runTurn({ loadCandidates: async () => candidates });
    assert.equal(details.find(item => item.context)?.context?.durationMs, 50, "语境助手阶段耗时");
    assert.equal(details.find(item => item.memory)?.memory?.durationMs, 30, "记忆助手阶段耗时");
    const knowledge = details.find(item => item.knowledge)?.knowledge;
    assert.equal(knowledge?.status, "not_needed", "未触发的知识检索必须写 skipped 而不是成功。");
    assert.equal(knowledge?.durationMs, 0);
    const contextOperation = stageOf(turnContext, "context").operations[0]!;
    assert.equal(contextOperation.durationMs, 50);
    assert.equal(contextOperation.startedAt, fakeNow - 100, "阶段开始时间应能还原到整轮时钟轴上。");
    assert.equal(contextOperation.attempts[0]?.model, "context");
    assert.equal(contextOperation.attempts[0]?.usage?.totalTokens, 50);
    assert.equal(contextOperation.attempts[0]?.usageReported, true);
  }

  // 2. 语境助手超时：记录 timeout，不重试，主回复照常完成。
  {
    resetFetch(body => {
      if (body.model === "context") { const error = new Error("simulated timeout"); error.name = "TimeoutError"; throw error; }
      return jsonResponse(reply, "stop", body.model);
    });
    const { result, details, turnContext } = await runTurn();
    assert.equal(result.reply, reply.reply, "语境助手超时不能挡住主回复。");
    assert.equal(details.find(item => item.context)?.context?.status, "failed");
    assert.equal(details.find(item => item.knowledge)?.knowledge?.status, "not_needed");
    assert.deepEqual(stageOf(turnContext, "context").operations[0]?.attempts.map(item => item.status), ["timeout"]);
    assert.equal(calls.filter(call => call.model === "context").length, 1, "超时不触发第二次分析。");
  }

  // 3. 语境助手截断：一次预算翻倍重试，两次 attempt 与总耗时都要留下。
  {
    let contextCalls = 0;
    resetFetch(body => {
      if (body.model !== "context") return jsonResponse(reply, "stop", body.model);
      contextCalls++; fakeNow += 50;
      return contextCalls === 1 ? jsonResponse("", "length", "context") : jsonResponse(analysis, "stop", "context");
    });
    const { details, turnContext } = await runTurn();
    assert.equal(contextCalls, 2);
    assert.deepEqual(stageOf(turnContext, "context").operations[0]?.attempts.map(item => item.status), ["truncated", "success"]);
    assert.equal(details.find(item => item.context)?.context?.durationMs, 100);
    const budgets = calls.filter(call => call.model === "context").map(call => JSON.parse(JSON.stringify(call)).max_tokens);
    assert(Number(budgets[1]) > Number(budgets[0]), "截断重试应提高预算，而不是原样重发。");
  }

  // 4. 记忆助手截断重试：次数与耗时都记在 memory 阶段。
  {
    let memoryCalls = 0;
    resetFetch(body => {
      if (body.model !== "memory") return standardHandler()(body);
      memoryCalls++; fakeNow += 30;
      return memoryCalls === 1 ? jsonResponse("", "length", "memory") : jsonResponse({ sourceKeys: ["memory/public"] }, "stop", "memory");
    });
    const { details, turnContext } = await runTurn({ loadCandidates: async () => candidates });
    assert.equal(memoryCalls, 2);
    assert.deepEqual(stageOf(turnContext, "memory").operations[0]?.attempts.map(item => item.status), ["truncated", "success"]);
    assert.equal(details.find(item => item.memory)?.memory?.durationMs, 60);
  }

  // 5 + 6. 记忆与知识都不触发：两者都必须显式 skipped。
  {
    resetFetch(standardHandler({ ...analysis, memoryQuery: undefined, knowledgeQuery: undefined }));
    const { details, turnContext } = await runTurn();
    assert.equal(details.find(item => item.memory)?.memory?.status, "not_needed");
    assert.equal(details.find(item => item.knowledge)?.knowledge?.status, "not_needed");
    assert.equal(stageOf(turnContext, "memory").skipped, "not_needed");
    assert.equal(stageOf(turnContext, "knowledge").skipped, "not_needed");
  }

  // 7. 主回复模型失败：attempt 里留下 http_error，turnDetail 里留下归一化失败原因。
  {
    resetFetch(body => body.model === "character" ? new Response("provider detail must not leak", { status: 401 }) : standardHandler()(body));
    const turnContext = makeTurn();
    let failure: unknown;
    try {
      await runTurn({ turnContext, loadCandidates: async () => candidates });
    } catch (error) { failure = error; }
    assert(failure, "主回复失败必须向上抛出，由渠道层兜底。");
    const operation = stageOf(turnContext, "response").operations[0];
    assert.equal(operation?.state, "failed");
    assert.equal(operation?.attempts[0]?.status, "http_error");
    assert(JSON.stringify(turnContext.snapshot()).includes("http_error"));
    assert(!JSON.stringify(turnContext.snapshot()).includes("provider detail must not leak"));
    const detail = createModelTurnDetail(true, [], undefined, randomUUID());
    detail.update({ response: { action: "silent", reply: "", failureReason: "http_error", durationMs: 20 } });
    detail.update({ timing: { totalMs: 100, responseMs: 20, modelMs: 20 } });
    const restored = readModelTurnDetail(detail.serialize())!;
    assert.equal(restored.response.status, "failed", "带失败原因的 patch 不能把状态覆盖成 success");
    assert.equal(restored.response.failureReason, "http_error");
    assert.equal(restored.timing?.modelMs, 20);
  }

  // 8. 多阶段同时异常：同一个 traceId 仍能关联所有阶段与整轮耗时。
  {
    const traceId = randomUUID();
    const detail = createModelTurnDetail(true, [{ id: "current", content: "本轮" }], undefined, traceId);
    detail.update({ context: { status: "failed", durationMs: 10 } });
    detail.update({ memory: { status: "failed", durationMs: 20 } });
    detail.update({ knowledge: { status: "failed", durationMs: 30 } });
    detail.update({ response: { action: "silent", reply: "", failureReason: "model_error" } });
    detail.update({ timing: { totalMs: 60, responseMs: 60, modelMs: 50 } });
    detail.update({ database: { knowledgeReadMs: 7, memoryCandidateMs: 9, knowledgeCollectMs: 11 } });
    const restored = readModelTurnDetail(detail.serialize())!;
    assert.equal(restored.traceId, traceId);
    assert.equal(restored.context.status, "failed");
    assert.equal(restored.memory.status, "failed");
    assert.equal(restored.knowledge?.status, "failed");
    assert.equal(restored.response.failureReason, "model_error");
    assert.deepEqual(restored.database, { knowledgeReadMs: 7, memoryCandidateMs: 9, knowledgeCollectMs: 11 });
    assert.equal(restored.timing?.totalMs, 60);
    assert.equal(readModelTurnDetail(JSON.stringify({ ...JSON.parse(detail.serialize()), traceId: "not-a-uuid" }))?.traceId, undefined);
  }

  // 9. 自动知识收集的诊断/写入失败不能改变本轮回复。
  {
    resetFetch(standardHandler());
    const { result, details } = await runTurn({ onKnowledgeCandidate: async () => { throw new Error("database unavailable"); } });
    assert.equal(result.reply, reply.reply);
    assert.equal(details.find(item => item.context)?.context?.status, "success");
  }

  // 10. 多人对话、@、引用：交给语境助手的字段保持完整，不因提速而删减。
  {
    const complex: ConversationReplyInput = { ...baseInput, transcript: [
      { id: "m1", member: "member_1", speaker: "甲", content: "@self 你觉得呢？", mentions: [{ target: "self" }] },
      { id: "m2", member: "member_2", speaker: "乙", content: "别听他的", quoted: { id: "m1", member: "member_1", speaker: "甲", content: "@self 你觉得呢？", available: true } },
    ], currentMessage: "@self 换个话题", groupBackground: [] };
    resetFetch(body => {
      if (body.model === "context") return jsonResponse({ summary: "话题切换，乙引用了甲。", evidenceMessageIds: ["m1", "m2"], participation: "observing" }, "stop", "context");
      return jsonResponse(reply, "stop", body.model);
    });
    await runTurn({ chatInput: complex });
    const analyzerPayload = JSON.parse(calls[0]!.messages.find(row => row.role === "user")!.content);
    assert.equal(analyzerPayload.transcript.length, 2);
    assert.deepEqual(analyzerPayload.transcript[0].mentions, [{ target: "self" }]);
    assert.equal(analyzerPayload.transcript[1].quoted.id, "m1");
    assert.equal(analyzerPayload.transcript[1].quoted.available, true);
    assert.equal(analyzerPayload.transcript[1].isOwner, false);
  }

  // 11. 长上下文：最后一条关键消息必须仍在分析载荷里，裁剪只发生在更早的内容。
  {
    const long = Array.from({ length: 90 }, (_, index) => ({ id: "m" + index, content: "MSG_" + index + "_" + "字".repeat(200) }));
    long.push({ id: "critical", content: "CRITICAL_LAST" });
    resetFetch(body => {
      if (body.model === "context") return jsonResponse({ summary: "关键消息在最后。", evidenceMessageIds: ["critical"], participation: "invited" }, "stop", "context");
      return jsonResponse(reply, "stop", body.model);
    });
    await runTurn({ chatInput: { ...baseInput, transcript: long } });
    const payload = JSON.parse(calls[0]!.messages.find(row => row.role === "user")!.content);
    assert(payload.transcript.some((row: { id: string }) => row.id === "critical"), "关键消息不能被预算裁剪掉。");
    assert.equal(payload.contextClipped, true, "真实裁剪必须如实标记。");
  }

  // 12. 并发群聊：两个轮次的 details 与 traceId 互不覆盖。
  {
    const analysisA = { ...analysis, summary: "SUMMARY_A" };
    const analysisB = { ...analysis, summary: "SUMMARY_B" };
    resetFetch(body => {
      const userPayload = JSON.parse(body.messages.find(row => row.role === "user")!.content);
      const value = userPayload.characterName === "角色甲" ? analysisA : analysisB;
      return jsonResponse(body.model === "context" ? value : reply, "stop", body.model);
    });
    const detailsA: TurnDetailPatch[] = [], detailsB: TurnDetailPatch[] = [];
    const [a, b] = await Promise.all([
      runTurn({ details: detailsA, chatInput: { ...baseInput, characterName: "角色甲" } }),
      runTurn({ details: detailsB, chatInput: { ...baseInput, characterName: "角色乙" } }),
    ]);
    assert.equal(a.turnContext.turnId === b.turnContext.turnId, false);
    assert.equal(detailsA.find(item => item.context)?.context?.summary, "SUMMARY_A");
    assert.equal(detailsB.find(item => item.context)?.context?.summary, "SUMMARY_B");
    assert(detailsA.every(item => item.context?.summary !== "SUMMARY_B"));
    assert(detailsB.every(item => item.context?.summary !== "SUMMARY_A"));
  }

  console.log("Group reply latency diagnostics passed: stage timing, timeout, truncation retries, skipped stages, failure trace, concurrency and understanding inputs (mocked).");
} finally {
  Date.now = realNow;
  globalThis.fetch = realFetch;
}
