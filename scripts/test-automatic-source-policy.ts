import assert from "node:assert/strict";
import type { PrismaClient } from "../src/generated/prisma/client";
import { refreshConversationSummary } from "../server/utils/conversation-summary";
import { automaticKnowledgeLines, excludesAutomaticGrowth, filterAutomaticSources, sanitizeAutomaticSource, stripReadOnlyEvidence } from "../server/utils/automatic-source-policy";

const aiQuote = { content: "OTHER_AI_UNTRUSTED_OPINION", kind: "AI", readOnly: true, excludeFromGrowth: true };
const human = { id: "human", conversationId: "role-room", role: "USER", content: "真人说：我完成了今天的绘画。", metadata: { platform: "qq-onebot", authorOpenId: "human-author", quotedMessage: aiQuote } };
const legacyAi = { id: "legacy-ai", conversationId: "role-room", role: "USER", content: "LEGACY_AI_OPINION", metadata: { platform: "qq-onebot", authorOpenId: "ai-author" } };
const markedAi = { ...legacyAi, id: "marked-ai", metadata: { ...legacyAi.metadata, kind: "AI" } };
const unknown = { ...legacyAi, id: "unknown", content: "UNKNOWN_AUTHOR_CONTENT", metadata: { platform: "qq-onebot", authorOpenId: "unknown-author" } };
const foreignPlatform = { ...legacyAi, id: "foreign-platform", content: "OTHER_PLATFORM_AUTHOR", metadata: { platform: "another-platform", authorOpenId: "ai-author" } };
const self = { id: "self", role: "ASSISTANT", content: "我完成了绘画。", metadata: { platform: "qq-onebot", authorOpenId: "ai-author" } };
const derived = { ...self, id: "derived", content: "DERIVED_FROM_READONLY", metadata: { excludeFromGrowth: true, growthExclusionReason: "read_only_ai_context" } };
let identityReads = 0;
const db = { conversation: { findMany: async (args: {where: {characterId: string; id: {in: string[]}}}) => {
  assert.equal(args.where.characterId, "role-a"); return args.where.id.in.includes("role-room") ? [{id: "role-room"}] : [];
}}, externalIdentity: { findMany: async (args: {where: {platform: string; platformUid: {in: string[]}; kind: string; OR: Array<unknown>}}) => {
  identityReads++;
  assert.equal(args.where.kind, "AI");
  assert(JSON.stringify(args.where.OR).includes('"characterId":"role-a"'));
  return args.where.platform === "qq-onebot" && args.where.platformUid.in.includes("ai-author") ? [{platformUid: "ai-author"}] : [];
}} } as unknown as Pick<PrismaClient, "externalIdentity" | "conversation">;
const result = await filterAutomaticSources(db, "role-a", [human, legacyAi, markedAi, unknown, foreignPlatform, self, derived]);
assert.deepEqual(result.map(row => row.id), ["human", "unknown", "foreign-platform", "self"]);
assert.equal(result[0]!.content, human.content, "Human main content remains real evidence");
assert(!JSON.stringify(result).includes("OTHER_AI_UNTRUSTED_OPINION"));
assert(!JSON.stringify(result).includes("LEGACY_AI_OPINION"));
assert(!JSON.stringify(result).includes("DERIVED_FROM_READONLY"));
assert.equal((result[0]!.metadata as Record<string,unknown>).quotedMessage, undefined);
assert(identityReads <= 2, "Identity reads are batched by exact platform, not per message or model calls");
assert.equal(sanitizeAutomaticSource(markedAi), null);
assert(excludesAutomaticGrowth({readOnly: true}));
assert.deepEqual(stripReadOnlyEvidence({main: "HUMAN", nested: [{quotedMessage: aiQuote}, aiQuote]}), {main: "HUMAN", nested: [{}]});
assert.equal(human.metadata.quotedMessage.content, "OTHER_AI_UNTRUSTED_OPINION", "Read-only chat evidence is not mutated or erased from storage");
const knowledge = automaticKnowledgeLines([{id: "human", content: "HUMAN_KNOWLEDGE", quoted: aiQuote}, {id: "ai", content: "AI_KNOWLEDGE", kind: "AI"}]);
assert.equal(knowledge.length, 1); assert(!JSON.stringify(knowledge).includes("OTHER_AI_UNTRUSTED_OPINION"));
const now = new Date("2026-02-03T12:00:00Z");
const summaryRows = [human, legacyAi, derived, { ...human, id: "human2" }].map((row, index) => ({ ...row, occurredAt: new Date(now.getTime() - 3_600_000 + index) }));
let wrote = false;
const summaryDb = { ...db, conversation: { ...db.conversation, findFirst: async () => ({ metadata: {}, updatedAt: now }), updateMany: async () => { wrote = true; return { count: 1 }; } }, message: { findMany: async () => summaryRows } } as unknown as PrismaClient;
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(String(init?.body)); const payload = JSON.parse(input.messages[1].content);
    assert(payload.messages.some((row: {id:string}) => row.id === "human"));
    assert(!JSON.stringify(payload).includes("OTHER_AI_UNTRUSTED_OPINION"));
    assert(!JSON.stringify(payload).includes("LEGACY_AI_OPINION"));
    assert(!JSON.stringify(payload).includes("DERIVED_FROM_READONLY"));
    return Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "真人完成绘画。" }) }, finish_reason: "stop" }] });
  };
  const summary = await refreshConversationSummary(summaryDb, { characterId: "role-a", conversationId: "role-room", memoryScopeId: "private-role-a", channelBindingId: "binding", model: "mock", apiKey: "test", apiBaseUrl: "https://model.invalid/v1", now });
  assert(summary && wrote); assert.equal(summary.through.id, "human2", "Cursor covers raw scanned evidence, not merely eligible rows");
} finally { globalThis.fetch = originalFetch; }
console.log("Automatic source policy passed: read-only nested evidence, verified legacy identities, human preservation, self attribution and knowledge projection (mock only).");
