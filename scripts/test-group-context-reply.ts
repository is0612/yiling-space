import assert from "node:assert/strict";
import { generateGroupContextReply } from "../server/utils/group-context-reply";
import type { TurnDetailPatch } from "../server/utils/model-turn-detail";
import type { ConversationReplyInput } from "../server/utils/chat-reply";
import type { MemoryAssistantCandidate, MemoryAssistantRuntime } from "../server/utils/memory-assistant";

const contextAssistant: MemoryAssistantRuntime = { model: "context", apiKey: "context-key", apiBaseUrl: "https://context.invalid/v1", temperature: 0.1, maxInputTokens: 16_384, maxOutputTokens: 2_048 };
const assistant: MemoryAssistantRuntime = { ...contextAssistant, model: "memory", apiKey: "memory-key", apiBaseUrl: "https://memory.invalid/v1" };
const chatInput: ConversationReplyInput = {
  groupChat: true, direct: true, allowSilent: false, characterName: "小鱼", characterPrompt: "CHARACTER_COMPOSES_FINAL",
  model: "character", apiKey: "character-key", apiBaseUrl: "https://character.invalid/v1", thinking: false,
  currentMessage: "@self 记得上次的电影吗？", transcript: [{ id: "current", content: "@self 记得上次的电影吗？" }],
  groupBackground: [{ id: "evidence", content: "说的是科幻电影。" }, { id: "unrelated", content: "UNRELATED_BACKGROUND" }],
  recentMessages: [], memories: [], snapshots: [],
};
const candidates: MemoryAssistantCandidate[] = [
  { sourceKey: "memory/public", sourceType: "memory", id: "public", scope: "character", relevanceScore: 1, category: "FACT", content: "PUBLIC_FILM_EVIDENCE" },
  { sourceKey: "memory/private", sourceType: "memory", id: "private", scope: "private", relevanceScore: 1, category: "FACT", content: "PRIVATE_MUST_NOT_REACH_MODELS" },
];
const analysis = { summary: "用户问过去聊过的电影。", evidenceMessageIds: ["current", "evidence"], participation: "invited", memoryQuery: "上次科幻电影", knowledgeCandidate: { evidenceMessageIds: ["evidence", "invented"], reason: "群友解释了一个可复用的科学概念。" } };
const reply = { action: "reply", reply: "上次聊的是这部电影。", usedMemoryIds: ["public"], usedSnapshotIds: [], usedEventIds: [], usedRawMessageIds: [] };
const usage = { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 };
function response(content: unknown): Response {
  return Response.json({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }], usage });
}
type Call = { model: string; messages: Array<{ role: string; content: string }> };
type Entry = { kind: "context-assistant" | "memory-assistant"; model: string; usage?: { totalTokens: number }; status: string };
const originalFetch = globalThis.fetch;
let calls: Call[] = [];
let entries: Entry[] = [];
let details: TurnDetailPatch[] = [];
let next: (body: Call) => Response = () => response(reply);
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(String(options?.body)) as Call;
  calls.push(body);
  assert(!JSON.stringify(body).includes("PRIVATE_MUST_NOT_REACH_MODELS"));
  return next(body);
};
const run = (overrides: Partial<Parameters<typeof generateGroupContextReply>[0]> = {}) => generateGroupContextReply({
  chatInput, assistant, contextAssistant, candidates,
  onTurnDetail: detail => { details.push(detail); },
  recordAssistantUsage: async entry => { entries.push(entry); }, ...overrides,
});
function reset(handler: (body: Call) => Response) { calls = []; entries = []; details = []; next = handler; }
try {
  reset(body => body.model === "context" ? response(analysis) : body.model === "memory" ? response({ sourceKeys: ["memory/public", "memory/private", "memory/invented"] }) : response(reply));
  let loadedQuery = "";
  const captured: Array<{ rawContent: string; sourceMessageIds: string[]; reason: string }> = [];
  const result = await run({ loadCandidates: async query => { loadedQuery = query; return candidates; }, onKnowledgeCandidate: async value => { captured.push(value); } });
  assert.equal(result.reply, reply.reply);
  assert.deepEqual(result.usedMemoryIds, ["public"]);
  assert.equal(loadedQuery, analysis.memoryQuery);
  assert.deepEqual(captured[0]?.sourceMessageIds, ["evidence"], "Only real included evidence ids may be collected.");
  assert(captured[0]?.rawContent.includes("说的是科幻电影。"));
  assert.equal(captured?.reason, "群友解释了一个可复用的科学概念。");
  assert.equal(details[0]?.context?.status, "success");
  assert.deepEqual(details[0]?.context?.evidence?.map(item => item.id), ["current", "evidence"]);
  assert.deepEqual(details[1]?.memory, { status: "success", query: analysis.memoryQuery, sources: [
    { id: "public", type: "memory", scope: "character", content: "PUBLIC_FILM_EVIDENCE" },
  ] }, "Diagnostics include selected public sources only, never invented or private candidates.");
  assert.deepEqual(calls.map(call => call.model), ["context", "memory", "character"], "Analysis must precede one retrieval and one final composition without an initial chat call.");
  assert.deepEqual(entries.map(entry => [entry.kind, entry.status, entry.usage?.totalTokens]), [["context-assistant", "success", 50], ["memory-assistant", "success", 50]]);
  const finalText = JSON.stringify(calls[2]!.messages);
  assert(finalText.includes("CHARACTER_COMPOSES_FINAL"));
  assert(finalText.includes("PUBLIC_FILM_EVIDENCE"));
  assert(!finalText.includes("UNRELATED_BACKGROUND"), "Final character sees only evidence-linked background.");

  reset(body => body.model === "context" ? response({ ...analysis, memoryQuery: undefined, knowledgeQuery: "黑洞的逃逸速度" }) : response({ ...reply, usedMemoryIds: [] }));
  let loadedKnowledgeQuery = "";
  const knowledgeItem = { id: "knowledge-1", title: "黑洞", content: "黑洞的事件视界是无法逃逸的边界。", category: "SCIENCE", tags: ["天文学"], confidence: 0.94, sourceType: "CHAT" };
  await run({ loadKnowledge: async query => { loadedKnowledgeQuery = query; return [knowledgeItem]; } });
  assert.equal(loadedKnowledgeQuery, "黑洞的逃逸速度");
  assert.deepEqual(calls.map(call => call.model), ["context", "character"], "Knowledge retrieval is a scoped database lookup, not another model call.");
  const knowledgePrompt = JSON.stringify(calls[1]!.messages);
  assert(knowledgePrompt.includes("knowledge-1"));
  assert(knowledgePrompt.includes("事件视界"));
  assert(knowledgePrompt.includes("confirmed, character-owned learning records"));
  assert(!knowledgePrompt.includes("PRIVATE_MUST_NOT_REACH_MODELS"));

  const extendedBackground = [{ id: "extended", content: "EXTENDED_ANALYSIS_EVIDENCE_" + "字".repeat(1_000) }, { id: "extended-unrelated", content: "EXTENDED_UNRELATED" }];
  reset(body => body.model === "context" ? response({ ...analysis, memoryQuery: undefined, evidenceMessageIds: ["extended"] }) : response({ ...reply, usedMemoryIds: [] }));
  await run({ analysisBackground: extendedBackground });
  assert(JSON.stringify(calls[0]!.messages).includes("EXTENDED_ANALYSIS_EVIDENCE_"));
  assert(JSON.stringify(calls[1]!.messages).includes("EXTENDED_ANALYSIS_EVIDENCE_"));
  assert(!JSON.stringify(calls[1]!.messages).includes("EXTENDED_UNRELATED"));
  assert(!JSON.stringify(calls[1]!.messages).includes("字".repeat(700)), "Final evidence must be clipped to the wrapper's 600-char bound.");

  reset(body => body.model === "context" ? response({ ...analysis, memoryQuery: undefined, participation: "observing" }) : response({ ...reply, action: "silent", reply: "", usedMemoryIds: [] }));
  const silent = await run();
  assert.equal(silent.action, "silent", "Direct invitation flag does not force final output after advisory analysis.");
  assert.equal(silent.reply, "");
  assert.deepEqual(calls.map(call => call.model), ["context", "character"]);

  reset(body => body.model === "context" ? response("INVALID_ANALYZER_JSON") : response({ ...reply, usedMemoryIds: [], reply: "旧流程正常接话。" }));
  assert.equal((await run()).reply, "旧流程正常接话。");
  assert.deepEqual(calls.map(call => call.model), ["context", "character"]);
  assert.equal(entries[0]?.status, "failed");
  assert.equal(details[0]?.context?.status, "failed");
  assert.equal(details.filter(item => item.context).length, 1, "Legacy fallback must not overwrite analyzer failure.");
  assert.equal(details[1]?.memory?.status, "not_needed");
  assert.equal(entries[0]?.usage?.totalTokens, 50, "Failed HTTP200 analysis remains accounted.");

  reset(body => body.model === "context" ? response(analysis) : body.model === "memory" ? response("INVALID_MEMORY_JSON") : response({ ...reply, usedMemoryIds: [], reply: "这回没查到确切记录，你给个片名线索？" }));
  const failedMemory = await run();
  assert.equal(failedMemory.reply, "这回没查到确切记录，你给个片名线索？", "The character composes the final response after memory failure.");
  assert.deepEqual(calls.map(call => call.model), ["context", "memory", "character"]);
  assert.deepEqual(entries.map(entry => entry.status), ["success", "failed"]);
  assert.equal(entries[1]?.usage?.totalTokens, 50);
  assert(JSON.stringify(calls[2]!.messages).includes("failed"));

  reset(body => body.model === "context" ? response(analysis) : body.model === "memory" ? response({ sourceKeys: ["memory/public"] }) : new Response("final failed", { status: 401 }));
  await assert.rejects(() => run());
  assert.deepEqual(entries.map(entry => [entry.kind, entry.usage?.totalTokens]), [["context-assistant", 50], ["memory-assistant", 50]], "Assistant calls are recorded before final generation can throw.");

  reset(body => body.model === "context" ? response({ ...analysis, memoryQuery: undefined }) : response(reply));
  assert.equal((await run({ recordAssistantUsage: async () => { throw new Error("accounting unavailable"); } })).reply, reply.reply);

  reset(() => response({ ...reply, usedMemoryIds: [] }));
  await run({ contextAssistant: null, assistant: null });
  assert.deepEqual(calls.map(call => call.model), ["character"], "Disabled analyzer preserves the old flow.");
  assert.equal(details[0]?.context?.status, "not_enabled");
  assert.equal(details[1]?.memory?.status, "not_enabled");

  reset(() => response(reply));
  await run({ chatInput: { ...chatInput, groupChat: false }, contextAssistant: null });
  assert.equal(details[0]?.context?.status, "not_applicable");

  reset(body => body.model === "context" ? response(analysis) : response(reply));
  await run({ candidates: [] });
  assert.equal(details[1]?.memory?.status, "no_sources");
  await run({ assistant: null });
  assert.equal(details.at(-1)?.memory?.status, "not_enabled");
  await run({ loadCandidates: async () => { throw new Error("lookup unavailable"); } });
  assert.equal(details.at(-1)?.memory?.status, "failed");
  await run({ onTurnDetail: () => { throw new Error("diagnostic unavailable"); } });

  const manyEvidence = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, content: "x".repeat(1_000) }));
  reset(body => body.model === "context" ? response({ ...analysis, memoryQuery: undefined, evidenceMessageIds: [...manyEvidence.map(item => item.id), "invented"] }) : response(reply));
  await run({ analysisBackground: manyEvidence });
  assert.equal(details[0]?.context?.evidence?.length, 12);
  assert(details[0]?.context?.evidence?.every(item => item.content.length === 600));
  assert.equal(details[1]?.memory?.status, "not_needed");
  console.log("Group context reply mocked integration tests passed (no real model calls).");
} finally {
  globalThis.fetch = originalFetch;
}
