import assert from "node:assert/strict";
import { generateConversationReply } from "../server/utils/chat-reply";
import { analyzeMemoryPeriod } from "../server/utils/memory-ai";
import { interactionExperiencePrompt, parseInteractionSuggestion } from "../server/utils/interaction-experiences";
import { refreshConversationSummary } from "../server/utils/conversation-summary";
import type { PrismaClient } from "../src/generated/prisma/client";

// Synthetic conflicting evidence only. This checks assembled requests, not model semantics.
const original = globalThis.fetch;
let request: { messages: Array<{ role: string; content: string }> };
let output: unknown = { reply: "这次查到了；先前失败不代表现在读不到。" };
globalThis.fetch = async (_url, init) => {
  request = JSON.parse(String(init?.body));
  return Response.json({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: "stop" }] });
};
const base = { characterName: "测试角色", characterPrompt: "轻松直率，有自己的判断", model: "mock", apiKey: "test-only", apiBaseUrl: "https://model.invalid/v1",
  currentMessage: "现在可以看到那段记录了吗", recentMessages: [], memories: [{ id: "old-failure", category: "FACT", content: "之前查询失败，助手说读不到。", confidence: 0.9, scope: "private" as const }], snapshots: [],
  conversationSummary: { summary: "当时助手说记录不可见。", coverage: "partial" as const, through: { id: "old", occurredAt: "2026-01-01T00:00:00Z" } },
  interactionExperiences: [{ id: "old-experience", content: "先承认读不到", context: "过去查询失败", weight: 1 }],
  rawMessages: [{ id: "fresh", role: "USER", content: "今天的完整原话证据", occurredAt: "2026-01-02T00:00:00Z", scope: "private" as const }],
};
try {
  const result = await generateConversationReply(base);
  assert.equal(result.promptTemplateVersion, "conversation-retrieval-v82");
  const system = request!.messages.find(message => message.role === "system")!.content;
  const payload = request!.messages.find(message => message.role === "user")!.content;
  assert(system.includes("current server-supplied capabilities and fresh retrieved original evidence take precedence"));
  assert(system.includes("past self-descriptions in memories, summaries or learned reminders"));
  assert(payload.includes("old-failure") && payload.includes("今天的完整原话证据"), "Do not delete dated failures or new sources by keyword");
  assert(payload.includes("Current original evidence and server-supplied capability state take precedence"));
  for (const currentMessage of ["不对哦", "我觉得那个人是在试探你", "晚安"]) {
    await generateConversationReply({ ...base, currentMessage });
    const prompt = request!.messages[0]!.content;
    assert(prompt.includes("distinguish a supported factual correction"));
    assert(prompt.includes("interpretation as proof of another person's hidden intent"));
    assert(prompt.includes("do not replace one confident guess with another"));
    assert(prompt.includes("without repeating an apology or promise to remember"));
  }

  // Both long-term extraction and daily event extraction preserve dated failure evidence.
  const evidence = [{ id: "failure", role: "ASSISTANT", eventType: "message", occurredAt: "2026-01-01T01:00:00Z", content: "刚才查询失败，我以为一直没有权限。" },
    { id: "correction", role: "USER", eventType: "message", occurredAt: "2026-01-01T01:02:00Z", content: "这次已查到了。我觉得那人是在开玩笑，但请别再用那个词。" }];
  const analysisInput = { apiKey: "test-only", apiBaseUrl: "https://model.invalid/v1", model: "mock", characterName: "测试角色", timezone: "Asia/Shanghai", scopeType: "USER_PRIVATE",
    periodStart: "2026-01-01T00:00:00Z", periodEnd: "2026-01-02T00:00:00Z", messages: evidence, totalMessageCount: 2, omittedMessageCount: 0, activeMemories: [], previousSnapshotSummary: null };
  output = { summary: "一次查询失败后恢复，用户给出自己的解读及用词偏好。", importantEvents: [], factAndPreferenceChanges: [], relationshipChanges: [], goalsAndCommitments: [], unresolvedTopics: [], differencesFromPrevious: [], memoryChanges: [], events: [] };
  await analyzeMemoryPeriod(analysisInput);
  let extraction = request!.messages[0]!.content;
  assert(extraction.includes("不能仅凭助手自述或用户猜测写成永久能力"));
  assert(extraction.includes("用户的解读"));
  assert(extraction.includes("真实故障及来源可以保留"));
  assert(request!.messages[1]!.content.includes("刚才查询失败"), "Evidence remains available for dated events");
  output = { events: [] };
  await analyzeMemoryPeriod({ ...analysisInput, mode: "events" });
  extraction = request!.messages[0]!.content;
  assert(extraction.includes("只能按发生时间记为事件"));
  assert(extraction.includes("模糊否定不足以推导新的确定结论"));

  assert(interactionExperiencePrompt.includes("不将用户解读或助手顺从改口当成第三人的真实意图"));
  assert(interactionExperiencePrompt.includes("不学成‘先承认一直读不到’"));
  assert(interactionExperiencePrompt.includes("表达纠正学成当句落实"));
  const feedback = "我觉得他是在开玩笑，请别用那个词。";
  const experience = parseInteractionSuggestion(JSON.stringify({ content: "保留观点归属并调整用词", context: "被提醒用词时", feedbackQuote: feedback,
    learning: { kind: "EXPRESSION", situation: "被提醒用词时", misunderstanding: "把用户解读当成事实", correction: "用户给出个人解读并要求换词", nextJudgment: "保留不确定性并直接换词" } }), feedback);
  assert(!("skip" in experience));
  assert.throws(() => parseInteractionSuggestion(JSON.stringify({ content: "猜测", context: "反馈", feedbackQuote: "编造的反馈" }), feedback), "Source quote validation stays unchanged");

  // Capture the real summary request without touching a database or background jobs.
  output = { summary: "一次失败后查到证据；对他人动机只有用户解读。" };
  const db = { conversation: { findFirst: async () => ({ metadata: {}, updatedAt: new Date() }), updateMany: async () => ({ count: 1 }) },
    message: { findMany: async () => Array.from({ length: 24 }, (_, index) => ({ ...evidence[index % 2]!, id: `source-${index}`, occurredAt: new Date(`2026-01-01T01:00:${String(index).padStart(2, "0")}Z`) })) } } as unknown as PrismaClient;
  await refreshConversationSummary(db, { characterId: "character", conversationId: "conversation", memoryScopeId: "private", channelBindingId: null, model: "mock", apiKey: "test-only", apiBaseUrl: "https://model.invalid/v1" });
  const summary = request!.messages[0]!.content;
  assert(summary.includes("never to permanent access or capability"));
  assert(summary.includes("remains the speaker's interpretation"));
} finally { globalThis.fetch = original; }
console.log("Evidence priority and feedback attribution prompt regressions passed (synthetic cases, mock requests only; model behavior not measured).");
